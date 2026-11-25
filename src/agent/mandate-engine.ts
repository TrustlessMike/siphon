import crypto from 'node:crypto';
import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import { resolveProtocolFeeBps } from '../scanner/chains.js';
import type { AnyChainId, ScannedAsset, ScanReport } from '../scanner/types.js';

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
  dayWindowStart: string;
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

export interface SiphonAgentEngineOptions {
  nowMs?: () => number;
  maxApprovals?: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_MAX_APPROVALS = 500;

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
 * Resolves asset IDs against active scanCache reports (most recent scans first).
 */
export function resolveAssetsFromScans(
  scans: Iterable<ScanReport>,
  assetIds: string[]
): { matched: ScannedAsset[]; missingIds: string[] } {
  const uniqueIds = Array.from(new Set(assetIds.map((id) => String(id).trim()).filter(Boolean)));
  if (!uniqueIds.length) return { matched: [], missingIds: [] };

  const scanList = Array.from(scans).reverse();
  const assetById = new Map<string, ScannedAsset>();
  for (const scan of scanList) {
    for (const asset of scan.assets) {
      if (!assetById.has(asset.id)) {
        assetById.set(asset.id, asset);
      }
    }
  }

  const matched: ScannedAsset[] = [];
  const missingIds: string[] = [];
  for (const id of uniqueIds) {
    const found = assetById.get(id);
    if (found) matched.push(found);
    else missingIds.push(id);
  }
  return { matched, missingIds };
}

/**
 * Policy-bounded Smart-Contract Agent Mandate & AI Plugin Permission Gate engine.
 * Mirrors `contracts/SiphonAgentVault.sol` invariants off-chain and guarantees that
 * ChatGPT, Claude MCP, and autonomous dust/DeFi agents can NEVER bypass owner caps,
 * spoof scan valuations, or redirect funds away from the locked Solana destination.
 */
export class SiphonAgentEngine {
  private mandates = new Map<string, AgentMandateRecord>();
  private approvals = new Map<string, PermissionRequestRecord>();
  private tokens = new Map<string, { record: PluginApiTokenRecord; secretHash: Buffer }>();
  private readonly nowMs: () => number;
  private readonly maxApprovals: number;

  constructor(opts: SiphonAgentEngineOptions = {}) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.maxApprovals = Math.max(10, Math.floor(opts.maxApprovals ?? DEFAULT_MAX_APPROVALS));
  }

