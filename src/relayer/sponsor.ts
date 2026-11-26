import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { deriveSolanaUsdcAta, solanaOwnerToUsdcAtaBytes32 } from '../bridge/cctp.js';
import { EVM_CHAINS, getProtocolFeeConfig } from '../scanner/chains.js';
import { isEip2612Token } from '../scanner/discovery.js';
import { computeRelayerBreakEven, RELAYER_BREAK_EVEN_MULTIPLIER } from '../scanner/roi.js';
import type { EvmChainId, ScannedAsset } from '../scanner/types.js';
import type { TurgaliumStateStore } from '../storage/state-store.js';
import {
  broadcastSignedRelayerTx,
  type RelayerBroadcastResult,
  type RelayerCustomBroadcasterContext,
} from './broadcaster.js';
import type { evmJsonRpcCall } from '../scanner/rpc.js';

export const CANONICAL_PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// EIP-2 secp256k1 half-order (matches TurgaliumSweepDelegate.SECP256K1N_HALF)
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

// Exact EIP-712 type strings matching contracts/TurgaliumRouter.sol and contracts/TurgaliumSweepDelegate.sol
export const PERMIT2_DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,uint256 chainId,address verifyingContract)';
export const DELEGATE_DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
export const TOKEN_PERMISSIONS_TYPE_STRING = 'TokenPermissions(address token,uint256 amount)';
export const TURGALIUM_WITNESS_TYPE_STRING =
  'TurgaliumSweepWitness(bytes32 solanaRecipient,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint16 feeBps,address feeRecipient,bytes32 swapsHash)';
export const PERMIT_BATCH_WITNESS_TYPE_STRING =
  'PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,TurgaliumSweepWitness witness)' +
  TOKEN_PERMISSIONS_TYPE_STRING +
  TURGALIUM_WITNESS_TYPE_STRING;
export const SWEEP_INTENT_TYPE_STRING =
  'SweepIntent(bytes32 solanaRecipient,address usdc,address cctpMessenger,address feeRecipient,uint16 feeBps,uint256 directUsdcAmount,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint256 nonce,uint256 deadline,bytes32 callsHash)';

const MAX_ISSUED_INTENTS = 2000;
const MAX_CONSUMED_DIGESTS = 10_000;

interface TrackedGaslessIntent {
  intentId: string;
  mode: 'permit2_batch' | 'eip7702_delegate';
  chain: EvmChainId;
  chainId: number;
  userAddress: string;
  routerAddress: string | null;
  solanaRecipient: string;
  feeRecipient: string | null;
  feeBps: number;
  nonce: string;
  minNetUsdcOut: string;
  maxGasReimbursementUsdc: string;
  swapsHash?: string;
  callsHash?: string;
  directUsdcAmount?: string;
  usdcAddress?: string;
  cctpMessenger?: string | null;
  deadline: number;
  eligible: boolean;
  rejectionReason?: string;
  routerConfigured: boolean;
  previewOnly: boolean;
  eip712Digest: string | null;
  consumed: boolean;
  createdAt: number;
  txHash?: string;
}

interface ConsumedDigestRecord {
  digest: string;
  intentId: string;
  chain: EvmChainId;
  consumedAt: number;
  deadline: number;
}

interface PersistedGaslessIntentState {
  intents: TrackedGaslessIntent[];
  consumedDigests: ConsumedDigestRecord[];
}

const issuedIntents = new Map<string, TrackedGaslessIntent>();
const consumedDigests = new Map<string, ConsumedDigestRecord>();
const broadcastingIntentIds = new Set<string>();
let activeIntentStateStore: TurgaliumStateStore | null = null;

function hydrateGaslessIntentsFromStore(store: TurgaliumStateStore): void {
  const saved = store.load<PersistedGaslessIntentState>('gasless_intents', {
    intents: [],
    consumedDigests: [],
  });
  issuedIntents.clear();
  consumedDigests.clear();
  if (saved && Array.isArray(saved.intents)) {
    for (const item of saved.intents) {
      if (item && typeof item.intentId === 'string') {
        issuedIntents.set(item.intentId, item);
      }
    }
  }
  if (saved && Array.isArray(saved.consumedDigests)) {
    for (const rec of saved.consumedDigests) {
      if (rec && typeof rec.digest === 'string') {
        consumedDigests.set(rec.digest.toLowerCase(), rec);
      }
    }
  }
}

function persistGaslessIntents(store: TurgaliumStateStore | null = activeIntentStateStore): void {
  if (!store) return;
  store.save<PersistedGaslessIntentState>('gasless_intents', {
    intents: Array.from(issuedIntents.values()),
    consumedDigests: Array.from(consumedDigests.values()),
  });
}

/**
 * Configures a pluggable `TurgaliumStateStore` for gasless intent tracking and
 * replay-protected consumed EIP-712 digests, immediately hydrating persisted state.
 */
export function configureGaslessIntentStore(store: TurgaliumStateStore | null): void {
  activeIntentStateStore = store;
  if (store) {
    hydrateGaslessIntentsFromStore(store);
  }
}

/**
 * Returns true if the given 32-byte EIP-712 digest has already been consumed.
 */
export function isGaslessDigestConsumed(digest: string): boolean {
  return consumedDigests.has(digest.trim().toLowerCase());
}

function keccakHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(keccak_256(bytes)).toString('hex');
}

function keccakUtf8(text: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(text));
}

function encodeWordUint(value: bigint | number | string): Uint8Array {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  if (big < 0n) throw new Error('ABI uint word cannot be negative');
  if (big >= 1n << 256n) throw new Error('ABI uint word exceeds uint256 max');
  return Buffer.from(big.toString(16).padStart(64, '0'), 'hex');
}

function selectorFromSignature(sig: string): string {
  return '0x' + Buffer.from(keccakUtf8(sig).slice(0, 4)).toString('hex');
}

// Exact Solidity ABI 4-byte selectors for TurgaliumRouter & TurgaliumSweepDelegate sponsored entrypoints
export const RELAYER_ALLOWED_SELECTORS = {
  sweepWithPermit2Batch: selectorFromSignature(
    'sweepWithPermit2Batch(address,((address,uint256)[],uint256,uint256),(bytes32,uint256,uint256,uint16,address,bytes32),bytes,uint256,(address,uint256,bool,address,bytes)[])'
  ),
  executeSponsoredSweep: selectorFromSignature(
    'executeSponsoredSweep((bytes32,address,address,address,uint16,uint256,uint256,uint256,uint256,uint256,(uint8,address,address,uint256)[],(address,uint256,uint256,address,bytes)[],(address,uint256)[],(address,address)[]),uint256,uint8,bytes32,bytes32)'
  ),
  executeSponsoredSweepV2: selectorFromSignature(
    'executeSponsoredSweepV2((bytes32,address,address,address,uint16,uint256,uint256,uint256,uint256,uint256,(uint8,address,address,uint256)[],(address,uint256,uint256,address,bytes)[],(address,uint256)[],(address,address)[]),uint256,(bytes32,uint256,uint32,bytes),uint256,uint8,bytes32,bytes32)'
  ),
} as const;

function readAbiWord(argsHex: string, byteOffset: number): string | null {
  const charOffset = byteOffset * 2;
  if (!Number.isSafeInteger(charOffset) || charOffset < 0 || charOffset + 64 > argsHex.length) {
    return null;
  }
  return argsHex.slice(charOffset, charOffset + 64);
}

function readAbiUint(argsHex: string, byteOffset: number): bigint | null {
  const word = readAbiWord(argsHex, byteOffset);
  if (!word) return null;
  return BigInt('0x' + word);
}

function readAbiAddress(argsHex: string, byteOffset: number): string | null {
  const word = readAbiWord(argsHex, byteOffset);
  if (!word || !word.startsWith('0'.repeat(24))) return null;
  return '0x' + word.slice(24).toLowerCase();
}

function readAbiOffset(argsHex: string, byteOffset: number, baseByteOffset = 0): number | null {
  const raw = readAbiUint(argsHex, byteOffset);
  if (raw === null) return null;
  const maxBytes = BigInt(argsHex.length / 2);
  const abs = BigInt(baseByteOffset) + raw;
  if (abs < 0n || abs > maxBytes) return null;
  return Number(abs);
}

