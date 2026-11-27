import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';
import {
  computePreservationFee,
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  getProtocolFeeConfig,
  SOLANA_CCTP_DOMAIN,
  type PreservationFeeOptions,
} from '../scanner/chains.js';
import { fetchSolanaWalletBalances } from '../scanner/discovery.js';
import { evaluateChainBatchRoi } from '../scanner/roi.js';
import { evmJsonRpcCall } from '../scanner/rpc.js';
import type { AnyChainId, CctpBridgeLeg, EvmChainId, MigrationPlan, ScanReport } from '../scanner/types.js';

// Circle CCTP V1 TokenMessenger.depositForBurn(uint256,uint32,bytes32,address)
export const CCTP_V1_DEPOSIT_FOR_BURN_SELECTOR = '6fd3504e';
// Circle CCTP V2 TokenMessengerV2.depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)
export const CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR = '8e0250ee';
export const CCTP_V2_FAST_FINALITY_THRESHOLD = 1000;
export const CCTP_V2_STANDARD_FINALITY_THRESHOLD = 2000;
export const CCTP_V2_IRIS_FEES_BASE_URL = 'https://iris-api.circle.com/v2/burn/USDC/fees';
export const CCTP_V2_MAX_FEE_BPS_SAFETY_CAP = 50; // 0.50% hard cap protecting against malformed/spoofed fee quotes

/**
 * Fallback Circle CCTP V2 Fast Transfer fee schedule (bps) per source domain when Circle Iris
 * fee endpoint is unreachable (Standard Transfer is always 0 bps).
 */
export const CCTP_V2_FALLBACK_FAST_FEE_BPS: Record<number, number> = {
  0: 1.0,  // Ethereum (~15s soft finality vs 13m standard)
  1: 1.0,  // Avalanche
  2: 1.3,  // Optimism
  3: 1.4,  // Arbitrum
  6: 1.3,  // Base
  7: 1.3,  // Polygon
  10: 1.3, // Unichain
  11: 15.0, // Linea (live Circle Iris V2 fast fee is ~13 bps; 15 bps covers with safe headroom)
  13: 1.0, // Sonic
  14: 1.3, // World Chain
  19: 1.0, // HyperEVM
  21: 2.0, // Ink
};

/**
 * Standard finality attestation ETAs (seconds) for CCTP V2 Standard Transfer (`minFinalityThreshold = 2000`, 0 bps)
 * vs Fast Transfer (`minFinalityThreshold = 1000`, `cfg.cctpAttestationSec`).
 */
export const CCTP_V2_STANDARD_FINALITY_SEC: Partial<Record<EvmChainId, number>> = {
  ethereum: 780,   // ~13 min Ethereum L1 finality
  base: 900,       // ~15 min OP-Stack L1 finality
  arbitrum: 900,   // ~15 min Arbitrum L1 finality
  optimism: 900,   // ~15 min OP-Stack L1 finality
  unichain: 900,   // ~15 min OP-Stack L1 finality
  linea: 900,      // ~15 min Linea L1 finality
  worldchain: 900, // ~15 min OP-Stack L1 finality
  ink: 900,        // ~15 min OP-Stack L1 finality
  polygon: 20,
  avalanche: 12,
  sonic: 12,
  hyperevm: 15,
};

export function getCctpEstimatedSeconds(
  chain: EvmChainId,
  transferMode: CctpTransferMode = 'fast'
): number {
  const cfg = EVM_CHAINS[chain];
  if (!cfg) return 20;
  if (cfg.cctpVersion === 2 && transferMode === 'standard') {
    return CCTP_V2_STANDARD_FINALITY_SEC[chain] ?? Math.max(cfg.cctpAttestationSec, 780);
  }
  return cfg.cctpAttestationSec;
}

export type CctpTransferMode = 'fast' | 'standard';

export interface CctpV2FeeTier {
  finalityThreshold: number;
  minimumFeeBps: number;
  forwardFee?: {
    low?: number;
    medium?: number;
    high?: number;
  };
}

export interface CctpV2BurnFeeQuote {
  sourceDomain: number;
  destinationDomain: number;
  mode: CctpTransferMode;
  minFinalityThreshold: number;
  feeBps: number;
  forwardFeeUsdc6?: number;
  maxFeeRaw?: bigint;
  source: 'circle_iris_live' | 'fallback';
  endpoint: string;
  tiers: CctpV2FeeTier[];
}

const ZERO_BYTES32 = '0x' + '00'.repeat(32);

// Canonical Solana SPL Token, Associated Token Account Program, and Native USDC Mint
export const SOLANA_TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);
export const SOLANA_USDC_MINT_PUBKEY = new PublicKey(
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
);

// Circle CCTP MessageTransmitter event: MessageSent(bytes message)
export const CCTP_MESSAGE_SENT_TOPIC =
  '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036';
export const SOLANA_CCTP_PROGRAMS = {
  messageTransmitter: 'CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd',
  tokenMessengerMinter: 'CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3',
} as const;
export const SOLANA_CCTP_PROGRAMS_V2 = {
  messageTransmitter: 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
  tokenMessengerMinter: 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
} as const;

export type SolanaCctpPrograms =
  | typeof SOLANA_CCTP_PROGRAMS
  | typeof SOLANA_CCTP_PROGRAMS_V2;

export function getSolanaCctpPrograms(cctpVersion?: 1 | 2 | null): SolanaCctpPrograms {
  return cctpVersion === 2 ? SOLANA_CCTP_PROGRAMS_V2 : SOLANA_CCTP_PROGRAMS;
}

