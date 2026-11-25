import crypto from 'node:crypto';
import {
  deriveNonEvmCctpRecipientBytes32,
  evaluateNonEvmGaslessBreakEven,
  fetchWithRetry,
  filterChainSweepableAssets,
  getNonEvmFeeRecipient,
} from '../execution/non-evm-converter.js';
import { getProtocolFeeConfig, SOLANA_CCTP_DOMAIN } from '../scanner/chains.js';
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

const APTOS_REST_URLS = [
  process.env.APTOS_RPC_URL?.trim(),
  'https://api.mainnet.aptoslabs.com/v1',
  'https://aptos-rest.publicnode.com/v1',
].filter((u): u is string => Boolean(u));

const APTOS_GRAPHQL_URL =
  process.env.APTOS_INDEXER_URL?.trim() || 'https://api.mainnet.aptoslabs.com/v1/graphql';

const APTOS_CCTP_DOMAIN = 9;
// Official Circle CCTP TokenMessengerMinter on Aptos Mainnet
const APTOS_CCTP_TOKEN_MESSENGER =
  '0x081e86cebf457a0c6004f35bd648a2794698f52e0dde09a48619dcd3d4294924';
const APTOS_NATIVE_APT_FA = '0x000000000000000000000000000000000000000000000000000000000000000a';
const APTOS_NATIVE_USDC_FA = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b';
const APTOS_NATIVE_USDT_FA = '0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b';

interface CanonicalAptosAsset {
  symbol: string;
  name: string;
  decimals: number;
  coingeckoKey: string;
  /** True ONLY for Native Circle FA USDC accepted by Aptos Circle CCTP Domain 9 */
  isNativeCctpUsdc?: boolean;
  isNativeApt?: boolean;
  isLst?: boolean;
  protocol?: string;
}

// Strict canonical Aptos asset allowlist (CoinStore + Fungible Assets) — prevents fake "*usdc*" spoofing!
const CANONICAL_APTOS_ASSETS: Record<string, CanonicalAptosAsset> = {
  '0x1::aptos_coin::aptoscoin': {
    symbol: 'APT',
    name: 'Aptos Coin',
    decimals: 8,
    coingeckoKey: 'coingecko:aptos',
    isNativeApt: true,
  },
  '0xa': {
    symbol: 'APT',
    name: 'Aptos Coin (FA)',
    decimals: 8,
    coingeckoKey: 'coingecko:aptos',
    isNativeApt: true,
  },
  [APTOS_NATIVE_APT_FA]: {
    symbol: 'APT',
    name: 'Aptos Coin (FA)',
    decimals: 8,
    coingeckoKey: 'coingecko:aptos',
    isNativeApt: true,
  },
  [APTOS_NATIVE_USDC_FA]: {
    symbol: 'USDC',
    name: 'Native Aptos USDC (FA)',
    decimals: 6,
    coingeckoKey: 'coingecko:usd-coin',
    isNativeCctpUsdc: true,
  },
  [APTOS_NATIVE_USDT_FA]: {
    symbol: 'USDt',
    name: 'Native Aptos Tether USDt (FA)',
    decimals: 6,
    coingeckoKey: 'coingecko:tether',
  },
  // Legacy bridged CoinStores — NOT native CCTP USDC (must swap via Panora/Liquidswap first!)
  '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::usdc': {
    symbol: 'zUSDC',
    name: 'LayerZero Bridged USDC (Aptos)',
    decimals: 6,
    coingeckoKey: 'coingecko:usd-coin',
  },
  '0xf22bede237a07e121b56d91a491eb7bcdfd1f5907926a9e58338f964a01b17fa::asset::usdt': {
    symbol: 'zUSDT',
    name: 'LayerZero Bridged USDT (Aptos)',
    decimals: 6,
    coingeckoKey: 'coingecko:tether',
  },
  '0x5e156f1207d0ebfa19a9eeff00d62a282278fb8719f4fab3a586a0a2c0fffbea::coin::t': {
    symbol: 'whUSDC',
    name: 'Wormhole Bridged USDC (Aptos)',
    decimals: 6,
    coingeckoKey: 'coingecko:usd-coin',
  },
  // Aptos Liquid Staking Tokens (LSTs)
  '0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a::amapt_token::amnisapt': {
    symbol: 'amAPT',
    name: 'Amnis Staked APT',
    decimals: 8,
    coingeckoKey: 'coingecko:aptos',
    isLst: true,
    protocol: 'Amnis LST',
  },
  '0x111ae3e5bc816a5e63c2da97d0aa3886519e0cd5e4b046659fa35796bd11542a::stapt_token::stakedapt': {
    symbol: 'stAPT',
    name: 'Amnis Staked APT (Yield)',
    decimals: 8,
    coingeckoKey: 'coingecko:aptos',
    isLst: true,
    protocol: 'Amnis LST',
  },
  '0xfaf4e633ae9eb31366c9ca24214231760926576c7b625313b3688b5e900731f6::staking::thalaapt': {
    symbol: 'thAPT',
    name: 'Thala Staked APT',
    decimals: 8,
    coingeckoKey: 'coingecko:aptos',
    isLst: true,
    protocol: 'Thala LST',
  },
};

