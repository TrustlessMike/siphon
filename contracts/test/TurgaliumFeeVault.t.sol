// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { TestBase } from "./TestBase.sol";
import { MockERC20, RevertingReceiver } from "./Mocks.sol";
import { TurgaliumFeeVault } from "../TurgaliumFeeVault.sol";

contract TurgaliumFeeVaultTest is TestBase {
    TurgaliumFeeVault internal vault;
    MockERC20 internal usdc;

    address internal treasuryA = address(0x1111);
    address internal treasuryB = address(0x2222);
    address internal treasuryC = address(0x3333);
    address internal attacker = address(0xDEAD);

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        vault = new TurgaliumFeeVault(treasuryA);
    }

    function test_ConstructorAndZeroAddressGuards() public {
        vm.expectRevert(TurgaliumFeeVault.InvalidAddress.selector);
        new TurgaliumFeeVault(address(0));

        assertEq(vault.payeeCount(), 1);
        (address acct, uint16 share) = vault.payees(0);
        assertEq(acct, treasuryA);
        assertEq(share, 10_000);
    }

    function test_ERC20SplitAccountingAndDustRetention() public {
        TurgaliumFeeVault.Payee[] memory payees = new TurgaliumFeeVault.Payee[](3);
        payees[0] = TurgaliumFeeVault.Payee({ account: treasuryA, shareBps: 3333 });
        payees[1] = TurgaliumFeeVault.Payee({ account: treasuryB, shareBps: 3333 });
        payees[2] = TurgaliumFeeVault.Payee({ account: treasuryC, shareBps: 3334 });
        vault.setPayees(payees);

        // 10_001 base units -> rounding dust stays cleanly inside vault (no last-payee dust bias)
        usdc.mint(address(vault), 10_001);
        vault.distributeERC20(address(usdc));

        assertEq(usdc.balanceOf(treasuryA), 3_333);
        assertEq(usdc.balanceOf(treasuryB), 3_333);
        assertEq(usdc.balanceOf(treasuryC), 3_334);
        assertEq(usdc.balanceOf(address(vault)), 1, "Rounding dust remains in vault");
        assertEq(vault.totalDistributedERC20(address(usdc)), 10_000);
    }

    function test_NativePushDoSImmunityAndClaim() public {
        RevertingReceiver blocked = new RevertingReceiver();

        TurgaliumFeeVault.Payee[] memory payees = new TurgaliumFeeVault.Payee[](2);
        payees[0] = TurgaliumFeeVault.Payee({ account: address(blocked), shareBps: 4000 });
        payees[1] = TurgaliumFeeVault.Payee({ account: treasuryB, shareBps: 6000 });
        vault.setPayees(payees);

        vm.deal(address(vault), 10 ether);
        vault.distributeNative();

        // Healthy payee received 6 ETH immediately; reverting payee's 4 ETH was escrowed
        assertEq(treasuryB.balance, 6 ether);
        assertEq(vault.pendingNative(address(blocked)), 4 ether);
        assertEq(vault.totalEscrowedNative(), 4 ether);

        // Blocked payee can claim to an alternate safe EOA
        vm.prank(address(blocked));
        vault.claimNative(payable(treasuryC));
        assertEq(treasuryC.balance, 4 ether);
        assertEq(vault.pendingNative(address(blocked)), 0);
        assertEq(vault.totalEscrowedNative(), 0);
    }

    function test_ERC20BlacklistIsolationAndClaim() public {
        TurgaliumFeeVault.Payee[] memory payees = new TurgaliumFeeVault.Payee[](2);
        payees[0] = TurgaliumFeeVault.Payee({ account: treasuryA, shareBps: 5000 });
        payees[1] = TurgaliumFeeVault.Payee({ account: treasuryB, shareBps: 5000 });
        vault.setPayees(payees);

        usdc.setBlacklisted(treasuryA, true);
        usdc.mint(address(vault), 1_000_000);

        vault.distributeERC20(address(usdc));

        assertEq(usdc.balanceOf(treasuryB), 500_000);
        assertEq(usdc.balanceOf(treasuryA), 0);
        assertEq(vault.pendingERC20(address(usdc), treasuryA), 500_000);
        assertEq(vault.totalEscrowedERC20(address(usdc)), 500_000);

        // Blacklisted treasury redirects its claim to treasuryC
        vm.prank(treasuryA);
        vault.claimERC20(address(usdc), treasuryC);
        assertEq(usdc.balanceOf(treasuryC), 500_000);
        assertEq(vault.pendingERC20(address(usdc), treasuryA), 0);
        assertEq(vault.totalEscrowedERC20(address(usdc)), 0);
    }

    function test_PayeeValidationAndOwnershipGuards() public {
        // Invalid sum
        TurgaliumFeeVault.Payee[] memory badSum = new TurgaliumFeeVault.Payee[](1);
        badSum[0] = TurgaliumFeeVault.Payee({ account: treasuryA, shareBps: 9999 });
        vm.expectRevert(abi.encodeWithSelector(TurgaliumFeeVault.InvalidShares.selector, 9999));
        vault.setPayees(badSum);

        // Duplicate payee
        TurgaliumFeeVault.Payee[] memory dup = new TurgaliumFeeVault.Payee[](2);
        dup[0] = TurgaliumFeeVault.Payee({ account: treasuryA, shareBps: 5000 });
        dup[1] = TurgaliumFeeVault.Payee({ account: treasuryA, shareBps: 5000 });
        vm.expectRevert(abi.encodeWithSelector(TurgaliumFeeVault.DuplicatePayee.selector, treasuryA));
        vault.setPayees(dup);

        // Non-owner rejected
        vm.prank(attacker);
        vm.expectRevert(TurgaliumFeeVault.Unauthorized.selector);
        vault.setPayees(badSum);

        // Two-step ownership
        vault.transferOwnership(treasuryB);
        vm.prank(treasuryB);
        vault.acceptOwnership();
        assertEq(vault.owner(), treasuryB);
    }

    function testFuzz_ERC20SplitConservation(uint96 rawAmount, uint16 shareA, uint16 shareB) public {
        uint256 amount = bound(uint256(rawAmount), 10_000, 1_000_000_000_000);
        uint16 a = uint16(bound(uint256(shareA), 1, 9_998));
        uint16 b = uint16(bound(uint256(shareB), 1, 9_999 - uint256(a)));
        uint16 c = 10_000 - a - b;

        TurgaliumFeeVault.Payee[] memory payees = new TurgaliumFeeVault.Payee[](3);
        payees[0] = TurgaliumFeeVault.Payee({ account: treasuryA, shareBps: a });
        payees[1] = TurgaliumFeeVault.Payee({ account: treasuryB, shareBps: b });
        payees[2] = TurgaliumFeeVault.Payee({ account: treasuryC, shareBps: c });
        vault.setPayees(payees);

        usdc.mint(address(vault), amount);
        vault.distributeERC20(address(usdc));

        uint256 paid = usdc.balanceOf(treasuryA) + usdc.balanceOf(treasuryB) + usdc.balanceOf(treasuryC);
        uint256 dust = usdc.balanceOf(address(vault));

        assertEq(paid + dust, amount, "Conservation violated");
        assertLe(dust, 3, "Dust cannot exceed payee count");
    }
}
