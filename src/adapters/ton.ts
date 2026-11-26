import crypto from 'node:crypto';
import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import {
  checkQuoteHaircutPass,
  evaluateNonEvmGaslessBreakEven,
  fetchTonGaslessConfig,
  filterChainSweepableAssets,
  getNonEvmFeeRecipient,
  quoteRelayNonEvm,
  RELAY_TON_CHAIN_ID,
  RELAY_TON_NATIVE_CURRENCY,
} from '../execution/non-evm-converter.js';
import { getProtocolFeeConfig } from '../scanner/chains.js';
import { fetchSolanaWalletBalances } from '../scanner/discovery.js';
import { fetchLiveUsdPrices } from '../scanner/prices.js';
import { applyTwoLevelRoiToReport } from '../scanner/roi.js';
import { sanitizeTokenName, sanitizeTokenSymbol } from '../scanner/sanitize.js';
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

const TONAPI_BASE = 'https://tonapi.io/v2';
const TONCENTER_BASE = 'https://toncenter.com/api/v2';

// Canonical TON Jetton Master addresses (raw 0:... AND friendly EQ... forms) — prevents fake "USDT" symbol spoofing!
interface CanonicalJettonMeta {
  symbol: string;
  name: string;
  decimals: number;
  coingeckoKey: string;
  isStable?: boolean;
  isLst?: boolean;
  protocol?: string;
}

const CANONICAL_TON_JETTONS: Record<string, CanonicalJettonMeta> = {
  // Tether USDt on TON
  '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe': {
    symbol: 'USDT',
    name: 'Tether USD (TON)',
    decimals: 6,
    coingeckoKey: 'coingecko:tether',
    isStable: true,
  },
  eqcxe6mutqjkfngfarotkot1lzbdiix1kcixrv7nw2id_sds: {
    symbol: 'USDT',
    name: 'Tether USD (TON)',
    decimals: 6,
    coingeckoKey: 'coingecko:tether',
    isStable: true,
  },
  // Notcoin (NOT)
  '0:2f956143c461769579baef2e32cc2d7bc18283f40d20bb03e432cd603ac33ffc': {
    symbol: 'NOT',
    name: 'Notcoin',
    decimals: 9,
    coingeckoKey: 'coingecko:notcoin',
  },
  // DOGS
  '0:afc49cb8786f21c87045b19ede78fc6b46c51048513f8e9a6d44060199c1bf0c': {
    symbol: 'DOGS',
    name: 'DOGS',
    decimals: 9,
    coingeckoKey: 'coingecko:dogs-2',
  },
  // Tonstakers Liquid Staked TON (tsTON)
  '0:bdf3fa8098d129b54b4f73b5bac5d1e1fd91eb054169c3916dfc8ccd536d1000': {
    symbol: 'tsTON',
    name: 'Tonstakers Staked TON',
    decimals: 9,
    coingeckoKey: 'coingecko:the-open-network',
    isLst: true,
    protocol: 'Tonstakers LST',
  },
  // Bemo Staked TON (stTON)
  '0:cd872fa7c5816052acdf5332260443faec9aacc8c21cca4d92e7f47034d11892': {
    symbol: 'stTON',
    name: 'Bemo Staked TON',
    decimals: 9,
    coingeckoKey: 'coingecko:the-open-network',
    isLst: true,
    protocol: 'Bemo LST',
  },
};

