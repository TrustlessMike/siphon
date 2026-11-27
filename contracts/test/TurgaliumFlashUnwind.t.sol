// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import { MockERC20 } from "./Mocks.sol";
import {
    TurgaliumFlashUnwind,
    IAaveV3FlashPool,
    IERC20
} from "../TurgaliumFlashUnwind.sol";

/// @notice Realistic mock Aave V3 / Neverland Pool supporting variable debt, health factor lock on
///         aToken transfer while debt > 0, flashLoanSimple, flashLoan, repay, and withdraw.
contract MockFlashAaveV3Pool {
    uint128 public flashLoanPremiumBps; // e.g. 50 = 0.50% (Neverland) or 5 = 0.05% (Aave V3)
    mapping(address => address) public aTokens;
    mapping(address => address) public variableDebtTokens;
    mapping(address => uint256) public totalUserDebtCount;

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
                MockERC20(assets[i]).transferFrom(
                    receiverAddress,
                    address(this),
                    amounts[i] + premiums[i]
                ),
                "FLASH_MULTI_REPAY_FAILED"
            );
        }
    }

    function repay(
        address asset,
        uint256 amount,
        uint256,
        address onBehalfOf
    ) external returns (uint256) {
        MockDebtToken debtTok = MockDebtToken(variableDebtTokens[asset]);
        uint256 owed = debtTok.balanceOf(onBehalfOf);
        uint256 payAmt = amount == type(uint256).max || amount > owed ? owed : amount;
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

/// @notice Mock aToken that mirrors Aave V3 HF enforcement: blocks transferFrom while user holds debt!
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
            require(guardedDebtToken.balanceOf(msg.sender) == 0, "HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD");
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
        // Mirrors real Aave V3: transferring collateral aToken while HF is 1.08 reverts until debt == 0!
        if (address(guardedDebtToken) != address(0)) {
            require(guardedDebtToken.balanceOf(from) == 0, "HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD");
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

contract MockDexRouter {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut) external {
        require(MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "DEX_PULL_FAIL");
        MockERC20(tokenOut).mint(msg.sender, amountOut);
    }

    function swapAndReenter(
        address target,
        address pool,
        address tokenIn,
        uint256 amountIn
    ) external {
        require(MockERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn), "DEX_PULL_FAIL");
        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({
            asset: tokenIn,
            aTokenAmount: 1,
            minRemainingOut: 0
        });
        TurgaliumFlashUnwind(target).unwindSimple(
            pool,
            TurgaliumFlashUnwind.SimpleUnwindParams({
                debtAsset: tokenIn,
                debtAmount: 1,
                interestRateMode: 2,
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

contract TurgaliumFlashUnwindTest is TestBase {
    address private constant OWNER = address(0xA11CE);
    address private constant USER = address(0xB0B);
    address private constant ATTACKER = address(0xBAD);
    address private constant RECIPIENT = address(0xCAFE);

    MockERC20 private wmon;
    MockERC20 private smon;
    MockERC20 private gmon;
    MockERC20 private usdc;

    MockDebtToken private vDebtWmon;
    MockDebtToken private vDebtUsdc;

    MockAToken private nWmon;
    MockAToken private nSmon;
    MockAToken private nGmon;

    MockFlashAaveV3Pool private neverlandPool;
    MockDexRouter private dexRouter;
    TurgaliumFlashUnwind private flashUnwind;

    function setUp() public {
        wmon = new MockERC20("Wrapped MON", "WMON", 18);
        smon = new MockERC20("Kintsu sMON", "sMON", 18);
        gmon = new MockERC20("Magma gMON", "gMON", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);

        vDebtWmon = new MockDebtToken();
        vDebtUsdc = new MockDebtToken();

        // Both nsMON and ngMON enforce HF check against WMON debt (just like live Neverland!)
        nWmon = new MockAToken("Neverland WMON", "nWMON", 18, vDebtWmon);
        nSmon = new MockAToken("Neverland sMON", "nsMON", 18, vDebtWmon);
        nGmon = new MockAToken("Neverland gMON", "ngMON", 18, vDebtWmon);

        // 50 bps = 0.50% (live Neverland FLASHLOAN_PREMIUM_TOTAL on Monad)
        neverlandPool = new MockFlashAaveV3Pool(50);
        neverlandPool.setReserve(address(wmon), address(nWmon), address(vDebtWmon));
        neverlandPool.setReserve(address(smon), address(nSmon), address(new MockDebtToken()));
        neverlandPool.setReserve(address(gmon), address(nGmon), address(new MockDebtToken()));
        neverlandPool.setReserve(address(usdc), address(new MockAToken("nUSDC", "nUSDC", 6, vDebtUsdc)), address(vDebtUsdc));

        dexRouter = new MockDexRouter();

        address[] memory pools = new address[](1);
        pools[0] = address(neverlandPool);
        address[] memory routers = new address[](1);
        routers[0] = address(dexRouter);

        flashUnwind = new TurgaliumFlashUnwind(OWNER, pools, routers);
    }

    function testUnwindSimpleNeverlandLoopedPositionWithZeroUpfrontCapital() public {
        // Mirrors Malik's exact Monad Neverland position:
        //   75,000 nsMON + 15,000 ngMON collateral vs 82,453 WMON debt, 0 WMON in wallet!
        uint256 smonCol = 75_000e18;
        uint256 gmonCol = 15_000e18;
        uint256 wmonDebt = 82_453e18;

        nSmon.mint(USER, smonCol);
        nGmon.mint(USER, gmonCol);
        neverlandPool.mintDebt(USER, address(wmon), wmonDebt);

        // User holds literally 0 WMON
        assertEq(wmon.balanceOf(USER), 0);

        vm.startPrank(USER);
        nSmon.approve(address(flashUnwind), type(uint256).max);
        nGmon.approve(address(flashUnwind), type(uint256).max);

        // Swap only 75,000 sMON -> 84,542 WMON (covers 82,453 debt + 0.50% premium ~412 WMON),
        // leaving 100% of 15,000 gMON untouched + ~1,677 WMON surplus returned to USER!
        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](2);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({
            asset: address(smon),
            aTokenAmount: type(uint256).max,
            minRemainingOut: 0
        });
        cols[1] = TurgaliumFlashUnwind.CollateralPull({
            asset: address(gmon),
            aTokenAmount: type(uint256).max,
            minRemainingOut: gmonCol
        });

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](1);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(smon),
            tokenOut: address(wmon),
            amountIn: smonCol,
            minAmountOut: 84_000e18,
            callData: abi.encodeWithSelector(
                MockDexRouter.swap.selector,
                address(smon),
                address(wmon),
                smonCol,
                84_542e18
            )
        });

        (uint256 repaid, uint256 surplus) = flashUnwind.unwindSimple(
            address(neverlandPool),
            TurgaliumFlashUnwind.SimpleUnwindParams({
                debtAsset: address(wmon),
                debtAmount: type(uint256).max,
                interestRateMode: 2,
                collaterals: cols,
                swaps: swaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: address(0), // defaults to msg.sender
                minDebtSurplus: 1_500e18,
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();

        // 1. 100% of debt cleared to 0
        assertEq(vDebtWmon.balanceOf(USER), 0, "WMON debt must be 0");
        assertEq(repaid, wmonDebt, "repaid must equal exact debt");

        // 2. User received 100% of gMON + WMON surplus (~1,676.7 WMON after 0.50% flash fee)
        assertEq(gmon.balanceOf(USER), gmonCol, "User must keep 100% of unswapped gMON");
        assertGt(surplus, 1_600e18, "User must receive >1600 WMON net surplus");
        assertEq(wmon.balanceOf(USER), surplus, "User WMON balance must match surplus");

        // 3. Zero dust & zero leftover approvals on TurgaliumFlashUnwind
        assertEq(wmon.balanceOf(address(flashUnwind)), 0, "No WMON stuck");
        assertEq(smon.balanceOf(address(flashUnwind)), 0, "No sMON stuck");
        assertEq(gmon.balanceOf(address(flashUnwind)), 0, "No gMON stuck");
        assertEq(wmon.allowance(address(flashUnwind), address(neverlandPool)), 0, "Pool allowance reset");
        assertEq(smon.allowance(address(flashUnwind), address(dexRouter)), 0, "Router allowance reset");
    }

    function testUnwindSimpleSameAssetNoSwapWithPermit() public {
        uint256 col = 10_000e18;
        uint256 debt = 7_500e18;
        nWmon.mint(USER, col);
        neverlandPool.mintDebt(USER, address(wmon), debt);

        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({
            asset: address(wmon),
            aTokenAmount: type(uint256).max,
            minRemainingOut: 0
        });

        TurgaliumFlashUnwind.PermitApproval[] memory permits = new TurgaliumFlashUnwind.PermitApproval[](1);
        permits[0] = TurgaliumFlashUnwind.PermitApproval({
            token: address(nWmon),
            value: type(uint256).max,
            deadline: block.timestamp + 600,
            v: 27,
            r: bytes32(uint256(1)),
            s: bytes32(uint256(2))
        });

        vm.prank(USER);
        (uint256 repaid, uint256 surplus) = flashUnwind.unwindSimple(
            address(neverlandPool),
            TurgaliumFlashUnwind.SimpleUnwindParams({
                debtAsset: address(wmon),
                debtAmount: type(uint256).max,
                interestRateMode: 2,
                collaterals: cols,
                swaps: new TurgaliumFlashUnwind.SwapStep[](0),
                permits: permits,
                recipient: RECIPIENT,
                minDebtSurplus: 2_400e18,
                deadline: block.timestamp + 600
            })
        );

        assertEq(repaid, debt);
        assertEq(vDebtWmon.balanceOf(USER), 0);
        assertGt(surplus, 2_450e18, "surplus must exceed 2450 WMON");
        assertEq(wmon.balanceOf(RECIPIENT), surplus);
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
        cols[0] = TurgaliumFlashUnwind.CollateralPull({
            asset: address(smon),
            aTokenAmount: type(uint256).max,
            minRemainingOut: 0
        });

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](2);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(smon),
            tokenOut: address(wmon),
            amountIn: 60_000e18,
            minAmountOut: 55_000e18,
            callData: abi.encodeWithSelector(
                MockDexRouter.swap.selector,
                address(smon),
                address(wmon),
                60_000e18,
                56_000e18
            )
        });
        swaps[1] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(smon),
            tokenOut: address(usdc),
            amountIn: 40_000e18,
            minAmountOut: 250e6,
            callData: abi.encodeWithSelector(
                MockDexRouter.swap.selector,
                address(smon),
                address(usdc),
                40_000e18,
                260e6
            )
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
        assertEq(vDebtWmon.balanceOf(USER), 0);
        assertEq(vDebtUsdc.balanceOf(USER), 0);
        assertGt(surpluses[0], 5_500e18, "WMON surplus must exceed 5500");
        assertGt(surpluses[1], 55e6, "USDC surplus must exceed 55");
        assertEq(wmon.balanceOf(USER), surpluses[0]);
        assertEq(usdc.balanceOf(USER), surpluses[1]);
    }

    function testRejectsSpoofedPoolAndSpoofedRouterAndDisjointViolation() public {
        address fakePool = address(0x9999);
        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({
            asset: address(smon),
            aTokenAmount: 100e18,
            minRemainingOut: 0
        });

        vm.prank(USER);
        vm.expectRevert(abi.encodeWithSelector(TurgaliumFlashUnwind.PoolNotAllowed.selector, fakePool));
        flashUnwind.unwindSimple(
            fakePool,
            TurgaliumFlashUnwind.SimpleUnwindParams({
                debtAsset: address(wmon),
                debtAmount: 100e18,
                interestRateMode: 2,
                collaterals: cols,
                swaps: new TurgaliumFlashUnwind.SwapStep[](0),
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: USER,
                minDebtSurplus: 0,
                deadline: block.timestamp + 600
            })
        );

        // Disjoint allowlist check
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                TurgaliumFlashUnwind.DisjointAllowlistViolation.selector,
                address(neverlandPool)
            )
        );
        flashUnwind.setAllowedSwapRouter(address(neverlandPool), true);

        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                TurgaliumFlashUnwind.DisjointAllowlistViolation.selector,
                address(dexRouter)
            )
        );
        flashUnwind.setAllowedPool(address(dexRouter), true);
    }

    function testRejectsSpoofedCallbackAndReentrancyAndSlippage() public {
        // 1. Direct unsolicited executeOperation callback must revert
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(
                TurgaliumFlashUnwind.InvalidCallbackCaller.selector,
                ATTACKER,
                address(0)
            )
        );
        flashUnwind.executeOperation(address(wmon), 100e18, 1e18, address(flashUnwind), "");

        // 2. Malicious reentrant swap router must revert inside nonReentrant (wrapped as SwapExecutionFailed)
        nSmon.mint(USER, 1_000e18);
        neverlandPool.mintDebt(USER, address(wmon), 500e18);
        vm.startPrank(USER);
        nSmon.approve(address(flashUnwind), type(uint256).max);

        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({
            asset: address(smon),
            aTokenAmount: type(uint256).max,
            minRemainingOut: 0
        });

        TurgaliumFlashUnwind.SwapStep[] memory reenterSwaps = new TurgaliumFlashUnwind.SwapStep[](1);
        reenterSwaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(smon),
            tokenOut: address(wmon),
            amountIn: 1_000e18,
            minAmountOut: 500e18,
            callData: abi.encodeWithSelector(
                MockDexRouter.swapAndReenter.selector,
                address(flashUnwind),
                address(neverlandPool),
                address(smon),
                1_000e18
            )
        });

        vm.expectRevert();
        flashUnwind.unwindSimple(
            address(neverlandPool),
            TurgaliumFlashUnwind.SimpleUnwindParams({
                debtAsset: address(wmon),
                debtAmount: type(uint256).max,
                interestRateMode: 2,
                collaterals: cols,
                swaps: reenterSwaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: USER,
                minDebtSurplus: 0,
                deadline: block.timestamp + 600
            })
        );

        // 3. Slippage protection reverts when minAmountOut is not met
        TurgaliumFlashUnwind.SwapStep[] memory lowOutSwaps = new TurgaliumFlashUnwind.SwapStep[](1);
        lowOutSwaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(dexRouter),
            tokenIn: address(smon),
            tokenOut: address(wmon),
            amountIn: 1_000e18,
            minAmountOut: 900e18,
            callData: abi.encodeWithSelector(
                MockDexRouter.swap.selector,
                address(smon),
                address(wmon),
                1_000e18,
                600e18
            )
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                TurgaliumFlashUnwind.SwapSlippageExceeded.selector,
                0,
                600e18,
                900e18
            )
        );
        flashUnwind.unwindSimple(
            address(neverlandPool),
            TurgaliumFlashUnwind.SimpleUnwindParams({
                debtAsset: address(wmon),
                debtAmount: type(uint256).max,
                interestRateMode: 2,
                collaterals: cols,
                swaps: lowOutSwaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: USER,
                minDebtSurplus: 0,
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();
    }

    function testGovernanceTwoStepOwnershipAndPause() public {
        vm.prank(OWNER);
        flashUnwind.setPaused(true);
        assertTrue(flashUnwind.paused());

        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](1);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({
            asset: address(smon),
            aTokenAmount: 1e18,
            minRemainingOut: 0
        });
        vm.prank(USER);
        vm.expectRevert(TurgaliumFlashUnwind.ContractPaused.selector);
        flashUnwind.unwindSimple(
            address(neverlandPool),
            TurgaliumFlashUnwind.SimpleUnwindParams({
                debtAsset: address(wmon),
                debtAmount: 1e18,
                interestRateMode: 2,
                collaterals: cols,
                swaps: new TurgaliumFlashUnwind.SwapStep[](0),
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: USER,
                minDebtSurplus: 0,
                deadline: block.timestamp + 600
            })
        );

        vm.prank(OWNER);
        flashUnwind.transferOwnership(RECIPIENT);
        assertEq(flashUnwind.pendingOwner(), RECIPIENT);
        assertEq(flashUnwind.owner(), OWNER);

        vm.prank(RECIPIENT);
        flashUnwind.acceptOwnership();
        assertEq(flashUnwind.owner(), RECIPIENT);
        assertEq(flashUnwind.pendingOwner(), address(0));
    }

    /// @notice Live Monad Mainnet fork verification against the real Neverland Pool
    ///         (0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585) and real leveraged wallet
    ///         (0xb7b570Dc117b4946925bc39166418516FB011CbB).
    ///         Run with: `forge test --fork-url https://rpc.monad.xyz --match-test testForkMonadNeverlandLiveFlashUnwind -vvv`
    function testForkMonadNeverlandLiveFlashUnwind() public {
        if (block.chainid != 143) {
            vm.skip(true);
            return;
        }

        address livePool = 0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585;
        address liveWmon = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
        address liveSmon = 0xA3227C5969757783154C60bF0bC1944180ed81B9;
        address liveGmon = 0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081;
        address liveUser = 0xb7b570Dc117b4946925bc39166418516FB011CbB;

        IAaveV3FlashPool.ReserveData memory wmonRd = IAaveV3FlashPool(livePool).getReserveData(liveWmon);
        IAaveV3FlashPool.ReserveData memory smonRd = IAaveV3FlashPool(livePool).getReserveData(liveSmon);
        IAaveV3FlashPool.ReserveData memory gmonRd = IAaveV3FlashPool(livePool).getReserveData(liveGmon);

        uint256 initialDebt = IERC20(wmonRd.variableDebtTokenAddress).balanceOf(liveUser);
        uint256 initialNsmon = IERC20(smonRd.aTokenAddress).balanceOf(liveUser);
        uint256 initialNgmon = IERC20(gmonRd.aTokenAddress).balanceOf(liveUser);

        if (initialDebt == 0 || initialNsmon == 0) {
            // Position already unwound on-chain
            return;
        }

        // Deploy a local mock DEX router on the fork funded with WMON (mirroring live KyberSwap rates:
        // ~1.12 WMON/sMON and ~1.11 WMON/gMON). Both collaterals swap cleanly to repay 100% debt + 0.50% fee!
        MockForkDexRouter forkDex = new MockForkDexRouter();
        uint256 smonWmonOut = (initialNsmon * 112) / 100;
        uint256 gmonWmonOut = (initialNgmon * 111) / 100;
        vm.prank(wmonRd.aTokenAddress);
        IERC20(liveWmon).transfer(address(forkDex), smonWmonOut + gmonWmonOut);

        address[] memory pools = new address[](1);
        pools[0] = livePool;
        address[] memory routers = new address[](1);
        routers[0] = address(forkDex);
        TurgaliumFlashUnwind liveUnwind = new TurgaliumFlashUnwind(OWNER, pools, routers);

        vm.startPrank(liveUser);
        IERC20(smonRd.aTokenAddress).approve(address(liveUnwind), type(uint256).max);
        if (initialNgmon > 0) {
            IERC20(gmonRd.aTokenAddress).approve(address(liveUnwind), type(uint256).max);
        }

        uint256 colCount = initialNgmon > 0 ? 2 : 1;
        TurgaliumFlashUnwind.CollateralPull[] memory cols = new TurgaliumFlashUnwind.CollateralPull[](colCount);
        cols[0] = TurgaliumFlashUnwind.CollateralPull({
            asset: liveSmon,
            aTokenAmount: type(uint256).max,
            minRemainingOut: 0
        });
        if (initialNgmon > 0) {
            cols[1] = TurgaliumFlashUnwind.CollateralPull({
                asset: liveGmon,
                aTokenAmount: type(uint256).max,
                minRemainingOut: 0
            });
        }

        TurgaliumFlashUnwind.SwapStep[] memory swaps = new TurgaliumFlashUnwind.SwapStep[](colCount);
        swaps[0] = TurgaliumFlashUnwind.SwapStep({
            router: address(forkDex),
            tokenIn: liveSmon,
            tokenOut: liveWmon,
            amountIn: type(uint256).max,
            minAmountOut: (smonWmonOut * 99) / 100,
            callData: abi.encodeWithSelector(
                MockForkDexRouter.swapAll.selector,
                liveSmon,
                liveWmon,
                smonWmonOut
            )
        });
        if (initialNgmon > 0) {
            swaps[1] = TurgaliumFlashUnwind.SwapStep({
                router: address(forkDex),
                tokenIn: liveGmon,
                tokenOut: liveWmon,
                amountIn: type(uint256).max,
                minAmountOut: (gmonWmonOut * 99) / 100,
                callData: abi.encodeWithSelector(
                    MockForkDexRouter.swapAll.selector,
                    liveGmon,
                    liveWmon,
                    gmonWmonOut
                )
            });
        }

        (uint256 repaid, uint256 surplus) = liveUnwind.unwindSimple(
            livePool,
            TurgaliumFlashUnwind.SimpleUnwindParams({
                debtAsset: liveWmon,
                debtAmount: type(uint256).max,
                interestRateMode: 2,
                collaterals: cols,
                swaps: swaps,
                permits: new TurgaliumFlashUnwind.PermitApproval[](0),
                recipient: liveUser,
                minDebtSurplus: 10_000e18, // >10,000 WMON net equity returned!
                deadline: block.timestamp + 600
            })
        );
        vm.stopPrank();

        assertGe(repaid, initialDebt, "Live Neverland WMON debt must be fully repaid");
        assertEq(IERC20(wmonRd.variableDebtTokenAddress).balanceOf(liveUser), 0, "Live Neverland debt == 0");
        assertEq(IERC20(smonRd.aTokenAddress).balanceOf(liveUser), 0, "Live nsMON withdrawn");
        if (initialNgmon > 0) {
            assertEq(IERC20(gmonRd.aTokenAddress).balanceOf(liveUser), 0, "Live ngMON withdrawn");
        }
        assertGt(surplus, 10_000e18, "Live net WMON surplus (>10k WMON) returned");
        assertEq(IERC20(liveWmon).balanceOf(address(liveUnwind)), 0, "Zero residual WMON on contract");
    }
}

contract MockForkDexRouter {
    function swapAll(address tokenIn, address tokenOut, uint256 amountOut) external {
        uint256 bal = IERC20(tokenIn).balanceOf(msg.sender);
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), bal), "FORK_DEX_PULL_FAIL");
        require(IERC20(tokenOut).transfer(msg.sender, amountOut), "FORK_DEX_OUT_FAIL");
    }
}
