// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title SiphonDelegateRegistry
 * @notice On-chain policy allowlist & kill-switch registry for SiphonSweepDelegate (EIP-7702)
 *         and Siphon execution infrastructure.
 *
 * Security properties:
 *   1. Implements ISiphonDelegateRegistry consumed by SiphonSweepDelegate.
 *   2. Two-step ownership transfer (transferOwnership -> acceptOwnership).
 *   3. Global pausable kill-switch: when paused, every isAllowed* / isApproved* query returns false,
 *      immediately halting all registry-gated delegated sweeps without migrating user EOA delegations.
 *   4. Strictly disjoint swap router vs DeFi protocol allowlists (prevents arbitrary router calldata
 *      from targeting DeFi protocols).
 *   5. Batch configuration helpers for deterministic multi-chain deployment scripts.
 */
contract SiphonDelegateRegistry {
    address public owner;
    address public pendingOwner;
    bool public paused;

    mapping(address => bool) public allowedFeeRecipients;
    mapping(address => bool) public allowedRelayers;
    mapping(address => bool) public allowedSwapRouters;
    mapping(address => bool) public allowedDefiProtocols;
    mapping(address => bool) public allowedDelegateImplementations;
    mapping(address => bool) public allowedAgentVaults;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    event FeeRecipientUpdated(address indexed recipient, bool allowed);
    event RelayerUpdated(address indexed relayer, bool allowed);
    event SwapRouterUpdated(address indexed router, bool allowed);
    event DefiProtocolUpdated(address indexed protocol, bool allowed);
    event DelegateImplementationUpdated(address indexed implementation, bool allowed);
    event AgentVaultUpdated(address indexed vault, bool allowed);

    error Unauthorized();
    error InvalidAddress();
    error DisjointAllowlistViolation(address target);
    error AlreadyPaused();
    error NotPaused();

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert InvalidAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    // -------------------------------------------------------------------------
    // Governance & Emergency Kill-Switch
    // -------------------------------------------------------------------------

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

    function pause() external onlyOwner {
        if (paused) revert AlreadyPaused();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert NotPaused();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // -------------------------------------------------------------------------
    // Single Allowlist Updates
    // -------------------------------------------------------------------------

    function setAllowedFeeRecipient(address recipient, bool allowed) public onlyOwner {
        if (recipient == address(0)) revert InvalidAddress();
        allowedFeeRecipients[recipient] = allowed;
        emit FeeRecipientUpdated(recipient, allowed);
    }

    function setAllowedRelayer(address relayer, bool allowed) public onlyOwner {
        if (relayer == address(0)) revert InvalidAddress();
        allowedRelayers[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function setAllowedSwapRouter(address router, bool allowed) public onlyOwner {
        if (router == address(0)) revert InvalidAddress();
        if (allowed && allowedDefiProtocols[router]) {
            revert DisjointAllowlistViolation(router);
        }
        allowedSwapRouters[router] = allowed;
        emit SwapRouterUpdated(router, allowed);
    }

    function setAllowedDefiProtocol(address protocol, bool allowed) public onlyOwner {
        if (protocol == address(0)) revert InvalidAddress();
        if (allowed && allowedSwapRouters[protocol]) {
            revert DisjointAllowlistViolation(protocol);
        }
        allowedDefiProtocols[protocol] = allowed;
        emit DefiProtocolUpdated(protocol, allowed);
    }

    function setAllowedDelegateImplementation(address implementation, bool allowed) public onlyOwner {
        if (implementation == address(0)) revert InvalidAddress();
        allowedDelegateImplementations[implementation] = allowed;
        emit DelegateImplementationUpdated(implementation, allowed);
    }

    function setAllowedAgentVault(address vault, bool allowed) public onlyOwner {
        if (vault == address(0)) revert InvalidAddress();
        allowedAgentVaults[vault] = allowed;
        emit AgentVaultUpdated(vault, allowed);
    }

    // -------------------------------------------------------------------------
    // Batch Allowlist Updates
    // -------------------------------------------------------------------------

    function setAllowedFeeRecipientsBatch(address[] calldata recipients, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < recipients.length; i++) {
            setAllowedFeeRecipient(recipients[i], allowed);
        }
    }

    function setAllowedRelayersBatch(address[] calldata relayers, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < relayers.length; i++) {
            setAllowedRelayer(relayers[i], allowed);
        }
    }

    function setAllowedSwapRoutersBatch(address[] calldata routers, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < routers.length; i++) {
            setAllowedSwapRouter(routers[i], allowed);
        }
    }

    function setAllowedDefiProtocolsBatch(address[] calldata protocols, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < protocols.length; i++) {
            setAllowedDefiProtocol(protocols[i], allowed);
        }
    }

    function setAllowedDelegateImplementationsBatch(address[] calldata implementations, bool allowed)
        external
        onlyOwner
    {
        for (uint256 i = 0; i < implementations.length; i++) {
            setAllowedDelegateImplementation(implementations[i], allowed);
        }
    }

    function setAllowedAgentVaultsBatch(address[] calldata vaults, bool allowed) external onlyOwner {
        for (uint256 i = 0; i < vaults.length; i++) {
            setAllowedAgentVault(vaults[i], allowed);
        }
    }

    // -------------------------------------------------------------------------
    // ISiphonDelegateRegistry Views (Fail-Closed When Paused)
    // -------------------------------------------------------------------------

    function isAllowedFeeRecipient(address recipient) external view returns (bool) {
        return !paused && allowedFeeRecipients[recipient];
    }

    function isAllowedRelayer(address relayer) external view returns (bool) {
        return !paused && allowedRelayers[relayer];
    }

    function isAllowedSwapRouter(address router) external view returns (bool) {
        return !paused && allowedSwapRouters[router];
    }

    function isAllowedDefiProtocol(address protocol) external view returns (bool) {
        return !paused && allowedDefiProtocols[protocol];
    }

    function isAllowedDelegateImplementation(address implementation) external view returns (bool) {
        return !paused && allowedDelegateImplementations[implementation];
    }

    function isAllowedAgentVault(address vault) external view returns (bool) {
        return !paused && allowedAgentVaults[vault];
    }

    // -------------------------------------------------------------------------
    // Convenience Aliases
    // -------------------------------------------------------------------------

    function isApprovedRelayer(address relayer) external view returns (bool) {
        return !paused && allowedRelayers[relayer];
    }

    function isApprovedRouter(address router) external view returns (bool) {
        return !paused && allowedSwapRouters[router];
    }

    function isApprovedFeeRecipient(address recipient) external view returns (bool) {
        return !paused && allowedFeeRecipients[recipient];
    }

    function isApprovedDefiProtocol(address protocol) external view returns (bool) {
        return !paused && allowedDefiProtocols[protocol];
    }

    function isApprovedDelegateImplementation(address implementation) external view returns (bool) {
        return !paused && allowedDelegateImplementations[implementation];
    }

    function isApprovedAgentVault(address vault) external view returns (bool) {
        return !paused && allowedAgentVaults[vault];
    }
}