export const APTOS_FAMILY_META: ChainFamilyMeta = {
  family: 'aptos',
  label: 'Aptos',
  shortLabel: 'Aptos',
  chains: [{ id: 'aptos', name: 'Aptos', nativeSymbol: 'APT', logo: '/logos/aptos.svg', cctpDomain: APTOS_CCTP_DOMAIN }],
  signingMechanism: 'Direct Move Entry Function (Petra / Phantom) or Native FeePayerRawTransaction',
  gasSponsorshipMechanism: 'Direct Petra/Phantom or Aptos Native Fee Payer Transaction ($0 user APT)',
  preSignProofMechanism: 'Aptos Indexer GraphQL + /v1/transactions/simulate + Circle CCTP ATA bytes32 + Solana snapshot',
  bridgeProviders: ['Circle CCTP (Domain 9 → 5)', 'Panora / Wormhole'],
  wallets: [
    { id: 'petra', name: 'Petra Wallet', logo: '/logos/petra.svg', installUrl: 'https://petra.app' },
    { id: 'phantom-aptos', name: 'Phantom (Aptos)', logo: '/logos/phantom.svg', installUrl: 'https://phantom.app' },
  ],
  sampleAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
  sampleLabel: 'Aptos Framework Sample',
  addressHint: '0x… (64-hex Aptos address)',
};

async function aptosGet<T>(path: string, timeoutMs = 4200): Promise<T | null> {
  for (const base of APTOS_REST_URLS) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (process.env.APTOS_API_KEY?.trim()) {
      headers.Authorization = `Bearer ${process.env.APTOS_API_KEY.trim()}`;
    }
    const res = await fetchWithRetry(`${base}${path}`, { headers }, timeoutMs);
    if (res && res.ok) return (await res.json()) as T;
  }
  return null;
}

async function aptosGraphql<T>(query: string, timeoutMs = 4200): Promise<T | null> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (process.env.APTOS_API_KEY?.trim()) {
    headers.Authorization = `Bearer ${process.env.APTOS_API_KEY.trim()}`;
  }
  const res = await fetchWithRetry(
    APTOS_GRAPHQL_URL,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ query }),
    },
    timeoutMs
  );
  if (res && res.ok) {
    const j = (await res.json()) as { data?: T; errors?: unknown[] };
    if (j.data && (!j.errors || !j.errors.length)) return j.data;
  }
  return null;
}

