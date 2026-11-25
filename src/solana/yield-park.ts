import { VersionedTransaction } from '@solana/web3.js';
import { solanaAddressToBytes32 } from '../bridge/cctp.js';

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOLANA_JUPSOL_MINT = 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v';
export const SOLANA_JUPITER_LEND_JLUSDC_MINT = '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D';

export const JUPITER_SWAP_LITE_BASE = 'https://lite-api.jup.ag/swap/v1';
export const JUPITER_SWAP_PRO_BASE = 'https://api.jup.ag/swap/v1';
export const JUPITER_LEND_EARN_TOKENS_URL = 'https://lite-api.jup.ag/lend/v1/earn/tokens';
export const KAMINO_MAIN_MARKET_RESERVES_URL =
  'https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves/metrics';

export const MIN_PRESERVE_PCT = 50;
export const DEFAULT_PRESERVE_PCT = 90;
export const MAX_PRESERVE_PCT = 100;
export const MAX_TOTAL_USDC_AMOUNT = 100_000_000;
export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 500;
export const DEFAULT_YIELD_PARK_TIMEOUT_MS = 4_500;

export type SolanaYieldStrategyId = 'jupsol' | 'jupiter_lend_usdc' | 'kamino_usdc';

export interface SolanaYieldStrategyMeta {
  id: SolanaYieldStrategyId;
  name: string;
  protocol: string;
  symbol: string;
  outputMint: string | null;
  outputDecimals: number;
  assetClass: 'liquid_staked_sol' | 'usdc_savings';
  executionMode: 'jupiter_swap_v0' | 'vault_deposit_preview';
  baselineApyPct: number;
  apyRangePct: [number, number];
  riskTier: 'low' | 'moderate';
  preservesUsdPeg: boolean;
  description: string;
  appUrl: string;
}

export const SOLANA_YIELD_STRATEGIES: Readonly<Record<SolanaYieldStrategyId, SolanaYieldStrategyMeta>> =
  Object.freeze({
    jupsol: {
      id: 'jupsol',
      name: 'Jupiter Staked SOL (JupSOL)',
      protocol: 'Jupiter / Sanctum LST',
      symbol: 'JupSOL',
      outputMint: SOLANA_JUPSOL_MINT,
      outputDecimals: 9,
      assetClass: 'liquid_staked_sol',
      executionMode: 'jupiter_swap_v0',
      baselineApyPct: 7.1,
      apyRangePct: [6.0, 8.2],
      riskTier: 'moderate',
      preservesUsdPeg: false,
      description:
        'Convert preserved USDC directly into JupSOL via Jupiter Swap V0 for native Solana staking + MEV yield (~6–8% APY).',
      appUrl: 'https://jup.ag/swap/USDC-JupSOL',
    },
    jupiter_lend_usdc: {
      id: 'jupiter_lend_usdc',
      name: 'Jupiter Lend USDC (jlUSDC)',
      protocol: 'Jupiter Lend',
      symbol: 'jlUSDC',
      outputMint: SOLANA_JUPITER_LEND_JLUSDC_MINT,
      outputDecimals: 6,
      assetClass: 'usdc_savings',
      executionMode: 'vault_deposit_preview',
      baselineApyPct: 7.4,
      apyRangePct: [5.5, 9.5],
      riskTier: 'low',
      preservesUsdPeg: true,
      description:
        'Park preserved USDC in Jupiter Lend Earn (jlUSDC) to earn USD-denominated lending yield while keeping principal USD-pegged.',
      appUrl: 'https://jup.ag/lend/earn',
    },
    kamino_usdc: {
      id: 'kamino_usdc',
      name: 'Kamino USDC Lending Vault',
      protocol: 'Kamino Finance',
      symbol: 'kUSDC',
      outputMint: null,
      outputDecimals: 6,
      assetClass: 'usdc_savings',
      executionMode: 'vault_deposit_preview',
      baselineApyPct: 6.8,
      apyRangePct: [5.0, 8.8],
      riskTier: 'low',
      preservesUsdPeg: true,
      description:
        'Supply preserved USDC into Kamino Main Market USDC reserve for automated USD lending yield with instant liquidity.',
      appUrl: 'https://app.kamino.finance/lending',
    },
  });

