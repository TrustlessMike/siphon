import {
  AddressLookupTableAccount,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  SOLANA_TOKEN_PROGRAM_ID,
  solanaAddressToBytes32,
} from '../bridge/cctp.js';
import {
  DEFAULT_FALLBACK_SOL_PRICE_USD,
  SOLANA_EMPTY_ATA_RENT_LAMPORTS,
  SOLANA_EMPTY_ATA_RENT_SOL,
  SOLANA_MAX_PACKET_BYTES,
} from '../bridge/solana-rent.js';
import { redactRpcUrl } from '../scanner/rpc.js';
import {
  JUPITER_SWAP_LITE_BASE,
  JUPITER_SWAP_PRO_BASE,
  MAX_JUPITER_PRICE_IMPACT_PCT,
  MAX_SLIPPAGE_BPS,
  SOLANA_JUPITER_LEND_JLUSDC_MINT,
  SOLANA_JUPSOL_MINT,
  SOLANA_USDC_MINT,
  SOLANA_WSOL_MINT,
} from './yield-park.js';

export const SOLANA_SPL_DUST_SCAN_VERSION = 'turgalium-solana-spl-dust-scan-v1';
export const SOLANA_SPL_DUST_SWEEP_VERSION = 'turgalium-solana-spl-dust-sweep-v1';

export const JUPITER_PRICE_LITE_URL = 'https://lite-api.jup.ag/price/v2';
export const JUPITER_PRICE_PRO_URL = 'https://api.jup.ag/price/v2';

export const DEFAULT_MAX_DUST_USD = 50;
export const MIN_MAX_DUST_USD = 0.01;
export const MAX_MAX_DUST_USD = 5_000;
export const DEFAULT_DUST_SLIPPAGE_BPS = 100;
export const MAX_DUST_SWEEP_TOKENS = 10;
export const MAX_ALLOWED_DUST_SWEEP_TOKENS = 20;
export const DEFAULT_SPL_DUST_TIMEOUT_MS = 4_500;

// SPL Token CloseAccount instruction discriminator = 9
const SPL_CLOSE_ACCOUNT_INSTRUCTION_INDEX = 9;
const SPL_TOKEN_PROGRAM_BASE58 = SOLANA_TOKEN_PROGRAM_ID.toBase58();

const DEFAULT_SOLANA_RPC_URLS = [
  process.env.SOLANA_RPC_URL?.trim(),
  'https://api.mainnet-beta.solana.com',
  'https://solana.publicnode.com',
].filter((u): u is string => Boolean(u));

/**
 * Core Solana base / yield / stablecoin mints that must NEVER be treated as sweepable dust.
 */
export const PROTECTED_SOLANA_MINTS: ReadonlySet<string> = new Set<string>([
  SOLANA_WSOL_MINT,
  SOLANA_USDC_MINT,
  SOLANA_JUPSOL_MINT,
  SOLANA_JUPITER_LEND_JLUSDC_MINT,
]);

export type SolanaDustTargetAsset = 'usdc' | 'sol';

export interface DustSweepTargetMeta {
  id: SolanaDustTargetAsset;
  symbol: 'USDC' | 'SOL';
  mint: string;
  decimals: number;
}

export const DUST_SWEEP_TARGETS: Readonly<Record<SolanaDustTargetAsset, DustSweepTargetMeta>> =
  Object.freeze({
    usdc: Object.freeze({
      id: 'usdc' as const,
      symbol: 'USDC' as const,
      mint: SOLANA_USDC_MINT,
      decimals: 6,
    }),
    sol: Object.freeze({
      id: 'sol' as const,
      symbol: 'SOL' as const,
      mint: SOLANA_WSOL_MINT,
      decimals: 9,
    }),
  });

export interface SolanaSplDustAccount {
  tokenAccount: string;
  mint: string;
  owner: string;
  programId: string;
  amount: string;
  uiAmount: number;
  decimals: number;
  symbol: string;
  state: 'initialized';
  frozen: false;
  closeable: true;
  closeAuthority: string | null;
  priceUsd: number | null;
  priceSource: 'explicit' | 'jupiter' | 'defillama' | 'unpriced';
  usdValue: number | null;
  rentLamports: number;
  rentSol: number;
  rentUsd: number;
  netEstimatedUsd: number;
}

export interface ScanSolanaSplDustOptions {
  maxDustUsd?: number;
  minDustUsd?: number;
  includeUnpriced?: boolean;
  rpcUrls?: string[];
  timeoutMs?: number;
  solPriceUsd?: number;
  priceMapUsd?: Record<string, number>;
  skipPriceFetch?: boolean;
  jupiterApiKey?: string;
}

export interface SolanaSplDustScanResult {
  scanVersion: typeof SOLANA_SPL_DUST_SCAN_VERSION;
  ownerAddress: string;
  programId: string;
  maxDustUsd: number;
  minDustUsd: number;
  totalTokenAccountsScanned: number;
  dustCount: number;
  skippedProtectedCount: number;
  skippedZeroBalanceCount: number;
  skippedFrozenCount: number;
  skippedUncloseableCount: number;
  skippedAboveMaxUsdCount: number;
  skippedBelowMinUsdCount: number;
  totalDustUsd: number;
  reclaimableRentLamports: number;
  reclaimableRentSol: number;
  reclaimableRentUsd: number;
  totalEstimatedRecoveryUsd: number;
  solPriceUsd: number;
  solPriceSource: 'explicit' | 'live' | 'fallback';
  dustAccounts: SolanaSplDustAccount[];
}

export interface DustSweepTokenInput {
  tokenAccount: string;
  mint: string;
  amount: string;
  decimals?: number;
  uiAmount?: number;
  symbol?: string;
  usdValue?: number | null;
  rentLamports?: number;
}

export interface BuildSolanaSplDustSweepParams {
  ownerAddress: string;
  targetAsset?: SolanaDustTargetAsset;
  tokens?: DustSweepTokenInput[];
  maxDustUsd?: number;
  minDustUsd?: number;
  includeUnpriced?: boolean;
  slippageBps?: number;
  closeAccounts?: boolean;
  buildTransactions?: boolean;
  priorityFeeMicroLamports?: number;
  maxTokens?: number;
  rpcUrls?: string[];
  solPriceUsd?: number;
  priceMapUsd?: Record<string, number>;
  skipPriceFetch?: boolean;
  jupiterApiKey?: string;
  timeoutMs?: number;
}

export interface DustSwapQuoteSummary {
  apiBaseUrl: string;
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  otherAmountThresholdRaw: string;
  estimatedOutputUi: number;
  minOutputUi: number;
  estimatedOutputUsd: number;
  slippageBps: number;
  priceImpactPct: number;
  routeLabels: string[];
}

export interface DustSweepTransactionPayload {
  version: 0;
  feePayer: string;
  lastValidBlockHeight: number | null;
  prioritizationFeeLamports: number | null;
  serializedByteLength: number;
  atomicCloseAppended: boolean;
  swapTransactionBase64: string;
}

export interface SolanaSplDustSweepItem {
  tokenAccount: string;
  mint: string;
  symbol: string;
  amount: string;
  decimals: number;
  uiAmount: number;
  targetAsset: SolanaDustTargetAsset;
  targetMint: string;
  targetSymbol: 'USDC' | 'SOL';
  quote: DustSwapQuoteSummary;
  rentReclaim: {
    enabled: boolean;
    atomicCloseAppended: boolean;
    rentLamports: number;
    rentSol: number;
    rentUsd: number;
    destination: string;
    authority: string;
  };
  transaction: DustSweepTransactionPayload | null;
  warnings: string[];
}

export interface SolanaSplDustSkippedItem {
  tokenAccount: string;
  mint: string;
  symbol: string;
  reason: string;
}