/**
 * Verifies that client-supplied `txCalldata` strictly matches the persisted server intent's
 * allowed contract selector, user address, witness/intent parameters, nonce, deadline,
 * gas reimbursement cap, and verified user EIP-712 signature. Fails closed on any mismatch.
 */
export function verifyRelayerCalldataMatchesIntent(
  tracked: Pick<
    TrackedGaslessIntent,
    | 'mode'
    | 'userAddress'
    | 'solanaRecipient'
    | 'feeRecipient'
    | 'feeBps'
    | 'nonce'
    | 'deadline'
    | 'minNetUsdcOut'
    | 'maxGasReimbursementUsdc'
    | 'swapsHash'
    | 'callsHash'
    | 'directUsdcAmount'
    | 'usdcAddress'
    | 'cctpMessenger'
  >,
  txCalldata: string,
  signature: string
): { ok: true; selector: string } | { ok: false; reason: string } {
  if (typeof txCalldata !== 'string') {
    return { ok: false, reason: 'txCalldata must be a 0x-prefixed hex string.' };
  }
  const clean = txCalldata.trim();
  if (!/^0x([0-9a-fA-F]{2}){4,}$/.test(clean)) {
    return { ok: false, reason: 'txCalldata must be valid even-length hex with a 4-byte function selector.' };
  }
  const lower = clean.toLowerCase();
  const selector = lower.slice(0, 10);
  const argsHex = lower.slice(10);
  const cleanSig = signature.trim().toLowerCase();

  if (tracked.mode === 'permit2_batch') {
    if (selector !== RELAYER_ALLOWED_SELECTORS.sweepWithPermit2Batch) {
      return {
        ok: false,
        reason: `Calldata selector ${selector} does not match expected TurgaliumRouter.sweepWithPermit2Batch (${RELAYER_ALLOWED_SELECTORS.sweepWithPermit2Batch}).`,
      };
    }
    // Head layout (11 words = 352 bytes):
    // 0: address user
    // 1: offset -> permit (PermitBatchTransferFrom)
    // 2..7: inline static TurgaliumSweepWitness (solanaRecipient, minNetUsdcOut, maxGasReimbursementUsdc, feeBps, feeRecipient, swapsHash)
    // 8: offset -> bytes permitSignature
    // 9: uint256 gasReimbursementUsdc
    // 10: offset -> SwapStep[] swaps
    const userAddr = readAbiAddress(argsHex, 0);
    if (!userAddr || userAddr !== tracked.userAddress.toLowerCase()) {
      return { ok: false, reason: 'txCalldata user parameter does not match persisted intent userAddress.' };
    }

    const permitOff = readAbiOffset(argsHex, 32);
    if (permitOff === null) {
      return { ok: false, reason: 'txCalldata permit offset is out of bounds.' };
    }
    const permitNonce = readAbiUint(argsHex, permitOff + 32);
    const permitDeadline = readAbiUint(argsHex, permitOff + 64);
    if (permitNonce === null || permitNonce.toString() !== tracked.nonce) {
      return { ok: false, reason: 'txCalldata permit.nonce does not match persisted intent nonce.' };
    }
    if (permitDeadline === null || permitDeadline !== BigInt(tracked.deadline)) {
      return { ok: false, reason: 'txCalldata permit.deadline does not match persisted intent deadline.' };
    }

    const witnessSolana = readAbiWord(argsHex, 64);
    const witnessMinNet = readAbiUint(argsHex, 96);
    const witnessMaxGas = readAbiUint(argsHex, 128);
    const witnessFeeBps = readAbiUint(argsHex, 160);
    const witnessFeeRecipient = readAbiAddress(argsHex, 192);
    const witnessSwapsHash = readAbiWord(argsHex, 224);

    if (!witnessSolana || '0x' + witnessSolana !== tracked.solanaRecipient.toLowerCase()) {
      return { ok: false, reason: 'txCalldata witness.solanaRecipient does not match persisted intent.' };
    }
    if (witnessMinNet === null || witnessMinNet.toString() !== tracked.minNetUsdcOut) {
      return { ok: false, reason: 'txCalldata witness.minNetUsdcOut does not match persisted intent.' };
    }
    if (witnessMaxGas === null || witnessMaxGas.toString() !== tracked.maxGasReimbursementUsdc) {
      return { ok: false, reason: 'txCalldata witness.maxGasReimbursementUsdc does not match persisted intent.' };
    }
    if (witnessFeeBps === null || witnessFeeBps !== BigInt(tracked.feeBps)) {
      return { ok: false, reason: 'txCalldata witness.feeBps does not match persisted intent.' };
    }
    if (!tracked.feeRecipient || !witnessFeeRecipient || witnessFeeRecipient !== tracked.feeRecipient.toLowerCase()) {
      return { ok: false, reason: 'txCalldata witness.feeRecipient does not match persisted intent.' };
    }
    if (tracked.swapsHash && (!witnessSwapsHash || '0x' + witnessSwapsHash !== tracked.swapsHash.toLowerCase())) {
      return { ok: false, reason: 'txCalldata witness.swapsHash does not match persisted intent.' };
    }

    const sigOff = readAbiOffset(argsHex, 256);
    if (sigOff === null) {
      return { ok: false, reason: 'txCalldata permitSignature offset is out of bounds.' };
    }
    const sigLen = readAbiUint(argsHex, sigOff);
    if (sigLen !== 65n) {
      return { ok: false, reason: 'txCalldata permitSignature must be 65 bytes.' };
    }
    const sigCharStart = (sigOff + 32) * 2;
    if (sigCharStart + 130 > argsHex.length) {
      return { ok: false, reason: 'txCalldata permitSignature bytes truncated.' };
    }
    const embeddedSig = '0x' + argsHex.slice(sigCharStart, sigCharStart + 130);
    if (embeddedSig !== cleanSig) {
      return { ok: false, reason: 'txCalldata permitSignature does not match verified user signature.' };
    }

    const gasReimb = readAbiUint(argsHex, 288);
    if (gasReimb === null || gasReimb > BigInt(tracked.maxGasReimbursementUsdc)) {
      return { ok: false, reason: 'txCalldata gasReimbursementUsdc exceeds persisted intent cap.' };
    }

    const swapsOff = readAbiOffset(argsHex, 320);
    if (swapsOff === null || readAbiUint(argsHex, swapsOff) === null) {
      return { ok: false, reason: 'txCalldata swaps array offset is out of bounds.' };
    }

    return { ok: true, selector };
  }

  // eip7702_delegate mode: allow executeSponsoredSweep or executeSponsoredSweepV2
  const isV1 = selector === RELAYER_ALLOWED_SELECTORS.executeSponsoredSweep;
  const isV2 = selector === RELAYER_ALLOWED_SELECTORS.executeSponsoredSweepV2;
  if (!isV1 && !isV2) {
    return {
      ok: false,
      reason: `Calldata selector ${selector} does not match expected TurgaliumSweepDelegate.executeSponsoredSweep or executeSponsoredSweepV2.`,
    };
  }

  const intentOff = readAbiOffset(argsHex, 0);
  if (intentOff === null) {
    return { ok: false, reason: 'txCalldata SweepIntent offset is out of bounds.' };
  }

  const gasReimbOffset = isV1 ? 32 : 96;
  const vOffset = isV1 ? 64 : 128;
  const rOffset = isV1 ? 96 : 160;
  const sOffset = isV1 ? 128 : 192;

  const gasReimb = readAbiUint(argsHex, gasReimbOffset);
  if (gasReimb === null || gasReimb > BigInt(tracked.maxGasReimbursementUsdc)) {
    return { ok: false, reason: 'txCalldata gasReimbursementUsdc exceeds persisted intent cap.' };
  }

  const vWord = readAbiUint(argsHex, vOffset);
  const rWord = readAbiWord(argsHex, rOffset);
  const sWord = readAbiWord(argsHex, sOffset);
  if (vWord === null || !rWord || !sWord) {
    return { ok: false, reason: 'txCalldata ECDSA (v, r, s) words are truncated.' };
  }
  const expectedR = cleanSig.slice(2, 66);
  const expectedS = cleanSig.slice(66, 130);
  const expectedV = BigInt('0x' + cleanSig.slice(130, 132));
  if (vWord !== expectedV || rWord !== expectedR || sWord !== expectedS) {
    return { ok: false, reason: 'txCalldata (v, r, s) signature does not match verified user signature.' };
  }

  const intentSolana = readAbiWord(argsHex, intentOff);
  const intentUsdc = readAbiAddress(argsHex, intentOff + 32);
  const intentMessenger = readAbiAddress(argsHex, intentOff + 64);
  const intentFeeRecipient = readAbiAddress(argsHex, intentOff + 96);
  const intentFeeBps = readAbiUint(argsHex, intentOff + 128);
  const intentDirectUsdc = readAbiUint(argsHex, intentOff + 160);
  const intentMinNet = readAbiUint(argsHex, intentOff + 192);
  const intentMaxGas = readAbiUint(argsHex, intentOff + 224);
  const intentNonce = readAbiUint(argsHex, intentOff + 256);
  const intentDeadline = readAbiUint(argsHex, intentOff + 288);

  if (!intentSolana || '0x' + intentSolana !== tracked.solanaRecipient.toLowerCase()) {
    return { ok: false, reason: 'txCalldata intent.solanaRecipient does not match persisted intent.' };
  }
  if (tracked.usdcAddress && (!intentUsdc || intentUsdc !== tracked.usdcAddress.toLowerCase())) {
    return { ok: false, reason: 'txCalldata intent.usdc does not match persisted intent.' };
  }
  if (tracked.cctpMessenger && (!intentMessenger || intentMessenger !== tracked.cctpMessenger.toLowerCase())) {
    return { ok: false, reason: 'txCalldata intent.cctpMessenger does not match persisted intent.' };
  }
  if (!tracked.feeRecipient || !intentFeeRecipient || intentFeeRecipient !== tracked.feeRecipient.toLowerCase()) {
    return { ok: false, reason: 'txCalldata intent.feeRecipient does not match persisted intent.' };
  }
  if (intentFeeBps === null || intentFeeBps !== BigInt(tracked.feeBps)) {
    return { ok: false, reason: 'txCalldata intent.feeBps does not match persisted intent.' };
  }
  if (tracked.directUsdcAmount !== undefined && (intentDirectUsdc === null || intentDirectUsdc.toString() !== tracked.directUsdcAmount)) {
    return { ok: false, reason: 'txCalldata intent.directUsdcAmount does not match persisted intent.' };
  }
  if (intentMinNet === null || intentMinNet.toString() !== tracked.minNetUsdcOut) {
    return { ok: false, reason: 'txCalldata intent.minNetUsdcOut does not match persisted intent.' };
  }
  if (intentMaxGas === null || intentMaxGas.toString() !== tracked.maxGasReimbursementUsdc) {
    return { ok: false, reason: 'txCalldata intent.maxGasReimbursementUsdc does not match persisted intent.' };
  }
  if (intentNonce === null || intentNonce.toString() !== tracked.nonce) {
    return { ok: false, reason: 'txCalldata intent.nonce does not match persisted intent.' };
  }
  if (intentDeadline === null || intentDeadline !== BigInt(tracked.deadline)) {
    return { ok: false, reason: 'txCalldata intent.deadline does not match persisted intent.' };
  }

  return { ok: true, selector };
}

