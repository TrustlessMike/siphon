import { EVM_CHAINS, getProtocolFeeConfig } from './chains.js';
import type {
  AnyChainId,
  ChainRouteStrategy,
  EvmChainId,
  RoiCostBreakdown,
  RoiVerdict,
  ScannedAsset,
  ScanReport,
} from './types.js';

export const SOLANA_USDC_ATA_RENT_SOL = 0.00203928;
export const WORTH_IT_MIN_NET_USD = 0.25;
export const WORTH_IT_MAX_COST_PCT = 35;
export const NEGATIVE_ROI_COST_PCT = 65;
export const DEFAULT_LIVE_QUOTE_HAIRCUT_CAP_PCT = 50;
export const RELAYER_BREAK_EVEN_MULTIPLIER = 1.5;

export type AssetRoiVerdict =
  | 'profitable'
  | 'profitable_batched_only'
  | 'negative_roi_skip'
  | 'zero_liquidity_burn'
  | 'honeypot_blocked';

export interface AssetRoiEvaluation {
  assetId: string;
  symbol: string;
  chain: AnyChainId;
  grossUsd: number;
  protocolFeeUsd: number;
  slippageUsd: number;
  soloGasUsd: number;
  batchedGasUsd: number;
  l1DataFeeUsd: number;
  /** Signed solo net USD (never clamped to 0) */
  signedSoloNetUsd: number;
  /** Signed batched net USD (never clamped to 0) */
  signedBatchedNetUsd: number;
  /** Signed marginal net ROI USD (canonical Level 1 signed output) */
  netRoiUsd: number;
  /** Total marginal costs as percentage of gross USD (0..100+) */
  effectiveCostPct: number;
  /** 3-tier UI verdict */
  roiVerdict: RoiVerdict;
  /** Signed user net USD when relayer sponsors gas ($0 user gas) */
  signedSponsoredNetUsd: number;
  /** Signed relayer margin on this asset alone: protocolFeeUsd - incrementalGasUsd */
  relayerAssetMarginUsd: number;
  costBreakdown: RoiCostBreakdown;
  verdict: AssetRoiVerdict;
  shouldIncludeByDefault: boolean;
  reason: string;
}

export interface RelayerBreakEvenResult {
  protocolFeeBps: number;
  protocolFeePercent: number;
  grossUsd: number;
  protocolFeeUsd: number;
  sponsoredGasUsd: number;
  fixedRelayerOverheadUsd: number;
  effectiveRelayerCostUsd: number;
  /** Minimum relayer coverage required by 1.5x safety policy */
  requiredRelayerCoverageUsd: number;
  /** Signed: positive = relayer profits, negative = relayer loses money */
  relayerNetMarginUsd: number;
  /** Minimum gross USD sweep size required for protocol fee to cover relayer gas + overhead */
  breakEvenGrossUsd: number;
  shortfallToBreakEvenUsd: number;
  isRelayerProfitable: boolean;
  marginPercentOfGross: number;
  rejectionReason?: string;
}

export interface PrunedAssetBuckets {
  kept: ScannedAsset[];
  lowEfficiency: ScannedAsset[];
  prunedNegativeRoi: ScannedAsset[];
  optionalBurns: ScannedAsset[];
  blockedHoneypots: ScannedAsset[];
  evaluations: AssetRoiEvaluation[];
}

export interface RouteComparison {
  recommendedStrategy: ChainRouteStrategy;
  localBatchSingleBridgeNetUsd: number;
  directPerTokenBridgeNetUsd: number;
  batchAdvantageUsd: number;
  singleBridgeFixedFeeUsd: number;
  perTokenBridgeTotalFeeUsd: number;
}

export interface ChainBatchRoiReport {
  chain: AnyChainId;
  chainName: string;
  assetCount: number;
  keptCount: number;
  lowEfficiencyCount: number;
  prunedNegativeRoiCount: number;
  optionalBurnCount: number;
  blockedHoneypotCount: number;
  includedAssetIds: string[];
  unprunedGrossUsd: number;
  keptGrossUsd: number;
  /** Signed user net BEFORE pruning negative-ROI dust */
  unprunedSignedUserNetUsd: number;
  /** Signed user net AFTER pruning negative-ROI dust */
  keptSignedUserNetUsd: number;
  /** Signed Level 2 total chain-leg net USD (including fixed bridge fee + Solana ATA rent) */
  chainLegNetUsd: number;
  chainLegCostPct: number;
  roiVerdict: RoiVerdict;
  skipChainNegativeRoi: boolean;
  routeComparison: RouteComparison;
  solanaAtaRentUsd: number;
  breakEvenHint?: string;
  /** Positive USD bleed prevented by pruning negative-ROI dust */
  negativeBleedPreventedUsd: number;
  protocolFeeUsd: number;
  totalGasUsd: number;
  totalSlippageUsd: number;
  bridgeFixedFeeUsd: number;
  relayerBreakEven: RelayerBreakEvenResult;
  recommendedExecution: 'sponsored_gasless' | 'self_funded_batch' | 'skip_negative_roi';
  warnings: string[];
  evaluations: AssetRoiEvaluation[];
}

export interface PortfolioRoiReport {
  protocolFeeBps: number;
  protocolFeePercent: number;
  totalGrossUsd: number;
  totalSignedUserNetUsd: number;
  totalProtocolFeeUsd: number;
  totalSponsoredGasUsd: number;
  totalRelayerNetMarginUsd: number;
  totalPrunedNegativeRoiCount: number;
  totalNegativeBleedPreventedUsd: number;
  solanaAtaRentUsd: number;
  overallRelayerProfitable: boolean;
  chains: ChainBatchRoiReport[];
}

export interface LiveQuoteHaircutResult {
  passed: boolean;
  grossUsd: number;
  quoteOutUsd: number;
  actualGasUsd: number;
  liveNetUsd: number;
  liveHaircutPct: number;
  capPct: number;
  overridden: boolean;
  reason: string;
}

const L2_CHAINS = new Set<string>([
  'base',
  'arbitrum',
  'optimism',
  'unichain',
  'linea',
  'scroll',
  'mantle',
  'blast',
  'worldchain',
]);

const CANONICAL_COSMOS_USDC_DENOMS = new Set<string>([
  'uusdc',
  'ibc/498a0751c798a0d9a389aa3691123dada57daa4fe165d5c75894505b876ba6e4',
  'ibc/f663521bf1836b00f5f177680f74bfb9a8b5654a694d0d2bc249e03cf2509013',
]);
const CANONICAL_SUI_USDC_TYPE =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::usdc';
const CANONICAL_APTOS_USDC_FA =
  '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b';
const CANONICAL_TRON_USDC_ADDRESS = 'tekxitehnzsmse2xqrbj4w32run966rdz8';

function r2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function ceil2(n: number): number {
  if (!Number.isFinite(n)) return Infinity;
  return Math.ceil(n * 100 - 1e-9) / 100;
}

function r4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function fmtSigned(n: number): string {
  const safe = Number.isFinite(n) ? n : 0;
  const rounded = r2(safe);
  const abs = Math.abs(rounded).toFixed(2);
  return rounded < 0 ? `-$${abs}` : `+$${abs}`;
}

function isEvmChain(chain: AnyChainId): chain is EvmChainId {
  return typeof chain === 'string' && Object.hasOwn(EVM_CHAINS, chain);
}

/**
 * Returns true ONLY when the asset settles 1:1 as canonical USDC without requiring a DEX swap:
 *  - 1:1 DeFi USDC receipts (e.g. aEthUSDC, cUSDCv3, steakUSDC, mwUSDC) whose underlying is canonical USDC
 *  - Canonical EVM USDC matching `EVM_CHAINS[chain].usdcAddress` (never spoofed ERC-20s with symbol "USDC")
 *  - Canonical non-EVM native/IBC USDC (Noble `uusdc`/native USDC, Osmosis/Cosmos Hub Noble IBC USDC,
 *    Sui native USDC, Aptos native FA USDC, Tron canonical USDC, or verified non-EVM direct bridge stable)
 */