export function getCctpIrisAttestationUrl(params: {
  cctpVersion: 1 | 2;
  messageHash?: string;
  sourceDomain?: number | null;
  txHash?: string;
}): string {
  if (params.cctpVersion === 2) {
    if (params.sourceDomain === null || params.sourceDomain === undefined || !params.txHash) {
      throw new Error('CCTP V2 Iris polling requires sourceDomain and txHash');
    }
    return `https://iris-api.circle.com/v2/messages/${params.sourceDomain}?transactionHash=${encodeURIComponent(params.txHash)}`;
  }
  if (!params.messageHash) {
    throw new Error('CCTP V1 Iris polling requires messageHash');
  }
  return `https://iris-api.circle.com/v1/attestations/${encodeURIComponent(params.messageHash)}`;
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * Validates a Solana base58 public key and converts its raw 32 bytes into a 0x-prefixed bytes32.
 * WARNING: For Circle CCTP `mintRecipient` on Solana (domain 5), ALWAYS use `solanaOwnerToUsdcAtaBytes32`
 * (the canonical SPL USDC Associated Token Account PDA) — never pass the raw wallet owner pubkey!
 */
export function solanaAddressToBytes32(solanaAddress: string): string {
  const pubkey = new PublicKey(solanaAddress.trim());
  if (pubkey.equals(PublicKey.default)) {
    throw new Error('Invalid Solana address: all-zero System Program pubkey is not allowed');
  }
  return '0x' + Buffer.from(pubkey.toBytes()).toString('hex');
}

/**
 * Derives the canonical Solana USDC Associated Token Account (ATA) PDA for a Solana wallet owner.
 * Circle CCTP `TokenMessengerMinter.handle_receive_message` on Solana requires `mintRecipient` to be
 * the recipient's SPL USDC Token Account (canonical ATA), NOT the raw wallet owner pubkey.
 */
export function deriveSolanaUsdcAta(ownerPubkey: string): PublicKey {
  const trimmed = ownerPubkey.trim();
  if (!trimmed) {
    throw new Error('Solana owner public key is required');
  }
  const owner = new PublicKey(trimmed);
  if (owner.equals(PublicKey.default)) {
    throw new Error('Invalid Solana owner public key: all-zero System Program pubkey is not allowed');
  }
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), SOLANA_TOKEN_PROGRAM_ID.toBytes(), SOLANA_USDC_MINT_PUBKEY.toBytes()],
    SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

/**
 * Derives the canonical 32-byte Solana USDC Associated Token Account (ATA) PDA as a 0x-prefixed
 * EVM `bytes32` value for Circle CCTP `depositForBurn(..., mintRecipient, ...)`.
 */
export function solanaOwnerToUsdcAtaBytes32(ownerPubkey: string): string {
  const ata = deriveSolanaUsdcAta(ownerPubkey);
  return '0x' + Buffer.from(ata.toBytes()).toString('hex');
}

/**
 * Computes a bounded raw USDC `maxFee` ceiling (6-decimal micro-USDC) for CCTP V2 `depositForBurn`
 * from a bps fee quote (supports fractional bps such as 1.3 or 1.4 bps), rounding up to avoid
 * 1-unit under-quoting while strictly guaranteeing `maxFee < rawUsdcAmount`.
 */
export function computeCctpV2MaxFeeRaw(
  rawUsdcAmount: bigint,
  feeBps: number,
  options?: { bufferBps?: number; maxFeeBpsCap?: number }
): bigint {
  if (rawUsdcAmount <= 0n || !Number.isFinite(feeBps) || feeBps <= 0) {
    return 0n;
  }
  const bufferBps =
    options?.bufferBps !== undefined && Number.isFinite(options.bufferBps) && options.bufferBps > 0
      ? options.bufferBps
      : 0;
  const capBps =
    options?.maxFeeBpsCap !== undefined &&
    Number.isFinite(options.maxFeeBpsCap) &&
    options.maxFeeBpsCap > 0
      ? options.maxFeeBpsCap
      : CCTP_V2_MAX_FEE_BPS_SAFETY_CAP;

  const effectiveBps = Math.min(capBps, feeBps + bufferBps);
  // 1 bps = 1/10,000; scale by 100 for 0.01 bps precision => denominator = 1,000,000
  const scaledHundredthsBps = BigInt(Math.ceil(effectiveBps * 100));
  if (scaledHundredthsBps <= 0n) return 0n;

  const ceilFee = (rawUsdcAmount * scaledHundredthsBps + 999_999n) / 1_000_000n;
  if (rawUsdcAmount === 1n) return 0n;
  const bounded = ceilFee >= rawUsdcAmount ? rawUsdcAmount - 1n : ceilFee;
  return bounded > 0n ? bounded : 1n;
}

/**
 * Queries Circle's live CCTP V2 burn fee schedule at:
 *   GET https://iris-api.circle.com/v2/burn/USDC/fees/{sourceDomain}/{destDomain}
 *
 * Returns Fast Transfer (`minFinalityThreshold = 1000`, ~1–1.4 bps) or Standard Transfer
 * (`minFinalityThreshold = 2000`, 0 bps) with a safe domain-calibrated fallback if the
 * upstream Circle API is unreachable or returns malformed data.
 */