export interface SolanaSplDustSweepPlan {
  planVersion: typeof SOLANA_SPL_DUST_SWEEP_VERSION;
  ownerAddress: string;
  targetAsset: SolanaDustTargetAsset;
  targetMint: string;
  targetSymbol: 'USDC' | 'SOL';
  maxDustUsd: number;
  slippageBps: number;
  closeAccountsRequested: boolean;
  sweptCount: number;
  skippedCount: number;
  estimatedTotalOutputUi: number;
  estimatedTotalOutputUsd: number;
  totalReclaimableRentLamports: number;
  totalReclaimableRentSol: number;
  totalReclaimableRentUsd: number;
  totalEstimatedRecoveryUsd: number;
  solPriceUsd: number;
  items: SolanaSplDustSweepItem[];
  skipped: SolanaSplDustSkippedItem[];
  warnings: string[];
}

interface RawParsedTokenAccountEntry {
  pubkey?: string;
  account?: {
    lamports?: number;
    owner?: string;
    data?: {
      program?: string;
      parsed?: {
        type?: string;
        info?: {
          mint?: string;
          owner?: string;
          state?: string;
          closeAuthority?: string | null;
          isNative?: boolean;
          tokenAmount?: {
            amount?: string;
            decimals?: number;
            uiAmount?: number | null;
            uiAmountString?: string;
          };
        };
      };
    };
  };
}

class UpstreamTamperingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamTamperingError';
  }
}

class UpstreamTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamTransportError';
  }
}

function round8(val: number): number {
  return Number(val.toFixed(8));
}

function round6(val: number): number {
  return Number(val.toFixed(6));
}

function round2(val: number): number {
  return Number(val.toFixed(2));
}

function shortMintLabel(mint: string): string {
  const s = mint.trim();
  if (s.length <= 10) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

export function isProtectedSolanaMint(mint: string): boolean {
  return typeof mint === 'string' && PROTECTED_SOLANA_MINTS.has(mint.trim());
}

function validateSolanaPubkey(addr: string, label: string): PublicKey {
  const clean = typeof addr === 'string' ? addr.trim() : '';
  if (!clean) {
    throw new Error(`${label} is required.`);
  }
  try {
    solanaAddressToBytes32(clean);
    return new PublicKey(clean);
  } catch (err) {
    throw new Error(
      `Invalid Solana ${label}: ${err instanceof Error ? err.message : 'expected valid base58 public key'}.`
    );
  }
}

function validateDustUsdBounds(maxDustUsd?: number, minDustUsd?: number): {
  maxDustUsd: number;
  minDustUsd: number;
} {
  const maxVal = maxDustUsd ?? DEFAULT_MAX_DUST_USD;
  if (
    typeof maxVal !== 'number' ||
    !Number.isFinite(maxVal) ||
    maxVal < MIN_MAX_DUST_USD ||
    maxVal > MAX_MAX_DUST_USD
  ) {
    throw new Error(
      `maxDustUsd must be a finite number between ${MIN_MAX_DUST_USD} and ${MAX_MAX_DUST_USD}.`
    );
  }
  const minVal = minDustUsd ?? 0;
  if (
    typeof minVal !== 'number' ||
    !Number.isFinite(minVal) ||
    minVal < 0 ||
    minVal > maxVal
  ) {
    throw new Error(`minDustUsd must be a finite number between 0 and maxDustUsd (${maxVal}).`);
  }
  return { maxDustUsd: round2(maxVal), minDustUsd: round2(minVal) };
}

function sanitizeExplicitPriceMap(raw?: Record<string, number>): Map<string, number> {
  const map = new Map<string, number>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map;
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(raw, key)) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const val = raw[key];
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      map.set(key.trim(), val);
    }
  }
  return map;
}

function getJupiterSwapEndpoint(explicitApiKey?: string): {
  baseUrl: string;
  priceUrl: string;
  headers: Record<string, string>;
} {
  const apiKey = (explicitApiKey ?? process.env.JUPITER_API_KEY)?.trim();
  if (apiKey) {
    return {
      baseUrl: JUPITER_SWAP_PRO_BASE,
      priceUrl: JUPITER_PRICE_PRO_URL,
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
    };
  }
  return {
    baseUrl: JUPITER_SWAP_LITE_BASE,
    priceUrl: JUPITER_PRICE_LITE_URL,
    headers: {
      Accept: 'application/json',
    },
  };
}

async function fetchJsonWithTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<{ ok: boolean; status: number; data: T | null; errorText?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      let errorText = `HTTP ${res.status}`;
      try {
        const body = await res.text();
        if (body) errorText = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      } catch {
        // ignore
      }
      return { ok: false, status: res.status, data: null, errorText };
    }
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      status: 0,
      data: null,
      errorText: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchSolanaRpc<T>(
  method: string,
  params: unknown[],
  rpcUrls: string[],
  timeoutMs: number
): Promise<T> {
  let lastError: Error | null = null;
  for (const rpcUrl of rpcUrls) {
    const safeUrl = redactRpcUrl(rpcUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastError = new Error(`Solana RPC HTTP ${res.status} from ${safeUrl}`);
        continue;
      }
      const json = (await res.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };
      if (json.error) {
        const msg = json.error.message
          ? json.error.message.split(rpcUrl).join(safeUrl)
          : `Solana RPC error ${json.error.code ?? ''}`;
        lastError = new Error(msg);
        continue;
      }
      if (json.result !== undefined) {
        return json.result;
      }
      lastError = new Error(`Solana RPC returned empty result for ${method}`);
    } catch (err) {
      clearTimeout(timer);
      const rawMsg = err instanceof Error ? err.message : String(err);
      lastError = new Error(rawMsg.split(rpcUrl).join(safeUrl));
    }
  }
  throw lastError ?? new Error(`All Solana RPC endpoints failed for ${method}.`);
}

async function fetchSplPricesUsd(
  mints: string[],
  opts: { timeoutMs: number; jupiterApiKey?: string }
): Promise<{
  prices: Map<string, { priceUsd: number; source: 'jupiter' | 'defillama'; symbol?: string }>;
  solPriceUsd: number | null;
}> {
  const prices = new Map<
    string,
    { priceUsd: number; source: 'jupiter' | 'defillama'; symbol?: string }
  >();
  const uniqueMints = Array.from(new Set(mints.filter(Boolean)));
  const queryMints = Array.from(new Set([SOLANA_WSOL_MINT, ...uniqueMints]));

  const { priceUrl, headers } = getJupiterSwapEndpoint(opts.jupiterApiKey);
  const priceTimeout = Math.min(opts.timeoutMs, 3_000);

  // 1. Primary: Jupiter Price API v2 (batched in chunks of 50 in parallel)
  const jupChunks: string[][] = [];
  for (let i = 0; i < queryMints.length; i += 50) {
    jupChunks.push(queryMints.slice(i, i + 50));
  }
  await Promise.all(
    jupChunks.map(async (chunk) => {
      const url = `${priceUrl}?ids=${encodeURIComponent(chunk.join(','))}`;
      const res = await fetchJsonWithTimeout<{
        data?: Record<string, { price?: string | number; mintSymbol?: string } | null>;
      }>(url, { method: 'GET', headers }, priceTimeout);
      if (res.ok && res.data?.data && typeof res.data.data === 'object') {
        const dataObj = res.data.data;
        for (const mint of chunk) {
          if (!Object.hasOwn(dataObj, mint)) continue;
          const entry = dataObj[mint];
          const p = Number(entry?.price ?? NaN);
          if (Number.isFinite(p) && p > 0) {
            const sym =
              typeof entry?.mintSymbol === 'string' && entry.mintSymbol.trim()
                ? entry.mintSymbol.trim().slice(0, 16)
                : undefined;
            prices.set(mint, { priceUsd: p, source: 'jupiter', symbol: sym });
          }
        }
      }
    })
  );

  // 2. Fallback: DeFiLlama coins API for any missing mints + SOL (parallel chunks of 40)
  const missing = queryMints.filter((m) => !prices.has(m));
  if (missing.length > 0) {
    const llamaKeys = missing.map((m) =>
      m === SOLANA_WSOL_MINT ? 'coingecko:solana' : `solana:${m}`
    );
    const llamaChunks: Array<{ keys: string[]; mints: string[] }> = [];
    for (let i = 0; i < llamaKeys.length; i += 40) {
      llamaChunks.push({
        keys: llamaKeys.slice(i, i + 40),
        mints: missing.slice(i, i + 40),
      });
    }
    await Promise.all(
      llamaChunks.map(async ({ keys: chunkKeys, mints: chunkMints }) => {
        const url = `https://coins.llama.fi/prices/current/${chunkKeys.map(encodeURIComponent).join(',')}`;
        const res = await fetchJsonWithTimeout<{
          coins?: Record<string, { price?: number; symbol?: string }>;
        }>(url, { method: 'GET', headers: { Accept: 'application/json' } }, priceTimeout);
        if (res.ok && res.data?.coins && typeof res.data.coins === 'object') {
          const coinsObj = res.data.coins;
          for (let j = 0; j < chunkKeys.length; j += 1) {
            const k = chunkKeys[j];
            const mint = chunkMints[j];
            if (!Object.hasOwn(coinsObj, k)) continue;
            const entry = coinsObj[k];
            const p = Number(entry?.price ?? NaN);
            if (Number.isFinite(p) && p > 0) {
              const sym =
                typeof entry?.symbol === 'string' && entry.symbol.trim()
                  ? entry.symbol.trim().slice(0, 16)
                  : undefined;
              prices.set(mint, { priceUsd: p, source: 'defillama', symbol: sym });
            }
          }
        }
      })
    );
  }

  const solEntry = prices.get(SOLANA_WSOL_MINT);
  return {
    prices,
    solPriceUsd: solEntry ? solEntry.priceUsd : null,
  };
}

