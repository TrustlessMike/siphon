import { getProtocolFeeConfig } from './chains.js';
import type {
  AnyChainId,
  ChainFamily,
  ChainRouteStrategy,
  RoiCostBreakdown,
  RoiVerdict,
  ScannedAsset,
  ScanReport,
} from './types.js';

/**
 * Case-aware wallet key normalization for `(sourceWallet, chain)` batch grouping.
 * Only lowercases case-insensitive hex (`0x...`, `.eth`) and Bech32 (`cosmos1...`, `bc1...`)
 * addresses while preserving exact case for Base58 (Tron, BTC legacy, Solana) and Base64url (TON).
 */
export function normalizeBatchWalletKey(rawWallet?: string | null, family?: ChainFamily): string {
  const clean = (rawWallet || '').trim();
  if (!clean) return 'default';
  if (
    family === 'evm' ||
    family === 'cosmos' ||
    /^0x[0-9a-fA-F]+$/.test(clean) ||
    clean.toLowerCase().endsWith('.eth') ||
    /^(bc1|tb1)[0-9a-zA-Z]+$/i.test(clean)
  ) {
    return clean.toLowerCase();
  }
  return clean;
}

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
  sourceWallet?: string;
  sourceWalletLabel?: string;
  assetCount: number;
  keptCount: number;
  lowEfficiencyCount: number;
  prunedNegativeRoiCount: number;
  optionalBurnCount: number;
  blockedHoneypotCount: number;
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

function r2(n: number): number {
  return Number(n.toFixed(2));
}

function r4(n: number): number {
  return Number(n.toFixed(4));
}

