import crypto from 'node:crypto';
import { solanaOwnerToUsdcAtaBytes32 } from '../bridge/cctp.js';
import { getProtocolFeeConfig, SOLANA_CCTP_DOMAIN } from '../scanner/chains.js';
import { SOLANA_USDC_MINT } from '../scanner/discovery.js';
import {
  computeRelayerBreakEven,
  evaluateLiveQuoteHaircut,
} from '../scanner/roi.js';
import type { AnyChainId, ChainFamily, ScannedAsset } from '../scanner/types.js';
import {
  computeTierScaledSlippageBps,
  type RouteAuctionFetcher,
  type TierScaledSlippageResult,
} from './route-auction.js';

export { computeTierScaledSlippageBps, type TierScaledSlippageResult };

export const SOLANA_NATIVE_MINT = '11111111111111111111111111111111';
export const RELAY_SOLANA_CHAIN_ID = 792703809;
export const RELAY_BITCOIN_CHAIN_ID = 8253038;
export const RELAY_TRON_CHAIN_ID = 728126428;
export const RELAY_TON_CHAIN_ID = 224235520;

export const LIFI_SOLANA_CHAIN_ID = 1151111081099710;
export const LIFI_BITCOIN_CHAIN_ID = 20000000000001;
export const LIFI_SUI_CHAIN_ID = 9270000000000000;
export const LIFI_TRON_CHAIN_ID = 728126428;

export const RELAY_BTC_NATIVE_CURRENCY = 'bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8';
export const RELAY_TON_NATIVE_CURRENCY = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
export const RELAY_TRON_NATIVE_CURRENCY = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
export const APTOS_NATIVE_USDC_FA_ADDRESS =
  '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b';
export const DEFAULT_NON_EVM_AUCTION_TIMEOUT_MS = 3500;

export interface NonEvmRouteAuctionCandidate {
  provider: string;
  label: string;
  status: 'ok' | 'rejected_haircut' | 'timeout' | 'error' | 'ineligible';
  quotedOutUsd: number;
  gasUsd: number;
  bridgeFeeUsd: number;
  netUsd: number;
  etaSeconds: number;
  latencyMs: number;
  liveExecutable: boolean;
  requestId?: string;
  reason?: string;
}

export interface NonEvmRouteAuctionMetadata {
  winner: string;
  winnerNetUsd: number;
  runnerUp?: string;
  runnerUpNetUsd?: number;
  savingsOverRunnerUpUsd: number;
  bpsSavedOverRunnerUp: number;
  totalAuctionDurationMs: number;
  providersQueried: string[];
  providersSucceeded: number;
  candidates: NonEvmRouteAuctionCandidate[];
  perAsset?: Record<string, Omit<NonEvmRouteAuctionMetadata, 'perAsset'>>;
}

declare module '../adapters/interface.js' {
  interface PreparedNonEvmBatch {
    routeAuction?: NonEvmRouteAuctionMetadata;
  }
}

// =====================================================================
// BECH32 / BECH32M CODEC (Zero-Dependency RFC BIP-173 & BIP-350)
// Used for Cosmos address validation, sibling coinType-118 derivation,
// and Bitcoin SegWit / Taproot validation.
// =====================================================================

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i += 1) {
      if ((top >>> i) & 1) chk ^= BECH32_GEN[i];
    }
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

export interface DecodedBech32 {
  hrp: string;
  words: number[];
  encoding: 'bech32' | 'bech32m';
}

export function decodeBech32(raw: string): DecodedBech32 | null {
  const s = raw.trim();
  if (s.length < 8 || s.length > 90) return null;
  let hasLower = false;
  let hasUpper = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 33 || c > 126) return null;
    if (c >= 97 && c <= 122) hasLower = true;
    if (c >= 65 && c <= 90) hasUpper = true;
  }
  if (hasLower && hasUpper) return null;

  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) return null;

  const hrp = lower.slice(0, sep);
  const dataPart = lower.slice(sep + 1);
  const data: number[] = [];
  for (let i = 0; i < dataPart.length; i += 1) {
    const idx = BECH32_CHARSET.indexOf(dataPart[i]);
    if (idx === -1) return null;
    data.push(idx);
  }

  const mod = bech32Polymod([...bech32HrpExpand(hrp), ...data]);
  if (mod !== BECH32_CONST && mod !== BECH32M_CONST) return null;

  return {
    hrp,
    words: data.slice(0, -6),
    encoding: mod === BECH32_CONST ? 'bech32' : 'bech32m',
  };
}

export function encodeBech32(
  hrp: string,
  words: number[],
  encoding: 'bech32' | 'bech32m' = 'bech32'
): string {
  const cleanHrp = hrp.trim().toLowerCase();
  const specConst = encoding === 'bech32m' ? BECH32M_CONST : BECH32_CONST;
  const polymod = bech32Polymod([...bech32HrpExpand(cleanHrp), ...words, 0, 0, 0, 0, 0, 0]) ^ specConst;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    checksum.push((polymod >>> (5 * (5 - i))) & 31);
  }
  return `${cleanHrp}1${[...words, ...checksum].map((w) => BECH32_CHARSET[w]).join('')}`;
}

/**
 * Re-encodes a valid Bech32 address under a new HRP with a freshly computed checksum.
 * Safe ONLY between chains sharing the same derivation path (e.g. Cosmos coinType 118:
 * cosmoshub, osmosis, noble, celestia, neutron). NEVER use for Injective (coinType 60).
 */
export function convertBech32Prefix(address: string, targetHrp: string): string | null {
  const decoded = decodeBech32(address);
  if (!decoded) return null;
  return encodeBech32(targetHrp, decoded.words, decoded.encoding);
}