export interface YieldPreservationSplit {
  totalUsdcAmount: number;
  totalUsdcRaw: string;
  preservePct: number;
  degenPct: number;
  yieldUsdc: number;
  yieldUsdcRaw: string;
  degenSidePocketUsdc: number;
  degenSidePocketRaw: string;
}

export interface JupiterSwapQuoteSummary {
  apiBaseUrl: string;
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  otherAmountThresholdRaw: string;
  estimatedOutputUi: number;
  minOutputUi: number;
  slippageBps: number;
  priceImpactPct: number;
  routeLabels: string[];
  rawQuoteResponse: Record<string, unknown>;
}

export interface YieldParkTransactionPayload {
  version: 0;
  feePayer: string;
  lastValidBlockHeight: number | null;
  prioritizationFeeLamports: number | null;
  serializedByteLength: number;
  swapTransactionBase64: string;
}

export interface BuildSolanaYieldParkParams {
  ownerAddress: string;
  totalUsdcAmount: number;
  preservePct?: number;
  strategy?: SolanaYieldStrategyId;
  slippageBps?: number;
  buildTransaction?: boolean;
  priorityFeeMicroLamports?: number;
  fetchLiveApy?: boolean;
  jupiterApiKey?: string;
  timeoutMs?: number;
}

export interface SolanaYieldParkPlan {
  planVersion: 'siphon-solana-yield-park-v1';
  ownerAddress: string;
  strategy: SolanaYieldStrategyMeta;
  split: YieldPreservationSplit;
  apy: {
    estimatedApyPct: number;
    source: 'live' | 'baseline_estimate';
    apyRangePct: [number, number];
  };
  projections: {
    projectedAnnualYieldUsd: number;
    projectedMonthlyYieldUsd: number;
    projectedDailyYieldUsd: number;
    yieldFundedDegenMonthlyBudgetUsd: number;
  };
  jupiterQuote: JupiterSwapQuoteSummary | null;
  transaction: YieldParkTransactionPayload | null;
  warnings: string[];
}

export function listSolanaYieldStrategies(): SolanaYieldStrategyMeta[] {
  return Object.values(SOLANA_YIELD_STRATEGIES);
}

/**
 * Computes exact integer micro-USDC preservation split so `yieldUsdcRaw + degenSidePocketRaw === totalUsdcRaw`
 * with zero floating-point drift. Enforces Siphon's preservation-first guard: `50 <= preservePct <= 100`.
 */
export function calculateYieldPreservationSplit(
  totalUsdcAmount: number,
  preservePct = DEFAULT_PRESERVE_PCT
): YieldPreservationSplit {
  if (typeof totalUsdcAmount !== 'number' || !Number.isFinite(totalUsdcAmount) || totalUsdcAmount <= 0) {
    throw new Error('totalUsdcAmount must be a finite positive number.');
  }
  if (totalUsdcAmount > MAX_TOTAL_USDC_AMOUNT) {
    throw new Error(`totalUsdcAmount exceeds maximum allowed bound (${MAX_TOTAL_USDC_AMOUNT} USDC).`);
  }
  if (
    typeof preservePct !== 'number' ||
    !Number.isFinite(preservePct) ||
    preservePct < MIN_PRESERVE_PCT ||
    preservePct > MAX_PRESERVE_PCT
  ) {
    throw new Error(
      `preservePct must be a finite number between ${MIN_PRESERVE_PCT} and ${MAX_PRESERVE_PCT} (Preservation-First guard).`
    );
  }

  const totalRaw = BigInt(Math.round(totalUsdcAmount * 1_000_000));
  if (totalRaw <= 0n) {
    throw new Error('totalUsdcAmount is too small (must be at least 0.000001 USDC).');
  }

  // Basis-points precision for preservePct (e.g., 90 -> 9000 bps, 92.5 -> 9250 bps)
  const preserveBps = BigInt(Math.round(preservePct * 100));
  const yieldRaw = (totalRaw * preserveBps) / 10_000n;
  if (yieldRaw <= 0n) {
    throw new Error('Preserved yield allocation rounds to 0 micro-USDC; increase totalUsdcAmount.');
  }
  const degenRaw = totalRaw - yieldRaw;

  const normalizedPreservePct = Number(preservePct.toFixed(2));
  const degenPct = Number((100 - normalizedPreservePct).toFixed(2));

  return {
    totalUsdcAmount: Number((Number(totalRaw) / 1_000_000).toFixed(6)),
    totalUsdcRaw: totalRaw.toString(),
    preservePct: normalizedPreservePct,
    degenPct,
    yieldUsdc: Number((Number(yieldRaw) / 1_000_000).toFixed(6)),
    yieldUsdcRaw: yieldRaw.toString(),
    degenSidePocketUsdc: Number((Number(degenRaw) / 1_000_000).toFixed(6)),
    degenSidePocketRaw: degenRaw.toString(),
  };
}