export function isCanonicalDirectUsdc(asset: ScannedAsset): boolean {
  if (asset.kind === 'dead_token' || asset.action === 'BURN_ZERO_LIQUIDITY' || !asset.honeypotSafe) {
    return false;
  }

  const addrLower = (asset.address || '').trim().toLowerCase();
  const symUpper = (asset.symbol || '').trim().toUpperCase();

  if (isEvmChain(asset.chain)) {
    const canonicalUsdc = EVM_CHAINS[asset.chain].usdcAddress.toLowerCase();

    // 1:1 DeFi USDC withdrawals redeem directly to canonical USDC without a DEX swap
    if (asset.kind === 'defi_position') {
      const underlyingSym = (asset.underlyingSymbol || '').trim().toUpperCase();
      if (underlyingSym !== 'USDC') return false;
      if (asset.underlyingAddress) {
        return asset.underlyingAddress.trim().toLowerCase() === canonicalUsdc;
      }
      return true;
    }

    // For EVM tokens, strictly require the canonical chain USDC contract address (blocks spoofed "USDC" ERC-20s)
    return asset.kind === 'erc20' && addrLower === canonicalUsdc;
  }

  // Non-EVM 1:1 DeFi USDC receipt
  if (asset.kind === 'defi_position' && (asset.underlyingSymbol || '').trim().toUpperCase() === 'USDC') {
    return true;
  }

  // Noble native USDC (kind: 'native', symbol: 'USDC', address: 'uusdc') & Cosmos IBC Noble USDC
  if (asset.chain === 'noble') {
    return addrLower === 'uusdc' || (asset.kind === 'native' && symUpper === 'USDC');
  }
  if (
    asset.chain === 'cosmoshub' ||
    asset.chain === 'osmosis' ||
    asset.chain === 'celestia' ||
    asset.chain === 'injective' ||
    asset.chain === 'neutron'
  ) {
    return CANONICAL_COSMOS_USDC_DENOMS.has(addrLower);
  }
  if (asset.chain === 'sui') {
    return addrLower === CANONICAL_SUI_USDC_TYPE;
  }
  if (asset.chain === 'aptos') {
    return addrLower === CANONICAL_APTOS_USDC_FA;
  }
  if (asset.chain === 'tron') {
    return addrLower === CANONICAL_TRON_USDC_ADDRESS || asset.action === 'BRIDGE_DIRECT_USDC';
  }
  if (asset.chain === 'ton') {
    return asset.action === 'BRIDGE_DIRECT_USDC';
  }

  return false;
}

/**
 * Estimates L1 data/blob posting overhead on EVM L2 rollups (OP Stack, Arbitrum, zkEVMs).
 */
export function estimateL1DataFeeUsd(chain: AnyChainId, isBatched = true): number {
  if (!L2_CHAINS.has(chain)) return 0;
  // Post-EIP-4844 blob posting fee per swap/transfer (~$0.004–$0.015)
  const base = chain === 'scroll' || chain === 'linea' ? 0.015 : 0.005;
  return r4(isBatched ? base * 0.65 : base);
}

/**
 * Estimates fixed single-bridge / solver settlement overhead once per chain leg.
 */
export function estimateBridgeFixedFeeUsd(chain: AnyChainId): number {
  if (chain === 'ethereum') return 1.1;
  if (L2_CHAINS.has(chain)) return 0.16;
  if (chain === 'polygon' || chain === 'avalanche' || chain === 'bnb' || chain === 'sonic') return 0.2;
  if (chain === 'cosmoshub' || chain === 'osmosis' || chain === 'noble' || chain === 'celestia' || chain === 'injective' || chain === 'neutron') {
    return 0.14;
  }
  if (chain === 'sui' || chain === 'aptos') return 0.12;
  if (chain === 'ton') return 0.35;
  if (chain === 'tron') return 0.75;
  if (chain === 'btc') return 2.2;
  return 0.25;
}

/**
 * Computes Solana destination USDC ATA rent in USD (~0.00203928 SOL) when wallet lacks a USDC ATA.
 */
export function estimateSolanaAtaRentUsd(opts: { hasUsdcAta?: boolean; solPriceUsd?: number } = {}): number {
  if (opts.hasUsdcAta !== false) return 0;
  const solPrice = opts.solPriceUsd && opts.solPriceUsd > 0 ? opts.solPriceUsd : 70;
  return r2(SOLANA_USDC_ATA_RENT_SOL * solPrice);
}

/**
 * Estimates realistic price impact scaled by verified DEX liquidity depth rather than a flat 0.15%.
 */
export function estimateLiquidityScaledSlippageUsd(params: {
  grossUsd: number;
  liquidityUsd: number;
  isDirectUsdc?: boolean;
  isDead?: boolean;
}): number {
  if (params.isDead || params.isDirectUsdc || params.grossUsd <= 0) return 0;
  const liq = Math.max(1000, params.liquidityUsd || 0);
  // Base AMM fee (0.15%) + constant-product price impact scaled by trade/depth ratio (capped at 35%)
  const depthImpact = Math.min(0.35, (params.grossUsd / liq) * 2.0);
  const totalRate = Math.min(0.4, 0.0015 + depthImpact);
  return r2(params.grossUsd * totalRate);
}

/**
 * Classifies signed net ROI and effective cost percentage into the 3-tier UI verdict:
 *   - worth_it:       netRoiUsd > $0.25 AND effectiveCostPct < 35%
 *   - low_efficiency: netRoiUsd > $0    AND effectiveCostPct in [35%, 65%) (or net in (0, 0.25])
 *   - negative_roi:   netRoiUsd <= $0   OR  effectiveCostPct >= 65%
 */
export function classifyRoiVerdict(netRoiUsd: number, effectiveCostPct: number): RoiVerdict {
  if (!Number.isFinite(netRoiUsd) || !Number.isFinite(effectiveCostPct)) {
    return 'negative_roi';
  }
  if (netRoiUsd <= 0 || effectiveCostPct >= NEGATIVE_ROI_COST_PCT) {
    return 'negative_roi';
  }
  if (netRoiUsd > WORTH_IT_MIN_NET_USD && effectiveCostPct < WORTH_IT_MAX_COST_PCT) {
    return 'worth_it';
  }
  return 'low_efficiency';
}

/**
 * Live Quote Haircut Gate:
 * Re-evaluates real quoted output minus actual gas before allowing execution.
 * Drops any asset whose liveNetUsd <= 0 or liveHaircutPct > 50% (unless allowHighCost is true).
 * Fails closed on any non-finite (NaN / Infinity) or invalid input.
 */
export function evaluateLiveQuoteHaircut(params: {
  grossUsd: number;
  quoteOutUsd: number;
  actualGasUsd: number;
  allowHighCost?: boolean;
  maxHaircutPct?: number;
}): LiveQuoteHaircutResult {
  const rawCapPct = params.maxHaircutPct ?? DEFAULT_LIVE_QUOTE_HAIRCUT_CAP_PCT;
  if (
    !Number.isFinite(params.grossUsd) ||
    !Number.isFinite(params.quoteOutUsd) ||
    !Number.isFinite(params.actualGasUsd) ||
    !Number.isFinite(rawCapPct) ||
    rawCapPct <= 0 ||
    params.grossUsd < 0 ||
    params.quoteOutUsd < 0 ||
    params.actualGasUsd < 0
  ) {
    return {
      passed: false,
      grossUsd: Number.isFinite(params.grossUsd) ? r2(Math.max(0, params.grossUsd)) : 0,
      quoteOutUsd: Number.isFinite(params.quoteOutUsd) ? r2(Math.max(0, params.quoteOutUsd)) : 0,
      actualGasUsd: Number.isFinite(params.actualGasUsd) ? r2(Math.max(0, params.actualGasUsd)) : 0,
      liveNetUsd: 0,
      liveHaircutPct: 100,
      capPct: Number.isFinite(rawCapPct) && rawCapPct > 0 ? rawCapPct : DEFAULT_LIVE_QUOTE_HAIRCUT_CAP_PCT,
      overridden: false,
      reason: 'Dropped by Live Quote Haircut Gate: non-finite or invalid quote/gas parameters (fail-closed).',
    };
  }

  const grossUsd = r2(params.grossUsd);
  const quoteOutUsd = r2(params.quoteOutUsd);
  const actualGasUsd = r2(params.actualGasUsd);
  const capPct = rawCapPct;
  const liveNetUsd = r2(quoteOutUsd - actualGasUsd);
  const liveHaircutPct = grossUsd > 0 ? r2((1 - liveNetUsd / grossUsd) * 100) : 100;

  if (grossUsd <= 0 || liveNetUsd <= 0 || !Number.isFinite(liveNetUsd) || !Number.isFinite(liveHaircutPct)) {
    return {
      passed: false,
      grossUsd,
      quoteOutUsd,
      actualGasUsd,
      liveNetUsd: Number.isFinite(liveNetUsd) ? liveNetUsd : 0,
      liveHaircutPct: Number.isFinite(liveHaircutPct) ? liveHaircutPct : 100,
      capPct,
      overridden: false,
      reason:
        grossUsd <= 0
          ? 'Dropped by Live Quote Haircut Gate: gross USD value must be positive (fail-closed).'
          : `Dropped by Live Quote Haircut Gate: quoted net output is negative (${fmtSigned(liveNetUsd)} on $${grossUsd.toFixed(2)} gross).`,
    };
  }

  if (liveHaircutPct > capPct) {
    if (params.allowHighCost) {
      return {
        passed: true,
        grossUsd,
        quoteOutUsd,
        actualGasUsd,
        liveNetUsd,
        liveHaircutPct,
        capPct,
        overridden: true,
        reason: `High-cost override enabled: ${liveHaircutPct.toFixed(1)}% haircut exceeds ${capPct}% default cap.`,
      };
    }
    return {
      passed: false,
      grossUsd,
      quoteOutUsd,
      actualGasUsd,
      liveNetUsd,
      liveHaircutPct,
      capPct,
      overridden: false,
      reason: `Dropped by Live Quote Haircut Gate: ${liveHaircutPct.toFixed(1)}% total haircut exceeds ${capPct}% cap ($${liveNetUsd.toFixed(2)} net on $${grossUsd.toFixed(2)} gross). Pass allowHighCost: true to override.`,
    };
  }

  return {
    passed: true,
    grossUsd,
    quoteOutUsd,
    actualGasUsd,
    liveNetUsd,
    liveHaircutPct,
    capPct,
    overridden: false,
    reason: `Live quote passed haircut gate (${liveHaircutPct.toFixed(1)}% total cost, +$${liveNetUsd.toFixed(2)} net).`,
  };
}

