// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import { MockERC20 } from "./Mocks.sol";
import {
    TurgaliumFlashUnwind,
    IAaveV3FlashPool,
    IAaveV2LendingPool,
    IMorphoBlue,
    IERC20
} from "../TurgaliumFlashUnwind.sol";

// -----------------------------------------------------------------------------
// Realistic Mocks for ALL 5 Lending Protocol Families + ALL 3 Flash Sources
// -----------------------------------------------------------------------------

contract MockDebtToken {
    mapping(address => uint256) public balanceOf;

    function mint(address user, uint256 amount) external {
        balanceOf[user] += amount;
    }

    function burn(address user, uint256 amount) external {
        require(balanceOf[user] >= amount, "INSUFFICIENT_DEBT");
        balanceOf[user] -= amount;
    }
}

contract MockAToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    MockDebtToken public immutable guardedDebtToken;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;

    constructor(string memory n, string memory s, uint8 d, MockDebtToken _debtToken) {
        name = n;
        symbol = s;
        decimals = d;
        guardedDebtToken = _debtToken;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (address(guardedDebtToken) != address(0)) {
            require(guardedDebtToken.balanceOf(msg.sender) == 0, "HF_TOO_LOW");
        }
        require(balanceOf[msg.sender] >= amount, "INSUFFICIENT_BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function burn(address from, uint256 amount) external {
        require(balanceOf[from] >= amount, "INSUFFICIENT_ATOKEN");
        balanceOf[from] -= amount;
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8,
        bytes32,
        bytes32
    ) external {
        require(block.timestamp <= deadline, "PERMIT_EXPIRED");
        nonces[owner]++;
        allowance[owner][spender] = value;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (address(guardedDebtToken) != address(0)) {
            require(guardedDebtToken.balanceOf(from) == 0, "HF_TOO_LOW");
        }
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "INSUFFICIENT_ALLOWANCE");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "INSUFFICIENT_BALANCE");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockFlashAaveV3Pool {
    uint128 public flashLoanPremiumBps;
    mapping(address => address) public aTokens;
    mapping(address => address) public variableDebtTokens;

    constructor(uint128 _premiumBps) {
        flashLoanPremiumBps = _premiumBps;
    }

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128) {
        return flashLoanPremiumBps;
    }

    function setReserve(address asset, address aToken, address vDebtToken) external {
        aTokens[asset] = aToken;
        variableDebtTokens[asset] = vDebtToken;
    }

    function getReserveData(address asset) external view returns (IAaveV3FlashPool.ReserveData memory data) {
        data.aTokenAddress = aTokens[asset];
        data.variableDebtTokenAddress = variableDebtTokens[asset];
    }

    function mintDebt(address user, address asset, uint256 amount) external {
        MockDebtToken(variableDebtTokens[asset]).mint(user, amount);
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        uint256 premium = (amount * uint256(flashLoanPremiumBps)) / 10_000;
        MockERC20(asset).mint(receiverAddress, amount);
        bool ok = TurgaliumFlashUnwind(receiverAddress).executeOperation(
            asset,
            amount,
            premium,
            msg.sender,
            params
        );
        require(ok, "FLASH_CALLBACK_FALSE");
        require(
            MockERC20(asset).transferFrom(receiverAddress, address(this), amount + premium),
            "FLASH_REPAY_FAILED"
        );
    }

    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata,
        address,
        bytes calldata params,
        uint16
    ) external {
        uint256 n = assets.length;
        uint256[] memory premiums = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            premiums[i] = (amounts[i] * uint256(flashLoanPremiumBps)) / 10_000;
            MockERC20(assets[i]).mint(receiverAddress, amounts[i]);
        }
        bool ok = TurgaliumFlashUnwind(receiverAddress).executeOperation(
            assets,
            amounts,
            premiums,
            msg.sender,
            params
        );
        require(ok, "FLASH_MULTI_CALLBACK_FALSE");
        for (uint256 i = 0; i < n; i++) {
            require(
                MockERC20(assets[i]).transferFrom(receiverAddress, address(this), amounts[i] + premiums[i]),
                "FLASH_MULTI_REPAY_FAILED"
            );
        }
    }

    function repay(address asset, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        // Mirror real Aave V3 Error 40: forbid MAX_UINT256 when msg.sender != onBehalfOf!
        require(amount != type(uint256).max || msg.sender == onBehalfOf, "40");
        MockDebtToken debtTok = MockDebtToken(variableDebtTokens[asset]);
        uint256 owed = debtTok.balanceOf(onBehalfOf);
        uint256 payAmt = amount > owed ? owed : amount;
        require(payAmt > 0, "NO_DEBT_TO_REPAY");
        require(MockERC20(asset).transferFrom(msg.sender, address(this), payAmt), "REPAY_PULL_FAILED");
        debtTok.burn(onBehalfOf, payAmt);
        return payAmt;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        MockAToken aTok = MockAToken(aTokens[asset]);
        uint256 bal = aTok.balanceOf(msg.sender);
        uint256 wAmt = amount == type(uint256).max ? bal : amount;
        require(wAmt > 0 && wAmt <= bal, "BAD_WITHDRAW_AMT");
        aTok.burn(msg.sender, wAmt);
        MockERC20(asset).mint(to, wAmt);
        return wAmt;
    }
}