/**
 * Normalizes a Move struct coin type tag (e.g. `0x0000...0002::sui::SUI` -> `0x2::sui::SUI`
 * and full 64-hex addresses lowercased) so Sui GraphQL & RPC tags match consistently.
 */
export function normalizeMoveCoinType(raw: string): string {
  const trimmed = raw.trim();
  const parts = trimmed.split('::');
  if (parts.length < 3) return trimmed;
  const addrPart = parts[0].toLowerCase();
  if (/^0x[0-9a-f]+$/.test(addrPart)) {
    const stripped = addrPart.slice(2).replace(/^0+/, '') || '0';
    // Preserve short canonical framework addresses (0x1, 0x2, 0x3) and pad 64-hex package addresses
    const normalizedAddr = stripped.length <= 4 ? `0x${stripped}` : `0x${stripped.padStart(64, '0')}`;
    return [normalizedAddr, ...parts.slice(1)].join('::');
  }
  return trimmed;
}

// =====================================================================
// PER-FAMILY FEE RECIPIENTS & SWEEPABLE ASSET / BREAK-EVEN GUARDS
// =====================================================================

export function getNonEvmFeeRecipient(family: Exclude<ChainFamily, 'evm'>, chainPrefix?: string): string | null {
  switch (family) {
    case 'cosmos':
      return process.env.TURGALIUM_FEE_RECIPIENT_COSMOS?.trim() || process.env.TURGALIUM_COSMOS_FEE_RECIPIENT?.trim() || null;
    case 'sui':
      return process.env.TURGALIUM_FEE_RECIPIENT_SUI?.trim() || process.env.TURGALIUM_SUI_SPONSOR_ADDRESS?.trim() || null;
    case 'aptos':
      return process.env.TURGALIUM_FEE_RECIPIENT_APTOS?.trim() || process.env.TURGALIUM_APTOS_FEE_PAYER?.trim() || null;
    case 'ton':
      return process.env.TURGALIUM_FEE_RECIPIENT_TON?.trim() || process.env.TURGALIUM_TON_RELAYER_ADDRESS?.trim() || null;
    case 'tron':
      return process.env.TURGALIUM_FEE_RECIPIENT_TRON?.trim() || process.env.TURGALIUM_TRON_ROUTER?.trim() || null;
    case 'btc':
      return process.env.TURGALIUM_THORNAME_AFFILIATE?.trim() || (chainPrefix ? `${chainPrefix}:turgalium` : 'turgalium');
    default:
      return null;
  }
}

const SWEEPABLE_ACTIONS = new Set<ScannedAsset['action']>([
  'WITHDRAW_AND_BRIDGE',
  'SELL_AND_BRIDGE',
  'BRIDGE_DIRECT_USDC',
]);

export function filterChainSweepableAssets(chain: AnyChainId, assets: ScannedAsset[]): ScannedAsset[] {
  return assets.filter((a) => a.chain === chain && SWEEPABLE_ACTIONS.has(a.action));
}

export function evaluateNonEvmGaslessBreakEven(params: {
  grossUsd: number;
  sponsoredGasEstUsd: number;
  protocolFeeBps: number;
  estimatedNetUsd: number;
}): { eligible: boolean; rejectionReason?: string } {
  const minNetUsdcRaw = BigInt(Math.max(0, Math.round(params.estimatedNetUsd * 0.98 * 1_000_000)));
  if (minNetUsdcRaw <= 0n || params.grossUsd <= 0) {
    return {
      eligible: false,
      rejectionReason: 'No positive net output after gas and protocol fee; skipped to prevent gas-drain griefing.',
    };
  }
  const be = computeRelayerBreakEven({
    grossUsd: params.grossUsd,
    protocolFeeBps: params.protocolFeeBps,
    sponsoredGasUsd: params.sponsoredGasEstUsd,
  });
  if (!be.isRelayerProfitable) {
    return {
      eligible: false,
      rejectionReason: be.rejectionReason,
    };
  }
  return { eligible: true };
}

export function deriveNonEvmCctpRecipientBytes32(solanaDestination: string): string {
  return solanaOwnerToUsdcAtaBytes32(solanaDestination);
}

// =====================================================================
// FETCH HELPER WITH TIMEOUT + 1 RETRY ON 429/5XX
// =====================================================================

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  timeoutMs = 5500,
  fetcher: RouteAuctionFetcher = globalThis.fetch.bind(globalThis)
): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetcher(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.status !== 429 && res.status < 500) return res;
    } catch {
      clearTimeout(timer);
    }
    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 450));
    }
  }
  return null;
}

// =====================================================================
// LIVE QUOTE PROVIDER 1: RELAY NON-EVM (Bitcoin, Tron, TON -> Solana)
// =====================================================================

