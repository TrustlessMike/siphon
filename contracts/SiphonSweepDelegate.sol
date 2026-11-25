// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title SiphonSweepDelegate (EIP-7702 Gasless 1-Signature Atomic Sweeper)
 * @notice Hardened EIP-7702 delegation target for standard EOAs (Rabby, MetaMask, Phantom, Ledger).
 *
 * Security invariants:
 *   1. Explicit signed `directUsdcAmount` prevents 0-output sandwiched swaps from cannibalizing pre-existing EOA USDC.
 *   2. Enforces immutable `protocolFeeRecipient` (or policyRegistry allowlist) and `minNetUsdcOut > 0` onchain.
 *   3. Exact EIP-712 `SWEEP_INTENT_TYPEHASH` parity with `src/relayer/sponsor.ts` (including `directUsdcAmount` & `callsHash`).
 *   4. Supports both Circle CCTP V1 (4-arg) and CCTP V2 (7-arg) targeting the user's canonical 32-byte Solana USDC ATA PDA.
 *   5. Safe execution ordering: approval revokes FIRST -> DeFi exits -> swaps (incl. native ETH value) -> fee & CCTP bridge ->
 *      isolated capped-gas, 32-byte bounded burn calls LAST (immune to return-bombs and gas griefing).
 *   6. Exact ERC-7201 namespaced storage slot and owner `cancelNonce(uint256)` invalidation.
 */

interface IERC20Delegate {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface ITokenMessengerDelegate {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce);
}

interface ITokenMessengerV2Delegate {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;
}

interface ISiphonDelegateRegistry {
    function isAllowedFeeRecipient(address recipient) external view returns (bool);
    function isAllowedRelayer(address relayer) external view returns (bool);
    function isAllowedSwapRouter(address router) external view returns (bool);
    function isAllowedDefiProtocol(address protocol) external view returns (bool);
}

interface IAavePoolDelegate {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ICompoundCometDelegate {
    function withdraw(address asset, uint256 amount) external;
}

interface IERC4626Delegate {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

library SafeDelegateERC20 {
    error ERC20CallFailed(address token);

    function _callSuccess(address token, bool ok, bytes memory data) private view returns (bool) {
        if (!ok) return false;
        if (data.length == 0) {
            return token.code.length > 0;
        }
        if (data.length < 32) return false;
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(data, 32))
        }
        return word == 1;
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Delegate.transfer.selector, to, amount)
        );
        if (!_callSuccess(token, ok, data)) {
            revert ERC20CallFailed(token);
        }
    }

    function _tryApprove(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Delegate.approve.selector, spender, amount)
        );
        return _callSuccess(token, ok, data);
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        if (_tryApprove(token, spender, amount)) {
            return;
        }
        if (!_tryApprove(token, spender, 0) || (amount > 0 && !_tryApprove(token, spender, amount))) {
            revert ERC20CallFailed(token);
        }
    }
}

