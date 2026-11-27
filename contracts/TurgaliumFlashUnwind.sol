// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title TurgaliumFlashUnwind
 * @notice Zero-fee (0%), non-custodial universal Flash-Loan Self-Unwind engine covering ALL 5 major
 *         EVM lending protocol families and their forks across all 20 EVM chains:
 *           1. Aave V3 & ALL Aave V3 forks (Aave V3 Core/Prime/EtherFi, Neverland, HyperLend, HypurrFi,
 *              SparkLend, Seamless, Lendle, ZeroLend, Kinza, Radiant Base, Tydro/Ink)
 *           2. Aave V2 & ALL Aave V2 forks (Aave V2 Ethereum/Polygon/Avalanche, Radiant V2, Granary)
 *           3. Compound V3 (Comet) & ALL Comet forks (cUSDCv3, cWETHv3, cUSDTv3, cAEROv3)
 *           4. Compound V2 & ALL Compound V2 forks (Compound V2, Venus, Benqi, Moonwell, Mendi, Ionic)
 *           5. Morpho Blue & ALL Morpho markets (Ethereum, Base, Arbitrum, Optimism, Polygon, Unichain,
 *              HyperEVM, Worldchain, Monad)
 *
 *         Funded atomically by ANY allowlisted flash-loan source on the chain:
 *           - Morpho Blue (0.00% flash loan fee!)
 *           - Balancer V2 Vault (0.00% flash loan fee!)
 *           - Aave V3 / Fork Pools (flashLoanSimple / flashLoan)
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

interface IAaveV2LendingPool {
    struct ReserveConfigurationMap {
        uint256 data;
    }

    struct ReserveDataV2 {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 variableBorrowIndex;
        uint128 currentLiquidityRate;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint8 id;
    }

    function getReserveData(address asset) external view returns (ReserveDataV2 memory);
}

interface ICompoundV3Comet {
    function baseToken() external view returns (address);
    function borrowBalanceOf(address account) external view returns (uint256);
    function collateralBalanceOf(address account, address asset) external view returns (uint128);
    function supplyTo(address dst, address asset, uint256 amount) external;
    function withdrawFrom(address src, address to, address asset, uint256 amount) external;
}

interface ICompoundV2Comptroller {
    function markets(address cToken) external view returns (bool isListed, uint256 collateralFactorMantissa);
}

interface ICompoundV2Token {
    function underlying() external view returns (address);
    function borrowBalanceCurrent(address account) external returns (uint256);
    function repayBorrowBehalf(address borrower, uint256 repayAmount) external returns (uint256);
    function redeem(uint256 redeemTokens) external returns (uint256);
}

interface IMorphoBlue {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    function flashLoan(address token, uint256 assets, bytes calldata data) external;
    function position(bytes32 id, address user) external view returns (Position memory);

    function repay(
        MarketParams calldata marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);