export async function fetchCctpV2BurnFee(params: {
  sourceDomain: number;
  destinationDomain?: number;
  mode?: CctpTransferMode;
  rawUsdcAmount?: bigint;
  bufferBps?: number;
  maxFeeBpsCap?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): Promise<CctpV2BurnFeeQuote> {
  const { sourceDomain } = params;
  const destinationDomain = params.destinationDomain ?? SOLANA_CCTP_DOMAIN;
  const mode: CctpTransferMode = params.mode ?? 'fast';

  if (!Number.isInteger(sourceDomain) || sourceDomain < 0 || sourceDomain > 0xffffffff) {
    throw new Error(`Invalid CCTP V2 sourceDomain: ${sourceDomain}`);
  }
  if (
    !Number.isInteger(destinationDomain) ||
    destinationDomain < 0 ||
    destinationDomain > 0xffffffff
  ) {
    throw new Error(`Invalid CCTP V2 destinationDomain: ${destinationDomain}`);
  }

  const capBps =
    params.maxFeeBpsCap !== undefined &&
    Number.isFinite(params.maxFeeBpsCap) &&
    params.maxFeeBpsCap > 0
      ? params.maxFeeBpsCap
      : CCTP_V2_MAX_FEE_BPS_SAFETY_CAP;

  const endpoint = `${CCTP_V2_IRIS_FEES_BASE_URL}/${sourceDomain}/${destinationDomain}`;
  const fallbackFastBps = CCTP_V2_FALLBACK_FAST_FEE_BPS[sourceDomain] ?? 1.4;
  const fallbackTiers: CctpV2FeeTier[] = [
    { finalityThreshold: CCTP_V2_FAST_FINALITY_THRESHOLD, minimumFeeBps: fallbackFastBps },
    { finalityThreshold: CCTP_V2_STANDARD_FINALITY_THRESHOLD, minimumFeeBps: 0 },
  ];

  const buildFallback = (): CctpV2BurnFeeQuote => {
    const isFast = mode === 'fast';
    const feeBps = isFast ? Math.min(capBps, fallbackFastBps) : 0;
    const minFinalityThreshold = isFast
      ? CCTP_V2_FAST_FINALITY_THRESHOLD
      : CCTP_V2_STANDARD_FINALITY_THRESHOLD;
    const maxFeeRaw =
      params.rawUsdcAmount !== undefined
        ? isFast
          ? computeCctpV2MaxFeeRaw(params.rawUsdcAmount, feeBps, {
              bufferBps: params.bufferBps,
              maxFeeBpsCap: capBps,
            })
          : 0n
        : undefined;
    return {
      sourceDomain,
      destinationDomain,
      mode,
      minFinalityThreshold,
      feeBps,
      maxFeeRaw,
      source: 'fallback',
      endpoint,
      tiers: fallbackTiers,
    };
  };

  const fetchImpl = params.fetcher ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return buildFallback();
  }

  const controller = new AbortController();
  const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 3500;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(endpoint, { signal: controller.signal });
    if (!res.ok) {
      return buildFallback();
    }
    const rawJson = (await res.json()) as unknown;
    const rawList = Array.isArray(rawJson)
      ? rawJson
      : rawJson && typeof rawJson === 'object' && Array.isArray((rawJson as { data?: unknown }).data)
      ? (rawJson as { data: unknown[] }).data
      : rawJson && typeof rawJson === 'object' && Array.isArray((rawJson as { fees?: unknown }).fees)
      ? (rawJson as { fees: unknown[] }).fees
      : null;

    if (!rawList || rawList.length === 0) {
      return buildFallback();
    }

    const tiers: CctpV2FeeTier[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as {
        finalityThreshold?: unknown;
        minimumFee?: unknown;
        forwardFee?: { low?: unknown; medium?: unknown; high?: unknown };
      };
      const finalityThreshold = Number(obj.finalityThreshold);
      const minimumFeeBps = Number(obj.minimumFee);
      if (
        !Number.isInteger(finalityThreshold) ||
        finalityThreshold < 0 ||
        !Number.isFinite(minimumFeeBps) ||
        minimumFeeBps < 0
      ) {
        continue;
      }
      const tier: CctpV2FeeTier = { finalityThreshold, minimumFeeBps };
      if (obj.forwardFee && typeof obj.forwardFee === 'object') {
        const low = Number(obj.forwardFee.low);
        const medium = Number(obj.forwardFee.medium);
        const high = Number(obj.forwardFee.high);
        tier.forwardFee = {
          ...(Number.isFinite(low) && low >= 0 ? { low } : {}),
          ...(Number.isFinite(medium) && medium >= 0 ? { medium } : {}),
          ...(Number.isFinite(high) && high >= 0 ? { high } : {}),
        };
      }
      tiers.push(tier);
    }

    if (tiers.length === 0) {
      return buildFallback();
    }

    const isFast = mode === 'fast';
    const selected = isFast
      ? tiers.find((t) => t.finalityThreshold === CCTP_V2_FAST_FINALITY_THRESHOLD) ??
        tiers.find((t) => t.finalityThreshold <= CCTP_V2_FAST_FINALITY_THRESHOLD)
      : tiers.find((t) => t.finalityThreshold === CCTP_V2_STANDARD_FINALITY_THRESHOLD) ??
        tiers.find((t) => t.finalityThreshold >= CCTP_V2_STANDARD_FINALITY_THRESHOLD);

    if (!selected) {
      return buildFallback();
    }

    const boundedFeeBps = isFast
      ? Math.min(capBps, selected.minimumFeeBps)
      : Math.min(capBps, selected.minimumFeeBps);
    const minFinalityThreshold = selected.finalityThreshold;
    const forwardFeeUsdc6 =
      selected.forwardFee?.medium ?? selected.forwardFee?.low ?? selected.forwardFee?.high;
    const maxFeeRaw =
      params.rawUsdcAmount !== undefined
        ? boundedFeeBps > 0
          ? computeCctpV2MaxFeeRaw(params.rawUsdcAmount, boundedFeeBps, {
              bufferBps: params.bufferBps,
              maxFeeBpsCap: capBps,
            })
          : 0n
        : undefined;

    return {
      sourceDomain,
      destinationDomain,
      mode,
      minFinalityThreshold,
      feeBps: boundedFeeBps,
      ...(forwardFeeUsdc6 !== undefined ? { forwardFeeUsdc6 } : {}),
      maxFeeRaw,
      source: 'circle_iris_live',
      endpoint,
      tiers,
    };
  } catch {
    return buildFallback();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Encodes Circle CCTP `depositForBurn` calldata for either:
 *   - CCTP V1 (`0x6fd3504e`): depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken)
 *   - CCTP V2 (`0x8e0250ee`): depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)
 *
 * For CCTP V2, supports:
 *   - Fast Transfer (`transferMode: 'fast'`): defaults to `minFinalityThreshold = 1000` with bounded `maxFee` (~1–1.4 bps)
 *   - Standard Transfer (`transferMode: 'standard'` or omitted): defaults to `minFinalityThreshold = 2000`, `maxFee = 0n` (0 bps)
 */
