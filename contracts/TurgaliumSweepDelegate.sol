// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title TurgaliumSweepDelegate (EIP-7702 Gasless 1-Signature Atomic Sweeper)
 * @notice Hardened EIP-7702 delegation target for standard EOAs (Rabby, MetaMask, Phantom, Ledger).
 *
 * Security invariants:
 *   1. Explicit signed `directUsdcAmount` prevents 0-output sandwiched swaps from cannibalizing pre-existing EOA USDC.
 *   2. Enforces immutable `protocolFeeRecipient` (or policyRegistry allowlist), 0-1000 bps tiered fee preservation
 *      (with optional immutable `protocolMaxFeeUsdcCap` & signed `maxFeeUsdcCap`), and `minNetUsdcOut > 0` onchain.
 *   3. Exact EIP-712 `SWEEP_INTENT_TYPEHASH` parity with `src/relayer/sponsor.ts` (including `directUsdcAmount` & `callsHash`),
 *      plus `SWEEP_INTENT_V2_TYPEHASH` binding CCTP V2 Fast Transfer / Forwarding Hook options and `maxFeeUsdcCap`.
 *   4. Supports Circle CCTP V1 (4-arg) and CCTP V2 (7-arg Standard/Fast + 8-arg `depositForBurnWithHook`)
 *      targeting the user's canonical 32-byte Solana USDC ATA PDA.
 *   5. Supports on-chain `TurgaliumAgentVault.authorizeAgentAction(...)` mandate enforcement via `executeSponsoredSweepWithMandate`.
 *   6. Safe execution ordering: approval revokes FIRST -> DeFi exits -> swaps (incl. native ETH value) ->
 *      mandate check (if any) -> fee & CCTP bridge -> isolated capped-gas, 32-byte bounded burn calls LAST.
 *   7. Exact ERC-7201 namespaced storage slot and owner `cancelNonce(uint256)` invalidation.
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

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

interface ITurgaliumDelegateRegistry {
    function paused() external view returns (bool);
    function isAllowedFeeRecipient(address recipient) external view returns (bool);
    function isAllowedRelayer(address relayer) external view returns (bool);
    function isAllowedSwapRouter(address router) external view returns (bool);
    function isAllowedDefiProtocol(address protocol) external view returns (bool);
    function isAllowedAgentVault(address vault) external view returns (bool);
}

interface ITurgaliumAgentVaultDelegate {
    struct AgentMandate {
        address owner;
        address agentKey;
        address authorizedRouter;
        bytes32 lockedSolanaRecipient;
        uint256 maxPerTxUsd6;
        uint256 dailyCapUsd6;
        uint256 spentTodayUsd6;
        uint64 dayWindowStart;
        uint64 expiresAt;
        uint16 maxFeeBps;
        uint16 minNetOutBps;
        uint8 allowedActionsMask;
        bool active;
    }

    function getMandate(bytes32 mandateId) external view returns (AgentMandate memory);

    function authorizeAgentAction(
        bytes32 mandateId,
        address agentCaller,
        uint8 actionBit,
        bytes32 solanaRecipient,
        uint256 grossUsd6,
        uint256 netOutUsd6,
        uint16 feeBps,
        bytes32 intentDigest
    ) external;
}