/**
 * Level 1 — Asset-Level Signed Marginal ROI Evaluator.
 * Never clamps net outputs to 0; computes liquidity-scaled slippage, L2 data fee,
 * protocol fee, signed netRoiUsd, effectiveCostPct, and 3-tier roiVerdict.
 */
export function evaluateAssetRoi(
  asset: ScannedAsset,
  opts: {
    protocolFeeBps?: number;
    isBatched?: boolean;
    gasSponsored?: boolean;
    solanaAtaRentUsd?: number;
    includeSingleBridgeShare?: boolean;
    chainAssetCount?: number;
  } = {}
): AssetRoiEvaluation {
  const feeCfg = getProtocolFeeConfig({ feeBps: opts.protocolFeeBps });
  const isBatched = opts.isBatched ?? true;
  const grossUsd = Number.isFinite(asset.grossUsd) ? r2(Math.max(0, asset.grossUsd)) : 0;
  const soloGasUsd = Number.isFinite(asset.estimatedGasUsd) ? r4(Math.max(0, asset.estimatedGasUsd)) : 0;
  const batchedGasUsd = Number.isFinite(asset.batchedGasUsd) ? r4(Math.max(0, asset.batchedGasUsd)) : 0;
  const soloL1DataFeeUsd = estimateL1DataFeeUsd(asset.chain, false);
  const batchedL1DataFeeUsd = estimateL1DataFeeUsd(asset.chain, true);
  const l1DataFeeUsd = isBatched ? batchedL1DataFeeUsd : soloL1DataFeeUsd;
  const isDirectUsdc = isCanonicalDirectUsdc(asset);

  // Use the greater of explicit asset slippage or liquidity-depth-scaled price impact
  const scaledSlippage = estimateLiquidityScaledSlippageUsd({
    grossUsd,
    liquidityUsd: Number.isFinite(asset.liquidityUsd) ? asset.liquidityUsd : 0,
    isDirectUsdc,
    isDead: asset.kind === 'dead_token' || asset.action === 'BURN_ZERO_LIQUIDITY',
  });
  const explicitSlippage = Number.isFinite(asset.estimatedSlippageUsd) ? Math.max(0, asset.estimatedSlippageUsd) : 0;
  const slippageUsd = isDirectUsdc ? 0 : r2(Math.max(explicitSlippage, scaledSlippage));
  const incrementalGasUsd = r4((isBatched ? batchedGasUsd : soloGasUsd) + l1DataFeeUsd);

  if (asset.action === 'SKIP_HONEYPOT' || !asset.honeypotSafe) {
    return {
      assetId: asset.id,
      symbol: asset.symbol,
      chain: asset.chain,
      grossUsd,
      protocolFeeUsd: 0,
      slippageUsd: 0,
      soloGasUsd,
      batchedGasUsd,
      l1DataFeeUsd,
      signedSoloNetUsd: r2(-(soloGasUsd + soloL1DataFeeUsd)),
      signedBatchedNetUsd: r2(-(batchedGasUsd + batchedL1DataFeeUsd)),
      netRoiUsd: r2(-incrementalGasUsd),
      effectiveCostPct: 100,
      roiVerdict: 'negative_roi',
      signedSponsoredNetUsd: 0,
      relayerAssetMarginUsd: r2(-incrementalGasUsd),
      costBreakdown: {
        gasUsd: r2(isBatched ? batchedGasUsd : soloGasUsd),
        l1DataFeeUsd: r4(l1DataFeeUsd),
        slippageUsd: 0,
        bridgeFeeUsd: 0,
        protocolFeeUsd: 0,
        solanaAtaRentUsd: 0,
        totalCostUsd: r2(incrementalGasUsd),
      },
      verdict: 'honeypot_blocked',
      shouldIncludeByDefault: false,
      reason: `Blocked honeypot/revert token (attempting sweep would waste ${fmtSigned(-soloGasUsd)} gas).`,
    };
  }

  if (asset.action === 'BURN_ZERO_LIQUIDITY') {
    return {
      assetId: asset.id,
      symbol: asset.symbol,
      chain: asset.chain,
      grossUsd: 0,
      protocolFeeUsd: 0,
      slippageUsd: 0,
      soloGasUsd,
      batchedGasUsd,
      l1DataFeeUsd,
      signedSoloNetUsd: r2(-(soloGasUsd + soloL1DataFeeUsd)),
      signedBatchedNetUsd: r2(-(batchedGasUsd + batchedL1DataFeeUsd)),
      netRoiUsd: r2(-incrementalGasUsd),
      effectiveCostPct: 100,
      roiVerdict: 'negative_roi',
      signedSponsoredNetUsd: 0,
      relayerAssetMarginUsd: r2(-incrementalGasUsd),
      costBreakdown: {
        gasUsd: r2(isBatched ? batchedGasUsd : soloGasUsd),
        l1DataFeeUsd: r4(l1DataFeeUsd),
        slippageUsd: 0,
        bridgeFeeUsd: 0,
        protocolFeeUsd: 0,
        solanaAtaRentUsd: 0,
        totalCostUsd: r2(incrementalGasUsd),
      },
      verdict: 'zero_liquidity_burn',
      shouldIncludeByDefault: false,
      reason: `Zero-liquidity burn is strictly negative ROI (${fmtSigned(-incrementalGasUsd)} gas) — opt-in only.`,
    };
  }

  // Chain-specific sub-fee dust guard (e.g., BTC dust UTXO or pre-skipped chain-floor dust)
  const protocolFeeUsd = r2((Math.max(0, grossUsd - slippageUsd) * feeCfg.feeBps) / 10_000);
  const bridgeShareUsd = opts.includeSingleBridgeShare
    ? r2(estimateBridgeFixedFeeUsd(asset.chain) / Math.max(1, opts.chainAssetCount ?? 1))
    : 0;
  const ataShareUsd = r2(Math.max(0, Number.isFinite(opts.solanaAtaRentUsd ?? 0) ? (opts.solanaAtaRentUsd ?? 0) : 0));

  const soloTotalCostUsd = r2(soloGasUsd + soloL1DataFeeUsd + slippageUsd + protocolFeeUsd + bridgeShareUsd + ataShareUsd);
  const batchedTotalCostUsd = r2(batchedGasUsd + batchedL1DataFeeUsd + slippageUsd + protocolFeeUsd + bridgeShareUsd + ataShareUsd);
  const signedSoloNetUsd = r2(grossUsd - soloTotalCostUsd);
  const signedBatchedNetUsd = r2(grossUsd - batchedTotalCostUsd);
  const netRoiUsd = isBatched ? signedBatchedNetUsd : signedSoloNetUsd;
  const totalCostUsd = isBatched ? batchedTotalCostUsd : soloTotalCostUsd;
  const effectiveCostPct = grossUsd > 0 ? r2((totalCostUsd / grossUsd) * 100) : 100;

  // Respect explicit chain-floor / BTC sub-fee dust SKIP flags so pre-skipped dust is never resurrected
  let roiVerdict = classifyRoiVerdict(netRoiUsd, effectiveCostPct);
  if (asset.action === 'SKIP_GAS_NEGATIVE' || asset.action === 'SKIP_NEGATIVE_ROI') {
    roiVerdict = 'negative_roi';
  }

  const signedSponsoredNetUsd = r2(grossUsd - protocolFeeUsd - slippageUsd - bridgeShareUsd - ataShareUsd);
  const relayerAssetMarginUsd = r2(protocolFeeUsd - incrementalGasUsd);

  const soloEffectiveCostPct = grossUsd > 0 ? r2((soloTotalCostUsd / grossUsd) * 100) : 100;
  let verdict: AssetRoiVerdict;
  if (roiVerdict === 'negative_roi') {
    verdict = 'negative_roi_skip';
  } else if (classifyRoiVerdict(signedSoloNetUsd, soloEffectiveCostPct) === 'worth_it') {
    verdict = 'profitable';
  } else {
    verdict = 'profitable_batched_only';
  }

  const shouldIncludeByDefault = roiVerdict === 'worth_it';
  const reason =
    roiVerdict === 'worth_it'
      ? `Worth it: ${fmtSigned(netRoiUsd)} net (${effectiveCostPct.toFixed(1)}% total cost).`
      : roiVerdict === 'low_efficiency'
      ? `High cost (${effectiveCostPct.toFixed(1)}% fees, ${fmtSigned(netRoiUsd)} net) — unchecked by default (opt-in).`
      : `Negative ROI (${fmtSigned(netRoiUsd)} net, ${effectiveCostPct.toFixed(1)}% total cost) — auto-skipped.`;

  return {
    assetId: asset.id,
    symbol: asset.symbol,
    chain: asset.chain,
    grossUsd,
    protocolFeeUsd,
    slippageUsd,
    soloGasUsd,
    batchedGasUsd,
    l1DataFeeUsd,
    signedSoloNetUsd,
    signedBatchedNetUsd,
    netRoiUsd,
    effectiveCostPct,
    roiVerdict,
    signedSponsoredNetUsd,
    relayerAssetMarginUsd,
    costBreakdown: {
      gasUsd: r2(isBatched ? batchedGasUsd : soloGasUsd),
      l1DataFeeUsd: r4(l1DataFeeUsd),
      slippageUsd,
      bridgeFeeUsd: bridgeShareUsd,
      protocolFeeUsd,
      solanaAtaRentUsd: ataShareUsd,
      totalCostUsd,
    },
    verdict,
    shouldIncludeByDefault,
    reason,
  };
}