contract MockAaveV2Pool {
    mapping(address => address) public aTokens;
    mapping(address => address) public variableDebtTokens;

    function setReserve(address asset, address aToken, address vDebtToken) external {
        aTokens[asset] = aToken;
        variableDebtTokens[asset] = vDebtToken;
    }

    function getReserveData(address asset) external view returns (IAaveV2LendingPool.ReserveDataV2 memory data) {
        data.aTokenAddress = aTokens[asset];
        data.variableDebtTokenAddress = variableDebtTokens[asset];
    }

    function mintDebt(address user, address asset, uint256 amount) external {
        MockDebtToken(variableDebtTokens[asset]).mint(user, amount);
    }

    function repay(address asset, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        MockDebtToken debtTok = MockDebtToken(variableDebtTokens[asset]);
        uint256 owed = debtTok.balanceOf(onBehalfOf);
        uint256 payAmt = amount > owed ? owed : amount;
        require(MockERC20(asset).transferFrom(msg.sender, address(this), payAmt), "V2_REPAY_FAIL");
        debtTok.burn(onBehalfOf, payAmt);
        return payAmt;
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        MockAToken aTok = MockAToken(aTokens[asset]);
        uint256 bal = aTok.balanceOf(msg.sender);
        uint256 wAmt = amount == type(uint256).max ? bal : amount;
        aTok.burn(msg.sender, wAmt);
        MockERC20(asset).mint(to, wAmt);
        return wAmt;
    }
}

contract MockMorphoBlue {
    mapping(bytes32 => mapping(address => IMorphoBlue.Position)) public positions;
    mapping(address => mapping(address => bool)) public isAuthorized;

    function setAuthorization(address authorized, bool newIsAuthorized) external {
        isAuthorized[msg.sender][authorized] = newIsAuthorized;
    }

    function seedPosition(
        IMorphoBlue.MarketParams calldata mp,
        address user,
        uint128 borrowShares,
        uint128 collateral
    ) external {
        bytes32 id = keccak256(abi.encode(mp));
        positions[id][user] = IMorphoBlue.Position({
            supplyShares: 0,
            borrowShares: borrowShares,
            collateral: collateral
        });
    }

    function position(bytes32 id, address user) external view returns (IMorphoBlue.Position memory) {
        return positions[id][user];
    }

    /// @notice 0.00% fee Morpho Blue flash loan!
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        MockERC20(token).mint(msg.sender, assets);
        TurgaliumFlashUnwind(msg.sender).onMorphoFlashLoan(assets, data);
        require(MockERC20(token).transferFrom(msg.sender, address(this), assets), "MORPHO_FLASH_REPAY_FAIL");
    }

    function repay(
        IMorphoBlue.MarketParams calldata mp,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid) {
        bytes32 id = keccak256(abi.encode(mp));
        IMorphoBlue.Position storage p = positions[id][onBehalf];
        if (shares > 0) {
            require(p.borrowShares >= shares, "OVER_REPAY");
            sharesRepaid = shares;
            assetsRepaid = shares; // 1:1 mock share ratio
            p.borrowShares -= uint128(shares);
        } else {
            assetsRepaid = assets;
            sharesRepaid = assets;
            p.borrowShares -= uint128(assets);
        }
        require(MockERC20(mp.loanToken).transferFrom(msg.sender, address(this), assetsRepaid), "MORPHO_REPAY_FAIL");
    }

    function withdrawCollateral(
        IMorphoBlue.MarketParams calldata mp,
        uint256 assets,
        address onBehalf,
        address receiver
    ) external {
        require(msg.sender == onBehalf || isAuthorized[onBehalf][msg.sender], "NOT_AUTHORIZED");
        bytes32 id = keccak256(abi.encode(mp));
        IMorphoBlue.Position storage p = positions[id][onBehalf];
        require(p.borrowShares == 0, "MORPHO_UNHEALTHY");
        require(p.collateral >= assets, "INSUFFICIENT_COL");
        p.collateral -= uint128(assets);
        MockERC20(mp.collateralToken).mint(receiver, assets);
    }
}