/**
 * Encodes valid `TurgaliumRouter.sweepWithPermit2Batch(...)` calldata bound to a prepared
 * `GaslessSweepIntentPlan` and verified user EIP-712 signature (with empty swaps array by default).
 */
export function encodePermit2SweepCalldata(params: {
  plan: GaslessSweepIntentPlan;
  signature: string;
  gasReimbursementUsdc?: bigint | string;
}): string {
  if (params.plan.mode !== 'permit2_batch') {
    throw new Error('encodePermit2SweepCalldata requires a permit2_batch intent plan.');
  }
  if (!params.plan.feeRecipientEvm) {
    throw new Error('Intent plan missing feeRecipientEvm.');
  }
  const cleanSig = params.signature.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{130}$/.test(cleanSig)) {
    throw new Error('Invalid 65-byte Permit2 signature.');
  }
  const gasReimb = BigInt(params.gasReimbursementUsdc ?? 0n);
  const permitted = params.plan.coveredAssets;

  // Dynamic section 1: permit = (TokenPermissions[] permitted, uint256 nonce, uint256 deadline)
  const permitBytes = concatBytes([
    encodeWordUint(96n), // offset to permitted[] inside permit tuple (3 words)
    encodeWordUint(params.plan.nonce),
    encodeWordUint(params.plan.deadline),
    encodeWordUint(permitted.length),
    ...permitted.flatMap((a) => [encodeWordAddress(a.address), encodeWordUint(a.rawBalance)]),
  ]);

  // Dynamic section 2: bytes permitSignature (65 bytes padded to 96 bytes)
  const sigPadded = Buffer.from(cleanSig.padEnd(192, '0'), 'hex');
  const sigBytes = concatBytes([encodeWordUint(65n), sigPadded]);

  // Dynamic section 3: empty SwapStep[] swaps
  const swapsBytes = encodeWordUint(0n);

  const headSizeBytes = 11 * 32; // 352 bytes
  const permitOffset = BigInt(headSizeBytes);
  const sigOffset = permitOffset + BigInt(permitBytes.length);
  const swapsOffset = sigOffset + BigInt(sigBytes.length);

  const encoded = concatBytes([
    encodeWordAddress(params.plan.userAddress),
    encodeWordUint(permitOffset),
    encodeWordBytes32(params.plan.solanaMintRecipientBytes32),
    encodeWordUint(params.plan.minNetUsdcOut),
    encodeWordUint(params.plan.maxGasReimbursementUsdc),
    encodeWordUint(params.plan.protocolFeeBps),
    encodeWordAddress(params.plan.feeRecipientEvm),
    encodeWordBytes32(params.plan.swapsHash ?? computeEmptySwapsHash()),
    encodeWordUint(sigOffset),
    encodeWordUint(gasReimb),
    encodeWordUint(swapsOffset),
    permitBytes,
    sigBytes,
    swapsBytes,
  ]);

  return RELAYER_ALLOWED_SELECTORS.sweepWithPermit2Batch + Buffer.from(encoded).toString('hex');
}