/**
 * Exact Relayer Break-Even Math:
 * Unifies off-chain eligibility with on-chain `SiphonRouter` / `SiphonSweepDelegate` solvency:
 *   - Total relayer outlay `G = sponsoredGasUsd + l1DataFeeUsd + fixedRelayerOverheadUsd`
 *   - Required coverage = `1.5 * G`
 *   - When gas is reimbursed from proceeds (`maxGasReimbursementUsd !== undefined`),
 *     effective reimbursement in solvency math is capped at actual outlay `min(G, maxGasReimbursementUsd)`
 *     (never inflated by a 2.5x safety ceiling!), enforcing `protocolFeeUsd >= 0.5 * G` at full reimbursement.
 *   - When unreimbursed (`maxGasReimbursementUsd === undefined`), enforces `protocolFeeUsd >= 1.5 * G` unconditionally.
 */
export function computeRelayerBreakEven(params: {
  sponsoredGasUsd: number;
  protocolFeeBps?: number;
  grossUsd: number;
  maxGasReimbursementUsd?: number;
  fixedRelayerOverheadUsd?: number;
  l1DataFeeUsd?: number;
  slippageUsd?: number;
}): RelayerBreakEvenResult {
  const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
  const rate = feeCfg.feeBps / 10_000;

  const rawOverhead = params.fixedRelayerOverheadUsd ?? 0.02;
  const rawL1Data = params.l1DataFeeUsd ?? 0;
  const rawSlippage = params.slippageUsd ?? 0;
  const isReimbursed = params.maxGasReimbursementUsd !== undefined;

  if (
    !Number.isFinite(params.sponsoredGasUsd) ||
    !Number.isFinite(params.grossUsd) ||
    !Number.isFinite(rawOverhead) ||
    !Number.isFinite(rawL1Data) ||
    !Number.isFinite(rawSlippage) ||
    (isReimbursed && !Number.isFinite(params.maxGasReimbursementUsd!))
  ) {
    return {
      protocolFeeBps: feeCfg.feeBps,
      protocolFeePercent: feeCfg.feePercent,
      grossUsd: 0,
      protocolFeeUsd: 0,
      sponsoredGasUsd: 0,
      fixedRelayerOverheadUsd: 0.02,
      effectiveRelayerCostUsd: 0.02,
      requiredRelayerCoverageUsd: 0.03,
      relayerNetMarginUsd: -0.02,
      breakEvenGrossUsd: Infinity,
      shortfallToBreakEvenUsd: Infinity,
      isRelayerProfitable: false,
      marginPercentOfGross: -100,
      rejectionReason:
        'Below gasless sponsorship break-even: non-finite gas, gross, or reimbursement inputs (fail-closed).',
    };
  }

  const fixedRelayerOverheadUsd = r2(Math.max(0, rawOverhead));
  const l1DataFeeUsd = r4(Math.max(0, rawL1Data));
  const sponsoredGasUsd = r2(Math.max(0, params.sponsoredGasUsd));
  const effectiveRelayerCostUsd = r2(sponsoredGasUsd + l1DataFeeUsd + fixedRelayerOverheadUsd);
  const requiredRelayerCoverageUsd = r2(effectiveRelayerCostUsd * RELAYER_BREAK_EVEN_MULTIPLIER);

  const grossUsd = r2(Math.max(0, params.grossUsd));
  const slippageUsd = r2(Math.min(grossUsd, Math.max(0, rawSlippage)));
  const netAfterSlippageUsd = r2(Math.max(0, grossUsd - slippageUsd));
  const protocolFeeUsd = r2(netAfterSlippageUsd * rate);

  // Cap effective reimbursement in solvency math at actual relayer outlay G (never 2.5x safety cap!)
  const effectiveReimbursementUsd = isReimbursed
    ? r2(Math.min(effectiveRelayerCostUsd, Math.max(0, params.maxGasReimbursementUsd!)))
    : 0;
  const totalRelayerRevenueUsd = r2(protocolFeeUsd + effectiveReimbursementUsd);

  const relayerNetMarginUsd = r2(totalRelayerRevenueUsd - effectiveRelayerCostUsd);
  const requiredFeeUsd = r2(Math.max(0, requiredRelayerCoverageUsd - effectiveReimbursementUsd));
  const slippageRate = grossUsd > 0 ? Math.min(0.99, slippageUsd / grossUsd) : 0;
  const effectiveFeeRate = rate * (1 - slippageRate);

  const minGrossForFeeUsd = effectiveFeeRate > 0 ? ceil2(requiredFeeUsd / effectiveFeeRate) : Infinity;
  const userRetentionRate = (1 - slippageRate) * (1 - rate);
  const minGrossForUserNetUsd =
    isReimbursed && userRetentionRate > 0
      ? ceil2((effectiveRelayerCostUsd + 0.01) / userRetentionRate)
      : 0;
  const breakEvenGrossUsd = isReimbursed
    ? Math.max(minGrossForFeeUsd, minGrossForUserNetUsd)
    : minGrossForFeeUsd;

  const shortfallToBreakEvenUsd = Number.isFinite(breakEvenGrossUsd)
    ? r2(Math.max(0, breakEvenGrossUsd - grossUsd))
    : Infinity;

  const userProceedsPositive =
    !isReimbursed || netAfterSlippageUsd > effectiveRelayerCostUsd + protocolFeeUsd;
  const isRelayerProfitable =
    grossUsd > 0 &&
    totalRelayerRevenueUsd >= requiredRelayerCoverageUsd &&
    userProceedsPositive;

  const marginPercentOfGross = grossUsd > 0 ? r2((relayerNetMarginUsd / grossUsd) * 100) : -100;
  const rejectionReason = !isRelayerProfitable
    ? isReimbursed
      ? `Below gasless sponsorship break-even: expected fee + capped gas reimbursement ($${totalRelayerRevenueUsd.toFixed(2)}) is below ${RELAYER_BREAK_EVEN_MULTIPLIER}x relayer cost ($${requiredRelayerCoverageUsd.toFixed(2)}). Need ≥ $${breakEvenGrossUsd.toFixed(2)} gross on this chain.`
      : `Below gasless sponsorship break-even: expected protocol fee ($${protocolFeeUsd.toFixed(2)}) is below ${RELAYER_BREAK_EVEN_MULTIPLIER}x relayer cost ($${requiredRelayerCoverageUsd.toFixed(2)}). Need ≥ $${breakEvenGrossUsd.toFixed(2)} gross on this chain.`
    : undefined;

  return {
    protocolFeeBps: feeCfg.feeBps,
    protocolFeePercent: feeCfg.feePercent,
    grossUsd,
    protocolFeeUsd,
    sponsoredGasUsd,
    fixedRelayerOverheadUsd,
    effectiveRelayerCostUsd,
    requiredRelayerCoverageUsd,
    relayerNetMarginUsd,
    breakEvenGrossUsd,
    shortfallToBreakEvenUsd,
    isRelayerProfitable,
    marginPercentOfGross,
    rejectionReason,
  };
}

