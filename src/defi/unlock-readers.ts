import { COSMOS_CHAINS, type CosmosChainConfig } from '../adapters/cosmos.js';
import { validateCosmosAddress, validateEvmHexAddress } from '../scanner/address.js';
import { DEAD_BURN_ADDRESS, EVM_CHAINS } from '../scanner/chains.js';
import { evmJsonRpcCall, formatUnits } from '../scanner/rpc.js';
import type { AnyChainId, CosmosChainId, EvmChainId } from '../scanner/types.js';

export const LIDO_WITHDRAWAL_QUEUE_ADDRESS = '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1';
export const ETHENA_SUSDE_ADDRESS = '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497';

/**
 * Cryptographically verified 4-byte EVM ABI function selectors (keccak256).
 */
export const UNLOCK_READER_SELECTORS = {
  lidoGetWithdrawalRequests: '0x7d031b65', // getWithdrawalRequests(address)
  lidoGetWithdrawalStatus: '0xb8c4b85a', // getWithdrawalStatus(uint256[])
  lidoClaimWithdrawal: '0xf8444436', // claimWithdrawal(uint256)
  lidoClaimWithdrawals: '0xe3afe0a3', // claimWithdrawals(uint256[],uint256[])
  ethenaCooldowns: '0x01320fe2', // cooldowns(address)
  ethenaUnstake: '0xf2888dbb', // unstake(address)
} as const;

export const DEFAULT_UNLOCK_READER_TIMEOUT_MS = 2_500;
export const MAX_LIDO_WITHDRAWAL_REQUESTS = 100;
export const LIDO_DEFAULT_FINALIZATION_WINDOW_SEC = 3 * 86_400; // ~3 days standard queue estimate

const DEFAULT_ETH_PRICE_USD = 2500;
const DEFAULT_USDE_PRICE_USD = 1;

const DEFAULT_COSMOS_PRICES_USD: Record<CosmosChainId, number> = {
  cosmoshub: 4.5,
  osmosis: 0.4,
  noble: 1.0,
  celestia: 3.5,
  injective: 15.0,
  neutron: 0.25,
};

const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

export type EvmEthCallFn = (params: {
  chain: EvmChainId;
  to: string;
  data: string;
  timeoutMs: number;
}) => Promise<string | null>;

export interface LiveUnlockScheduleItem {
  id: string;
  kind: 'defi_unlock' | 'cctp_claim' | 'lido_withdrawal' | 'ethena_cooldown' | 'cosmos_unbonding';
  chain: AnyChainId;
  chainName: string;
  symbol: string;
  protocol: string;
  estimatedUsd: number;
  unlockAtMs: number;
  unlockAtIso: string;
  secondsRemaining: number;
  status: 'ready_to_claim' | 'locked_waiting' | 'attestation_pending';
  actionLabel: string;
  source?: 'scan_index' | 'cctp_attestation' | 'lido_withdrawal_queue' | 'ethena_susde' | 'cosmos_staking';
  uiAmount?: number;
  rawAmount?: string;
  requestId?: string;
  validatorAddress?: string;
  contractAddress?: string;
  claimMethod?: string;
}

export interface LidoWithdrawalRequest {
  requestId: string;
  amountOfStETHRaw: string;
  amountOfStETH: number;
  amountOfSharesRaw: string;
  owner: string;
  requestedAtSec: number;
  requestedAtIso: string;
  isFinalized: boolean;
  isClaimed: boolean;
  readyToClaim: boolean;
  estimatedUnlockAtMs: number;
  estimatedUsd: number;
}

export interface LidoWithdrawalQueueResult {
  ok: boolean;
  ownerAddress: string;
  contractAddress: string;
  requests: LidoWithdrawalRequest[];
  activeRequests: LidoWithdrawalRequest[];
  claimableCount: number;
  pendingCount: number;
  totalActiveStETH: number;
  totalActiveUsd: number;
  items: LiveUnlockScheduleItem[];
  error?: string;
  timedOut?: boolean;
}

export interface EthenaCooldownStatus {
  active: boolean;
  ownerAddress: string;
  contractAddress: string;
  cooldownEndSec: number;
  cooldownEndMs: number;
  cooldownEndIso: string | null;
  underlyingAmountRaw: string;
  underlyingAmountUsde: number;
  estimatedUsd: number;
  secondsRemaining: number;
  readyToUnstake: boolean;
  claimMethod: 'unstake(address)';
}

export interface EthenaCooldownReaderResult {
  ok: boolean;
  ownerAddress: string;
  contractAddress: string;
  cooldown: EthenaCooldownStatus | null;
  items: LiveUnlockScheduleItem[];
  error?: string;
  timedOut?: boolean;
}

export interface CosmosUnbondingEntry {
  chain: CosmosChainId;
  chainName: string;
  delegatorAddress: string;
  validatorAddress: string;
  symbol: string;
  denom: string;
  decimals: number;
  creationHeight: string;
  unbondingId?: string;
  balanceRaw: string;
  uiAmount: number;
  estimatedUsd: number;
  completionTimeMs: number;
  completionTimeIso: string;
  secondsRemaining: number;
  readyToClaim: boolean;
}