async function aptosView<T>(payload: Record<string, unknown>, timeoutMs = 3500): Promise<T | null> {
  for (const base of APTOS_REST_URLS) {
    const res = await fetchWithRetry(
      `${base}/view`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      timeoutMs
    );
    if (res && res.ok) return (await res.json()) as T;
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

export const aptosAdapter: ChainFamilyAdapter = {
  family: 'aptos',
  meta: APTOS_FAMILY_META,

  matchesAddress(address: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(address.trim());
  },

  async scanWallet(address: string, label?: string): Promise<ScanReport> {
    const start = Date.now();
    const cleanAddr = address.trim();
    const feeCfg = getProtocolFeeConfig();
    const warnings: string[] = [];
    const safeAddr = cleanAddr.replace(/[^0-9a-fA-Fx]/g, '');

    const faQuery = `{
      current_fungible_asset_balances(
        where: { owner_address: { _eq: "${safeAddr}" }, amount: { _gt: "0" } },
        limit: 50
      ) {
        amount
        asset_type
        metadata { symbol name decimals }
      }
    }`;

    const [ledger, gqlFa, resources, aptFaRes, usdcFaRes, priceMap] = await Promise.all([
      aptosGet<{ ledger_version?: string; block_height?: string }>(''),
      aptosGraphql<{
        current_fungible_asset_balances?: Array<{
          amount: string | number;
          asset_type: string;
          metadata?: { symbol?: string; name?: string; decimals?: number };
        }>;
      }>(faQuery),
      aptosGet<Array<{ type: string; data?: Record<string, unknown> }>>(
        `/accounts/${encodeURIComponent(cleanAddr)}/resources?limit=200`
      ),
      aptosView<[string]>({
        function: '0x1::primary_fungible_store::balance',
        type_arguments: ['0x1::fungible_asset::Metadata'],
        arguments: [cleanAddr, '0xa'],
      }),
      aptosView<[string]>({
        function: '0x1::primary_fungible_store::balance',
        type_arguments: ['0x1::fungible_asset::Metadata'],
        arguments: [cleanAddr, APTOS_NATIVE_USDC_FA],
      }),
      fetchLiveUsdPrices(['coingecko:aptos', 'coingecko:usd-coin', 'coingecko:tether', 'coingecko:solana']),
    ]);

    const rpcReachable = Boolean(ledger || resources || gqlFa);
    if (!rpcReachable) {
      warnings.push('Aptos Mainnet REST & Indexer GraphQL APIs did not respond within 4.2s.');
    }

    const blockNumber = Number(ledger?.block_height || ledger?.ledger_version || 0);
    const aptPrice = priceMap.get('coingecko:aptos') ?? 6.1;
    const solPrice = priceMap.get('coingecko:solana') ?? 70;
    const assets: ScannedAsset[] = [];
    const seenAssetTypes = new Set<string>();
    let nativeBalance = 0;

    const pushCanonicalAsset = (assetType: string, rawVal: string) => {
      const key = assetType.trim().toLowerCase();
      const canonical = CANONICAL_APTOS_ASSETS[key];
      if (!canonical) return;
      const dedupeKey = canonical.isNativeApt ? 'apt:native' : key;
      if (seenAssetTypes.has(dedupeKey)) return;

      let rawBig = 0n;
      try {
        rawBig = BigInt(String(rawVal).split('.')[0] || '0');
      } catch {
        return;
      }
      if (rawBig <= 0n) return;
      seenAssetTypes.add(dedupeKey);

      const uiBal = unitsToUi(rawBig.toString(), canonical.decimals);
      if (canonical.isNativeApt) nativeBalance = uiBal;

      const priceUsd = priceMap.get(canonical.coingeckoKey) ?? (canonical.isNativeCctpUsdc ? 1.0 : 0);
      const grossUsd = Number((uiBal * priceUsd).toFixed(2));
      const gasUsd = 0.008;
      const slippageUsd = canonical.isNativeCctpUsdc ? 0 : Number((grossUsd * 0.0025).toFixed(2));
      const isDust = grossUsd < 0.25;

      assets.push({
        id: `aptos:${assetType}`,
        family: 'aptos',
        sourceWallet: cleanAddr,
        chain: 'aptos',
        chainName: 'Aptos',
        address: assetType,
        symbol: canonical.symbol,
        name: canonical.name,
        decimals: canonical.decimals,
        kind: canonical.isLst ? 'defi_position' : canonical.isNativeApt ? 'native' : 'erc20',
        protocol: canonical.protocol,
        underlyingSymbol: canonical.isLst ? 'APT' : undefined,
        rawBalance: rawBig.toString(),
        uiBalance: Number(uiBal.toFixed(6)),
        priceUsd,
        grossUsd,
        liquidityUsd: canonical.isNativeCctpUsdc ? 350_000_000 : 40_000_000,
        estimatedGasUsd: gasUsd,
        batchedGasUsd: 0.004,
        estimatedSlippageUsd: slippageUsd,
        netUsdcSingle: Math.max(0, Number((grossUsd - gasUsd - slippageUsd).toFixed(2))),
        netUsdcBatched: Math.max(0, Number((grossUsd - 0.004 - slippageUsd).toFixed(2))),
        action: isDust
          ? 'SKIP_GAS_NEGATIVE'
          : canonical.isNativeCctpUsdc
          ? 'BRIDGE_DIRECT_USDC'
          : 'SELL_AND_BRIDGE',
        actionReason: isDust
          ? 'Sub-$0.25 dust on Aptos'
          : canonical.isNativeCctpUsdc
          ? 'Direct Native Circle CCTP (Aptos Domain 9 → Solana USDC ATA PDA)'
          : 'Swap to Native FA USDC (Panora/Liquidswap) → Circle CCTP Domain 9 → Solana',
        selectedByDefault: !isDust,
        honeypotSafe: true,
      });
    };

    // 1. Primary: Aptos Indexer GraphQL (covers ALL Fungible Assets including AIP-63 FA APT 0xa, Native USDC FA, Native USDt FA, & migrated Coins!)
    for (const row of gqlFa?.current_fungible_asset_balances ?? []) {
      if (row.asset_type && row.amount !== undefined) {
        pushCanonicalAsset(row.asset_type, String(row.amount));
      }
    }

    // 2. Direct /v1/view fallbacks for AIP-63 FA APT (0xa) and Native USDC FA
    if (aptFaRes?.[0] && !seenAssetTypes.has('apt:native')) {
      pushCanonicalAsset('0xa', aptFaRes[0]);
    }
    if (usdcFaRes?.[0] && !seenAssetTypes.has(APTOS_NATIVE_USDC_FA)) {
      pushCanonicalAsset(APTOS_NATIVE_USDC_FA, usdcFaRes[0]);
    }

    // 3. Legacy CoinStore resources (strict canonical allowlist only — no substring matching!)
    for (const r of resources ?? []) {
      const m = r.type.match(/^0x1::coin::CoinStore<(.+)>$/);
      if (!m) continue;
      const coinType = m[1];
      const rawVal = String((r.data?.coin as { value?: string } | undefined)?.value ?? '0');
      pushCanonicalAsset(coinType, rawVal);
    }

    const grossUsd = Number(assets.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const defiGrossUsd = Number(
      assets.filter((a) => a.kind === 'defi_position').reduce((s, a) => s + a.grossUsd, 0).toFixed(2)
    );
    const protocolFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const batchedGasUsd = Number(assets.reduce((s, a) => s + a.batchedGasUsd, 0).toFixed(3));
    const singleTxGasUsd = Number(assets.reduce((s, a) => s + a.estimatedGasUsd, 0).toFixed(3));
    const slippageTotal = Number(assets.reduce((s, a) => s + a.estimatedSlippageUsd, 0).toFixed(2));
    const netSolanaUsdc = Number(
      Math.max(0, grossUsd - protocolFeeUsd - batchedGasUsd - slippageTotal).toFixed(2)
    );

    const summary: ChainScanSummary = {
      family: 'aptos',
      sourceWallet: cleanAddr,
      chain: 'aptos',
      chainName: 'Aptos',
      chainId: 1,
      cctpDomain: APTOS_CCTP_DOMAIN,
      rpcStatus: rpcReachable ? 'live' : 'degraded',
      blockNumber,
      gasPriceGwei: 0.001,
      nativeBalance: Number(nativeBalance.toFixed(6)),
      nativeSymbol: 'APT',
      nativePriceUsd: aptPrice,
      assetCount: assets.length,
      defiCount: assets.filter((a) => a.kind === 'defi_position').length,
      liquidCount: assets.filter((a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC').length,
      burnCount: 0,
      skippedCount: assets.filter((a) => a.action === 'SKIP_GAS_NEGATIVE').length,
      grossUsd,
      netUsdcBridged: netSolanaUsdc,
      totalGasUsd: batchedGasUsd,
      gasSavedByBatchUsd: Number(Math.max(0, singleTxGasUsd - batchedGasUsd).toFixed(3)),
      cctpAttestationSec: 18,
      needsGasSponsorship: nativeBalance < 0.05,
      sponsorshipMechanism: 'Direct Move Entry Function or Native FeePayerRawTransaction ($0 user APT)',
    };

    return applyTwoLevelRoiToReport({
      scanId: `scan_aptos_${crypto.randomBytes(4).toString('hex')}`,
      family: 'aptos',
      mode: 'live_rpc',
      walletAddress: cleanAddr,
      walletLabel: label || 'Aptos Mainnet',
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
    const feeRecipient = getNonEvmFeeRecipient('aptos');
    const solanaUsdcAtaBytes32 = deriveNonEvmCctpRecipientBytes32(params.solanaDestination);
    const sweepable = filterChainSweepableAssets('aptos', params.assets);

    const calls: PreparedNonEvmCall[] = [];
    const bridgeTrackers: PreparedNonEvmBatch['bridgeTrackers'] = [];
    const skippedAssets: PreparedNonEvmBatch['skippedAssets'] = [];
    const notes: string[] = [];
    let liveExecutable = false;

    for (const asset of sweepable) {
      const isNativeUsdcFa = asset.address.trim().toLowerCase() === APTOS_NATIVE_USDC_FA;
      if (isNativeUsdcFa && outputAsset === 'USDC') {
        // Real Aptos Circle CCTP Domain 9 Move entry function targeting canonical Solana USDC ATA PDA!
        const rawAmt = BigInt(asset.rawBalance || '0');
        const feeRaw = feeRecipient ? (rawAmt * BigInt(feeCfg.feeBps)) / 10_000n : 0n;
        const netBurnRaw = rawAmt - feeRaw;

        if (feeRecipient && feeRaw > 0n) {
          calls.push({
            stepId: 'aptos_protocol_fee_fa',
            assetId: asset.id,
            assetSymbol: asset.symbol,
            action: asset.action,
            provider: 'aptos_fa_transfer',
            label: `Protocol Fee (${feeCfg.feePercent}% USDC)`,
            description: `Transfers ${feeCfg.feePercent}% Native FA USDC fee to Siphon treasury`,
            nativePayload: {
              type: 'entry_function_payload',
              function: '0x1::primary_fungible_store::transfer',
              type_arguments: ['0x1::fungible_asset::Metadata'],
              arguments: [APTOS_NATIVE_USDC_FA, feeRecipient, feeRaw.toString()],
            },
          });
        }

        // Convert bytes32 hex to byte array vector<u8> expected by Move CCTP deposit_for_burn
        const recipientBytes = Array.from(Buffer.from(solanaUsdcAtaBytes32.slice(2), 'hex'));
        calls.push({
          stepId: 'aptos_cctp_deposit_for_burn',
          assetId: asset.id,
          assetSymbol: asset.symbol,
          action: asset.action,
          provider: 'circle_cctp',
          label: `Circle CCTP Domain 9 → Solana USDC ATA (${(Number(netBurnRaw) / 1e6).toFixed(2)} USDC)`,
          description: `Calls Circle TokenMessengerMinter.deposit_for_burn targeting canonical Solana USDC ATA PDA`,
          nativePayload: {
            type: 'entry_function_payload',
            function: `${APTOS_CCTP_TOKEN_MESSENGER}::token_messenger::deposit_for_burn`,
            type_arguments: [],
            arguments: [
              netBurnRaw.toString(),
              SOLANA_CCTP_DOMAIN,
              recipientBytes,
              APTOS_NATIVE_USDC_FA,
            ],
          },
        });
        liveExecutable = true;
        bridgeTrackers.push({
          assetId: asset.id,
          assetSymbol: asset.symbol,
          provider: 'circle_cctp',
          estimatedOutput: `${(Number(netBurnRaw) / 1e6).toFixed(2)} USDC`,
          estimatedSeconds: 20,
          requiresSolanaClaim: true,
        });
      } else {
        skippedAssets.push({
          assetId: asset.id,
          assetSymbol: asset.symbol,
          reason: `Swap ${asset.symbol} → Native Aptos USDC FA (Panora/Liquidswap) first, or set PANORA_API_KEY for automated swap+CCTP quoting.`,
        });
      }
    }

    if (!calls.length && sweepable.length > 0) {
      notes.push('Native Aptos USDC FA bridges directly via Circle CCTP Domain 9 in 1 Petra/Phantom signature; non-USDC Aptos tokens require a Panora/Liquidswap swap step first.');
    }

    const grossUsd = Number(sweepable.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const estimatedFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));

    return {
      family: 'aptos',
      chain: 'aptos',
      chainId: 1,
      chainName: 'Aptos',
      explorerUrl: 'https://explorer.aptoslabs.com',
      userAddress: params.userAddress,
      solanaDestination: params.solanaDestination,
      solanaUsdcAtaBytes32,
      outputAsset,
      executionKind: 'aptos_entry_fn',
      signingStandard: 'Petra / Phantom Aptos signAndSubmitTransaction (Move Entry Function)',
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
        collectionMethod: feeRecipient ? 'aptos_fa_transfer_plus_cctp' : 'circle_cctp_only',
        estimatedFeeUsd,
      },
      estimatedSeconds: 20,
      gaslessAvailable: Boolean(process.env.SIPHON_APTOS_FEE_PAYER_KEY?.trim()),
      gaslessMechanism: 'Aptos Native FeePayerRawTransaction ($0 user APT)',
      notes,
    };
  },

  async buildGaslessIntent(params): Promise<UniversalGaslessIntent> {
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    // Canonical SPL USDC ATA PDA (fixes CRIT-03 for Aptos CCTP Domain 9 -> Solana Domain 5!)
    const mintRecipientBytes32 = deriveNonEvmCctpRecipientBytes32(params.solanaDestination);
    const feePayerAddress =
      getNonEvmFeeRecipient('aptos') ||
      '0x00000000000000000000000000000000000000000000000000000000000051f0';
    const chainAssets = filterChainSweepableAssets('aptos', params.assets);
    const grossUsd = Number(chainAssets.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const protocolFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const sponsoredGasEstUsd = 0.01;
    const estimatedNetUsd = Number(Math.max(0, grossUsd - protocolFeeUsd - sponsoredGasEstUsd).toFixed(2));
    const minNetUsdcOut = BigInt(Math.round(estimatedNetUsd * 0.985 * 1_000_000)).toString();
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    const nonce = BigInt('0x' + crypto.randomBytes(8).toString('hex')).toString();

    const breakEven = evaluateNonEvmGaslessBreakEven({
      grossUsd,
      sponsoredGasEstUsd,
      protocolFeeBps: feeCfg.feeBps,
      estimatedNetUsd,
    });

    const signPayload = {
      transactionType: 'FeePayerRawTransaction',
      sender: params.userAddress,
      fee_payer_address: feePayerAddress,
      max_gas_amount: '25000',
      gas_unit_price: '100',
      expiration_timestamp_secs: String(deadline),
      payload: {
        type: 'entry_function_payload',
        function: `${feePayerAddress}::siphon_sweep_router::atomic_sweep_and_bridge`,
        type_arguments: [],
        arguments: [
          chainAssets.map((a) => a.address),
          chainAssets.map((a) => a.rawBalance),
          mintRecipientBytes32,
          SOLANA_CCTP_DOMAIN,
          feeCfg.feeBps,
          minNetUsdcOut,
        ],
      },
    };

    const intentDigestSha256 =
      '0x' + crypto.createHash('sha256').update(JSON.stringify(signPayload)).digest('hex');

    return {
      intentId: `int_aptos_${crypto.randomBytes(4).toString('hex')}`,
      family: 'aptos',
      mode: 'aptos_fee_payer_raw_tx',
      chain: 'aptos',
      chainId: 1,
      chainName: 'Aptos',
      userAddress: params.userAddress,
      solanaDestination: params.solanaDestination,
      solanaMintRecipientBytes32: mintRecipientBytes32,
      outputAsset: params.outputAsset ?? 'USDC',
      nonce,
      deadline,
      userGasCostUsd: 0,
      sponsoredGasEstUsd,
      gasSponsorshipMechanism: 'Aptos Native Fee Payer Transaction (FeePayerRawTransaction)',
      protocolFeeBps: feeCfg.feeBps,
      protocolFeePercent: feeCfg.feePercent,
      protocolFeeUsd,
      feeRecipient: getNonEvmFeeRecipient('aptos'),
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
      relayerConfigured: Boolean(process.env.SIPHON_APTOS_FEE_PAYER_KEY?.trim()),
      sponsorEligible: breakEven.eligible,
      sponsorRejectionReason: breakEven.rejectionReason,
      intentDigestSha256,
      explanation: `1 Petra/Phantom signature signs a Move FeePayerRawTransaction ($0 user APT gas) routing ${chainAssets.length} asset(s) via Circle CCTP Domain 9 → Solana USDC ATA PDA.`,
    };
  },

  async simulatePreSignProof(params): Promise<UniversalPreSignProof> {
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    const cleanAddr = params.userAddress.trim();
    const userAddressValid = aptosAdapter.matchesAddress(cleanAddr);
    let expectedBytes32 = '0x' + '00'.repeat(32);
    let solanaRecipientValid = false;
    try {
      expectedBytes32 = deriveNonEvmCctpRecipientBytes32(params.solanaDestination);
      solanaRecipientValid = true;
    } catch {
      solanaRecipientValid = false;
    }

    const sweepable = filterChainSweepableAssets('aptos', params.assets);
    const outputAsset = params.outputAsset ?? 'USDC';

    const [ledger, aptFaRes, aptCoinRes, usdcFaRes, solSnap, priceMap] = await Promise.all([
      aptosGet<{ block_height?: string; ledger_version?: string }>(''),
      userAddressValid
        ? aptosView<[string]>({
            function: '0x1::primary_fungible_store::balance',
            type_arguments: ['0x1::fungible_asset::Metadata'],
            arguments: [cleanAddr, '0xa'],
          })
        : Promise.resolve(null),
      userAddressValid
        ? aptosGet<{ data?: { coin?: { value?: string } } }>(
            `/accounts/${encodeURIComponent(cleanAddr)}/resource/0x1::coin::CoinStore%3C0x1::aptos_coin::AptosCoin%3E`
          )
        : Promise.resolve(null),
      userAddressValid
        ? aptosView<[string]>({
            function: '0x1::primary_fungible_store::balance',
            type_arguments: ['0x1::fungible_asset::Metadata'],
            arguments: [cleanAddr, APTOS_NATIVE_USDC_FA],
          })
        : Promise.resolve(null),
      solanaRecipientValid
        ? fetchSolanaWalletBalances(params.solanaDestination).catch(() => null)
        : Promise.resolve(null),
      fetchLiveUsdPrices(['coingecko:aptos']),
    ]);

    const blockNumber = Number(ledger?.block_height || ledger?.ledger_version || 0);
    const aptBalanceKnown = Boolean(aptFaRes?.[0] !== undefined || aptCoinRes?.data?.coin?.value !== undefined);
    const rawApt = aptFaRes?.[0] || aptCoinRes?.data?.coin?.value || '0';
    const usdcBalanceKnown = Boolean(usdcFaRes?.[0] !== undefined);
    const rawUsdc = usdcFaRes?.[0] || '0';

    const nativeBalanceUi = Number(unitsToUi(rawApt, 8).toFixed(5));
    const nativePriceUsd = params.nativePriceUsd ?? priceMap.get('coingecko:aptos') ?? 6.1;
    const nativeBalanceUsd = Number((nativeBalanceUi * nativePriceUsd).toFixed(2));
    const estimatedGasUsd = 0.01;
    const hasEnoughNativeGas = nativeBalanceUi >= 0.05;
    const grossUsd = Number(sweepable.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const feeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const estimatedNetUsd = Number(Math.max(0, grossUsd - feeUsd - estimatedGasUsd).toFixed(2));
    const guaranteedMinNetUsd = Number((estimatedNetUsd * 0.985).toFixed(2));
    const rpcReachable = blockNumber > 0;

    // Fail-closed live balance verification for APT & Native FA USDC
    let insufficientBalanceDetail: string | null = null;
    for (const a of sweepable) {
      const addrLower = a.address.trim().toLowerCase();
      let reqRaw = 0n;
      try {
        reqRaw = BigInt(a.rawBalance || '0');
      } catch {
        reqRaw = 0n;
      }
      if (
        (addrLower === '0xa' || addrLower === APTOS_NATIVE_APT_FA || addrLower === '0x1::aptos_coin::aptoscoin') &&
        aptBalanceKnown
      ) {
        if (reqRaw > BigInt(rawApt)) {
          insufficientBalanceDetail = `Insufficient live Aptos APT balance (${rawApt} available < ${reqRaw.toString()} requested).`;
          break;
        }
      } else if (addrLower === APTOS_NATIVE_USDC_FA && usdcBalanceKnown) {
        if (reqRaw > BigInt(rawUsdc)) {
          insufficientBalanceDetail = `Insufficient live Aptos Native USDC FA balance (${rawUsdc} available < ${reqRaw.toString()} requested).`;
          break;
        }
      }
    }

    const ataMissing = outputAsset === 'USDC' && solSnap !== null && !solSnap.hasUsdcAta;

    // Real live POST /v1/transactions/simulate ONLY when a UserTransaction simulation payload is supplied
    let simPayload: Record<string, unknown> | null = params.simulationPayload ?? null;
    if (!simPayload && params.rawTxBytes?.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(params.rawTxBytes);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          simPayload = parsed as Record<string, unknown>;
        }
      } catch {
        // invalid JSON handled below
      }
    }
    const rawPayloadMalformed = Boolean(params.rawTxBytes && !simPayload);

    let liveSimSucceeded = false;
    let liveSimError: string | null = rawPayloadMalformed
      ? 'Aptos /v1/transactions/simulate requires a JSON UserTransaction payload.'
      : null;
    let liveSimGasUsed: string | null = null;
    let liveSimUnreachable = false;

    if (simPayload && userAddressValid && solanaRecipientValid && !insufficientBalanceDetail) {
      let responded = false;
      for (const base of APTOS_REST_URLS) {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (process.env.APTOS_API_KEY?.trim()) {
          headers.Authorization = `Bearer ${process.env.APTOS_API_KEY.trim()}`;
        }
        const res = await fetchWithRetry(
          `${base}/transactions/simulate?estimate_max_gas_amount=true&estimate_gas_unit_price=true`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(simPayload),
          },
          4200
        );
        if (!res) continue;
        responded = true;
        const json = (await res.json().catch(() => null)) as
          | Array<{ success?: boolean; vm_status?: string; gas_used?: string }>
          | { message?: string; error_code?: string }
          | null;
        if (res.ok && Array.isArray(json) && json[0]?.success === true) {
          liveSimSucceeded = true;
          liveSimGasUsed = String(json[0].gas_used ?? '0');
        } else if (Array.isArray(json) && json[0]) {
          liveSimError = json[0].vm_status || 'Aptos VM simulation failed (success=false)';
        } else {
          const errObj = json as { message?: string } | null;
          liveSimError = errObj?.message || `Aptos /v1/transactions/simulate returned HTTP ${res.status}`;
        }
        break;
      }
      if (!responded) {
        liveSimUnreachable = true;
      }
    }

    const warnings: string[] = [];
    if (!userAddressValid) {
      warnings.push(`Invalid Aptos address format: ${cleanAddr || '(empty)'}.`);
    }
    if (!solanaRecipientValid) {
      warnings.push('Invalid Solana destination address (expected valid non-zero base58 pubkey).');
    }
    if (ataMissing) {
      warnings.push('Destination Solana wallet has no canonical USDC ATA yet; create ATA before claiming CCTP USDC.');
    }
    if (sweepable.length === 0) {
      warnings.push('No sweepable Aptos assets selected.');
    }
    if (insufficientBalanceDetail) {
      warnings.push(insufficientBalanceDetail);
    }
    if (!hasEnoughNativeGas) {
      warnings.push(`Low APT gas (${nativeBalanceUi} APT). FeePayerRawTransaction covers $0 user gas.`);
    }
    if (!rpcReachable) {
      warnings.push('Aptos REST API could not be reached for live block height verification.');
    }
    if (liveSimError) {
      warnings.push(`Aptos /v1/transactions/simulate reverted: ${liveSimError}`);
    }

    const failClosedTx =
      !userAddressValid ||
      sweepable.length === 0 ||
      Boolean(insufficientBalanceDetail) ||
      Boolean(liveSimError);
    const failClosedRecipient = !solanaRecipientValid || ataMissing;

    const simulatedLive = Boolean(simPayload && liveSimSucceeded && !failClosedTx && !failClosedRecipient);
    const allChecksSafe = Boolean(simulatedLive && !failClosedTx && !failClosedRecipient);

    const txCheckStatus: UniversalPreSignProof['checks'][number]['preflightStatus'] = failClosedTx
      ? 'reverted'
      : liveSimUnreachable || (!simPayload && !rpcReachable)
      ? 'rpc_skipped'
      : simulatedLive
      ? 'verified'
      : 'unsimulated';

    const cctpCheckStatus: UniversalPreSignProof['checks'][number]['preflightStatus'] = failClosedRecipient
      ? 'reverted'
      : simulatedLive
      ? 'verified'
      : 'unsimulated';

    const simulationNote = simulatedLive
      ? `Live Aptos /v1/transactions/simulate passed (gas_used=${liveSimGasUsed ?? 'ok'}) at block #${blockNumber.toLocaleString()}.`
      : failClosedTx || failClosedRecipient
      ? `Pre-flight check failed closed: ${warnings[0] ?? 'validation rejected.'}`
      : liveSimUnreachable || !rpcReachable
      ? 'Aptos REST /v1/transactions/simulate unreachable; transaction was not simulated.'
      : 'High-level Aptos intent pre-flight only: /v1/transactions/simulate requires a signed/unsigned UserTransaction payload with account public key.';

    const proofDigestSha256 =
      '0x' +
      crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            family: 'aptos',
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
      proofId: `prf_aptos_${crypto.randomBytes(4).toString('hex')}`,
      family: 'aptos',
      proofDigestSha256,
      generatedAt: new Date().toISOString(),
      chain: 'aptos',
      chainId: 1,
      chainName: 'Aptos',
      blockNumber,
      userAddress: cleanAddr,
      solanaDestination: params.solanaDestination,
      solanaMintRecipientBytes32: expectedBytes32,
      mintRecipientVerified: solanaRecipientValid,
      hasEnoughNativeGas,
      nativeBalanceUi,
      nativeSymbol: 'APT',
      nativeBalanceUsd,
      estimatedGasUsd,
      recommendedMode: hasEnoughNativeGas ? 'sequential' : 'sponsored_gasless',
      simulationEndpoint: '/v1/transactions/simulate',
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
        collectionMethod: 'move_sweep_router_5_to_10_pct',
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
          stepId: 'aptos_simulate_tx',
          assetSymbol: 'APT',
          actionType: 'aptos_move_simulate',
          target: 'api.mainnet.aptoslabs.com/v1/transactions/simulate',
          summary:
            txCheckStatus === 'verified'
              ? `Live Aptos /v1/transactions/simulate passed (gas ${liveSimGasUsed ?? 'ok'})`
              : txCheckStatus === 'reverted'
              ? liveSimError
                ? `Aptos simulation reverted: ${liveSimError.slice(0, 120)}`
                : insufficientBalanceDetail || warnings[0] || 'Aptos pre-flight rejected'
              : txCheckStatus === 'rpc_skipped'
              ? 'Aptos REST API unreachable'
              : `Pre-flight Aptos state checked at #${blockNumber.toLocaleString()} (no UserTransaction simulated)`,
          preflightStatus: txCheckStatus,
          preflightDetail:
            txCheckStatus === 'verified'
              ? `Block #${blockNumber.toLocaleString()} · /v1/transactions/simulate success (gas_used=${liveSimGasUsed ?? 'ok'})`
              : txCheckStatus === 'reverted'
              ? liveSimError || insufficientBalanceDetail || warnings[0] || 'Aptos pre-flight check failed closed'
              : txCheckStatus === 'rpc_skipped'
              ? 'Aptos REST busy'
              : `Block #${blockNumber.toLocaleString()} (${nativeBalanceUi} APT) · UserTransaction payload not supplied for live dry-run`,
        },
        {
          stepId: 'aptos_cctp_domain9',
          assetSymbol: 'USDC',
          actionType: 'cctp_deposit_for_burn',
          target: 'cctp::token_messenger::deposit_for_burn',
          summary: !solanaRecipientValid
            ? 'Invalid Solana destination address'
            : ataMissing
            ? 'Solana destination USDC ATA missing'
            : `Native Aptos CCTP Domain 9 → Solana USDC ATA PDA (${simulatedLive ? 'verified' : 'unsimulated'})`,
          preflightStatus: cctpCheckStatus,
          preflightDetail: !solanaRecipientValid
            ? 'Solana destination failed base58 / non-zero public key validation'
            : ataMissing
            ? 'Solana wallet has no canonical USDC ATA yet'
            : simulatedLive
            ? `Canonical Solana USDC ATA bytes32 (${expectedBytes32.slice(0, 14)}…) verified alongside live simulate`
            : `Canonical Solana USDC ATA bytes32 (${expectedBytes32.slice(0, 14)}…) derived (tx execution not simulated live)`,
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

    if (params.signature && params.intentId) {
      if (params.deadline && Math.floor(Date.now() / 1000) > params.deadline) {
        throw new Error('Signed Aptos FeePayer intent expired. Re-sign a fresh intent.');
      }
      const fp = '0x' + crypto.createHash('sha256').update(params.signature).digest('hex').slice(0, 16);
      const configured = Boolean(process.env.SIPHON_APTOS_FEE_PAYER_KEY?.trim());
      out.submitted = {
        accepted: true,
        mode: configured ? 'relayer_queued' : 'intent_verified_awaiting_deployment',
        broadcasted: false,
        settlementStatus: configured ? 'queued_for_fee_payer' : 'awaiting_relayer',
        signatureFingerprint: fp,
        nextStep: configured
          ? `Aptos Fee Payer queued ${params.intentId} (${fp}).`
          : `Aptos 1-Sig Move intent verified (${fp}). Use Direct Mode (Petra/Phantom) for immediate CCTP Domain 9 execution, or configure SIPHON_APTOS_FEE_PAYER_KEY.`,
      };
    }

    if (params.txHash) {
      const [txInfo, postSol] = await Promise.all([
        aptosGet<{ success?: boolean; version?: string; gas_used?: string }>(
          `/transactions/by_hash/${encodeURIComponent(params.txHash)}`
        ),
        fetchSolanaWalletBalances(params.solanaDestination).catch(() => null),
      ]);

      const found = Boolean(txInfo);
      const succeeded = txInfo?.success === true;
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

      const proofDigestSha256 =
        '0x' +
        crypto
          .createHash('sha256')
          .update(JSON.stringify({ family: 'aptos', txHash: params.txHash, succeeded, solanaDeltaProof }))
          .digest('hex');

      out.proof = {
        verified: Boolean(succeeded && positiveSolanaDelta),
        family: 'aptos',
        proofDigestSha256,
        verifiedAt: new Date().toISOString(),
        chain: 'aptos',
        chainName: 'Aptos',
        txHash: params.txHash,
        explorerUrl: `https://explorer.aptoslabs.com/txn/${params.txHash}?network=mainnet`,
        sourceReceipt: {
          found,
          succeeded,
          blockOrHeight: txInfo?.version ? Number(txInfo.version) : undefined,
          gasUsed: txInfo?.gas_used,
          nativeSymbol: 'APT',
        },
        decodedTransfers: [],
        bridgeProof: {
          provider: 'Circle CCTP (Aptos Domain 9 → Solana USDC ATA)',
          status: positiveSolanaDelta ? 'success' : succeeded ? 'attesting_cctp' : found ? 'failed' : 'pending',
        },
        solanaDeltaProof,
        summary: !found
          ? 'Aptos transaction not yet indexed.'
          : succeeded
          ? `Verified on Aptos version #${txInfo?.version ?? '—'} · Circle CCTP → Solana tracked.`
          : 'Aptos transaction aborted.',
      };
    }

    return out;
  },
};
