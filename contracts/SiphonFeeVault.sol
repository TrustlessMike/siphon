// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title SiphonFeeVault
 * @notice Auditable protocol treasury vault receiving 0-10% tiered migration fees (with optional whale
 *         USDC caps) from SiphonRouter, SiphonSweepDelegate, Relay appFees, LI.FI integrator fees,
 *         and EIP-5792 atomic batch splits.
 *
 * Security properties:
 *   1. Accepts both native gas coins (ETH/POL/AVAX) and any ERC-20 token (USDC, WETH, etc.)
 *   2. Hardened SafeVaultERC20 wrapper (code.length > 0, safe 32-byte bool word check, USDT-compatible)
 *   3. Push-payment DoS immunity: failed native or blacklisted ERC-20 transfers are isolated into per-payee
 *      claimable escrow (`pendingNative` / `pendingERC20`) so one reverting/blacklisted payee can never freeze others
 *   4. Cross-function reentrancy protection (`nonReentrant` on `setPayees`, distributions, and claims) + strict CEI
 *   5. Fair proportional rounding: sub-unit rounding dust remains in the vault (eliminates last-payee dust capture)
 *   6. Two-step ownership transfer and bounded payee count (max 32 unique payees summing to 10_000 bps)
 */

interface IERC20Vault {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

library SafeVaultERC20 {
    error TransferFailed(address token);

    function _callSuccess(address token, bool ok, bytes memory data) private view returns (bool) {
        if (!ok) return false;
        if (data.length == 0) {
            return token.code.length > 0;
        }
        if (data.length < 32) return false;
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(data, 32))
        }
        return word == 1;
    }

    function trySafeTransfer(address token, address to, uint256 amount) internal returns (bool) {
        if (token.code.length == 0) return false;
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Vault.transfer.selector, to, amount)
        );
        return _callSuccess(token, ok, data);
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        if (!trySafeTransfer(token, to, amount)) {
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
    uint256 public constant MAX_PAYEES = 32;
    uint256 public constant NATIVE_PUSH_GAS_CAP = 50_000;

    address public owner;
    address public pendingOwner;
    uint256 private _guard = 1;

    Payee[] public payees;
    mapping(address => uint256) public totalDistributedERC20;
    uint256 public totalDistributedNative;

    /// @notice Claimable escrow balances for any payee whose push transfer failed (e.g., blacklisted or reverting receiver).
    mapping(address => uint256) public pendingNative;
    uint256 public totalEscrowedNative;
    mapping(address => mapping(address => uint256)) public pendingERC20;
    mapping(address => uint256) public totalEscrowedERC20;

    event NativeFeeReceived(address indexed sender, uint256 amount);
    event NativeFeeDistributed(uint256 totalAmount, uint256 recipientCount);
    event ERC20FeeDistributed(address indexed token, uint256 totalAmount, uint256 recipientCount);
    event NativePayoutEscrowed(address indexed payee, uint256 amount);
    event ERC20PayoutEscrowed(address indexed token, address indexed payee, uint256 amount);
    event NativePayoutClaimed(address indexed payee, address indexed to, uint256 amount);
    event ERC20PayoutClaimed(address indexed token, address indexed payee, address indexed to, uint256 amount);
    event PayeesUpdated(uint256 count);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error Reentrancy();
    error InvalidAddress();
    error InvalidShares(uint256 sumBps);
    error TooManyPayees(uint256 count);
    error DuplicatePayee(address payee);
    error NothingToDistribute();
    error NothingToClaim();
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

    function setPayees(Payee[] calldata nextPayees) external onlyOwner nonReentrant {
        uint256 count = nextPayees.length;
        if (count == 0) revert InvalidShares(0);
        if (count > MAX_PAYEES) revert TooManyPayees(count);

        uint256 sum = 0;
        for (uint256 i = 0; i < count; i++) {
            address acct = nextPayees[i].account;
            if (acct == address(0)) revert InvalidAddress();
            if (nextPayees[i].shareBps == 0) revert InvalidShares(0);
            for (uint256 j = 0; j < i; j++) {
                if (nextPayees[j].account == acct) revert DuplicatePayee(acct);
            }
            sum += nextPayees[i].shareBps;
        }
        if (sum != TOTAL_BPS) revert InvalidShares(sum);

        delete payees;
        for (uint256 i = 0; i < count; i++) {
            payees.push(nextPayees[i]);
        }
        emit PayeesUpdated(count);
    }

    function distributeERC20(address token) external nonReentrant {
        if (token == address(0) || token.code.length == 0) revert InvalidAddress();
        uint256 balance = IERC20Vault(token).balanceOf(address(this));
        uint256 escrowed = totalEscrowedERC20[token];
        if (balance <= escrowed) revert NothingToDistribute();
        uint256 distributable = balance - escrowed;

        uint256 len = payees.length;
        Payee[] memory snapshot = new Payee[](len);
        uint256[] memory shares = new uint256[](len);
        uint256 totalAllocated = 0;

        for (uint256 i = 0; i < len; i++) {
            snapshot[i] = payees[i];
            uint256 share = (distributable * snapshot[i].shareBps) / TOTAL_BPS;
            shares[i] = share;
            totalAllocated += share;
        }
        if (totalAllocated == 0) revert NothingToDistribute();

        // CEI: update accounting state before any external token calls
        totalDistributedERC20[token] += totalAllocated;
        emit ERC20FeeDistributed(token, totalAllocated, len);

        for (uint256 i = 0; i < len; i++) {
            uint256 share = shares[i];
            if (share == 0) continue;
            // Guard against sender-tax FoT tokens exhausting vault balance mid-loop
            uint256 currentAvailable = IERC20Vault(token).balanceOf(address(this));
            uint256 cappedEscrow = totalEscrowedERC20[token];
            uint256 sendAmt = currentAvailable > cappedEscrow
                ? (share < (currentAvailable - cappedEscrow) ? share : (currentAvailable - cappedEscrow))
                : 0;
            if (sendAmt == 0) continue;

            if (!token.trySafeTransfer(snapshot[i].account, sendAmt)) {
                pendingERC20[token][snapshot[i].account] += sendAmt;
                totalEscrowedERC20[token] += sendAmt;
                emit ERC20PayoutEscrowed(token, snapshot[i].account, sendAmt);
            }
        }
    }

    function distributeNative() external nonReentrant {
        uint256 balance = address(this).balance;
        if (balance <= totalEscrowedNative) revert NothingToDistribute();
        uint256 distributable = balance - totalEscrowedNative;

        uint256 len = payees.length;
        Payee[] memory snapshot = new Payee[](len);
        uint256[] memory shares = new uint256[](len);
        uint256 totalAllocated = 0;

        for (uint256 i = 0; i < len; i++) {
            snapshot[i] = payees[i];
            uint256 share = (distributable * snapshot[i].shareBps) / TOTAL_BPS;
            shares[i] = share;
            totalAllocated += share;
        }
        if (totalAllocated == 0) revert NothingToDistribute();

        // CEI: update accounting state before external calls
        totalDistributedNative += totalAllocated;
        emit NativeFeeDistributed(totalAllocated, len);

        for (uint256 i = 0; i < len; i++) {
            uint256 share = shares[i];
            if (share == 0) continue;
            (bool ok, ) = snapshot[i].account.call{ value: share, gas: NATIVE_PUSH_GAS_CAP }("");
            if (!ok) {
                pendingNative[snapshot[i].account] += share;
                totalEscrowedNative += share;
                emit NativePayoutEscrowed(snapshot[i].account, share);
            }
        }
    }

    /// @notice Pull-payment claim for any payee whose native ETH payout was escrowed.
    function claimNative(address payable to) external nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        uint256 amount = pendingNative[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingNative[msg.sender] = 0;
        totalEscrowedNative -= amount;
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed(to);
        emit NativePayoutClaimed(msg.sender, to, amount);
    }

    /// @notice Pull-payment claim for any payee whose ERC-20 payout was escrowed (e.g., after resolving blacklist or redirecting to `to`).
    function claimERC20(address token, address to) external nonReentrant {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        uint256 amount = pendingERC20[token][msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingERC20[token][msg.sender] = 0;
        totalEscrowedERC20[token] -= amount;
        token.safeTransfer(to, amount);
        emit ERC20PayoutClaimed(token, msg.sender, to, amount);
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
