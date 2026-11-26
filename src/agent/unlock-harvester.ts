import crypto from 'node:crypto';
import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import {
  readLiveUnlockQueues,
  type LiveUnlockQueuesReport,
  type LiveUnlockScheduleItem,
  type ReadLiveUnlockQueuesOptions,
} from '../defi/unlock-readers.js';
import { validateCosmosAddress, validateEvmHexAddress } from '../scanner/address.js';
import { DEAD_BURN_ADDRESS } from '../scanner/chains.js';
import { sanitizeFreeText } from '../scanner/sanitize.js';
import type { AnyChainId } from '../scanner/types.js';
import type { TurgaliumStateStore } from '../storage/state-store.js';

export const MAX_UNLOCK_WATCHES = 50;
export const DEFAULT_UNLOCK_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const MAX_ADDRESSES_PER_FAMILY = 10;
const MAX_NOTIFIED_KEYS_PER_WATCH = 200;
const MAX_PERSISTED_ALERTS = 200;
const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

export type UnlockWatchStatus = 'watching' | 'ready_to_claim' | 'paused' | 'cancelled';

export type UnlockQueuesReaderFn = (
  options: ReadLiveUnlockQueuesOptions
) => Promise<LiveUnlockQueuesReport>;

export interface UnlockHarvestAlert {
  alertKey: string;
  watchId: string;
  itemId: string;
  kind: LiveUnlockScheduleItem['kind'];
  chain: AnyChainId;
  chainName: string;
  symbol: string;
  protocol: string;
  estimatedUsd: number;
  uiAmount?: number;
  requestId?: string;
  validatorAddress?: string;
  contractAddress?: string;
  claimMethod?: string;
  actionLabel: string;
  solanaDestination?: string;
  detectedAt: string;
  /** Non-custodial invariant: harvested unlock alerts always require explicit human approval or verified mandate. */
  requiresHumanApproval: true;
}

export interface UnlockWatchEntry {
  id: string;
  walletAddress: string;
  evmAddresses: string[];
  cosmosAddresses: string[];
  solanaDestination?: string;
  label?: string;
  createdAt: string;
  lastCheckedAt: string | null;
  status: UnlockWatchStatus;
  readyUnlocks: LiveUnlockScheduleItem[];
  pendingUnlocksCount: number;
  notifiedKeys: string[];
  lastWarnings: string[];
  cancelledAt?: string;
}

export interface CreateUnlockWatchInput {
  walletAddress?: string;
  evmAddresses?: string[];
  cosmosAddresses?: string[];
  solanaDestination?: string;
  label?: string;
}

export interface UnlockHarvesterStoreOptions {
  maxWatches?: number;
  nowMs?: () => number;
  stateStore?: TurgaliumStateStore;
  readUnlockQueues?: UnlockQueuesReaderFn;
}

export interface UnlockHarvesterPollerOptions {
  /** Polling interval in milliseconds (default 300_000 ms / 5 min; min 25 ms for tests). */
  intervalMs?: number;
  /** Custom unlock queues reader (defaults to live `readLiveUnlockQueues`). */
  readUnlockQueues?: UnlockQueuesReaderFn;
  /** Per-reader RPC timeout in ms. */
  timeoutMs?: number;
  /** Optional notification / approval-proposal hook invoked once per newly matured unlock. */
  onReadyUnlock?: (alert: UnlockHarvestAlert, watch: UnlockWatchEntry) => void | Promise<void>;
  /** Optionally trigger an immediate check on startup (default false). */
  runImmediately?: boolean;
}

export interface UnlockHarvesterPollerStatus {
  running: boolean;
  intervalMs: number;
  tickInFlight: boolean;
  activeWatches: number;
  readyWatches: number;
  pausedWatches: number;
  cancelledWatches: number;
  totalWatches: number;
  totalReadyUnlocks: number;
  totalPendingUnlocks: number;
  alertsCount: number;
  ticksTotal: number;
  skippedIdleTicks: number;
  rpcChecksTotal: number;
  newAlertsEmitted: number;
  errorCount: number;
  lastTickAt: string | null;
  lastReadyDetectedAt: string | null;
  lastError: string | null;
}

export interface UnlockCheckResult {
  checkedAt: string;
  checkedWatches: number;
  readyWatches: number;
  totalReadyUnlocks: number;
  totalPendingUnlocks: number;
  newAlerts: UnlockHarvestAlert[];
  watches: UnlockWatchEntry[];
  warnings: string[];
}

