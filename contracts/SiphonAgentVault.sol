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
 *   2. Every execution enforces:
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
    uint16 public constant HARD_MAX_FEE_BPS = 1000; // 10.00%

    struct AgentMandate {
        address owner;
        address agentKey;
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

    event MandateGranted(
        bytes32 indexed mandateId,
        address indexed owner,
        address indexed agentKey,
        bytes32 lockedSolanaRecipient,
        uint256 maxPerTxUsd6,
        uint256 dailyCapUsd6,
        uint8 allowedActionsMask,
        uint64 expiresAt
    );

    event MandateRevoked(bytes32 indexed mandateId, address indexed owner);

    event AgentExecutionAuthorized(
        bytes32 indexed mandateId,
        address indexed agentKey,
        uint8 actionBit,
        uint256 grossUsd6,
        uint256 netOutUsd6,
        bytes32 intentDigest
    );

    error Unauthorized();
    error InvalidMandateParams();
    error MandateInactiveOrExpired();
    error ActionNotPermitted(uint8 actionBit);
    error ExceedsPerTxCap(uint256 requestedUsd6, uint256 maxPerTxUsd6);
    error ExceedsDailyCap(uint256 projectedDailyUsd6, uint256 dailyCapUsd6);
    error FeeAboveCap(uint16 feeBps, uint16 maxFeeBps);
    error NegativeOrLowRoiBlocked(uint256 netOutUsd6, uint256 minRequiredUsd6);
    error RecipientMismatch();

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
        if (
            agentKey == address(0) ||
            lockedSolanaRecipient == bytes32(0) ||
            maxPerTxUsd6 == 0 ||
            dailyCapUsd6 < maxPerTxUsd6 ||
            durationSeconds == 0 ||
            maxFeeBps > HARD_MAX_FEE_BPS ||
            minNetOutBps > 10_000 ||
            allowedActionsMask == 0
        ) {
            revert InvalidMandateParams();
        }

        mandateId = keccak256(
            abi.encodePacked(msg.sender, agentKey, lockedSolanaRecipient, ++mandateNonce, block.chainid)
        );
        uint64 expiresAt = uint64(block.timestamp) + durationSeconds;

        mandates[mandateId] = AgentMandate({
            owner: msg.sender,
            agentKey: agentKey,
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
            lockedSolanaRecipient,
            maxPerTxUsd6,
            dailyCapUsd6,
            allowedActionsMask,
            expiresAt
        );
    }

    function revokeMandate(bytes32 mandateId) external {
        AgentMandate storage m = mandates[mandateId];
        if (m.owner != msg.sender) revert Unauthorized();
        m.active = false;
        emit MandateRevoked(mandateId, msg.sender);
    }

    /**
     * @notice Enforces all mandate guardrails before a SiphonRouter / SiphonSweepDelegate call executes.
     */
    function authorizeAgentAction(
        bytes32 mandateId,
        uint8 actionBit,
        bytes32 solanaRecipient,
        uint256 grossUsd6,
        uint256 netOutUsd6,
        uint16 feeBps,
        bytes32 intentDigest
    ) external {
        AgentMandate storage m = mandates[mandateId];
        if (!m.active || block.timestamp > m.expiresAt) revert MandateInactiveOrExpired();
        if (msg.sender != m.agentKey && msg.sender != m.owner) revert Unauthorized();
        if (solanaRecipient != m.lockedSolanaRecipient) revert RecipientMismatch();
        if ((m.allowedActionsMask & actionBit) == 0) revert ActionNotPermitted(actionBit);
        if (feeBps > m.maxFeeBps) revert FeeAboveCap(feeBps, m.maxFeeBps);
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

        emit AgentExecutionAuthorized(mandateId, msg.sender, actionBit, grossUsd6, netOutUsd6, intentDigest);
    }
}