function encodeWordAddress(addr: string): Uint8Array {
  const clean = addr.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address for EIP-712 encoding: ${addr}`);
  }
  return Buffer.from(clean.padStart(64, '0'), 'hex');
}

function encodeWordBytes32(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`Invalid bytes32 for EIP-712 encoding: ${hex}`);
  }
  return Buffer.from(clean, 'hex');
}

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

/**
 * Computes Solidity-identical `keccak256(abi.encode(defiExits, swaps, burns, revokes))`
 * matching `TurgaliumSweepDelegate.computeCallsHash` for empty call arrays (or custom pre-encoded calls).
 */
export function computeEmptySweepCallsHash(): string {
  // abi.encode(empty[], empty[], empty[], empty[]):
  // 4 head offsets (0x80, 0xa0, 0xc0, 0xe0) followed by 4 zero lengths (0, 0, 0, 0)
  const encoded = concatBytes([
    encodeWordUint(0x80n),
    encodeWordUint(0xa0n),
    encodeWordUint(0xc0n),
    encodeWordUint(0xe0n),
    encodeWordUint(0n),
    encodeWordUint(0n),
    encodeWordUint(0n),
    encodeWordUint(0n),
  ]);
  return keccakHex(encoded);
}

/**
 * Computes Solidity-identical `keccak256(abi.encode(swaps))` for an empty `SwapStep[]` array,
 * matching `TurgaliumRouter.sweepWithPermit2Batch` witness `swapsHash`.
 */
export function computeEmptySwapsHash(): string {
  // abi.encode(empty[]): head offset 0x20 + zero length 0
  const encoded = concatBytes([encodeWordUint(0x20n), encodeWordUint(0n)]);
  return keccakHex(encoded);
}

/**
 * Computes the exact EIP-712 signing digest (`\x19\x01 || domainSeparator || structHash`)
 * for Turgalium's `PermitBatchWitnessTransferFrom` or `SweepIntent` typed data.
 */
export function computeGaslessIntentEip712Digest(typedData: Record<string, unknown>): string {
  const primaryType = typedData.primaryType as string;
  const domain = typedData.domain as Record<string, unknown>;
  const message = typedData.message as Record<string, unknown>;

  if (primaryType === 'PermitBatchWitnessTransferFrom') {
    const domainTypeHash = keccakUtf8(PERMIT2_DOMAIN_TYPE_STRING);
    const domainSeparator = keccak_256(
      concatBytes([
        domainTypeHash,
        keccakUtf8(String(domain.name)),
        encodeWordUint(Number(domain.chainId)),
        encodeWordAddress(String(domain.verifyingContract)),
      ])
    );

    const tokenPermTypeHash = keccakUtf8(TOKEN_PERMISSIONS_TYPE_STRING);
    const permitted = (message.permitted as Array<{ token: string; amount: string }>) ?? [];
    const permHashes = permitted.map((p) =>
      keccak_256(concatBytes([tokenPermTypeHash, encodeWordAddress(p.token), encodeWordUint(p.amount)]))
    );
    const permittedHash = keccak_256(concatBytes(permHashes));

    const witness = message.witness as Record<string, unknown>;
    const witnessTypeHash = keccakUtf8(TURGALIUM_WITNESS_TYPE_STRING);
    const witnessHash = keccak_256(
      concatBytes([
        witnessTypeHash,
        encodeWordBytes32(String(witness.solanaRecipient)),
        encodeWordUint(String(witness.minNetUsdcOut)),
        encodeWordUint(String(witness.maxGasReimbursementUsdc)),
        encodeWordUint(Number(witness.feeBps)),
        encodeWordAddress(String(witness.feeRecipient)),
        encodeWordBytes32(String(witness.swapsHash)),
      ])
    );

    const permitTypeHash = keccakUtf8(PERMIT_BATCH_WITNESS_TYPE_STRING);
    const structHash = keccak_256(
      concatBytes([
        permitTypeHash,
        permittedHash,
        encodeWordAddress(String(message.spender)),
        encodeWordUint(String(message.nonce)),
        encodeWordUint(String(message.deadline)),
        witnessHash,
      ])
    );

    return keccakHex(concatBytes([new Uint8Array([0x19, 0x01]), domainSeparator, structHash]));
  }

  if (primaryType === 'SweepIntent') {
    const domainTypeHash = keccakUtf8(DELEGATE_DOMAIN_TYPE_STRING);
    const domainSeparator = keccak_256(
      concatBytes([
        domainTypeHash,
        keccakUtf8(String(domain.name)),
        keccakUtf8(String(domain.version)),
        encodeWordUint(Number(domain.chainId)),
        encodeWordAddress(String(domain.verifyingContract)),
      ])
    );

    const intentTypeHash = keccakUtf8(SWEEP_INTENT_TYPE_STRING);
    const structHash = keccak_256(
      concatBytes([
        intentTypeHash,
        encodeWordBytes32(String(message.solanaRecipient)),
        encodeWordAddress(String(message.usdc)),
        encodeWordAddress(String(message.cctpMessenger)),
        encodeWordAddress(String(message.feeRecipient)),
        encodeWordUint(Number(message.feeBps)),
        encodeWordUint(String(message.directUsdcAmount)),
        encodeWordUint(String(message.minNetUsdcOut)),
        encodeWordUint(String(message.maxGasReimbursementUsdc)),
        encodeWordUint(String(message.nonce)),
        encodeWordUint(String(message.deadline)),
        encodeWordBytes32(String(message.callsHash)),
      ])
    );

    return keccakHex(concatBytes([new Uint8Array([0x19, 0x01]), domainSeparator, structHash]));
  }

  throw new Error(`Unsupported EIP-712 primaryType: ${primaryType}`);
}

/**
 * Recovers the EVM signer address from a 32-byte EIP-712 digest and 65-byte ECDSA signature
 * with strict EIP-2 low-`s` malleability protection.
 */
export function recoverEip712Signer(digestHex: string, signatureHex: string): string {
  const cleanDigest = digestHex.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(cleanDigest)) {
    throw new Error('Invalid 32-byte EIP-712 digest');
  }
  const cleanSig = signatureHex.trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(cleanSig)) {
    throw new Error('Invalid EIP-712 signature (expected 65-byte 0x hex signature).');
  }

  const r = BigInt('0x' + cleanSig.slice(2, 66));
  const s = BigInt('0x' + cleanSig.slice(66, 130));
  const rawV = parseInt(cleanSig.slice(130, 132), 16);

  if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_HALF_N) {
    throw new Error('Invalid ECDSA signature scalar (r out of range or high-s malleability rejected).');
  }
  if (rawV !== 27 && rawV !== 28) {
    throw new Error(`Invalid ECDSA recovery id v=${rawV} (expected 27 or 28).`);
  }

  const recoveryBit = rawV - 27;
  const sigObj = new secp256k1.Signature(r, s, recoveryBit);
  const digestBytes = Buffer.from(cleanDigest.slice(2), 'hex');
  const pubPoint = sigObj.recoverPublicKey(digestBytes);
  const uncompressed = pubPoint.toRawBytes(false); // 65 bytes: 0x04 || X(32) || Y(32)
  const addrBytes = keccak_256(uncompressed.slice(1)).slice(-20);
  return '0x' + Buffer.from(addrBytes).toString('hex');
}

export interface GaslessSweepIntentPlan {
  intentId: string;
  mode: 'permit2_batch' | 'eip7702_delegate';
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  userAddress: string;
  solanaDestination: string;
  solanaUsdcAta: string;
  solanaMintRecipientBytes32: string;
  outputAsset: 'USDC' | 'SOL';
  nonce: string;
  deadline: number;
  userGasCostUsd: 0;
  sponsoredGasEstUsd: number;
  maxGasReimbursementUsdc: string; // 6 decimals raw string
  protocolFeeBps: number;
  protocolFeePercent: number;
  protocolFeeUsd: number;
  feeRecipientEvm: string | null;
  minNetUsdcOut: string; // 6 decimals raw string
  directUsdcAmount?: string; // 6 decimals raw string (EIP-7702 SweepIntent)
  callsHash?: string; // bytes32 (EIP-7702 SweepIntent)
  swapsHash?: string; // bytes32 (Permit2 TurgaliumSweepWitness)
  estimatedNetUsd: number;
  sponsorEligible: boolean;
  sponsorRejectionReason?: string;
  relayerRequiredCoverageUsd: number;
  relayerExpectedCoverageUsd: number;
  coveredAssets: Array<{ id: string; symbol: string; address: string; rawBalance: string; grossUsd: number }>;
  uncoveredNativeAssets: Array<{ id: string; symbol: string; reason: string }>;
  instantSingleSigBreakdown: {
    permit2ApprovedIds: string[];
    eip2612SupportedIds: string[];
    instantEligibleIds: string[];
    requiresOnchainApprovalIds: string[];
    zeroPopupReadyCount: number;
    requiresApprovalCount: number;
  };
  routerConfigured: boolean;
  previewOnly: boolean;
  relayerConfigured: boolean;
  routerAddress: string | null;
  typedData: Record<string, unknown> | null;
  eip712Digest: string | null;
  intentDigestSha256: string;
  explanation: string;
}

export interface SignedIntentReceipt {
  accepted: boolean;
  broadcasted: boolean;
  settlementStatus: 'unbroadcast_awaiting_deployment' | 'queued_pending_broadcast' | 'broadcast';
  mode: 'relayer_submitted' | 'intent_verified_awaiting_deployment';
  intentId: string;
  chain: EvmChainId;
  chainName: string;
  userAddress: string;
  recoveredSigner: string;
  signatureValid: boolean;
  signatureFingerprint: string;
  txHash?: string;
  relayerAddress?: string;
  diagnostic?: string;
  nextStep: string;
}

function getChainRouterAddress(chain: EvmChainId): string | null {
  const envKey = `TURGALIUM_ROUTER_${chain.toUpperCase()}`;
  const val = process.env[envKey]?.trim();
  if (!val || !/^0x[0-9a-fA-F]{40}$/.test(val)) return null;
  const lower = val.toLowerCase();
  if (
    lower === '0x0000000000000000000000000000000000000000' ||
    lower === '0x00000000000000000000000000000000000051f0'
  ) {
    return null;
  }
  return val;
}

function getChainDelegateAddress(chain: EvmChainId): string | null {
  const envKey = `TURGALIUM_DELEGATE_${chain.toUpperCase()}`;
  const val = process.env[envKey]?.trim();
  if (val && /^0x[0-9a-fA-F]{40}$/.test(val)) {
    const lower = val.toLowerCase();
    if (
      lower !== '0x0000000000000000000000000000000000000000' &&
      lower !== '0x00000000000000000000000000000000000051f0'
    ) {
      return val;
    }
  }
  return getChainRouterAddress(chain);
}

export function isSponsorRelayerConfigured(chain?: EvmChainId): boolean {
  const hasKey = Boolean(process.env.TURGALIUM_RELAYER_PRIVATE_KEY?.trim());
  if (!hasKey) return false;
  if (!chain) return true;
  return Boolean(getChainRouterAddress(chain));
}

/**
 * Clears in-memory tracked intents and consumed digests (for deterministic testing).
 */
export function clearTrackedGaslessIntentsForTest(): void {
  issuedIntents.clear();
  consumedDigests.clear();
  broadcastingIntentIds.clear();
}

/**
 * Builds a single off-chain EIP-712 gasless signature payload solving BOTH:
 *   1. Zero per-tx popups (1 eth_signTypedData_v4 covers ALL tokens on the chain)
 *   2. Zero native gas needed by the user (Turgalium Relayer sponsors gas, reimbursed from 5-10% fee/proceeds)
 *
 * Security hardening:
 *   - Uses canonical 32-byte Solana USDC ATA PDA (`solanaOwnerToUsdcAtaBytes32`) for CCTP `mintRecipient`
 *   - Never emits live mainnet Permit2/EIP-7702 typed data with placeholder `0x...51F0` addresses
 *   - Matches Solidity EIP-712 structs exactly (`swapsHash` on Permit2 witness; `directUsdcAmount` + `callsHash` on SweepIntent)
 *   - Evaluates relayer break-even honestly at 1.0x sponsored gas (eliminating the circular 2.5x bypass)
 */
export function buildGaslessSweepIntent(params: {
  chain: EvmChainId;
  assets: ScannedAsset[];
  userAddress: string;
  solanaDestination: string;
  outputAsset?: 'USDC' | 'SOL';
  protocolFeeBps?: number;
  feeRecipientEvm?: string | null;
  preferredMode?: 'permit2_batch' | 'eip7702_delegate';
  filterToInstantSingleSig?: boolean;
  callsHash?: string;
  swapsHash?: string;
}): GaslessSweepIntentPlan {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) throw new Error(`Unsupported chain: ${params.chain}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.userAddress.trim())) {
    throw new Error(`Invalid EVM userAddress: ${params.userAddress}`);
  }

  // CRIT-04: Derive canonical Solana USDC Associated Token Account (ATA) PDA
  const solanaUsdcAta = deriveSolanaUsdcAta(params.solanaDestination).toBase58();
  const solanaMintRecipientBytes32 = solanaOwnerToUsdcAtaBytes32(params.solanaDestination);

  const feeConfig = getProtocolFeeConfig({
    feeBps: params.protocolFeeBps,
    feeRecipientEvm: params.feeRecipientEvm,
  });

  const chainAssets = params.assets.filter(
    (a) =>
      a.chain === params.chain &&
      a.action !== 'SKIP_HONEYPOT' &&
      a.action !== 'SKIP_GAS_NEGATIVE' &&
      a.action !== 'SKIP_NEGATIVE_ROI' &&
      a.action !== 'SKIP_UNPRICED'
  );
  // MED-05: Permit2 batch strictly covers liquid swappable/bridgeable ERC-20s (never dead burns or DeFi receipts)
  const allLiquidErc20Assets = chainAssets.filter(
    (a) =>
      a.address !== 'native' &&
      a.kind !== 'defi_position' &&
      (a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC')
  );
  const permit2ApprovedIds: string[] = [];
  const eip2612SupportedIds: string[] = [];
  const instantEligibleIds: string[] = [];
  const requiresOnchainApprovalIds: string[] = [];
  for (const asset of allLiquidErc20Assets) {
    const hasPermit2 = Boolean(asset.permit2Approved);
    const hasEip2612 = Boolean(
      asset.eip2612Supported ?? isEip2612Token(params.chain, asset.address, asset.symbol)
    );
    if (hasPermit2) permit2ApprovedIds.push(asset.id);
    if (hasEip2612) eip2612SupportedIds.push(asset.id);
    if (hasPermit2 || hasEip2612) {
      instantEligibleIds.push(asset.id);
    } else {
      requiresOnchainApprovalIds.push(asset.id);
    }
  }
  const instantEligibleSet = new Set(instantEligibleIds);
  const permit2Erc20Assets = params.filterToInstantSingleSig
    ? allLiquidErc20Assets.filter((a) => instantEligibleSet.has(a.id))
    : allLiquidErc20Assets;
  const nativeAssets = chainAssets.filter((a) => a.address === 'native');

  const mode: 'permit2_batch' | 'eip7702_delegate' =
    params.preferredMode ?? (permit2Erc20Assets.length > 0 ? 'permit2_batch' : 'eip7702_delegate');

  // MED-03: In eip7702_delegate mode, include both ERC-20/DeFi assets and native gas coins
  const coveredForEconomics =
    mode === 'eip7702_delegate'
      ? chainAssets.filter((a) => a.action !== 'BURN_ZERO_LIQUIDITY')
      : permit2Erc20Assets;

  const nonce = BigInt('0x' + crypto.randomBytes(12).toString('hex')).toString();
  const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 minutes
  const routerAddress =
    mode === 'eip7702_delegate'
      ? getChainDelegateAddress(params.chain)
      : getChainRouterAddress(params.chain);
  const routerConfigured = Boolean(routerAddress);

  const grossUsd = Number(
    coveredForEconomics.reduce((s, a) => s + a.grossUsd, 0).toFixed(2)
  );
  const estimatedSlippageUsd = Number(
    coveredForEconomics.reduce((s, a) => s + (a.estimatedSlippageUsd || 0), 0).toFixed(2)
  );
  const sponsoredGasEstUsd = Number(
    Math.max(
      0.04,
      coveredForEconomics.reduce((s, a) => s + (a.batchedGasUsd || a.estimatedGasUsd || 0), 0)
    ).toFixed(2)
  );
  const protocolFeeUsd = Number(((grossUsd * feeConfig.feeBps) / 10_000).toFixed(2));

  // HIGH-04: Honest break-even check aligned with onchain invariant:
  // When feeBps > 0: feeUsdc + gasReimbursementUsdc >= 1.5 * gasReimbursementUsdc  <=>  feeUsdc >= 0.5 * gasReimbursementUsdc.
  // When feeBps === 0 (open-source zero-fee mode): at-cost gas reimbursement without protocol markup.
  const isZeroFeeAtCost = feeConfig.feeBps === 0;
  const relayerRequiredCoverageUsd = Number(
    (isZeroFeeAtCost ? sponsoredGasEstUsd : sponsoredGasEstUsd * RELAYER_BREAK_EVEN_MULTIPLIER).toFixed(2)
  );
  const relayerExpectedCoverageUsd = Number((protocolFeeUsd + sponsoredGasEstUsd).toFixed(2));
  const relayerCheck = computeRelayerBreakEven({
    sponsoredGasUsd: sponsoredGasEstUsd,
    protocolFeeBps: feeConfig.feeBps,
    grossUsd,
    maxGasReimbursementUsd: sponsoredGasEstUsd,
    ...(isZeroFeeAtCost ? { fixedRelayerOverheadUsd: 0 } : {}),
  });

  // Cap maxGasReimbursementUsd by BOTH onchain break-even ceiling (2 * protocolFeeUsd when fee > 0) and affordable proceeds
  const affordableReimbursementUsd = Number(
    Math.max(0, grossUsd - protocolFeeUsd - estimatedSlippageUsd - 0.01).toFixed(2)
  );
  const onchainMaxReimbursementCapUsd = isZeroFeeAtCost
    ? Number(Math.max(sponsoredGasEstUsd * 1.5, 0.25).toFixed(2))
    : Number((protocolFeeUsd * 2).toFixed(2));
  const maxGasReimbursementUsd = Number(
    Math.min(
      Math.max(sponsoredGasEstUsd * 1.5, Math.min(0.25, onchainMaxReimbursementCapUsd)),
      onchainMaxReimbursementCapUsd,
      affordableReimbursementUsd
    ).toFixed(2)
  );

  const estimatedNetUsd = Number(
    (grossUsd - protocolFeeUsd - estimatedSlippageUsd - sponsoredGasEstUsd).toFixed(2)
  );
  // MED-05: Keep minNetUsdcOut consistent with slippage and reimbursement headroom
  const minNetUsd = Number(
    Math.max(
      0,
      Math.min(
        estimatedNetUsd * 0.985,
        grossUsd - protocolFeeUsd - estimatedSlippageUsd - maxGasReimbursementUsd
      )
    ).toFixed(2)
  );

  const maxGasReimbursementUsdc = BigInt(Math.round(Math.max(0, maxGasReimbursementUsd) * 1_000_000)).toString();
  const minNetUsdcOut = BigInt(Math.round(Math.max(0, minNetUsd) * 1_000_000)).toString();

  // CRIT-02: Compute explicit directUsdcAmount for EIP-7702 SweepIntent (0 for non-USDC swaps!)
  const directUsdcRaw = coveredForEconomics
    .filter(
      (a) =>
        a.action === 'BRIDGE_DIRECT_USDC' &&
        a.address.toLowerCase() === cfg.usdcAddress.toLowerCase()
    )
    .reduce((sum, a) => sum + BigInt(a.rawBalance || '0'), 0n);
  const directUsdcAmount = directUsdcRaw.toString();

  const callsHash =
    params.callsHash && /^0x[0-9a-fA-F]{64}$/.test(params.callsHash)
      ? params.callsHash.toLowerCase()
      : computeEmptySweepCallsHash();
  const swapsHash =
    params.swapsHash && /^0x[0-9a-fA-F]{64}$/.test(params.swapsHash)
      ? params.swapsHash.toLowerCase()
      : computeEmptySwapsHash();

  const userMinNetPositive = BigInt(minNetUsdcOut) > 0n;
  const zeroFeeAtCost = feeConfig.feeBps === 0 && relayerExpectedCoverageUsd + 1e-9 >= sponsoredGasEstUsd;
  const onchainFeeCoversGasMargin =
    zeroFeeAtCost || protocolFeeUsd + 1e-9 >= sponsoredGasEstUsd * 0.5;
  const sponsorEligible =
    (zeroFeeAtCost || relayerExpectedCoverageUsd >= relayerRequiredCoverageUsd) &&
    onchainFeeCoversGasMargin &&
    userMinNetPositive &&
    relayerCheck.isRelayerProfitable;
  const sponsorRejectionReason = !sponsorEligible
    ? !userMinNetPositive
      ? `Below gasless sponsorship break-even: user minNetUsdcOut is $0.00 on $${grossUsd.toFixed(2)} gross vs $${sponsoredGasEstUsd.toFixed(2)} sponsored gas.`
      : `Below gasless sponsorship break-even: protocol fee + 1.0x sponsored gas ($${relayerExpectedCoverageUsd.toFixed(2)}) < 1.5x sponsored gas ($${relayerRequiredCoverageUsd.toFixed(2)}) (protocol fee $${protocolFeeUsd.toFixed(2)} must be >= 0.5x gas $${(sponsoredGasEstUsd * 0.5).toFixed(2)}).`
    : undefined;

  // MED-05 / CRIT-06: NEVER emit live mainnet Permit2/EIP-7702 typed data with unowned placeholder 0x...51F0!
  const effectiveFeeRecipient = feeConfig.feeRecipientEvm;
  const canEmitLiveTypedData =
    routerConfigured &&
    Boolean(routerAddress) &&
    Boolean(effectiveFeeRecipient) &&
    (mode === 'permit2_batch' || Boolean(cfg.cctpTokenMessenger));
  const previewOnly = !canEmitLiveTypedData;

  let typedData: Record<string, unknown> | null = null;
  let eip712Digest: string | null = null;

  if (canEmitLiveTypedData && routerAddress && effectiveFeeRecipient) {
    typedData =
      mode === 'permit2_batch'
        ? {
            types: {
              EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'chainId', type: 'uint256' },
                { name: 'verifyingContract', type: 'address' },
              ],
              PermitBatchWitnessTransferFrom: [
                { name: 'permitted', type: 'TokenPermissions[]' },
                { name: 'spender', type: 'address' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'witness', type: 'TurgaliumSweepWitness' },
              ],
              TokenPermissions: [
                { name: 'token', type: 'address' },
                { name: 'amount', type: 'uint256' },
              ],
              TurgaliumSweepWitness: [
                { name: 'solanaRecipient', type: 'bytes32' },
                { name: 'minNetUsdcOut', type: 'uint256' },
                { name: 'maxGasReimbursementUsdc', type: 'uint256' },
                { name: 'feeBps', type: 'uint16' },
                { name: 'feeRecipient', type: 'address' },
                { name: 'swapsHash', type: 'bytes32' },
              ],
            },
            primaryType: 'PermitBatchWitnessTransferFrom',
            domain: {
              name: 'Permit2',
              chainId: cfg.chainId,
              verifyingContract: CANONICAL_PERMIT2_ADDRESS,
            },
            message: {
              permitted: permit2Erc20Assets.map((a) => ({
                token: a.address,
                amount: a.rawBalance,
              })),
              spender: routerAddress,
              nonce,
              deadline: String(deadline),
              witness: {
                solanaRecipient: solanaMintRecipientBytes32,
                minNetUsdcOut,
                maxGasReimbursementUsdc,
                feeBps: feeConfig.feeBps,
                feeRecipient: effectiveFeeRecipient,
                swapsHash,
              },
            },
          }
        : {
            types: {
              EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'version', type: 'string' },
                { name: 'chainId', type: 'uint256' },
                { name: 'verifyingContract', type: 'address' },
              ],
              SweepIntent: [
                { name: 'solanaRecipient', type: 'bytes32' },
                { name: 'usdc', type: 'address' },
                { name: 'cctpMessenger', type: 'address' },
                { name: 'feeRecipient', type: 'address' },
                { name: 'feeBps', type: 'uint16' },
                { name: 'directUsdcAmount', type: 'uint256' },
                { name: 'minNetUsdcOut', type: 'uint256' },
                { name: 'maxGasReimbursementUsdc', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'callsHash', type: 'bytes32' },
              ],
            },
            primaryType: 'SweepIntent',
            domain: {
              name: 'TurgaliumSweepDelegate',
              version: '1',
              chainId: cfg.chainId,
              verifyingContract: params.userAddress,
            },
            message: {
              solanaRecipient: solanaMintRecipientBytes32,
              usdc: cfg.usdcAddress,
              cctpMessenger: cfg.cctpTokenMessenger!,
              feeRecipient: effectiveFeeRecipient,
              feeBps: feeConfig.feeBps,
              directUsdcAmount,
              minNetUsdcOut,
              maxGasReimbursementUsdc,
              nonce,
              deadline: String(deadline),
              callsHash,
            },
          };

    eip712Digest = computeGaslessIntentEip712Digest(typedData);
  }

  const intentDigestSha256 =
    '0x' +
    crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          mode,
          chainId: cfg.chainId,
          user: params.userAddress.toLowerCase(),
          routerConfigured,
          previewOnly,
          solanaMintRecipientBytes32,
          eip712Digest,
          typedData,
        })
      )
      .digest('hex');

  const intentId = `int_${crypto.randomBytes(6).toString('hex')}`;
  issuedIntents.set(intentId, {
    intentId,
    mode,
    chain: params.chain,
    chainId: cfg.chainId,
    userAddress: params.userAddress.toLowerCase(),
    routerAddress,
    solanaRecipient: solanaMintRecipientBytes32.toLowerCase(),
    feeRecipient: effectiveFeeRecipient ? effectiveFeeRecipient.toLowerCase() : null,
    feeBps: feeConfig.feeBps,
    nonce,
    minNetUsdcOut,
    maxGasReimbursementUsdc,
    ...(mode === 'eip7702_delegate'
      ? {
          directUsdcAmount,
          callsHash,
          usdcAddress: cfg.usdcAddress.toLowerCase(),
          cctpMessenger: cfg.cctpTokenMessenger ? cfg.cctpTokenMessenger.toLowerCase() : null,
        }
      : { swapsHash }),
    deadline,
    eligible: sponsorEligible,
    rejectionReason: sponsorRejectionReason,
    routerConfigured,
    previewOnly,
    eip712Digest,
    consumed: false,
    createdAt: Date.now(),
  });
  if (issuedIntents.size > MAX_ISSUED_INTENTS) {
    const oldest = issuedIntents.keys().next().value;
    if (oldest) issuedIntents.delete(oldest);
  }
  persistGaslessIntents();

  return {
    intentId,
    mode,
    chain: params.chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    userAddress: params.userAddress,
    solanaDestination: params.solanaDestination,
    solanaUsdcAta,
    solanaMintRecipientBytes32,
    outputAsset: params.outputAsset ?? 'USDC',
    nonce,
    deadline,
    userGasCostUsd: 0,
    sponsoredGasEstUsd,
    maxGasReimbursementUsdc,
    protocolFeeBps: feeConfig.feeBps,
    protocolFeePercent: feeConfig.feePercent,
    protocolFeeUsd,
    feeRecipientEvm: effectiveFeeRecipient,
    minNetUsdcOut,
    ...(mode === 'eip7702_delegate' ? { directUsdcAmount, callsHash } : { swapsHash }),
    estimatedNetUsd,
    sponsorEligible,
    sponsorRejectionReason,
    relayerRequiredCoverageUsd,
    relayerExpectedCoverageUsd,
    coveredAssets: coveredForEconomics.map((a) => ({
      id: a.id,
      symbol: a.symbol,
      address: a.address,
      rawBalance: a.rawBalance,
      grossUsd: a.grossUsd,
    })),
    uncoveredNativeAssets:
      mode === 'permit2_batch'
        ? nativeAssets.map((a) => ({
            id: a.id,
            symbol: a.symbol,
            reason: `Native ${a.symbol} requires EIP-7702 delegate execution (Permit2 covers liquid ERC-20s).`,
          }))
        : [],
    instantSingleSigBreakdown: {
      permit2ApprovedIds,
      eip2612SupportedIds,
      instantEligibleIds,
      requiresOnchainApprovalIds,
      zeroPopupReadyCount: instantEligibleIds.length,
      requiresApprovalCount: requiresOnchainApprovalIds.length,
    },
    routerConfigured,
    previewOnly,
    relayerConfigured: isSponsorRelayerConfigured(params.chain),
    routerAddress,
    typedData,
    eip712Digest,
    intentDigestSha256,
    explanation: previewOnly
      ? `Preview mode only on ${cfg.name}: deploy TurgaliumRouter/TurgaliumSweepDelegate and configure TURGALIUM_ROUTER_${params.chain.toUpperCase()} + TURGALIUM_FEE_RECIPIENT_EVM before signing live EIP-712 payloads.`
      : mode === 'permit2_batch'
      ? `1 gasless Permit2 signature covers ${permit2Erc20Assets.length} liquid ERC-20 token(s) on ${cfg.name}. User pays $0.00 gas; Turgalium Relayer sponsors gas & deducts ${feeConfig.feePercent}% fee onchain.`
      : `1 gasless EIP-7702 SweepIntent covers ${coveredForEconomics.length} position(s) on ${cfg.name} with $0.00 user gas, explicit directUsdcAmount, and onchain minNetUsdcOut floor.`,
  };
}