function fmtSigned(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  return n < 0 ? `-$${abs}` : `+$${abs}`;
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
 */
export function evaluateLiveQuoteHaircut(params: {
  grossUsd: number;
  quoteOutUsd: number;
  actualGasUsd: number;
  allowHighCost?: boolean;
  maxHaircutPct?: number;
}): LiveQuoteHaircutResult {
  const grossUsd = r2(Math.max(0, params.grossUsd));
  const quoteOutUsd = r2(Math.max(0, params.quoteOutUsd));
  const actualGasUsd = r2(Math.max(0, params.actualGasUsd));
  const capPct = params.maxHaircutPct ?? DEFAULT_LIVE_QUOTE_HAIRCUT_CAP_PCT;
  const liveNetUsd = r2(quoteOutUsd - actualGasUsd);
  const liveHaircutPct = grossUsd > 0 ? r2((1 - liveNetUsd / grossUsd) * 100) : 100;

  if (liveNetUsd <= 0) {
    return {
      passed: false,
      grossUsd,
      quoteOutUsd,
      actualGasUsd,
      liveNetUsd,
      liveHaircutPct,
      capPct,
      overridden: false,
      reason: `Dropped by Live Quote Haircut Gate: quoted net output is negative (${fmtSigned(liveNetUsd)} on $${grossUsd.toFixed(2)} gross).`,
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
  const grossUsd = r2(asset.grossUsd);
  const soloGasUsd = r4(asset.estimatedGasUsd);
  const batchedGasUsd = r4(asset.batchedGasUsd);
  const l1DataFeeUsd = estimateL1DataFeeUsd(asset.chain, isBatched);
  const isDirectUsdc =
    asset.action === 'BRIDGE_DIRECT_USDC' ||
    (asset.symbol === 'USDC' && asset.kind === 'erc20');

  // Use the greater of explicit asset slippage or liquidity-depth-scaled price impact
  const scaledSlippage = estimateLiquidityScaledSlippageUsd({
    grossUsd,
    liquidityUsd: asset.liquidityUsd,
    isDirectUsdc,
    isDead: asset.kind === 'dead_token' || asset.action === 'BURN_ZERO_LIQUIDITY',
  });
  const slippageUsd = r2(Math.max(asset.estimatedSlippageUsd || 0, scaledSlippage));
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
      signedSoloNetUsd: r2(-soloGasUsd),
      signedBatchedNetUsd: r2(-batchedGasUsd),
      netRoiUsd: r2(-incrementalGasUsd),
      effectiveCostPct: 100,
      roiVerdict: 'negative_roi',
      signedSponsoredNetUsd: 0,
      relayerAssetMarginUsd: r2(-incrementalGasUsd),
      costBreakdown: {
        gasUsd: r2(incrementalGasUsd),
        l1DataFeeUsd: r2(l1DataFeeUsd),
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
      signedSoloNetUsd: r2(-soloGasUsd),
      signedBatchedNetUsd: r2(-batchedGasUsd),
      netRoiUsd: r2(-incrementalGasUsd),
      effectiveCostPct: 100,
      roiVerdict: 'negative_roi',
      signedSponsoredNetUsd: 0,
      relayerAssetMarginUsd: r2(-incrementalGasUsd),
      costBreakdown: {
        gasUsd: r2(incrementalGasUsd),
        l1DataFeeUsd: r2(l1DataFeeUsd),
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

  // Chain-specific sub-fee dust guard (e.g., BTC dust UTXO already flagged SKIP_GAS_NEGATIVE)
  const protocolFeeUsd = r2((Math.max(0, grossUsd - slippageUsd) * feeCfg.feeBps) / 10_000);
  const bridgeShareUsd = opts.includeSingleBridgeShare
    ? r2(estimateBridgeFixedFeeUsd(asset.chain) / Math.max(1, opts.chainAssetCount ?? 1))
    : 0;
  const ataShareUsd = r2(opts.solanaAtaRentUsd ?? 0);

  const soloTotalCostUsd = r2(soloGasUsd + l1DataFeeUsd + slippageUsd + protocolFeeUsd + bridgeShareUsd + ataShareUsd);
  const batchedTotalCostUsd = r2(batchedGasUsd + l1DataFeeUsd + slippageUsd + protocolFeeUsd + bridgeShareUsd + ataShareUsd);
  const signedSoloNetUsd = r2(grossUsd - soloTotalCostUsd);
  const signedBatchedNetUsd = r2(grossUsd - batchedTotalCostUsd);
  const netRoiUsd = isBatched ? signedBatchedNetUsd : signedSoloNetUsd;
  const totalCostUsd = isBatched ? batchedTotalCostUsd : soloTotalCostUsd;
  const effectiveCostPct = grossUsd > 0 ? r2((totalCostUsd / grossUsd) * 100) : 100;

  // Respect explicit BTC/chain sub-fee dust flags
  let roiVerdict = classifyRoiVerdict(netRoiUsd, effectiveCostPct);
  if (asset.action === 'SKIP_GAS_NEGATIVE' && asset.chain === 'btc' && asset.address.startsWith('dust:')) {
    roiVerdict = 'negative_roi';
  }

  const signedSponsoredNetUsd = r2(grossUsd - protocolFeeUsd - slippageUsd - bridgeShareUsd - ataShareUsd);
  const relayerAssetMarginUsd = r2(protocolFeeUsd - incrementalGasUsd);

  let verdict: AssetRoiVerdict;
  if (roiVerdict === 'negative_roi') {
    verdict = 'negative_roi_skip';
  } else if (signedSoloNetUsd > WORTH_IT_MIN_NET_USD) {
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
      l1DataFeeUsd: r2(l1DataFeeUsd),
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
 * Enforces `protocolFeeUsd + maxGasReimbursementUsd >= sponsoredGasUsd * 1.5` (or fixed overhead)
 * so Siphon's relayer never burns funds sponsoring unprofitable dust sweeps.
 */
export function computeRelayerBreakEven(params: {
  sponsoredGasUsd: number;
  protocolFeeBps?: number;
  grossUsd: number;
  maxGasReimbursementUsd?: number;
  fixedRelayerOverheadUsd?: number;
}): RelayerBreakEvenResult {
  const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
  const rate = feeCfg.feeBps / 10_000;
  const fixedRelayerOverheadUsd = r2(params.fixedRelayerOverheadUsd ?? 0.02);
  const sponsoredGasUsd = r2(Math.max(0, params.sponsoredGasUsd));
  const effectiveRelayerCostUsd = r2(sponsoredGasUsd + fixedRelayerOverheadUsd);
  const requiredRelayerCoverageUsd = r2(
    Math.max(effectiveRelayerCostUsd, sponsoredGasUsd * RELAYER_BREAK_EVEN_MULTIPLIER)
  );
  const grossUsd = r2(Math.max(0, params.grossUsd));
  const protocolFeeUsd = r2(grossUsd * rate);
  const reimbursement = r2(Math.max(0, params.maxGasReimbursementUsd ?? 0));
  const totalRelayerRevenueUsd = r2(protocolFeeUsd + reimbursement);

  const relayerNetMarginUsd = r2(protocolFeeUsd - effectiveRelayerCostUsd);
  const breakEvenGrossUsd = rate > 0 ? r2(effectiveRelayerCostUsd / rate) : Infinity;
  const shortfallToBreakEvenUsd = r2(Math.max(0, breakEvenGrossUsd - grossUsd));

  // If maxGasReimbursementUsd is explicitly supplied (gasless sponsorship check), require 1.5x coverage!
  const isRelayerProfitable =
    params.maxGasReimbursementUsd !== undefined
      ? totalRelayerRevenueUsd >= requiredRelayerCoverageUsd && grossUsd > sponsoredGasUsd + protocolFeeUsd
      : relayerNetMarginUsd >= 0;

  const marginPercentOfGross = grossUsd > 0 ? r2((relayerNetMarginUsd / grossUsd) * 100) : -100;
  const rejectionReason = !isRelayerProfitable
    ? `Below gasless sponsorship break-even: expected fee + reimbursement ($${totalRelayerRevenueUsd.toFixed(2)}) is below 1.5x sponsored gas ($${requiredRelayerCoverageUsd.toFixed(2)}). Need ≥ $${breakEvenGrossUsd.toFixed(2)} gross on this chain.`
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
    params.evaluations.reduce((s, e) => s + e.soloGasUsd + e.l1DataFeeUsd, 0)
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
  sourceWallet?: string;
  sourceWalletLabel?: string;
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

  // Positive-marginal assets eligible for the chain leg (worth_it + low_efficiency if combined batch rescues them)
  const sweepableAll = [...buckets.kept, ...buckets.lowEfficiency, ...buckets.prunedNegativeRoi];
  // If individual tokens were low_efficiency solely because of solo overhead, test combining worth_it + low_efficiency in Level 2 batch!
  const legCandidates = buckets.kept.length > 0 ? buckets.kept : buckets.lowEfficiency;

  const unprunedGrossUsd = r2(sweepableAll.reduce((s, a) => s + a.grossUsd, 0));
  const keptGrossUsd = r2(legCandidates.reduce((s, a) => s + a.grossUsd, 0));

  const unprunedEvals = buckets.evaluations.filter(
    (e) => e.verdict !== 'honeypot_blocked' && e.verdict !== 'zero_liquidity_burn'
  );
  const candidateIds = new Set(legCandidates.map((a) => a.id));
  const keptEvals = buckets.evaluations.filter((e) => candidateIds.has(e.assetId));

  const unprunedSignedUserNetUsd = r2(
    unprunedEvals.reduce((s, e) => s + e.signedBatchedNetUsd, 0)
  );
  const keptSignedUserNetUsd = r2(
    keptEvals.reduce((s, e) => s + (gasSponsored ? e.signedSponsoredNetUsd : e.signedBatchedNetUsd), 0)
  );
  const keptBatchedUserNetUsd = r2(keptEvals.reduce((s, e) => s + e.signedBatchedNetUsd, 0));
  const prunedNegativeIds = new Set(buckets.prunedNegativeRoi.map((a) => a.id));
  const negativeBleedPreventedUsd = r2(
    buckets.evaluations
      .filter((e) => prunedNegativeIds.has(e.assetId))
      .reduce((s, e) => s + Math.max(0, -e.signedBatchedNetUsd), 0)
  );

  const totalGasUsd = r2(keptEvals.reduce((s, e) => s + e.batchedGasUsd + e.l1DataFeeUsd, 0));
  const totalSlippageUsd = r2(keptEvals.reduce((s, e) => s + e.slippageUsd, 0));
  const protocolFeeUsd = r2((Math.max(0, keptGrossUsd - totalSlippageUsd) * feeCfg.feeBps) / 10_000);

  const routeComparison = compareChainRouteStrategies({
    chain: params.chain,
    assets: legCandidates,
    evaluations: keptEvals,
    protocolFeeUsd,
    solanaAtaRentUsd,
  });

  const bestChainLegNetUsd =
    legCandidates.length === 0
      ? r2(-(estimateBridgeFixedFeeUsd(params.chain) + solanaAtaRentUsd))
      : Math.max(
          routeComparison.localBatchSingleBridgeNetUsd,
          routeComparison.directPerTokenBridgeNetUsd
        );
  const bridgeFixedFeeUsd =
    routeComparison.recommendedStrategy === 'local_batch_single_bridge'
      ? routeComparison.singleBridgeFixedFeeUsd
      : routeComparison.perTokenBridgeTotalFeeUsd;

  const totalLegCostUsd = r2(keptGrossUsd - bestChainLegNetUsd);
  const chainLegCostPct = keptGrossUsd > 0 ? r2((totalLegCostUsd / keptGrossUsd) * 100) : 100;
  const roiVerdict =
    legCandidates.length === 0
      ? 'negative_roi'
      : classifyRoiVerdict(bestChainLegNetUsd, chainLegCostPct);
  const skipChainNegativeRoi = roiVerdict === 'negative_roi';

  let breakEvenHint: string | undefined;
  if (skipChainNegativeRoi) {
    const fixedCosts = totalGasUsd + bridgeFixedFeeUsd + solanaAtaRentUsd + 0.35;
    const neededGross = r2(fixedCosts / Math.max(0.15, 0.35 - feeCfg.feeBps / 10_000));
    if (params.gasPriceGwei && params.gasPriceGwei > 1 && totalGasUsd > 0.5) {
      const targetGwei = Math.max(0.5, Number((params.gasPriceGwei * 0.35).toFixed(1)));
      breakEvenHint = `Becomes profitable below ${targetGwei} gwei or when chain balance > $${neededGross.toFixed(2)}.`;
    } else {
      breakEvenHint = `Becomes profitable when chain balance > $${neededGross.toFixed(2)} (fixed costs ~$${r2(totalGasUsd + bridgeFixedFeeUsd + solanaAtaRentUsd).toFixed(2)}).`;
    }
  }

  const relayerBreakEven = computeRelayerBreakEven({
    sponsoredGasUsd: totalGasUsd,
    protocolFeeBps: feeCfg.feeBps,
    grossUsd: keptGrossUsd,
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
      `Below relayer break-even ($${relayerBreakEven.breakEvenGrossUsd.toFixed(2)} gross needed at ${feeCfg.feePercent}% fee to cover $${relayerBreakEven.effectiveRelayerCostUsd.toFixed(2)} sponsored gas; shortfall $${relayerBreakEven.shortfallToBreakEvenUsd.toFixed(2)}).`
    );
  }

  return {
    chain: params.chain,
    chainName: params.chainName || params.assets[0]?.chainName || params.chain,
    sourceWallet: params.sourceWallet ?? params.assets[0]?.sourceWallet,
    sourceWalletLabel: params.sourceWalletLabel ?? params.assets[0]?.sourceWalletLabel,
    assetCount: params.assets.length,
    keptCount: buckets.kept.length,
    lowEfficiencyCount: buckets.lowEfficiency.length,
    prunedNegativeRoiCount: buckets.prunedNegativeRoi.length,
    optionalBurnCount: buckets.optionalBurns.length,
    blockedHoneypotCount: buckets.blockedHoneypots.length,
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

  let ataApplied = false;

  for (const chainSummary of report.chains) {
    const chainAssets = byChain.get(chainSummary.chain) ?? [];
    if (!chainAssets.length) continue;

    // Sub-group by sourceWallet so distinct EOAs on the same chain are NEVER merged into 1 atomic batch!
    const byWallet = new Map<string, { sourceWallet?: string; sourceWalletLabel?: string; assets: ScannedAsset[] }>();
    for (const a of chainAssets) {
      const rawWallet = a.sourceWallet || report.walletAddress;
      const wKey = normalizeBatchWalletKey(rawWallet, a.family);
      const group = byWallet.get(wKey);
      if (group) {
        group.assets.push(a);
      } else {
        byWallet.set(wKey, {
          sourceWallet: a.sourceWallet || (report.walletAddress && !report.walletAddress.includes(',') ? report.walletAddress : undefined),
          sourceWalletLabel: a.sourceWalletLabel || report.walletLabel,
          assets: [a],
        });
      }
    }

    const walletBatchReports: ChainBatchRoiReport[] = [];

    for (const wGroup of byWallet.values()) {
      // Count Solana ATA rent ONCE across the entire multi-chain/multi-wallet sweep (on first profitable batch)
      const batchHasAtaRent = !ataApplied && ataRentTotal > 0;
      const batchRoi = evaluateChainBatchRoi({
        chain: chainSummary.chain,
        chainName: chainSummary.chainName,
        sourceWallet: wGroup.sourceWallet,
        sourceWalletLabel: wGroup.sourceWalletLabel,
        assets: wGroup.assets,
        protocolFeeBps: feeBps,
        gasSponsored: chainSummary.needsGasSponsorship,
        hasSolanaUsdcAta: batchHasAtaRent ? false : true,
        solPriceUsd,
        gasPriceGwei: chainSummary.gasPriceGwei,
      });
      if (batchHasAtaRent && !batchRoi.skipChainNegativeRoi) {
        ataApplied = true;
      }
      walletBatchReports.push(batchRoi);

      const evalMap = new Map(batchRoi.evaluations.map((e) => [e.assetId, e]));
      for (const a of wGroup.assets) {
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

        if (ev.roiVerdict === 'negative_roi') {
          a.action = 'SKIP_GAS_NEGATIVE';
          a.selectedByDefault = false;
          if (!a.actionReason.toLowerCase().includes('skipped')) {
            a.actionReason = ev.reason;
          }
        } else if (ev.roiVerdict === 'low_efficiency') {
          // Low efficiency (35%-65% fees): keep sweepable action so user can opt in, unchecked by default!
          a.selectedByDefault = false;
          a.actionReason = `${ev.reason} (${a.actionReason})`;
        } else {
          // Worth it: selected by default unless THIS wallet's chain batch is negative ROI
          a.selectedByDefault = !batchRoi.skipChainNegativeRoi;
        }
      }
    }

    if (walletBatchReports.length === 1) {
      const chainRoi = walletBatchReports[0];
      chainSummary.chainLegNetUsd = chainRoi.chainLegNetUsd;
      chainSummary.chainLegCostPct = chainRoi.chainLegCostPct;
      chainSummary.roiVerdict = chainRoi.roiVerdict;
      chainSummary.skipChainNegativeRoi = chainRoi.skipChainNegativeRoi;
      chainSummary.routeStrategy = chainRoi.routeComparison.recommendedStrategy;
      chainSummary.breakEvenHint = chainRoi.breakEvenHint;
      chainSummary.solanaAtaRentUsd = chainRoi.solanaAtaRentUsd;
    } else {
      const sumNetUsd = r2(walletBatchReports.reduce((s, r) => s + r.chainLegNetUsd, 0));
      const sumKeptGross = r2(walletBatchReports.reduce((s, r) => s + r.keptGrossUsd, 0));
      const aggCostPct = sumKeptGross > 0 ? r2(((sumKeptGross - sumNetUsd) / sumKeptGross) * 100) : 100;
      const allSkipped = walletBatchReports.every((r) => r.skipChainNegativeRoi);
      chainSummary.chainLegNetUsd = sumNetUsd;
      chainSummary.chainLegCostPct = aggCostPct;
      chainSummary.roiVerdict = allSkipped ? 'negative_roi' : classifyRoiVerdict(sumNetUsd, aggCostPct);
      chainSummary.skipChainNegativeRoi = allSkipped;
      chainSummary.routeStrategy = walletBatchReports.some(
        (r) => r.routeComparison.recommendedStrategy === 'local_batch_single_bridge'
      )
        ? 'local_batch_single_bridge'
        : 'direct_per_token_bridge';
      chainSummary.breakEvenHint = walletBatchReports.find((r) => r.breakEvenHint)?.breakEvenHint;
      chainSummary.solanaAtaRentUsd = r2(walletBatchReports.reduce((s, r) => s + r.solanaAtaRentUsd, 0));
    }

    chainSummary.skippedCount = chainAssets.filter(
      (a) =>
        a.action === 'SKIP_HONEYPOT' ||
        a.action === 'SKIP_GAS_NEGATIVE' ||
        a.action === 'SKIP_NEGATIVE_ROI'
    ).length;
  }

  report.totals.gasNegativeCount = report.assets.filter(
    (a) => a.action === 'SKIP_GAS_NEGATIVE' || a.action === 'SKIP_NEGATIVE_ROI'
  ).length;

  return report;
}

/**
 * Portfolio-Level Rollup across all `(sourceWallet, chain)` batches in a ScanReport.
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

  // Group strictly by (sourceWallet, chain) so distinct EOAs on the same chain are modeled separately
  const byWalletAndChain = new Map<
    string,
    { chain: AnyChainId; sourceWallet?: string; sourceWalletLabel?: string; assets: ScannedAsset[] }
  >();
  for (const a of report.assets) {
    const rawWallet = a.sourceWallet || report.walletAddress;
    const wKey = normalizeBatchWalletKey(rawWallet, a.family);
    const key = `${wKey}::${a.chain}`;
    const existing = byWalletAndChain.get(key);
    if (existing) {
      existing.assets.push(a);
    } else {
      byWalletAndChain.set(key, {
        chain: a.chain,
        sourceWallet: a.sourceWallet || (report.walletAddress && !report.walletAddress.includes(',') ? report.walletAddress : undefined),
        sourceWalletLabel: a.sourceWalletLabel || report.walletLabel,
        assets: [a],
      });
    }
  }

  const chains: ChainBatchRoiReport[] = [];
  let ataAssigned = false;
  for (const group of byWalletAndChain.values()) {
    const meta = report.chains.find((c) => c.chain === group.chain);
    const applyAtaHere = !ataAssigned && solanaAtaRentUsd > 0;
    const chainRoi = evaluateChainBatchRoi({
      chain: group.chain,
      chainName: meta?.chainName || group.assets[0]?.chainName || group.chain,
      sourceWallet: group.sourceWallet,
      sourceWalletLabel: group.sourceWalletLabel,
      assets: group.assets,
      protocolFeeBps: feeCfg.feeBps,
      gasSponsored: opts.gasSponsored ?? true,
      fixedRelayerOverheadUsd: opts.fixedRelayerOverheadUsd,
      hasSolanaUsdcAta: applyAtaHere ? false : true,
      solPriceUsd,
      gasPriceGwei: meta?.gasPriceGwei,
    });
    if (applyAtaHere) ataAssigned = true;
    chains.push(chainRoi);
  }

  const totalGrossUsd = r2(chains.reduce((s, c) => s + c.keptGrossUsd, 0));
  const totalSignedUserNetUsd = r2(chains.reduce((s, c) => s + c.chainLegNetUsd, 0));
  const totalProtocolFeeUsd = r2(chains.reduce((s, c) => s + c.protocolFeeUsd, 0));
  const totalSponsoredGasUsd = r2(chains.reduce((s, c) => s + c.totalGasUsd, 0));
  const totalRelayerNetMarginUsd = r2(
    chains.reduce((s, c) => s + c.relayerBreakEven.relayerNetMarginUsd, 0)
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
    solanaAtaRentUsd,
    overallRelayerProfitable: totalRelayerNetMarginUsd >= 0,
    chains,
  };
}