interface PersistedUnlockHarvesterState {
  watches: UnlockWatchEntry[];
  alerts: UnlockHarvestAlert[];
}

function isReadyUnlockStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  const norm = status.trim().toLowerCase();
  return norm === 'ready_to_claim' || norm === 'claimable' || norm === 'ready';
}

function computeUnlockAlertKey(item: LiveUnlockScheduleItem): string {
  const cleanId = typeof item.id === 'string' ? item.id.trim() : '';
  if (cleanId) return cleanId;
  return `${item.kind}:${item.chain}:${item.requestId ?? item.validatorAddress ?? item.symbol}`;
}

function assertValidEvmAddress(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw new Error(`${field} must be a valid 20-byte 0x EVM address string.`);
  }
  const res = validateEvmHexAddress(raw);
  if (!res.valid || !res.normalized) {
    throw new Error(`Invalid ${field}: ${res.reason ?? 'expected a valid 0x EVM address.'}`);
  }
  const lower = res.normalized.toLowerCase();
  if (lower === ZERO_EVM_ADDRESS || lower === DEAD_BURN_ADDRESS.toLowerCase()) {
    throw new Error(`${field} cannot be the zero or burn address.`);
  }
  return res.normalized;
}

function assertValidCosmosAddress(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw new Error(`${field} must be a valid Cosmos Bech32 address string.`);
  }
  const res = validateCosmosAddress(raw);
  if (!res.valid || !res.normalized) {
    throw new Error(`Invalid ${field}: ${res.reason ?? 'expected a valid Cosmos Bech32 address.'}`);
  }
  return res.normalized;
}

function cloneWatch(w: UnlockWatchEntry): UnlockWatchEntry {
  return {
    ...w,
    evmAddresses: [...w.evmAddresses],
    cosmosAddresses: [...w.cosmosAddresses],
    readyUnlocks: w.readyUnlocks.map((item) => ({ ...item })),
    notifiedKeys: [...w.notifiedKeys],
    lastWarnings: [...w.lastWarnings],
  };
}

/**
 * Autonomous DeFi Unlock & Unbonding Harvester Store + `.unref()` Background Poller.
 *
 * Monitors Lido Withdrawal Queue NFTs, Ethena sUSDe cooldowns, and Cosmos SDK unbonding
 * delegations across watched wallets with:
 *  - Zero RPC traffic when 0 active watches are registered.
 *  - Single-flight tick guard (`tickInFlight`) to prevent overlapping slow RPC polls.
 *  - `.unref()` interval timers so Node exits cleanly and tests never hang.
 *  - Deduplicated ready-to-claim harvest alerts persisted atomically via `TurgaliumStateStore`.
 *  - Non-custodial fail-closed design: alerts require explicit user approval or verified mandate.
 */
export class UnlockHarvesterStore {
  private readonly watches = new Map<string, UnlockWatchEntry>();
  private alerts: UnlockHarvestAlert[] = [];
  private readonly maxWatches: number;
  private readonly nowMs: () => number;
  private readonly stateStore?: TurgaliumStateStore;
  private readonly defaultReader: UnlockQueuesReaderFn;

  private pollerTimer: ReturnType<typeof setInterval> | null = null;
  private pollerOptions: UnlockHarvesterPollerOptions | null = null;
  private pollerIntervalMs = DEFAULT_UNLOCK_POLL_INTERVAL_MS;
  private tickInFlight = false;
  private ticksTotal = 0;
  private skippedIdleTicks = 0;
  private rpcChecksTotal = 0;
  private newAlertsEmitted = 0;
  private errorCount = 0;
  private lastTickAt: string | null = null;
  private lastReadyDetectedAt: string | null = null;
  private lastError: string | null = null;

  constructor(opts: UnlockHarvesterStoreOptions = {}) {
    this.maxWatches = Math.max(1, Math.floor(opts.maxWatches ?? MAX_UNLOCK_WATCHES));
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.stateStore = opts.stateStore;
    this.defaultReader = opts.readUnlockQueues ?? readLiveUnlockQueues;
    if (this.stateStore) {
      this.hydrateFromStore();
    }
  }