/**
 * Separates assets into `worth_it` (kept), `low_efficiency` (unchecked opt-in),
 * `negative_roi` (pruned), `optionalBurns`, and `blockedHoneypots`.
 */
export function pruneNegativeRoiAssets(
  assets: ScannedAsset[],
  opts: { protocolFeeBps?: number; isBatched?: boolean } = {}
): PrunedAssetBuckets {
  const kept: ScannedAsset[] = [];
  const lowEfficiency: ScannedAsset[] = [];
  const prunedNegativeRoi: ScannedAsset[] = [];
  const optionalBurns: ScannedAsset[] = [];
  const blockedHoneypots: ScannedAsset[] = [];
  const evaluations: AssetRoiEvaluation[] = [];

  for (const a of assets) {
    const ev = evaluateAssetRoi(a, opts);
    evaluations.push(ev);
    if (ev.verdict === 'honeypot_blocked') blockedHoneypots.push(a);
    else if (ev.verdict === 'zero_liquidity_burn') optionalBurns.push(a);
    else if (ev.roiVerdict === 'negative_roi') prunedNegativeRoi.push(a);
    else if (ev.roiVerdict === 'low_efficiency') lowEfficiency.push(a);
    else kept.push(a);
  }

  return { kept, lowEfficiency, prunedNegativeRoi, optionalBurns, blockedHoneypots, evaluations };
}

/**
 * Level 2 Route Optimizer:
 * Compares Local Batch Swap + Single Bridge (1 bridge fee + amortized swap gas)
 * vs Direct Per-Token Bridge (N bridge fees + individual tx overhead).
 */
export function compareChainRouteStrategies(params: {
  chain: AnyChainId;
  assets: ScannedAsset[];
  evaluations: AssetRoiEvaluation[];
  protocolFeeUsd: number;
  solanaAtaRentUsd: number;
}): RouteComparison {
  const count = Math.max(1, params.assets.length);
  const grossUsd = r2(params.assets.reduce((s, a) => s + a.grossUsd, 0));
  const totalSlippageUsd = r2(params.evaluations.reduce((s, e) => s + e.slippageUsd, 0));
  const singleBridgeFixedFeeUsd = estimateBridgeFixedFeeUsd(params.chain);
  const perTokenBridgeTotalFeeUsd = r2(singleBridgeFixedFeeUsd * count);

  const batchedSwapGasUsd = r2(
    params.evaluations.reduce((s, e) => s + e.batchedGasUsd + e.l1DataFeeUsd, 0)
  );
  const directPerTokenGasUsd = r2(
    params.evaluations.reduce((s, e) => s + e.soloGasUsd + estimateL1DataFeeUsd(e.chain, false), 0)
  );

  // Local batch swap + single bridge pays fixed bridge cost ONCE per chain leg!
  const localBatchSingleBridgeNetUsd = r2(
    grossUsd -
      params.protocolFeeUsd -
      totalSlippageUsd -
      batchedSwapGasUsd -
      singleBridgeFixedFeeUsd -
      params.solanaAtaRentUsd
  );

  // Direct per-token bridge pays bridge/solver cost per asset
  const directPerTokenBridgeNetUsd = r2(
    grossUsd -
      params.protocolFeeUsd -
      totalSlippageUsd -
      directPerTokenGasUsd -
      perTokenBridgeTotalFeeUsd -
      params.solanaAtaRentUsd
  );

  const recommendedStrategy: ChainRouteStrategy =
    localBatchSingleBridgeNetUsd >= directPerTokenBridgeNetUsd
      ? 'local_batch_single_bridge'
      : 'direct_per_token_bridge';

  return {
    recommendedStrategy,
    localBatchSingleBridgeNetUsd,
    directPerTokenBridgeNetUsd,
    batchAdvantageUsd: r2(localBatchSingleBridgeNetUsd - directPerTokenBridgeNetUsd),
    singleBridgeFixedFeeUsd,
    perTokenBridgeTotalFeeUsd,
  };
}

/**
 * Level 2 — Chain-Level Batch Economics, Route Optimizer, Solana ATA Rent & Break-Even Hint.
 */
