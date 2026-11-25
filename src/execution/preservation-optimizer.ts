import { EVM_CHAINS, getProtocolFeeConfig } from '../scanner/chains.js';
import {
  estimateBridgeFixedFeeUsd,
  estimateL1DataFeeUsd,
  estimateLiquidityScaledSlippageUsd,
  evaluateAssetRoi,
  isCanonicalDirectUsdc,
} from '../scanner/roi.js';
import { evmJsonRpcCall } from '../scanner/rpc.js';
import type { AnyChainId, EvmChainId, ScannedAsset, ScanReport } from '../scanner/types.js';

export type PreservationRouteId = 'circle_cctp' | 'relay' | 'lifi' | 'direct_swap_only';

export interface RouteCandidateQuote {
  route: PreservationRouteId;
  label: string;
  bridgePreferenceValue: 'cctp' | 'relay' | 'lifi' | 'auto';
  eligible: boolean;
  ineligibleReason?: string;
  settlesOnSolana: boolean;
  grossUsd: number;
  gasUsd: number;
  l1DataFeeUsd: number;
  slippageUsd: number;
  bridgeFeeUsd: number;
  protocolFeeUsd: number;
  solanaAtaRentUsd: number;
  totalCostUsd: number;
  netUsdPreserved: number;
  preservationRatePct: number;
  estimatedSeconds: number;
  notes: string;
}

export interface ChainPreservationAudit {
  chain: AnyChainId;
  chainName: string;
  assetCount: number;
  sweepableAssetCount: number;
  directUsdcAssetCount: number;
  nonUsdcAssetCount: number;
  prunedNegativeRoiCount: number;
  grossUsd: number;
  bestRoute: PreservationRouteId;
  bestRouteLabel: string;
  recommendedBridgePreference: 'cctp' | 'relay' | 'lifi' | 'auto';
  bestNetUsdPreserved: number;
  bestPreservationRatePct: number;
  candidates: RouteCandidateQuote[];
  routeAuctionSavingsUsd: number;
  gasSavedUsd: number;
  approvalsSavedUsd: number;
  negativeRoiPrunedSavedUsd: number;
  popupsNaive: number;
  popupsOptimized: number;
  popupsEliminated: number;
  rationale: string;
}

export interface ChainGasTimingRecommendation {
  chain: EvmChainId;
  chainName: string;
  currentGwei: number;
  targetMaxGwei: number;
  shouldWait: boolean;
  immediateGasUsd: number;
  targetWindowGasUsd: number;
  estimatedWaitSavingsUsd: number;
  source: 'live_rpc' | 'override' | 'scan_snapshot';
  recommendation: string;
}

export interface UnlockScheduleItem {
  id: string;
  kind: 'defi_unlock' | 'cctp_claim';
  chain: AnyChainId;
  chainName: string;
  symbol: string;
  protocol: string;
  estimatedUsd: number;
  unlockAtMs: number;
  unlockAtIso: string;
  secondsRemaining: number;
  status: 'ready_to_claim' | 'locked_waiting' | 'attestation_pending';
  actionLabel: string;
}

export interface AttestedCctpLegInput {
  chain: AnyChainId;
  chainName?: string;
  amountUsdc: number;
  txHash?: string;
  attestationStatus: 'pending_confirmations' | 'complete';
  estimatedReadyAt?: number;
}

export interface PreservationPlanOptions {
  selectedAssetIds?: string[];
  outputAsset?: 'USDC' | 'SOL';
  protocolFeeBps?: number;
  maxBaseFeeGwei?: number;
  liveGasGweiByChain?: Partial<Record<AnyChainId, number>>;
  gasPriceFetcher?: (chain: EvmChainId) => Promise<number | null>;
  fetchLiveGas?: boolean;
  rpcTimeoutMs?: number;
  hasSolanaUsdcAta?: boolean;
  nowMs?: number;
  attestedCctpLegs?: AttestedCctpLegInput[];
}

export interface PreservationPlanReport {
  generatedAt: string;
  walletAddress: string;
  outputAsset: 'USDC' | 'SOL';
  protocolFeeBps: number;
  recommendedBridgePreference: 'cctp' | 'relay' | 'lifi' | 'auto';
  recommendedRouteLabel: string;
  totals: {
    grossSweepableUsd: number;
    optimizedNetUsd: number;
    naiveManualNetUsd: number;
    optimizedTotalCostUsd: number;
    naiveTotalCostUsd: number;
    dollarsSavedGasUsd: number;
    dollarsSavedApprovalsUsd: number;
    dollarsSavedNegativeRoiPrunedUsd: number;
    dollarsSavedRouteAuctionUsd: number;
    totalDollarsPreservedUsd: number;
    preservationRatePct: number;
    executionEfficiencyPct: number;
    naivePreservationRatePct: number;
    popupsNaive: number;
    popupsOptimized: number;
    popupsEliminated: number;
  };
  chains: ChainPreservationAudit[];
  gasTiming: {
    primary: ChainGasTimingRecommendation;
    chains: ChainGasTimingRecommendation[];
    anyHighGasChain: boolean;
    totalPotentialWaitSavingsUsd: number;
  };
  unlockSchedule: UnlockScheduleItem[];
}

const DEFAULT_MAX_BASE_FEE_GWEI = 15;
const ERC20_APPROVE_GAS_UNITS = 46_000;
const SOLANA_CCTP_CLAIM_FEE_USD = 0.01;
const SOLANA_ATA_RENT_SOL = 0.00203928;

const DEFAULT_NATIVE_PRICE_USD: Partial<Record<EvmChainId, number>> = {
  ethereum: 2500,
  base: 2500,
  arbitrum: 2500,
  optimism: 2500,
  polygon: 0.45,
  avalanche: 28,
  bnb: 600,
  sonic: 0.6,
  unichain: 2500,
  linea: 2500,
  scroll: 2500,
  mantle: 0.85,
  blast: 2500,
  worldchain: 2500,
};

function r2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function r4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function isEvmChainId(chain: AnyChainId): chain is EvmChainId {
  return typeof chain === 'string' && Object.hasOwn(EVM_CHAINS, chain);
}

/**
 * Fetches live `eth_gasPrice` (in gwei) for an EVM chain via JSON-RPC failover.
 * Supports deterministic override injection for tests and offline backtests.
 */