function getJupiterSwapEndpoint(explicitApiKey?: string): {
  baseUrl: string;
  headers: Record<string, string>;
} {
  const apiKey = (explicitApiKey ?? process.env.JUPITER_API_KEY)?.trim();
  if (apiKey) {
    return {
      baseUrl: JUPITER_SWAP_PRO_BASE,
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
    };
  }
  return {
    baseUrl: JUPITER_SWAP_LITE_BASE,
    headers: {
      Accept: 'application/json',
    },
  };
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; data: T | null; errorText?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      let errorText = `HTTP ${res.status}`;
      try {
        const body = await res.text();
        if (body) errorText = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      } catch {
        // ignore
      }
      return { ok: false, status: res.status, data: null, errorText };
    }
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      data: null,
      errorText: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchLiveSavingsApy(
  strategyId: 'jupiter_lend_usdc' | 'kamino_usdc',
  timeoutMs: number
): Promise<number | null> {
  if (strategyId === 'jupiter_lend_usdc') {
    const res = await fetchJsonWithTimeout<Array<Record<string, unknown>>>(
      JUPITER_LEND_EARN_TOKENS_URL,
      { method: 'GET', headers: { Accept: 'application/json' } },
      Math.min(timeoutMs, 2_500)
    );
    if (!res.ok || !Array.isArray(res.data)) return null;
    for (const item of res.data) {
      const symbol = String(item?.symbol ?? item?.asset?.toString() ?? '').toUpperCase();
      const assetObj = item?.asset as Record<string, unknown> | undefined;
      const underlyingAddress = String(assetObj?.address ?? item?.assetAddress ?? '');
      if (
        underlyingAddress === SOLANA_USDC_MINT ||
        symbol === 'JLUSDC' ||
        symbol === 'USDC'
      ) {
        const rawRate = Number(item?.totalRate ?? item?.supplyRate ?? item?.apy ?? NaN);
        if (Number.isFinite(rawRate) && rawRate > 0) {
          // Jupiter Lend rates may be returned in bps (e.g. 740 -> 7.4%) or percentage (7.4) or decimal (0.074)
          const pct = rawRate > 100 ? rawRate / 100 : rawRate < 1 ? rawRate * 100 : rawRate;
          if (pct > 0 && pct <= 50) return Number(pct.toFixed(2));
        }
      }
    }
    return null;
  }

  const res = await fetchJsonWithTimeout<Array<Record<string, unknown>>>(
    KAMINO_MAIN_MARKET_RESERVES_URL,
    { method: 'GET', headers: { Accept: 'application/json' } },
    Math.min(timeoutMs, 2_500)
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  for (const reserve of res.data) {
    const tokenSym = String(reserve?.liquidityToken ?? reserve?.symbol ?? '').toUpperCase();
    const mint = String(reserve?.liquidityTokenMint ?? '');
    if (mint === SOLANA_USDC_MINT || tokenSym === 'USDC') {
      const rawApy = Number(reserve?.supplyApy ?? reserve?.apy ?? NaN);
      if (Number.isFinite(rawApy) && rawApy > 0) {
        const pct = rawApy < 1 ? rawApy * 100 : rawApy;
        if (pct > 0 && pct <= 50) return Number(pct.toFixed(2));
      }
    }
  }
  return null;
}

/**
 * Builds a 1-click Post-Arrival Solana Yield Parking plan with strict preservation-first
 * split math (default 90% Yield / 10% Degen Side-Pocket):
 *  - `jupsol`: fetches live Jupiter Swap API quote (`USDC -> JupSOL`) and optionally builds &
 *    verifies an unsigned `VersionedTransaction` (V0) via Jupiter `/swap`.
 *  - `jupiter_lend_usdc` / `kamino_usdc`: computes exact split + live/baseline APY & yield projections.
 */
export async function buildSolanaYieldParkPlan(
  params: BuildSolanaYieldParkParams
): Promise<SolanaYieldParkPlan> {
  const ownerClean = typeof params.ownerAddress === 'string' ? params.ownerAddress.trim() : '';
  if (!ownerClean) {
    throw new Error('ownerAddress is required.');
  }
  // Validates base58 and rejects all-zero System Program pubkey
  try {
    solanaAddressToBytes32(ownerClean);
  } catch (err) {
    throw new Error(
      `Invalid Solana ownerAddress: ${err instanceof Error ? err.message : 'expected valid base58 public key'}.`
    );
  }

  const strategyId: SolanaYieldStrategyId = params.strategy ?? 'jupsol';
  if (!(strategyId in SOLANA_YIELD_STRATEGIES)) {
    throw new Error(
      `Unsupported yield strategy "${String(params.strategy)}". Allowed: jupsol, jupiter_lend_usdc, kamino_usdc.`
    );
  }
  const strategy = SOLANA_YIELD_STRATEGIES[strategyId];

  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps must be an integer between 1 and ${MAX_SLIPPAGE_BPS}.`);
  }

  if (params.priorityFeeMicroLamports !== undefined) {
    if (
      !Number.isInteger(params.priorityFeeMicroLamports) ||
      params.priorityFeeMicroLamports < 0 ||
      params.priorityFeeMicroLamports > 10_000_000
    ) {
      throw new Error('priorityFeeMicroLamports must be an integer between 0 and 10,000,000.');
    }
  }

  const split = calculateYieldPreservationSplit(
    params.totalUsdcAmount,
    params.preservePct ?? DEFAULT_PRESERVE_PCT
  );

  const timeoutMs = params.timeoutMs ?? DEFAULT_YIELD_PARK_TIMEOUT_MS;
  const warnings: string[] = [];

  let estimatedApyPct = strategy.baselineApyPct;
  let apySource: 'live' | 'baseline_estimate' = 'baseline_estimate';
  let jupiterQuote: JupiterSwapQuoteSummary | null = null;
  let transaction: YieldParkTransactionPayload | null = null;

  if (strategyId === 'jupsol') {
    const { baseUrl, headers } = getJupiterSwapEndpoint(params.jupiterApiKey);
    const quoteUrl =
      `${baseUrl}/quote?inputMint=${SOLANA_USDC_MINT}` +
      `&outputMint=${SOLANA_JUPSOL_MINT}` +
      `&amount=${split.yieldUsdcRaw}` +
      `&slippageBps=${slippageBps}` +
      `&restrictIntermediateTokens=true`;

    const quoteRes = await fetchJsonWithTimeout<Record<string, unknown>>(
      quoteUrl,
      { method: 'GET', headers },
      timeoutMs
    );

    if (!quoteRes.ok || !quoteRes.data) {
      throw new Error(
        `Jupiter Swap quote failed for USDC -> JupSOL (${quoteRes.errorText ?? 'unknown error'}).`
      );
    }

    const q = quoteRes.data;
    const outAmountRaw = typeof q.outAmount === 'string' ? q.outAmount.trim() : '';
    const otherAmountThresholdRaw =
      typeof q.otherAmountThreshold === 'string' ? q.otherAmountThreshold.trim() : outAmountRaw;
    if (!/^\d+$/.test(outAmountRaw) || BigInt(outAmountRaw) <= 0n) {
      throw new Error('Jupiter Swap quote returned invalid or zero outAmount.');
    }

    const rawPriceImpact = Number(q.priceImpactPct ?? 0);
    const priceImpactPct = Number.isFinite(rawPriceImpact)
      ? Number((rawPriceImpact * 100).toFixed(4))
      : 0;
    const routePlan = Array.isArray(q.routePlan) ? q.routePlan : [];
    const routeLabels = routePlan
      .map((hop) => {
        const swapInfo = (hop as Record<string, unknown>)?.swapInfo as
          | Record<string, unknown>
          | undefined;
        return typeof swapInfo?.label === 'string' ? swapInfo.label : null;
      })
      .filter((label): label is string => Boolean(label));

    jupiterQuote = {
      apiBaseUrl: baseUrl,
      inputMint: SOLANA_USDC_MINT,
      outputMint: SOLANA_JUPSOL_MINT,
      inAmountRaw: split.yieldUsdcRaw,
      outAmountRaw,
      otherAmountThresholdRaw,
      estimatedOutputUi: Number((Number(outAmountRaw) / 1e9).toFixed(6)),
      minOutputUi: Number((Number(otherAmountThresholdRaw) / 1e9).toFixed(6)),
      slippageBps,
      priceImpactPct,
      routeLabels,
      rawQuoteResponse: q,
    };

    if (params.buildTransaction) {
      const swapBody: Record<string, unknown> = {
        quoteResponse: q,
        userPublicKey: ownerClean,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        asLegacyTransaction: false,
      };
      if (params.priorityFeeMicroLamports !== undefined) {
        swapBody.computeUnitPriceMicroLamports = params.priorityFeeMicroLamports;
      } else {
        swapBody.prioritizationFeeLamports = 'auto';
      }

      const swapRes = await fetchJsonWithTimeout<{
        swapTransaction?: string;
        lastValidBlockHeight?: number;
        prioritizationFeeLamports?: number;
      }>(
        `${baseUrl}/swap`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(swapBody),
        },
        timeoutMs
      );

      if (!swapRes.ok || !swapRes.data?.swapTransaction) {
        throw new Error(
          `Jupiter Swap transaction build failed (${swapRes.errorText ?? 'missing swapTransaction'}).`
        );
      }

      const txBase64 = swapRes.data.swapTransaction.trim();
      const txBytes = Buffer.from(txBase64, 'base64');
      let parsedTx: VersionedTransaction;
      try {
        parsedTx = VersionedTransaction.deserialize(txBytes);
      } catch {
        throw new Error('Jupiter Swap returned malformed VersionedTransaction bytes.');
      }
      if (parsedTx.version !== 0) {
        throw new Error(
          `Expected VersionedTransaction v0 from Jupiter Swap, got version "${String(parsedTx.version)}".`
        );
      }
      const feePayer = parsedTx.message.staticAccountKeys[0]?.toBase58();
      if (!feePayer || feePayer !== ownerClean) {
        throw new Error(
          `Jupiter Swap transaction feePayer mismatch: got ${feePayer ?? 'none'}, expected ${ownerClean}.`
        );
      }

      transaction = {
        version: 0,
        feePayer,
        lastValidBlockHeight:
          typeof swapRes.data.lastValidBlockHeight === 'number'
            ? swapRes.data.lastValidBlockHeight
            : null,
        prioritizationFeeLamports:
          typeof swapRes.data.prioritizationFeeLamports === 'number'
            ? swapRes.data.prioritizationFeeLamports
            : null,
        serializedByteLength: txBytes.length,
        swapTransactionBase64: txBase64,
      };
    }
  } else {
    if (params.fetchLiveApy !== false) {
      const liveApy = await fetchLiveSavingsApy(strategyId, timeoutMs);
      if (liveApy !== null) {
        estimatedApyPct = liveApy;
        apySource = 'live';
      }
    }
    if (params.buildTransaction) {
      warnings.push(
        `${strategy.name} currently returns a live APY & split quote preview; deposit directly via ${strategy.appUrl} or select 'jupsol' for an instant Jupiter Swap V0 transaction.`
      );
    }
  }

  const projectedAnnualYieldUsd = Number(((split.yieldUsdc * estimatedApyPct) / 100).toFixed(2));
  const projectedMonthlyYieldUsd = Number((projectedAnnualYieldUsd / 12).toFixed(2));
  const projectedDailyYieldUsd = Number((projectedAnnualYieldUsd / 365).toFixed(4));

  return {
    planVersion: 'siphon-solana-yield-park-v1',
    ownerAddress: ownerClean,
    strategy,
    split,
    apy: {
      estimatedApyPct,
      source: apySource,
      apyRangePct: strategy.apyRangePct,
    },
    projections: {
      projectedAnnualYieldUsd,
      projectedMonthlyYieldUsd,
      projectedDailyYieldUsd,
      yieldFundedDegenMonthlyBudgetUsd: projectedMonthlyYieldUsd,
    },
    jupiterQuote,
    transaction,
    warnings,
  };
}
