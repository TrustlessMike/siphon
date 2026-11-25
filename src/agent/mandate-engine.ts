import crypto from 'node:crypto';
import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import { resolveProtocolFeeBps } from '../scanner/chains.js';
import type { AnyChainId } from '../scanner/types.js';

export type AgentActionType =
  | 'dust_convert'
  | 'defi_withdraw'
  | 'bridge_solana'
  | 'burn_zero_liq';

export type PluginClientKind = 'claude_mcp' | 'chatgpt_action' | 'smart_contract_agent' | 'ui';

export interface AgentMandateRecord {
  mandateId: string;
  name: string;
  ownerAddress: string;
  agentKey: string;
  lockedSolanaRecipient: string;
  lockedSolanaRecipientBytes32: string;
  maxPerTxUsd: number;
  dailyCapUsd: number;
  spentTodayUsd: number;
  remainingDailyUsd: number;
  maxFeeBps: number;
  minNetOutBps: number;
  allowedActions: AgentActionType[];
  allowedActionsMask: number;
  autoApproveUnderUsd: number;
  expiresAt: string;
  createdAt: string;
  active: boolean;
  onchainContract: 'SiphonAgentVault.sol';
  lastRunAt?: string;
  executionsCount: number;
}

export interface PermissionRequestRecord {
  approvalId: string;
  requestDigestSha256: string;
  client: PluginClientKind;
  mandateId?: string;
  actionType: AgentActionType;
  summary: string;
  sourceWallets: string[];
  chains: AnyChainId[];
  solanaDestination: string;
  grossUsd: number;
  estimatedNetUsdc: number;
  protocolFeeBps: number;
  assetIds: string[];
  status: 'pending_approval' | 'approved' | 'auto_approved_by_mandate' | 'rejected' | 'executed';
  policyChecks: Array<{ check: string; passed: boolean; detail: string }>;
  decisionReason?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface PluginApiTokenRecord {
  tokenId: string;
  label: string;
  client: 'claude_mcp' | 'chatgpt_action';
  scopes: string[];
  tokenPreview: string;
  createdAt: string;
  revoked: boolean;
}

const ACTION_BITS: Record<AgentActionType, number> = {
  dust_convert: 1 << 0,
  defi_withdraw: 1 << 1,
  bridge_solana: 1 << 2,
  burn_zero_liq: 1 << 3,
};

function round2(n: number): number {
  return Number(n.toFixed(2));
}

export function computeActionsMask(actions: AgentActionType[]): number {
  return actions.reduce((mask, a) => mask | (ACTION_BITS[a] ?? 0), 0);
}

/**
 * Policy-bounded Smart-Contract Agent Mandate & AI Plugin Permission Gate engine.
 * Mirrors `contracts/SiphonAgentVault.sol` invariants off-chain and guarantees that
 * ChatGPT, Claude MCP, and autonomous dust/DeFi agents can NEVER bypass owner caps
 * or redirect funds away from the locked Solana destination.
 */
export class SiphonAgentEngine {
  private mandates = new Map<string, AgentMandateRecord>();
  private approvals = new Map<string, PermissionRequestRecord>();
  private tokens = new Map<string, { record: PluginApiTokenRecord; secretHash: string }>();

