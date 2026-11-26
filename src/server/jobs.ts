import crypto from 'node:crypto';
import { fetchCctpAttestationForTx } from '../bridge/cctp.js';
import { checkLiveExecutionStatus } from '../execution/tx-builder.js';
import { EVM_CHAINS } from '../scanner/chains.js';
import type { AnyChainId, EvmChainId } from '../scanner/types.js';
import type { TurgaliumStateStore } from '../storage/state-store.js';

const NON_EVM_EXPLORERS: Record<string, string> = {
  cosmoshub: 'https://www.mintscan.io/cosmos',
  osmosis: 'https://www.mintscan.io/osmosis',
  noble: 'https://www.mintscan.io/noble',
  celestia: 'https://www.mintscan.io/celestia',
  injective: 'https://www.mintscan.io/injective',
  neutron: 'https://www.mintscan.io/neutron',
  sui: 'https://suiscan.xyz/mainnet',
  aptos: 'https://explorer.aptoslabs.com',
  ton: 'https://tonviewer.com',
  tron: 'https://tronscan.org/#',
  btc: 'https://mempool.space',
};

export const DEFAULT_POLL_INTERVAL_MS = 3500;
export const DEFAULT_POLL_WINDOW_MS = 180_000; // 3 min for fast L2/Relay legs
export const ETHEREUM_CCTP_POLL_WINDOW_MS = 1_020_000; // 17 min (> 780s ETH CCTP finality + buffer)

export function isEvmChainId(chain: string): chain is EvmChainId {
  return typeof chain === 'string' && Object.hasOwn(EVM_CHAINS, chain);
}

export type JobLegStatus =
  | 'queued'
  | 'preparing'
  | 'signing'
  | 'confirming'
  | 'relaying'
  | 'attested'
  | 'landed'
  | 'failed'
  | 'skipped';

export const VALID_JOB_LEG_STATUSES = new Set<JobLegStatus>([
  'queued',
  'preparing',
  'signing',
  'confirming',
  'relaying',
  'attested',
  'landed',
  'failed',
  'skipped',
]);

export function isValidJobLegStatus(status: unknown): status is JobLegStatus {
  return typeof status === 'string' && VALID_JOB_LEG_STATUSES.has(status as JobLegStatus);
}

const POLLER_EXIT_STATUSES = new Set<JobLegStatus>(['landed', 'attested', 'failed', 'skipped']);
const TERMINAL_JOB_LEG_STATUSES = new Set<JobLegStatus>(['landed', 'failed', 'skipped']);

export interface BackgroundJobLeg {
  legId: string;
  sourceWallet: string;
  chain: AnyChainId;
  chainName: string;
  explorerUrl: string;
  assetCount: number;
  estimatedNetUsd: number;
  estimatedFeeUsd: number;
  status: JobLegStatus;
  statusText: string;
  provider?: string;
  callsBatched?: number;
  popupsSaved?: number;
  evmTxHash?: string;
  solanaTxHash?: string;
  requestId?: string;
  requiresSolanaClaim?: boolean;
  attestationStatus?: string;
  updatedAt: string;
}

export type BackgroundJobLegPatch = Partial<
  Omit<BackgroundJobLeg, 'legId' | 'sourceWallet' | 'chain' | 'chainName' | 'explorerUrl'>
>;

export type JobLegTarget =
  | AnyChainId
  | string
  | {
      legId?: string;
      chain?: AnyChainId;
      sourceWallet?: string;
      walletAddress?: string;
    };

export interface BackgroundJob {
  jobId: string;
  createdAt: string;
  updatedAt: string;
  sourceWallet: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp';
  protocolFeeBps: number;
  feeRecipientEvm: string | null;
  status: 'active' | 'completed' | 'partial' | 'failed' | 'skipped';
  totalNetUsd: number;
  settledNetUsd: number;
  attestedNetUsd: number;
  legs: BackgroundJobLeg[];
}

export interface BackgroundJobStoreOptions {
  maxJobs?: number;
  ttlMs?: number;
  nowMs?: () => number;
  pollIntervalMs?: number;
  statusChecker?: typeof checkLiveExecutionStatus;
  attestationFetcher?: typeof fetchCctpAttestationForTx;
  stateStore?: TurgaliumStateStore;
  resumePollersOnLoad?: boolean;
}

