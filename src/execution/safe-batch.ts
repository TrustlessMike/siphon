import { keccak_256 } from '@noble/hashes/sha3';
import { toChecksumEvmAddress, validateEvmHexAddress, ZERO_EVM_ADDRESS } from '../scanner/address.js';
import { EVM_CHAINS } from '../scanner/chains.js';
import type { EvmChainId } from '../scanner/types.js';
import type { PreparedBatchCall, PreparedChainBatch } from './tx-builder.js';

export const SAFE_TX_BUILDER_VERSION = '1.0' as const;
export const SAFE_TX_BUILDER_APP_VERSION = '1.16.5';
export const MAX_SAFE_BATCH_TRANSACTIONS = 100;
export const MAX_SAFE_CALLDATA_HEX_CHARS = 524_288; // 256 KiB calldata per tx
export const MAX_SAFE_META_NAME_LEN = 120;
export const MAX_SAFE_META_DESC_LEN = 500;

const MAX_UINT256 = (1n << 256n) - 1n;

export interface SafeBatchCallInput {
  to: string;
  value?: string | number | bigint;
  data?: string;
  label?: string;
  description?: string;
}

export interface SafeBatchMetaOptions {
  name?: string;
  description?: string;
  createdFromSafeAddress?: string;
  createdFromOwnerAddress?: string;
  txBuilderVersion?: string;
  createdAt?: number;
}

export interface SafeBatchBuildInput extends SafeBatchMetaOptions {
  /** Optional Turgalium EVM chain slug (e.g. "ethereum", "base", "arbitrum") */
  chain?: EvmChainId | string;
  /** Optional numeric EVM chain ID (decimal integer or numeric string, e.g. 8453 or "8453") */
  chainId?: number | string;
  /** Either a Turgalium PreparedChainBatch or an explicit calls/transactions list */
  batch?: Pick<PreparedChainBatch, 'chain' | 'chainId' | 'chainName' | 'userAddress' | 'calls'>;
  calls?: Array<SafeBatchCallInput | PreparedBatchCall>;
  transactions?: Array<SafeBatchCallInput | PreparedBatchCall>;
}

export interface SafeBatchTransactionV1 {
  to: string;
  value: string;
  data: string;
  contractMethod: null;
  contractInputsValues: null;
}

export interface SafeBatchMetaV1 {
  name: string;
  description: string;
  txBuilderVersion: string;
  createdFromSafeAddress: string;
  createdFromOwnerAddress: string;
  checksum: string;
}

export interface SafeTransactionBatchV1 {
  version: typeof SAFE_TX_BUILDER_VERSION;
  chainId: string;
  createdAt: number;
  meta: SafeBatchMetaV1;
  transactions: SafeBatchTransactionV1[];
}

function sanitizeMetaText(raw: unknown, fallback: string, maxLen: number): string {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') {
    throw new Error('Safe batch metadata fields must be strings.');
  }
  const cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLen);
}

/**
 * Validates and EIP-55 checksums an EVM address for Safe Transaction Builder output.
 * Rejects malformed hex, invalid mixed-case EIP-55 checksums, and the zero address.
 */