  private hydrateFromStore(): void {
    if (!this.stateStore) return;
    const saved = this.stateStore.load<PersistedUnlockHarvesterState | UnlockWatchEntry[]>(
      'unlock_harvester',
      { watches: [], alerts: [] }
    );
    const savedWatches = Array.isArray(saved)
      ? saved
      : saved && typeof saved === 'object' && Array.isArray(saved.watches)
        ? saved.watches
        : [];
    const savedAlerts =
      !Array.isArray(saved) && saved && typeof saved === 'object' && Array.isArray(saved.alerts)
        ? saved.alerts
        : [];

    for (const item of savedWatches) {
      if (item && typeof item === 'object' && typeof item.id === 'string') {
        this.watches.set(item.id, {
          ...item,
          evmAddresses: Array.isArray(item.evmAddresses) ? item.evmAddresses : [],
          cosmosAddresses: Array.isArray(item.cosmosAddresses) ? item.cosmosAddresses : [],
          readyUnlocks: Array.isArray(item.readyUnlocks) ? item.readyUnlocks : [],
          notifiedKeys: Array.isArray(item.notifiedKeys) ? item.notifiedKeys : [],
          lastWarnings: Array.isArray(item.lastWarnings) ? item.lastWarnings : [],
          pendingUnlocksCount:
            typeof item.pendingUnlocksCount === 'number' && Number.isFinite(item.pendingUnlocksCount)
              ? item.pendingUnlocksCount
              : 0,
          lastCheckedAt: typeof item.lastCheckedAt === 'string' ? item.lastCheckedAt : null,
        });
      }
    }
    while (this.watches.size > this.maxWatches) {
      const oldestKey = this.watches.keys().next().value;
      if (!oldestKey) break;
      this.watches.delete(oldestKey);
    }

    this.alerts = savedAlerts
      .filter((a) => a && typeof a === 'object' && typeof a.alertKey === 'string')
      .slice(-MAX_PERSISTED_ALERTS);
  }

  private persist(): void {
    if (!this.stateStore) return;
    const state: PersistedUnlockHarvesterState = {
      watches: Array.from(this.watches.values()),
      alerts: this.alerts.slice(-MAX_PERSISTED_ALERTS),
    };
    this.stateStore.save('unlock_harvester', state);
  }

  get capacity(): number {
    return this.maxWatches;
  }

  get size(): number {
    return this.watches.size;
  }

  createWatch(input: CreateUnlockWatchInput): UnlockWatchEntry {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Unlock watch payload must be a JSON object.');
    }

    const evmMap = new Map<string, string>();
    const cosmosSet = new Set<string>();
    let primaryWallet: string | null = null;

    if (input.walletAddress !== undefined && input.walletAddress !== null && input.walletAddress !== '') {
      if (typeof input.walletAddress !== 'string') {
        throw new Error('walletAddress must be a string (valid EVM 0x or Cosmos Bech32 address).');
      }
      const trimmed = input.walletAddress.trim();
      const evmCheck = validateEvmHexAddress(trimmed);
      if (evmCheck.valid && evmCheck.normalized) {
        const lower = evmCheck.normalized.toLowerCase();
        if (lower === ZERO_EVM_ADDRESS || lower === DEAD_BURN_ADDRESS.toLowerCase()) {
          throw new Error('walletAddress cannot be the zero or burn address.');
        }
        evmMap.set(lower, evmCheck.normalized);
        primaryWallet = evmCheck.normalized;
      } else {
        const cosmosCheck = validateCosmosAddress(trimmed);
        if (cosmosCheck.valid && cosmosCheck.normalized) {
          cosmosSet.add(cosmosCheck.normalized);
          primaryWallet = cosmosCheck.normalized;
        } else {
          throw new Error(
            'walletAddress must be a valid EVM (0x...) or Cosmos Bech32 (cosmos1/osmo1/celestia1/inj1/...) address.'
          );
        }
      }
    }

    if (input.evmAddresses !== undefined) {
      if (!Array.isArray(input.evmAddresses)) {
        throw new Error('evmAddresses must be an array of EVM address strings.');
      }
      if (input.evmAddresses.length > MAX_ADDRESSES_PER_FAMILY) {
        throw new Error(`evmAddresses exceeds maximum of ${MAX_ADDRESSES_PER_FAMILY} addresses per watch.`);
      }
      for (const raw of input.evmAddresses) {
        const clean = assertValidEvmAddress(raw, 'evmAddresses[] entry');
        evmMap.set(clean.toLowerCase(), clean);
      }
    }

