import { EVM_CHAINS } from '../scanner/chains.js';
import type { EvmChainId } from '../scanner/types.js';
import { evmJsonRpcCall, formatUnits } from '../scanner/rpc.js';
import { FALLBACK_PRICES } from '../scanner/prices.js';
import { validateRouterCallTarget, type RouteAuctionFetcher } from './route-auction.js';

function getFallbackNativePriceUsd(symbol: string): number {
  return FALLBACK_PRICES[symbol] ?? FALLBACK_PRICES[symbol.toUpperCase()] ?? 1;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface ChainNativeGasStatus {
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  nativeSymbol: string;
  nativeBalanceWei: string;
  nativeBalanceUi: number;
  nativeBalanceUsd: number;
  requiredMsgValueWei: string;
  requiredMsgValueUi: number;
  estimatedGasUsd: number;
  hasEnoughGas: boolean;
  gasUnknown?: boolean;
  shortfallUsd: number;
  reason?: string;
}

export interface GasRefuelQuoteRequest {
  fromChain: EvmChainId;
  toChain: EvmChainId;
  userAddress: string;
  amountUsd?: number;
  timeoutMs?: number;
  fetcher?: RouteAuctionFetcher;
  nativePrices?: Record<string, number>;
}

export interface GasRefuelTransaction {
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  explorerUrl: string;
  from: string;
  to: string;
  data: string;
  value: string;
  gas?: string;
  label: string;
}

export interface GasRefuelQuoteResult {
  provider: 'relay';
  requestId?: string;
  fromChain: EvmChainId;
  fromChainId: number;
  fromChainName: string;
  fromNativeSymbol: string;
  toChain: EvmChainId;
  toChainId: number;
  toChainName: string;
  toNativeSymbol: string;
  amountInWei: string;
  amountInUi: number;
  amountInUsd: number;
  estimatedOutFormatted: string;
  estimatedOutUsd: number;
  estimatedSeconds: number;
  transaction: GasRefuelTransaction;
}

function round2(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function round6(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(6)) : 0;
}

function toHexWei(val: string | number | bigint | undefined): string {
  if (val === undefined || val === null || val === '') return '0x0';
  if (typeof val === 'bigint') return `0x${(val < 0n ? 0n : val).toString(16)}`;
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return '0x0';
    return `0x${BigInt(Math.floor(val)).toString(16)}`;
  }
  const s = val.trim();
  if (!s) return '0x0';
  try {
    const n = s.startsWith('0x') || s.startsWith('0X') ? BigInt(s) : BigInt(s);
    return `0x${(n < 0n ? 0n : n).toString(16)}`;
  } catch {
    return '0x0';
  }
}

