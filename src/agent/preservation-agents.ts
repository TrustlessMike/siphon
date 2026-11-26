import crypto from 'node:crypto';
import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import { fetchLiveChainGasGwei } from '../execution/preservation-optimizer.js';
import { DEAD_BURN_ADDRESS, EVM_CHAINS } from '../scanner/chains.js';
import { planDustConversion } from '../scanner/dust.js';
import { sanitizeFreeText } from '../scanner/sanitize.js';
import type { AnyChainId, EvmChainId, ScanReport } from '../scanner/types.js';
import type { TurgaliumStateStore } from '../storage/state-store.js';

export type GasWatchStatus = 'watching' | 'ready' | 'cancelled' | 'expired';

export interface GasWatchTrigger {
  id: string;
  sourceWallet: string;
  solanaDestination: string;
  chain: EvmChainId;
  maxBaseFeeGwei: number;
  estimatedSavingsUsd: number;
  mandateId?: string;
  status: GasWatchStatus;
  lastObservedGwei?: number;
  readyAt?: string;
  cancelledAt?: string;
  createdAt: string;
  expiresAt: string;
  /** Strictly false unless a verified active signed mandate authorizes autonomous execution */
  autoExecuteAllowed: boolean;
  safetyNote: string;
}

export interface CreateGasWatchTriggerInput {
  sourceWallet: string;
  solanaDestination: string;
  chain?: EvmChainId;
  maxBaseFeeGwei: number;
  estimatedSavingsUsd?: number;
  mandateId?: string;
  ttlHours?: number;
}

export interface GasWatchEvaluationResult {
  evaluatedAt: string;
  evaluatedCount: number;
  transitionedToReady: GasWatchTrigger[];
  readyTriggers: GasWatchTrigger[];
  expiredCount: number;
  triggers: GasWatchTrigger[];
}

export interface PreservationAgentStoreOptions {
  maxTriggers?: number;
  defaultTtlMs?: number;
  nowMs?: () => number;
  stateStore?: TurgaliumStateStore;
}

export interface GasWatchPollerOptions {
  /** Polling interval in milliseconds (default 30_000 ms; min 25 ms for tests). */
  intervalMs?: number;
  /** Optional gas price fetcher; defaults to live RPC via `fetchLiveChainGasGwei`. */
  fetchGasGwei?: (chain: EvmChainId) => Promise<number | null>;
  /** Optional fail-closed mandate validator re-checked on every evaluation. */
  mandateValidator?: (mandateId: string, trigger: GasWatchTrigger) => boolean;
  /**
   * Optional human-permissioned / notification hook fired whenever a trigger transitions
   * `watching` -> `ready`. Wrapped in try/catch so callback errors never crash the poller.
   */
  onTriggered?: (
    trigger: GasWatchTrigger,
    evalResult: GasWatchEvaluationResult
  ) => void | Promise<void>;
  /** Optionally execute an immediate tick upon starting (default false). */
  runImmediately?: boolean;
}

export interface GasWatchPollerStatus {
  running: boolean;
  intervalMs: number;
  tickInFlight: boolean;
  armedCount: number;
  readyCount: number;
  totalTriggers: number;
  ticksTotal: number;
  skippedIdleTicks: number;
  rpcFetchCount: number;
  triggeredCount: number;
  errorCount: number;
  lastTickAt: string | null;
  lastTriggeredAt: string | null;
  lastError: string | null;
  lastObservedGasGwei: Partial<Record<EvmChainId, number>>;
}

export interface DustAutoHarvestOptions {
  minHarvestUsd?: number;
  minPreservationRatePct?: number;
  maxDustThresholdUsd?: number;
  protocolFeeBps?: number;
  hasSolanaUsdcAta?: boolean;
  hasValidMandate?: boolean;
}