contract SiphonSweepDelegate {
    using SafeDelegateERC20 for address;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint32 public constant SOLANA_CCTP_DOMAIN = 5;
    uint32 public constant CCTP_V2_STANDARD_FINALITY = 2000;
    uint16 public constant MIN_FEE_BPS = 500;  // 5.0%
    uint16 public constant MAX_FEE_BPS = 1000; // 10.0%
    uint256 public constant BURN_GAS_STIPEND = 100_000;
    uint256 public constant REVOKE_GAS_STIPEND = 60_000;

    // secp256k1 half-order for EIP-2 signature malleability protection
    uint256 private constant SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SWEEP_INTENT_TYPEHASH = keccak256(
        "SweepIntent(bytes32 solanaRecipient,address usdc,address cctpMessenger,address feeRecipient,uint16 feeBps,uint256 directUsdcAmount,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint256 nonce,uint256 deadline,bytes32 callsHash)"
    );

    /// @notice Immutable deployment-level protocol fee treasury (lives in delegate bytecode, safe under EIP-7702).
    address public immutable protocolFeeRecipient;

    /// @notice Circle CCTP version deployed on this chain: 1 (4-arg) or 2 (7-arg TokenMessengerV2).
    uint8 public immutable cctpVersion;

    /// @notice Optional policy registry enforcing allowlisted fee recipients, relayers, swap routers, and DeFi protocols.
    address public immutable policyRegistry;

    enum ExitKind {
        AAVE_V3,
        COMPOUND_V3,
        ERC4626
    }

    struct DefiExit {
        ExitKind kind;
        address protocol;
        address underlyingAsset;
        uint256 amount;
    }

    struct TokenSwap {
        address tokenIn;   // address(0) for native gas coin swap forwarding `ethValue`
        uint256 amountIn;
        uint256 ethValue;  // native wei forwarded when tokenIn == address(0)
        address router;
        bytes callData;
    }

    struct DeadBurn {
        address token;
        uint256 amount;
    }

    struct ApprovalRevoke {
        address token;
        address spender;
    }

    struct SweepIntent {
        /// @dev Canonical 32-byte Solana USDC Associated Token Account (ATA) PDA — NEVER a raw wallet pubkey.
        bytes32 solanaRecipient;
        address usdc;
        address cctpMessenger;
        address feeRecipient;
        uint16 feeBps;
        /// @dev Explicit amount of pre-existing EOA USDC authorized to be swept (0 for swap-only sweeps).
        uint256 directUsdcAmount;
        uint256 minNetUsdcOut;
        uint256 maxGasReimbursementUsdc;
        uint256 nonce;
        uint256 deadline;
        DefiExit[] defiExits;
        TokenSwap[] swaps;
        DeadBurn[] burns;
        ApprovalRevoke[] revokes;
    }

    /// @dev Exact ERC-7201 storage slot: keccak256(abi.encode(uint256(keccak256("siphon.eip7702.sweep.delegate.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_SLOT =
        0xa6b7741274d7a992e8f1ae1e71cebc66d0900a4cbdc50d80cc8162e664a93f00;

    struct DelegateStorage {
        mapping(uint256 => bool) usedNonces;
        uint256 locked;
    }

    function _store() private pure returns (DelegateStorage storage s) {
        bytes32 slot = STORAGE_SLOT;
        assembly {
            s.slot := slot
        }
    }

    event SponsoredSweepProven(
        address indexed user,
        address indexed relayer,
        bytes32 indexed solanaRecipient,
        uint256 grossUsdc,
        uint256 gasReimbursementUsdc,
        uint256 protocolFeeUsdc,
        uint256 netBridgedUsdc,
        uint64 cctpNonce,
        uint256 burnedCount
    );
    event NonceCancelled(address indexed user, uint256 indexed nonce);

    error ExpiredIntent();
    error NonceAlreadyUsed(uint256 nonce);
    error InvalidSignature();
    error InvalidFeeBps(uint16 feeBps);
    error InvalidAddress();
    error InvalidCctpVersion(uint8 version);
    error UnauthorizedFeeRecipient(address recipient);
    error UnauthorizedRelayer(address relayer);
    error TargetNotAllowed(address target);
    error InsufficientDirectUsdc(uint256 available, uint256 required);
    error InsufficientNativeBalance(uint256 available, uint256 required);
    error GasReimbursementTooHigh(uint256 requested, uint256 maxAllowed);
    error ZeroMinNetOutput();
    error RelayerBreakEvenNotMet(uint256 relayerRevenueUsdc, uint256 requiredCoverageUsdc);
    error SwapCallFailed(address router);
    error SlippageFloorNotMet(uint256 actualUsdc, uint256 minRequired);
    error Reentrancy();

    constructor(address _protocolFeeRecipient, uint8 _cctpVersion, address _policyRegistry) {
        if (_protocolFeeRecipient == address(0)) revert InvalidAddress();
        if (_cctpVersion != 1 && _cctpVersion != 2) revert InvalidCctpVersion(_cctpVersion);
        protocolFeeRecipient = _protocolFeeRecipient;
        cctpVersion = _cctpVersion;
        policyRegistry = _policyRegistry;
    }

    receive() external payable {}

    function isNonceUsed(uint256 nonce) external view returns (bool) {
        return _store().usedNonces[nonce];
    }

    /// @notice Allows the delegated EOA itself to cancel an unused signed SweepIntent nonce before expiry.
    function cancelNonce(uint256 nonce) external {
        if (msg.sender != address(this)) revert InvalidSignature();
        _store().usedNonces[nonce] = true;
        emit NonceCancelled(address(this), nonce);
    }

    function computeCallsHash(SweepIntent calldata intent) public pure returns (bytes32) {
        return keccak256(abi.encode(intent.defiExits, intent.swaps, intent.burns, intent.revokes));
    }

    function hashIntent(SweepIntent calldata intent) public view returns (bytes32) {
        bytes32 callsHash = computeCallsHash(intent);
        bytes32 structHash = keccak256(
            abi.encode(
                SWEEP_INTENT_TYPEHASH,
                intent.solanaRecipient,
                intent.usdc,
                intent.cctpMessenger,
                intent.feeRecipient,
                intent.feeBps,
                intent.directUsdcAmount,
                intent.minNetUsdcOut,
                intent.maxGasReimbursementUsdc,
                intent.nonce,
                intent.deadline,
                callsHash
            )
        );
        bytes32 domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("SiphonSweepDelegate"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _safeRevoke(address token, address spender) private {
        if (token == address(0) || spender == address(0) || token.code.length == 0) return;
        bytes memory payload = abi.encodeWithSelector(IERC20Delegate.approve.selector, spender, 0);
        uint256 gasCap = REVOKE_GAS_STIPEND;
        assembly ("memory-safe") {
            pop(call(gasCap, token, 0, add(payload, 32), mload(payload), 0, 0))
        }
    }

    function _safeBurnTransfer(address token, uint256 amount) private returns (bool succeeded) {
        if (token == address(0) || token.code.length == 0) return false;
        bytes memory payload = abi.encodeWithSelector(IERC20Delegate.transfer.selector, DEAD_ADDRESS, amount);
        uint256 gasCap = BURN_GAS_STIPEND;
        assembly ("memory-safe") {
            mstore(0x00, 0)
            let ok := call(gasCap, token, 0, add(payload, 32), mload(payload), 0x00, 32)
            let rdsize := returndatasize()
            if ok {
                if or(iszero(rdsize), and(iszero(lt(rdsize, 32)), eq(mload(0x00), 1))) {
                    succeeded := 1
                }
            }
        }
    }

    function _bridgeUsdcViaCctp(
        address usdcToken,
        address messenger,
        uint256 amount,
        bytes32 solanaUsdcAta
    ) private returns (uint64 cctpNonce) {
        usdcToken.forceApprove(messenger, amount);
        if (cctpVersion == 2) {
            ITokenMessengerV2Delegate(messenger).depositForBurn(
                amount,
                SOLANA_CCTP_DOMAIN,
                solanaUsdcAta,
                usdcToken,
                bytes32(0),
                0,
                CCTP_V2_STANDARD_FINALITY
            );
            cctpNonce = 0;
        } else {
            cctpNonce = ITokenMessengerDelegate(messenger).depositForBurn(
                amount,
                SOLANA_CCTP_DOMAIN,
                solanaUsdcAta,
                usdcToken
            );
        }
        usdcToken.forceApprove(messenger, 0);
    }

    function _executeDefiAndSwaps(SweepIntent calldata intent) private {
        // 2. Exit DeFi positions directly as the EOA
        for (uint256 i = 0; i < intent.defiExits.length; i++) {
            DefiExit calldata ex = intent.defiExits[i];
            if (ex.amount == 0) continue;
            if (ex.protocol == address(0) || ex.protocol.code.length == 0) {
                revert TargetNotAllowed(ex.protocol);
            }
            if (policyRegistry != address(0) && !ISiphonDelegateRegistry(policyRegistry).isAllowedDefiProtocol(ex.protocol)) {
                revert TargetNotAllowed(ex.protocol);
            }
            if (ex.kind == ExitKind.AAVE_V3) {
                IAavePoolDelegate(ex.protocol).withdraw(ex.underlyingAsset, ex.amount, address(this));
            } else if (ex.kind == ExitKind.COMPOUND_V3) {
                ICompoundCometDelegate(ex.protocol).withdraw(ex.underlyingAsset, ex.amount);
            } else if (ex.kind == ExitKind.ERC4626) {
                IERC4626Delegate(ex.protocol).redeem(ex.amount, address(this), address(this));
            }
        }

        // 3. Swap liquid ERC-20s (or native ETH when tokenIn == address(0)) directly into native USDC
        for (uint256 i = 0; i < intent.swaps.length; i++) {
            TokenSwap calldata sw = intent.swaps[i];
            if (sw.tokenIn == intent.usdc) continue;
            if (sw.router == address(0) || sw.router.code.length == 0 || sw.router == intent.usdc) {
                revert TargetNotAllowed(sw.router);
            }
            if (policyRegistry != address(0) && !ISiphonDelegateRegistry(policyRegistry).isAllowedSwapRouter(sw.router)) {
                revert TargetNotAllowed(sw.router);
            }

            if (sw.tokenIn == address(0)) {
                if (sw.ethValue == 0) continue;
                if (address(this).balance < sw.ethValue) {
                    revert InsufficientNativeBalance(address(this).balance, sw.ethValue);
                }
                (bool okNative, ) = sw.router.call{ value: sw.ethValue }(sw.callData);
                if (!okNative) revert SwapCallFailed(sw.router);
            } else {
                if (sw.amountIn == 0) continue;
                sw.tokenIn.forceApprove(sw.router, sw.amountIn);
                (bool ok, ) = sw.router.call(sw.callData);
                if (!ok) revert SwapCallFailed(sw.router);
                sw.tokenIn.forceApprove(sw.router, 0);
            }
        }
    }

    function _settleAndBridge(
        SweepIntent calldata intent,
        uint256 usdcBefore,
        uint256 gasReimbursementUsdc
    ) private returns (uint256 grossUsdc, uint256 protocolFeeUsdc, uint256 netBridgedUsdc, uint64 cctpNonce) {
        // 4. Exact USDC output accounting: NEVER fall back to usdcAfter when swaps yield 0 USDC!
        //    grossUsdc = explicit signed directUsdcAmount + strictly measured positive swap delta (usdcAfter - usdcBefore).
        uint256 usdcAfter = IERC20Delegate(intent.usdc).balanceOf(address(this));
        if (usdcAfter < usdcBefore) revert SlippageFloorNotMet(0, intent.minNetUsdcOut);
        uint256 swappedUsdc = usdcAfter - usdcBefore;
        grossUsdc = intent.directUsdcAmount + swappedUsdc;
        if (grossUsdc == 0) revert SlippageFloorNotMet(0, intent.minNetUsdcOut);

        protocolFeeUsdc = (grossUsdc * intent.feeBps) / 10_000;
        // Onchain Relayer Break-Even Protection: require protocolFee + gasReimbursement >= ceil(1.5x sponsored gas)
        if (gasReimbursementUsdc > 0) {
            uint256 relayerRevenue = protocolFeeUsdc + gasReimbursementUsdc;
            uint256 requiredCoverage = (gasReimbursementUsdc * 3 + 1) / 2;
            if (relayerRevenue < requiredCoverage) {
                revert RelayerBreakEvenNotMet(relayerRevenue, requiredCoverage);
            }
        }
        uint256 totalDeductions = protocolFeeUsdc + gasReimbursementUsdc;
        if (grossUsdc <= totalDeductions) revert SlippageFloorNotMet(0, intent.minNetUsdcOut);

        netBridgedUsdc = grossUsdc - totalDeductions;
        if (netBridgedUsdc < intent.minNetUsdcOut) {
            revert SlippageFloorNotMet(netBridgedUsdc, intent.minNetUsdcOut);
        }

        if (gasReimbursementUsdc > 0) {
            intent.usdc.safeTransfer(msg.sender, gasReimbursementUsdc);
        }
        if (protocolFeeUsdc > 0) {
            intent.usdc.safeTransfer(intent.feeRecipient, protocolFeeUsdc);
        }

        // 5. Bridge net USDC 1:1 to Solana canonical USDC ATA PDA via Circle CCTP (V1 or V2) BEFORE untrusted burns
        cctpNonce = _bridgeUsdcViaCctp(
            intent.usdc,
            intent.cctpMessenger,
            netBridgedUsdc,
            intent.solanaRecipient
        );
    }

    function _validateAndVerifyIntent(
        DelegateStorage storage ds,
        SweepIntent calldata intent,
        uint256 gasReimbursementUsdc,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        if (block.timestamp > intent.deadline) revert ExpiredIntent();
        if (intent.minNetUsdcOut == 0) revert ZeroMinNetOutput();
        if (ds.usedNonces[intent.nonce]) revert NonceAlreadyUsed(intent.nonce);
        if (intent.feeBps < MIN_FEE_BPS || intent.feeBps > MAX_FEE_BPS) {
            revert InvalidFeeBps(intent.feeBps);
        }
        if (
            intent.usdc == address(0) ||
            intent.cctpMessenger == address(0) ||
            intent.feeRecipient == address(0) ||
            intent.solanaRecipient == bytes32(0)
        ) {
            revert InvalidAddress();
        }
        if (intent.cctpMessenger.code.length == 0 || intent.usdc.code.length == 0) {
            revert InvalidAddress();
        }

        // Enforce protocol fee recipient invariant (eliminates 100% fee bypass via attacker-controlled feeRecipient)
        bool feeRecipientValid = intent.feeRecipient == protocolFeeRecipient ||
            (policyRegistry != address(0) &&
                ISiphonDelegateRegistry(policyRegistry).isAllowedFeeRecipient(intent.feeRecipient));
        if (!feeRecipientValid) {
            revert UnauthorizedFeeRecipient(intent.feeRecipient);
        }

        if (gasReimbursementUsdc > 0 && policyRegistry != address(0)) {
            if (!ISiphonDelegateRegistry(policyRegistry).isAllowedRelayer(msg.sender)) {
                revert UnauthorizedRelayer(msg.sender);
            }
        }
        if (gasReimbursementUsdc > intent.maxGasReimbursementUsdc) {
            revert GasReimbursementTooHigh(gasReimbursementUsdc, intent.maxGasReimbursementUsdc);
        }

        // Verify the delegated EOA (`address(this)`) signed this exact SweepIntent
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) revert InvalidSignature();
        address signer = ecrecover(hashIntent(intent), v, r, s);
        if (signer == address(0) || signer != address(this)) revert InvalidSignature();
        ds.usedNonces[intent.nonce] = true;
    }

    /**
     * @notice Executed by Siphon's Gas Sponsor Relayer on behalf of the delegated EOA (`address(this)`).
     *         User pays $0 gas and signs 1 off-chain EIP-712 intent.
     */
    function executeSponsoredSweep(
        SweepIntent calldata intent,
        uint256 gasReimbursementUsdc,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 netBridgedUsdc, uint64 cctpNonce) {
        DelegateStorage storage ds = _store();
        if (ds.locked == 1) revert Reentrancy();
        ds.locked = 1;

        _validateAndVerifyIntent(ds, intent, gasReimbursementUsdc, v, r, s);

        // 1. Execute ERC-20 approval revocations FIRST (closes lingering spender vectors before swaps/DeFi exits)
        for (uint256 i = 0; i < intent.revokes.length; i++) {
            ApprovalRevoke calldata rv = intent.revokes[i];
            _safeRevoke(rv.token, rv.spender);
        }

        uint256 usdcBefore = IERC20Delegate(intent.usdc).balanceOf(address(this));
        if (usdcBefore < intent.directUsdcAmount) {
            revert InsufficientDirectUsdc(usdcBefore, intent.directUsdcAmount);
        }

        _executeDefiAndSwaps(intent);

        uint256 grossUsdc;
        uint256 protocolFeeUsdc;
        (grossUsdc, protocolFeeUsdc, netBridgedUsdc, cctpNonce) = _settleAndBridge(
            intent,
            usdcBefore,
            gasReimbursementUsdc
        );

        // 6. Execute isolated dead-token burns LAST with capped gas & 32-byte bounded return copy
        uint256 burnedCount = 0;
        for (uint256 i = 0; i < intent.burns.length; i++) {
            DeadBurn calldata b = intent.burns[i];
            if (b.amount == 0) continue;
            if (_safeBurnTransfer(b.token, b.amount)) {
                burnedCount++;
            }
        }

        emit SponsoredSweepProven(
            address(this),
            msg.sender,
            intent.solanaRecipient,
            grossUsdc,
            gasReimbursementUsdc,
            protocolFeeUsdc,
            netBridgedUsdc,
            cctpNonce,
            burnedCount
        );

        ds.locked = 0;
    }
}