export interface CosmosUnbondingReaderResult {
  ok: boolean;
  chain: CosmosChainId;
  chainName: string;
  delegatorAddress: string;
  entries: CosmosUnbondingEntry[];
  totalUiAmount: number;
  totalEstimatedUsd: number;
  items: LiveUnlockScheduleItem[];
  error?: string;
  timedOut?: boolean;
}

export interface LidoUnlockReaderOptions {
  ethCall?: EvmEthCallFn;
  timeoutMs?: number;
  nowMs?: number;
  ethPriceUsd?: number;
  rpcUrls?: string[];
}

export interface EthenaUnlockReaderOptions {
  ethCall?: EvmEthCallFn;
  timeoutMs?: number;
  nowMs?: number;
  usdePriceUsd?: number;
  rpcUrls?: string[];
}

export interface CosmosUnbondingReaderOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowMs?: number;
  tokenPriceUsd?: number;
  lcdUrls?: string[];
}

export interface ReadLiveUnlockQueuesOptions {
  evmAddresses?: string[];
  cosmosAddresses?: string[];
  ethCall?: EvmEthCallFn;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  nowMs?: number;
  ethPriceUsd?: number;
  usdePriceUsd?: number;
  cosmosPricesUsd?: Partial<Record<CosmosChainId, number>>;
  ethRpcUrls?: string[];
  cosmosLcdUrls?: Partial<Record<CosmosChainId, string[]>>;
}

export interface LiveUnlockQueuesReport {
  readAt: string;
  items: LiveUnlockScheduleItem[];
  lido: LidoWithdrawalQueueResult[];
  ethena: EthenaCooldownReaderResult[];
  cosmos: CosmosUnbondingReaderResult[];
  warnings: string[];
}

function r2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function r6(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(6));
}

const MAX_SAFE_DATE_MS = 8_640_000_000_000_000;
const MAX_SAFE_DATE_SEC = Math.floor(MAX_SAFE_DATE_MS / 1000);

function clampDateMs(ms: number, fallbackMs: number): number {
  const safeFallback =
    Number.isFinite(fallbackMs) && fallbackMs >= 0 && fallbackMs <= MAX_SAFE_DATE_MS
      ? Math.round(fallbackMs)
      : Date.now();
  if (!Number.isFinite(ms)) return safeFallback;
  return Math.max(0, Math.min(MAX_SAFE_DATE_MS, Math.round(ms)));
}

function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function pad32Hex(hex: string): string {
  const clean = strip0x(hex).toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean) || clean.length > 64) {
    throw new Error(`Invalid ABI hex word: ${hex}`);
  }
  return clean.padStart(64, '0');
}

function padUint256(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) {
    throw new Error(`uint256 out of bounds: ${value.toString()}`);
  }
  return value.toString(16).padStart(64, '0');
}

function assertValidEvmReaderAddress(raw: string): string {
  const res = validateEvmHexAddress(raw);
  if (!res.valid || !res.normalized) {
    throw new Error(res.reason ?? 'Invalid EVM address.');
  }
  const lower = res.normalized.toLowerCase();
  if (lower === ZERO_EVM_ADDRESS || lower === DEAD_BURN_ADDRESS.toLowerCase()) {
    throw new Error('EVM address cannot be the zero or burn address.');
  }
  return res.normalized;
}

function formatDurationShort(totalSec: number): string {
  if (totalSec <= 0) return 'now';
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) return `${Math.ceil(totalSec / 60)}m`;
  if (totalSec < 86_400) return `${Math.round(totalSec / 3600)}h`;
  return `${Math.round(totalSec / 86_400)}d`;
}

class TimeoutError extends Error {
  readonly isTimeout = true;
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof TimeoutError) return true;
  if (err instanceof Error) {
    return err.name === 'AbortError' || /timeout|timed out|aborted/i.test(err.message);
  }
  return /timeout|timed out|aborted/i.test(String(err));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const boundedMs = Math.max(10, Math.min(30_000, Math.floor(timeoutMs)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError(`${label} timed out after ${boundedMs}ms`));
        }, boundedMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function defaultEvmEthCall(
  params: { chain: EvmChainId; to: string; data: string; timeoutMs: number },
  rpcUrlsOverride?: string[]
): Promise<string | null> {
  const cfg = EVM_CHAINS[params.chain];
  const urls = rpcUrlsOverride?.length ? rpcUrlsOverride : cfg?.rpcUrls ?? [];
  if (!urls.length) {
    throw new Error(`No RPC URLs configured for EVM chain ${params.chain}.`);
  }
  const res = await evmJsonRpcCall<string>(
    urls,
    'eth_call',
    [{ to: params.to, data: params.data }, 'latest'],
    params.timeoutMs
  );
  if (res.error) {
    throw new Error(res.error.message ?? `eth_call error ${res.error.code ?? ''}`);
  }
  return typeof res.result === 'string' ? res.result : null;
}

// ============================================================================
// 1. LIDO WITHDRAWAL QUEUE (0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1)
// ============================================================================

/**
 * Encodes `WithdrawalQueueERC721.getWithdrawalRequests(address _owner)` (`0x7d031b65`).
 */
export function encodeLidoGetWithdrawalRequestsCall(ownerAddress: string): string {
  const clean = assertValidEvmReaderAddress(ownerAddress);
  return `${UNLOCK_READER_SELECTORS.lidoGetWithdrawalRequests}${pad32Hex(clean)}`;
}