/**
 * Builds a single verified SPL Token `CloseAccount` instruction where BOTH
 * `destination` and `authority` are locked strictly to `ownerAddress`.
 * Reclaims ~0.00203928 SOL rent atomically right after the ATA balance is drained to 0.
 */
export function buildAtomicSplCloseInstruction(
  ownerAddress: string,
  tokenAccountAddress: string
): TransactionInstruction {
  const ownerPubkey = validateSolanaPubkey(ownerAddress, 'ownerAddress');
  const tokenAccountPubkey = validateSolanaPubkey(tokenAccountAddress, 'tokenAccount');

  if (tokenAccountPubkey.equals(ownerPubkey)) {
    throw new Error(
      `Refusing to close owner wallet address ${ownerPubkey.toBase58()} as a token account.`
    );
  }

  return new TransactionInstruction({
    programId: SOLANA_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: tokenAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: ownerPubkey, isSigner: false, isWritable: true },
      { pubkey: ownerPubkey, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([SPL_CLOSE_ACCOUNT_INSTRUCTION_INDEX]),
  });
}

async function resolveAddressLookupTables(
  lookupAddresses: PublicKey[],
  rpcUrls: string[],
  timeoutMs: number
): Promise<AddressLookupTableAccount[] | null> {
  if (lookupAddresses.length === 0) return [];
  try {
    const result = await fetchSolanaRpc<{
      value?: Array<{ data?: [string, string] | string } | null>;
    }>(
      'getMultipleAccounts',
      [lookupAddresses.map((k) => k.toBase58()), { encoding: 'base64' }],
      rpcUrls,
      timeoutMs
    );
    const values = result?.value;
    if (!Array.isArray(values) || values.length !== lookupAddresses.length) return null;
    const alts: AddressLookupTableAccount[] = [];
    for (let i = 0; i < lookupAddresses.length; i += 1) {
      const acc = values[i];
      const rawData = Array.isArray(acc?.data) ? acc.data[0] : null;
      if (typeof rawData !== 'string' || !rawData) return null;
      const state = AddressLookupTableAccount.deserialize(Buffer.from(rawData, 'base64'));
      alts.push(new AddressLookupTableAccount({ key: lookupAddresses[i], state }));
    }
    return alts;
  } catch {
    return null;
  }
}

function hasExistingCloseAccountIx(
  msg: MessageV0,
  tokenAccountBase58: string,
  ownerBase58: string
): boolean {
  const staticKeys = msg.staticAccountKeys.map((k) => k.toBase58());
  for (const ix of msg.compiledInstructions) {
    const progId = staticKeys[ix.programIdIndex];
    if (progId !== SPL_TOKEN_PROGRAM_BASE58) continue;
    if (ix.data.length !== 1 || ix.data[0] !== SPL_CLOSE_ACCOUNT_INSTRUCTION_INDEX) continue;
    if (ix.accountKeyIndexes.length < 3) continue;
    const accKey = staticKeys[ix.accountKeyIndexes[0]];
    const destKey = staticKeys[ix.accountKeyIndexes[1]];
    const authKey = staticKeys[ix.accountKeyIndexes[2]];
    if (accKey === tokenAccountBase58 && destKey === ownerBase58 && authKey === ownerBase58) {
      return true;
    }
  }
  return false;
}

function isStaticKeyWritable(msg: MessageV0, keyIndex: number): boolean {
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } =
    msg.header;
  const totalStatic = msg.staticAccountKeys.length;
  if (keyIndex < 0 || keyIndex >= totalStatic) return false;
  if (keyIndex < numRequiredSignatures) {
    return keyIndex < numRequiredSignatures - numReadonlySignedAccounts;
  }
  return keyIndex < totalStatic - numReadonlyUnsignedAccounts;
}

/**
 * Verifies a Jupiter-built VersionedTransaction (v0 + feePayer === ownerAddress) and
 * atomically appends an SPL Token `CloseAccount` instruction reclaiming ~0.00203928 SOL
 * rent back to `ownerAddress` in the exact same transaction.
 */
