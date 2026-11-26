import type { IncomingMessage } from 'node:http';
import { scanReclaimableSolanaRent } from '../bridge/solana-rent.js';
import {
  buildSolanaSplDustSweepPlan,
  DUST_SWEEP_TARGETS,
  MAX_ALLOWED_DUST_SWEEP_TOKENS,
  scanSolanaSplDust,
  type DustSweepTokenInput,
  type SolanaDustTargetAsset,
} from '../solana/spl-dust.js';
import {
  buildSolanaYieldParkPlan,
  listSolanaYieldStrategies,
  type SolanaYieldStrategyId,
} from '../solana/yield-park.js';

const MAX_SOLANA_JSON_BODY_BYTES = 32_768; // 32 KiB strict cap for Solana rent/yield/dust endpoints

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

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
 *  - POST /api/solana/dust-scan
 *  - POST /api/solana/dust-sweep
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

  if (method === 'POST' && pathname === '/api/solana/dust-scan') {
    const rawBody = await readJsonBody<unknown>(req, MAX_SOLANA_JSON_BODY_BYTES);
    if (!isPlainRecord(rawBody)) {
      reply(400, { error: 'Request body must be a JSON object.' });
      return true;
    }

    const rawOwner =
      rawBody.ownerAddress !== undefined ? rawBody.ownerAddress : rawBody.solanaAddress;
    const ownerAddress = typeof rawOwner === 'string' ? rawOwner.trim() : '';
    if (!ownerAddress) {
      reply(400, { error: 'ownerAddress must be a non-empty string.' });
      return true;
    }

    if (
      rawBody.maxDustUsd !== undefined &&
      (typeof rawBody.maxDustUsd !== 'number' || !Number.isFinite(rawBody.maxDustUsd))
    ) {
      reply(400, { error: 'maxDustUsd must be a finite number.' });
      return true;
    }
    if (
      rawBody.minDustUsd !== undefined &&
      (typeof rawBody.minDustUsd !== 'number' || !Number.isFinite(rawBody.minDustUsd))
    ) {
      reply(400, { error: 'minDustUsd must be a finite number.' });
      return true;
    }
    if (rawBody.includeUnpriced !== undefined && typeof rawBody.includeUnpriced !== 'boolean') {
      reply(400, { error: 'includeUnpriced must be a boolean.' });
      return true;
    }
    if (
      rawBody.solPriceUsd !== undefined &&
      (typeof rawBody.solPriceUsd !== 'number' || !Number.isFinite(rawBody.solPriceUsd))
    ) {
      reply(400, { error: 'solPriceUsd must be a finite positive number.' });
      return true;
    }
    if (rawBody.skipPriceFetch !== undefined && typeof rawBody.skipPriceFetch !== 'boolean') {
      reply(400, { error: 'skipPriceFetch must be a boolean.' });
      return true;
    }

    try {
      const scan = await scanSolanaSplDust(ownerAddress, {
        maxDustUsd: rawBody.maxDustUsd as number | undefined,
        minDustUsd: rawBody.minDustUsd as number | undefined,
        includeUnpriced: rawBody.includeUnpriced as boolean | undefined,
        solPriceUsd: rawBody.solPriceUsd as number | undefined,
        skipPriceFetch: rawBody.skipPriceFetch as boolean | undefined,
      });
      reply(200, scan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to scan Solana SPL dust.';
      const isValidationError =
        /invalid|required|must be|refusing|cannot|duplicate|unsupported|non-empty|frozen|exceeds|protected/i.test(
          msg
        );
      reply(isValidationError ? 400 : 503, {
        ...(isValidationError ? {} : { rpcUnavailable: true }),
        error: msg,
      });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/solana/dust-sweep') {
    const rawBody = await readJsonBody<unknown>(req, MAX_SOLANA_JSON_BODY_BYTES);
    if (!isPlainRecord(rawBody)) {
      reply(400, { error: 'Request body must be a JSON object.' });
      return true;
    }

    const rawOwner =
      rawBody.ownerAddress !== undefined ? rawBody.ownerAddress : rawBody.solanaAddress;
    const ownerAddress = typeof rawOwner === 'string' ? rawOwner.trim() : '';
    if (!ownerAddress) {
      reply(400, { error: 'ownerAddress must be a non-empty string.' });
      return true;
    }

    let targetAsset: SolanaDustTargetAsset = 'usdc';
    if (rawBody.targetAsset !== undefined) {
      if (
        typeof rawBody.targetAsset !== 'string' ||
        !Object.hasOwn(DUST_SWEEP_TARGETS, rawBody.targetAsset)
      ) {
        reply(400, {
          error: `Unsupported targetAsset "${String(rawBody.targetAsset)}". Allowed: usdc, sol.`,
        });
        return true;
      }
      targetAsset = rawBody.targetAsset as SolanaDustTargetAsset;
    }

    if (
      rawBody.maxDustUsd !== undefined &&
      (typeof rawBody.maxDustUsd !== 'number' || !Number.isFinite(rawBody.maxDustUsd))
    ) {
      reply(400, { error: 'maxDustUsd must be a finite number.' });
      return true;
    }
    if (
      rawBody.minDustUsd !== undefined &&
      (typeof rawBody.minDustUsd !== 'number' || !Number.isFinite(rawBody.minDustUsd))
    ) {
      reply(400, { error: 'minDustUsd must be a finite number.' });
      return true;
    }
    if (
      rawBody.slippageBps !== undefined &&
      (typeof rawBody.slippageBps !== 'number' || !Number.isInteger(rawBody.slippageBps))
    ) {
      reply(400, { error: 'slippageBps must be an integer.' });
      return true;
    }
    if (rawBody.closeAccounts !== undefined && typeof rawBody.closeAccounts !== 'boolean') {
      reply(400, { error: 'closeAccounts must be a boolean.' });
      return true;
    }
    if (rawBody.buildTransactions !== undefined && typeof rawBody.buildTransactions !== 'boolean') {
      reply(400, { error: 'buildTransactions must be a boolean.' });
      return true;
    }
    if (
      rawBody.priorityFeeMicroLamports !== undefined &&
      (typeof rawBody.priorityFeeMicroLamports !== 'number' ||
        !Number.isInteger(rawBody.priorityFeeMicroLamports))
    ) {
      reply(400, { error: 'priorityFeeMicroLamports must be an integer.' });
      return true;
    }
    if (
      rawBody.maxTokens !== undefined &&
      (typeof rawBody.maxTokens !== 'number' || !Number.isInteger(rawBody.maxTokens))
    ) {
      reply(400, { error: 'maxTokens must be an integer.' });
      return true;
    }
    if (
      rawBody.solPriceUsd !== undefined &&
      (typeof rawBody.solPriceUsd !== 'number' || !Number.isFinite(rawBody.solPriceUsd))
    ) {
      reply(400, { error: 'solPriceUsd must be a finite positive number.' });
      return true;
    }
    if (rawBody.skipPriceFetch !== undefined && typeof rawBody.skipPriceFetch !== 'boolean') {
      reply(400, { error: 'skipPriceFetch must be a boolean.' });
      return true;
    }
    if (rawBody.includeUnpriced !== undefined && typeof rawBody.includeUnpriced !== 'boolean') {
      reply(400, { error: 'includeUnpriced must be a boolean.' });
      return true;
    }

    let tokens: DustSweepTokenInput[] | undefined;
    if (rawBody.tokens !== undefined) {
      if (
        !Array.isArray(rawBody.tokens) ||
        rawBody.tokens.length === 0 ||
        rawBody.tokens.length > MAX_ALLOWED_DUST_SWEEP_TOKENS
      ) {
        reply(400, {
          error: `tokens must be a non-empty array of at most ${MAX_ALLOWED_DUST_SWEEP_TOKENS} entries.`,
        });
        return true;
      }
      for (const entry of rawBody.tokens) {
        if (!isPlainRecord(entry)) {
          reply(400, { error: 'Each entry in tokens must be a JSON object.' });
          return true;
        }
      }
      tokens = rawBody.tokens as DustSweepTokenInput[];
    }

    try {
      const plan = await buildSolanaSplDustSweepPlan({
        ownerAddress,
        targetAsset,
        tokens,
        maxDustUsd: rawBody.maxDustUsd as number | undefined,
        minDustUsd: rawBody.minDustUsd as number | undefined,
        includeUnpriced: rawBody.includeUnpriced as boolean | undefined,
        slippageBps: rawBody.slippageBps as number | undefined,
        closeAccounts: rawBody.closeAccounts as boolean | undefined,
        buildTransactions: rawBody.buildTransactions as boolean | undefined,
        priorityFeeMicroLamports: rawBody.priorityFeeMicroLamports as number | undefined,
        maxTokens: rawBody.maxTokens as number | undefined,
        solPriceUsd: rawBody.solPriceUsd as number | undefined,
        skipPriceFetch: rawBody.skipPriceFetch as boolean | undefined,
      });
      reply(200, plan);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to build Solana SPL dust sweep plan.';
      const isJupiterError = /jupiter swap (quote|transaction build) failed/i.test(msg);
      const isRpcError = /solana rpc|all solana rpc endpoints failed/i.test(msg);
      if (isJupiterError) {
        reply(502, { error: msg });
      } else if (isRpcError) {
        reply(503, { rpcUnavailable: true, error: msg });
      } else {
        reply(400, { error: msg });
      }
    }
    return true;
  }

  return false;
}