export async function fetchLiveChainGasGwei(
  chain: EvmChainId,
  options: {
    overrideGwei?: number;
    timeoutMs?: number;
    gasPriceFetcher?: (chain: EvmChainId) => Promise<number | null>;
  } = {}
): Promise<{ gwei: number; source: 'override' | 'live_rpc' } | null> {
  if (
    typeof options.overrideGwei === 'number' &&
    Number.isFinite(options.overrideGwei) &&
    options.overrideGwei >= 0
  ) {
    return { gwei: r2(options.overrideGwei), source: 'override' };
  }

  if (options.gasPriceFetcher) {
    try {
      const fetched = await options.gasPriceFetcher(chain);
      if (typeof fetched === 'number' && Number.isFinite(fetched) && fetched >= 0) {
        return { gwei: r2(fetched), source: 'live_rpc' };
      }
    } catch {
      return null;
    }
    return null;
  }

  const cfg = EVM_CHAINS[chain];
  if (!cfg) return null;

  try {
    const rpcRes = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_gasPrice',
      [],
      options.timeoutMs ?? 2000
    );
    if (typeof rpcRes.result === 'string' && /^0x[0-9a-fA-F]+$/.test(rpcRes.result)) {
      const wei = BigInt(rpcRes.result);
      const gwei = Number(wei) / 1e9;
      if (Number.isFinite(gwei) && gwei >= 0) {
        return { gwei: r2(gwei), source: 'live_rpc' };
      }
    }
  } catch {
    return null;
  }
  return null;
}

function resolveChainGasGwei(
  chain: AnyChainId,
  scan: ScanReport,
  liveOverrides?: Partial<Record<AnyChainId, number>>
): { gwei: number; nativePriceUsd: number; source: 'override' | 'scan_snapshot' } {
  const summary = scan.chains.find((c) => c.chain === chain);
  const override = liveOverrides?.[chain];
  const evmDefaultPrice = isEvmChainId(chain) ? DEFAULT_NATIVE_PRICE_USD[chain] ?? 2500 : 1;
  const nativePriceUsd =
    summary && Number.isFinite(summary.nativePriceUsd) && summary.nativePriceUsd > 0
      ? summary.nativePriceUsd
      : evmDefaultPrice;

  if (typeof override === 'number' && Number.isFinite(override) && override >= 0) {
    return { gwei: r2(override), nativePriceUsd, source: 'override' };
  }

  if (summary && Number.isFinite(summary.gasPriceGwei) && summary.gasPriceGwei >= 0) {
    return { gwei: r2(summary.gasPriceGwei), nativePriceUsd, source: 'scan_snapshot' };
  }

  return {
    gwei: chain === 'ethereum' ? 18 : 0.1,
    nativePriceUsd,
    source: 'scan_snapshot',
  };
}

function estimateGasUsdForUnits(gasUnits: number, gwei: number, nativePriceUsd: number): number {
  if (!Number.isFinite(gasUnits) || !Number.isFinite(gwei) || !Number.isFinite(nativePriceUsd)) {
    return 0;
  }
  return r4(Math.max(0, gasUnits) * Math.max(0, gwei) * 1e-9 * Math.max(0, nativePriceUsd));
}

function supportsNativeCctp(chain: AnyChainId): boolean {
  if (chain === 'noble') return true;
  if (!isEvmChainId(chain)) return false;
  const cfg = EVM_CHAINS[chain];
  return cfg.cctpDomain !== null && Boolean(cfg.cctpTokenMessenger);
}

function resolveAssetBaseSlippage(asset: ScannedAsset, directUsdc: boolean): number {
  if (directUsdc || asset.grossUsd <= 0) return 0;
  const scaled = estimateLiquidityScaledSlippageUsd({
    grossUsd: asset.grossUsd,
    liquidityUsd: Number.isFinite(asset.liquidityUsd) ? asset.liquidityUsd : 0,
    isDirectUsdc: false,
    isDead: asset.kind === 'dead_token' || asset.action === 'BURN_ZERO_LIQUIDITY',
  });
  const explicit = Number.isFinite(asset.estimatedSlippageUsd)
    ? Math.max(0, asset.estimatedSlippageUsd)
    : 0;
  return r2(Math.max(scaled, explicit));
}