export async function appendAtomicCloseAccountToVersionedTx(
  swapTxBase64: string,
  ownerAddress: string,
  tokenAccountAddress: string,
  opts: {
    addressLookupTableAccounts?: AddressLookupTableAccount[];
    rpcUrls?: string[];
    timeoutMs?: number;
  } = {}
): Promise<{
  swapTransactionBase64: string;
  serializedByteLength: number;
  feePayer: string;
  atomicCloseAppended: boolean;
  warning?: string;
}> {
  const ownerPubkey = validateSolanaPubkey(ownerAddress, 'ownerAddress');
  const tokenAccountPubkey = validateSolanaPubkey(tokenAccountAddress, 'tokenAccount');
  const ownerClean = ownerPubkey.toBase58();
  const tokenAccountClean = tokenAccountPubkey.toBase58();
  if (ownerClean === tokenAccountClean) {
    throw new Error(`Refusing to close owner wallet address ${ownerClean} as a token account.`);
  }

  const cleanB64 = typeof swapTxBase64 === 'string' ? swapTxBase64.trim() : '';
  if (!cleanB64) {
    throw new UpstreamTamperingError('Jupiter Swap returned empty swapTransaction payload.');
  }
  const origBytes = Buffer.from(cleanB64, 'base64');
  let parsedTx: VersionedTransaction;
  try {
    parsedTx = VersionedTransaction.deserialize(origBytes);
  } catch {
    throw new UpstreamTamperingError('Jupiter Swap returned malformed VersionedTransaction bytes.');
  }

  if (parsedTx.version !== 0) {
    throw new UpstreamTamperingError(
      `Expected VersionedTransaction v0 from Jupiter Swap, got version "${String(parsedTx.version)}".`
    );
  }

  const feePayer = parsedTx.message.staticAccountKeys[0]?.toBase58();
  if (!feePayer || feePayer !== ownerClean) {
    throw new UpstreamTamperingError(
      `Jupiter Swap transaction feePayer mismatch: got ${feePayer ?? 'none'}, expected ${ownerClean}.`
    );
  }

  const msg = parsedTx.message as MessageV0;

  // Idempotent: if Jupiter already included CloseAccount for this exact ATA -> owner
  if (hasExistingCloseAccountIx(msg, tokenAccountClean, ownerClean)) {
    return {
      swapTransactionBase64: cleanB64,
      serializedByteLength: origBytes.length,
      feePayer,
      atomicCloseAppended: true,
    };
  }

  const closeIx = buildAtomicSplCloseInstruction(ownerClean, tokenAccountClean);

  // Fast Path 1: No Address Lookup Tables -> clean decompile, append CloseAccount, recompile V0
  if (msg.addressTableLookups.length === 0) {
    const decompiled = TransactionMessage.decompile(msg);
    decompiled.instructions.push(closeIx);
    const recompiledMsg = decompiled.compileToV0Message();
    const updatedTx = new VersionedTransaction(recompiledMsg);
    const updatedFeePayer = updatedTx.message.staticAccountKeys[0]?.toBase58();
    if (updatedFeePayer !== ownerClean) {
      throw new UpstreamTamperingError(
        `Atomic CloseAccount transaction feePayer mismatch: got ${updatedFeePayer ?? 'none'}, expected ${ownerClean}.`
      );
    }
    const updatedBytes = Buffer.from(updatedTx.serialize());
    if (updatedBytes.length > SOLANA_MAX_PACKET_BYTES) {
      return {
        swapTransactionBase64: cleanB64,
        serializedByteLength: origBytes.length,
        feePayer,
        atomicCloseAppended: false,
        warning: `Appending atomic CloseAccount exceeded Solana's ${SOLANA_MAX_PACKET_BYTES}-byte packet limit (${updatedBytes.length} bytes); reclaim 0.00203928 SOL via Rent Vacuum after swap.`,
      };
    }
    return {
      swapTransactionBase64: updatedBytes.toString('base64'),
      serializedByteLength: updatedBytes.length,
      feePayer: updatedFeePayer,
      atomicCloseAppended: true,
    };
  }

  // Fast Path 2: Has ALTs, but owner (idx 0), tokenAccount (writable static), and SPL Token Program
  // are ALREADY present in staticAccountKeys -> append compiled CloseAccount directly without shifting ALT indices!
  const staticKeyStrs = msg.staticAccountKeys.map((k) => k.toBase58());
  const ownerIdx = staticKeyStrs.indexOf(ownerClean);
  const tokenAccIdx = staticKeyStrs.indexOf(tokenAccountClean);
  const tokenProgIdx = staticKeyStrs.indexOf(SPL_TOKEN_PROGRAM_BASE58);
  if (
    ownerIdx === 0 &&
    tokenAccIdx >= 0 &&
    isStaticKeyWritable(msg, tokenAccIdx) &&
    tokenProgIdx >= 0
  ) {
    const appendedMsg = new MessageV0({
      header: msg.header,
      staticAccountKeys: msg.staticAccountKeys,
      recentBlockhash: msg.recentBlockhash,
      compiledInstructions: [
        ...msg.compiledInstructions,
        {
          programIdIndex: tokenProgIdx,
          accountKeyIndexes: [tokenAccIdx, ownerIdx, ownerIdx],
          data: Uint8Array.from([SPL_CLOSE_ACCOUNT_INSTRUCTION_INDEX]),
        },
      ],
      addressTableLookups: msg.addressTableLookups,
    });
    const updatedTx = new VersionedTransaction(appendedMsg);
    const updatedBytes = Buffer.from(updatedTx.serialize());
    if (updatedBytes.length <= SOLANA_MAX_PACKET_BYTES) {
      return {
        swapTransactionBase64: updatedBytes.toString('base64'),
        serializedByteLength: updatedBytes.length,
        feePayer,
        atomicCloseAppended: true,
      };
    }
    return {
      swapTransactionBase64: cleanB64,
      serializedByteLength: origBytes.length,
      feePayer,
      atomicCloseAppended: false,
      warning: `Appending atomic CloseAccount exceeded Solana's ${SOLANA_MAX_PACKET_BYTES}-byte packet limit (${updatedBytes.length} bytes); reclaim 0.00203928 SOL via Rent Vacuum after swap.`,
    };
  }

  // Path 3: Resolve ALTs via explicit accounts or RPC, decompile, append, recompile
  const rpcUrls =
    Array.isArray(opts.rpcUrls) && opts.rpcUrls.length > 0 ? opts.rpcUrls : DEFAULT_SOLANA_RPC_URLS;
  const alts =
    opts.addressLookupTableAccounts ??
    (await resolveAddressLookupTables(
      msg.addressTableLookups.map((l) => l.accountKey),
      rpcUrls,
      opts.timeoutMs ?? DEFAULT_SPL_DUST_TIMEOUT_MS
    ));

  if (alts) {
    try {
      const decompiled = TransactionMessage.decompile(msg, { addressLookupTableAccounts: alts });
      decompiled.instructions.push(closeIx);
      const recompiledMsg = decompiled.compileToV0Message(alts);
      const updatedTx = new VersionedTransaction(recompiledMsg);
      const updatedFeePayer = updatedTx.message.staticAccountKeys[0]?.toBase58();
      const updatedBytes = Buffer.from(updatedTx.serialize());
      if (updatedFeePayer === ownerClean && updatedBytes.length <= SOLANA_MAX_PACKET_BYTES) {
        return {
          swapTransactionBase64: updatedBytes.toString('base64'),
          serializedByteLength: updatedBytes.length,
          feePayer: updatedFeePayer,
          atomicCloseAppended: true,
        };
      }
    } catch {
      // Fall through to graceful swap-only return with warning
    }
  }

  return {
    swapTransactionBase64: cleanB64,
    serializedByteLength: origBytes.length,
    feePayer,
    atomicCloseAppended: false,
    warning:
      'Could not append atomic CloseAccount across Address Lookup Tables; swap will drain the ATA so you can reclaim 0.00203928 SOL via Rent Vacuum.',
  };
}

/**
 * Scans a Solana wallet via `getTokenAccountsByOwner` (`jsonParsed`) for SPL Token Program
 * accounts containing sweepable dust (`0 < usdValue <= maxDustUsd`, default $50).
 * Strictly skips SOL/wSOL, USDC, JupSOL, jlUSDC, frozen accounts, zero-balance accounts,
 * foreign-authority accounts, and positions exceeding `maxDustUsd`.
 */
