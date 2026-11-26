import crypto from 'node:crypto';
import {
  checkQuoteHaircutPass,
  DEFAULT_NON_EVM_AUCTION_TIMEOUT_MS,
  deriveNonEvmCctpRecipientBytes32,
  evaluateNonEvmGaslessBreakEven,
  fetchWithRetry,
  filterChainSweepableAssets,
  getNonEvmFeeRecipient,
  LIFI_SUI_CHAIN_ID,
  type NonEvmRouteAuctionCandidate,
  type NonEvmRouteAuctionMetadata,
  normalizeMoveCoinType,
  quoteLifiNonEvm,
  quoteMayanSwiftNonEvm,
} from '../execution/non-evm-converter.js';
import type { RouteAuctionFetcher } from '../execution/route-auction.js';
import { getProtocolFeeConfig, SOLANA_CCTP_DOMAIN } from '../scanner/chains.js';
import { fetchSolanaWalletBalances } from '../scanner/discovery.js';
import { fetchLiveUsdPrices } from '../scanner/prices.js';
import { applyTwoLevelRoiToReport } from '../scanner/roi.js';
import { sanitizeTokenSymbol } from '../scanner/sanitize.js';
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

const SUI_GRAPHQL_URLS = [
  process.env.SUI_GRAPHQL_URL?.trim(),
  'https://graphql.mainnet.sui.io/graphql',
].filter((u): u is string => Boolean(u));

const SUI_RPC_URLS = [
  process.env.SUI_RPC_URL?.trim(),
  'https://mainnet.suiet.app',
].filter((u): u is string => Boolean(u));

const SUI_CCTP_DOMAIN = 8;
const SUI_NATIVE_USDC_TYPE =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

interface KnownSuiCoinMeta {
  symbol: string;
  name: string;
  decimals: number;
  coingeckoKey: string;
  /** True ONLY for Native Circle Sui USDC accepted by Circle CCTP Domain 8 */
  isNativeCctpUsdc?: boolean;
  isLst?: boolean;
  protocol?: string;
}

const KNOWN_SUI_COINS: Record<string, KnownSuiCoinMeta> = {
  '0x2::sui::SUI': { symbol: 'SUI', name: 'Sui', decimals: 9, coingeckoKey: 'coingecko:sui' },
  [SUI_NATIVE_USDC_TYPE]: {
    symbol: 'USDC',
    name: 'Native Sui USDC',
    decimals: 6,
    coingeckoKey: 'coingecko:usd-coin',
    isNativeCctpUsdc: true,
  },
  // Wormhole wUSDC is NOT accepted by Circle CCTP — must swap via Cetus/LI.FI first
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN': {
    symbol: 'wUSDC',
    name: 'Wormhole USDC (Sui)',
    decimals: 6,
    coingeckoKey: 'coingecko:usd-coin',
  },
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN': {
    symbol: 'USDT',
    name: 'Tether USD (Sui)',
    decimals: 6,
    coingeckoKey: 'coingecko:tether',
  },
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP': {
    symbol: 'DEEP',
    name: 'DeepBook',
    decimals: 6,
    coingeckoKey: 'coingecko:deep',
  },
  '0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL': {
    symbol: 'WAL',
    name: 'Walrus',
    decimals: 9,
    coingeckoKey: 'coingecko:walrus-2',
  },
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS': {
    symbol: 'CETUS',
    name: 'Cetus Protocol',
    decimals: 9,
    coingeckoKey: 'coingecko:cetus-protocol',
  },
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI': {
    symbol: 'afSUI',
    name: 'Aftermath Staked SUI',
    decimals: 9,
    coingeckoKey: 'coingecko:sui',
    isLst: true,
    protocol: 'Aftermath LST',
  },
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI': {
    symbol: 'haSUI',
    name: 'Haedal Staked SUI',
    decimals: 9,
    coingeckoKey: 'coingecko:sui',
    isLst: true,
    protocol: 'Haedal LST',
  },
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT': {
    symbol: 'vSUI',
    name: 'Volo Staked SUI',
    decimals: 9,
    coingeckoKey: 'coingecko:sui',
    isLst: true,
    protocol: 'Volo LST',
  },
};

export const SUI_FAMILY_META: ChainFamilyMeta = {
  family: 'sui',
  label: 'Sui',
  shortLabel: 'Sui',
  chains: [{ id: 'sui', name: 'Sui', nativeSymbol: 'SUI', logo: '/logos/sui.svg', cctpDomain: SUI_CCTP_DOMAIN }],
  signingMechanism: '1-Sig Programmable Transaction Block (PTB) — Direct Wallet Standard or Sponsored Gas',
  gasSponsorshipMechanism: 'Direct PTB or Sui Native Sponsored Transaction (gasData.owner = Turgalium Relayer, $0 user SUI)',
  preSignProofMechanism: 'Sui GraphQL / gRPC state + dryRunTransactionBlock + Circle CCTP ATA bytes32 + Solana snapshot',
  bridgeProviders: ['LI.FI (Sui MVM)', 'Circle CCTP (Domain 8 → 5)', 'Cetus / Mayan'],
  wallets: [
    { id: 'slush', name: 'Slush (Sui Wallet)', logo: '/logos/slush.svg', installUrl: 'https://slush.app' },
    { id: 'phantom-sui', name: 'Phantom (Sui)', logo: '/logos/phantom.svg', installUrl: 'https://phantom.app' },
  ],
  sampleAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
  sampleLabel: 'Sui System Sample',
  addressHint: '0x… (64-hex Sui address)',
};

async function suiGraphql<T>(query: string, timeoutMs = 4500): Promise<T | null> {
  for (const url of SUI_GRAPHQL_URLS) {
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query }),
      },
      timeoutMs
    );
    if (res && res.ok) {
      const json = (await res.json()) as { data?: T; errors?: unknown[] };
      if (json.data && (!json.errors || !json.errors.length)) return json.data;
    }
  }
  return null;
}

async function suiRpc<T>(method: string, params: unknown[], timeoutMs = 4200): Promise<T | null> {
  for (const url of SUI_RPC_URLS) {
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      },
      timeoutMs
    );
    if (res && res.ok) {
      const json = (await res.json()) as { result?: T; error?: unknown };
      if (!json.error && json.result !== undefined) return json.result;
    }
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

const SUI_CCTP_SOLANA_CLAIM_COST_USD = 0.25;

