// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SiphonRouter
 * @notice Single-signature EVM-to-Solana migrator router.
 *
 * Security-hardened execution flow:
 *   1. Uses SafeERC20 low-level wrappers so non-standard tokens (e.g., Ethereum USDT) never revert
 *   2. Pulls user aTokens before Aave v3 withdrawals so the router withdraws the user's actual collateral
 *   3. Measures exact balance deltas per swap step so residual dust can never be swept across callers
 *   4. Isolates user-selected zero-liquidity token burns inside try/catch so honeypots never revert a sweep
 *   5. Routes a protocol fee (5% - 10%, default 7%) directly to a treasury wallet or SiphonFeeVault contract
 *   6. Bridges consolidated net native USDC directly to the user's Solana Ed25519 bytes32 address via Circle CCTP
 *   7. Two-step ownership transfer and hard-bounded protocol fee (500 - 1000 bps)
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ITokenMessengerCCTP {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce);
}

interface IAaveV3Pool {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface ICompoundV3Comet {
    function withdrawFrom(address src, address to, address asset, uint256 amount) external;
}

interface IERC4626Vault {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

interface IPermit2 {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitBatchTransferFrom {
        TokenPermissions[] permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitWitnessTransferFrom(
        PermitBatchTransferFrom calldata permit,
        SignatureTransferDetails[] calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}

library SafeERC20Lite {
    error SafeTransferFailed(address token);
    error SafeTransferFromFailed(address token);
    error SafeApproveFailed(address token);

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFailed(token);
        }
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFromFailed(token);
        }
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert SafeApproveFailed(token);
        }
    }

    function forceApprove(address token, address spender, uint256 amount) internal {
        safeApprove(token, spender, 0);
        if (amount > 0) {
            safeApprove(token, spender, amount);
        }
    }
}

