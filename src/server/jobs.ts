import crypto from 'node:crypto';
import { fetchCctpAttestationForTx } from '../bridge/cctp.js';
import { checkLiveExecutionStatus } from '../execution/tx-builder.js';
import { EVM_CHAINS } from '../scanner/chains.js';
import type { EvmChainId } from '../scanner/types.js';

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

export interface BackgroundJobLeg {
  chain: EvmChainId;
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
  status: 'active' | 'completed' | 'partial' | 'failed';
  totalNetUsd: number;
  settledNetUsd: number;
  legs: BackgroundJobLeg[];
}

export class BackgroundJobStore {
  private jobs = new Map<string, BackgroundJob>();
  private pollTimers = new Map<string, NodeJS.Timeout>();

  createJob(input: {
    sourceWallet: string;
    solanaDestination: string;
    outputAsset: 'USDC' | 'SOL';
    bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp';
    protocolFeeBps: number;
    feeRecipientEvm: string | null;
    legs: Array<{
      chain: EvmChainId;
      chainName?: string;
      assetCount: number;
      estimatedNetUsd: number;
      estimatedFeeUsd?: number;
    }>;
  }): BackgroundJob {
    const now = new Date().toISOString();
    const jobId = `job_${crypto.randomBytes(5).toString('hex')}`;
    const legs: BackgroundJobLeg[] = input.legs.map((l) => {
      const cfg = EVM_CHAINS[l.chain];
      return {
        chain: l.chain,
        chainName: l.chainName || cfg?.name || l.chain,
        explorerUrl: cfg?.explorerUrl || 'https://etherscan.io',
        assetCount: l.assetCount,
        estimatedNetUsd: Number(l.estimatedNetUsd.toFixed(2)),
        estimatedFeeUsd: Number((l.estimatedFeeUsd ?? 0).toFixed(2)),
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
      legs,
    };

    this.jobs.set(jobId, job);
    if (this.jobs.size > 30) {
      const oldest = this.jobs.keys().next().value;
      if (oldest) {
        this.clearPollersForJob(oldest);
        this.jobs.delete(oldest);
      }
    }
    return job;
  }

  listJobs(): BackgroundJob[] {
    return Array.from(this.jobs.values()).reverse();
  }

  getJob(jobId: string): BackgroundJob | null {
    return this.jobs.get(jobId) ?? null;
  }

  updateLeg(
    jobId: string,
    chain: EvmChainId,
    patch: Partial<Omit<BackgroundJobLeg, 'chain' | 'chainName' | 'explorerUrl'>>
  ): BackgroundJob | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const leg = job.legs.find((l) => l.chain === chain);
    if (!leg) return null;

    Object.assign(leg, patch, { updatedAt: new Date().toISOString() });
    this.recomputeJobSummary(job);

    // Start autonomous server-side background settlement watcher once an EVM tx or Relay intent exists
    if (
      (leg.status === 'confirming' || leg.status === 'relaying') &&
      (leg.evmTxHash || leg.requestId)
    ) {
      this.ensureBackgroundPoller(jobId, chain);
    } else if (leg.status === 'landed' || leg.status === 'failed' || leg.status === 'skipped') {
      this.clearPoller(`${jobId}:${chain}`);
    }

    return job;
  }

  private recomputeJobSummary(job: BackgroundJob): void {
    const settled = job.legs
      .filter((l) => l.status === 'landed' || l.status === 'attested')
      .reduce((s, l) => s + l.estimatedNetUsd, 0);
    job.settledNetUsd = Number(settled.toFixed(2));
    job.updatedAt = new Date().toISOString();

    const terminal = new Set<JobLegStatus>(['landed', 'attested', 'failed', 'skipped']);
    const allDone = job.legs.every((l) => terminal.has(l.status));
    if (!allDone) {
      job.status = 'active';
      return;
    }
    const anyLanded = job.legs.some((l) => l.status === 'landed' || l.status === 'attested');
    const anyFailed = job.legs.some((l) => l.status === 'failed');
    if (anyLanded && !anyFailed) job.status = 'completed';
    else if (anyLanded && anyFailed) job.status = 'partial';
    else job.status = 'failed';
  }

  private ensureBackgroundPoller(jobId: string, chain: EvmChainId): void {
    const key = `${jobId}:${chain}`;
    if (this.pollTimers.has(key)) return;

    let attempts = 0;
    const maxAttempts = 40; // ~2.5 minutes background tracking

    const timer = setInterval(async () => {
      attempts += 1;
      const job = this.jobs.get(jobId);
      const leg = job?.legs.find((l) => l.chain === chain);
      if (!job || !leg || attempts > maxAttempts) {
        this.clearPoller(key);
        return;
      }
      if (leg.status === 'landed' || leg.status === 'failed' || leg.status === 'skipped') {
        this.clearPoller(key);
        return;
      }

      try {
        const st = await checkLiveExecutionStatus({
          chain,
          txHash: leg.evmTxHash,
          requestId: leg.requestId,
          provider: leg.provider,
        });

        if (st.evmFailed) {
          leg.status = 'failed';
          leg.statusText = 'EVM transaction reverted onchain';
          this.recomputeJobSummary(job);
          this.clearPoller(key);
          return;
        }

        if (st.solanaTxHash) leg.solanaTxHash = st.solanaTxHash;

        if (st.bridgeStatus === 'success') {
          leg.status = 'landed';
          leg.statusText = `Landed on Solana (${job.outputAsset})`;
          this.recomputeJobSummary(job);
          this.clearPoller(key);
          return;
        }

        if (st.evmConfirmed && leg.requiresSolanaClaim && leg.evmTxHash) {
          const att = await fetchCctpAttestationForTx({
            chain,
            txHash: leg.evmTxHash,
            solanaDestination: job.solanaDestination,
          });
          leg.attestationStatus = att.attestationStatus;
          if (att.attestationStatus === 'complete') {
            leg.status = 'attested';
            leg.statusText = 'Circle CCTP attested · ready to claim on Solana';
            this.recomputeJobSummary(job);
            this.clearPoller(key);
            return;
          }
          leg.status = 'relaying';
          leg.statusText = 'EVM confirmed · waiting for Circle Iris attestation';
          this.recomputeJobSummary(job);
          return;
        }

        if (st.evmConfirmed && !leg.requestId) {
          leg.status = 'landed';
          leg.statusText = 'Confirmed onchain';
          this.recomputeJobSummary(job);
          this.clearPoller(key);
          return;
        }

        if (st.evmConfirmed) {
          leg.status = 'relaying';
          leg.statusText = `Relaying to Solana (${st.bridgeStatus})…`;
          this.recomputeJobSummary(job);
        }
      } catch {
        // Retry silently on transient RPC hiccups
      }
    }, 3500);

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
  }

  private clearPollersForJob(jobId: string): void {
    for (const key of Array.from(this.pollTimers.keys())) {
      if (key.startsWith(`${jobId}:`)) this.clearPoller(key);
    }
  }

  dispose(): void {
    for (const timer of this.pollTimers.values()) clearInterval(timer);
    this.pollTimers.clear();
  }
}