/**
 * Decodes ABI-encoded `uint256[]` returned by `getWithdrawalRequests(address)`.
 */
export function decodeLidoWithdrawalRequestIds(hexResult: string): bigint[] {
  if (typeof hexResult !== 'string') return [];
  const raw = strip0x(hexResult.trim());
  if (!raw || raw.length < 128 || raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) return [];

  const offsetBytes = BigInt('0x' + raw.slice(0, 64));
  if (offsetBytes > BigInt(raw.length / 2)) return [];
  const offsetChars = Number(offsetBytes) * 2;
  if (offsetChars + 64 > raw.length) return [];

  const countBig = BigInt('0x' + raw.slice(offsetChars, offsetChars + 64));
  if (countBig <= 0n) return [];
  const count = Number(countBig > BigInt(MAX_LIDO_WITHDRAWAL_REQUESTS) ? BigInt(MAX_LIDO_WITHDRAWAL_REQUESTS) : countBig);
  const dataStart = offsetChars + 64;
  if (dataStart + count * 64 > raw.length) return [];

  const ids: bigint[] = [];
  for (let i = 0; i < count; i += 1) {
    const word = raw.slice(dataStart + i * 64, dataStart + (i + 1) * 64);
    ids.push(BigInt('0x' + word));
  }
  return ids;
}

/**
 * Encodes `WithdrawalQueueERC721.getWithdrawalStatus(uint256[] _requestIds)` (`0xb8c4b85a`).
 */
export function encodeLidoGetWithdrawalStatusCall(requestIds: readonly bigint[]): string {
  if (requestIds.length > MAX_LIDO_WITHDRAWAL_REQUESTS) {
    throw new Error(`requestIds exceeds maximum batch size (${MAX_LIDO_WITHDRAWAL_REQUESTS}).`);
  }
  const header = pad32Hex('20') + padUint256(BigInt(requestIds.length));
  const body = requestIds.map((id) => padUint256(id)).join('');
  return `${UNLOCK_READER_SELECTORS.lidoGetWithdrawalStatus}${header}${body}`;
}

/**
 * Decodes ABI-encoded `WithdrawalRequestStatus[]` returned by `getWithdrawalStatus(uint256[])`:
 *   struct WithdrawalRequestStatus {
 *     uint256 amountOfStETH;
 *     uint256 amountOfShares;
 *     address owner;
 *     uint256 timestamp;
 *     bool isFinalized;
 *     bool isClaimed;
 *   }
 */
export function decodeLidoWithdrawalStatuses(
  hexResult: string,
  requestIds: readonly bigint[],
  options: { nowMs?: number; ethPriceUsd?: number } = {}
): LidoWithdrawalRequest[] {
  if (typeof hexResult !== 'string' || requestIds.length === 0) return [];
  const raw = strip0x(hexResult.trim());
  if (!raw || raw.length < 128 || raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) return [];

  const nowMs = clampDateMs(options.nowMs ?? Date.now(), Date.now());
  const ethPriceUsd =
    typeof options.ethPriceUsd === 'number' && Number.isFinite(options.ethPriceUsd) && options.ethPriceUsd > 0
      ? options.ethPriceUsd
      : DEFAULT_ETH_PRICE_USD;

  const offsetBytes = BigInt('0x' + raw.slice(0, 64));
  if (offsetBytes > BigInt(raw.length / 2)) return [];
  const offsetChars = Number(offsetBytes) * 2;
  if (offsetChars + 64 > raw.length) return [];

  const countBig = BigInt('0x' + raw.slice(offsetChars, offsetChars + 64));
  if (countBig <= 0n) return [];
  const count = Math.min(
    requestIds.length,
    Number(countBig > BigInt(MAX_LIDO_WITHDRAWAL_REQUESTS) ? BigInt(MAX_LIDO_WITHDRAWAL_REQUESTS) : countBig)
  );

  // Each WithdrawalRequestStatus tuple is 6 static 32-byte words = 384 hex chars
  const STRUCT_WORDS = 6;
  const STRUCT_HEX_LEN = STRUCT_WORDS * 64;
  const dataStart = offsetChars + 64;
  if (dataStart + count * STRUCT_HEX_LEN > raw.length) return [];

  const out: LidoWithdrawalRequest[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = dataStart + i * STRUCT_HEX_LEN;
    const w0 = raw.slice(base, base + 64);
    const w1 = raw.slice(base + 64, base + 128);
    const w2 = raw.slice(base + 128, base + 192);
    const w3 = raw.slice(base + 192, base + 256);
    const w4 = raw.slice(base + 256, base + 320);
    const w5 = raw.slice(base + 320, base + 384);

    const amountOfStETHRaw = BigInt('0x' + w0);
    const amountOfSharesRaw = BigInt('0x' + w1);
    const owner = '0x' + w2.slice(24).toLowerCase();
    const requestedAtSecBig = BigInt('0x' + w3);
    const requestedAtSec =
      requestedAtSecBig > BigInt(MAX_SAFE_DATE_SEC) ? MAX_SAFE_DATE_SEC : Number(requestedAtSecBig);
    const isFinalized = BigInt('0x' + w4) !== 0n;
    const isClaimed = BigInt('0x' + w5) !== 0n;
    const readyToClaim = isFinalized && !isClaimed;

    const amountOfStETH = r6(formatUnits(amountOfStETHRaw, 18));
    const estimatedUsd = r2(amountOfStETH * ethPriceUsd);
    const requestedAtMs = clampDateMs(requestedAtSec * 1000, nowMs);
    const estimatedUnlockAtMs = readyToClaim
      ? nowMs
      : clampDateMs(
          Math.max(nowMs + 3600_000, requestedAtMs + LIDO_DEFAULT_FINALIZATION_WINDOW_SEC * 1000),
          nowMs + 3600_000
        );

    out.push({
      requestId: requestIds[i].toString(),
      amountOfStETHRaw: amountOfStETHRaw.toString(),
      amountOfStETH,
      amountOfSharesRaw: amountOfSharesRaw.toString(),
      owner,
      requestedAtSec,
      requestedAtIso: requestedAtSec > 0 ? new Date(requestedAtMs).toISOString() : new Date(nowMs).toISOString(),
      isFinalized,
      isClaimed,
      readyToClaim,
      estimatedUnlockAtMs,
      estimatedUsd,
    });
  }

  return out;
}

