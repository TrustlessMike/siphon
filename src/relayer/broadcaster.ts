import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { EVM_CHAINS } from '../scanner/chains.js';
import { evmJsonRpcCall, isEvmExecutionRevertError } from '../scanner/rpc.js';
import type { EvmChainId } from '../scanner/types.js';

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const PLACEHOLDER_ROUTER_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x00000000000000000000000000000000000051f0',
]);

export type RlpInput = Uint8Array | RlpInput[];

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function encodeLength(len: number, offset: number): Uint8Array {
  if (len < 56) {
    return new Uint8Array([offset + len]);
  }
  const hexLen = len.toString(16);
  const evenHex = hexLen.length % 2 === 0 ? hexLen : '0' + hexLen;
  const lenBytes = Buffer.from(evenHex, 'hex');
  return concatBytes([new Uint8Array([offset + 55 + lenBytes.length]), lenBytes]);
}

/**
 * Minimal canonical RLP encoder (Ethereum Yellow Paper Appendix B) with zero external deps.
 */
export function rlpEncode(input: RlpInput): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0] < 0x80) {
      return input;
    }
    return concatBytes([encodeLength(input.length, 0x80), input]);
  }
  const encodedItems = input.map((item) => rlpEncode(item));
  const payload = concatBytes(encodedItems);
  return concatBytes([encodeLength(payload.length, 0xc0), payload]);
}

function bigintToMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('RLP integer cannot be negative');
  if (value === 0n) return new Uint8Array(0);
  const hex = value.toString(16);
  const evenHex = hex.length % 2 === 0 ? hex : '0' + hex;
  return Buffer.from(evenHex, 'hex');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('Invalid hex string');
  }
  return Buffer.from(clean, 'hex');
}

function normalizePrivateKeyHex(raw: string): Uint8Array | null {
  const trimmed = raw.trim();
  const clean = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  const scalar = BigInt('0x' + clean);
  if (scalar === 0n || scalar >= SECP256K1_N) return null;
  return Buffer.from(clean, 'hex');
}

/**
 * Derives the lowercase 0x EVM address from a 32-byte hex private key.
 */
export function deriveEvmAddressFromPrivateKey(privateKeyHex: string): string {
  const privBytes = normalizePrivateKeyHex(privateKeyHex);
  if (!privBytes) {
    throw new Error('Invalid 32-byte secp256k1 private key.');
  }
  const uncompressed = secp256k1.getPublicKey(privBytes, false); // 65 bytes: 0x04 || X || Y
  const addrBytes = keccak_256(uncompressed.slice(1)).slice(-20);
  return '0x' + Buffer.from(addrBytes).toString('hex');
}

export interface Eip1559TransactionParams {
  chainId: number;
  nonce: number;
  maxPriorityFeePerGasWei: bigint;
  maxFeePerGasWei: bigint;
  gasLimit: bigint;
  to: string;
  valueWei?: bigint;
  data: string;
}

const DEFAULT_CHAIN_MAX_GAS_LIMIT = 15_000_000n;
const HIGH_GAS_PRICE_CHAINS = new Set<EvmChainId>(['ethereum', 'polygon', 'avalanche', 'sonic']);
const DEFAULT_HIGH_CHAIN_MAX_FEE_CAP_WEI = 500_000_000_000n; // 500 gwei
const DEFAULT_L2_CHAIN_MAX_FEE_CAP_WEI = 50_000_000_000n; // 50 gwei

export function getChainRelayerCaps(chain: EvmChainId): {
  maxFeeCapWei: bigint;
  maxGasLimit: bigint;
} {
  const maxFeeCapWei = HIGH_GAS_PRICE_CHAINS.has(chain)
    ? DEFAULT_HIGH_CHAIN_MAX_FEE_CAP_WEI
    : DEFAULT_L2_CHAIN_MAX_FEE_CAP_WEI;
  return {
    maxFeeCapWei,
    maxGasLimit: DEFAULT_CHAIN_MAX_GAS_LIMIT,
  };
}