function buildChainRouteCandidates(params: {
  chain: AnyChainId;
  assets: ScannedAsset[];
  outputAsset: 'USDC' | 'SOL';
  protocolFeeBps: number;
  gasGwei: number;
  nativePriceUsd: number;
  ataRentUsd: number;
}): {
  candidates: RouteCandidateQuote[];
  best: RouteCandidateQuote;
  naiveBridgeBaseline: RouteCandidateQuote;
  rationale: string;
} {
  const { chain, assets, outputAsset, protocolFeeBps, gasGwei, nativePriceUsd, ataRentUsd } =
    params;
  const evmCfg = isEvmChainId(chain) ? EVM_CHAINS[chain] : undefined;
  const feeRate = protocolFeeBps / 10_000;

  const grossUsd = r2(assets.reduce((s, a) => s + Math.max(0, Number(a.grossUsd) || 0), 0));
  const directUsdcAssets = assets.filter((a) => isCanonicalDirectUsdc(a));
  const nonUsdcAssets = assets.filter((a) => !isCanonicalDirectUsdc(a));
  const allDirectUsdc = assets.length > 0 && nonUsdcAssets.length === 0;

  // Base local swap/unwind gas scaled to live gas gwei when available
  const rawBatchedGasFromAssets = r4(
    assets.reduce((s, a) => s + Math.max(0, Number(a.batchedGasUsd) || 0), 0)
  );
  let scaledBatchedGasUsd = rawBatchedGasFromAssets;
  if (evmCfg) {
    let totalUnits = 0;
    for (const a of assets) {
      const direct = isCanonicalDirectUsdc(a);
      if (a.kind === 'defi_position') {
        totalUnits += evmCfg.defiWithdrawGasUnits + (direct ? 0 : evmCfg.swapGasUnits);
      } else if (direct) {
        totalUnits += Math.round(evmCfg.bridgeGasUnits * 0.45);
      } else {
        totalUnits += evmCfg.swapGasUnits;
      }
    }
    const batchDiscount = assets.length > 1 ? 0.58 : 0.88;
    const computedFromLiveGwei = estimateGasUsdForUnits(
      totalUnits * batchDiscount,
      gasGwei,
      nativePriceUsd
    );
    // Prefer live-gwei-computed gas on EVM so gas spikes/drops accurately flow into route math
    scaledBatchedGasUsd = computedFromLiveGwei > 0 ? computedFromLiveGwei : rawBatchedGasFromAssets;
  }

  const baseSlippageUsd = r2(
    assets.reduce((s, a) => s + resolveAssetBaseSlippage(a, isCanonicalDirectUsdc(a)), 0)
  );
  const l1DataFeeUsd = r4(estimateL1DataFeeUsd(chain, true) * Math.max(1, assets.length));
  const isL1 = chain === 'ethereum';
  const isFastL2 =
    chain === 'base' ||
    chain === 'arbitrum' ||
    chain === 'optimism' ||
    chain === 'unichain' ||
    chain === 'worldchain';

  const makeCandidate = (spec: {
    route: PreservationRouteId;
    label: string;
    bridgePreferenceValue: 'cctp' | 'relay' | 'lifi' | 'auto';
    eligible: boolean;
    ineligibleReason?: string;
    settlesOnSolana: boolean;
    gasUsd: number;
    l1DataFeeUsd: number;
    slippageUsd: number;
    bridgeFeeUsd: number;
    ataRentUsd: number;
    estimatedSeconds: number;
    notes: string;
  }): RouteCandidateQuote => {
    const gasUsd = r2(Math.max(0, spec.gasUsd));
    const l1Fee = r4(Math.max(0, spec.l1DataFeeUsd));
    const slippageUsd = r2(Math.max(0, spec.slippageUsd));
    const bridgeFeeUsd = r2(Math.max(0, spec.bridgeFeeUsd));
    const ataRent = r2(Math.max(0, spec.ataRentUsd));
    const protocolFeeUsd = r2(Math.max(0, grossUsd - slippageUsd) * feeRate);
    const totalCostUsd = r2(gasUsd + l1Fee + slippageUsd + bridgeFeeUsd + protocolFeeUsd + ataRent);
    const netUsdPreserved = r2(grossUsd - totalCostUsd);
    const preservationRatePct =
      grossUsd > 0 ? r2(clamp((netUsdPreserved / grossUsd) * 100, 0, 100)) : 100;

    return {
      route: spec.route,
      label: spec.label,
      bridgePreferenceValue: spec.bridgePreferenceValue,
      eligible: spec.eligible,
      ineligibleReason: spec.ineligibleReason,
      settlesOnSolana: spec.settlesOnSolana,
      grossUsd,
      gasUsd,
      l1DataFeeUsd: l1Fee,
      slippageUsd,
      bridgeFeeUsd,
      protocolFeeUsd,
      solanaAtaRentUsd: ataRent,
      totalCostUsd,
      netUsdPreserved,
      preservationRatePct,
      estimatedSeconds: spec.estimatedSeconds,
      notes: spec.notes,
    };
  };

  // 1. Circle CCTP (0-bps native USDC burn-and-mint)
  const cctpSupported = supportsNativeCctp(chain);
  const cctpEligible = outputAsset === 'USDC' && cctpSupported && grossUsd > 0;
  const nonUsdcGrossUsd = r2(
    nonUsdcAssets.reduce((s, a) => s + Math.max(0, Number(a.grossUsd) || 0), 0)
  );
  const cctpBurnGasUsd = evmCfg
    ? estimateGasUsdForUnits(evmCfg.bridgeGasUnits, gasGwei, nativePriceUsd)
    : 0.05;
  const cctpSwapGasUsd = allDirectUsdc ? 0 : scaledBatchedGasUsd;
  const cctpTotalGasUsd = allDirectUsdc
    ? cctpBurnGasUsd
    : r4(cctpSwapGasUsd + cctpBurnGasUsd * 0.7);
  // CCTP charges 0 bps bridge spread on native USDC (only ~$0.01 Solana claim tx fee).
  // Non-USDC assets must first swap locally to USDC via a DEX pool (~25 bps pool/router fee).
  const cctpBridgeFeeUsd = SOLANA_CCTP_CLAIM_FEE_USD;
  const cctpLocalDexSwapFeeUsd = allDirectUsdc ? 0 : r2(nonUsdcGrossUsd * 0.0025);
  const cctpSlippageUsd = r2(baseSlippageUsd + cctpLocalDexSwapFeeUsd);
  const cctpSec = evmCfg?.cctpAttestationSec ?? 20;

  const cctpCandidate = makeCandidate({
    route: 'circle_cctp',
    label: 'Circle CCTP (0-bps Burn & Mint)',
    bridgePreferenceValue: 'cctp',
    eligible: cctpEligible,
    ineligibleReason: !cctpSupported
      ? `${evmCfg?.name ?? chain} does not support native Circle CCTP.`
      : outputAsset === 'SOL'
      ? 'Circle CCTP settles native USDC only (SOL output uses Relay or LI.FI).'
      : undefined,
    settlesOnSolana: true,
    gasUsd: cctpTotalGasUsd,
    l1DataFeeUsd,
    slippageUsd: cctpSlippageUsd,
    bridgeFeeUsd: cctpBridgeFeeUsd,
    ataRentUsd,
    estimatedSeconds: cctpSec,
    notes: allDirectUsdc
      ? 'Zero bridge spread (0 bps) + zero DEX slippage on canonical USDC.'
      : 'Local batched DEX swap to USDC (25 bps pool fee) + 0-bps Circle burn-and-mint to Solana.',
  });

  // 2. Relay Instant Intent Bridge (fast L2 non-USDC swaps & single-intent settlement)
  const relaySupported = isEvmChainId(chain);
  const relayFixedFee = isL1 ? 0.85 : isFastL2 ? 0.12 : 0.18;
  const relaySpreadBps = isL1 ? 11 : isFastL2 ? 8 : 12;
  const relayBridgeFeeUsd = r2(relayFixedFee + (grossUsd * relaySpreadBps) / 10_000);
  // Single intent deposit eliminates separate local swap + bridge burn overhead on non-USDC swaps
  const relayGasUsd = allDirectUsdc
    ? r4(scaledBatchedGasUsd * 0.9)
    : r4(scaledBatchedGasUsd * 0.72);
  // Relay intent solvers fill directly from inventory, cutting AMM pool overhead on liquid L2 pairs
  const relaySlippageUsd = allDirectUsdc ? 0 : r2(baseSlippageUsd * 0.85);

  const relayCandidate = makeCandidate({
    route: 'relay',
    label: 'Relay Instant Bridge (~4s fill)',
    bridgePreferenceValue: 'relay',
    eligible: relaySupported && grossUsd > 0,
    ineligibleReason: !relaySupported
      ? `Relay EVM intent bridge is unavailable on ${chain}.`
      : undefined,
    settlesOnSolana: true,
    gasUsd: relayGasUsd,
    l1DataFeeUsd: r4(l1DataFeeUsd * 0.8),
    slippageUsd: relaySlippageUsd,
    bridgeFeeUsd: relayBridgeFeeUsd,
    ataRentUsd,
    estimatedSeconds: isL1 ? 14 : 4,
    notes: `Fast intent settlement (${relaySpreadBps} bps solver spread + $${relayFixedFee.toFixed(2)} relayer fee).`,
  });

  // 3. LI.FI Aggregator (multi-DEX split-routing across Mayan / deBridge / Stargate / 1inch)
  const lifiFixedFee = isL1 ? 1.2 : 0.22;
  const lifiSpreadBps = isL1 ? 17 : 15;
  const lifiBridgeFeeUsd = r2(lifiFixedFee + (grossUsd * lifiSpreadBps) / 10_000);
  const lifiGasUsd = r4(scaledBatchedGasUsd * 0.92);
  // Multi-DEX aggregation shines on thinner-liquidity non-USDC tokens (cuts price impact ~28%)
  const lifiSlippageUsd = allDirectUsdc ? 0 : r2(baseSlippageUsd * 0.72);

  const lifiCandidate = makeCandidate({
    route: 'lifi',
    label: 'LI.FI Multi-DEX Aggregator',
    bridgePreferenceValue: 'lifi',
    eligible: grossUsd > 0,
    settlesOnSolana: true,
    gasUsd: lifiGasUsd,
    l1DataFeeUsd,
    slippageUsd: lifiSlippageUsd,
    bridgeFeeUsd: lifiBridgeFeeUsd,
    ataRentUsd,
    estimatedSeconds: isL1 ? 35 : 18,
    notes: `Aggregated multi-DEX routing (${lifiSpreadBps} bps bridge spread; deeper liquidity on exotic pairs).`,
  });

  // 4. Direct Swap-Only (Local consolidation to USDC without paying cross-chain bridge fee yet)
  const directSwapEligible = grossUsd > 0 && nonUsdcAssets.length > 0;
  const directSwapGasUsd = allDirectUsdc ? 0 : r4(scaledBatchedGasUsd * 0.85);
  const directSwapCandidate = makeCandidate({
    route: 'direct_swap_only',
    label: 'Direct Swap-Only (Hold Local USDC)',
    bridgePreferenceValue: 'auto',
    eligible: directSwapEligible,
    ineligibleReason: !directSwapEligible
      ? 'Assets are already canonical USDC; no local swap needed.'
      : undefined,
    settlesOnSolana: false,
    gasUsd: directSwapGasUsd,
    l1DataFeeUsd: r4(l1DataFeeUsd * 0.6),
    slippageUsd: r2(baseSlippageUsd * 0.95),
    bridgeFeeUsd: 0,
    ataRentUsd: 0,
    estimatedSeconds: isL1 ? 12 : 2,
    notes: 'Swaps locally into USDC without bridging yet — protects small balances from high bridge overhead.',
  });

  const candidates: RouteCandidateQuote[] = [
    cctpCandidate,
    relayCandidate,
    lifiCandidate,
    directSwapCandidate,
  ];

  // Select best cross-chain route strictly by highest netUsdPreserved (tie-break: faster ETA)
  const eligibleCrossChain = candidates
    .filter((c) => c.eligible && c.settlesOnSolana)
    .sort((a, b) => {
      if (b.netUsdPreserved !== a.netUsdPreserved) {
        return b.netUsdPreserved - a.netUsdPreserved;
      }
      return a.estimatedSeconds - b.estimatedSeconds;
    });

  const bestCrossChain = eligibleCrossChain[0] ?? lifiCandidate;

  // Pick direct_swap_only ONLY when cross-chain bridging destroys excessive value
  // (non-positive net or > 35% cost haircut while local swap-only stays positive and preserves meaningfully more)
  const crossChainCostPct =
    grossUsd > 0 ? ((grossUsd - bestCrossChain.netUsdPreserved) / grossUsd) * 100 : 100;
  const useDirectSwapOnly =
    directSwapCandidate.eligible &&
    directSwapCandidate.netUsdPreserved > bestCrossChain.netUsdPreserved &&
    directSwapCandidate.netUsdPreserved > 0 &&
    (bestCrossChain.netUsdPreserved <= 0 || crossChainCostPct >= 35);

  const best = useDirectSwapOnly ? directSwapCandidate : bestCrossChain;

  // Baseline unoptimized cross-chain bridge (highest-cost eligible cross-chain route)
  const worstEligibleCrossChain =
    eligibleCrossChain.length > 0
      ? eligibleCrossChain[eligibleCrossChain.length - 1]
      : lifiCandidate;

  let rationale: string;
  if (best.route === 'circle_cctp') {
    const vsRelay = relayCandidate.eligible
      ? r2(best.netUsdPreserved - relayCandidate.netUsdPreserved)
      : 0;
    rationale =
      vsRelay > 0
        ? `Circle CCTP 0-bps burn-and-mint preserves +$${vsRelay.toFixed(2)} more than Relay bridge spread.`
        : 'Circle CCTP 0-bps burn-and-mint maximizes net USDC preserved.';
  } else if (best.route === 'relay') {
    rationale = `Relay instant intent routing maximizes net USD preserved (~${best.estimatedSeconds}s fill, lowest L2 swap+bridge cost).`;
  } else if (best.route === 'lifi') {
    rationale =
      'LI.FI multi-DEX aggregation cuts swap price impact enough to beat direct intent bridges on net USD.';
  } else {
    rationale =
      'Cross-chain bridge overhead is too high for this balance — direct local swap to USDC preserves more capital.';
  }

  return {
    candidates,
    best,
    naiveBridgeBaseline: worstEligibleCrossChain,
    rationale,
  };
}

