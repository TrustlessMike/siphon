import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { EVM_CHAINS } from './chains.js';
import { evmJsonRpcCall } from './rpc.js';
import type { ChainFamily, CosmosChainId } from './types.js';

export const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';
export const ENS_REGISTRY_ADDRESS = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
export const ENS_RESOLVER_SELECTOR = '0178b8bf'; // resolver(bytes32)
export const ENS_ADDR_SELECTOR = '3b3b57de'; // addr(bytes32)

export const COSMOS_HRP_TO_CHAIN: Readonly<Record<string, CosmosChainId>> = Object.freeze({
  cosmos: 'cosmoshub',
  osmo: 'osmosis',
  noble: 'noble',
  celestia: 'celestia',
  inj: 'injective',
  neutron: 'neutron',
});

export type BitcoinAddressType = 'p2pkh' | 'p2sh' | 'p2wpkh' | 'p2wsh' | 'p2tr';
export type TronAddressFormat = 'base58check' | 'hex';
export type TonAddressFormat = 'friendly_base64url' | 'friendly_base64' | 'raw';

export interface AddressValidationResult<TMeta = Record<string, unknown>> {
  valid: boolean;
  normalized?: string;
  reason?: string;
  meta?: TMeta;
}

export interface DecodedBase58Check {
  version: number;
  payload: Uint8Array;
  rawPayload: Uint8Array;
}

export interface DecodedBech32Strict {
  hrp: string;
  words: number[];
  encoding: 'bech32' | 'bech32m';
}

export interface DetectedAddress {
  family: ChainFamily;
  normalized: string;
  ambiguous: boolean;
  possibleFamilies: ChainFamily[];
  disambiguationHint?: string;
  isEns?: boolean;
  cosmosChain?: CosmosChainId;
  cosmosChains?: CosmosChainId[];
  bitcoinType?: BitcoinAddressType;
  tronFormat?: TronAddressFormat;
  tonFormat?: TonAddressFormat;
}

export type EnsResolutionErrorCode = 'INVALID_NAME' | 'UNRESOLVED' | 'RPC_ERROR';

export class EnsResolutionError extends Error {
  readonly code: EnsResolutionErrorCode;
  readonly ensName: string;

  constructor(ensName: string, code: EnsResolutionErrorCode, message: string) {
    super(message);
    this.name = 'EnsResolutionError';
    this.code = code;
    this.ensName = ensName;
  }
}

// =====================================================================
// BASE58 & BASE58CHECK (Bitcoin P2PKH/P2SH, Tron)
// =====================================================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map<string, bigint>(
  Array.from(BASE58_ALPHABET).map((ch, idx) => [ch, BigInt(idx)])
);

function doubleSha256(data: Uint8Array): Buffer {
  const first = crypto.createHash('sha256').update(data).digest();
  return crypto.createHash('sha256').update(first).digest();
}

export function decodeBase58(input: string): Uint8Array | null {
  if (!input || typeof input !== 'string') return null;
  let acc = 0n;
  for (let i = 0; i < input.length; i += 1) {
    const val = BASE58_MAP.get(input[i]);
    if (val === undefined) return null;
    acc = acc * 58n + val;
  }

  let leadingZeros = 0;
  while (leadingZeros < input.length && input[leadingZeros] === '1') {
    leadingZeros += 1;
  }

  let hex = acc === 0n ? '' : acc.toString(16);
  if (hex.length % 2 === 1) hex = '0' + hex;
  const decoded = hex ? Buffer.from(hex, 'hex') : Buffer.alloc(0);

  const out = new Uint8Array(leadingZeros + decoded.length);
  out.set(decoded, leadingZeros);
  return out;
}

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }

  let acc = 0n;
  for (let i = leadingZeros; i < bytes.length; i += 1) {
    acc = (acc << 8n) + BigInt(bytes[i]);
  }

  let encoded = '';
  while (acc > 0n) {
    const rem = Number(acc % 58n);
    acc /= 58n;
    encoded = BASE58_ALPHABET[rem] + encoded;
  }

  return '1'.repeat(leadingZeros) + encoded;
}

