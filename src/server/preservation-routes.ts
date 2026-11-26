import type { IncomingMessage } from 'node:http';
import type { SiphonAgentEngine } from '../agent/mandate-engine.js';
import {
  evaluateDustAutoHarvestEligibility,
  type GasWatchTrigger,
  type PreservationAgentStore,
} from '../agent/preservation-agents.js';
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
  agentEngine: SiphonAgentEngine;
  preservationAgents: PreservationAgentStore;
  maxPrivilegedBodyBytes: number;
  nowMs?: () => number;
  liveGasFetcher?: (chain: EvmChainId) => Promise<number | null>;
}

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
  agentEngine: SiphonAgentEngine,
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
 * Handles Siphon Capital-Preservation & Watchdog Agent HTTP endpoints:
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

  return false;
}