    if (input.cosmosAddresses !== undefined) {
      if (!Array.isArray(input.cosmosAddresses)) {
        throw new Error('cosmosAddresses must be an array of Cosmos Bech32 address strings.');
      }
      if (input.cosmosAddresses.length > MAX_ADDRESSES_PER_FAMILY) {
        throw new Error(`cosmosAddresses exceeds maximum of ${MAX_ADDRESSES_PER_FAMILY} addresses per watch.`);
      }
      for (const raw of input.cosmosAddresses) {
        const clean = assertValidCosmosAddress(raw, 'cosmosAddresses[] entry');
        cosmosSet.add(clean);
      }
    }

    const evmAddresses = Array.from(evmMap.values());
    const cosmosAddresses = Array.from(cosmosSet.values());
    if (evmAddresses.length === 0 && cosmosAddresses.length === 0) {
      throw new Error(
        'At least one valid EVM or Cosmos address is required (walletAddress, evmAddresses[], or cosmosAddresses[]).'
      );
    }

    let solanaDestination: string | undefined;
    if (
      input.solanaDestination !== undefined &&
      input.solanaDestination !== null &&
      input.solanaDestination !== ''
    ) {
      if (typeof input.solanaDestination !== 'string') {
        throw new Error('solanaDestination must be a valid Solana base58 address string.');
      }
      const trimmedSol = input.solanaDestination.trim();
      try {
        solanaAddressToBytes32(trimmedSol);
      } catch {
        throw new Error('Invalid solanaDestination: expected a valid non-zero Solana base58 public key.');
      }
      solanaDestination = trimmedSol;
    }

    let label: string | undefined;
    if (input.label !== undefined && input.label !== null && input.label !== '') {
      if (typeof input.label !== 'string') {
        throw new Error('label must be a string.');
      }
      const cleanLabel = sanitizeFreeText(input.label, 80);
      if (cleanLabel) label = cleanLabel;
    }

    const nowIso = new Date(this.nowMs()).toISOString();
    const id = `uw_${crypto.randomBytes(6).toString('hex')}`;
    const entry: UnlockWatchEntry = {
      id,
      walletAddress: primaryWallet ?? evmAddresses[0] ?? cosmosAddresses[0],
      evmAddresses,
      cosmosAddresses,
      solanaDestination,
      label,
      createdAt: nowIso,
      lastCheckedAt: null,
      status: 'watching',
      readyUnlocks: [],
      pendingUnlocksCount: 0,
      notifiedKeys: [],
      lastWarnings: [],
    };

    this.watches.set(id, entry);
    while (this.watches.size > this.maxWatches) {
      const oldestKey = this.watches.keys().next().value;
      if (!oldestKey) break;
      this.watches.delete(oldestKey);
    }
    this.persist();