export function decodeBase58Check(input: string): DecodedBase58Check | null {
  const decoded = decodeBase58(input);
  if (!decoded || decoded.length < 5) return null;

  const rawPayload = decoded.subarray(0, decoded.length - 4);
  const providedChecksum = decoded.subarray(decoded.length - 4);
  const expectedChecksum = doubleSha256(rawPayload);

  for (let i = 0; i < 4; i += 1) {
    if (providedChecksum[i] !== expectedChecksum[i]) return null;
  }

  return {
    version: rawPayload[0],
    payload: rawPayload.subarray(1),
    rawPayload,
  };
}

export function encodeBase58Check(versionAndPayload: Uint8Array): string {
  const checksum = doubleSha256(versionAndPayload).subarray(0, 4);
  const full = new Uint8Array(versionAndPayload.length + 4);
  full.set(versionAndPayload, 0);
  full.set(checksum, versionAndPayload.length);
  return encodeBase58(full);
}

// =====================================================================
// STRICT BECH32 / BECH32M (BIP-173 & BIP-350)
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

export function decodeBech32Strict(raw: string): DecodedBech32Strict | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s !== raw) return null;
  if (s.length < 8 || s.length > 90) return null;

  let hasLower = false;
  let hasUpper = false;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 33 || code > 126) return null;
    if (code >= 97 && code <= 122) hasLower = true;
    if (code >= 65 && code <= 90) hasUpper = true;
  }
  // BIP-173 / BIP-350 strictly forbid mixed case
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

export function encodeBech32Strict(
  hrp: string,
  words: number[],
  encoding: 'bech32' | 'bech32m' = 'bech32'
): string {
  const cleanHrp = hrp.trim().toLowerCase();
  const specConst = encoding === 'bech32m' ? BECH32M_CONST : BECH32_CONST;
  const polymod =
    bech32Polymod([...bech32HrpExpand(cleanHrp), ...words, 0, 0, 0, 0, 0, 0]) ^ specConst;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    checksum.push((polymod >>> (5 * (5 - i))) & 31);
  }
  return `${cleanHrp}1${[...words, ...checksum].map((w) => BECH32_CHARSET[w]).join('')}`;
}

export function convertBits(
  data: readonly number[],
  fromBits: number,
  toBits: number,
  pad: boolean
): number[] | null {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << toBits) - 1;
  const out: number[] = [];

  for (const value of data) {
    if (value < 0 || value >>> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      out.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    return null;
  }

  return out;
}

// =====================================================================
// CRC16-XMODEM (TON Friendly Address Checksum)
// =====================================================================

export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

// =====================================================================
// 1. EVM (EIP-55 Checksum) & ENS (.eth)
// =====================================================================

