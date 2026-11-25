import { EVM_CHAINS, resolveProtocolFeeBps } from './chains.js';
import { isEip2612Token } from './discovery.js';
import { evaluateAssetRoi, evaluateChainBatchRoi, normalizeBatchWalletKey } from './roi.js';
import type { AnyChainId, EvmChainId, ScannedAsset, ScanReport } from './types.js';

export type DustExecutionLane =
  | 'instant_single_sig'
  | 'hybrid_single_sig_and_multi_swap'
  | 'multi_input_batch'
  | 'single_asset_bridge'
  | 'skip_negative_roi';

export interface DustChainPlan {
  chain: AnyChainId;
  chainName: string;
  sourceWallet?: string;
  sourceWalletLabel?: string;
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
  /** Two-lane signature reduction breakdown (Permit2 + EIP-2612 instant 1-sig vs consolidated multi-input swap) */
  instantSingleSigAssetIds: string[];
  multiInputSwapAssetIds: string[];
  instantSingleSigCount: number;
  permit2ReadyCount: number;
  eip2612Count: number;
  multiInputSwapCount: number;
  naiveLegacySignatures: number;
  optimizedLegacySignatures: number;
  eip5792Signatures: number;
  signaturesEliminated: number;
  recommendedExecutionLane: DustExecutionLane;
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
  instantSingleSigAssetIds: string[];
  multiInputSwapAssetIds: string[];
  instantSingleSigCount: number;
  multiInputSwapCount: number;
  totalNaiveLegacySignatures: number;
  totalOptimizedLegacySignatures: number;
  totalEip5792Signatures: number;
  totalSignaturesEliminated: number;
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
 *
 * Groups strictly by `(sourceWallet, chain)` so two separate EOAs on the same chain
 * are modeled as two independent atomic batches rather than one impossible shared batch.
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

  // Group strictly by (sourceWallet, chain) to avoid impossible cross-wallet atomic batching
  const byWalletAndChain = new Map<
    string,
    { chain: AnyChainId; sourceWallet?: string; sourceWalletLabel?: string; items: ScannedAsset[] }
  >();
  for (const asset of dustCandidates) {
    const rawWallet = asset.sourceWallet || params.scan.walletAddress || '';
    const walletKey = normalizeBatchWalletKey(rawWallet, asset.family);
    const groupKey = `${walletKey}::${asset.chain}`;
    const existing = byWalletAndChain.get(groupKey);
    if (existing) {
      existing.items.push(asset);
    } else {
      byWalletAndChain.set(groupKey, {
        chain: asset.chain,
        sourceWallet: asset.sourceWallet || (params.scan.walletAddress && !params.scan.walletAddress.includes(',') ? params.scan.walletAddress : undefined),
        sourceWalletLabel: asset.sourceWalletLabel || params.scan.walletLabel,
        items: [asset],
      });
    }
  }

  const chains: DustChainPlan[] = [];
  const allConvertibleIds: string[] = [];