export interface RelayNonEvmStep {
  id: string;
  action: string;
  description: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface RelayNonEvmQuoteResult {
  provider: 'relay';
  requestId: string;
  estimatedOutputUi: string;
  estimatedOutputSymbol: 'USDC' | 'SOL';
  quotedOutUsd: number;
  estimatedGasUsd: number;
  estimatedSeconds: number;
  steps: RelayNonEvmStep[];
}

export async function quoteRelayNonEvm(params: {
  originChainId: number;
  originCurrency: string;
  amountRaw: string;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  feeRecipient?: string | null;
  protocolFeeBps?: number;
  fetcher?: RouteAuctionFetcher;
}): Promise<RelayNonEvmQuoteResult | null> {
  const destCurrency = params.outputAsset === 'SOL' ? SOLANA_NATIVE_MINT : SOLANA_USDC_MINT;
  const body: Record<string, unknown> = {
    user: params.userAddress,
    recipient: params.solanaDestination,
    originChainId: params.originChainId,
    destinationChainId: RELAY_SOLANA_CHAIN_ID,
    originCurrency: params.originCurrency,
    destinationCurrency: destCurrency,
    amount: params.amountRaw,
    tradeType: 'EXACT_INPUT',
  };

  // Relay supports appFees when recipient matches destination or origin format (Solana base58 recipient works across all origin VMs!)
  const solFeeRecipient = process.env.TURGALIUM_FEE_RECIPIENT_SOLANA?.trim();
  const feeBps = getProtocolFeeConfig({ feeBps: params.protocolFeeBps }).feeBps;
  if (solFeeRecipient && feeBps > 0) {
    body.appFees = [{ recipient: solFeeRecipient, fee: String(feeBps) }];
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (process.env.RELAY_API_KEY?.trim()) {
    headers['x-api-key'] = process.env.RELAY_API_KEY.trim();
  }

  const res = await fetchWithRetry(
    'https://api.relay.link/quote',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    },
    5500,
    params.fetcher
  );
  if (!res || !res.ok) return null;

  const json = (await res.json()) as {
    requestId?: string;
    steps?: Array<{
      id?: string;
      action?: string;
      description?: string;
      kind?: string;
      requestId?: string;
      items?: Array<{ data?: Record<string, unknown> }>;
    }>;
    details?: {
      currencyOut?: { amountFormatted?: string; amountUsd?: string };
      timeEstimate?: number;
    };
    fees?: {
      gas?: { amountUsd?: string };
    };
  };

  const rawSteps = Array.isArray(json.steps) ? json.steps : [];
  const steps: RelayNonEvmStep[] = [];
  for (const s of rawSteps) {
    const itemData = s.items?.[0]?.data;
    if (!itemData || typeof itemData !== 'object') continue;
    steps.push({
      id: s.id || 'deposit',
      action: s.action || 'Confirm transaction',
      description: s.description || 'Relay cross-chain conversion to Solana',
      kind: s.kind || 'transaction',
      data: itemData,
    });
  }
  if (!steps.length) return null;

  const requestId = json.requestId || rawSteps.find((s) => s.requestId)?.requestId || `relay_${crypto.randomBytes(6).toString('hex')}`;
  const outFormatted = json.details?.currencyOut?.amountFormatted || '0';
  const outUsd = Number(json.details?.currencyOut?.amountUsd ?? 0);
  const gasUsd = Number(json.fees?.gas?.amountUsd ?? 0);
  const estSec = Math.max(5, Number(json.details?.timeEstimate ?? 15));

  return {
    provider: 'relay',
    requestId,
    estimatedOutputUi: `${Number(outFormatted).toFixed(params.outputAsset === 'SOL' ? 4 : 2)} ${params.outputAsset}`,
    estimatedOutputSymbol: params.outputAsset,
    quotedOutUsd: Number.isFinite(outUsd) ? Number(outUsd.toFixed(2)) : 0,
    estimatedGasUsd: Number.isFinite(gasUsd) ? Number(gasUsd.toFixed(4)) : 0,
    estimatedSeconds: estSec,
    steps,
  };
}

// =====================================================================
// LIVE QUOTE PROVIDER 2: LI.FI NON-EVM (Sui, Tron, Bitcoin -> Solana)
// =====================================================================

export interface LifiNonEvmQuoteResult {
  provider: 'lifi';
  tool: string;
  requestId: string;
  estimatedOutputUi: string;
  quotedOutUsd: number;
  estimatedGasUsd: number;
  estimatedSeconds: number;
  liveExecutable: boolean;
  appliedSlippageBps?: number;
  transactionRequest: Record<string, unknown> | null;
  routeSummary?: Record<string, unknown>;
}

export async function quoteLifiNonEvm(params: {
  fromChainId: number;
  fromToken: string;
  fromAmount: string;
  fromAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  tradeUsd?: number;
  liquidityUsd?: number;
  symbol?: string;
  slippageBps?: number;
  fetcher?: RouteAuctionFetcher;
}): Promise<LifiNonEvmQuoteResult | null> {
  const toToken = params.outputAsset === 'SOL' ? SOLANA_NATIVE_MINT : SOLANA_USDC_MINT;
  const slippagePlan = computeTierScaledSlippageBps({
    tradeUsd: params.tradeUsd,
    liquidityUsd: params.liquidityUsd,
    symbol: params.symbol,
    overrideBps: params.slippageBps,
  });
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.LIFI_API_KEY?.trim()) {
    headers['x-lifi-api-key'] = process.env.LIFI_API_KEY.trim();
  }