// Per-(chain, relayerAddress) async mutex queue and local pending-nonce tracker
const relayerNonceQueues = new Map<string, Promise<void>>();
const relayerPendingNonces = new Map<string, number>();

async function withRelayerNonceLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = relayerNonceQueues.get(key) ?? Promise.resolve();
  let releaseLock!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const tail = previous.then(() => current);
  relayerNonceQueues.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    releaseLock();
    if (relayerNonceQueues.get(key) === tail) {
      relayerNonceQueues.delete(key);
    }
  }
}

/**
 * Resets in-memory relayer nonce tracking state (for deterministic tests).
 */
export function resetRelayerNonceTrackerForTest(): void {
  relayerPendingNonces.clear();
  relayerNonceQueues.clear();
}

/**
 * Signs an EIP-1559 (Type-2) Ethereum transaction using `@noble/curves/secp256k1`
 * with strict EIP-2 low-`s` normalization.
 */
export function signEip1559Transaction(
  tx: Eip1559TransactionParams,
  privateKeyHex: string
): {
  rawTransaction: string;
  txHash: string;
  from: string;
  yParity: 0 | 1;
} {
  const privBytes = normalizePrivateKeyHex(privateKeyHex);
  if (!privBytes) {
    throw new Error('Invalid 32-byte secp256k1 private key.');
  }
  if (!Number.isInteger(tx.chainId) || tx.chainId <= 0) {
    throw new Error(`Invalid transaction chainId: ${tx.chainId}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to.trim())) {
    throw new Error(`Invalid transaction destination address: ${tx.to}`);
  }
  if (!Number.isInteger(tx.nonce) || tx.nonce < 0) {
    throw new Error(`Invalid transaction nonce: ${tx.nonce}`);
  }
  const valueWei = tx.valueWei ?? 0n;
  if (valueWei < 0n) {
    throw new Error('Transaction valueWei cannot be negative.');
  }
  if (tx.maxPriorityFeePerGasWei < 0n || tx.maxFeePerGasWei < 0n) {
    throw new Error('Transaction EIP-1559 fee parameters cannot be negative.');
  }
  if (tx.maxPriorityFeePerGasWei > tx.maxFeePerGasWei) {
    throw new Error('Transaction maxPriorityFeePerGasWei cannot exceed maxFeePerGasWei.');
  }
  if (tx.gasLimit <= 0n) {
    throw new Error('Transaction gasLimit must be positive.');
  }

  const from = deriveEvmAddressFromPrivateKey(privateKeyHex);
  const unsignedFields: RlpInput[] = [
    bigintToMinimalBytes(BigInt(tx.chainId)),
    bigintToMinimalBytes(BigInt(tx.nonce)),
    bigintToMinimalBytes(tx.maxPriorityFeePerGasWei),
    bigintToMinimalBytes(tx.maxFeePerGasWei),
    bigintToMinimalBytes(tx.gasLimit),
    hexToBytes(tx.to.trim()),
    bigintToMinimalBytes(valueWei),
    hexToBytes(tx.data.trim()),
    [], // accessList
  ];

  const unsignedPayload = concatBytes([new Uint8Array([0x02]), rlpEncode(unsignedFields)]);
  const signingDigest = keccak_256(unsignedPayload);
  const sig = secp256k1.sign(signingDigest, privBytes, { lowS: true });
  const yParity: 0 | 1 = sig.recovery === 1 ? 1 : 0;

  const signedFields: RlpInput[] = [
    ...unsignedFields,
    bigintToMinimalBytes(BigInt(yParity)),
    bigintToMinimalBytes(sig.r),
    bigintToMinimalBytes(sig.s),
  ];

  const signedPayload = concatBytes([new Uint8Array([0x02]), rlpEncode(signedFields)]);
  const rawTransaction = '0x' + Buffer.from(signedPayload).toString('hex');
  const txHash = '0x' + Buffer.from(keccak_256(signedPayload)).toString('hex');

  return { rawTransaction, txHash, from, yParity };
}

export type RelayerBroadcastReasonCode =
  | 'broadcasted'
  | 'unsupported_chain'
  | 'relayer_key_missing'
  | 'relayer_key_invalid'
  | 'router_unconfigured'
  | 'invalid_calldata'
  | 'invalid_tx_params'
  | 'rpc_error'
  | 'invalid_tx_hash';

export interface RelayerCustomBroadcasterContext {
  chain: EvmChainId;
  chainId: number;
  rawTransaction: string;
  computedTxHash: string;
  from: string;
  to: string;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGasWei: bigint;
  maxPriorityFeePerGasWei: bigint;
  rpcUrls: string[];
}

export interface RelayerBroadcastRequest {
  chain: EvmChainId;
  to: string | null | undefined;
  data: string | null | undefined;
  valueWei?: bigint;
  gasLimit?: bigint;
  maxFeePerGasWei?: bigint;
  maxPriorityFeePerGasWei?: bigint;
  nonce?: number;
  privateKeyHex?: string;
  rpcUrls?: string[];
  timeoutMs?: number;
  /**
   * Optional custom RPC / Flashbots / test broadcaster hook.
   * Must return a real 32-byte 0x transaction hash or throw on failure.
   */
  sendRawTransaction?: (ctx: RelayerCustomBroadcasterContext) => Promise<string>;
  /**
   * Optional JSON-RPC call override (for tests or private RPC transport).
   */
  rpcCall?: typeof evmJsonRpcCall;
}

export interface RelayerBroadcastResult {
  broadcasted: boolean;
  reasonCode: RelayerBroadcastReasonCode;
  diagnostic: string;
  txHash?: string;
  relayerAddress?: string;
  nonce?: number;
  gasLimit?: string;
  maxFeePerGasWei?: string;
  maxPriorityFeePerGasWei?: string;
  rawTransaction?: string;
}

/**
 * Signs and broadcasts a real EIP-1559 transaction from Turgalium's configured relayer key
 * via `eth_sendRawTransaction` (or a custom broadcaster hook such as Flashbots Protect).
 *
 * Fail-closed guarantees:
 *   - NEVER fabricates a transaction hash when keys, router, calldata, or RPC are missing/failing.
 *   - Validates router address is non-zero and non-placeholder (`0x...51F0` rejected).
 *   - Verifies RPC/hook returned a valid 32-byte 0x transaction hash before marking `broadcasted: true`.
 */
export async function broadcastSignedRelayerTx(
  req: RelayerBroadcastRequest
): Promise<RelayerBroadcastResult> {
  const cfg = EVM_CHAINS[req.chain];
  if (!cfg) {
    return {
      broadcasted: false,
      reasonCode: 'unsupported_chain',
      diagnostic: `Unsupported EVM chain "${String(req.chain)}" for relayer broadcast.`,
    };
  }

  const rawKey = (req.privateKeyHex ?? process.env.TURGALIUM_RELAYER_PRIVATE_KEY ?? '').trim();
  if (!rawKey) {
    return {
      broadcasted: false,
      reasonCode: 'relayer_key_missing',
      diagnostic: `TURGALIUM_RELAYER_PRIVATE_KEY is not configured for ${cfg.name}; refusing to broadcast or fabricate a transaction hash.`,
    };
  }

  if (!normalizePrivateKeyHex(rawKey)) {
    return {
      broadcasted: false,
      reasonCode: 'relayer_key_invalid',
      diagnostic: 'TURGALIUM_RELAYER_PRIVATE_KEY is malformed (expected 32-byte 0x hex secp256k1 private key).',
    };
  }

  const to = req.to?.trim() ?? '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || PLACEHOLDER_ROUTER_ADDRESSES.has(to.toLowerCase())) {
    return {
      broadcasted: false,
      reasonCode: 'router_unconfigured',
      diagnostic: `Router/delegate address is unconfigured or placeholder for ${cfg.name}; configure TURGALIUM_ROUTER_${req.chain.toUpperCase()} before broadcasting.`,
    };
  }

  const data = req.data?.trim() ?? '';
  if (!/^0x([0-9a-fA-F]{2})+$/.test(data)) {
    return {
      broadcasted: false,
      reasonCode: 'invalid_calldata',
      diagnostic: `Valid non-empty hex calldata is required to broadcast a sponsored sweep on ${cfg.name}.`,
    };
  }

  const relayerAddress = deriveEvmAddressFromPrivateKey(rawKey);
  const rpcUrls = req.rpcUrls?.length ? req.rpcUrls : cfg.rpcUrls;
  const rpcCall = req.rpcCall ?? evmJsonRpcCall;
  const timeoutMs = req.timeoutMs ?? 6000;
  const valueWei = req.valueWei ?? 0n;
  const { maxFeeCapWei, maxGasLimit } = getChainRelayerCaps(req.chain);

  if (!Number.isInteger(cfg.chainId) || cfg.chainId <= 0) {
    return {
      broadcasted: false,
      relayerAddress,
      reasonCode: 'invalid_tx_params',
      diagnostic: `Invalid chainId (${cfg.chainId}) configured for ${cfg.name}.`,
    };
  }
  if (valueWei < 0n) {
    return {
      broadcasted: false,
      relayerAddress,
      reasonCode: 'invalid_tx_params',
      diagnostic: 'Transaction valueWei cannot be negative.',
    };
  }
  if (req.nonce !== undefined && (!Number.isInteger(req.nonce) || req.nonce < 0)) {
    return {
      broadcasted: false,
      relayerAddress,
      reasonCode: 'invalid_tx_params',
      diagnostic: `Invalid explicit nonce (${String(req.nonce)}): expected a non-negative integer.`,
    };
  }
  if (req.gasLimit !== undefined && (req.gasLimit <= 0n || req.gasLimit > maxGasLimit)) {
    return {
      broadcasted: false,
      relayerAddress,
      reasonCode: 'invalid_tx_params',
      diagnostic: `Transaction gasLimit (${req.gasLimit.toString()}) out of bounds (must be in (0, ${maxGasLimit.toString()}]).`,
    };
  }
  if (req.maxPriorityFeePerGasWei !== undefined && req.maxPriorityFeePerGasWei < 0n) {
    return {
      broadcasted: false,
      relayerAddress,
      reasonCode: 'invalid_tx_params',
      diagnostic: 'maxPriorityFeePerGasWei cannot be negative.',
    };
  }
  if (req.maxFeePerGasWei !== undefined) {
    if (req.maxFeePerGasWei < 0n || req.maxFeePerGasWei > maxFeeCapWei) {
      return {
        broadcasted: false,
        relayerAddress,
        reasonCode: 'invalid_tx_params',
        diagnostic: `maxFeePerGasWei (${req.maxFeePerGasWei.toString()}) exceeds ${cfg.name} safety cap (${maxFeeCapWei.toString()} wei).`,
      };
    }
    if (req.maxPriorityFeePerGasWei !== undefined && req.maxPriorityFeePerGasWei > req.maxFeePerGasWei) {
      return {
        broadcasted: false,
        relayerAddress,
        reasonCode: 'invalid_tx_params',
        diagnostic: 'maxPriorityFeePerGasWei cannot exceed maxFeePerGasWei.',
      };
    }
  }

  const lockKey = `${req.chain}:${relayerAddress.toLowerCase()}`;

  return withRelayerNonceLock(lockKey, async (): Promise<RelayerBroadcastResult> => {
    try {
      // 1. Resolve relayer pending nonce under per-(chain, relayerAddress) lock
      let nonce = req.nonce;
      if (nonce === undefined) {
        const nonceRes = await rpcCall<string>(
          rpcUrls,
          'eth_getTransactionCount',
          [relayerAddress, 'pending'],
          timeoutMs
        );
        if (nonceRes.error || !nonceRes.result) {
          return {
            broadcasted: false,
            relayerAddress,
            reasonCode: 'rpc_error',
            diagnostic: `Failed to fetch relayer nonce on ${cfg.name}: ${nonceRes.error?.message ?? 'empty RPC result'}.`,
          };
        }
        const rpcNonce = Number(BigInt(nonceRes.result));
        const localNext = relayerPendingNonces.get(lockKey);
        nonce = localNext !== undefined && localNext > rpcNonce ? localNext : rpcNonce;
      }

      // 2. Resolve EIP-1559 gas pricing with strict cap & priority invariants
      let maxPriorityFeePerGasWei = req.maxPriorityFeePerGasWei;
      let maxFeePerGasWei = req.maxFeePerGasWei;

      if (maxFeePerGasWei === undefined || maxPriorityFeePerGasWei === undefined) {
        const gasPriceRes = await rpcCall<string>(rpcUrls, 'eth_gasPrice', [], timeoutMs);
        if (gasPriceRes.error || !gasPriceRes.result) {
          return {
            broadcasted: false,
            relayerAddress,
            nonce,
            reasonCode: 'rpc_error',
            diagnostic: `Failed to fetch gas price on ${cfg.name}: ${gasPriceRes.error?.message ?? 'empty RPC result'}.`,
          };
        }
        const baseGasPrice = BigInt(gasPriceRes.result);
        if (maxPriorityFeePerGasWei === undefined) {
          try {
            const prioRes = await rpcCall<string>(rpcUrls, 'eth_maxPriorityFeePerGas', [], timeoutMs);
            maxPriorityFeePerGasWei =
              prioRes.result && BigInt(prioRes.result) > 0n
                ? BigInt(prioRes.result)
                : baseGasPrice / 10n > 100_000_000n
                ? baseGasPrice / 10n
                : 100_000_000n;
          } catch {
            maxPriorityFeePerGasWei = 100_000_000n; // 0.1 gwei fallback
          }
        }
        if (maxFeePerGasWei === undefined) {
          const buffered = (baseGasPrice * 130n) / 100n + maxPriorityFeePerGasWei;
          maxFeePerGasWei = buffered > maxPriorityFeePerGasWei ? buffered : maxPriorityFeePerGasWei;
        }
        // Clamp RPC-derived priority fee if it exceeds resolved/explicit maxFeePerGasWei
        if (req.maxPriorityFeePerGasWei === undefined && maxPriorityFeePerGasWei > maxFeePerGasWei) {
          maxPriorityFeePerGasWei = maxFeePerGasWei;
        }
      }

      if (
        maxPriorityFeePerGasWei < 0n ||
        maxFeePerGasWei < 0n ||
        maxPriorityFeePerGasWei > maxFeePerGasWei
      ) {
        return {
          broadcasted: false,
          relayerAddress,
          nonce,
          reasonCode: 'invalid_tx_params',
          diagnostic: `Invalid EIP-1559 fee bounds on ${cfg.name}: priority=${maxPriorityFeePerGasWei.toString()}, maxFee=${maxFeePerGasWei.toString()}.`,
        };
      }
      if (maxFeePerGasWei > maxFeeCapWei) {
        return {
          broadcasted: false,
          relayerAddress,
          nonce,
          reasonCode: 'invalid_tx_params',
          diagnostic: `Resolved maxFeePerGasWei (${maxFeePerGasWei.toString()}) exceeds ${cfg.name} safety cap (${maxFeeCapWei.toString()} wei).`,
        };
      }

      // 3. Resolve gasLimit with 25% safety buffer and strict upper cap
      let gasLimit = req.gasLimit;
      if (gasLimit === undefined) {
        const estRes = await rpcCall<string>(
          rpcUrls,
          'eth_estimateGas',
          [
            {
              from: relayerAddress,
              to,
              data,
              value: '0x' + valueWei.toString(16),
            },
          ],
          timeoutMs
        );
        if (estRes.error || !estRes.result) {
          const revertNote = isEvmExecutionRevertError(estRes.error) ? ' (EVM execution reverted)' : '';
          return {
            broadcasted: false,
            relayerAddress,
            nonce,
            reasonCode: 'rpc_error',
            diagnostic: `Gas estimation failed on ${cfg.name}${revertNote}: ${estRes.error?.message ?? 'empty RPC result'}.`,
          };
        }
        const estimated = BigInt(estRes.result);
        gasLimit = (estimated * 125n) / 100n;
      }

      if (gasLimit <= 0n || gasLimit > maxGasLimit) {
        return {
          broadcasted: false,
          relayerAddress,
          nonce,
          reasonCode: 'invalid_tx_params',
          diagnostic: `Resolved gasLimit (${gasLimit.toString()}) out of bounds (must be in (0, ${maxGasLimit.toString()}]).`,
        };
      }

      // 4. Sign EIP-1559 transaction
      const signed = signEip1559Transaction(
        {
          chainId: cfg.chainId,
          nonce,
          maxPriorityFeePerGasWei,
          maxFeePerGasWei,
          gasLimit,
          to,
          valueWei,
          data,
        },
        rawKey
      );

      // 5. Broadcast via custom hook or eth_sendRawTransaction
      let broadcastTxHash: string | undefined;
      if (req.sendRawTransaction) {
        broadcastTxHash = await req.sendRawTransaction({
          chain: req.chain,
          chainId: cfg.chainId,
          rawTransaction: signed.rawTransaction,
          computedTxHash: signed.txHash,
          from: relayerAddress,
          to,
          nonce,
          gasLimit,
          maxFeePerGasWei,
          maxPriorityFeePerGasWei,
          rpcUrls,
        });
      } else {
        const sendRes = await rpcCall<string>(
          rpcUrls,
          'eth_sendRawTransaction',
          [signed.rawTransaction],
          timeoutMs
        );
        if (sendRes.error || !sendRes.result) {
          return {
            broadcasted: false,
            relayerAddress,
            nonce,
            gasLimit: gasLimit.toString(),
            maxFeePerGasWei: maxFeePerGasWei.toString(),
            maxPriorityFeePerGasWei: maxPriorityFeePerGasWei.toString(),
            reasonCode: 'rpc_error',
            diagnostic: `eth_sendRawTransaction rejected on ${cfg.name}: ${sendRes.error?.message ?? 'empty RPC result'}.`,
          };
        }
        broadcastTxHash = sendRes.result;
      }

      const cleanHash = typeof broadcastTxHash === 'string' ? broadcastTxHash.trim() : '';
      if (!/^0x[0-9a-fA-F]{64}$/.test(cleanHash)) {
        return {
          broadcasted: false,
          relayerAddress,
          nonce,
          reasonCode: 'invalid_tx_hash',
          diagnostic: `Relayer RPC/broadcaster returned an invalid transaction hash ("${cleanHash}"); refusing to mark broadcast.`,
        };
      }

      // Advance local pending-nonce tracker strictly after broadcast succeeded
      const prevLocal = relayerPendingNonces.get(lockKey) ?? 0;
      if (nonce + 1 > prevLocal) {
        relayerPendingNonces.set(lockKey, nonce + 1);
      }

      return {
        broadcasted: true,
        reasonCode: 'broadcasted',
        txHash: cleanHash,
        relayerAddress,
        nonce,
        gasLimit: gasLimit.toString(),
        maxFeePerGasWei: maxFeePerGasWei.toString(),
        maxPriorityFeePerGasWei: maxPriorityFeePerGasWei.toString(),
        rawTransaction: signed.rawTransaction,
        diagnostic: `Signed EIP-1559 transaction broadcast on ${cfg.name} from ${relayerAddress} (nonce ${nonce}).`,
      };
    } catch (err) {
      return {
        broadcasted: false,
        relayerAddress,
        reasonCode: 'rpc_error',
        diagnostic: `Relayer broadcast failed on ${cfg.name}: ${err instanceof Error ? err.message : String(err)}.`,
      };
    }
  });
}
