// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title TurgaliumFlashUnwind
 * @notice Zero-fee (0%), non-custodial atomic Flash-Loan Self-Unwind executor for
 *         Aave V3 and Aave V3 fork pools across all EVM chains (Neverland on Monad,
 *         Aave v3 on Ethereum/Arbitrum/Optimism/Base/Polygon/Avalanche/BNB/Gnosis/
 *         Scroll/Linea/Sonic/Celo, SparkLend, Seamless, Lendle, HyperLend).
 *
 * Atomic 1-transaction flow (`unwindSimple` or `unwindMulti`) requiring $0 upfront debt capital:
 *   1. Caller (`msg.sender` == collateral owner) optionally attaches EIP-2612 aToken permits
 *      or pre-approves `aToken` allowance to this contract.
 *   2. Contract queries `Pool.getReserveData(debtAsset)` on-chain; when `debtAmount == MAX_UINT256`,
 *      it reads live `variableDebtToken.balanceOf(msg.sender)` + a 1 ppm (+2 wei) ray-rounding buffer.
 *   3. Contract calls `Pool.flashLoanSimple` (single debt) or `Pool.flashLoan` (multi-debt) on the
 *      owner-allowlisted Aave V3 Pool.
 *   4. Inside `executeOperation`:
 *        a. Strictly verifies `msg.sender == _activePool`, `initiator == address(this)`, and
 *           `_activeCallbackHash` binding.
 *        b. Calls `Pool.repay(debtAsset, repayArg, rateMode, user)` -> clears user's debt so
 *           health factor restriction lifts immediately (even from HF 1.01).
 *        c. Resolves each collateral `aToken` on-chain via `Pool.getReserveData(c.asset)`, pulls
 *           `aToken` from `user`, and calls `Pool.withdraw(c.asset, MAX_UINT256, address(this))`.
 *        d. Executes 0..N swaps on owner-allowlisted DEX routers (e.g., KyberSwap, LI.FI, OpenOcean,
 *           1inch, ParaSwap, Odos) with exact approval reset to 0 and per-swap `minAmountOut` checks.
 *        e. Verifies `debtAsset.balanceOf(this) >= amount + premium` and approves exact `amount + premium`
 *           back to `Pool`.
 *   5. After the flash loan settles, resets pool approval to 0 and sweeps 100% of remaining surplus
 *      (net equity in `debtAsset` + any unswapped collateral tokens) directly to `recipient` with
 *      slippage checks (`minDebtSurplus` and per-collateral `minRemainingOut`).
 *
 * Security properties:
 *   - 0% protocol fee, stateless between transactions (never custodies user funds).
 *   - Only `msg.sender` can unwind their own position (no third-party griefing / forced unwind).
 *   - Strictly disjoint allowlists: `allowedPools` vs `allowedSwapRouters`.
 *   - Hardened SafeERC20Lite (code.length > 0, return-value safe, zero-first forceApprove).
 *   - Two-step ownership transfer (`transferOwnership` -> `acceptOwnership`) + pause circuit breaker.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IAaveV3FlashPool {
    struct ReserveConfigurationMap {
        uint256 data;
    }

    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    function getReserveData(address asset) external view returns (ReserveData memory);

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata interestRateModes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

library SafeERC20FlashLite {
    error TokenNotContract(address token);
    error SafeTransferFailed(address token);
    error SafeTransferFromFailed(address token);
    error SafeApproveFailed(address token);

    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        if (address(token).code.length == 0) revert TokenNotContract(address(token));
        (bool ok, bytes memory ret) = address(token).call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        if (!ok || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) {
            revert SafeTransferFailed(address(token));
        }
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        if (address(token).code.length == 0) revert TokenNotContract(address(token));
        (bool ok, bytes memory ret) = address(token).call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        if (!ok || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) {
            revert SafeTransferFromFailed(address(token));
        }
    }

    function forceApprove(IERC20 token, address spender, uint256 amount) internal {
        if (address(token).code.length == 0) revert TokenNotContract(address(token));
        (bool ok, bytes memory ret) = address(token).call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, amount)
        );
        if (ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))))) {
            return;
        }
        // USDT-style non-zero -> zero -> target approval reset
        (bool resetOk, bytes memory resetRet) = address(token).call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, 0)
        );
        if (!resetOk || (resetRet.length != 0 && (resetRet.length < 32 || !abi.decode(resetRet, (bool))))) {
            revert SafeApproveFailed(address(token));
        }
        if (amount == 0) return;
        (bool ok2, bytes memory ret2) = address(token).call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, amount)
        );
        if (!ok2 || (ret2.length != 0 && (ret2.length < 32 || !abi.decode(ret2, (bool))))) {
            revert SafeApproveFailed(address(token));
        }
    }
}

