import crypto from 'node:crypto';
import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import {
  checkQuoteHaircutPass,
  evaluateNonEvmGaslessBreakEven,
  filterChainSweepableAssets,
  getNonEvmFeeRecipient,
  LIFI_TRON_CHAIN_ID,
  quoteLifiNonEvm,
  quoteRelayNonEvm,
  RELAY_TRON_CHAIN_ID,
  RELAY_TRON_NATIVE_CURRENCY,
} from '../execution/non-evm-converter.js';
import { getProtocolFeeConfig } from '../scanner/chains.js';
import { fetchSolanaWalletBalances } from '../scanner/discovery.js';
import { fetchLiveUsdPrices } from '../scanner/prices.js';
import { applyTwoLevelRoiToReport } from '../scanner/roi.js';
import type { ChainScanSummary, ScannedAsset, ScanReport } from '../scanner/types.js';
import type {
  ChainFamilyAdapter,
  ChainFamilyMeta,
  PreparedNonEvmBatch,
  PreparedNonEvmCall,
  UniversalExecutionProof,
  UniversalGaslessIntent,
  UniversalPreSignProof,
} from './interface.js';

const TRONGRID_BASE = 'https://api.trongrid.io';

const KNOWN_TRC20: Record<
  string,
  { symbol: string; name: string; decimals: number; coingeckoKey: string; isStable?: boolean; isLst?: boolean }
> = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: {
    symbol: 'USDT',
    name: 'Tether USD (TRC-20)',
    decimals: 6,
    coingeckoKey: 'coingecko:tether',
    isStable: true,
  },
  TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: {
    symbol: 'USDC',
    name: 'USD Coin (TRC-20)',
    decimals: 6,
    coingeckoKey: 'coingecko:usd-coin',
    isStable: true,
  },
  TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn: {
    symbol: 'USDD',
    name: 'USDD (TRC-20)',
    decimals: 18,
    coingeckoKey: 'coingecko:tether',
    isStable: true,
  },
  TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9: {
    symbol: 'JST',
    name: 'JUST (TRC-20)',
    decimals: 18,
    coingeckoKey: 'coingecko:just',
  },
  TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR: {
    symbol: 'WTRX',
    name: 'Wrapped TRX (TRC-20)',
    decimals: 6,
    coingeckoKey: 'coingecko:tron',
  },
  TU3kjFuhtEo42tsCBtfYUAZxoqQ4yuSLQ5: {
    symbol: 'sTRX',
    name: 'JustLend Staked TRX',
    decimals: 18,
    coingeckoKey: 'coingecko:tron',
    isLst: true,
  },
  TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S: {
    symbol: 'SUN',
    name: 'SUN Token (TRC-20)',
    decimals: 18,
    coingeckoKey: 'coingecko:sun-token',
  },
};

export const TRON_FAMILY_META: ChainFamilyMeta = {
  family: 'tron',
  label: 'Tron',
  shortLabel: 'Tron',
  chains: [{ id: 'tron', name: 'Tron', nativeSymbol: 'TRX', logo: '/logos/tron.svg', cctpDomain: null }],
  signingMechanism: 'Direct TronLink TVM TriggerSmartContract (Relay / LI.FI) or Dual Resource Delegation',
  gasSponsorshipMechanism: 'Tron Dual Energy + Bandwidth Delegation (DelegateResourceContract) or GasFree USDT',
  preSignProofMechanism: '/wallet/getaccountresource + /wallet/triggerconstantcontract + Solana snapshot',
  bridgeProviders: ['Relay (Tron TVM → Solana)', 'LI.FI (TVM)', 'Allbridge Core'],
  wallets: [
    { id: 'tronlink', name: 'TronLink', logo: '/logos/tronlink.svg', installUrl: 'https://www.tronlink.org' },
  ],
  sampleAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
  sampleLabel: 'Tron Sample Vault',
  addressHint: 'T… (34-char Tron base58 address)',
};

async function tronFetch<T>(path: string, init?: RequestInit, timeoutMs = 4200): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (process.env.TRONGRID_API_KEY?.trim()) {
      headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY.trim();
    }
    if (init?.body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${TRONGRID_BASE}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return (await res.json()) as T;
  } catch {
    // caller handles fallback
  }
  return null;
}

function unitsToUi(raw: string, decimals: number): number {
  try {
    const v = BigInt(raw);
    const d = 10n ** BigInt(decimals);
    return Number(v / d) + Number(v % d) / Number(d);
  } catch {
    return Number(raw) / 10 ** decimals;
  }
}

