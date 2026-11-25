// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SiphonSweepDelegate (EIP-7702 Gasless 1-Signature Atomic Sweeper)
 * @notice Minimal audited EIP-7702 delegation target for standard EOAs (Rabby, MetaMask, Phantom, Ledger).
 *
 * Solves all 3 core migration problems simultaneously:
 *   1. ZERO per-transaction popups: user signs 1 EIP-7702 authorization + 1 EIP-712 SweepIntent off-chain.
 *   2. ZERO native gas required: Siphon's sponsor relayer pays 100% of ETH/POL/AVAX gas and is reimbursed
 *      (capped at user-signed maxGasReimbursementUsdc) + 5-10% protocol fee out of swept proceeds.
 *   3. REAL-TIME verifiable onchain proof: enforces minNetUsdcOut (reverts if violated) and emits
 *      SponsoredSweepProven with exact gross, gasReimbursement, protocolFee, and netBridged amounts.
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

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Delegate.transfer.selector, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert ERC20CallFailed(token);
        }
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        (bool ok0, bytes memory d0) = token.call(
            abi.encodeWithSelector(IERC20Delegate.approve.selector, spender, 0)
        );
        if (!ok0 || (d0.length > 0 && !abi.decode(d0, (bool)))) revert ERC20CallFailed(token);
        if (amount > 0) {
            (bool ok1, bytes memory d1) = token.call(
                abi.encodeWithSelector(IERC20Delegate.approve.selector, spender, amount)
            );
            if (!ok1 || (d1.length > 0 && !abi.decode(d1, (bool)))) revert ERC20CallFailed(token);
        }
    }
}