export function evaluateChainBatchRoi(params: {
  chain: AnyChainId;
  chainName?: string;
  assets: ScannedAsset[];
  protocolFeeBps?: number;
  gasSponsored?: boolean;
  fixedRelayerOverheadUsd?: number;
  hasSolanaUsdcAta?: boolean;
  solPriceUsd?: number;
  gasPriceGwei?: number;
}): ChainBatchRoiReport {
  const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
  const gasSponsored = params.gasSponsored ?? true;
  const solanaAtaRentUsd = estimateSolanaAtaRentUsd({
    hasUsdcAta: params.hasSolanaUsdcAta,
    solPriceUsd: params.solPriceUsd,
  });

  const buckets = pruneNegativeRoiAssets(params.assets, {
    protocolFeeBps: feeCfg.feeBps,
    isBatched: true,
  });

  // Positive-marginal assets eligible for the chain leg (worth_it + low_efficiency if combined batch rescues/improves them)
  const sweepableAll = [...buckets.kept, ...buckets.lowEfficiency, ...buckets.prunedNegativeRoi];
  const evalById = new Map(buckets.evaluations.map((e) => [e.assetId, e]));

  const evaluateCandidateSet = (candidates: ScannedAsset[]) => {
    const cIds = new Set(candidates.map((a) => a.id));
    const cEvals = buckets.evaluations.filter((e) => cIds.has(e.assetId));
    const cGross = r2(candidates.reduce((s, a) => s + (Number.isFinite(a.grossUsd) ? Math.max(0, a.grossUsd) : 0), 0));
    const cGas = r2(cEvals.reduce((s, e) => s + e.batchedGasUsd + e.l1DataFeeUsd, 0));
    const cSlippage = r2(cEvals.reduce((s, e) => s + e.slippageUsd, 0));
    const cFee = r2((Math.max(0, cGross - cSlippage) * feeCfg.feeBps) / 10_000);
    const cRoute = compareChainRouteStrategies({
      chain: params.chain,
      assets: candidates,
      evaluations: cEvals,
      protocolFeeUsd: cFee,
      solanaAtaRentUsd,
    });
    const cBestNet =
      candidates.length === 0
        ? r2(-(estimateBridgeFixedFeeUsd(params.chain) + solanaAtaRentUsd))
        : Math.max(cRoute.localBatchSingleBridgeNetUsd, cRoute.directPerTokenBridgeNetUsd);
    const cBridgeFee =
      cRoute.recommendedStrategy === 'local_batch_single_bridge'
        ? cRoute.singleBridgeFixedFeeUsd
        : cRoute.perTokenBridgeTotalFeeUsd;
    const cCost = r2(cGross - cBestNet);
    const cCostPct = cGross > 0 ? r2((cCost / cGross) * 100) : 100;
    const cVerdict: RoiVerdict =
      candidates.length === 0 ? 'negative_roi' : classifyRoiVerdict(cBestNet, cCostPct);
    return {
      candidates,
      evals: cEvals,
      grossUsd: cGross,
      totalGasUsd: cGas,
      totalSlippageUsd: cSlippage,
      protocolFeeUsd: cFee,
      routeComparison: cRoute,
      bestChainLegNetUsd: cBestNet,
      bridgeFixedFeeUsd: cBridgeFee,
      chainLegCostPct: cCostPct,
      roiVerdict: cVerdict,
      skipChainNegativeRoi: cVerdict === 'negative_roi',
    };
  };

  // Start with worth_it assets, then greedily incorporate low_efficiency assets (ordered by lowest
  // effectiveCostPct) whenever adding them strictly increases chainLegNetUsd without pushing a valid
  // batch into negative_roi (fixes both non-monotonic wipeout and unpriced phantom dust!).
  const sortedLowEff = [...buckets.lowEfficiency].sort((a, b) => {
    const ea = evalById.get(a.id);
    const eb = evalById.get(b.id);
    const costDiff = (ea?.effectiveCostPct ?? 100) - (eb?.effectiveCostPct ?? 100);
    if (Math.abs(costDiff) > 1e-6) return costDiff;
    return (eb?.netRoiUsd ?? 0) - (ea?.netRoiUsd ?? 0);
  });

  const keptOnlyResult = evaluateCandidateSet(buckets.kept);
  let bestResult = keptOnlyResult;
  const workingCandidates = [...buckets.kept];

  for (const candidate of sortedLowEff) {
    const trial = evaluateCandidateSet([...workingCandidates, candidate]);
    const improvesNet = trial.bestChainLegNetUsd > bestResult.bestChainLegNetUsd;
    const keepsValidOrRescuing =
      !trial.skipChainNegativeRoi || bestResult.skipChainNegativeRoi;
    if (improvesNet && keepsValidOrRescuing) {
      workingCandidates.push(candidate);
      bestResult = trial;
    }
  }

  // Never choose a skipped combined batch if worth_it assets alone were valid
  if (bestResult.skipChainNegativeRoi && !keptOnlyResult.skipChainNegativeRoi) {
    bestResult = keptOnlyResult;
  }

  const legCandidates = bestResult.candidates;
  const keptGrossUsd = bestResult.grossUsd;
  const keptEvals = bestResult.evals;

  const unprunedGrossUsd = r2(
    sweepableAll.reduce((s, a) => s + (Number.isFinite(a.grossUsd) ? Math.max(0, a.grossUsd) : 0), 0)
  );
  const unprunedEvals = buckets.evaluations.filter(
    (e) => e.verdict !== 'honeypot_blocked' && e.verdict !== 'zero_liquidity_burn'
  );

  const unprunedSignedUserNetUsd = r2(
    unprunedEvals.reduce((s, e) => s + e.signedBatchedNetUsd, 0)
  );
  const keptSignedUserNetUsd = r2(
    keptEvals.reduce((s, e) => s + (gasSponsored ? e.signedSponsoredNetUsd : e.signedBatchedNetUsd), 0)
  );
  const prunedNegativeIds = new Set(buckets.prunedNegativeRoi.map((a) => a.id));
  const negativeBleedPreventedUsd = r2(
    buckets.evaluations
      .filter((e) => prunedNegativeIds.has(e.assetId))
      .reduce((s, e) => s + Math.max(0, -e.signedBatchedNetUsd), 0)
  );

  const totalGasUsd = bestResult.totalGasUsd;
  const totalSlippageUsd = bestResult.totalSlippageUsd;
  const protocolFeeUsd = bestResult.protocolFeeUsd;
  const routeComparison = bestResult.routeComparison;
  const bestChainLegNetUsd = bestResult.bestChainLegNetUsd;
  const bridgeFixedFeeUsd = bestResult.bridgeFixedFeeUsd;
  const chainLegCostPct = bestResult.chainLegCostPct;
  const roiVerdict = bestResult.roiVerdict;
  const skipChainNegativeRoi = bestResult.skipChainNegativeRoi;

  let breakEvenHint: string | undefined;
  if (skipChainNegativeRoi) {
    const representativeGasUsd =
      totalGasUsd > 0
        ? totalGasUsd
        : unprunedEvals.length > 0
        ? r2(Math.min(...unprunedEvals.map((e) => e.batchedGasUsd + e.l1DataFeeUsd)))
        : 0;
    const fixedCosts = representativeGasUsd + bridgeFixedFeeUsd + solanaAtaRentUsd + WORTH_IT_MIN_NET_USD;
    const neededGross = r2(fixedCosts / Math.max(0.15, 0.35 - feeCfg.feeBps / 10_000));
    if (isEvmChain(params.chain) && params.gasPriceGwei && params.gasPriceGwei > 1 && representativeGasUsd > 0.5) {
      const targetGwei = Math.max(0.5, Number((params.gasPriceGwei * 0.35).toFixed(1)));
      breakEvenHint = `Becomes profitable below ${targetGwei} gwei or when chain balance > $${neededGross.toFixed(2)}.`;
    } else {
      breakEvenHint = `Becomes profitable when chain balance > $${neededGross.toFixed(2)} (fixed costs ~$${r2(representativeGasUsd + bridgeFixedFeeUsd + solanaAtaRentUsd).toFixed(2)}).`;
    }
  }

  const relayerBreakEven = computeRelayerBreakEven({
    sponsoredGasUsd: totalGasUsd,
    protocolFeeBps: feeCfg.feeBps,
    grossUsd: keptGrossUsd,
    slippageUsd: totalSlippageUsd,
    fixedRelayerOverheadUsd: params.fixedRelayerOverheadUsd,
  });

  let recommendedExecution: ChainBatchRoiReport['recommendedExecution'];
  if (skipChainNegativeRoi || legCandidates.length === 0) {
    recommendedExecution = 'skip_negative_roi';
  } else if (relayerBreakEven.isRelayerProfitable) {
    recommendedExecution = 'sponsored_gasless';
  } else {
    recommendedExecution = 'self_funded_batch';
  }

  const warnings: string[] = [];
  if (buckets.prunedNegativeRoi.length > 0) {
    warnings.push(
      `Pruned ${buckets.prunedNegativeRoi.length} negative-ROI dust asset(s), preventing ${fmtSigned(-negativeBleedPreventedUsd)} in value bleed.`
    );
  }
  if (solanaAtaRentUsd > 0) {
    warnings.push(
      `First-time Solana USDC ATA creation rent (~$${solanaAtaRentUsd.toFixed(2)} / ${SOLANA_USDC_ATA_RENT_SOL.toFixed(5)} SOL) factored into leg ROI.`
    );
  }
  if (skipChainNegativeRoi && breakEvenHint) {
    warnings.push(`SKIP_CHAIN_NEGATIVE_ROI: ${breakEvenHint}`);
  } else if (legCandidates.length > 0 && !relayerBreakEven.isRelayerProfitable) {
    warnings.push(
      `Below relayer break-even ($${relayerBreakEven.breakEvenGrossUsd.toFixed(2)} gross needed at ${feeCfg.feePercent}% fee to cover $${relayerBreakEven.requiredRelayerCoverageUsd.toFixed(2)} 1.5x relayer coverage; shortfall $${relayerBreakEven.shortfallToBreakEvenUsd.toFixed(2)}).`
    );
  }

  return {
    chain: params.chain,
    chainName: params.chainName || params.assets[0]?.chainName || params.chain,
    assetCount: params.assets.length,
    keptCount: buckets.kept.length,
    lowEfficiencyCount: buckets.lowEfficiency.length,
    prunedNegativeRoiCount: buckets.prunedNegativeRoi.length,
    optionalBurnCount: buckets.optionalBurns.length,
    blockedHoneypotCount: buckets.blockedHoneypots.length,
    includedAssetIds: legCandidates.map((a) => a.id),
    unprunedGrossUsd,
    keptGrossUsd,
    unprunedSignedUserNetUsd,
    keptSignedUserNetUsd,
    chainLegNetUsd: bestChainLegNetUsd,
    chainLegCostPct,
    roiVerdict,
    skipChainNegativeRoi,
    routeComparison,
    solanaAtaRentUsd,
    breakEvenHint,
    negativeBleedPreventedUsd,
    protocolFeeUsd,
    totalGasUsd,
    totalSlippageUsd,
    bridgeFixedFeeUsd,
    relayerBreakEven,
    recommendedExecution,
    warnings,
    evaluations: buckets.evaluations,
  };
}

function formatIdempotentLowEfficiencyReason(evReason: string, existingReason: string): string {
  const existing = (existingReason || '').trim();
  if (!existing) return evReason;
  // Unwrap any previously prepended "High cost (...) — unchecked by default (opt-in). (...)" wrapper
  const match = existing.match(/^High cost \([^)]+\)\s+—\s+unchecked by default \(opt-in\)\.\s*(?:\((.*)\))?$/);
  if (match) {
    const inner = (match[1] || '').trim();
    return inner ? `${evReason} (${inner})` : evReason;
  }
  return `${evReason} (${existing})`;
}

/**
 * Stamps Level 1 (signed marginal per-asset ROI) & Level 2 (chain-leg total ROI + route optimizer + break-even hint)
 * onto any ScanReport across ALL 7 chain families (`evm`, `cosmos`, `sui`, `aptos`, `ton`, `tron`, `btc`).
 */