export const tronAdapter: ChainFamilyAdapter = {
  family: 'tron',
  meta: TRON_FAMILY_META,

  matchesAddress(address: string): boolean {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address.trim());
  },

  async scanWallet(address: string, label?: string): Promise<ScanReport> {
    const start = Date.now();
    const cleanAddr = address.trim();
    const feeCfg = getProtocolFeeConfig();
    const warnings: string[] = [];

    const [acctRes, nowBlock, resources, priceMap] = await Promise.all([
      tronFetch<{
        data?: Array<{
          balance?: number;
          trc20?: Array<Record<string, string>>;
          frozenV2?: Array<{ type?: string; amount?: number }>;
        }>;
      }>(`/v1/accounts/${encodeURIComponent(cleanAddr)}`),
      tronFetch<{ block_header?: { raw_data?: { number?: number } } }>('/wallet/getnowblock', {
        method: 'POST',
        body: '{}',
      }),
      tronFetch<{
        freeNetLimit?: number;
        freeNetUsed?: number;
        NetLimit?: number;
        NetUsed?: number;
        EnergyLimit?: number;
        EnergyUsed?: number;
      }>('/wallet/getaccountresource', {
        method: 'POST',
        body: JSON.stringify({ address: cleanAddr, visible: true }),
      }),
      fetchLiveUsdPrices([
        'coingecko:tron',
        'coingecko:tether',
        'coingecko:usd-coin',
        'coingecko:just',
        'coingecko:sun-token',
        'coingecko:solana',
      ]),
    ]);

    const rpcReachable = Boolean(acctRes || nowBlock);
    if (!rpcReachable) {
      warnings.push('TronGrid public API did not respond within 4.2s.');
    }

    const blockNumber = nowBlock?.block_header?.raw_data?.number ?? 0;
    const trxPrice = priceMap.get('coingecko:tron') ?? 0.24;
    const solPrice = priceMap.get('coingecko:solana') ?? 70;
    const acct = acctRes?.data?.[0];
    const assets: ScannedAsset[] = [];

    const availEnergy = Math.max(0, Number(resources?.EnergyLimit ?? 0) - Number(resources?.EnergyUsed ?? 0));
    const availBandwidth =
      Math.max(0, Number(resources?.freeNetLimit ?? 0) - Number(resources?.freeNetUsed ?? 0)) +
      Math.max(0, Number(resources?.NetLimit ?? 0) - Number(resources?.NetUsed ?? 0));

    const trxSun = acct?.balance ?? 0;
    const nativeBalance = unitsToUi(String(trxSun), 6);
    if (nativeBalance > 0) {
      const grossUsd = Number((nativeBalance * trxPrice).toFixed(2));
      const gasUsd = 0.25;
      const slippageUsd = Number((grossUsd * 0.004).toFixed(2));
      const isDust = grossUsd < 1.0;
      assets.push({
        id: 'tron:native',
        family: 'tron',
        sourceWallet: cleanAddr,
        chain: 'tron',
        chainName: 'Tron',
        address: 'native',
        symbol: 'TRX',
        name: 'TRON',
        decimals: 6,
        kind: 'native',
        rawBalance: String(trxSun),
        uiBalance: Number(nativeBalance.toFixed(6)),
        priceUsd: trxPrice,
        grossUsd,
        liquidityUsd: 200_000_000,
        estimatedGasUsd: gasUsd,
        batchedGasUsd: 0.1,
        estimatedSlippageUsd: slippageUsd,
        netUsdcSingle: Math.max(0, Number((grossUsd - gasUsd - slippageUsd).toFixed(2))),
        netUsdcBatched: Math.max(0, Number((grossUsd - 0.1 - slippageUsd).toFixed(2))),
        action: isDust ? 'SKIP_GAS_NEGATIVE' : 'SELL_AND_BRIDGE',
        actionReason: isDust ? 'Sub-$1 TRX dust' : 'Convert TRX → Solana via Relay / LI.FI TVM',
        selectedByDefault: !isDust,
        honeypotSafe: true,
      });
    }

    // Detect Stake 2.0 frozenV2 TRX (Energy/Bandwidth stakes)
    let frozenV2Sun = 0n;
    for (const f of acct?.frozenV2 ?? []) {
      if (f.amount && f.amount > 0) frozenV2Sun += BigInt(Math.round(f.amount));
    }
    if (frozenV2Sun > 0n) {
      const stakedUi = unitsToUi(frozenV2Sun.toString(), 6);
      const grossUsd = Number((stakedUi * trxPrice).toFixed(2));
      if (grossUsd >= 1.0) {
        assets.push({
          id: 'tron:frozen_v2_trx',
          family: 'tron',
          sourceWallet: cleanAddr,
          chain: 'tron',
          chainName: 'Tron',
          address: 'stake_v2:trx',
          symbol: 'Staked TRX',
          name: 'TRON Stake 2.0 (Energy/Bandwidth)',
          decimals: 6,
          kind: 'defi_position',
          protocol: 'TRON Stake 2.0',
          underlyingSymbol: 'TRX',
          rawBalance: frozenV2Sun.toString(),
          uiBalance: Number(stakedUi.toFixed(6)),
          priceUsd: trxPrice,
          grossUsd,
          liquidityUsd: 200_000_000,
          estimatedGasUsd: 0.25,
          batchedGasUsd: 0.1,
          estimatedSlippageUsd: Number((grossUsd * 0.004).toFixed(2)),
          netUsdcSingle: Math.max(0, Number((grossUsd * 0.996 - 0.25).toFixed(2))),
          netUsdcBatched: Math.max(0, Number((grossUsd * 0.996 - 0.1).toFixed(2))),
          action: 'WITHDRAW_AND_BRIDGE',
          actionReason: 'TRON Stake 2.0 requires 14-day unfreeze cooldown on TronScan before sweeping to Solana',
          selectedByDefault: false,
          honeypotSafe: true,
          defiPositionType: 'Locked Stake 2.0',
        });
      }
    }

    for (const entry of acct?.trc20 ?? []) {
      for (const [contract, rawBal] of Object.entries(entry)) {
        const meta = KNOWN_TRC20[contract];
        if (!meta) continue;
        const uiBal = unitsToUi(rawBal, meta.decimals);
        if (uiBal <= 0) continue;

        const priceUsd = priceMap.get(meta.coingeckoKey) ?? (meta.isStable ? 1.0 : 0);
        const grossUsd = Number((uiBal * priceUsd).toFixed(2));
        const gasUsd = availEnergy >= 65_000 ? 0.1 : 1.4;
        const delegatedGasUsd = 0.35;
        const slippageUsd = meta.isStable ? Number((grossUsd * 0.001).toFixed(2)) : Number((grossUsd * 0.004).toFixed(2));
        const isDust = grossUsd < 2.0;

        assets.push({
          id: `tron:${contract}`,
          family: 'tron',
          sourceWallet: cleanAddr,
          chain: 'tron',
          chainName: 'Tron',
          address: contract,
          symbol: meta.symbol,
          name: meta.name,
          decimals: meta.decimals,
          kind: meta.isLst ? 'defi_position' : 'erc20',
          protocol: meta.isLst ? 'JustLend sTRX' : undefined,
          underlyingSymbol: meta.isLst ? 'TRX' : undefined,
          rawBalance: rawBal,
          uiBalance: Number(uiBal.toFixed(6)),
          priceUsd,
          grossUsd,
          liquidityUsd: meta.isStable ? 900_000_000 : 15_000_000,
          estimatedGasUsd: gasUsd,
          batchedGasUsd: delegatedGasUsd,
          estimatedSlippageUsd: slippageUsd,
          netUsdcSingle: Math.max(0, Number((grossUsd - gasUsd - slippageUsd).toFixed(2))),
          netUsdcBatched: Math.max(0, Number((grossUsd - delegatedGasUsd - slippageUsd).toFixed(2))),
          action: isDust ? 'SKIP_GAS_NEGATIVE' : meta.isStable ? 'BRIDGE_DIRECT_USDC' : 'SELL_AND_BRIDGE',
          actionReason: isDust
            ? `Sub-$2 TRC-20 ${meta.symbol} dust`
            : 'Direct TronLink TVM conversion via Relay / LI.FI (or Dual Energy+Bandwidth delegation / GasFree for $0 TRX)',
          selectedByDefault: !isDust,
          honeypotSafe: true,
        });
      }
    }

    const grossUsd = Number(assets.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const defiGrossUsd = Number(
      assets.filter((a) => a.kind === 'defi_position').reduce((s, a) => s + a.grossUsd, 0).toFixed(2)
    );
    const protocolFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const batchedGasUsd = Number(assets.reduce((s, a) => s + a.batchedGasUsd, 0).toFixed(2));
    const singleTxGasUsd = Number(assets.reduce((s, a) => s + a.estimatedGasUsd, 0).toFixed(2));
    const slippageTotal = Number(assets.reduce((s, a) => s + a.estimatedSlippageUsd, 0).toFixed(2));
    const netSolanaUsdc = Number(
      Math.max(0, grossUsd - protocolFeeUsd - batchedGasUsd - slippageTotal).toFixed(2)
    );

    const hasResources = availEnergy >= 65_000 && availBandwidth >= 350;
    const summary: ChainScanSummary = {
      family: 'tron',
      sourceWallet: cleanAddr,
      chain: 'tron',
      chainName: 'Tron',
      chainId: '0x2b6653dc',
      cctpDomain: null,
      rpcStatus: rpcReachable ? 'live' : 'degraded',
      blockNumber,
      gasPriceGwei: 420, // 420 Sun / Energy unit
      nativeBalance: Number(nativeBalance.toFixed(6)),
      nativeSymbol: 'TRX',
      nativePriceUsd: trxPrice,
      assetCount: assets.length,
      defiCount: assets.filter((a) => a.kind === 'defi_position').length,
      liquidCount: assets.filter((a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC').length,
      burnCount: 0,
      skippedCount: assets.filter((a) => a.action === 'SKIP_GAS_NEGATIVE').length,
      grossUsd,
      netUsdcBridged: netSolanaUsdc,
      totalGasUsd: batchedGasUsd,
      gasSavedByBatchUsd: Number(Math.max(0, singleTxGasUsd - batchedGasUsd).toFixed(2)),
      cctpAttestationSec: 30,
      needsGasSponsorship: !hasResources && nativeBalance < 15,
      sponsorshipMechanism: 'Direct TronLink TVM or Dual Energy+Bandwidth Delegation / GasFree ($0 TRX)',
    };

    return applyTwoLevelRoiToReport({
      scanId: `scan_tron_${crypto.randomBytes(4).toString('hex')}`,
      family: 'tron',
      mode: 'live_rpc',
      walletAddress: cleanAddr,
      walletLabel: label || 'Tron Mainnet',
      scannedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - start,
      chainsScanned: 1,
      chains: [summary],
      assets,
      totals: {
        grossUsd,
        defiGrossUsd,
        liquidGrossUsd: Number((grossUsd - defiGrossUsd).toFixed(2)),
        protocolFeeBps: feeCfg.feeBps,
        protocolFeeUsd,
        singleTxGasUsd,
        batchedGasUsd,
        gasSavedUsd: summary.gasSavedByBatchUsd,
        estimatedSlippageUsd: slippageTotal,
        netSolanaUsdc,
        solEquivalent: Number((netSolanaUsdc / solPrice).toFixed(4)),
        solPriceUsd: solPrice,
        defiPositionCount: summary.defiCount,
        liquidDustCount: summary.liquidCount,
        burnCandidateCount: 0,
        honeypotSkippedCount: 0,
        gasNegativeCount: summary.skippedCount,
      },
      warnings,
    });
  },

  async prepareDirectBatch(params): Promise<PreparedNonEvmBatch> {
    const outputAsset = params.outputAsset ?? 'USDC';
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    const feeRecipient = getNonEvmFeeRecipient('tron');
    const solanaUsdcAtaBytes32 = solanaAddressToBytes32(params.solanaDestination);
    const sweepable = filterChainSweepableAssets('tron', params.assets).filter(
      (a) => a.address !== 'stake_v2:trx'
    );

    const calls: PreparedNonEvmCall[] = [];
    const bridgeTrackers: PreparedNonEvmBatch['bridgeTrackers'] = [];
    const skippedAssets: PreparedNonEvmBatch['skippedAssets'] = [];
    const notes: string[] = [];
    let maxSeconds = 30;
    let liveExecutable = false;

    for (const asset of sweepable) {
      const originCurrency =
        asset.address === 'native' ? RELAY_TRON_NATIVE_CURRENCY : asset.address;

      // 1. Primary: Live Relay Tron TVM quote (returns ready-to-sign approve + deposit TVM contract calls!)
      const relayQuote =
        params.bridgePreference !== 'lifi'
          ? await quoteRelayNonEvm({
              originChainId: RELAY_TRON_CHAIN_ID,
              originCurrency,
              amountRaw: asset.rawBalance,
              userAddress: params.userAddress,
              solanaDestination: params.solanaDestination,
              outputAsset,
              protocolFeeBps: feeCfg.feeBps,
            })
          : null;

      if (relayQuote) {
        const haircut = checkQuoteHaircutPass({
          grossUsd: asset.grossUsd,
          quotedOutUsd: relayQuote.quotedOutUsd,
          estimatedGasUsd: relayQuote.estimatedGasUsd,
          allowHighCost: params.allowHighCost,
        });
        if (!haircut.passed) {
          skippedAssets.push({ assetId: asset.id, assetSymbol: asset.symbol, reason: haircut.reason });
          continue;
        }
        maxSeconds = Math.max(maxSeconds, relayQuote.estimatedSeconds);
        for (const step of relayQuote.steps) {
          if (step.data?.parameter || step.data?.type) liveExecutable = true;
          calls.push({
            stepId: `tron_relay_${step.id}`,
            assetId: asset.id,
            assetSymbol: asset.symbol,
            action: asset.action,
            provider: 'relay',
            label: `${step.id === 'approve' ? 'Approve' : 'Convert'} ${asset.symbol} → ${relayQuote.estimatedOutputUi} (Relay)`,
            description: step.description,
            nativePayload: {
              tvmStep: step.data,
              stepKind: step.id,
              requestId: relayQuote.requestId,
              solanaDestination: params.solanaDestination,
            },
          });
        }
        bridgeTrackers.push({
          assetId: asset.id,
          assetSymbol: asset.symbol,
          provider: 'relay',
          requestId: relayQuote.requestId,
          estimatedOutput: relayQuote.estimatedOutputUi,
          estimatedSeconds: relayQuote.estimatedSeconds,
        });
        continue;
      }

      // 2. Fallback: Live LI.FI TVM quote
      const lifiQuote = await quoteLifiNonEvm({
        fromChainId: LIFI_TRON_CHAIN_ID,
        fromToken: asset.address === 'native' ? 'TRX' : asset.address,
        fromAmount: asset.rawBalance,
        fromAddress: params.userAddress,
        solanaDestination: params.solanaDestination,
        outputAsset,
      });

      if (lifiQuote) {
        const haircut = checkQuoteHaircutPass({
          grossUsd: asset.grossUsd,
          quotedOutUsd: lifiQuote.quotedOutUsd,
          estimatedGasUsd: lifiQuote.estimatedGasUsd,
          allowHighCost: params.allowHighCost,
        });
        if (!haircut.passed) {
          skippedAssets.push({ assetId: asset.id, assetSymbol: asset.symbol, reason: haircut.reason });
          continue;
        }
        if (lifiQuote.liveExecutable) liveExecutable = true;
        maxSeconds = Math.max(maxSeconds, lifiQuote.estimatedSeconds);
        calls.push({
          stepId: 'tron_lifi_convert',
          assetId: asset.id,
          assetSymbol: asset.symbol,
          action: asset.action,
          provider: 'lifi',
          label: `Convert ${asset.uiBalance} ${asset.symbol} → ${lifiQuote.estimatedOutputUi} (${lifiQuote.tool})`,
          description: `Live LI.FI Tron TVM conversion to Solana ${outputAsset}`,
          nativePayload: {
            transactionRequest: lifiQuote.transactionRequest,
            requestId: lifiQuote.requestId,
            solanaDestination: params.solanaDestination,
          },
        });
        bridgeTrackers.push({
          assetId: asset.id,
          assetSymbol: asset.symbol,
          provider: 'lifi',
          requestId: lifiQuote.requestId,
          estimatedOutput: lifiQuote.estimatedOutputUi,
          estimatedSeconds: lifiQuote.estimatedSeconds,
        });
      } else {
        skippedAssets.push({
          assetId: asset.id,
          assetSymbol: asset.symbol,
          reason: `No live Tron → Solana route found for ${asset.symbol}.`,
        });
      }
    }

    const grossUsd = Number(sweepable.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const estimatedFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    notes.push('TRC-20 USDT has no EIP-2612 permit(); Direct Mode executes standard approve + deposit TVM transactions in TronLink (like Rabby EOA).');

    return {
      family: 'tron',
      chain: 'tron',
      chainId: '0x2b6653dc',
      chainName: 'Tron',
      explorerUrl: 'https://tronscan.org/#',
      userAddress: params.userAddress,
      solanaDestination: params.solanaDestination,
      solanaUsdcAtaBytes32,
      outputAsset,
      executionKind: 'tron_tvm_tx',
      signingStandard: 'TronLink tronWeb.trx.sign + sendRawTransaction',
      liveExecutable,
      calls,
      bridgeTrackers,
      skippedAssets,
      savings: {
        totalCalls: calls.length,
        walletPopupsBatched: calls.length,
        walletPopupsLegacy: calls.length,
        popupsSaved: 0,
      },
      feeBreakdown: {
        feeBps: feeCfg.feeBps,
        feePercent: feeCfg.feePercent,
        feeRecipient,
        collectionMethod: feeRecipient ? 'tron_router_or_relay' : 'relay_quote_only',
        estimatedFeeUsd,
      },
      estimatedSeconds: maxSeconds,
      gaslessAvailable: Boolean(process.env.TURGALIUM_TRON_RELAYER_KEY?.trim()),
      gaslessMechanism: 'Relayer Dual ENERGY + BANDWIDTH Delegation (DelegateResourceContract) or GasFree USDT',
      notes,
    };
  },

  async buildGaslessIntent(params): Promise<UniversalGaslessIntent> {
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    const mintRecipientBytes32 = solanaAddressToBytes32(params.solanaDestination);
    const tronRouter =
      getNonEvmFeeRecipient('tron') || 'TTurgaliumTronRouterEnergyDelegat000';
    const chainAssets = filterChainSweepableAssets('tron', params.assets);
    const grossUsd = Number(chainAssets.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const protocolFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const sponsoredGasEstUsd = Number(Math.max(0.35, chainAssets.length * 0.35).toFixed(2));
    const estimatedNetUsd = Number(Math.max(0, grossUsd - protocolFeeUsd - sponsoredGasEstUsd).toFixed(2));
    const minNetUsdcOut = BigInt(Math.round(estimatedNetUsd * 0.98 * 1_000_000)).toString();
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    const nonce = BigInt('0x' + crypto.randomBytes(8).toString('hex')).toString();

    const breakEven = evaluateNonEvmGaslessBreakEven({
      grossUsd,
      sponsoredGasEstUsd,
      protocolFeeBps: feeCfg.feeBps,
      estimatedNetUsd,
    });

    const signPayload = {
      standard: 'TIP-712',
      domain: { name: 'TurgaliumTronRouter', version: '1', chainId: '0x2b6653dc', verifyingContract: tronRouter },
      relayerPreStep: {
        contractType: 'DelegateResourceContract',
        resources: ['ENERGY', 'BANDWIDTH'],
        resource: 'ENERGY',
        receiverAddress: params.userAddress,
        energyAmount: 130_000 * Math.max(1, chainAssets.length),
        bandwidthAmount: 500 * Math.max(1, chainAssets.length),
        ensureAccountActivated: true,
        lock: false,
      },
      gasFreeNote:
        'TRC-20 USDT does not implement EIP-2612 permit(); relayer delegates both ENERGY & BANDWIDTH (and activates account if needed) so user signs normal TVM tx with $0 TRX, or routes via GasFree smart wallet.',
      message: {
        owner: params.userAddress,
        tokens: chainAssets.map((a) => ({ token: a.address, amount: a.rawBalance })),
        solanaRecipient: mintRecipientBytes32,
        bridgeProvider: 'Relay / Allbridge Core / LI.FI',
        feeBps: feeCfg.feeBps,
        minNetUsdcOut,
        nonce,
        deadline,
      },
    };

    const intentDigestSha256 =
      '0x' + crypto.createHash('sha256').update(JSON.stringify(signPayload)).digest('hex');

    return {
      intentId: `int_tron_${crypto.randomBytes(4).toString('hex')}`,
      family: 'tron',
      mode: 'tron_energy_delegated_tip712',
      chain: 'tron',
      chainId: '0x2b6653dc',
      chainName: 'Tron',
      userAddress: params.userAddress,
      solanaDestination: params.solanaDestination,
      solanaMintRecipientBytes32: mintRecipientBytes32,
      outputAsset: params.outputAsset ?? 'USDC',
      nonce,
      deadline,
      userGasCostUsd: 0,
      sponsoredGasEstUsd,
      gasSponsorshipMechanism: 'Tron Dual Energy + Bandwidth Delegation (DelegateResourceContract) or GasFree ($0 TRX)',
      protocolFeeBps: feeCfg.feeBps,
      protocolFeePercent: feeCfg.feePercent,
      protocolFeeUsd,
      feeRecipient: getNonEvmFeeRecipient('tron'),
      minNetUsdcOut,
      estimatedNetUsd,
      coveredAssets: chainAssets.map((a) => ({
        id: a.id,
        symbol: a.symbol,
        address: a.address,
        rawBalance: a.rawBalance,
        grossUsd: a.grossUsd,
      })),
      signPayload,
      relayerConfigured: Boolean(process.env.TURGALIUM_TRON_RELAYER_KEY?.trim()),
      sponsorEligible: breakEven.eligible,
      sponsorRejectionReason: breakEven.rejectionReason,
      intentDigestSha256,
      explanation: `Relayer delegates both ENERGY & BANDWIDTH via DelegateResourceContract (plus account activation if needed) so TronLink sweeps trapped TRC-20 USDT with $0 TRX → Relay/Allbridge → Solana.`,
    };
  },

  async simulatePreSignProof(params): Promise<UniversalPreSignProof> {
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    const cleanAddr = params.userAddress.trim();
    const userAddressValid = tronAdapter.matchesAddress(cleanAddr);
    let expectedBytes32 = '0x' + '00'.repeat(32);
    let solanaRecipientValid = false;
    try {
      expectedBytes32 = solanaAddressToBytes32(params.solanaDestination);
      solanaRecipientValid = true;
    } catch {
      solanaRecipientValid = false;
    }

    const sweepable = filterChainSweepableAssets('tron', params.assets);
    const outputAsset = params.outputAsset ?? 'USDC';

    const [acctRes, nowBlock, resources, solSnap, priceMap] = await Promise.all([
      userAddressValid
        ? tronFetch<{
            data?: Array<{
              balance?: number;
              trc20?: Array<Record<string, string>>;
            }>;
          }>(`/v1/accounts/${encodeURIComponent(cleanAddr)}`)
        : Promise.resolve(null),
      tronFetch<{ block_header?: { raw_data?: { number?: number } } }>('/wallet/getnowblock', {
        method: 'POST',
        body: '{}',
      }),
      userAddressValid
        ? tronFetch<{
            freeNetLimit?: number;
            freeNetUsed?: number;
            NetLimit?: number;
            NetUsed?: number;
            EnergyLimit?: number;
            EnergyUsed?: number;
          }>('/wallet/getaccountresource', {
            method: 'POST',
            body: JSON.stringify({ address: cleanAddr, visible: true }),
          })
        : Promise.resolve(null),
      solanaRecipientValid
        ? fetchSolanaWalletBalances(params.solanaDestination).catch(() => null)
        : Promise.resolve(null),
      fetchLiveUsdPrices(['coingecko:tron']),
    ]);

    const blockNumber = nowBlock?.block_header?.raw_data?.number ?? 0;
    const acct = acctRes?.data?.[0];
    const acctKnown = Boolean(acctRes && Array.isArray(acctRes.data));
    const liveTrxSun = BigInt(Math.max(0, Math.trunc(acct?.balance ?? 0)));
    const liveTrc20Balances = new Map<string, bigint>();
    for (const entry of acct?.trc20 ?? []) {
      for (const [contract, rawBal] of Object.entries(entry)) {
        try {
          liveTrc20Balances.set(contract, BigInt(rawBal || '0'));
        } catch {
          // ignore
        }
      }
    }

    const nativeBalanceUi = Number(unitsToUi(liveTrxSun.toString(), 6).toFixed(4));
    const nativePriceUsd = params.nativePriceUsd ?? priceMap.get('coingecko:tron') ?? 0.24;
    const nativeBalanceUsd = Number((nativeBalanceUi * nativePriceUsd).toFixed(2));
    const availEnergy = Math.max(0, Number(resources?.EnergyLimit ?? 0) - Number(resources?.EnergyUsed ?? 0));
    const availBandwidth =
      Math.max(0, Number(resources?.freeNetLimit ?? 0) - Number(resources?.freeNetUsed ?? 0)) +
      Math.max(0, Number(resources?.NetLimit ?? 0) - Number(resources?.NetUsed ?? 0));
    const estimatedGasUsd = Number(Math.max(0.35, sweepable.length * 0.35).toFixed(2));
    const hasEnoughNativeGas = (availEnergy >= 65_000 && availBandwidth >= 350) || nativeBalanceUi >= 15;
    const grossUsd = Number(sweepable.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const feeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const estimatedNetUsd = Number(Math.max(0, grossUsd - feeUsd - estimatedGasUsd).toFixed(2));
    const guaranteedMinNetUsd = Number((estimatedNetUsd * 0.98).toFixed(2));
    const tronReachable = blockNumber > 0;

    // Fail-closed live TRX & TRC-20 balance check
    let insufficientBalanceDetail: string | null = null;
    if (acctKnown) {
      for (const a of sweepable) {
        if (a.address === 'stake_v2:trx') continue;
        let reqRaw = 0n;
        try {
          reqRaw = BigInt(a.rawBalance || '0');
        } catch {
          reqRaw = 0n;
        }
        if (a.address === 'native') {
          if (reqRaw > liveTrxSun) {
            insufficientBalanceDetail = `Insufficient live TRX balance (${liveTrxSun.toString()} sun available < ${reqRaw.toString()} requested).`;
            break;
          }
        } else {
          const availRaw = liveTrc20Balances.get(a.address) ?? 0n;
          if (reqRaw > availRaw) {
            insufficientBalanceDetail = `Insufficient live TRC-20 balance for ${a.symbol} (${availRaw.toString()} available < ${reqRaw.toString()} requested).`;
            break;
          }
        }
      }
    }

    const ataMissing = outputAsset === 'USDC' && solSnap !== null && !solSnap.hasUsdcAta;

    // Real live POST /wallet/triggerconstantcontract ONLY when a TVM constant-call payload is provided
    let triggerPayload: Record<string, unknown> | null = params.simulationPayload ?? null;
    if (!triggerPayload && params.rawTxBytes?.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(params.rawTxBytes);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          triggerPayload = parsed as Record<string, unknown>;
        }
      } catch {
        // invalid JSON handled below
      }
    }
    const rawPayloadMalformed = Boolean(params.rawTxBytes && !triggerPayload);

    let liveSimSucceeded = false;
    let liveSimError: string | null = rawPayloadMalformed
      ? 'Tron /wallet/triggerconstantcontract requires a JSON contract call payload.'
      : null;
    let liveSimEnergyUsed: number | null = null;
    let liveSimUnreachable = false;

    if (triggerPayload && userAddressValid && solanaRecipientValid && !insufficientBalanceDetail) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4200);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (process.env.TRONGRID_API_KEY?.trim()) {
          headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY.trim();
        }
        const res = await fetch(`${TRONGRID_BASE}/wallet/triggerconstantcontract`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            owner_address: cleanAddr,
            visible: true,
            ...triggerPayload,
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const json = (await res.json().catch(() => ({}))) as {
          result?: { result?: boolean; code?: string; message?: string };
          energy_used?: number;
          transaction?: { ret?: Array<{ contractRet?: string }> };
          Error?: string;
        };
        const contractRet = json.transaction?.ret?.[0]?.contractRet;
        if (res.ok && json.result?.result === true && contractRet !== 'REVERT' && !json.Error) {
          liveSimSucceeded = true;
          liveSimEnergyUsed = Number(json.energy_used ?? 0);
        } else {
          liveSimError =
            json.Error ||
            (contractRet === 'REVERT' ? 'TVM execution REVERTED' : null) ||
            json.result?.message ||
            json.result?.code ||
            `TronGrid /wallet/triggerconstantcontract failed (HTTP ${res.status})`;
        }
      } catch {
        liveSimUnreachable = true;
      }
    }

    const warnings: string[] = [];
    if (!userAddressValid) {
      warnings.push(`Invalid Tron address format: ${cleanAddr || '(empty)'}.`);
    }
    if (!solanaRecipientValid) {
      warnings.push('Invalid Solana destination address (expected valid non-zero base58 pubkey).');
    }
    if (ataMissing) {
      warnings.push('Destination Solana wallet has no canonical USDC ATA yet; create ATA before settling USDC.');
    }
    if (sweepable.length === 0) {
      warnings.push('No sweepable Tron assets selected.');
    }
    if (insufficientBalanceDetail) {
      warnings.push(insufficientBalanceDetail);
    }
    if (!hasEnoughNativeGas) {
      warnings.push(
        `Low TRX/Resources (${nativeBalanceUi} TRX · ${availEnergy.toLocaleString()} Energy · ${availBandwidth} Bandwidth). Dual Energy+Bandwidth delegation or ~15 TRX needed.`
      );
    }
    if (!tronReachable) {
      warnings.push('TronGrid block height could not be reached for live verification.');
    }
    if (liveSimError) {
      warnings.push(`Tron /wallet/triggerconstantcontract reverted: ${liveSimError}`);
    }

    const failClosedTx =
      !userAddressValid ||
      sweepable.length === 0 ||
      Boolean(insufficientBalanceDetail) ||
      Boolean(liveSimError);
    const failClosedRecipient = !solanaRecipientValid || ataMissing;

    const simulatedLive = Boolean(triggerPayload && liveSimSucceeded && !failClosedTx && !failClosedRecipient);
    const allChecksSafe = Boolean(simulatedLive && !failClosedTx && !failClosedRecipient);

    const tvmCheckStatus: UniversalPreSignProof['checks'][number]['preflightStatus'] = failClosedTx
      ? 'reverted'
      : liveSimUnreachable || (!triggerPayload && !tronReachable)
      ? 'rpc_skipped'
      : simulatedLive
      ? 'verified'
      : 'unsimulated';

    const recipientCheckStatus: UniversalPreSignProof['checks'][number]['preflightStatus'] = failClosedRecipient
      ? 'reverted'
      : simulatedLive
      ? 'verified'
      : 'unsimulated';

    const simulationNote = simulatedLive
      ? `Live Tron /wallet/triggerconstantcontract passed (energy_used=${liveSimEnergyUsed ?? 0}) at block #${blockNumber.toLocaleString()}.`
      : failClosedTx || failClosedRecipient
      ? `Pre-flight check failed closed: ${warnings[0] ?? 'validation rejected.'}`
      : liveSimUnreachable || !tronReachable
      ? 'TronGrid /wallet/triggerconstantcontract unreachable; TVM call was not simulated.'
      : 'High-level Tron intent pre-flight only: /wallet/triggerconstantcontract requires target contract_address, function_selector, and parameter.';

    const proofDigestSha256 =
      '0x' +
      crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            family: 'tron',
            blockNumber,
            userAddress: cleanAddr,
            expectedBytes32,
            simulatedLive,
            outflows: sweepable.map((a) => ({ id: a.id, raw: a.rawBalance })),
            guaranteedMinNetUsd,
          })
        )
        .digest('hex');

    return {
      proofId: `prf_tron_${crypto.randomBytes(4).toString('hex')}`,
      family: 'tron',
      proofDigestSha256,
      generatedAt: new Date().toISOString(),
      chain: 'tron',
      chainId: '0x2b6653dc',
      chainName: 'Tron',
      blockNumber,
      userAddress: cleanAddr,
      solanaDestination: params.solanaDestination,
      solanaMintRecipientBytes32: expectedBytes32,
      mintRecipientVerified: solanaRecipientValid,
      hasEnoughNativeGas,
      nativeBalanceUi,
      nativeSymbol: 'TRX',
      nativeBalanceUsd,
      estimatedGasUsd,
      recommendedMode: hasEnoughNativeGas ? 'sequential' : 'sponsored_gasless',
      simulationEndpoint: '/wallet/getaccountresource + /wallet/triggerconstantcontract',
      simulatedLive,
      simulationNote,
      outflows: sweepable.map((a) => ({
        symbol: a.symbol,
        amount: a.uiBalance,
        usd: a.grossUsd,
        action: a.action,
      })),
      protocolFee: {
        feeBps: feeCfg.feeBps,
        feePercent: feeCfg.feePercent,
        estimatedFeeUsd: feeUsd,
        feeRecipientEvm: null,
        collectionMethod: 'tron_router_fee_5_to_10_pct',
      },
      guaranteedMinNetUsd,
      estimatedNetUsd,
      outputAsset,
      preSolanaSnapshot: solSnap
        ? {
            usdcBalance: solSnap.usdcBalance,
            solBalance: solSnap.solBalance,
            hasUsdcAta: solSnap.hasUsdcAta,
            slot: solSnap.slot,
          }
        : undefined,
      checks: [
        {
          stepId: 'tron_triggerconstantcontract',
          assetSymbol: 'USDT',
          actionType: 'tron_constant_call',
          target: 'api.trongrid.io/wallet/triggerconstantcontract',
          summary:
            tvmCheckStatus === 'verified'
              ? `Live Tron /wallet/triggerconstantcontract passed (energy ${liveSimEnergyUsed ?? 0})`
              : tvmCheckStatus === 'reverted'
              ? liveSimError
                ? `TVM simulation reverted: ${liveSimError.slice(0, 120)}`
                : insufficientBalanceDetail || warnings[0] || 'Tron pre-flight rejected'
              : tvmCheckStatus === 'rpc_skipped'
              ? 'TronGrid unreachable'
              : `Pre-flight Tron state checked at #${blockNumber.toLocaleString()} (no TVM call simulated)`,
          preflightStatus: tvmCheckStatus,
          preflightDetail:
            tvmCheckStatus === 'verified'
              ? `Block #${blockNumber.toLocaleString()} · triggerconstantcontract passed (energy_used=${liveSimEnergyUsed ?? 0})`
              : tvmCheckStatus === 'reverted'
              ? liveSimError || insufficientBalanceDetail || warnings[0] || 'Tron pre-flight check failed closed'
              : tvmCheckStatus === 'rpc_skipped'
              ? 'TronGrid rate-limited'
              : `Block #${blockNumber.toLocaleString()} · ${nativeBalanceUi} TRX · ${availEnergy.toLocaleString()} Energy · ${availBandwidth} BW (TVM call payload not supplied)`,
        },
        {
          stepId: 'tron_mayan_allbridge',
          assetSymbol: outputAsset,
          actionType: 'bridge_or_swap',
          target: 'Relay / LI.FI / Allbridge → Solana',
          summary: !solanaRecipientValid
            ? 'Invalid Solana destination address'
            : ataMissing
            ? 'Solana destination USDC ATA missing'
            : `Solana recipient ${params.solanaDestination.slice(0, 6)}… checked (${simulatedLive ? 'verified' : 'unsimulated'})`,
          preflightStatus: recipientCheckStatus,
          preflightDetail: !solanaRecipientValid
            ? 'Solana destination failed base58 / non-zero public key validation'
            : ataMissing
            ? 'Solana wallet has no canonical USDC ATA yet'
            : simulatedLive
            ? 'Solana base58 & bytes32 recipient verified alongside live TVM simulation'
            : 'Solana base58 & bytes32 recipient validated (tx execution not simulated live)',
        },
      ],
      allChecksSafe,
      warnings,
    };
  },

  async relayAndProve(params) {
    const out: {
      submitted?: {
        accepted: boolean;
        mode: string;
        broadcasted?: boolean;
        settlementStatus?: string;
        signatureFingerprint?: string;
        nextStep: string;
      };
      proof?: UniversalExecutionProof;
    } = {};

    if (params.signature || params.intentId) {
      out.submitted = {
        accepted: false,
        mode: 'unsupported_non_evm_relayer',
        broadcasted: false,
        settlementStatus: 'rejected_unverified',
        nextStep:
          'Sponsored relayer submission is not enabled for Tron (requires server-issued intent verification and TVM secp256k1 signature validation). Use Direct Mode (TronLink) to sign and broadcast directly from your wallet.',
      };
    }

    if (params.txHash) {
      const [txInfo, rawTx, postSol] = await Promise.all([
        tronFetch<{
          id?: string;
          blockNumber?: number;
          fee?: number;
          result?: string;
          receipt?: { result?: string; energy_usage_total?: number };
        }>('/wallet/gettransactioninfobyid', {
          method: 'POST',
          body: JSON.stringify({ value: params.txHash }),
        }),
        tronFetch<{ ret?: Array<{ contractRet?: string }> }>('/wallet/gettransactionbyid', {
          method: 'POST',
          body: JSON.stringify({ value: params.txHash }),
        }),
        fetchSolanaWalletBalances(params.solanaDestination).catch(() => null),
      ]);

      const found = Boolean(txInfo?.id);
      const contractRet = rawTx?.ret?.[0]?.contractRet;
      const topFailed = txInfo?.result === 'FAILED';
      const receiptFailed = Boolean(txInfo?.receipt?.result && txInfo.receipt.result !== 'SUCCESS');
      const retFailed = Boolean(contractRet && contractRet !== 'SUCCESS');
      const succeeded = found && !topFailed && !receiptFailed && !retFailed;

      const solanaDeltaProof = postSol
        ? {
            address: postSol.address,
            preUsdc: params.preSolanaUsdc,
            postUsdc: postSol.usdcBalance,
            deltaUsdc:
              typeof params.preSolanaUsdc === 'number'
                ? Number((postSol.usdcBalance - params.preSolanaUsdc).toFixed(4))
                : undefined,
            preSol: params.preSolanaSol,
            postSol: postSol.solBalance,
            deltaSol:
              typeof params.preSolanaSol === 'number'
                ? Number((postSol.solBalance - params.preSolanaSol).toFixed(6))
                : undefined,
            verifiedAtSlot: postSol.slot,
          }
        : undefined;

      const positiveSolanaDelta =
        params.outputAsset === 'SOL'
          ? Boolean(solanaDeltaProof?.deltaSol && solanaDeltaProof.deltaSol > 0)
          : Boolean(
              (solanaDeltaProof?.deltaUsdc && solanaDeltaProof.deltaUsdc > 0) ||
                (solanaDeltaProof?.deltaSol && solanaDeltaProof.deltaSol > 0)
            );

      out.proof = {
        verified: Boolean(succeeded && positiveSolanaDelta),
        family: 'tron',
        proofDigestSha256:
          '0x' +
          crypto
            .createHash('sha256')
            .update(JSON.stringify({ family: 'tron', txHash: params.txHash, succeeded, solanaDeltaProof }))
            .digest('hex'),
        verifiedAt: new Date().toISOString(),
        chain: 'tron',
        chainName: 'Tron',
        txHash: params.txHash,
        explorerUrl: `https://tronscan.org/#/transaction/${params.txHash}`,
        sourceReceipt: {
          found,
          succeeded,
          blockOrHeight: txInfo?.blockNumber,
          gasUsed: txInfo?.receipt?.energy_usage_total
            ? `${txInfo.receipt.energy_usage_total} energy`
            : undefined,
          nativeSymbol: 'TRX',
        },
        decodedTransfers: [],
        bridgeProof: {
          provider: params.provider === 'relay' ? 'Relay (Tron → Solana)' : 'Relay / LI.FI / Allbridge → Solana',
          status: positiveSolanaDelta ? 'success' : succeeded ? 'relaying' : found ? 'failed' : 'pending',
        },
        solanaDeltaProof,
        summary: !found
          ? 'Tron transaction not yet indexed on TronGrid.'
          : succeeded
          ? `Verified on Tron block #${txInfo?.blockNumber ?? '—'} · Solana settlement tracked.`
          : `Tron transaction failed (${txInfo?.receipt?.result || contractRet || txInfo?.result || 'REVERT'}).`,
      };
    }

    return out;
  },
};