export function encodeCctpDepositForBurn(params: {
  rawUsdcAmount: bigint;
  destinationDomain: number;
  solanaMintRecipientBytes32: string;
  usdcAddress: string;
  cctpVersion?: 1 | 2;
  transferMode?: CctpTransferMode;
  fastFeeBps?: number;
  destinationCallerBytes32?: string;
  maxFee?: bigint;
  minFinalityThreshold?: number;
}): string {
  if (params.rawUsdcAmount < 0n) {
    throw new Error('rawUsdcAmount must be non-negative');
  }
  if (!Number.isInteger(params.destinationDomain) || params.destinationDomain < 0 || params.destinationDomain > 0xffffffff) {
    throw new Error(`Invalid CCTP destinationDomain: ${params.destinationDomain}`);
  }
  const recClean = params.solanaMintRecipientBytes32.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(recClean) || recClean === ZERO_BYTES32) {
    throw new Error('Invalid non-zero 32-byte solanaMintRecipientBytes32');
  }
  const tokClean = params.usdcAddress.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(tokClean)) {
    throw new Error(`Invalid EVM usdcAddress: ${params.usdcAddress}`);
  }

  const amtHex = params.rawUsdcAmount.toString(16).padStart(64, '0');
  const domHex = params.destinationDomain.toString(16).padStart(64, '0');
  const recHex = recClean.slice(2);
  const tokHex = tokClean.slice(2).padStart(64, '0');

  if (params.cctpVersion === 2) {
    const callerClean = (params.destinationCallerBytes32 ?? ZERO_BYTES32).trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(callerClean)) {
      throw new Error('Invalid 32-byte destinationCallerBytes32 for CCTP V2');
    }
    const isFast = params.transferMode === 'fast';
    const maxFee =
      params.maxFee !== undefined
        ? params.maxFee
        : isFast
        ? computeCctpV2MaxFeeRaw(params.rawUsdcAmount, params.fastFeeBps ?? 1.4)
        : 0n;
    if (maxFee < 0n) throw new Error('CCTP V2 maxFee must be non-negative');
    if (params.rawUsdcAmount > 0n && maxFee >= params.rawUsdcAmount) {
      throw new Error('CCTP V2 maxFee must be strictly less than rawUsdcAmount');
    }
    // Standard finality threshold is 2000 (Fast Transfer is 1000)
    const minFinalityThreshold =
      params.minFinalityThreshold ??
      (isFast ? CCTP_V2_FAST_FINALITY_THRESHOLD : CCTP_V2_STANDARD_FINALITY_THRESHOLD);
    if (!Number.isInteger(minFinalityThreshold) || minFinalityThreshold < 0 || minFinalityThreshold > 0xffffffff) {
      throw new Error(`Invalid CCTP V2 minFinalityThreshold: ${minFinalityThreshold}`);
    }
    const callerHex = callerClean.slice(2);
    const maxFeeHex = maxFee.toString(16).padStart(64, '0');
    const finalityHex = minFinalityThreshold.toString(16).padStart(64, '0');
    return `0x${CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR}${amtHex}${domHex}${recHex}${tokHex}${callerHex}${maxFeeHex}${finalityHex}`;
  }

  return `0x${CCTP_V1_DEPOSIT_FOR_BURN_SELECTOR}${amtHex}${domHex}${recHex}${tokHex}`;
}

export interface ExtractedCctpMessage {
  messageBytesHex: string;
  messageHash: string;
  emitterAddress?: string;
}

/**
 * Extracts ALL valid Circle CCTP `MessageSent(bytes)` raw message bytes and `keccak256` hashes
 * from EVM transaction receipt logs with strict emitter-address and ABI bounds validation.
 */
export function extractAllCctpMessagesFromLogs(
  logs: Array<{ address?: string; topics?: string[]; data?: string }>,
  options?: { expectedMessageTransmitter?: string | null }
): ExtractedCctpMessage[] {
  const expectedAddr = options?.expectedMessageTransmitter?.trim().toLowerCase() || null;
  const results: ExtractedCctpMessage[] = [];

  for (const log of logs) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (topic0 !== CCTP_MESSAGE_SENT_TOPIC || !log.data) continue;

    if (expectedAddr) {
      const logAddr = log.address?.trim().toLowerCase();
      if (!logAddr || logAddr !== expectedAddr) continue;
    }

    const raw = log.data.startsWith('0x') || log.data.startsWith('0X') ? log.data.slice(2) : log.data;
    if (raw.length < 128 || raw.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(raw)) continue;

    let offsetBytes: bigint;
    try {
      offsetBytes = BigInt('0x' + raw.slice(0, 64));
    } catch {
      continue;
    }
    // Dynamic `bytes` in MessageSent(bytes) must start at a 32-byte aligned offset within bounds
    if (offsetBytes < 32n || offsetBytes > 1024n || offsetBytes % 32n !== 0n) continue;
    const lenStartBig = offsetBytes * 2n;
    const rawLenBig = BigInt(raw.length);
    if (lenStartBig + 64n > rawLenBig) continue;

    const lenStart = Number(lenStartBig);
    let msgByteLenBig: bigint;
    try {
      msgByteLenBig = BigInt('0x' + raw.slice(lenStart, lenStart + 64));
    } catch {
      continue;
    }
    if (msgByteLenBig <= 0n || msgByteLenBig > 65_536n) continue;
    const msgHexLenBig = msgByteLenBig * 2n;
    if (lenStartBig + 64n + msgHexLenBig > rawLenBig) continue;

    const msgHexLen = Number(msgHexLenBig);
    const msgHex = raw.slice(lenStart + 64, lenStart + 64 + msgHexLen);
    if (msgHex.length !== msgHexLen) continue;

    const msgBytes = Buffer.from(msgHex, 'hex');
    const hashBytes = keccak_256(msgBytes);
    const messageHash = '0x' + Buffer.from(hashBytes).toString('hex');
    results.push({
      messageBytesHex: '0x' + msgHex.toLowerCase(),
      messageHash,
      emitterAddress: log.address,
    });
  }

  return results;
}

/**
 * Extracts the first valid Circle CCTP `MessageSent(bytes)` raw message bytes and its `keccak256` message hash
 * from EVM transaction receipt logs.
 */
export function extractCctpMessageFromLogs(
  logs: Array<{ address?: string; topics?: string[]; data?: string }>,
  options?: { expectedMessageTransmitter?: string | null }
): ExtractedCctpMessage | null {
  const all = extractAllCctpMessagesFromLogs(logs, options);
  return all[0] ?? null;
}

export interface CctpAttestationResult {
  found: boolean;
  chain: EvmChainId;
  cctpVersion?: 1 | 2;
  txHash: string;
  messageHash?: string;
  messageBytesHex?: string;
  messagesCount?: number;
  attestationStatus: 'not_found' | 'pending_confirmations' | 'complete' | 'error';
  attestation?: string;
  irisEndpoint?: string;
  solanaProgramIds: SolanaCctpPrograms;
  solanaDestinationReady?: {
    address: string;
    usdcAta?: string;
    hasUsdcAta: boolean;
    solBalance: number;
    warning?: string;
  };
  nextStep: string;
}