  for (const group of byWalletAndChain.values()) {
    const { chain, sourceWallet, sourceWalletLabel, items } = group;
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
      sourceWallet,
      sourceWalletLabel,
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

    const convertibleAssets = isLegProfitable ? convertible.map((c) => c.asset) : [];
    const isEvmChain = chain in EVM_CHAINS;
    const instantSingleSigAssets: ScannedAsset[] = [];
    const multiInputSwapAssets: ScannedAsset[] = [];
    let permit2ReadyCount = 0;
    let eip2612Count = 0;
    let nativeCount = 0;

    for (const asset of convertibleAssets) {
      if (asset.address === 'native') {
        nativeCount += 1;
        continue;
      }
      const hasPermit2 = Boolean(asset.permit2Approved);
      const hasEip2612 = Boolean(
        asset.eip2612Supported ??
          (isEvmChain && isEip2612Token(chain as EvmChainId, asset.address, asset.symbol))
      );
      if (hasPermit2) permit2ReadyCount += 1;
      if (hasEip2612) eip2612Count += 1;

      if (isEvmChain && (hasPermit2 || hasEip2612)) {
        instantSingleSigAssets.push(asset);
      } else {
        multiInputSwapAssets.push(asset);
      }
    }

    const instantSingleSigAssetIds = instantSingleSigAssets.map((a) => a.id);
    const multiInputSwapAssetIds = multiInputSwapAssets.map((a) => a.id);

    // Signature reduction math for non-EIP-5792 EOAs (e.g. Rabby 0.94.x) vs EIP-5792/7702 smart EOAs:
    // - Naive per-token swap+bridge on a legacy EOA: 2 signatures per ERC-20 (approve + swap) + 1 per native.
    // - Optimized Two-Lane on a legacy EOA:
    //     * Instant Lane (Permit2 / EIP-2612): 1 off-chain EIP-712 signature covers ALL instant tokens.
    //     * Multi-Input Lane (M legacy ERC-20s): M approves + 1 consolidated multi-input swap + 1 bridge
    //       (when M >= 2, saving M - 2 swap/bridge popups; when M == 1, 2 sigs).
    //     * Native gas token (if present): 1 sig.
    const erc20Count = instantSingleSigAssets.length + multiInputSwapAssets.length;
    const naiveLegacySignatures = isLegProfitable
      ? isEvmChain
        ? erc20Count * 2 + nativeCount
        : convertibleAssets.length
      : 0;
    const instantLaneSigs = instantSingleSigAssets.length > 0 ? 1 : 0;
    const legacyLaneSigs = !isEvmChain
      ? multiInputSwapAssets.length
      : multiInputSwapAssets.length >= 2
      ? multiInputSwapAssets.length + 2
      : multiInputSwapAssets.length * 2;
    const optimizedLegacySignatures = isLegProfitable
      ? Math.min(naiveLegacySignatures, instantLaneSigs + legacyLaneSigs + nativeCount)
      : 0;
    const eip5792Signatures = isLegProfitable ? 1 : 0;
    const signaturesEliminated = Math.max(0, naiveLegacySignatures - optimizedLegacySignatures);

    let recommendedExecutionLane: DustExecutionLane = 'skip_negative_roi';
    if (isLegProfitable) {
      if (instantSingleSigAssets.length > 0 && multiInputSwapAssets.length === 0 && nativeCount === 0) {
        recommendedExecutionLane = 'instant_single_sig';
      } else if (instantSingleSigAssets.length > 0 && multiInputSwapAssets.length > 0) {
        recommendedExecutionLane = 'hybrid_single_sig_and_multi_swap';
      } else if (multiInputSwapAssets.length >= 2) {
        recommendedExecutionLane = 'multi_input_batch';
      } else {
        recommendedExecutionLane = 'single_asset_bridge';
      }
    }

    allConvertibleIds.push(...finalConvertibleIds);

    chains.push({
      chain,
      chainName: chainMeta?.chainName || items[0].chainName,
      sourceWallet,
      sourceWalletLabel,
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
      instantSingleSigAssetIds,
      multiInputSwapAssetIds,
      instantSingleSigCount: instantSingleSigAssetIds.length,
      permit2ReadyCount,
      eip2612Count,
      multiInputSwapCount: multiInputSwapAssetIds.length,
      naiveLegacySignatures,
      optimizedLegacySignatures,
      eip5792Signatures,
      signaturesEliminated,
      recommendedExecutionLane,
      breakEvenHint: batchRoi.breakEvenHint,
    });
  }

  chains.sort((a, b) => b.batchedConversionNetUsd - a.batchedConversionNetUsd);

  const allInstantSingleSigIds = chains.flatMap((c) => c.instantSingleSigAssetIds);
  const allMultiInputSwapIds = chains.flatMap((c) => c.multiInputSwapAssetIds);

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
    instantSingleSigAssetIds: allInstantSingleSigIds,
    multiInputSwapAssetIds: allMultiInputSwapIds,
    instantSingleSigCount: allInstantSingleSigIds.length,
    multiInputSwapCount: allMultiInputSwapIds.length,
    totalNaiveLegacySignatures: chains.reduce((s, c) => s + c.naiveLegacySignatures, 0),
    totalOptimizedLegacySignatures: chains.reduce((s, c) => s + c.optimizedLegacySignatures, 0),
    totalEip5792Signatures: chains.reduce((s, c) => s + c.eip5792Signatures, 0),
    totalSignaturesEliminated: chains.reduce((s, c) => s + c.signaturesEliminated, 0),
    chains,
  };
}