/**
 * Verifies a user-signed EIP-712 gasless sweep intent fail-closed:
 *   - Rejects unknown, expired, or evicted `intentId` (never fails open)
 *   - Enforces server-stored eligibility, chain, userAddress, and deadline (ignores client deadline)
 *   - Performs cryptographic EIP-712 secp256k1 ecrecover with EIP-2 low-s validation
 *   - Enforces single-use replay protection (`consumed = true`)
 *   - NEVER marks unverified or non-broadcast intents as `'attested'` or settled
 */
function validateSignedGaslessIntentPreConsume(params: {
  intentId: string;
  chain: EvmChainId;
  userAddress: string;
  signature: string;
  deadline: number;
}): {
  cfg: (typeof EVM_CHAINS)[EvmChainId];
  tracked: TrackedGaslessIntent;
  normalizedDigest: string;
  sig: string;
  recoveredSigner: string;
  signatureFingerprint: string;
  configured: boolean;
} {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) throw new Error(`Unsupported chain: ${params.chain}`);

  // CRIT-07: Fail-closed lookup on server-issued intent store
  const tracked = issuedIntents.get(params.intentId);
  if (!tracked) {
    throw new Error(
      `Unknown, expired, or evicted gasless intentId (${params.intentId}). Prepare a fresh intent before signing.`
    );
  }
  if (!tracked.eligible) {
    throw new Error(tracked.rejectionReason || 'Below gasless sponsorship break-even.');
  }
  if (tracked.consumed) {
    throw new Error(`Gasless sweep intent ${params.intentId} has already been consumed (replay rejected).`);
  }
  if (broadcastingIntentIds.has(params.intentId)) {
    throw new Error(`Gasless sweep intent ${params.intentId} is already broadcasting (concurrent submission rejected).`);
  }
  if (tracked.previewOnly || !tracked.routerConfigured || !tracked.eip712Digest) {
    throw new Error(
      `Cannot submit preview-only intent on ${cfg.name}: deploy TurgaliumRouter/TurgaliumSweepDelegate and set TURGALIUM_ROUTER_${params.chain.toUpperCase()} + TURGALIUM_FEE_RECIPIENT_EVM.`
    );
  }
  const normalizedDigest = tracked.eip712Digest.toLowerCase();
  if (consumedDigests.has(normalizedDigest)) {
    throw new Error(
      `Gasless sweep intent digest ${normalizedDigest} has already been consumed (replay rejected).`
    );
  }
  if (tracked.chain !== params.chain) {
    throw new Error(`Chain mismatch for intent ${params.intentId}: expected ${tracked.chain}, got ${params.chain}.`);
  }
  if (tracked.userAddress !== params.userAddress.trim().toLowerCase()) {
    throw new Error(`User address mismatch for intent ${params.intentId}.`);
  }

  // Enforce server-stored deadline (never trust client-supplied params.deadline)
  if (Math.floor(Date.now() / 1000) > tracked.deadline) {
    throw new Error('Signed gasless sweep intent has expired. Re-sign a fresh intent.');
  }

  // Real cryptographic EIP-712 ecrecover + EIP-2 low-s check
  const sig = params.signature.trim();
  const recoveredSigner = recoverEip712Signer(tracked.eip712Digest, sig);
  if (recoveredSigner.toLowerCase() !== tracked.userAddress) {
    throw new Error(
      `Invalid EIP-712 signature: recovered signer ${recoveredSigner} does not match userAddress ${tracked.userAddress}.`
    );
  }

  const signatureFingerprint =
    '0x' + crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
  const configured = isSponsorRelayerConfigured(params.chain);

  return { cfg, tracked, normalizedDigest, sig, recoveredSigner, signatureFingerprint, configured };
}