/**
 * Fetches an EVM transaction receipt, validates receipt status and MessageTransmitter emitter,
 * extracts the Circle CCTP `MessageSent` log, polls Circle's live Iris Attestation API (V1 or V2),
 * and checks whether the Solana recipient already has a canonical USDC ATA + SOL for `receiveMessage`.
 */
export async function fetchCctpAttestationForTx(params: {
  chain: EvmChainId;
  txHash: string;
  solanaDestination?: string;
}): Promise<CctpAttestationResult> {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) throw new Error(`Unsupported chain: ${params.chain}`);
  const cctpVersion: 1 | 2 = cfg.cctpVersion === 2 ? 2 : 1;
  const solanaProgramIds = getSolanaCctpPrograms(cctpVersion);

  const receiptRes = await evmJsonRpcCall<{
    status?: string;
    logs?: Array<{ address?: string; topics?: string[]; data?: string }>;
  } | null>(cfg.rpcUrls, 'eth_getTransactionReceipt', [params.txHash], 4500);

  const receipt = receiptRes.result;
  if (!receipt || !Array.isArray(receipt.logs)) {
    return {
      found: false,
      chain: params.chain,
      cctpVersion,
      txHash: params.txHash,
      attestationStatus: 'not_found',
      solanaProgramIds,
      nextStep: 'Transaction receipt not yet indexed on EVM RPC. Retry in a few seconds.',
    };
  }

  // HIGH-10: Reject reverted transactions before scanning logs
  if (receipt.status !== '0x1') {
    return {
      found: false,
      chain: params.chain,
      cctpVersion,
      txHash: params.txHash,
      attestationStatus: 'error',
      solanaProgramIds,
      nextStep: 'EVM transaction reverted onchain (receipt.status !== 0x1). No CCTP burn occurred.',
    };
  }

  const allExtracted = extractAllCctpMessagesFromLogs(receipt.logs, {
    expectedMessageTransmitter: cfg.cctpMessageTransmitter,
  });
  const extracted = allExtracted[0] ?? null;
  if (!extracted) {
    return {
      found: false,
      chain: params.chain,
      cctpVersion,
      txHash: params.txHash,
      attestationStatus: 'not_found',
      solanaProgramIds,
      nextStep: cfg.cctpMessageTransmitter
        ? `No Circle CCTP MessageSent event from canonical MessageTransmitter (${cfg.cctpMessageTransmitter}) found in this transaction.`
        : 'No Circle CCTP MessageSent event found in this transaction.',
    };
  }

  let attestationStatus: CctpAttestationResult['attestationStatus'] = 'pending_confirmations';
  let attestation: string | undefined;
  const irisEndpoint = getCctpIrisAttestationUrl({
    cctpVersion,
    messageHash: extracted.messageHash,
    sourceDomain: cfg.cctpDomain,
    txHash: params.txHash,
  });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const irisRes = await fetch(irisEndpoint, { signal: controller.signal });
    clearTimeout(timer);
    if (irisRes.ok) {
      if (cctpVersion === 2) {
        const irisJson = (await irisRes.json()) as {
          messages?: Array<{ status?: string; attestation?: string }>;
        };
        const msg = irisJson.messages?.[0];
        if (
          msg?.status === 'complete' &&
          typeof msg.attestation === 'string' &&
          /^0x[0-9a-fA-F]{130,}$/.test(msg.attestation)
        ) {
          attestationStatus = 'complete';
          attestation = msg.attestation;
        }
      } else {
        const irisJson = (await irisRes.json()) as { status?: string; attestation?: string };
        if (
          irisJson.status === 'complete' &&
          typeof irisJson.attestation === 'string' &&
          /^0x[0-9a-fA-F]{130,}$/.test(irisJson.attestation)
        ) {
          attestationStatus = 'complete';
          attestation = irisJson.attestation;
        }
      }
    } else if (irisRes.status === 404) {
      attestationStatus = 'pending_confirmations';
    } else {
      attestationStatus = 'error';
    }
  } catch {
    attestationStatus = 'pending_confirmations';
  }

  let solanaDestinationReady: CctpAttestationResult['solanaDestinationReady'];
  if (params.solanaDestination) {
    try {
      const usdcAta = deriveSolanaUsdcAta(params.solanaDestination).toBase58();
      const bal = await fetchSolanaWalletBalances(params.solanaDestination);
      const warning = !bal.hasUsdcAta
        ? `Destination Solana wallet has no canonical USDC ATA (${usdcAta}) yet — prepend createAssociatedTokenAccountIdempotent before receiveMessage (~0.00204 SOL rent).`
        : bal.solBalance < 0.002
        ? 'Destination Solana wallet has low SOL (< 0.002 SOL) to pay receiveMessage tx fee.'
        : undefined;
      solanaDestinationReady = {
        address: bal.address,
        usdcAta,
        hasUsdcAta: bal.hasUsdcAta,
        solBalance: bal.solBalance,
        warning,
      };
    } catch {
      // non-fatal
    }
  }

  const nextStep =
    attestationStatus === 'complete'
      ? `Circle Iris V${cctpVersion} attestation is READY. Submit MessageTransmitter.receiveMessage(messageBytes, attestation) on Solana (${solanaProgramIds.messageTransmitter}) to mint native USDC to the canonical USDC ATA.`
      : attestationStatus === 'error'
      ? `Circle Iris V${cctpVersion} API returned an error for ${cfg.name}. Verify txHash and retry.`
      : `Waiting for Circle Iris V${cctpVersion} finality on ${cfg.name} (~${cfg.cctpAttestationSec}s). Poll /api/cctp/attestation again until status === "complete".`;

  return {
    found: true,
    chain: params.chain,
    cctpVersion,
    txHash: params.txHash,
    messageHash: extracted.messageHash,
    messageBytesHex: extracted.messageBytesHex,
    messagesCount: allExtracted.length,
    attestationStatus,
    attestation,
    irisEndpoint,
    solanaProgramIds,
    solanaDestinationReady,
    nextStep,
  };
}

export interface BuildPlanInput {
  scan: ScanReport;
  selectedAssetIds?: string[];
  solanaDestination: string;
  usePermit2Batch?: boolean;
  includeBurns?: boolean;
  outputAsset?: 'USDC' | 'SOL';
  bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
  cctpTransferMode?: CctpTransferMode;
  protocolFeeBps?: number;
  feeSchedule?: 'tiered' | 'flat';
  preservationFeeOpts?: PreservationFeeOptions;
  feeRecipientEvm?: string | null;
  hasSolanaUsdcAta?: boolean;
}