/**
 * Live read-only reader for Ethereum Lido WithdrawalQueueERC721 pending & claimable stETH NFTs.
 * Fails gracefully (never throws on RPC timeout/failure).
 */
export async function readLidoWithdrawalQueue(
  evmAddress: string,
  options: LidoUnlockReaderOptions = {}
): Promise<LidoWithdrawalQueueResult> {
  const nowMs = options.nowMs ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_UNLOCK_READER_TIMEOUT_MS;
  const ethPriceUsd = options.ethPriceUsd ?? DEFAULT_ETH_PRICE_USD;

  let ownerAddress: string;
  try {
    ownerAddress = assertValidEvmReaderAddress(evmAddress);
  } catch (err) {
    return {
      ok: false,
      ownerAddress: String(evmAddress ?? ''),
      contractAddress: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
      requests: [],
      activeRequests: [],
      claimableCount: 0,
      pendingCount: 0,
      totalActiveStETH: 0,
      totalActiveUsd: 0,
      items: [],
      error: err instanceof Error ? err.message : 'Invalid EVM address.',
    };
  }

  const doEthCall: EvmEthCallFn =
    options.ethCall ?? ((p) => defaultEvmEthCall(p, options.rpcUrls));

  try {
    const reqIdsCalldata = encodeLidoGetWithdrawalRequestsCall(ownerAddress);
    const reqIdsHex = await withTimeout(
      doEthCall({
        chain: 'ethereum',
        to: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
        data: reqIdsCalldata,
        timeoutMs,
      }),
      timeoutMs,
      'Lido getWithdrawalRequests'
    );

    if (!reqIdsHex || reqIdsHex === '0x') {
      return {
        ok: true,
        ownerAddress,
        contractAddress: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
        requests: [],
        activeRequests: [],
        claimableCount: 0,
        pendingCount: 0,
        totalActiveStETH: 0,
        totalActiveUsd: 0,
        items: [],
      };
    }

    const requestIds = decodeLidoWithdrawalRequestIds(reqIdsHex);
    if (requestIds.length === 0) {
      return {
        ok: true,
        ownerAddress,
        contractAddress: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
        requests: [],
        activeRequests: [],
        claimableCount: 0,
        pendingCount: 0,
        totalActiveStETH: 0,
        totalActiveUsd: 0,
        items: [],
      };
    }

    const statusCalldata = encodeLidoGetWithdrawalStatusCall(requestIds);
    const statusHex = await withTimeout(
      doEthCall({
        chain: 'ethereum',
        to: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
        data: statusCalldata,
        timeoutMs,
      }),
      timeoutMs,
      'Lido getWithdrawalStatus'
    );

    const requests = statusHex
      ? decodeLidoWithdrawalStatuses(statusHex, requestIds, { nowMs, ethPriceUsd })
      : [];
    const activeRequests = requests.filter((r) => !r.isClaimed && BigInt(r.amountOfStETHRaw) > 0n);

    const items: LiveUnlockScheduleItem[] = activeRequests.map((req) => {
      const secondsRemaining = req.readyToClaim
        ? 0
        : Math.max(0, Math.round((req.estimatedUnlockAtMs - nowMs) / 1000));
      return {
        id: `lido:ethereum:${req.requestId}`,
        kind: 'lido_withdrawal',
        chain: 'ethereum',
        chainName: 'Ethereum',
        symbol: 'stETH',
        protocol: 'Lido Withdrawal Queue',
        estimatedUsd: req.estimatedUsd,
        unlockAtMs: req.estimatedUnlockAtMs,
        unlockAtIso: new Date(req.estimatedUnlockAtMs).toISOString(),
        secondsRemaining,
        status: req.readyToClaim ? 'ready_to_claim' : 'locked_waiting',
        actionLabel: req.readyToClaim
          ? `Claim ${req.amountOfStETH} ETH from Lido NFT #${req.requestId}`
          : `Lido NFT #${req.requestId} finalizing (~${formatDurationShort(secondsRemaining)})`,
        source: 'lido_withdrawal_queue',
        uiAmount: req.amountOfStETH,
        rawAmount: req.amountOfStETHRaw,
        requestId: req.requestId,
        contractAddress: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
        claimMethod: 'claimWithdrawal(uint256)',
      };
    });

    const claimableCount = activeRequests.filter((r) => r.readyToClaim).length;
    const pendingCount = activeRequests.length - claimableCount;
    const totalActiveStETH = r6(activeRequests.reduce((s, r) => s + r.amountOfStETH, 0));
    const totalActiveUsd = r2(activeRequests.reduce((s, r) => s + r.estimatedUsd, 0));

    return {
      ok: true,
      ownerAddress,
      contractAddress: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
      requests,
      activeRequests,
      claimableCount,
      pendingCount,
      totalActiveStETH,
      totalActiveUsd,
      items,
    };
  } catch (err) {
    return {
      ok: false,
      ownerAddress,
      contractAddress: LIDO_WITHDRAWAL_QUEUE_ADDRESS,
      requests: [],
      activeRequests: [],
      claimableCount: 0,
      pendingCount: 0,
      totalActiveStETH: 0,
      totalActiveUsd: 0,
      items: [],
      error: err instanceof Error ? err.message : String(err),
      timedOut: isTimeoutError(err),
    };
  }
}