    function withdrawCollateral(
        MarketParams calldata marketParams,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external;
}

interface IBalancerV2Vault {
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

contract TurgaliumFlashUnwind {
    // -------------------------------------------------------------------------
    // Protocol Flag Bits (strictly disjoint from allowedSwapRouters)
    // -------------------------------------------------------------------------

    uint8 public constant FLAG_AAVE_V3 = 1 << 0;
    uint8 public constant FLAG_AAVE_V2 = 1 << 1;
    uint8 public constant FLAG_COMPOUND_V3 = 1 << 2;
    uint8 public constant FLAG_COMPOUND_V2 = 1 << 3;
    uint8 public constant FLAG_MORPHO_BLUE = 1 << 4;
    uint8 public constant FLAG_BALANCER_V2 = 1 << 5;

    // -------------------------------------------------------------------------
    // Enums & Structs
    // -------------------------------------------------------------------------

    enum FlashProviderKind {
        AAVE_V3,
        MORPHO_BLUE,
        BALANCER_V2
    }

    enum LendingProtocolKind {
        AAVE_V3,
        AAVE_V2,
        COMPOUND_V3,
        COMPOUND_V2,
        MORPHO_BLUE
    }

    struct PermitApproval {
        address token;
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct CollateralPull {
        address asset;
        uint256 aTokenAmount;
        uint256 minRemainingOut;
    }

    struct SwapStep {
        address router;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        bytes callData;
    }

    struct MultiUnwindParams {
        address[] debtAssets;
        uint256[] debtAmounts;
        uint256[] interestRateModes;
        CollateralPull[] collaterals;
        SwapStep[] swaps;
        PermitApproval[] permits;
        address recipient;
        uint256[] minDebtSurpluses;
        uint256 deadline;
    }

    struct UniversalUnwindParams {
        FlashProviderKind flashProviderKind;
        address flashProvider;
        LendingProtocolKind lendingKind;
        address lendingMarket;
        address debtAsset;
        uint256 debtAmount;
        uint256 interestRateMode;
        bytes protocolData;
        CollateralPull[] collaterals;
        SwapStep[] swaps;
        PermitApproval[] permits;
        address recipient;
        uint256 minDebtSurplus;
        uint256 deadline;
    }

    struct UniversalCallbackContext {
        address user;
        address debtAsset;
        LendingProtocolKind lendingKind;
        address lendingMarket;
        bool repayFull;
        uint256 interestRateMode;
        bytes protocolData;
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
    address private _activeFlashLender;
    uint8 private _activeFlashKind; // packed in same slot as _activeFlashLender (1=AaveV3, 3=Morpho, 4=Balancer)
    address private _activeDebtAsset;
    bytes32 private _activeCallbackHash;
    uint256 private _lastRepaidSingle;
    uint256[] private _lastRepaidMulti;

    address public owner;
    address public pendingOwner;
    bool public paused;

    mapping(address => uint8) public protocolFlags;
    mapping(address => bool) public allowedSwapRouters;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PausedSet(bool paused);
    event ProtocolFlagSet(address indexed target, uint8 flag, bool allowed);
    event AllowedSwapRouterSet(address indexed router, bool allowed);
    event FlashUnwoundSimple(
        address indexed user,
        address indexed pool,
        address indexed debtAsset,
        uint256 debtRepaid,
        uint256 debtSurplus,
        address recipient
    );
    event FlashUnwoundUniversal(
        address indexed user,
        uint8 flashProviderKind,
        address indexed flashProvider,
        uint8 lendingKind,
        address indexed lendingMarket,
        address debtAsset,
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
    // Compact Custom Errors (saves ~2.8 KB runtime bytecode)
    // -------------------------------------------------------------------------

    error Unauthorized();
    error ContractPaused();
    error ReentrancyBlocked();
    error InvalidAddress();
    error TokenCallFailed(address token);
    error NotAllowed(address target);
    error DisjointAllowlistViolation(address target);
    error InvalidInput(uint8 code);
    error CallbackRejected(address caller);
    error SwapExecutionFailed(uint256 index, bytes reason);
    error SlippageOrRepayShortfall(address token, uint256 actual, uint256 required);
    error ProtocolActionFailed(address target, uint256 code);

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
            _setFlag(initialPools[i], FLAG_AAVE_V3, true);
        }

        for (uint256 i = 0; i < initialRouters.length; i++) {
            address r = initialRouters[i];
            if (r == address(0) || r == address(this)) revert InvalidAddress();
            if (protocolFlags[r] != 0) revert DisjointAllowlistViolation(r);
            allowedSwapRouters[r] = true;
            emit AllowedSwapRouterSet(r, true);
        }
    }

    function allowedPools(address a) external view returns (bool) {
        return (protocolFlags[a] & FLAG_AAVE_V3) != 0;
    }

    function configureExtendedMarkets(
        address[] calldata aaveV2Pools,
        address[] calldata compoundV3Comets,
        address[] calldata compoundV2Comptrollers,
        address[] calldata morphoBlues,
        address[] calldata balancerVaults
    ) external onlyOwner {
        for (uint256 i = 0; i < aaveV2Pools.length; i++) _setFlag(aaveV2Pools[i], FLAG_AAVE_V2, true);
        for (uint256 i = 0; i < compoundV3Comets.length; i++) _setFlag(compoundV3Comets[i], FLAG_COMPOUND_V3, true);
        for (uint256 i = 0; i < compoundV2Comptrollers.length; i++) _setFlag(compoundV2Comptrollers[i], FLAG_COMPOUND_V2, true);
        for (uint256 i = 0; i < morphoBlues.length; i++) _setFlag(morphoBlues[i], FLAG_MORPHO_BLUE, true);
        for (uint256 i = 0; i < balancerVaults.length; i++) _setFlag(balancerVaults[i], FLAG_BALANCER_V2, true);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedSet(_paused);
    }

    function setAllowedPool(address pool, bool allowed) external onlyOwner {
        _setFlag(pool, FLAG_AAVE_V3, allowed);
    }

    function setProtocolFlag(address target, uint8 flag, bool allowed) external onlyOwner {
        _setFlag(target, flag, allowed);
    }

    function setAllowedSwapRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0) || router == address(this)) revert InvalidAddress();
        if (allowed && protocolFlags[router] != 0) revert DisjointAllowlistViolation(router);
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
        _safeTransfer(token, to, amount);
        emit RescuedERC20(token, to, amount);
    }

    function rescueETH(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert ProtocolActionFailed(to, 0);
        emit RescuedETH(to, amount);
    }

    // -------------------------------------------------------------------------
    // Entrypoints: Universal (5 families x 3 flash sources), Simple, Multi
    // -------------------------------------------------------------------------