function markGaslessIntentConsumed(
  tracked: TrackedGaslessIntent,
  normalizedDigest: string,
  txHash?: string
): void {
  tracked.consumed = true;
  if (txHash) tracked.txHash = txHash;
  consumedDigests.set(normalizedDigest, {
    digest: normalizedDigest,
    intentId: tracked.intentId,
    chain: tracked.chain,
    consumedAt: Date.now(),
    deadline: tracked.deadline,
  });
  while (consumedDigests.size > MAX_CONSUMED_DIGESTS) {
    const oldestDigest = consumedDigests.keys().next().value;
    if (!oldestDigest) break;
    consumedDigests.delete(oldestDigest);
  }
  persistGaslessIntents();
}

function buildBaseSignedIntentReceipt(
  params: { intentId: string; chain: EvmChainId; userAddress: string },
  verified: {
    cfg: (typeof EVM_CHAINS)[EvmChainId];
    recoveredSigner: string;
    signatureFingerprint: string;
    configured: boolean;
  }
): SignedIntentReceipt {
  const { cfg, recoveredSigner, signatureFingerprint, configured } = verified;
  return {
    accepted: configured,
    broadcasted: false,
    settlementStatus: configured
      ? 'queued_pending_broadcast'
      : 'unbroadcast_awaiting_deployment',
    mode: configured ? 'relayer_submitted' : 'intent_verified_awaiting_deployment',
    intentId: params.intentId,
    chain: params.chain,
    chainName: cfg.name,
    userAddress: params.userAddress,
    recoveredSigner,
    signatureValid: true,
    signatureFingerprint,
    diagnostic: configured
      ? 'Verified EIP-712 intent queued; call submitAndBroadcastSignedGaslessIntent or broadcastSignedRelayerTx to broadcast.'
      : `Relayer key TURGALIUM_RELAYER_PRIVATE_KEY is unconfigured for ${cfg.name}.`,
    nextStep: configured
      ? `EIP-712 signature cryptographically verified for ${recoveredSigner}. Intent ${params.intentId} queued for sponsored broadcast on ${cfg.name} (not yet attested onchain).`
      : `EIP-712 signature verified (${signatureFingerprint}) for ${recoveredSigner}, NOT broadcast or attested. Configure TURGALIUM_RELAYER_PRIVATE_KEY to broadcast sponsored sweeps on ${cfg.name}.`,
  };
}