export function applyTwoLevelRoiToReport(
  report: ScanReport,
  opts: {
    protocolFeeBps?: number;
    hasSolanaUsdcAta?: boolean;
  } = {}
): ScanReport {
  const feeBps = opts.protocolFeeBps ?? report.totals.protocolFeeBps;
  const solPriceUsd = report.totals.solPriceUsd || 70;
  const ataRentTotal = estimateSolanaAtaRentUsd({
    hasUsdcAta: opts.hasSolanaUsdcAta,
    solPriceUsd,
  });

  // Group assets by chain
  const byChain = new Map<AnyChainId, ScannedAsset[]>();
  for (const a of report.assets) {
    const arr = byChain.get(a.chain) ?? [];
    arr.push(a);
    byChain.set(a.chain, arr);
  }

  // Pass 1: Evaluate all chains without Solana ATA rent to determine independently executing chains
  const chainRoiByChain = new Map<AnyChainId, ChainBatchRoiReport>();
  for (const chainSummary of report.chains) {
    const chainAssets = byChain.get(chainSummary.chain) ?? [];
    if (!chainAssets.length) continue;

    chainRoiByChain.set(
      chainSummary.chain,
      evaluateChainBatchRoi({
        chain: chainSummary.chain,
        chainName: chainSummary.chainName,
        assets: chainAssets,
        protocolFeeBps: feeBps,
        gasSponsored: chainSummary.needsGasSponsorship,
        hasSolanaUsdcAta: true,
        solPriceUsd,
        gasPriceGwei: chainSummary.gasPriceGwei,
      })
    );
  }

  // Pass 2: Charge Solana ATA rent EXACTLY ONCE across the entire multi-chain sweep
  // on the highest-net executing chain (never double-counted or stamped onto skipped chains!)
  if (ataRentTotal > 0) {
    const executingCandidates = report.chains
      .map((cs) => ({ cs, roi: chainRoiByChain.get(cs.chain) }))
      .filter(
        (entry): entry is { cs: (typeof report.chains)[number]; roi: ChainBatchRoiReport } =>
          Boolean(entry.roi && !entry.roi.skipChainNegativeRoi && entry.roi.includedAssetIds.length > 0)
      )
      .sort((a, b) => b.roi.chainLegNetUsd - a.roi.chainLegNetUsd);

    let ataAssigned = false;
    for (const { cs } of executingCandidates) {
      const chainAssets = byChain.get(cs.chain) ?? [];
      const withAta = evaluateChainBatchRoi({
        chain: cs.chain,
        chainName: cs.chainName,
        assets: chainAssets,
        protocolFeeBps: feeBps,
        gasSponsored: cs.needsGasSponsorship,
        hasSolanaUsdcAta: false,
        solPriceUsd,
        gasPriceGwei: cs.gasPriceGwei,
      });
      if (!withAta.skipChainNegativeRoi) {
        chainRoiByChain.set(cs.chain, withAta);
        ataAssigned = true;
        break;
      }
    }

    // If no single chain can survive ATA rent, re-apply ATA to the single best candidate so it skips cleanly
    if (!ataAssigned && executingCandidates.length > 0) {
      const best = executingCandidates[0];
      const chainAssets = byChain.get(best.cs.chain) ?? [];
      const skippedWithAta = evaluateChainBatchRoi({
        chain: best.cs.chain,
        chainName: best.cs.chainName,
        assets: chainAssets,
        protocolFeeBps: feeBps,
        gasSponsored: best.cs.needsGasSponsorship,
        hasSolanaUsdcAta: false,
        solPriceUsd,
        gasPriceGwei: best.cs.gasPriceGwei,
      });
      chainRoiByChain.set(best.cs.chain, {
        ...skippedWithAta,
        solanaAtaRentUsd: 0,
      });
    }
  }

  for (const chainSummary of report.chains) {
    const chainAssets = byChain.get(chainSummary.chain) ?? [];
    if (!chainAssets.length) continue;

    const chainRoi = chainRoiByChain.get(chainSummary.chain);
    if (!chainRoi) continue;

    const evalMap = new Map(chainRoi.evaluations.map((e) => [e.assetId, e]));
    for (const a of chainAssets) {
      const ev = evalMap.get(a.id);
      if (!ev) continue;
      a.netRoiUsd = ev.netRoiUsd;
      a.effectiveCostPct = ev.effectiveCostPct;
      a.roiVerdict = ev.roiVerdict;
      a.roiCostBreakdown = ev.costBreakdown;
      a.netUsdcSingle = ev.signedSoloNetUsd;
      a.netUsdcBatched = ev.signedBatchedNetUsd;

      if (a.action === 'SKIP_HONEYPOT' || a.action === 'BURN_ZERO_LIQUIDITY') {
        a.selectedByDefault = false;
        continue;
      }
      if (a.aaveDebtUsd && a.aaveDebtUsd > 0) {
        a.selectedByDefault = false;
        continue;
      }
      // Never resurrect pre-skipped dust (Cosmos/Tron/TON/BTC floor skips) as selectedByDefault: true
      if (a.action === 'SKIP_GAS_NEGATIVE' || a.action === 'SKIP_NEGATIVE_ROI') {
        a.selectedByDefault = false;
        continue;
      }

      if (ev.roiVerdict === 'negative_roi') {
        a.action = 'SKIP_GAS_NEGATIVE';
        a.selectedByDefault = false;
        if (!a.actionReason.toLowerCase().includes('skipped')) {
          a.actionReason = ev.reason;
        }
      } else if (ev.roiVerdict === 'low_efficiency') {
        // Low efficiency (35%-65% fees): keep sweepable action so user can opt in, unchecked by default!
        a.selectedByDefault = false;
        a.actionReason = formatIdempotentLowEfficiencyReason(ev.reason, a.actionReason);
      } else {
        // Worth it: selected by default unless the entire chain leg is negative ROI
        a.selectedByDefault = !chainRoi.skipChainNegativeRoi;
      }
    }

    // Fully synchronize chainSummary aggregates from post-ROI assets
    const activeSweep = chainAssets.filter(
      (a) =>
        a.action === 'WITHDRAW_AND_BRIDGE' ||
        a.action === 'SELL_AND_BRIDGE' ||
        a.action === 'BRIDGE_DIRECT_USDC'
    );
    const chainGrossUsd = r2(activeSweep.reduce((s, a) => s + a.grossUsd, 0));
    const chainSingleGas = r4(activeSweep.reduce((s, a) => s + a.estimatedGasUsd, 0));
    const chainBatchedGas = r4(activeSweep.reduce((s, a) => s + a.batchedGasUsd, 0));
    const chainSlippage = r2(
      activeSweep.reduce((s, a) => s + (a.roiCostBreakdown?.slippageUsd ?? a.estimatedSlippageUsd ?? 0), 0)
    );
    const chainFee = r2((Math.max(0, chainGrossUsd - chainSlippage) * feeBps) / 10_000);

    chainSummary.assetCount = chainAssets.length;
    chainSummary.defiCount = chainAssets.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE').length;
    chainSummary.liquidCount = chainAssets.filter(
      (a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC'
    ).length;
    chainSummary.burnCount = chainAssets.filter((a) => a.action === 'BURN_ZERO_LIQUIDITY').length;
    chainSummary.skippedCount = chainAssets.filter(
      (a) =>
        a.action === 'SKIP_HONEYPOT' ||
        a.action === 'SKIP_GAS_NEGATIVE' ||
        a.action === 'SKIP_NEGATIVE_ROI'
    ).length;
    chainSummary.grossUsd = chainGrossUsd;
    chainSummary.totalGasUsd = r2(chainBatchedGas);
    chainSummary.gasSavedByBatchUsd = r2(Math.max(0, chainSingleGas - chainBatchedGas));
    chainSummary.netUsdcBridged = r2(Math.max(0, chainGrossUsd - chainSlippage - chainBatchedGas - chainFee));

    chainSummary.chainLegNetUsd = chainRoi.chainLegNetUsd;
    chainSummary.chainLegCostPct = chainRoi.chainLegCostPct;
    chainSummary.roiVerdict = chainRoi.roiVerdict;
    chainSummary.skipChainNegativeRoi = chainRoi.skipChainNegativeRoi;
    chainSummary.routeStrategy = chainRoi.routeComparison.recommendedStrategy;
    chainSummary.breakEvenHint = chainRoi.breakEvenHint;
    chainSummary.solanaAtaRentUsd = chainRoi.skipChainNegativeRoi ? 0 : chainRoi.solanaAtaRentUsd;
  }

  // Fully synchronize report.totals from post-ROI active assets
  const activeAll = report.assets.filter(
    (a) =>
      a.action === 'WITHDRAW_AND_BRIDGE' ||
      a.action === 'SELL_AND_BRIDGE' ||
      a.action === 'BRIDGE_DIRECT_USDC'
  );
  const totalGrossUsd = r2(activeAll.reduce((s, a) => s + a.grossUsd, 0));
  const defiGrossUsd = r2(
    activeAll.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE').reduce((s, a) => s + a.grossUsd, 0)
  );
  const liquidGrossUsd = r2(totalGrossUsd - defiGrossUsd);
  const singleTxGasUsd = r2(activeAll.reduce((s, a) => s + a.estimatedGasUsd, 0));
  const batchedGasUsd = r2(activeAll.reduce((s, a) => s + a.batchedGasUsd, 0));
  const gasSavedUsd = r2(Math.max(0, singleTxGasUsd - batchedGasUsd));
  const estimatedSlippageUsd = r2(
    activeAll.reduce((s, a) => s + (a.roiCostBreakdown?.slippageUsd ?? a.estimatedSlippageUsd ?? 0), 0)
  );
  const protocolFeeUsd = r2((Math.max(0, totalGrossUsd - estimatedSlippageUsd) * feeBps) / 10_000);
  const netSolanaUsdc = r2(
    Math.max(0, totalGrossUsd - estimatedSlippageUsd - batchedGasUsd - protocolFeeUsd)
  );

  report.totals.grossUsd = totalGrossUsd;
  report.totals.defiGrossUsd = defiGrossUsd;
  report.totals.liquidGrossUsd = liquidGrossUsd;
  report.totals.protocolFeeBps = feeBps;
  report.totals.protocolFeeUsd = protocolFeeUsd;
  report.totals.singleTxGasUsd = singleTxGasUsd;
  report.totals.batchedGasUsd = batchedGasUsd;
  report.totals.gasSavedUsd = gasSavedUsd;
  report.totals.estimatedSlippageUsd = estimatedSlippageUsd;
  report.totals.netSolanaUsdc = netSolanaUsdc;
  report.totals.solEquivalent = solPriceUsd > 0 ? r4(netSolanaUsdc / solPriceUsd) : 0;
  report.totals.defiPositionCount = report.assets.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE').length;
  report.totals.liquidDustCount = report.assets.filter(
    (a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC'
  ).length;
  report.totals.burnCandidateCount = report.assets.filter((a) => a.action === 'BURN_ZERO_LIQUIDITY').length;
  report.totals.honeypotSkippedCount = report.assets.filter((a) => a.action === 'SKIP_HONEYPOT').length;
  report.totals.gasNegativeCount = report.assets.filter(
    (a) => a.action === 'SKIP_GAS_NEGATIVE' || a.action === 'SKIP_NEGATIVE_ROI'
  ).length;

  return report;
}

/**
 * Portfolio-Level Rollup across all chains in a ScanReport.
 */
export function evaluatePortfolioRoi(
  report: ScanReport,
  opts: {
    protocolFeeBps?: number;
    gasSponsored?: boolean;
    fixedRelayerOverheadUsd?: number;
    hasSolanaUsdcAta?: boolean;
  } = {}
): PortfolioRoiReport {
  const feeCfg = getProtocolFeeConfig({ feeBps: opts.protocolFeeBps ?? report.totals.protocolFeeBps });
  const solPriceUsd = report.totals.solPriceUsd || 70;
  const solanaAtaRentUsd = estimateSolanaAtaRentUsd({
    hasUsdcAta: opts.hasSolanaUsdcAta,
    solPriceUsd,
  });

  const byChain = new Map<AnyChainId, ScannedAsset[]>();
  for (const a of report.assets) {
    const arr = byChain.get(a.chain) ?? [];
    arr.push(a);
    byChain.set(a.chain, arr);
  }

  // Pass 1: Evaluate all chains without ATA rent
  const chains: ChainBatchRoiReport[] = [];
  for (const [chain, chainAssets] of byChain.entries()) {
    const meta = report.chains.find((c) => c.chain === chain);
    chains.push(
      evaluateChainBatchRoi({
        chain,
        chainName: meta?.chainName || chainAssets[0]?.chainName || chain,
        assets: chainAssets,
        protocolFeeBps: feeCfg.feeBps,
        gasSponsored: opts.gasSponsored ?? true,
        fixedRelayerOverheadUsd: opts.fixedRelayerOverheadUsd,
        hasSolanaUsdcAta: true,
        solPriceUsd,
        gasPriceGwei: meta?.gasPriceGwei,
      })
    );
  }

  // Pass 2: Assign Solana ATA rent ONCE to the highest-net executing chain (never onto skipped chains!)
  let appliedAtaRentUsd = 0;
  if (solanaAtaRentUsd > 0) {
    const candidateIndices = chains
      .map((c, idx) => ({ c, idx }))
      .filter(({ c }) => !c.skipChainNegativeRoi && c.includedAssetIds.length > 0)
      .sort((a, b) => b.c.chainLegNetUsd - a.c.chainLegNetUsd);

    let assigned = false;
    for (const { c, idx } of candidateIndices) {
      const chainAssets = byChain.get(c.chain) ?? [];
      const meta = report.chains.find((m) => m.chain === c.chain);
      const withAta = evaluateChainBatchRoi({
        chain: c.chain,
        chainName: meta?.chainName || chainAssets[0]?.chainName || c.chain,
        assets: chainAssets,
        protocolFeeBps: feeCfg.feeBps,
        gasSponsored: opts.gasSponsored ?? true,
        fixedRelayerOverheadUsd: opts.fixedRelayerOverheadUsd,
        hasSolanaUsdcAta: false,
        solPriceUsd,
        gasPriceGwei: meta?.gasPriceGwei,
      });
      if (!withAta.skipChainNegativeRoi) {
        chains[idx] = withAta;
        appliedAtaRentUsd = withAta.solanaAtaRentUsd;
        assigned = true;
        break;
      }
    }

    if (!assigned && candidateIndices.length > 0) {
      const { c, idx } = candidateIndices[0];
      const chainAssets = byChain.get(c.chain) ?? [];
      const meta = report.chains.find((m) => m.chain === c.chain);
      const skippedWithAta = evaluateChainBatchRoi({
        chain: c.chain,
        chainName: meta?.chainName || chainAssets[0]?.chainName || c.chain,
        assets: chainAssets,
        protocolFeeBps: feeCfg.feeBps,
        gasSponsored: opts.gasSponsored ?? true,
        fixedRelayerOverheadUsd: opts.fixedRelayerOverheadUsd,
        hasSolanaUsdcAta: false,
        solPriceUsd,
        gasPriceGwei: meta?.gasPriceGwei,
      });
      chains[idx] = { ...skippedWithAta, solanaAtaRentUsd: 0 };
    }
  }

  // Sum portfolio executing totals ONLY across non-skipped executing chains
  const executingChains = chains.filter((c) => !c.skipChainNegativeRoi);
  const totalGrossUsd = r2(executingChains.reduce((s, c) => s + c.keptGrossUsd, 0));
  const totalSignedUserNetUsd = r2(executingChains.reduce((s, c) => s + c.chainLegNetUsd, 0));
  const totalProtocolFeeUsd = r2(executingChains.reduce((s, c) => s + c.protocolFeeUsd, 0));
  const totalSponsoredGasUsd = r2(executingChains.reduce((s, c) => s + c.totalGasUsd, 0));
  const totalRelayerNetMarginUsd = r2(
    executingChains.reduce((s, c) => s + c.relayerBreakEven.relayerNetMarginUsd, 0)
  );
  const totalPrunedNegativeRoiCount = chains.reduce((s, c) => s + c.prunedNegativeRoiCount, 0);
  const totalNegativeBleedPreventedUsd = r2(
    chains.reduce((s, c) => s + c.negativeBleedPreventedUsd, 0)
  );

  return {
    protocolFeeBps: feeCfg.feeBps,
    protocolFeePercent: feeCfg.feePercent,
    totalGrossUsd,
    totalSignedUserNetUsd,
    totalProtocolFeeUsd,
    totalSponsoredGasUsd,
    totalRelayerNetMarginUsd,
    totalPrunedNegativeRoiCount,
    totalNegativeBleedPreventedUsd,
    solanaAtaRentUsd: appliedAtaRentUsd,
    overallRelayerProfitable: executingChains.length > 0 && totalRelayerNetMarginUsd >= 0,
    chains,
  };
}
