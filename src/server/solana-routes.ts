import type { IncomingMessage } from 'node:http';
import { scanReclaimableSolanaRent } from '../bridge/solana-rent.js';
import {
  buildSolanaYieldParkPlan,
  listSolanaYieldStrategies,
  type SolanaYieldStrategyId,
} from '../solana/yield-park.js';

const MAX_SOLANA_JSON_BODY_BYTES = 32_768; // 32 KiB strict cap for Solana rent/yield endpoints

export interface SolanaRouteContext {
  method: string;
  pathname: string;
  url: URL;
  req: IncomingMessage;
  reply: (status: number, payload: unknown) => void;
  readJsonBody: <T>(req: IncomingMessage, maxBytes?: number) => Promise<T>;
}

/**
 * Modular HTTP routes for Solana post-arrival capital efficiency:
 *  - GET  /api/solana/yield-strategies
 *  - POST /api/solana/rent-scan
 *  - POST /api/solana/yield-park
 */
export async function handleSolanaRoutes(ctx: SolanaRouteContext): Promise<boolean> {
  const { method, pathname, req, reply, readJsonBody } = ctx;

  if (method === 'GET' && pathname === '/api/solana/yield-strategies') {
    reply(200, {
      strategies: listSolanaYieldStrategies(),
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/solana/rent-scan') {
    const body = await readJsonBody<{
      ownerAddress?: string;
      solanaAddress?: string;
      includeUnsignedTx?: boolean;
      recentBlockhash?: string;
      computeUnitPriceMicroLamports?: number;
      solPriceUsd?: number;
      skipPriceFetch?: boolean;
      maxAccountsPerTx?: number;
    }>(req, MAX_SOLANA_JSON_BODY_BYTES);

    const rawOwner = body.ownerAddress !== undefined ? body.ownerAddress : body.solanaAddress;
    const ownerAddress = typeof rawOwner === 'string' ? rawOwner.trim() : '';
    if (!ownerAddress) {
      reply(400, { error: 'ownerAddress must be a non-empty string.' });
      return true;
    }

    try {
      const scan = await scanReclaimableSolanaRent(ownerAddress, {
        includeUnsignedTx: Boolean(body.includeUnsignedTx),
        recentBlockhash: body.recentBlockhash,
        computeUnitPriceMicroLamports: body.computeUnitPriceMicroLamports,
        solPriceUsd: body.solPriceUsd,
        skipPriceFetch: body.skipPriceFetch,
        maxAccountsPerTx: body.maxAccountsPerTx,
      });
      reply(200, scan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to scan reclaimable Solana rent.';
      const isValidationError =
        /invalid|required|must be|refusing|cannot|duplicate|unsupported|non-empty|frozen|exceeds/i.test(
          msg
        );
      reply(isValidationError ? 400 : 503, {
        ...(isValidationError ? {} : { rpcUnavailable: true }),
        error: msg,
      });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/solana/yield-park') {
    const body = await readJsonBody<{
      ownerAddress?: string;
      solanaAddress?: string;
      totalUsdcAmount?: number;
      amountUsdc?: number;
      preservePct?: number;
      strategy?: SolanaYieldStrategyId;
      slippageBps?: number;
      buildTransaction?: boolean;
      priorityFeeMicroLamports?: number;
      fetchLiveApy?: boolean;
    }>(req, MAX_SOLANA_JSON_BODY_BYTES);

    const rawOwner = body.ownerAddress !== undefined ? body.ownerAddress : body.solanaAddress;
    const ownerAddress = typeof rawOwner === 'string' ? rawOwner.trim() : '';
    const totalUsdcAmount = body.totalUsdcAmount ?? body.amountUsdc;

    if (!ownerAddress) {
      reply(400, { error: 'ownerAddress must be a non-empty string.' });
      return true;
    }
    if (totalUsdcAmount === undefined) {
      reply(400, { error: 'totalUsdcAmount is required.' });
      return true;
    }

    try {
      const plan = await buildSolanaYieldParkPlan({
        ownerAddress,
        totalUsdcAmount,
        preservePct: body.preservePct,
        strategy: body.strategy,
        slippageBps: body.slippageBps,
        buildTransaction: Boolean(body.buildTransaction),
        priorityFeeMicroLamports: body.priorityFeeMicroLamports,
        fetchLiveApy: body.fetchLiveApy,
      });
      reply(200, plan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to build Solana yield parking plan.';
      const isUpstreamError = /jupiter swap (quote|transaction build) failed/i.test(msg);
      reply(isUpstreamError ? 502 : 400, { error: msg });
    }
    return true;
  }

  return false;
}
