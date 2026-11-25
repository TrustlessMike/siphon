// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SiphonFeeVault
 * @notice Auditable protocol treasury vault receiving 5-10% migration fees from SiphonRouter,
 *         Relay appFees, LI.FI integrator fees, and EIP-5792 atomic batch splits.
 *
 * Security properties:
 *   1. Accepts both native gas coins (ETH/POL/AVAX) and any ERC-20 token (USDC, WETH, etc.)
 *   2. SafeERC20 low-level transfer wrapper compatible with non-standard tokens (Ethereum USDT)
 *   3. Multi-recipient bps revenue splits (always sums to 10_000 bps = 100%)
 *   4. Two-step ownership transfer and non-reentrant distribution/sweep
 */

interface IERC20Vault {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

library SafeVaultERC20 {
    error TransferFailed(address token);

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Vault.transfer.selector, to, amount)
        );
        if (!ok || (data.length > 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed(token);
        }
    }
}

contract SiphonFeeVault {
    using SafeVaultERC20 for address;

    struct Payee {
        address account;
        uint16 shareBps; // Out of 10_000
    }

    uint16 public constant TOTAL_BPS = 10_000;

    address public owner;
    address public pendingOwner;
    uint256 private _guard = 1;

    Payee[] public payees;
    mapping(address => uint256) public totalDistributedERC20;
    uint256 public totalDistributedNative;

    event NativeFeeReceived(address indexed sender, uint256 amount);
    event NativeFeeDistributed(uint256 totalAmount, uint256 recipientCount);
    event ERC20FeeDistributed(address indexed token, uint256 totalAmount, uint256 recipientCount);
    event PayeesUpdated(uint256 count);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error Reentrancy();
    error InvalidAddress();
    error InvalidShares(uint256 sumBps);
    error NothingToDistribute();
    error NativeTransferFailed(address to);

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (_guard != 1) revert Reentrancy();
        _guard = 2;
        _;
        _guard = 1;
    }

    constructor(address initialTreasury) {
        if (initialTreasury == address(0)) revert InvalidAddress();
        owner = msg.sender;
        payees.push(Payee({ account: initialTreasury, shareBps: TOTAL_BPS }));
        emit PayeesUpdated(1);
    }

    receive() external payable {
        emit NativeFeeReceived(msg.sender, msg.value);
    }

    function payeeCount() external view returns (uint256) {
        return payees.length;
    }

    function setPayees(Payee[] calldata nextPayees) external onlyOwner {
        if (nextPayees.length == 0) revert InvalidShares(0);
        delete payees;
        uint256 sum = 0;
        for (uint256 i = 0; i < nextPayees.length; i++) {
            if (nextPayees[i].account == address(0)) revert InvalidAddress();
            if (nextPayees[i].shareBps == 0) revert InvalidShares(0);
            sum += nextPayees[i].shareBps;
            payees.push(nextPayees[i]);
        }
        if (sum != TOTAL_BPS) revert InvalidShares(sum);
        emit PayeesUpdated(nextPayees.length);
    }

    function distributeERC20(address token) external nonReentrant {
        if (token == address(0)) revert InvalidAddress();
        uint256 balance = IERC20Vault(token).balanceOf(address(this));
        if (balance == 0) revert NothingToDistribute();

        uint256 len = payees.length;
        uint256 remaining = balance;
        for (uint256 i = 0; i < len; i++) {
            uint256 share = (i == len - 1) ? remaining : (balance * payees[i].shareBps) / TOTAL_BPS;
            remaining -= share;
            if (share > 0) {
                token.safeTransfer(payees[i].account, share);
            }
        }
        totalDistributedERC20[token] += balance;
        emit ERC20FeeDistributed(token, balance, len);
    }

    function distributeNative() external nonReentrant {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NothingToDistribute();

        uint256 len = payees.length;
        uint256 remaining = balance;
        for (uint256 i = 0; i < len; i++) {
            uint256 share = (i == len - 1) ? remaining : (balance * payees[i].shareBps) / TOTAL_BPS;
            remaining -= share;
            if (share > 0) {
                (bool ok, ) = payees[i].account.call{ value: share }("");
                if (!ok) revert NativeTransferFailed(payees[i].account);
            }
        }
        totalDistributedNative += balance;
        emit NativeFeeDistributed(balance, len);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address prev = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(prev, owner);
    }
}