contract TurgaliumFlashUnwind {
    using SafeERC20FlashLite for IERC20;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct PermitApproval {
        address token;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct CollateralPull {
        /// @notice Underlying reserve asset on the Aave V3 pool (e.g., sMON, gMON, WETH, WBTC)
        address asset;
        /// @notice Amount of aToken to pull from caller; pass type(uint256).max for 100% of balance
        uint256 aTokenAmount;
        /// @notice Minimum remaining underlying balance of this collateral sent to recipient after swaps
        uint256 minRemainingOut;
    }

    struct SwapStep {
        /// @notice Owner-allowlisted DEX aggregator / router contract
        address router;
        /// @notice ERC-20 token spent by the swap
        address tokenIn;
        /// @notice ERC-20 token received by the swap
        address tokenOut;
        /// @notice Amount of tokenIn to approve & spend (pass type(uint256).max for full contract balance)
        uint256 amountIn;
        /// @notice Minimum tokenOut delta received by this contract
        uint256 minAmountOut;
        /// @notice Encoded swap calldata targeting `router`
        bytes callData;
    }

    struct SimpleUnwindParams {
        address debtAsset;
        /// @notice Exact debt amount to flash-repay, or type(uint256).max to repay 100% live variable debt
        uint256 debtAmount;
        /// @notice Interest rate mode (2 = variable debt, 1 = stable debt)
        uint256 interestRateMode;
        CollateralPull[] collaterals;
        SwapStep[] swaps;
        PermitApproval[] permits;
        /// @notice Destination for net equity (defaults to msg.sender if address(0))
        address recipient;
        /// @notice Slippage floor on net surplus debtAsset returned to recipient after flash loan repayment
        uint256 minDebtSurplus;
        /// @notice Transaction expiration timestamp
        uint256 deadline;
    }

    struct MultiUnwindParams {
        address[] debtAssets;
        /// @notice Exact debt amounts or type(uint256).max per leg for 100% live debt repayment
        uint256[] debtAmounts;
        /// @notice Interest rate modes per debt leg (2 = variable)
        uint256[] interestRateModes;
        CollateralPull[] collaterals;
        SwapStep[] swaps;
        PermitApproval[] permits;
        address recipient;
        /// @notice Slippage floors per debt leg after flash loan repayment
        uint256[] minDebtSurpluses;
        uint256 deadline;
    }

    struct SimpleCallbackContext {
        address user;
        bool repayFull;
        uint256 interestRateMode;
        CollateralPull[] collaterals;
        SwapStep[] swaps;
    }

    struct MultiCallbackContext {
        address user;
        bool[] repayFullFlags;
        uint256[] interestRateModes;
        CollateralPull[] collaterals;
        SwapStep[] swaps;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    uint256 private constant _UNLOCKED = 1;
    uint256 private constant _LOCKED = 2;

    uint256 private _lockState = _UNLOCKED;
    address private _activePool;
    bytes32 private _activeCallbackHash;
    uint256 private _lastRepaidSingle;
    uint256[] private _lastRepaidMulti;

    address public owner;
    address public pendingOwner;
    bool public paused;

    mapping(address => bool) public allowedPools;
    mapping(address => bool) public allowedSwapRouters;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PausedSet(bool paused);
    event AllowedPoolSet(address indexed pool, bool allowed);
    event AllowedSwapRouterSet(address indexed router, bool allowed);
    event FlashUnwoundSimple(
        address indexed user,
        address indexed pool,
        address indexed debtAsset,
        uint256 debtRepaid,
        uint256 debtSurplus,
        address recipient
    );
    event FlashUnwoundMulti(
        address indexed user,
        address indexed pool,
        uint256 debtLegCount,
        address recipient
    );
    event RescuedERC20(address indexed token, address indexed to, uint256 amount);
    event RescuedETH(address indexed to, uint256 amount);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error Unauthorized();
    error ContractPaused();
    error ReentrancyBlocked();
    error InvalidAddress();
    error ExpiredDeadline(uint256 deadline, uint256 currentTimestamp);
    error PoolNotAllowed(address pool);
    error RouterNotAllowed(address router);
    error DisjointAllowlistViolation(address target);
    error InvalidRateMode(uint256 mode);
    error InvalidArrayLengths();
    error NoActiveDebt(address asset);
    error ReserveNotFound(address asset);
    error ZeroCollateralBalance(address aToken);
    error InvalidCallbackCaller(address caller, address expected);
    error InvalidCallbackInitiator(address initiator);
    error InvalidCallbackContext();
    error InvalidSwapStep(uint256 index);
    error SwapExecutionFailed(uint256 index, bytes reason);
    error SwapSlippageExceeded(uint256 index, uint256 received, uint256 minRequired);
    error InsufficientRepayBalance(address asset, uint256 available, uint256 required);
    error MinDebtSurplusNotMet(address asset, uint256 surplus, uint256 minRequired);
    error MinCollateralOutNotMet(address asset, uint256 received, uint256 minRequired);
    error EthRescueFailed();

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_lockState != _UNLOCKED) revert ReentrancyBlocked();
        _lockState = _LOCKED;
        _;
        _lockState = _UNLOCKED;
    }

    // -------------------------------------------------------------------------
    // Constructor & Governance
    // -------------------------------------------------------------------------

    constructor(
        address initialOwner,
        address[] memory initialPools,
        address[] memory initialRouters
    ) {
        if (initialOwner == address(0)) revert InvalidAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);

        for (uint256 i = 0; i < initialPools.length; i++) {
            address p = initialPools[i];
            if (p == address(0) || p == address(this)) revert InvalidAddress();
            allowedPools[p] = true;
            emit AllowedPoolSet(p, true);
        }

        for (uint256 i = 0; i < initialRouters.length; i++) {
            address r = initialRouters[i];
            if (r == address(0) || r == address(this)) revert InvalidAddress();
            if (allowedPools[r]) revert DisjointAllowlistViolation(r);
            allowedSwapRouters[r] = true;
            emit AllowedSwapRouterSet(r, true);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setAllowedPool(address pool, bool allowed) external onlyOwner {
        if (pool == address(0) || pool == address(this)) revert InvalidAddress();
        if (allowed && allowedSwapRouters[pool]) revert DisjointAllowlistViolation(pool);
        allowedPools[pool] = allowed;
        emit AllowedPoolSet(pool, allowed);
    }

    function setAllowedSwapRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0) || router == address(this)) revert InvalidAddress();
        if (allowed && allowedPools[router]) revert DisjointAllowlistViolation(router);
        allowedSwapRouters[router] = allowed;
        emit AllowedSwapRouterSet(router, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address prev = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }

    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
        emit RescuedERC20(token, to, amount);
    }

    function rescueETH(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert EthRescueFailed();
        emit RescuedETH(to, amount);
    }

    // -------------------------------------------------------------------------
    // Core Single-Debt Atomic Flash Unwind (flashLoanSimple)
    // -------------------------------------------------------------------------

    function unwindSimple(
        address pool,
        SimpleUnwindParams calldata p
    ) external nonReentrant whenNotPaused returns (uint256 debtRepaid, uint256 debtSurplus) {
        if (block.timestamp > p.deadline) revert ExpiredDeadline(p.deadline, block.timestamp);
        if (!allowedPools[pool]) revert PoolNotAllowed(pool);
        if (p.debtAsset == address(0)) revert InvalidAddress();
        if (p.interestRateMode != 1 && p.interestRateMode != 2) {
            revert InvalidRateMode(p.interestRateMode);
        }
        if (p.collaterals.length == 0) revert InvalidArrayLengths();

        address recipient = p.recipient == address(0) ? msg.sender : p.recipient;

        // 1. Apply any optional EIP-2612 permits (wrapped so already-approved or front-run permit never DoSes)
        _applyPermits(msg.sender, p.permits);

        // 2. Resolve live debt amount on-chain when debtAmount == MAX_UINT256
        bool repayFull = p.debtAmount == type(uint256).max;
        uint256 flashAmount = _resolveFlashDebtAmount(
            pool,
            p.debtAsset,
            p.debtAmount,
            p.interestRateMode,
            msg.sender
        );

        // 3. Bind callback state and execute Pool.flashLoanSimple
        bytes memory callbackParams = abi.encode(
            SimpleCallbackContext({
                user: msg.sender,
                repayFull: repayFull,
                interestRateMode: p.interestRateMode,
                collaterals: p.collaterals,
                swaps: p.swaps
            })
        );

        _activePool = pool;
        _activeCallbackHash = keccak256(abi.encode(uint8(1), pool, p.debtAsset, flashAmount, callbackParams));
        _lastRepaidSingle = 0;

        IAaveV3FlashPool(pool).flashLoanSimple(address(this), p.debtAsset, flashAmount, callbackParams, 0);

        // 4. Clear callback state & zero out pool approval
        _activePool = address(0);
        _activeCallbackHash = bytes32(0);
        debtRepaid = _lastRepaidSingle;
        _lastRepaidSingle = 0;

        IERC20(p.debtAsset).forceApprove(pool, 0);

        // 5. Sweep 100% of surplus debtAsset + remaining withdrawn collaterals + any distinct swap outputs
        debtSurplus = IERC20(p.debtAsset).balanceOf(address(this));
        if (debtSurplus < p.minDebtSurplus) {
            revert MinDebtSurplusNotMet(p.debtAsset, debtSurplus, p.minDebtSurplus);
        }
        if (debtSurplus > 0) {
            IERC20(p.debtAsset).safeTransfer(recipient, debtSurplus);
        }

        _sweepRemainingTokens(recipient, p.collaterals, p.swaps);

        emit FlashUnwoundSimple(msg.sender, pool, p.debtAsset, debtRepaid, debtSurplus, recipient);
    }

    // -------------------------------------------------------------------------
    // Core Multi-Debt Atomic Flash Unwind (flashLoan)
    // -------------------------------------------------------------------------

    function unwindMulti(
        address pool,
        MultiUnwindParams calldata p
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256[] memory debtsRepaid, uint256[] memory debtSurpluses)
    {
        if (block.timestamp > p.deadline) revert ExpiredDeadline(p.deadline, block.timestamp);
        if (!allowedPools[pool]) revert PoolNotAllowed(pool);

        uint256 n = p.debtAssets.length;
        if (
            n == 0 ||
            p.debtAmounts.length != n ||
            p.interestRateModes.length != n ||
            p.minDebtSurpluses.length != n ||
            p.collaterals.length == 0
        ) {
            revert InvalidArrayLengths();
        }

        address recipient = p.recipient == address(0) ? msg.sender : p.recipient;

        _applyPermits(msg.sender, p.permits);

        uint256[] memory flashAmounts = new uint256[](n);
        uint256[] memory flashModes = new uint256[](n);
        bool[] memory repayFullFlags = new bool[](n);

        for (uint256 i = 0; i < n; i++) {
            if (p.debtAssets[i] == address(0)) revert InvalidAddress();
            if (p.interestRateModes[i] != 1 && p.interestRateModes[i] != 2) {
                revert InvalidRateMode(p.interestRateModes[i]);
            }
            repayFullFlags[i] = p.debtAmounts[i] == type(uint256).max;
            flashAmounts[i] = _resolveFlashDebtAmount(
                pool,
                p.debtAssets[i],
                p.debtAmounts[i],
                p.interestRateModes[i],
                msg.sender
            );
            flashModes[i] = 0; // 0 = no debt (atomic flash loan repaid in same tx)
        }

        bytes memory callbackParams = abi.encode(
            MultiCallbackContext({
                user: msg.sender,
                repayFullFlags: repayFullFlags,
                interestRateModes: p.interestRateModes,
                collaterals: p.collaterals,
                swaps: p.swaps
            })
        );

        _activePool = pool;
        _activeCallbackHash = keccak256(
            abi.encode(uint8(2), pool, p.debtAssets, flashAmounts, callbackParams)
        );
        delete _lastRepaidMulti;

        IAaveV3FlashPool(pool).flashLoan(
            address(this),
            p.debtAssets,
            flashAmounts,
            flashModes,
            address(this),
            callbackParams,
            0
        );

        _activePool = address(0);
        _activeCallbackHash = bytes32(0);
        debtsRepaid = _lastRepaidMulti;
        delete _lastRepaidMulti;

        debtSurpluses = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address dAsset = p.debtAssets[i];
            IERC20(dAsset).forceApprove(pool, 0);
            uint256 surplus = IERC20(dAsset).balanceOf(address(this));
            if (surplus < p.minDebtSurpluses[i]) {
                revert MinDebtSurplusNotMet(dAsset, surplus, p.minDebtSurpluses[i]);
            }
            debtSurpluses[i] = surplus;
            if (surplus > 0) {
                IERC20(dAsset).safeTransfer(recipient, surplus);
            }
        }

        _sweepRemainingTokens(recipient, p.collaterals, p.swaps);

        emit FlashUnwoundMulti(msg.sender, pool, n, recipient);
    }

    // -------------------------------------------------------------------------
    // Aave V3 Flash Loan Callbacks
    // -------------------------------------------------------------------------

    /// @notice Aave V3 `IFlashLoanSimpleReceiver` callback.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        address pool = _activePool;
        if (pool == address(0) || msg.sender != pool) {
            revert InvalidCallbackCaller(msg.sender, pool);
        }
        if (initiator != address(this)) revert InvalidCallbackInitiator(initiator);

        bytes32 expectedHash = keccak256(abi.encode(uint8(1), pool, asset, amount, params));
        if (expectedHash != _activeCallbackHash) revert InvalidCallbackContext();
        // Consume callback hash immediately to prevent any nested re-entry
        _activeCallbackHash = bytes32(0);

        SimpleCallbackContext memory ctx = abi.decode(params, (SimpleCallbackContext));

        // 1. Repay user's debt on the Aave V3 pool.
        //    NOTE: Aave V3 ValidationLogic rejects `amount == MAX_UINT256` when `msg.sender != onBehalfOf`
        //    (Error 40: NO_EXPLICIT_AMOUNT_TO_REPAY_ON_BEHALF). Read exact live debt inside the callback
        //    (same block.timestamp) and pass an explicit uint256 capped at the flashed `amount`.
        uint256 repayArg = _resolveExplicitRepayAmount(pool, asset, amount, ctx.repayFull, ctx.interestRateMode, ctx.user);
        IERC20(asset).forceApprove(pool, repayArg);
        uint256 repaid = IAaveV3FlashPool(pool).repay(asset, repayArg, ctx.interestRateMode, ctx.user);
        _lastRepaidSingle = repaid;

        // 2. Pull user's aTokens (now unlocked with 0 debt!) and withdraw underlying
        _pullAndWithdrawCollaterals(pool, ctx.user, ctx.collaterals);

        // 3. Execute DEX swaps on owner-allowlisted routers to source debtAsset repayment
        _executeSwaps(pool, ctx.swaps);

        // 4. Verify sufficient balance for flash loan repayment + premium and approve exact totalOwed
        uint256 totalOwed = amount + premium;
        uint256 available = IERC20(asset).balanceOf(address(this));
        if (available < totalOwed) {
            revert InsufficientRepayBalance(asset, available, totalOwed);
        }
        IERC20(asset).forceApprove(pool, totalOwed);

        return true;
    }

    /// @notice Aave V3 `IFlashLoanReceiver` multi-asset callback.
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        address pool = _activePool;
        if (pool == address(0) || msg.sender != pool) {
            revert InvalidCallbackCaller(msg.sender, pool);
        }
        if (initiator != address(this)) revert InvalidCallbackInitiator(initiator);

        bytes32 expectedHash = keccak256(abi.encode(uint8(2), pool, assets, amounts, params));
        if (expectedHash != _activeCallbackHash) revert InvalidCallbackContext();
        _activeCallbackHash = bytes32(0);

        MultiCallbackContext memory ctx = abi.decode(params, (MultiCallbackContext));

        uint256 n = assets.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 repayArg = _resolveExplicitRepayAmount(
                pool,
                assets[i],
                amounts[i],
                ctx.repayFullFlags[i],
                ctx.interestRateModes[i],
                ctx.user
            );
            IERC20(assets[i]).forceApprove(pool, repayArg);
            uint256 repaid = IAaveV3FlashPool(pool).repay(
                assets[i],
                repayArg,
                ctx.interestRateModes[i],
                ctx.user
            );
            _lastRepaidMulti.push(repaid);
        }

        _pullAndWithdrawCollaterals(pool, ctx.user, ctx.collaterals);
        _executeSwaps(pool, ctx.swaps);

        for (uint256 i = 0; i < n; i++) {
            uint256 totalOwed = amounts[i] + premiums[i];
            uint256 available = IERC20(assets[i]).balanceOf(address(this));
            if (available < totalOwed) {
                revert InsufficientRepayBalance(assets[i], available, totalOwed);
            }
            IERC20(assets[i]).forceApprove(pool, totalOwed);
        }

        return true;
    }

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    function _applyPermits(address user, PermitApproval[] calldata permits) private {
        for (uint256 i = 0; i < permits.length; i++) {
            PermitApproval calldata perm = permits[i];
            if (perm.token == address(0)) revert InvalidAddress();
            // Permit is best-effort: if user already approved or a relayer front-ran the exact permit, continue.
            try
                IERC20Permit(perm.token).permit(
                    user,
                    address(this),
                    perm.value,
                    perm.deadline,
                    perm.v,
                    perm.r,
                    perm.s
                )
            {} catch {}
        }
    }

    function _resolveFlashDebtAmount(
        address pool,
        address debtAsset,
        uint256 requestedAmount,
        uint256 interestRateMode,
        address user
    ) private view returns (uint256 flashAmount) {
        if (requestedAmount != type(uint256).max) {
            if (requestedAmount == 0) revert NoActiveDebt(debtAsset);
            return requestedAmount;
        }

        IAaveV3FlashPool.ReserveData memory rd = IAaveV3FlashPool(pool).getReserveData(debtAsset);
        address debtToken = interestRateMode == 1
            ? rd.stableDebtTokenAddress
            : rd.variableDebtTokenAddress;
        if (debtToken == address(0)) revert ReserveNotFound(debtAsset);

        uint256 liveDebt = IERC20(debtToken).balanceOf(user);
        if (liveDebt == 0) revert NoActiveDebt(debtAsset);

        // Add 1 ppm + 2 wei buffer to protect against Aave V3 rayMul/rayDiv 1-2 wei rounding;
        // inside executeOperation we pass exact liveDebt (explicit uint256, avoiding Aave Error 40).
        uint256 roundingBuffer = (liveDebt / 1_000_000) + 2;
        return liveDebt + roundingBuffer;
    }

    function _resolveExplicitRepayAmount(
        address pool,
        address debtAsset,
        uint256 flashedAmount,
        bool repayFull,
        uint256 interestRateMode,
        address user
    ) private view returns (uint256) {
        if (!repayFull) return flashedAmount;
        IAaveV3FlashPool.ReserveData memory rd = IAaveV3FlashPool(pool).getReserveData(debtAsset);
        address debtToken = interestRateMode == 1
            ? rd.stableDebtTokenAddress
            : rd.variableDebtTokenAddress;
        if (debtToken == address(0)) return flashedAmount;
        uint256 liveDebt = IERC20(debtToken).balanceOf(user);
        if (liveDebt == 0) revert NoActiveDebt(debtAsset);
        return liveDebt < flashedAmount ? liveDebt : flashedAmount;
    }

    function _pullAndWithdrawCollaterals(
        address pool,
        address user,
        CollateralPull[] memory collaterals
    ) private {
        for (uint256 i = 0; i < collaterals.length; i++) {
            CollateralPull memory c = collaterals[i];
            if (c.asset == address(0)) revert InvalidAddress();

            IAaveV3FlashPool.ReserveData memory rd = IAaveV3FlashPool(pool).getReserveData(c.asset);
            address aToken = rd.aTokenAddress;
            if (aToken == address(0)) revert ReserveNotFound(c.asset);

            uint256 pullAmount = c.aTokenAmount == type(uint256).max
                ? IERC20(aToken).balanceOf(user)
                : c.aTokenAmount;
            if (pullAmount == 0) revert ZeroCollateralBalance(aToken);

            IERC20(aToken).safeTransferFrom(user, address(this), pullAmount);
            IAaveV3FlashPool(pool).withdraw(c.asset, type(uint256).max, address(this));
        }
    }

    function _executeSwaps(address pool, SwapStep[] memory swaps) private {
        for (uint256 i = 0; i < swaps.length; i++) {
            SwapStep memory s = swaps[i];
            if (
                s.router == address(0) ||
                s.router == address(this) ||
                s.router == pool ||
                s.tokenIn == address(0) ||
                s.tokenOut == address(0) ||
                s.callData.length < 4
            ) {
                revert InvalidSwapStep(i);
            }
            if (!allowedSwapRouters[s.router]) revert RouterNotAllowed(s.router);

            uint256 inBalance = IERC20(s.tokenIn).balanceOf(address(this));
            uint256 approveAmt = s.amountIn == type(uint256).max ? inBalance : s.amountIn;
            if (approveAmt == 0 || approveAmt > inBalance) revert InvalidSwapStep(i);

            uint256 outBefore = IERC20(s.tokenOut).balanceOf(address(this));
            IERC20(s.tokenIn).forceApprove(s.router, approveAmt);

            (bool ok, bytes memory ret) = s.router.call(s.callData);
            // Always clear router allowance immediately after call
            IERC20(s.tokenIn).forceApprove(s.router, 0);

            if (!ok) revert SwapExecutionFailed(i, ret);

            uint256 outAfter = IERC20(s.tokenOut).balanceOf(address(this));
            uint256 received = outAfter > outBefore ? outAfter - outBefore : 0;
            if (received < s.minAmountOut) {
                revert SwapSlippageExceeded(i, received, s.minAmountOut);
            }
        }
    }

    function _sweepRemainingTokens(
        address recipient,
        CollateralPull[] calldata collaterals,
        SwapStep[] calldata swaps
    ) private {
        for (uint256 i = 0; i < collaterals.length; i++) {
            address cAsset = collaterals[i].asset;
            uint256 bal = IERC20(cAsset).balanceOf(address(this));
            if (bal < collaterals[i].minRemainingOut) {
                revert MinCollateralOutNotMet(cAsset, bal, collaterals[i].minRemainingOut);
            }
            if (bal > 0) {
                IERC20(cAsset).safeTransfer(recipient, bal);
            }
        }

        for (uint256 i = 0; i < swaps.length; i++) {
            address outToken = swaps[i].tokenOut;
            uint256 bal = IERC20(outToken).balanceOf(address(this));
            if (bal > 0) {
                IERC20(outToken).safeTransfer(recipient, bal);
            }
        }
    }
}