  // 1. Try direct /v1/quote (returns transactionRequest ready to sign when wallet holds balance)
  const qs = new URLSearchParams({
    fromChain: String(params.fromChainId),
    toChain: String(LIFI_SOLANA_CHAIN_ID),
    fromToken: params.fromToken,
    toToken,
    fromAmount: params.fromAmount,
    fromAddress: params.fromAddress,
    toAddress: params.solanaDestination,
    slippage: slippagePlan.slippageFraction.toFixed(4),
  });
  const directRes = await fetchWithRetry(
    `https://li.quest/v1/quote?${qs.toString()}`,
    { headers },
    5500,
    params.fetcher
  );
  if (directRes && directRes.ok) {
    const q = (await directRes.json()) as {
      id?: string;
      tool?: string;
      toolDetails?: { name?: string };
      estimate?: {
        toAmount?: string;
        toAmountUSD?: string;
        executionDuration?: number;
        gasCosts?: Array<{ amountUSD?: string }>;
      };
      transactionRequest?: Record<string, unknown>;
    };
    const outDec = params.outputAsset === 'SOL' ? 9 : 6;
    const outUi = q.estimate?.toAmount ? Number(q.estimate.toAmount) / 10 ** outDec : 0;
    const outUsd = Number(q.estimate?.toAmountUSD ?? 0);
    const gasUsd = (q.estimate?.gasCosts ?? []).reduce((s, g) => s + Number(g.amountUSD ?? 0), 0);
    if (outUi > 0 || q.transactionRequest) {
      return {
        provider: 'lifi',
        tool: q.toolDetails?.name || q.tool || 'LI.FI',
        requestId: q.id || `lifi_${crypto.randomBytes(6).toString('hex')}`,
        estimatedOutputUi: `${outUi.toFixed(params.outputAsset === 'SOL' ? 4 : 2)} ${params.outputAsset}`,
        quotedOutUsd: Number.isFinite(outUsd) ? Number(outUsd.toFixed(2)) : 0,
        estimatedGasUsd: Number.isFinite(gasUsd) ? Number(gasUsd.toFixed(4)) : 0,
        estimatedSeconds: Math.max(10, Number(q.estimate?.executionDuration ?? 45)),
        liveExecutable: Boolean(q.transactionRequest && Object.keys(q.transactionRequest).length > 0),
        appliedSlippageBps: slippagePlan.slippageBps,
        transactionRequest: q.transactionRequest ?? null,
      };
    }
  }

  // 2. Fallback to /v1/advanced/routes (works for Sui even when simulating / previewing before funding)
  const routeRes = await fetchWithRetry(
    'https://li.quest/v1/advanced/routes',
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromChainId: params.fromChainId,
        toChainId: LIFI_SOLANA_CHAIN_ID,
        fromTokenAddress: params.fromToken,
        toTokenAddress: toToken,
        fromAmount: params.fromAmount,
        fromAddress: params.fromAddress,
        toAddress: params.solanaDestination,
        options: { slippage: slippagePlan.slippageFraction },
      }),
    },
    5500,
    params.fetcher
  );
  if (!routeRes || !routeRes.ok) return null;
  const rj = (await routeRes.json()) as {
    routes?: Array<{
      id?: string;
      toAmount?: string;
      toAmountUSD?: string;
      gasCostUSD?: string;
      steps?: Array<{
        tool?: string;
        toolDetails?: { name?: string };
        estimate?: { executionDuration?: number };
      }>;
    }>;
  };
  const best = rj.routes?.[0];
  if (!best) return null;

  // Attempt stepTransaction on step 0 to get real serialized tx bytes
  let txReq: Record<string, unknown> | null = null;
  if (best.steps?.[0]) {
    const stepRes = await fetchWithRetry(
      'https://li.quest/v1/advanced/stepTransaction',
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(best.steps[0]),
      },
      5500,
      params.fetcher
    );
    if (stepRes && stepRes.ok) {
      const sj = (await stepRes.json()) as { transactionRequest?: Record<string, unknown> };
      if (sj.transactionRequest && Object.keys(sj.transactionRequest).length > 0) {
        txReq = sj.transactionRequest;
      }
    }
  }

  const outDec = params.outputAsset === 'SOL' ? 9 : 6;
  const outUi = best.toAmount ? Number(best.toAmount) / 10 ** outDec : 0;
  const outUsd = Number(best.toAmountUSD ?? 0);
  const gasUsd = Number(best.gasCostUSD ?? 0);
  const firstStep = best.steps?.[0];

  return {
    provider: 'lifi',
    tool: firstStep?.toolDetails?.name || firstStep?.tool || 'LI.FI',
    requestId: best.id || `lifi_${crypto.randomBytes(6).toString('hex')}`,
    estimatedOutputUi: `${outUi.toFixed(params.outputAsset === 'SOL' ? 4 : 2)} ${params.outputAsset}`,
    quotedOutUsd: Number.isFinite(outUsd) ? Number(outUsd.toFixed(2)) : 0,
    estimatedGasUsd: Number.isFinite(gasUsd) ? Number(gasUsd.toFixed(4)) : 0,
    estimatedSeconds: Math.max(10, Number(firstStep?.estimate?.executionDuration ?? 45)),
    liveExecutable: Boolean(txReq),
    appliedSlippageBps: slippagePlan.slippageBps,
    transactionRequest: txReq,
    routeSummary: {
      routeId: best.id,
      stepCount: best.steps?.length ?? 1,
      tool: firstStep?.tool,
    },
  };
}

// =====================================================================
// LIVE QUOTE PROVIDER 3: SKIP GO API (Cosmos/IBC 6 Chains -> Solana)
// =====================================================================

const COSMOS_CHAIN_ID_TO_HRP: Record<string, string> = {
  'cosmoshub-4': 'cosmos',
  'osmosis-1': 'osmo',
  'noble-1': 'noble',
  celestia: 'celestia',
  'neutron-1': 'neutron',
  'axelar-dojo-1': 'axelar',
  'stride-1': 'stride',
  'phoenix-1': 'terra',
  'kaiyo-1': 'kujira',
  'juno-1': 'juno',
  'stargaze-1': 'stars',
  'dydx-mainnet-1': 'dydx',
  'pacific-1': 'sei',
};

let skipChainPrefixCache: Map<string, string> | null = null;