export async function scanSolanaSplDust(
  ownerAddress: string,
  opts: ScanSolanaSplDustOptions = {}
): Promise<SolanaSplDustScanResult> {
  const ownerPubkey = validateSolanaPubkey(ownerAddress, 'ownerAddress');
  const ownerClean = ownerPubkey.toBase58();

  const { maxDustUsd, minDustUsd } = validateDustUsdBounds(opts.maxDustUsd, opts.minDustUsd);

  if (opts.solPriceUsd !== undefined) {
    if (
      typeof opts.solPriceUsd !== 'number' ||
      !Number.isFinite(opts.solPriceUsd) ||
      opts.solPriceUsd <= 0
    ) {
      throw new Error('solPriceUsd must be a finite positive number.');
    }
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_SPL_DUST_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 100) {
    throw new Error('timeoutMs must be a finite number >= 100.');
  }

  const rpcUrls =
    Array.isArray(opts.rpcUrls) && opts.rpcUrls.length > 0 ? opts.rpcUrls : DEFAULT_SOLANA_RPC_URLS;
  const includeUnpriced = opts.includeUnpriced !== false;
  const explicitPrices = sanitizeExplicitPriceMap(opts.priceMapUsd);

  const splResult = await fetchSolanaRpc<{ value?: RawParsedTokenAccountEntry[] }>(
    'getTokenAccountsByOwner',
    [ownerClean, { programId: SPL_TOKEN_PROGRAM_BASE58 }, { encoding: 'jsonParsed' }],
    rpcUrls,
    timeoutMs
  );

  const entries = Array.isArray(splResult?.value) ? splResult.value : [];
  const seenAccounts = new Set<string>();

  let totalTokenAccountsScanned = 0;
  let skippedProtectedCount = 0;
  let skippedZeroBalanceCount = 0;
  let skippedFrozenCount = 0;
  let skippedUncloseableCount = 0;
  let skippedAboveMaxUsdCount = 0;
  let skippedBelowMinUsdCount = 0;

  interface CandidateDustAccount {
    tokenAccount: string;
    mint: string;
    amount: string;
    uiAmount: number;
    decimals: number;
    closeAuthority: string | null;
    rentLamports: number;
  }

  const candidates: CandidateDustAccount[] = [];

  for (const entry of entries) {
    const pubkeyStr = typeof entry?.pubkey === 'string' ? entry.pubkey.trim() : '';
    if (!pubkeyStr || seenAccounts.has(pubkeyStr)) continue;
    seenAccounts.add(pubkeyStr);
    totalTokenAccountsScanned += 1;

    // Validate token account pubkey and never touch owner wallet address itself
    try {
      solanaAddressToBytes32(pubkeyStr);
      if (pubkeyStr === ownerClean) {
        skippedUncloseableCount += 1;
        continue;
      }
    } catch {
      skippedUncloseableCount += 1;
      continue;
    }

    const info = entry.account?.data?.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (!info || !tokenAmount) {
      skippedUncloseableCount += 1;
      continue;
    }

    const mint = typeof info.mint === 'string' ? info.mint.trim() : '';
    try {
      if (!mint) throw new Error('missing mint');
      solanaAddressToBytes32(mint);
    } catch {
      skippedUncloseableCount += 1;
      continue;
    }

    const stateStr =
      typeof info.state === 'string' ? info.state.trim().toLowerCase() : 'initialized';
    if (stateStr === 'frozen') {
      skippedFrozenCount += 1;
      continue;
    }
    if (stateStr !== 'initialized') {
      skippedUncloseableCount += 1;
      continue;
    }

    const accountOwner = typeof info.owner === 'string' ? info.owner.trim() : '';
    if (!accountOwner || accountOwner !== ownerClean) {
      skippedUncloseableCount += 1;
      continue;
    }

    const closeAuthority =
      typeof info.closeAuthority === 'string' && info.closeAuthority.trim()
        ? info.closeAuthority.trim()
        : null;
    if (closeAuthority && closeAuthority !== ownerClean) {
      skippedUncloseableCount += 1;
      continue;
    }

    const rawAmount = typeof tokenAmount.amount === 'string' ? tokenAmount.amount.trim() : '';
    const decimals =
      typeof tokenAmount.decimals === 'number' &&
      Number.isInteger(tokenAmount.decimals) &&
      tokenAmount.decimals >= 0 &&
      tokenAmount.decimals <= 18
        ? tokenAmount.decimals
        : 0;
    if (!/^\d+$/.test(rawAmount)) {
      skippedUncloseableCount += 1;
      continue;
    }

    const amountBig = BigInt(rawAmount);
    const uiAmount =
      typeof tokenAmount.uiAmount === 'number' && Number.isFinite(tokenAmount.uiAmount)
        ? tokenAmount.uiAmount
        : Number(tokenAmount.uiAmountString ?? Number(amountBig) / Math.pow(10, decimals));

    if (amountBig === 0n || !Number.isFinite(uiAmount) || uiAmount <= 0) {
      skippedZeroBalanceCount += 1;
      continue;
    }

    // Strictly skip native SOL/wSOL, USDC, JupSOL, and jlUSDC
    if (info.isNative === true || isProtectedSolanaMint(mint)) {
      skippedProtectedCount += 1;
      continue;
    }

    const rawLamports = entry.account?.lamports;
    const rentLamports =
      typeof rawLamports === 'number' && Number.isInteger(rawLamports) && rawLamports > 0
        ? rawLamports
        : SOLANA_EMPTY_ATA_RENT_LAMPORTS;

    candidates.push({
      tokenAccount: pubkeyStr,
      mint,
      amount: rawAmount,
      uiAmount,
      decimals,
      closeAuthority,
      rentLamports,
    });
  }

  // Fetch USD prices for candidate mints + SOL (unless skipped)
  let fetchedPrices = new Map<
    string,
    { priceUsd: number; source: 'jupiter' | 'defillama'; symbol?: string }
  >();
  let liveSolPriceUsd: number | null = null;

  const unpricedMints = candidates
    .map((c) => c.mint)
    .filter((m) => !explicitPrices.has(m));
  const needsSolPrice = opts.solPriceUsd === undefined;

  if (!opts.skipPriceFetch && (unpricedMints.length > 0 || needsSolPrice)) {
    const priceRes = await fetchSplPricesUsd(unpricedMints, {
      timeoutMs,
      jupiterApiKey: opts.jupiterApiKey,
    });
    fetchedPrices = priceRes.prices;
    liveSolPriceUsd = priceRes.solPriceUsd;
  }

  let solPriceUsd: number;
  let solPriceSource: 'explicit' | 'live' | 'fallback';
  if (opts.solPriceUsd !== undefined) {
    solPriceUsd = opts.solPriceUsd;
    solPriceSource = 'explicit';
  } else if (liveSolPriceUsd !== null) {
    solPriceUsd = liveSolPriceUsd;
    solPriceSource = 'live';
  } else {
    solPriceUsd = DEFAULT_FALLBACK_SOL_PRICE_USD;
    solPriceSource = 'fallback';
  }

  const dustAccounts: SolanaSplDustAccount[] = [];

  for (const c of candidates) {
    let priceUsd: number | null = null;
    let priceSource: SolanaSplDustAccount['priceSource'] = 'unpriced';
    let symbol = shortMintLabel(c.mint);

    if (explicitPrices.has(c.mint)) {
      priceUsd = explicitPrices.get(c.mint)!;
      priceSource = 'explicit';
    } else if (fetchedPrices.has(c.mint)) {
      const hit = fetchedPrices.get(c.mint)!;
      priceUsd = hit.priceUsd;
      priceSource = hit.source;
      if (hit.symbol) symbol = hit.symbol;
    }

    const usdValue = priceUsd !== null ? round6(c.uiAmount * priceUsd) : null;

    if (usdValue !== null && usdValue > maxDustUsd) {
      skippedAboveMaxUsdCount += 1;
      continue;
    }
    if (usdValue !== null && minDustUsd > 0 && usdValue < minDustUsd) {
      skippedBelowMinUsdCount += 1;
      continue;
    }
    if (usdValue === null && !includeUnpriced) {
      skippedBelowMinUsdCount += 1;
      continue;
    }

    const rentSol = round8(c.rentLamports / 1_000_000_000);
    const rentUsd = round2(rentSol * solPriceUsd);
    const netEstimatedUsd = round2((usdValue ?? 0) + rentUsd);

    dustAccounts.push({
      tokenAccount: c.tokenAccount,
      mint: c.mint,
      owner: ownerClean,
      programId: SPL_TOKEN_PROGRAM_BASE58,
      amount: c.amount,
      uiAmount: c.uiAmount,
      decimals: c.decimals,
      symbol,
      state: 'initialized',
      frozen: false,
      closeable: true,
      closeAuthority: c.closeAuthority,
      priceUsd: priceUsd !== null ? round6(priceUsd) : null,
      priceSource,
      usdValue: usdValue !== null ? round2(usdValue) : null,
      rentLamports: c.rentLamports,
      rentSol,
      rentUsd,
      netEstimatedUsd,
    });
  }

  // Deterministic ordering: highest net recovery USD first, tie-break by tokenAccount
  dustAccounts.sort((a, b) => {
    if (b.netEstimatedUsd !== a.netEstimatedUsd) {
      return b.netEstimatedUsd - a.netEstimatedUsd;
    }
    return a.tokenAccount.localeCompare(b.tokenAccount);
  });

  const totalDustUsd = round2(dustAccounts.reduce((sum, a) => sum + (a.usdValue ?? 0), 0));
  const reclaimableRentLamports = dustAccounts.reduce((sum, a) => sum + a.rentLamports, 0);
  const reclaimableRentSol = round8(reclaimableRentLamports / 1_000_000_000);
  const reclaimableRentUsd = round2(reclaimableRentSol * solPriceUsd);
  const totalEstimatedRecoveryUsd = round2(totalDustUsd + reclaimableRentUsd);

  return {
    scanVersion: SOLANA_SPL_DUST_SCAN_VERSION,
    ownerAddress: ownerClean,
    programId: SPL_TOKEN_PROGRAM_BASE58,
    maxDustUsd,
    minDustUsd,
    totalTokenAccountsScanned,
    dustCount: dustAccounts.length,
    skippedProtectedCount,
    skippedZeroBalanceCount,
    skippedFrozenCount,
    skippedUncloseableCount,
    skippedAboveMaxUsdCount,
    skippedBelowMinUsdCount,
    totalDustUsd,
    reclaimableRentLamports,
    reclaimableRentSol,
    reclaimableRentUsd,
    totalEstimatedRecoveryUsd,
    solPriceUsd: round2(solPriceUsd),
    solPriceSource,
    dustAccounts,
  };
}