function getBridgeProviderMeta(
  pref: 'auto' | 'relay' | 'lifi' | 'cctp',
  outputAsset: 'USDC' | 'SOL',
  cctpSec: number
): { label: string; shortLabel: string; etaText: string; stepTitle: string } {
  const effectivePref = outputAsset === 'SOL' && pref === 'cctp' ? 'auto' : pref;
  if (effectivePref === 'relay') {
    return {
      label: 'Relay Instant Bridge (~2s auto-fill)',
      shortLabel: 'Relay Bridge',
      etaText: '~2–10s auto-fill',
      stepTitle: `Relay Bridge → Solana ${outputAsset}`,
    };
  }
  if (effectivePref === 'lifi') {
    return {
      label: 'LI.FI Aggregator (Mayan / deBridge / Relay)',
      shortLabel: 'LI.FI Router',
      etaText: '~15–30s auto-fill',
      stepTitle: `LI.FI Route → Solana ${outputAsset}`,
    };
  }
  if (effectivePref === 'cctp') {
    return {
      label: 'Circle CCTP 1:1 (Domain 5 · Solana Claim)',
      shortLabel: 'Circle CCTP 1:1',
      etaText: `~${cctpSec}s finality`,
      stepTitle: 'Circle CCTP 1:1 Burn',
    };
  }
  return {
    label: 'Auto (Relay → LI.FI → Circle CCTP)',
    shortLabel: 'Relay / LI.FI',
    etaText: '~2–15s auto-fill',
    stepTitle: `Relay / LI.FI → Solana ${outputAsset}`,
  };
}

