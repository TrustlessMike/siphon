// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SiphonAgentVault
 * @notice Policy-bounded Smart-Contract Agent & AI Plugin Session Vault for Siphon.
 *
 * Security invariants:
 *   1. An owner grants a scoped AgentMandate to an autonomous agent key (or AI assistant relayer)
 *      with an IMMUTABLE `lockedSolanaRecipient` bytes32 destination — the agent can NEVER
 *      redirect funds to any other address.
 *   2. Mandate budget can ONLY be consumed by an owner-approved execution router/delegate
 *      (`authorizedRouter`, e.g. SiphonRouter or SiphonSweepDelegate) AFTER the router measures
 *      actual on-chain token transfer amounts and post-swap USDC balance deltas. Untrusted EOAs
 *      or agents CANNOT call `authorizeAgentAction` directly with self-reported `grossUsd6`/`netOutUsd6`.
 *   3. Every execution enforces:
 *        - Single-bit action validation (`actionBit != 0 && (actionBit & (actionBit - 1)) == 0`)
 *        - Per-transaction USD value cap (`maxPerTxUsd6`)
 *        - Rolling 24-hour USD spending cap (`dailyCapUsd6`)
 *        - Allowed action bitmap (`ACTION_DUST_CONVERT`, `ACTION_DEFI_WITHDRAW`, `ACTION_BRIDGE_SOLANA`, `ACTION_BURN_ZERO_LIQ`)
 *        - Protocol fee ceiling (`maxFeeBps` <= 1000 bps / 10%)
 *        - Minimum net output guard (`minNetOutBps`, preventing negative-ROI / high-haircut dust drains)
 *        - Mandate expiry (`expiresAt`) and instant owner `revokeMandate()`.
 */