// ============================================================================
// 2. ETHENA sUSDe COOLDOWNS (0x9D39A5DE30e57443BfF2A8307A4256c8797A3497)
// ============================================================================

/**
 * Encodes `StakedUSDeV2.cooldowns(address)` (`0x01320fe2`).
 */
export function encodeEthenaCooldownsCall(ownerAddress: string): string {
  const clean = assertValidEvmReaderAddress(ownerAddress);
  return `${UNLOCK_READER_SELECTORS.ethenaCooldowns}${pad32Hex(clean)}`;
}

/**
 * Decodes ABI-encoded `(uint104 cooldownEnd, uint152 underlyingAmount)` returned by `cooldowns(address)`.
 */
export function decodeEthenaCooldown(
  hexResult: string,
  ownerAddress: string,
  options: { nowMs?: number; usdePriceUsd?: number } = {}
): EthenaCooldownStatus | null {
  if (typeof hexResult !== 'string') return null;
  const raw = strip0x(hexResult.trim());
  if (!raw || raw.length < 128 || raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) return null;

  const nowMs = clampDateMs(options.nowMs ?? Date.now(), Date.now());
  const usdePriceUsd =
    typeof options.usdePriceUsd === 'number' && Number.isFinite(options.usdePriceUsd) && options.usdePriceUsd > 0
      ? options.usdePriceUsd
      : DEFAULT_USDE_PRICE_USD;

  const cooldownEndBig = BigInt('0x' + raw.slice(0, 64));
  const underlyingAmountRaw = BigInt('0x' + raw.slice(64, 128));

  // Sanity guard: uint104 max is (1<<104)-1, uint152 max is (1<<152)-1
  if (cooldownEndBig >= 1n << 104n || underlyingAmountRaw >= 1n << 152n) {
    return null;
  }

  const cooldownEndSec =
    cooldownEndBig > BigInt(MAX_SAFE_DATE_SEC) ? MAX_SAFE_DATE_SEC : Number(cooldownEndBig);
  const cooldownEndMs = clampDateMs(cooldownEndSec * 1000, nowMs);
  const active = underlyingAmountRaw > 0n;
  const underlyingAmountUsde = r6(formatUnits(underlyingAmountRaw, 18));
  const estimatedUsd = r2(underlyingAmountUsde * usdePriceUsd);
  const secondsRemaining = active ? Math.max(0, Math.round((cooldownEndMs - nowMs) / 1000)) : 0;
  const readyToUnstake = active && cooldownEndMs <= nowMs;

  return {
    active,
    ownerAddress,
    contractAddress: ETHENA_SUSDE_ADDRESS,
    cooldownEndSec,
    cooldownEndMs,
    cooldownEndIso: cooldownEndSec > 0 ? new Date(cooldownEndMs).toISOString() : null,
    underlyingAmountRaw: underlyingAmountRaw.toString(),
    underlyingAmountUsde,
    estimatedUsd,
    secondsRemaining,
    readyToUnstake,
    claimMethod: 'unstake(address)',
  };
}

/**
 * Live read-only reader for Ethereum Ethena `sUSDe` `cooldowns(address)` unlock state.
 * Fails gracefully (never throws on RPC timeout/failure).
 */