function buildUnlockSchedule(
  scan: ScanReport,
  attestedCctpLegs: AttestedCctpLegInput[] | undefined,
  nowMs: number
): UnlockScheduleItem[] {
  const items: UnlockScheduleItem[] = [];

  for (const asset of scan.assets) {
    const rawUnlock = asset.defiUnlockAt ?? asset.defiExitPlan?.unlockAt;
    const hasCooldown = Boolean(asset.defiExitPlan?.cooldownDetected);
    if (rawUnlock !== undefined && Number.isFinite(rawUnlock) && rawUnlock > 0) {
      // Normalize seconds vs milliseconds timestamps
      const unlockAtMs = rawUnlock < 1e12 ? Math.round(rawUnlock * 1000) : Math.round(rawUnlock);
      const secondsRemaining = Math.max(0, Math.round((unlockAtMs - nowMs) / 1000));
      items.push({
        id: `unlock:${asset.id}`,
        kind: 'defi_unlock',
        chain: asset.chain,
        chainName: asset.chainName,
        symbol: asset.symbol,
        protocol: asset.protocol ?? asset.defiExitPlan?.protocolName ?? 'DeFi Protocol',
        estimatedUsd: r2(Math.max(0, asset.defiNetUsd ?? asset.grossUsd ?? 0)),
        unlockAtMs,
        unlockAtIso: new Date(unlockAtMs).toISOString(),
        secondsRemaining,
        status: secondsRemaining === 0 ? 'ready_to_claim' : 'locked_waiting',
        actionLabel:
          secondsRemaining === 0
            ? `Claim & bridge ${asset.symbol}`
            : `Unlocks in ${formatDurationShort(secondsRemaining)}`,
      });
    } else if (hasCooldown && asset.kind === 'defi_position') {
      // Cooldown detected without explicit timestamp: surface a 7-day standard unbonding reminder
      const unlockAtMs = nowMs + 7 * 86_400_000;
      const secondsRemaining = 7 * 86_400;
      items.push({
        id: `cooldown:${asset.id}`,
        kind: 'defi_unlock',
        chain: asset.chain,
        chainName: asset.chainName,
        symbol: asset.symbol,
        protocol: asset.protocol ?? asset.defiExitPlan?.protocolName ?? 'DeFi Protocol',
        estimatedUsd: r2(Math.max(0, asset.defiNetUsd ?? asset.grossUsd ?? 0)),
        unlockAtMs,
        unlockAtIso: new Date(unlockAtMs).toISOString(),
        secondsRemaining,
        status: 'locked_waiting',
        actionLabel:
          asset.defiExitPlan?.exitStrategy === 'direct_swap_bypass_cooldown'
            ? `Instant DEX bypass available (avoids cooldown)`
            : `Cooldown active — track unlock`,
      });
    }
  }

  for (const leg of attestedCctpLegs ?? []) {
    const chainName =
      leg.chainName ??
      (isEvmChainId(leg.chain) ? EVM_CHAINS[leg.chain].name : String(leg.chain));
    const defaultWaitMs = isEvmChainId(leg.chain)
      ? EVM_CHAINS[leg.chain].cctpAttestationSec * 1000
      : 20_000;
    const rawReady = leg.estimatedReadyAt;
    const unlockAtMs =
      leg.attestationStatus === 'complete'
        ? nowMs
        : rawReady && Number.isFinite(rawReady)
        ? rawReady < 1e12
          ? Math.round(rawReady * 1000)
          : Math.round(rawReady)
        : nowMs + defaultWaitMs;
    const secondsRemaining =
      leg.attestationStatus === 'complete'
        ? 0
        : Math.max(0, Math.round((unlockAtMs - nowMs) / 1000));

    items.push({
      id: `cctp:${leg.chain}:${leg.txHash ?? Math.round(leg.amountUsdc * 100)}`,
      kind: 'cctp_claim',
      chain: leg.chain,
      chainName,
      symbol: 'USDC',
      protocol: 'Circle CCTP (Domain 5 → Solana)',
      estimatedUsd: r2(Math.max(0, leg.amountUsdc)),
      unlockAtMs,
      unlockAtIso: new Date(unlockAtMs).toISOString(),
      secondsRemaining,
      status: leg.attestationStatus === 'complete' ? 'ready_to_claim' : 'attestation_pending',
      actionLabel:
        leg.attestationStatus === 'complete'
          ? `Claim $${r2(leg.amountUsdc).toFixed(2)} USDC on Solana`
          : `Attesting (~${formatDurationShort(secondsRemaining)})`,
    });
  }

  return items.sort((a, b) => a.unlockAtMs - b.unlockAtMs);
}