contract MockBalancerV2Vault {
    /// @notice 0.00% fee Balancer V2 Vault flash loan!
    function flashLoan(
        address recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external {
        uint256[] memory fees = new uint256[](tokens.length);
        uint256[] memory balBefore = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            balBefore[i] = MockERC20(tokens[i]).balanceOf(address(this));
            MockERC20(tokens[i]).mint(recipient, amounts[i]);
        }
        TurgaliumFlashUnwind(recipient).receiveFlashLoan(tokens, amounts, fees, userData);
        for (uint256 i = 0; i < tokens.length; i++) {
            require(
                MockERC20(tokens[i]).balanceOf(address(this)) >= balBefore[i] + amounts[i],
                "BALANCER_FLASH_NOT_REPAID"
            );
        }
    }
}

contract MockFlashComet {
    address public immutable baseToken;
    mapping(address => uint256) public borrowBalanceOf;
    mapping(address => mapping(address => uint128)) public collateralBalanceOf;
    mapping(address => mapping(address => bool)) public isAllowed;

    constructor(address _baseToken) {
        baseToken = _baseToken;
    }

    function allow(address manager, bool allowed) external {
        isAllowed[msg.sender][manager] = allowed;
    }

    function seedUser(address user, address colAsset, uint128 colAmt, uint256 debtAmt) external {
        collateralBalanceOf[user][colAsset] = colAmt;
        borrowBalanceOf[user] = debtAmt;
    }

    function supplyTo(address dst, address asset, uint256 amount) external {
        require(asset == baseToken, "NOT_BASE");
        require(MockERC20(asset).transferFrom(msg.sender, address(this), amount), "COMET_PULL_FAIL");
        uint256 debt = borrowBalanceOf[dst];
        borrowBalanceOf[dst] = amount >= debt ? 0 : debt - amount;
    }

    function withdrawFrom(address src, address to, address asset, uint256 amount) external {
        require(msg.sender == src || isAllowed[src][msg.sender], "COMET_NOT_ALLOWED");
        require(borrowBalanceOf[src] == 0, "COMET_UNHEALTHY");
        require(collateralBalanceOf[src][asset] >= amount, "COMET_INSUFFICIENT_COL");
        collateralBalanceOf[src][asset] -= uint128(amount);
        MockERC20(asset).mint(to, amount);
    }
}

contract MockComptroller {
    mapping(address => bool) public listed;

    function setListed(address cToken, bool ok) external {
        listed[cToken] = ok;
    }

    function markets(address cToken) external view returns (bool isListed, uint256 collateralFactorMantissa) {
        return (listed[cToken], 8e17);
    }
}

contract MockCToken {
    address public immutable underlying;
    MockCToken public immutable guardedDebtCToken;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public borrowBalances;

    constructor(address _underlying, MockCToken _debtCToken) {
        underlying = _underlying;
        guardedDebtCToken = _debtCToken;
    }

    function mintCToken(address user, uint256 amount) external {
        balanceOf[user] += amount;
    }

    function seedBorrow(address user, uint256 amount) external {
        borrowBalances[user] = amount;
    }

    function borrowBalanceCurrent(address user) external view returns (uint256) {
        return borrowBalances[user];
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (address(guardedDebtCToken) != address(0)) {
            require(guardedDebtCToken.borrowBalanceCurrent(from) == 0, "COMPV2_SHORTFALL");
        }
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "INSUFFICIENT_ALLOWANCE");
            allowance[from][msg.sender] = allowed - amount;
        }
        require(balanceOf[from] >= amount, "INSUFFICIENT_CTOKEN");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function repayBorrowBehalf(address borrower, uint256 repayAmount) external returns (uint256) {
        uint256 debt = borrowBalances[borrower];
        uint256 payAmt = repayAmount > debt ? debt : repayAmount;
        require(MockERC20(underlying).transferFrom(msg.sender, address(this), payAmt), "CTOKEN_REPAY_FAIL");
        borrowBalances[borrower] -= payAmt;
        return 0;
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        require(balanceOf[msg.sender] >= redeemTokens, "REDEEM_UNDERFLOW");
        balanceOf[msg.sender] -= redeemTokens;
        MockERC20(underlying).mint(msg.sender, redeemTokens);
        return 0;
    }
}