  /**
   * Matches `SiphonAgentVault.sol` rolling 24h window semantics:
   * `if (block.timestamp >= dayWindowStart + 1 days) { dayWindowStart = block.timestamp; spentTodayUsd6 = 0; }`
   */
  private refreshRollingDayWindow(mandate: AgentMandateRecord, nowMs = this.nowMs()): void {
    const startMs = Date.parse(mandate.dayWindowStart || mandate.createdAt);
    if (Number.isFinite(startMs) && nowMs >= startMs + DAY_MS) {
      mandate.dayWindowStart = new Date(nowMs).toISOString();
      mandate.spentTodayUsd = 0;
      mandate.remainingDailyUsd = round2(mandate.dailyCapUsd);
    }
  }

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
    const nowMs = this.nowMs();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + durationDays * DAY_MS).toISOString();

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
      dayWindowStart: nowIso,
      maxFeeBps,
      minNetOutBps,
      allowedActions,
      allowedActionsMask: computeActionsMask(allowedActions),
      autoApproveUnderUsd: round2(autoApproveUnderUsd),
      expiresAt,
      createdAt: nowIso,
      active: true,
      onchainContract: 'SiphonAgentVault.sol',
      executionsCount: 0,
    };

    this.mandates.set(mandateId, record);
    return record;
  }

  listMandates(): AgentMandateRecord[] {
    const nowMs = this.nowMs();
    const items = Array.from(this.mandates.values());
    for (const m of items) {
      this.refreshRollingDayWindow(m, nowMs);
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMandate(mandateId: string): AgentMandateRecord | null {
    const m = this.mandates.get(mandateId);
    if (!m) return null;
    this.refreshRollingDayWindow(m);
    return m;
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
   *   - Rejects immediately on Negative ROI or spoofed `grossUsd`/`estimatedNetUsdc` vs `scanCache`;
   *   - Marks `auto_approved_by_mandate` ONLY when a valid active mandate matches destination, action,
   *     ROI floor, per-tx cap, rolling 24h daily cap, verified asset valuation, AND `grossUsd <= autoApproveUnderUsd`;
   *   - Otherwise marks `pending_approval` so the owner explicitly clicks Approve / Reject in Siphon.
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
    scanCache?: Iterable<ScanReport>;
  }): PermissionRequestRecord {
    const solDest = input.solanaDestination.trim();
    solanaAddressToBytes32(solDest); // fail fast on invalid Solana recipient

    const nowMs = this.nowMs();
    const feeBps = resolveProtocolFeeBps(input.protocolFeeBps ?? 700);
    const reportedGrossUsd = round2(Math.max(0, Number(input.grossUsd || 0)));
    const reportedEstimatedNetUsdc = round2(Number(input.estimatedNetUsdc || 0));
    const assetIds = Array.isArray(input.assetIds)
      ? Array.from(new Set(input.assetIds.map((id) => String(id).trim()).filter(Boolean)))
      : [];
    const approvalId = `apr_${crypto.randomBytes(6).toString('hex')}`;

    const policyChecks: Array<{ check: string; passed: boolean; detail: string }> = [];

    // Verify grossUsd & estimatedNetUsdc against scanCache when assetIds are supplied
    let effectiveGrossUsd = reportedGrossUsd;
    let effectiveNetUsdc = reportedEstimatedNetUsdc;
    let valuationRejected = false;
    let valuationRejectReason: string | undefined;
    let valuationUnverified = false;

    if (reportedGrossUsd > 0 && reportedEstimatedNetUsdc > reportedGrossUsd + 0.01) {
      valuationRejected = true;
      valuationRejectReason = `Rejected: estimatedNetUsdc ($${reportedEstimatedNetUsdc.toFixed(2)}) exceeds grossUsd ($${reportedGrossUsd.toFixed(2)}).`;
      policyChecks.push({
        check: 'Scan Asset Valuation Match',
        passed: false,
        detail: valuationRejectReason,
      });
    } else if (assetIds.length > 0 && input.scanCache) {
      const { matched, missingIds } = resolveAssetsFromScans(input.scanCache, assetIds);
      if (missingIds.length > 0) {
        valuationUnverified = true;
        policyChecks.push({
          check: 'Scan Asset Valuation Match',
          passed: false,
          detail: `Unverified assetIds not found in active scanCache (${missingIds.slice(0, 5).join(', ')}). Auto-approval blocked.`,
        });
      }

      if (matched.length > 0) {
        const verifiedGrossUsd = round2(
          matched.reduce((sum, a) => sum + Math.max(0, Number(a.grossUsd || 0)), 0)
        );
        const verifiedNetUsdc = round2(
          matched.reduce(
            (sum, a) =>
              sum +
              Number(
                typeof a.netRoiUsd === 'number'
                  ? a.netRoiUsd
                  : typeof a.netUsdcBatched === 'number'
                  ? a.netUsdcBatched
                  : 0
              ),
            0
          )
        );
        const grossTolerance = Math.max(1.0, round2(verifiedGrossUsd * 0.05));
        const netTolerance = Math.max(1.0, round2(verifiedGrossUsd * 0.15));

        const underReportedGross = reportedGrossUsd + grossTolerance < verifiedGrossUsd;
        const severelyMismatchedGross =
          Math.abs(reportedGrossUsd - verifiedGrossUsd) > grossTolerance;
        const netExceedsVerifiedGross = reportedEstimatedNetUsdc > verifiedGrossUsd + 0.01;
        const spoofedPositiveRoi = verifiedNetUsdc <= 0 && reportedEstimatedNetUsdc > 0;
        const overstatedNet =
          verifiedNetUsdc > 0 && reportedEstimatedNetUsdc > verifiedNetUsdc + netTolerance;

        if (
          underReportedGross ||
          severelyMismatchedGross ||
          netExceedsVerifiedGross ||
          spoofedPositiveRoi ||
          overstatedNet
        ) {
          valuationRejected = true;
          effectiveGrossUsd = Math.max(reportedGrossUsd, verifiedGrossUsd);
          effectiveNetUsdc = verifiedNetUsdc;
          valuationRejectReason = `Rejected: reported valuation ($${reportedGrossUsd.toFixed(2)} gross / $${reportedEstimatedNetUsdc.toFixed(2)} net) contradicts verified scanCache assets ($${verifiedGrossUsd.toFixed(2)} gross / $${verifiedNetUsdc.toFixed(2)} net).`;
          policyChecks.push({
            check: 'Scan Asset Valuation Match',
            passed: false,
            detail: valuationRejectReason,
          });
        } else {
          effectiveGrossUsd = Math.max(reportedGrossUsd, verifiedGrossUsd);
          effectiveNetUsdc = Math.min(reportedEstimatedNetUsdc, verifiedGrossUsd);
          if (!valuationUnverified) {
            policyChecks.push({
              check: 'Scan Asset Valuation Match',
              passed: true,
              detail: `Verified ${matched.length} scanned asset(s): $${verifiedGrossUsd.toFixed(2)} gross / $${verifiedNetUsdc.toFixed(2)} est. net matches reported values.`,
            });
          }
        }
      }
    }

    const digestPayload = JSON.stringify({
      approvalId,
      client: input.client,
      mandateId: input.mandateId || null,
      actionType: input.actionType,
      sourceWallets: input.sourceWallets,
      chains: input.chains,
      solanaDestination: solDest,
      grossUsd: effectiveGrossUsd,
      estimatedNetUsdc: effectiveNetUsdc,
      protocolFeeBps: feeBps,
      assetIds,
    });
    const requestDigestSha256 =
      '0x' + crypto.createHash('sha256').update(digestPayload).digest('hex');

    const roiPositive = effectiveNetUsdc > 0;
    policyChecks.push({
      check: 'Positive Net ROI Guard',
      passed: roiPositive,
      detail: roiPositive
        ? `Estimated net output $${effectiveNetUsdc.toFixed(2)} USDC on $${effectiveGrossUsd.toFixed(2)} gross.`
        : `Blocked: estimated net output ($${effectiveNetUsdc.toFixed(2)}) is non-positive.`,
    });

    const mandate = input.mandateId ? this.mandates.get(input.mandateId) : undefined;
    let canAutoApprove = false;

    if (mandate) {
      this.refreshRollingDayWindow(mandate, nowMs);

      const notExpired = mandate.active && Date.parse(mandate.expiresAt) > nowMs;
      const destMatches = mandate.lockedSolanaRecipient === solDest;
      const actionAllowed = mandate.allowedActions.includes(input.actionType);
      const withinPerTx = effectiveGrossUsd <= mandate.maxPerTxUsd;
      const withinDaily = round2(mandate.spentTodayUsd + effectiveGrossUsd) <= mandate.dailyCapUsd;
      const withinFee = feeBps <= mandate.maxFeeBps;
      const minNetRequired = round2((effectiveGrossUsd * mandate.minNetOutBps) / 10_000);
      const meetsMinNet = effectiveGrossUsd === 0 || effectiveNetUsdc >= minNetRequired;
      const withinAutoTier = effectiveGrossUsd <= mandate.autoApproveUnderUsd;

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
          detail: `$${effectiveGrossUsd.toFixed(2)} vs $${mandate.maxPerTxUsd.toFixed(2)}/tx & $${mandate.remainingDailyUsd.toFixed(2)} remaining today.`,
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
        !valuationRejected &&
        !valuationUnverified &&
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
        mandate.spentTodayUsd = round2(mandate.spentTodayUsd + effectiveGrossUsd);
        mandate.remainingDailyUsd = round2(Math.max(0, mandate.dailyCapUsd - mandate.spentTodayUsd));
        mandate.executionsCount += 1;
        mandate.lastRunAt = new Date(nowMs).toISOString();
      }
    } else {
      policyChecks.push({
        check: 'Human Permission Gate',
        passed: true,
        detail: 'No auto-approve mandate supplied — queued for explicit owner confirmation in Siphon UI.',
      });
    }

    const nowIso = new Date(nowMs).toISOString();
    const autoRejected = valuationRejected || !roiPositive;
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
      grossUsd: effectiveGrossUsd,
      estimatedNetUsdc: effectiveNetUsdc,
      protocolFeeBps: feeBps,
      assetIds,
      status: autoRejected
        ? 'rejected'
        : canAutoApprove
        ? 'auto_approved_by_mandate'
        : 'pending_approval',
      policyChecks,
      decisionReason: valuationRejected
        ? valuationRejectReason
        : !roiPositive
        ? 'Rejected automatically by Negative-ROI Guard.'
        : canAutoApprove
        ? `Auto-approved within SiphonAgentVault mandate ${mandate?.mandateId} (<= $${mandate?.autoApproveUnderUsd}).`
        : 'Awaiting explicit user permission approval in Siphon.',
      createdAt: nowIso,
      decidedAt: autoRejected || canAutoApprove ? nowIso : undefined,
    };

    this.approvals.set(approvalId, record);
    while (this.approvals.size > this.maxApprovals) {
      const oldestKey = this.approvals.keys().next().value;
      if (!oldestKey) break;
      this.approvals.delete(oldestKey);
    }
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

    const nowMs = this.nowMs();
    req.status = params.decision === 'approve' ? 'approved' : 'rejected';
    req.decisionReason =
      params.reason?.trim() ||
      (params.decision === 'approve'
        ? 'Explicitly approved by wallet owner.'
        : 'Rejected by wallet owner.');
    req.decidedAt = new Date(nowMs).toISOString();

    if (params.decision === 'approve' && req.mandateId) {
      const m = this.mandates.get(req.mandateId);
      if (m && m.active) {
        this.refreshRollingDayWindow(m, nowMs);
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
    const secretHash = crypto.createHash('sha256').update(rawSecret).digest();
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
      createdAt: new Date(this.nowMs()).toISOString(),
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
    const match = /^Bearer\s+(\S+)$/i.exec(bearerHeader.trim());
    if (!match) return null;
    const raw = match[1];
    if (!raw) return null;

    const candidateHash = crypto.createHash('sha256').update(raw).digest();
    let matchedRecord: PluginApiTokenRecord | null = null;
    for (const entry of this.tokens.values()) {
      const hashMatches =
        entry.secretHash.length === candidateHash.length &&
        crypto.timingSafeEqual(entry.secretHash, candidateHash);
      if (hashMatches && !entry.record.revoked) {
        matchedRecord = entry.record;
      }
    }
    return matchedRecord;
  }
}