function formatDurationShort(totalSec: number): string {
  if (totalSec <= 0) return 'now';
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) return `${Math.ceil(totalSec / 60)}m`;
  if (totalSec < 86_400) return `${Math.round(totalSec / 3600)}h`;
  return `${Math.round(totalSec / 86_400)}d`;
}

/**
 * Capital-Preservation Route Auction & Exact Dollars Saved Engine.
 *
 * Compares Circle CCTP vs Relay vs LI.FI vs Direct Swap-Only per chain strictly on
 * actual net USD preserved, calculates exact reconciled savings vs Naive Manual
 * Swap-and-Bridge, produces live L1 gas-timing recommendations, and builds an
 * Unlock & Claim Schedule so no capital is left stranded.
 */
export async function evaluatePreservationPlan(
  scanReport: ScanReport,
  options: PreservationPlanOptions = {}
): Promise<PreservationPlanReport> {
  const nowMs = options.nowMs ?? Date.now();
  const outputAsset: 'USDC' | 'SOL' = options.outputAsset === 'SOL' ? 'SOL' : 'USDC';
  const protocolFeeBps =
    options.protocolFeeBps !== undefined
      ? Math.max(0, Math.min(1000, Math.round(Number(options.protocolFeeBps) || 0)))
      : getProtocolFeeConfig().feeBps;
  const maxBaseFeeGwei =
    typeof options.maxBaseFeeGwei === 'number' &&
    Number.isFinite(options.maxBaseFeeGwei) &&
    options.maxBaseFeeGwei > 0
      ? r2(options.maxBaseFeeGwei)
      : DEFAULT_MAX_BASE_FEE_GWEI;

  const solPrice =
    scanReport.totals?.solPriceUsd && scanReport.totals.solPriceUsd > 0
      ? scanReport.totals.solPriceUsd
      : 70;
  const ataRentUsdOnce =
    options.hasSolanaUsdcAta === false ? r2(SOLANA_ATA_RENT_SOL * solPrice) : 0;

  // Resolve live Ethereum L1 gas (injectable override -> fetcher -> live RPC if enabled -> scan snapshot)
  const liveGasMap: Partial<Record<AnyChainId, number>> = {
    ...(options.liveGasGweiByChain ?? {}),
  };
  let ethGasSource: 'live_rpc' | 'override' | 'scan_snapshot' =
    typeof liveGasMap.ethereum === 'number' && Number.isFinite(liveGasMap.ethereum)
      ? 'override'
      : 'scan_snapshot';

  if (ethGasSource !== 'override' && (options.gasPriceFetcher || options.fetchLiveGas)) {
    const fetched = await fetchLiveChainGasGwei('ethereum', {
      gasPriceFetcher: options.gasPriceFetcher,
      timeoutMs: options.rpcTimeoutMs ?? 2000,
    });
    if (fetched) {
      liveGasMap.ethereum = fetched.gwei;
      ethGasSource = fetched.source;
    }
  }

  const selectedSet = Array.isArray(options.selectedAssetIds)
    ? new Set(options.selectedAssetIds)
    : null;

  // Group assets by chain
  const assetsByChain = new Map<AnyChainId, ScannedAsset[]>();
  for (const asset of scanReport.assets) {
    if (asset.action === 'SKIP_HONEYPOT' || !asset.honeypotSafe) continue;
    if (asset.action === 'BURN_ZERO_LIQUIDITY' || asset.kind === 'dead_token') continue;
    if (asset.action === 'SKIP_UNPRICED') continue;
    const list = assetsByChain.get(asset.chain);
    if (list) list.push(asset);
    else assetsByChain.set(asset.chain, [asset]);
  }

  const chainAudits: ChainPreservationAudit[] = [];
  const gasTimingChains: ChainGasTimingRecommendation[] = [];

  let totalGrossSweepableUsd = 0;
  let totalOptimizedNetUsd = 0;
  let totalOptimizedCostUsd = 0;
  let totalNaiveCostUsd = 0;
  let totalGasSavedUsd = 0;
  let totalApprovalsSavedUsd = 0;
  let totalNegativeRoiPrunedSavedUsd = 0;
  let totalRouteAuctionSavedUsd = 0;
  let totalPopupsNaive = 0;
  let totalPopupsOptimized = 0;
  let ataApplied = false;

  const routeWeightByPref: Record<'cctp' | 'relay' | 'lifi' | 'auto', number> = {
    cctp: 0,
    relay: 0,
    lifi: 0,
    auto: 0,
  };

  for (const [chain, chainAssets] of assetsByChain.entries()) {
    const chainSummary = scanReport.chains.find((c) => c.chain === chain);
    const chainName =
      chainSummary?.chainName ??
      (isEvmChainId(chain) ? EVM_CHAINS[chain].name : chainAssets[0]?.chainName ?? String(chain));
    const { gwei, nativePriceUsd, source: chainGasSource } = resolveChainGasGwei(
      chain,
      scanReport,
      liveGasMap
    );

    // Partition into sweepable vs pruned negative-ROI dust
    const sweepable: ScannedAsset[] = [];
    const prunedNegativeRoi: ScannedAsset[] = [];

    for (const a of chainAssets) {
      const roi = evaluateAssetRoi(a, { protocolFeeBps, isBatched: true });
      const explicitlySelected = selectedSet ? selectedSet.has(a.id) : a.selectedByDefault;
      const isNegativeRoi =
        a.action === 'SKIP_GAS_NEGATIVE' ||
        a.action === 'SKIP_NEGATIVE_ROI' ||
        roi.roiVerdict === 'negative_roi';

      if (isNegativeRoi) {
        prunedNegativeRoi.push(a);
      } else if (explicitlySelected && a.grossUsd > 0) {
        sweepable.push(a);
      }
    }

    // Negative-ROI bleed prevented: naive user manually paying solo gas + bridge overhead on sub-gas dust
    let chainNegativeRoiSavedUsd = 0;
    for (const neg of prunedNegativeRoi) {
      const soloGas = Math.max(0, Number(neg.estimatedGasUsd) || 0);
      const approvalGas =
        neg.kind !== 'native' && isEvmChainId(chain)
          ? estimateGasUsdForUnits(ERC20_APPROVE_GAS_UNITS, gwei, nativePriceUsd)
          : 0;
      const soloBridgeShare = estimateBridgeFixedFeeUsd(chain) * 0.5;
      const naiveAttemptCost = soloGas + approvalGas + soloBridgeShare;
      const bleed = Math.max(0, naiveAttemptCost - Math.max(0, neg.grossUsd));
      chainNegativeRoiSavedUsd += bleed;
    }
    chainNegativeRoiSavedUsd = r2(chainNegativeRoiSavedUsd);

    if (sweepable.length === 0) {
      if (chainNegativeRoiSavedUsd > 0) {
        totalNegativeRoiPrunedSavedUsd = r2(
          totalNegativeRoiPrunedSavedUsd + chainNegativeRoiSavedUsd
        );
      }
      continue;
    }

    const ataForChain = !ataApplied && ataRentUsdOnce > 0 ? ataRentUsdOnce : 0;
    if (ataForChain > 0) ataApplied = true;

    const { candidates, best, naiveBridgeBaseline, rationale } = buildChainRouteCandidates({
      chain,
      assets: sweepable,
      outputAsset,
      protocolFeeBps,
      gasGwei: gwei,
      nativePriceUsd,
      ataRentUsd: ataForChain,
    });

    const directUsdcCount = sweepable.filter((a) => isCanonicalDirectUsdc(a)).length;
    const nonUsdcCount = sweepable.length - directUsdcCount;
    const nonNativeApprovalCount = sweepable.filter((a) => a.kind !== 'native').length;

    // 1. Naive vs Optimized Gas Savings
    const evmCfg = isEvmChainId(chain) ? EVM_CHAINS[chain] : undefined;
    let naiveExecutionGasUsd = 0;
    for (const a of sweepable) {
      const direct = isCanonicalDirectUsdc(a);
      if (evmCfg) {
        const units =
          a.kind === 'defi_position'
            ? evmCfg.defiWithdrawGasUnits +
              (direct ? 0 : evmCfg.swapGasUnits) +
              evmCfg.bridgeGasUnits
            : direct
            ? evmCfg.bridgeGasUnits
            : evmCfg.swapGasUnits + evmCfg.bridgeGasUnits;
        naiveExecutionGasUsd += estimateGasUsdForUnits(units, gwei, nativePriceUsd);
      } else {
        naiveExecutionGasUsd += Math.max(0, Number(a.estimatedGasUsd) || 0) * 1.25;
      }
    }
    naiveExecutionGasUsd = r2(naiveExecutionGasUsd);
    const gasSavedUsd = r2(Math.max(0, naiveExecutionGasUsd - best.gasUsd));

    // 2. Separate ERC-20 Approval Gas Saved via Permit2 / EIP-2612 / EIP-5792
    const approvalsSavedUsd = evmCfg
      ? r2(
          estimateGasUsdForUnits(
            nonNativeApprovalCount * ERC20_APPROVE_GAS_UNITS,
            gwei,
            nativePriceUsd
          )
        )
      : 0;

    // 3. Route Auction Savings (vs unoptimized per-token manual bridging & worst bridge spread)
    const perTokenManualBridgeOverhead =
      sweepable.length > 1
        ? r2((sweepable.length - 1) * estimateBridgeFixedFeeUsd(chain) * 0.75)
        : 0;
    const auctionDeltaVsWorstBridge = Math.max(
      0,
      naiveBridgeBaseline.bridgeFeeUsd +
        naiveBridgeBaseline.slippageUsd -
        (best.bridgeFeeUsd + best.slippageUsd)
    );
    const routeAuctionSavingsUsd = r2(perTokenManualBridgeOverhead + auctionDeltaVsWorstBridge);

    // 4. Popup Count Math (Naive manual approve + withdraw + swap + bridge vs Siphon 1-click batch)
    let popupsNaive = 0;
    for (const a of sweepable) {
      const direct = isCanonicalDirectUsdc(a);
      if (a.kind !== 'native') popupsNaive += 1; // approve()
      if (a.kind === 'defi_position') popupsNaive += 1; // protocol withdraw()
      if (!direct) popupsNaive += 1; // DEX swap()
      popupsNaive += 1; // bridge()
    }
    const popupsOptimized = best.route === 'circle_cctp' ? 2 : 1; // 1 EVM batch (+ 1 Solana claim for CCTP)
    const popupsEliminated = Math.max(0, popupsNaive - popupsOptimized);

    // Accumulate totals
    totalGrossSweepableUsd = r2(totalGrossSweepableUsd + best.grossUsd);
    totalOptimizedNetUsd = r2(totalOptimizedNetUsd + best.netUsdPreserved);
    totalOptimizedCostUsd = r2(totalOptimizedCostUsd + best.totalCostUsd);
    totalNaiveCostUsd = r2(
      totalNaiveCostUsd +
        best.totalCostUsd +
        gasSavedUsd +
        approvalsSavedUsd +
        routeAuctionSavingsUsd +
        chainNegativeRoiSavedUsd
    );
    totalGasSavedUsd = r2(totalGasSavedUsd + gasSavedUsd);
    totalApprovalsSavedUsd = r2(totalApprovalsSavedUsd + approvalsSavedUsd);
    totalNegativeRoiPrunedSavedUsd = r2(totalNegativeRoiPrunedSavedUsd + chainNegativeRoiSavedUsd);
    totalRouteAuctionSavedUsd = r2(totalRouteAuctionSavedUsd + routeAuctionSavingsUsd);
    totalPopupsNaive += popupsNaive;
    totalPopupsOptimized += popupsOptimized;
    routeWeightByPref[best.bridgePreferenceValue] += best.grossUsd;

    chainAudits.push({
      chain,
      chainName,
      assetCount: chainAssets.length,
      sweepableAssetCount: sweepable.length,
      directUsdcAssetCount: directUsdcCount,
      nonUsdcAssetCount: nonUsdcCount,
      prunedNegativeRoiCount: prunedNegativeRoi.length,
      grossUsd: best.grossUsd,
      bestRoute: best.route,
      bestRouteLabel: best.label,
      recommendedBridgePreference: best.bridgePreferenceValue,
      bestNetUsdPreserved: best.netUsdPreserved,
      bestPreservationRatePct: best.preservationRatePct,
      candidates,
      routeAuctionSavingsUsd,
      gasSavedUsd,
      approvalsSavedUsd,
      negativeRoiPrunedSavedUsd: chainNegativeRoiSavedUsd,
      popupsNaive,
      popupsOptimized,
      popupsEliminated,
      rationale,
    });

    // Gas-timing evaluation for Ethereum L1 and any high-gas EVM chain
    if (isEvmChainId(chain) && (chain === 'ethereum' || gwei > maxBaseFeeGwei)) {
      const chainTargetGwei = chain === 'ethereum' ? maxBaseFeeGwei : Math.min(maxBaseFeeGwei, 2);
      const immediateGasUsd = r2(best.gasUsd);
      const targetWindowGasUsd =
        gwei > 0 ? r2(immediateGasUsd * Math.min(1, chainTargetGwei / gwei)) : immediateGasUsd;
      const estimatedWaitSavingsUsd = r2(Math.max(0, immediateGasUsd - targetWindowGasUsd));
      const shouldWait = gwei > chainTargetGwei && estimatedWaitSavingsUsd >= 0.5;
      const source = chain === 'ethereum' ? ethGasSource : chainGasSource;

      gasTimingChains.push({
        chain,
        chainName,
        currentGwei: gwei,
        targetMaxGwei: chainTargetGwei,
        shouldWait,
        immediateGasUsd,
        targetWindowGasUsd,
        estimatedWaitSavingsUsd,
        source,
        recommendation: shouldWait
          ? `Save ~$${estimatedWaitSavingsUsd.toFixed(2)} by waiting for ≤ ${chainTargetGwei} gwei on ${chainName} (currently ${gwei.toFixed(1)} gwei).`
          : `${chainName} gas is ${gwei.toFixed(1)} gwei (≤ ${chainTargetGwei} gwei target) — efficient window to sweep now.`,
      });
    }
  }

  // Always include Ethereum L1 primary gas-timing reading even if the wallet has no Ethereum assets
  let primaryGasTiming = gasTimingChains.find((g) => g.chain === 'ethereum');
  if (!primaryGasTiming) {
    const ethResolved = resolveChainGasGwei('ethereum', scanReport, liveGasMap);
    // Estimate standard single Ethereum sweep batch (~220k gas) as reference when wallet has no L1 assets
    const refImmediate = r2(
      estimateGasUsdForUnits(220_000, ethResolved.gwei, ethResolved.nativePriceUsd)
    );
    const refTarget = r2(
      estimateGasUsdForUnits(
        220_000,
        Math.min(ethResolved.gwei, maxBaseFeeGwei),
        ethResolved.nativePriceUsd
      )
    );
    const refSavings = r2(Math.max(0, refImmediate - refTarget));
    const shouldWait = ethResolved.gwei > maxBaseFeeGwei && refSavings >= 0.5;
    primaryGasTiming = {
      chain: 'ethereum',
      chainName: 'Ethereum',
      currentGwei: ethResolved.gwei,
      targetMaxGwei: maxBaseFeeGwei,
      shouldWait,
      immediateGasUsd: refImmediate,
      targetWindowGasUsd: refTarget,
      estimatedWaitSavingsUsd: refSavings,
      source: ethGasSource,
      recommendation: shouldWait
        ? `Ethereum L1 is at ${ethResolved.gwei.toFixed(1)} gwei — waiting for ≤ ${maxBaseFeeGwei} gwei saves ~$${refSavings.toFixed(2)} on L1 sweeps.`
        : `Ethereum L1 gas is ${ethResolved.gwei.toFixed(1)} gwei (≤ ${maxBaseFeeGwei} gwei target) — favorable window.`,
    };
    gasTimingChains.unshift(primaryGasTiming);
  }

  const totalDollarsPreservedUsd = r2(
    totalGasSavedUsd +
      totalApprovalsSavedUsd +
      totalNegativeRoiPrunedSavedUsd +
      totalRouteAuctionSavedUsd
  );

  const naiveManualNetUsd = r2(totalOptimizedNetUsd - totalDollarsPreservedUsd);
  const preservationRatePct =
    totalGrossSweepableUsd > 0
      ? r2(clamp((totalOptimizedNetUsd / totalGrossSweepableUsd) * 100, 0, 100))
      : 100;
  const totalProtocolFeesUsd = r2(
    chainAudits.reduce(
      (s, c) => s + (c.candidates.find((q) => q.route === c.bestRoute)?.protocolFeeUsd ?? 0),
      0
    )
  );
  const executionEfficiencyPct =
    totalGrossSweepableUsd > 0
      ? r2(
          clamp(
            ((totalOptimizedNetUsd + totalProtocolFeesUsd) / totalGrossSweepableUsd) * 100,
            0,
            100
          )
        )
      : 100;
  const naivePreservationRatePct =
    totalGrossSweepableUsd > 0
      ? r2(clamp((naiveManualNetUsd / totalGrossSweepableUsd) * 100, 0, 100))
      : 100;

  // Determine portfolio-wide recommended bridge preference
  const activePrefs = Object.entries(routeWeightByPref)
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1]);
  let recommendedBridgePreference: 'cctp' | 'relay' | 'lifi' | 'auto' = 'auto';
  if (activePrefs.length === 1) {
    recommendedBridgePreference = activePrefs[0][0] as 'cctp' | 'relay' | 'lifi' | 'auto';
  } else if (activePrefs.length > 1) {
    const topPref = activePrefs[0][0] as 'cctp' | 'relay' | 'lifi' | 'auto';
    const topShare = activePrefs[0][1] / Math.max(1, totalGrossSweepableUsd);
    recommendedBridgePreference = topShare >= 0.7 ? topPref : 'auto';
  }

  const recommendedRouteLabel =
    recommendedBridgePreference === 'cctp'
      ? 'Circle CCTP (0-bps 1:1)'
      : recommendedBridgePreference === 'relay'
      ? 'Relay Instant Bridge'
      : recommendedBridgePreference === 'lifi'
      ? 'LI.FI Aggregator'
      : 'Auto Optimal (Per-Chain Auction)';

  const totalPotentialWaitSavingsUsd = r2(
    gasTimingChains
      .filter((g) => g.shouldWait)
      .reduce((s, g) => s + g.estimatedWaitSavingsUsd, 0)
  );

  const unlockSchedule = buildUnlockSchedule(scanReport, options.attestedCctpLegs, nowMs);

  return {
    generatedAt: new Date(nowMs).toISOString(),
    walletAddress: scanReport.walletAddress,
    outputAsset,
    protocolFeeBps,
    recommendedBridgePreference,
    recommendedRouteLabel,
    totals: {
      grossSweepableUsd: totalGrossSweepableUsd,
      optimizedNetUsd: totalOptimizedNetUsd,
      naiveManualNetUsd,
      optimizedTotalCostUsd: totalOptimizedCostUsd,
      naiveTotalCostUsd: totalNaiveCostUsd,
      dollarsSavedGasUsd: totalGasSavedUsd,
      dollarsSavedApprovalsUsd: totalApprovalsSavedUsd,
      dollarsSavedNegativeRoiPrunedUsd: totalNegativeRoiPrunedSavedUsd,
      dollarsSavedRouteAuctionUsd: totalRouteAuctionSavedUsd,
      totalDollarsPreservedUsd,
      preservationRatePct,
      executionEfficiencyPct,
      naivePreservationRatePct,
      popupsNaive: totalPopupsNaive,
      popupsOptimized: totalPopupsOptimized,
      popupsEliminated: Math.max(0, totalPopupsNaive - totalPopupsOptimized),
    },
    chains: chainAudits,
    gasTiming: {
      primary: primaryGasTiming,
      chains: gasTimingChains,
      anyHighGasChain: gasTimingChains.some((g) => g.shouldWait),
      totalPotentialWaitSavingsUsd,
    },
    unlockSchedule,
  };
}