export function normalizeSafeAddress(raw: unknown, fieldName: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${fieldName} must be a valid 20-byte 0x EVM address.`);
  }
  const res = validateEvmHexAddress(raw.trim());
  if (!res.valid || !res.normalized) {
    throw new Error(`Invalid ${fieldName}: ${res.reason ?? 'expected 20-byte 0x EVM address.'}`);
  }
  if (res.normalized.toLowerCase() === ZERO_EVM_ADDRESS) {
    throw new Error(`Invalid ${fieldName}: zero address is not allowed in Safe batches.`);
  }
  return toChecksumEvmAddress(res.normalized);
}

function normalizeOptionalSafeAddress(raw: unknown, fieldName: string): string {
  if (raw === undefined || raw === null || raw === '') return '';
  return normalizeSafeAddress(raw, fieldName);
}

/**
 * Resolves and strictly validates a positive EVM chainId (decimal string) from either
 * a Turgalium chain slug, a numeric chainId, or both (ensuring they match when both are provided).
 */
export function normalizeSafeChainId(params: {
  chain?: string;
  chainId?: number | string;
}): { chainId: string; chainNumeric: number; chainName?: string } {
  let resolvedFromSlug: { chainId: number; name: string } | undefined;
  if (params.chain !== undefined && params.chain !== null && params.chain !== '') {
    if (typeof params.chain !== 'string') {
      throw new Error('chain must be a string.');
    }
    const slug = params.chain.trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(EVM_CHAINS, slug)) {
      throw new Error(`Unsupported EVM chain slug: "${params.chain}".`);
    }
    const cfg = EVM_CHAINS[slug as EvmChainId];
    resolvedFromSlug = { chainId: cfg.chainId, name: cfg.name };
  }

  let resolvedFromId: number | undefined;
  if (params.chainId !== undefined && params.chainId !== null && params.chainId !== '') {
    if (typeof params.chainId === 'number') {
      if (!Number.isSafeInteger(params.chainId) || params.chainId <= 0) {
        throw new Error('chainId must be a positive safe integer.');
      }
      resolvedFromId = params.chainId;
    } else if (typeof params.chainId === 'string') {
      const trimmed = params.chainId.trim();
      if (!/^[1-9][0-9]{0,15}$/.test(trimmed)) {
        throw new Error('chainId string must be a positive decimal integer.');
      }
      const parsed = Number(trimmed);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error('chainId exceeds safe integer bounds.');
      }
      resolvedFromId = parsed;
    } else {
      throw new Error('chainId must be a positive integer or decimal string.');
    }
  }

  if (resolvedFromSlug && resolvedFromId !== undefined && resolvedFromSlug.chainId !== resolvedFromId) {
    throw new Error(
      `Mismatched chain (${params.chain} -> ${resolvedFromSlug.chainId}) and chainId (${resolvedFromId}).`
    );
  }

  const finalId = resolvedFromId ?? resolvedFromSlug?.chainId;
  if (!finalId) {
    throw new Error('Either a valid EVM chain or positive chainId is required.');
  }

  return {
    chainId: String(finalId),
    chainNumeric: finalId,
    chainName: resolvedFromSlug?.name,
  };
}

/**
 * Parses a wei value (decimal string, 0x-hex string, non-negative safe integer, or bigint)
 * and outputs the canonical decimal string required by Safe Transaction Builder JSON v1.0.
 */
export function normalizeSafeValueWei(raw: unknown, index: number): string {
  if (raw === undefined || raw === null || raw === '') return '0';

  let parsed: bigint;
  if (typeof raw === 'bigint') {
    parsed = raw;
  } else if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) {
      throw new Error(`transactions[${index}].value must be a non-negative integer.`);
    }
    parsed = BigInt(raw);
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return '0';
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      parsed = BigInt(trimmed);
    } else if (/^[0-9]+$/.test(trimmed)) {
      parsed = BigInt(trimmed);
    } else {
      throw new Error(
        `transactions[${index}].value must be a non-negative decimal or 0x-hex wei string.`
      );
    }
  } else {
    throw new Error(`transactions[${index}].value has unsupported type.`);
  }

  if (parsed < 0n || parsed > MAX_UINT256) {
    throw new Error(`transactions[${index}].value is out of uint256 bounds.`);
  }
  return parsed.toString(10);
}

/**
 * Strictly validates EVM calldata hex (`0x` or `0x`-prefixed even-length hex string).
 */
export function normalizeSafeCalldata(raw: unknown, index: number): string {
  if (raw === undefined || raw === null || raw === '') return '0x';
  if (typeof raw !== 'string') {
    throw new Error(`transactions[${index}].data must be a 0x-prefixed hex string.`);
  }
  const trimmed = raw.trim();
  if (trimmed === '0x' || trimmed === '0X') return '0x';
  if (trimmed.length > MAX_SAFE_CALLDATA_HEX_CHARS + 2) {
    throw new Error(
      `transactions[${index}].data exceeds ${MAX_SAFE_CALLDATA_HEX_CHARS / 2} byte calldata cap.`
    );
  }
  if (!/^0x[0-9a-fA-F]+$/.test(trimmed) || (trimmed.length - 2) % 2 !== 0) {
    throw new Error(
      `transactions[${index}].data must be a valid 0x-prefixed even-length hexadecimal string.`
    );
  }
  return `0x${trimmed.slice(2).toLowerCase()}`;
}

/**
 * Computes a deterministic Safe Transaction Builder keccak256 checksum over the canonical batch payload.
 */
export function computeSafeBatchChecksum(batchWithoutChecksum: {
  version: string;
  chainId: string;
  createdAt: number;
  meta: Omit<SafeBatchMetaV1, 'checksum'>;
  transactions: SafeBatchTransactionV1[];
}): string {
  const serialized = JSON.stringify(batchWithoutChecksum);
  const hash = keccak_256(new TextEncoder().encode(serialized));
  return '0x' + Buffer.from(hash).toString('hex');
}

/**
 * Builds a standard Safe (Gnosis Safe) Transaction Builder JSON v1.0 batch from any
 * Turgalium EVM chain batch (`PreparedChainBatch`) or explicit call list.
 */
export function buildSafeTransactionBatch(input: SafeBatchBuildInput): SafeTransactionBatchV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Safe batch input must be a JSON object.');
  }

  const batchObj = input.batch;
  if (batchObj !== undefined && (batchObj === null || typeof batchObj !== 'object' || Array.isArray(batchObj))) {
    throw new Error('batch must be an object when supplied.');
  }

  const resolvedChain = normalizeSafeChainId({
    chain: input.chain ?? batchObj?.chain,
    chainId: input.chainId ?? batchObj?.chainId,
  });

  const rawCalls = input.calls ?? input.transactions ?? batchObj?.calls;
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) {
    throw new Error('At least one transaction call is required to build a Safe batch.');
  }
  if (rawCalls.length > MAX_SAFE_BATCH_TRANSACTIONS) {
    throw new Error(
      `Safe batch exceeds maximum of ${MAX_SAFE_BATCH_TRANSACTIONS} transactions per export.`
    );
  }

  const transactions: SafeBatchTransactionV1[] = rawCalls.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`transactions[${idx}] must be an object.`);
    }
    const call = item as SafeBatchCallInput;
    const to = normalizeSafeAddress(call.to, `transactions[${idx}].to`);
    const value = normalizeSafeValueWei(call.value, idx);
    const data = normalizeSafeCalldata(call.data, idx);
    return {
      to,
      value,
      data,
      contractMethod: null,
      contractInputsValues: null,
    };
  });

  const createdAt =
    input.createdAt === undefined
      ? Date.now()
      : typeof input.createdAt === 'number' &&
          Number.isSafeInteger(input.createdAt) &&
          input.createdAt > 0
        ? input.createdAt
        : (() => {
            throw new Error('createdAt must be a positive integer epoch timestamp in milliseconds.');
          })();

  const defaultName = resolvedChain.chainName
    ? `Turgalium Sweep — ${resolvedChain.chainName}`
    : `Turgalium Sweep (Chain ${resolvedChain.chainId})`;
  const defaultDesc = `Non-custodial Turgalium sweep batch (${transactions.length} call${transactions.length === 1 ? '' : 's'}) exported for Safe Transaction Builder.`;

  const createdFromSafeAddress = normalizeOptionalSafeAddress(
    input.createdFromSafeAddress ?? batchObj?.userAddress,
    'createdFromSafeAddress'
  );
  const createdFromOwnerAddress = normalizeOptionalSafeAddress(
    input.createdFromOwnerAddress,
    'createdFromOwnerAddress'
  );

  const metaCore: Omit<SafeBatchMetaV1, 'checksum'> = {
    name: sanitizeMetaText(input.name, defaultName, MAX_SAFE_META_NAME_LEN),
    description: sanitizeMetaText(input.description, defaultDesc, MAX_SAFE_META_DESC_LEN),
    txBuilderVersion: sanitizeMetaText(
      input.txBuilderVersion,
      SAFE_TX_BUILDER_APP_VERSION,
      32
    ),
    createdFromSafeAddress,
    createdFromOwnerAddress,
  };

  const checksum = computeSafeBatchChecksum({
    version: SAFE_TX_BUILDER_VERSION,
    chainId: resolvedChain.chainId,
    createdAt,
    meta: metaCore,
    transactions,
  });

  return {
    version: SAFE_TX_BUILDER_VERSION,
    chainId: resolvedChain.chainId,
    createdAt,
    meta: {
      ...metaCore,
      checksum,
    },
    transactions,
  };
}

/**
 * Convenience wrapper to export a Turgalium `PreparedChainBatch` directly as a Safe Transaction Builder JSON v1.0 file.
 */
export function buildSafeTransactionBatchFromPrepared(
  batch: PreparedChainBatch,
  opts: SafeBatchMetaOptions = {}
): SafeTransactionBatchV1 {
  return buildSafeTransactionBatch({
    ...opts,
    batch,
  });
}