    function unwindUniversal(
        UniversalUnwindParams calldata p
    ) external nonReentrant whenNotPaused returns (uint256 debtRepaid, uint256 debtSurplus) {
        (debtRepaid, debtSurplus) = _runSingleFlashUnwind(
            p.flashProviderKind,
            p.flashProvider,
            p.lendingKind,
            p.lendingMarket,
            p.debtAsset,
            p.debtAmount,
            p.interestRateMode,
            p.protocolData,
            p.collaterals,
            p.swaps,
            p.permits,
            p.recipient,
            p.minDebtSurplus,
            p.deadline
        );
        emit FlashUnwoundUniversal(
            msg.sender,
            uint8(p.flashProviderKind),
            p.flashProvider,
            uint8(p.lendingKind),
            p.lendingMarket,
            p.debtAsset,
            debtRepaid,
            debtSurplus,
            p.recipient == address(0) ? msg.sender : p.recipient
        );
    }

    function unwindMulti(
        address pool,
        MultiUnwindParams calldata p
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256[] memory debtsRepaid, uint256[] memory debtSurpluses)
    {
        if (block.timestamp > p.deadline) revert InvalidInput(1);
        if ((protocolFlags[pool] & FLAG_AAVE_V3) == 0) revert NotAllowed(pool);

        uint256 n = p.debtAssets.length;
        if (
            n == 0 ||
            p.debtAmounts.length != n ||
            p.interestRateModes.length != n ||
            p.minDebtSurpluses.length != n ||
            p.collaterals.length == 0
        ) {
            revert InvalidInput(2);
        }

        address recipient = p.recipient == address(0) ? msg.sender : p.recipient;
        _applyPermits(msg.sender, p.permits);

        uint256[] memory flashAmounts = new uint256[](n);
        uint256[] memory flashModes = new uint256[](n);
        bool[] memory repayFullFlags = new bool[](n);

        for (uint256 i = 0; i < n; i++) {
            if (p.debtAssets[i] == address(0)) revert InvalidAddress();
            if (p.interestRateModes[i] != 1 && p.interestRateModes[i] != 2) {
                revert InvalidInput(3);
            }
            repayFullFlags[i] = p.debtAmounts[i] == type(uint256).max;
            flashAmounts[i] = _resolveAaveFlashDebt(
                pool,
                false,
                p.debtAssets[i],
                p.debtAmounts[i],
                p.interestRateModes[i],
                msg.sender
            );
            flashModes[i] = 0;
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

        _activeFlashLender = pool;
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

        _activeFlashLender = address(0);
        _activeCallbackHash = bytes32(0);
        debtsRepaid = _lastRepaidMulti;
        delete _lastRepaidMulti;

        debtSurpluses = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address dAsset = p.debtAssets[i];
            _forceApprove(dAsset, pool, 0);
            uint256 surplus = IERC20(dAsset).balanceOf(address(this));
            if (surplus < p.minDebtSurpluses[i]) {
                revert SlippageOrRepayShortfall(dAsset, surplus, p.minDebtSurpluses[i]);
            }
            debtSurpluses[i] = surplus;
            if (surplus > 0) _safeTransfer(dAsset, recipient, surplus);
        }

        _sweepRemainingTokens(recipient, LendingProtocolKind.AAVE_V3, p.collaterals, p.swaps);
        emit FlashUnwoundMulti(msg.sender, pool, n, recipient);
    }

