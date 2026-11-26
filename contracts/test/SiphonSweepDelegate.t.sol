// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import {
    MockERC20,
    MockHoneypotReturnBombToken,
    MockTokenMessengerV2,
    MockSwapAggregator,
    MockCompoundV3Comet,
    MockERC4626Vault
} from "./Mocks.sol";
import { SiphonDelegateRegistry } from "../SiphonDelegateRegistry.sol";
import { SiphonSweepDelegate } from "../SiphonSweepDelegate.sol";
import { SiphonAgentVault } from "../SiphonAgentVault.sol";

contract SiphonSweepDelegateTest is TestBase {
    MockERC20 internal usdc;
    MockERC20 internal dustToken;
    MockERC20 internal deadToken;
    MockHoneypotReturnBombToken internal honeypot;
    MockTokenMessengerV2 internal cctpV2;
    MockSwapAggregator internal swapRouter;
    MockCompoundV3Comet internal comet;
    MockERC4626Vault internal vault4626;

    SiphonDelegateRegistry internal registry;
    SiphonSweepDelegate internal delegateImpl;
    SiphonAgentVault internal agentVault;

    uint256 internal constant EOA_PK = 0xA11CE01;
    uint256 internal constant AGENT_PK = 0xA6E702;
    uint256 internal constant ATTACKER_PK = 0xBAD03;

    address internal eoa;
    address internal agent;
    address internal attacker;
    address internal feeRecipient = address(0xFEE2);
    address internal relayer = address(0xBEEF2);
    address internal oldSpender = address(0x59E4);

    bytes32 internal constant SOLANA_ATA =
        0x223344556677889900aabbccddeeff0011223344556677889900aabbccddeeff;
    bytes32 internal constant WRONG_SOLANA_ATA =
        0x99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa;

    function setUp() public {
        vm.warp(1_750_000_000);
        eoa = vm.addr(EOA_PK);
        agent = vm.addr(AGENT_PK);
        attacker = vm.addr(ATTACKER_PK);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        dustToken = new MockERC20("Dust", "DUST", 18);
        deadToken = new MockERC20("Dead", "DEAD", 18);
        honeypot = new MockHoneypotReturnBombToken();

        cctpV2 = new MockTokenMessengerV2();
        swapRouter = new MockSwapAggregator(address(usdc));
        comet = new MockCompoundV3Comet(address(usdc));
        vault4626 = new MockERC4626Vault(address(usdc));
        usdc.mint(address(swapRouter), 10_000_000e6);

        registry = new SiphonDelegateRegistry(address(this));
        registry.setAllowedFeeRecipient(feeRecipient, true);
        registry.setAllowedRelayer(relayer, true);
        registry.setAllowedSwapRouter(address(swapRouter), true);
        registry.setAllowedDefiProtocol(address(comet), true);
        registry.setAllowedDefiProtocol(address(vault4626), true);

        // Deploy EIP-7702 delegate implementation pinning immutable usdc, cctpMessenger, & mandatory policyRegistry
        delegateImpl = new SiphonSweepDelegate(
            address(usdc),
            address(cctpV2),
            feeRecipient,
            2,
            address(registry),
            25e6
        );
        vm.etch(eoa, address(delegateImpl).code);

        // Deploy real SiphonAgentVault with delegateImpl as default router (NEVER putting EOAs in authorizedRouters!)
        agentVault = new SiphonAgentVault(address(delegateImpl));
        registry.setAllowedAgentVault(address(agentVault), true);
    }

    function _delegated() internal view returns (SiphonSweepDelegate) {
        return SiphonSweepDelegate(payable(eoa));
    }

    function _baseIntent(uint256 nonce, uint16 feeBps, uint256 directUsdc)
        internal
        view
        returns (SiphonSweepDelegate.SweepIntent memory intent)
    {
        intent = SiphonSweepDelegate.SweepIntent({
            solanaRecipient: SOLANA_ATA,
            usdc: address(usdc),
            cctpMessenger: address(cctpV2),
            feeRecipient: feeRecipient,
            feeBps: feeBps,
            directUsdcAmount: directUsdc,
            minNetUsdcOut: 1,
            maxGasReimbursementUsdc: 5e6,
            nonce: nonce,
            deadline: block.timestamp + 600,
            defiExits: new SiphonSweepDelegate.DefiExit[](0),
            swaps: new SiphonSweepDelegate.TokenSwap[](0),
            burns: new SiphonSweepDelegate.DeadBurn[](0),
            revokes: new SiphonSweepDelegate.ApprovalRevoke[](0)
        });
    }

    function test_V1SponsoredSweepSignatureRevokesNativeSwapAndReplayProtection() public {
        // Fund EOA with 100 USDC, 1 ETH, lingering approval to oldSpender, and dead + honeypot tokens
        usdc.mint(eoa, 100e6);
        vm.deal(eoa, 2 ether);
        dustToken.mint(eoa, 50e18);
        deadToken.mint(eoa, 500e18);

        vm.prank(eoa);
        dustToken.approve(oldSpender, type(uint256).max);
        assertEq(dustToken.allowance(eoa, oldSpender), type(uint256).max);

        SiphonSweepDelegate.SweepIntent memory intent = _baseIntent(1, 500, 100e6);
        intent.minNetUsdcOut = 200e6;

        intent.revokes = new SiphonSweepDelegate.ApprovalRevoke[](1);
        intent.revokes[0] = SiphonSweepDelegate.ApprovalRevoke({
            token: address(dustToken),
            spender: oldSpender
        });

        // Native ETH swap: 1 ETH -> 200 USDC
        intent.swaps = new SiphonSweepDelegate.TokenSwap[](1);
        intent.swaps[0] = SiphonSweepDelegate.TokenSwap({
            tokenIn: address(0),
            amountIn: 0,
            ethValue: 1 ether,
            router: address(swapRouter),
            callData: abi.encodeWithSelector(MockSwapAggregator.swapEthToUsdc.selector, 200e6)
        });

        intent.burns = new SiphonSweepDelegate.DeadBurn[](2);
        intent.burns[0] = SiphonSweepDelegate.DeadBurn({ token: address(deadToken), amount: 500e18 });
        intent.burns[1] = SiphonSweepDelegate.DeadBurn({ token: address(honeypot), amount: 1 });

        bytes32 digest = _delegated().hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, digest);

        // Unauthorized relayer rejected when gasReimbursement > 0
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SiphonSweepDelegate.UnauthorizedRelayer.selector, attacker));
        _delegated().executeSponsoredSweep(intent, 1e6, v, r, s);

        // Authorized relayer succeeds
        vm.prank(relayer);
        (uint256 netBridged, ) = _delegated().executeSponsoredSweep(intent, 1e6, v, r, s);

        // Gross = 100 direct + 200 ETH swap = 300 USDC; 5% fee = 15 USDC; 1 USDC gas -> 284 bridged
        assertEq(netBridged, 284e6);
        assertEq(usdc.balanceOf(feeRecipient), 15e6);
        assertEq(usdc.balanceOf(relayer), 1e6);
        assertEq(cctpV2.lastAmount(), 284e6);
        assertEq(dustToken.allowance(eoa, oldSpender), 0, "Lingering approval MUST be revoked");
        assertEq(deadToken.balanceOf(delegateImpl.DEAD_ADDRESS()), 500e18);
        assertTrue(_delegated().isNonceUsed(1));

        // Replay same nonce -> reverts with NonceAlreadyUsed
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SiphonSweepDelegate.NonceAlreadyUsed.selector, 1));
        _delegated().executeSponsoredSweep(intent, 1e6, v, r, s);
    }

    function test_DeadlineExpiryCancelNonceAndRegistryKillSwitch() public {
        usdc.mint(eoa, 200e6);

        // 1. Expired intent reverts
        SiphonSweepDelegate.SweepIntent memory expiredIntent = _baseIntent(10, 0, 100e6);
        expiredIntent.deadline = block.timestamp - 1;
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(EOA_PK, _delegated().hashIntent(expiredIntent));
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.ExpiredIntent.selector);
        _delegated().executeSponsoredSweep(expiredIntent, 0, v1, r1, s1);

        // 2. Owner cancels nonce before execution
        SiphonSweepDelegate.SweepIntent memory cancelledIntent = _baseIntent(11, 0, 100e6);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(EOA_PK, _delegated().hashIntent(cancelledIntent));
        vm.prank(eoa);
        _delegated().cancelNonce(11);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SiphonSweepDelegate.NonceAlreadyUsed.selector, 11));
        _delegated().executeSponsoredSweep(cancelledIntent, 0, v2, r2, s2);

        // 3. Registry kill-switch blocks execution immediately
        SiphonSweepDelegate.SweepIntent memory liveIntent = _baseIntent(12, 0, 100e6);
        liveIntent.swaps = new SiphonSweepDelegate.TokenSwap[](1);
        liveIntent.swaps[0] = SiphonSweepDelegate.TokenSwap({
            tokenIn: address(dustToken),
            amountIn: 1e18,
            ethValue: 0,
            router: address(swapRouter),
            callData: abi.encodeWithSelector(MockSwapAggregator.swapExactToUsdc.selector, address(dustToken), 1e18, 10e6)
        });
        dustToken.mint(eoa, 1e18);
        (uint8 v3, bytes32 r3, bytes32 s3) = vm.sign(EOA_PK, _delegated().hashIntent(liveIntent));

        registry.pause();
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.ProtocolPaused.selector);
        _delegated().executeSponsoredSweep(liveIntent, 0, v3, r3, s3);

        // Unpause restores sweep cleanly (0 bps fee!)
        registry.unpause();
        vm.prank(relayer);
        (uint256 netBridged, ) = _delegated().executeSponsoredSweep(liveIntent, 0, v3, r3, s3);
        assertEq(netBridged, 110e6);
        assertEq(usdc.balanceOf(feeRecipient), 0, "0 bps fee tier");
    }

    function test_V2CctpFastTransferHooksAndWhaleCap() public {
        // $100,000 sweep at 25 bps -> delegate has immutable $25 cap!
        usdc.mint(eoa, 100_000e6);
        SiphonSweepDelegate.SweepIntent memory intent = _baseIntent(20, 25, 100_000e6);
        // After $25 whale cap and $50 CCTP fast transfer maxFee, minSolanaReceived = 99,925 USDC
        intent.minNetUsdcOut = 99_925e6;

        bytes memory hook = abi.encodePacked("jupiter-lend:jlUSDC", SOLANA_ATA);
        SiphonSweepDelegate.CctpV2Options memory cctpOpts = SiphonSweepDelegate.CctpV2Options({
            destinationCaller: bytes32(uint256(0x1234)),
            maxFee: 50e6, // 0.05% fast fee (< 5% ceiling)
            minFinalityThreshold: 1000,
            hookData: hook
        });

        bytes32 digest = _delegated().hashIntentV2(intent, 25e6, cctpOpts);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, digest);

        vm.prank(relayer);
        (uint256 netBridged, ) = _delegated().executeSponsoredSweepV2(intent, 25e6, cctpOpts, 0, v, r, s);

        assertEq(usdc.balanceOf(feeRecipient), 25e6, "Delegate whale cap enforced at $25");
        assertEq(netBridged, 99_975e6);
        assertTrue(cctpV2.lastUsedHook());
        assertEq(cctpV2.lastMinFinalityThreshold(), 1000);
        assertEq(cctpV2.lastMaxFee(), 50e6);
        assertEq(cctpV2.lastHookData(), hook, "Forwarding hook data preserved");

        // User signed maxFeeUsdcCap stricter than actual fee -> reverts FeeCapExceeded
        usdc.mint(eoa, 100_000e6);
        intent.nonce = 21;
        bytes32 digestStrict = _delegated().hashIntentV2(intent, 10e6, cctpOpts);
        (uint8 vs, bytes32 rs, bytes32 ss) = vm.sign(EOA_PK, digestStrict);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SiphonSweepDelegate.FeeCapExceeded.selector, 25e6, 10e6));
        _delegated().executeSponsoredSweepV2(intent, 10e6, cctpOpts, 0, vs, rs, ss);
    }

    function test_ExecuteSponsoredSweepWithMandateAgentSigned() public {
        // Delegated EOA grants EIP-7702 self-delegated mandate to `agent` (eoa is NOT in authorizedRouters!)
        uint8 actionBridge = agentVault.ACTION_BRIDGE_SOLANA();
        vm.prank(eoa);
        bytes32 mandateId = agentVault.grantMandateWithRouter(
            agent,
            eoa,
            SOLANA_ATA,
            600e6, // $600 per tx
            900e6, // $900 rolling 24h cap
            7 days,
            50,    // max 0.50% total fee
            9800,  // min 98% net preservation
            actionBridge
        );
        assertFalse(agentVault.authorizedRouters(eoa), "EOA must never be added to global authorizedRouters");

        usdc.mint(eoa, 2_000e6);

        // Autonomous `agent` signs distinct MandateSweepIntent (zero EOA popup!)
        SiphonSweepDelegate.SweepIntent memory intent = _baseIntent(100, 25, 500e6);
        intent.minNetUsdcOut = 490e6;
        SiphonSweepDelegate.CctpV2Options memory fastOpts = SiphonSweepDelegate.CctpV2Options({
            destinationCaller: bytes32(0),
            maxFee: 500_000, // $0.50 (10 bps -> total 35 bps <= 50 bps)
            minFinalityThreshold: 1000,
            hookData: ""
        });

        bytes32 digest = _delegated().hashMandateIntent(
            intent,
            5e6,
            fastOpts,
            address(agentVault),
            mandateId,
            actionBridge
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_PK, digest);

        // Relayer submits agent-signed intent -> SiphonAgentVault enforces policy on-chain!
        vm.prank(relayer);
        (uint256 bridged1, ) = _delegated().executeSponsoredSweepWithMandate(
            intent,
            5e6,
            fastOpts,
            address(agentVault),
            mandateId,
            actionBridge,
            0,
            v,
            r,
            s
        );
        assertEq(bridged1, 498_750_000);
        assertEq(cctpV2.lastMinFinalityThreshold(), 1000);

        // Agent tries redirecting funds to WRONG_SOLANA_ATA -> REVERTS with RecipientMismatch!
        intent.nonce = 101;
        intent.solanaRecipient = WRONG_SOLANA_ATA;
        (v, r, s) = vm.sign(
            AGENT_PK,
            _delegated().hashMandateIntent(intent, 5e6, fastOpts, address(agentVault), mandateId, actionBridge)
        );
        vm.prank(relayer);
        vm.expectRevert(SiphonAgentVault.RecipientMismatch.selector);
        _delegated().executeSponsoredSweepWithMandate(
            intent,
            5e6,
            fastOpts,
            address(agentVault),
            mandateId,
            actionBridge,
            0,
            v,
            r,
            s
        );

        // Agent tries second $500 sweep same day (500 + 500 = 1000 > 900 dailyCap) -> REVERTS ExceedsDailyCap!
        intent.nonce = 102;
        intent.solanaRecipient = SOLANA_ATA;
        (v, r, s) = vm.sign(
            AGENT_PK,
            _delegated().hashMandateIntent(intent, 5e6, fastOpts, address(agentVault), mandateId, actionBridge)
        );
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SiphonAgentVault.ExceedsDailyCap.selector, 1000e6, 900e6));
        _delegated().executeSponsoredSweepWithMandate(
            intent,
            5e6,
            fastOpts,
            address(agentVault),
            mandateId,
            actionBridge,
            0,
            v,
            r,
            s
        );

        // Unrelated attacker signature -> REVERTS InvalidSignature!
        intent.nonce = 103;
        intent.directUsdcAmount = 100e6;
        intent.minNetUsdcOut = 95e6;
        (v, r, s) = vm.sign(
            ATTACKER_PK,
            _delegated().hashMandateIntent(intent, 5e6, fastOpts, address(agentVault), mandateId, actionBridge)
        );
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.InvalidSignature.selector);
        _delegated().executeSponsoredSweepWithMandate(
            intent,
            5e6,
            fastOpts,
            address(agentVault),
            mandateId,
            actionBridge,
            0,
            v,
            r,
            s
        );
    }

    // =========================================================================
    // Wave 8A Adversarial Regression Proofs (C-1..C-4, H-1..H-4, M-1..M-3)
    // =========================================================================

    function test_RevertRogueAgentFakeUsdcOrMessenger() public {
        MockERC20 fakeUsdc = new MockERC20("Fake USDC", "fUSDC", 6);
        MockTokenMessengerV2 fakeMessenger = new MockTokenMessengerV2();
        usdc.mint(eoa, 500e6);
        fakeUsdc.mint(eoa, 500e6);

        // 1. Forged `intent.usdc` != pinned immutable `usdc` -> REVERTS InvalidAddress!
        SiphonSweepDelegate.SweepIntent memory fakeUsdcIntent = _baseIntent(200, 25, 100e6);
        fakeUsdcIntent.usdc = address(fakeUsdc);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(EOA_PK, _delegated().hashIntent(fakeUsdcIntent));
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.InvalidAddress.selector);
        _delegated().executeSponsoredSweep(fakeUsdcIntent, 0, v1, r1, s1);

        // 2. Forged `intent.cctpMessenger` != pinned immutable `cctpMessenger` -> REVERTS InvalidAddress!
        SiphonSweepDelegate.SweepIntent memory fakeMsgIntent = _baseIntent(201, 25, 100e6);
        fakeMsgIntent.cctpMessenger = address(fakeMessenger);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(EOA_PK, _delegated().hashIntent(fakeMsgIntent));
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.InvalidAddress.selector);
        _delegated().executeSponsoredSweep(fakeMsgIntent, 0, v2, r2, s2);
    }

    function test_RevertZeroPolicyRegistryInConstructor() public {
        // Zero policyRegistry -> REVERTS InvalidAddress
        vm.expectRevert(SiphonSweepDelegate.InvalidAddress.selector);
        new SiphonSweepDelegate(address(usdc), address(cctpV2), feeRecipient, 2, address(0), 25e6);

        // EOA policyRegistry (code.length == 0) -> REVERTS InvalidAddress
        vm.expectRevert(SiphonSweepDelegate.InvalidAddress.selector);
        new SiphonSweepDelegate(address(usdc), address(cctpV2), feeRecipient, 2, address(0x123456), 25e6);

        // Zero or EOA usdc / cctpMessenger -> REVERTS InvalidAddress
        vm.expectRevert(SiphonSweepDelegate.InvalidAddress.selector);
        new SiphonSweepDelegate(address(0), address(cctpV2), feeRecipient, 2, address(registry), 25e6);

        vm.expectRevert(SiphonSweepDelegate.InvalidAddress.selector);
        new SiphonSweepDelegate(address(usdc), address(0x987654), feeRecipient, 2, address(registry), 25e6);
    }

    function test_RegistryPauseHaltsDirectUsdcAndZeroGasSweeps() public {
        usdc.mint(eoa, 500e6);
        deadToken.mint(eoa, 100e18);
        vm.prank(eoa);
        dustToken.approve(oldSpender, 100e18);

        // Pure direct USDC + revoke + burn + 0-gas sweep (uses NO swap routers or DeFi protocols)
        SiphonSweepDelegate.SweepIntent memory directIntent = _baseIntent(300, 25, 200e6);
        directIntent.revokes = new SiphonSweepDelegate.ApprovalRevoke[](1);
        directIntent.revokes[0] = SiphonSweepDelegate.ApprovalRevoke({ token: address(dustToken), spender: oldSpender });
        directIntent.burns = new SiphonSweepDelegate.DeadBurn[](1);
        directIntent.burns[0] = SiphonSweepDelegate.DeadBurn({ token: address(deadToken), amount: 100e18 });

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(EOA_PK, _delegated().hashIntent(directIntent));

        registry.pause();
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.ProtocolPaused.selector);
        _delegated().executeSponsoredSweep(directIntent, 0, v, r, s);

        // Verify nothing executed: approval intact, deadToken intact, USDC untouched
        assertEq(dustToken.allowance(eoa, oldSpender), 100e18);
        assertEq(deadToken.balanceOf(eoa), 100e18);
        assertEq(usdc.balanceOf(eoa), 500e6);

        // M-1: After unpause, unauthorized third-party relayer submitting 0-bps fee sweep with 0 gas MUST revert!
        registry.unpause();
        SiphonSweepDelegate.SweepIntent memory zeroFeeIntent = _baseIntent(301, 0, 200e6);
        (uint8 vz, bytes32 rz, bytes32 sz) = vm.sign(EOA_PK, _delegated().hashIntent(zeroFeeIntent));
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SiphonSweepDelegate.UnauthorizedRelayer.selector, attacker));
        _delegated().executeSponsoredSweep(zeroFeeIntent, 0, vz, rz, sz);
    }

    function test_MandateSignatureDistinctFromV2SweepSignature() public {
        uint8 actionBridge = agentVault.ACTION_BRIDGE_SOLANA();
        vm.prank(eoa);
        bytes32 mandateId = agentVault.grantMandateWithRouter(
            agent,
            eoa,
            SOLANA_ATA,
            500e6,
            1_000e6,
            7 days,
            50,
            9800,
            actionBridge
        );
        usdc.mint(eoa, 500e6);

        SiphonSweepDelegate.SweepIntent memory intent = _baseIntent(400, 25, 200e6);
        intent.minNetUsdcOut = 190e6;
        SiphonSweepDelegate.CctpV2Options memory opts = SiphonSweepDelegate.CctpV2Options({
            destinationCaller: bytes32(0),
            maxFee: 0,
            minFinalityThreshold: 2000,
            hookData: ""
        });

        bytes32 v2Digest = _delegated().hashIntentV2(intent, 5e6, opts);
        bytes32 mandateDigest = _delegated().hashMandateIntent(
            intent,
            5e6,
            opts,
            address(agentVault),
            mandateId,
            actionBridge
        );
        assertTrue(v2Digest != mandateDigest, "V2 digest and Mandate digest MUST be domain-separated");

        // Signing V2 digest cannot be replayed into executeSponsoredSweepWithMandate!
        (uint8 vV2, bytes32 rV2, bytes32 sV2) = vm.sign(AGENT_PK, v2Digest);
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.InvalidSignature.selector);
        _delegated().executeSponsoredSweepWithMandate(
            intent,
            5e6,
            opts,
            address(agentVault),
            mandateId,
            actionBridge,
            0,
            vV2,
            rV2,
            sV2
        );

        // Signing Mandate digest cannot be replayed into executeSponsoredSweepV2!
        (uint8 vM, bytes32 rM, bytes32 sM) = vm.sign(EOA_PK, mandateDigest);
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.InvalidSignature.selector);
        _delegated().executeSponsoredSweepV2(intent, 5e6, opts, 0, vM, rM, sM);
    }

    function test_VaultRevokesCompromisedRouterForExistingMandatesAndSupportsEip7702Owner() public {
        address compromisedRouter = address(0xC049);
        vm.etch(compromisedRouter, hex"00");
        agentVault.setAuthorizedRouter(compromisedRouter, true);

        uint8 actionBridge = agentVault.ACTION_BRIDGE_SOLANA();
        vm.prank(eoa);
        bytes32 routerMandateId = agentVault.grantMandateWithRouter(
            agent,
            compromisedRouter,
            SOLANA_ATA,
            500e6,
            1_000e6,
            7 days,
            50,
            9800,
            actionBridge
        );

        // 1. Before revocation, compromisedRouter can authorize action on existing mandate
        vm.prank(compromisedRouter);
        agentVault.authorizeAgentAction(
            routerMandateId,
            agent,
            actionBridge,
            SOLANA_ATA,
            100e6,
            99e6,
            25,
            keccak256("before-revoke")
        );

        // 2. Admin revokes compromisedRouter globally -> existing mandate immediately blocked!
        agentVault.setAuthorizedRouter(compromisedRouter, false);
        vm.prank(compromisedRouter);
        vm.expectRevert(
            abi.encodeWithSelector(
                SiphonAgentVault.UnauthorizedRouter.selector,
                compromisedRouter,
                compromisedRouter
            )
        );
        agentVault.authorizeAgentAction(
            routerMandateId,
            agent,
            actionBridge,
            SOLANA_ATA,
            100e6,
            99e6,
            25,
            keccak256("after-revoke")
        );

        // 3. Owner cannot bypass non-self router mandate by calling authorizeAgentAction directly as EOA!
        vm.prank(eoa);
        vm.expectRevert(
            abi.encodeWithSelector(SiphonAgentVault.UnauthorizedRouter.selector, eoa, compromisedRouter)
        );
        agentVault.authorizeAgentAction(
            routerMandateId,
            agent,
            actionBridge,
            SOLANA_ATA,
            100e6,
            99e6,
            25,
            keccak256("owner-spoof")
        );

        // 4. EIP-7702 self-delegated mandate (`authorizedRouter == eoa`) works cleanly without putting eoa in authorizedRouters!
        assertFalse(agentVault.authorizedRouters(eoa));
        vm.prank(eoa);
        bytes32 selfMandateId = agentVault.grantMandateWithRouter(
            agent,
            eoa,
            SOLANA_ATA,
            500e6,
            1_000e6,
            7 days,
            50,
            9800,
            actionBridge
        );
        vm.prank(eoa);
        agentVault.authorizeAgentAction(
            selfMandateId,
            agent,
            actionBridge,
            SOLANA_ATA,
            100e6,
            99e6,
            25,
            keccak256("eip7702-self-delegated")
        );
    }

    function test_DelegateBlocksAgentSwapsBurnsUsdcBurnCctpOverrideAndCometBorrow() public {
        uint8 allMask = agentVault.ALL_ACTIONS_MASK();
        uint8 actionBridge = agentVault.ACTION_BRIDGE_SOLANA();
        vm.prank(eoa);
        bytes32 mandateId = agentVault.grantMandateWithRouter(
            agent,
            eoa,
            SOLANA_ATA,
            1_000e6,
            5_000e6,
            7 days,
            100,
            9500,
            allMask
        );

        usdc.mint(eoa, 1_000e6);
        dustToken.mint(eoa, 100e18);
        deadToken.mint(eoa, 100e18);

        SiphonSweepDelegate.CctpV2Options memory cleanOpts = SiphonSweepDelegate.CctpV2Options({
            destinationCaller: bytes32(0),
            maxFee: 0,
            minFinalityThreshold: 2000,
            hookData: ""
        });

        // 1. Agent arbitrary swapCalldata -> REVERTS AgentArbitrarySwapsForbidden
        SiphonSweepDelegate.SweepIntent memory swapIntent = _baseIntent(500, 25, 0);
        swapIntent.swaps = new SiphonSweepDelegate.TokenSwap[](1);
        swapIntent.swaps[0] = SiphonSweepDelegate.TokenSwap({
            tokenIn: address(dustToken),
            amountIn: 10e18,
            ethValue: 0,
            router: address(swapRouter),
            callData: abi.encodeWithSelector(MockSwapAggregator.swapExactToUsdc.selector, address(dustToken), 10e18, 50e6)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            AGENT_PK,
            _delegated().hashMandateIntent(swapIntent, 5e6, cleanOpts, address(agentVault), mandateId, actionBridge)
        );
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.AgentArbitrarySwapsForbidden.selector);
        _delegated().executeSponsoredSweepWithMandate(
            swapIntent,
            5e6,
            cleanOpts,
            address(agentVault),
            mandateId,
            actionBridge,
            0,
            v,
            r,
            s
        );

        // 2. Agent arbitrary burn -> REVERTS AgentBurnsForbidden
        SiphonSweepDelegate.SweepIntent memory burnIntent = _baseIntent(501, 25, 100e6);
        burnIntent.burns = new SiphonSweepDelegate.DeadBurn[](1);
        burnIntent.burns[0] = SiphonSweepDelegate.DeadBurn({ token: address(deadToken), amount: 10e18 });
        (v, r, s) = vm.sign(
            AGENT_PK,
            _delegated().hashMandateIntent(burnIntent, 5e6, cleanOpts, address(agentVault), mandateId, actionBridge)
        );
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.AgentBurnsForbidden.selector);
        _delegated().executeSponsoredSweepWithMandate(
            burnIntent,
            5e6,
            cleanOpts,
            address(agentVault),
            mandateId,
            actionBridge,
            0,
            v,
            r,
            s
        );

        // 3. Agent destinationCaller / hookData override -> REVERTS AgentCctpOverrideForbidden
        SiphonSweepDelegate.SweepIntent memory cleanIntent = _baseIntent(502, 25, 100e6);
        SiphonSweepDelegate.CctpV2Options memory rogueOpts = SiphonSweepDelegate.CctpV2Options({
            destinationCaller: bytes32(uint256(0xBEEF)),
            maxFee: 0,
            minFinalityThreshold: 1000,
            hookData: ""
        });
        (v, r, s) = vm.sign(
            AGENT_PK,
            _delegated().hashMandateIntent(cleanIntent, 5e6, rogueOpts, address(agentVault), mandateId, actionBridge)
        );
        vm.prank(relayer);
        vm.expectRevert(SiphonSweepDelegate.AgentCctpOverrideForbidden.selector);
        _delegated().executeSponsoredSweepWithMandate(
            cleanIntent,
            5e6,
            rogueOpts,
            address(agentVault),
            mandateId,
            actionBridge,
            0,
            v,
            r,
            s
        );

        // 4. Direct owner burning USDC -> REVERTS InvalidBurnToken(usdc)
        SiphonSweepDelegate.SweepIntent memory usdcBurnIntent = _baseIntent(503, 25, 100e6);
        usdcBurnIntent.burns = new SiphonSweepDelegate.DeadBurn[](1);
        usdcBurnIntent.burns[0] = SiphonSweepDelegate.DeadBurn({ token: address(usdc), amount: 50e6 });
        (v, r, s) = vm.sign(EOA_PK, _delegated().hashIntent(usdcBurnIntent));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SiphonSweepDelegate.InvalidBurnToken.selector, address(usdc)));
        _delegated().executeSponsoredSweep(usdcBurnIntent, 0, v, r, s);

        // 5. Compound v3 over-withdrawal caps to supplied balance (no borrow debt!)
        comet.creditUser(eoa, address(usdc), 250e6);
        SiphonSweepDelegate.SweepIntent memory cometIntent = _baseIntent(504, 25, 0);
        cometIntent.minNetUsdcOut = 240e6;
        cometIntent.defiExits = new SiphonSweepDelegate.DefiExit[](1);
        cometIntent.defiExits[0] = SiphonSweepDelegate.DefiExit({
            kind: SiphonSweepDelegate.ExitKind.COMPOUND_V3,
            protocol: address(comet),
            underlyingAsset: address(usdc),
            amount: 1_000e6
        });
        (v, r, s) = vm.sign(EOA_PK, _delegated().hashIntent(cometIntent));
        vm.prank(relayer);
        (uint256 cometBridged, ) = _delegated().executeSponsoredSweep(cometIntent, 0, v, r, s);
        assertEq(comet.borrowBalanceOf(eoa), 0, "Delegate MUST NOT create Compound v3 borrow debt");
        assertEq(cometBridged, 249_375_000);
    }
}