const DEFAULT_MAX_JOBS = 30;
const DEFAULT_JOB_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Computes the polling window and maxAttempts for a leg so Ethereum CCTP legs cover
 * the full ~780s Circle Iris finality window (+ buffer) instead of timing out at 140s.
 */
export function computePollerMaxAttempts(
  chain: EvmChainId,
  leg: Pick<BackgroundJobLeg, 'provider' | 'requiresSolanaClaim'>,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
): number {
  const interval = Math.max(10, pollIntervalMs);
  const cfg = EVM_CHAINS[chain];
  const cctpWindowMs = cfg ? (cfg.cctpAttestationSec + 240) * 1000 : DEFAULT_POLL_WINDOW_MS;
  const isEthCctp =
    chain === 'ethereum' &&
    (Boolean(leg.requiresSolanaClaim) || leg.provider === 'circle_cctp' || !leg.provider);
  const targetWindowMs = isEthCctp
    ? Math.max(ETHEREUM_CCTP_POLL_WINDOW_MS, cctpWindowMs)
    : leg.requiresSolanaClaim || leg.provider === 'circle_cctp'
    ? Math.max(DEFAULT_POLL_WINDOW_MS, cctpWindowMs)
    : DEFAULT_POLL_WINDOW_MS;
  return Math.max(40, Math.ceil(targetWindowMs / interval));
}

export function sanitizeLegPatch(patch: BackgroundJobLegPatch): BackgroundJobLegPatch {
  const clean: BackgroundJobLegPatch = {};
  if (patch.status !== undefined) {
    if (!isValidJobLegStatus(patch.status)) {
      throw new Error(`Invalid leg status: ${String(patch.status)}`);
    }
    clean.status = patch.status;
  }
  if (patch.statusText !== undefined) clean.statusText = String(patch.statusText);
  if (patch.provider !== undefined) clean.provider = String(patch.provider);
  if (patch.callsBatched !== undefined) {
    if (typeof patch.callsBatched !== 'number' || !Number.isInteger(patch.callsBatched) || patch.callsBatched < 0) {
      throw new Error('Invalid callsBatched: must be a non-negative integer');
    }
    clean.callsBatched = patch.callsBatched;
  }
  if (patch.popupsSaved !== undefined) {
    if (typeof patch.popupsSaved !== 'number' || !Number.isInteger(patch.popupsSaved) || patch.popupsSaved < 0) {
      throw new Error('Invalid popupsSaved: must be a non-negative integer');
    }
    clean.popupsSaved = patch.popupsSaved;
  }
  if (patch.evmTxHash !== undefined) clean.evmTxHash = String(patch.evmTxHash);
  if (patch.solanaTxHash !== undefined) clean.solanaTxHash = String(patch.solanaTxHash);
  if (patch.requestId !== undefined) clean.requestId = String(patch.requestId);
  if (patch.requiresSolanaClaim !== undefined) {
    clean.requiresSolanaClaim = Boolean(patch.requiresSolanaClaim);
  }
  if (patch.attestationStatus !== undefined) clean.attestationStatus = String(patch.attestationStatus);
  return clean;
}

export class BackgroundJobStore {
  private jobs = new Map<string, { job: BackgroundJob; expiresAt: number }>();
  private pollTimers = new Map<string, NodeJS.Timeout>();
  private pollInFlight = new Set<string>();
  private readonly maxJobs: number;
  private readonly ttlMs: number;
  private readonly nowMs: () => number;
  private readonly pollIntervalMs: number;
  private readonly statusChecker: typeof checkLiveExecutionStatus;
  private readonly attestationFetcher: typeof fetchCctpAttestationForTx;
  private readonly stateStore?: TurgaliumStateStore;