interface IAavePoolDelegate {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ICompoundCometDelegate {
    function baseToken() external view returns (address);
    function balanceOf(address account) external view returns (uint256);
    function withdraw(address asset, uint256 amount) external;
}

interface IERC4626Delegate {
    function asset() external view returns (address);
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

contract TurgaliumSweepDelegate {
    using SafeDelegateERC20 for address;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint32 public constant SOLANA_CCTP_DOMAIN = 5;
    uint32 public constant CCTP_V2_FAST_FINALITY = 1000;
    uint32 public constant CCTP_V2_STANDARD_FINALITY = 2000;
    uint16 public constant MAX_CCTP_FEE_BPS = 500; // 5.0% max fast-transfer fee guard
    uint16 public constant MIN_FEE_BPS = 0;        // 0.0% (supports tiered preservation & whale fees)
    uint16 public constant MAX_FEE_BPS = 1000;     // 10.0% hard user-protection ceiling
    uint256 public constant BURN_GAS_STIPEND = 100_000;
    uint256 public constant REVOKE_GAS_STIPEND = 60_000;

    uint8 public constant ACTION_DUST_CONVERT = 1 << 0;
    uint8 public constant ACTION_DEFI_WITHDRAW = 1 << 1;
    uint8 public constant ACTION_BRIDGE_SOLANA = 1 << 2;
    uint8 public constant ACTION_BURN_ZERO_LIQ = 1 << 3;

    // secp256k1 half-order for EIP-2 signature malleability protection
    uint256 private constant SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SWEEP_INTENT_TYPEHASH = keccak256(
        "SweepIntent(bytes32 solanaRecipient,address usdc,address cctpMessenger,address feeRecipient,uint16 feeBps,uint256 directUsdcAmount,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint256 nonce,uint256 deadline,bytes32 callsHash)"
    );
    bytes32 public constant SWEEP_INTENT_V2_TYPEHASH = keccak256(
        "SweepIntentV2(bytes32 solanaRecipient,address usdc,address cctpMessenger,address feeRecipient,uint16 feeBps,uint256 maxFeeUsdcCap,uint256 directUsdcAmount,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint256 nonce,uint256 deadline,bytes32 callsHash,bytes32 cctpOptionsHash)"
    );
    bytes32 public constant MANDATE_SWEEP_INTENT_TYPEHASH = keccak256(
        "MandateSweepIntent(bytes32 solanaRecipient,address usdc,address cctpMessenger,address feeRecipient,uint16 feeBps,uint256 maxFeeUsdcCap,uint256 directUsdcAmount,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint256 nonce,uint256 deadline,bytes32 callsHash,bytes32 cctpOptionsHash,address agentVault,bytes32 mandateId,uint8 actionBit)"
    );

    /// @notice Immutable canonical native USDC contract pinned in delegate bytecode.
    address public immutable usdc;

    /// @notice Immutable canonical Circle CCTP TokenMessenger pinned in delegate bytecode.
    address public immutable cctpMessenger;

    /// @notice Immutable deployment-level protocol fee treasury (lives in delegate bytecode, safe under EIP-7702).
    address public immutable protocolFeeRecipient;

    /// @notice Circle CCTP version deployed on this chain: 1 (4-arg) or 2 (7/8-arg TokenMessengerV2).
    uint8 public immutable cctpVersion;

    /// @notice Mandatory policy registry enforcing kill-switch, fee recipients, relayers, swap routers, DeFi protocols, & agent vaults.
    address public immutable policyRegistry;

    /// @notice Optional immutable protocol fee cap in USDC base units (0 = uncapped beyond feeBps; e.g. 25e6 = $25 whale cap).
    uint256 public immutable protocolMaxFeeUsdcCap;

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

    struct CctpV2Options {
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold; // 0 defaults to 2000 (Standard), 1000 = Fast Transfer
        bytes hookData;              // Non-empty invokes TokenMessengerV2.depositForBurnWithHook
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

    /// @dev Exact ERC-7201 storage slot: keccak256(abi.encode(uint256(keccak256("turgalium.eip7702.sweep.delegate.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 public constant STORAGE_SLOT =
        0xb28ad115b98ee0cdb6a6fb3a8270e2f7701b3c3aad8c58cbdf5f3e0ec909a500;

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
    event MandateSponsoredSweepProven(
        bytes32 indexed mandateId,
        address indexed agentVault,
        address indexed signer,
        uint256 grossUsdc,
        uint256 netBridgedUsdc
    );
    event NonceCancelled(address indexed user, uint256 indexed nonce);

    error ExpiredIntent();
    error NonceAlreadyUsed(uint256 nonce);
    error InvalidSignature();
    error InvalidFeeBps(uint16 feeBps);
    error FeeCapExceeded(uint256 feeUsdc, uint256 maxAllowedCap);
    error InvalidAddress();
    error InvalidCctpVersion(uint8 version);
    error CctpV2Required();
    error CctpMaxFeeTooHigh(uint256 requestedMaxFee, uint256 maxAllowedFee);
    error UnauthorizedFeeRecipient(address recipient);
    error UnauthorizedRelayer(address relayer);
    error TargetNotAllowed(address target);
    error ProtocolPaused();
    error MandateActionNotPermitted(uint8 requiredBit);
    error AgentArbitrarySwapsForbidden();
    error AgentNonUsdcDefiExitForbidden(address underlyingAsset);
    error AgentBurnsForbidden();
    error AgentCctpOverrideForbidden();
    error InvalidBurnToken(address token);
    error InsufficientSuppliedBalance();
    error InsufficientDirectUsdc(uint256 available, uint256 required);
    error InsufficientNativeBalance(uint256 available, uint256 required);
    error GasReimbursementTooHigh(uint256 requested, uint256 maxAllowed);
    error ZeroMinNetOutput();
    error RelayerBreakEvenNotMet(uint256 relayerRevenueUsdc, uint256 requiredCoverageUsdc);
    error SwapCallFailed(address router);
    error SlippageFloorNotMet(uint256 actualUsdc, uint256 minRequired);
    error Reentrancy();

    constructor(
        address _usdc,
        address _cctpMessenger,
        address _protocolFeeRecipient,
        uint8 _cctpVersion,
        address _policyRegistry,
        uint256 _protocolMaxFeeUsdcCap
    ) {
        if (
            _usdc == address(0) ||
            _usdc.code.length == 0 ||
            _cctpMessenger == address(0) ||
            _cctpMessenger.code.length == 0 ||
            _protocolFeeRecipient == address(0) ||
            _policyRegistry == address(0) ||
            _policyRegistry.code.length == 0 ||
            _usdc == _cctpMessenger ||
            _usdc == _policyRegistry ||
            _cctpMessenger == _policyRegistry
        ) {
            revert InvalidAddress();
        }
        if (_cctpVersion != 1 && _cctpVersion != 2) revert InvalidCctpVersion(_cctpVersion);
        usdc = _usdc;
        cctpMessenger = _cctpMessenger;
        protocolFeeRecipient = _protocolFeeRecipient;
        cctpVersion = _cctpVersion;
        policyRegistry = _policyRegistry;
        protocolMaxFeeUsdcCap = _protocolMaxFeeUsdcCap;
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

    function computeCctpOptionsHash(CctpV2Options calldata cctpOpts) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                cctpOpts.destinationCaller,
                cctpOpts.maxFee,
                cctpOpts.minFinalityThreshold,
                keccak256(cctpOpts.hookData)
            )
        );
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256("TurgaliumSweepDelegate"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
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
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function hashIntentV2(
        SweepIntent calldata intent,
        uint256 maxFeeUsdcCap,
        CctpV2Options calldata cctpOpts
    ) public view returns (bytes32) {
        bytes32 callsHash = computeCallsHash(intent);
        bytes32 cctpOptionsHash = computeCctpOptionsHash(cctpOpts);
        bytes32 structHash = keccak256(
            abi.encode(
                SWEEP_INTENT_V2_TYPEHASH,
                intent.solanaRecipient,
                intent.usdc,
                intent.cctpMessenger,
                intent.feeRecipient,
                intent.feeBps,
                maxFeeUsdcCap,
                intent.directUsdcAmount,
                intent.minNetUsdcOut,
                intent.maxGasReimbursementUsdc,
                intent.nonce,
                intent.deadline,
                callsHash,
                cctpOptionsHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function hashMandateIntent(
        SweepIntent calldata intent,
        uint256 maxFeeUsdcCap,
        CctpV2Options calldata cctpOpts,
        address agentVault,
        bytes32 mandateId,
        uint8 actionBit
    ) public view returns (bytes32) {
        bytes32 callsHash = computeCallsHash(intent);
        bytes32 cctpOptionsHash = computeCctpOptionsHash(cctpOpts);
        bytes32 structHash = keccak256(
            abi.encode(
                MANDATE_SWEEP_INTENT_TYPEHASH,
                intent.solanaRecipient,
                intent.usdc,
                intent.cctpMessenger,
                intent.feeRecipient,
                intent.feeBps,
                maxFeeUsdcCap,
                intent.directUsdcAmount,
                intent.minNetUsdcOut,
                intent.maxGasReimbursementUsdc,
                intent.nonce,
                intent.deadline,
                callsHash,
                cctpOptionsHash,
                agentVault,
                mandateId,
                actionBit
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
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
        if (token == usdc) revert InvalidBurnToken(token);
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

    function _validateCctpAndComputeMinReceived(
        uint256 amount,
        CctpV2Options memory opts
    ) private view returns (uint256 minSolanaReceived) {
        if (cctpVersion == 2) {
            uint256 maxAllowedCctpFee = (amount * MAX_CCTP_FEE_BPS) / 10_000;
            if (opts.maxFee >= amount || opts.maxFee > maxAllowedCctpFee) {
                revert CctpMaxFeeTooHigh(opts.maxFee, maxAllowedCctpFee);
            }
            minSolanaReceived = amount - opts.maxFee;
        } else {
            if (opts.hookData.length > 0 || opts.maxFee > 0) revert CctpV2Required();
            minSolanaReceived = amount;
        }
    }

    function _bridgeUsdcViaCctp(
        address usdcToken,
        address messenger,
        uint256 amount,
        bytes32 solanaUsdcAta,
        CctpV2Options memory opts
    ) private returns (uint64 cctpNonce) {
        _validateCctpAndComputeMinReceived(amount, opts);
        usdcToken.forceApprove(messenger, amount);
        if (cctpVersion == 2) {
            uint32 finality = opts.minFinalityThreshold == 0
                ? CCTP_V2_STANDARD_FINALITY
                : opts.minFinalityThreshold;
            if (opts.hookData.length > 0) {
                ITokenMessengerV2Delegate(messenger).depositForBurnWithHook(
                    amount,
                    SOLANA_CCTP_DOMAIN,
                    solanaUsdcAta,
                    usdcToken,
                    opts.destinationCaller,
                    opts.maxFee,
                    finality,
                    opts.hookData
                );
            } else {
                ITokenMessengerV2Delegate(messenger).depositForBurn(
                    amount,
                    SOLANA_CCTP_DOMAIN,
                    solanaUsdcAta,
                    usdcToken,
                    opts.destinationCaller,
                    opts.maxFee,
                    finality
                );
            }
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
            if (ex.underlyingAsset == address(0)) revert InvalidAddress();
            if (ex.protocol == address(0) || ex.protocol.code.length == 0) {
                revert TargetNotAllowed(ex.protocol);
            }
            if (!ITurgaliumDelegateRegistry(policyRegistry).isAllowedDefiProtocol(ex.protocol)) {
                revert TargetNotAllowed(ex.protocol);
            }
            if (ex.kind == ExitKind.AAVE_V3) {
                IAavePoolDelegate(ex.protocol).withdraw(ex.underlyingAsset, ex.amount, address(this));
            } else if (ex.kind == ExitKind.COMPOUND_V3) {
                uint256 withdrawAmt = ex.amount;
                if (ex.underlyingAsset == ICompoundCometDelegate(ex.protocol).baseToken()) {
                    uint256 supplied = ICompoundCometDelegate(ex.protocol).balanceOf(address(this));
                    if (supplied == 0) revert InsufficientSuppliedBalance();
                    if (withdrawAmt > supplied) withdrawAmt = supplied;
                }
                ICompoundCometDelegate(ex.protocol).withdraw(ex.underlyingAsset, withdrawAmt);
            } else if (ex.kind == ExitKind.ERC4626) {
                if (IERC4626Delegate(ex.protocol).asset() != ex.underlyingAsset) {
                    revert InvalidAddress();
                }
                IERC4626Delegate(ex.protocol).redeem(ex.amount, address(this), address(this));
            }
        }

        // 3. Swap liquid ERC-20s (or native ETH when tokenIn == address(0)) directly into native USDC
        for (uint256 i = 0; i < intent.swaps.length; i++) {
            TokenSwap calldata sw = intent.swaps[i];
            if (sw.tokenIn == usdc) continue;
            if (sw.router == address(0) || sw.router.code.length == 0 || sw.router == usdc) {
                revert TargetNotAllowed(sw.router);
            }
            if (!ITurgaliumDelegateRegistry(policyRegistry).isAllowedSwapRouter(sw.router)) {
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

    function _computeAmounts(
        SweepIntent calldata intent,
        uint256 usdcBefore,
        uint256 gasReimbursementUsdc,
        uint256 userMaxFeeUsdcCap,
        CctpV2Options memory cctpOpts
    )
        private
        view
        returns (
            uint256 grossUsdc,
            uint256 protocolFeeUsdc,
            uint16 effectiveFeeBps,
            uint256 netBridgedUsdc,
            uint256 minSolanaReceived
        )
    {
        // 4. Exact USDC output accounting: NEVER fall back to usdcAfter when swaps yield 0 USDC!
        //    grossUsdc = explicit signed directUsdcAmount + strictly measured positive swap delta (usdcAfter - usdcBefore).
        uint256 usdcAfter = IERC20Delegate(usdc).balanceOf(address(this));
        if (usdcAfter < usdcBefore) revert SlippageFloorNotMet(0, intent.minNetUsdcOut);
        uint256 swappedUsdc = usdcAfter - usdcBefore;
        grossUsdc = intent.directUsdcAmount + swappedUsdc;
        if (grossUsdc == 0) revert SlippageFloorNotMet(0, intent.minNetUsdcOut);

        uint256 uncappedFee = (grossUsdc * intent.feeBps) / 10_000;
        protocolFeeUsdc = uncappedFee;
        if (protocolMaxFeeUsdcCap > 0 && protocolFeeUsdc > protocolMaxFeeUsdcCap) {
            protocolFeeUsdc = protocolMaxFeeUsdcCap;
        }
        if (userMaxFeeUsdcCap > 0 && protocolFeeUsdc > userMaxFeeUsdcCap) {
            revert FeeCapExceeded(protocolFeeUsdc, userMaxFeeUsdcCap);
        }

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
        minSolanaReceived = _validateCctpAndComputeMinReceived(netBridgedUsdc, cctpOpts);
        if (minSolanaReceived < intent.minNetUsdcOut) {
            revert SlippageFloorNotMet(minSolanaReceived, intent.minNetUsdcOut);
        }

        uint256 allDeductions = grossUsdc - minSolanaReceived;
        effectiveFeeBps = uint16((allDeductions * 10_000 + grossUsdc - 1) / grossUsdc);
    }

    function _settleAndBridge(
        SweepIntent calldata intent,
        uint256 usdcBefore,
        uint256 gasReimbursementUsdc,
        uint256 userMaxFeeUsdcCap,
        CctpV2Options memory cctpOpts
    ) private returns (uint256 grossUsdc, uint256 protocolFeeUsdc, uint256 netBridgedUsdc, uint64 cctpNonce) {
        (grossUsdc, protocolFeeUsdc, , netBridgedUsdc, ) = _computeAmounts(
            intent,
            usdcBefore,
            gasReimbursementUsdc,
            userMaxFeeUsdcCap,
            cctpOpts
        );

        if (gasReimbursementUsdc > 0) {
            usdc.safeTransfer(msg.sender, gasReimbursementUsdc);
        }
        if (protocolFeeUsdc > 0) {
            usdc.safeTransfer(intent.feeRecipient, protocolFeeUsdc);
        }

        // 5. Bridge net USDC 1:1 to Solana canonical USDC ATA PDA via Circle CCTP (V1 or V2) BEFORE untrusted burns
        cctpNonce = _bridgeUsdcViaCctp(
            usdc,
            cctpMessenger,
            netBridgedUsdc,
            intent.solanaRecipient,
            cctpOpts
        );
    }

    function _validateCommonIntent(
        DelegateStorage storage ds,
        SweepIntent calldata intent,
        uint256 gasReimbursementUsdc
    ) private view {
        // Unconditional kill-switch: halts ALL delegated sweeps (direct USDC, revokes, burns, 0-gas) immediately on pause
        if (ITurgaliumDelegateRegistry(policyRegistry).paused()) revert ProtocolPaused();
        if (block.timestamp > intent.deadline) revert ExpiredIntent();
        if (intent.minNetUsdcOut == 0) revert ZeroMinNetOutput();
        if (ds.usedNonces[intent.nonce]) revert NonceAlreadyUsed(intent.nonce);
        if (intent.feeBps < MIN_FEE_BPS || intent.feeBps > MAX_FEE_BPS) {
            revert InvalidFeeBps(intent.feeBps);
        }
        if (
            intent.usdc != usdc ||
            intent.cctpMessenger != cctpMessenger ||
            intent.feeRecipient == address(0) ||
            intent.solanaRecipient == bytes32(0)
        ) {
            revert InvalidAddress();
        }

        // Enforce protocol fee recipient invariant (eliminates 100% fee bypass via attacker-controlled feeRecipient)
        bool feeRecipientValid = intent.feeRecipient == protocolFeeRecipient ||
            ITurgaliumDelegateRegistry(policyRegistry).isAllowedFeeRecipient(intent.feeRecipient);
        if (!feeRecipientValid) {
            revert UnauthorizedFeeRecipient(intent.feeRecipient);
        }

        // Require allowlisted relayer for BOTH gas-reimbursed sweeps AND 0-bps fee tiers (blocks third-party 0-fee bypass)
        if (gasReimbursementUsdc > 0 || intent.feeBps == 0) {
            if (!ITurgaliumDelegateRegistry(policyRegistry).isAllowedRelayer(msg.sender)) {
                revert UnauthorizedRelayer(msg.sender);
            }
        }
        if (gasReimbursementUsdc > intent.maxGasReimbursementUsdc) {
            revert GasReimbursementTooHigh(gasReimbursementUsdc, intent.maxGasReimbursementUsdc);
        }
    }

    function _recoverSigner(bytes32 digest, uint8 v, bytes32 r, bytes32 s) private pure returns (address signer) {
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _validateAndVerifyIntent(
        DelegateStorage storage ds,
        SweepIntent calldata intent,
        uint256 gasReimbursementUsdc,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        _validateCommonIntent(ds, intent, gasReimbursementUsdc);
        // Verify the delegated EOA (`address(this)`) signed this exact SweepIntent
        address signer = _recoverSigner(hashIntent(intent), v, r, s);
        if (signer != address(this)) revert InvalidSignature();
        ds.usedNonces[intent.nonce] = true;
    }

    /**
     * @notice Executed by Turgalium's Gas Sponsor Relayer on behalf of the delegated EOA (`address(this)`).
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
        CctpV2Options memory defaultOpts;
        (grossUsdc, protocolFeeUsdc, netBridgedUsdc, cctpNonce) = _settleAndBridge(
            intent,
            usdcBefore,
            gasReimbursementUsdc,
            0,
            defaultOpts
        );

        // 6. Execute isolated dead-token burns LAST with capped gas & 32-byte bounded return copy
        uint256 burnedCount = 0;
        for (uint256 i = 0; i < intent.burns.length; i++) {
            DeadBurn calldata b = intent.burns[i];
            if (b.token == usdc) revert InvalidBurnToken(b.token);
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

    /**
     * @notice V2 sponsored sweep supporting cryptographically signed `maxFeeUsdcCap` and CCTP V2
     *         Fast Transfer (`minFinalityThreshold = 1000`, `maxFee`) / Forwarding Hooks (`hookData`).
     */
    function executeSponsoredSweepV2(
        SweepIntent calldata intent,
        uint256 maxFeeUsdcCap,
        CctpV2Options calldata cctpOpts,
        uint256 gasReimbursementUsdc,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 netBridgedUsdc, uint64 cctpNonce) {
        DelegateStorage storage ds = _store();
        if (ds.locked == 1) revert Reentrancy();
        ds.locked = 1;

        _validateCommonIntent(ds, intent, gasReimbursementUsdc);
        address signer = _recoverSigner(hashIntentV2(intent, maxFeeUsdcCap, cctpOpts), v, r, s);
        if (signer != address(this)) revert InvalidSignature();
        ds.usedNonces[intent.nonce] = true;

        for (uint256 i = 0; i < intent.revokes.length; i++) {
            ApprovalRevoke calldata rv = intent.revokes[i];
            _safeRevoke(rv.token, rv.spender);
        }

        uint256 usdcBefore = IERC20Delegate(usdc).balanceOf(address(this));
        if (usdcBefore < intent.directUsdcAmount) {
            revert InsufficientDirectUsdc(usdcBefore, intent.directUsdcAmount);
        }

        _executeDefiAndSwaps(intent);

        uint256 grossUsdc;
        uint256 protocolFeeUsdc;
        (grossUsdc, protocolFeeUsdc, netBridgedUsdc, cctpNonce) = _settleAndBridge(
            intent,
            usdcBefore,
            gasReimbursementUsdc,
            maxFeeUsdcCap,
            cctpOpts
        );

        uint256 burnedCount = 0;
        for (uint256 i = 0; i < intent.burns.length; i++) {
            DeadBurn calldata b = intent.burns[i];
            if (b.token == usdc) revert InvalidBurnToken(b.token);
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

    /**
     * @notice Mandate-gated EIP-7702 sponsored sweep integrated with on-chain `TurgaliumAgentVault.authorizeAgentAction`.
     * @dev Accepts `MANDATE_SWEEP_INTENT_TYPEHASH` signatures from either the delegated EOA (`address(this)`) or the
     *      mandate's authorized `agentKey` (when `mandate.owner == address(this)`), then verifies actual post-exit USDC
     *      deltas (after CCTP maxFee) against `TurgaliumAgentVault`. Autonomous agent signatures strictly forbid arbitrary
     *      swap calldata, non-USDC DeFi exits, arbitrary burns, and CCTP destinationCaller/hookData overrides.
     */
    function executeSponsoredSweepWithMandate(
        SweepIntent calldata intent,
        uint256 maxFeeUsdcCap,
        CctpV2Options calldata cctpOpts,
        address agentVault,
        bytes32 mandateId,
        uint8 actionBit,
        uint256 gasReimbursementUsdc,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 netBridgedUsdc, uint64 cctpNonce) {
        DelegateStorage storage ds = _store();
        if (ds.locked == 1) revert Reentrancy();
        ds.locked = 1;

        if (agentVault == address(0) || agentVault.code.length == 0) {
            revert TargetNotAllowed(agentVault);
        }
        if (!ITurgaliumDelegateRegistry(policyRegistry).isAllowedAgentVault(agentVault)) {
            revert TargetNotAllowed(agentVault);
        }

        _validateCommonIntent(ds, intent, gasReimbursementUsdc);

        ITurgaliumAgentVaultDelegate.AgentMandate memory m = ITurgaliumAgentVaultDelegate(agentVault).getMandate(mandateId);
        if (m.owner != address(this)) revert InvalidSignature();

        bytes32 digest = hashMandateIntent(intent, maxFeeUsdcCap, cctpOpts, agentVault, mandateId, actionBit);
        address signer = _recoverSigner(digest, v, r, s);
        bool validSigner = (signer == address(this)) || (signer == m.agentKey);
        if (!validSigner) revert InvalidSignature();

        bool isAutonomousAgent = (signer != address(this));
        if (isAutonomousAgent) {
            if (intent.swaps.length > 0) revert AgentArbitrarySwapsForbidden();
            if (intent.burns.length > 0) revert AgentBurnsForbidden();
            if (cctpOpts.destinationCaller != bytes32(0) || cctpOpts.hookData.length != 0) {
                revert AgentCctpOverrideForbidden();
            }
            for (uint256 i = 0; i < intent.defiExits.length; i++) {
                if (intent.defiExits[i].underlyingAsset != usdc) {
                    revert AgentNonUsdcDefiExitForbidden(intent.defiExits[i].underlyingAsset);
                }
            }
        }

        if ((m.allowedActionsMask & ACTION_BRIDGE_SOLANA) == 0) {
            revert MandateActionNotPermitted(ACTION_BRIDGE_SOLANA);
        }
        if (intent.defiExits.length > 0 && (m.allowedActionsMask & ACTION_DEFI_WITHDRAW) == 0) {
            revert MandateActionNotPermitted(ACTION_DEFI_WITHDRAW);
        }
        if (intent.swaps.length > 0 && (m.allowedActionsMask & ACTION_DUST_CONVERT) == 0) {
            revert MandateActionNotPermitted(ACTION_DUST_CONVERT);
        }
        if (intent.burns.length > 0 && (m.allowedActionsMask & ACTION_BURN_ZERO_LIQ) == 0) {
            revert MandateActionNotPermitted(ACTION_BURN_ZERO_LIQ);
        }

        ds.usedNonces[intent.nonce] = true;

        for (uint256 i = 0; i < intent.revokes.length; i++) {
            ApprovalRevoke calldata rv = intent.revokes[i];
            _safeRevoke(rv.token, rv.spender);
        }

        uint256 usdcBefore = IERC20Delegate(usdc).balanceOf(address(this));
        if (usdcBefore < intent.directUsdcAmount) {
            revert InsufficientDirectUsdc(usdcBefore, intent.directUsdcAmount);
        }

        _executeDefiAndSwaps(intent);

        uint256 grossUsdc;
        uint256 protocolFeeUsdc;
        uint16 effectiveFeeBps;
        uint256 minSolanaReceived;
        (grossUsdc, protocolFeeUsdc, effectiveFeeBps, netBridgedUsdc, minSolanaReceived) = _computeAmounts(
            intent,
            usdcBefore,
            gasReimbursementUsdc,
            maxFeeUsdcCap,
            cctpOpts
        );

        // Enforce on-chain TurgaliumAgentVault policy caps & locked Solana recipient BEFORE moving fees or bridging
        ITurgaliumAgentVaultDelegate(agentVault).authorizeAgentAction(
            mandateId,
            signer,
            actionBit,
            intent.solanaRecipient,
            grossUsdc,
            minSolanaReceived,
            effectiveFeeBps,
            digest
        );

        if (gasReimbursementUsdc > 0) {
            usdc.safeTransfer(msg.sender, gasReimbursementUsdc);
        }
        if (protocolFeeUsdc > 0) {
            usdc.safeTransfer(intent.feeRecipient, protocolFeeUsdc);
        }

        cctpNonce = _bridgeUsdcViaCctp(
            usdc,
            cctpMessenger,
            netBridgedUsdc,
            intent.solanaRecipient,
            cctpOpts
        );

        uint256 burnedCount = 0;
        for (uint256 i = 0; i < intent.burns.length; i++) {
            DeadBurn calldata b = intent.burns[i];
            if (b.token == usdc) revert InvalidBurnToken(b.token);
            if (b.amount == 0) continue;
            if (_safeBurnTransfer(b.token, b.amount)) {
                burnedCount++;
            }
        }

        emit MandateSponsoredSweepProven(mandateId, agentVault, signer, grossUsdc, netBridgedUsdc);
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
