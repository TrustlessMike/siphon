// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import { TurgaliumDelegateRegistry } from "../TurgaliumDelegateRegistry.sol";

contract TurgaliumDelegateRegistryTest is TestBase {
    TurgaliumDelegateRegistry internal registry;
    address internal owner = address(0xA11CE);
    address internal nextOwner = address(0xB0B);
    address internal attacker = address(0xBAD);
    address internal relayer1 = address(0x1001);
    address internal relayer2 = address(0x1002);
    address internal router1 = address(0x2001);
    address internal defi1 = address(0x3001);
    address internal feeVault = address(0x4001);
    address internal delegateImpl = address(0x5001);
    address internal agentVault = address(0x6001);

    function setUp() public {
        registry = new TurgaliumDelegateRegistry(owner);
        // Contract allowlist targets must have deployed bytecode (L-3)
        vm.etch(router1, hex"00");
        vm.etch(defi1, hex"00");
        vm.etch(delegateImpl, hex"00");
        vm.etch(agentVault, hex"00");
    }

    function test_ConstructorRejectsZeroOwner() public {
        vm.expectRevert(TurgaliumDelegateRegistry.InvalidAddress.selector);
        new TurgaliumDelegateRegistry(address(0));
    }

    function test_AllowlistSingleAndBatchConfiguration() public {
        vm.startPrank(owner);
        registry.setAllowedRelayer(relayer1, true);
        registry.setAllowedSwapRouter(router1, true);
        registry.setAllowedDefiProtocol(defi1, true);
        registry.setAllowedFeeRecipient(feeVault, true);
        registry.setAllowedDelegateImplementation(delegateImpl, true);
        registry.setAllowedAgentVault(agentVault, true);

        address[] memory batchRelayers = new address[](2);
        batchRelayers[0] = relayer1;
        batchRelayers[1] = relayer2;
        registry.setAllowedRelayersBatch(batchRelayers, true);
        vm.stopPrank();

        assertTrue(registry.isAllowedRelayer(relayer1));
        assertTrue(registry.isApprovedRelayer(relayer2));
        assertTrue(registry.isAllowedSwapRouter(router1));
        assertTrue(registry.isApprovedRouter(router1));
        assertTrue(registry.isAllowedDefiProtocol(defi1));
        assertTrue(registry.isApprovedDefiProtocol(defi1));
        assertTrue(registry.isAllowedFeeRecipient(feeVault));
        assertTrue(registry.isApprovedFeeRecipient(feeVault));
        assertTrue(registry.isAllowedDelegateImplementation(delegateImpl));
        assertTrue(registry.isApprovedDelegateImplementation(delegateImpl));
        assertTrue(registry.isAllowedAgentVault(agentVault));
        assertTrue(registry.isApprovedAgentVault(agentVault));

        // Revoke relayer2
        vm.prank(owner);
        registry.setAllowedRelayer(relayer2, false);
        assertFalse(registry.isAllowedRelayer(relayer2));
        assertFalse(registry.isApprovedRelayer(relayer2));
    }

    function test_DisjointSwapRouterAndDefiProtocolEnforced() public {
        vm.startPrank(owner);
        registry.setAllowedSwapRouter(router1, true);

        vm.expectRevert(abi.encodeWithSelector(TurgaliumDelegateRegistry.DisjointAllowlistViolation.selector, router1));
        registry.setAllowedDefiProtocol(router1, true);

        vm.expectRevert(abi.encodeWithSelector(TurgaliumDelegateRegistry.DisjointAllowlistViolation.selector, router1));
        registry.setAllowedAgentVault(router1, true);

        vm.expectRevert(abi.encodeWithSelector(TurgaliumDelegateRegistry.DisjointAllowlistViolation.selector, router1));
        registry.setAllowedDelegateImplementation(router1, true);

        registry.setAllowedDefiProtocol(defi1, true);
        vm.expectRevert(abi.encodeWithSelector(TurgaliumDelegateRegistry.DisjointAllowlistViolation.selector, defi1));
        registry.setAllowedSwapRouter(defi1, true);

        registry.setAllowedAgentVault(agentVault, true);
        vm.expectRevert(abi.encodeWithSelector(TurgaliumDelegateRegistry.DisjointAllowlistViolation.selector, agentVault));
        registry.setAllowedSwapRouter(agentVault, true);

        registry.setAllowedDelegateImplementation(delegateImpl, true);
        vm.expectRevert(abi.encodeWithSelector(TurgaliumDelegateRegistry.DisjointAllowlistViolation.selector, delegateImpl));
        registry.setAllowedSwapRouter(delegateImpl, true);
        vm.stopPrank();
    }

    function test_ContractAllowlistSettersRejectEoAs() public {
        address eoaAddr = address(0x9999);
        vm.startPrank(owner);
        vm.expectRevert(TurgaliumDelegateRegistry.InvalidAddress.selector);
        registry.setAllowedSwapRouter(eoaAddr, true);

        vm.expectRevert(TurgaliumDelegateRegistry.InvalidAddress.selector);
        registry.setAllowedDefiProtocol(eoaAddr, true);

        vm.expectRevert(TurgaliumDelegateRegistry.InvalidAddress.selector);
        registry.setAllowedDelegateImplementation(eoaAddr, true);

        vm.expectRevert(TurgaliumDelegateRegistry.InvalidAddress.selector);
        registry.setAllowedAgentVault(eoaAddr, true);
        vm.stopPrank();
    }

    function test_PauseKillSwitchBlocksAllQueriesFailClosed() public {
        vm.startPrank(owner);
        registry.setAllowedRelayer(relayer1, true);
        registry.setAllowedSwapRouter(router1, true);
        registry.setAllowedDefiProtocol(defi1, true);
        registry.setAllowedFeeRecipient(feeVault, true);
        registry.setAllowedDelegateImplementation(delegateImpl, true);
        registry.setAllowedAgentVault(agentVault, true);

        registry.pause();
        vm.stopPrank();

        assertTrue(registry.paused());
        assertFalse(registry.isAllowedRelayer(relayer1));
        assertFalse(registry.isApprovedRelayer(relayer1));
        assertFalse(registry.isAllowedSwapRouter(router1));
        assertFalse(registry.isApprovedRouter(router1));
        assertFalse(registry.isAllowedDefiProtocol(defi1));
        assertFalse(registry.isAllowedFeeRecipient(feeVault));
        assertFalse(registry.isAllowedDelegateImplementation(delegateImpl));
        assertFalse(registry.isAllowedAgentVault(agentVault));

        // Double pause reverts
        vm.prank(owner);
        vm.expectRevert(TurgaliumDelegateRegistry.AlreadyPaused.selector);
        registry.pause();

        // Unpause restores all allowlist entries cleanly
        vm.prank(owner);
        registry.unpause();
        assertFalse(registry.paused());
        assertTrue(registry.isApprovedRelayer(relayer1));
        assertTrue(registry.isApprovedRouter(router1));
        assertTrue(registry.isAllowedDefiProtocol(defi1));
        assertTrue(registry.isAllowedFeeRecipient(feeVault));
        assertTrue(registry.isAllowedAgentVault(agentVault));
    }

    function test_TwoStepOwnershipTransfer() public {
        vm.prank(attacker);
        vm.expectRevert(TurgaliumDelegateRegistry.Unauthorized.selector);
        registry.transferOwnership(attacker);

        vm.prank(owner);
        vm.expectRevert(TurgaliumDelegateRegistry.InvalidAddress.selector);
        registry.transferOwnership(address(0));

        vm.prank(owner);
        registry.transferOwnership(nextOwner);
        assertEq(registry.pendingOwner(), nextOwner);
        assertEq(registry.owner(), owner);

        vm.prank(attacker);
        vm.expectRevert(TurgaliumDelegateRegistry.Unauthorized.selector);
        registry.acceptOwnership();

        vm.prank(nextOwner);
        registry.acceptOwnership();
        assertEq(registry.owner(), nextOwner);
        assertEq(registry.pendingOwner(), address(0));

        // Previous owner is now locked out
        vm.prank(owner);
        vm.expectRevert(TurgaliumDelegateRegistry.Unauthorized.selector);
        registry.pause();

        // New owner has full control
        vm.prank(nextOwner);
        registry.pause();
        assertTrue(registry.paused());
    }

    function test_UnauthorizedCannotModifyAllowlists() public {
        vm.startPrank(attacker);
        vm.expectRevert(TurgaliumDelegateRegistry.Unauthorized.selector);
        registry.setAllowedRelayer(attacker, true);

        vm.expectRevert(TurgaliumDelegateRegistry.Unauthorized.selector);
        registry.setAllowedSwapRouter(attacker, true);

        vm.expectRevert(TurgaliumDelegateRegistry.Unauthorized.selector);
        registry.setAllowedDefiProtocol(attacker, true);

        vm.expectRevert(TurgaliumDelegateRegistry.Unauthorized.selector);
        registry.setAllowedFeeRecipient(attacker, true);

        vm.expectRevert(TurgaliumDelegateRegistry.Unauthorized.selector);
        registry.pause();
        vm.stopPrank();
    }
}
