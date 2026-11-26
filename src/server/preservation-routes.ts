import type { IncomingMessage } from 'node:http';
import type { TurgaliumAgentEngine } from '../agent/mandate-engine.js';
import {
  evaluateDustAutoHarvestEligibility,
  type GasWatchTrigger,
  type PreservationAgentStore,
} from '../agent/preservation-agents.js';
import type {
  UnlockHarvesterStore,
  UnlockQueuesReaderFn,
} from '../agent/unlock-harvester.js';
import {
  type AttestedCctpLegInput,
  evaluatePreservationPlan,
  fetchLiveChainGasGwei,
} from '../execution/preservation-optimizer.js';
import type { AnyChainId, EvmChainId, ScanReport } from '../scanner/types.js';
import type { BoundedTtlCache } from './cache.js';

export interface PreservationRouteContext {
  req: IncomingMessage;
  method: string;
  pathname: string;
  readJsonBody: <T>(req: IncomingMessage, maxBytes?: number) => Promise<T>;
  reply: (status: number, payload: unknown) => void;
  scanCache: BoundedTtlCache<string, ScanReport>;
  agentEngine: TurgaliumAgentEngine;
  preservationAgents: PreservationAgentStore;
  unlockHarvester?: UnlockHarvesterStore;
  unlockQueuesReader?: UnlockQueuesReaderFn;
  maxPrivilegedBodyBytes: number;
  nowMs?: () => number;
  liveGasFetcher?: (chain: EvmChainId) => Promise<number | null>;
}

const MAX_UNLOCK_WATCH_BODY_BYTES = 32_768; // 32 KiB strict cap for unlock-watch payloads

const GAS_CACHE_TTL_MS = 15_000;
const FALLBACK_ETHEREUM_GWEI = 18;

interface CachedGasReading {
  gwei: number;
  source: 'live_rpc' | 'fallback';
  fetchedAtMs: number;
}

const sharedEthGasCache = new WeakMap<PreservationAgentStore, CachedGasReading>();

async function getCurrentEthereumGwei(
  ctx: PreservationRouteContext
): Promise<{ gwei: number; source: 'live_rpc' | 'fallback' }> {
  const now = (ctx.nowMs ?? (() => Date.now()))();

  // When a deterministic fetcher is injected (tests / custom RPC), always invoke it directly
  if (ctx.liveGasFetcher) {
    const res = await fetchLiveChainGasGwei('ethereum', {
      gasPriceFetcher: ctx.liveGasFetcher,
    });
    if (res) {
      return { gwei: res.gwei, source: 'live_rpc' };
    }
    return { gwei: FALLBACK_ETHEREUM_GWEI, source: 'fallback' };
  }

  const cached = sharedEthGasCache.get(ctx.preservationAgents);
  if (cached && now - cached.fetchedAtMs < GAS_CACHE_TTL_MS) {
    return { gwei: cached.gwei, source: cached.source };
  }

  const live = await fetchLiveChainGasGwei('ethereum', { timeoutMs: 1200 });
  const reading: CachedGasReading = live
    ? { gwei: live.gwei, source: 'live_rpc', fetchedAtMs: now }
    : { gwei: FALLBACK_ETHEREUM_GWEI, source: 'fallback', fetchedAtMs: now };
  sharedEthGasCache.set(ctx.preservationAgents, reading);
  return { gwei: reading.gwei, source: reading.source };
}

function findCachedScanByWallet(
  scanCache: BoundedTtlCache<string, ScanReport>,
  walletAddress: string
): ScanReport | undefined {
  const needle = walletAddress.trim();
  if (!needle) return undefined;
  const needleLower = needle.toLowerCase();
  const scans = Array.from(scanCache.values()).reverse();
  for (const scan of scans) {
    if (!scan.walletAddress) continue;
    const candidate = scan.walletAddress.trim();
    if (candidate === needle || candidate.toLowerCase() === needleLower) {
      return scan;
    }
  }
  return undefined;
}

function isValidScanReportShape(val: unknown): val is ScanReport {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  return (
    typeof obj.walletAddress === 'string' &&
    Array.isArray(obj.assets) &&
    Array.isArray(obj.chains)
  );
}