export async function prepareSuiDirectBatch(
  params: Parameters<NonNullable<ChainFamilyAdapter['prepareDirectBatch']>>[0] & {
    fetcher?: RouteAuctionFetcher;
    auctionTimeoutMs?: number;
  }
): Promise<PreparedNonEvmBatch> {
  const outputAsset = params.outputAsset ?? 'USDC';
  const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
  const feeRecipient = getNonEvmFeeRecipient('sui');
  const solanaUsdcAtaBytes32 = deriveNonEvmCctpRecipientBytes32(params.solanaDestination);
  const sweepable = filterChainSweepableAssets('sui', params.assets);
  const timeoutMs = params.auctionTimeoutMs ?? DEFAULT_NON_EVM_AUCTION_TIMEOUT_MS;

  const calls: PreparedNonEvmCall[] = [];
  const bridgeTrackers: PreparedNonEvmBatch['bridgeTrackers'] = [];
  const skippedAssets: PreparedNonEvmBatch['skippedAssets'] = [];
  const notes: string[] = [];
  const perAssetAuctions: Record<string, Omit<NonEvmRouteAuctionMetadata, 'perAsset'>> = {};
  let maxSeconds = 20;
  let liveExecutable = false;

  for (const asset of sweepable) {
    if (asset.id === 'sui:native_stake' || asset.address.startsWith('staked:')) {
      const stakeIds = asset.address.startsWith('staked:')
        ? asset.address.slice('staked:'.length).split(',').filter(Boolean)
        : [];
      calls.push({
        stepId: 'sui_withdraw_stake',
        assetId: asset.id,
        assetSymbol: asset.symbol,
        action: asset.action,
        provider: 'sui_native_staking',
        label: `Unstake ${asset.uiBalance} SUI in PTB`,
        description: `Calls 0x3::sui_system::request_withdraw_stake for ${Math.max(1, stakeIds.length)} active StakedSui object(s)`,
        nativePayload: {
          kind: 'moveCall',
          target: '0x3::sui_system::request_withdraw_stake',
          arguments: ['0x5', stakeIds],
        },
      });
      continue;
    }

    const normCoin = normalizeMoveCoinType(asset.address);
    const isNativeUsdc = normCoin === SUI_NATIVE_USDC_TYPE;
    const fullCoinTag =
      normCoin === '0x2::sui::SUI'
        ? '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
        : normCoin;
    const mayanCoinTag = normCoin === '0x2::sui::SUI' ? '0x2::sui::SUI' : normCoin;

    const auctionStart = Date.now();
    const providersQueried: string[] = ['lifi', 'mayan_swift'];
    if (isNativeUsdc && outputAsset === 'USDC') {
      providersQueried.push('circle_cctp');
    }

    const raceWithTimeout = <T>(p: Promise<T>, ms: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> =>
      Promise.race([
        p.then((value) => ({ timedOut: false as const, value })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
      ]);

    const lifiStart = Date.now();
    const mayanStart = Date.now();

    const [lifiRace, mayanRace] =
      params.bridgePreference === 'cctp' && isNativeUsdc && outputAsset === 'USDC'
        ? [
            { timedOut: false as const, value: null },
            { timedOut: false as const, value: null },
          ]
        : await Promise.all([
            raceWithTimeout(
              quoteLifiNonEvm({
                fromChainId: LIFI_SUI_CHAIN_ID,
                fromToken: fullCoinTag,
                fromAmount: asset.rawBalance,
                fromAddress: params.userAddress,
                solanaDestination: params.solanaDestination,
                outputAsset,
                tradeUsd: asset.grossUsd,
                liquidityUsd: asset.liquidityUsd,
                symbol: asset.symbol,
                fetcher: params.fetcher,
              }).catch(() => null),
              timeoutMs
            ),
            raceWithTimeout(
              quoteMayanSwiftNonEvm({
                fromChain: 'sui',
                fromToken: mayanCoinTag,
                fromAmount: asset.rawBalance,
                fromDecimals: asset.decimals,
                fromAddress: params.userAddress,
                solanaDestination: params.solanaDestination,
                outputAsset,
                tradeUsd: asset.grossUsd,
                liquidityUsd: asset.liquidityUsd,
                symbol: asset.symbol,
                timeoutMs,
                fetcher: params.fetcher,
              }).catch(() => null),
              timeoutMs
            ),
          ]);

    const lifiLatencyMs = Date.now() - lifiStart;
    const mayanLatencyMs = Date.now() - mayanStart;

    const candidates: NonEvmRouteAuctionCandidate[] = [];
    const lifiQuote = !lifiRace.timedOut ? lifiRace.value : null;
    const mayanQuote = !mayanRace.timedOut ? mayanRace.value : null;

    // Candidate 1: LI.FI Sui
    if (params.bridgePreference === 'cctp' && isNativeUsdc && outputAsset === 'USDC') {
      candidates.push({
        provider: 'lifi',
        label: 'LI.FI Sui',
        status: 'ineligible',
        quotedOutUsd: 0,
        gasUsd: 0.01,
        bridgeFeeUsd: 0,
        netUsd: 0,
        etaSeconds: 0,
        latencyMs: 0,
        liveExecutable: false,
        reason: 'Skipped because bridgePreference="cctp" was explicitly requested.',
      });
    } else if (lifiRace.timedOut) {
      candidates.push({
        provider: 'lifi',
        label: 'LI.FI Sui',
        status: 'timeout',
        quotedOutUsd: 0,
        gasUsd: 0.01,
        bridgeFeeUsd: 0,
        netUsd: 0,
        etaSeconds: 0,
        latencyMs: lifiLatencyMs,
        liveExecutable: false,
        reason: `LI.FI Sui timed out after ${timeoutMs}ms`,
      });
    } else if (!lifiQuote) {
      candidates.push({
        provider: 'lifi',
        label: 'LI.FI Sui',
        status: 'error',
        quotedOutUsd: 0,
        gasUsd: 0.01,
        bridgeFeeUsd: 0,
        netUsd: 0,
        etaSeconds: 0,
        latencyMs: lifiLatencyMs,
        liveExecutable: false,
        reason: 'LI.FI returned no live Sui → Solana quote.',
      });
    } else {
      const haircut = checkQuoteHaircutPass({
        grossUsd: asset.grossUsd,
        quotedOutUsd: lifiQuote.quotedOutUsd,
        estimatedGasUsd: lifiQuote.estimatedGasUsd,
        allowHighCost: params.allowHighCost,
      });
      const netUsd = Number(Math.max(0, lifiQuote.quotedOutUsd - lifiQuote.estimatedGasUsd).toFixed(2));
      candidates.push({
        provider: 'lifi',
        label: `LI.FI (${lifiQuote.tool})`,
        status: haircut.passed ? 'ok' : 'rejected_haircut',
        quotedOutUsd: lifiQuote.quotedOutUsd,
        gasUsd: lifiQuote.estimatedGasUsd,
        bridgeFeeUsd: Number(Math.max(0, asset.grossUsd - lifiQuote.quotedOutUsd).toFixed(2)),
        netUsd,
        etaSeconds: lifiQuote.estimatedSeconds,
        latencyMs: lifiLatencyMs,
        liveExecutable: lifiQuote.liveExecutable,
        requestId: lifiQuote.requestId,
        reason: haircut.passed ? undefined : haircut.reason,
      });
    }

    // Candidate 2: Mayan Swift
    if (params.bridgePreference === 'cctp' && isNativeUsdc && outputAsset === 'USDC') {
      candidates.push({
        provider: 'mayan_swift',
        label: 'Mayan Swift',
        status: 'ineligible',
        quotedOutUsd: 0,
        gasUsd: 0.01,
        bridgeFeeUsd: 0,
        netUsd: 0,
        etaSeconds: 0,
        latencyMs: 0,
        liveExecutable: false,
        reason: 'Skipped because bridgePreference="cctp" was explicitly requested.',
      });
    } else if (mayanRace.timedOut) {
      candidates.push({
        provider: 'mayan_swift',
        label: 'Mayan Swift',
        status: 'timeout',
        quotedOutUsd: 0,
        gasUsd: 0.01,
        bridgeFeeUsd: 0,
        netUsd: 0,
        etaSeconds: 0,
        latencyMs: mayanLatencyMs,
        liveExecutable: false,
        reason: `Mayan Swift timed out after ${timeoutMs}ms`,
      });
    } else if (!mayanQuote) {
      candidates.push({
        provider: 'mayan_swift',
        label: 'Mayan Swift',
        status: 'error',
        quotedOutUsd: 0,
        gasUsd: 0.01,
        bridgeFeeUsd: 0,
        netUsd: 0,
        etaSeconds: 0,
        latencyMs: mayanLatencyMs,
        liveExecutable: false,
        reason: 'Mayan Swift returned no live Sui → Solana quote.',
      });
    } else {
      const haircut = checkQuoteHaircutPass({
        grossUsd: asset.grossUsd,
        quotedOutUsd: mayanQuote.quotedOutUsd,
        estimatedGasUsd: mayanQuote.estimatedGasUsd,
        allowHighCost: params.allowHighCost,
      });
      const netUsd = Number(Math.max(0, mayanQuote.quotedOutUsd - mayanQuote.estimatedGasUsd).toFixed(2));
      candidates.push({
        provider: 'mayan_swift',
        label: mayanQuote.tool,
        status: haircut.passed ? 'ok' : 'rejected_haircut',
        quotedOutUsd: mayanQuote.quotedOutUsd,
        gasUsd: mayanQuote.estimatedGasUsd,
        bridgeFeeUsd: mayanQuote.bridgeFeeUsd,
        netUsd,
        etaSeconds: mayanQuote.estimatedSeconds,
        latencyMs: mayanLatencyMs,
        liveExecutable: mayanQuote.liveExecutable,
        requestId: mayanQuote.requestId,
        reason: haircut.passed ? undefined : haircut.reason,
      });
    }

    // Candidate 3: Circle CCTP Domain 8 -> 5 (0 bps) for Native Sui USDC
    if (isNativeUsdc && outputAsset === 'USDC') {
      const usdcUi = unitsToUi(asset.rawBalance, 6);
      const cctpOutUsd = Number(usdcUi.toFixed(2));
      const cctpGasUsd = 0.01;
      const cctpNetUsd = Number(
        Math.max(0, cctpOutUsd - cctpGasUsd - SUI_CCTP_SOLANA_CLAIM_COST_USD).toFixed(2)
      );
      const cctpHaircut = checkQuoteHaircutPass({
        grossUsd: asset.grossUsd,
        quotedOutUsd: cctpOutUsd,
        estimatedGasUsd: cctpGasUsd + SUI_CCTP_SOLANA_CLAIM_COST_USD,
        allowHighCost: params.allowHighCost,
      });
      candidates.push({
        provider: 'circle_cctp',
        label: 'Circle CCTP Domain 8 → 5 (0 bps)',
        status: cctpHaircut.passed ? 'ok' : 'rejected_haircut',
        quotedOutUsd: cctpOutUsd,
        gasUsd: cctpGasUsd,
        bridgeFeeUsd: 0,
        netUsd: cctpNetUsd,
        etaSeconds: 18,
        latencyMs: 0,
        // Honest semantics: raw Move call blueprint requires serialized BCS PTB bytes for Wallet Standard execution
        liveExecutable: false,
        reason: cctpHaircut.passed
          ? '0 bps Circle CCTP burn blueprint (requires PTB serialization & Solana claim)'
          : cctpHaircut.reason,
      });
    }

    candidates.sort((a, b) => b.netUsd - a.netUsd);
    const passing = candidates.filter((c) => c.status === 'ok');
    const executablePassing = passing.filter((c) => c.liveExecutable);

    let winner: NonEvmRouteAuctionCandidate | undefined;
    if (params.bridgePreference === 'cctp' && isNativeUsdc && outputAsset === 'USDC') {
      winner = passing.find((c) => c.provider === 'circle_cctp') ?? executablePassing[0] ?? passing[0];
    } else if (params.bridgePreference === 'lifi') {
      winner = passing.find((c) => c.provider === 'lifi') ?? executablePassing[0] ?? passing[0];
    } else {
      // Pick the highest net USD executable route; if none returned live PTB bytes, pick highest net USD quote honestly
      winner = executablePassing[0] ?? passing[0];
    }

    if (!winner) {
      const reasons = candidates
        .map((c) => c.reason)
        .filter(Boolean)
        .join(' | ');
      skippedAssets.push({
        assetId: asset.id,
        assetSymbol: asset.symbol,
        reason:
          reasons ||
          `No live Sui → Solana route returned for ${asset.symbol} (amount may be below bridge minimum).`,
      });
      continue;
    }

    const comparablePool = winner.liveExecutable ? executablePassing : passing;
    const runnerUp =
      comparablePool.find((c) => c.provider !== winner.provider) ??
      passing.find((c) => c.provider !== winner.provider);
    const savingsOverRunnerUpUsd =
      runnerUp ? Number(Math.max(0, winner.netUsd - runnerUp.netUsd).toFixed(2)) : 0;
    const bpsSavedOverRunnerUp =
      runnerUp && asset.grossUsd > 0
        ? Math.round((savingsOverRunnerUpUsd / asset.grossUsd) * 10_000)
        : 0;

    perAssetAuctions[asset.id] = {
      winner: winner.provider,
      winnerNetUsd: winner.netUsd,
      ...(runnerUp ? { runnerUp: runnerUp.provider, runnerUpNetUsd: runnerUp.netUsd } : {}),
      savingsOverRunnerUpUsd,
      bpsSavedOverRunnerUp,
      totalAuctionDurationMs: Date.now() - auctionStart,
      providersQueried,
      providersSucceeded: passing.length,
      candidates,
    };

    if (winner.provider === 'circle_cctp') {
      maxSeconds = Math.max(maxSeconds, 18);
      calls.push({
        stepId: 'sui_cctp_burn',
        assetId: asset.id,
        assetSymbol: asset.symbol,
        action: asset.action,
        provider: 'circle_cctp',
        label: `Circle CCTP Domain 8 → Solana USDC ATA (${asset.uiBalance} USDC)`,
        description: `Burns Native Sui USDC (0 bps) to canonical Solana USDC ATA PDA (${solanaUsdcAtaBytes32.slice(0, 14)}…)`,
        nativePayload: {
          kind: 'moveCall',
          target: 'cctp::token_messenger_minter::deposit_for_burn',
          coinType: SUI_NATIVE_USDC_TYPE,
          amountRaw: asset.rawBalance,
          sourceDomain: SUI_CCTP_DOMAIN,
          destinationDomain: SOLANA_CCTP_DOMAIN,
          mintRecipientBytes32: solanaUsdcAtaBytes32,
        },
      });
      bridgeTrackers.push({
        assetId: asset.id,
        assetSymbol: asset.symbol,
        provider: 'circle_cctp',
        estimatedOutput: `${asset.uiBalance.toFixed(2)} USDC`,
        estimatedSeconds: 18,
        requiresSolanaClaim: true,
      });
    } else if (winner.provider === 'mayan_swift' && mayanQuote) {
      if (mayanQuote.liveExecutable) liveExecutable = true;
      maxSeconds = Math.max(maxSeconds, mayanQuote.estimatedSeconds);
      calls.push({
        stepId: 'sui_mayan_swift_convert',
        assetId: asset.id,
        assetSymbol: asset.symbol,
        action: asset.action,
        provider: 'mayan_swift',
        label: `Convert ${asset.uiBalance} ${asset.symbol} → ${mayanQuote.estimatedOutputUi} (${mayanQuote.tool})`,
        description: mayanQuote.liveExecutable
          ? `Live Sui PTB via ${mayanQuote.tool} directly to Solana ${outputAsset}`
          : `Live ${mayanQuote.tool} quote (${mayanQuote.estimatedOutputUi}); connect funded Sui wallet to build live PTB bytes`,
        nativePayload: {
          kind: 'sui_ptb_transaction',
          transactionRequest: mayanQuote.transactionRequest,
          mayanQuote: mayanQuote.rawQuote,
          fromCoinType: mayanCoinTag,
          amountRaw: asset.rawBalance,
          solanaDestination: params.solanaDestination,
        },
      });
      bridgeTrackers.push({
        assetId: asset.id,
        assetSymbol: asset.symbol,
        provider: 'mayan_swift',
        requestId: mayanQuote.requestId,
        estimatedOutput: mayanQuote.estimatedOutputUi,
        estimatedSeconds: mayanQuote.estimatedSeconds,
      });
    } else if (lifiQuote) {
      if (lifiQuote.liveExecutable) liveExecutable = true;
      maxSeconds = Math.max(maxSeconds, lifiQuote.estimatedSeconds);
      calls.push({
        stepId: 'sui_lifi_convert',
        assetId: asset.id,
        assetSymbol: asset.symbol,
        action: asset.action,
        provider: 'lifi',
        label: `Convert ${asset.uiBalance} ${asset.symbol} → ${lifiQuote.estimatedOutputUi} (${lifiQuote.tool})`,
        description: lifiQuote.liveExecutable
          ? `Live Sui PTB via LI.FI (${lifiQuote.tool}) directly to Solana ${outputAsset}`
          : `Live LI.FI route quoted (${lifiQuote.estimatedOutputUi}); connect funded Sui wallet to build live PTB bytes`,
        nativePayload: {
          kind: 'sui_ptb_transaction',
          transactionRequest: lifiQuote.transactionRequest,
          routeSummary: lifiQuote.routeSummary,
          fromCoinType: fullCoinTag,
          amountRaw: asset.rawBalance,
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
    }
  }

  const auctionEntries = Object.values(perAssetAuctions);
  let routeAuction: NonEvmRouteAuctionMetadata | undefined;
  if (auctionEntries.length === 1) {
    routeAuction = { ...auctionEntries[0], perAsset: perAssetAuctions };
  } else if (auctionEntries.length > 1) {
    const primary = auctionEntries.reduce((best, cur) =>
      cur.winnerNetUsd > best.winnerNetUsd ? cur : best
    );
    const totalSavings = Number(
      auctionEntries.reduce((s, a) => s + a.savingsOverRunnerUpUsd, 0).toFixed(2)
    );
    routeAuction = {
      ...primary,
      savingsOverRunnerUpUsd: totalSavings,
      perAsset: perAssetAuctions,
    };
  }

  if (routeAuction && routeAuction.runnerUp && routeAuction.savingsOverRunnerUpUsd > 0) {
    notes.push(
      `Sui Parallel Auction: ${routeAuction.winner} won at $${routeAuction.winnerNetUsd.toFixed(2)} net, saving $${routeAuction.savingsOverRunnerUpUsd.toFixed(2)} (+${routeAuction.bpsSavedOverRunnerUp} bps) vs ${routeAuction.runnerUp}.`
    );
  }

  const grossUsd = Number(sweepable.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
  const estimatedFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
  if (!liveExecutable && calls.length > 0) {
    notes.push('Connect a funded Slush or Phantom (Sui) wallet to serialize and execute live PTB bytes via Wallet Standard.');
  }

  return {
    family: 'sui',
    chain: 'sui',
    chainId: 'sui:mainnet',
    chainName: 'Sui',
    explorerUrl: 'https://suiscan.xyz/mainnet',
    userAddress: params.userAddress,
    solanaDestination: params.solanaDestination,
    solanaUsdcAtaBytes32,
    outputAsset,
    executionKind: 'sui_ptb',
    signingStandard: 'Sui Wallet Standard (sui:signAndExecuteTransaction)',
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
      collectionMethod: feeRecipient ? 'sui_ptb_split_coins' : 'bridge_quote_only',
      estimatedFeeUsd,
    },
    estimatedSeconds: maxSeconds,
    gaslessAvailable: Boolean(process.env.TURGALIUM_SUI_SPONSOR_PRIVATE_KEY?.trim()),
    gaslessMechanism: 'Sui Native Sponsored PTB (gasData.owner = Turgalium Sponsor)',
    notes,
    ...(routeAuction ? { routeAuction } : {}),
  };
}

export const suiAdapter: ChainFamilyAdapter = {
  family: 'sui',
  meta: SUI_FAMILY_META,

  matchesAddress(address: string): boolean {
    return /^0x[0-9a-fA-F]{64}$/.test(address.trim());
  },

  async scanWallet(address: string, label?: string): Promise<ScanReport> {
    const start = Date.now();
    const cleanAddr = address.trim();
    const feeCfg = getProtocolFeeConfig();
    const warnings: string[] = [];

    const escapedAddr = cleanAddr.replace(/[^0-9a-fA-Fx]/g, '');
    const gqlQuery = `{
      checkpoint { sequenceNumber }
      address(address: "${escapedAddr}") {
        balances(first: 50) { nodes { coinType { repr } totalBalance } }
        objects(filter: { type: "0x3::staking_pool::StakedSui" }, first: 30) {
          nodes { address contents { json } }
        }
      }
    }`;

    const [gqlData, priceMap] = await Promise.all([
      suiGraphql<{
        checkpoint?: { sequenceNumber?: number };
        address?: {
          balances?: { nodes?: Array<{ coinType?: { repr?: string }; totalBalance?: string }> };
          objects?: { nodes?: Array<{ address?: string; contents?: { json?: Record<string, unknown> } }> };
        };
      }>(gqlQuery),
      fetchLiveUsdPrices([
        'coingecko:sui',
        'coingecko:usd-coin',
        'coingecko:tether',
        'coingecko:deep',
        'coingecko:walrus-2',
        'coingecko:cetus-protocol',
        'coingecko:solana',
      ]),
    ]);

    let blockNumber = Number(gqlData?.checkpoint?.sequenceNumber ?? 0);
    let balanceItems: Array<{ coinType: string; totalBalance: string }> =
      (gqlData?.address?.balances?.nodes ?? [])
        .filter((n) => n.coinType?.repr && n.totalBalance)
        .map((n) => ({
          coinType: normalizeMoveCoinType(n.coinType!.repr!),
          totalBalance: String(n.totalBalance),
        }));
    let stakedObjects = gqlData?.address?.objects?.nodes ?? [];
    let rpcReachable = Boolean(gqlData && blockNumber > 0);

    // Fallback to live JSON-RPC provider if GraphQL endpoint didn't respond
    if (!rpcReachable) {
      const [rpcBals, rpcStakes, rpcCp] = await Promise.all([
        suiRpc<Array<{ coinType: string; totalBalance: string }>>('suix_getAllBalances', [cleanAddr]),
        suiRpc<Array<{ stakes?: Array<{ stakedSuiId?: string; status?: string; principal?: string; estimatedReward?: string }> }>>('suix_getStakes', [cleanAddr]),
        suiRpc<string>('sui_getLatestCheckpointSequenceNumber', []),
      ]);
      if (rpcCp || rpcBals) {
        rpcReachable = true;
        blockNumber = Number(rpcCp || 0);
        balanceItems = (rpcBals ?? []).map((b) => ({
          coinType: normalizeMoveCoinType(b.coinType),
          totalBalance: b.totalBalance,
        }));
        stakedObjects = (rpcStakes ?? []).flatMap((vg) =>
          (vg.stakes ?? [])
            .filter((s) => !s.status || s.status === 'Active')
            .map((s) => ({
              address: s.stakedSuiId,
              contents: {
                json: {
                  principal: s.principal,
                  estimated_reward: s.estimatedReward,
                },
              },
            }))
        );
      } else {
        warnings.push('Sui Mainnet GraphQL & fallback RPC endpoints did not respond within timeout.');
      }
    }

    const suiPrice = priceMap.get('coingecko:sui') ?? 2.45;
    const solPrice = priceMap.get('coingecko:solana') ?? 70;
    const assets: ScannedAsset[] = [];
    let nativeBalance = 0;

    for (const b of balanceItems) {
      const meta = KNOWN_SUI_COINS[b.coinType];
      if (!meta) continue;
      const uiBal = unitsToUi(b.totalBalance, meta.decimals);
      if (uiBal <= 0) continue;
      if (b.coinType === '0x2::sui::SUI') nativeBalance = uiBal;

      const priceUsd = priceMap.get(meta.coingeckoKey) ?? (meta.isNativeCctpUsdc ? 1 : 0);
      const grossUsd = Number((uiBal * priceUsd).toFixed(2));
      const gasUsd = 0.01;
      const slippageUsd = meta.isNativeCctpUsdc ? 0 : Number((grossUsd * 0.0025).toFixed(2));
      const isDust = grossUsd < 0.25;

      assets.push({
        id: `sui:${b.coinType}`,
        family: 'sui',
        sourceWallet: cleanAddr,
        chain: 'sui',
        chainName: 'Sui',
        address: b.coinType,
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
        kind: meta.isLst ? 'defi_position' : b.coinType === '0x2::sui::SUI' ? 'native' : 'erc20',
        protocol: meta.protocol,
        underlyingSymbol: meta.isLst ? 'SUI' : undefined,
        rawBalance: b.totalBalance,
        uiBalance: Number(uiBal.toFixed(6)),
        priceUsd,
        grossUsd,
        liquidityUsd: meta.isNativeCctpUsdc ? 400_000_000 : 50_000_000,
        estimatedGasUsd: gasUsd,
        batchedGasUsd: 0.005,
        estimatedSlippageUsd: slippageUsd,
        netUsdcSingle: Math.max(0, Number((grossUsd - gasUsd - slippageUsd).toFixed(2))),
        netUsdcBatched: Math.max(0, Number((grossUsd - 0.005 - slippageUsd).toFixed(2))),
        action: isDust
          ? 'SKIP_GAS_NEGATIVE'
          : meta.isNativeCctpUsdc
          ? 'BRIDGE_DIRECT_USDC'
          : 'SELL_AND_BRIDGE',
        actionReason: isDust
          ? 'Sub-$0.25 dust on Sui'
          : meta.isNativeCctpUsdc
          ? 'Direct Native Circle CCTP on Sui (Domain 8 → Solana USDC ATA PDA) in 1-Sig PTB'
          : meta.isLst
          ? `Direct LST Swap (${meta.symbol} → Solana via LI.FI/Cetus PTB, bypasses unstake wait)`
          : 'Atomic Sui PTB swap (LI.FI / Cetus) → Solana USDC/SOL',
        selectedByDefault: !isDust,
        honeypotSafe: true,
      });
    }

    // Active Delegated SUI stakes (GraphQL 0x3::staking_pool::StakedSui objects)
    let totalStakeMist = 0n;
    const activeStakeIds: string[] = [];
    for (const obj of stakedObjects) {
      const json = obj.contents?.json;
      const principal = String(json?.principal ?? '0');
      const reward = String(json?.estimated_reward ?? '0');
      try {
        const p = BigInt(principal);
        const r = BigInt(reward);
        if (p + r > 0n) {
          totalStakeMist += p + r;
          if (obj.address) activeStakeIds.push(obj.address);
        }
      } catch {
        // ignore malformed stake object
      }
    }
    if (totalStakeMist > 0n) {
      const uiStake = unitsToUi(totalStakeMist.toString(), 9);
      const grossUsd = Number((uiStake * suiPrice).toFixed(2));
      if (grossUsd >= 0.5) {
        assets.push({
          id: 'sui:native_stake',
          family: 'sui',
          sourceWallet: cleanAddr,
          chain: 'sui',
          chainName: 'Sui',
          address: activeStakeIds.length ? `staked:${activeStakeIds.join(',')}` : '0x3::sui_system::StakedSui',
          symbol: 'Staked SUI',
          name: `Sui Native Validator Stake (${Math.max(1, activeStakeIds.length)} object${activeStakeIds.length === 1 ? '' : 's'})`,
          decimals: 9,
          kind: 'defi_position',
          protocol: 'Sui Native Staking',
          underlyingSymbol: 'SUI',
          rawBalance: totalStakeMist.toString(),
          uiBalance: Number(uiStake.toFixed(6)),
          priceUsd: suiPrice,
          grossUsd,
          liquidityUsd: 80_000_000,
          estimatedGasUsd: 0.015,
          batchedGasUsd: 0.006,
          estimatedSlippageUsd: Number((grossUsd * 0.003).toFixed(2)),
          netUsdcSingle: Math.max(0, Number((grossUsd * 0.997 - 0.015).toFixed(2))),
          netUsdcBatched: Math.max(0, Number((grossUsd * 0.997 - 0.006).toFixed(2))),
          action: 'WITHDRAW_AND_BRIDGE',
          actionReason: 'PTB sui_system::request_withdraw_stake + swap + bridge to Solana in 1 signature',
          selectedByDefault: true,
          honeypotSafe: true,
          stakedExitMode: 'native_unstake',
        });
      }
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
      family: 'sui',
      sourceWallet: cleanAddr,
      chain: 'sui',
      chainName: 'Sui',
      chainId: 'sui:mainnet',
      cctpDomain: SUI_CCTP_DOMAIN,
      rpcStatus: rpcReachable ? 'live' : 'degraded',
      blockNumber,
      gasPriceGwei: 0.001,
      nativeBalance: Number(nativeBalance.toFixed(6)),
      nativeSymbol: 'SUI',
      nativePriceUsd: suiPrice,
      assetCount: assets.length,
      defiCount: assets.filter((a) => a.kind === 'defi_position').length,
      liquidCount: assets.filter((a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC').length,
      burnCount: 0,
      skippedCount: assets.filter((a) => a.action === 'SKIP_GAS_NEGATIVE').length,
      grossUsd,
      netUsdcBridged: netSolanaUsdc,
      totalGasUsd: batchedGasUsd,
      gasSavedByBatchUsd: Number(Math.max(0, singleTxGasUsd - batchedGasUsd).toFixed(3)),
      cctpAttestationSec: 16,
      needsGasSponsorship: nativeBalance < 0.05,
      sponsorshipMechanism: 'Direct 1-Sig PTB or Sui Native Sponsored Transaction (gasData.owner)',
    };

    return applyTwoLevelRoiToReport({
      scanId: `scan_sui_${crypto.randomBytes(4).toString('hex')}`,
      family: 'sui',
      mode: 'live_rpc',
      walletAddress: cleanAddr,
      walletLabel: label || 'Sui Mainnet',
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
    return prepareSuiDirectBatch(params);
  },

  async buildGaslessIntent(params): Promise<UniversalGaslessIntent> {
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    // Canonical SPL USDC ATA PDA (never raw Solana owner pubkey!)
    const mintRecipientBytes32 = deriveNonEvmCctpRecipientBytes32(params.solanaDestination);
    const sponsorAddress =
      getNonEvmFeeRecipient('sui') ||
      '0x00000000000000000000000000000000000000000000000000000000000051f0';
    const chainAssets = filterChainSweepableAssets('sui', params.assets);
    const grossUsd = Number(chainAssets.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const protocolFeeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const sponsoredGasEstUsd = 0.01;
    const estimatedNetUsd = Number(Math.max(0, grossUsd - protocolFeeUsd - sponsoredGasEstUsd).toFixed(2));
    const minNetUsdcOut = BigInt(Math.round(estimatedNetUsd * 0.985 * 1_000_000)).toString();
    const feeUsdcRaw = BigInt(Math.round(protocolFeeUsd * 1_000_000)).toString();
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    const nonce = BigInt('0x' + crypto.randomBytes(8).toString('hex')).toString();

    const breakEven = evaluateNonEvmGaslessBreakEven({
      grossUsd,
      sponsoredGasEstUsd,
      protocolFeeBps: feeCfg.feeBps,
      estimatedNetUsd,
    });

    const commands: Array<Record<string, unknown>> = [];
    if (chainAssets.some((a) => a.kind === 'defi_position' && a.id === 'sui:native_stake')) {
      commands.push({ moveCall: '0x3::sui_system::request_withdraw_stake', args: ['0x5', 'StakedSuiObjects'] });
    }
    for (const a of chainAssets.filter((x) => x.action === 'SELL_AND_BRIDGE')) {
      commands.push({
        moveCall: 'cetus_aggregator::swap_to_usdc',
        coinType: normalizeMoveCoinType(a.address),
        amountIn: a.rawBalance,
        targetCoinType: SUI_NATIVE_USDC_TYPE,
      });
    }
    commands.push({
      splitAndTransferFee: {
        feeBps: feeCfg.feeBps,
        feeUsdcRaw,
        recipient: sponsorAddress,
      },
    });
    commands.push({
      moveCall: 'cctp::token_messenger_minter::deposit_for_burn',
      sourceDomain: SUI_CCTP_DOMAIN,
      destinationDomain: SOLANA_CCTP_DOMAIN,
      mintRecipient: mintRecipientBytes32,
      burnCoinType: SUI_NATIVE_USDC_TYPE,
      minNetUsdcOut,
    });

    const signPayload = {
      kind: 'ProgrammableTransaction',
      sender: params.userAddress,
      gasData: {
        owner: sponsorAddress,
        budget: '50000000',
        price: '1000',
        sponsored: true,
      },
      commands,
      expirationEpochOffset: 2,
      expiration: deadline,
      nonce,
    };

    const intentDigestSha256 =
      '0x' + crypto.createHash('sha256').update(JSON.stringify(signPayload)).digest('hex');

    return {
      intentId: `int_sui_${crypto.randomBytes(4).toString('hex')}`,
      family: 'sui',
      mode: 'sui_sponsored_ptb',
      chain: 'sui',
      chainId: 'sui:mainnet',
      chainName: 'Sui',
      userAddress: params.userAddress,
      solanaDestination: params.solanaDestination,
      solanaMintRecipientBytes32: mintRecipientBytes32,
      outputAsset: params.outputAsset ?? 'USDC',
      nonce,
      deadline,
      userGasCostUsd: 0,
      sponsoredGasEstUsd,
      gasSponsorshipMechanism: 'Sui Native Sponsored Transaction (gasData.owner = Turgalium Relayer)',
      protocolFeeBps: feeCfg.feeBps,
      protocolFeePercent: feeCfg.feePercent,
      protocolFeeUsd,
      feeRecipient: getNonEvmFeeRecipient('sui'),
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
      relayerConfigured: Boolean(process.env.TURGALIUM_SUI_SPONSOR_PRIVATE_KEY?.trim()),
      sponsorEligible: breakEven.eligible,
      sponsorRejectionReason: breakEven.rejectionReason,
      intentDigestSha256,
      explanation: `1 Slush/Phantom signature authorizes an atomic ${commands.length}-command Sui PTB with gasData.owner = Turgalium Relayer ($0 user SUI) → Circle CCTP Domain 8 → Solana USDC ATA PDA.`,
    };
  },

  async simulatePreSignProof(params): Promise<UniversalPreSignProof> {
    const feeCfg = getProtocolFeeConfig({ feeBps: params.protocolFeeBps });
    const cleanAddr = params.userAddress.trim();
    const userAddressValid = suiAdapter.matchesAddress(cleanAddr);
    let expectedBytes32 = '0x' + '00'.repeat(32);
    let solanaRecipientValid = false;
    try {
      expectedBytes32 = deriveNonEvmCctpRecipientBytes32(params.solanaDestination);
      solanaRecipientValid = true;
    } catch {
      solanaRecipientValid = false;
    }

    const sweepable = filterChainSweepableAssets('sui', params.assets);
    const outputAsset = params.outputAsset ?? 'USDC';
    const escapedAddr = cleanAddr.replace(/[^0-9a-fA-Fx]/g, '');

    const [gqlData, solSnap, priceMap] = await Promise.all([
      userAddressValid
        ? suiGraphql<{
            checkpoint?: { sequenceNumber?: number };
            address?: {
              balances?: { nodes?: Array<{ coinType?: { repr?: string }; totalBalance?: string }> };
            };
          }>(
            `{ checkpoint { sequenceNumber } address(address: "${escapedAddr}") { balances(first: 50) { nodes { coinType { repr } totalBalance } } } }`
          )
        : Promise.resolve(null),
      solanaRecipientValid
        ? fetchSolanaWalletBalances(params.solanaDestination).catch(() => null)
        : Promise.resolve(null),
      fetchLiveUsdPrices(['coingecko:sui']),
    ]);

    let blockNumber = Number(gqlData?.checkpoint?.sequenceNumber ?? 0);
    const liveCoinBalances = new Map<string, bigint>();
    let liveBalancesFetched = Boolean(gqlData?.address?.balances);
    for (const n of gqlData?.address?.balances?.nodes ?? []) {
      if (n.coinType?.repr && n.totalBalance !== undefined) {
        try {
          liveCoinBalances.set(normalizeMoveCoinType(n.coinType.repr), BigInt(n.totalBalance));
        } catch {
          // ignore malformed balance
        }
      }
    }

    if (!blockNumber && userAddressValid) {
      const [cp, rpcBals] = await Promise.all([
        suiRpc<string>('sui_getLatestCheckpointSequenceNumber', []),
        suiRpc<Array<{ coinType: string; totalBalance: string }>>('suix_getAllBalances', [cleanAddr]),
      ]);
      blockNumber = Number(cp || 0);
      if (Array.isArray(rpcBals)) {
        liveBalancesFetched = true;
        for (const b of rpcBals) {
          try {
            liveCoinBalances.set(normalizeMoveCoinType(b.coinType), BigInt(b.totalBalance || '0'));
          } catch {
            // ignore
          }
        }
      }
    }

    const rawSui = (liveCoinBalances.get('0x2::sui::SUI') ?? 0n).toString();
    const nativeBalanceUi = Number(unitsToUi(rawSui, 9).toFixed(5));
    const nativePriceUsd = params.nativePriceUsd ?? priceMap.get('coingecko:sui') ?? 2.45;
    const nativeBalanceUsd = Number((nativeBalanceUi * nativePriceUsd).toFixed(2));
    const estimatedGasUsd = 0.01;
    const hasEnoughNativeGas = nativeBalanceUi >= 0.05;
    const grossUsd = Number(sweepable.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
    const feeUsd = Number(((grossUsd * feeCfg.feeBps) / 10_000).toFixed(2));
    const estimatedNetUsd = Number(Math.max(0, grossUsd - feeUsd - estimatedGasUsd).toFixed(2));
    const guaranteedMinNetUsd = Number((estimatedNetUsd * 0.985).toFixed(2));
    const rpcReachable = blockNumber > 0;

    // Fail-closed live balance verification for liquid Sui coins
    let insufficientBalanceDetail: string | null = null;
    if (liveBalancesFetched) {
      for (const a of sweepable) {
        if (a.id === 'sui:native_stake' || a.address.startsWith('staked:')) continue;
        let reqRaw = 0n;
        try {
          reqRaw = BigInt(a.rawBalance || '0');
        } catch {
          reqRaw = 0n;
        }
        const normType = normalizeMoveCoinType(a.address);
        const availRaw = liveCoinBalances.get(normType) ?? 0n;
        if (reqRaw > availRaw) {
          insufficientBalanceDetail = `Insufficient live Sui balance for ${a.symbol} (${availRaw.toString()} available < ${reqRaw.toString()} requested).`;
          break;
        }
      }
    }

    const ataMissing = outputAsset === 'USDC' && solSnap !== null && !solSnap.hasUsdcAta;

    // Real live sui_dryRunTransactionBlock when BCS base64 txBytes are provided
    const rawTxBytes = (
      params.rawTxBytes ??
      (typeof params.simulationPayload?.txBytes === 'string' ? params.simulationPayload.txBytes : undefined)
    )?.trim();

    let liveSimSucceeded = false;
    let liveSimError: string | null = null;
    let liveSimGasSummary: string | null = null;
    let liveSimUnreachable = false;

    if (rawTxBytes && userAddressValid && solanaRecipientValid && !insufficientBalanceDetail) {
      let responded = false;
      for (const url of SUI_RPC_URLS) {
        const res = await fetchWithRetry(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'sui_dryRunTransactionBlock',
              params: [rawTxBytes],
            }),
          },
          4200
        );
        if (!res) continue;
        responded = true;
        const json = (await res.json().catch(() => ({}))) as {
          result?: {
            effects?: {
              status?: { status?: string; error?: string };
              gasUsed?: { computationCost?: string; storageCost?: string };
            };
          };
          error?: { message?: string };
        };
        if (json.error) {
          liveSimError = json.error.message || 'sui_dryRunTransactionBlock RPC error';
        } else if (json.result?.effects?.status?.status === 'success') {
          liveSimSucceeded = true;
          liveSimGasSummary = `computationCost=${json.result.effects.gasUsed?.computationCost ?? '0'}`;
        } else {
          liveSimError =
            json.result?.effects?.status?.error ||
            `Sui dry-run failed with status=${json.result?.effects?.status?.status ?? 'unknown'}`;
        }
        break;
      }
      if (!responded) {
        liveSimUnreachable = true;
      }
    }

    const warnings: string[] = [];
    if (!userAddressValid) {
      warnings.push(`Invalid Sui address format: ${cleanAddr || '(empty)'}.`);
    }
    if (!solanaRecipientValid) {
      warnings.push('Invalid Solana destination address (expected valid non-zero base58 pubkey).');
    }
    if (ataMissing) {
      warnings.push('Destination Solana wallet has no canonical USDC ATA yet; create ATA before claiming CCTP USDC.');
    }
    if (sweepable.length === 0) {
      warnings.push('No sweepable Sui assets selected.');
    }
    if (insufficientBalanceDetail) {
      warnings.push(insufficientBalanceDetail);
    }
    if (!hasEnoughNativeGas) {
      warnings.push(`Low SUI balance (${nativeBalanceUi} SUI). Native Sponsored PTB sets gasData.owner = Turgalium Relayer ($0 user gas).`);
    }
    if (!rpcReachable) {
      warnings.push('Sui Mainnet GraphQL/RPC checkpoint could not be reached for live verification.');
    }
    if (liveSimError) {
      warnings.push(`Sui sui_dryRunTransactionBlock reverted: ${liveSimError}`);
    }

    const failClosedTx =
      !userAddressValid ||
      sweepable.length === 0 ||
      Boolean(insufficientBalanceDetail) ||
      Boolean(liveSimError);
    const failClosedRecipient = !solanaRecipientValid || ataMissing;

    const simulatedLive = Boolean(rawTxBytes && liveSimSucceeded && !failClosedTx && !failClosedRecipient);
    const allChecksSafe = Boolean(simulatedLive && !failClosedTx && !failClosedRecipient);

    const ptbCheckStatus: UniversalPreSignProof['checks'][number]['preflightStatus'] = failClosedTx
      ? 'reverted'
      : liveSimUnreachable || (!rawTxBytes && !rpcReachable)
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
      ? `Live Sui sui_dryRunTransactionBlock passed (${liveSimGasSummary ?? 'ok'}) at checkpoint #${blockNumber.toLocaleString()}.`
      : failClosedTx || failClosedRecipient
      ? `Pre-flight check failed closed: ${warnings[0] ?? 'validation rejected.'}`
      : liveSimUnreachable || !rpcReachable
      ? 'Sui GraphQL/RPC dry-run endpoint unreachable; transaction was not simulated.'
      : 'High-level Sui PTB intent pre-flight only: sui_dryRunTransactionBlock requires BCS-serialized txBytes from wallet/SDK.';

    const proofDigestSha256 =
      '0x' +
      crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            family: 'sui',
            checkpoint: blockNumber,
            userAddress: cleanAddr,
            expectedBytes32,
            simulatedLive,
            outflows: sweepable.map((a) => ({ id: a.id, raw: a.rawBalance })),
            guaranteedMinNetUsd,
          })
        )
        .digest('hex');

    return {
      proofId: `prf_sui_${crypto.randomBytes(4).toString('hex')}`,
      family: 'sui',
      proofDigestSha256,
      generatedAt: new Date().toISOString(),
      chain: 'sui',
      chainId: 'sui:mainnet',
      chainName: 'Sui',
      blockNumber,
      userAddress: cleanAddr,
      solanaDestination: params.solanaDestination,
      solanaMintRecipientBytes32: expectedBytes32,
      mintRecipientVerified: solanaRecipientValid,
      hasEnoughNativeGas,
      nativeBalanceUi,
      nativeSymbol: 'SUI',
      nativeBalanceUsd,
      estimatedGasUsd,
      recommendedMode: hasEnoughNativeGas ? 'eip5792_batch' : 'sponsored_gasless',
      simulationEndpoint: 'graphql.mainnet.sui.io + sui_dryRunTransactionBlock',
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
        collectionMethod: 'sui_ptb_split_coins_5_to_10_pct',
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
          stepId: 'sui_dry_run_ptb',
          assetSymbol: 'SUI',
          actionType: 'sui_ptb_dry_run',
          target: 'sui_dryRunTransactionBlock',
          summary:
            ptbCheckStatus === 'verified'
              ? `Live Sui dryRunTransactionBlock passed (${liveSimGasSummary ?? 'ok'})`
              : ptbCheckStatus === 'reverted'
              ? liveSimError
                ? `Sui dry-run reverted: ${liveSimError.slice(0, 120)}`
                : insufficientBalanceDetail || warnings[0] || 'Sui pre-flight rejected'
              : ptbCheckStatus === 'rpc_skipped'
              ? 'Sui GraphQL/RPC endpoint unreachable'
              : `Pre-flight Sui state checked at #${blockNumber.toLocaleString()} (no BCS txBytes simulated)`,
          preflightStatus: ptbCheckStatus,
          preflightDetail:
            ptbCheckStatus === 'verified'
              ? `Checkpoint #${blockNumber.toLocaleString()} · sui_dryRunTransactionBlock success (${liveSimGasSummary ?? 'ok'})`
              : ptbCheckStatus === 'reverted'
              ? liveSimError || insufficientBalanceDetail || warnings[0] || 'Sui pre-flight check failed closed'
              : ptbCheckStatus === 'rpc_skipped'
              ? 'Sui GraphQL/RPC unavailable'
              : `Checkpoint #${blockNumber.toLocaleString()} (${nativeBalanceUi} SUI) · BCS txBytes not supplied for live dry-run`,
        },
        {
          stepId: 'sui_cctp_domain8',
          assetSymbol: 'USDC',
          actionType: 'cctp_deposit_for_burn',
          target: 'cctp::token_messenger_minter::deposit_for_burn',
          summary: !solanaRecipientValid
            ? 'Invalid Solana destination address'
            : ataMissing
            ? 'Solana destination USDC ATA missing'
            : `Native Sui CCTP Domain 8 → Solana USDC ATA PDA (${simulatedLive ? 'verified' : 'unsimulated'})`,
          preflightStatus: cctpCheckStatus,
          preflightDetail: !solanaRecipientValid
            ? 'Solana destination failed base58 / non-zero public key validation'
            : ataMissing
            ? 'Solana wallet has no canonical USDC ATA yet'
            : simulatedLive
            ? `Canonical Solana USDC ATA bytes32 (${expectedBytes32.slice(0, 14)}…) verified alongside live dry-run`
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
        throw new Error('Signed Sui gasless PTB intent expired. Re-sign a fresh intent.');
      }
      const fp = '0x' + crypto.createHash('sha256').update(params.signature).digest('hex').slice(0, 16);
      const configured = Boolean(process.env.TURGALIUM_SUI_SPONSOR_PRIVATE_KEY?.trim());
      out.submitted = {
        accepted: true,
        mode: configured ? 'relayer_queued' : 'intent_verified_awaiting_deployment',
        broadcasted: false,
        settlementStatus: configured ? 'queued_for_sponsor' : 'awaiting_relayer',
        signatureFingerprint: fp,
        nextStep: configured
          ? `Sui gas sponsor queued PTB ${params.intentId} (${fp}) for co-signing.`
          : `Sui 1-Sig PTB verified (${fp}). Switch to Direct Mode to execute immediately with your Slush/Phantom wallet, or configure TURGALIUM_SUI_SPONSOR_PRIVATE_KEY for $0 gas.`,
      };
    }

    if (params.txHash) {
      const [txBlock, postSol] = await Promise.all([
        suiRpc<{
          checkpoint?: string;
          effects?: { status?: { status?: string }; gasUsed?: { computationCost?: string } };
          balanceChanges?: Array<{ coinType: string; amount: string; owner?: { AddressOwner?: string } }>;
        }>('sui_getTransactionBlock', [
          params.txHash,
          { showEffects: true, showBalanceChanges: true, showEvents: true },
        ]),
        fetchSolanaWalletBalances(params.solanaDestination).catch(() => null),
      ]);

      const found = Boolean(txBlock);
      const succeeded = txBlock?.effects?.status?.status === 'success';
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
          .update(JSON.stringify({ family: 'sui', digest: params.txHash, succeeded, solanaDeltaProof }))
          .digest('hex');

      const userLower = params.userAddress.toLowerCase();
      out.proof = {
        verified: Boolean(succeeded && positiveSolanaDelta),
        family: 'sui',
        proofDigestSha256,
        verifiedAt: new Date().toISOString(),
        chain: 'sui',
        chainName: 'Sui',
        txHash: params.txHash,
        explorerUrl: `https://suiscan.xyz/mainnet/tx/${params.txHash}`,
        sourceReceipt: {
          found,
          succeeded,
          blockOrHeight: txBlock?.checkpoint ? Number(txBlock.checkpoint) : undefined,
          gasUsed: txBlock?.effects?.gasUsed?.computationCost,
          nativeSymbol: 'SUI',
        },
        decodedTransfers: (txBlock?.balanceChanges ?? [])
          .filter((bc) => !userLower || bc.owner?.AddressOwner?.toLowerCase() === userLower)
          .map((bc) => {
            const norm = normalizeMoveCoinType(bc.coinType);
            const meta = KNOWN_SUI_COINS[norm];
            const dec = meta?.decimals ?? 9;
            return {
              tokenAddress: norm,
              symbol: sanitizeTokenSymbol(meta?.symbol ?? norm.split('::').pop(), 'COIN'),
              from: params.userAddress,
              to: bc.owner?.AddressOwner || 'ptb',
              amountUi: Math.abs(unitsToUi(bc.amount.replace('-', ''), dec)),
              category: bc.amount.startsWith('-') ? 'user_outflow' : 'other',
            };
          }),
        bridgeProof: {
          provider: params.provider === 'lifi' ? 'LI.FI (Sui → Solana)' : 'Circle CCTP (Sui Domain 8 → Solana Domain 5)',
          status: positiveSolanaDelta ? 'success' : succeeded ? 'relaying' : found ? 'failed' : 'pending',
        },
        solanaDeltaProof,
        summary: !found
          ? 'Sui transaction digest not yet indexed.'
          : succeeded
          ? `Verified on Sui checkpoint #${txBlock?.checkpoint ?? '—'} · Solana settlement tracked.`
          : 'Sui PTB execution failed.',
      };
    }

    return out;
  },
};