contract MockDexRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        require(MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "DEX_PULL_FAIL");
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    function swapAndReenter(address target, address pool, address tokenIn, uint256 amountIn) external {
        require(MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "DEX_PULL_FAIL");
        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({ asset: tokenIn, aTokenAmount: 1, minRemainingOut: 0 });
        TurgaliumFlashUnwind(target).unwindUniversal(
            TurgaliumFlashUnwind.UniversalUnwindParams({
                flashProviderKind: TurgaliumFlashUnwind.FlashProviderKind.AAVE_V3,
                flashProvider: pool,
                lendingKind: TurgaliumFlashUnwind.LendingProtocolKind.AAVE_V3,
                lendingMarket: pool,
                debtAsset: tokenIn,
                debtAmount: 1,
                interestRateMode: 2,
                protocolData: "",
                collaterals: cols,
                swaps: new TurgaliumFlashUnwind.SwapStep[](0),
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: msg.sender,
                minDebtSurplus: 0,
                deadline: block.timestamp + 100
            })
        );
    }
}

contract MockForkDexRouter {
    function swapAll(address tokenIn, address tokenOut, uint256 amountOut) external {
        uint256 bal = IERC20(tokenIn).balanceOf(msg.sender);
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), bal), "FORK_DEX_PULL_FAIL");
        require(IERC20(tokenOut).transfer(msg.sender, amountOut), "FORK_DEX_OUT_FAIL");
    }
}

// -----------------------------------------------------------------------------
// Comprehensive Test Suite Across All 5 Lending Families & All 3 Flash Sources
// -----------------------------------------------------------------------------