contract SiphonAgentVault {
    uint8 public constant ACTION_DUST_CONVERT = 1 << 0;
    uint8 public constant ACTION_DEFI_WITHDRAW = 1 << 1;
    uint8 public constant ACTION_BRIDGE_SOLANA = 1 << 2;
    uint8 public constant ACTION_BURN_ZERO_LIQ = 1 << 3;
    uint8 public constant ALL_ACTIONS_MASK =
        ACTION_DUST_CONVERT | ACTION_DEFI_WITHDRAW | ACTION_BRIDGE_SOLANA | ACTION_BURN_ZERO_LIQ;
    uint16 public constant HARD_MAX_FEE_BPS = 1000; // 10.00%

    /// @notice Vault administrator authorized to configure the default Siphon execution router.
    address public vaultAdmin;
    address public pendingVaultAdmin;

    /// @notice Default approved execution router/delegate (SiphonRouter / SiphonSweepDelegate)
    ///         permitted to consume mandate budgets after verifying actual on-chain transfer amounts.
    address public authorizedRouter;

    /// @notice Allowlist of approved execution routers/delegates (supports both SiphonRouter & SiphonSweepDelegate).
    mapping(address => bool) public authorizedRouters;

    struct AgentMandate {
        address owner;
        address agentKey;
        address authorizedRouter;
        bytes32 lockedSolanaRecipient;
        uint256 maxPerTxUsd6;
        uint256 dailyCapUsd6;
        uint256 spentTodayUsd6;
        uint64 dayWindowStart;
        uint64 expiresAt;
        uint16 maxFeeBps;
        uint16 minNetOutBps;
        uint8 allowedActionsMask;
        bool active;
    }

    mapping(bytes32 => AgentMandate) public mandates;
    uint256 public mandateNonce;

    event AuthorizedRouterUpdated(address indexed previousRouter, address indexed newRouter);
    event AuthorizedRouterStatusUpdated(address indexed router, bool allowed);
    event MandateRouterUpdated(bytes32 indexed mandateId, address indexed owner, address indexed newRouter);
    event VaultAdminTransferStarted(address indexed currentAdmin, address indexed pendingAdmin);
    event VaultAdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    event MandateGranted(
        bytes32 indexed mandateId,
        address indexed owner,
        address indexed agentKey,
        address authorizedRouter,
        bytes32 lockedSolanaRecipient,
        uint256 maxPerTxUsd6,
        uint256 dailyCapUsd6,
        uint8 allowedActionsMask,
        uint64 expiresAt
    );

    event MandateRevoked(bytes32 indexed mandateId, address indexed owner);

    event AgentExecutionAuthorized(
        bytes32 indexed mandateId,
        address indexed router,
        address indexed agentKey,
        uint8 actionBit,
        uint256 grossUsd6,
        uint256 netOutUsd6,
        bytes32 intentDigest
    );

    error Unauthorized();
    error UnauthorizedRouter(address caller, address expectedRouter);
    error RouterNotConfigured();
    error InvalidActionBit(uint8 actionBit);
    error InvalidMandateParams();
    error MandateInactiveOrExpired();
    error ActionNotPermitted(uint8 actionBit);
    error ExceedsPerTxCap(uint256 requestedUsd6, uint256 maxPerTxUsd6);
    error ExceedsDailyCap(uint256 projectedDailyUsd6, uint256 dailyCapUsd6);
    error FeeAboveCap(uint16 feeBps, uint16 maxFeeBps);
    error NegativeOrLowRoiBlocked(uint256 netOutUsd6, uint256 minRequiredUsd6);
    error RecipientMismatch();

    constructor(address initialRouter) {
        if (initialRouter == address(0)) revert RouterNotConfigured();
        vaultAdmin = msg.sender;
        authorizedRouter = initialRouter;
        authorizedRouters[initialRouter] = true;
        emit AuthorizedRouterUpdated(address(0), initialRouter);
        emit AuthorizedRouterStatusUpdated(initialRouter, true);
    }

    modifier onlyVaultAdmin() {
        if (msg.sender != vaultAdmin) revert Unauthorized();
        _;
    }

    /// @notice Updates the default approved SiphonRouter / SiphonSweepDelegate contract.
    function setRouter(address newRouter) external onlyVaultAdmin {
        if (newRouter == address(0)) revert RouterNotConfigured();
        address prev = authorizedRouter;
        authorizedRouter = newRouter;
        authorizedRouters[newRouter] = true;
        emit AuthorizedRouterUpdated(prev, newRouter);
        emit AuthorizedRouterStatusUpdated(newRouter, true);
    }

    /// @notice Grants or revokes an additional authorized execution router or delegate contract.
    function setAuthorizedRouter(address router, bool allowed) external onlyVaultAdmin {
        if (router == address(0)) revert RouterNotConfigured();
        authorizedRouters[router] = allowed;
        emit AuthorizedRouterStatusUpdated(router, allowed);
    }

    /// @notice Returns the full AgentMandate struct for on-chain router/delegate verification.
    function getMandate(bytes32 mandateId) external view returns (AgentMandate memory) {
        return mandates[mandateId];
    }

    /// @notice Initiates two-step transfer of vault admin ownership.
    function transferVaultAdmin(address newAdmin) external onlyVaultAdmin {
        if (newAdmin == address(0)) revert InvalidMandateParams();
        pendingVaultAdmin = newAdmin;
        emit VaultAdminTransferStarted(vaultAdmin, newAdmin);
    }

    /// @notice Completes two-step transfer of vault admin ownership.
    function acceptVaultAdmin() external {
        if (msg.sender != pendingVaultAdmin) revert Unauthorized();
        address prev = vaultAdmin;
        vaultAdmin = msg.sender;
        pendingVaultAdmin = address(0);
        emit VaultAdminTransferred(prev, msg.sender);
    }

    function grantMandate(
        address agentKey,
        bytes32 lockedSolanaRecipient,
        uint256 maxPerTxUsd6,
        uint256 dailyCapUsd6,
        uint64 durationSeconds,
        uint16 maxFeeBps,
        uint16 minNetOutBps,
        uint8 allowedActionsMask
    ) external returns (bytes32 mandateId) {
        return
            grantMandateWithRouter(
                agentKey,
                authorizedRouter,
                lockedSolanaRecipient,
                maxPerTxUsd6,
                dailyCapUsd6,
                durationSeconds,
                maxFeeBps,
                minNetOutBps,
                allowedActionsMask
            );
    }

    function grantMandateWithRouter(
        address agentKey,
        address mandateRouter,
        bytes32 lockedSolanaRecipient,
        uint256 maxPerTxUsd6,
        uint256 dailyCapUsd6,
        uint64 durationSeconds,
        uint16 maxFeeBps,
        uint16 minNetOutBps,
        uint8 allowedActionsMask
    ) public returns (bytes32 mandateId) {
        if (mandateRouter == address(0)) revert RouterNotConfigured();
        if (mandateRouter != msg.sender && !authorizedRouters[mandateRouter]) {
            revert UnauthorizedRouter(mandateRouter, authorizedRouter);
        }
        if (
            agentKey == address(0) ||
            lockedSolanaRecipient == bytes32(0) ||
            maxPerTxUsd6 == 0 ||
            dailyCapUsd6 < maxPerTxUsd6 ||
            durationSeconds == 0 ||
            maxFeeBps > HARD_MAX_FEE_BPS ||
            minNetOutBps > 10_000 ||
            allowedActionsMask == 0 ||
            (allowedActionsMask & ~ALL_ACTIONS_MASK) != 0
        ) {
            revert InvalidMandateParams();
        }

        mandateId = keccak256(
            abi.encodePacked(msg.sender, agentKey, mandateRouter, lockedSolanaRecipient, ++mandateNonce, block.chainid)
        );
        uint64 expiresAt = uint64(block.timestamp) + durationSeconds;

        mandates[mandateId] = AgentMandate({
            owner: msg.sender,
            agentKey: agentKey,
            authorizedRouter: mandateRouter,
            lockedSolanaRecipient: lockedSolanaRecipient,
            maxPerTxUsd6: maxPerTxUsd6,
            dailyCapUsd6: dailyCapUsd6,
            spentTodayUsd6: 0,
            dayWindowStart: uint64(block.timestamp),
            expiresAt: expiresAt,
            maxFeeBps: maxFeeBps,
            minNetOutBps: minNetOutBps,
            allowedActionsMask: allowedActionsMask,
            active: true
        });

        emit MandateGranted(
            mandateId,
            msg.sender,
            agentKey,
            mandateRouter,
            lockedSolanaRecipient,
            maxPerTxUsd6,
            dailyCapUsd6,
            allowedActionsMask,
            expiresAt
        );
    }

    /// @notice Allows the mandate owner to pin or rotate the approved execution router/delegate for their mandate.
    function setMandateRouter(bytes32 mandateId, address newRouter) external {
        AgentMandate storage m = mandates[mandateId];
        if (m.owner != msg.sender) revert Unauthorized();
        if (newRouter == address(0)) revert RouterNotConfigured();
        if (newRouter != msg.sender && !authorizedRouters[newRouter]) {
            revert UnauthorizedRouter(newRouter, authorizedRouter);
        }
        m.authorizedRouter = newRouter;
        emit MandateRouterUpdated(mandateId, msg.sender, newRouter);
    }

    function revokeMandate(bytes32 mandateId) external {
        AgentMandate storage m = mandates[mandateId];
        if (m.owner != msg.sender) revert Unauthorized();
        m.active = false;
        emit MandateRevoked(mandateId, msg.sender);
    }

    /**
     * @notice Enforces all mandate guardrails and consumes rolling 24h budget.
     * @dev MUST ONLY be invoked by the owner-approved execution router/delegate (`m.authorizedRouter`)
     *      after verifying actual on-chain transfer amounts and post-swap USDC balance deltas,
     *      preventing agents from spoofing self-reported `grossUsd6`/`netOutUsd6` values.
     * @param mandateId        Unique mandate identifier.
     * @param agentCaller      The authenticated caller (agentKey or owner) verified by the router.
     * @param actionBit        Single power-of-two action flag (`actionBit != 0 && (actionBit & (actionBit - 1)) == 0`).
     * @param solanaRecipient  Destination bytes32 pubkey; must exactly match `lockedSolanaRecipient`.
     * @param grossUsd6        Actual router-measured input value in 6-decimal USD.
     * @param netOutUsd6       Actual router-measured net USDC output in 6-decimal USD.
     * @param feeBps           Applied protocol fee in basis points.
     * @param intentDigest     Keccak256 / SHA-256 execution digest for audit correlation.
     */
    function authorizeAgentAction(
        bytes32 mandateId,
        address agentCaller,
        uint8 actionBit,
        bytes32 solanaRecipient,
        uint256 grossUsd6,
        uint256 netOutUsd6,
        uint16 feeBps,
        bytes32 intentDigest
    ) external {
        // Enforce strict single-bit action validation so callers cannot pass 0 or combined bitmasks.
        if (actionBit == 0 || (actionBit & (actionBit - 1)) != 0 || (actionBit & ~ALL_ACTIONS_MASK) != 0) {
            revert InvalidActionBit(actionBit);
        }

        AgentMandate storage m = mandates[mandateId];
        if (!m.active || block.timestamp > m.expiresAt) revert MandateInactiveOrExpired();

        // Only the owner-approved execution router/delegate may consume mandate budget.
        // - If msg.sender == m.owner (EIP-7702 self-delegated EOA), allow ONLY when m.authorizedRouter == m.owner
        //   without ever adding EOAs to the global `authorizedRouters` allowlist.
        // - Otherwise require BOTH global router authorization (so revoking a compromised router immediately
        //   halts existing mandates too) AND matching the mandate's pinned/default router.
        address expectedRouter = m.authorizedRouter != address(0) ? m.authorizedRouter : authorizedRouter;
        if (expectedRouter == address(0)) revert RouterNotConfigured();
        bool callerAllowed;
        if (msg.sender == m.owner) {
            callerAllowed = (expectedRouter == m.owner);
        } else {
            callerAllowed = authorizedRouters[msg.sender] &&
                ((msg.sender == expectedRouter) || (m.authorizedRouter == authorizedRouter));
        }
        if (!callerAllowed) {
            if (msg.sender != expectedRouter) revert UnauthorizedRouter(msg.sender, expectedRouter);
            revert UnauthorizedRouter(msg.sender, expectedRouter);
        }

        if (agentCaller != m.agentKey && agentCaller != m.owner) revert Unauthorized();
        if (solanaRecipient != m.lockedSolanaRecipient) revert RecipientMismatch();
        if ((m.allowedActionsMask & actionBit) == 0) revert ActionNotPermitted(actionBit);
        if (feeBps > m.maxFeeBps) revert FeeAboveCap(feeBps, m.maxFeeBps);
        if (grossUsd6 == 0 || netOutUsd6 > grossUsd6) revert InvalidMandateParams();
        if (grossUsd6 > m.maxPerTxUsd6) revert ExceedsPerTxCap(grossUsd6, m.maxPerTxUsd6);

        uint256 minRequiredOut = (grossUsd6 * m.minNetOutBps) / 10_000;
        if (netOutUsd6 < minRequiredOut || netOutUsd6 == 0) {
            revert NegativeOrLowRoiBlocked(netOutUsd6, minRequiredOut);
        }

        if (block.timestamp >= uint256(m.dayWindowStart) + 1 days) {
            m.dayWindowStart = uint64(block.timestamp);
            m.spentTodayUsd6 = 0;
        }
        uint256 nextSpent = m.spentTodayUsd6 + grossUsd6;
        if (nextSpent > m.dailyCapUsd6) revert ExceedsDailyCap(nextSpent, m.dailyCapUsd6);
        m.spentTodayUsd6 = nextSpent;

        emit AgentExecutionAuthorized(
            mandateId,
            msg.sender,
            agentCaller,
            actionBit,
            grossUsd6,
            netOutUsd6,
            intentDigest
        );
    }
}