export function submitSignedGaslessIntent(params: {
  intentId: string;
  chain: EvmChainId;
  userAddress: string;
  signature: string;
  deadline: number;
}): SignedIntentReceipt {
  const verified = validateSignedGaslessIntentPreConsume(params);
  // Single-use replay protection: mark consumed immediately after cryptographic verification & persist
  markGaslessIntentConsumed(verified.tracked, verified.normalizedDigest);
  return buildBaseSignedIntentReceipt(params, verified);
}

/**
 * Verifies a user-signed EIP-712 gasless sweep intent AND attempts real onchain broadcast
 * via `broadcastSignedRelayerTx()` when `TURGALIUM_RELAYER_PRIVATE_KEY`, router, and execution
 * calldata (`txCalldata`) are available.
 *
 * Security & reliability guarantees:
 *   - Strictly verifies `txCalldata` selector + persisted intent parameters + signature BEFORE consuming intent.
 *   - Uses an in-flight `broadcastingIntentIds` guard and rolls back on pre-broadcast validation/RPC errors
 *     so transient RPC failures never permanently burn valid user intents.
 *   - Always fails closed honestly (`broadcasted: false`, never fabricates tx hashes) if the
 *     relayer key, router, calldata, or upstream RPC is unavailable.
 */
export async function submitAndBroadcastSignedGaslessIntent(params: {
  intentId: string;
  chain: EvmChainId;
  userAddress: string;
  signature: string;
  deadline: number;
  txCalldata?: string;
  gasLimit?: bigint;
  maxFeePerGasWei?: bigint;
  maxPriorityFeePerGasWei?: bigint;
  nonce?: number;
  rpcUrls?: string[];
  sendRawTransaction?: (ctx: RelayerCustomBroadcasterContext) => Promise<string>;
  rpcCall?: typeof evmJsonRpcCall;
}): Promise<SignedIntentReceipt & { broadcastResult?: RelayerBroadcastResult }> {
  // 1. Validate intent + cryptographic EIP-712 signature BEFORE marking consumed
  const verified = validateSignedGaslessIntentPreConsume({
    intentId: params.intentId,
    chain: params.chain,
    userAddress: params.userAddress,
    signature: params.signature,
    deadline: params.deadline,
  });

  // 2. If txCalldata is supplied, strictly verify it matches the persisted intent BEFORE consuming!
  const trimmedCalldata = typeof params.txCalldata === 'string' ? params.txCalldata.trim() : '';
  if (params.txCalldata !== undefined && params.txCalldata !== null && trimmedCalldata !== '') {
    const calldataCheck = verifyRelayerCalldataMatchesIntent(
      verified.tracked,
      trimmedCalldata,
      verified.sig
    );
    if (!calldataCheck.ok) {
      throw new Error(`Invalid relayer txCalldata: ${calldataCheck.reason}`);
    }
  } else if (params.txCalldata !== undefined && typeof params.txCalldata !== 'string') {
    throw new Error('Invalid relayer txCalldata: expected a 0x-prefixed hex string.');
  }

  const baseReceipt = buildBaseSignedIntentReceipt(params, verified);

  if (!baseReceipt.accepted) {
    markGaslessIntentConsumed(verified.tracked, verified.normalizedDigest);
    return baseReceipt;
  }

  const targetContract =
    verified.tracked.mode === 'eip7702_delegate'
      ? params.userAddress
      : verified.tracked.routerAddress ?? getChainRouterAddress(params.chain);

  if (!trimmedCalldata) {
    markGaslessIntentConsumed(verified.tracked, verified.normalizedDigest);
    return {
      ...baseReceipt,
      broadcasted: false,
      settlementStatus: 'queued_pending_broadcast',
      diagnostic:
        'Relayer key and router are configured, but encoded router/delegate execution calldata (txCalldata) was not supplied; refusing to fabricate a transaction hash.',
    };
  }

  // 3. Guard against concurrent duplicate broadcasts while allowing rollback on transient RPC failures
  broadcastingIntentIds.add(params.intentId);
  try {
    const broadcastResult = await broadcastSignedRelayerTx({
      chain: params.chain,
      to: targetContract,
      data: trimmedCalldata,
      gasLimit: params.gasLimit,
      maxFeePerGasWei: params.maxFeePerGasWei,
      maxPriorityFeePerGasWei: params.maxPriorityFeePerGasWei,
      nonce: params.nonce,
      rpcUrls: params.rpcUrls,
      sendRawTransaction: params.sendRawTransaction,
      rpcCall: params.rpcCall,
    });

    if (!broadcastResult.broadcasted || !broadcastResult.txHash) {
      // Only mark consumed if raw tx may have reached mempool (invalid_tx_hash);
      // pre-broadcast validation or RPC errors leave the intent unconsumed for safe retry.
      if (broadcastResult.reasonCode === 'invalid_tx_hash') {
        markGaslessIntentConsumed(verified.tracked, verified.normalizedDigest);
      }
      return {
        ...baseReceipt,
        broadcasted: false,
        settlementStatus: 'queued_pending_broadcast',
        relayerAddress: broadcastResult.relayerAddress,
        diagnostic: broadcastResult.diagnostic,
        nextStep: `EIP-712 signature verified, but relayer broadcast did not complete: ${broadcastResult.diagnostic}`,
        broadcastResult,
      };
    }

    markGaslessIntentConsumed(verified.tracked, verified.normalizedDigest, broadcastResult.txHash);

    return {
      ...baseReceipt,
      broadcasted: true,
      settlementStatus: 'broadcast',
      txHash: broadcastResult.txHash,
      relayerAddress: broadcastResult.relayerAddress,
      diagnostic: broadcastResult.diagnostic,
      nextStep: `Sponsored EIP-1559 transaction broadcast on ${baseReceipt.chainName}: ${broadcastResult.txHash}.`,
      broadcastResult,
    };
  } finally {
    broadcastingIntentIds.delete(params.intentId);
  }
}