export interface DustAutoHarvestEvaluation {
  eligible: boolean;
  canAutoExecute: boolean;
  grossDustUsd: number;
  netBatchedUsd: number;
  totalCostUsd: number;
  preservationRatePct: number;
  convertibleCount: number;
  rescuedByBatchCount: number;
  skippedDustCount: number;
  minHarvestUsd: number;
  minPreservationRatePct: number;
  shortfallUsd: number;
  eligibleChains: AnyChainId[];
  convertibleAssetIds: string[];
  reason: string;
}

const DEFAULT_MAX_TRIGGERS = 50;
const DEFAULT_TTL_MS = 72 * 3600 * 1000; // 72 hours
const DEFAULT_GAS_POLL_INTERVAL_MS = 30_000; // 30 seconds
const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

function r2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function assertFiniteNumber(raw: unknown, field: string): number {
  if (typeof raw === 'boolean' || raw === null || raw === undefined || raw === '') {
    throw new Error(`Invalid ${field}: expected a finite number.`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${field}: must be a finite number.`);
  }
  return n;
}

function assertValidEvmWallet(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('sourceWallet must be a valid 20-byte 0x EVM address.');
  }
  const clean = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) {
    throw new Error('sourceWallet must be a valid 20-byte 0x EVM address.');
  }
  const lower = clean.toLowerCase();
  if (lower === ZERO_EVM_ADDRESS || lower === DEAD_BURN_ADDRESS.toLowerCase()) {
    throw new Error('sourceWallet cannot be the zero or burn address.');
  }
  return clean;
}

function assertValidEvmChain(raw: unknown): EvmChainId {
  const clean = typeof raw === 'string' ? raw.trim().toLowerCase() : 'ethereum';
  if (!Object.hasOwn(EVM_CHAINS, clean)) {
    throw new Error(`Unsupported EVM chain for gas-window watch: ${String(raw)}`);
  }
  return clean as EvmChainId;
}

/**
 * Bounded LRU store & fail-closed evaluator for Turgalium Gas-Window Watchdog triggers.
 *
 * Security invariants:
 *  - Hard LRU capacity cap (`maxTriggers = 50` by default) prevents memory DoS.
 *  - Strict input validation on EVM source wallet, Solana base58 destination, chain, and gwei bounds.
 *  - Fail-closed execution safety: NEVER allows autonomous execution without a verified active mandate.
 */
export class PreservationAgentStore {
  private readonly triggers = new Map<string, GasWatchTrigger>();
  private readonly maxTriggers: number;
  private readonly defaultTtlMs: number;
  private readonly nowMs: () => number;
  private readonly stateStore?: TurgaliumStateStore;

  private pollerTimer: ReturnType<typeof setInterval> | null = null;
  private pollerOptions: GasWatchPollerOptions | null = null;
  private pollerIntervalMs = DEFAULT_GAS_POLL_INTERVAL_MS;
  private tickInFlight = false;
  private ticksTotal = 0;
  private skippedIdleTicks = 0;
  private rpcFetchCount = 0;
  private triggeredCount = 0;
  private errorCount = 0;
  private lastTickAt: string | null = null;
  private lastTriggeredAt: string | null = null;
  private lastError: string | null = null;
  private lastObservedGasGwei: Partial<Record<EvmChainId, number>> = {};

  constructor(opts: PreservationAgentStoreOptions = {}) {
    this.maxTriggers = Math.max(1, Math.floor(opts.maxTriggers ?? DEFAULT_MAX_TRIGGERS));
    this.defaultTtlMs = Math.max(60_000, Math.floor(opts.defaultTtlMs ?? DEFAULT_TTL_MS));
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.stateStore = opts.stateStore;
    if (this.stateStore) {
      this.hydrateFromStore();
    }
  }

  private hydrateFromStore(): void {
    if (!this.stateStore) return;
    const saved = this.stateStore.load<GasWatchTrigger[]>('preservation_agents', []);
    if (Array.isArray(saved)) {
      for (const item of saved) {
        if (item && typeof item === 'object' && typeof item.id === 'string') {
          this.triggers.set(item.id, item);
        }
      }
      while (this.triggers.size > this.maxTriggers) {
        const oldestKey = this.triggers.keys().next().value;
        if (!oldestKey) break;
        this.triggers.delete(oldestKey);
      }
    }
  }

  private persistTriggers(): void {
    if (!this.stateStore) return;
    this.stateStore.save('preservation_agents', Array.from(this.triggers.values()));
  }

  get capacity(): number {
    return this.maxTriggers;
  }

  get size(): number {
    return this.triggers.size;
  }

  createTrigger(input: CreateGasWatchTriggerInput): GasWatchTrigger {
    const sourceWallet = assertValidEvmWallet(input.sourceWallet);
    if (typeof input.solanaDestination !== 'string' || !input.solanaDestination.trim()) {
      throw new Error('solanaDestination must be a valid non-empty Solana base58 address.');
    }
    const solanaDestination = input.solanaDestination.trim();
    try {
      solanaAddressToBytes32(solanaDestination);
    } catch {
      throw new Error('Invalid solanaDestination: expected a valid non-zero Solana base58 public key.');
    }

    const chain = assertValidEvmChain(input.chain ?? 'ethereum');
    const rawGwei = assertFiniteNumber(input.maxBaseFeeGwei, 'maxBaseFeeGwei');
    if (rawGwei <= 0 || rawGwei > 500) {
      throw new Error('maxBaseFeeGwei must be greater than 0 and at most 500 gwei.');
    }
    const maxBaseFeeGwei = r2(rawGwei);

    let estimatedSavingsUsd = 0;
    if (input.estimatedSavingsUsd !== undefined) {
      const rawSavings = assertFiniteNumber(input.estimatedSavingsUsd, 'estimatedSavingsUsd');
      if (rawSavings < 0 || rawSavings > 1_000_000) {
        throw new Error('estimatedSavingsUsd must be between 0 and 1,000,000.');
      }
      estimatedSavingsUsd = r2(rawSavings);
    }

    let ttlMs = this.defaultTtlMs;
    if (input.ttlHours !== undefined) {
      const rawHours = assertFiniteNumber(input.ttlHours, 'ttlHours');
      if (rawHours < 1 || rawHours > 168) {
        throw new Error('ttlHours must be between 1 and 168 hours.');
      }
      ttlMs = Math.round(rawHours * 3600 * 1000);
    }

    let mandateId: string | undefined;
    if (input.mandateId !== undefined && input.mandateId !== '') {
      if (typeof input.mandateId !== 'string') {
        throw new Error('mandateId must be a string.');
      }
      const cleanMandate = sanitizeFreeText(input.mandateId, 64);
      if (!cleanMandate) {
        throw new Error('mandateId cannot be blank.');
      }
      mandateId = cleanMandate;
    }

    const now = this.nowMs();
    const id = `gw_${crypto.randomBytes(6).toString('hex')}`;
    const trigger: GasWatchTrigger = {
      id,
      sourceWallet,
      solanaDestination,
      chain,
      maxBaseFeeGwei,
      estimatedSavingsUsd,
      mandateId,
      status: 'watching',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      autoExecuteAllowed: false,
      safetyNote: mandateId
        ? `Linked to mandate ${mandateId} — auto-execution stays blocked until gas target is met and mandate is verified active.`
        : 'Notify-only trigger — fail-closed without a signed TurgaliumAgentVault mandate.',
    };

    this.triggers.set(id, trigger);
    while (this.triggers.size > this.maxTriggers) {
      const oldestKey = this.triggers.keys().next().value;
      if (!oldestKey) break;
      this.triggers.delete(oldestKey);
    }
    this.persistTriggers();

    return { ...trigger };
  }

  getTrigger(id: string): GasWatchTrigger | null {
    const item = this.triggers.get(id);
    if (!item) return null;
    if (this.expireIfStale(item, this.nowMs())) {
      this.persistTriggers();
    }
    return { ...item };
  }

  listTriggers(): GasWatchTrigger[] {
    const now = this.nowMs();
    const list: GasWatchTrigger[] = [];
    let mutated = false;
    for (const item of this.triggers.values()) {
      if (this.expireIfStale(item, now)) {
        mutated = true;
      }
      list.push({ ...item });
    }
    if (mutated) {
      this.persistTriggers();
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  cancelTrigger(id: string): GasWatchTrigger | null {
    const item = this.triggers.get(id);
    if (!item) return null;
    if (item.status === 'watching' || item.status === 'ready') {
      item.status = 'cancelled';
      item.cancelledAt = new Date(this.nowMs()).toISOString();
      item.autoExecuteAllowed = false;
      item.safetyNote = 'Trigger cancelled by user.';
      this.persistTriggers();
    }
    return { ...item };
  }

  /**
   * Transitions watching triggers to `'ready'` strictly when `liveGas <= maxBaseFeeGwei`.
   * Fail-closed safety: `autoExecuteAllowed` is NEVER true unless a valid active mandate
   * passes `mandateValidator`.
   */
  evaluateGasWatchTriggers(
    liveGasByChain: Partial<Record<EvmChainId, number>>,
    options: {
      mandateValidator?: (mandateId: string, trigger: GasWatchTrigger) => boolean;
    } = {}
  ): GasWatchEvaluationResult {
    const now = this.nowMs();
    const nowIso = new Date(now).toISOString();
    const transitionedToReady: GasWatchTrigger[] = [];
    const readyTriggers: GasWatchTrigger[] = [];
    let expiredCount = 0;
    let evaluatedCount = 0;

    for (const trigger of this.triggers.values()) {
      evaluatedCount += 1;

      if (this.expireIfStale(trigger, now)) {
        expiredCount += 1;
        continue;
      }

      if (trigger.status === 'cancelled' || trigger.status === 'expired') {
        trigger.autoExecuteAllowed = false;
        continue;
      }

      const currentGwei = liveGasByChain[trigger.chain];
      if (typeof currentGwei === 'number' && Number.isFinite(currentGwei) && currentGwei >= 0) {
        trigger.lastObservedGwei = r2(currentGwei);
        if (trigger.status === 'watching' && currentGwei <= trigger.maxBaseFeeGwei) {
          trigger.status = 'ready';
          trigger.readyAt = nowIso;
          transitionedToReady.push({ ...trigger });
        }
      }

      // Always re-verify mandate status fail-closed on every evaluation
      const mandateValid = Boolean(
        trigger.status === 'ready' &&
          trigger.mandateId &&
          options.mandateValidator &&
          options.mandateValidator(trigger.mandateId, trigger)
      );
      trigger.autoExecuteAllowed = mandateValid;
      if (trigger.status === 'ready') {
        trigger.safetyNote = mandateValid
          ? `Gas window met (${trigger.lastObservedGwei ?? trigger.maxBaseFeeGwei} ≤ ${trigger.maxBaseFeeGwei} gwei) and active mandate ${trigger.mandateId} verified.`
          : `Gas window met (${trigger.lastObservedGwei ?? trigger.maxBaseFeeGwei} ≤ ${trigger.maxBaseFeeGwei} gwei) — awaiting explicit user signature (no active signed mandate).`;
        readyTriggers.push({ ...trigger });
      }
    }

    if (evaluatedCount > 0) {
      this.persistTriggers();
    }

    return {
      evaluatedAt: nowIso,
      evaluatedCount,
      transitionedToReady,
      readyTriggers,
      expiredCount,
      triggers: this.listTriggers(),
    };
  }

  private expireIfStale(trigger: GasWatchTrigger, now: number): boolean {
    if (trigger.status === 'watching' && Date.parse(trigger.expiresAt) <= now) {
      trigger.status = 'expired';
      trigger.autoExecuteAllowed = false;
      trigger.safetyNote = 'Gas-window trigger expired before target gas was reached.';
      return true;
    }
    return false;
  }

  /**
   * Executes a single non-overlapping gas-watch poller tick.
   * Zero idle cost: skips immediately without calling `fetchGasGwei` or any RPC
   * when `armedCount === 0`.
   */
  async runPollerTick(
    overrideOpts?: GasWatchPollerOptions
  ): Promise<GasWatchEvaluationResult | null> {
    if (this.tickInFlight) {
      return null;
    }
    this.tickInFlight = true;
    try {
      this.ticksTotal += 1;
      const now = this.nowMs();
      this.lastTickAt = new Date(now).toISOString();

      let expiredAny = false;
      const armedChains = new Set<EvmChainId>();
      for (const trigger of this.triggers.values()) {
        if (this.expireIfStale(trigger, now)) {
          expiredAny = true;
          continue;
        }
        if (trigger.status === 'watching') {
          armedChains.add(trigger.chain);
        }
      }
      if (expiredAny) {
        this.persistTriggers();
      }

      if (armedChains.size === 0) {
        this.skippedIdleTicks += 1;
        return null;
      }

      const activeOpts = overrideOpts ?? this.pollerOptions ?? {};
      const liveGasByChain: Partial<Record<EvmChainId, number>> = {};

      for (const chain of armedChains) {
        this.rpcFetchCount += 1;
        try {
          let reading: number | null;
          if (activeOpts.fetchGasGwei) {
            reading = await activeOpts.fetchGasGwei(chain);
          } else {
            const live = await fetchLiveChainGasGwei(chain, { timeoutMs: 2_000 });
            reading = live ? live.gwei : null;
          }
          if (typeof reading === 'number' && Number.isFinite(reading) && reading >= 0) {
            const rounded = r2(reading);
            liveGasByChain[chain] = rounded;
            this.lastObservedGasGwei[chain] = rounded;
          }
        } catch (err) {
          this.errorCount += 1;
          this.lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (Object.keys(liveGasByChain).length === 0) {
        return null;
      }

      const evalResult = this.evaluateGasWatchTriggers(liveGasByChain, {
        mandateValidator: activeOpts.mandateValidator,
      });

      if (evalResult.transitionedToReady.length > 0) {
        this.triggeredCount += evalResult.transitionedToReady.length;
        this.lastTriggeredAt = evalResult.evaluatedAt;
        if (activeOpts.onTriggered) {
          for (const triggered of evalResult.transitionedToReady) {
            try {
              await activeOpts.onTriggered({ ...triggered }, evalResult);
            } catch (cbErr) {
              this.errorCount += 1;
              this.lastError = cbErr instanceof Error ? cbErr.message : String(cbErr);
            }
          }
        }
      }

      return evalResult;
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Starts the autonomous `.unref()` background poller loop for Gas-Window Watchdog triggers.
   * Safe for unit tests & graceful shutdown: the timer is always `.unref()`'d.
   */
  startPoller(opts: GasWatchPollerOptions = {}): GasWatchPollerStatus {
    this.stopPoller();
    const rawInterval = opts.intervalMs ?? DEFAULT_GAS_POLL_INTERVAL_MS;
    const intervalMs = Math.max(
      25,
      Math.min(3_600_000, Math.floor(Number.isFinite(rawInterval) ? rawInterval : DEFAULT_GAS_POLL_INTERVAL_MS))
    );
    this.pollerIntervalMs = intervalMs;
    this.pollerOptions = { ...opts, intervalMs };

    this.pollerTimer = setInterval(() => {
      void this.runPollerTick();
    }, intervalMs);
    this.pollerTimer.unref?.();

    if (opts.runImmediately) {
      void this.runPollerTick();
    }

    return this.getPollerStatus();
  }

  stopPoller(): void {
    if (this.pollerTimer) {
      clearInterval(this.pollerTimer);
      this.pollerTimer = null;
    }
  }

  dispose(): void {
    this.stopPoller();
  }

  getPollerStatus(): GasWatchPollerStatus {
    const now = this.nowMs();
    let armedCount = 0;
    let readyCount = 0;
    for (const trigger of this.triggers.values()) {
      if (trigger.status === 'watching' && Date.parse(trigger.expiresAt) > now) {
        armedCount += 1;
      } else if (trigger.status === 'ready') {
        readyCount += 1;
      }
    }
    return {
      running: this.pollerTimer !== null,
      intervalMs: this.pollerIntervalMs,
      tickInFlight: this.tickInFlight,
      armedCount,
      readyCount,
      totalTriggers: this.triggers.size,
      ticksTotal: this.ticksTotal,
      skippedIdleTicks: this.skippedIdleTicks,
      rpcFetchCount: this.rpcFetchCount,
      triggeredCount: this.triggeredCount,
      errorCount: this.errorCount,
      lastTickAt: this.lastTickAt,
      lastTriggeredAt: this.lastTriggeredAt,
      lastError: this.lastError,
      lastObservedGasGwei: { ...this.lastObservedGasGwei },
    };
  }

  getPollerMetrics(): GasWatchPollerStatus {
    return this.getPollerStatus();
  }
}

/**
 * Pure standalone evaluator helper matching the required functional API signature.
 * Transitions watching triggers to `'ready'` strictly when `liveGas <= maxBaseFeeGwei`
 * and never enables auto-execution without a verified active mandate.
 */
export function evaluateGasWatchTriggers(
  triggers: GasWatchTrigger[],
  liveGasByChain: Partial<Record<EvmChainId, number>>,
  options: {
    nowMs?: number;
    mandateValidator?: (mandateId: string, trigger: GasWatchTrigger) => boolean;
  } = {}
): GasWatchTrigger[] {
  const now = options.nowMs ?? Date.now();
  const nowIso = new Date(now).toISOString();

  return triggers.map((orig) => {
    const next: GasWatchTrigger = { ...orig };

    if (next.status === 'watching' && Date.parse(next.expiresAt) <= now) {
      next.status = 'expired';
      next.autoExecuteAllowed = false;
      next.safetyNote = 'Gas-window trigger expired before target gas was reached.';
      return next;
    }

    if (next.status === 'cancelled' || next.status === 'expired') {
      next.autoExecuteAllowed = false;
      return next;
    }

    const currentGwei = liveGasByChain[next.chain];
    if (typeof currentGwei === 'number' && Number.isFinite(currentGwei) && currentGwei >= 0) {
      next.lastObservedGwei = r2(currentGwei);
      if (next.status === 'watching' && currentGwei <= next.maxBaseFeeGwei) {
        next.status = 'ready';
        next.readyAt = nowIso;
      }
    }

    const mandateValid = Boolean(
      next.status === 'ready' &&
        next.mandateId &&
        options.mandateValidator &&
        options.mandateValidator(next.mandateId, next)
    );
    next.autoExecuteAllowed = mandateValid;
    if (next.status === 'ready') {
      next.safetyNote = mandateValid
        ? `Gas window met (${next.lastObservedGwei ?? next.maxBaseFeeGwei} ≤ ${next.maxBaseFeeGwei} gwei) and active mandate ${next.mandateId} verified.`
        : `Gas window met (${next.lastObservedGwei ?? next.maxBaseFeeGwei} ≤ ${next.maxBaseFeeGwei} gwei) — fail-closed without a signed mandate.`;
    }
    return next;
  });
}

/**
 * Dust Auto-Harvest Eligibility Evaluator:
 * Ensures autonomous agents NEVER waste gas sweeping tiny $1 dust piles.
 * Requires BOTH:
 *   1. `netBatchedUsd >= minHarvestUsd` (default $10)
 *   2. `preservationRatePct >= minPreservationRatePct` (default 85%)
 */
export function evaluateDustAutoHarvestEligibility(
  scanReport: ScanReport,
  options: DustAutoHarvestOptions = {}
): DustAutoHarvestEvaluation {
  const minHarvestUsd =
    typeof options.minHarvestUsd === 'number' &&
    Number.isFinite(options.minHarvestUsd) &&
    options.minHarvestUsd > 0
      ? r2(options.minHarvestUsd)
      : 10;
  const minPreservationRatePct =
    typeof options.minPreservationRatePct === 'number' &&
    Number.isFinite(options.minPreservationRatePct) &&
    options.minPreservationRatePct > 0 &&
    options.minPreservationRatePct <= 100
      ? r2(options.minPreservationRatePct)
      : 85;
  const maxDustThresholdUsd =
    typeof options.maxDustThresholdUsd === 'number' &&
    Number.isFinite(options.maxDustThresholdUsd) &&
    options.maxDustThresholdUsd > 0
      ? r2(options.maxDustThresholdUsd)
      : 25;

  const dustPlan = planDustConversion({
    scan: scanReport,
    maxDustThresholdUsd,
    protocolFeeBps: options.protocolFeeBps,
    hasSolanaUsdcAta: options.hasSolanaUsdcAta ?? true,
  });

  const grossDustUsd = r2(Math.max(0, dustPlan.grossConvertibleDustUsd));
  const netBatchedUsd = r2(Math.max(0, dustPlan.estimatedNetSolanaUsdc));
  const totalCostUsd = r2(Math.max(0, grossDustUsd - netBatchedUsd));
  const preservationRatePct =
    grossDustUsd > 0 ? r2(Math.max(0, Math.min(100, (netBatchedUsd / grossDustUsd) * 100))) : 0;
  const shortfallUsd = r2(Math.max(0, minHarvestUsd - netBatchedUsd));

  const eligibleChains = Array.from(
    new Set(
      dustPlan.chains
        .filter((c) => c.convertibleAssetIds.length > 0 && c.batchedConversionNetUsd > 0)
        .map((c) => c.chain)
    )
  );

  const meetsAmount = netBatchedUsd >= minHarvestUsd;
  const meetsPreservation = preservationRatePct >= minPreservationRatePct;
  const eligible = dustPlan.convertibleCount > 0 && meetsAmount && meetsPreservation;
  const canAutoExecute = eligible && Boolean(options.hasValidMandate);

  let reason: string;
  if (dustPlan.convertibleCount === 0) {
    reason = 'No profitable convertible dust detected across scanned chains.';
  } else if (!meetsAmount) {
    reason = `Accumulated dust net ($${netBatchedUsd.toFixed(2)}) is below the $${minHarvestUsd.toFixed(2)} minimum harvest threshold (need +$${shortfallUsd.toFixed(2)} more before sweeping).`;
  } else if (!meetsPreservation) {
    reason = `Batched dust preservation rate (${preservationRatePct.toFixed(1)}%) is below the ${minPreservationRatePct.toFixed(0)}% efficiency floor — hold until gas drops or more dust accumulates.`;
  } else if (!canAutoExecute) {
    reason = `Ready to harvest $${netBatchedUsd.toFixed(2)} net across ${eligibleChains.length} chain(s) (${preservationRatePct.toFixed(1)}% kept) — awaiting user confirmation or signed mandate.`;
  } else {
    reason = `Eligible for autonomous dust harvest: $${netBatchedUsd.toFixed(2)} net across ${eligibleChains.length} chain(s) (${preservationRatePct.toFixed(1)}% preserved).`;
  }

  return {
    eligible,
    canAutoExecute,
    grossDustUsd,
    netBatchedUsd,
    totalCostUsd,
    preservationRatePct,
    convertibleCount: dustPlan.convertibleCount,
    rescuedByBatchCount: dustPlan.rescuedByBatchCount,
    skippedDustCount: dustPlan.skippedUnprofitableCount,
    minHarvestUsd,
    minPreservationRatePct,
    shortfallUsd,
    eligibleChains,
    convertibleAssetIds: dustPlan.convertibleAssetIds,
    reason,
  };
}