export async function readEthenaSusdeCooldown(
  evmAddress: string,
  options: EthenaUnlockReaderOptions = {}
): Promise<EthenaCooldownReaderResult> {
  const nowMs = options.nowMs ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_UNLOCK_READER_TIMEOUT_MS;
  const usdePriceUsd = options.usdePriceUsd ?? DEFAULT_USDE_PRICE_USD;

  let ownerAddress: string;
  try {
    ownerAddress = assertValidEvmReaderAddress(evmAddress);
  } catch (err) {
    return {
      ok: false,
      ownerAddress: String(evmAddress ?? ''),
      contractAddress: ETHENA_SUSDE_ADDRESS,
      cooldown: null,
      items: [],
      error: err instanceof Error ? err.message : 'Invalid EVM address.',
    };
  }

  const doEthCall: EvmEthCallFn =
    options.ethCall ?? ((p) => defaultEvmEthCall(p, options.rpcUrls));

  try {
    const calldata = encodeEthenaCooldownsCall(ownerAddress);
    const hex = await withTimeout(
      doEthCall({
        chain: 'ethereum',
        to: ETHENA_SUSDE_ADDRESS,
        data: calldata,
        timeoutMs,
      }),
      timeoutMs,
      'Ethena sUSDe cooldowns'
    );

    if (!hex || hex === '0x') {
      return {
        ok: true,
        ownerAddress,
        contractAddress: ETHENA_SUSDE_ADDRESS,
        cooldown: null,
        items: [],
      };
    }

    const cooldown = decodeEthenaCooldown(hex, ownerAddress, { nowMs, usdePriceUsd });
    const items: LiveUnlockScheduleItem[] = [];

    if (cooldown && cooldown.active) {
      const effectiveUnlockMs = cooldown.readyToUnstake
        ? Math.min(nowMs, cooldown.cooldownEndMs || nowMs)
        : cooldown.cooldownEndMs;
      items.push({
        id: `ethena:ethereum:susde:${ownerAddress.toLowerCase()}`,
        kind: 'ethena_cooldown',
        chain: 'ethereum',
        chainName: 'Ethereum',
        symbol: 'sUSDe',
        protocol: 'Ethena sUSDe',
        estimatedUsd: cooldown.estimatedUsd,
        unlockAtMs: effectiveUnlockMs,
        unlockAtIso: new Date(effectiveUnlockMs).toISOString(),
        secondsRemaining: cooldown.secondsRemaining,
        status: cooldown.readyToUnstake ? 'ready_to_claim' : 'locked_waiting',
        actionLabel: cooldown.readyToUnstake
          ? `Unstake ${cooldown.underlyingAmountUsde} USDe via Ethena unstake(address)`
          : `Ethena sUSDe cooldown ends in ${formatDurationShort(cooldown.secondsRemaining)}`,
        source: 'ethena_susde',
        uiAmount: cooldown.underlyingAmountUsde,
        rawAmount: cooldown.underlyingAmountRaw,
        contractAddress: ETHENA_SUSDE_ADDRESS,
        claimMethod: 'unstake(address)',
      });
    }

    return {
      ok: true,
      ownerAddress,
      contractAddress: ETHENA_SUSDE_ADDRESS,
      cooldown,
      items,
    };
  } catch (err) {
    return {
      ok: false,
      ownerAddress,
      contractAddress: ETHENA_SUSDE_ADDRESS,
      cooldown: null,
      items: [],
      error: err instanceof Error ? err.message : String(err),
      timedOut: isTimeoutError(err),
    };
  }
}

// ============================================================================
// 3. COSMOS UNBONDING DELEGATIONS
//    GET /cosmos/staking/v1beta1/delegators/{addr}/unbonding_delegations
// ============================================================================

interface RawCosmosUnbondingPayload {
  unbonding_responses?: Array<{
    delegator_address?: string;
    validator_address?: string;
    entries?: Array<{
      creation_height?: string | number;
      completion_time?: string;
      initial_balance?: string;
      balance?: string;
      unbonding_id?: string | number;
    }>;
  }>;
}

/**
 * Pure parser for Cosmos SDK `/cosmos/staking/v1beta1/delegators/{addr}/unbonding_delegations`.
 */
export function parseCosmosUnbondingDelegations(
  payload: unknown,
  chain: CosmosChainId,
  delegatorAddress: string,
  options: { nowMs?: number; tokenPriceUsd?: number } = {}
): CosmosUnbondingEntry[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const cfg: CosmosChainConfig | undefined = COSMOS_CHAINS[chain];
  if (!cfg) return [];

  const nowMs = options.nowMs ?? Date.now();
  const tokenPriceUsd =
    typeof options.tokenPriceUsd === 'number' && Number.isFinite(options.tokenPriceUsd) && options.tokenPriceUsd > 0
      ? options.tokenPriceUsd
      : DEFAULT_COSMOS_PRICES_USD[chain] ?? 1;

  const raw = payload as RawCosmosUnbondingPayload;
  const responses = Array.isArray(raw.unbonding_responses) ? raw.unbonding_responses : [];
  const entries: CosmosUnbondingEntry[] = [];

  for (const resp of responses) {
    if (!resp || typeof resp !== 'object') continue;
    const validatorAddress =
      typeof resp.validator_address === 'string' && resp.validator_address.trim()
        ? resp.validator_address.trim()
        : 'unknown-validator';
    const rawEntries = Array.isArray(resp.entries) ? resp.entries : [];

    for (const entry of rawEntries) {
      if (!entry || typeof entry !== 'object') continue;
      const balanceStr =
        typeof entry.balance === 'string'
          ? entry.balance.trim()
          : typeof entry.initial_balance === 'string'
            ? entry.initial_balance.trim()
            : '';
      if (!/^\d+$/.test(balanceStr)) continue;
      const balanceRaw = BigInt(balanceStr);
      if (balanceRaw <= 0n) continue;

      const rawCompletion = typeof entry.completion_time === 'string' ? entry.completion_time.trim() : '';
      const parsedCompletionMs = Date.parse(rawCompletion);
      if (!Number.isFinite(parsedCompletionMs) || parsedCompletionMs <= 0) continue;
      const completionTimeMs = clampDateMs(parsedCompletionMs, nowMs);

      const uiAmount = r6(formatUnits(balanceRaw, cfg.decimals));
      const estimatedUsd = r2(uiAmount * tokenPriceUsd);
      const secondsRemaining = Math.max(0, Math.round((completionTimeMs - nowMs) / 1000));
      const readyToClaim = completionTimeMs <= nowMs;

      entries.push({
        chain,
        chainName: cfg.name,
        delegatorAddress,
        validatorAddress,
        symbol: cfg.symbol,
        denom: cfg.baseDenom,
        decimals: cfg.decimals,
        creationHeight:
          entry.creation_height !== undefined && entry.creation_height !== null
            ? String(entry.creation_height).trim()
            : '0',
        unbondingId:
          entry.unbonding_id !== undefined && entry.unbonding_id !== null
            ? String(entry.unbonding_id).trim()
            : undefined,
        balanceRaw: balanceRaw.toString(),
        uiAmount,
        estimatedUsd,
        completionTimeMs,
        completionTimeIso: new Date(completionTimeMs).toISOString(),
        secondsRemaining,
        readyToClaim,
      });
    }
  }

  return entries.sort((a, b) => a.completionTimeMs - b.completionTimeMs);
}

