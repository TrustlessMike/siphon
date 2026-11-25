import { resolveProtocolFeeBps } from './chains.js';
import { evaluateAssetRoi, evaluateChainBatchRoi } from './roi.js';
import type { AnyChainId, ScannedAsset, ScanReport } from './types.js';

export interface DustChainPlan {
  chain: AnyChainId;
  chainName: string;
  dustTokenCount: number;
  rescuedByBatchCount: number;
  directProfitableCount: number;
  unprofitableSkippedCount: number;
  grossDustUsd: number;
  soloTotalNetUsd: number;
  batchedConversionNetUsd: number;
  batchRescueGainUsd: number;
  recommendedRoute: 'local_batch_single_bridge' | 'direct_per_token_bridge' | 'skip_negative_roi';
  convertibleAssetIds: string[];
  skippedAssetIds: string[];
  breakEvenHint?: string;
}

export interface DustConversionPlan {
  maxDustThresholdUsd: number;
  protocolFeeBps: number;
  totalDustAssetsFound: number;
  convertibleCount: number;
  rescuedByBatchCount: number;
  skippedUnprofitableCount: number;
  grossConvertibleDustUsd: number;
  estimatedNetSolanaUsdc: number;
  totalBatchRescueGainUsd: number;
  convertibleAssetIds: string[];
  chains: DustChainPlan[];
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

/**
 * Dedicated Dust Conversion & Batch Rescue planner.
 * Identifies all small balances (`0 < grossUsd <= maxDustThresholdUsd`), separates
 * batch-rescuable dust from permanently negative-ROI sub-fee dust, and computes exact
 * savings from converting dust locally into USDC before a single cross-chain bridge.
 */
export function planDustConversion(params: {
  scan: ScanReport;
  maxDustThresholdUsd?: number;
  protocolFeeBps?: number;
  hasSolanaUsdcAta?: boolean;
}): DustConversionPlan {
  const maxDustThresholdUsd = Math.max(1, Math.min(250, Number(params.maxDustThresholdUsd ?? 25)));
  const protocolFeeBps = resolveProtocolFeeBps(params.protocolFeeBps);

  const dustCandidates = params.scan.assets.filter(
    (a) =>
      a.grossUsd > 0 &&
      a.grossUsd <= maxDustThresholdUsd &&
      a.action !== 'SKIP_HONEYPOT' &&
      a.action !== 'BURN_ZERO_LIQUIDITY' &&
      a.kind !== 'defi_position'
  );

  const byChain = new Map<AnyChainId, ScannedAsset[]>();
  for (const asset of dustCandidates) {
    const arr = byChain.get(asset.chain) ?? [];
    arr.push(asset);
    byChain.set(asset.chain, arr);
  }

  const chains: DustChainPlan[] = [];
  const allConvertibleIds: string[] = [];

  for (const [chain, items] of byChain.entries()) {
    const chainMeta = params.scan.chains.find((c) => c.chain === chain);
    const evals = items.map((asset) => ({
      asset,
      roi: evaluateAssetRoi(asset, { protocolFeeBps }),
    }));

    const convertible = evals.filter(
      (e) => e.roi.signedBatchedNetUsd > 0.05 && e.roi.effectiveCostPct < 65
    );
    const rescuedByBatch = convertible.filter((e) => e.roi.signedSoloNetUsd <= 0);
    const directProfitable = convertible.filter((e) => e.roi.signedSoloNetUsd > 0);
    const skipped = evals.filter(
      (e) => !(e.roi.signedBatchedNetUsd > 0.05 && e.roi.effectiveCostPct < 65)
    );

    const batchRoi = evaluateChainBatchRoi({
      chain,
      assets: convertible.map((c) => c.asset),
      protocolFeeBps,
      gasSponsored: true,
      hasSolanaUsdcAta: params.hasSolanaUsdcAta ?? true,
      gasPriceGwei: chainMeta?.gasPriceGwei,
    });

    const isLegProfitable = convertible.length > 0 && !batchRoi.skipChainNegativeRoi && batchRoi.chainLegNetUsd > 0;
    const soloSum = round2(convertible.reduce((s, c) => s + Math.max(0, c.roi.signedSoloNetUsd), 0));
    const batchedNet = isLegProfitable ? round2(batchRoi.chainLegNetUsd) : 0;
    const rescueGain = isLegProfitable ? round2(Math.max(0, batchedNet - soloSum)) : 0;

    const finalConvertibleIds = isLegProfitable ? convertible.map((c) => c.asset.id) : [];
    const finalSkippedIds = isLegProfitable
      ? skipped.map((s) => s.asset.id)
      : items.map((a) => a.id);

    allConvertibleIds.push(...finalConvertibleIds);

    chains.push({
      chain,
      chainName: chainMeta?.chainName || items[0].chainName,
      dustTokenCount: items.length,
      rescuedByBatchCount: isLegProfitable ? rescuedByBatch.length : 0,
      directProfitableCount: isLegProfitable ? directProfitable.length : 0,
      unprofitableSkippedCount: finalSkippedIds.length,
      grossDustUsd: round2(items.reduce((s, a) => s + a.grossUsd, 0)),
      soloTotalNetUsd: soloSum,
      batchedConversionNetUsd: batchedNet,
      batchRescueGainUsd: rescueGain,
      recommendedRoute: isLegProfitable ? batchRoi.routeComparison.recommendedStrategy : 'skip_negative_roi',
      convertibleAssetIds: finalConvertibleIds,
      skippedAssetIds: finalSkippedIds,
      breakEvenHint: batchRoi.breakEvenHint,
    });
  }

  chains.sort((a, b) => b.batchedConversionNetUsd - a.batchedConversionNetUsd);

  return {
    maxDustThresholdUsd,
    protocolFeeBps,
    totalDustAssetsFound: dustCandidates.length,
    convertibleCount: allConvertibleIds.length,
    rescuedByBatchCount: chains.reduce((s, c) => s + c.rescuedByBatchCount, 0),
    skippedUnprofitableCount: chains.reduce((s, c) => s + c.unprofitableSkippedCount, 0),
    grossConvertibleDustUsd: round2(
      dustCandidates
        .filter((a) => allConvertibleIds.includes(a.id))
        .reduce((s, a) => s + a.grossUsd, 0)
    ),
    estimatedNetSolanaUsdc: round2(chains.reduce((s, c) => s + c.batchedConversionNetUsd, 0)),
    totalBatchRescueGainUsd: round2(chains.reduce((s, c) => s + c.batchRescueGainUsd, 0)),
    convertibleAssetIds: allConvertibleIds,
    chains,
  };
}
