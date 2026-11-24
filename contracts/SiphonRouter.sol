// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SiphonRouter
 * @notice Single-signature EVM-to-Solana migrator router.
 *
 * Atomically executes across a single user transaction (or Permit2 gas-sponsored relay):
 *   1. Withdraws user capital from DeFi smart contracts (Aave v3, Compound v3, ERC-4626 vaults)
 *   2. Pulls approved ERC-20 dust balances via Permit2 / allowance
 *   3. Swaps all liquid tokens into native chain USDC via approved DEX aggregator targets
 *   4. Safely burns user-selected zero-liquidity / dead tokens to 0x...dEaD using try/catch
 *      so a reverting honeypot or blacklisted scam token NEVER reverts the user's sweep
 *   5. Bridges the consolidated native USDC directly to the user's Solana wallet via Circle CCTP
 *      (TokenMessenger.depositForBurn, destinationDomain = 5, 32-byte Solana Ed25519 pubkey)
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

contract SiphonRouter {
    /// @notice Canonical burn sink for verifiable zero-liquidity token disposal.
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Circle CCTP destination domain ID for Solana Mainnet.
    uint32 public constant SOLANA_CCTP_DOMAIN = 5;

    /// @notice Hard protocol fee cap (1.00% = 100 bps). Default deployment uses 35 bps (0.35%).
    uint16 public constant MAX_FEE_BPS = 100;

    address public immutable usdc;
    ITokenMessengerCCTP public immutable cctpMessenger;
    address public owner;
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
        address protocol;
        address assetOrVault;
        uint256 amount;
    }

    struct SwapStep {
        address tokenIn;
        uint256 amountIn;
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

    error ExpiredDeadline();
    error InvalidSolanaRecipient();
    error TargetNotAllowed(address target);
    error SlippageExceeded(uint256 actualUsdc, uint256 minExpected);
    error ZeroUsdcOutput();
    error Unauthorized();
    error FeeTooHigh();
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
        if (_feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        usdc = _usdc;
        cctpMessenger = ITokenMessengerCCTP(_cctpMessenger);
        owner = msg.sender;
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
    }

    function setAllowedTarget(address target, bool allowed) external onlyOwner {
        allowedTargets[target] = allowed;
        emit TargetUpdated(target, allowed);
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

            if (exitStep.kind == DefiKind.AAVE_V3_WITHDRAW) {
                IAaveV3Pool(exitStep.protocol).withdraw(
                    exitStep.assetOrVault,
                    exitStep.amount,
                    address(this)
                );
            } else if (exitStep.kind == DefiKind.COMPOUND_V3_WITHDRAW) {
                ICompoundV3Comet(exitStep.protocol).withdrawFrom(
                    msg.sender,
                    address(this),
                    exitStep.assetOrVault,
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

        // 2. Pull liquid ERC-20 dust & swap into native USDC via allowlisted aggregators
        for (uint256 i = 0; i < params.swaps.length; i++) {
            SwapStep calldata s = params.swaps[i];
            if (s.tokenIn == usdc) {
                IERC20(usdc).transferFrom(msg.sender, address(this), s.amountIn);
                continue;
            }
            if (!allowedTargets[s.aggregator]) revert TargetNotAllowed(s.aggregator);

            uint256 pulled = s.amountIn;
            if (IERC20(s.tokenIn).allowance(msg.sender, address(this)) >= pulled) {
                IERC20(s.tokenIn).transferFrom(msg.sender, address(this), pulled);
            }

            uint256 swapBal = IERC20(s.tokenIn).balanceOf(address(this));
            if (swapBal == 0) continue;

            IERC20(s.tokenIn).approve(s.aggregator, 0);
            IERC20(s.tokenIn).approve(s.aggregator, swapBal);

            (bool ok, ) = s.aggregator.call(s.swapCalldata);
            require(ok, "AGGREGATOR_SWAP_FAILED");
            IERC20(s.tokenIn).approve(s.aggregator, 0);
        }

        // 3. Safely burn user-selected zero-liquidity / dead tokens (isolated try/catch)
        uint256 burnedCount = 0;
        uint256 skippedBurns = 0;
        for (uint256 i = 0; i < params.burns.length; i++) {
            BurnStep calldata b = params.burns[i];
            if (b.amount == 0) continue;
            try IERC20(b.token).transferFrom(msg.sender, DEAD_ADDRESS, b.amount) returns (bool ok) {
                if (ok) {
                    burnedCount++;
                    emit DeadTokenBurned(msg.sender, b.token, b.amount);
                } else {
                    skippedBurns++;
                    emit DeadTokenSkipped(msg.sender, b.token, "TRANSFER_RETURNED_FALSE");
                }
            } catch {
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
            IERC20(usdc).transfer(feeRecipient, feeUsdc);
        }

        IERC20(usdc).approve(address(cctpMessenger), 0);
        IERC20(usdc).approve(address(cctpMessenger), bridgedUsdc);
        cctpNonce = cctpMessenger.depositForBurn(
            bridgedUsdc,
            SOLANA_CCTP_DOMAIN,
            params.solanaRecipient,
            usdc
        );
        IERC20(usdc).approve(address(cctpMessenger), 0);

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
}