async function resolveCosmosHrpForSkipChain(chainId: string): Promise<string | null> {
  if (COSMOS_CHAIN_ID_TO_HRP[chainId]) return COSMOS_CHAIN_ID_TO_HRP[chainId];
  if (!skipChainPrefixCache) {
    skipChainPrefixCache = new Map();
    const res = await fetchWithRetry('https://api.skip.build/v2/info/chains?include_evm=false&include_svm=false', {
      headers: { Accept: 'application/json' },
    }, 4000);
    if (res && res.ok) {
      const j = (await res.json()) as {
        chains?: Array<{ chain_id?: string; bech32_prefix?: string }>;
      };
      for (const c of j.chains ?? []) {
        if (c.chain_id && c.bech32_prefix) {
          skipChainPrefixCache.set(c.chain_id, c.bech32_prefix);
        }
      }
    }
  }
  return skipChainPrefixCache.get(chainId) ?? null;
}

export interface SkipGoCosmosQuoteResult {
  provider: 'skip_go';
  requestId: string;
  chainIds: string[];
  requiredChainAddresses: string[];
  estimatedOutputUi: string;
  quotedOutUsd: number;
  estimatedSeconds: number;
  txsRequired: number;
  liveExecutable: boolean;
  appliedSlippageBps?: number;
  cosmosTx: {
    chain_id: string;
    path?: string[];
    msgs: Array<{ msg_type_url: string; msg: string }>;
    signer_address: string;
  } | null;
  operations: unknown[];
}

export async function quoteSkipGoCosmos(params: {
  sourceChainId: string;
  sourceDenom: string;
  amountInRaw: string;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  addressesByChain?: Record<string, string>;
  tradeUsd?: number;
  liquidityUsd?: number;
  symbol?: string;
  slippageBps?: number;
  fetcher?: RouteAuctionFetcher;
}): Promise<SkipGoCosmosQuoteResult | null> {
  const destDenom = params.outputAsset === 'SOL' ? 'solana-native' : SOLANA_USDC_MINT;
  const inferredSymbol =
    params.symbol ??
    (params.sourceDenom === 'uusdc'
      ? 'USDC'
      : params.sourceDenom === 'uatom'
      ? 'ATOM'
      : params.sourceDenom === 'uosmo'
      ? 'OSMO'
      : undefined);
  const slippagePlan = computeTierScaledSlippageBps({
    tradeUsd: params.tradeUsd,
    liquidityUsd: params.liquidityUsd,
    symbol: inferredSymbol,
    overrideBps: params.slippageBps,
  });

  const routeRes = await fetchWithRetry(
    'https://api.skip.build/v2/fungible/route',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        source_asset_denom: params.sourceDenom,
        source_asset_chain_id: params.sourceChainId,
        dest_asset_denom: destDenom,
        dest_asset_chain_id: 'solana',
        amount_in: params.amountInRaw,
        smart_relay: true,
        allow_multi_tx: false,
      }),
    },
    5500,
    params.fetcher
  );
  if (!routeRes || !routeRes.ok) return null;

  const route = (await routeRes.json()) as {
    source_asset_denom?: string;
    source_asset_chain_id?: string;
    dest_asset_denom?: string;
    dest_asset_chain_id?: string;
    amount_in?: string;
    amount_out?: string;
    usd_amount_out?: string;
    estimated_route_duration_seconds?: number;
    txs_required?: number;
    chain_ids?: string[];
    required_chain_addresses?: string[];
    operations?: unknown[];
  };
  if (!route.amount_out || !Array.isArray(route.operations) || !route.operations.length) return null;

  const reqChains = route.required_chain_addresses ?? [params.sourceChainId, 'solana'];
  const isSourceInjective = params.sourceChainId === 'injective-1';
  const addressList: string[] = [];
  let canBuildMsgs = true;

  for (const cid of reqChains) {
    if (cid === 'solana') {
      addressList.push(params.solanaDestination);
      continue;
    }
    if (cid === params.sourceChainId) {
      addressList.push(params.userAddress);
      continue;
    }
    // Check explicit connected wallet address map first
    const byChain = params.addressesByChain ?? {};
    const explicit =
      byChain[cid] ||
      Object.entries(byChain).find(([k]) => cid.startsWith(k))?.[1];
    if (explicit) {
      addressList.push(explicit);
      continue;
    }
    // Safe Bech32 HRP re-encoding for intermediate Cosmos PFM hops (never from/to Injective coinType 60)
    const hrp = !isSourceInjective ? await resolveCosmosHrpForSkipChain(cid) : null;
    if (hrp) {
      const derived = convertBech32Prefix(params.userAddress, hrp);
      if (derived) {
        addressList.push(derived);
        continue;
      }
    }
    canBuildMsgs = false;
    break;
  }

  let cosmosTx: SkipGoCosmosQuoteResult['cosmosTx'] = null;
  if (canBuildMsgs && addressList.length === reqChains.length) {
    const msgsRes = await fetchWithRetry(
      'https://api.skip.build/v2/fungible/msgs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          source_asset_denom: route.source_asset_denom,
          source_asset_chain_id: route.source_asset_chain_id,
          dest_asset_denom: route.dest_asset_denom,
          dest_asset_chain_id: route.dest_asset_chain_id,
          amount_in: route.amount_in,
          amount_out: route.amount_out,
          address_list: addressList,
          operations: route.operations,
          slippage_tolerance_percent: String(slippagePlan.slippagePercent),
        }),
      },
      5500,
      params.fetcher
    );
    if (msgsRes && msgsRes.ok) {
      const mj = (await msgsRes.json()) as {
        txs?: Array<{
          cosmos_tx?: {
            chain_id: string;
            path?: string[];
            msgs: Array<{ msg_type_url: string; msg: string }>;
            signer_address: string;
          };
        }>;
      };
      if (mj.txs?.[0]?.cosmos_tx?.msgs?.length) {
        cosmosTx = mj.txs[0].cosmos_tx;
      }
    }
  }

  const outDec = params.outputAsset === 'SOL' ? 9 : 6;
  const outUi = Number(route.amount_out) / 10 ** outDec;
  const outUsd = Number(route.usd_amount_out ?? (params.outputAsset === 'USDC' ? outUi : 0));

  return {
    provider: 'skip_go',
    requestId: `skip_${crypto.randomBytes(6).toString('hex')}`,
    chainIds: route.chain_ids ?? [params.sourceChainId, 'solana'],
    requiredChainAddresses: reqChains,
    estimatedOutputUi: `${outUi.toFixed(params.outputAsset === 'SOL' ? 4 : 2)} ${params.outputAsset}`,
    quotedOutUsd: Number.isFinite(outUsd) ? Number(outUsd.toFixed(2)) : 0,
    estimatedSeconds: Math.max(15, Number(route.estimated_route_duration_seconds ?? 120)),
    txsRequired: Number(route.txs_required ?? 1),
    liveExecutable: Boolean(cosmosTx),
    appliedSlippageBps: slippagePlan.slippageBps,
    cosmosTx,
    operations: route.operations,
  };
}

