// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import {
    MockERC20,
    MockHoneypotReturnBombToken,
    MockTokenMessengerV1,
    MockTokenMessengerV2,
    MockSwapAggregator,
    MockAaveV3Pool,
    MockCompoundV3Comet,
    MockERC4626Vault,
    MockPermit2
} from "./Mocks.sol";
import { SiphonRouter, IPermit2 } from "../SiphonRouter.sol";
import { SiphonAgentVault } from "../SiphonAgentVault.sol";

contract SiphonRouterTest is TestBase {
    MockERC20 internal usdc;
    MockERC20 internal dustToken;
    MockERC20 internal aUsdc;
    MockERC20 internal deadToken;
    MockHoneypotReturnBombToken internal honeypotToken;

    MockTokenMessengerV1 internal cctpV1;
    MockTokenMessengerV2 internal cctpV2;
    MockSwapAggregator internal aggregator;
    MockAaveV3Pool internal aavePool;
    MockCompoundV3Comet internal comet;
    MockERC4626Vault internal vault4626;

    SiphonRouter internal routerV2;
    SiphonRouter internal routerV1;
    SiphonAgentVault internal agentVault;

    address internal owner;
    address internal feeRecipient = address(0xFEE1);
    address internal relayer = address(0xBEEF);
    address internal user = address(0xA11CE);
    address internal agent = address(0xA6E7);
    address internal attacker = address(0xBAD);

    bytes32 internal constant SOLANA_ATA =
        0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff;
    bytes32 internal constant WRONG_SOLANA_ATA =
        0xffeeddccbbaa00998877665544332211ffeeddccbbaa00998877665544332211;

    function setUp() public {
        owner = address(this);
        vm.warp(1_750_000_000);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        dustToken = new MockERC20("Dust Token", "DUST", 18);
        aUsdc = new MockERC20("Aave USDC", "aUSDC", 6);
        deadToken = new MockERC20("Dead Token", "DEAD", 18);
        honeypotToken = new MockHoneypotReturnBombToken();

        cctpV1 = new MockTokenMessengerV1();
        cctpV2 = new MockTokenMessengerV2();
        aggregator = new MockSwapAggregator(address(usdc));
        aavePool = new MockAaveV3Pool();
        aavePool.setReserve(address(usdc), address(aUsdc));
        comet = new MockCompoundV3Comet();
        vault4626 = new MockERC4626Vault(address(usdc));

        // Seed aggregator liquidity
        usdc.mint(address(aggregator), 10_000_000e6);

        // Deploy routers (V2 default 25 bps preservation tier; V1 700 bps legacy tier)
        routerV2 = new SiphonRouter(address(usdc), address(cctpV2), 2, feeRecipient, 25);
        routerV1 = new SiphonRouter(address(usdc), address(cctpV1), 1, feeRecipient, 700);

        // Configure allowlists on routerV2
        routerV2.setAllowedSwapAggregator(address(aggregator), true);
        routerV2.setAllowedDefiProtocol(address(aavePool), true);
        routerV2.setAllowedDefiProtocol(address(comet), true);
        routerV2.setAllowedDefiProtocol(address(vault4626), true);
        routerV2.setAllowedRelayer(relayer, true);

        // Configure allowlists on routerV1
        routerV1.setAllowedSwapAggregator(address(aggregator), true);

        // Deploy real SiphonAgentVault linked to routerV2
        agentVault = new SiphonAgentVault(address(routerV2));
        routerV2.setAllowedAgentVault(address(agentVault), true);

        // Etch MockPermit2 at canonical Permit2 address
        MockPermit2 permit2Impl = new MockPermit2();
        vm.etch(address(routerV2.PERMIT2()), address(permit2Impl).code);
    }

    function _emptyCctp() internal pure returns (SiphonRouter.CctpV2Options memory opts) {}

    function test_EndToEndMultiProtocolSweepSwapsAndIsolatedHoneypotBurn() public {
        // Setup user positions:
        // - 500 USDC in Aave v3
        // - 300 USDC in Compound v3
        // - 200 USDC in ERC-4626 vault
        // - 100 DUST swapped to 500 USDC
        // - 1,000 DEAD tokens + honeypot return-bomb token
        aUsdc.mint(user, 500e6);
        comet.creditUser(user, address(usdc), 300e6);
        vault4626.mintShares(user, 200e6);
        dustToken.mint(user, 100e18);
        deadToken.mint(user, 1000e18);

        vm.startPrank(user);
        aUsdc.approve(address(routerV2), 500e6);
        dustToken.approve(address(routerV2), 100e18);
        deadToken.approve(address(routerV2), 1000e18);

        SiphonRouter.DefiExitStep[] memory exits = new SiphonRouter.DefiExitStep[](3);
        exits[0] = SiphonRouter.DefiExitStep({
            kind: SiphonRouter.DefiKind.AAVE_V3_WITHDRAW,
            protocol: address(aavePool),
            receiptToken: address(aUsdc),
            underlyingAsset: address(usdc),
            amount: 500e6
        });
        exits[1] = SiphonRouter.DefiExitStep({
            kind: SiphonRouter.DefiKind.COMPOUND_V3_WITHDRAW,
            protocol: address(comet),
            receiptToken: address(0),
            underlyingAsset: address(usdc),
            amount: 300e6
        });
        exits[2] = SiphonRouter.DefiExitStep({
            kind: SiphonRouter.DefiKind.ERC4626_REDEEM,
            protocol: address(vault4626),
            receiptToken: address(0),
            underlyingAsset: address(usdc),
            amount: 200e6
        });

        SiphonRouter.SwapStep[] memory swaps = new SiphonRouter.SwapStep[](1);
        swaps[0] = SiphonRouter.SwapStep({
            tokenIn: address(dustToken),
            amountIn: 100e18,
            pullFromUser: true,
            aggregator: address(aggregator),
            swapCalldata: abi.encodeWithSelector(
                MockSwapAggregator.swapExactToUsdc.selector,
                address(dustToken),
                100e18,
                500e6
            )
        });

        SiphonRouter.BurnStep[] memory burns = new SiphonRouter.BurnStep[](2);
        burns[0] = SiphonRouter.BurnStep({ token: address(deadToken), amount: 1000e18 });
        burns[1] = SiphonRouter.BurnStep({ token: address(honeypotToken), amount: 12345 });

        SiphonRouter.SweepParams memory params = SiphonRouter.SweepParams({
            solanaRecipient: SOLANA_ATA,
            minNetUsdcOut: 1490e6,
            maxFeeUsdcCap: 0,
            deadline: block.timestamp + 600,
            cctp: _emptyCctp(),
            defiExits: exits,
            swaps: swaps,
            burns: burns
        });

        (uint256 bridgedUsdc, ) = routerV2.sweepAndBridgeToSolana(params);
        vm.stopPrank();

        // Total gross = 500 + 300 + 200 + 500 = 1500 USDC; 25 bps fee = 3.75 USDC
        assertEq(usdc.balanceOf(feeRecipient), 3_750_000);
        assertEq(bridgedUsdc, 1_496_250_000);
        assertEq(cctpV2.lastAmount(), 1_496_250_000);
        assertEq(cctpV2.lastMintRecipient(), SOLANA_ATA);
        assertEq(cctpV2.lastMinFinalityThreshold(), 2000);
        assertFalse(cctpV2.lastUsedHook());

        // Dead token burned cleanly; honeypot skipped without reverting sweep
        assertEq(deadToken.balanceOf(routerV2.DEAD_ADDRESS()), 1000e18);
        assertEq(usdc.balanceOf(address(routerV2)), 0, "Zero residual USDC");
        assertEq(dustToken.balanceOf(address(routerV2)), 0, "Zero residual dust");
    }

    function test_ZeroBpsFeeAndWhaleMaxFeeUsdcCap() public {
        // 1. 0 bps preservation tier (MIN_FEE_BPS == 0)
        assertEq(routerV2.MIN_FEE_BPS(), 0);
        routerV2.setFeeParams(feeRecipient, 0);

        usdc.mint(user, 10_000e6);
        vm.startPrank(user);
        usdc.approve(address(routerV2), 10_000e6);

        SiphonRouter.SwapStep[] memory directSwap = new SiphonRouter.SwapStep[](1);
        directSwap[0] = SiphonRouter.SwapStep({
            tokenIn: address(usdc),
            amountIn: 10_000e6,
            pullFromUser: true,
            aggregator: address(0),
            swapCalldata: ""
        });

        SiphonRouter.SweepParams memory zeroFeeParams = SiphonRouter.SweepParams({
            solanaRecipient: SOLANA_ATA,
            minNetUsdcOut: 10_000e6,
            maxFeeUsdcCap: 0,
            deadline: block.timestamp + 600,
            cctp: _emptyCctp(),
            defiExits: new SiphonRouter.DefiExitStep[](0),
            swaps: directSwap,
            burns: new SiphonRouter.BurnStep[](0)
        });
        (uint256 bridged0, ) = routerV2.sweepAndBridgeToSolana(zeroFeeParams);
        vm.stopPrank();

        assertEq(bridged0, 10_000e6, "0 bps must bridge 100%");
        assertEq(usdc.balanceOf(feeRecipient), 0);

        // 2. Whale $25 hard cap on $100,000 sweep at 25 bps (uncapped would be $250)
        routerV2.setFeeParams(feeRecipient, 25);
        routerV2.setMaxFeeUsdcCap(25e6);

        usdc.mint(user, 100_000e6);
        vm.startPrank(user);
        usdc.approve(address(routerV2), 100_000e6);

        directSwap[0].amountIn = 100_000e6;
        SiphonRouter.SweepParams memory whaleParams = SiphonRouter.SweepParams({
            solanaRecipient: SOLANA_ATA,
            minNetUsdcOut: 99_975e6,
            maxFeeUsdcCap: 25e6, // User-side ceiling agrees with $25 cap
            deadline: block.timestamp + 600,
            cctp: _emptyCctp(),
            defiExits: new SiphonRouter.DefiExitStep[](0),
            swaps: directSwap,
            burns: new SiphonRouter.BurnStep[](0)
        });
        (uint256 bridgedWhale, ) = routerV2.sweepAndBridgeToSolana(whaleParams);
        vm.stopPrank();

        assertEq(usdc.balanceOf(feeRecipient), 25e6, "Whale fee must be capped at $25");
        assertEq(bridgedWhale, 99_975e6);

        // 3. User-side maxFeeUsdcCap reverts if actual protocol fee exceeds user ceiling
        usdc.mint(user, 100_000e6);
        vm.startPrank(user);
        usdc.approve(address(routerV2), 100_000e6);
        whaleParams.maxFeeUsdcCap = 10e6; // User refuses to pay >$10 when protocol charges $25
        vm.expectRevert(abi.encodeWithSelector(SiphonRouter.FeeCapExceeded.selector, 25e6, 10e6));
        routerV2.sweepAndBridgeToSolana(whaleParams);
        vm.stopPrank();
    }

    function test_CctpV1VsV2FastTransferAndHooks() public {
        // 1. CCTP V1 returns incrementing nonce and rejects hookData
        usdc.mint(user, 1_000e6);
        vm.startPrank(user);
        usdc.approve(address(routerV1), 1_000e6);

        SiphonRouter.SwapStep[] memory swaps = new SiphonRouter.SwapStep[](1);
        swaps[0] = SiphonRouter.SwapStep({
            tokenIn: address(usdc),
            amountIn: 500e6,
            pullFromUser: true,
            aggregator: address(0),
            swapCalldata: ""
        });

        SiphonRouter.SweepParams memory v1Params = SiphonRouter.SweepParams({
            solanaRecipient: SOLANA_ATA,
            minNetUsdcOut: 400e6,
            maxFeeUsdcCap: 0,
            deadline: block.timestamp + 600,
            cctp: _emptyCctp(),
            defiExits: new SiphonRouter.DefiExitStep[](0),
            swaps: swaps,
            burns: new SiphonRouter.BurnStep[](0)
        });
        (uint256 bridgedV1, uint64 nonceV1) = routerV1.sweepAndBridgeToSolana(v1Params);
        assertEq(nonceV1, 1);
        assertEq(bridgedV1, 465e6); // 700 bps fee on 500 USDC = 35 USDC
        assertEq(cctpV1.lastAmount(), 465e6);

        // V1 rejects hookData
        v1Params.cctp.hookData = hex"deadbeef";
        vm.expectRevert(SiphonRouter.CctpV2Required.selector);
        routerV1.sweepAndBridgeToSolana(v1Params);
        vm.stopPrank();

        // 2. CCTP V2 Fast Transfer (minFinalityThreshold = 1000, maxFee = 1e6)
        usdc.mint(user, 2_000e6);
        vm.startPrank(user);
        usdc.approve(address(routerV2), 2_000e6);

        swaps[0].amountIn = 1_000e6;
        SiphonRouter.SweepParams memory fastParams = SiphonRouter.SweepParams({
            solanaRecipient: SOLANA_ATA,
            minNetUsdcOut: 990e6,
            maxFeeUsdcCap: 0,
            deadline: block.timestamp + 600,
            cctp: SiphonRouter.CctpV2Options({
                destinationCaller: bytes32(uint256(0xCAFE)),
                maxFee: 1e6,
                minFinalityThreshold: 1000,
                hookData: ""
            }),
            defiExits: new SiphonRouter.DefiExitStep[](0),
            swaps: swaps,
            burns: new SiphonRouter.BurnStep[](0)
        });
        routerV2.sweepAndBridgeToSolana(fastParams);
        assertEq(cctpV2.lastMinFinalityThreshold(), 1000);
        assertEq(cctpV2.lastMaxFee(), 1e6);
        assertEq(cctpV2.lastDestinationCaller(), bytes32(uint256(0xCAFE)));
        assertFalse(cctpV2.lastUsedHook());

        // 3. CCTP V2 depositForBurnWithHook (Circle Forwarding Service / Solana hookData)
        bytes memory forwardHook = abi.encodePacked("cctp-forward:v1", SOLANA_ATA);
        fastParams.cctp.hookData = forwardHook;
        routerV2.sweepAndBridgeToSolana(fastParams);
        assertTrue(cctpV2.lastUsedHook());
        assertEq(cctpV2.lastHookData(), forwardHook, "Hook data mismatch");

        // 4. Excessive CCTP maxFee (> 5% of bridged amount) reverts cleanly
        usdc.mint(user, 1_000e6);
        usdc.approve(address(routerV2), 1_000e6);
        fastParams.cctp.maxFee = 100e6; // > 5% of 997.5e6
        vm.expectRevert();
        routerV2.sweepAndBridgeToSolana(fastParams);
        vm.stopPrank();
    }

    function test_SweepWithMandateEnforcesSiphonAgentVaultPolicy() public {
        // Owner grants mandate to `agent`:
        // - lockedSolanaRecipient = SOLANA_ATA
        // - maxPerTxUsd6 = 500e6 ($500)
        // - dailyCapUsd6 = 800e6 ($800 / 24h)
        // - maxFeeBps = 50 (0.50%)
        // - minNetOutBps = 9800 (98% net preservation floor)
        // - allowedActionsMask = ACTION_DUST_CONVERT | ACTION_BRIDGE_SOLANA
        uint8 actionDust = agentVault.ACTION_DUST_CONVERT();
        uint8 actionBridge = agentVault.ACTION_BRIDGE_SOLANA();
        uint8 actionDefi = routerV2.ACTION_DEFI_WITHDRAW();
        vm.prank(user);
        bytes32 mandateId = agentVault.grantMandate(
            agent,
            SOLANA_ATA,
            500e6,
            800e6,
            7 days,
            50,
            9800,
            actionDust | actionBridge
        );

        // User approves routerV2 for USDC
        usdc.mint(user, 3_000e6);
        vm.prank(user);
        usdc.approve(address(routerV2), 3_000e6);

        SiphonRouter.SwapStep[] memory swaps = new SiphonRouter.SwapStep[](1);
        swaps[0] = SiphonRouter.SwapStep({
            tokenIn: address(usdc),
            amountIn: 450e6,
            pullFromUser: true,
            aggregator: address(0),
            swapCalldata: ""
        });

        uint256 startTs = block.timestamp;
        SiphonRouter.SweepParams memory params = SiphonRouter.SweepParams({
            solanaRecipient: SOLANA_ATA,
            minNetUsdcOut: 440e6,
            maxFeeUsdcCap: 0,
            deadline: startTs + 3600,
            cctp: _emptyCctp(),
            defiExits: new SiphonRouter.DefiExitStep[](0),
            swaps: swaps,
            burns: new SiphonRouter.BurnStep[](0)
        });

        // 1. Happy path: agent executes $450 sweep (under $500 per-tx & $800 daily cap)
        vm.prank(agent);
        (uint256 bridged1, ) = routerV2.sweepWithMandate(
            address(agentVault),
            mandateId,
            actionBridge,
            params
        );
        assertEq(bridged1, 448_875_000); // 450 - 0.25% (1.125 USDC)
        assertEq(cctpV2.lastMintRecipient(), SOLANA_ATA);

        // 2. Wrong Solana recipient -> REVERTS with RecipientMismatch!
        params.solanaRecipient = WRONG_SOLANA_ATA;
        vm.prank(agent);
        vm.expectRevert(SiphonAgentVault.RecipientMismatch.selector);
        routerV2.sweepWithMandate(
            address(agentVault),
            mandateId,
            actionBridge,
            params
        );
        params.solanaRecipient = SOLANA_ATA;

        // 3. Second $450 sweep same day -> 450 + 450 = 900 > 800 dailyCap -> REVERTS with ExceedsDailyCap!
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SiphonAgentVault.ExceedsDailyCap.selector, 900e6, 800e6));
        routerV2.sweepWithMandate(
            address(agentVault),
            mandateId,
            actionBridge,
            params
        );

        // 4. Excessive fee (raise router feeBps to 100 > mandate maxFeeBps 50) -> REVERTS with FeeAboveCap!
        routerV2.setFeeParams(feeRecipient, 100);
        swaps[0].amountIn = 200e6;
        params.minNetUsdcOut = 190e6;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SiphonAgentVault.FeeAboveCap.selector, 100, 50));
        routerV2.sweepWithMandate(
            address(agentVault),
            mandateId,
            actionBridge,
            params
        );
        routerV2.setFeeParams(feeRecipient, 25);

        // 5. Sneaking unauthorized DeFi exit when ACTION_DEFI_WITHDRAW was NOT granted -> REVERTS!
        SiphonRouter.DefiExitStep[] memory sneakyExit = new SiphonRouter.DefiExitStep[](1);
        sneakyExit[0] = SiphonRouter.DefiExitStep({
            kind: SiphonRouter.DefiKind.COMPOUND_V3_WITHDRAW,
            protocol: address(comet),
            receiptToken: address(0),
            underlyingAsset: address(usdc),
            amount: 100e6
        });
        params.defiExits = sneakyExit;
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(SiphonRouter.MandateActionNotPermitted.selector, actionDefi));
        routerV2.sweepWithMandate(
            address(agentVault),
            mandateId,
            actionBridge,
            params
        );
        params.defiExits = new SiphonRouter.DefiExitStep[](0);

        // 6. Warp +24 hours -> daily cap resets cleanly and $450 sweep succeeds!
        vm.warp(startTs + 1 days);
        swaps[0].amountIn = 450e6;
        params.deadline = startTs + 1 days + 3600;
        params.minNetUsdcOut = 440e6;
        vm.prank(agent);
        (uint256 bridged2, ) = routerV2.sweepWithMandate(
            address(agentVault),
            mandateId,
            actionBridge,
            params
        );
        assertEq(bridged2, 448_875_000);

        // 7. Revoke mandate -> immediately reverts with MandateInactiveOrExpired!
        vm.prank(user);
        agentVault.revokeMandate(mandateId);

        swaps[0].amountIn = 100e6;
        params.minNetUsdcOut = 90e6;
        vm.prank(agent);
        vm.expectRevert(SiphonAgentVault.MandateInactiveOrExpired.selector);
        routerV2.sweepWithMandate(
            address(agentVault),
            mandateId,
            actionBridge,
            params
        );
    }

    function test_Permit2BatchSweepAndRefundsUnswappedTokens() public {
        routerV2.setFeeParams(feeRecipient, 500); // 5% so relayer break-even passes on $1 gas

        dustToken.mint(user, 100e18);
        address permit2Addr = address(routerV2.PERMIT2());
        vm.prank(user);
        dustToken.approve(permit2Addr, 100e18);

        IPermit2.TokenPermissions[] memory permitted = new IPermit2.TokenPermissions[](1);
        permitted[0] = IPermit2.TokenPermissions({ token: address(dustToken), amount: 100e18 });
        IPermit2.PermitBatchTransferFrom memory permit = IPermit2.PermitBatchTransferFrom({
            permitted: permitted,
            nonce: 42,
            deadline: block.timestamp + 600
        });

        // Swap only 60 of 100 permitted DUST tokens -> 40 DUST MUST be refunded to user!
        SiphonRouter.SwapStep[] memory swaps = new SiphonRouter.SwapStep[](1);
        swaps[0] = SiphonRouter.SwapStep({
            tokenIn: address(dustToken),
            amountIn: 100e18,
            pullFromUser: false,
            aggregator: address(aggregator),
            swapCalldata: abi.encodeWithSelector(
                MockSwapAggregator.swapPartialToUsdc.selector,
                address(dustToken),
                60e18,
                100e6
            )
        });

        SiphonRouter.SiphonSweepWitness memory witness = SiphonRouter.SiphonSweepWitness({
            solanaRecipient: SOLANA_ATA,
            minNetUsdcOut: 90e6,
            maxGasReimbursementUsdc: 2e6,
            feeBps: 500,
            feeRecipient: feeRecipient,
            swapsHash: keccak256(abi.encode(swaps))
        });

        bytes memory dummySig = new bytes(65);
        vm.prank(relayer);
        (uint256 bridged, ) = routerV2.sweepWithPermit2Batch(user, permit, witness, dummySig, 1e6, swaps);

        // 100 gross - 5 fee - 1 gas = 94 bridged; 40 unswapped DUST refunded to user
        assertEq(bridged, 94e6);
        assertEq(usdc.balanceOf(feeRecipient), 5e6);
        assertEq(usdc.balanceOf(relayer), 1e6);
        assertEq(dustToken.balanceOf(user), 40e18, "Unswapped DUST must be refunded");
        assertEq(dustToken.balanceOf(address(routerV2)), 0, "Zero DUST stranded");
        assertEq(usdc.balanceOf(address(routerV2)), 0, "Zero USDC stranded");

        // Tampering with swapsHash reverts
        witness.swapsHash = keccak256("tampered");
        vm.prank(relayer);
        vm.expectRevert(SiphonRouter.InvalidSwapsHash.selector);
        routerV2.sweepWithPermit2Batch(user, permit, witness, dummySig, 1e6, swaps);
    }

    function test_DisjointAllowlistsAndFakeATokenRejected() public {
        // Cannot add existing aggregator as DeFi protocol
        vm.expectRevert(abi.encodeWithSelector(SiphonRouter.DisjointAllowlistViolation.selector, address(aggregator)));
        routerV2.setAllowedDefiProtocol(address(aggregator), true);

        // Fake aToken rejected by Pool.getReserveData validation
        SiphonRouter.DefiExitStep[] memory badAave = new SiphonRouter.DefiExitStep[](1);
        badAave[0] = SiphonRouter.DefiExitStep({
            kind: SiphonRouter.DefiKind.AAVE_V3_WITHDRAW,
            protocol: address(aavePool),
            receiptToken: address(dustToken), // WRONG receipt token!
            underlyingAsset: address(usdc),
            amount: 100e6
        });

        SiphonRouter.SweepParams memory params = SiphonRouter.SweepParams({
            solanaRecipient: SOLANA_ATA,
            minNetUsdcOut: 1,
            maxFeeUsdcCap: 0,
            deadline: block.timestamp + 600,
            cctp: _emptyCctp(),
            defiExits: badAave,
            swaps: new SiphonRouter.SwapStep[](0),
            burns: new SiphonRouter.BurnStep[](0)
        });

        vm.prank(user);
        vm.expectRevert(SiphonRouter.InvalidAddress.selector);
        routerV2.sweepAndBridgeToSolana(params);
    }

    function testFuzz_FeeBoundsAndZeroResidualStranding(
        uint96 rawAmount,
        uint16 rawFeeBps,
        uint96 rawFeeCap
    ) public {
        uint256 gross = bound(uint256(rawAmount), 100, 5_000_000e6);
        uint16 bps = uint16(bound(uint256(rawFeeBps), 0, routerV2.MAX_FEE_BPS()));
        uint256 cap = bound(uint256(rawFeeCap), 0, 100_000e6);

        routerV2.setFeeParams(feeRecipient, bps);
        routerV2.setMaxFeeUsdcCap(cap);

        uint256 feeRecipientBefore = usdc.balanceOf(feeRecipient);
        usdc.mint(user, gross);

        vm.startPrank(user);
        usdc.approve(address(routerV2), gross);

        SiphonRouter.SwapStep[] memory swaps = new SiphonRouter.SwapStep[](1);
        swaps[0] = SiphonRouter.SwapStep({
            tokenIn: address(usdc),
            amountIn: gross,
            pullFromUser: true,
            aggregator: address(0),
            swapCalldata: ""
        });

        SiphonRouter.SweepParams memory params = SiphonRouter.SweepParams({
            solanaRecipient: SOLANA_ATA,
            minNetUsdcOut: 1,
            maxFeeUsdcCap: 0,
            deadline: block.timestamp + 600,
            cctp: _emptyCctp(),
            defiExits: new SiphonRouter.DefiExitStep[](0),
            swaps: swaps,
            burns: new SiphonRouter.BurnStep[](0)
        });

        (uint256 bridged, ) = routerV2.sweepAndBridgeToSolana(params);
        vm.stopPrank();

        uint256 chargedFee = usdc.balanceOf(feeRecipient) - feeRecipientBefore;
        uint256 maxBpsFee = (gross * bps) / 10_000;

        assertEq(chargedFee + bridged, gross, "Conservation violated");
        assertLe(chargedFee, maxBpsFee, "Charged fee exceeded feeBps");
        if (cap > 0) {
            assertLe(chargedFee, cap, "Charged fee exceeded maxFeeUsdcCap");
        }
        assertEq(usdc.balanceOf(address(routerV2)), 0, "Router must strand zero USDC");
    }
}