/**
 * Live read-only reader for Cosmos SDK staking unbonding delegations across Cosmos chains.
 * Fails gracefully (never throws on LCD timeout/404/network error).
 */
export async function readCosmosUnbondingDelegations(
  cosmosAddress: string,
  options: CosmosUnbondingReaderOptions = {}
): Promise<CosmosUnbondingReaderResult> {
  const nowMs = options.nowMs ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_UNLOCK_READER_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  const validated = validateCosmosAddress(cosmosAddress);
  if (!validated.valid || !validated.meta || !validated.normalized) {
    return {
      ok: false,
      chain: 'cosmoshub',
      chainName: 'Cosmos',
      delegatorAddress: String(cosmosAddress ?? ''),
      entries: [],
      totalUiAmount: 0,
      totalEstimatedUsd: 0,
      items: [],
      error: validated.reason ?? 'Invalid Cosmos Bech32 address.',
    };
  }

  const chain = validated.meta.chain;
  const delegatorAddress = validated.normalized;
  const cfg = COSMOS_CHAINS[chain];
  const lcdUrls = options.lcdUrls?.length ? options.lcdUrls : cfg.lcdUrls;

  // Noble & Neutron have no native x/staking module; return empty cleanly unless custom lcdUrls were injected
  if ((chain === 'noble' || chain === 'neutron') && !options.lcdUrls?.length && !options.fetchImpl) {
    return {
      ok: true,
      chain,
      chainName: cfg.name,
      delegatorAddress,
      entries: [],
      totalUiAmount: 0,
      totalEstimatedUsd: 0,
      items: [],
    };
  }

  const endpoint = `/cosmos/staking/v1beta1/delegators/${encodeURIComponent(delegatorAddress)}/unbonding_delegations`;
  let lastError = 'All Cosmos LCD endpoints failed.';
  let anyTimedOut = false;

  for (const base of lcdUrls) {
    const controller = new AbortController();
    const url = `${base.replace(/\/+$/, '')}${endpoint}`;
    try {
      const res = await withTimeout(
        doFetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        }),
        timeoutMs,
        `Cosmos ${cfg.name} unbonding_delegations`
      );
      if (!res.ok) {
        lastError = `LCD HTTP ${res.status} (${base})`;
        continue;
      }
      const payload = (await withTimeout(
        res.json(),
        timeoutMs,
        `Cosmos ${cfg.name} JSON parse`
      )) as unknown;

      const entries = parseCosmosUnbondingDelegations(payload, chain, delegatorAddress, {
        nowMs,
        tokenPriceUsd: options.tokenPriceUsd,
      });

      const items: LiveUnlockScheduleItem[] = entries.map((e, idx) => ({
        id: `cosmos:${chain}:${e.validatorAddress}:${e.unbondingId ?? `${e.creationHeight}_${e.completionTimeMs}_${idx}`}`,
        kind: 'cosmos_unbonding',
        chain,
        chainName: cfg.name,
        symbol: cfg.symbol,
        protocol: `${cfg.name} Staking Unbonding`,
        estimatedUsd: e.estimatedUsd,
        unlockAtMs: e.completionTimeMs,
        unlockAtIso: e.completionTimeIso,
        secondsRemaining: e.secondsRemaining,
        status: e.readyToClaim ? 'ready_to_claim' : 'locked_waiting',
        actionLabel: e.readyToClaim
          ? `Unbonded ${e.uiAmount} ${cfg.symbol} — ready to bridge to Solana`
          : `${e.uiAmount} ${cfg.symbol} unbonds in ${formatDurationShort(e.secondsRemaining)}`,
        source: 'cosmos_staking',
        uiAmount: e.uiAmount,
        rawAmount: e.balanceRaw,
        validatorAddress: e.validatorAddress,
      }));

      const totalUiAmount = r6(entries.reduce((s, e) => s + e.uiAmount, 0));
      const totalEstimatedUsd = r2(entries.reduce((s, e) => s + e.estimatedUsd, 0));

      return {
        ok: true,
        chain,
        chainName: cfg.name,
        delegatorAddress,
        entries,
        totalUiAmount,
        totalEstimatedUsd,
        items,
      };
    } catch (err) {
      controller.abort();
      if (isTimeoutError(err)) anyTimedOut = true;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    ok: false,
    chain,
    chainName: cfg.name,
    delegatorAddress,
    entries: [],
    totalUiAmount: 0,
    totalEstimatedUsd: 0,
    items: [],
    error: lastError,
    timedOut: anyTimedOut,
  };
}