export function parseHexOrDecWei(raw: string | undefined): bigint {
  if (!raw || typeof raw !== 'string') return 0n;
  const s = raw.trim();
  if (!s) return 0n;
  try {
    const n = BigInt(s);
    return n > 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Fetches live native gas balances (eth_getBalance) across unique EVM chains in parallel.
 * Returns null per chain when all RPCs fail so callers degrade gracefully.
 */
export async function fetchChainNativeBalancesWei(params: {
  chains: EvmChainId[];
  userAddress: string;
  timeoutMs?: number;
  rpcCallFn?: typeof evmJsonRpcCall;
}): Promise<Partial<Record<EvmChainId, bigint>>> {
  const uniqueChains = Array.from(new Set(params.chains.filter((c) => Object.hasOwn(EVM_CHAINS, c))));
  if (!uniqueChains.length || !EVM_ADDRESS_RE.test(params.userAddress)) return {};

  const rpcFn = params.rpcCallFn ?? evmJsonRpcCall;
  const timeoutMs = params.timeoutMs ?? 2_800;
  const out: Partial<Record<EvmChainId, bigint>> = {};

  await Promise.all(
    uniqueChains.map(async (chain) => {
      const cfg = EVM_CHAINS[chain];
      if (!cfg) return;
      try {
        const res = await rpcFn<string>(
          cfg.rpcUrls,
          'eth_getBalance',
          [params.userAddress, 'latest'],
          timeoutMs
        );
        if (typeof res.result === 'string' && /^0x[0-9a-fA-F]+$/.test(res.result)) {
          out[chain] = BigInt(res.result);
        }
      } catch {
        // Leave undefined when RPC is unavailable so we never false-block offline/degraded RPCs
      }
    })
  );

  return out;
}

/**
 * Evaluates whether the user has enough native gas on each chain to broadcast prepared transactions
 * (covering both tx msg.value such as bridge fixFees and estimated network gas with safety headroom).
 */
export function evaluateChainNativeGasStatus(params: {
  chain: EvmChainId;
  nativeBalanceWei: bigint | undefined;
  requiredMsgValueWei: bigint;
  estimatedGasUsd: number;
  nativePriceUsd?: number;
}): ChainNativeGasStatus {
  const cfg = EVM_CHAINS[params.chain];
  const nativePriceUsd =
    typeof params.nativePriceUsd === 'number' && params.nativePriceUsd > 0
      ? params.nativePriceUsd
      : getFallbackNativePriceUsd(cfg.nativeSymbol);

  const requiredMsgValueUi = round6(formatUnits(params.requiredMsgValueWei, 18));
  const requiredMsgValueUsd = requiredMsgValueUi * nativePriceUsd;
  const safeGasUsd = Math.max(0.01, (Number.isFinite(params.estimatedGasUsd) ? params.estimatedGasUsd : 0) * 1.35);

  if (params.nativeBalanceWei === undefined) {
    return {
      chain: params.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      nativeSymbol: cfg.nativeSymbol,
      nativeBalanceWei: '0',
      nativeBalanceUi: 0,
      nativeBalanceUsd: 0,
      requiredMsgValueWei: params.requiredMsgValueWei.toString(),
      requiredMsgValueUi,
      estimatedGasUsd: round2(params.estimatedGasUsd),
      hasEnoughGas: true,
      gasUnknown: true,
      shortfallUsd: 0,
    };
  }

  const nativeBalanceUi = round6(formatUnits(params.nativeBalanceWei, 18));
  const nativeBalanceUsd = round2(nativeBalanceUi * nativePriceUsd);
  const totalNeededUsd = requiredMsgValueUsd + safeGasUsd;
  const hasEnoughGas =
    params.nativeBalanceWei > params.requiredMsgValueWei &&
    nativeBalanceUsd >= totalNeededUsd - 1e-6;
  const shortfallUsd = hasEnoughGas ? 0 : round2(Math.max(0.01, totalNeededUsd - nativeBalanceUsd));

  const reason = hasEnoughGas
    ? undefined
    : params.nativeBalanceWei === 0n
    ? `${cfg.name} wallet has 0 ${cfg.nativeSymbol} ($0.00) for gas. Refuel ~$${Math.max(0.5, shortfallUsd).toFixed(2)} ${cfg.nativeSymbol} or skip ${cfg.name}.`
    : params.nativeBalanceWei <= params.requiredMsgValueWei
    ? `${cfg.name} transaction needs ${requiredMsgValueUi} ${cfg.nativeSymbol} + gas, but wallet only holds ${nativeBalanceUi} ${cfg.nativeSymbol}.`
    : `${cfg.name} has ${nativeBalanceUi} ${cfg.nativeSymbol} (~$${nativeBalanceUsd.toFixed(2)}), below estimated gas (~$${totalNeededUsd.toFixed(2)}).`;

  return {
    chain: params.chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    nativeSymbol: cfg.nativeSymbol,
    nativeBalanceWei: params.nativeBalanceWei.toString(),
    nativeBalanceUi,
    nativeBalanceUsd,
    requiredMsgValueWei: params.requiredMsgValueWei.toString(),
    requiredMsgValueUi,
    estimatedGasUsd: round2(params.estimatedGasUsd),
    hasEnoughGas,
    shortfallUsd,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Builds a 1-click Relay cross-chain native gas drop (e.g. $1 ETH on Base/Arbitrum/Optimism/Ethereum -> POL on Polygon)
 * so users with $0.00 gas on a target chain can unlock their sweep in one signature without leaving Turgalium.
 */
export async function buildGasRefuelQuote(
  params: GasRefuelQuoteRequest
): Promise<GasRefuelQuoteResult> {
  const fromCfg = EVM_CHAINS[params.fromChain];
  const toCfg = EVM_CHAINS[params.toChain];
  if (!fromCfg) {
    throw new Error(`Unsupported source chain for gas refuel: ${String(params.fromChain)}`);
  }
  if (!toCfg) {
    throw new Error(`Unsupported destination chain for gas refuel: ${String(params.toChain)}`);
  }
  if (params.fromChain === params.toChain) {
    throw new Error('Source and destination chains for gas refuel must be different.');
  }

  const userAddress = typeof params.userAddress === 'string' ? params.userAddress.trim() : '';
  if (!EVM_ADDRESS_RE.test(userAddress) || userAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error('userAddress must be a valid non-zero EVM address.');
  }

  const requestedUsd =
    typeof params.amountUsd === 'number' && Number.isFinite(params.amountUsd)
      ? params.amountUsd
      : 1.0;
  const amountUsd = Math.min(25, Math.max(0.25, round2(requestedUsd)));

  const livePrices = params.nativePrices ?? FALLBACK_PRICES;
  const fromPriceUsd =
    livePrices[fromCfg.nativeSymbol] || getFallbackNativePriceUsd(fromCfg.nativeSymbol);
  const amountInUi = round6(amountUsd / Math.max(0.01, fromPriceUsd));
  const amountInWei = BigInt(Math.max(1, Math.floor(amountInUi * 1e18)));

  const fetcher = params.fetcher ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = params.timeoutMs ?? 6_500;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetcher('https://api.relay.link/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        user: userAddress,
        originChainId: fromCfg.chainId,
        destinationChainId: toCfg.chainId,
        originCurrency: ZERO_ADDRESS,
        destinationCurrency: ZERO_ADDRESS,
        recipient: userAddress,
        amount: amountInWei.toString(),
        tradeType: 'EXACT_INPUT',
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new Error(
      `Gas refuel quote request failed: ${err instanceof Error ? err.message : 'network error'}`
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Relay gas refuel quote unavailable (${res.status})${errText ? `: ${errText.slice(0, 140)}` : ''}`
    );
  }

  const json = (await res.json()) as {
    requestId?: string;
    details?: {
      timeEstimate?: number;
      currencyOut?: {
        amountFormatted?: string;
        amountUsd?: string;
        currency?: { symbol?: string };
      };
    };
    steps?: Array<{
      id?: string;
      kind?: string;
      requestId?: string;
      items?: Array<{
        data?: {
          from?: string;
          to?: string;
          data?: string;
          value?: string;
          gas?: string;
          chainId?: number;
        };
      }>;
    }>;
  };

  let txData:
    | { from?: string; to?: string; data?: string; value?: string; gas?: string; chainId?: number }
    | undefined;
  let stepRequestId = json.requestId;

  for (const step of json.steps ?? []) {
    if (step.kind !== 'transaction') continue;
    const item = step.items?.[0];
    if (item?.data?.to) {
      txData = item.data;
      if (!stepRequestId && step.requestId) stepRequestId = step.requestId;
      break;
    }
  }

  if (!txData?.to) {
    throw new Error(`Relay returned no executable gas refuel transaction (${fromCfg.name} -> ${toCfg.name}).`);
  }

  const targetCheck = validateRouterCallTarget({
    to: txData.to,
    data: txData.data ?? '0x',
    userAddress,
    tokenAddresses: [],
    requireCalldata: false,
  });
  if (!targetCheck.valid) {
    throw new Error(`Gas refuel security validation failed: ${targetCheck.reason}`);
  }

  const outFormatted =
    json.details?.currencyOut?.amountFormatted && json.details.currencyOut.currency?.symbol
      ? `${Number(json.details.currencyOut.amountFormatted).toFixed(4)} ${json.details.currencyOut.currency.symbol}`
      : `~$${amountUsd.toFixed(2)} ${toCfg.nativeSymbol}`;
  const outUsd = Number(json.details?.currencyOut?.amountUsd ?? amountUsd);

  return {
    provider: 'relay',
    requestId: stepRequestId,
    fromChain: params.fromChain,
    fromChainId: fromCfg.chainId,
    fromChainName: fromCfg.name,
    fromNativeSymbol: fromCfg.nativeSymbol,
    toChain: params.toChain,
    toChainId: toCfg.chainId,
    toChainName: toCfg.name,
    toNativeSymbol: toCfg.nativeSymbol,
    amountInWei: amountInWei.toString(),
    amountInUi,
    amountInUsd: amountUsd,
    estimatedOutFormatted: outFormatted,
    estimatedOutUsd: round2(Number.isFinite(outUsd) ? outUsd : amountUsd),
    estimatedSeconds: Math.max(2, Math.round(json.details?.timeEstimate ?? 6)),
    transaction: {
      chain: params.fromChain,
      chainId: fromCfg.chainId,
      chainName: fromCfg.name,
      explorerUrl: fromCfg.explorerUrl,
      from: userAddress,
      to: txData.to.trim(),
      data: (txData.data ?? '0x').trim() || '0x',
      value: toHexWei(txData.value ?? amountInWei),
      gas: txData.gas ? toHexWei(txData.gas) : undefined,
      label: `Refuel ${toCfg.name} gas (${outFormatted}) from ${fromCfg.name}`,
    },
  };
}