contract TurgaliumFlashUnwindTest is TestBase {
    address private constant OWNER = address(0xA11CE);
    address private constant USER = address(0xB0B);
    address private constant ATTACKER = address(0xBAD);
    address private constant RECIPIENT = address(0xCAFE);

    MockERC20 private wmon;
    MockERC20 private smon;
    MockERC20 private gmon;
    MockERC20 private usdc;
    MockERC20 private weth;

    MockDebtToken private vDebtWmon;
    MockDebtToken private vDebtUsdc;
    MockDebtToken private v2DebtUsdc;

    MockAToken private nWmon;
    MockAToken private nSmon;
    MockAToken private nGmon;
    MockAToken private aV2Weth;

    MockFlashAaveV3Pool private neverlandPool;
    MockAaveV2Pool private aaveV2Pool;
    MockMorphoBlue private morphoBlue;
    MockBalancerV2Vault private balancerVault;
    MockFlashComet private cometUsdc;
    MockComptroller private comptroller;
    MockCToken private cUsdcDebt;
    MockCToken private cWethCol;

    MockDexRouter private dexRouter;
    TurgaliumFlashUnwind private flashUnwind;

    function setUp() public {
        wmon = new MockERC20("Wrapped MON", "WMON", 18);
        smon = new MockERC20("Kintsu sMON", "sMON", 18);
        gmon = new MockERC20("Magma gMON", "gMON", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        weth = new MockERC20("Wrapped Ether", "WETH", 18);

        vDebtWmon = new MockDebtToken();
        vDebtUsdc = new MockDebtToken();
        v2DebtUsdc = new MockDebtToken();

        nWmon = new MockAToken("Neverland WMON", "nWMON", 18, vDebtWmon);
        nSmon = new MockAToken("Neverland sMON", "nsMON", 18, vDebtWmon);
        nGmon = new MockAToken("Neverland gMON", "ngMON", 18, vDebtWmon);
        aV2Weth = new MockAToken("Aave V2 WETH", "aWETH", 18, v2DebtUsdc);

        neverlandPool = new MockFlashAaveV3Pool(50); // 0.50% Neverland fee
        neverlandPool.setReserve(address(wmon), address(nWmon), address(vDebtWmon));
        neverlandPool.setReserve(address(smon), address(nSmon), address(new MockDebtToken()));
        neverlandPool.setReserve(address(gmon), address(nGmon), address(new MockDebtToken()));
        neverlandPool.setReserve(address(usdc), address(new MockAToken("nUSDC", "nUSDC", 6, vDebtUsdc)), address(vDebtUsdc));

        aaveV2Pool = new MockAaveV2Pool();
        aaveV2Pool.setReserve(address(usdc), address(new MockAToken("aUSDC", "aUSDC", 6, v2DebtUsdc)), address(v2DebtUsdc));
        aaveV2Pool.setReserve(address(weth), address(aV2Weth), address(new MockDebtToken()));

        morphoBlue = new MockMorphoBlue();
        balancerVault = new MockBalancerV2Vault();
        cometUsdc = new MockFlashComet(address(usdc));

        comptroller = new MockComptroller();
        cUsdcDebt = new MockCToken(address(usdc), MockCToken(address(0)));
        cWethCol = new MockCToken(address(weth), cUsdcDebt);
        comptroller.setListed(address(cUsdcDebt), true);
        comptroller.setListed(address(cWethCol), true);

        dexRouter = new MockDexRouter();

        address[] memory pools = new address[](1);
        pools[0] = address(neverlandPool);
        address[] memory routers = new address[](1);
        routers[0] = address(dexRouter);

        flashUnwind = new TurgaliumFlashUnwind(OWNER, pools, routers);

        address[] memory v2 = new address[](1);
        v2[0] = address(aaveV2Pool);
        address[] memory cv3 = new address[](1);
        cv3[0] = address(cometUsdc);
        address[] memory cv2 = new address[](1);
        cv2[0] = address(comptroller);
        address[] memory mb = new address[](1);
        mb[0] = address(morphoBlue);
        address[] memory bv = new address[](1);
        bv[0] = address(balancerVault);

        vm.prank(OWNER);
        flashUnwind.configureExtendedMarkets(v2, cv3, cv2, mb, bv);
    }

    function testFamily1_AaveV3_NeverlandLoopedWithZeroFeeMorphoFlash() public {
        // Use 0.00% Morpho Blue flash loan to unwind Neverland (saving 0.50% Neverland flash fee!)
        uint256 smonCol = 75_000e18;
        uint256 gmonCol = 15_000e18;
        uint256 wmonDebt = 82_453e18;
        nSmon.mint(USER, smonCol);
        nGmon.mint(USER, gmonCol);
        neverlandPool.mintDebt(USER, address(wmon), wmonDebt);

        vm.startPrank(USER);
        nSmon.approve(address(flashUnwind), type(uint256).max);
        nGmon.approve(address(flashUnwind), type(uint256).max);

        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](2);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({ asset: address(smon), aTokenAmount: type(uint256).max, minRemainingOut: 0 });
        cols[1] = TurgaliumFlashUnwind.CollateralPull({ asset: address(gmon), aTokenAmount: type(uint256).max, minRemainingOut: gmonCol });

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](1);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(smon),
            tokenOut: address(wmon),
            amountIn: smonCol,
            minAmountOut: 84_000e18,
            callData: abi.encodeWithSelector(MockDexRouter.swap.selector, address(smon), address(wmon), smonCol, 84_542e18)
        });

        (uint256 repaid, uint256 surplus) = flashUnwind.unwindUniversal(
            TurgaliumFlashUnwind.UniversalUnwindParams({
                flashProviderKind: TurgaliumFlashUnwind.FlashProviderKind.MORPHO_BLUE,
                flashProvider: address(morphoBlue),
                lendingKind: TurgaliumFlashUnwind.LendingProtocolKind.AAVE_V3,
                lendingMarket: address(neverlandPool),
                debtAsset: address(wmon),
                debtAmount: type(uint256).max,
                interestRateMode: 2,
                protocolData: "",
                collaterals: cols,
                swaps: swaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: address(0),
                minDebtSurplus: 2_000e18, // Full 2,089 WMON surplus (0% flash fee!)
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();

        assertEq(repaid, wmonDebt);
        assertEq(vDebtWmon.balanceOf(USER), 0);
        assertEq(surplus, 84_542e18 - wmonDebt, "0% flash fee -> 100% net surplus returned!");
        assertEq(gmon.balanceOf(USER), gmonCol);
        assertEq(wmon.balanceOf(address(flashUnwind)), 0);
    }

    function testFamily2_AaveV2_WithZeroFeeBalancerFlash() public {
        aV2Weth.mint(USER, 2e18);
        aaveV2Pool.mintDebt(USER, address(usdc), 4_000e6);

        vm.startPrank(USER);
        aV2Weth.approve(address(flashUnwind), type(uint256).max);

        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({ asset: address(weth), aTokenAmount: type(uint256).max, minRemainingOut: 0 });

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](1);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(weth),
            tokenOut: address(usdc),
            amountIn: 2e18,
            minAmountOut: 5_000e6,
            callData: abi.encodeWithSelector(MockDexRouter.swap.selector, address(weth), address(usdc), 2e18, 5_200e6)
        });

        (uint256 repaid, uint256 surplus) = flashUnwind.unwindUniversal(
            TurgaliumFlashUnwind.UniversalUnwindParams({
                flashProviderKind: TurgaliumFlashUnwind.FlashProviderKind.BALANCER_V2,
                flashProvider: address(balancerVault),
                lendingKind: TurgaliumFlashUnwind.LendingProtocolKind.AAVE_V2,
                lendingMarket: address(aaveV2Pool),
                debtAsset: address(usdc),
                debtAmount: type(uint256).max,
                interestRateMode: 2,
                protocolData: "",
                collaterals: cols,
                swaps: swaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: USER,
                minDebtSurplus: 1_100e6,
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();

        assertEq(repaid, 4_000e6);
        assertEq(v2DebtUsdc.balanceOf(USER), 0);
        assertEq(surplus, 1_200e6);
        assertEq(usdc.balanceOf(USER), 1_200e6);
    }

    function testFamily3_CompoundV3Comet_WithMorphoFlash() public {
        cometUsdc.seedUser(USER, address(weth), 1e18, 2_000e6);

        vm.startPrank(USER);
        cometUsdc.allow(address(flashUnwind), true);

        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({ asset: address(weth), aTokenAmount: type(uint256).max, minRemainingOut: 0 });

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](1);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(weth),
            tokenOut: address(usdc),
            amountIn: 1e18,
            minAmountOut: 2_500e6,
            callData: abi.encodeWithSelector(MockDexRouter.swap.selector, address(weth), address(usdc), 1e18, 2_650e6)
        });

        (uint256 repaid, uint256 surplus) = flashUnwind.unwindUniversal(
            TurgaliumFlashUnwind.UniversalUnwindParams({
                flashProviderKind: TurgaliumFlashUnwind.FlashProviderKind.MORPHO_BLUE,
                flashProvider: address(morphoBlue),
                lendingKind: TurgaliumFlashUnwind.LendingProtocolKind.COMPOUND_V3,
                lendingMarket: address(cometUsdc),
                debtAsset: address(usdc),
                debtAmount: type(uint256).max,
                interestRateMode: 0,
                protocolData: "",
                collaterals: cols,
                swaps: swaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: USER,
                minDebtSurplus: 600e6,
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();

        assertEq(repaid, 2_000e6);
        assertEq(cometUsdc.borrowBalanceOf(USER), 0);
        assertEq(surplus, 650e6);
        assertEq(usdc.balanceOf(USER), 650e6);
    }

    function testFamily4_CompoundV2Forks_MoonwellVenusBenqiMendi() public {
        cWethCol.mintCToken(USER, 1e18);
        cUsdcDebt.seedBorrow(USER, 1_500e6);

        vm.startPrank(USER);
        cWethCol.approve(address(flashUnwind), type(uint256).max);

        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({ asset: address(cWethCol), aTokenAmount: type(uint256).max, minRemainingOut: 0 });

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](1);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(weth),
            tokenOut: address(usdc),
            amountIn: 1e18,
            minAmountOut: 2_000e6,
            callData: abi.encodeWithSelector(MockDexRouter.swap.selector, address(weth), address(usdc), 1e18, 2_300e6)
        });

        (uint256 repaid, uint256 surplus) = flashUnwind.unwindUniversal(
            TurgaliumFlashUnwind.UniversalUnwindParams({
                flashProviderKind: TurgaliumFlashUnwind.FlashProviderKind.BALANCER_V2,
                flashProvider: address(balancerVault),
                lendingKind: TurgaliumFlashUnwind.LendingProtocolKind.COMPOUND_V2,
                lendingMarket: address(comptroller),
                debtAsset: address(usdc),
                debtAmount: type(uint256).max,
                interestRateMode: 0,
                protocolData: abi.encode(address(cUsdcDebt)),
                collaterals: cols,
                swaps: swaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: USER,
                minDebtSurplus: 750e6,
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();

        assertEq(repaid, 1_500e6);
        assertEq(cUsdcDebt.borrowBalanceCurrent(USER), 0);
        assertEq(surplus, 800e6);
        assertEq(usdc.balanceOf(USER), 800e6);
    }

    function testFamily5_MorphoBlue_ZeroFeeSelfFlashUnwind() public {
        IMorphoBlue.MarketParams memory mp = IMorphoBlue.MarketParams({
            loanToken: address(usdc),
            collateralToken: address(weth),
            oracle: address(0x1111),
            irm: address(0x2222),
            lltv: 86e16
        });
        morphoBlue.seedPosition(mp, USER, 1_800e6, 1e18);

        vm.startPrank(USER);
        morphoBlue.setAuthorization(address(flashUnwind), true);

        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({ asset: address(weth), aTokenAmount: type(uint256).max, minRemainingOut: 0 });

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](1);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(weth),
            tokenOut: address(usdc),
            amountIn: 1e18,
            minAmountOut: 2_400e6,
            callData: abi.encodeWithSelector(MockDexRouter.swap.selector, address(weth), address(usdc), 1e18, 2_500e6)
        });

        (uint256 repaid, uint256 surplus) = flashUnwind.unwindUniversal(
            TurgaliumFlashUnwind.UniversalUnwindParams({
                flashProviderKind: TurgaliumFlashUnwind.FlashProviderKind.MORPHO_BLUE,
                flashProvider: address(morphoBlue),
                lendingKind: TurgaliumFlashUnwind.LendingProtocolKind.MORPHO_BLUE,
                lendingMarket: address(morphoBlue),
                debtAsset: address(usdc),
                debtAmount: 1_800e6,
                interestRateMode: 0,
                protocolData: abi.encode(mp, true),
                collaterals: cols,
                swaps: swaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: USER,
                minDebtSurplus: 650e6,
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();

        assertEq(repaid, 1_800e6);
        assertEq(surplus, 700e6);
        assertEq(usdc.balanceOf(USER), 700e6);
    }

    function testUnwindMultiClearsTwoDebtAssetsAtomically() public {
        nSmon.mint(USER, 100_000e18);
        neverlandPool.mintDebt(USER, address(wmon), 50_000e18);
        neverlandPool.mintDebt(USER, address(usdc), 200e6);

        vm.startPrank(USER);
        nSmon.approve(address(flashUnwind), type(uint256).max);

        address[] memory debtAssets = new address[](2);
        debtAssets[0] = address(wmon);
        debtAssets[1] = address(usdc);
        uint256[] memory debtAmounts = new uint256[](2);
        debtAmounts[0] = type(uint256).max;
        debtAmounts[1] = type(uint256).max;
        uint256[] memory modes = new uint256[](2);
        modes[0] = 2;
        modes[1] = 2;
        uint256[] memory minSurpluses = new uint256[](2);
        minSurpluses[0] = 5_000e18;
        minSurpluses[1] = 50e6;

        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({ asset: address(smon), aTokenAmount: type(uint256).max, minRemainingOut: 0 });

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](2);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(smon),
            tokenOut: address(wmon),
            amountIn: 60_000e18,
            minAmountOut: 55_000e18,
            callData: abi.encodeWithSelector(MockDexRouter.swap.selector, address(smon), address(wmon), 60_000e18, 56_000e18)
        });
        swaps[1] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(smon),
            tokenOut: address(usdc),
            amountIn: 40_000e18,
            minAmountOut: 250e6,
            callData: abi.encodeWithSelector(MockDexRouter.swap.selector, address(smon), address(usdc), 40_000e18, 260e6)
        });

        (uint256[] memory repaid, uint256[] memory surpluses) = flashUnwind.unwindMulti(
            address(neverlandPool),
            TurgaliumFlashUnwind.MultiUnwindParams({
                debtAssets: debtAssets,
                debtAmounts: debtAmounts,
                interestRateModes: modes,
                collaterals: cols,
                swaps: swaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: USER,
                minDebtSurpluses: minSurpluses,
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();

        assertEq(repaid[0], 50_000e18);
        assertEq(repaid[1], 200e6);
        assertGt(surpluses[0], 5_500e18, "WMON surplus must exceed 5500");
        assertGt(surpluses[1], 55e6, "USDC surplus must exceed 55");
    }

    function testSecurityDisjointAllowlistsCallbacksReentrancyAndPause() public {
        // 1. Disjoint allowlists across all protocol flags
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(TurgaliumFlashUnwind.DisjointAllowlistViolation.selector, address(neverlandPool)));
        flashUnwind.setAllowedSwapRouter(address(neverlandPool), true);

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(TurgaliumFlashUnwind.DisjointAllowlistViolation.selector, address(morphoBlue)));
        flashUnwind.setAllowedSwapRouter(address(morphoBlue), true);

        // 2. Unsolicited callbacks rejected across Aave, Morpho, and Balancer
        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(TurgaliumFlashUnwind.CallbackRejected.selector, ATTACKER));
        flashUnwind.executeOperation(address(wmon), 1e18, 0, address(flashUnwind), "");

        vm.prank(ATTACKER);
        vm.expectRevert(abi.encodeWithSelector(TurgaliumFlashUnwind.CallbackRejected.selector, ATTACKER));
        flashUnwind.onMorphoFlashLoan(1e18, "");

        // 3. Pause & two-step ownership
        vm.prank(OWNER);
        flashUnwind.setPaused(true);
        assertTrue(flashUnwind.paused());
        vm.prank(OWNER);
        flashUnwind.transferOwnership(RECIPIENT);
        vm.prank(RECIPIENT);
        flashUnwind.acceptOwnership();
        assertEq(flashUnwind.owner(), RECIPIENT);
    }

    /// @notice Live Monad Mainnet fork verification: uses 0.00% FREE Morpho Blue flash loan
    ///         (0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee) to unwind Malik's REAL live Neverland
    ///         position (0xb7b570Dc117b4946925bc39166418516FB011CbB) with 0% Turgalium fee AND 0% flash fee!
    function testForkMonadZeroFeeMorphoToNeverlandLiveUnwind() public {
        if (block.chainid != 143) {
            vm.skip(true);
            return;
        }

        address liveNeverland = 0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585;
        address liveMorpho = 0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee;
        address liveWmon = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
        address liveSmon = 0xA3227C5969757783154C60bF0bC1944180ed81B9;
        address liveGmon = 0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081;
        address liveUser = 0xb7b570Dc117b4946925bc39166418516FB011CbB;

        IAaveV3FlashPool.ReserveData memory wmonRd = IAaveV3FlashPool(liveNeverland).getReserveData(liveWmon);
        IAaveV3FlashPool.ReserveData memory smonRd = IAaveV3FlashPool(liveNeverland).getReserveData(liveSmon);
        IAaveV3FlashPool.ReserveData memory gmonRd = IAaveV3FlashPool(liveNeverland).getReserveData(liveGmon);

        uint256 initialDebt = IERC20(wmonRd.variableDebtTokenAddress).balanceOf(liveUser);
        uint256 initialNsmon = IERC20(smonRd.aTokenAddress).balanceOf(liveUser);
        uint256 initialNgmon = IERC20(gmonRd.aTokenAddress).balanceOf(liveUser);
        if (initialDebt == 0 || initialNsmon == 0) return;

        MockForkDexRouter forkDex = new MockForkDexRouter();
        uint256 smonWmonOut = (initialNsmon * 112) / 100;
        uint256 gmonWmonOut = (initialNgmon * 111) / 100;
        vm.prank(wmonRd.aTokenAddress);
        IERC20(liveWmon).transfer(address(forkDex), smonWmonOut + gmonWmonOut);

        address[] memory pools = new address[](1);
        pools[0] = liveNeverland;
        address[] memory routers = new address[](1);
        routers[0] = address(forkDex);
        TurgaliumFlashUnwind liveUnwind = new TurgaliumFlashUnwind(OWNER, pools, routers);

        address[] memory empty;
        address[] memory morphos = new address[](1);
        morphos[0] = liveMorpho;
        vm.prank(OWNER);
        liveUnwind.configureExtendedMarkets(empty, empty, empty, morphos, empty);

        vm.startPrank(liveUser);
        IERC20(smonRd.aTokenAddress).approve(address(liveUnwind), type(uint256).max);
        if (initialNgmon > 0) {
            IERC20(gmonRd.aTokenAddress).approve(address(liveUnwind), type(uint256).max);
        }

        uint256 colCount = initialNgmon > 0 ? 2 : 1;
        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](colCount);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({ asset: liveSmon, aTokenAmount: type(uint256).max, minRemainingOut: 0 });
        if (initialNgmon > 0) {
            cols[1] = TurgaliumFlashUnwind.CollateralPull({ asset: liveGmon, aTokenAmount: type(uint256).max, minRemainingOut: 0 });
        }

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](colCount);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(forkDex),
            tokenIn: liveSmon,
            tokenOut: liveWmon,
            amountIn: type(uint256).max,
            minAmountOut: (smonWmonOut * 99) / 100,
            callData: abi.encodeWithSelector(MockForkDexRouter.swapAll.selector, liveSmon, liveWmon, smonWmonOut)
        });
        if (initialNgmon > 0) {
            swaps[1] = TurgaliumFlashUnwind.SwapStep({
                router: address(forkDex),
                tokenIn: liveGmon,
                tokenOut: liveWmon,
                amountIn: type(uint256).max,
                minAmountOut: (gmonWmonOut * 99) / 100,
                callData: abi.encodeWithSelector(MockForkDexRouter.swapAll.selector, liveGmon, liveWmon, gmonWmonOut)
            });
        }

        (uint256 repaid, uint256 surplus) = liveUnwind.unwindUniversal(
            TurgaliumFlashUnwind.UniversalUnwindParams({
                flashProviderKind: TurgaliumFlashUnwind.FlashProviderKind.MORPHO_BLUE,
                flashProvider: liveMorpho,
                lendingKind: TurgaliumFlashUnwind.LendingProtocolKind.AAVE_V3,
                lendingMarket: liveNeverland,
                debtAsset: liveWmon,
                debtAmount: type(uint256).max,
                interestRateMode: 2,
                protocolData: "",
                collaterals: cols,
                swaps: swaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: liveUser,
                minDebtSurplus: 15_000e18, // ~15.5k+ WMON returned with ZERO flash fee!
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();

        assertGe(repaid, initialDebt, "Live Neverland debt cleared to 0");
        assertEq(IERC20(wmonRd.variableDebtTokenAddress).balanceOf(liveUser), 0);
        assertGt(surplus, 15_000e18, "0% Morpho flash fee preserved >15,000 WMON net surplus!");
        assertEq(IERC20(liveWmon).balanceOf(address(liveUnwind)), 0);
    }
}