    return cloneWatch(entry);
  }

  getWatch(id: string): UnlockWatchEntry | null {
    const item = this.watches.get(id);
    return item ? cloneWatch(item) : null;
  }

  listWatches(): UnlockWatchEntry[] {
    return Array.from(this.watches.values())
      .map(cloneWatch)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listAlerts(watchId?: string): UnlockHarvestAlert[] {
    const filtered = watchId
      ? this.alerts.filter((a) => a.watchId === watchId)
      : this.alerts;
    return filtered.map((a) => ({ ...a })).reverse();
  }

  cancelWatch(id: string): UnlockWatchEntry | null {
    const item = this.watches.get(id);
    if (!item) return null;
    if (item.status !== 'cancelled') {
      item.status = 'cancelled';
      item.cancelledAt = new Date(this.nowMs()).toISOString();
      this.persist();
    }
    return cloneWatch(item);
  }

  deleteWatch(id: string): UnlockWatchEntry | null {
    const item = this.watches.get(id);
    if (!item) return null;
    item.status = 'cancelled';
    item.cancelledAt = new Date(this.nowMs()).toISOString();
    const snapshot = cloneWatch(item);
    this.watches.delete(id);
    this.persist();
    return snapshot;
  }

  getActiveWatchCount(): number {
    let count = 0;
    for (const w of this.watches.values()) {
      if (w.status === 'watching' || w.status === 'ready_to_claim') {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Checks all active watches against live Lido / Ethena / Cosmos unlock readers,
   * updates each watch's ready/pending state, emits deduplicated harvest alerts,
   * and persists immediately to `TurgaliumStateStore`.
   */
  async checkAllWatches(
    opts: {
      readUnlockQueues?: UnlockQueuesReaderFn;
      timeoutMs?: number;
      onReadyUnlock?: (alert: UnlockHarvestAlert, watch: UnlockWatchEntry) => void | Promise<void>;
    } = {}
  ): Promise<UnlockCheckResult> {
    const now = this.nowMs();
    const nowIso = new Date(now).toISOString();
    const reader = opts.readUnlockQueues ?? this.pollerOptions?.readUnlockQueues ?? this.defaultReader;
    const timeoutMs = opts.timeoutMs ?? this.pollerOptions?.timeoutMs;
    const onReadyUnlock = opts.onReadyUnlock ?? this.pollerOptions?.onReadyUnlock;

    const activeWatches = Array.from(this.watches.values()).filter(
      (w) => w.status === 'watching' || w.status === 'ready_to_claim'
    );

    const newAlerts: UnlockHarvestAlert[] = [];
    const warnings: string[] = [];
    let checkedWatches = 0;

    for (const watch of activeWatches) {
      checkedWatches += 1;
      this.rpcChecksTotal += 1;
      try {
        const report = await reader({
          evmAddresses: watch.evmAddresses,
          cosmosAddresses: watch.cosmosAddresses,
          nowMs: now,
          timeoutMs,
        });

        const items = Array.isArray(report?.items) ? report.items : [];
        const readyUnlocks = items.filter((item) => isReadyUnlockStatus(item.status));
        const pendingUnlocksCount = items.length - readyUnlocks.length;
        const reportWarnings = Array.isArray(report?.warnings) ? report.warnings : [];

        watch.lastCheckedAt = nowIso;
        watch.readyUnlocks = readyUnlocks.map((item) => ({ ...item }));
        watch.pendingUnlocksCount = Math.max(0, pendingUnlocksCount);
        watch.lastWarnings = [...reportWarnings];
        watch.status = readyUnlocks.length > 0 ? 'ready_to_claim' : 'watching';

        for (const wMsg of reportWarnings) {
          warnings.push(`[${watch.id}] ${wMsg}`);
        }

        const notifiedSet = new Set(watch.notifiedKeys);
        for (const item of readyUnlocks) {
          const alertKey = computeUnlockAlertKey(item);
          if (notifiedSet.has(alertKey)) continue;

          notifiedSet.add(alertKey);
          watch.notifiedKeys.push(alertKey);
          if (watch.notifiedKeys.length > MAX_NOTIFIED_KEYS_PER_WATCH) {
            watch.notifiedKeys = watch.notifiedKeys.slice(-MAX_NOTIFIED_KEYS_PER_WATCH);
          }

          const alert: UnlockHarvestAlert = {
            alertKey,
            watchId: watch.id,
            itemId: item.id,
            kind: item.kind,
            chain: item.chain,
            chainName: item.chainName,
            symbol: item.symbol,
            protocol: item.protocol,
            estimatedUsd: item.estimatedUsd,
            uiAmount: item.uiAmount,
            requestId: item.requestId,
            validatorAddress: item.validatorAddress,
            contractAddress: item.contractAddress,
            claimMethod: item.claimMethod,
            actionLabel: item.actionLabel,
            solanaDestination: watch.solanaDestination,
            detectedAt: nowIso,
            requiresHumanApproval: true,
          };

          newAlerts.push(alert);
          this.alerts.push(alert);
          if (this.alerts.length > MAX_PERSISTED_ALERTS) {
            this.alerts = this.alerts.slice(-MAX_PERSISTED_ALERTS);
          }
          this.newAlertsEmitted += 1;
          this.lastReadyDetectedAt = nowIso;

          if (onReadyUnlock) {
            try {
              await onReadyUnlock({ ...alert }, cloneWatch(watch));
            } catch (cbErr) {
              this.errorCount += 1;
              this.lastError =
                cbErr instanceof Error ? cbErr.message : String(cbErr);
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.errorCount += 1;
        this.lastError = msg;
        watch.lastCheckedAt = nowIso;
        watch.lastWarnings = [msg];
        warnings.push(`[${watch.id}] Unlock check failed: ${msg}`);
      }
    }

    if (checkedWatches > 0) {
      this.persist();
    }

    const watches = this.listWatches();
    let readyWatches = 0;
    let totalReadyUnlocks = 0;
    let totalPendingUnlocks = 0;
    for (const w of watches) {
      if (w.status === 'ready_to_claim') readyWatches += 1;
      if (w.status === 'watching' || w.status === 'ready_to_claim') {
        totalReadyUnlocks += w.readyUnlocks.length;
        totalPendingUnlocks += w.pendingUnlocksCount;
      }
    }

    return {
      checkedAt: nowIso,
      checkedWatches,
      readyWatches,
      totalReadyUnlocks,
      totalPendingUnlocks,
      newAlerts,
      watches,
      warnings,
    };
  }

  /**
   * Executes a single non-overlapping poller tick.
   * Zero idle cost: skips immediately without calling any RPC when 0 active watches exist.
   */
  async runPollerTick(
    overrideOpts?: Partial<UnlockHarvesterPollerOptions>
  ): Promise<UnlockCheckResult | null> {
    if (this.tickInFlight) {
      return null;
    }
    this.tickInFlight = true;
    try {
      this.ticksTotal += 1;
      this.lastTickAt = new Date(this.nowMs()).toISOString();

      if (this.getActiveWatchCount() === 0) {
        this.skippedIdleTicks += 1;
        return null;
      }

      return await this.checkAllWatches({
        readUnlockQueues: overrideOpts?.readUnlockQueues ?? this.pollerOptions?.readUnlockQueues,
        timeoutMs: overrideOpts?.timeoutMs ?? this.pollerOptions?.timeoutMs,
        onReadyUnlock: overrideOpts?.onReadyUnlock ?? this.pollerOptions?.onReadyUnlock,
      });
    } finally {
      this.tickInFlight = false;
    }
  }

  /**
   * Starts the autonomous `.unref()` background poller loop for DeFi unlock harvesting.
   * Safe for tests & graceful shutdown: timer is always `.unref()`'d.
   */
  startPoller(opts: UnlockHarvesterPollerOptions = {}): UnlockHarvesterPollerStatus {
    this.stopPoller();
    const rawInterval = opts.intervalMs ?? DEFAULT_UNLOCK_POLL_INTERVAL_MS;
    const intervalMs = Math.max(
      25,
      Math.min(86_400_000, Math.floor(Number.isFinite(rawInterval) ? rawInterval : DEFAULT_UNLOCK_POLL_INTERVAL_MS))
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

  getPollerStatus(): UnlockHarvesterPollerStatus {
    let activeWatches = 0;
    let readyWatches = 0;
    let pausedWatches = 0;
    let cancelledWatches = 0;
    let totalReadyUnlocks = 0;
    let totalPendingUnlocks = 0;

    for (const w of this.watches.values()) {
      if (w.status === 'watching') {
        activeWatches += 1;
        totalPendingUnlocks += w.pendingUnlocksCount;
      } else if (w.status === 'ready_to_claim') {
        activeWatches += 1;
        readyWatches += 1;
        totalReadyUnlocks += w.readyUnlocks.length;
        totalPendingUnlocks += w.pendingUnlocksCount;
      } else if (w.status === 'paused') {
        pausedWatches += 1;
      } else if (w.status === 'cancelled') {
        cancelledWatches += 1;
      }
    }

    return {
      running: this.pollerTimer !== null,
      intervalMs: this.pollerIntervalMs,
      tickInFlight: this.tickInFlight,
      activeWatches,
      readyWatches,
      pausedWatches,
      cancelledWatches,
      totalWatches: this.watches.size,
      totalReadyUnlocks,
      totalPendingUnlocks,
      alertsCount: this.alerts.length,
      ticksTotal: this.ticksTotal,
      skippedIdleTicks: this.skippedIdleTicks,
      rpcChecksTotal: this.rpcChecksTotal,
      newAlertsEmitted: this.newAlertsEmitted,
      errorCount: this.errorCount,
      lastTickAt: this.lastTickAt,
      lastReadyDetectedAt: this.lastReadyDetectedAt,
      lastError: this.lastError,
    };
  }

  getPollerMetrics(): UnlockHarvesterPollerStatus {
    return this.getPollerStatus();
  }
}
