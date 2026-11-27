import crypto from 'node:crypto';
import {
  CHAIN_LIST,
  computePreservationFee,
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  isCuratedRegistryToken,
  PROTOCOL_FEE_BPS,
  resolveUnderlyingDecimals,
  TOKEN_REGISTRY,
} from './chains.js';
import { fetchLiveUsdPrices, fetchLiveUsdPricesWithStatus } from './prices.js';
import {
  AAVE_V2_LENDING_POOLS,
  computeYearnV2UnderlyingRaw,
  discoverUniswapV3NftPositions,
  encodeErc4626Redeem,
  encodeYearnV2Withdraw,
  type Erc4626VaultState,
  identifyProtocolExtractorId,
  probeErc4626VaultStates,
  probeExpandedDefiContracts,
  resolveDefiExitPlan,
} from '../defi/extractors.js';
import {
  checkAaveV3AccountSafety,
  detectPermit2Allowances,
  discoverChainTokens,
  discoverDefiProtocolPositions,
  fetchDexLiquidityBatch,
  fetchDexLiquidityBatchWithStatus,
  isEip2612Token,
  MIN_VERIFIED_DEX_LIQUIDITY_USD,
  simulateBurnTransferOnchain,
} from './discovery.js';
import { formatUnits, isValidEvmAddress, scanSingleEvmChain } from './rpc.js';
import { computeDefiDisplayMetadata } from './defi-display.js';
import { applyTwoLevelRoiToReport, estimateLiquidityScaledSlippageUsd } from './roi.js';
import type {
  AssetAction,
  ChainScanSummary,
  EvmChainId,
  ScannedAsset,
  ScanReport,
} from './types.js';

export const DEFILLAMA_CHAIN_SLUGS: Partial<Record<EvmChainId, string>> = {
  avalanche: 'avax',
  bnb: 'bsc',
  hyperevm: 'hyperliquid',
  zksync: 'era',
  gnosis: 'xdai',
  berachain: 'berachain',
  ink: 'ink',
};

export interface WalletPreset {
  id: string;
  label: string;
  subtitle: string;
  address: string;
  mode: 'preset' | 'live_rpc';
}

export const WALLET_PRESETS: WalletPreset[] = [
  {
    id: 'veteran_defi',
    label: 'Multi-Chain DeFi Veteran',
    subtitle: '6 chains · Aave/Comp/Lido positions + ERC-20 dust + 4 dead tokens + 1 honeypot',
    address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    mode: 'preset',
  },
  {
    id: 'vitalik_live',
    label: 'vitalik.eth (Live Mainnet RPC)',
    subtitle: 'Real-time Multicall3 scan across Ethereum, Base, Arbitrum, Optimism, Polygon & Avalanche',
    address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    mode: 'live_rpc',
  },
  {
    id: 'airdrop_farmer',
    label: 'L2 Airdrop Dust Wallet',
    subtitle: 'Zero ETH on Arbitrum (gas-sponsored rescue) + fragmented L2 rewards + 3 dead memecoins',
    address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    mode: 'preset',
  },
];

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

function encodeTransferPreview(to: string, rawAmount: bigint): string {
  const cleanTo = to.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const amtHex = rawAmount.toString(16).padStart(64, '0');
  return `0xa9059cbb${cleanTo}${amtHex}`;
}

function encodeAaveWithdrawPreview(asset: string, rawAmount: bigint, to: string): string {
  const a = asset.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const amt = rawAmount.toString(16).padStart(64, '0');
  const r = to.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return `0x69328dec${a}${amt}${r}`;
}

interface RawAssetSeed {
  chain: EvmChainId;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: ScannedAsset['kind'];
  protocol?: string;
  protocolAddress?: string;
  underlyingSymbol?: string;
  underlyingAddress?: string;
  underlyingDecimals?: number;
  rawBalance: bigint;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd?: number;
  honeypot?: boolean;
  permit2Approved?: boolean;
  aaveDebtUsd?: number;
  aaveHealthFactor?: number;
  aaveTotalCollateralUsd?: number;
  aaveLiquidationThresholdBps?: number;
  dexLiquidityVerified?: boolean;
  vaultState?: Erc4626VaultState;
  lpToken0Address?: string;
  lpToken0Symbol?: string;
  lpToken0Decimals?: number;
  lpToken1Address?: string;
  lpToken1Symbol?: string;
  lpToken1Decimals?: number;
  lpRouterAddress?: string;
  lpStable?: boolean;
  expectedUnderlyingRaw?: bigint;
  expectedSecondaryRaw?: bigint;
  nftTokenId?: string;
  nftLiquidity?: string;
  nftManagerAddress?: string;
  protocolUrl?: string;
  protocolLogoUrl?: string;
  defiPositionType?: string;
  defiDebtUsd?: number;
  defiHealthFactor?: number;
  defiUnlockAt?: number;
  defiNetUsd?: number;
  defiDebtSummary?: string;
  isRegistryToken?: boolean;
  pricingUnavailable?: boolean;
  dexLookupFailed?: boolean;
}