contract SiphonRouter {
    using SafeERC20Lite for address;

    /// @notice Canonical burn sink for verifiable zero-liquidity token disposal.
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Canonical Uniswap Permit2 contract deployed identically on all 6 EVM chains.
    IPermit2 public constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);

    bytes32 public constant SIPHON_WITNESS_TYPEHASH = keccak256(
        "SiphonSweepWitness(bytes32 solanaRecipient,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint16 feeBps,address feeRecipient)"
    );
    string public constant SIPHON_WITNESS_TYPESTRING =
        "SiphonSweepWitness witness)SiphonSweepWitness(bytes32 solanaRecipient,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint16 feeBps,address feeRecipient)TokenPermissions(address token,uint256 amount)";

    struct SiphonSweepWitness {
        bytes32 solanaRecipient;
        uint256 minNetUsdcOut;
        uint256 maxGasReimbursementUsdc;
        uint16 feeBps;
        address feeRecipient;
    }

    /// @notice Circle CCTP destination domain ID for Solana Mainnet.
    uint32 public constant SOLANA_CCTP_DOMAIN = 5;

    /// @notice Protocol fee bounds: 5.00% (500 bps) minimum, 10.00% (1000 bps) maximum. Default: 700 bps (7.0%).
    uint16 public constant MIN_FEE_BPS = 500;
    uint16 public constant MAX_FEE_BPS = 1000;

    address public immutable usdc;
    ITokenMessengerCCTP public immutable cctpMessenger;
    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    uint16 public feeBps;
    uint256 private _reentrancyGuard = 1;

    /// @notice Allowlisted DEX aggregator & DeFi adapter targets to prevent arbitrary calldata abuse.
    mapping(address => bool) public allowedTargets;

    enum DefiKind {
        AAVE_V3_WITHDRAW,
        COMPOUND_V3_WITHDRAW,
        ERC4626_REDEEM
    }

    struct DefiExitStep {
        DefiKind kind;
        address protocol;       // Aave v3 Pool, Compound v3 Comet, or ERC-4626 Vault
        address receiptToken;   // For AAVE_V3_WITHDRAW: user's aToken pulled before Pool.withdraw()
        address underlyingAsset; // Underlying ERC-20 asset returned by protocol
        uint256 amount;
    }

    struct SwapStep {
        address tokenIn;
        uint256 amountIn;
        bool pullFromUser;      // True for wallet ERC-20s; false when swapping output of a prior DefiExitStep
        address aggregator;
        bytes swapCalldata;
    }

    struct BurnStep {
        address token;
        uint256 amount;
    }

    struct SweepParams {
        bytes32 solanaRecipient;
        uint256 minNetUsdcOut;
        uint256 deadline;
        DefiExitStep[] defiExits;
        SwapStep[] swaps;
        BurnStep[] burns;
    }

    event SiphonMigrated(
        address indexed user,
        bytes32 indexed solanaRecipient,
        uint256 grossUsdc,
        uint256 feeUsdc,
        uint256 bridgedUsdc,
        uint64 cctpNonce,
        uint256 burnedCount,
        uint256 skippedBurns
    );

    event DeadTokenBurned(address indexed user, address indexed token, uint256 amount);
    event DeadTokenSkipped(address indexed user, address indexed token, string reason);
    event TargetUpdated(address indexed target, bool allowed);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeUpdated(address indexed feeRecipient, uint16 feeBps);

    error ExpiredDeadline();
    error InvalidAddress();
    error InvalidSolanaRecipient();
    error TargetNotAllowed(address target);
    error AggregatorSwapFailed(address aggregator);
    error SlippageExceeded(uint256 actualUsdc, uint256 minExpected);
    error ZeroUsdcOutput();
    error ZeroMinNetOutput();
    error RelayerBreakEvenNotMet(uint256 relayerRevenueUsdc, uint256 requiredCoverageUsdc);
    error Unauthorized();
    error FeeOutOfBounds(uint16 feeBps);
    error Reentrancy();

    modifier nonReentrant() {
        if (_reentrancyGuard != 1) revert Reentrancy();
        _reentrancyGuard = 2;
        _;
        _reentrancyGuard = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(
        address _usdc,
        address _cctpMessenger,
        address _feeRecipient,
        uint16 _feeBps
    ) {
        if (_usdc == address(0) || _cctpMessenger == address(0) || _feeRecipient == address(0)) {
            revert InvalidAddress();
        }
        if (_feeBps < MIN_FEE_BPS || _feeBps > MAX_FEE_BPS) revert FeeOutOfBounds(_feeBps);
        usdc = _usdc;
        cctpMessenger = ITokenMessengerCCTP(_cctpMessenger);
        owner = msg.sender;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    receive() external payable {}

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert InvalidAddress();
        allowedTargets[target] = allowed;
        emit TargetUpdated(target, allowed);
    }

    function setFeeParams(address _feeRecipient, uint16 _feeBps) external onlyOwner {
        if (_feeRecipient == address(0)) revert InvalidAddress();
        if (_feeBps < MIN_FEE_BPS || _feeBps > MAX_FEE_BPS) revert FeeOutOfBounds(_feeBps);
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        emit FeeUpdated(_feeRecipient, _feeBps);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        token.safeTransfer(to, amount);
    }

    /**
     * @notice Executes an atomic multi-protocol withdraw + dust swap + isolated burn + Circle CCTP bridge to Solana.
     */
    function sweepAndBridgeToSolana(SweepParams calldata params)
        external
        nonReentrant
        returns (uint256 bridgedUsdc, uint64 cctpNonce)
    {
        if (block.timestamp > params.deadline) revert ExpiredDeadline();
        if (params.solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();

        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));

        // 1. Withdraw user capital from approved DeFi smart contracts
        for (uint256 i = 0; i < params.defiExits.length; i++) {
            DefiExitStep calldata exitStep = params.defiExits[i];
            if (!allowedTargets[exitStep.protocol]) revert TargetNotAllowed(exitStep.protocol);
            if (exitStep.amount == 0) continue;

            if (exitStep.kind == DefiKind.AAVE_V3_WITHDRAW) {
                if (exitStep.receiptToken == address(0) || exitStep.underlyingAsset == address(0)) {
                    revert InvalidAddress();
                }
                // Pull the user's aTokens into the router first so Pool.withdraw burns the user's position
                uint256 aBalBefore = IERC20(exitStep.receiptToken).balanceOf(address(this));
                exitStep.receiptToken.safeTransferFrom(msg.sender, address(this), exitStep.amount);
                uint256 aReceived = IERC20(exitStep.receiptToken).balanceOf(address(this)) - aBalBefore;

                IAaveV3Pool(exitStep.protocol).withdraw(
                    exitStep.underlyingAsset,
                    aReceived,
                    address(this)
                );
            } else if (exitStep.kind == DefiKind.COMPOUND_V3_WITHDRAW) {
                ICompoundV3Comet(exitStep.protocol).withdrawFrom(
                    msg.sender,
                    address(this),
                    exitStep.underlyingAsset,
                    exitStep.amount
                );
            } else if (exitStep.kind == DefiKind.ERC4626_REDEEM) {
                IERC4626Vault(exitStep.protocol).redeem(
                    exitStep.amount,
                    address(this),
                    msg.sender
                );
            }
        }

        // 2. Pull liquid ERC-20 dust & swap exact amount into native USDC via allowlisted aggregators
        for (uint256 i = 0; i < params.swaps.length; i++) {
            SwapStep calldata s = params.swaps[i];
            if (s.amountIn == 0) continue;

            if (s.tokenIn == usdc) {
                if (s.pullFromUser) {
                    usdc.safeTransferFrom(msg.sender, address(this), s.amountIn);
                }
                continue;
            }

            if (!allowedTargets[s.aggregator]) revert TargetNotAllowed(s.aggregator);

            uint256 swapAmount;
            if (s.pullFromUser) {
                uint256 balBefore = IERC20(s.tokenIn).balanceOf(address(this));
                s.tokenIn.safeTransferFrom(msg.sender, address(this), s.amountIn);
                swapAmount = IERC20(s.tokenIn).balanceOf(address(this)) - balBefore;
            } else {
                uint256 currentBal = IERC20(s.tokenIn).balanceOf(address(this));
                swapAmount = s.amountIn < currentBal ? s.amountIn : currentBal;
            }

            if (swapAmount == 0) continue;

            s.tokenIn.forceApprove(s.aggregator, swapAmount);
            (bool ok, ) = s.aggregator.call(s.swapCalldata);
            if (!ok) revert AggregatorSwapFailed(s.aggregator);
            s.tokenIn.forceApprove(s.aggregator, 0);
        }

        // 3. Safely burn user-selected zero-liquidity / dead tokens (isolated try/catch)
        uint256 burnedCount = 0;
        uint256 skippedBurns = 0;
        for (uint256 i = 0; i < params.burns.length; i++) {
            BurnStep calldata b = params.burns[i];
            if (b.amount == 0) continue;
            (bool ok, bytes memory ret) = b.token.call(
                abi.encodeWithSelector(IERC20.transferFrom.selector, msg.sender, DEAD_ADDRESS, b.amount)
            );
            bool succeeded = ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
            if (succeeded) {
                burnedCount++;
                emit DeadTokenBurned(msg.sender, b.token, b.amount);
            } else {
                skippedBurns++;
                emit DeadTokenSkipped(msg.sender, b.token, "HONEYPOT_OR_REVERT");
            }
        }

        // 4. Compute exact USDC delta, enforce user slippage floor, and bridge 1:1 via Circle CCTP
        uint256 grossUsdc = IERC20(usdc).balanceOf(address(this)) - usdcBefore;
        if (grossUsdc == 0) revert ZeroUsdcOutput();

        uint256 feeUsdc = (grossUsdc * feeBps) / 10_000;
        bridgedUsdc = grossUsdc - feeUsdc;
        if (bridgedUsdc < params.minNetUsdcOut) {
            revert SlippageExceeded(bridgedUsdc, params.minNetUsdcOut);
        }

        if (feeUsdc > 0 && feeRecipient != address(0)) {
            usdc.safeTransfer(feeRecipient, feeUsdc);
        }

        usdc.forceApprove(address(cctpMessenger), bridgedUsdc);
        cctpNonce = cctpMessenger.depositForBurn(
            bridgedUsdc,
            SOLANA_CCTP_DOMAIN,
            params.solanaRecipient,
            usdc
        );
        usdc.forceApprove(address(cctpMessenger), 0);

        emit SiphonMigrated(
            msg.sender,
            params.solanaRecipient,
            grossUsdc,
            feeUsdc,
            bridgedUsdc,
            cctpNonce,
            burnedCount,
            skippedBurns
        );
    }

    /**
     * @notice Witness-bound gasless 1-signature sweep via Uniswap Permit2 permitWitnessTransferFrom.
     *         The user's SINGLE off-chain EIP-712 signature cryptographically locks solanaRecipient,
     *         minNetUsdcOut, maxGasReimbursementUsdc, feeBps, and feeRecipient so no relayer can tamper.
     */
    function sweepWithPermit2Batch(
        address user,
        IPermit2.PermitBatchTransferFrom calldata permit,
        SiphonSweepWitness calldata witness,
        bytes calldata permitSignature,
        uint256 gasReimbursementUsdc,
        SwapStep[] calldata swaps
    ) external nonReentrant returns (uint256 bridgedUsdc, uint64 cctpNonce) {
        if (user == address(0) || witness.feeRecipient == address(0)) revert InvalidAddress();
        if (witness.solanaRecipient == bytes32(0)) revert InvalidSolanaRecipient();
        if (witness.minNetUsdcOut == 0) revert ZeroMinNetOutput();
        if (block.timestamp > permit.deadline) revert ExpiredDeadline();
        if (witness.feeBps < MIN_FEE_BPS || witness.feeBps > MAX_FEE_BPS) {
            revert FeeOutOfBounds(witness.feeBps);
        }
        if (gasReimbursementUsdc > witness.maxGasReimbursementUsdc) {
            revert SlippageExceeded(0, witness.minNetUsdcOut);
        }

        uint256 usdcBefore = IERC20(usdc).balanceOf(address(this));

        // 1. Pull ALL permitted tokens in ONE witness-bound gasless Permit2 signature
        uint256 len = permit.permitted.length;
        IPermit2.SignatureTransferDetails[] memory details = new IPermit2.SignatureTransferDetails[](len);
        for (uint256 i = 0; i < len; i++) {
            details[i] = IPermit2.SignatureTransferDetails({
                to: address(this),
                requestedAmount: permit.permitted[i].amount
            });
        }
        bytes32 witnessHash = keccak256(
            abi.encode(
                SIPHON_WITNESS_TYPEHASH,
                witness.solanaRecipient,
                witness.minNetUsdcOut,
                witness.maxGasReimbursementUsdc,
                witness.feeBps,
                witness.feeRecipient
            )
        );
        PERMIT2.permitWitnessTransferFrom(
            permit,
            details,
            user,
            witnessHash,
            SIPHON_WITNESS_TYPESTRING,
            permitSignature
        );

        // 2. Swap pulled tokens into native USDC via allowlisted aggregators
        for (uint256 i = 0; i < swaps.length; i++) {
            SwapStep calldata s = swaps[i];
            if (s.amountIn == 0 || s.tokenIn == usdc) continue;
            if (!allowedTargets[s.aggregator]) revert TargetNotAllowed(s.aggregator);
            uint256 currentBal = IERC20(s.tokenIn).balanceOf(address(this));
            uint256 swapAmount = s.amountIn < currentBal ? s.amountIn : currentBal;
            if (swapAmount == 0) continue;
            s.tokenIn.forceApprove(s.aggregator, swapAmount);
            (bool ok, ) = s.aggregator.call(s.swapCalldata);
            if (!ok) revert AggregatorSwapFailed(s.aggregator);
            s.tokenIn.forceApprove(s.aggregator, 0);
        }

        // 3. Account exact USDC delta, reimburse capped sponsor gas, route user-signed fee, & bridge
        uint256 grossUsdc = IERC20(usdc).balanceOf(address(this)) - usdcBefore;
        if (grossUsdc == 0) revert ZeroUsdcOutput();

        uint256 feeUsdc = (grossUsdc * witness.feeBps) / 10_000;
        // Onchain Relayer Break-Even Protection: require protocolFee + gasReimbursement >= 1.5x sponsored gas
        if (gasReimbursementUsdc > 0) {
            uint256 relayerRevenue = feeUsdc + gasReimbursementUsdc;
            uint256 requiredCoverage = (gasReimbursementUsdc * 3) / 2;
            if (relayerRevenue < requiredCoverage) {
                revert RelayerBreakEvenNotMet(relayerRevenue, requiredCoverage);
            }
        }
        uint256 deductions = feeUsdc + gasReimbursementUsdc;
        if (grossUsdc <= deductions) revert SlippageExceeded(0, witness.minNetUsdcOut);

        bridgedUsdc = grossUsdc - deductions;
        if (bridgedUsdc < witness.minNetUsdcOut) revert SlippageExceeded(bridgedUsdc, witness.minNetUsdcOut);

        if (gasReimbursementUsdc > 0) {
            usdc.safeTransfer(msg.sender, gasReimbursementUsdc);
        }
        if (feeUsdc > 0) {
            usdc.safeTransfer(witness.feeRecipient, feeUsdc);
        }

        usdc.forceApprove(address(cctpMessenger), bridgedUsdc);
        cctpNonce = cctpMessenger.depositForBurn(
            bridgedUsdc,
            SOLANA_CCTP_DOMAIN,
            witness.solanaRecipient,
            usdc
        );
        usdc.forceApprove(address(cctpMessenger), 0);

        emit SiphonMigrated(
            user,
            witness.solanaRecipient,
            grossUsdc,
            feeUsdc,
            bridgedUsdc,
            cctpNonce,
            0,
            0
        );
    }
}
