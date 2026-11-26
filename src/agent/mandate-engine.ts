import crypto from 'node:crypto';
import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import { resolveProtocolFeeBps } from '../scanner/chains.js';
import { sanitizeFreeText } from '../scanner/sanitize.js';
import type { AnyChainId, ScannedAsset, ScanReport } from '../scanner/types.js';
import type { TurgaliumStateStore } from '../storage/state-store.js';

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
  onchainContract: 'TurgaliumAgentVault.sol';
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
  expiresAt: string;
  decidedAt?: string;
}

export interface PluginApiTokenRecord {
  tokenId: string;
  label: string;
  client: 'claude_mcp' | 'chatgpt_action';
  scopes: string[];
  tokenPreview: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

export interface TurgaliumAgentEngineOptions {
  nowMs?: () => number;
  maxMandates?: number;
  maxApprovals?: number;
  maxTokens?: number;
  approvalTtlMs?: number;
  tokenTtlMs?: number;
  stateStore?: TurgaliumStateStore;
}

const DAY_MS = 86_400_000;
const DEFAULT_MAX_MANDATES = 200;
const DEFAULT_MAX_APPROVALS = 500;
const DEFAULT_MAX_TOKENS = 200;
const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_TOKEN_TTL_MS = 30 * DAY_MS; // 30 days

const ACTION_BITS: Record<AgentActionType, number> = {
  dust_convert: 1 << 0,
  defi_withdraw: 1 << 1,
  bridge_solana: 1 << 2,
  burn_zero_liq: 1 << 3,
};

const VALID_ACTION_TYPES = new Set<string>(Object.keys(ACTION_BITS));

function isAgentActionType(val: unknown): val is AgentActionType {
  return typeof val === 'string' && VALID_ACTION_TYPES.has(val);
}

function assertFiniteNumber(raw: unknown, field: string): number {
  if (typeof raw === 'boolean' || raw === null || raw === '') {
    throw new Error(`Invalid numeric value for ${field}: expected a finite number.`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value for ${field}: must be a finite number (NaN/Infinity rejected).`);
  }
  return n;
}

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
 * Mirrors `contracts/TurgaliumAgentVault.sol` invariants off-chain and guarantees that
 * ChatGPT, Claude MCP, and autonomous dust/DeFi agents can NEVER bypass owner caps,
 * spoof scan valuations, brick quotas via Infinity/NaN, or redirect funds away from
 * the locked Solana destination.
 */
export class TurgaliumAgentEngine {
  private mandates = new Map<string, AgentMandateRecord>();
  private approvals = new Map<string, PermissionRequestRecord>();
  private tokens = new Map<string, { record: PluginApiTokenRecord; secretHash: Buffer }>();
  private readonly nowMs: () => number;
  private readonly maxMandates: number;
  private readonly maxApprovals: number;
  private readonly maxTokens: number;
  private readonly approvalTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly stateStore?: TurgaliumStateStore;

  constructor(opts: TurgaliumAgentEngineOptions = {}) {
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.maxMandates = Math.max(10, Math.floor(opts.maxMandates ?? DEFAULT_MAX_MANDATES));
    this.maxApprovals = Math.max(10, Math.floor(opts.maxApprovals ?? DEFAULT_MAX_APPROVALS));
    this.maxTokens = Math.max(10, Math.floor(opts.maxTokens ?? DEFAULT_MAX_TOKENS));
    this.approvalTtlMs = Math.max(60_000, Math.floor(opts.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS));
    this.tokenTtlMs = Math.max(60_000, Math.floor(opts.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS));
    this.stateStore = opts.stateStore;
    if (this.stateStore) {
      this.hydrateFromStore();
    }
  }

  private hydrateFromStore(): void {
    if (!this.stateStore) return;
    const savedMandates = this.stateStore.load<AgentMandateRecord[]>('mandates', []);
    if (Array.isArray(savedMandates)) {
      for (const m of savedMandates) {
        if (m && typeof m === 'object' && typeof m.mandateId === 'string') {
          this.mandates.set(m.mandateId, m);
        }
      }
    }

    const savedApprovals = this.stateStore.load<PermissionRequestRecord[]>('approvals', []);
    if (Array.isArray(savedApprovals)) {
      for (const a of savedApprovals) {
        if (a && typeof a === 'object' && typeof a.approvalId === 'string') {
          this.approvals.set(a.approvalId, a);
        }
      }
    }

    const savedTokens = this.stateStore.load<
      Array<{ record: PluginApiTokenRecord; secretHashHex: string }>
    >('plugin_tokens', []);
    if (Array.isArray(savedTokens)) {
      for (const t of savedTokens) {
        if (
          t &&
          typeof t === 'object' &&
          t.record &&
          typeof t.record.tokenId === 'string' &&
          typeof t.secretHashHex === 'string' &&
          /^[0-9a-fA-F]{64}$/.test(t.secretHashHex)
        ) {
          this.tokens.set(t.record.tokenId, {
            record: t.record,
            secretHash: Buffer.from(t.secretHashHex, 'hex'),
          });
        }
      }
    }
  }

  private persistMandates(): void {
    if (!this.stateStore) return;
    this.stateStore.save('mandates', Array.from(this.mandates.values()));
  }

  private persistApprovals(): void {
    if (!this.stateStore) return;
    this.stateStore.save('approvals', Array.from(this.approvals.values()));
  }

  private persistTokens(): void {
    if (!this.stateStore) return;
    const serialized = Array.from(this.tokens.values()).map((entry) => ({
      record: entry.record,
      secretHashHex: entry.secretHash.toString('hex'),
    }));
    this.stateStore.save('plugin_tokens', serialized);
  }

  /**
   * Matches `TurgaliumAgentVault.sol` rolling 24h window semantics:
   * `if (block.timestamp >= dayWindowStart + 1 days) { dayWindowStart = block.timestamp; spentTodayUsd6 = 0; }`
   */
  private refreshRollingDayWindow(mandate: AgentMandateRecord, nowMs = this.nowMs()): boolean {
    const startMs = Date.parse(mandate.dayWindowStart || mandate.createdAt);
    if (Number.isFinite(startMs) && nowMs >= startMs + DAY_MS) {
      mandate.dayWindowStart = new Date(nowMs).toISOString();
      mandate.spentTodayUsd = 0;
      mandate.remainingDailyUsd = round2(mandate.dailyCapUsd);
      return true;
    }
    return false;
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
    if (typeof input.ownerAddress !== 'string' || !input.ownerAddress.trim()) {
      throw new Error('ownerAddress must be a non-empty string.');
    }
    if (typeof input.lockedSolanaRecipient !== 'string' || !input.lockedSolanaRecipient.trim()) {
      throw new Error('lockedSolanaRecipient must be a non-empty string.');
    }

    const ownerAddress = input.ownerAddress.trim().slice(0, 128);
    const solDest = input.lockedSolanaRecipient.trim();
    const lockedSolanaRecipientBytes32 = solanaAddressToBytes32(solDest); // validates base58 Ed25519 key

    const rawMaxPerTx =
      input.maxPerTxUsd !== undefined ? assertFiniteNumber(input.maxPerTxUsd, 'maxPerTxUsd') : 250;
    const rawDailyCap =
      input.dailyCapUsd !== undefined ? assertFiniteNumber(input.dailyCapUsd, 'dailyCapUsd') : Math.max(rawMaxPerTx, 1000);
    const rawAutoApprove =
      input.autoApproveUnderUsd !== undefined
        ? assertFiniteNumber(input.autoApproveUnderUsd, 'autoApproveUnderUsd')
        : 50;
    const rawDurationDays =
      input.durationDays !== undefined ? assertFiniteNumber(input.durationDays, 'durationDays') : 30;
    const rawMaxFeeBps =
      input.maxFeeBps !== undefined ? assertFiniteNumber(input.maxFeeBps, 'maxFeeBps') : 700;
    const rawMinNetOutBps =
      input.minNetOutBps !== undefined ? assertFiniteNumber(input.minNetOutBps, 'minNetOutBps') : 7000;

    if (rawMaxPerTx <= 0 || rawDailyCap <= 0 || rawAutoApprove < 0 || rawDurationDays <= 0) {
      throw new Error('Mandate numeric caps and durationDays must be positive (autoApproveUnderUsd >= 0).');
    }
    if (rawDailyCap < rawMaxPerTx) {
      throw new Error('dailyCapUsd must be greater than or equal to maxPerTxUsd.');
    }

    const maxPerTxUsd = Math.max(5, Math.min(100_000, rawMaxPerTx));
    const dailyCapUsd = Math.max(maxPerTxUsd, Math.min(500_000, rawDailyCap));
    const autoApproveUnderUsd = Math.max(0, Math.min(maxPerTxUsd, rawAutoApprove));
    const maxFeeBps = resolveProtocolFeeBps(rawMaxFeeBps);
    const minNetOutBps = Math.max(5000, Math.min(9500, Math.round(rawMinNetOutBps)));
    const durationDays = Math.max(1, Math.min(365, Math.round(rawDurationDays)));

    let allowedActions: AgentActionType[];
    if (input.allowedActions !== undefined) {
      if (!Array.isArray(input.allowedActions) || input.allowedActions.length === 0) {
        throw new Error('allowedActions must be a non-empty array of valid action types.');
      }
      const invalid = input.allowedActions.filter((a) => !isAgentActionType(a));
      if (invalid.length > 0) {
        throw new Error(`Invalid allowedActions entries: ${invalid.map(String).join(', ')}`);
      }
      allowedActions = Array.from(new Set(input.allowedActions));
    } else {
      allowedActions = ['dust_convert', 'defi_withdraw', 'bridge_solana'];
    }

    const allowedActionsMask = computeActionsMask(allowedActions);
    if (allowedActionsMask === 0) {
      throw new Error('allowedActionsMask must be non-zero.');
    }

    if (input.agentKey !== undefined && typeof input.agentKey !== 'string') {
      throw new Error('agentKey must be a string.');
    }
    const cleanAgentKey = input.agentKey?.trim();
    if (cleanAgentKey && !/^0x[0-9a-fA-F]{40}$/.test(cleanAgentKey)) {
      throw new Error('agentKey must be a valid 20-byte 0x EVM address.');
    }

    const mandateId = `mnd_${crypto.randomBytes(8).toString('hex')}`;
    const agentKey =
      cleanAgentKey ||
      `0x${crypto.createHash('sha256').update(mandateId).digest('hex').slice(0, 40)}`;
    const nowMs = this.nowMs();
    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + durationDays * DAY_MS).toISOString();

    const record: AgentMandateRecord = {
      mandateId,
      name: sanitizeFreeText(input.name, 80, 'Dust & DeFi Auto-Sweep Agent'),
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
      allowedActionsMask,
      autoApproveUnderUsd: round2(autoApproveUnderUsd),
      expiresAt,
      createdAt: nowIso,
      active: true,
      onchainContract: 'TurgaliumAgentVault.sol',
      executionsCount: 0,
    };

    this.mandates.set(mandateId, record);
    while (this.mandates.size > this.maxMandates) {
      const oldestKey = this.mandates.keys().next().value;
      if (!oldestKey) break;
      this.mandates.delete(oldestKey);
    }
    this.persistMandates();
    return record;
  }

  listMandates(): AgentMandateRecord[] {
    const nowMs = this.nowMs();
    const items = Array.from(this.mandates.values());
    let rolled = false;
    for (const m of items) {
      if (this.refreshRollingDayWindow(m, nowMs)) rolled = true;
    }
    if (rolled) this.persistMandates();
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getMandate(mandateId: string): AgentMandateRecord | null {
    const m = this.mandates.get(mandateId);
    if (!m) return null;
    if (this.refreshRollingDayWindow(m)) {
      this.persistMandates();
    }
    return m;
  }

  revokeMandate(mandateId: string): AgentMandateRecord | null {
    const m = this.mandates.get(mandateId);
    if (!m) return null;
    m.active = false;
    const nowIso = new Date(this.nowMs()).toISOString();
    let approvalChanged = false;
    // Cascade-reject pending approvals tied to the revoked mandate (MED-2)
    for (const apr of this.approvals.values()) {
      if (apr.mandateId === mandateId && apr.status === 'pending_approval') {
        apr.status = 'rejected';
        apr.decisionReason = `Auto-rejected because mandate ${mandateId} was revoked.`;
        apr.decidedAt = nowIso;
        approvalChanged = true;
      }
    }
    this.persistMandates();
    if (approvalChanged) this.persistApprovals();
    return m;
  }

  /**
   * Proposes a value-moving action from Claude MCP, ChatGPT Action, or a Smart-Contract Agent.
   * Evaluates every TurgaliumAgentVault policy check and either:
   *   - Throws on invalid inputs (non-finite NaN/Infinity amounts, grossUsd <= 0, invalid actionType, unknown mandateId);
   *   - Rejects immediately on Negative ROI, spoofed scanCache valuation, or ANY hard mandate invariant violation;
   *   - Marks `auto_approved_by_mandate` ONLY when a valid active mandate passes EVERY check AND
   *     `autoApproveUnderUsd > 0 && grossUsd <= autoApproveUnderUsd`;
   *   - Otherwise marks `pending_approval` so the owner explicitly clicks Approve / Reject in Turgalium.
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
    if (!isAgentActionType(input.actionType)) {
      throw new Error(`Invalid actionType: ${String(input.actionType)}`);
    }
    if (typeof input.solanaDestination !== 'string' || !input.solanaDestination.trim()) {
      throw new Error('solanaDestination must be a non-empty Solana base58 address.');
    }
    const solDest = input.solanaDestination.trim();
    solanaAddressToBytes32(solDest); // fail fast on invalid Solana recipient

    const rawGross = assertFiniteNumber(input.grossUsd, 'grossUsd');
    const rawNet = assertFiniteNumber(input.estimatedNetUsdc, 'estimatedNetUsdc');
    if (rawGross <= 0) {
      throw new Error('grossUsd must be a positive finite number (> 0).');
    }
    if (input.protocolFeeBps !== undefined) {
      assertFiniteNumber(input.protocolFeeBps, 'protocolFeeBps');
    }

    const mandateIdClean =
      typeof input.mandateId === 'string' && input.mandateId.trim() ? input.mandateId.trim() : undefined;
    const mandate = mandateIdClean ? this.mandates.get(mandateIdClean) : undefined;
    if (mandateIdClean && !mandate) {
      throw new Error(`Unknown mandateId: ${mandateIdClean}`);
    }

    const nowMs = this.nowMs();
    const feeBps = resolveProtocolFeeBps(input.protocolFeeBps ?? 700);
    const reportedGrossUsd = round2(rawGross);
    if (reportedGrossUsd <= 0) {
      throw new Error('grossUsd rounds to $0.00; sub-cent zero-value permission requests are rejected.');
    }
    const reportedEstimatedNetUsdc = round2(rawNet);
    const assetIds = Array.isArray(input.assetIds)
      ? Array.from(new Set(input.assetIds.map((id) => String(id).trim()).filter(Boolean))).slice(0, 100)
      : [];
    const sourceWallets = Array.isArray(input.sourceWallets)
      ? input.sourceWallets.map((w) => sanitizeFreeText(String(w), 128)).filter(Boolean).slice(0, 20)
      : [];
    const chains = Array.isArray(input.chains)
      ? (input.chains.map((c) => sanitizeFreeText(String(c), 32)).filter(Boolean).slice(0, 25) as AnyChainId[])
      : [];
    const summary = sanitizeFreeText(input.summary, 240, `Permission request (${input.actionType})`);
    const approvalId = `apr_${crypto.randomBytes(8).toString('hex')}`;

    const policyChecks: Array<{ check: string; passed: boolean; detail: string }> = [];

    // Verify grossUsd & estimatedNetUsdc against scanCache when assetIds are supplied
    let effectiveGrossUsd = reportedGrossUsd;
    let effectiveNetUsdc = reportedEstimatedNetUsdc;
    let valuationRejected = false;
    let valuationRejectReason: string | undefined;
    let valuationUnverified = false;

    if (reportedEstimatedNetUsdc > reportedGrossUsd + 0.01) {
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

    // Deterministic commitment over canonical sweep parameters (excluding random approvalId)
    const digestPayload = JSON.stringify({
      client: input.client,
      mandateId: mandate?.mandateId || null,
      actionType: input.actionType,
      sourceWallets,
      chains,
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

    let canAutoApprove = false;
    let hardMandateViolation: string | undefined;
    let mandateMutated = false;

    if (mandate) {
      if (this.refreshRollingDayWindow(mandate, nowMs)) {
        mandateMutated = true;
      }

      const notExpired = mandate.active && Date.parse(mandate.expiresAt) > nowMs;
      const destMatches = mandate.lockedSolanaRecipient === solDest;
      const actionBit = ACTION_BITS[input.actionType] ?? 0;
      const actionAllowed = actionBit !== 0 && (mandate.allowedActionsMask & actionBit) !== 0;
      const withinPerTx = effectiveGrossUsd <= mandate.maxPerTxUsd;
      const withinDaily = round2(mandate.spentTodayUsd + effectiveGrossUsd) <= mandate.dailyCapUsd;
      const withinFee = feeBps <= mandate.maxFeeBps;
      const minNetRequired = round2((effectiveGrossUsd * mandate.minNetOutBps) / 10_000);
      const meetsMinNet = effectiveNetUsdc >= minNetRequired;
      const withinAutoTier =
        mandate.autoApproveUnderUsd > 0 && effectiveGrossUsd <= mandate.autoApproveUnderUsd;

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
          check: 'Protocol Fee Ceiling',
          passed: withinFee,
          detail: withinFee
            ? `${feeBps} bps <= mandate max ${mandate.maxFeeBps} bps.`
            : `Blocked: fee ${feeBps} bps exceeds mandate max ${mandate.maxFeeBps} bps.`,
        },
        {
          check: 'Minimum Net Output Floor',
          passed: meetsMinNet,
          detail: meetsMinNet
            ? `$${effectiveNetUsdc.toFixed(2)} >= $${minNetRequired.toFixed(2)} (${(mandate.minNetOutBps / 100).toFixed(1)}% floor).`
            : `Blocked: $${effectiveNetUsdc.toFixed(2)} below mandate minimum $${minNetRequired.toFixed(2)} (${(mandate.minNetOutBps / 100).toFixed(1)}%).`,
        },
        {
          check: 'Per-Tx & Daily Cap',
          passed: withinPerTx && withinDaily,
          detail: `$${effectiveGrossUsd.toFixed(2)} vs $${mandate.maxPerTxUsd.toFixed(2)}/tx & $${mandate.remainingDailyUsd.toFixed(2)} remaining today.`,
        },
        {
          check: 'Auto-Approve Threshold',
          passed: withinAutoTier,
          detail:
            mandate.autoApproveUnderUsd <= 0
              ? 'Auto-approve disabled ($0 threshold) — requires explicit human approval.'
              : withinAutoTier
              ? `Within $${mandate.autoApproveUnderUsd.toFixed(2)} autonomous tier.`
              : `Above $${mandate.autoApproveUnderUsd.toFixed(2)} autonomous tier — requires explicit human approval.`,
        }
      );

      // Hard mandate invariants are terminal rejections (HIGH-3); only exceeding autoApproveUnderUsd enters pending_approval
      if (!notExpired) hardMandateViolation = 'Rejected: mandate is revoked or expired.';
      else if (!destMatches) hardMandateViolation = 'Rejected: solanaDestination does not match immutable mandate lockedSolanaRecipient.';
      else if (!actionAllowed) hardMandateViolation = `Rejected: action '${input.actionType}' is not permitted by mandate.`;
      else if (!withinFee) hardMandateViolation = `Rejected: protocolFeeBps (${feeBps}) exceeds mandate maxFeeBps (${mandate.maxFeeBps}).`;
      else if (!meetsMinNet) hardMandateViolation = `Rejected: estimatedNetUsdc ($${effectiveNetUsdc.toFixed(2)}) below mandate minNetOutBps floor ($${minNetRequired.toFixed(2)}).`;
      else if (!withinPerTx) hardMandateViolation = `Rejected: grossUsd ($${effectiveGrossUsd.toFixed(2)}) exceeds mandate maxPerTxUsd ($${mandate.maxPerTxUsd.toFixed(2)}).`;
      else if (!withinDaily) hardMandateViolation = `Rejected: grossUsd ($${effectiveGrossUsd.toFixed(2)}) exceeds remaining daily cap ($${mandate.remainingDailyUsd.toFixed(2)}).`;

      canAutoApprove =
        !valuationRejected &&
        !valuationUnverified &&
        !hardMandateViolation &&
        roiPositive &&
        withinAutoTier;

      if (canAutoApprove) {
        mandate.spentTodayUsd = round2(mandate.spentTodayUsd + effectiveGrossUsd);
        mandate.remainingDailyUsd = round2(Math.max(0, mandate.dailyCapUsd - mandate.spentTodayUsd));
        mandate.executionsCount += 1;
        mandate.lastRunAt = new Date(nowMs).toISOString();
        mandateMutated = true;
      }
    } else {
      policyChecks.push({
        check: 'Human Permission Gate',
        passed: true,
        detail: 'No auto-approve mandate supplied — queued for explicit owner confirmation in Turgalium UI.',
      });
    }

    const nowIso = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.approvalTtlMs).toISOString();
    const autoRejected = valuationRejected || !roiPositive || Boolean(hardMandateViolation);
    const record: PermissionRequestRecord = {
      approvalId,
      requestDigestSha256,
      client: input.client,
      mandateId: mandate?.mandateId,
      actionType: input.actionType,
      summary,
      sourceWallets,
      chains,
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
        : hardMandateViolation
        ? hardMandateViolation
        : canAutoApprove
        ? `Auto-approved within TurgaliumAgentVault mandate ${mandate?.mandateId} (<= $${mandate?.autoApproveUnderUsd}).`
        : 'Awaiting explicit user permission approval in Turgalium.',
      createdAt: nowIso,
      expiresAt,
      decidedAt: autoRejected || canAutoApprove ? nowIso : undefined,
    };

    this.approvals.set(approvalId, record);
    while (this.approvals.size > this.maxApprovals) {
      const oldestKey = this.approvals.keys().next().value;
      if (!oldestKey) break;
      this.approvals.delete(oldestKey);
    }
    this.persistApprovals();
    if (mandateMutated) this.persistMandates();
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
    const nowIso = new Date(nowMs).toISOString();

    // Enforce approval TTL (MED-2)
    if (params.decision === 'approve' && Date.parse(req.expiresAt) <= nowMs) {
      req.status = 'rejected';
      req.decisionReason = 'Approval request expired before owner decision.';
      req.decidedAt = nowIso;
      this.persistApprovals();
      throw new Error('Permission request has expired and can no longer be approved.');
    }

    let mandateMutated = false;

    // Re-enforce ALL mandate invariants before allowing human approval to debit mandate quota (HIGH-3)
    if (params.decision === 'approve' && req.mandateId) {
      const m = this.mandates.get(req.mandateId);
      if (!m || !m.active || Date.parse(m.expiresAt) <= nowMs) {
        req.status = 'rejected';
        req.decisionReason = 'Mandate is missing, revoked, or expired.';
        req.decidedAt = nowIso;
        this.persistApprovals();
        throw new Error('Cannot approve: associated mandate is inactive or expired.');
      }
      if (this.refreshRollingDayWindow(m, nowMs)) {
        mandateMutated = true;
      }

      if (!Number.isFinite(req.grossUsd) || req.grossUsd <= 0 || !Number.isFinite(req.estimatedNetUsdc) || req.estimatedNetUsdc <= 0) {
        throw new Error('Cannot approve: non-finite or non-positive request amount.');
      }
      if (req.solanaDestination !== m.lockedSolanaRecipient) {
        throw new Error('Cannot approve: solanaDestination violates mandate lockedSolanaRecipient.');
      }
      const actionBit = ACTION_BITS[req.actionType] ?? 0;
      if (actionBit === 0 || (m.allowedActionsMask & actionBit) === 0) {
        throw new Error(`Cannot approve: action '${req.actionType}' is not permitted by mandate.`);
      }
      if (req.protocolFeeBps > m.maxFeeBps) {
        throw new Error(`Cannot approve: fee ${req.protocolFeeBps} bps exceeds mandate max ${m.maxFeeBps} bps.`);
      }
      const minNetRequired = round2((req.grossUsd * m.minNetOutBps) / 10_000);
      if (req.estimatedNetUsdc < minNetRequired) {
        throw new Error(`Cannot approve: estimatedNetUsdc below mandate minimum output floor ($${minNetRequired.toFixed(2)}).`);
      }
      if (req.grossUsd > m.maxPerTxUsd) {
        throw new Error(`Cannot approve: grossUsd ($${req.grossUsd.toFixed(2)}) exceeds mandate maxPerTxUsd ($${m.maxPerTxUsd.toFixed(2)}).`);
      }
      if (round2(m.spentTodayUsd + req.grossUsd) > m.dailyCapUsd) {
        throw new Error(`Cannot approve: grossUsd ($${req.grossUsd.toFixed(2)}) exceeds remaining daily cap ($${m.remainingDailyUsd.toFixed(2)}).`);
      }

      m.spentTodayUsd = round2(m.spentTodayUsd + req.grossUsd);
      m.remainingDailyUsd = round2(Math.max(0, m.dailyCapUsd - m.spentTodayUsd));
      m.executionsCount += 1;
      m.lastRunAt = nowIso;
      mandateMutated = true;
    }

    req.status = params.decision === 'approve' ? 'approved' : 'rejected';
    req.decisionReason =
      sanitizeFreeText(params.reason, 200) ||
      (params.decision === 'approve'
        ? 'Explicitly approved by wallet owner.'
        : 'Rejected by wallet owner.');
    req.decidedAt = nowIso;
    this.persistApprovals();
    if (mandateMutated) this.persistMandates();
    return req;
  }

  issuePluginToken(params: {
    label: string;
    client: 'claude_mcp' | 'chatgpt_action';
    scopes?: string[];
  }): { token: string; record: PluginApiTokenRecord } {
    const tokenId = `tok_${crypto.randomBytes(16).toString('hex')}`;
    const rawSecret = `turgalium_${params.client === 'chatgpt_action' ? 'gpt' : 'mcp'}_${crypto.randomBytes(18).toString('hex')}`;
    const secretHash = crypto.createHash('sha256').update(rawSecret).digest();
    const scopes =
      Array.isArray(params.scopes) && params.scopes.length
        ? params.scopes
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .map((s) => sanitizeFreeText(s, 48))
            .slice(0, 12)
        : ['scan:read', 'dust:plan', 'proof:simulate', 'agent:propose'];

    const nowMs = this.nowMs();
    const record: PluginApiTokenRecord = {
      tokenId,
      label: sanitizeFreeText(
        params.label,
        80,
        params.client === 'chatgpt_action' ? 'ChatGPT Action' : 'Claude MCP'
      ),
      client: params.client,
      scopes,
      tokenPreview: `${rawSecret.slice(0, 14)}…${rawSecret.slice(-4)}`,
      createdAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + this.tokenTtlMs).toISOString(),
      revoked: false,
    };

    this.tokens.set(tokenId, { record, secretHash });
    while (this.tokens.size > this.maxTokens) {
      const oldestKey = this.tokens.keys().next().value;
      if (!oldestKey) break;
      this.tokens.delete(oldestKey);
    }
    this.persistTokens();
    return { token: rawSecret, record };
  }

  listPluginTokens(): PluginApiTokenRecord[] {
    return Array.from(this.tokens.values()).map((t) => t.record);
  }

  revokePluginToken(tokenId: string): PluginApiTokenRecord | null {
    const entry = this.tokens.get(tokenId);
    if (!entry) return null;
    entry.record.revoked = true;
    this.persistTokens();
    return entry.record;
  }

  verifyPluginToken(bearerHeader?: string | null): PluginApiTokenRecord | null {
    if (typeof bearerHeader !== 'string' || !bearerHeader) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(bearerHeader.trim());
    if (!match) return null;
    const raw = match[1];
    if (!raw) return null;

    const nowMs = this.nowMs();
    const candidateHash = crypto.createHash('sha256').update(raw).digest();
    let matchedRecord: PluginApiTokenRecord | null = null;
    for (const entry of this.tokens.values()) {
      const hashMatches =
        entry.secretHash.length === candidateHash.length &&
        crypto.timingSafeEqual(entry.secretHash, candidateHash);
      const notExpired = Date.parse(entry.record.expiresAt) > nowMs;
      if (hashMatches && !entry.record.revoked && notExpired) {
        matchedRecord = entry.record;
      }
    }
    return matchedRecord;
  }
}
