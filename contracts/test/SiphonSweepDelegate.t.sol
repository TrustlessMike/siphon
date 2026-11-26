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
        comet = new MockCompoundV3Comet();
        vault4626 = new MockERC4626Vault(address(usdc));
        usdc.mint(address(swapRouter), 10_000_000e6);

        registry = new SiphonDelegateRegistry(address(this));
        registry.setAllowedFeeRecipient(feeRecipient, true);
        registry.setAllowedRelayer(relayer, true);
        registry.setAllowedSwapRouter(address(swapRouter), true);
        registry.setAllowedDefiProtocol(address(comet), true);
        registry.setAllowedDefiProtocol(address(vault4626), true);

        // Deploy EIP-7702 delegate implementation with $25 whale fee cap and etch onto `eoa`
        delegateImpl = new SiphonSweepDelegate(feeRecipient, 2, address(registry), 25e6);
        vm.etch(eoa, address(delegateImpl).code);

        // Deploy real SiphonAgentVault authorizing the delegated EOA (which is msg.sender under EIP-7702)
        agentVault = new SiphonAgentVault(eoa);
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
        vm.expectRevert(abi.encodeWithSelector(SiphonSweepDelegate.TargetNotAllowed.selector, address(swapRouter)));
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
        intent.minNetUsdcOut = 99_975e6;

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
        // Delegated EOA grants autonomous mandate to `agent`
        uint8 actionBridge = agentVault.ACTION_BRIDGE_SOLANA();
        vm.prank(eoa);
        bytes32 mandateId = agentVault.grantMandate(
            agent,
            SOLANA_ATA,
            600e6, // $600 per tx
            900e6, // $900 rolling 24h cap
            7 days,
            50,    // max 0.50% fee
            9800,  // min 98% net preservation
            actionBridge
        );

        usdc.mint(eoa, 2_000e6);

        // Autonomous `agent` signs SweepIntentV2 (zero EOA popup!)
        SiphonSweepDelegate.SweepIntent memory intent = _baseIntent(100, 25, 500e6);
        intent.minNetUsdcOut = 490e6;
        SiphonSweepDelegate.CctpV2Options memory fastOpts = SiphonSweepDelegate.CctpV2Options({
            destinationCaller: bytes32(0),
            maxFee: 500_000, // $0.50
            minFinalityThreshold: 1000,
            hookData: ""
        });

        bytes32 digest = _delegated().hashIntentV2(intent, 5e6, fastOpts);
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
        (v, r, s) = vm.sign(AGENT_PK, _delegated().hashIntentV2(intent, 5e6, fastOpts));
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
        (v, r, s) = vm.sign(AGENT_PK, _delegated().hashIntentV2(intent, 5e6, fastOpts));
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
        (v, r, s) = vm.sign(ATTACKER_PK, _delegated().hashIntentV2(intent, 5e6, fastOpts));
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
}