// =====================================================================
// LIVE QUOTE PROVIDER 4: TONAPI GASLESS CONFIG + STATUS TRACKING
// =====================================================================

export interface TonGaslessConfig {
  relayAddress: string;
  gasJettons: string[];
}

export async function fetchTonGaslessConfig(): Promise<TonGaslessConfig | null> {
  const res = await fetchWithRetry('https://tonapi.io/v2/gasless/config', {
    headers: { Accept: 'application/json' },
  }, 4000);
  if (!res || !res.ok) return null;
  const j = (await res.json()) as {
    relay_address?: string;
    gas_jettons?: Array<{ master_id?: string }>;
  };
  if (!j.relay_address) return null;
  return {
    relayAddress: j.relay_address,
    gasJettons: (j.gas_jettons ?? []).map((g) => g.master_id || '').filter(Boolean),
  };
}

export function checkQuoteHaircutPass(params: {
  grossUsd: number;
  quotedOutUsd: number;
  estimatedGasUsd: number;
  allowHighCost?: boolean;
}): { passed: boolean; reason: string } {
  if (params.quotedOutUsd <= 0) {
    return { passed: true, reason: 'Quote USD unavailable; skipping haircut filter.' };
  }
  const gate = evaluateLiveQuoteHaircut({
    grossUsd: params.grossUsd,
    quoteOutUsd: params.quotedOutUsd,
    actualGasUsd: params.estimatedGasUsd,
    allowHighCost: Boolean(params.allowHighCost),
  });
  return { passed: gate.passed, reason: gate.reason };
}

export function getCctpSolanaDomain(): number {
  return SOLANA_CCTP_DOMAIN;
}

// =====================================================================
// LIVE QUOTE PROVIDER 5: MAYAN SWIFT NON-EVM (Sui -> Solana)
// =====================================================================

export interface MayanSwiftNonEvmQuoteResult {
  provider: 'mayan_swift';
  tool: string;
  requestId: string;
  estimatedOutputUi: string;
  quotedOutUsd: number;
  estimatedGasUsd: number;
  bridgeFeeUsd: number;
  estimatedSeconds: number;
  liveExecutable: boolean;
  appliedSlippageBps: number;
  transactionRequest: Record<string, unknown> | null;
  rawQuote: Record<string, unknown>;
}

interface MayanRawQuotePayload {
  type?: string;
  quoteId?: string;
  expectedAmountOut?: string | number;
  expectedAmountOutBaseUnits?: string | number;
  minAmountOut?: string | number;
  toTokenPrice?: number;
  toToken?: { decimals?: number; symbol?: string };
  clientRelayerFeeSuccess?: number;
  swapRelayerFee?: number;
  redeemRelayerFee?: number;
  etaSeconds?: number;
  eta?: number;
  transactionRequest?: Record<string, unknown>;
  serializedTransaction?: string;
  ptbBytes?: string;
  [key: string]: unknown;
}

