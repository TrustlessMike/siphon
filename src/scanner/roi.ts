import { getProtocolFeeConfig } from './chains.js';
import type { AnyChainId, ScannedAsset, ScanReport } from './types.js';

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
  /** Signed solo net USD (can be negative — never silently clamped to 0!) */
  signedSoloNetUsd: number;
  /** Signed batched net USD (can be negative!) */
  signedBatchedNetUsd: number;
  /** Signed user net USD when relayer sponsors gas ($0 user gas) */
  signedSponsoredNetUsd: number;
  /** Signed relayer margin on this asset alone: protocolFeeUsd - incrementalGasUsd */
  relayerAssetMarginUsd: number;
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
  /** Signed: positive = relayer profits, negative = relayer loses money */
  relayerNetMarginUsd: number;
  /** Minimum gross USD sweep size required for protocol fee to cover relayer gas + overhead */
  breakEvenGrossUsd: number;
  shortfallToBreakEvenUsd: number;
  isRelayerProfitable: boolean;
  marginPercentOfGross: number;
}

export interface PrunedAssetBuckets {
  kept: ScannedAsset[];
  prunedNegativeRoi: ScannedAsset[];
  optionalBurns: ScannedAsset[];
  blockedHoneypots: ScannedAsset[];
  evaluations: AssetRoiEvaluation[];
}

export interface ChainBatchRoiReport {
  chain: AnyChainId;
  chainName: string;
  assetCount: number;
  keptCount: number;
  prunedNegativeRoiCount: number;
  optionalBurnCount: number;
  blockedHoneypotCount: number;
  unprunedGrossUsd: number;
  keptGrossUsd: number;
  /** Signed user net BEFORE pruning negative-ROI dust */
  unprunedSignedUserNetUsd: number;
  /** Signed user net AFTER pruning negative-ROI dust */
  keptSignedUserNetUsd: number;
  /** Positive USD bleed prevented by pruning negative-ROI dust */
  negativeBleedPreventedUsd: number;
  protocolFeeUsd: number;
  totalGasUsd: number;
  totalSlippageUsd: number;
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
  overallRelayerProfitable: boolean;
  chains: ChainBatchRoiReport[];
}

function r2(n: number): number {
  return Number(n.toFixed(2));
}

function fmtSigned(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  return n < 0 ? `-$${abs}` : `+$${abs}`;
}

/**
 * Level 1 — Asset-Level Signed Incremental ROI Evaluator.
 * Preserves signed negative numbers so negative-ROI dust is explicitly identified and never hidden.
 */
export function evaluateAssetRoi(
  asset: ScannedAsset,
  opts: { protocolFeeBps?: number; isBatched?: boolean; gasSponsored?: boolean } = {}
): AssetRoiEvaluation {
  const feeCfg = getProtocolFeeConfig({ feeBps: opts.protocolFeeBps });
  const isBatched = opts.isBatched ?? true;
  const grossUsd = r2(asset.grossUsd);
  const soloGasUsd = r2(asset.estimatedGasUsd);
  const batchedGasUsd = r2(asset.batchedGasUsd);
  const slippageUsd = r2(asset.estimatedSlippageUsd);
  const incrementalGasUsd = isBatched ? batchedGasUsd : soloGasUsd;

  if (asset.action === 'SKIP_HONEYPOT' || !asset.honeypotSafe) {
    return {
      assetId: asset.id,
      symbol: asset.symbol,
      chain: asset.chain,
      grossUsd,
      protocolFeeUsd: 0,
      slippageUsd,
      soloGasUsd,
      batchedGasUsd,
      signedSoloNetUsd: r2(-soloGasUsd),
      signedBatchedNetUsd: r2(-batchedGasUsd),
      signedSponsoredNetUsd: 0,
      relayerAssetMarginUsd: r2(-incrementalGasUsd),
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
      signedSoloNetUsd: r2(-soloGasUsd),
      signedBatchedNetUsd: r2(-batchedGasUsd),
      signedSponsoredNetUsd: 0,
      relayerAssetMarginUsd: r2(-incrementalGasUsd),
      verdict: 'zero_liquidity_burn',
      shouldIncludeByDefault: false,
      reason: `Zero-liquidity burn is strictly negative ROI (${fmtSigned(-batchedGasUsd)} gas) — opt-in only.`,
    };
  }

  const protocolFeeUsd = r2((grossUsd * feeCfg.feeBps) / 10_000);
  const signedSoloNetUsd = r2(grossUsd - protocolFeeUsd - slippageUsd - soloGasUsd);
  const signedBatchedNetUsd = r2(grossUsd - protocolFeeUsd - slippageUsd - batchedGasUsd);
  const signedSponsoredNetUsd = r2(grossUsd - protocolFeeUsd - slippageUsd);
  const relayerAssetMarginUsd = r2(protocolFeeUsd - incrementalGasUsd);

  let verdict: AssetRoiVerdict;
  let shouldIncludeByDefault = false;
  let reason: string;

  if (signedSoloNetUsd > 0) {
    verdict = 'profitable';
    shouldIncludeByDefault = true;
    reason = `Profitable solo (${fmtSigned(signedSoloNetUsd)}) and batched (${fmtSigned(signedBatchedNetUsd)}).`;
  } else if (signedBatchedNetUsd > 0) {
    verdict = 'profitable_batched_only';
    shouldIncludeByDefault = true;
    reason = `Negative solo (${fmtSigned(signedSoloNetUsd)}) but positive when batched (${fmtSigned(signedBatchedNetUsd)}).`;
  } else {
    verdict = 'negative_roi_skip';
    shouldIncludeByDefault = false;
    reason = `Negative ROI even when batched (${fmtSigned(signedBatchedNetUsd)} net vs $${batchedGasUsd.toFixed(2)} gas) — pruned.`;
  }

  return {
    assetId: asset.id,
    symbol: asset.symbol,
    chain: asset.chain,
    grossUsd,
    protocolFeeUsd,
    slippageUsd,
    soloGasUsd,
    batchedGasUsd,
    signedSoloNetUsd,
    signedBatchedNetUsd,
    signedSponsoredNetUsd,
    relayerAssetMarginUsd,
    verdict,
    shouldIncludeByDefault,
    reason,
  };
}