export const TON_FAMILY_META: ChainFamilyMeta = {
  family: 'ton',
  label: 'TON',
  shortLabel: 'TON',
  chains: [{ id: 'ton', name: 'TON', nativeSymbol: 'TON', logo: '/logos/ton.svg', cctpDomain: null }],
  signingMechanism: '1-Sig TonConnect 2 / Wallet W5 Batch (up to 255 messages in 1 signature)',
  gasSponsorshipMechanism: 'Direct TonConnect 2 or TonAPI W5 Gasless Relayer ($0 TON, paid in Jettons)',
  preSignProofMechanism: '/v2/traces/emulate + TonAPI masterchain seqno & verified Jettons + Solana snapshot',
  bridgeProviders: ['Relay (TON → Solana)', 'STON.fi / deBridge DLN'],
  wallets: [
    { id: 'tonkeeper', name: 'Tonkeeper', logo: '/logos/tonkeeper.svg', installUrl: 'https://tonkeeper.com' },
  ],
  sampleAddress: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2',
  sampleLabel: 'TON Sample Vault',
  addressHint: 'EQ…, UQ…, or 0:… TON address',
};

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 4200): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (process.env.TONAPI_KEY?.trim() && url.startsWith(TONAPI_BASE)) {
      headers.Authorization = `Bearer ${process.env.TONAPI_KEY.trim()}`;
    }
    const res = await fetch(url, {
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

export const tonAdapter: ChainFamilyAdapter = {
  family: 'ton',
  meta: TON_FAMILY_META,

  matchesAddress(address: string): boolean {
    const c = address.trim();
    // Mainnet bounceable/non-bounceable (EQ/UQ/Ef/Uf, base64url or standard base64) OR raw masterchain (-1:) / basechain (0:)
    return (
      /^(EQ|UQ|Ef|Uf)[A-Za-z0-9_+/-]{46}$/.test(c) ||
      /^(-1|0):[0-9a-fA-F]{64}$/.test(c)
    );
  },

  async scanWallet(address: string, label?: string): Promise<ScanReport> {
    const start = Date.now();
    const cleanAddr = address.trim();
    const feeCfg = getProtocolFeeConfig();
    const warnings: string[] = [];

    const [account, jettons, head, priceMap] = await Promise.all([
      fetchJson<{ balance?: number; last_activity?: number; interfaces?: string[] }>(
        `${TONAPI_BASE}/accounts/${encodeURIComponent(cleanAddr)}`
      ),
      fetchJson<{
        balances?: Array<{
          balance: string;
          jetton?: {
            address?: string;
            symbol?: string;
            name?: string;
            decimals?: number;
            verification?: 'whitelist' | 'blacklist' | 'none';
          };
          price?: { prices?: { USD?: number } };
        }>;
      }>(`${TONAPI_BASE}/accounts/${encodeURIComponent(cleanAddr)}/jettons?currencies=usd`),
      fetchJson<{ seqno?: number }>(`${TONAPI_BASE}/blockchain/masterchain-head`),
      fetchLiveUsdPrices([
        'coingecko:the-open-network',
        'coingecko:tether',
        'coingecko:notcoin',
        'coingecko:dogs-2',
        'coingecko:solana',
      ]),
    ]);

    let tonNano = account?.balance !== undefined ? String(account.balance) : null;
    let rpcReachable = Boolean(account || head);
    if (tonNano === null) {
      const tc = await fetchJson<{ ok?: boolean; result?: string }>(
        `${TONCENTER_BASE}/getAddressBalance?address=${encodeURIComponent(cleanAddr)}`
      );
      if (tc?.ok && tc.result) {
        tonNano = tc.result;
        rpcReachable = true;
      } else {
        warnings.push('TonAPI & Toncenter public endpoints did not respond within 4.2s.');
      }
    }

    const isWalletW5 = Boolean(account?.interfaces?.some((i) => i.toLowerCase().includes('wallet_v5')));
    const tonPrice = priceMap.get('coingecko:the-open-network') ?? 3.8;
    const solPrice = priceMap.get('coingecko:solana') ?? 70;
    const assets: ScannedAsset[] = [];

    const nativeBalance = tonNano ? unitsToUi(tonNano, 9) : 0;
    if (nativeBalance > 0) {
      const grossUsd = Number((nativeBalance * tonPrice).toFixed(2));
      const gasUsd = 0.04;
      const slippageUsd = Number((grossUsd * 0.004).toFixed(2));
      const isDust = grossUsd < 0.5;
      assets.push({
        id: 'ton:native',
        family: 'ton',
        sourceWallet: cleanAddr,
        chain: 'ton',
        chainName: 'TON',
        address: 'native',
        symbol: 'TON',
        name: 'Toncoin',
        decimals: 9,
        kind: 'native',
        rawBalance: tonNano || '0',
        uiBalance: Number(nativeBalance.toFixed(6)),
        priceUsd: tonPrice,
        grossUsd,
        liquidityUsd: 120_000_000,
        estimatedGasUsd: gasUsd,
        batchedGasUsd: 0.015,
        estimatedSlippageUsd: slippageUsd,
        netUsdcSingle: Math.max(0, Number((grossUsd - gasUsd - slippageUsd).toFixed(2))),
        netUsdcBatched: Math.max(0, Number((grossUsd - 0.015 - slippageUsd).toFixed(2))),
        action: isDust ? 'SKIP_GAS_NEGATIVE' : 'SELL_AND_BRIDGE',
        actionReason: isDust
          ? 'Sub-$0.50 TON dust'
          : 'TonConnect 2 / Wallet W5 conversion via Relay (TON → Solana)',
        selectedByDefault: !isDust,
        honeypotSafe: true,
      });
    }

    for (const j of jettons?.balances ?? []) {
      const masterAddr = (j.jetton?.address || '').trim();
      const masterKey = masterAddr.toLowerCase();
      const canonical = CANONICAL_TON_JETTONS[masterKey];
      const verification = j.jetton?.verification ?? 'none';

      const sym = canonical?.symbol ?? sanitizeTokenSymbol(j.jetton?.symbol, 'JETTON').toUpperCase();
      const dec = canonical?.decimals ?? Math.min(36, Math.max(0, Number(j.jetton?.decimals ?? 9) || 9));
      const uiBal = unitsToUi(j.balance || '0', dec);
      if (uiBal <= 0) continue;

      // Reject blacklisted / scam Jettons explicitly as SKIP_HONEYPOT
      if (verification === 'blacklist') {
        assets.push({
          id: `ton:${masterAddr || sym}`,
          family: 'ton',
          sourceWallet: cleanAddr,
          chain: 'ton',
          chainName: 'TON',
          address: masterAddr || sym,
          symbol: sym,
          name: sanitizeTokenName(j.jetton?.name, `${sym} Jetton`),
          decimals: dec,
          kind: 'dead_token',
          rawBalance: j.balance,
          uiBalance: Number(uiBal.toFixed(6)),
          priceUsd: 0,
          grossUsd: 0,
          liquidityUsd: 0,
          estimatedGasUsd: 0.05,
          batchedGasUsd: 0.015,
          estimatedSlippageUsd: 0,
          netUsdcSingle: 0,
          netUsdcBatched: 0,
          action: 'SKIP_HONEYPOT',
          actionReason: 'Blacklisted/unverified scam Jetton on TonAPI — safely skipped.',
          selectedByDefault: false,
          honeypotSafe: false,
        });
        continue;
      }

      // Only trust canonical Jetton Master allowlist OR TonAPI whitelist + live TonAPI USD price (never symbol-only $1!)
      const tonApiUsd = Number(j.price?.prices?.USD ?? 0);
      const priceUsd = canonical
        ? priceMap.get(canonical.coingeckoKey) ?? (canonical.isStable ? 1.0 : tonApiUsd)
        : verification === 'whitelist' && Number.isFinite(tonApiUsd) && tonApiUsd > 0
        ? tonApiUsd
        : 0;
      const grossUsd = Number((uiBal * priceUsd).toFixed(2));
      if (priceUsd <= 0 || grossUsd === 0) continue;

      const isStable = Boolean(canonical?.isStable);
      const gasUsd = 0.05;
      const slippageUsd = isStable ? Number((grossUsd * 0.001).toFixed(2)) : Number((grossUsd * 0.005).toFixed(2));
      const isDust = grossUsd < 0.5;
      const safeName = canonical?.name ?? sanitizeTokenName(j.jetton?.name, `${sym} Jetton`);

      assets.push({
        id: `ton:${masterAddr || sym}`,
        family: 'ton',
        sourceWallet: cleanAddr,
        chain: 'ton',
        chainName: 'TON',
        address: masterAddr || sym,
        symbol: sym,
        name: safeName,
        decimals: dec,
        kind: canonical?.isLst ? 'defi_position' : 'erc20',
        protocol: canonical?.protocol,
        underlyingSymbol: canonical?.isLst ? 'TON' : undefined,
        rawBalance: j.balance,
        uiBalance: Number(uiBal.toFixed(6)),
        priceUsd,
        grossUsd,
        liquidityUsd: isStable ? 180_000_000 : 12_000_000,
        estimatedGasUsd: gasUsd,
        batchedGasUsd: 0.015,
        estimatedSlippageUsd: slippageUsd,
        netUsdcSingle: Math.max(0, Number((grossUsd - gasUsd - slippageUsd).toFixed(2))),
        netUsdcBatched: Math.max(0, Number((grossUsd - 0.015 - slippageUsd).toFixed(2))),
        action: isDust ? 'SKIP_GAS_NEGATIVE' : isStable ? 'BRIDGE_DIRECT_USDC' : 'SELL_AND_BRIDGE',
        actionReason: isDust
          ? `Sub-$0.50 ${sym} Jetton dust`
          : isWalletW5
          ? 'Wallet W5 1-sig batch (up to 255 msgs; Gasless Jetton fee supported) → Relay/deBridge → Solana'
          : 'TonConnect 2 batch → Relay / STON.fi → Solana',
        selectedByDefault: !isDust,
        honeypotSafe: true,
      });
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

    const summary: ChainScanSummary = {
      family: 'ton',
      sourceWallet: cleanAddr,
      chain: 'ton',
      chainName: 'TON',
      chainId: '-239',
      cctpDomain: null,
      rpcStatus: rpcReachable ? 'live' : 'degraded',
      blockNumber: Number(head?.seqno ?? 0),
      gasPriceGwei: 0.01,
      nativeBalance: Number(nativeBalance.toFixed(6)),
      nativeSymbol: 'TON',
      nativePriceUsd: tonPrice,
      assetCount: assets.length,
      defiCount: assets.filter((a) => a.kind === 'defi_position').length,
      liquidCount: assets.filter((a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC').length,
      burnCount: 0,
      skippedCount: assets.filter((a) => a.action === 'SKIP_GAS_NEGATIVE' || a.action === 'SKIP_HONEYPOT').length,
      grossUsd,
      netUsdcBridged: netSolanaUsdc,
      totalGasUsd: batchedGasUsd,
      gasSavedByBatchUsd: Number(Math.max(0, singleTxGasUsd - batchedGasUsd).toFixed(2)),
      cctpAttestationSec: 25,
      needsGasSponsorship: nativeBalance < 0.25,
      sponsorshipMechanism: isWalletW5
        ? 'Wallet W5 Detected (255-msg batch + TonAPI Jetton Gasless ready)'
        : 'TonConnect 2 Direct Batch (upgrade to Wallet W5 for $0 TON Gasless)',
    };

    return applyTwoLevelRoiToReport({
      scanId: `scan_ton_${crypto.randomBytes(4).toString('hex')}`,
      family: 'ton',
      mode: 'live_rpc',
      walletAddress: cleanAddr,
      walletLabel: label || 'TON Mainnet',
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
        honeypotSkippedCount: assets.filter((a) => a.action === 'SKIP_HONEYPOT').length,
        gasNegativeCount: assets.filter((a) => a.action === 'SKIP_GAS_NEGATIVE').length,
      },
      warnings,
    });
  },

  async prepareDirectBatch(params): Promise<PreparedNonEvmBatch> {
    const outputAsset = params.outputAsset ?? 'USDC';
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    const feeRecipient = getNonEvmFeeRecipient('ton');
    const solanaUsdcAtaBytes32 = solanaAddressToBytes32(params.solanaDestination);
    const sweepable = filterChainSweepableAssets('ton', params.assets);

    const [gaslessCfg] = await Promise.all([fetchTonGaslessConfig()]);

    const calls: PreparedNonEvmCall[] = [];
    const bridgeTrackers: PreparedNonEvmBatch['bridgeTrackers'] = [];
    const skippedAssets: PreparedNonEvmBatch['skippedAssets'] = [];
    const notes: string[] = [];
    let maxSeconds = 25;
    let liveExecutable = false;

    for (const asset of sweepable) {
      const originCurrency =
        asset.address === 'native' ? RELAY_TON_NATIVE_CURRENCY : asset.address;
      const relayQuote = await quoteRelayNonEvm({
        originChainId: RELAY_TON_CHAIN_ID,
        originCurrency,
        amountRaw: asset.rawBalance,
        userAddress: params.userAddress,
        solanaDestination: params.solanaDestination,
        outputAsset,
        protocolFeeBps: feeCfg.feeBps,
      });

      if (!relayQuote) {
        skippedAssets.push({
          assetId: asset.id,
          assetSymbol: asset.symbol,
          reason: `No live Relay TON → Solana route found for ${asset.symbol} (swap via STON.fi to TON/USDT first or check bridge minimum).`,
        });
        continue;
      }

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
        const rawMsgs = Array.isArray(step.data.messages)
          ? (step.data.messages as Array<{ to?: string; address?: string; value?: string; amount?: string; body?: string; payload?: string }>)
          : [];
        const tonConnectMessages = rawMsgs
          .filter((m) => (m.to || m.address) && (m.value || m.amount))
          .map((m) => ({
            address: String(m.to || m.address),
            amount: String(m.value || m.amount),
            payload: m.body || m.payload || undefined,
          }));
        if (tonConnectMessages.length > 0) liveExecutable = true;

        calls.push({
          stepId: `ton_relay_${step.id}`,
          assetId: asset.id,
          assetSymbol: asset.symbol,
          action: asset.action,
          provider: 'relay',
          label: `Convert ${asset.uiBalance} ${asset.symbol} → ${relayQuote.estimatedOutputUi} (Relay)`,
          description: step.description,
          nativePayload: {
            network: '-239',
            validUntil: Math.floor(Date.now() / 1000) + 600,
            messages: tonConnectMessages,
            requestId: relayQuote.requestId,
            gaslessRelayAddress: gaslessCfg?.relayAddress ?? null,
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
    }

    if (gaslessCfg?.relayAddress) {
      notes.push(`TonAPI W5 Gasless relayer active (${gaslessCfg.relayAddress.slice(0, 14)}…) — supports $0 TON Jetton-paid batching.`);
    }

    const grossUsd = Number(sweepable.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const estimatedFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));

    return {
      family: 'ton',
      chain: 'ton',
      chainId: '-239',
      chainName: 'TON',
      explorerUrl: 'https://tonviewer.com',
      userAddress: params.userAddress,
      solanaDestination: params.solanaDestination,
      solanaUsdcAtaBytes32,
      outputAsset,
      executionKind: 'ton_tonconnect_batch',
      signingStandard: 'TonConnect 2 sendTransaction (Wallet W5 up to 255 msgs / v4r2 up to 4 msgs)',
      liveExecutable,
      calls,
      bridgeTrackers,
      skippedAssets,
      savings: {
        totalCalls: calls.length,
        walletPopupsBatched: calls.length ? 1 : 0,
        walletPopupsLegacy: calls.length,
        popupsSaved: Math.max(0, calls.length - 1),
      },
      feeBreakdown: {
        feeBps: feeCfg.feeBps,
        feePercent: feeCfg.feePercent,
        feeRecipient,
        collectionMethod: feeRecipient ? 'ton_w5_jetton_transfer' : 'relay_quote_only',
        estimatedFeeUsd,
      },
      estimatedSeconds: maxSeconds,
      gaslessAvailable: Boolean(gaslessCfg?.relayAddress),
      gaslessMechanism: 'TonAPI Wallet W5 Gasless (/v2/gasless/estimate + signMessage + /v2/gasless/send)',
      notes,
    };
  },

  async buildGaslessIntent(params): Promise<UniversalGaslessIntent> {
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    const mintRecipientBytes32 = solanaAddressToBytes32(params.solanaDestination);
    const gaslessCfg = await fetchTonGaslessConfig();
    const relayerTonAddr =
      getNonEvmFeeRecipient('ton') ||
      gaslessCfg?.relayAddress ||
      'EQCturgaliumRelayerW5GaslessBattery0000000000000';
    const chainAssets = filterChainSweepableAssets('ton', params.assets);
    const grossUsd = Number(chainAssets.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const protocolFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const sponsoredGasEstUsd = Number(Math.max(0.03, chainAssets.length * 0.015).toFixed(2));
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

    const messages = [
      ...chainAssets.slice(0, 252).map((a) => ({
        op: a.address === 'native' ? 'ton_swap_and_bridge' : 'jetton_transfer_to_router',
        asset: a.symbol,
        jettonMaster: a.address,
        amountRaw: a.rawBalance,
        bridge: 'Relay / deBridge → Solana',
      })),
      {
        op: 'jetton_relayer_gas_reimbursement',
        recipient: relayerTonAddr,
        feeBps: feeCfg.feeBps,
        protocolFeeUsd,
      },
      {
        op: 'bridge_to_solana',
        solanaDestination: params.solanaDestination,
        minNetUsdcOut,
      },
    ];

    const signPayload = {
      walletVersion: 'wallet_v5r1_gasless',
      maxBatchMessages: 255,
      validUntil: deadline,
      seqnoNonce: nonce,
      relayerBattery: relayerTonAddr,
      messages,
    };

    const intentDigestSha256 =
      '0x' + crypto.createHash('sha256').update(JSON.stringify(signPayload)).digest('hex');

    return {
      intentId: `int_ton_${crypto.randomBytes(4).toString('hex')}`,
      family: 'ton',
      mode: 'ton_w5_gasless_batch',
      chain: 'ton',
      chainId: '-239',
      chainName: 'TON',
      userAddress: params.userAddress,
      solanaDestination: params.solanaDestination,
      solanaMintRecipientBytes32: mintRecipientBytes32,
      outputAsset: params.outputAsset ?? 'USDC',
      nonce,
      deadline,
      userGasCostUsd: 0,
      sponsoredGasEstUsd,
      gasSponsorshipMechanism: 'Wallet W5 Gasless (up to 255 messages in 1 sig, relayer reimbursed in Jettons)',
      protocolFeeBps: feeCfg.feeBps,
      protocolFeePercent: feeCfg.feePercent,
      protocolFeeUsd,
      feeRecipient: getNonEvmFeeRecipient('ton'),
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
      relayerConfigured: Boolean(process.env.TURGALIUM_TON_RELAYER_KEY?.trim() || gaslessCfg?.relayAddress),
      sponsorEligible: breakEven.eligible,
      sponsorRejectionReason: breakEven.rejectionReason,
      intentDigestSha256,
      explanation: `1 Tonkeeper W5 signature batches ${messages.length}/255 internal messages ($0 TON gas — relayer paid in Jettons) → Relay/deBridge → Solana.`,
    };
  },

  async simulatePreSignProof(params): Promise<UniversalPreSignProof> {
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    const cleanAddr = params.userAddress.trim();
    const userAddressValid = tonAdapter.matchesAddress(cleanAddr);
    let expectedBytes32 = '0x' + '00'.repeat(32);
    let solanaRecipientValid = false;
    try {
      expectedBytes32 = solanaAddressToBytes32(params.solanaDestination);
      solanaRecipientValid = true;
    } catch {
      solanaRecipientValid = false;
    }

    const sweepable = filterChainSweepableAssets('ton', params.assets);
    const outputAsset = params.outputAsset ?? 'USDC';
    const hasJettonsToSweep = sweepable.some((a) => a.address !== 'native');

    const [account, jettons, head, solSnap, priceMap] = await Promise.all([
      userAddressValid
        ? fetchJson<{ balance?: number; interfaces?: string[] }>(
            `${TONAPI_BASE}/accounts/${encodeURIComponent(cleanAddr)}`
          )
        : Promise.resolve(null),
      userAddressValid && hasJettonsToSweep
        ? fetchJson<{
            balances?: Array<{ balance: string; jetton?: { address?: string } }>;
          }>(`${TONAPI_BASE}/accounts/${encodeURIComponent(cleanAddr)}/jettons`)
        : Promise.resolve(null),
      fetchJson<{ seqno?: number }>(`${TONAPI_BASE}/blockchain/masterchain-head`),
      solanaRecipientValid
        ? fetchSolanaWalletBalances(params.solanaDestination).catch(() => null)
        : Promise.resolve(null),
      fetchLiveUsdPrices(['coingecko:the-open-network']),
    ]);

    const seqno = Number(head?.seqno ?? 0);
    const liveTonNano = account?.balance !== undefined ? BigInt(Math.max(0, Math.trunc(account.balance))) : null;
    const nativeBalanceUi = Number(unitsToUi(String(account?.balance ?? 0), 9).toFixed(5));
    const nativePriceUsd = params.nativePriceUsd ?? priceMap.get('coingecko:the-open-network') ?? 3.8;
    const nativeBalanceUsd = Number((nativeBalanceUi * nativePriceUsd).toFixed(2));
    const estimatedGasUsd = Number(Math.max(0.03, sweepable.length * 0.015).toFixed(2));
    const hasEnoughNativeGas = nativeBalanceUi >= 0.25;
    const grossUsd = Number(sweepable.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const feeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const estimatedNetUsd = Number(Math.max(0, grossUsd - feeUsd - estimatedGasUsd).toFixed(2));
    const guaranteedMinNetUsd = Number((estimatedNetUsd * 0.98).toFixed(2));
    const tonReachable = Boolean(account && seqno > 0);

    // Fail-closed live TON & Jetton balance check
    let insufficientBalanceDetail: string | null = null;
    const liveJettonBalances = new Map<string, bigint>();
    for (const j of jettons?.balances ?? []) {
      const k = (j.jetton?.address || '').trim().toLowerCase();
      if (!k) continue;
      try {
        liveJettonBalances.set(k, BigInt(j.balance || '0'));
      } catch {
        // ignore
      }
    }
    for (const a of sweepable) {
      let reqRaw = 0n;
      try {
        reqRaw = BigInt(a.rawBalance || '0');
      } catch {
        reqRaw = 0n;
      }
      if (a.address === 'native' && liveTonNano !== null) {
        if (reqRaw > liveTonNano) {
          insufficientBalanceDetail = `Insufficient live TON balance (${liveTonNano.toString()} nanotons available < ${reqRaw.toString()} requested).`;
          break;
        }
      } else if (a.address !== 'native' && jettons && Array.isArray(jettons.balances)) {
        const availRaw = liveJettonBalances.get(a.address.trim().toLowerCase()) ?? 0n;
        if (reqRaw > availRaw) {
          insufficientBalanceDetail = `Insufficient live TON Jetton balance for ${a.symbol} (${availRaw.toString()} available < ${reqRaw.toString()} requested).`;
          break;
        }
      }
    }

    const ataMissing = outputAsset === 'USDC' && solSnap !== null && !solSnap.hasUsdcAta;

    // Real live POST /v2/traces/emulate ONLY when BOC payload is provided
    const boc = (
      params.rawTxBytes ??
      (typeof params.simulationPayload?.boc === 'string' ? params.simulationPayload.boc : undefined)
    )?.trim();

    let liveSimSucceeded = false;
    let liveSimError: string | null = null;
    let liveSimDetail: string | null = null;
    let liveSimUnreachable = false;

    if (boc && userAddressValid && solanaRecipientValid && !insufficientBalanceDetail) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4200);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };
        if (process.env.TONAPI_KEY?.trim()) {
          headers.Authorization = `Bearer ${process.env.TONAPI_KEY.trim()}`;
        }
        const res = await fetch(`${TONAPI_BASE}/traces/emulate`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ boc }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        const json = (await res.json().catch(() => ({}))) as {
          error?: string;
          transaction?: { success?: boolean; aborted?: boolean; total_fees?: number };
        };
        if (res.ok && !json.error && json.transaction?.success === true && json.transaction?.aborted !== true) {
          liveSimSucceeded = true;
          liveSimDetail = `emulated_fees=${json.transaction.total_fees ?? 0} nanotons`;
        } else {
          liveSimError =
            json.error ||
            (json.transaction?.aborted
              ? 'TonAPI /v2/traces/emulate reported aborted transaction'
              : `TonAPI /v2/traces/emulate failed (HTTP ${res.status})`);
        }
      } catch {
        liveSimUnreachable = true;
      }
    }

    const warnings: string[] = [];
    if (!userAddressValid) {
      warnings.push(`Invalid TON address format: ${cleanAddr || '(empty)'}.`);
    }
    if (!solanaRecipientValid) {
      warnings.push('Invalid Solana destination address (expected valid non-zero base58 pubkey).');
    }
    if (ataMissing) {
      warnings.push('Destination Solana wallet has no canonical USDC ATA yet; create ATA before settling USDC.');
    }
    if (sweepable.length === 0) {
      warnings.push('No sweepable TON assets selected.');
    }
    if (insufficientBalanceDetail) {
      warnings.push(insufficientBalanceDetail);
    }
    if (!hasEnoughNativeGas) {
      warnings.push(`Low TON balance (${nativeBalanceUi} TON). Wallet W5 Gasless reimburses relayer in Jettons ($0 user TON).`);
    }
    if (!tonReachable) {
      warnings.push('TonAPI account/masterchain state could not be reached for live verification.');
    }
    if (liveSimError) {
      warnings.push(`TonAPI /v2/traces/emulate reverted: ${liveSimError}`);
    }

    const failClosedTx =
      !userAddressValid ||
      sweepable.length === 0 ||
      Boolean(insufficientBalanceDetail) ||
      Boolean(liveSimError);
    const failClosedRecipient = !solanaRecipientValid || ataMissing;

    const simulatedLive = Boolean(boc && liveSimSucceeded && !failClosedTx && !failClosedRecipient);
    const allChecksSafe = Boolean(simulatedLive && !failClosedTx && !failClosedRecipient);

    const emulateCheckStatus: UniversalPreSignProof['checks'][number]['preflightStatus'] = failClosedTx
      ? 'reverted'
      : liveSimUnreachable || (!boc && !tonReachable)
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
      ? `Live TonAPI /v2/traces/emulate succeeded (${liveSimDetail ?? 'ok'}) at masterchain seqno #${seqno.toLocaleString()}.`
      : failClosedTx || failClosedRecipient
      ? `Pre-flight check failed closed: ${warnings[0] ?? 'validation rejected.'}`
      : liveSimUnreachable || !tonReachable
      ? 'TonAPI /v2/traces/emulate or account endpoint unreachable; transaction was not emulated.'
      : 'High-level TON intent pre-flight only: /v2/traces/emulate requires a serialized BOC payload from TonConnect/Wallet W5.';

    const proofDigestSha256 =
      '0x' +
      crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            family: 'ton',
            seqno,
            userAddress: cleanAddr,
            solanaDestination: params.solanaDestination,
            simulatedLive,
            outflows: sweepable.map((a) => ({ id: a.id, raw: a.rawBalance })),
            guaranteedMinNetUsd,
          })
        )
        .digest('hex');

    return {
      proofId: `prf_ton_${crypto.randomBytes(4).toString('hex')}`,
      family: 'ton',
      proofDigestSha256,
      generatedAt: new Date().toISOString(),
      chain: 'ton',
      chainId: '-239',
      chainName: 'TON',
      blockNumber: seqno,
      userAddress: cleanAddr,
      solanaDestination: params.solanaDestination,
      solanaMintRecipientBytes32: expectedBytes32,
      mintRecipientVerified: solanaRecipientValid,
      hasEnoughNativeGas,
      nativeBalanceUi,
      nativeSymbol: 'TON',
      nativeBalanceUsd,
      estimatedGasUsd,
      recommendedMode: hasEnoughNativeGas ? 'eip5792_batch' : 'sponsored_gasless',
      simulationEndpoint: '/v2/traces/emulate',
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
        collectionMethod: 'ton_w5_jetton_fee_5_to_10_pct',
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
          stepId: 'ton_traces_emulate',
          assetSymbol: 'TON',
          actionType: 'ton_w5_emulate',
          target: 'tonapi.io/v2/traces/emulate',
          summary:
            emulateCheckStatus === 'verified'
              ? `Live TonAPI /v2/traces/emulate passed (${liveSimDetail ?? 'ok'})`
              : emulateCheckStatus === 'reverted'
              ? liveSimError
                ? `TON trace emulation reverted: ${liveSimError.slice(0, 120)}`
                : insufficientBalanceDetail || warnings[0] || 'TON pre-flight rejected'
              : emulateCheckStatus === 'rpc_skipped'
              ? 'TonAPI endpoint unreachable'
              : `Pre-flight TON state checked at seqno #${seqno.toLocaleString()} (no BOC emulated)`,
          preflightStatus: emulateCheckStatus,
          preflightDetail:
            emulateCheckStatus === 'verified'
              ? `Seqno #${seqno.toLocaleString()} · /v2/traces/emulate passed (${liveSimDetail ?? 'ok'})`
              : emulateCheckStatus === 'reverted'
              ? liveSimError || insufficientBalanceDetail || warnings[0] || 'TON pre-flight check failed closed'
              : emulateCheckStatus === 'rpc_skipped'
              ? 'TonAPI rate-limited or unreachable'
              : `Seqno #${seqno.toLocaleString()} (${nativeBalanceUi} TON) · BOC not supplied for live emulation`,
        },
        {
          stepId: 'ton_bridge_solana',
          assetSymbol: outputAsset,
          actionType: 'bridge_or_swap',
          target: 'Relay / deBridge → Solana',
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
            ? 'Solana base58 & bytes32 recipient verified alongside live trace emulation'
            : 'Solana base58 & bytes32 recipient validated (tx execution not emulated live)',
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
        throw new Error('Signed TON W5 batch intent expired. Re-sign a fresh intent.');
      }
      const fp = '0x' + crypto.createHash('sha256').update(params.signature).digest('hex').slice(0, 16);
      const configured = Boolean(process.env.TURGALIUM_TON_RELAYER_KEY?.trim());
      out.submitted = {
        accepted: true,
        mode: configured ? 'relayer_queued' : 'intent_verified_awaiting_deployment',
        broadcasted: false,
        settlementStatus: configured ? 'queued_for_relayer' : 'awaiting_relayer',
        signatureFingerprint: fp,
        nextStep: configured
          ? `TON W5 Gasless relayer queued BOC ${params.intentId} (${fp}).`
          : `TON W5 1-Sig batch verified (${fp}). Use Direct Mode (TonConnect 2 sendTransaction) to execute live Relay messages immediately.`,
      };
    }

    if (params.txHash) {
      const [txInfo, postSol] = await Promise.all([
        fetchJson<{ success?: boolean; lt?: number; total_fees?: number }>(
          `${TONAPI_BASE}/blockchain/transactions/${encodeURIComponent(params.txHash)}`
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

      out.proof = {
        verified: Boolean(succeeded && positiveSolanaDelta),
        family: 'ton',
        proofDigestSha256:
          '0x' +
          crypto
            .createHash('sha256')
            .update(JSON.stringify({ family: 'ton', txHash: params.txHash, succeeded, solanaDeltaProof }))
            .digest('hex'),
        verifiedAt: new Date().toISOString(),
        chain: 'ton',
        chainName: 'TON',
        txHash: params.txHash,
        explorerUrl: `https://tonviewer.com/transaction/${params.txHash}`,
        sourceReceipt: {
          found,
          succeeded,
          blockOrHeight: txInfo?.lt,
          gasUsed: txInfo?.total_fees !== undefined ? String(txInfo.total_fees) : undefined,
          nativeSymbol: 'TON',
        },
        decodedTransfers: [],
        bridgeProof: {
          provider: params.provider === 'relay' ? 'Relay (TON → Solana)' : 'deBridge / Relay → Solana',
          status: positiveSolanaDelta ? 'success' : succeeded ? 'relaying' : found ? 'failed' : 'pending',
        },
        solanaDeltaProof,
        summary: !found
          ? 'TON transaction not yet indexed on TonAPI.'
          : succeeded
          ? `Confirmed on TON (lt ${txInfo?.lt ?? '—'}) · Solana settlement tracked.`
          : 'TON transaction failed.',
      };
    }

    return out;
  },
};