  constructor(opts: BackgroundJobStoreOptions = {}) {
    this.maxJobs = Math.max(1, Math.floor(opts.maxJobs ?? DEFAULT_MAX_JOBS));
    this.ttlMs = Math.max(1, Math.floor(opts.ttlMs ?? DEFAULT_JOB_TTL_MS));
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.pollIntervalMs = Math.max(10, opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.statusChecker = opts.statusChecker ?? checkLiveExecutionStatus;
    this.attestationFetcher = opts.attestationFetcher ?? fetchCctpAttestationForTx;
    this.stateStore = opts.stateStore;
    if (this.stateStore) {
      this.hydrateFromStore(Boolean(opts.resumePollersOnLoad));
    }
  }

  private hydrateFromStore(resumePollers: boolean): void {
    if (!this.stateStore) return;
    const saved = this.stateStore.load<Array<{ job: BackgroundJob; expiresAt: number }>>('jobs', []);
    if (!Array.isArray(saved)) return;
    const now = this.nowMs();
    for (const entry of saved) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !entry.job ||
        typeof entry.job.jobId !== 'string' ||
        typeof entry.expiresAt !== 'number' ||
        !Number.isFinite(entry.expiresAt) ||
        now >= entry.expiresAt
      ) {
        continue;
      }
      this.jobs.set(entry.job.jobId, { job: entry.job, expiresAt: entry.expiresAt });
    }
    this.pruneInactiveJobs();
    if (resumePollers) {
      this.resumeActivePollers();
    }
  }

  private persist(): void {
    if (!this.stateStore) return;
    const entries = Array.from(this.jobs.values());
    this.stateStore.save('jobs', entries);
  }

  /**
   * Resumes background settlement pollers for any persisted in-flight EVM legs after restart.
   */
  resumeActivePollers(): number {
    const now = this.nowMs();
    let resumed = 0;
    for (const [jobId, entry] of this.jobs.entries()) {
      if (now >= entry.expiresAt || entry.job.status !== 'active') continue;
      for (const leg of entry.job.legs) {
        if (
          isEvmChainId(leg.chain) &&
          (leg.status === 'confirming' || leg.status === 'relaying') &&
          (leg.evmTxHash || leg.requestId)
        ) {
          this.ensureBackgroundPoller(jobId, leg.legId, leg.chain);
          resumed += 1;
        }
      }
    }
    return resumed;
  }

  pruneExpired(now = this.nowMs()): number {
    let removed = 0;
    for (const [jobId, entry] of this.jobs.entries()) {
      if (now >= entry.expiresAt) {
        this.clearPollersForJob(jobId);
        this.jobs.delete(jobId);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.persist();
    }
    return removed;
  }

  createJob(input: {
    sourceWallet: string;
    solanaDestination: string;
    outputAsset: 'USDC' | 'SOL';
    bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp';
    protocolFeeBps: number;
    feeRecipientEvm: string | null;
    legs: Array<{
      legId?: string;
      sourceWallet?: string;
      walletAddress?: string;
      chain: AnyChainId;
      chainName?: string;
      assetCount: number;
      estimatedNetUsd: number;
      estimatedFeeUsd?: number;
    }>;
  }): BackgroundJob {
    if (!Array.isArray(input.legs)) {
      throw new Error('legs must be an array');
    }

    const nowMs = this.nowMs();
    this.pruneExpired(nowMs);
    const now = new Date(nowMs).toISOString();
    const jobId = `job_${crypto.randomBytes(5).toString('hex')}`;
    const seenLegIds = new Set<string>();

    const legs: BackgroundJobLeg[] = input.legs.map((l, idx) => {
      if (!l || typeof l !== 'object' || typeof l.chain !== 'string' || !l.chain.trim()) {
        throw new Error(`Invalid leg at index ${idx}: chain is required`);
      }
      if (
        typeof l.assetCount !== 'number' ||
        !Number.isInteger(l.assetCount) ||
        l.assetCount < 0
      ) {
        throw new Error(`Invalid leg assetCount at index ${idx}: must be a non-negative integer`);
      }
      if (typeof l.estimatedNetUsd !== 'number' || !Number.isFinite(l.estimatedNetUsd)) {
        throw new Error(`Invalid leg estimatedNetUsd at index ${idx}: must be a finite number`);
      }
      const feeUsd = l.estimatedFeeUsd ?? 0;
      if (typeof feeUsd !== 'number' || !Number.isFinite(feeUsd) || feeUsd < 0) {
        throw new Error(`Invalid leg estimatedFeeUsd at index ${idx}: must be a finite non-negative number`);
      }

      const legWallet = (l.sourceWallet || l.walletAddress || input.sourceWallet || '').trim();
      const baseLegId = (l.legId && l.legId.trim()) || `${legWallet}:${l.chain}`;
      let legId = baseLegId;
      let suffix = 1;
      while (seenLegIds.has(legId)) {
        legId = `${baseLegId}#${suffix}`;
        suffix += 1;
      }
      seenLegIds.add(legId);

      const cfg = isEvmChainId(l.chain) ? EVM_CHAINS[l.chain] : undefined;
      const nonEvmExplorer = Object.hasOwn(NON_EVM_EXPLORERS, l.chain)
        ? NON_EVM_EXPLORERS[l.chain]
        : undefined;

      return {
        legId,
        sourceWallet: legWallet,
        chain: l.chain,
        chainName: l.chainName || cfg?.name || l.chain,
        explorerUrl: cfg?.explorerUrl || nonEvmExplorer || 'https://etherscan.io',
        assetCount: l.assetCount,
        estimatedNetUsd: Number(l.estimatedNetUsd.toFixed(2)),
        estimatedFeeUsd: Number(feeUsd.toFixed(2)),
        status: 'queued',
        statusText: 'Queued in background agent',
        updatedAt: now,
      };
    });

    const job: BackgroundJob = {
      jobId,
      createdAt: now,
      updatedAt: now,
      sourceWallet: input.sourceWallet,
      solanaDestination: input.solanaDestination,
      outputAsset: input.outputAsset,
      bridgePreference: input.bridgePreference,
      protocolFeeBps: input.protocolFeeBps,
      feeRecipientEvm: input.feeRecipientEvm,
      status: legs.length ? 'active' : 'completed',
      totalNetUsd: Number(legs.reduce((s, l) => s + l.estimatedNetUsd, 0).toFixed(2)),
      settledNetUsd: 0,
      attestedNetUsd: 0,
      legs,
    };

    this.jobs.set(jobId, { job, expiresAt: nowMs + this.ttlMs });
    this.pruneInactiveJobs(jobId);
    this.persist();
    return job;
  }

  private pruneInactiveJobs(protectedJobId?: string): void {
    if (this.jobs.size <= this.maxJobs) return;
    // Pass 1: Evict oldest terminal (non-active) jobs first so active in-progress jobs stay protected
    for (const [candidateId, entry] of this.jobs.entries()) {
      if (candidateId === protectedJobId) continue;
      if (entry.job.status !== 'active') {
        this.clearPollersForJob(candidateId);
        this.jobs.delete(candidateId);
        if (this.jobs.size <= this.maxJobs) return;
      }
    }
    // Pass 2: Hard LRU capacity cap to prevent unbounded memory growth under an all-active job flood
    for (const candidateId of this.jobs.keys()) {
      if (candidateId === protectedJobId) continue;
      this.clearPollersForJob(candidateId);
      this.jobs.delete(candidateId);
      if (this.jobs.size <= this.maxJobs) break;
    }
  }

  listJobs(): BackgroundJob[] {
    this.pruneExpired();
    return Array.from(this.jobs.values())
      .map((entry) => entry.job)
      .reverse();
  }

  getJob(jobId: string): BackgroundJob | null {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    if (this.nowMs() >= entry.expiresAt) {
      this.clearPollersForJob(jobId);
      this.jobs.delete(jobId);
      this.persist();
      return null;
    }
    // Refresh LRU order on read
    this.jobs.delete(jobId);
    this.jobs.set(jobId, entry);
    return entry.job;
  }

  private findLeg(
    job: BackgroundJob,
    target: JobLegTarget,
    opts?: { legId?: string; sourceWallet?: string; walletAddress?: string }
  ): BackgroundJobLeg | undefined {
    const explicitLegId =
      opts?.legId || (typeof target === 'object' && target !== null ? target.legId : undefined);
    if (explicitLegId) {
      return job.legs.find((l) => l.legId === explicitLegId);
    }

    if (typeof target === 'string') {
      // Exact legId match first (supports passing leg.legId directly)
      const byLegId = job.legs.find((l) => l.legId === target);
      if (byLegId) return byLegId;
    }

    const chain = typeof target === 'string' ? target : target?.chain;
    const wallet = (
      opts?.sourceWallet ||
      opts?.walletAddress ||
      (typeof target === 'object' && target !== null
        ? target.sourceWallet || target.walletAddress
        : undefined) ||
      ''
    ).trim();

    if (wallet && chain) {
      // Exact wallet match first (preserves case sensitivity for Base58/TON), then case-insensitive fallback (EVM)
      const exact = job.legs.find((l) => l.chain === chain && l.sourceWallet === wallet);
      if (exact) return exact;
      const lower = wallet.toLowerCase();
      return job.legs.find((l) => l.chain === chain && l.sourceWallet.toLowerCase() === lower);
    }

    if (chain) {
      return job.legs.find((l) => l.chain === chain);
    }

    return undefined;
  }

  updateLeg(
    jobId: string,
    target: JobLegTarget,
    patch: BackgroundJobLegPatch,
    opts?: { legId?: string; sourceWallet?: string; walletAddress?: string }
  ): BackgroundJob | null {
    const entry = this.jobs.get(jobId);
    if (!entry) return null;
    const nowMs = this.nowMs();
    if (nowMs >= entry.expiresAt) {
      this.clearPollersForJob(jobId);
      this.jobs.delete(jobId);
      return null;
    }
    const job = entry.job;
    const leg = this.findLeg(job, target, opts);
    if (!leg) return null;

    const cleanPatch = sanitizeLegPatch(patch);
    Object.assign(leg, cleanPatch, { updatedAt: new Date(nowMs).toISOString() });
    this.recomputeJobSummary(job);
    // Refresh LRU position and extend TTL on active update
    this.jobs.delete(jobId);
    this.jobs.set(jobId, { job, expiresAt: nowMs + this.ttlMs });
    this.persist();

    const pollerKey = `${jobId}:${leg.legId}`;

    // Start autonomous server-side background settlement watcher once an EVM tx or Relay intent exists
    if (
      isEvmChainId(leg.chain) &&
      (leg.status === 'confirming' || leg.status === 'relaying') &&
      (leg.evmTxHash || leg.requestId)
    ) {
      this.ensureBackgroundPoller(jobId, leg.legId, leg.chain);
    } else if (POLLER_EXIT_STATUSES.has(leg.status)) {
      this.clearPoller(pollerKey);
    }

    return job;
  }

  private recomputeJobSummary(job: BackgroundJob): void {
    // Only actually landed legs count toward settledNetUsd; unclaimed 'attested' CCTP legs are tracked separately
    const settled = job.legs
      .filter((l) => l.status === 'landed')
      .reduce((s, l) => s + l.estimatedNetUsd, 0);
    const attested = job.legs
      .filter((l) => l.status === 'attested')
      .reduce((s, l) => s + l.estimatedNetUsd, 0);
    job.settledNetUsd = Number(settled.toFixed(2));
    job.attestedNetUsd = Number(attested.toFixed(2));
    job.updatedAt = new Date().toISOString();

    if (job.legs.length === 0) {
      job.status = 'completed';
      this.pruneInactiveJobs(job.jobId);
      this.persist();
      return;
    }

    // Jobs with queued/in-flight OR unclaimed 'attested' legs remain active until settled/failed/skipped
    const allTerminal = job.legs.every((l) => TERMINAL_JOB_LEG_STATUSES.has(l.status));
    if (!allTerminal) {
      job.status = 'active';
      this.persist();
      return;
    }

    const allSkipped = job.legs.every((l) => l.status === 'skipped');
    const anyLanded = job.legs.some((l) => l.status === 'landed');
    const anyFailed = job.legs.some((l) => l.status === 'failed');

    if (allSkipped) job.status = 'skipped';
    else if (anyLanded && !anyFailed) job.status = 'completed';
    else if (anyLanded && anyFailed) job.status = 'partial';
    else job.status = 'failed';

    this.pruneInactiveJobs(job.jobId);
    this.persist();
  }

  private ensureBackgroundPoller(jobId: string, legId: string, chain: EvmChainId): void {
    const key = `${jobId}:${legId}`;
    if (this.pollTimers.has(key)) return;

    const initialEntry = this.jobs.get(jobId);
    const initialJob = initialEntry && this.nowMs() < initialEntry.expiresAt ? initialEntry.job : undefined;
    const initialLeg = initialJob?.legs.find((l) => l.legId === legId);
    if (!initialJob || !initialLeg) return;

    let attempts = 0;
    const maxAttempts = computePollerMaxAttempts(chain, initialLeg, this.pollIntervalMs);

    const timer = setInterval(async () => {
      // Prevent overlapping async ticks on slow RPCs / Relay fetches
      if (this.pollInFlight.has(key)) return;
      this.pollInFlight.add(key);

      try {
        attempts += 1;
        const entry = this.jobs.get(jobId);
        const job = entry && this.nowMs() < entry.expiresAt ? entry.job : undefined;
        const leg = job?.legs.find((l) => l.legId === legId);
        if (!job || !leg) {
          this.clearPoller(key);
          return;
        }
        if (POLLER_EXIT_STATUSES.has(leg.status)) {
          this.clearPoller(key);
          return;
        }
        if (attempts > maxAttempts) {
          leg.statusText = 'Background polling window elapsed — check explorer or refresh status';
          leg.updatedAt = new Date().toISOString();
          this.clearPoller(key);
          return;
        }

        const st = await this.statusChecker({
          chain,
          txHash: leg.evmTxHash,
          requestId: leg.requestId,
          provider: leg.provider,
        });

        // Re-check terminal status & timer ownership after await to prevent out-of-order state regression
        if (this.pollTimers.get(key) !== timer || POLLER_EXIT_STATUSES.has(leg.status)) {
          return;
        }

        if (st.evmFailed) {
          leg.status = 'failed';
          leg.statusText = 'EVM transaction reverted onchain';
          leg.updatedAt = new Date().toISOString();
          this.recomputeJobSummary(job);
          this.clearPoller(key);
          return;
        }

        if (st.solanaTxHash) leg.solanaTxHash = st.solanaTxHash;

        if (st.bridgeStatus === 'success') {
          leg.status = 'landed';
          leg.statusText = `Landed on Solana (${job.outputAsset})`;
          leg.updatedAt = new Date().toISOString();
          this.recomputeJobSummary(job);
          this.clearPoller(key);
          return;
        }

        if (st.evmConfirmed && leg.requiresSolanaClaim && leg.evmTxHash) {
          const att = await this.attestationFetcher({
            chain,
            txHash: leg.evmTxHash,
            solanaDestination: job.solanaDestination,
          });
          if (this.pollTimers.get(key) !== timer || POLLER_EXIT_STATUSES.has(leg.status)) {
            return;
          }
          leg.attestationStatus = att.attestationStatus;
          if (att.attestationStatus === 'complete') {
            leg.status = 'attested';
            leg.statusText = 'Circle CCTP attested · ready to claim on Solana';
            leg.updatedAt = new Date().toISOString();
            this.recomputeJobSummary(job);
            this.clearPoller(key);
            return;
          }
          leg.status = 'relaying';
          leg.statusText = 'EVM confirmed · waiting for Circle Iris attestation';
          leg.updatedAt = new Date().toISOString();
          this.recomputeJobSummary(job);
          return;
        }

        // Only mark direct onchain (non-bridge / non-Relay / non-LI.FI) txs as landed on EVM confirmation
        const isAsyncBridgeProvider =
          leg.provider === 'relay' || leg.provider === 'lifi' || leg.provider === 'circle_cctp';
        if (st.evmConfirmed && !leg.requestId && !leg.requiresSolanaClaim && !isAsyncBridgeProvider) {
          leg.status = 'landed';
          leg.statusText = 'Confirmed onchain';
          leg.updatedAt = new Date().toISOString();
          this.recomputeJobSummary(job);
          this.clearPoller(key);
          return;
        }

        if (st.evmConfirmed) {
          leg.status = 'relaying';
          leg.statusText = `Relaying to Solana (${st.bridgeStatus})…`;
          leg.updatedAt = new Date().toISOString();
          this.recomputeJobSummary(job);
        }
      } catch {
        // Retry silently on transient RPC hiccups
      } finally {
        this.pollInFlight.delete(key);
      }
    }, this.pollIntervalMs);

    // Don't block Node process exit
    timer.unref?.();
    this.pollTimers.set(key, timer);
  }

  private clearPoller(key: string): void {
    const timer = this.pollTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.pollTimers.delete(key);
    }
    this.pollInFlight.delete(key);
  }

  private clearPollersForJob(jobId: string): void {
    for (const key of Array.from(this.pollTimers.keys())) {
      if (key.startsWith(`${jobId}:`)) this.clearPoller(key);
    }
  }

  dispose(): void {
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
    this.pollInFlight.clear();
  }
}