contract SiphonSweepDelegate {
    using SafeDelegateERC20 for address;

    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint32 public constant SOLANA_CCTP_DOMAIN = 5;
    uint16 public constant MIN_FEE_BPS = 500;  // 5.0%
    uint16 public constant MAX_FEE_BPS = 1000; // 10.0%

    // secp256k1 half-order for EIP-2 signature malleability protection
    uint256 private constant SECP256K1N_HALF =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant SWEEP_INTENT_TYPEHASH = keccak256(
        "SweepIntent(bytes32 solanaRecipient,address usdc,address cctpMessenger,address feeRecipient,uint16 feeBps,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint256 nonce,uint256 deadline,bytes32 callsHash)"
    );

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
        address tokenIn;
        uint256 amountIn;
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
        bytes32 solanaRecipient;
        address usdc;
        address cctpMessenger;
        address feeRecipient;
        uint16 feeBps;
        uint256 minNetUsdcOut;
        uint256 maxGasReimbursementUsdc;
        uint256 nonce;
        uint256 deadline;
        DefiExit[] defiExits;
        TokenSwap[] swaps;
        DeadBurn[] burns;
        ApprovalRevoke[] revokes;
    }

    /// @dev Dedicated EIP-7201 storage slot so delegate storage never collides with other EOA delegates
    bytes32 private constant STORAGE_SLOT = keccak256("siphon.eip7702.sweep.delegate.v1");

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

    error ExpiredIntent();
    error NonceAlreadyUsed(uint256 nonce);
    error InvalidSignature();
    error InvalidFeeBps(uint16 feeBps);
    error InvalidAddress();
    error GasReimbursementTooHigh(uint256 requested, uint256 maxAllowed);
    error SwapCallFailed(address router);
    error SlippageFloorNotMet(uint256 actualUsdc, uint256 minRequired);
    error Reentrancy();

    receive() external payable {}

    function isNonceUsed(uint256 nonce) external view returns (bool) {
        return _store().usedNonces[nonce];
    }

    function hashIntent(SweepIntent calldata intent) public view returns (bytes32) {
        bytes32 callsHash = keccak256(abi.encode(intent.defiExits, intent.swaps, intent.burns, intent.revokes));
        bytes32 structHash = keccak256(
            abi.encode(
                SWEEP_INTENT_TYPEHASH,
                intent.solanaRecipient,
                intent.usdc,
                intent.cctpMessenger,
                intent.feeRecipient,
                intent.feeBps,
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

        if (block.timestamp > intent.deadline) revert ExpiredIntent();
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
        if (gasReimbursementUsdc > intent.maxGasReimbursementUsdc) {
            revert GasReimbursementTooHigh(gasReimbursementUsdc, intent.maxGasReimbursementUsdc);
        }

        // Verify the delegated EOA (`address(this)`) signed this exact SweepIntent
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) revert InvalidSignature();
        address signer = ecrecover(hashIntent(intent), v, r, s);
        if (signer == address(0) || signer != address(this)) revert InvalidSignature();
        ds.usedNonces[intent.nonce] = true;

        uint256 usdcBefore = IERC20Delegate(intent.usdc).balanceOf(address(this));

        // 1. Exit DeFi positions directly as the EOA (zero aToken approvals required!)
        for (uint256 i = 0; i < intent.defiExits.length; i++) {
            DefiExit calldata ex = intent.defiExits[i];
            if (ex.amount == 0) continue;
            if (ex.kind == ExitKind.AAVE_V3) {
                IAavePoolDelegate(ex.protocol).withdraw(ex.underlyingAsset, ex.amount, address(this));
            } else if (ex.kind == ExitKind.COMPOUND_V3) {
                ICompoundCometDelegate(ex.protocol).withdraw(ex.underlyingAsset, ex.amount);
            } else if (ex.kind == ExitKind.ERC4626) {
                IERC4626Delegate(ex.protocol).redeem(ex.amount, address(this), address(this));
            }
        }

        // 2. Approve & swap all liquid ERC-20s directly from the EOA into native USDC
        for (uint256 i = 0; i < intent.swaps.length; i++) {
            TokenSwap calldata sw = intent.swaps[i];
            if (sw.amountIn == 0 || sw.tokenIn == intent.usdc) continue;
            sw.tokenIn.forceApprove(sw.router, sw.amountIn);
            (bool ok, ) = sw.router.call(sw.callData);
            if (!ok) revert SwapCallFailed(sw.router);
            sw.tokenIn.forceApprove(sw.router, 0);
        }

        // 3. Optional isolated dead-token burns (honeypot-safe)
        uint256 burnedCount = 0;
        for (uint256 i = 0; i < intent.burns.length; i++) {
            DeadBurn calldata b = intent.burns[i];
            if (b.amount == 0) continue;
            (bool ok, bytes memory ret) = b.token.call(
                abi.encodeWithSelector(IERC20Delegate.transfer.selector, DEAD_ADDRESS, b.amount)
            );
            if (ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))))) {
                burnedCount++;
            }
        }

        // 3b. Optional ERC-20 approval hygiene revocations (Wallet Migration Service)
        for (uint256 i = 0; i < intent.revokes.length; i++) {
            ApprovalRevoke calldata rv = intent.revokes[i];
            if (rv.token == address(0) || rv.spender == address(0)) continue;
            rv.token.call(abi.encodeWithSelector(IERC20Delegate.approve.selector, rv.spender, 0));
        }

        // 4. Account exact USDC output, reimburse sponsor gas, route 5-10% protocol fee, & prove slippage floor
        uint256 usdcAfter = IERC20Delegate(intent.usdc).balanceOf(address(this));
        uint256 grossUsdc = usdcAfter > usdcBefore ? (usdcAfter - usdcBefore) : usdcAfter;
        uint256 protocolFeeUsdc = (grossUsdc * intent.feeBps) / 10_000;
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

        // 5. Bridge net USDC 1:1 to Solana via Circle CCTP
        intent.usdc.forceApprove(intent.cctpMessenger, netBridgedUsdc);
        cctpNonce = ITokenMessengerDelegate(intent.cctpMessenger).depositForBurn(
            netBridgedUsdc,
            SOLANA_CCTP_DOMAIN,
            intent.solanaRecipient,
            intent.usdc
        );
        intent.usdc.forceApprove(intent.cctpMessenger, 0);

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