    // -------------------------------------------------------------------------
    // Flash-Loan Callbacks
    // -------------------------------------------------------------------------

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (initiator != address(this) || _activeFlashKind != 1 || asset != _activeDebtAsset) {
            revert CallbackRejected(msg.sender);
        }
        _executeSingleBody(amount, amount + premium, params);
        return true;
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (_activeFlashKind != 3) revert CallbackRejected(msg.sender);
        _executeSingleBody(assets, assets, data);
    }

    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external {
        if (
            _activeFlashKind != 4 ||
            tokens.length != 1 ||
            amounts.length != 1 ||
            feeAmounts.length != 1 ||
            tokens[0] != _activeDebtAsset
        ) {
            revert CallbackRejected(msg.sender);
        }
        _executeSingleBody(amounts[0], amounts[0] + feeAmounts[0], userData);
    }

    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        address pool = _activeFlashLender;
        if (pool == address(0) || msg.sender != pool) revert CallbackRejected(msg.sender);
        if (initiator != address(this)) revert CallbackRejected(initiator);

        if (keccak256(abi.encode(uint8(2), pool, assets, amounts, params)) != _activeCallbackHash) {
            revert CallbackRejected(msg.sender);
        }
        _activeCallbackHash = bytes32(0);

        MultiCallbackContext memory ctx = abi.decode(params, (MultiCallbackContext));

        uint256 n = assets.length;
        for (uint256 i = 0; i < n; i++) {
            uint256 repayArg = _resolveExplicitAaveRepay(
                pool,
                false,
                assets[i],
                amounts[i],
                ctx.repayFullFlags[i],
                ctx.interestRateModes[i],
                ctx.user
            );
            _forceApprove(assets[i], pool, repayArg);
            _lastRepaidMulti.push(
                IAaveV3FlashPool(pool).repay(assets[i], repayArg, ctx.interestRateModes[i], ctx.user)
            );
        }

        _pullAndWithdrawAave(pool, false, ctx.user, ctx.collaterals);
        _executeSwaps(pool, pool, ctx.swaps);

        for (uint256 i = 0; i < n; i++) {
            uint256 totalOwed = amounts[i] + premiums[i];
            uint256 available = IERC20(assets[i]).balanceOf(address(this));
            if (available < totalOwed) {
                revert SlippageOrRepayShortfall(assets[i], available, totalOwed);
            }
            _forceApprove(assets[i], pool, totalOwed);
        }
        return true;
    }

    // -------------------------------------------------------------------------
    // Internal Shared Core (Single Memory Signature = Zero Duplicate Decoders)
    // -------------------------------------------------------------------------

    function _runSingleFlashUnwind(
        FlashProviderKind flashProviderKind,
        address flashProvider,
        LendingProtocolKind lendingKind,
        address lendingMarket,
        address debtAsset,
        uint256 debtAmount,
        uint256 interestRateMode,
        bytes memory protocolData,
        CollateralPull[] calldata collaterals,
        SwapStep[] calldata swaps,
        PermitApproval[] calldata permits,
        address recipientRaw,
        uint256 minDebtSurplus,
        uint256 deadline
    ) private returns (uint256 debtRepaid, uint256 debtSurplus) {
        if (block.timestamp > deadline) revert InvalidInput(1);
        if (debtAsset == address(0)) revert InvalidAddress();
        if (collaterals.length == 0) revert InvalidInput(2);

        _validateFlashProvider(flashProviderKind, flashProvider);
        _validateLendingMarket(lendingKind, lendingMarket);

        if (
            (lendingKind == LendingProtocolKind.AAVE_V3 ||
                lendingKind == LendingProtocolKind.AAVE_V2) &&
            interestRateMode != 1 &&
            interestRateMode != 2
        ) {
            revert InvalidInput(3);
        }

        address recipient = recipientRaw == address(0) ? msg.sender : recipientRaw;
        _applyPermits(msg.sender, permits);

        bool repayFull = debtAmount == type(uint256).max;
        uint256 flashAmount = _resolveUniversalFlashAmount(
            lendingKind,
            lendingMarket,
            debtAsset,
            debtAmount,
            interestRateMode,
            protocolData,
            msg.sender
        );

        bytes memory callbackParams = abi.encode(
            UniversalCallbackContext({
                user: msg.sender,
                debtAsset: debtAsset,
                lendingKind: lendingKind,
                lendingMarket: lendingMarket,
                repayFull: repayFull,
                interestRateMode: interestRateMode,
                protocolData: protocolData,
                collaterals: collaterals,
                swaps: swaps
            })
        );

        _activeFlashLender = flashProvider;
        _activeDebtAsset = debtAsset;
        _lastRepaidSingle = 0;

        uint8 kindTag = flashProviderKind == FlashProviderKind.AAVE_V3
            ? 1
            : flashProviderKind == FlashProviderKind.MORPHO_BLUE
            ? 3
            : 4;
        _activeFlashKind = kindTag;
        _activeCallbackHash = keccak256(abi.encode(kindTag, flashProvider, debtAsset, flashAmount, callbackParams));

        if (kindTag == 1) {
            IAaveV3FlashPool(flashProvider).flashLoanSimple(
                address(this),
                debtAsset,
                flashAmount,
                callbackParams,
                0
            );
            _forceApprove(debtAsset, flashProvider, 0);
        } else if (kindTag == 3) {
            IMorphoBlue(flashProvider).flashLoan(debtAsset, flashAmount, callbackParams);
            _forceApprove(debtAsset, flashProvider, 0);
        } else {
            address[] memory tokens = new address[](1);
            tokens[0] = debtAsset;
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = flashAmount;
            IBalancerV2Vault(flashProvider).flashLoan(address(this), tokens, amounts, callbackParams);
        }

        _activeFlashLender = address(0);
        _activeFlashKind = 0;
        _activeDebtAsset = address(0);
        _activeCallbackHash = bytes32(0);
        debtRepaid = _lastRepaidSingle;
        _lastRepaidSingle = 0;

        debtSurplus = IERC20(debtAsset).balanceOf(address(this));
        if (debtSurplus < minDebtSurplus) {
            revert SlippageOrRepayShortfall(debtAsset, debtSurplus, minDebtSurplus);
        }
        if (debtSurplus > 0) _safeTransfer(debtAsset, recipient, debtSurplus);

        _sweepRemainingTokens(recipient, lendingKind, collaterals, swaps);
    }

    function _executeSingleBody(
        uint256 amount,
        uint256 totalOwed,
        bytes calldata callbackParams
    ) private {
        address lender = _activeFlashLender;
        uint8 kindTag = _activeFlashKind;
        address debtAsset = _activeDebtAsset;
        if (lender == address(0) || msg.sender != lender) revert CallbackRejected(msg.sender);
        if (
            keccak256(abi.encode(kindTag, lender, debtAsset, amount, callbackParams)) !=
            _activeCallbackHash
        ) {
            revert CallbackRejected(msg.sender);
        }
        _activeCallbackHash = bytes32(0);

        UniversalCallbackContext memory ctx = abi.decode(callbackParams, (UniversalCallbackContext));
        _executeUniversalCore(lender, debtAsset, amount, ctx);

        uint256 available = IERC20(debtAsset).balanceOf(address(this));
        if (available < totalOwed) revert SlippageOrRepayShortfall(debtAsset, available, totalOwed);

        if (kindTag == 4) {
            _safeTransfer(debtAsset, lender, totalOwed);
        } else {
            _forceApprove(debtAsset, lender, totalOwed);
        }
    }

    function _executeUniversalCore(
        address flashLender,
        address debtAsset,
        uint256 flashedAmount,
        UniversalCallbackContext memory ctx
    ) private {
        if (
            ctx.lendingKind == LendingProtocolKind.AAVE_V3 ||
            ctx.lendingKind == LendingProtocolKind.AAVE_V2
        ) {
            bool isV2 = ctx.lendingKind == LendingProtocolKind.AAVE_V2;
            uint256 repayArg = _resolveExplicitAaveRepay(
                ctx.lendingMarket,
                isV2,
                debtAsset,
                flashedAmount,
                ctx.repayFull,
                ctx.interestRateMode,
                ctx.user
            );
            _forceApprove(debtAsset, ctx.lendingMarket, repayArg);
            _lastRepaidSingle = IAaveV3FlashPool(ctx.lendingMarket).repay(
                debtAsset,
                repayArg,
                ctx.interestRateMode,
                ctx.user
            );
            _forceApprove(debtAsset, ctx.lendingMarket, 0);
            _pullAndWithdrawAave(ctx.lendingMarket, isV2, ctx.user, ctx.collaterals);
        } else if (ctx.lendingKind == LendingProtocolKind.COMPOUND_V3) {
            address comet = ctx.lendingMarket;
            if (ICompoundV3Comet(comet).baseToken() != debtAsset) revert InvalidInput(4);

            uint256 liveDebt = ICompoundV3Comet(comet).borrowBalanceOf(ctx.user);
            uint256 repayAmt = ctx.repayFull
                ? (liveDebt < flashedAmount ? liveDebt : flashedAmount)
                : flashedAmount;
            if (repayAmt == 0) revert InvalidInput(5);

            _forceApprove(debtAsset, comet, repayAmt);
            ICompoundV3Comet(comet).supplyTo(ctx.user, debtAsset, repayAmt);
            _forceApprove(debtAsset, comet, 0);
            _lastRepaidSingle = repayAmt;

            for (uint256 i = 0; i < ctx.collaterals.length; i++) {
                CollateralPull memory c = ctx.collaterals[i];
                if (c.asset == address(0)) revert InvalidAddress();
                uint256 colAmt = c.aTokenAmount == type(uint256).max
                    ? uint256(ICompoundV3Comet(comet).collateralBalanceOf(ctx.user, c.asset))
                    : c.aTokenAmount;
                if (colAmt == 0) revert InvalidInput(6);
                ICompoundV3Comet(comet).withdrawFrom(ctx.user, address(this), c.asset, colAmt);
            }
        } else if (ctx.lendingKind == LendingProtocolKind.COMPOUND_V2) {
            if (ctx.protocolData.length < 32) revert InvalidInput(4);
            address debtCToken = abi.decode(ctx.protocolData, (address));
            (bool debtListed, ) = ICompoundV2Comptroller(ctx.lendingMarket).markets(debtCToken);
            if (!debtListed) revert NotAllowed(debtCToken);
            if (ICompoundV2Token(debtCToken).underlying() != debtAsset) revert InvalidInput(4);

            uint256 liveDebt = ICompoundV2Token(debtCToken).borrowBalanceCurrent(ctx.user);
            uint256 repayAmt = ctx.repayFull
                ? (liveDebt < flashedAmount ? liveDebt : flashedAmount)
                : flashedAmount;
            if (repayAmt == 0) revert InvalidInput(5);

            _forceApprove(debtAsset, debtCToken, repayAmt);
            uint256 repayErr = ICompoundV2Token(debtCToken).repayBorrowBehalf(ctx.user, repayAmt);
            _forceApprove(debtAsset, debtCToken, 0);
            if (repayErr != 0) revert ProtocolActionFailed(debtCToken, repayErr);
            _lastRepaidSingle = repayAmt;

            for (uint256 i = 0; i < ctx.collaterals.length; i++) {
                CollateralPull memory c = ctx.collaterals[i];
                address cToken = c.asset;
                (bool colListed, ) = ICompoundV2Comptroller(ctx.lendingMarket).markets(cToken);
                if (!colListed) revert NotAllowed(cToken);

                uint256 pullAmt = c.aTokenAmount == type(uint256).max
                    ? IERC20(cToken).balanceOf(ctx.user)
                    : c.aTokenAmount;
                if (pullAmt == 0) revert InvalidInput(6);

                _safeTransferFrom(cToken, ctx.user, address(this), pullAmt);
                uint256 redeemErr = ICompoundV2Token(cToken).redeem(pullAmt);
                if (redeemErr != 0) revert ProtocolActionFailed(cToken, redeemErr);
            }
        } else {
            if (ctx.protocolData.length < 192) revert InvalidInput(4);
            (IMorphoBlue.MarketParams memory mp, bool repayFullShares) = abi.decode(
                ctx.protocolData,
                (IMorphoBlue.MarketParams, bool)
            );
            if (mp.loanToken != debtAsset) revert InvalidInput(4);

            bytes32 marketId = keccak256(abi.encode(mp));
            IMorphoBlue.Position memory pos = IMorphoBlue(ctx.lendingMarket).position(marketId, ctx.user);

            _forceApprove(debtAsset, ctx.lendingMarket, flashedAmount);
            uint256 repaidAssets;
            if (repayFullShares) {
                if (pos.borrowShares == 0) revert InvalidInput(5);
                (repaidAssets, ) = IMorphoBlue(ctx.lendingMarket).repay(
                    mp,
                    0,
                    uint256(pos.borrowShares),
                    ctx.user,
                    ""
                );
            } else {
                (repaidAssets, ) = IMorphoBlue(ctx.lendingMarket).repay(
                    mp,
                    flashedAmount,
                    0,
                    ctx.user,
                    ""
                );
            }
            _forceApprove(debtAsset, ctx.lendingMarket, 0);
            _lastRepaidSingle = repaidAssets;

            uint256 colAmt = ctx.collaterals[0].aTokenAmount == type(uint256).max
                ? uint256(pos.collateral)
                : ctx.collaterals[0].aTokenAmount;
            if (colAmt == 0) revert InvalidInput(6);
            IMorphoBlue(ctx.lendingMarket).withdrawCollateral(mp, colAmt, ctx.user, address(this));
        }

        _executeSwaps(flashLender, ctx.lendingMarket, ctx.swaps);
    }

    // -------------------------------------------------------------------------
    // Compact Assembly SafeERC20 & Protocol Helpers (zero heap allocs, EIP-170 lean)
    // -------------------------------------------------------------------------

    function _safeTransfer(address token, address to, uint256 amount) private {
        bool ok;
        assembly ("memory-safe") {
            if iszero(extcodesize(token)) { ok := 0 }
            if extcodesize(token) {
                let ptr := mload(0x40)
                mstore(ptr, shl(224, 0xa9059cbb))
                mstore(add(ptr, 4), to)
                mstore(add(ptr, 36), amount)
                ok := and(
                    or(and(eq(mload(0), 1), gt(returndatasize(), 31)), iszero(returndatasize())),
                    call(gas(), token, 0, ptr, 68, 0, 32)
                )
            }
        }
        if (!ok) revert TokenCallFailed(token);
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        bool ok;
        assembly ("memory-safe") {
            if extcodesize(token) {
                let ptr := mload(0x40)
                mstore(ptr, shl(224, 0x23b872dd))
                mstore(add(ptr, 4), from)
                mstore(add(ptr, 36), to)
                mstore(add(ptr, 68), amount)
                ok := and(
                    or(and(eq(mload(0), 1), gt(returndatasize(), 31)), iszero(returndatasize())),
                    call(gas(), token, 0, ptr, 100, 0, 32)
                )
            }
        }
        if (!ok) revert TokenCallFailed(token);
    }

    function _approveRaw(address token, address spender, uint256 amount) private returns (bool ok) {
        assembly ("memory-safe") {
            if extcodesize(token) {
                let ptr := mload(0x40)
                mstore(ptr, shl(224, 0x095ea7b3))
                mstore(add(ptr, 4), spender)
                mstore(add(ptr, 36), amount)
                ok := and(
                    or(and(eq(mload(0), 1), gt(returndatasize(), 31)), iszero(returndatasize())),
                    call(gas(), token, 0, ptr, 68, 0, 32)
                )
            }
        }
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (!_approveRaw(token, spender, amount)) {
            if (!_approveRaw(token, spender, 0) || (amount != 0 && !_approveRaw(token, spender, amount))) {
                revert TokenCallFailed(token);
            }
        }
    }

    function _setFlag(address target, uint8 flag, bool allowed) private {
        if (target == address(0) || target == address(this)) revert InvalidAddress();
        if (allowed && allowedSwapRouters[target]) revert DisjointAllowlistViolation(target);
        if (allowed) protocolFlags[target] |= flag;
        else protocolFlags[target] &= ~flag;
        emit ProtocolFlagSet(target, flag, allowed);
    }

    function _validateFlashProvider(FlashProviderKind kind, address provider) private view {
        uint8 need = kind == FlashProviderKind.AAVE_V3
            ? FLAG_AAVE_V3
            : kind == FlashProviderKind.MORPHO_BLUE
            ? FLAG_MORPHO_BLUE
            : FLAG_BALANCER_V2;
        if ((protocolFlags[provider] & need) == 0) revert NotAllowed(provider);
    }

    function _validateLendingMarket(LendingProtocolKind kind, address market) private view {
        uint8 need = kind == LendingProtocolKind.AAVE_V3
            ? FLAG_AAVE_V3
            : kind == LendingProtocolKind.AAVE_V2
            ? FLAG_AAVE_V2
            : kind == LendingProtocolKind.COMPOUND_V3
            ? FLAG_COMPOUND_V3
            : kind == LendingProtocolKind.COMPOUND_V2
            ? FLAG_COMPOUND_V2
            : FLAG_MORPHO_BLUE;
        if ((protocolFlags[market] & need) == 0) revert NotAllowed(market);
    }

    function _applyPermits(address user, PermitApproval[] calldata permits) private {
        for (uint256 i = 0; i < permits.length; i++) {
            PermitApproval calldata perm = permits[i];
            if (perm.token == address(0)) revert InvalidAddress();
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

    function _getAaveTokens(
        address pool,
        bool isV2,
        address asset
    ) private view returns (address aToken, address stableDebt, address variableDebt) {
        if (isV2) {
            IAaveV2LendingPool.ReserveDataV2 memory rd2 = IAaveV2LendingPool(pool).getReserveData(asset);
            return (rd2.aTokenAddress, rd2.stableDebtTokenAddress, rd2.variableDebtTokenAddress);
        }
        IAaveV3FlashPool.ReserveData memory rd3 = IAaveV3FlashPool(pool).getReserveData(asset);
        return (rd3.aTokenAddress, rd3.stableDebtTokenAddress, rd3.variableDebtTokenAddress);
    }

    function _resolveAaveFlashDebt(
        address pool,
        bool isV2,
        address debtAsset,
        uint256 requestedAmount,
        uint256 interestRateMode,
        address user
    ) private view returns (uint256) {
        if (requestedAmount != type(uint256).max) {
            if (requestedAmount == 0) revert InvalidInput(5);
            return requestedAmount;
        }
        (, address sDebt, address vDebt) = _getAaveTokens(pool, isV2, debtAsset);
        address debtToken = interestRateMode == 1 ? sDebt : vDebt;
        if (debtToken == address(0)) revert InvalidInput(7);
        uint256 liveDebt = IERC20(debtToken).balanceOf(user);
        if (liveDebt == 0) revert InvalidInput(5);
        return liveDebt + (liveDebt / 1_000_000) + 2;
    }

    function _resolveExplicitAaveRepay(
        address pool,
        bool isV2,
        address debtAsset,
        uint256 flashedAmount,
        bool repayFull,
        uint256 interestRateMode,
        address user
    ) private view returns (uint256) {
        if (!repayFull) return flashedAmount;
        (, address sDebt, address vDebt) = _getAaveTokens(pool, isV2, debtAsset);
        address debtToken = interestRateMode == 1 ? sDebt : vDebt;
        if (debtToken == address(0)) return flashedAmount;
        uint256 liveDebt = IERC20(debtToken).balanceOf(user);
        if (liveDebt == 0) revert InvalidInput(5);
        return liveDebt < flashedAmount ? liveDebt : flashedAmount;
    }

    function _resolveUniversalFlashAmount(
        LendingProtocolKind kind,
        address market,
        address debtAsset,
        uint256 requestedAmount,
        uint256 interestRateMode,
        bytes memory protocolData,
        address user
    ) private returns (uint256) {
        if (requestedAmount != type(uint256).max) {
            if (requestedAmount == 0) revert InvalidInput(5);
            return requestedAmount;
        }
        if (kind == LendingProtocolKind.AAVE_V3 || kind == LendingProtocolKind.AAVE_V2) {
            return
                _resolveAaveFlashDebt(
                    market,
                    kind == LendingProtocolKind.AAVE_V2,
                    debtAsset,
                    requestedAmount,
                    interestRateMode,
                    user
                );
        }
        if (kind == LendingProtocolKind.COMPOUND_V3) {
            uint256 liveDebt = ICompoundV3Comet(market).borrowBalanceOf(user);
            if (liveDebt == 0) revert InvalidInput(5);
            return liveDebt + (liveDebt / 1_000_000) + 2;
        }
        if (kind == LendingProtocolKind.COMPOUND_V2) {
            if (protocolData.length < 32) revert InvalidInput(4);
            address debtCToken = abi.decode(protocolData, (address));
            (bool listed, ) = ICompoundV2Comptroller(market).markets(debtCToken);
            if (!listed) revert NotAllowed(debtCToken);
            uint256 liveDebt = ICompoundV2Token(debtCToken).borrowBalanceCurrent(user);
            if (liveDebt == 0) revert InvalidInput(5);
            return liveDebt + (liveDebt / 1_000_000) + 2;
        }
        revert InvalidInput(4);
    }

    function _pullAndWithdrawAave(
        address pool,
        bool isV2,
        address user,
        CollateralPull[] memory collaterals
    ) private {
        for (uint256 i = 0; i < collaterals.length; i++) {
            CollateralPull memory c = collaterals[i];
            if (c.asset == address(0)) revert InvalidAddress();
            (address aToken, , ) = _getAaveTokens(pool, isV2, c.asset);
            if (aToken == address(0)) revert InvalidInput(7);

            uint256 pullAmount = c.aTokenAmount == type(uint256).max
                ? IERC20(aToken).balanceOf(user)
                : c.aTokenAmount;
            if (pullAmount == 0) revert InvalidInput(6);

            _safeTransferFrom(aToken, user, address(this), pullAmount);
            IAaveV3FlashPool(pool).withdraw(c.asset, type(uint256).max, address(this));
        }
    }

    function _executeSwaps(address flashLender, address lendingMarket, SwapStep[] memory swaps) private {
        for (uint256 i = 0; i < swaps.length; i++) {
            SwapStep memory s = swaps[i];
            if (
                s.router == address(0) ||
                s.router == address(this) ||
                s.router == flashLender ||
                s.router == lendingMarket ||
                s.tokenIn == address(0) ||
                s.tokenOut == address(0) ||
                s.callData.length < 4
            ) {
                revert InvalidInput(8);
            }
            if (!allowedSwapRouters[s.router]) revert NotAllowed(s.router);

            uint256 inBalance = IERC20(s.tokenIn).balanceOf(address(this));
            uint256 approveAmt = s.amountIn == type(uint256).max ? inBalance : s.amountIn;
            if (approveAmt == 0 || approveAmt > inBalance) revert InvalidInput(8);

            uint256 outBefore = IERC20(s.tokenOut).balanceOf(address(this));
            _forceApprove(s.tokenIn, s.router, approveAmt);

            (bool ok, bytes memory ret) = s.router.call(s.callData);
            _forceApprove(s.tokenIn, s.router, 0);

            if (!ok) revert SwapExecutionFailed(i, ret);

            uint256 outAfter = IERC20(s.tokenOut).balanceOf(address(this));
            uint256 received = outAfter > outBefore ? outAfter - outBefore : 0;
            if (received < s.minAmountOut) {
                revert SlippageOrRepayShortfall(s.tokenOut, received, s.minAmountOut);
            }
        }
    }

    function _sweepRemainingTokens(
        address recipient,
        LendingProtocolKind lendingKind,
        CollateralPull[] calldata collaterals,
        SwapStep[] calldata swaps
    ) private {
        for (uint256 i = 0; i < collaterals.length; i++) {
            address cAsset = lendingKind == LendingProtocolKind.COMPOUND_V2
                ? ICompoundV2Token(collaterals[i].asset).underlying()
                : collaterals[i].asset;
            uint256 bal = IERC20(cAsset).balanceOf(address(this));
            if (bal < collaterals[i].minRemainingOut) {
                revert SlippageOrRepayShortfall(cAsset, bal, collaterals[i].minRemainingOut);
            }
            if (bal > 0) _safeTransfer(cAsset, recipient, bal);
        }

        for (uint256 i = 0; i < swaps.length; i++) {
            address outToken = swaps[i].tokenOut;
            uint256 bal = IERC20(outToken).balanceOf(address(this));
            if (bal > 0) _safeTransfer(outToken, recipient, bal);
        }
    }
}