export function toChecksumEvmAddress(address: string): string {
  const clean = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM hex address: ${address}`);
  }
  const lowerHex = clean.slice(2).toLowerCase();
  const hashHex = Buffer.from(keccak_256(Buffer.from(lowerHex, 'utf8'))).toString('hex');
  let out = '0x';
  for (let i = 0; i < 40; i += 1) {
    const ch = lowerHex[i];
    if (ch >= 'a' && ch <= 'f' && parseInt(hashHex[i], 16) >= 8) {
      out += ch.toUpperCase();
    } else {
      out += ch;
    }
  }
  return out;
}

export function validateEvmHexAddress(
  address: string
): AddressValidationResult<{ checksummed: boolean }> {
  const clean = address.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) {
    return { valid: false, reason: 'Expected 0x followed by 40 hexadecimal characters.' };
  }
  const hex = clean.slice(2);
  const isAllLower = hex === hex.toLowerCase();
  const isAllUpper = hex === hex.toUpperCase();
  const checksummed = toChecksumEvmAddress(clean);

  if (isAllLower || isAllUpper) {
    return { valid: true, normalized: checksummed, meta: { checksummed: false } };
  }

  if (clean !== checksummed) {
    return {
      valid: false,
      reason: 'Invalid EIP-55 mixed-case checksum on EVM address.',
    };
  }

  return { valid: true, normalized: checksummed, meta: { checksummed: true } };
}

const ENS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidEnsName(rawName: string): boolean {
  if (!rawName || typeof rawName !== 'string') return false;
  const clean = rawName.trim();
  if (!clean || clean.length > 255) return false;
  const lower = clean.toLowerCase();
  if (!lower.endsWith('.eth')) return false;

  const labels = lower.split('.');
  if (labels.length < 2) return false;
  if (labels[labels.length - 1] !== 'eth') return false;

  for (let i = 0; i < labels.length - 1; i += 1) {
    const label = labels[i];
    if (!label || !ENS_LABEL_REGEX.test(label)) return false;
  }

  return true;
}

export function validateEvmAddressOrEns(
  address: string
): AddressValidationResult<{ isEns: boolean }> {
  const clean = address.trim();
  if (isValidEnsName(clean)) {
    return { valid: true, normalized: clean.toLowerCase(), meta: { isEns: true } };
  }
  const hexRes = validateEvmHexAddress(clean);
  if (hexRes.valid) {
    return { valid: true, normalized: hexRes.normalized, meta: { isEns: false } };
  }
  return { valid: false, reason: hexRes.reason };
}

/**
 * Pure-TypeScript EIP-137 `namehash` using `@noble/hashes/sha3` keccak_256.
 */
export function ensNamehash(name: string): string {
  const clean = name.trim().toLowerCase();
  let node: Uint8Array = new Uint8Array(32);
  if (!clean) {
    return '0x' + Buffer.from(node).toString('hex');
  }
  const labels = clean.split('.').reverse();
  for (const label of labels) {
    const labelHash = keccak_256(Buffer.from(label, 'utf8'));
    const combined = new Uint8Array(64);
    combined.set(node, 0);
    combined.set(labelHash, 32);
    node = keccak_256(combined);
  }
  return '0x' + Buffer.from(node).toString('hex');
}

function decodeAbiAddressWord(hexResult: string | undefined): string | null {
  if (!hexResult || typeof hexResult !== 'string') return null;
  const stripped = hexResult.startsWith('0x') || hexResult.startsWith('0X')
    ? hexResult.slice(2).toLowerCase()
    : hexResult.toLowerCase();
  if (stripped.length < 64) return null;
  const word = stripped.slice(0, 64);
  if (!/^0{24}[0-9a-f]{40}$/.test(word)) return null;
  return '0x' + word.slice(24);
}

export interface ResolveEnsOptions {
  rpcUrls?: string[];
  timeoutMs?: number;
  rpcCall?: (
    rpcUrls: string[],
    method: string,
    params: unknown[],
    timeoutMs?: number
  ) => Promise<{ result?: string; error?: { message?: string; code?: number } }>;
}

/**
 * Resolves an ENS `.eth` name (including multi-label subdomains like `sub.name.eth`)
 * on Ethereum mainnet via the canonical ENS Registry (`0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`)
 * and the configured Public Resolver's `addr(bytes32)`.
 *
 * Returns EIP-55 checksummed address if resolved to a non-zero address, or `null` if unregistered / zero.
 * Throws `EnsResolutionError` with code `'INVALID_NAME'` for malformed names or `'RPC_ERROR'` if RPC fails.
 */
export async function resolveEnsName(
  name: string,
  opts: ResolveEnsOptions = {}
): Promise<string | null> {
  const clean = name.trim().toLowerCase();
  if (!isValidEnsName(clean)) {
    throw new EnsResolutionError(
      name,
      'INVALID_NAME',
      `Invalid ENS name format: "${name.trim()}". Expected a valid .eth domain (e.g. vitalik.eth or sub.name.eth).`
    );
  }

  const nodeHex = ensNamehash(clean).slice(2);
  const rpcUrls =
    opts.rpcUrls?.length
      ? opts.rpcUrls
      : EVM_CHAINS.ethereum.rpcUrls?.length
      ? EVM_CHAINS.ethereum.rpcUrls
      : [EVM_CHAINS.ethereum.rpcUrl];
  const timeoutMs = opts.timeoutMs ?? 4500;
  const callRpc = opts.rpcCall ?? evmJsonRpcCall<string>;

  let resolverRes: { result?: string; error?: { message?: string; code?: number } };
  try {
    resolverRes = await callRpc(
      rpcUrls,
      'eth_call',
      [{ to: ENS_REGISTRY_ADDRESS, data: `0x${ENS_RESOLVER_SELECTOR}${nodeHex}` }, 'latest'],
      timeoutMs
    );
  } catch (err) {
    throw new EnsResolutionError(
      clean,
      'RPC_ERROR',
      `Ethereum mainnet RPC failed while querying ENS Registry for "${clean}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (resolverRes.error) return null;
  const resolverAddr = decodeAbiAddressWord(resolverRes.result);
  if (!resolverAddr || resolverAddr === ZERO_EVM_ADDRESS) {
    return null;
  }

  let addrRes: { result?: string; error?: { message?: string; code?: number } };
  try {
    addrRes = await callRpc(
      rpcUrls,
      'eth_call',
      [{ to: resolverAddr, data: `0x${ENS_ADDR_SELECTOR}${nodeHex}` }, 'latest'],
      timeoutMs
    );
  } catch (err) {
    throw new EnsResolutionError(
      clean,
      'RPC_ERROR',
      `Ethereum mainnet RPC failed while querying ENS Resolver (${resolverAddr}) for "${clean}": ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  if (addrRes.error) return null;
  const resolvedAddr = decodeAbiAddressWord(addrRes.result);
  if (!resolvedAddr || resolvedAddr === ZERO_EVM_ADDRESS) {
    return null;
  }

  return toChecksumEvmAddress(resolvedAddr);
}

export async function resolveEnsNameOrThrow(
  name: string,
  opts: ResolveEnsOptions = {}
): Promise<string> {
  const clean = name.trim().toLowerCase();
  const resolved = await resolveEnsName(clean, opts);
  if (!resolved) {
    throw new EnsResolutionError(
      clean,
      'UNRESOLVED',
      `ENS name "${clean}" does not resolve to a non-zero Ethereum mainnet address.`
    );
  }
  return resolved;
}

// =====================================================================
// 2. BITCOIN (Base58Check P2PKH/P2SH + BIP-173/350 Bech32/Bech32m)
// =====================================================================

export function validateBitcoinAddress(
  address: string
): AddressValidationResult<{ type: BitcoinAddressType; witnessVersion?: number }> {
  const clean = address.trim();
  if (!clean) return { valid: false, reason: 'Empty Bitcoin address.' };

  // SegWit v0 (Bech32) & Taproot v1 (Bech32m) on Bitcoin mainnet ("bc")
  if (/^bc1/i.test(clean)) {
    const decoded = decodeBech32Strict(clean);
    if (!decoded) {
      return { valid: false, reason: 'Invalid Bitcoin Bech32/Bech32m checksum, charset, or mixed case.' };
    }
    if (decoded.hrp !== 'bc') {
      return { valid: false, reason: `Unsupported Bitcoin Bech32 HRP "${decoded.hrp}" (expected "bc").` };
    }
    if (decoded.words.length < 1) {
      return { valid: false, reason: 'Missing Bitcoin witness version.' };
    }

    const witnessVersion = decoded.words[0];
    if (witnessVersion !== 0 && witnessVersion !== 1) {
      return {
        valid: false,
        reason: `Unsupported Bitcoin witness version ${witnessVersion} (only v0 SegWit and v1 Taproot are supported).`,
      };
    }

    // BIP-350: v0 MUST use Bech32; v1 MUST use Bech32m
    if (witnessVersion === 0 && decoded.encoding !== 'bech32') {
      return { valid: false, reason: 'Bitcoin SegWit v0 addresses must use Bech32 (not Bech32m).' };
    }
    if (witnessVersion === 1 && decoded.encoding !== 'bech32m') {
      return { valid: false, reason: 'Bitcoin Taproot v1 addresses must use Bech32m (not Bech32).' };
    }

    const program = convertBits(decoded.words.slice(1), 5, 8, false);
    if (!program) {
      return { valid: false, reason: 'Invalid Bitcoin witness program bit padding.' };
    }

    if (witnessVersion === 0) {
      if (program.length === 20) {
        return { valid: true, normalized: clean.toLowerCase(), meta: { type: 'p2wpkh', witnessVersion: 0 } };
      }
      if (program.length === 32) {
        return { valid: true, normalized: clean.toLowerCase(), meta: { type: 'p2wsh', witnessVersion: 0 } };
      }
      return {
        valid: false,
        reason: `Invalid Bitcoin SegWit v0 program length: ${program.length} bytes (expected 20 or 32).`,
      };
    }

    // witnessVersion === 1 (BIP-341 Taproot)
    if (program.length !== 32) {
      return {
        valid: false,
        reason: `Invalid Bitcoin Taproot v1 program length: ${program.length} bytes (expected 32).`,
      };
    }
    return { valid: true, normalized: clean.toLowerCase(), meta: { type: 'p2tr', witnessVersion: 1 } };
  }

  // Legacy Base58Check: P2PKH (0x00 -> "1...") or P2SH (0x05 -> "3...")
  if (clean[0] === '1' || clean[0] === '3') {
    const b58 = decodeBase58Check(clean);
    if (!b58) {
      return { valid: false, reason: 'Invalid Bitcoin Base58Check double-SHA256 checksum.' };
    }
    if (b58.rawPayload.length !== 21) {
      return {
        valid: false,
        reason: `Invalid Bitcoin Base58Check payload length: ${b58.rawPayload.length} bytes (expected 21).`,
      };
    }
    if (b58.version === 0x00) {
      return { valid: true, normalized: clean, meta: { type: 'p2pkh' } };
    }
    if (b58.version === 0x05) {
      return { valid: true, normalized: clean, meta: { type: 'p2sh' } };
    }
    return {
      valid: false,
      reason: `Unsupported Bitcoin Base58Check version byte 0x${b58.version.toString(16)}.`,
    };
  }

  return { valid: false, reason: 'Unrecognized Bitcoin mainnet address format.' };
}

// =====================================================================
// 3. TRON (Base58Check 0x41 + 42-char 41... Hex)
// =====================================================================

export function validateTronAddress(
  address: string
): AddressValidationResult<{ format: TronAddressFormat; base58: string; hex: string }> {
  const clean = address.trim();
  if (!clean) return { valid: false, reason: 'Empty Tron address.' };

  // 42-char hex format: 0x41 prefix byte without leading 0x -> "41" + 40 hex chars
  if (/^41[0-9a-fA-F]{40}$/.test(clean)) {
    const hex = clean.toLowerCase();
    const rawPayload = Buffer.from(hex, 'hex');
    const base58 = encodeBase58Check(rawPayload);
    return {
      valid: true,
      normalized: base58,
      meta: { format: 'hex', base58, hex },
    };
  }

  // Mainnet Base58Check ("T...", version 0x41, 21-byte payload + 4-byte double-SHA256 checksum)
  if (clean.startsWith('T')) {
    const b58 = decodeBase58Check(clean);
    if (!b58) {
      return { valid: false, reason: 'Invalid Tron Base58Check double-SHA256 checksum.' };
    }
    if (b58.rawPayload.length !== 21 || b58.version !== 0x41) {
      return {
        valid: false,
        reason: `Invalid Tron address version/length (expected 21 bytes with 0x41 version).`,
      };
    }
    const hex = Buffer.from(b58.rawPayload).toString('hex');
    return {
      valid: true,
      normalized: clean,
      meta: { format: 'base58check', base58: clean, hex },
    };
  }

  return { valid: false, reason: 'Expected Tron Base58Check (T...) or 42-char 41... hex address.' };
}

// =====================================================================
// 4. COSMOS (Strict Bech32 + Exact Supported HRP Mapping)
// =====================================================================

export function getCosmosChainForAddress(address: string): CosmosChainId | null {
  const res = validateCosmosAddress(address);
  return res.valid && res.meta ? res.meta.chain : null;
}

export function validateCosmosAddress(
  address: string
): AddressValidationResult<{ chain: CosmosChainId; hrp: string }> {
  const clean = address.trim();
  if (!clean) return { valid: false, reason: 'Empty Cosmos address.' };

  const decoded = decodeBech32Strict(clean);
  if (!decoded) {
    return { valid: false, reason: 'Invalid Cosmos Bech32 checksum, charset, or mixed case.' };
  }
  if (decoded.encoding !== 'bech32') {
    return { valid: false, reason: 'Cosmos addresses must use BIP-173 Bech32 (not Bech32m).' };
  }
  if (!Object.prototype.hasOwnProperty.call(COSMOS_HRP_TO_CHAIN, decoded.hrp)) {
    return {
      valid: false,
      reason: `Unsupported Cosmos HRP "${decoded.hrp}" (no fallback to cosmoshub).`,
    };
  }

  const payload = convertBits(decoded.words, 5, 8, false);
  if (!payload || (payload.length !== 20 && payload.length !== 32)) {
    return {
      valid: false,
      reason: `Invalid Cosmos address payload length (expected 20 or 32 bytes).`,
    };
  }

  const chain = COSMOS_HRP_TO_CHAIN[decoded.hrp];
  return {
    valid: true,
    normalized: clean.toLowerCase(),
    meta: { chain, hrp: decoded.hrp },
  };
}

export function validateCosmosAddressList(
  rawAddress: string
): AddressValidationResult<{ chains: CosmosChainId[]; addresses: string[] }> {
  const trimmed = rawAddress.trim();
  if (!trimmed) return { valid: false, reason: 'Empty Cosmos address list.' };

  const parts = trimmed.split(',').map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) {
    return { valid: false, reason: 'Empty entry in comma-separated Cosmos address list.' };
  }

  const chains: CosmosChainId[] = [];
  const addresses: string[] = [];
  for (const part of parts) {
    const res = validateCosmosAddress(part);
    if (!res.valid || !res.meta || !res.normalized) {
      return { valid: false, reason: res.reason ?? 'Invalid Cosmos address in list.' };
    }
    chains.push(res.meta.chain);
    addresses.push(res.normalized);
  }

  return {
    valid: true,
    normalized: addresses.join(','),
    meta: { chains, addresses },
  };
}

// =====================================================================
// 5. TON (CRC16-XMODEM Friendly Base64/Base64URL + Mainnet Raw Format)
// =====================================================================

const TON_TAG_MAINNET_BOUNCEABLE = 0x11;
const TON_TAG_MAINNET_NON_BOUNCEABLE = 0x51;
const TON_TAG_TESTNET_FLAG = 0x80;

export function validateTonAddress(
  address: string
): AddressValidationResult<{ format: TonAddressFormat; workchain: -1 | 0; bounceable?: boolean }> {
  const clean = address.trim();
  if (!clean) return { valid: false, reason: 'Empty TON address.' };

  // Raw format: strictly -1:<64hex> (masterchain) or 0:<64hex> (basechain); rejects -0:
  if (clean.includes(':')) {
    if (!/^(-1|0):[0-9a-fA-F]{64}$/.test(clean)) {
      return {
        valid: false,
        reason: 'Invalid TON raw address (expected -1:<64hex> or 0:<64hex>; -0: is forbidden).',
      };
    }
    const workchain: -1 | 0 = clean.startsWith('-1:') ? -1 : 0;
    const hash = clean.slice(clean.indexOf(':') + 1).toLowerCase();
    return {
      valid: true,
      normalized: `${workchain}:${hash}`,
      meta: { format: 'raw', workchain },
    };
  }

  // Friendly format: 48 Base64 or Base64URL chars -> 36 bytes (tag + workchain + 32-byte hash + 2-byte CRC16-XMODEM)
  if (clean.length !== 48) {
    return { valid: false, reason: 'Invalid TON friendly address length (expected 48 characters).' };
  }
  const isBase64Url = /^[A-Za-z0-9_-]{48}$/.test(clean);
  const isBase64Std = /^[A-Za-z0-9+/]{48}$/.test(clean);
  if (!isBase64Url && !isBase64Std) {
    return { valid: false, reason: 'Invalid TON Base64/Base64URL characters (do not mix variants).' };
  }

  const stdB64 = isBase64Url ? clean.replace(/-/g, '+').replace(/_/g, '/') : clean;
  const buf = Buffer.from(stdB64, 'base64');
  if (buf.length !== 36) {
    return { valid: false, reason: 'Decoded TON friendly address must be exactly 36 bytes.' };
  }

  const tag = buf[0];
  if ((tag & TON_TAG_TESTNET_FLAG) !== 0) {
    return { valid: false, reason: 'TON testnet addresses (0x80 flag, e.g. kQ/0Q) are rejected on mainnet.' };
  }
  if (tag !== TON_TAG_MAINNET_BOUNCEABLE && tag !== TON_TAG_MAINNET_NON_BOUNCEABLE) {
    return {
      valid: false,
      reason: `Unsupported TON address tag byte 0x${tag.toString(16)} (expected 0x11 or 0x51).`,
    };
  }

  const workchainSigned = buf.readInt8(1);
  if (workchainSigned !== 0 && workchainSigned !== -1) {
    return {
      valid: false,
      reason: `Unsupported TON workchain ${workchainSigned} (expected 0 or -1).`,
    };
  }

  const expectedCrc = crc16Xmodem(buf.subarray(0, 34));
  const actualCrc = (buf[34] << 8) | buf[35];
  if (expectedCrc !== actualCrc) {
    return {
      valid: false,
      reason: `Invalid TON CRC16-XMODEM checksum (expected 0x${expectedCrc.toString(16).padStart(4, '0')}, got 0x${actualCrc.toString(16).padStart(4, '0')}).`,
    };
  }

  return {
    valid: true,
    normalized: clean,
    meta: {
      format: isBase64Url ? 'friendly_base64url' : 'friendly_base64',
      workchain: workchainSigned,
      bounceable: tag === TON_TAG_MAINNET_BOUNCEABLE,
    },
  };
}

// =====================================================================
// 6. SUI & APTOS (Short & Full Move Addresses: 0x1 .. 0x + 64 hex)
// =====================================================================

export function normalizeMoveAddress(address: string): string | null {
  const clean = address.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(clean)) return null;
  return '0x' + clean.slice(2).toLowerCase().padStart(64, '0');
}

export function validateMoveAddress(
  address: string
): AddressValidationResult<{ isShort: boolean; hexLength: number }> {
  const clean = address.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(clean)) {
    return { valid: false, reason: 'Expected 0x followed by 1 to 64 hexadecimal characters.' };
  }
  const hex = clean.slice(2);
  return {
    valid: true,
    normalized: '0x' + hex.toLowerCase().padStart(64, '0'),
    meta: {
      isShort: hex.length < 64,
      hexLength: hex.length,
    },
  };
}

// =====================================================================
// UNIFIED CRYPTOGRAPHIC AUTO-DETECTION ACROSS ALL 7 FAMILIES
// =====================================================================

/**
 * Cryptographically detects and disambiguates a wallet address across all 7 families.
 *
 * Collision safeguards:
 * - Exact 40-hex `0x...` addresses are ALWAYS validated as EVM (with EIP-55 mixed-case check)
 *   so they never collide with Move short addresses even when `preferredFamily` is `'sui'`/`'aptos'`.
 * - Short Move addresses (`0x1`..`0x`+63 hex, excluding 40-hex) require `preferredFamily` to be
 *   `'sui'` or `'aptos'` so unhinted truncated hex strings never misdetect as Sui.
 * - Full 64-hex Move addresses (`0x`+64 hex) honor `preferredFamily` (`'sui'`/`'aptos'`);
 *   when unhinted, they default to `'sui'` and explicitly set `ambiguous: true` with
 *   `possibleFamilies: ['sui', 'aptos']`.
 * - Bitcoin, Tron, Cosmos, and TON all require valid cryptographic checksums (Base58Check
 *   double-SHA256, BIP-173/350 Bech32/Bech32m, CRC16-XMODEM), defeating Solana pubkey collisions.
 */
export function detectAddress(
  rawAddress: string,
  preferredFamily?: ChainFamily
): DetectedAddress | null {
  if (!rawAddress || typeof rawAddress !== 'string') return null;
  const addr = rawAddress.trim();
  if (!addr) return null;

  // 1. Exact 40-hex 0x... -> EVM ONLY (prevents collision with short Move addresses & rejects bad EIP-55)
  if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    const evm = validateEvmHexAddress(addr);
    if (!evm.valid || !evm.normalized) return null;
    return {
      family: 'evm',
      normalized: evm.normalized,
      ambiguous: false,
      possibleFamilies: ['evm'],
      isEns: false,
    };
  }

  // 2. Exact 64-hex 0x... -> Move (Sui / Aptos), disambiguated by preferredFamily
  if (/^0x[0-9a-fA-F]{64}$/.test(addr)) {
    const normalized = addr.toLowerCase();
    if (preferredFamily === 'aptos' || preferredFamily === 'sui') {
      return {
        family: preferredFamily,
        normalized,
        ambiguous: false,
        possibleFamilies: [preferredFamily],
      };
    }
    return {
      family: 'sui',
      normalized,
      ambiguous: true,
      possibleFamilies: ['sui', 'aptos'],
      disambiguationHint:
        '64-hex Move address is valid on both Sui and Aptos; specify preferredFamily ("sui" or "aptos") to disambiguate.',
    };
  }

  // 3. Short Move address (0x1..0x + 63 hex, excluding 40-hex handled above) when Move preferredFamily is set
  if (/^0x[0-9a-fA-F]{1,63}$/.test(addr)) {
    if (preferredFamily === 'sui' || preferredFamily === 'aptos') {
      const move = validateMoveAddress(addr);
      if (move.valid && move.normalized) {
        return {
          family: preferredFamily,
          normalized: move.normalized,
          ambiguous: false,
          possibleFamilies: [preferredFamily],
        };
      }
    }
    return null;
  }

  // 4. ENS .eth domain (supports vitalik.eth and multi-label subdomains like sub.name.eth)
  if (isValidEnsName(addr)) {
    return {
      family: 'evm',
      normalized: addr.toLowerCase(),
      ambiguous: false,
      possibleFamilies: ['evm'],
      isEns: true,
    };
  }

  // 5. Cosmos Bech32 (single or comma-separated multi-chain Cosmos addresses)
  const cosmos = validateCosmosAddressList(addr);
  if (cosmos.valid && cosmos.normalized && cosmos.meta) {
    return {
      family: 'cosmos',
      normalized: cosmos.normalized,
      ambiguous: false,
      possibleFamilies: ['cosmos'],
      cosmosChain: cosmos.meta.chains[0],
      cosmosChains: cosmos.meta.chains,
    };
  }

  // 6. Tron (Base58Check 0x41 or 42-char 41... hex)
  const tron = validateTronAddress(addr);
  if (tron.valid && tron.normalized && tron.meta) {
    return {
      family: 'tron',
      normalized: tron.normalized,
      ambiguous: false,
      possibleFamilies: ['tron'],
      tronFormat: tron.meta.format,
    };
  }

  // 7. TON (CRC16-XMODEM mainnet friendly Base64/Base64URL or raw -1:/0:)
  const ton = validateTonAddress(addr);
  if (ton.valid && ton.normalized && ton.meta) {
    return {
      family: 'ton',
      normalized: ton.normalized,
      ambiguous: false,
      possibleFamilies: ['ton'],
      tonFormat: ton.meta.format,
    };
  }

  // 8. Bitcoin (Base58Check 0x00/0x05 or BIP-173/350 Bech32/Bech32m bc1q/bc1p)
  const btc = validateBitcoinAddress(addr);
  if (btc.valid && btc.normalized && btc.meta) {
    return {
      family: 'btc',
      normalized: btc.normalized,
      ambiguous: false,
      possibleFamilies: ['btc'],
      bitcoinType: btc.meta.type,
    };
  }

  return null;
}

export function detectAddressFamilyStrict(
  rawAddress: string,
  preferredFamily?: ChainFamily
): ChainFamily | null {
  return detectAddress(rawAddress, preferredFamily)?.family ?? null;
}