/**
 * Quotes & builds a single SPL dust swap (`inputMint -> USDC | SOL`) via Jupiter Swap API
 * with strict output verification (`inputMint`, `outputMint`, `inAmount`, `priceImpactPct <= 5%`,
 * `feePayer === ownerAddress`) and optional atomic SPL `CloseAccount` rent reclaim (0.00203928 SOL/ATA).
 */
async function quoteAndBuildDustItem(
  ownerClean: string,
  token: {
    tokenAccount: string;
    mint: string;
    amount: string;
    decimals: number;
    uiAmount: number;
    symbol: string;
    rentLamports: number;
  },
  target: DustSweepTargetMeta,
  opts: {
    maxDustUsd: number;
    slippageBps: number;
    closeAccounts: boolean;
    buildTransactions: boolean;
    priorityFeeMicroLamports?: number;
    solPriceUsd: number;
    rpcUrls: string[];
    jupiterApiKey?: string;
    timeoutMs: number;
  }
): Promise<SolanaSplDustSweepItem> {
  const { baseUrl, headers } = getJupiterSwapEndpoint(opts.jupiterApiKey);
  const quoteUrl =
    `${baseUrl}/quote?inputMint=${encodeURIComponent(token.mint)}` +
    `&outputMint=${encodeURIComponent(target.mint)}` +
    `&amount=${encodeURIComponent(token.amount)}` +
    `&slippageBps=${opts.slippageBps}` +
    `&restrictIntermediateTokens=true`;

  const quoteRes = await fetchJsonWithTimeout<Record<string, unknown>>(
    quoteUrl,
    { method: 'GET', headers },
    opts.timeoutMs
  );

  if (!quoteRes.ok || !quoteRes.data) {
    // HTTP 400 / 404 from Jupiter usually means no liquidity/route for obscure dust token;
    // 5xx or network error is an upstream transport failure.
    if (quoteRes.status === 0 || quoteRes.status >= 500 || quoteRes.status === 429) {
      throw new UpstreamTransportError(
        `Jupiter Swap quote failed for ${token.symbol} -> ${target.symbol} (${quoteRes.errorText ?? 'unknown error'}).`
      );
    }
    throw new Error(
      `No Jupiter swap route for ${token.symbol} -> ${target.symbol} (${quoteRes.errorText ?? 'unroutable dust'}).`
    );
  }

  const q = quoteRes.data;
  const quotedInputMint = typeof q.inputMint === 'string' ? q.inputMint.trim() : '';
  const quotedOutputMint = typeof q.outputMint === 'string' ? q.outputMint.trim() : '';
  const quotedInAmount = typeof q.inAmount === 'string' ? q.inAmount.trim() : '';

  if (quotedInputMint !== token.mint) {
    throw new UpstreamTamperingError(
      `Jupiter Swap quote inputMint mismatch: got "${quotedInputMint || 'missing'}", expected ${token.mint}.`
    );
  }
  if (quotedOutputMint !== target.mint) {
    throw new UpstreamTamperingError(
      `Jupiter Swap quote outputMint mismatch: got "${quotedOutputMint || 'missing'}", expected ${target.mint}.`
    );
  }
  if (!/^\d+$/.test(quotedInAmount) || quotedInAmount !== token.amount) {
    throw new UpstreamTamperingError(
      `Jupiter Swap quote inAmount mismatch: got "${quotedInAmount || 'missing'}", expected ${token.amount}.`
    );
  }

  const outAmountRaw = typeof q.outAmount === 'string' ? q.outAmount.trim() : '';
  const otherAmountThresholdRaw =
    q.otherAmountThreshold === undefined
      ? outAmountRaw
      : typeof q.otherAmountThreshold === 'string'
      ? q.otherAmountThreshold.trim()
      : '';

  if (!/^\d+$/.test(outAmountRaw) || BigInt(outAmountRaw) <= 0n) {
    throw new Error(`Jupiter Swap quote returned invalid or zero outAmount for ${token.symbol}.`);
  }
  if (!/^\d+$/.test(otherAmountThresholdRaw) || BigInt(otherAmountThresholdRaw) <= 0n) {
    throw new Error(
      `Jupiter Swap quote returned invalid or zero otherAmountThreshold for ${token.symbol}.`
    );
  }

  const rawPriceImpact = Number(q.priceImpactPct ?? 0);
  if (!Number.isFinite(rawPriceImpact) || rawPriceImpact < 0) {
    throw new UpstreamTamperingError('Jupiter Swap quote returned invalid priceImpactPct.');
  }
  const priceImpactPct = Number((rawPriceImpact * 100).toFixed(4));
  if (priceImpactPct > MAX_JUPITER_PRICE_IMPACT_PCT) {
    throw new Error(
      `Jupiter Swap quote price impact (${priceImpactPct}%) exceeds maximum safe limit (${MAX_JUPITER_PRICE_IMPACT_PCT}%).`
    );
  }

  const targetScale = Math.pow(10, target.decimals);
  const estimatedOutputUi = round6(Number(outAmountRaw) / targetScale);
  const minOutputUi = round6(Number(otherAmountThresholdRaw) / targetScale);
  const estimatedOutputUsd =
    target.id === 'usdc'
      ? round2(estimatedOutputUi)
      : round2(estimatedOutputUi * opts.solPriceUsd);

  // Fail-closed whale protection: even if a token was unpriced during scan, refuse to sweep
  // if live Jupiter quote output value exceeds maxDustUsd.
  if (estimatedOutputUsd > opts.maxDustUsd) {
    throw new Error(
      `Quoted output value ($${estimatedOutputUsd}) for ${token.symbol} exceeds maxDustUsd ($${opts.maxDustUsd}); skipped to protect large position.`
    );
  }

  const routePlan = Array.isArray(q.routePlan) ? q.routePlan : [];
  const routeLabels = routePlan
    .map((hop) => {
      const swapInfo = (hop as Record<string, unknown>)?.swapInfo as
        | Record<string, unknown>
        | undefined;
      return typeof swapInfo?.label === 'string' ? swapInfo.label : null;
    })
    .filter((label): label is string => Boolean(label));

  const quote: DustSwapQuoteSummary = {
    apiBaseUrl: baseUrl,
    inputMint: token.mint,
    outputMint: target.mint,
    inAmountRaw: token.amount,
    outAmountRaw,
    otherAmountThresholdRaw,
    estimatedOutputUi,
    minOutputUi,
    estimatedOutputUsd,
    slippageBps: opts.slippageBps,
    priceImpactPct,
    routeLabels,
  };

  const warnings: string[] = [];
  const rentSol = round8(token.rentLamports / 1_000_000_000);
  const rentUsd = round2(rentSol * opts.solPriceUsd);
  let atomicCloseAppended = false;
  let transaction: DustSweepTransactionPayload | null = null;

  if (opts.buildTransactions) {
    const swapBody: Record<string, unknown> = {
      quoteResponse: q,
      userPublicKey: ownerClean,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      asLegacyTransaction: false,
    };
    if (opts.priorityFeeMicroLamports !== undefined) {
      swapBody.computeUnitPriceMicroLamports = opts.priorityFeeMicroLamports;
    } else {
      swapBody.prioritizationFeeLamports = 'auto';
    }

    const swapRes = await fetchJsonWithTimeout<{
      swapTransaction?: string;
      lastValidBlockHeight?: number;
      prioritizationFeeLamports?: number;
    }>(
      `${baseUrl}/swap`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(swapBody),
      },
      opts.timeoutMs
    );

    if (!swapRes.ok || !swapRes.data?.swapTransaction) {
      throw new UpstreamTransportError(
        `Jupiter Swap transaction build failed for ${token.symbol} (${swapRes.errorText ?? 'missing swapTransaction'}).`
      );
    }

    const rawTxB64 = swapRes.data.swapTransaction.trim();
    if (opts.closeAccounts) {
      const closed = await appendAtomicCloseAccountToVersionedTx(
        rawTxB64,
        ownerClean,
        token.tokenAccount,
        {
          rpcUrls: opts.rpcUrls,
          timeoutMs: opts.timeoutMs,
        }
      );
      atomicCloseAppended = closed.atomicCloseAppended;
      if (closed.warning) warnings.push(closed.warning);
      transaction = {
        version: 0,
        feePayer: closed.feePayer,
        lastValidBlockHeight:
          typeof swapRes.data.lastValidBlockHeight === 'number'
            ? swapRes.data.lastValidBlockHeight
            : null,
        prioritizationFeeLamports:
          typeof swapRes.data.prioritizationFeeLamports === 'number'
            ? swapRes.data.prioritizationFeeLamports
            : null,
        serializedByteLength: closed.serializedByteLength,
        atomicCloseAppended,
        swapTransactionBase64: closed.swapTransactionBase64,
      };
    } else {
      const txBytes = Buffer.from(rawTxB64, 'base64');
      let parsedTx: VersionedTransaction;
      try {
        parsedTx = VersionedTransaction.deserialize(txBytes);
      } catch {
        throw new UpstreamTamperingError(
          'Jupiter Swap returned malformed VersionedTransaction bytes.'
        );
      }
      if (parsedTx.version !== 0) {
        throw new UpstreamTamperingError(
          `Expected VersionedTransaction v0 from Jupiter Swap, got version "${String(parsedTx.version)}".`
        );
      }
      const feePayer = parsedTx.message.staticAccountKeys[0]?.toBase58();
      if (!feePayer || feePayer !== ownerClean) {
        throw new UpstreamTamperingError(
          `Jupiter Swap transaction feePayer mismatch: got ${feePayer ?? 'none'}, expected ${ownerClean}.`
        );
      }
      transaction = {
        version: 0,
        feePayer,
        lastValidBlockHeight:
          typeof swapRes.data.lastValidBlockHeight === 'number'
            ? swapRes.data.lastValidBlockHeight
            : null,
        prioritizationFeeLamports:
          typeof swapRes.data.prioritizationFeeLamports === 'number'
            ? swapRes.data.prioritizationFeeLamports
            : null,
        serializedByteLength: txBytes.length,
        atomicCloseAppended: false,
        swapTransactionBase64: rawTxB64,
      };
    }
  }

  return {
    tokenAccount: token.tokenAccount,
    mint: token.mint,
    symbol: token.symbol,
    amount: token.amount,
    decimals: token.decimals,
    uiAmount: token.uiAmount,
    targetAsset: target.id,
    targetMint: target.mint,
    targetSymbol: target.symbol,
    quote,
    rentReclaim: {
      enabled: opts.closeAccounts,
      atomicCloseAppended,
      rentLamports: opts.closeAccounts ? token.rentLamports : 0,
      rentSol: opts.closeAccounts ? rentSol : 0,
      rentUsd: opts.closeAccounts ? rentUsd : 0,
      destination: ownerClean,
      authority: ownerClean,
    },
    transaction,
    warnings,
  };
}