// ============================================================================
// 4. UNIFIED LIVE UNLOCK-QUEUE READER
// ============================================================================

/**
 * Queries all live on-chain unlock queues in parallel (Lido Withdrawal Queue, Ethena sUSDe
 * cooldowns, and Cosmos unbonding delegations) with clean per-reader timeout fail-safety.
 */
export async function readLiveUnlockQueues(
  options: ReadLiveUnlockQueuesOptions = {}
): Promise<LiveUnlockQueuesReport> {
  const nowMs = options.nowMs ?? Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_UNLOCK_READER_TIMEOUT_MS;

  // Deduplicate valid EVM addresses
  const evmSet = new Map<string, string>();
  for (const raw of options.evmAddresses ?? []) {
    if (typeof raw !== 'string') continue;
    const res = validateEvmHexAddress(raw);
    if (res.valid && res.normalized) {
      const lower = res.normalized.toLowerCase();
      if (lower !== ZERO_EVM_ADDRESS && lower !== DEAD_BURN_ADDRESS.toLowerCase()) {
        evmSet.set(lower, res.normalized);
      }
    }
  }

  // Deduplicate valid Cosmos addresses (supports comma-separated lists as well)
  const cosmosSet = new Set<string>();
  for (const raw of options.cosmosAddresses ?? []) {
    if (typeof raw !== 'string') continue;
    for (const part of raw.split(',')) {
      const res = validateCosmosAddress(part);
      if (res.valid && res.normalized) {
        cosmosSet.add(res.normalized);
      }
    }
  }

  const evmAddrs = Array.from(evmSet.values());
  const cosmosAddrs = Array.from(cosmosSet.values());

  const [lidoResults, ethenaResults, cosmosResults] = await Promise.all([
    Promise.all(
      evmAddrs.map((addr) =>
        readLidoWithdrawalQueue(addr, {
          ethCall: options.ethCall,
          timeoutMs,
          nowMs,
          ethPriceUsd: options.ethPriceUsd,
          rpcUrls: options.ethRpcUrls,
        })
      )
    ),
    Promise.all(
      evmAddrs.map((addr) =>
        readEthenaSusdeCooldown(addr, {
          ethCall: options.ethCall,
          timeoutMs,
          nowMs,
          usdePriceUsd: options.usdePriceUsd,
          rpcUrls: options.ethRpcUrls,
        })
      )
    ),
    Promise.all(
      cosmosAddrs.map((addr) => {
        const v = validateCosmosAddress(addr);
        const chain = v.meta?.chain;
        return readCosmosUnbondingDelegations(addr, {
          fetchImpl: options.fetchImpl,
          timeoutMs,
          nowMs,
          tokenPriceUsd: chain ? options.cosmosPricesUsd?.[chain] : undefined,
          lcdUrls: chain ? options.cosmosLcdUrls?.[chain] : undefined,
        });
      })
    ),
  ]);

  const warnings: string[] = [];
  const items: LiveUnlockScheduleItem[] = [];

  for (const r of lidoResults) {
    items.push(...r.items);
    if (!r.ok && r.error) {
      warnings.push(`Lido Withdrawal Queue read failed (${r.ownerAddress.slice(0, 10)}…): ${r.error}`);
    }
  }
  for (const r of ethenaResults) {
    items.push(...r.items);
    if (!r.ok && r.error) {
      warnings.push(`Ethena sUSDe cooldown read failed (${r.ownerAddress.slice(0, 10)}…): ${r.error}`);
    }
  }
  for (const r of cosmosResults) {
    items.push(...r.items);
    if (!r.ok && r.error) {
      warnings.push(`Cosmos ${r.chainName} unbonding read failed: ${r.error}`);
    }
  }

  // Deduplicate by id and sort soonest-first
  const byId = new Map<string, LiveUnlockScheduleItem>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  const sorted = Array.from(byId.values()).sort((a, b) => {
    if (a.unlockAtMs !== b.unlockAtMs) return a.unlockAtMs - b.unlockAtMs;
    if (a.status !== b.status) {
      if (a.status === 'ready_to_claim') return -1;
      if (b.status === 'ready_to_claim') return 1;
    }
    if (b.estimatedUsd !== a.estimatedUsd) return b.estimatedUsd - a.estimatedUsd;
    return a.id.localeCompare(b.id);
  });

  return {
    readAt: new Date(nowMs).toISOString(),
    items: sorted,
    lido: lidoResults,
    ethena: ethenaResults,
    cosmos: cosmosResults,
    warnings,
  };
}