/**
 * Exact Relayer Break-Even Math:
 * Determines whether Siphon's 5–10% protocol fee covers the sponsored gas + relayer overhead,
 * and computes the exact gross USD threshold required to break even.
 */
export function computeRelayerBreakEven(params: {
  sponsoredGasUsd: number;
  protocolFeeBps?: number;
  grossUsd: number;
  fixedRelayerOverheadUsd?: number;
}): RelayerBreakEvenResult {
  const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
  const rate = feeCfg.feeBps / 10_000;
  const fixedRelayerOverheadUsd = r2(params.fixedRelayerOverheadUsd ?? 0.02);
  const sponsoredGasUsd = r2(Math.max(0, params.sponsoredGasUsd));
  const effectiveRelayerCostUsd = r2(sponsoredGasUsd + fixedRelayerOverheadUsd);
  const grossUsd = r2(Math.max(0, params.grossUsd));
  const protocolFeeUsd = r2(grossUsd * rate);
  const relayerNetMarginUsd = r2(protocolFeeUsd - effectiveRelayerCostUsd);
  const breakEvenGrossUsd = rate > 0 ? r2(effectiveRelayerCostUsd / rate) : Infinity;
  const shortfallToBreakEvenUsd = r2(Math.max(0, breakEvenGrossUsd - grossUsd));
  const isRelayerProfitable = relayerNetMarginUsd >= 0;
  const marginPercentOfGross = grossUsd > 0 ? r2((relayerNetMarginUsd / grossUsd) * 100) : -100;

  return {
    protocolFeeBps: feeCfg.feeBps,
    protocolFeePercent: feeCfg.feePercent,
    grossUsd,
    protocolFeeUsd,
    sponsoredGasUsd,
    fixedRelayerOverheadUsd,
    effectiveRelayerCostUsd,
    relayerNetMarginUsd,
    breakEvenGrossUsd,
    shortfallToBreakEvenUsd,
    isRelayerProfitable,
    marginPercentOfGross,
  };
}

/**
 * Separates positive incremental ROI assets from negative-ROI dust, opt-in burns, and blocked honeypots
 * so bad dust can never drag down a profitable chain bundle.
 */
export function pruneNegativeRoiAssets(
  assets: ScannedAsset[],
  opts: { protocolFeeBps?: number; isBatched?: boolean } = {}
): PrunedAssetBuckets {
  const kept: ScannedAsset[] = [];
  const prunedNegativeRoi: ScannedAsset[] = [];
  const optionalBurns: ScannedAsset[] = [];
  const blockedHoneypots: ScannedAsset[] = [];
  const evaluations: AssetRoiEvaluation[] = [];

  for (const a of assets) {
    const ev = evaluateAssetRoi(a, opts);
    evaluations.push(ev);
    if (ev.verdict === 'honeypot_blocked') blockedHoneypots.push(a);
    else if (ev.verdict === 'zero_liquidity_burn') optionalBurns.push(a);
    else if (ev.verdict === 'negative_roi_skip') prunedNegativeRoi.push(a);
    else kept.push(a);
  }

  return { kept, prunedNegativeRoi, optionalBurns, blockedHoneypots, evaluations };
}

/**
 * Level 2 — Chain-Level Batch Economics + Relayer Break-Even Analysis.
 */