function classifyAndBuildReport(params: {
  mode: 'live_rpc' | 'preset';
  walletAddress: string;
  walletLabel?: string;
  startedAtMs: number;
  chainMeta: Map<
    EvmChainId,
    {
      rpcStatus: 'live' | 'preset';
      blockNumber: number;
      gasPriceGwei: number;
      nativeBalance: number;
      nativePriceUsd: number;
    }
  >;
  rawAssets: RawAssetSeed[];
  solPriceUsd: number;
  warnings: string[];
  scannedChains?: typeof CHAIN_LIST;
}): ScanReport {
  const { mode, walletAddress, walletLabel, startedAtMs, chainMeta, rawAssets, solPriceUsd, warnings } =
    params;
  const activeChainConfigs = params.scannedChains ?? CHAIN_LIST;

  // Group count per chain so Permit2 batching amortizes base tx overhead
  const countsPerChain = new Map<EvmChainId, number>();
  for (const item of rawAssets) {
    countsPerChain.set(item.chain, (countsPerChain.get(item.chain) ?? 0) + 1);
  }

  const assets: ScannedAsset[] = rawAssets.map((item, idx) => {
    const chain = EVM_CHAINS[item.chain];
    const meta = chainMeta.get(item.chain) ?? {
      rpcStatus: 'preset' as const,
      blockNumber: 0,
      gasPriceGwei: 1,
      nativeBalance: 0,
      nativePriceUsd: 1680,
    };

    const uiBalance = formatUnits(item.rawBalance, item.decimals);
    const grossUsd = round2(uiBalance * item.priceUsd);
    const gasPriceEth = meta.gasPriceGwei * 1e-9;

    const isDirectUsdc =
      item.kind === 'erc20' && item.address.toLowerCase() === chain.usdcAddress.toLowerCase();

    let singleGasUnits = chain.swapGasUnits;
    if (item.kind === 'defi_position') {
      singleGasUnits =
        chain.defiWithdrawGasUnits + (item.underlyingSymbol === 'USDC' ? 0 : chain.swapGasUnits);
    } else if (item.kind === 'dead_token') {
      singleGasUnits = chain.burnGasUnits;
    } else if (isDirectUsdc) {
      singleGasUnits = Math.round(chain.bridgeGasUnits * 0.5);
    }

    const chainItemCount = Math.max(1, countsPerChain.get(item.chain) ?? 1);
    const estimatedGasUsd = round4(singleGasUnits * gasPriceEth * meta.nativePriceUsd);
    // Batching via TurgaliumRouter saves ~42% gas (eliminates repeated 21k base tx + repeated approvals + shared CCTP burn)
    const batchedGasUsd = round4(
      estimatedGasUsd * (chainItemCount > 1 ? 0.54 : 0.85)
    );

    const estimatedSlippageUsd = estimateLiquidityScaledSlippageUsd({
      grossUsd,
      liquidityUsd: item.liquidityUsd,
      volume24hUsd: item.volume24hUsd,
      isDirectUsdc: isDirectUsdc || item.underlyingSymbol === 'USDC',
      isDead: item.kind === 'dead_token',
    });

    const netUsdcSingle = round2(grossUsd - estimatedGasUsd - estimatedSlippageUsd);
    const netUsdcBatched = round2(grossUsd - batchedGasUsd - estimatedSlippageUsd);

    let action: AssetAction;
    let actionReason: string;
    let selectedByDefault = true;
    let honeypotSafe = true;
    let calldataPreview: string | undefined;

    let defiExitPlan: ScannedAsset['defiExitPlan'];

    const curatedRegistryToken = Boolean(
      item.isRegistryToken || isCuratedRegistryToken(item.chain, item.address)
    );

    if (item.honeypot) {
      action = 'SKIP_HONEYPOT';
      actionReason = 'eth_call transfer simulation reverted (honeypot / transfer-lock). Safely skipped.';
      selectedByDefault = false;
      honeypotSafe = false;
    } else if (
      item.pricingUnavailable ||
      item.dexLookupFailed ||
      (curatedRegistryToken && item.priceUsd <= 0)
    ) {
      action = 'SKIP_UNPRICED';
      actionReason = item.dexLookupFailed
        ? 'DEX liquidity verification failed or timed out — safely skipped (never burned during API outages).'
        : curatedRegistryToken
        ? 'Live price feed unavailable for curated registry token — safely skipped (curated blue-chip tokens are never burned).'
        : 'Price lookup failed or unavailable — safely skipped instead of burning.';
      selectedByDefault = false;
      calldataPreview = undefined;
    } else if (
      !curatedRegistryToken &&
      (item.kind === 'dead_token' || item.liquidityUsd === 0 || item.priceUsd === 0)
    ) {
      action = 'BURN_ZERO_LIQUIDITY';
      actionReason = 'Zero verified DEX liquidity ($0.00). Opt-in burn to 0x…dEaD (unchecked by default to save gas & popups).';
      selectedByDefault = false;
      calldataPreview = encodeTransferPreview(DEAD_BURN_ADDRESS, item.rawBalance);
    } else if (item.kind === 'defi_position') {
      action = 'WITHDRAW_AND_BRIDGE';
      defiExitPlan = resolveDefiExitPlan({
        asset: {
          chain: item.chain,
          address: item.address,
          symbol: item.symbol,
          decimals: item.decimals,
          protocol: item.protocol,
          protocolAddress: item.protocolAddress,
          protocolUrl: item.protocolUrl,
          protocolLogoUrl: item.protocolLogoUrl,
          underlyingSymbol: item.underlyingSymbol,
          underlyingAddress: item.underlyingAddress,
          rawBalance: item.rawBalance.toString(),
          uiBalance: round4(uiBalance),
          priceUsd: item.priceUsd,
          grossUsd,
          liquidityUsd: item.liquidityUsd,
          aaveDebtUsd: item.aaveDebtUsd,
          aaveHealthFactor: item.aaveHealthFactor,
          aaveTotalCollateralUsd: item.aaveTotalCollateralUsd,
          aaveLiquidationThresholdBps: item.aaveLiquidationThresholdBps,
          lpToken0Address: item.lpToken0Address,
          lpToken0Symbol: item.lpToken0Symbol,
          lpToken0Decimals: item.lpToken0Decimals,
          lpToken1Address: item.lpToken1Address,
          lpToken1Symbol: item.lpToken1Symbol,
          lpToken1Decimals: item.lpToken1Decimals,
          lpRouterAddress: item.lpRouterAddress,
          nftTokenId: item.nftTokenId,
          nftManagerAddress: item.nftManagerAddress,
          defiPositionType: item.defiPositionType,
          defiDebtUsd: item.defiDebtUsd,
          defiHealthFactor: item.defiHealthFactor,
          defiUnlockAt: item.defiUnlockAt,
          defiNetUsd: item.defiNetUsd,
          defiDebtSummary: item.defiDebtSummary,
        },
        vaultState: item.vaultState,
        expectedUnderlyingRaw: item.expectedUnderlyingRaw,
        expectedUnderlyingUi:
          item.expectedUnderlyingRaw !== undefined
            ? round4(formatUnits(item.expectedUnderlyingRaw, item.underlyingDecimals ?? item.decimals))
            : undefined,
        expectedSecondaryRaw: item.expectedSecondaryRaw,
        expectedSecondaryUi:
          item.expectedSecondaryRaw !== undefined
            ? round4(formatUnits(item.expectedSecondaryRaw, item.lpToken1Decimals ?? 18))
            : undefined,
      });

      if (defiExitPlan.exitStrategy === 'safe_partial_debt_exit') {
        actionReason = defiExitPlan.preflightReason;
        selectedByDefault = false;
      } else if (defiExitPlan.preflightStatus === 'blocked') {
        actionReason = defiExitPlan.preflightReason;
        selectedByDefault = false;
      } else if (defiExitPlan.exitStrategy === 'direct_swap_bypass_cooldown') {
        actionReason = defiExitPlan.preflightReason;
        selectedByDefault = netUsdcBatched > 0.25;
      } else {
        actionReason =
          item.underlyingSymbol === 'USDC'
            ? `Withdraw from ${item.protocol} directly as native USDC → Solana (Relay / CCTP).`
            : `Withdraw ${item.underlyingSymbol ?? item.symbol} from ${item.protocol} → Solana via Relay / LI.FI.`;
        selectedByDefault = netUsdcBatched > 0.25;
      }
      if (defiExitPlan.protocolId === 'external_protocol') {
        calldataPreview = undefined;
      } else if (defiExitPlan.protocolId === 'yearn_v2') {
        calldataPreview = encodeYearnV2Withdraw(item.rawBalance);
      } else if (defiExitPlan.protocolId === 'erc4626') {
        calldataPreview = encodeErc4626Redeem(item.rawBalance, walletAddress, walletAddress);
      } else {
        calldataPreview = encodeAaveWithdrawPreview(
          item.underlyingAddress || item.address,
          item.rawBalance,
          walletAddress
        );
      }
    } else if (isDirectUsdc) {
      action = 'BRIDGE_DIRECT_USDC';
      actionReason = 'Native USDC — direct route to Solana via Relay (~2s), LI.FI, or Circle CCTP.';
      selectedByDefault = grossUsd > 0.25;
    } else if (netUsdcBatched <= 0.1) {
      action = 'SKIP_GAS_NEGATIVE';
      actionReason = `Gross value ($${grossUsd.toFixed(2)}) is below batched execution gas ($${batchedGasUsd.toFixed(2)}).`;
      selectedByDefault = false;
    } else {
      action = 'SELL_AND_BRIDGE';
      actionReason = `Swap & bridge ${item.symbol} → native Solana USDC/SOL via Relay or LI.FI.`;
      selectedByDefault = true;
    }

    return {
      id: `${item.chain}_${item.symbol.toLowerCase()}_${idx}`,
      chain: item.chain,
      chainName: chain.name,
      address: item.address,
      symbol: item.symbol,
      name: item.name,
      decimals: item.decimals,
      kind: item.kind,
      protocol: item.protocol,
      protocolAddress: item.protocolAddress,
      underlyingSymbol: item.underlyingSymbol,
      underlyingAddress: item.underlyingAddress,
      rawBalance: item.rawBalance.toString(),
      uiBalance: round4(uiBalance),
      priceUsd: item.priceUsd,
      grossUsd,
      liquidityUsd: item.liquidityUsd,
      estimatedGasUsd,
      batchedGasUsd,
      estimatedSlippageUsd,
      netUsdcSingle,
      netUsdcBatched,
      action,
      actionReason,
      selectedByDefault,
      honeypotSafe,
      eip2612Supported:
        item.kind !== 'dead_token' && isEip2612Token(item.chain, item.address, item.symbol),
      permit2Approved: Boolean(item.permit2Approved),
      aaveDebtUsd: item.aaveDebtUsd,
      aaveHealthFactor: item.aaveHealthFactor,
      aaveTotalCollateralUsd: item.aaveTotalCollateralUsd,
      aaveLiquidationThresholdBps: item.aaveLiquidationThresholdBps,
      dexLiquidityVerified: item.dexLiquidityVerified,
      calldataPreview,
      defiExitPlan,
      lpToken0Address: item.lpToken0Address,
      lpToken0Symbol: item.lpToken0Symbol,
      lpToken0Decimals: item.lpToken0Decimals,
      lpToken1Address: item.lpToken1Address,
      lpToken1Symbol: item.lpToken1Symbol,
      lpToken1Decimals: item.lpToken1Decimals,
      lpRouterAddress: item.lpRouterAddress,
      lpStable: item.lpStable,
      nftTokenId: item.nftTokenId,
      nftLiquidity: item.nftLiquidity,
      nftManagerAddress: item.nftManagerAddress,
      protocolUrl: item.protocolUrl,
      protocolLogoUrl: item.protocolLogoUrl,
      defiPositionType: item.defiPositionType,
      defiDebtUsd: item.defiDebtUsd,
      defiHealthFactor: item.defiHealthFactor,
      defiUnlockAt: item.defiUnlockAt,
      defiNetUsd: item.defiNetUsd,
      defiDebtSummary: item.defiDebtSummary,
      defiDisplay:
        item.kind === 'defi_position'
          ? computeDefiDisplayMetadata({
              chain: item.chain,
              family: 'evm',
              symbol: item.symbol,
              name: item.name,
              uiBalance,
              protocol: item.protocol,
              underlyingSymbol: item.underlyingSymbol,
              aaveDebtUsd: item.aaveDebtUsd,
              defiDebtUsd: item.defiDebtUsd,
              defiUnlockAt: item.defiUnlockAt,
              defiExitPlan,
            })
          : undefined,
    };
  });

  // Build per-chain summaries
  const chains: ChainScanSummary[] = activeChainConfigs.map((c) => {
    const meta = chainMeta.get(c.id) ?? {
      rpcStatus: 'preset' as const,
      blockNumber: 0,
      gasPriceGwei: 1,
      nativeBalance: 0,
      nativePriceUsd: 1680,
    };
    const chainAssets = assets.filter((a) => a.chain === c.id);
    const activeSweep = chainAssets.filter(
      (a) =>
        a.action === 'WITHDRAW_AND_BRIDGE' ||
        a.action === 'SELL_AND_BRIDGE' ||
        a.action === 'BRIDGE_DIRECT_USDC'
    );
    const grossUsd = round2(activeSweep.reduce((s, a) => s + a.grossUsd, 0));
    const singleGas = round4(chainAssets.reduce((s, a) => s + a.estimatedGasUsd, 0));
    const batchedGas = round4(chainAssets.reduce((s, a) => s + a.batchedGasUsd, 0));
    const slippage = round2(activeSweep.reduce((s, a) => s + a.estimatedSlippageUsd, 0));
    const chainFeeBase = Math.max(0, grossUsd - slippage);
    const useEnvFlatFee = Boolean(process.env.TURGALIUM_FEE_BPS?.trim());
    const fee = useEnvFlatFee
      ? round2((chainFeeBase * PROTOCOL_FEE_BPS) / 10_000)
      : computePreservationFee(chainFeeBase).feeUsd;
    const netUsdcBridged = round2(Math.max(0, grossUsd - slippage - batchedGas - fee));

    return {
      chain: c.id,
      chainName: c.name,
      chainId: c.chainId,
      cctpDomain: c.cctpDomain,
      rpcStatus: meta.rpcStatus,
      blockNumber: meta.blockNumber,
      gasPriceGwei: Number(meta.gasPriceGwei.toFixed(3)),
      nativeBalance: round4(meta.nativeBalance),
      nativeSymbol: c.nativeSymbol,
      nativePriceUsd: round2(meta.nativePriceUsd),
      assetCount: chainAssets.length,
      defiCount: chainAssets.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE').length,
      liquidCount: chainAssets.filter(
        (a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC'
      ).length,
      burnCount: chainAssets.filter((a) => a.action === 'BURN_ZERO_LIQUIDITY').length,
      skippedCount: chainAssets.filter(
        (a) =>
          a.action === 'SKIP_HONEYPOT' ||
          a.action === 'SKIP_GAS_NEGATIVE' ||
          a.action === 'SKIP_NEGATIVE_ROI' ||
          a.action === 'SKIP_UNPRICED'
      ).length,
      grossUsd,
      netUsdcBridged,
      totalGasUsd: round2(batchedGas),
      gasSavedByBatchUsd: round2(Math.max(0, singleGas - batchedGas)),
      cctpAttestationSec: c.cctpAttestationSec,
      needsGasSponsorship:
        activeSweep.length > 0 &&
        meta.nativeBalance * meta.nativePriceUsd < Math.max(0.25, batchedGas * 1.35),
    };
  });

  const activeAll = assets.filter(
    (a) =>
      a.action === 'WITHDRAW_AND_BRIDGE' ||
      a.action === 'SELL_AND_BRIDGE' ||
      a.action === 'BRIDGE_DIRECT_USDC'
  );
  const grossUsd = round2(activeAll.reduce((s, a) => s + a.grossUsd, 0));
  const defiGrossUsd = round2(
    activeAll.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE').reduce((s, a) => s + a.grossUsd, 0)
  );
  const liquidGrossUsd = round2(grossUsd - defiGrossUsd);
  const singleTxGasUsd = round2(assets.reduce((s, a) => s + a.estimatedGasUsd, 0));
  const batchedGasUsd = round2(assets.reduce((s, a) => s + a.batchedGasUsd, 0));
  const gasSavedUsd = round2(Math.max(0, singleTxGasUsd - batchedGasUsd));
  const estimatedSlippageUsd = round2(activeAll.reduce((s, a) => s + a.estimatedSlippageUsd, 0));
  const useEnvFlatFee = Boolean(process.env.TURGALIUM_FEE_BPS?.trim());
  const totalFeeBase = Math.max(0, grossUsd - estimatedSlippageUsd);
  const totalPreservation = useEnvFlatFee ? null : computePreservationFee(totalFeeBase);
  const protocolFeeUsd = totalPreservation
    ? totalPreservation.feeUsd
    : round2((totalFeeBase * PROTOCOL_FEE_BPS) / 10_000);
  const effectiveReportFeeBps = totalPreservation
    ? Math.max(0, Math.round(totalPreservation.effectiveFeeBps))
    : PROTOCOL_FEE_BPS;
  const netSolanaUsdc = round2(
    Math.max(0, grossUsd - estimatedSlippageUsd - batchedGasUsd - protocolFeeUsd)
  );

  const report: ScanReport = {
    scanId: `scan_${crypto.randomBytes(5).toString('hex')}`,
    mode,
    walletAddress,
    walletLabel,
    scannedAt: new Date().toISOString(),
    scanDurationMs: Math.max(1, Math.round(performance.now() - startedAtMs)),
    chainsScanned: chains.length,
    chains,
    assets,
    totals: {
      grossUsd,
      defiGrossUsd,
      liquidGrossUsd,
      protocolFeeBps: effectiveReportFeeBps,
      protocolFeeUsd,
      singleTxGasUsd,
      batchedGasUsd,
      gasSavedUsd,
      estimatedSlippageUsd,
      netSolanaUsdc,
      solEquivalent: solPriceUsd > 0 ? round4(netSolanaUsdc / solPriceUsd) : 0,
      solPriceUsd: round2(solPriceUsd),
      defiPositionCount: assets.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE').length,
      liquidDustCount: assets.filter(
        (a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC'
      ).length,
      burnCandidateCount: assets.filter((a) => a.action === 'BURN_ZERO_LIQUIDITY').length,
      honeypotSkippedCount: assets.filter((a) => a.action === 'SKIP_HONEYPOT').length,
      gasNegativeCount: assets.filter((a) => a.action === 'SKIP_GAS_NEGATIVE').length,
    },
    warnings,
  };

  return applyTwoLevelRoiToReport(report);
}

export interface ScanLiveWalletOptions {
  chains?: EvmChainId[];
  onChainProgress?: (info: {
    chain: EvmChainId;
    chainName: string;
    completed: number;
    total: number;
    assetCount: number;
    ok: boolean;
  }) => void;
}

/**
 * Runs a REAL live multi-chain EVM scan across all configured EVM chains in parallel
 * using Multicall3 (`aggregate3`) + real DeFiLlama USD prices + parallel per-chain enrichment.
 */
export async function scanLiveWallet(
  walletAddress: string,
  label?: string,
  options?: ScanLiveWalletOptions
): Promise<ScanReport> {
  const cleanAddr = walletAddress.trim();
  if (!isValidEvmAddress(cleanAddr)) {
    throw new Error('Invalid EVM wallet address (expected 0x followed by 40 hex characters).');
  }

  const startedAtMs = performance.now();
  const warnings: string[] = [];

  const requestedSet =
    options?.chains && options.chains.length > 0
      ? new Set(options.chains.map((c) => c.toLowerCase() as EvmChainId))
      : null;
  const targetChains = requestedSet
    ? CHAIN_LIST.filter((c) => requestedSet.has(c.id))
    : CHAIN_LIST;
  if (targetChains.length === 0) {
    throw new Error('No valid EVM chains specified for scan.');
  }
  const targetChainSet = new Set(targetChains.map((c) => c.id));

  // 1. Parallel RPC scans across all target chains + live USD prices from DeFiLlama
  const llamaKeys = [
    'coingecko:solana',
    ...targetChains.map((c) => c.nativeLlamaId),
    ...TOKEN_REGISTRY.filter((t) => targetChainSet.has(t.chain))
      .map((t) => t.llamaKey)
      .filter((k): k is string => Boolean(k)),
  ];

  const [priceStatus, discoveredByChainArr, discoveredProtocolPositions, ...chainOutputs] = await Promise.all([
    fetchLiveUsdPricesWithStatus(llamaKeys),
    Promise.all(
      targetChains.map(async (c) => [c.id, await discoverChainTokens(c.id, cleanAddr, 24)] as const)
    ),
    discoverDefiProtocolPositions(cleanAddr),
    ...targetChains.map((c) =>
      scanSingleEvmChain(
        c,
        cleanAddr,
        TOKEN_REGISTRY.filter((t) => t.chain === c.id)
      )
    ),
  ]);
  const prices = priceStatus.prices;
  if (priceStatus.hadError) {
    warnings.push(
      'DeFiLlama live price feed partially failed or timed out — using verified fallback prices and skipping unpriced assets safely.'
    );
  }
  const discoveredByChain = new Map(discoveredByChainArr);

  const solPriceUsd = prices.get('coingecko:solana') ?? 70;
  const chainMeta = new Map<
    EvmChainId,
    {
      rpcStatus: 'live' | 'preset';
      blockNumber: number;
      gasPriceGwei: number;
      nativeBalance: number;
      nativePriceUsd: number;
    }
  >();

  let completedChains = 0;
  const totalChains = chainOutputs.length;

  // 2. Enrich ALL chains in parallel (DexScreener liquidity, DeFi probing, honeypot sims, Uni v3 NFTs)
  const perChainResults = await Promise.all(
    chainOutputs.map(async (out) => {
      const c = out.chain;
      const chainAssets: RawAssetSeed[] = [];
      const chainWarnings: string[] = [];
      const nativePrice = prices.get(c.nativeLlamaId) ?? 1680;
      const gasPriceGwei = Number(out.gasPriceWei) / 1e9;
      const nativeUi = formatUnits(out.nativeBalanceWei, 18);

      chainMeta.set(c.id, {
        rpcStatus: out.ok ? 'live' : 'preset',
        blockNumber: out.blockNumber,
        gasPriceGwei: Math.max(0.001, gasPriceGwei),
        nativeBalance: nativeUi,
        nativePriceUsd: nativePrice,
      });

      if (!out.ok) {
        chainWarnings.push(`${c.name} RPC timed out (${out.error ?? 'unavailable'}).`);
        completedChains += 1;
        options?.onChainProgress?.({
          chain: c.id,
          chainName: c.name,
          completed: completedChains,
          total: totalChains,
          assetCount: 0,
          ok: false,
        });
        return { chainAssets, chainWarnings };
      }

      // Reserve each chain's configured native gas buffer so users aren't stranded on follow-up txs or low-unit-price chains
      const gasReserve = c.gasReserveNative;
      if (nativeUi > gasReserve) {
        const reserveWei = BigInt(Math.round(gasReserve * 1e9)) * 1_000_000_000n;
        const sweepableWei = out.nativeBalanceWei - reserveWei;
        if (sweepableWei > 0n) {
          chainAssets.push({
            chain: c.id,
            address: 'native',
            symbol: c.nativeSymbol,
            name: `${c.name} Native ${c.nativeSymbol} (ex-gas reserve)`,
            decimals: 18,
            kind: 'native',
            rawBalance: sweepableWei,
            priceUsd: nativePrice,
            liquidityUsd: 100_000_000,
          });
        }
      }

      const chainTokens = TOKEN_REGISTRY.filter((t) => t.chain === c.id);
      const seenAddrs = new Set<string>();
      for (const tok of chainTokens) {
        const rawBal = out.tokenBalances.get(tok.address.toLowerCase());
        if (!rawBal || rawBal === 0n) continue;
        seenAddrs.add(tok.address.toLowerCase());
        const priceUsd = (tok.llamaKey ? prices.get(tok.llamaKey) : undefined) ?? 0;
        const pricingUnavailable = priceUsd <= 0;
        chainAssets.push({
          chain: c.id,
          address: tok.address,
          symbol: tok.symbol,
          name: tok.name,
          decimals: tok.decimals,
          kind: tok.kind,
          protocol: tok.protocol,
          protocolAddress: tok.protocolAddress,
          underlyingSymbol: tok.underlyingSymbol,
          underlyingAddress: tok.underlyingAddress,
          rawBalance: rawBal,
          priceUsd,
          liquidityUsd: priceUsd > 0 ? 5_000_000 : 0,
          isRegistryToken: true,
          pricingUnavailable,
        });
      }

      // Start Uniswap v3 / Aerodrome CL NFT discovery concurrently with discovered ERC-20 enrichment
      const nftPositionsPromise = discoverUniswapV3NftPositions(c.id, cleanAddr, 4).catch(() => []);

      // Merge real discovered arbitrary ERC-20s with live DexScreener liquidity verification
      // and expanded DeFi protocol auto-probing (Aave v2/v3, ERC-4626, Compound v2/Venus/Benqi, Uni v2/Aero v2 LP)
      const discoveredChainTokens = discoveredByChain.get(c.id) ?? [];
      if (discoveredChainTokens.length > 0) {
        const novelTokens = discoveredChainTokens.filter((dt) => !seenAddrs.has(dt.address.toLowerCase()));
        const novelBalancesMap = new Map(novelTokens.map((dt) => [dt.address.toLowerCase(), dt.rawBalance]));
        const [dexLiquidityResult, defiReceiptMap] = await Promise.all([
          fetchDexLiquidityBatchWithStatus(
            c.id,
            novelTokens.map((dt) => dt.address)
          ),
          probeExpandedDefiContracts({
            chain: c.id,
            tokenAddresses: novelTokens.map((dt) => dt.address),
            rawBalances: novelBalancesMap,
          }),
        ]);
        const dexLiquidityMap = dexLiquidityResult.liquidity;
        if (!dexLiquidityResult.ok && novelTokens.length > 0) {
          chainWarnings.push(
            `${c.name} DexScreener liquidity lookup failed (${dexLiquidityResult.error ?? 'unavailable'}) — unverified tokens safely skipped instead of burned.`
          );
        }

        // Fetch prices for any auto-detected DeFi underlying assets (ERC-4626 / Yearn v2 / Aave / Compound v2 / LP token0+token1)
        const defiUnderlyings = Array.from(defiReceiptMap.values()).flatMap((d) =>
          d.secondaryUnderlyingAddress ? [d.underlyingAddress, d.secondaryUnderlyingAddress] : [d.underlyingAddress]
        );
        const llamaChainSlug = DEFILLAMA_CHAIN_SLUGS[c.id] ?? c.id;
        const [underlyingDexMap, underlyingLlamaMap] = defiUnderlyings.length
          ? await Promise.all([
              fetchDexLiquidityBatch(c.id, defiUnderlyings),
              fetchLiveUsdPrices(defiUnderlyings.map((u) => `${llamaChainSlug}:${u}`)),
            ])
          : [new Map(), new Map<string, number>()];

        const liquidCandidates: Array<{
          dt: (typeof novelTokens)[number];
          verifiedLiq: number;
          verifiedPrice: number;
          volume24hUsd: number;
          isRegistry: boolean;
        }> = [];
        const extraDead: typeof novelTokens = [];
        for (const dt of novelTokens) {
          if (seenAddrs.has(dt.address.toLowerCase())) continue;
          seenAddrs.add(dt.address.toLowerCase());

          const defiReceipt = defiReceiptMap.get(dt.address.toLowerCase());
          if (defiReceipt) {
            const isUsdcUnderlying =
              defiReceipt.underlyingAddress.toLowerCase() === c.usdcAddress.toLowerCase();
            const uDex = underlyingDexMap.get(defiReceipt.underlyingAddress.toLowerCase());
            const uLlama = underlyingLlamaMap.get(`${llamaChainSlug}:${defiReceipt.underlyingAddress}`);
            const uPriceUsd = isUsdcUnderlying ? 1.0 : uDex?.priceUsd || uLlama || 0;

            if (defiReceipt.protocolId === 'uniswap_v2_lp' && defiReceipt.secondaryUnderlyingAddress) {
              const isUsdc1 =
                defiReceipt.secondaryUnderlyingAddress.toLowerCase() === c.usdcAddress.toLowerCase();
              const u1Dex = underlyingDexMap.get(defiReceipt.secondaryUnderlyingAddress.toLowerCase());
              const u1Llama = underlyingLlamaMap.get(`${llamaChainSlug}:${defiReceipt.secondaryUnderlyingAddress}`);
              const u1PriceUsd = isUsdc1 ? 1.0 : u1Dex?.priceUsd || u1Llama || 0;
              const dec0 = resolveUnderlyingDecimals({
                chain: c.id,
                underlyingAddress: defiReceipt.underlyingAddress,
                fallbackDecimals: 18,
              });
              const dec1 = resolveUnderlyingDecimals({
                chain: c.id,
                underlyingAddress: defiReceipt.secondaryUnderlyingAddress,
                fallbackDecimals: 18,
              });
              const ui0 = defiReceipt.expectedUnderlyingRaw
                ? formatUnits(defiReceipt.expectedUnderlyingRaw, dec0)
                : 0;
              const ui1 = defiReceipt.expectedSecondaryRaw
                ? formatUnits(defiReceipt.expectedSecondaryRaw, dec1)
                : 0;
              const lpTotalUsd = ui0 * uPriceUsd + ui1 * u1PriceUsd;
              const lpUi = formatUnits(dt.rawBalance, dt.decimals);
              const effectiveLpPrice = lpUi > 0 ? lpTotalUsd / lpUi : 0;
              if (lpTotalUsd > 0 && effectiveLpPrice > 0) {
                chainAssets.push({
                  chain: c.id,
                  address: dt.address,
                  symbol: dt.symbol,
                  name: dt.name,
                  decimals: dt.decimals,
                  kind: 'defi_position',
                  protocol: defiReceipt.protocol,
                  protocolAddress: defiReceipt.protocolAddress,
                  underlyingSymbol: isUsdcUnderlying ? 'USDC' : 'TOKEN0',
                  underlyingAddress: defiReceipt.underlyingAddress,
                  lpToken0Address: defiReceipt.underlyingAddress,
                  lpToken0Symbol: isUsdcUnderlying ? 'USDC' : 'TOKEN0',
                  lpToken0Decimals: dec0,
                  lpToken1Address: defiReceipt.secondaryUnderlyingAddress,
                  lpToken1Symbol: isUsdc1 ? 'USDC' : 'TOKEN1',
                  lpToken1Decimals: dec1,
                  lpRouterAddress: defiReceipt.lpRouterAddress,
                  lpStable: defiReceipt.lpStable,
                  expectedUnderlyingRaw: defiReceipt.expectedUnderlyingRaw,
                  expectedSecondaryRaw: defiReceipt.expectedSecondaryRaw,
                  rawBalance: dt.rawBalance,
                  priceUsd: effectiveLpPrice,
                  liquidityUsd: Math.max(500_000, (uDex?.liquidityUsd ?? 0) + (u1Dex?.liquidityUsd ?? 0)),
                  dexLiquidityVerified: true,
                });
                continue;
              }
            }

            if (uPriceUsd > 0) {
              let effectivePriceUsd = uPriceUsd;
              let expectedUnderlyingRaw = defiReceipt.expectedUnderlyingRaw;
              let underlyingSymbol = isUsdcUnderlying ? 'USDC' : dt.symbol.replace(/^[ascv]/i, '');
              let underlyingDecimals = isUsdcUnderlying ? 6 : dt.decimals;

              if (defiReceipt.protocolId === 'compound_v2' && defiReceipt.expectedUnderlyingRaw) {
                const uDec = isUsdcUnderlying ? 6 : 18;
                underlyingDecimals = uDec;
                const expectedUi = formatUnits(defiReceipt.expectedUnderlyingRaw, uDec);
                const cUi = formatUnits(dt.rawBalance, dt.decimals);
                if (cUi > 0 && expectedUi > 0) {
                  effectivePriceUsd = (expectedUi * uPriceUsd) / cUi;
                }
              } else if (defiReceipt.protocolId === 'yearn_v2' && defiReceipt.exchangeRateStored) {
                underlyingSymbol = isUsdcUnderlying
                  ? 'USDC'
                  : dt.symbol.replace(/^yv/i, '') || dt.symbol;
                underlyingDecimals = dt.decimals;
                expectedUnderlyingRaw = computeYearnV2UnderlyingRaw(
                  dt.rawBalance,
                  defiReceipt.exchangeRateStored,
                  dt.decimals
                );
                const expectedUi = formatUnits(expectedUnderlyingRaw, dt.decimals);
                const shareUi = formatUnits(dt.rawBalance, dt.decimals);
                if (shareUi > 0 && expectedUi > 0) {
                  effectivePriceUsd = (expectedUi * uPriceUsd) / shareUi;
                }
              }

              chainAssets.push({
                chain: c.id,
                address: dt.address,
                symbol: dt.symbol,
                name: dt.name,
                decimals: dt.decimals,
                kind: 'defi_position',
                protocol: defiReceipt.protocol,
                protocolAddress: defiReceipt.protocolAddress,
                underlyingSymbol,
                underlyingAddress: defiReceipt.underlyingAddress,
                underlyingDecimals,
                expectedUnderlyingRaw,
                rawBalance: dt.rawBalance,
                priceUsd: effectivePriceUsd,
                liquidityUsd: isUsdcUnderlying ? 100_000_000 : Math.max(5_000_000, uDex?.liquidityUsd ?? 5_000_000),
                dexLiquidityVerified: true,
              });
              continue;
            }
          }

          const addrLower = dt.address.toLowerCase();
          const dex = dexLiquidityMap.get(addrLower);
          const verifiedLiq = dex?.liquidityUsd ?? 0;
          const verifiedPrice = dex && dex.priceUsd > 0 ? dex.priceUsd : 0;
          const verifiedVol24h = dex?.volume24hUsd ?? 0;
          const isRegistry = isCuratedRegistryToken(c.id, dt.address);
          const dexCheckedCleanly =
            dexLiquidityResult.ok && dexLiquidityResult.queriedAddresses.has(addrLower);

          // Require verified DEX liquidity >= $2,500 before counting a discovered long-tail token as sellable USD
          if (verifiedLiq >= MIN_VERIFIED_DEX_LIQUIDITY_USD && verifiedPrice > 0) {
            liquidCandidates.push({
              dt,
              verifiedLiq,
              verifiedPrice,
              volume24hUsd: verifiedVol24h,
              isRegistry,
            });
          } else if (!dexCheckedCleanly || isRegistry || verifiedLiq >= MIN_VERIFIED_DEX_LIQUIDITY_USD) {
            // CRIT-08 / HIGH-07: When DexScreener lookup fails/times out, token is in curated TOKEN_REGISTRY,
            // or verified liquidity >= $2,500 without derivable spot price,
            // NEVER classify as BURN_ZERO_LIQUIDITY — fail closed to SKIP_UNPRICED.
            chainAssets.push({
              chain: c.id,
              address: dt.address,
              symbol: dt.symbol,
              name: dt.name,
              decimals: dt.decimals,
              kind: 'erc20',
              rawBalance: dt.rawBalance,
              priceUsd: 0,
              liquidityUsd: Math.round(verifiedLiq),
              dexLiquidityVerified: verifiedLiq >= MIN_VERIFIED_DEX_LIQUIDITY_USD,
              isRegistryToken: isRegistry,
              dexLookupFailed: !dexCheckedCleanly,
              pricingUnavailable: isRegistry || verifiedLiq >= MIN_VERIFIED_DEX_LIQUIDITY_USD,
            });
          } else if (extraDead.length < 6) {
            extraDead.push(dt);
          }
        }

        // HIGH-07: Live onchain eth_call transfer/honeypot verification across ALL novel discovered ERC-20s
        // (both >= $2,500 LP liquid candidates AND < $2,500 LP / zero-liquidity candidates)
        // so transfer-locked phishing tokens with >= $2,500 locked LP are caught as SKIP_HONEYPOT!
        const simTargets = [
          ...liquidCandidates.filter((item) => !item.isRegistry).map((item) => item.dt),
          ...extraDead,
        ];
        const simByAddr = new Map<string, { safeToBurn: boolean; reason: string }>();
        if (simTargets.length > 0) {
          const simChecks = await Promise.all(
            simTargets.map((dt) =>
              simulateBurnTransferOnchain({
                chain: c.id,
                walletAddress: cleanAddr,
                tokenAddress: dt.address,
                rawAmount: dt.rawBalance,
              })
            )
          );
          simTargets.forEach((dt, idx) => {
            simByAddr.set(dt.address.toLowerCase(), simChecks[idx]);
          });
        }

        for (const item of liquidCandidates) {
          const sim = simByAddr.get(item.dt.address.toLowerCase());
          chainAssets.push({
            chain: c.id,
            address: item.dt.address,
            symbol: item.dt.symbol,
            name: item.dt.name,
            decimals: item.dt.decimals,
            kind: 'erc20',
            rawBalance: item.dt.rawBalance,
            priceUsd: item.verifiedPrice,
            liquidityUsd: Math.round(item.verifiedLiq),
            volume24hUsd: item.volume24hUsd,
            honeypot: sim ? !sim.safeToBurn : false,
            dexLiquidityVerified: true,
            isRegistryToken: item.isRegistry,
          });
        }

        for (const dt of extraDead) {
          const sim = simByAddr.get(dt.address.toLowerCase());
          chainAssets.push({
            chain: c.id,
            address: dt.address,
            symbol: dt.symbol,
            name: dt.name,
            decimals: dt.decimals,
            kind: 'dead_token',
            rawBalance: dt.rawBalance,
            priceUsd: 0,
            liquidityUsd: 0,
            honeypot: sim ? !sim.safeToBurn : false,
            dexLiquidityVerified: false,
          });
        }
      }

      const nftPositions = await nftPositionsPromise;
      for (const nft of nftPositions) {
        const t0IsUsdc = nft.position.token0.toLowerCase() === c.usdcAddress.toLowerCase();
        const t1IsUsdc = nft.position.token1.toLowerCase() === c.usdcAddress.toLowerCase();
        const sym0 = t0IsUsdc ? 'USDC' : 'TOKEN0';
        const sym1 = t1IsUsdc ? 'USDC' : 'TOKEN1';
        chainAssets.push({
          chain: c.id,
          address: nft.managerAddress,
          symbol: `UNI-V3-#${nft.position.tokenId.toString()}`,
          name: `${nft.protocol} Position #${nft.position.tokenId.toString()}`,
          decimals: 0,
          kind: 'defi_position',
          protocol: nft.protocol,
          protocolAddress: nft.managerAddress,
          underlyingSymbol: sym0,
          underlyingAddress: nft.position.token0,
          lpToken0Address: nft.position.token0,
          lpToken0Symbol: sym0,
          lpToken0Decimals: resolveUnderlyingDecimals({
            chain: c.id,
            underlyingAddress: nft.position.token0,
            fallbackDecimals: 18,
          }),
          lpToken1Address: nft.position.token1,
          lpToken1Symbol: sym1,
          lpToken1Decimals: resolveUnderlyingDecimals({
            chain: c.id,
            underlyingAddress: nft.position.token1,
            fallbackDecimals: 18,
          }),
          nftTokenId: nft.position.tokenId.toString(),
          nftLiquidity: nft.position.liquidity.toString(),
          nftManagerAddress: nft.managerAddress,
          rawBalance: nft.position.liquidity > 0n ? nft.position.liquidity : 1n,
          priceUsd: 0,
          liquidityUsd: 5_000_000,
          dexLiquidityVerified: true,
        });
      }

      completedChains += 1;
      options?.onChainProgress?.({
        chain: c.id,
        chainName: c.name,
        completed: completedChains,
        total: totalChains,
        assetCount: chainAssets.length,
        ok: true,
      });

      return { chainAssets, chainWarnings };
    })
  );

  const rawAssets: RawAssetSeed[] = [];
  for (const res of perChainResults) {
    rawAssets.push(...res.chainAssets);
    warnings.push(...res.chainWarnings);
  }

  // Merge protocol-indexed DeFi positions (lending, locked/veNFT, staking, margin deposits, vaults)
  // while deduplicating against any onchain-probed receipt tokens (Aave, Compound, ERC-4626, Yearn v2, Uni LP)
  if (discoveredProtocolPositions.length > 0) {
    const onchainDefiAssets = rawAssets.filter((a) => a.kind === 'defi_position');
    const existingDefiByPool = new Map<string, RawAssetSeed>();
    for (const a of onchainDefiAssets) {
      existingDefiByPool.set(`${a.chain}:${a.address.toLowerCase()}`, a);
      if (a.protocolAddress) {
        existingDefiByPool.set(`${a.chain}:${a.protocolAddress.toLowerCase()}`, a);
      }
    }

    const toSafeRawBalance = (amount: number, decimals: number): bigint => {
      if (!Number.isFinite(amount) || amount <= 0) return 1n;
      const dec = Math.min(18, Math.max(0, Math.round(decimals)));
      const fixed = amount.toFixed(Math.min(8, dec));
      const [intPart, fracPart = ''] = fixed.split('.');
      const paddedFrac = fracPart.padEnd(dec, '0').slice(0, dec);
      try {
        const val = BigInt(`${intPart || '0'}${paddedFrac}`);
        return val > 0n ? val : 1n;
      } catch {
        return 1n;
      }
    };

    for (const pos of discoveredProtocolPositions) {
      if (!targetChainSet.has(pos.chain)) continue;
      const poolKey = `${pos.chain}:${pos.poolAddress.toLowerCase()}`;
      const existing = existingDefiByPool.get(poolKey);
      if (existing) {
        // Enrich onchain-detected position (e.g. Yearn v2 yvOP/yvUSDT) with protocol logo & URL, don't duplicate
        if (!existing.protocolUrl && pos.protocolSiteUrl) existing.protocolUrl = pos.protocolSiteUrl;
        if (!existing.protocolLogoUrl && pos.protocolLogoUrl) existing.protocolLogoUrl = pos.protocolLogoUrl;
        continue;
      }

      // Also skip if an onchain Aave/Compound/Lido position on the same chain already covers this protocol + underlying
      const primaryList = pos.supplyTokens.length ? pos.supplyTokens : pos.rewardTokens;
      const sorted = [...primaryList].sort((a, b) => b.amount * b.priceUsd - a.amount * a.priceUsd);
      const primary = sorted[0];
      if (!primary) continue;

      const protoLow = pos.protocolName.toLowerCase();
      const duplicateNative = onchainDefiAssets.some(
        (a) =>
          a.chain === pos.chain &&
          a.underlyingAddress &&
          primary.address !== 'native' &&
          a.underlyingAddress.toLowerCase() === primary.address.toLowerCase() &&
          (a.protocol ?? '').toLowerCase().includes(protoLow.split(' ')[0])
      );
      if (duplicateNative) continue;

      const decimals = Math.min(18, Math.max(0, primary.decimals));
      const rawBalance = toSafeRawBalance(primary.amount, decimals);
      const effectivePriceUsd =
        primary.priceUsd > 0
          ? primary.priceUsd
          : primary.amount > 0 && pos.assetUsdValue > 0
          ? pos.assetUsdValue / primary.amount
          : 0;
      if (effectivePriceUsd <= 0) continue;

      const debtSummary =
        pos.borrowTokens.length > 0
          ? pos.borrowTokens
              .map((b) => {
                const usd = b.amount * b.priceUsd;
                return `${b.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${b.symbol} ($${usd.toFixed(2)})`;
              })
              .join(' + ') + ' borrowed'
          : undefined;

      rawAssets.push({
        chain: pos.chain,
        address: pos.poolAddress,
        symbol: primary.symbol,
        name: pos.description
          ? `${pos.protocolName} · ${pos.description}`
          : `${pos.protocolName} ${pos.positionType} (${primary.symbol})`,
        decimals,
        kind: 'defi_position',
        protocol: pos.protocolName,
        protocolAddress: pos.poolAddress,
        protocolUrl: pos.protocolSiteUrl,
        protocolLogoUrl: pos.protocolLogoUrl,
        underlyingSymbol: primary.symbol,
        underlyingAddress: primary.address !== 'native' ? primary.address : undefined,
        underlyingDecimals: decimals,
        rawBalance,
        priceUsd: effectivePriceUsd,
        liquidityUsd: 1_000_000,
        dexLiquidityVerified: true,
        defiPositionType: pos.positionType,
        defiDebtUsd: pos.debtUsdValue > 0 ? pos.debtUsdValue : undefined,
        defiHealthFactor: pos.healthRate,
        defiUnlockAt: pos.unlockAt,
        defiNetUsd: pos.netUsdValue,
        defiDebtSummary: debtSummary,
      });
    }
  }

  // Run ERC-4626 vault probes, Aave debt safety checks, and Permit2 Multicall3 allowance checks
  // in a SINGLE parallel fan-out (eliminating a serial RPC round-trip waterfall on every EVM scan).
  const erc4626ByChain = new Map<EvmChainId, RawAssetSeed[]>();
  const aavePoolKeys = new Map<string, { chain: EvmChainId; poolAddress?: string }>();
  const erc20ByChain = new Map<EvmChainId, string[]>();
  for (const a of rawAssets) {
    if (a.kind === 'defi_position' && identifyProtocolExtractorId(a) === 'erc4626') {
      const list = erc4626ByChain.get(a.chain) ?? [];
      list.push(a);
      erc4626ByChain.set(a.chain, list);
    }
    if (a.kind === 'defi_position' && (a.protocol ?? '').toLowerCase().includes('aave')) {
      const isV2 = (a.protocol ?? '').toLowerCase().includes('aave v2');
      const poolAddress =
        a.protocolAddress || (isV2 ? AAVE_V2_LENDING_POOLS[a.chain] : EVM_CHAINS[a.chain].aaveV3Pool);
      const key = `${a.chain}:${(poolAddress ?? '').toLowerCase()}`;
      aavePoolKeys.set(key, { chain: a.chain, poolAddress });
    }
    if (a.address !== 'native' && a.kind !== 'dead_token' && !a.honeypot) {
      const list = erc20ByChain.get(a.chain) ?? [];
      list.push(a.address);
      erc20ByChain.set(a.chain, list);
    }
  }

  const [vaultResults, aaveChecks, permit2Checks] = await Promise.all([
    erc4626ByChain.size > 0
      ? Promise.all(
          Array.from(erc4626ByChain.entries()).map(async ([chain, seeds]) => {
            const map = await probeErc4626VaultStates({
              chain,
              owner: cleanAddr,
              vaults: seeds.map((s) => ({
                address: s.protocolAddress || s.address,
                rawBalance: s.rawBalance,
                decimals: s.decimals,
                underlyingDecimals: resolveUnderlyingDecimals({
                  chain,
                  underlyingAddress: s.underlyingAddress,
                  explicitDecimals: s.underlyingDecimals,
                  fallbackDecimals: s.decimals,
                }),
              })),
            });
            return [chain, map] as const;
          })
        )
      : Promise.resolve([]),
    aavePoolKeys.size > 0
      ? Promise.all(
          Array.from(aavePoolKeys.entries()).map(async ([key, { chain, poolAddress }]) => [
            key,
            await checkAaveV3AccountSafety(chain, cleanAddr, poolAddress),
          ] as const)
        )
      : Promise.resolve([]),
    Promise.all(
      Array.from(erc20ByChain.entries()).map(async ([chain, tokenAddresses]) => {
        const approved = await detectPermit2Allowances({
          chain,
          owner: cleanAddr,
          tokenAddresses,
        });
        return [chain, approved] as const;
      })
    ),
  ]);

  if (vaultResults.length > 0) {
    const vaultMapByChain = new Map(vaultResults);
    for (const a of rawAssets) {
      if (a.kind !== 'defi_position' || identifyProtocolExtractorId(a) !== 'erc4626') continue;
      const vState = vaultMapByChain.get(a.chain)?.get((a.protocolAddress || a.address).toLowerCase());
      if (!vState) continue;
      a.vaultState = vState;
      a.expectedUnderlyingRaw = vState.expectedUnderlyingRaw;
      // Re-price share value accurately using convertToAssets/previewRedeem when priced from underlying token
      const uDec = resolveUnderlyingDecimals({
        chain: a.chain,
        underlyingAddress: a.underlyingAddress,
        explicitDecimals: a.underlyingDecimals,
        fallbackDecimals: a.decimals,
      });
      const regEntry = TOKEN_REGISTRY.find(
        (t) => t.chain === a.chain && t.address.toLowerCase() === a.address.toLowerCase()
      );
      const pricedFromUnderlying =
        !regEntry ||
        (regEntry.llamaKey &&
          a.underlyingAddress &&
          regEntry.llamaKey.toLowerCase().includes(a.underlyingAddress.toLowerCase()));
      if (pricedFromUnderlying && a.priceUsd > 0 && a.rawBalance > 0n) {
        const sharesUi = formatUnits(a.rawBalance, a.decimals);
        const expectedUnderlyingUi = formatUnits(vState.expectedUnderlyingRaw, uDec);
        if (sharesUi > 0 && expectedUnderlyingUi > 0) {
          a.priceUsd = Number(((expectedUnderlyingUi * a.priceUsd) / sharesUi).toFixed(6));
        }
      }
    }
  }
  if (aaveChecks.length > 0) {
    const aaveMap = new Map(aaveChecks);
    for (const a of rawAssets) {
      if (a.kind === 'defi_position' && (a.protocol ?? '').toLowerCase().includes('aave')) {
        const isV2 = (a.protocol ?? '').toLowerCase().includes('aave v2');
        const poolAddress =
          a.protocolAddress || (isV2 ? AAVE_V2_LENDING_POOLS[a.chain] : EVM_CHAINS[a.chain].aaveV3Pool);
        const key = `${a.chain}:${(poolAddress ?? '').toLowerCase()}`;
        const safety = aaveMap.get(key);
        if (safety?.checked && safety.hasActiveDebt) {
          a.aaveDebtUsd = safety.totalDebtUsd;
          a.aaveHealthFactor = safety.healthFactor;
          a.aaveTotalCollateralUsd = safety.totalCollateralUsd;
          a.aaveLiquidationThresholdBps = safety.currentLiquidationThresholdBps;
          warnings.push(`${EVM_CHAINS[a.chain].name} ${safety.reason}`);
        }
      }
    }
  }
  const permit2Map = new Map(permit2Checks);
  for (const a of rawAssets) {
    if (a.address !== 'native') {
      a.permit2Approved = permit2Map.get(a.chain)?.has(a.address.toLowerCase()) ?? false;
    }
  }

  return classifyAndBuildReport({
    mode: 'live_rpc',
    walletAddress: cleanAddr,
    walletLabel: label ?? 'Live Mainnet Wallet',
    startedAtMs,
    chainMeta,
    rawAssets,
    solPriceUsd,
    warnings,
    scannedChains: targetChains,
  });
}

/**
 * Generates realistic multi-chain dust + DeFi + zero-liquidity burn + honeypot preset scans
 * priced with LIVE DeFiLlama token prices so the dollar values match today's real market.
 */
export async function scanPresetWallet(presetId: string): Promise<ScanReport> {
  const startedAtMs = performance.now();
  const preset = WALLET_PRESETS.find((p) => p.id === presetId) ?? WALLET_PRESETS[0];

  if (preset.mode === 'live_rpc') {
    return scanLiveWallet(preset.address, preset.label);
  }

  const prices = await fetchLiveUsdPrices([
    'coingecko:solana',
    'coingecko:ethereum',
    'coingecko:polygon-ecosystem-token',
    'coingecko:avalanche-2',
    'ethereum:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    'ethereum:0x514910771AF9Ca656af840dff83E8264EcF986CA',
    'ethereum:0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    'base:0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    'base:0x532f27101965dd16442E59d40670FaF5eBB142E4',
    'arbitrum:0x912CE59144191C1204E64559FE8253a0e49E6548',
    'arbitrum:0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
    'optimism:0x4200000000000000000000000000000000000042',
    'avax:0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd',
  ]);

  const ethUsd = prices.get('coingecko:ethereum') ?? 1680;
  const solUsd = prices.get('coingecko:solana') ?? 70;
  const polUsd = prices.get('coingecko:polygon-ecosystem-token') ?? 0.24;
  const avaxUsd = prices.get('coingecko:avalanche-2') ?? 18.5;

  const isFarmer = preset.id === 'airdrop_farmer';

  const chainMeta = new Map<
    EvmChainId,
    {
      rpcStatus: 'live' | 'preset';
      blockNumber: number;
      gasPriceGwei: number;
      nativeBalance: number;
      nativePriceUsd: number;
    }
  >([
    ['ethereum', { rpcStatus: 'preset', blockNumber: 26486990, gasPriceGwei: 3.4, nativeBalance: 0.042, nativePriceUsd: ethUsd }],
    ['base', { rpcStatus: 'preset', blockNumber: 61783411, gasPriceGwei: 0.012, nativeBalance: 0.018, nativePriceUsd: ethUsd }],
    ['arbitrum', { rpcStatus: 'preset', blockNumber: 531391157, gasPriceGwei: 0.02, nativeBalance: isFarmer ? 0.0 : 0.011, nativePriceUsd: ethUsd }],
    ['optimism', { rpcStatus: 'preset', blockNumber: 159974140, gasPriceGwei: 0.014, nativeBalance: 0.008, nativePriceUsd: ethUsd }],
    ['polygon', { rpcStatus: 'preset', blockNumber: 97894414, gasPriceGwei: 32, nativeBalance: 14.5, nativePriceUsd: polUsd }],
    ['avalanche', { rpcStatus: 'preset', blockNumber: 101285886, gasPriceGwei: 25, nativeBalance: 0.85, nativePriceUsd: avaxUsd }],
  ]);

  const rawAssets: RawAssetSeed[] = isFarmer
    ? [
        {
          chain: 'arbitrum',
          address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
          symbol: 'ARB',
          name: 'Arbitrum (Zero-ETH Gas Rescue)',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 640n * 10n ** 18n,
          priceUsd: prices.get('arbitrum:0x912CE59144191C1204E64559FE8253a0e49E6548') ?? 0.34,
          liquidityUsd: 42_000_000,
        },
        {
          chain: 'arbitrum',
          address: '0x724dc807b04555b71ed48a6896b6F41593b8C637',
          symbol: 'aArbUSDCn',
          name: 'Aave v3 Arbitrum USDC',
          decimals: 6,
          kind: 'defi_position',
          protocol: 'Aave v3',
          protocolAddress: EVM_CHAINS.arbitrum.aaveV3Pool,
          underlyingSymbol: 'USDC',
          rawBalance: 412_500_000n,
          priceUsd: 1.0,
          liquidityUsd: 80_000_000,
        },
        {
          chain: 'base',
          address: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
          symbol: 'BRETT',
          name: 'Brett (Base)',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 2_750n * 10n ** 18n,
          priceUsd: prices.get('base:0x532f27101965dd16442E59d40670FaF5eBB142E4') ?? 0.038,
          liquidityUsd: 8_500_000,
        },
        {
          chain: 'optimism',
          address: '0x4200000000000000000000000000000000000042',
          symbol: 'OP',
          name: 'Optimism',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 185n * 10n ** 18n,
          priceUsd: prices.get('optimism:0x4200000000000000000000000000000000000042') ?? 0.76,
          liquidityUsd: 35_000_000,
        },
        {
          chain: 'base',
          address: '0xDead000000000000000000000000000000001337',
          symbol: 'BASEPEPE',
          name: 'Rugged BasePepe LP Removed',
          decimals: 18,
          kind: 'dead_token',
          rawBalance: 9_840_000n * 10n ** 18n,
          priceUsd: 0,
          liquidityUsd: 0,
        },
        {
          chain: 'arbitrum',
          address: '0xDead000000000000000000000000000000009001',
          symbol: 'ARBDOGE2',
          name: 'Abandoned ArbDoge v2',
          decimals: 18,
          kind: 'dead_token',
          rawBalance: 450_000n * 10n ** 18n,
          priceUsd: 0,
          liquidityUsd: 0,
        },
        {
          chain: 'polygon',
          address: '0xBad0000000000000000000000000000000004444',
          symbol: 'CLAIM-NFT.IO',
          name: 'Phishing Airdrop Voucher',
          decimals: 18,
          kind: 'dead_token',
          rawBalance: 1000n * 10n ** 18n,
          priceUsd: 0,
          liquidityUsd: 0,
          honeypot: true,
        },
      ]
    : [
        // ETHEREUM — DeFi positions + dust + dead token
        {
          chain: 'ethereum',
          address: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
          symbol: 'aEthUSDC',
          name: 'Aave v3 Ethereum USDC',
          decimals: 6,
          kind: 'defi_position',
          protocol: 'Aave v3',
          protocolAddress: EVM_CHAINS.ethereum.aaveV3Pool,
          underlyingSymbol: 'USDC',
          rawBalance: 1_240_500_000n,
          priceUsd: 1.0,
          liquidityUsd: 250_000_000,
        },
        {
          chain: 'ethereum',
          address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
          symbol: 'wstETH',
          name: 'Lido Wrapped Staked ETH',
          decimals: 18,
          kind: 'defi_position',
          protocol: 'Lido',
          protocolAddress: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
          underlyingSymbol: 'ETH',
          rawBalance: 420_000_000_000_000_000n, // 0.42 wstETH
          priceUsd: prices.get('ethereum:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0') ?? ethUsd * 1.18,
          liquidityUsd: 180_000_000,
        },
        {
          chain: 'ethereum',
          address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
          symbol: 'LINK',
          name: 'Chainlink',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 14_500_000_000_000_000_000n, // 14.5 LINK
          priceUsd: prices.get('ethereum:0x514910771AF9Ca656af840dff83E8264EcF986CA') ?? 12.4,
          liquidityUsd: 90_000_000,
        },
        {
          chain: 'ethereum',
          address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
          symbol: 'UNI',
          name: 'Uniswap',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 19_200_000_000_000_000_000n,
          priceUsd: prices.get('ethereum:0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984') ?? 6.2,
          liquidityUsd: 70_000_000,
        },
        {
          chain: 'ethereum',
          address: '0xDead000000000000000000000000000000002021',
          symbol: 'OHM-OLD',
          name: 'Deprecated V1 Rebase Token',
          decimals: 9,
          kind: 'dead_token',
          rawBalance: 42_000_000_000n,
          priceUsd: 0,
          liquidityUsd: 0,
        },

        // BASE — Compound v3 + AERO + BRETT + dead token
        {
          chain: 'base',
          address: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
          symbol: 'cUSDCv3',
          name: 'Compound v3 Base USDC',
          decimals: 6,
          kind: 'defi_position',
          protocol: 'Compound v3',
          protocolAddress: EVM_CHAINS.base.compoundV3Comet,
          underlyingSymbol: 'USDC',
          rawBalance: 865_000_000n,
          priceUsd: 1.0,
          liquidityUsd: 95_000_000,
        },
        {
          chain: 'base',
          address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
          symbol: 'AERO',
          name: 'Aerodrome Finance',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 420n * 10n ** 18n,
          priceUsd: prices.get('base:0x940181a94A35A4569E4529A3CDfB74e38FD98631') ?? 0.58,
          liquidityUsd: 24_000_000,
        },
        {
          chain: 'base',
          address: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
          symbol: 'BRETT',
          name: 'Brett (Base)',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 1_850n * 10n ** 18n,
          priceUsd: prices.get('base:0x532f27101965dd16442E59d40670FaF5eBB142E4') ?? 0.038,
          liquidityUsd: 8_500_000,
        },
        {
          chain: 'base',
          address: '0xDead000000000000000000000000000000008453',
          symbol: 'BALD',
          name: 'Bald (Zero Liquidity Rug)',
          decimals: 18,
          kind: 'dead_token',
          rawBalance: 145_000n * 10n ** 18n,
          priceUsd: 0,
          liquidityUsd: 0,
        },

        // ARBITRUM — Aave v3 + ARB + PENDLE + dead token
        {
          chain: 'arbitrum',
          address: '0x724dc807b04555b71ed48a6896b6F41593b8C637',
          symbol: 'aArbUSDCn',
          name: 'Aave v3 Arbitrum USDC',
          decimals: 6,
          kind: 'defi_position',
          protocol: 'Aave v3',
          protocolAddress: EVM_CHAINS.arbitrum.aaveV3Pool,
          underlyingSymbol: 'USDC',
          rawBalance: 530_250_000n,
          priceUsd: 1.0,
          liquidityUsd: 80_000_000,
        },
        {
          chain: 'arbitrum',
          address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
          symbol: 'ARB',
          name: 'Arbitrum',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 510n * 10n ** 18n,
          priceUsd: prices.get('arbitrum:0x912CE59144191C1204E64559FE8253a0e49E6548') ?? 0.34,
          liquidityUsd: 42_000_000,
        },
        {
          chain: 'arbitrum',
          address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
          symbol: 'PENDLE',
          name: 'Pendle',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 48n * 10n ** 18n,
          priceUsd: prices.get('arbitrum:0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8') ?? 2.85,
          liquidityUsd: 19_000_000,
        },
        {
          chain: 'arbitrum',
          address: '0xDead000000000000000000000000000000042161',
          symbol: 'AIDOGE-V1',
          name: 'Dead Arbitrum Meme Pool',
          decimals: 6,
          kind: 'dead_token',
          rawBalance: 88_000_000_000n,
          priceUsd: 0,
          liquidityUsd: 0,
        },

        // OPTIMISM — OP + direct USDC
        {
          chain: 'optimism',
          address: '0x4200000000000000000000000000000000000042',
          symbol: 'OP',
          name: 'Optimism',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 162n * 10n ** 18n,
          priceUsd: prices.get('optimism:0x4200000000000000000000000000000000000042') ?? 0.76,
          liquidityUsd: 35_000_000,
        },
        {
          chain: 'optimism',
          address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
          symbol: 'USDC',
          name: 'USD Coin (Optimism)',
          decimals: 6,
          kind: 'erc20',
          rawBalance: 194_400_000n,
          priceUsd: 1.0,
          liquidityUsd: 120_000_000,
        },

        // POLYGON — Aave v3 + honeypot scam token safely skipped
        {
          chain: 'polygon',
          address: '0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD',
          symbol: 'aPolUSDCn',
          name: 'Aave v3 Polygon USDC',
          decimals: 6,
          kind: 'defi_position',
          protocol: 'Aave v3',
          protocolAddress: EVM_CHAINS.polygon.aaveV3Pool,
          underlyingSymbol: 'USDC',
          rawBalance: 245_800_000n,
          priceUsd: 1.0,
          liquidityUsd: 40_000_000,
        },
        {
          chain: 'polygon',
          address: '0xBad0000000000000000000000000000000000137',
          symbol: 'FREE-USDC.XYZ',
          name: 'Revert-on-Transfer Phishing Token',
          decimals: 18,
          kind: 'dead_token',
          rawBalance: 50_000n * 10n ** 18n,
          priceUsd: 0,
          liquidityUsd: 0,
          honeypot: true,
        },

        // AVALANCHE — JOE dust + dead token
        {
          chain: 'avalanche',
          address: '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd',
          symbol: 'JOE',
          name: 'Trader Joe',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 380n * 10n ** 18n,
          priceUsd: prices.get('avax:0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd') ?? 0.22,
          liquidityUsd: 11_000_000,
        },
        {
          chain: 'avalanche',
          address: '0xDead000000000000000000000000000000043114',
          symbol: 'TIME-OLD',
          name: 'Wonderland Dead Dust',
          decimals: 9,
          kind: 'dead_token',
          rawBalance: 1_450_000_000n,
          priceUsd: 0,
          liquidityUsd: 0,
        },
      ];

  // Preset demo wallets mark standard Uniswap/Router tokens as already Permit2-approved
  const presetPermit2Symbols = new Set(['USDC', 'UNI', 'AERO', 'ARB', 'OP']);
  for (const a of rawAssets) {
    if (a.kind === 'erc20' && presetPermit2Symbols.has(a.symbol)) {
      a.permit2Approved = true;
    }
  }

  return classifyAndBuildReport({
    mode: 'preset',
    walletAddress: preset.address,
    walletLabel: preset.label,
    startedAtMs,
    chainMeta,
    rawAssets,
    solPriceUsd: solUsd,
    warnings: [],
  });
}
