import crypto from 'node:crypto';
import {
  CHAIN_LIST,
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  PROTOCOL_FEE_BPS,
  TOKEN_REGISTRY,
} from './chains.js';
import { fetchLiveUsdPrices } from './prices.js';
import {
  checkAaveV3AccountSafety,
  detectPermit2Allowances,
  discoverChainTokens,
  fetchDexLiquidityBatch,
  isEip2612Token,
  MIN_VERIFIED_DEX_LIQUIDITY_USD,
  simulateBurnTransferOnchain,
} from './discovery.js';
import { formatUnits, isValidEvmAddress, scanSingleEvmChain } from './rpc.js';
import type {
  AssetAction,
  ChainScanSummary,
  EvmChainId,
  ScannedAsset,
  ScanReport,
} from './types.js';

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
  rawBalance: bigint;
  priceUsd: number;
  liquidityUsd: number;
  honeypot?: boolean;
  permit2Approved?: boolean;
  aaveDebtUsd?: number;
  aaveHealthFactor?: number;
  dexLiquidityVerified?: boolean;
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
}): ScanReport {
  const { mode, walletAddress, walletLabel, startedAtMs, chainMeta, rawAssets, solPriceUsd, warnings } =
    params;

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
    // Batching via SiphonRouter saves ~42% gas (eliminates repeated 21k base tx + repeated approvals + shared CCTP burn)
    const batchedGasUsd = round4(
      estimatedGasUsd * (chainItemCount > 1 ? 0.54 : 0.85)
    );

    const slippageRate =
      item.kind === 'dead_token' || isDirectUsdc || item.underlyingSymbol === 'USDC' ? 0 : 0.0015;
    const estimatedSlippageUsd = round2(grossUsd * slippageRate);

    const netUsdcSingle = round2(Math.max(0, grossUsd - estimatedGasUsd - estimatedSlippageUsd));
    const netUsdcBatched = round2(Math.max(0, grossUsd - batchedGasUsd - estimatedSlippageUsd));

    let action: AssetAction;
    let actionReason: string;
    let selectedByDefault = true;
    let honeypotSafe = true;
    let calldataPreview: string | undefined;

    if (item.honeypot) {
      action = 'SKIP_HONEYPOT';
      actionReason = 'eth_call transfer simulation reverted (honeypot / transfer-lock). Safely skipped.';
      selectedByDefault = false;
      honeypotSafe = false;
    } else if (item.kind === 'dead_token' || item.liquidityUsd === 0 || item.priceUsd === 0) {
      action = 'BURN_ZERO_LIQUIDITY';
      actionReason = 'Zero verified DEX liquidity ($0.00). Opt-in burn to 0x…dEaD (unchecked by default to save gas & popups).';
      selectedByDefault = false;
      calldataPreview = encodeTransferPreview(DEAD_BURN_ADDRESS, item.rawBalance);
    } else if (item.kind === 'defi_position') {
      action = 'WITHDRAW_AND_BRIDGE';
      const hasAaveDebt = Boolean(item.aaveDebtUsd && item.aaveDebtUsd > 0);
      if (hasAaveDebt) {
        actionReason = `Aave v3 debt guard: $${item.aaveDebtUsd?.toFixed(2)} active borrow (HF ${item.aaveHealthFactor?.toFixed(2) ?? '—'}). Repay debt before MAX withdraw.`;
        selectedByDefault = false;
      } else {
        actionReason =
          item.underlyingSymbol === 'USDC'
            ? `Withdraw from ${item.protocol} directly as native USDC → Solana (Relay / CCTP).`
            : `Withdraw ${item.underlyingSymbol ?? item.symbol} from ${item.protocol} → Solana via Relay / LI.FI.`;
        selectedByDefault = netUsdcBatched > 0.25;
      }
      calldataPreview = encodeAaveWithdrawPreview(
        item.address,
        item.rawBalance,
        walletAddress
      );
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
      dexLiquidityVerified: item.dexLiquidityVerified,
      calldataPreview,
    };
  });

  // Build per-chain summaries
  const chains: ChainScanSummary[] = CHAIN_LIST.map((c) => {
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
    const fee = round2((Math.max(0, grossUsd - slippage) * PROTOCOL_FEE_BPS) / 10_000);
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
        (a) => a.action === 'SKIP_HONEYPOT' || a.action === 'SKIP_GAS_NEGATIVE'
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
  const protocolFeeUsd = round2(
    (Math.max(0, grossUsd - estimatedSlippageUsd) * PROTOCOL_FEE_BPS) / 10_000
  );
  const netSolanaUsdc = round2(
    Math.max(0, grossUsd - estimatedSlippageUsd - batchedGasUsd - protocolFeeUsd)
  );

  return {
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
      protocolFeeBps: PROTOCOL_FEE_BPS,
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
}

/**
 * Runs a REAL live multi-chain EVM scan across all 6 Circle CCTP chains in parallel
 * using Multicall3 (`aggregate3`) + real DeFiLlama USD prices.
 */
export async function scanLiveWallet(walletAddress: string, label?: string): Promise<ScanReport> {
  const cleanAddr = walletAddress.trim();
  if (!isValidEvmAddress(cleanAddr)) {
    throw new Error('Invalid EVM wallet address (expected 0x followed by 40 hex characters).');
  }

  const startedAtMs = performance.now();
  const warnings: string[] = [];

  // 1. Parallel RPC scans across all 6 chains + live USD prices from DeFiLlama
  const llamaKeys = [
    'coingecko:solana',
    ...CHAIN_LIST.map((c) => c.nativeLlamaId),
    ...TOKEN_REGISTRY.map((t) => t.llamaKey).filter((k): k is string => Boolean(k)),
  ];

  const [prices, discoveredByChainArr, ...chainOutputs] = await Promise.all([
    fetchLiveUsdPrices(llamaKeys),
    Promise.all(
      CHAIN_LIST.map(async (c) => [c.id, await discoverChainTokens(c.id, cleanAddr, 24)] as const)
    ),
    ...CHAIN_LIST.map((c) =>
      scanSingleEvmChain(
        c,
        cleanAddr,
        TOKEN_REGISTRY.filter((t) => t.chain === c.id)
      )
    ),
  ]);
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

  const rawAssets: RawAssetSeed[] = [];

  for (const out of chainOutputs) {
    const c = out.chain;
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
      warnings.push(`${c.name} RPC timed out (${out.error ?? 'unavailable'}).`);
      continue;
    }

    // Reserve a tiny gas buffer on native token so user isn't stranded
    const gasReserve = c.id === 'ethereum' ? 0.002 : 0.0005;
    if (nativeUi > gasReserve) {
      const sweepableWei = out.nativeBalanceWei - BigInt(Math.round(gasReserve * 1e18));
      if (sweepableWei > 0n) {
        rawAssets.push({
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
      rawAssets.push({
        chain: c.id,
        address: tok.address,
        symbol: tok.symbol,
        name: tok.name,
        decimals: tok.decimals,
        kind: tok.kind,
        protocol: tok.protocol,
        protocolAddress: tok.protocolAddress,
        underlyingSymbol: tok.underlyingSymbol,
        rawBalance: rawBal,
        priceUsd,
        liquidityUsd: priceUsd > 0 ? 5_000_000 : 0,
      });
    }

    // Merge real discovered arbitrary ERC-20s with live DexScreener liquidity verification
    // so fake-price spam / illiquid coins never inflate headline USD totals!
    const discoveredChainTokens = discoveredByChain.get(c.id) ?? [];
    if (discoveredChainTokens.length > 0) {
      const novelTokens = discoveredChainTokens.filter((dt) => !seenAddrs.has(dt.address.toLowerCase()));
      const dexLiquidityMap = await fetchDexLiquidityBatch(
        c.id,
        novelTokens.map((dt) => dt.address)
      );

      const extraDead: typeof novelTokens = [];
      for (const dt of novelTokens) {
        if (seenAddrs.has(dt.address.toLowerCase())) continue;
        seenAddrs.add(dt.address.toLowerCase());
        const dex = dexLiquidityMap.get(dt.address.toLowerCase());
        const verifiedLiq = dex?.liquidityUsd ?? 0;
        const verifiedPrice = dex && dex.priceUsd > 0 ? dex.priceUsd : 0;

        // Require verified DEX liquidity >= $2,500 before counting a discovered long-tail token as sellable USD
        if (verifiedLiq >= MIN_VERIFIED_DEX_LIQUIDITY_USD && verifiedPrice > 0) {
          rawAssets.push({
            chain: c.id,
            address: dt.address,
            symbol: dt.symbol,
            name: dt.name,
            decimals: dt.decimals,
            kind: 'erc20',
            rawBalance: dt.rawBalance,
            priceUsd: verifiedPrice,
            liquidityUsd: Math.round(verifiedLiq),
            dexLiquidityVerified: true,
          });
        } else if (extraDead.length < 6) {
          extraDead.push(dt);
        }
      }

      // Live onchain eth_call honeypot verification on discovered zero-liquidity / illiquid tokens!
      if (extraDead.length > 0) {
        const simChecks = await Promise.all(
          extraDead.map((dt) =>
            simulateBurnTransferOnchain({
              chain: c.id,
              walletAddress: cleanAddr,
              tokenAddress: dt.address,
              rawAmount: dt.rawBalance,
            })
          )
        );
        extraDead.forEach((dt, idx) => {
          rawAssets.push({
            chain: c.id,
            address: dt.address,
            symbol: dt.symbol,
            name: dt.name,
            decimals: dt.decimals,
            kind: 'dead_token',
            rawBalance: dt.rawBalance,
            priceUsd: 0,
            liquidityUsd: 0,
            honeypot: !simChecks[idx].safeToBurn,
            dexLiquidityVerified: false,
          });
        });
      }
    }
  }

  // Run live Aave v3 getUserAccountData(user) debt safety checks on any chain with Aave positions
  const aaveChains = Array.from(
    new Set(
      rawAssets
        .filter((a) => a.kind === 'defi_position' && (a.protocol ?? '').toLowerCase().includes('aave'))
        .map((a) => a.chain)
    )
  );
  if (aaveChains.length > 0) {
    const aaveChecks = await Promise.all(
      aaveChains.map(async (chain) => [chain, await checkAaveV3AccountSafety(chain, cleanAddr)] as const)
    );
    const aaveMap = new Map(aaveChecks);
    for (const a of rawAssets) {
      if (a.kind === 'defi_position' && (a.protocol ?? '').toLowerCase().includes('aave')) {
        const safety = aaveMap.get(a.chain);
        if (safety?.checked && safety.hasActiveDebt) {
          a.aaveDebtUsd = safety.totalDebtUsd;
          a.aaveHealthFactor = safety.healthFactor;
          warnings.push(`${EVM_CHAINS[a.chain].name} ${safety.reason}`);
        }
      }
    }
  }

  // Check real onchain Permit2 allowances per chain in a single parallel Multicall3 pass
  const erc20ByChain = new Map<EvmChainId, string[]>();
  for (const a of rawAssets) {
    if (a.address !== 'native' && a.kind !== 'dead_token') {
      const list = erc20ByChain.get(a.chain) ?? [];
      list.push(a.address);
      erc20ByChain.set(a.chain, list);
    }
  }
  const permit2Checks = await Promise.all(
    Array.from(erc20ByChain.entries()).map(async ([chain, tokenAddresses]) => {
      const approved = await detectPermit2Allowances({
        chain,
        owner: cleanAddr,
        tokenAddresses,
      });
      return [chain, approved] as const;
    })
  );
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
    'base:0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
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
          address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
          symbol: 'DEGEN',
          name: 'Degen (Base)',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 24_500n * 10n ** 18n,
          priceUsd: prices.get('base:0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed') ?? 0.0042,
          liquidityUsd: 4_500_000,
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

        // BASE — Compound v3 + AERO + DEGEN + dead token
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
          address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
          symbol: 'DEGEN',
          name: 'Degen (Base)',
          decimals: 18,
          kind: 'erc20',
          rawBalance: 16_800n * 10n ** 18n,
          priceUsd: prices.get('base:0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed') ?? 0.0042,
          liquidityUsd: 4_500_000,
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