export function buildMigrationPlan(input: BuildPlanInput): MigrationPlan {
  const {
    scan,
    selectedAssetIds,
    solanaDestination,
    usePermit2Batch = true,
    includeBurns = true,
    outputAsset = 'USDC',
  } = input;
  const rawPref = input.bridgePreference ?? 'auto';
  const bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp' =
    outputAsset === 'SOL' && rawPref === 'cctp' ? 'auto' : rawPref;
  const useTieredFee =
    input.feeSchedule === 'tiered' ||
    (input.feeSchedule !== 'flat' &&
      input.protocolFeeBps === undefined &&
      !process.env.TURGALIUM_FEE_BPS?.trim());
  const feeConfig = getProtocolFeeConfig({
    feeBps: input.protocolFeeBps,
    feeRecipientEvm: input.feeRecipientEvm,
    feeSchedule: useTieredFee ? 'tiered' : 'flat',
    preservationFeeOpts: input.preservationFeeOpts,
  });
  const effectiveCctpTransferMode: CctpTransferMode = input.cctpTransferMode ?? 'fast';

  // CRIT-04: Derive canonical Solana USDC Associated Token Account (ATA) PDA bytes32 for CCTP mintRecipient!
  // For read-only dry-run previews before a Solana wallet is connected, emit a neutral zero placeholder (never executable).
  const hasSolanaDest = Boolean(
    solanaDestination && solanaDestination.trim() && solanaDestination.trim() !== '11111111111111111111111111111111'
  );
  const solanaUsdcAta = hasSolanaDest ? deriveSolanaUsdcAta(solanaDestination).toBase58() : '';
  const solanaMintRecipientBytes32 = hasSolanaDest
    ? solanaOwnerToUsdcAtaBytes32(solanaDestination)
    : '0x' + '00'.repeat(32);
  const selectedSet = Array.isArray(selectedAssetIds)
    ? new Set(selectedAssetIds)
    : new Set(scan.assets.filter((a) => a.selectedByDefault).map((a) => a.id));

  const chosen = scan.assets.filter((a) => selectedSet.has(a.id));
  const preferredOrder: AnyChainId[] = [
    'base',
    'arbitrum',
    'optimism',
    'avalanche',
    'polygon',
    'bnb',
    'sonic',
    'unichain',
    'linea',
    'scroll',
    'mantle',
    'blast',
    'worldchain',
    'hyperevm',
    'berachain',
    'zksync',
    'ink',
    'gnosis',
    'monad',
    'ethereum',
    'noble',
    'osmosis',
    'cosmoshub',
    'celestia',
    'injective',
    'neutron',
    'sui',
    'aptos',
    'ton',
    'tron',
    'btc',
  ];
  const dynamicChains = Array.from(new Set(chosen.map((a) => a.chain)));
  const chainOrder: AnyChainId[] = [
    ...preferredOrder.filter((id) => dynamicChains.includes(id)),
    ...dynamicChains.filter((id) => !preferredOrder.includes(id)),
  ];

  const legs: CctpBridgeLeg[] = [];
  const burnManifest: MigrationPlan['burnManifest'] = [];

  // Record honeypots safely skipped across the scan
  for (const h of scan.assets.filter((a) => a.action === 'SKIP_HONEYPOT')) {
    burnManifest.push({
      chain: h.chain,
      symbol: h.symbol,
      tokenAddress: h.address,
      amount: `${h.uiBalance.toLocaleString()} ${h.symbol}`,
      burnSink: DEAD_BURN_ADDRESS,
      status: 'SKIPPED_HONEYPOT',
      reason: h.actionReason,
    });
  }

  let totalDefi = 0;
  let totalSwaps = 0;
  let totalBurns = 0;
  let totalGross = 0;
  let totalGas = 0;
  let totalSingleGas = 0;
  let totalFee = 0;
  let totalNetUsdc = 0;

  for (const chainId of chainOrder) {
    const chainAssets = chosen.filter((a) => a.chain === chainId);
    if (!chainAssets.length) continue;

    const evmCfg = (EVM_CHAINS as Record<string, (typeof EVM_CHAINS)[EvmChainId] | undefined>)[chainId];
    const chainSummary = scan.chains.find((c) => c.chain === chainId);
    const chainName = evmCfg?.name ?? chainSummary?.chainName ?? chainAssets[0]?.chainName ?? chainId;
    const cctpDomain = evmCfg ? evmCfg.cctpDomain : chainSummary?.cctpDomain ?? null;
    const tokenMessenger = evmCfg?.cctpTokenMessenger ?? 'Relayer / Bridge Router';
    const usdcAddress = evmCfg?.usdcAddress ?? 'native_usdc';
    const estSec = evmCfg
      ? getCctpEstimatedSeconds(evmCfg.id, effectiveCctpTransferMode)
      : chainSummary?.cctpAttestationSec ?? 20;

    const defiItems = chainAssets.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE');
    const swapItems = chainAssets.filter((a) => a.action === 'SELL_AND_BRIDGE');
    const directUsdcItems = chainAssets.filter((a) => a.action === 'BRIDGE_DIRECT_USDC');
    const burnItems = includeBurns
      ? chainAssets.filter((a) => a.action === 'BURN_ZERO_LIQUIDITY')
      : [];
    const skippedOnChain = scan.assets.filter(
      (a) => a.chain === chainId && a.action === 'SKIP_HONEYPOT'
    ).length;

    const liquidOrDefi = [...defiItems, ...swapItems, ...directUsdcItems];
    if (!liquidOrDefi.length && !burnItems.length) continue;

    const grossUsdc = round2(liquidOrDefi.reduce((s, a) => s + a.grossUsd, 0));
    const slippage = round2(liquidOrDefi.reduce((s, a) => s + a.estimatedSlippageUsd, 0));
    const singleGas = round4(chainAssets.reduce((s, a) => s + a.estimatedGasUsd, 0));
    const activeGas = round4(
      chainAssets.reduce((s, a) => s + (usePermit2Batch ? a.batchedGasUsd : a.estimatedGasUsd), 0)
    );
    const feeBaseUsd = Math.max(0, grossUsdc - slippage);
    const legPreservationFee = useTieredFee
      ? computePreservationFee(feeBaseUsd, input.preservationFeeOpts)
      : null;
    const feeUsdc = legPreservationFee
      ? legPreservationFee.feeUsd
      : round2((feeBaseUsd * feeConfig.feeBps) / 10_000);
    const legFeeBps = legPreservationFee
      ? Math.max(0, Math.round(legPreservationFee.effectiveFeeBps))
      : feeConfig.feeBps;
    const legFeePercent = legPreservationFee
      ? Number((legPreservationFee.effectiveFeeBps / 100).toFixed(2))
      : feeConfig.feePercent;
    const bridgedUsdc = round2(Math.max(0, grossUsdc - slippage - activeGas - feeUsdc));
    const rawUsdcAmount = BigInt(Math.round(bridgedUsdc * 1_000_000));

    const cctpCalldata =
      hasSolanaDest && evmCfg && evmCfg.cctpTokenMessenger && rawUsdcAmount > 0n
        ? encodeCctpDepositForBurn({
            rawUsdcAmount,
            destinationDomain: SOLANA_CCTP_DOMAIN,
            solanaMintRecipientBytes32,
            usdcAddress: evmCfg.usdcAddress,
            cctpVersion: evmCfg.cctpVersion ?? 1,
            transferMode: effectiveCctpTransferMode,
            fastFeeBps:
              evmCfg.cctpDomain !== null
                ? CCTP_V2_FALLBACK_FAST_FEE_BPS[evmCfg.cctpDomain]
                : undefined,
          })
        : '0x';

    const effectiveChainPref =
      bridgePreference === 'cctp' && !evmCfg?.cctpTokenMessenger && cctpDomain === null
        ? 'auto'
        : bridgePreference;
    const providerMeta = getBridgeProviderMeta(effectiveChainPref, outputAsset, estSec);
    const steps: CctpBridgeLeg['steps'] = [];
    if (usePermit2Batch) {
      steps.push({
        step: evmCfg ? 'EIP-5792 / Permit2 Atomic Batch' : chainSummary?.sponsorshipMechanism || '1-Sig Gasless Batch',
        detail: `Bundles ${chainAssets.length} asset(s) into 1 confirmation on ${chainName}`,
        target: evmCfg ? 'wallet_sendCalls' : chainName,
      });
    }
    const legDefiExitPlans: NonNullable<CctpBridgeLeg['defiExitPlans']> = [];
    for (const d of defiItems) {
      if (d.defiExitPlan) {
        legDefiExitPlans.push({
          assetId: d.id,
          symbol: d.symbol,
          plan: d.defiExitPlan,
        });
      }
      steps.push({
        step:
          d.defiExitPlan?.exitStrategy === 'direct_swap_bypass_cooldown'
            ? `Direct Swap ${d.symbol} (Skip Cooldown)`
            : d.defiExitPlan?.exitStrategy === 'safe_partial_debt_exit'
            ? `Safe Partial Withdraw ${d.protocol}`
            : `Withdraw ${d.protocol}`,
        detail:
          d.defiExitPlan?.plainEnglishSteps?.[0] ||
          `Redeem ${d.uiBalance} ${d.symbol} ($${d.grossUsd.toFixed(2)}) → ${d.underlyingSymbol ?? 'USDC'}`,
        target: d.protocolAddress ?? d.address,
        defiExitPlan: d.defiExitPlan,
      });
    }
    if (swapItems.length > 0) {
      steps.push({
        step: `Swap & Bridge → Solana ${outputAsset}`,
        detail: `Route ${swapItems.map((s) => s.symbol).join(', ')} via ${providerMeta.shortLabel} (${providerMeta.etaText})`,
        target: usdcAddress,
      });
    }
    for (const b of burnItems) {
      burnManifest.push({
        chain: b.chain,
        symbol: b.symbol,
        tokenAddress: b.address,
        amount: `${b.uiBalance.toLocaleString()} ${b.symbol}`,
        burnSink: DEAD_BURN_ADDRESS,
        status: 'BURN_READY',
        reason: b.actionReason,
      });
    }
    if (burnItems.length > 0) {
      steps.push({
        step: 'Isolated Safe Burn',
        detail: `Burn ${burnItems.length} zero-liquidity token(s) to 0x…dEaD (eth_call verified)`,
        target: DEAD_BURN_ADDRESS,
      });
    }
    if (feeUsdc > 0) {
      const destLabel = feeConfig.feeRecipientEvm
        ? `${feeConfig.feeRecipientEvm.slice(0, 6)}…${feeConfig.feeRecipientEvm.slice(-4)} (${feeConfig.feeDestinationType === 'wallet' ? 'Treasury Wallet' : 'TurgaliumFeeVault'})`
        : 'TurgaliumFeeVault / Treasury (set recipient)';
      steps.push({
        step: `Protocol Fee (${legFeePercent}%)`,
        detail: `Routes $${feeUsdc.toFixed(2)} (${legFeeBps} bps${useTieredFee ? ' tiered' : ''}) atomically to ${destLabel}`,
        target: feeConfig.feeRecipientEvm ?? 'TurgaliumFeeVault',
      });
    }
    if (bridgedUsdc > 0 && (effectiveChainPref === 'cctp' || directUsdcItems.length > 0 || swapItems.length === 0)) {
      steps.push({
        step: providerMeta.stepTitle,
        detail:
          effectiveChainPref === 'cctp' && cctpDomain !== null
            ? `depositForBurn(${bridgedUsdc.toFixed(2)} USDC, Domain ${cctpDomain} → 5 Solana)`
            : `Settles ~$${bridgedUsdc.toFixed(2)} as native Solana ${outputAsset} (${providerMeta.etaText})`,
        target: effectiveChainPref === 'cctp' ? tokenMessenger : providerMeta.shortLabel,
      });
    }

    const chainRoi = evaluateChainBatchRoi({
      chain: chainId,
      chainName,
      assets: chainAssets,
      protocolFeeBps: useTieredFee ? undefined : feeConfig.feeBps,
      feeSchedule: useTieredFee ? 'tiered' : 'flat',
      preservationFeeOpts: input.preservationFeeOpts,
      gasSponsored: Boolean(usePermit2Batch && chainSummary?.needsGasSponsorship),
      hasSolanaUsdcAta: legs.length === 0 ? input.hasSolanaUsdcAta : true,
      solPriceUsd: scan.totals.solPriceUsd || 70,
      gasPriceGwei: chainSummary?.gasPriceGwei,
    });

    const legFamily =
      chainAssets[0]?.family ??
      chainSummary?.family ??
      (scan.family && scan.family !== 'mixed' ? scan.family : 'evm');

    legs.push({
      family: legFamily,
      chain: chainId,
      chainName,
      sourceDomain: cctpDomain,
      destinationDomain: SOLANA_CCTP_DOMAIN,
      cctpVersion: evmCfg?.cctpVersion ?? null,
      tokenMessenger,
      usdcAddress,
      grossUsdc,
      feeUsdc,
      bridgedUsdc,
      rawUsdcAmount: rawUsdcAmount.toString(),
      gasUsd: round2(activeGas),
      estimatedSeconds: estSec,
      defiExits: defiItems.length,
      swaps: swapItems.length + directUsdcItems.length,
      burns: burnItems.length,
      honeypotsSkipped: skippedOnChain,
      gasSponsored: Boolean(usePermit2Batch && chainSummary?.needsGasSponsorship),
      sponsorshipMechanism: chainSummary?.sponsorshipMechanism,
      chainLegNetUsd: chainRoi.chainLegNetUsd,
      effectiveCostPct: chainRoi.chainLegCostPct,
      roiVerdict: chainRoi.roiVerdict,
      routeStrategy: chainRoi.routeComparison.recommendedStrategy,
      breakEvenHint: chainRoi.breakEvenHint,
      skippedNegativeRoi: chainRoi.skipChainNegativeRoi,
      solanaAtaRentUsd: chainRoi.solanaAtaRentUsd,
      cctpCalldata,
      defiExitPlans: legDefiExitPlans.length ? legDefiExitPlans : undefined,
      steps,
    });

    totalDefi += defiItems.length;
    totalSwaps += swapItems.length + directUsdcItems.length;
    totalBurns += burnItems.length;
    totalGross += grossUsdc;
    totalGas += activeGas;
    totalSingleGas += singleGas;
    totalFee += feeUsdc;
    totalNetUsdc += bridgedUsdc;
  }

  const times = legs.filter((l) => l.bridgedUsdc > 0).map((l) => l.estimatedSeconds);
  const solPrice = scan.totals.solPriceUsd || 70;
  const activeBridgeMeta = getBridgeProviderMeta(bridgePreference, outputAsset, 20);

  const allDefiExitPlans = legs.flatMap((l) =>
    (l.defiExitPlans ?? []).map((entry) => ({
      assetId: entry.assetId,
      symbol: entry.symbol,
      chain: l.chain,
      plan: entry.plan,
    }))
  );

  const effectivePlanFeeBps =
    useTieredFee && totalGross > 0
      ? Math.max(0, Math.round((totalFee / totalGross) * 10_000))
      : feeConfig.feeBps;
  const effectivePlanFeePercent =
    useTieredFee && totalGross > 0
      ? Number(((totalFee / totalGross) * 100).toFixed(2))
      : feeConfig.feePercent;

  return {
    planId: `plan_${crypto.randomBytes(5).toString('hex')}`,
    family: scan.family ?? 'evm',
    createdAt: new Date().toISOString(),
    sourceWallet: scan.walletAddress,
    solanaDestination: solanaDestination.trim(),
    solanaUsdcAta,
    solanaMintRecipientBytes32,
    usePermit2Batch,
    includeBurns,
    outputAsset,
    bridgePreference,
    activeBridgeLabel: activeBridgeMeta.label,
    protocolFeeBps: effectivePlanFeeBps,
    protocolFeePercent: effectivePlanFeePercent,
    feeRecipientEvm: feeConfig.feeRecipientEvm,
    feeDestinationType: feeConfig.feeDestinationType,
    legs,
    defiExitPlans: allDefiExitPlans.length ? allDefiExitPlans : undefined,
    totals: {
      selectedAssets: chosen.length,
      defiWithdrawnCount: totalDefi,
      tokensSoldCount: totalSwaps,
      tokensBurnedCount: totalBurns,
      honeypotsSkippedCount: scan.totals.honeypotSkippedCount,
      grossUsd: round2(totalGross),
      totalGasUsd: round2(totalGas),
      gasSavedUsd: round2(Math.max(0, totalSingleGas - totalGas)),
      protocolFeeUsd: round2(totalFee),
      netSolanaUsdc: round2(totalNetUsdc),
      netSolanaSol: round4(totalNetUsdc / solPrice),
      estimatedFastestSec: times.length ? Math.min(...times) : 0,
      estimatedFullSec: times.length ? Math.max(...times) : 0,
    },
    burnManifest,
  };
}