  createMandate(input: {
    name?: string;
    ownerAddress: string;
    agentKey?: string;
    lockedSolanaRecipient: string;
    maxPerTxUsd?: number;
    dailyCapUsd?: number;
    autoApproveUnderUsd?: number;
    durationDays?: number;
    maxFeeBps?: number;
    minNetOutBps?: number;
    allowedActions?: AgentActionType[];
  }): AgentMandateRecord {
    const ownerAddress = input.ownerAddress.trim();
    const solDest = input.lockedSolanaRecipient.trim();
    const lockedSolanaRecipientBytes32 = solanaAddressToBytes32(solDest); // validates base58 Ed25519 key

    const maxPerTxUsd = Math.max(5, Math.min(100_000, Number(input.maxPerTxUsd ?? 250)));
    const dailyCapUsd = Math.max(maxPerTxUsd, Math.min(500_000, Number(input.dailyCapUsd ?? 1000)));
    const autoApproveUnderUsd = Math.max(
      0,
      Math.min(maxPerTxUsd, Number(input.autoApproveUnderUsd ?? 50))
    );
    const maxFeeBps = resolveProtocolFeeBps(input.maxFeeBps ?? 700);
    const minNetOutBps = Math.max(5000, Math.min(9500, Math.round(Number(input.minNetOutBps ?? 7000))));
    const durationDays = Math.max(1, Math.min(365, Number(input.durationDays ?? 30)));
    const allowedActions: AgentActionType[] =
      input.allowedActions?.length
        ? Array.from(new Set(input.allowedActions))
        : ['dust_convert', 'defi_withdraw', 'bridge_solana'];

    const mandateId = `mnd_${crypto.randomBytes(6).toString('hex')}`;
    const agentKey =
      input.agentKey?.trim() ||
      `0x${crypto.createHash('sha256').update(mandateId).digest('hex').slice(0, 40)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 86_400_000).toISOString();

    const record: AgentMandateRecord = {
      mandateId,
      name: input.name?.trim() || 'Dust & DeFi Auto-Sweep Agent',
      ownerAddress,
      agentKey,
      lockedSolanaRecipient: solDest,
      lockedSolanaRecipientBytes32,
      maxPerTxUsd: round2(maxPerTxUsd),
      dailyCapUsd: round2(dailyCapUsd),
      spentTodayUsd: 0,
      remainingDailyUsd: round2(dailyCapUsd),
      maxFeeBps,
      minNetOutBps,
      allowedActions,
      allowedActionsMask: computeActionsMask(allowedActions),
      autoApproveUnderUsd: round2(autoApproveUnderUsd),
      expiresAt,
      createdAt: now.toISOString(),
      active: true,
      onchainContract: 'SiphonAgentVault.sol',
      executionsCount: 0,
    };

    this.mandates.set(mandateId, record);
    return record;
  }

  listMandates(): AgentMandateRecord[] {
    return Array.from(this.mandates.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  getMandate(mandateId: string): AgentMandateRecord | null {
    return this.mandates.get(mandateId) ?? null;
  }

  revokeMandate(mandateId: string): AgentMandateRecord | null {
    const m = this.mandates.get(mandateId);
    if (!m) return null;
    m.active = false;
    return m;
  }

  /**
   * Proposes a value-moving action from Claude MCP, ChatGPT Action, or a Smart-Contract Agent.
   * Evaluates every SiphonAgentVault policy check and either:
   *   - Marks `auto_approved_by_mandate` ONLY when a valid active mandate matches destination, action,
   *     ROI floor, per-tx cap, daily cap, AND `grossUsd <= autoApproveUnderUsd`;
   *   - Otherwise marks `pending_approval` so Malik explicitly clicks Approve / Reject in Siphon!
   */
  requestPermission(input: {
    client: PluginClientKind;
    mandateId?: string;
    actionType: AgentActionType;
    summary: string;
    sourceWallets: string[];
    chains: AnyChainId[];
    solanaDestination: string;
    grossUsd: number;
    estimatedNetUsdc: number;
    protocolFeeBps?: number;
    assetIds?: string[];
  }): PermissionRequestRecord {
    const solDest = input.solanaDestination.trim();
    solanaAddressToBytes32(solDest); // fail fast on invalid Solana recipient

    const feeBps = resolveProtocolFeeBps(input.protocolFeeBps ?? 700);
    const grossUsd = round2(Math.max(0, Number(input.grossUsd || 0)));
    const estimatedNetUsdc = round2(Number(input.estimatedNetUsdc || 0));
    const approvalId = `apr_${crypto.randomBytes(6).toString('hex')}`;

    const digestPayload = JSON.stringify({
      approvalId,
      client: input.client,
      mandateId: input.mandateId || null,
      actionType: input.actionType,
      sourceWallets: input.sourceWallets,
      chains: input.chains,
      solanaDestination: solDest,
      grossUsd,
      estimatedNetUsdc,
      protocolFeeBps: feeBps,
      assetIds: input.assetIds ?? [],
    });
    const requestDigestSha256 =
      '0x' + crypto.createHash('sha256').update(digestPayload).digest('hex');

    const policyChecks: Array<{ check: string; passed: boolean; detail: string }> = [];
    const roiPositive = estimatedNetUsdc > 0;
    policyChecks.push({
      check: 'Positive Net ROI Guard',
      passed: roiPositive,
      detail: roiPositive
        ? `Estimated net output $${estimatedNetUsdc.toFixed(2)} USDC on $${grossUsd.toFixed(2)} gross.`
        : `Blocked: estimated net output ($${estimatedNetUsdc.toFixed(2)}) is non-positive.`,
    });

    const mandate = input.mandateId ? this.mandates.get(input.mandateId) : undefined;
    let canAutoApprove = false;

    if (mandate) {
      const notExpired = mandate.active && Date.parse(mandate.expiresAt) > Date.now();
      const destMatches = mandate.lockedSolanaRecipient === solDest;
      const actionAllowed = mandate.allowedActions.includes(input.actionType);
      const withinPerTx = grossUsd <= mandate.maxPerTxUsd;
      const withinDaily = mandate.spentTodayUsd + grossUsd <= mandate.dailyCapUsd;
      const withinFee = feeBps <= mandate.maxFeeBps;
      const minNetRequired = round2((grossUsd * mandate.minNetOutBps) / 10_000);
      const meetsMinNet = grossUsd === 0 || estimatedNetUsdc >= minNetRequired;
      const withinAutoTier = grossUsd <= mandate.autoApproveUnderUsd;

      policyChecks.push(
        {
          check: 'Mandate Active & Unexpired',
          passed: notExpired,
          detail: notExpired ? `Expires ${mandate.expiresAt}` : 'Mandate revoked or expired.',
        },
        {
          check: 'Locked Solana Recipient Match',
          passed: destMatches,
          detail: destMatches
            ? `Matches locked recipient ${mandate.lockedSolanaRecipient.slice(0, 8)}…`
            : 'Destination differs from immutable mandate recipient!',
        },
        {
          check: 'Action Scope Permitted',
          passed: actionAllowed,
          detail: actionAllowed
            ? `Action '${input.actionType}' allowed by mandate mask 0x${mandate.allowedActionsMask.toString(16)}.`
            : `Action '${input.actionType}' not permitted by mandate.`,
        },
        {
          check: 'Per-Tx & Daily Cap',
          passed: withinPerTx && withinDaily,
          detail: `$${grossUsd.toFixed(2)} vs $${mandate.maxPerTxUsd.toFixed(2)}/tx & $${mandate.remainingDailyUsd.toFixed(2)} remaining today.`,
        },
        {
          check: 'Auto-Approve Threshold',
          passed: withinAutoTier,
          detail: withinAutoTier
            ? `Within $${mandate.autoApproveUnderUsd.toFixed(2)} autonomous tier.`
            : `Above $${mandate.autoApproveUnderUsd.toFixed(2)} autonomous tier — requires explicit human approval.`,
        }
      );

      canAutoApprove =
        roiPositive &&
        notExpired &&
        destMatches &&
        actionAllowed &&
        withinPerTx &&
        withinDaily &&
        withinFee &&
        meetsMinNet &&
        withinAutoTier;

      if (canAutoApprove) {
        mandate.spentTodayUsd = round2(mandate.spentTodayUsd + grossUsd);
        mandate.remainingDailyUsd = round2(Math.max(0, mandate.dailyCapUsd - mandate.spentTodayUsd));
        mandate.executionsCount += 1;
        mandate.lastRunAt = new Date().toISOString();
      }
    } else {
      policyChecks.push({
        check: 'Human Permission Gate',
        passed: true,
        detail: 'No auto-approve mandate supplied — queued for explicit owner confirmation in Siphon UI.',
      });
    }

    const nowIso = new Date().toISOString();
    const record: PermissionRequestRecord = {
      approvalId,
      requestDigestSha256,
      client: input.client,
      mandateId: mandate?.mandateId,
      actionType: input.actionType,
      summary: input.summary,
      sourceWallets: input.sourceWallets,
      chains: input.chains,
      solanaDestination: solDest,
      grossUsd,
      estimatedNetUsdc,
      protocolFeeBps: feeBps,
      assetIds: input.assetIds ?? [],
      status: !roiPositive
        ? 'rejected'
        : canAutoApprove
        ? 'auto_approved_by_mandate'
        : 'pending_approval',
      policyChecks,
      decisionReason: !roiPositive
        ? 'Rejected automatically by Negative-ROI Guard.'
        : canAutoApprove
        ? `Auto-approved within SiphonAgentVault mandate ${mandate?.mandateId} (<= $${mandate?.autoApproveUnderUsd}).`
        : 'Awaiting explicit user permission approval in Siphon.',
      createdAt: nowIso,
      decidedAt: !roiPositive || canAutoApprove ? nowIso : undefined,
    };

    this.approvals.set(approvalId, record);
    return record;
  }

  listApprovals(): PermissionRequestRecord[] {
    return Array.from(this.approvals.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt)
    );
  }

  getApproval(approvalId: string): PermissionRequestRecord | null {
    return this.approvals.get(approvalId) ?? null;
  }

  decideApproval(params: {
    approvalId: string;
    decision: 'approve' | 'reject';
    reason?: string;
  }): PermissionRequestRecord | null {
    const req = this.approvals.get(params.approvalId);
    if (!req) return null;
    if (req.status !== 'pending_approval') return req;

    req.status = params.decision === 'approve' ? 'approved' : 'rejected';
    req.decisionReason =
      params.reason?.trim() ||
      (params.decision === 'approve'
        ? 'Explicitly approved by wallet owner.'
        : 'Rejected by wallet owner.');
    req.decidedAt = new Date().toISOString();

    if (params.decision === 'approve' && req.mandateId) {
      const m = this.mandates.get(req.mandateId);
      if (m && m.active) {
        m.spentTodayUsd = round2(m.spentTodayUsd + req.grossUsd);
        m.remainingDailyUsd = round2(Math.max(0, m.dailyCapUsd - m.spentTodayUsd));
        m.executionsCount += 1;
        m.lastRunAt = req.decidedAt;
      }
    }
    return req;
  }

  issuePluginToken(params: {
    label: string;
    client: 'claude_mcp' | 'chatgpt_action';
    scopes?: string[];
  }): { token: string; record: PluginApiTokenRecord } {
    const tokenId = `tok_${crypto.randomBytes(4).toString('hex')}`;
    const rawSecret = `siphon_${params.client === 'chatgpt_action' ? 'gpt' : 'mcp'}_${crypto.randomBytes(18).toString('hex')}`;
    const secretHash = crypto.createHash('sha256').update(rawSecret).digest('hex');
    const scopes =
      params.scopes?.length
        ? params.scopes
        : ['scan:read', 'dust:plan', 'proof:simulate', 'agent:propose'];

    const record: PluginApiTokenRecord = {
      tokenId,
      label: params.label.trim() || (params.client === 'chatgpt_action' ? 'ChatGPT Action' : 'Claude MCP'),
      client: params.client,
      scopes,
      tokenPreview: `${rawSecret.slice(0, 14)}…${rawSecret.slice(-4)}`,
      createdAt: new Date().toISOString(),
      revoked: false,
    };

    this.tokens.set(tokenId, { record, secretHash });
    return { token: rawSecret, record };
  }

  listPluginTokens(): PluginApiTokenRecord[] {
    return Array.from(this.tokens.values()).map((t) => t.record);
  }

  revokePluginToken(tokenId: string): PluginApiTokenRecord | null {
    const entry = this.tokens.get(tokenId);
    if (!entry) return null;
    entry.record.revoked = true;
    return entry.record;
  }

  verifyPluginToken(bearerHeader?: string | null): PluginApiTokenRecord | null {
    if (!bearerHeader) return null;
    const raw = bearerHeader.replace(/^Bearer\s+/i, '').trim();
    if (!raw) return null;
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    for (const entry of this.tokens.values()) {
      if (!entry.record.revoked && entry.secretHash === hash) {
        return entry.record;
      }
    }
    return null;
  }
}