function buildMandateValidator(
  agentEngine: TurgaliumAgentEngine,
  nowMs: () => number
): (mandateId: string, trigger: GasWatchTrigger) => boolean {
  return (mandateId: string, trigger: GasWatchTrigger): boolean => {
    const mandate = agentEngine.getMandate(mandateId);
    if (!mandate || !mandate.active) return false;
    if (Date.parse(mandate.expiresAt) <= nowMs()) return false;
    if (mandate.lockedSolanaRecipient !== trigger.solanaDestination) return false;
    return true;
  };
}

/**
 * Handles Turgalium Capital-Preservation & Watchdog Agent HTTP endpoints:
 *  - POST /api/optimize/preservation
 *  - GET  /api/agents/gas-watch
 *  - POST /api/agents/gas-watch
 *  - POST /api/agents/gas-watch/:id/cancel
 *
 * Returns `true` if the route was matched and handled, `false` otherwise.
 */
export async function handlePreservationRoute(ctx: PreservationRouteContext): Promise<boolean> {
  const { req, method, pathname, readJsonBody, reply, scanCache, agentEngine, preservationAgents } =
    ctx;
  const nowMs = ctx.nowMs ?? (() => Date.now());

  if (method === 'POST' && pathname === '/api/optimize/preservation') {
    const body = await readJsonBody<{
      scanReport?: ScanReport;
      scan?: ScanReport;
      scanId?: string;
      walletAddress?: string;
      selectedAssetIds?: string[];
      outputAsset?: 'USDC' | 'SOL';
      protocolFeeBps?: number;
      maxBaseFeeGwei?: number;
      liveGasGweiByChain?: Partial<Record<AnyChainId, number>>;
      hasSolanaUsdcAta?: boolean;
      attestedCctpLegs?: AttestedCctpLegInput[];
      minHarvestUsd?: number;
      minPreservationRatePct?: number;
    }>(req);

    if (
      body.walletAddress !== undefined &&
      body.walletAddress !== null &&
      typeof body.walletAddress !== 'string'
    ) {
      reply(400, { error: 'walletAddress must be a string.' });
      return true;
    }

    const rawScan =
      body.scanReport ??
      body.scan ??
      (typeof body.scanId === 'string' ? scanCache.get(body.scanId) : undefined) ??
      (typeof body.walletAddress === 'string'
        ? findCachedScanByWallet(scanCache, body.walletAddress)
        : undefined);

    if (!isValidScanReportShape(rawScan)) {
      reply(400, {
        error: 'Valid scanReport, scanId, or cached walletAddress is required.',
      });
      return true;
    }

    if (
      body.outputAsset !== undefined &&
      body.outputAsset !== 'USDC' &&
      body.outputAsset !== 'SOL'
    ) {
      reply(400, { error: "outputAsset must be 'USDC' or 'SOL'." });
      return true;
    }

    if (body.maxBaseFeeGwei !== undefined) {
      const g = Number(body.maxBaseFeeGwei);
      if (!Number.isFinite(g) || g <= 0 || g > 500) {
        reply(400, { error: 'maxBaseFeeGwei must be a finite number between 0 and 500.' });
        return true;
      }
    }

    const sanitizedOverrides: Partial<Record<AnyChainId, number>> = {};
    if (
      body.liveGasGweiByChain &&
      typeof body.liveGasGweiByChain === 'object' &&
      !Array.isArray(body.liveGasGweiByChain)
    ) {
      for (const [k, v] of Object.entries(body.liveGasGweiByChain)) {
        const num = Number(v);
        if (Number.isFinite(num) && num >= 0 && num <= 10_000) {
          sanitizedOverrides[k as AnyChainId] = num;
        }
      }
    }

    // Use live L1 gwei reading unless explicitly overridden in the request
    if (sanitizedOverrides.ethereum === undefined) {
      const ethReading = await getCurrentEthereumGwei(ctx);
      if (ethReading.source === 'live_rpc') {
        sanitizedOverrides.ethereum = ethReading.gwei;
      }
    }

    let effectiveProtocolFeeBps: number | undefined;
    const rawProtocolFeeBps: unknown = body.protocolFeeBps;
    if (rawProtocolFeeBps !== undefined) {
      if (
        typeof rawProtocolFeeBps === 'boolean' ||
        rawProtocolFeeBps === null ||
        (typeof rawProtocolFeeBps === 'string' && rawProtocolFeeBps.trim() === '')
      ) {
        reply(400, { error: 'protocolFeeBps must be a finite integer between 0 and 1000.' });
        return true;
      }
      const parsedFee = Number(rawProtocolFeeBps);
      if (!Number.isFinite(parsedFee) || !Number.isInteger(parsedFee) || parsedFee < 0 || parsedFee > 1000) {
        reply(400, { error: 'protocolFeeBps must be a finite integer between 0 and 1000.' });
        return true;
      }
      effectiveProtocolFeeBps = parsedFee;
    }

    const plan = await evaluatePreservationPlan(rawScan, {
      selectedAssetIds: Array.isArray(body.selectedAssetIds)
        ? body.selectedAssetIds.map(String)
        : undefined,
      outputAsset: body.outputAsset ?? 'USDC',
      protocolFeeBps: effectiveProtocolFeeBps,
      maxBaseFeeGwei: body.maxBaseFeeGwei,
      liveGasGweiByChain: sanitizedOverrides,
      hasSolanaUsdcAta: body.hasSolanaUsdcAta,
      attestedCctpLegs: Array.isArray(body.attestedCctpLegs) ? body.attestedCctpLegs : undefined,
      nowMs: nowMs(),
    });

    const dustHarvest = evaluateDustAutoHarvestEligibility(rawScan, {
      minHarvestUsd: body.minHarvestUsd,
      minPreservationRatePct: body.minPreservationRatePct,
      protocolFeeBps: effectiveProtocolFeeBps,
      hasSolanaUsdcAta: body.hasSolanaUsdcAta,
      hasValidMandate: false,
    });

    reply(200, {
      ...plan,
      dustHarvest,
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/agents/gas-watch') {
    const ethReading = await getCurrentEthereumGwei(ctx);
    const liveGasGwei: Partial<Record<EvmChainId, number>> = {
      ethereum: ethReading.gwei,
    };
    const evalResult = preservationAgents.evaluateGasWatchTriggers(liveGasGwei, {
      mandateValidator: buildMandateValidator(agentEngine, nowMs),
    });

    reply(200, {
      ethereumGwei: ethReading.gwei,
      gasSource: ethReading.source,
      liveGasGwei,
      evaluatedAt: evalResult.evaluatedAt,
      readyCount: evalResult.readyTriggers.length,
      maxTriggers: preservationAgents.capacity,
      triggers: evalResult.triggers,
      poller: preservationAgents.getPollerStatus(),
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/agents/gas-watch') {
    const body = await readJsonBody<{
      sourceWallet?: string;
      solanaDestination?: string;
      chain?: EvmChainId;
      maxBaseFeeGwei?: number;
      estimatedSavingsUsd?: number;
      mandateId?: string;
      ttlHours?: number;
    }>(req, ctx.maxPrivilegedBodyBytes);

    if (body.mandateId !== undefined && body.mandateId !== '') {
      const m = agentEngine.getMandate(String(body.mandateId).trim());
      if (!m || !m.active || Date.parse(m.expiresAt) <= nowMs()) {
        reply(400, { error: 'Supplied mandateId is missing, inactive, or expired.' });
        return true;
      }
      if (
        typeof body.solanaDestination === 'string' &&
        m.lockedSolanaRecipient !== body.solanaDestination.trim()
      ) {
        reply(400, {
          error: 'solanaDestination must match the immutable lockedSolanaRecipient of the mandate.',
        });
        return true;
      }
    }

    try {
      const created = preservationAgents.createTrigger({
        sourceWallet: body.sourceWallet as string,
        solanaDestination: body.solanaDestination as string,
        chain: body.chain ?? 'ethereum',
        maxBaseFeeGwei: body.maxBaseFeeGwei as number,
        estimatedSavingsUsd: body.estimatedSavingsUsd,
        mandateId: body.mandateId,
        ttlHours: body.ttlHours,
      });

      const ethReading = await getCurrentEthereumGwei(ctx);
      if (created.chain === 'ethereum') {
        preservationAgents.evaluateGasWatchTriggers(
          { ethereum: ethReading.gwei },
          { mandateValidator: buildMandateValidator(agentEngine, nowMs) }
        );
      }

      const refreshed = preservationAgents.getTrigger(created.id) ?? created;
      reply(200, {
        ...refreshed,
        ethereumGwei: ethReading.gwei,
      });
    } catch (err) {
      reply(400, {
        error: err instanceof Error ? err.message : 'Invalid gas-window trigger parameters.',
      });
    }
    return true;
  }

  if (
    method === 'POST' &&
    pathname.startsWith('/api/agents/gas-watch/') &&
    pathname.endsWith('/cancel')
  ) {
    const triggerId = pathname.slice('/api/agents/gas-watch/'.length, -'/cancel'.length).trim();
    if (!triggerId || triggerId.includes('/')) {
      reply(400, { error: 'Invalid gas-watch trigger id.' });
      return true;
    }
    const cancelled = preservationAgents.cancelTrigger(triggerId);
    if (!cancelled) {
      reply(404, { error: 'Gas-window trigger not found.' });
      return true;
    }
    reply(200, cancelled);
    return true;
  }

  // ================= DEFI UNLOCK & UNBONDING HARVESTER =================
  const unlockHarvester = ctx.unlockHarvester;
  const unlockBodyLimit = Math.min(ctx.maxPrivilegedBodyBytes, MAX_UNLOCK_WATCH_BODY_BYTES);

  if (unlockHarvester && method === 'GET' && pathname === '/api/agents/unlock-watch') {
    const watches = unlockHarvester.listWatches();
    const alerts = unlockHarvester.listAlerts();
    const poller = unlockHarvester.getPollerStatus();
    reply(200, {
      watches,
      alerts,
      summary: {
        totalWatches: watches.length,
        activeWatches: poller.activeWatches,
        readyWatches: poller.readyWatches,
        pausedWatches: poller.pausedWatches,
        cancelledWatches: poller.cancelledWatches,
        totalReadyUnlocks: poller.totalReadyUnlocks,
        totalPendingUnlocks: poller.totalPendingUnlocks,
        alertsCount: alerts.length,
      },
      maxWatches: unlockHarvester.capacity,
      poller,
    });
    return true;
  }

  if (unlockHarvester && method === 'POST' && pathname === '/api/agents/unlock-watch') {
    const body = await readJsonBody<{
      walletAddress?: unknown;
      evmAddresses?: unknown;
      cosmosAddresses?: unknown;
      solanaDestination?: unknown;
      label?: unknown;
    }>(req, unlockBodyLimit);

    try {
      const created = unlockHarvester.createWatch({
        walletAddress: body.walletAddress as string | undefined,
        evmAddresses: body.evmAddresses as string[] | undefined,
        cosmosAddresses: body.cosmosAddresses as string[] | undefined,
        solanaDestination: body.solanaDestination as string | undefined,
        label: body.label as string | undefined,
      });
      reply(200, created);
    } catch (err) {
      reply(400, {
        error: err instanceof Error ? err.message : 'Invalid unlock-watch parameters.',
      });
    }
    return true;
  }

  if (unlockHarvester && method === 'POST' && pathname === '/api/agents/unlock-watch/check') {
    let timeoutMs: number | undefined;
    const hasBodyHeaders =
      Boolean(req.headers['content-type']) ||
      (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) > 0);
    if (hasBodyHeaders) {
      const body = await readJsonBody<{ timeoutMs?: unknown }>(req, unlockBodyLimit);
      if (body.timeoutMs !== undefined) {
        if (typeof body.timeoutMs !== 'number' || !Number.isFinite(body.timeoutMs) || body.timeoutMs < 10 || body.timeoutMs > 30_000) {
          reply(400, { error: 'timeoutMs must be a finite number between 10 and 30000.' });
          return true;
        }
        timeoutMs = Math.floor(body.timeoutMs);
      }
    }

    const result = await unlockHarvester.checkAllWatches({
      readUnlockQueues: ctx.unlockQueuesReader,
      timeoutMs,
    });
    reply(200, {
      ...result,
      poller: unlockHarvester.getPollerStatus(),
    });
    return true;
  }

  if (
    unlockHarvester &&
    method === 'DELETE' &&
    pathname.startsWith('/api/agents/unlock-watch/')
  ) {
    const watchId = pathname.slice('/api/agents/unlock-watch/'.length).trim();
    if (!watchId || watchId.includes('/')) {
      reply(400, { error: 'Invalid unlock-watch id.' });
      return true;
    }
    const removed = unlockHarvester.deleteWatch(watchId);
    if (!removed) {
      reply(404, { error: 'Unlock watch not found.' });
      return true;
    }
    reply(200, {
      ...removed,
      deleted: true,
    });
    return true;
  }

  return false;
}
