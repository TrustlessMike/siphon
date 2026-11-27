import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { EVM_CHAINS } from '../scanner/chains.js';
import type { EvmChainId } from '../scanner/types.js';
import { evmJsonRpcCall, formatUnits } from '../scanner/rpc.js';
import { FALLBACK_PRICES, fetchLiveUsdPrices } from '../scanner/prices.js';
import { fetchLatestSolanaBlockhash } from '../bridge/solana-claim.js';
import { validateRouterCallTarget, type RouteAuctionFetcher } from './route-auction.js';

function getFallbackNativePriceUsd(llamaId: string, symbol: string): number {
  const byLlama = FALLBACK_PRICES[llamaId];
  if (typeof byLlama === 'number' && Number.isFinite(byLlama) && byLlama > 0) return byLlama;
  const bySym = FALLBACK_PRICES[symbol] ?? FALLBACK_PRICES[symbol.toUpperCase()];
  if (typeof bySym === 'number' && Number.isFinite(bySym) && bySym > 0) return bySym;
  if (symbol.toUpperCase() === 'ETH') return FALLBACK_PRICES['coingecko:ethereum'] ?? 2000;
  return 1;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const RELAY_SOLANA_CHAIN_ID = 792703809;
const SOLANA_NATIVE_MINT = '11111111111111111111111111111111';
const ALLOWED_RELAY_SOLANA_GAS_PROGRAMS = new Set([
  '11111111111111111111111111111111', // System Program
  'ComputeBudget111111111111111111111111111111', // Compute Budget
  '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2', // Relay Solana Depository
]);

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

export type GasRefuelSourceChain = EvmChainId | 'solana';

export interface GasRefuelQuoteRequest {
  fromChain: GasRefuelSourceChain;
  toChain: EvmChainId;
  /** Source wallet paying gas (0x EVM address for EVM source chains; Solana Base58 pubkey when fromChain === 'solana') */
  userAddress: string;
  /** Optional destination EVM wallet receiving refueled native gas (defaults to userAddress for EVM->EVM; required when fromChain === 'solana') */
  recipientAddress?: string;
  amountUsd?: number;
  timeoutMs?: number;
  fetcher?: RouteAuctionFetcher;
  nativePrices?: Record<string, number>;
  solanaBlockhashFn?: () => Promise<string | null>;
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

export interface GasRefuelSolanaTransaction {
  chain: 'solana';
  chainId: number;
  chainName: 'Solana';
  feePayer: string;
  serializedTransactionBase64: string;
  allowedProgramIds: string[];
  label: string;
}

export interface GasRefuelQuoteResult {
  provider: 'relay';
  requestId?: string;
  fromChain: GasRefuelSourceChain;
  fromChainId: number;
  fromChainName: string;
  fromNativeSymbol: string;
  toChain: EvmChainId;
  toChainId: number;
  toChainName: string;
  toNativeSymbol: string;
  recipientAddress: string;
  amountInWei: string;
  amountInUi: number;
  amountInUsd: number;
  estimatedOutFormatted: string;
  estimatedOutUsd: number;
  estimatedSeconds: number;
  transaction?: GasRefuelTransaction;
  solanaTransaction?: GasRefuelSolanaTransaction;
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
      : getFallbackNativePriceUsd(cfg.nativeLlamaId, cfg.nativeSymbol);

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
 * Builds a 1-click Relay cross-chain native gas drop from ANY funded EVM chain OR connected Solana wallet
 * (e.g. $0.75 ETH on Base -> MON on Monad, or 0.01 SOL on Solana -> ETH on Base/Arbitrum/Monad)
 * supporting cross-wallet refueling (`recipientAddress`) so users with $0.00 gas on a target chain
 * can automatically unify gas in 1–4 seconds without leaving Turgalium.
 */
export async function buildGasRefuelQuote(
  params: GasRefuelQuoteRequest
): Promise<GasRefuelQuoteResult> {
  const isSolanaSource = params.fromChain === 'solana';
  const fromCfg =
    params.fromChain === 'solana'
      ? null
      : Object.hasOwn(EVM_CHAINS, params.fromChain)
      ? EVM_CHAINS[params.fromChain]
      : null;
  const toCfg = Object.hasOwn(EVM_CHAINS, params.toChain) ? EVM_CHAINS[params.toChain] : null;
  if (!isSolanaSource && !fromCfg) {
    throw new Error(`Unsupported source chain for gas refuel: ${String(params.fromChain)}`);
  }
  if (!toCfg) {
    throw new Error(`Unsupported destination chain for gas refuel: ${String(params.toChain)}`);
  }
  if (!isSolanaSource && params.fromChain === params.toChain) {
    throw new Error('Source and destination chains for gas refuel must be different.');
  }

  const userAddress = typeof params.userAddress === 'string' ? params.userAddress.trim() : '';
  let recipientAddress =
    typeof params.recipientAddress === 'string' && params.recipientAddress.trim()
      ? params.recipientAddress.trim()
      : '';

  if (isSolanaSource) {
    try {
      new PublicKey(userAddress);
    } catch {
      throw new Error('userAddress must be a valid Solana Base58 pubkey when fromChain is solana.');
    }
    if (!EVM_ADDRESS_RE.test(recipientAddress) || recipientAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new Error('recipientAddress must be a valid non-zero EVM address when refueling from Solana.');
    }
  } else {
    if (!EVM_ADDRESS_RE.test(userAddress) || userAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new Error('userAddress must be a valid non-zero EVM address.');
    }
    if (!recipientAddress) {
      recipientAddress = userAddress;
    } else if (!EVM_ADDRESS_RE.test(recipientAddress) || recipientAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new Error('recipientAddress must be a valid non-zero EVM address.');
    }
  }

  const requestedUsd =
    typeof params.amountUsd === 'number' && Number.isFinite(params.amountUsd)
      ? params.amountUsd
      : 1.0;
  const amountUsd = Math.min(25, Math.max(0.25, round2(requestedUsd)));

  const fromLlamaId = isSolanaSource ? 'coingecko:solana' : fromCfg!.nativeLlamaId;
  const fromSymbol = isSolanaSource ? 'SOL' : fromCfg!.nativeSymbol;
  const fromChainName = isSolanaSource ? 'Solana' : fromCfg!.name;
  const fromChainId = isSolanaSource ? RELAY_SOLANA_CHAIN_ID : fromCfg!.chainId;
  const fromDecimals = isSolanaSource ? 9 : 18;

  const livePriceMap = params.nativePrices
    ? null
    : await fetchLiveUsdPrices([fromLlamaId, toCfg.nativeLlamaId]).catch(() => null);
  const fromPriceUsd =
    params.nativePrices?.[fromLlamaId] ||
    params.nativePrices?.[fromSymbol] ||
    livePriceMap?.get(fromLlamaId) ||
    getFallbackNativePriceUsd(fromLlamaId, fromSymbol);
  if (!Number.isFinite(fromPriceUsd) || fromPriceUsd <= 0) {
    throw new Error(`Unable to price ${fromSymbol} safely for gas refuel.`);
  }
  const amountInUi = round6(amountUsd / fromPriceUsd);
  const amountInUnits = BigInt(Math.max(1, Math.floor(amountInUi * 10 ** fromDecimals)));

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
        originChainId: fromChainId,
        destinationChainId: toCfg.chainId,
        originCurrency: isSolanaSource ? SOLANA_NATIVE_MINT : ZERO_ADDRESS,
        destinationCurrency: ZERO_ADDRESS,
        recipient: recipientAddress,
        amount: amountInUnits.toString(),
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
          instructions?: Array<{
            programId: string;
            keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
            data: string;
          }>;
        };
      }>;
    }>;
  };

  const outFormatted =
    json.details?.currencyOut?.amountFormatted && json.details.currencyOut.currency?.symbol
      ? `${Number(json.details.currencyOut.amountFormatted).toFixed(4)} ${json.details.currencyOut.currency.symbol}`
      : `~$${amountUsd.toFixed(2)} ${toCfg.nativeSymbol}`;
  const outUsd = Number(json.details?.currencyOut?.amountUsd ?? amountUsd);
  if (Number.isFinite(outUsd) && outUsd > Math.max(amountUsd * 3, amountUsd + 5)) {
    throw new Error(
      `Gas refuel safety cap tripped: quoted $${outUsd.toFixed(2)} exceeds requested $${amountUsd.toFixed(2)}.`
    );
  }

  let stepRequestId = json.requestId;

  if (isSolanaSource) {
    let rawInstructions:
      | Array<{
          programId: string;
          keys: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
          data: string;
        }>
      | undefined;

    for (const step of json.steps ?? []) {
      if (step.kind !== 'transaction') continue;
      const item = step.items?.[0];
      if (Array.isArray(item?.data?.instructions) && item.data.instructions.length > 0) {
        rawInstructions = item.data.instructions;
        if (!stepRequestId && step.requestId) stepRequestId = step.requestId;
        break;
      }
    }

    if (!rawInstructions || rawInstructions.length === 0) {
      throw new Error(`Relay returned no executable Solana gas refuel instructions (Solana -> ${toCfg.name}).`);
    }

    const compiledIxs: TransactionInstruction[] = [];
    const seenPrograms = new Set<string>();
    const RELAY_DEPOSITORY_SOLANA = '99vQwtBwYtrqqD9YSXbdum3KBdxPAVxYTaQ3cfnJSrN2';
    for (const ix of rawInstructions) {
      const progId = String(ix.programId || '').trim();
      if (!ALLOWED_RELAY_SOLANA_GAS_PROGRAMS.has(progId)) {
        throw new Error(`Gas refuel security validation failed: unexpected Solana program ${progId}.`);
      }
      seenPrograms.add(progId);
      const dataHex = String(ix.data || '').replace(/^0x/i, '');
      if (dataHex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(dataHex)) {
        throw new Error('Gas refuel security validation failed: malformed hex instruction data.');
      }
      const dataBuf = dataHex.length > 0 ? Buffer.from(dataHex, 'hex') : Buffer.alloc(0);
      compiledIxs.push(
        new TransactionInstruction({
          programId: new PublicKey(progId),
          keys: (ix.keys ?? []).map((k) => ({
            pubkey: new PublicKey(k.pubkey),
            isSigner: Boolean(k.isSigner),
            isWritable: Boolean(k.isWritable),
          })),
          data: dataBuf,
        })
      );
    }
    if (!seenPrograms.has(RELAY_DEPOSITORY_SOLANA)) {
      throw new Error(
        'Gas refuel security validation failed: Solana refuel transaction must invoke Relay depository.'
      );
    }

    const blockhashFn = params.solanaBlockhashFn ?? fetchLatestSolanaBlockhash;
    const recentBlockhash = await blockhashFn();
    if (!recentBlockhash) {
      throw new Error('Could not fetch latest Solana blockhash to build SOL gas refuel transaction.');
    }
    const feePayerKey = new PublicKey(userAddress);
    const msgV0 = new TransactionMessage({
      payerKey: feePayerKey,
      recentBlockhash,
      instructions: compiledIxs,
    }).compileToV0Message();
    const versionedTx = new VersionedTransaction(msgV0);
    const serializedTransactionBase64 = Buffer.from(versionedTx.serialize()).toString('base64');

    return {
      provider: 'relay',
      requestId: stepRequestId,
      fromChain: 'solana',
      fromChainId: RELAY_SOLANA_CHAIN_ID,
      fromChainName: 'Solana',
      fromNativeSymbol: 'SOL',
      toChain: params.toChain,
      toChainId: toCfg.chainId,
      toChainName: toCfg.name,
      toNativeSymbol: toCfg.nativeSymbol,
      recipientAddress,
      amountInWei: amountInUnits.toString(),
      amountInUi,
      amountInUsd: amountUsd,
      estimatedOutFormatted: outFormatted,
      estimatedOutUsd: round2(Number.isFinite(outUsd) ? outUsd : amountUsd),
      estimatedSeconds: Math.max(2, Math.round(json.details?.timeEstimate ?? 4)),
      solanaTransaction: {
        chain: 'solana',
        chainId: RELAY_SOLANA_CHAIN_ID,
        chainName: 'Solana',
        feePayer: userAddress,
        serializedTransactionBase64,
        allowedProgramIds: Array.from(seenPrograms),
        label: `Refuel ${toCfg.name} gas (${outFormatted}) from Solana`,
      },
    };
  }

  let txData:
    | { from?: string; to?: string; data?: string; value?: string; gas?: string; chainId?: number }
    | undefined;

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
    throw new Error(`Relay returned no executable gas refuel transaction (${fromChainName} -> ${toCfg.name}).`);
  }
  if (txData.chainId !== undefined && Number(txData.chainId) !== fromChainId) {
    throw new Error(
      `Gas refuel security validation failed: tx chainId (${txData.chainId}) !== expected source chainId (${fromChainId}).`
    );
  }
  const txValueWei = txData.value !== undefined ? parseHexOrDecWei(String(txData.value)) : amountInUnits;
  const maxAllowedValueWei = amountInUnits * 2n + 1_000_000_000_000_000n;
  if (txValueWei > maxAllowedValueWei) {
    throw new Error(
      `Gas refuel safety cap tripped: tx msg.value (${txValueWei.toString()}) exceeds requested input budget.`
    );
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

  return {
    provider: 'relay',
    requestId: stepRequestId,
    fromChain: params.fromChain,
    fromChainId,
    fromChainName,
    fromNativeSymbol: fromSymbol,
    toChain: params.toChain,
    toChainId: toCfg.chainId,
    toChainName: toCfg.name,
    toNativeSymbol: toCfg.nativeSymbol,
    recipientAddress,
    amountInWei: amountInUnits.toString(),
    amountInUi,
    amountInUsd: amountUsd,
    estimatedOutFormatted: outFormatted,
    estimatedOutUsd: round2(Number.isFinite(outUsd) ? outUsd : amountUsd),
    estimatedSeconds: Math.max(2, Math.round(json.details?.timeEstimate ?? 6)),
    transaction: {
      chain: params.fromChain as EvmChainId,
      chainId: fromChainId,
      chainName: fromChainName,
      explorerUrl: fromCfg!.explorerUrl,
      from: userAddress,
      to: txData.to.trim(),
      data: (txData.data ?? '0x').trim() || '0x',
      value: toHexWei(txData.value ?? amountInUnits),
      gas: txData.gas ? toHexWei(txData.gas) : undefined,
      label: `Refuel ${toCfg.name} gas (${outFormatted}) from ${fromChainName}`,
    },
  };
}