export function evaluateChainBatchRoi(params: {
  chain: AnyChainId;
  chainName?: string;
  assets: ScannedAsset[];
  protocolFeeBps?: number;
  gasSponsored?: boolean;
  fixedRelayerOverheadUsd?: number;
}): ChainBatchRoiReport {
  const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
  const gasSponsored = params.gasSponsored ?? true;
  const buckets = pruneNegativeRoiAssets(params.assets, {
    protocolFeeBps: feeCfg.feeBps,
    isBatched: true,
  });

  const sweepableAll = [...buckets.kept, ...buckets.prunedNegativeRoi];
  const unprunedGrossUsd = r2(sweepableAll.reduce((s, a) => s + a.grossUsd, 0));
  const keptGrossUsd = r2(buckets.kept.reduce((s, a) => s + a.grossUsd, 0));

  const unprunedEvals = buckets.evaluations.filter(
    (e) => e.verdict !== 'honeypot_blocked' && e.verdict !== 'zero_liquidity_burn'
  );
  const keptEvals = buckets.evaluations.filter(
    (e) => e.verdict === 'profitable' || e.verdict === 'profitable_batched_only'
  );

  const unprunedSignedUserNetUsd = r2(
    unprunedEvals.reduce((s, e) => s + e.signedBatchedNetUsd, 0)
  );
  const keptSignedUserNetUsd = r2(
    keptEvals.reduce((s, e) => s + (gasSponsored ? e.signedSponsoredNetUsd : e.signedBatchedNetUsd), 0)
  );
  const keptBatchedUserNetUsd = r2(keptEvals.reduce((s, e) => s + e.signedBatchedNetUsd, 0));
  const negativeBleedPreventedUsd = r2(
    Math.max(0, keptBatchedUserNetUsd - unprunedSignedUserNetUsd)
  );

  const totalGasUsd = r2(keptEvals.reduce((s, e) => s + e.batchedGasUsd, 0));
  const totalSlippageUsd = r2(keptEvals.reduce((s, e) => s + e.slippageUsd, 0));
  const protocolFeeUsd = r2((keptGrossUsd * feeCfg.feeBps) / 10_000);

  const relayerBreakEven = computeRelayerBreakEven({
    sponsoredGasUsd: totalGasUsd,
    protocolFeeBps: feeCfg.feeBps,
    grossUsd: keptGrossUsd,
    fixedRelayerOverheadUsd: params.fixedRelayerOverheadUsd,
  });

  let recommendedExecution: ChainBatchRoiReport['recommendedExecution'];
  if (buckets.kept.length === 0 || keptBatchedUserNetUsd <= 0) {
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
  if (buckets.kept.length > 0 && !relayerBreakEven.isRelayerProfitable) {
    warnings.push(
      `Below relayer break-even ($${relayerBreakEven.breakEvenGrossUsd.toFixed(2)} gross needed at ${feeCfg.feePercent}% fee to cover $${relayerBreakEven.effectiveRelayerCostUsd.toFixed(2)} sponsored gas; shortfall $${relayerBreakEven.shortfallToBreakEvenUsd.toFixed(2)}).`
    );
  }

  return {
    chain: params.chain,
    chainName: params.chainName || params.assets[0]?.chainName || params.chain,
    assetCount: params.assets.length,
    keptCount: buckets.kept.length,
    prunedNegativeRoiCount: buckets.prunedNegativeRoi.length,
    optionalBurnCount: buckets.optionalBurns.length,
    blockedHoneypotCount: buckets.blockedHoneypots.length,
    unprunedGrossUsd,
    keptGrossUsd,
    unprunedSignedUserNetUsd,
    keptSignedUserNetUsd,
    negativeBleedPreventedUsd,
    protocolFeeUsd,
    totalGasUsd,
    totalSlippageUsd,
    relayerBreakEven,
    recommendedExecution,
    warnings,
    evaluations: buckets.evaluations,
  };
}

/**
 * Portfolio-Level Rollup across all chains in a ScanReport.
 */
export function evaluatePortfolioRoi(
  report: ScanReport,
  opts: { protocolFeeBps?: number; gasSponsored?: boolean; fixedRelayerOverheadUsd?: number } = {}
): PortfolioRoiReport {
  const feeCfg = getProtocolFeeConfig({ feeBps: opts.protocolFeeBps ?? report.totals.protocolFeeBps });
  const byChain = new Map<AnyChainId, ScannedAsset[]>();
  for (const a of report.assets) {
    const arr = byChain.get(a.chain) ?? [];
    arr.push(a);
    byChain.set(a.chain, arr);
  }

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
      })
    );
  }

  const totalGrossUsd = r2(chains.reduce((s, c) => s + c.keptGrossUsd, 0));
  const totalSignedUserNetUsd = r2(chains.reduce((s, c) => s + c.keptSignedUserNetUsd, 0));
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
    overallRelayerProfitable: totalRelayerNetMarginUsd >= 0,
    chains,
  };
}