/**
 * Builds an end-to-end Solana SPL Dust Sweep plan:
 *  - Discovers SPL dust accounts via `scanSolanaSplDust` (or validates explicit `tokens`)
 *  - Quotes each dust token into USDC or SOL via Jupiter v6/lite API (`priceImpactPct <= 5%`)
 *  - Builds & verifies unsigned V0 `VersionedTransaction`s (`feePayer === ownerAddress`)
 *  - Atomically appends SPL Token `CloseAccount` to reclaim `0.00203928 SOL` rent per ATA
 */
export async function buildSolanaSplDustSweepPlan(
  params: BuildSolanaSplDustSweepParams
): Promise<SolanaSplDustSweepPlan> {
  const ownerPubkey = validateSolanaPubkey(params.ownerAddress, 'ownerAddress');
  const ownerClean = ownerPubkey.toBase58();

  const targetAsset: SolanaDustTargetAsset = params.targetAsset ?? 'usdc';
  if (typeof targetAsset !== 'string' || !Object.hasOwn(DUST_SWEEP_TARGETS, targetAsset)) {
    throw new Error(
      `Unsupported targetAsset "${String(params.targetAsset)}". Allowed: usdc, sol.`
    );
  }
  const target = DUST_SWEEP_TARGETS[targetAsset];

  const { maxDustUsd, minDustUsd } = validateDustUsdBounds(params.maxDustUsd, params.minDustUsd);

  const slippageBps = params.slippageBps ?? DEFAULT_DUST_SLIPPAGE_BPS;
  if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps must be an integer between 1 and ${MAX_SLIPPAGE_BPS}.`);
  }

  if (params.priorityFeeMicroLamports !== undefined) {
    if (
      !Number.isInteger(params.priorityFeeMicroLamports) ||
      params.priorityFeeMicroLamports < 0 ||
      params.priorityFeeMicroLamports > 10_000_000
    ) {
      throw new Error('priorityFeeMicroLamports must be an integer between 0 and 10,000,000.');
    }
  }

  const maxTokens = params.maxTokens ?? MAX_DUST_SWEEP_TOKENS;
  if (
    !Number.isInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > MAX_ALLOWED_DUST_SWEEP_TOKENS
  ) {
    throw new Error(
      `maxTokens must be an integer between 1 and ${MAX_ALLOWED_DUST_SWEEP_TOKENS}.`
    );
  }

  if (params.solPriceUsd !== undefined) {
    if (
      typeof params.solPriceUsd !== 'number' ||
      !Number.isFinite(params.solPriceUsd) ||
      params.solPriceUsd <= 0
    ) {
      throw new Error('solPriceUsd must be a finite positive number.');
    }
  }

  const timeoutMs = params.timeoutMs ?? DEFAULT_SPL_DUST_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 100) {
    throw new Error('timeoutMs must be a finite number >= 100.');
  }

  const closeAccounts = params.closeAccounts !== false;
  const buildTransactions = params.buildTransactions !== false;
  const rpcUrls =
    Array.isArray(params.rpcUrls) && params.rpcUrls.length > 0
      ? params.rpcUrls
      : DEFAULT_SOLANA_RPC_URLS;

  interface NormalizedSweepCandidate {
    tokenAccount: string;
    mint: string;
    amount: string;
    decimals: number;
    uiAmount: number;
    symbol: string;
    rentLamports: number;
  }

  let candidates: NormalizedSweepCandidate[] = [];
  let solPriceUsd = params.solPriceUsd ?? DEFAULT_FALLBACK_SOL_PRICE_USD;

  if (params.tokens !== undefined) {
    if (!Array.isArray(params.tokens) || params.tokens.length === 0) {
      throw new Error('tokens must be a non-empty array when provided.');
    }
    if (params.tokens.length > MAX_ALLOWED_DUST_SWEEP_TOKENS) {
      throw new Error(
        `Cannot sweep more than ${MAX_ALLOWED_DUST_SWEEP_TOKENS} tokens in a single request.`
      );
    }

    const seenAccounts = new Set<string>();
    for (const rawTok of params.tokens) {
      if (!rawTok || typeof rawTok !== 'object') {
        throw new Error('Each entry in tokens must be an object.');
      }
      const tokenAccountPubkey = validateSolanaPubkey(rawTok.tokenAccount, 'tokenAccount');
      const tokenAccountClean = tokenAccountPubkey.toBase58();
      if (tokenAccountClean === ownerClean) {
        throw new Error(
          `Refusing to sweep owner wallet address ${ownerClean} as a token account.`
        );
      }
      if (seenAccounts.has(tokenAccountClean)) {
        throw new Error(`Duplicate tokenAccount in sweep request: ${tokenAccountClean}.`);
      }
      seenAccounts.add(tokenAccountClean);

      const mintPubkey = validateSolanaPubkey(rawTok.mint, 'mint');
      const mintClean = mintPubkey.toBase58();
      if (isProtectedSolanaMint(mintClean)) {
        throw new Error(
          `Refusing to sweep protected Solana mint ${mintClean} (SOL/USDC/JupSOL/jlUSDC cannot be swept as dust).`
        );
      }
      if (mintClean === target.mint) {
        throw new Error(`Refusing to sweep token mint ${mintClean} into itself.`);
      }

      const amountStr = typeof rawTok.amount === 'string' ? rawTok.amount.trim() : '';
      if (!/^\d+$/.test(amountStr) || BigInt(amountStr) <= 0n) {
        throw new Error(
          `Invalid token amount "${String(rawTok.amount)}" for ${tokenAccountClean}: must be a positive integer string.`
        );
      }

      const decimals =
        rawTok.decimals !== undefined
          ? rawTok.decimals
          : 6;
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
        throw new Error(`Invalid decimals for ${tokenAccountClean}: must be an integer 0..18.`);
      }

      const uiAmount =
        typeof rawTok.uiAmount === 'number' && Number.isFinite(rawTok.uiAmount) && rawTok.uiAmount > 0
          ? rawTok.uiAmount
          : Number(BigInt(amountStr)) / Math.pow(10, decimals);

      if (
        rawTok.usdValue !== undefined &&
        rawTok.usdValue !== null &&
        typeof rawTok.usdValue === 'number' &&
        Number.isFinite(rawTok.usdValue) &&
        rawTok.usdValue > maxDustUsd
      ) {
        throw new Error(
          `Token ${mintClean} value ($${rawTok.usdValue}) exceeds maxDustUsd ($${maxDustUsd}).`
        );
      }

      const rentLamports =
        typeof rawTok.rentLamports === 'number' &&
        Number.isInteger(rawTok.rentLamports) &&
        rawTok.rentLamports > 0
          ? rawTok.rentLamports
          : SOLANA_EMPTY_ATA_RENT_LAMPORTS;

      const symbol =
        typeof rawTok.symbol === 'string' && rawTok.symbol.trim()
          ? rawTok.symbol.trim().slice(0, 16)
          : shortMintLabel(mintClean);

      candidates.push({
        tokenAccount: tokenAccountClean,
        mint: mintClean,
        amount: amountStr,
        decimals,
        uiAmount,
        symbol,
        rentLamports,
      });
    }

    if (params.solPriceUsd === undefined && !params.skipPriceFetch) {
      const priceRes = await fetchSplPricesUsd([], {
        timeoutMs,
        jupiterApiKey: params.jupiterApiKey,
      });
      if (priceRes.solPriceUsd !== null) {
        solPriceUsd = priceRes.solPriceUsd;
      }
    }
  } else {
    const scan = await scanSolanaSplDust(ownerClean, {
      maxDustUsd,
      minDustUsd,
      includeUnpriced: params.includeUnpriced,
      rpcUrls,
      timeoutMs,
      solPriceUsd: params.solPriceUsd,
      priceMapUsd: params.priceMapUsd,
      skipPriceFetch: params.skipPriceFetch,
      jupiterApiKey: params.jupiterApiKey,
    });
    solPriceUsd = scan.solPriceUsd;
    candidates = scan.dustAccounts.map((a) => ({
      tokenAccount: a.tokenAccount,
      mint: a.mint,
      amount: a.amount,
      decimals: a.decimals,
      uiAmount: a.uiAmount,
      symbol: a.symbol,
      rentLamports: a.rentLamports,
    }));
  }

  const warnings: string[] = [];
  if (candidates.length > maxTokens) {
    warnings.push(
      `Batching first ${maxTokens} of ${candidates.length} SPL dust tokens (run again to sweep remaining dust).`
    );
    candidates = candidates.slice(0, maxTokens);
  }

  const items: SolanaSplDustSweepItem[] = [];
  const skipped: SolanaSplDustSkippedItem[] = [];

  for (const tok of candidates) {
    try {
      const item = await quoteAndBuildDustItem(ownerClean, tok, target, {
        maxDustUsd,
        slippageBps,
        closeAccounts,
        buildTransactions,
        priorityFeeMicroLamports: params.priorityFeeMicroLamports,
        solPriceUsd,
        rpcUrls,
        jupiterApiKey: params.jupiterApiKey,
        timeoutMs,
      });
      items.push(item);
      if (item.warnings.length > 0) {
        warnings.push(...item.warnings);
      }
    } catch (err) {
      // Fail closed immediately on upstream tampering (feePayer/mint/amount mismatch, malformed tx)
      // or Jupiter transport outage.
      if (err instanceof UpstreamTamperingError || err instanceof UpstreamTransportError) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({
        tokenAccount: tok.tokenAccount,
        mint: tok.mint,
        symbol: tok.symbol,
        reason,
      });
    }
  }

  const estimatedTotalOutputUi = round6(
    items.reduce((sum, item) => sum + item.quote.estimatedOutputUi, 0)
  );
  const estimatedTotalOutputUsd = round2(
    items.reduce((sum, item) => sum + item.quote.estimatedOutputUsd, 0)
  );
  const totalReclaimableRentLamports = items.reduce(
    (sum, item) => sum + item.rentReclaim.rentLamports,
    0
  );
  const totalReclaimableRentSol = round8(totalReclaimableRentLamports / 1_000_000_000);
  const totalReclaimableRentUsd = round2(totalReclaimableRentSol * solPriceUsd);
  const totalEstimatedRecoveryUsd = round2(estimatedTotalOutputUsd + totalReclaimableRentUsd);

  return {
    planVersion: SOLANA_SPL_DUST_SWEEP_VERSION,
    ownerAddress: ownerClean,
    targetAsset: target.id,
    targetMint: target.mint,
    targetSymbol: target.symbol,
    maxDustUsd,
    slippageBps,
    closeAccountsRequested: closeAccounts,
    sweptCount: items.length,
    skippedCount: skipped.length,
    estimatedTotalOutputUi,
    estimatedTotalOutputUsd,
    totalReclaimableRentLamports,
    totalReclaimableRentSol,
    totalReclaimableRentUsd,
    totalEstimatedRecoveryUsd,
    solPriceUsd: round2(solPriceUsd),
    items,
    skipped,
    warnings,
  };
}

export {
  MAX_JUPITER_PRICE_IMPACT_PCT,
  MAX_SLIPPAGE_BPS,
  SOLANA_EMPTY_ATA_RENT_LAMPORTS,
  SOLANA_EMPTY_ATA_RENT_SOL,
  SOLANA_JUPITER_LEND_JLUSDC_MINT,
  SOLANA_JUPSOL_MINT,
  SOLANA_USDC_MINT,
  SOLANA_WSOL_MINT,
};