export async function quoteMayanSwiftNonEvm(params: {
  fromChain: 'sui';
  fromToken: string;
  fromAmount: string;
  fromDecimals: number;
  fromAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  tradeUsd?: number;
  liquidityUsd?: number;
  symbol?: string;
  slippageBps?: number;
  timeoutMs?: number;
  fetcher?: RouteAuctionFetcher;
}): Promise<MayanSwiftNonEvmQuoteResult | null> {
  const toToken = params.outputAsset === 'SOL' ? SOLANA_NATIVE_MINT : SOLANA_USDC_MINT;
  const slippagePlan = computeTierScaledSlippageBps({
    tradeUsd: params.tradeUsd,
    liquidityUsd: params.liquidityUsd,
    symbol: params.symbol,
    overrideBps: params.slippageBps,
  });

  let amountInUi = 0;
  try {
    const raw = BigInt(params.fromAmount);
    const div = 10n ** BigInt(params.fromDecimals);
    amountInUi = Number(raw / div) + Number(raw % div) / Number(div);
  } catch {
    amountInUi = Number(params.fromAmount) / 10 ** params.fromDecimals;
  }
  if (!Number.isFinite(amountInUi) || amountInUi <= 0) return null;

  const url = new URL('https://price-api.mayan.finance/v3/quote');
  url.searchParams.set('amountIn64', params.fromAmount);
  url.searchParams.set('amountIn', String(amountInUi));
  url.searchParams.set('fromToken', params.fromToken);
  url.searchParams.set('fromChain', params.fromChain);
  url.searchParams.set('toToken', toToken);
  url.searchParams.set('toChain', 'solana');
  url.searchParams.set('slippageBps', String(slippagePlan.slippageBps));
  url.searchParams.set('swift', 'true');
  url.searchParams.set('fromAddress', params.fromAddress);
  url.searchParams.set('destAddress', params.solanaDestination);
  url.searchParams.set('gasDrop', '0');

  const timeoutMs = params.timeoutMs ?? DEFAULT_NON_EVM_AUCTION_TIMEOUT_MS;
  const fetcher = params.fetcher ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response | null = null;
  try {
    res = await fetcher(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch {
    res = null;
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) return null;

  const rawJson = (await res.json().catch(() => null)) as
    | MayanRawQuotePayload
    | MayanRawQuotePayload[]
    | { quotes?: MayanRawQuotePayload[] }
    | null;
  if (!rawJson) return null;

  const list: MayanRawQuotePayload[] = Array.isArray(rawJson)
    ? rawJson
    : Array.isArray((rawJson as { quotes?: MayanRawQuotePayload[] }).quotes)
    ? ((rawJson as { quotes: MayanRawQuotePayload[] }).quotes)
    : [rawJson as MayanRawQuotePayload];

  const valid = list.filter((q) => {
    const out = Number(q.expectedAmountOut ?? 0);
    const outBase = Number(q.expectedAmountOutBaseUnits ?? 0);
    return (Number.isFinite(out) && out > 0) || (Number.isFinite(outBase) && outBase > 0);
  });
  if (!valid.length) return null;

  const swiftQuotes = valid.filter((q) => String(q.type || '').toUpperCase() === 'SWIFT');
  const pool = swiftQuotes.length ? swiftQuotes : valid;
  const best = pool.reduce((a, b) =>
    Number(b.expectedAmountOut ?? 0) > Number(a.expectedAmountOut ?? 0) ? b : a
  );

  const outDec = params.outputAsset === 'SOL' ? 9 : 6;
  const outUi =
    Number(best.expectedAmountOut ?? 0) > 0
      ? Number(best.expectedAmountOut)
      : Number(best.expectedAmountOutBaseUnits ?? 0) / 10 ** outDec;
  if (!Number.isFinite(outUi) || outUi <= 0) return null;

  const outPrice =
    params.outputAsset === 'USDC'
      ? 1.0
      : Number(best.toTokenPrice ?? 0) > 0
      ? Number(best.toTokenPrice)
      : 150;
  const quotedOutUsd = Number((outUi * outPrice).toFixed(2));
  const bridgeFeeUsd = Number(
    Math.max(0, Number(best.clientRelayerFeeSuccess ?? best.swapRelayerFee ?? 0)).toFixed(4)
  );
  const estimatedGasUsd = 0.01;
  const etaSeconds = Math.max(8, Number(best.etaSeconds ?? best.eta ?? 18));

  const txReq: Record<string, unknown> | null =
    best.transactionRequest && Object.keys(best.transactionRequest).length > 0
      ? best.transactionRequest
      : typeof best.serializedTransaction === 'string' && best.serializedTransaction.length > 0
      ? { data: best.serializedTransaction }
      : typeof best.ptbBytes === 'string' && best.ptbBytes.length > 0
      ? { data: best.ptbBytes }
      : null;

  const hasExecutableBytes = Boolean(
    txReq &&
      ((typeof txReq.data === 'string' && txReq.data.trim().length > 0) ||
        (typeof txReq.transactionBlock === 'string' && txReq.transactionBlock.trim().length > 0))
  );

  return {
    provider: 'mayan_swift',
    tool: String(best.type || 'SWIFT').toUpperCase() === 'SWIFT' ? 'Mayan Swift' : `Mayan ${best.type}`,
    requestId: best.quoteId || `mayan_${crypto.randomBytes(6).toString('hex')}`,
    estimatedOutputUi: `${outUi.toFixed(params.outputAsset === 'SOL' ? 4 : 2)} ${params.outputAsset}`,
    quotedOutUsd,
    estimatedGasUsd,
    bridgeFeeUsd,
    estimatedSeconds: etaSeconds,
    liveExecutable: hasExecutableBytes,
    appliedSlippageBps: slippagePlan.slippageBps,
    transactionRequest: txReq,
    rawQuote: best as Record<string, unknown>,
  };
}

// =====================================================================
// LIVE QUOTE PROVIDER 6: PANORA SWAP API (Aptos Pre-Swap -> Native USDC FA)
// =====================================================================

const MOVE_ENTRY_FN_RE = /^0x[0-9a-fA-F]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+$/;

export interface PanoraAptosSwapQuoteResult {
  ok: true;
  provider: 'panora';
  requestId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  expectedOutUsdcUi: number;
  minOutUsdcUi: number;
  minOutUsdcRaw: string;
  quotedOutUsd: number;
  estimatedGasUsd: number;
  appliedSlippageBps: number;
  txData: {
    function: string;
    type_arguments: string[];
    arguments: unknown[];
  };
}

export interface PanoraAptosSwapFailure {
  ok: false;
  reason: string;
  unkeyed?: boolean;
}

export async function quotePanoraAptosSwap(params: {
  fromTokenAddress: string;
  toTokenAddress?: string;
  fromAmountRaw: string;
  fromDecimals: number;
  userAddress: string;
  tradeUsd?: number;
  liquidityUsd?: number;
  symbol?: string;
  slippageBps?: number;
  apiKey?: string;
  timeoutMs?: number;
  fetcher?: RouteAuctionFetcher;
}): Promise<PanoraAptosSwapQuoteResult | PanoraAptosSwapFailure> {
  const apiKey = (params.apiKey ?? process.env.PANORA_API_KEY ?? '').trim();
  if (!apiKey) {
    return {
      ok: false,
      unkeyed: true,
      reason:
        'PANORA_API_KEY is not configured; cannot fetch live Aptos Panora pre-swap Move entry function payload (fail-closed).',
    };
  }

  const toTokenAddress = params.toTokenAddress?.trim() || APTOS_NATIVE_USDC_FA_ADDRESS;
  const rawLower = params.fromTokenAddress.trim().toLowerCase();
  const normalizedFromToken =
    rawLower === '0xa' ||
    rawLower === '0x000000000000000000000000000000000000000000000000000000000000000a' ||
    rawLower === '0x1::aptos_coin::aptoscoin'
      ? '0x1::aptos_coin::AptosCoin'
      : params.fromTokenAddress.trim();

  let amountInUi = 0;
  try {
    const raw = BigInt(params.fromAmountRaw);
    const div = 10n ** BigInt(params.fromDecimals);
    amountInUi = Number(raw / div) + Number(raw % div) / Number(div);
  } catch {
    amountInUi = Number(params.fromAmountRaw) / 10 ** params.fromDecimals;
  }
  if (!Number.isFinite(amountInUi) || amountInUi <= 0) {
    return { ok: false, reason: 'Invalid non-positive Aptos swap input amount.' };
  }

  const slippagePlan = computeTierScaledSlippageBps({
    tradeUsd: params.tradeUsd,
    liquidityUsd: params.liquidityUsd,
    symbol: params.symbol,
    overrideBps: params.slippageBps,
  });

  const url = new URL('https://api.panora.exchange/swap');
  url.searchParams.set('fromTokenAddress', normalizedFromToken);
  url.searchParams.set('toTokenAddress', toTokenAddress);
  url.searchParams.set('fromTokenAmount', String(amountInUi));
  url.searchParams.set('toWalletAddress', params.userAddress);
  url.searchParams.set('slippagePercentage', String(slippagePlan.slippagePercent));

  const res = await fetchWithRetry(
    url.toString(),
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
    },
    params.timeoutMs ?? 4500,
    params.fetcher
  );
  if (!res) {
    return {
      ok: false,
      reason: 'Panora Swap API did not respond within timeout; skipping Aptos pre-swap (fail-closed).',
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      reason: `Panora Swap API returned HTTP ${res.status}; skipping Aptos pre-swap (fail-closed).`,
    };
  }

  const json = (await res.json().catch(() => null)) as {
    quotes?: Array<{
      toTokenAmount?: string | number;
      minToTokenAmount?: string | number;
      toTokenAmountUSD?: string | number;
      txData?: {
        function?: string;
        type_arguments?: unknown[];
        arguments?: unknown[];
      };
    }>;
    txData?: {
      function?: string;
      type_arguments?: unknown[];
      arguments?: unknown[];
    };
    toTokenAmount?: string | number;
    minToTokenAmount?: string | number;
    toTokenAmountUSD?: string | number;
  } | null;

  const best = Array.isArray(json?.quotes) && json.quotes.length > 0 ? json.quotes[0] : json;
  const txData = best?.txData;
  if (
    !txData ||
    typeof txData.function !== 'string' ||
    !MOVE_ENTRY_FN_RE.test(txData.function.trim()) ||
    !Array.isArray(txData.type_arguments) ||
    !Array.isArray(txData.arguments)
  ) {
    return {
      ok: false,
      reason: 'Panora Swap API returned no valid Move entry_function_payload (function/type_arguments/arguments); fail-closed.',
    };
  }

  const expectedOutUsdcUi = Number(best?.toTokenAmount ?? 0);
  const rawMinOutUi = Number(best?.minToTokenAmount ?? 0);
  const minOutUsdcUi =
    Number.isFinite(rawMinOutUi) && rawMinOutUi > 0
      ? rawMinOutUi
      : expectedOutUsdcUi * (1 - slippagePlan.slippageFraction);
  if (!Number.isFinite(expectedOutUsdcUi) || expectedOutUsdcUi <= 0 || !Number.isFinite(minOutUsdcUi) || minOutUsdcUi <= 0) {
    return {
      ok: false,
      reason: 'Panora Swap API returned zero or invalid USDC output amount.',
    };
  }

  const minOutUsdcRaw = BigInt(Math.floor(minOutUsdcUi * 1_000_000)).toString();
  if (BigInt(minOutUsdcRaw) <= 0n) {
    return {
      ok: false,
      reason: 'Panora pre-swap minimum USDC output rounds to 0 base units.',
    };
  }

  const quotedOutUsd = Number(
    (Number(best?.toTokenAmountUSD ?? 0) > 0 ? Number(best?.toTokenAmountUSD) : expectedOutUsdcUi).toFixed(2)
  );

  return {
    ok: true,
    provider: 'panora',
    requestId: `panora_${crypto.randomBytes(6).toString('hex')}`,
    fromTokenAddress: normalizedFromToken,
    toTokenAddress,
    expectedOutUsdcUi: Number(expectedOutUsdcUi.toFixed(6)),
    minOutUsdcUi: Number(minOutUsdcUi.toFixed(6)),
    minOutUsdcRaw,
    quotedOutUsd,
    estimatedGasUsd: 0.01,
    appliedSlippageBps: slippagePlan.slippageBps,
    txData: {
      function: txData.function.trim(),
      type_arguments: txData.type_arguments.map(String),
      arguments: txData.arguments,
    },
  };
}
