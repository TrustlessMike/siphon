import type { ChainConfig, EvmChainId, TokenDescriptor } from './types.js';

export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const ZKSYNC_MULTICALL3_ADDRESS = '0xF9cda624FBC7e059355ce98a31693d299FACd963';
export const DEAD_BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
export const SOLANA_CCTP_DOMAIN = 5;

// Circle CCTP V2 canonical CREATE2 addresses uniform across EVM mainnets
export const CCTP_V2_TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
export const CCTP_V2_MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';

export const MIN_PROTOCOL_FEE_BPS = 500; // 5.0% (legacy flat floor, kept for backwards compatibility)
export const MAX_PROTOCOL_FEE_BPS = 1000; // 10.0%
export const DEFAULT_PROTOCOL_FEE_BPS = 700; // 7.0%

// Preservation-first progressive protocol fee schedule constants
export const MIN_PRESERVATION_FEE_BPS = 0; // 0.0% (self-custody / partner-subsidized mode)
export const DEFAULT_PRESERVATION_FEE_CAP_USD = 50; // $50 hard ceiling on principal migrations

export type PreservationFeeMode = 'tiered' | 'self_custody' | 'partner_subsidized' | 'legacy_flat';

export type PreservationFeeTierId =
  | 'zero'
  | 'dust'
  | 'small'
  | 'growth'
  | 'principal'
  | 'self_custody_zero'
  | 'partner_subsidized_zero'
  | 'legacy_flat';

export interface PreservationFeeTier {
  id: 'dust' | 'small' | 'growth' | 'principal';
  label: string;
  minGrossUsd: number;
  maxGrossUsd: number | null;
  feeBps: number;
  maxFeeUsdCap: number | null;
}

export const PRESERVATION_FEE_TIERS: readonly PreservationFeeTier[] = [
  {
    id: 'dust',
    label: 'Micro-Dust Rescue (<$50)',
    minGrossUsd: 0,
    maxGrossUsd: 50,
    feeBps: 500, // 5.00%
    maxFeeUsdCap: null,
  },
  {
    id: 'small',
    label: 'Small Sweep ($50–$500)',
    minGrossUsd: 50,
    maxGrossUsd: 500,
    feeBps: 100, // 1.00%
    maxFeeUsdCap: null,
  },
  {
    id: 'growth',
    label: 'Mid Migration ($500–$5,000)',
    minGrossUsd: 500,
    maxGrossUsd: 5_000,
    feeBps: 25, // 0.25%
    maxFeeUsdCap: null,
  },
  {
    id: 'principal',
    label: 'Principal Preservation ($5,000+)',
    minGrossUsd: 5_000,
    maxGrossUsd: null,
    feeBps: 10, // 0.10%
    maxFeeUsdCap: DEFAULT_PRESERVATION_FEE_CAP_USD, // hard $50 ceiling (configurable $25–$50)
  },
] as const;

export interface PreservationFeeOptions {
  mode?: PreservationFeeMode;
  /** Optional hard USD fee ceiling (overrides tier default cap when provided) */
  maxFeeUsdCap?: number | null;
  /** Optional explicit bps override in [0, 1000] */
  overrideFeeBps?: number;
  /** Optional custom progressive tier table */
  tiers?: readonly PreservationFeeTier[];
  /** Baseline flat fee bps used to compute capital savings (default 700 bps = 7%) */
  baselineFlatFeeBps?: number;
}

export interface PreservationFeeResult {
  grossUsd: number;
  mode: PreservationFeeMode;
  tierId: PreservationFeeTierId;
  tierLabel: string;
  nominalFeeBps: number;
  effectiveFeeBps: number;
  effectiveFeePercent: number;
  feeUsd: number;
  feeCapUsd: number | null;
  capApplied: boolean;
  netAfterFeeUsd: number;
  capitalPreservedPct: number;
  baselineFlatFeeUsd: number;
  savingsVsFlat7PctUsd: number;
  savingsVsFlat7PctBps: number;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

export function resolveProtocolFeeBps(raw?: number | string | null): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PROTOCOL_FEE_BPS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PROTOCOL_FEE_BPS;
  const rounded = Math.round(parsed);
  return Math.min(MAX_PROTOCOL_FEE_BPS, Math.max(MIN_PROTOCOL_FEE_BPS, rounded));
}

/**
 * Resolves a preservation-mode fee rate in basis points across the full [0, 1000] bps range
 * (allowing 0 bps for self-custody / partner-subsidized migrations while preserving the 10% cap).
 */
export function resolvePreservationFeeBps(raw?: number | string | null): number {
  if (raw === undefined || raw === null || raw === '') return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  const rounded = Math.round(parsed);
  return Math.min(MAX_PROTOCOL_FEE_BPS, Math.max(MIN_PRESERVATION_FEE_BPS, rounded));
}

/**
 * Preservation-First Tiered Protocol Fee Engine:
 *   - Dust (<$50):              500 bps (5.00%) — sustains micro-dust gasless relayer economics
 *   - Small ($50–$500):         100 bps (1.00%)
 *   - Mid ($500–$5,000):         25 bps (0.25%)
 *   - Principal ($5,000+):       10 bps (0.10%) capped at $50 hard ceiling (configurable via maxFeeUsdCap)
 *   - Self-custody / subsidized:  0 bps (0.00%)
 */
export function computePreservationFee(
  grossUsdInput: number,
  opts: PreservationFeeOptions = {}
): PreservationFeeResult {
  const mode: PreservationFeeMode = opts.mode ?? 'tiered';
  const baselineBps =
    opts.baselineFlatFeeBps !== undefined && Number.isFinite(opts.baselineFlatFeeBps)
      ? Math.max(0, Math.min(MAX_PROTOCOL_FEE_BPS, Math.round(opts.baselineFlatFeeBps)))
      : DEFAULT_PROTOCOL_FEE_BPS;

  if (!Number.isFinite(grossUsdInput) || grossUsdInput <= 0) {
    return {
      grossUsd: 0,
      mode,
      tierId: 'zero',
      tierLabel: 'Zero Gross Value',
      nominalFeeBps: 0,
      effectiveFeeBps: 0,
      effectiveFeePercent: 0,
      feeUsd: 0,
      feeCapUsd: null,
      capApplied: false,
      netAfterFeeUsd: 0,
      capitalPreservedPct: 100,
      baselineFlatFeeUsd: 0,
      savingsVsFlat7PctUsd: 0,
      savingsVsFlat7PctBps: 0,
    };
  }

  const grossUsd = round2(grossUsdInput);
  const baselineFlatFeeUsd = round2((grossUsd * baselineBps) / 10_000);

  if (mode === 'self_custody' || mode === 'partner_subsidized') {
    return {
      grossUsd,
      mode,
      tierId: mode === 'self_custody' ? 'self_custody_zero' : 'partner_subsidized_zero',
      tierLabel: mode === 'self_custody' ? 'Self-Custody Zero Fee (0 bps)' : 'Partner-Subsidized Zero Fee (0 bps)',
      nominalFeeBps: 0,
      effectiveFeeBps: 0,
      effectiveFeePercent: 0,
      feeUsd: 0,
      feeCapUsd: 0,
      capApplied: false,
      netAfterFeeUsd: grossUsd,
      capitalPreservedPct: 100,
      baselineFlatFeeUsd,
      savingsVsFlat7PctUsd: baselineFlatFeeUsd,
      savingsVsFlat7PctBps: baselineBps,
    };
  }

  if (mode === 'legacy_flat') {
    const flatBps =
      opts.overrideFeeBps !== undefined
        ? resolveProtocolFeeBps(opts.overrideFeeBps)
        : DEFAULT_PROTOCOL_FEE_BPS;
    const feeUsd = round2((grossUsd * flatBps) / 10_000);
    const netAfterFeeUsd = round2(Math.max(0, grossUsd - feeUsd));
    const effectiveFeeBps = grossUsd > 0 ? Number(((feeUsd / grossUsd) * 10_000).toFixed(2)) : 0;
    return {
      grossUsd,
      mode,
      tierId: 'legacy_flat',
      tierLabel: `Legacy Flat (${(flatBps / 100).toFixed(2)}%)`,
      nominalFeeBps: flatBps,
      effectiveFeeBps,
      effectiveFeePercent: Number((effectiveFeeBps / 100).toFixed(4)),
      feeUsd,
      feeCapUsd: null,
      capApplied: false,
      netAfterFeeUsd,
      capitalPreservedPct: Number(((netAfterFeeUsd / grossUsd) * 100).toFixed(4)),
      baselineFlatFeeUsd,
      savingsVsFlat7PctUsd: round2(baselineFlatFeeUsd - feeUsd),
      savingsVsFlat7PctBps: Number((baselineBps - effectiveFeeBps).toFixed(2)),
    };
  }

  const tiers = opts.tiers && opts.tiers.length > 0 ? opts.tiers : PRESERVATION_FEE_TIERS;
  const matchedTier =
    tiers.find(
      (t) => grossUsd >= t.minGrossUsd && (t.maxGrossUsd === null || grossUsd < t.maxGrossUsd)
    ) ?? tiers[tiers.length - 1];

  const nominalFeeBps =
    opts.overrideFeeBps !== undefined
      ? resolvePreservationFeeBps(opts.overrideFeeBps)
      : resolvePreservationFeeBps(matchedTier.feeBps);

  const resolvedCapUsd =
    opts.maxFeeUsdCap !== undefined
      ? opts.maxFeeUsdCap !== null && Number.isFinite(opts.maxFeeUsdCap) && opts.maxFeeUsdCap >= 0
        ? round2(opts.maxFeeUsdCap)
        : null
      : matchedTier.maxFeeUsdCap;

  const uncappedFeeUsd = round2((grossUsd * nominalFeeBps) / 10_000);
  const capApplied = resolvedCapUsd !== null && uncappedFeeUsd > resolvedCapUsd;
  const feeUsd = capApplied ? resolvedCapUsd : uncappedFeeUsd;
  const netAfterFeeUsd = round2(Math.max(0, grossUsd - feeUsd));
  const effectiveFeeBps = grossUsd > 0 ? Number(((feeUsd / grossUsd) * 10_000).toFixed(2)) : 0;
  const effectiveFeePercent = Number((effectiveFeeBps / 100).toFixed(4));
  const capitalPreservedPct = Number(((netAfterFeeUsd / grossUsd) * 100).toFixed(4));
  const savingsVsFlat7PctUsd = round2(baselineFlatFeeUsd - feeUsd);
  const savingsVsFlat7PctBps = Number((baselineBps - effectiveFeeBps).toFixed(2));

  return {
    grossUsd,
    mode,
    tierId: matchedTier.id,
    tierLabel: matchedTier.label,
    nominalFeeBps,
    effectiveFeeBps,
    effectiveFeePercent,
    feeUsd,
    feeCapUsd: resolvedCapUsd,
    capApplied,
    netAfterFeeUsd,
    capitalPreservedPct,
    baselineFlatFeeUsd,
    savingsVsFlat7PctUsd,
    savingsVsFlat7PctBps,
  };
}

export function isValidFeeRecipientEvm(addr?: string | null): addr is string {
  if (!addr) return false;
  const clean = addr.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) return false;
  const lower = clean.toLowerCase();
  return (
    lower !== '0x0000000000000000000000000000000000000000' &&
    lower !== DEAD_BURN_ADDRESS.toLowerCase()
  );
}

export const PROTOCOL_FEE_BPS = resolveProtocolFeeBps(process.env.SIPHON_FEE_BPS);

export interface ProtocolFeeConfig {
  feeBps: number;
  feePercent: number;
  minFeeBps: number;
  maxFeeBps: number;
  feeRecipientEvm: string | null;
  feeRecipientSol: string | null;
  feeDestinationType: 'contract' | 'wallet';
  treasuryConfigured: boolean;
}

export function getProtocolFeeConfig(overrides?: {
  feeBps?: number | string | null;
  feeRecipientEvm?: string | null;
}): ProtocolFeeConfig {
  const feeBps = resolveProtocolFeeBps(overrides?.feeBps ?? process.env.SIPHON_FEE_BPS);
  // HIGH-01: When server treasury is configured via environment, never allow client overrides to hijack fees.
  const serverTreasury = process.env.SIPHON_FEE_RECIPIENT_EVM?.trim() || null;
  const candidateEvm = isValidFeeRecipientEvm(serverTreasury)
    ? serverTreasury
    : overrides?.feeRecipientEvm ?? null;
  const feeRecipientEvm = isValidFeeRecipientEvm(candidateEvm) ? candidateEvm.trim() : null;
  const feeRecipientSol = process.env.SIPHON_FEE_RECIPIENT_SOL?.trim() || null;
  const rawType = (process.env.SIPHON_FEE_DESTINATION_TYPE ?? 'contract').toLowerCase();
  const feeDestinationType: 'contract' | 'wallet' = rawType === 'wallet' ? 'wallet' : 'contract';

  return {
    feeBps,
    feePercent: Number((feeBps / 100).toFixed(2)),
    minFeeBps: MIN_PROTOCOL_FEE_BPS,
    maxFeeBps: MAX_PROTOCOL_FEE_BPS,
    feeRecipientEvm,
    feeRecipientSol,
    feeDestinationType,
    treasuryConfigured: Boolean(feeRecipientEvm),
  };
}

function buildRpcUrls(envUrl: string | undefined, fallbacks: string[]): string[] {
  return Array.from(new Set([envUrl?.trim(), ...fallbacks].filter((u): u is string => Boolean(u))));
}

export const EVM_CHAINS: Record<EvmChainId, ChainConfig> = {
  ethereum: {
    id: 'ethereum',
    name: 'Ethereum',
    chainId: 1,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.ETH_RPC_URL ?? 'https://ethereum-rpc.publicnode.com',
    rpcUrls: buildRpcUrls(process.env.ETH_RPC_URL, [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://1rpc.io/eth',
    ]),
    explorerUrl: 'https://etherscan.io',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    cctpDomain: 0,
    cctpVersion: 2,
    cctpTokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    cctpMessageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    cctpAttestationSec: 15,
    swapGasUnits: 155_000,
    defiWithdrawGasUnits: 190_000,
    burnGasUnits: 48_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.002,
    aaveV3Pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    compoundV3Comet: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
  },
  base: {
    id: 'base',
    name: 'Base',
    chainId: 8453,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.BASE_RPC_URL ?? 'https://base-rpc.publicnode.com',
    rpcUrls: buildRpcUrls(process.env.BASE_RPC_URL, [
      'https://base-rpc.publicnode.com',
      'https://base.drpc.org',
      'https://mainnet.base.org',
    ]),
    explorerUrl: 'https://basescan.org',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    cctpDomain: 6,
    cctpVersion: 2,
    cctpTokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    cctpMessageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    cctpAttestationSec: 12,
    swapGasUnits: 150_000,
    defiWithdrawGasUnits: 185_000,
    burnGasUnits: 45_000,
    bridgeGasUnits: 110_000,
    gasReserveNative: 0.0005,
    aaveV3Pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    compoundV3Comet: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
  },
  arbitrum: {
    id: 'arbitrum',
    name: 'Arbitrum',
    chainId: 42161,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.ARB_RPC_URL ?? 'https://arbitrum-one-rpc.publicnode.com',
    rpcUrls: buildRpcUrls(process.env.ARB_RPC_URL, [
      'https://arbitrum-one-rpc.publicnode.com',
      'https://arbitrum.drpc.org',
      'https://arb1.arbitrum.io/rpc',
    ]),
    explorerUrl: 'https://arbiscan.io',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    cctpDomain: 3,
    cctpVersion: 2,
    cctpTokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    cctpMessageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    cctpAttestationSec: 12,
    swapGasUnits: 180_000,
    defiWithdrawGasUnits: 210_000,
    burnGasUnits: 52_000,
    bridgeGasUnits: 120_000,
    gasReserveNative: 0.0005,
    aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    compoundV3Comet: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
  },
  optimism: {
    id: 'optimism',
    name: 'Optimism',
    chainId: 10,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.OP_RPC_URL ?? 'https://optimism-rpc.publicnode.com',
    rpcUrls: buildRpcUrls(process.env.OP_RPC_URL, [
      'https://optimism-rpc.publicnode.com',
      'https://optimism.drpc.org',
      'https://mainnet.optimism.io',
    ]),
    explorerUrl: 'https://optimistic.etherscan.io',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    cctpDomain: 2,
    cctpVersion: 2,
    cctpTokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    cctpMessageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    cctpAttestationSec: 14,
    swapGasUnits: 150_000,
    defiWithdrawGasUnits: 185_000,
    burnGasUnits: 45_000,
    bridgeGasUnits: 110_000,
    gasReserveNative: 0.0005,
    aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    compoundV3Comet: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB',
  },
  polygon: {
    id: 'polygon',
    name: 'Polygon',
    chainId: 137,
    nativeSymbol: 'POL',
    nativeLlamaId: 'coingecko:polygon-ecosystem-token',
    rpcUrl: process.env.POLYGON_RPC_URL ?? 'https://137.rpc.thirdweb.com',
    rpcUrls: buildRpcUrls(process.env.POLYGON_RPC_URL, [
      'https://137.rpc.thirdweb.com',
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.drpc.org',
      'https://1rpc.io/matic',
    ]),
    explorerUrl: 'https://polygonscan.com',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    cctpDomain: 7,
    cctpVersion: 2,
    cctpTokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    cctpMessageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    cctpAttestationSec: 15,
    swapGasUnits: 160_000,
    defiWithdrawGasUnits: 195_000,
    burnGasUnits: 48_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.05,
    aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    compoundV3Comet: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
  },
  avalanche: {
    id: 'avalanche',
    name: 'Avalanche',
    chainId: 43114,
    nativeSymbol: 'AVAX',
    nativeLlamaId: 'coingecko:avalanche-2',
    rpcUrl: process.env.AVAX_RPC_URL ?? 'https://avalanche-c-chain-rpc.publicnode.com',
    rpcUrls: buildRpcUrls(process.env.AVAX_RPC_URL, [
      'https://avalanche-c-chain-rpc.publicnode.com',
      'https://avalanche.drpc.org',
      'https://api.avax.network/ext/bc/C/rpc',
    ]),
    explorerUrl: 'https://snowtrace.io',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    cctpDomain: 1,
    cctpVersion: 2,
    cctpTokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    cctpMessageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    cctpAttestationSec: 10,
    swapGasUnits: 155_000,
    defiWithdrawGasUnits: 190_000,
    burnGasUnits: 48_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.02,
    aaveV3Pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  },
  bnb: {
    id: 'bnb',
    name: 'BNB Chain',
    chainId: 56,
    nativeSymbol: 'BNB',
    nativeLlamaId: 'coingecko:binancecoin',
    rpcUrl: process.env.BNB_RPC_URL ?? 'https://bsc-rpc.publicnode.com',
    rpcUrls: buildRpcUrls(process.env.BNB_RPC_URL, [
      'https://bsc-rpc.publicnode.com',
      'https://bsc.drpc.org',
      'https://bsc-dataseed.binance.org',
    ]),
    explorerUrl: 'https://bscscan.com',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    cctpDomain: null,
    cctpVersion: null,
    cctpTokenMessenger: null,
    cctpMessageTransmitter: null,
    cctpAttestationSec: 12,
    swapGasUnits: 155_000,
    defiWithdrawGasUnits: 190_000,
    burnGasUnits: 45_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.003,
    aaveV3Pool: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  },
  sonic: {
    id: 'sonic',
    name: 'Sonic',
    chainId: 146,
    nativeSymbol: 'S',
    nativeLlamaId: 'coingecko:sonic-3',
    rpcUrl: process.env.SONIC_RPC_URL ?? 'https://rpc.soniclabs.com',
    rpcUrls: buildRpcUrls(process.env.SONIC_RPC_URL, [
      'https://rpc.soniclabs.com',
      'https://sonic-rpc.publicnode.com',
      'https://sonic.drpc.org',
    ]),
    explorerUrl: 'https://sonicscan.org',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
    cctpDomain: 13,
    cctpVersion: 2,
    cctpTokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    cctpMessageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    cctpAttestationSec: 12,
    swapGasUnits: 150_000,
    defiWithdrawGasUnits: 185_000,
    burnGasUnits: 45_000,
    bridgeGasUnits: 110_000,
    gasReserveNative: 0.05,
    aaveV3Pool: '0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3',
  },
  unichain: {
    id: 'unichain',
    name: 'Unichain',
    chainId: 130,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.UNICHAIN_RPC_URL ?? 'https://mainnet.unichain.org',
    rpcUrls: buildRpcUrls(process.env.UNICHAIN_RPC_URL, [
      'https://mainnet.unichain.org',
      'https://unichain-rpc.publicnode.com',
      'https://unichain.drpc.org',
    ]),
    explorerUrl: 'https://uniscan.xyz',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    cctpDomain: 10,
    cctpVersion: 2,
    cctpTokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    cctpMessageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    cctpAttestationSec: 14,
    swapGasUnits: 150_000,
    defiWithdrawGasUnits: 185_000,
    burnGasUnits: 45_000,
    bridgeGasUnits: 110_000,
    gasReserveNative: 0.0005,
  },
  linea: {
    id: 'linea',
    name: 'Linea',
    chainId: 59144,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.LINEA_RPC_URL ?? 'https://rpc.linea.build',
    rpcUrls: buildRpcUrls(process.env.LINEA_RPC_URL, [
      'https://rpc.linea.build',
      'https://linea-rpc.publicnode.com',
      'https://linea.drpc.org',
    ]),
    explorerUrl: 'https://lineascan.build',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
    cctpDomain: 11,
    cctpVersion: 2,
    cctpTokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    cctpMessageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    cctpAttestationSec: 18,
    swapGasUnits: 155_000,
    defiWithdrawGasUnits: 190_000,
    burnGasUnits: 45_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.0008,
    aaveV3Pool: '0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac',
  },
  scroll: {
    id: 'scroll',
    name: 'Scroll',
    chainId: 534352,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.SCROLL_RPC_URL ?? 'https://rpc.scroll.io',
    rpcUrls: buildRpcUrls(process.env.SCROLL_RPC_URL, [
      'https://rpc.scroll.io',
      'https://scroll-rpc.publicnode.com',
      'https://scroll.drpc.org',
    ]),
    explorerUrl: 'https://scrollscan.com',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
    cctpDomain: null,
    cctpVersion: null,
    cctpTokenMessenger: null,
    cctpMessageTransmitter: null,
    cctpAttestationSec: 20,
    swapGasUnits: 155_000,
    defiWithdrawGasUnits: 190_000,
    burnGasUnits: 48_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.0008,
    aaveV3Pool: '0x11fCfe756c05AD438e312a7fd934381537D3cFfe',
  },
  mantle: {
    id: 'mantle',
    name: 'Mantle',
    chainId: 5000,
    nativeSymbol: 'MNT',
    nativeLlamaId: 'coingecko:mantle',
    rpcUrl: process.env.MANTLE_RPC_URL ?? 'https://rpc.mantle.xyz',
    rpcUrls: buildRpcUrls(process.env.MANTLE_RPC_URL, [
      'https://rpc.mantle.xyz',
      'https://mantle-rpc.publicnode.com',
      'https://mantle.drpc.org',
    ]),
    explorerUrl: 'https://mantlescan.xyz',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
    cctpDomain: null,
    cctpVersion: null,
    cctpTokenMessenger: null,
    cctpMessageTransmitter: null,
    cctpAttestationSec: 18,
    swapGasUnits: 160_000,
    defiWithdrawGasUnits: 195_000,
    burnGasUnits: 48_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.05,
  },
  blast: {
    id: 'blast',
    name: 'Blast',
    chainId: 81457,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.BLAST_RPC_URL ?? 'https://rpc.blast.io',
    rpcUrls: buildRpcUrls(process.env.BLAST_RPC_URL, [
      'https://rpc.blast.io',
      'https://blast-rpc.publicnode.com',
      'https://blast.drpc.org',
    ]),
    explorerUrl: 'https://blastscan.io',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x4300000000000000000000000000000000000003',
    cctpDomain: null,
    cctpVersion: null,
    cctpTokenMessenger: null,
    cctpMessageTransmitter: null,
    cctpAttestationSec: 18,
    swapGasUnits: 155_000,
    defiWithdrawGasUnits: 190_000,
    burnGasUnits: 48_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.0005,
  },
  worldchain: {
    id: 'worldchain',
    name: 'World Chain',
    chainId: 480,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.WORLDCHAIN_RPC_URL ?? 'https://worldchain-mainnet.g.alchemy.com/public',
    rpcUrls: buildRpcUrls(process.env.WORLDCHAIN_RPC_URL, [
      'https://worldchain-mainnet.g.alchemy.com/public',
      'https://worldchain.drpc.org',
      'https://480.rpc.thirdweb.com',
    ]),
    explorerUrl: 'https://worldscan.org',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1',
    cctpDomain: 14,
    cctpVersion: 2,
    cctpTokenMessenger: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
    cctpMessageTransmitter: '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64',
    cctpAttestationSec: 15,
    swapGasUnits: 150_000,
    defiWithdrawGasUnits: 185_000,
    burnGasUnits: 45_000,
    bridgeGasUnits: 110_000,
    gasReserveNative: 0.0005,
  },
  hyperevm: {
    id: 'hyperevm',
    name: 'HyperEVM',
    chainId: 999,
    nativeSymbol: 'HYPE',
    nativeLlamaId: 'coingecko:hyperliquid',
    rpcUrl: process.env.HYPEREVM_RPC_URL ?? 'https://rpc.hyperliquid.xyz/evm',
    rpcUrls: buildRpcUrls(process.env.HYPEREVM_RPC_URL, [
      'https://rpc.hyperliquid.xyz/evm',
      'https://hyperliquid.drpc.org',
      'https://rpc.hyperlend.finance',
      'https://999.rpc.thirdweb.com',
    ]),
    explorerUrl: 'https://hyperevmscan.io',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
    cctpDomain: 19,
    cctpVersion: 2,
    cctpTokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    cctpMessageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    cctpAttestationSec: 12,
    swapGasUnits: 155_000,
    defiWithdrawGasUnits: 190_000,
    burnGasUnits: 45_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.01,
    aaveV3Pool: '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b',
  },
  berachain: {
    id: 'berachain',
    name: 'Berachain',
    chainId: 80094,
    nativeSymbol: 'BERA',
    nativeLlamaId: 'coingecko:berachain-bera',
    rpcUrl: process.env.BERACHAIN_RPC_URL ?? 'https://rpc.berachain.com',
    rpcUrls: buildRpcUrls(process.env.BERACHAIN_RPC_URL, [
      'https://rpc.berachain.com',
      'https://berachain-rpc.publicnode.com',
      'https://berachain.drpc.org',
      'https://80094.rpc.thirdweb.com',
    ]),
    explorerUrl: 'https://berascan.com',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x549943e04f40284185054145c6E4e9568C1D3241',
    cctpDomain: null,
    cctpVersion: null,
    cctpTokenMessenger: null,
    cctpMessageTransmitter: null,
    cctpAttestationSec: 16,
    swapGasUnits: 160_000,
    defiWithdrawGasUnits: 195_000,
    burnGasUnits: 48_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.05,
  },
  zksync: {
    id: 'zksync',
    name: 'zkSync Era',
    chainId: 324,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.ZKSYNC_RPC_URL ?? 'https://mainnet.era.zksync.io',
    rpcUrls: buildRpcUrls(process.env.ZKSYNC_RPC_URL, [
      'https://mainnet.era.zksync.io',
      'https://zksync-era.drpc.org',
      'https://1rpc.io/zksync2-era',
      'https://324.rpc.thirdweb.com',
    ]),
    explorerUrl: 'https://explorer.zksync.io',
    multicall3: ZKSYNC_MULTICALL3_ADDRESS,
    usdcAddress: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',
    cctpDomain: null,
    cctpVersion: null,
    cctpTokenMessenger: null,
    cctpMessageTransmitter: null,
    cctpAttestationSec: 18,
    swapGasUnits: 210_000,
    defiWithdrawGasUnits: 245_000,
    burnGasUnits: 60_000,
    bridgeGasUnits: 150_000,
    gasReserveNative: 0.0008,
    aaveV3Pool: '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c',
  },
  ink: {
    id: 'ink',
    name: 'Ink',
    chainId: 57073,
    nativeSymbol: 'ETH',
    nativeLlamaId: 'coingecko:ethereum',
    rpcUrl: process.env.INK_RPC_URL ?? 'https://rpc-gel.inkonchain.com',
    rpcUrls: buildRpcUrls(process.env.INK_RPC_URL, [
      'https://rpc-gel.inkonchain.com',
      'https://rpc-qnd.inkonchain.com',
      'https://ink.drpc.org',
      'https://57073.rpc.thirdweb.com',
    ]),
    explorerUrl: 'https://explorer.inkonchain.com',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x2D270e6886d130D724215A266106e6832161EAEd',
    cctpDomain: 21,
    cctpVersion: 2,
    cctpTokenMessenger: CCTP_V2_TOKEN_MESSENGER,
    cctpMessageTransmitter: CCTP_V2_MESSAGE_TRANSMITTER,
    cctpAttestationSec: 14,
    swapGasUnits: 150_000,
    defiWithdrawGasUnits: 185_000,
    burnGasUnits: 45_000,
    bridgeGasUnits: 110_000,
    gasReserveNative: 0.0005,
    aaveV3Pool: '0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA',
  },
  gnosis: {
    id: 'gnosis',
    name: 'Gnosis',
    chainId: 100,
    nativeSymbol: 'xDAI',
    nativeLlamaId: 'coingecko:xdai',
    rpcUrl: process.env.GNOSIS_RPC_URL ?? 'https://gnosis-rpc.publicnode.com',
    rpcUrls: buildRpcUrls(process.env.GNOSIS_RPC_URL, [
      'https://gnosis-rpc.publicnode.com',
      'https://gnosis.drpc.org',
      'https://1rpc.io/gnosis',
      'https://rpc.gnosischain.com',
    ]),
    explorerUrl: 'https://gnosisscan.io',
    multicall3: MULTICALL3_ADDRESS,
    usdcAddress: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
    cctpDomain: null,
    cctpVersion: null,
    cctpTokenMessenger: null,
    cctpMessageTransmitter: null,
    cctpAttestationSec: 18,
    swapGasUnits: 160_000,
    defiWithdrawGasUnits: 195_000,
    burnGasUnits: 48_000,
    bridgeGasUnits: 115_000,
    gasReserveNative: 0.05,
    aaveV3Pool: '0xb50201558B00496A145fE76f7424749556E326D8',
  },
};

export const CHAIN_LIST: ChainConfig[] = Object.values(EVM_CHAINS);

/**
 * Curated mainnet registry of major ERC-20 dust tokens AND live DeFi smart-contract
 * position receipt tokens (Aave v3 aTokens, Compound v3 Comets, Lido stETH/wstETH, Spark sDAI).
 */
export const TOKEN_REGISTRY: TokenDescriptor[] = [
  // ===================== ETHEREUM =====================
  {
    chain: 'ethereum',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  {
    chain: 'ethereum',
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  {
    chain: 'ethereum',
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
  {
    chain: 'ethereum',
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'ethereum:0x6B175474E89094C44Da98b954EedeAC495271d0F',
  },
  {
    chain: 'ethereum',
    address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    symbol: 'LINK',
    name: 'Chainlink',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'ethereum:0x514910771AF9Ca656af840dff83E8264EcF986CA',
  },
  {
    chain: 'ethereum',
    address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
    symbol: 'UNI',
    name: 'Uniswap',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'ethereum:0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
  },
  {
    chain: 'ethereum',
    address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
    symbol: 'AAVE',
    name: 'Aave Token',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'ethereum:0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
  },
  {
    chain: 'ethereum',
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    symbol: 'WBTC',
    name: 'Wrapped BTC',
    decimals: 8,
    kind: 'erc20',
    llamaKey: 'ethereum:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  // DeFi Positions on Ethereum
  {
    chain: 'ethereum',
    address: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
    symbol: 'aEthUSDC',
    name: 'Aave v3 Ethereum USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    llamaKey: 'ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  {
    chain: 'ethereum',
    address: '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8',
    symbol: 'aEthWETH',
    name: 'Aave v3 Ethereum WETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    underlyingSymbol: 'WETH',
    underlyingAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    llamaKey: 'ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
  {
    chain: 'ethereum',
    address: '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a',
    symbol: 'aEthUSDT',
    name: 'Aave v3 Ethereum USDT',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    underlyingSymbol: 'USDT',
    underlyingAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    llamaKey: 'ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7',
  },
  {
    chain: 'ethereum',
    address: '0x018008bfb33d285247A21d44E50697654f754e63',
    symbol: 'aEthDAI',
    name: 'Aave v3 Ethereum DAI',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    underlyingSymbol: 'DAI',
    underlyingAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    llamaKey: 'ethereum:0x6B175474E89094C44Da98b954EedeAC495271d0F',
  },
  {
    chain: 'ethereum',
    address: '0x5Ee5bf7ae06D1Be5997A1A72006FE6C607eC6DE8',
    symbol: 'aEthWBTC',
    name: 'Aave v3 Ethereum WBTC',
    decimals: 8,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    underlyingSymbol: 'WBTC',
    underlyingAddress: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    llamaKey: 'ethereum:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
  },
  {
    chain: 'ethereum',
    address: '0x0B925eD163218f6662a35e0f0371Ac234f9E9371',
    symbol: 'aEthwstETH',
    name: 'Aave v3 Ethereum wstETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    underlyingSymbol: 'wstETH',
    underlyingAddress: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    llamaKey: 'ethereum:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
  },
  {
    chain: 'ethereum',
    address: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    symbol: 'cUSDCv3',
    name: 'Compound v3 Ethereum USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Compound v3',
    protocolAddress: '0xc3d688B66703497DAA19211EEdff47f25384cdc3',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    llamaKey: 'ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  {
    chain: 'ethereum',
    address: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
    symbol: 'cWETHv3',
    name: 'Compound v3 Ethereum WETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Compound v3',
    protocolAddress: '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
    underlyingSymbol: 'WETH',
    underlyingAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    llamaKey: 'ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  },
  {
    chain: 'ethereum',
    address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
    symbol: 'stETH',
    name: 'Lido Staked Ether',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Lido',
    protocolAddress: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
    underlyingSymbol: 'ETH',
    llamaKey: 'ethereum:0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84',
  },
  {
    chain: 'ethereum',
    address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    symbol: 'wstETH',
    name: 'Wrapped Lido Staked ETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Lido',
    protocolAddress: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    underlyingSymbol: 'ETH',
    llamaKey: 'ethereum:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
  },
  {
    chain: 'ethereum',
    address: '0x83F20F44975D03b1b09e64809B757c47f942BEeA',
    symbol: 'sDAI',
    name: 'Spark Savings DAI Vault',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Spark ERC-4626',
    protocolAddress: '0x83F20F44975D03b1b09e64809B757c47f942BEeA',
    underlyingSymbol: 'DAI',
    underlyingAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    llamaKey: 'ethereum:0x83F20F44975D03b1b09e64809B757c47f942BEeA',
  },
  {
    chain: 'ethereum',
    address: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
    symbol: 'sUSDS',
    name: 'Sky Savings USDS Vault',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Sky ERC-4626',
    protocolAddress: '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
    underlyingSymbol: 'USDS',
    underlyingAddress: '0xdC035D45d973E3EC169d2276DDab16f1e407384F',
    llamaKey: 'ethereum:0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD',
  },
  {
    chain: 'ethereum',
    address: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    symbol: 'sUSDe',
    name: 'Ethena Staked USDe Vault',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Ethena ERC-4626',
    protocolAddress: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    underlyingSymbol: 'USDe',
    underlyingAddress: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
    llamaKey: 'ethereum:0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
  },

  // ===================== BASE =====================
  {
    chain: 'base',
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    name: 'USD Coin (Base)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  {
    chain: 'base',
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'base:0x4200000000000000000000000000000000000006',
  },
  {
    chain: 'base',
    address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    symbol: 'AERO',
    name: 'Aerodrome Finance',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'base:0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  },
  {
    chain: 'base',
    address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
    symbol: 'DEGEN',
    name: 'Degen (Base)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'base:0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
  },
  {
    chain: 'base',
    address: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
    symbol: 'BRETT',
    name: 'Brett',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'base:0x532f27101965dd16442E59d40670FaF5eBB142E4',
  },
  {
    chain: 'base',
    address: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
    symbol: 'aBasUSDC',
    name: 'Aave v3 Base USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    llamaKey: 'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  {
    chain: 'base',
    address: '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7',
    symbol: 'aBasWETH',
    name: 'Aave v3 Base WETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    underlyingSymbol: 'WETH',
    underlyingAddress: '0x4200000000000000000000000000000000000006',
    llamaKey: 'base:0x4200000000000000000000000000000000000006',
  },
  {
    chain: 'base',
    address: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
    symbol: 'cUSDCv3',
    name: 'Compound v3 Base USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Compound v3',
    protocolAddress: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    llamaKey: 'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  {
    chain: 'base',
    address: '0x46e6b214b524310239732D51387075E0e70970bf',
    symbol: 'cWETHv3',
    name: 'Compound v3 Base WETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Compound v3',
    protocolAddress: '0x46e6b214b524310239732D51387075E0e70970bf',
    underlyingSymbol: 'WETH',
    underlyingAddress: '0x4200000000000000000000000000000000000006',
    llamaKey: 'base:0x4200000000000000000000000000000000000006',
  },
  {
    chain: 'base',
    address: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183',
    symbol: 'steakUSDC',
    name: 'Morpho Steakhouse USDC Vault',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Morpho ERC-4626',
    protocolAddress: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    llamaKey: 'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  {
    chain: 'base',
    address: '0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca',
    symbol: 'mwUSDC',
    name: 'Moonwell Flagship USDC Vault',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Morpho ERC-4626',
    protocolAddress: '0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    llamaKey: 'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },

  // ===================== ARBITRUM =====================
  {
    chain: 'arbitrum',
    address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    symbol: 'USDC',
    name: 'USD Coin (Arbitrum)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'arbitrum:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    chain: 'arbitrum',
    address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
    symbol: 'ARB',
    name: 'Arbitrum',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'arbitrum:0x912CE59144191C1204E64559FE8253a0e49E6548',
  },
  {
    chain: 'arbitrum',
    address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'arbitrum:0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
  {
    chain: 'arbitrum',
    address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
    symbol: 'GMX',
    name: 'GMX',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'arbitrum:0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
  },
  {
    chain: 'arbitrum',
    address: '0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
    symbol: 'PENDLE',
    name: 'Pendle',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'arbitrum:0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8',
  },
  {
    chain: 'arbitrum',
    address: '0x724dc807b04555b71ed48a6896b6F41593b8C637',
    symbol: 'aArbUSDCn',
    name: 'Aave v3 Arbitrum USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    llamaKey: 'arbitrum:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },
  {
    chain: 'arbitrum',
    address: '0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8',
    symbol: 'aArbWETH',
    name: 'Aave v3 Arbitrum WETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    underlyingSymbol: 'WETH',
    underlyingAddress: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    llamaKey: 'arbitrum:0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  },
  {
    chain: 'arbitrum',
    address: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
    symbol: 'cUSDCv3',
    name: 'Compound v3 Arbitrum USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Compound v3',
    protocolAddress: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    llamaKey: 'arbitrum:0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  },

  // ===================== OPTIMISM =====================
  {
    chain: 'optimism',
    address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    symbol: 'USDC',
    name: 'USD Coin (Optimism)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'optimism:0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  {
    chain: 'optimism',
    address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    symbol: 'USDT',
    name: 'Tether USD (Optimism)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'optimism:0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  },
  {
    chain: 'optimism',
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether (Optimism)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },
  {
    chain: 'optimism',
    address: '0x4200000000000000000000000000000000000042',
    symbol: 'OP',
    name: 'Optimism',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'optimism:0x4200000000000000000000000000000000000042',
  },
  {
    chain: 'optimism',
    address: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb',
    symbol: 'wstETH',
    name: 'Wrapped stETH (Optimism)',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Lido',
    protocolAddress: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb',
    underlyingSymbol: 'ETH',
    llamaKey: 'optimism:0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb',
  },
  {
    chain: 'optimism',
    address: '0x38d693cE1dF5AaDF7bC62595A37D667aD57922e5',
    symbol: 'aOptUSDCn',
    name: 'Aave v3 Optimism USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    llamaKey: 'optimism:0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },
  {
    chain: 'optimism',
    address: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB',
    symbol: 'cUSDCv3',
    name: 'Compound v3 Optimism USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Compound v3',
    protocolAddress: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    llamaKey: 'optimism:0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  },

  // ===================== POLYGON =====================
  {
    chain: 'polygon',
    address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    symbol: 'USDC',
    name: 'USD Coin (Polygon)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'polygon:0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  {
    chain: 'polygon',
    address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    symbol: 'USDT',
    name: 'Tether USD (Polygon)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'polygon:0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
  {
    chain: 'polygon',
    address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    symbol: 'WETH',
    name: 'Wrapped Ether (PoS)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'polygon:0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  },
  {
    chain: 'polygon',
    address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    symbol: 'WBTC',
    name: 'Wrapped BTC (Polygon)',
    decimals: 8,
    kind: 'erc20',
    llamaKey: 'polygon:0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
  },
  {
    chain: 'polygon',
    address: '0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD',
    symbol: 'aPolUSDCn',
    name: 'Aave v3 Polygon USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    llamaKey: 'polygon:0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },
  {
    chain: 'polygon',
    address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
    symbol: 'cUSDCv3',
    name: 'Compound v3 Polygon USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Compound v3',
    protocolAddress: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    llamaKey: 'polygon:0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  },

  // ===================== AVALANCHE =====================
  {
    chain: 'avalanche',
    address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    symbol: 'USDC',
    name: 'USD Coin (Avalanche)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'avax:0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  },
  {
    chain: 'avalanche',
    address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
    symbol: 'USDT',
    name: 'Tether USD (Avalanche)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'avax:0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
  },
  {
    chain: 'avalanche',
    address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    symbol: 'WAVAX',
    name: 'Wrapped AVAX',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:avalanche-2',
  },
  {
    chain: 'avalanche',
    address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    symbol: 'WETH.e',
    name: 'Wrapped Ether (Avalanche)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },
  {
    chain: 'avalanche',
    address: '0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd',
    symbol: 'JOE',
    name: 'Trader Joe',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'avax:0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd',
  },
  {
    chain: 'avalanche',
    address: '0x625E7708f30cA75bfd92586e17077590C60eb4cD',
    symbol: 'aAvaUSDC',
    name: 'Aave v3 Avalanche USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    llamaKey: 'avax:0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  },

  // ===================== BNB CHAIN (56) =====================
  {
    chain: 'bnb',
    address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    symbol: 'USDC',
    name: 'USD Coin (BNB)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'bsc:0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  },
  {
    chain: 'bnb',
    address: '0x55d398326f99059fF775485246999027B3197955',
    symbol: 'USDT',
    name: 'Tether USD (BNB)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'bsc:0x55d398326f99059fF775485246999027B3197955',
  },
  {
    chain: 'bnb',
    address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    symbol: 'WBNB',
    name: 'Wrapped BNB',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:binancecoin',
  },
  {
    chain: 'bnb',
    address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    symbol: 'ETH',
    name: 'Binance-Peg Ethereum',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },
  {
    chain: 'bnb',
    address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    symbol: 'CAKE',
    name: 'PancakeSwap',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'bsc:0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
  },
  // DeFi Positions on BNB Chain (Aave v3 Pool 0x6807dc923806fE8Fd134338EABCA509979a7e0cB)
  {
    chain: 'bnb',
    address: '0x00901a076785e0906d1028c7d6372d247bec7d61',
    symbol: 'aBnbUSDC',
    name: 'Aave v3 BNB USDC',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    llamaKey: 'bsc:0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  },
  {
    chain: 'bnb',
    address: '0xa9251ca9DE909CB71783723713B21E4233fbf1B1',
    symbol: 'aBnbUSDT',
    name: 'Aave v3 BNB USDT',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    underlyingSymbol: 'USDT',
    underlyingAddress: '0x55d398326f99059fF775485246999027B3197955',
    llamaKey: 'bsc:0x55d398326f99059fF775485246999027B3197955',
  },
  {
    chain: 'bnb',
    address: '0x9B00a09492a626678E5A3009982191586C444Df9',
    symbol: 'aBnbWBNB',
    name: 'Aave v3 BNB WBNB',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    underlyingSymbol: 'WBNB',
    underlyingAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    llamaKey: 'coingecko:binancecoin',
  },

  // ===================== SONIC (146) =====================
  {
    chain: 'sonic',
    address: '0x29219dd400f2Bf60E5a23d13Be72B486D4038894',
    symbol: 'USDC',
    name: 'USD Coin (Sonic)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'coingecko:usd-coin',
  },
  {
    chain: 'sonic',
    address: '0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38',
    symbol: 'wS',
    name: 'Wrapped Sonic',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:sonic-3',
  },

  // ===================== UNICHAIN (130) =====================
  {
    chain: 'unichain',
    address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
    symbol: 'USDC',
    name: 'USD Coin (Unichain)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'coingecko:usd-coin',
  },
  {
    chain: 'unichain',
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether (Unichain)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },

  // ===================== LINEA (59144) =====================
  {
    chain: 'linea',
    address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
    symbol: 'USDC',
    name: 'USD Coin (Linea)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'linea:0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  },
  {
    chain: 'linea',
    address: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f',
    symbol: 'WETH',
    name: 'Wrapped Ether (Linea)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },

  // ===================== SCROLL (534352) =====================
  {
    chain: 'scroll',
    address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
    symbol: 'USDC',
    name: 'USD Coin (Scroll)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'scroll:0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
  },
  {
    chain: 'scroll',
    address: '0x5300000000000000000000000000000000000004',
    symbol: 'WETH',
    name: 'Wrapped Ether (Scroll)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },

  // ===================== MANTLE (5000) =====================
  {
    chain: 'mantle',
    address: '0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
    symbol: 'USDC',
    name: 'USD Coin (Mantle)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'mantle:0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9',
  },
  {
    chain: 'mantle',
    address: '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111',
    symbol: 'WETH',
    name: 'Wrapped Ether (Mantle)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },

  // ===================== BLAST (81457) =====================
  {
    chain: 'blast',
    address: '0x4300000000000000000000000000000000000003',
    symbol: 'USDB',
    name: 'USDB (Blast)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'blast:0x4300000000000000000000000000000000000003',
  },
  {
    chain: 'blast',
    address: '0x4300000000000000000000000000000000000004',
    symbol: 'WETH',
    name: 'Wrapped Ether (Blast)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },

  // ===================== WORLD CHAIN (480) =====================
  {
    chain: 'worldchain',
    address: '0x79A02482A880bCE3F13e09Da970dC34db4CD24d1',
    symbol: 'USDC',
    name: 'USD Coin (World Chain)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'coingecko:usd-coin',
  },
  {
    chain: 'worldchain',
    address: '0x2cFc85d8E48F8EAB294be644d9E25C3030863003',
    symbol: 'WLD',
    name: 'Worldcoin',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:worldcoin-wld',
  },

  // ===================== HYPEREVM (999) =====================
  {
    chain: 'hyperevm',
    address: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
    symbol: 'USDC',
    name: 'USD Coin (HyperEVM)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'hyperliquid:0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  },
  {
    chain: 'hyperevm',
    address: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
    symbol: 'USDT0',
    name: 'Tether USD₮0 (HyperEVM)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'hyperliquid:0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb',
  },
  {
    chain: 'hyperevm',
    address: '0x5555555555555555555555555555555555555555',
    symbol: 'WHYPE',
    name: 'Wrapped HYPE',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:hyperliquid',
  },
  {
    chain: 'hyperevm',
    address: '0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463',
    symbol: 'UBTC',
    name: 'Unit Bitcoin (HyperEVM)',
    decimals: 8,
    kind: 'erc20',
    llamaKey: 'hyperliquid:0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463',
  },
  {
    chain: 'hyperevm',
    address: '0xBe6727B535545C67d5cAa73dEa54865B92CF7907',
    symbol: 'UETH',
    name: 'Unit Ethereum (HyperEVM)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'hyperliquid:0xBe6727B535545C67d5cAa73dEa54865B92CF7907',
  },
  // DeFi Positions on HyperEVM (HyperLend Aave v3 fork 0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b)
  {
    chain: 'hyperevm',
    address: '0x744e4f26ee30213989216e1632d9be3547c4885b',
    symbol: 'hHyperEvmUSDC',
    name: 'HyperLend v3 HyperEVM USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0xb88339CB7199b77E23DB6E890353E22632Ba630f',
    llamaKey: 'hyperliquid:0xb88339CB7199b77E23DB6E890353E22632Ba630f',
  },
  {
    chain: 'hyperevm',
    address: '0x0d745eaa9e70bb8b6e2a0317f85f1d536616bd34',
    symbol: 'hHyperEvmWHYPE',
    name: 'HyperLend v3 HyperEVM WHYPE',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b',
    underlyingSymbol: 'WHYPE',
    underlyingAddress: '0x5555555555555555555555555555555555555555',
    llamaKey: 'coingecko:hyperliquid',
  },

  // ===================== BERACHAIN (80094) =====================
  {
    chain: 'berachain',
    address: '0x549943e04f40284185054145c6E4e9568C1D3241',
    symbol: 'USDC.e',
    name: 'Bridged USDC (Berachain)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'berachain:0x549943e04f40284185054145c6E4e9568C1D3241',
  },
  {
    chain: 'berachain',
    address: '0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce',
    symbol: 'HONEY',
    name: 'Honey Stablecoin (Berachain)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'berachain:0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce',
  },
  {
    chain: 'berachain',
    address: '0x6969696969696969696969696969696969696969',
    symbol: 'WBERA',
    name: 'Wrapped BERA',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:berachain-bera',
  },
  {
    chain: 'berachain',
    address: '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590',
    symbol: 'WETH',
    name: 'Wrapped Ether (Berachain)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },
  {
    chain: 'berachain',
    address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    symbol: 'WBTC',
    name: 'Wrapped BTC (Berachain)',
    decimals: 8,
    kind: 'erc20',
    llamaKey: 'coingecko:wrapped-bitcoin',
  },
  {
    chain: 'berachain',
    address: '0xac03CABA51e17c86c921E1f6CBFBdC91F8BB2E6b',
    symbol: 'iBGT',
    name: 'Infrared BGT (Berachain)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:berachain-bera',
  },

  // ===================== ZKSYNC ERA (324) =====================
  {
    chain: 'zksync',
    address: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',
    symbol: 'USDC',
    name: 'USD Coin (zkSync Era)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'era:0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',
  },
  {
    chain: 'zksync',
    address: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4',
    symbol: 'USDC.e',
    name: 'Bridged USDC.e (zkSync Era)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'era:0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4',
  },
  {
    chain: 'zksync',
    address: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
    symbol: 'WETH',
    name: 'Wrapped Ether (zkSync Era)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },
  {
    chain: 'zksync',
    address: '0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E',
    symbol: 'ZK',
    name: 'ZKsync',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'era:0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E',
  },
  {
    chain: 'zksync',
    address: '0xBBeB516fb02a01611cBBE0453Fe3c580D7281011',
    symbol: 'WBTC',
    name: 'Wrapped BTC (zkSync Era)',
    decimals: 8,
    kind: 'erc20',
    llamaKey: 'coingecko:wrapped-bitcoin',
  },
  // DeFi Positions on zkSync Era (Aave v3 Pool 0x78e30497a3c7527d953c6B1E3541b021A98Ac43c)
  {
    chain: 'zksync',
    address: '0xe977f9b2a5ccf0457870a67231f23be4daecfbdb',
    symbol: 'aZksUSDC',
    name: 'Aave v3 zkSync USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',
    llamaKey: 'era:0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4',
  },
  {
    chain: 'zksync',
    address: '0xb7b93bcf82519bb757fd18b23a389245dbd8ca64',
    symbol: 'aZksWETH',
    name: 'Aave v3 zkSync WETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c',
    underlyingSymbol: 'WETH',
    underlyingAddress: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
    llamaKey: 'coingecko:ethereum',
  },

  // ===================== INK (57073) =====================
  {
    chain: 'ink',
    address: '0x2D270e6886d130D724215A266106e6832161EAEd',
    symbol: 'USDC',
    name: 'USD Coin (Ink)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'ink:0x2D270e6886d130D724215A266106e6832161EAEd',
  },
  {
    chain: 'ink',
    address: '0xF1815bd50389c46847f0Bda824eC8da914045D14',
    symbol: 'USDC.e',
    name: 'Bridged USDC.e (Ink)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'ink:0xF1815bd50389c46847f0Bda824eC8da914045D14',
  },
  {
    chain: 'ink',
    address: '0x0200C29006150606B650577BBE7B6248F58470c1',
    symbol: 'USDT0',
    name: 'Tether USD₮0 (Ink)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'ink:0x0200C29006150606B650577BBE7B6248F58470c1',
  },
  {
    chain: 'ink',
    address: '0x4200000000000000000000000000000000000006',
    symbol: 'WETH',
    name: 'Wrapped Ether (Ink)',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },
  {
    chain: 'ink',
    address: '0x73E0C0d45E048D25Fc26Fa3159b0aA04BfA4Db98',
    symbol: 'kBTC',
    name: 'Kraken Wrapped BTC (Ink)',
    decimals: 8,
    kind: 'erc20',
    llamaKey: 'coingecko:wrapped-bitcoin',
  },
  // DeFi Positions on Ink (Aave v3 Pool 0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA)
  {
    chain: 'ink',
    address: '0x70a38b0c90441e991346b7a0cd98c8528dd1c234',
    symbol: 'aInkWlUSDC',
    name: 'Aave v3 Ink USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x2D270e6886d130D724215A266106e6832161EAEd',
    llamaKey: 'ink:0x2D270e6886d130D724215A266106e6832161EAEd',
  },
  {
    chain: 'ink',
    address: '0x2b35ef056728baffac103e3b81cb029788006ef9',
    symbol: 'aInkWlWETH',
    name: 'Aave v3 Ink WETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA',
    underlyingSymbol: 'WETH',
    underlyingAddress: '0x4200000000000000000000000000000000000006',
    llamaKey: 'coingecko:ethereum',
  },

  // ===================== GNOSIS CHAIN (100) =====================
  {
    chain: 'gnosis',
    address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
    symbol: 'WXDAI',
    name: 'Wrapped xDAI',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'xdai:0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
  },
  {
    chain: 'gnosis',
    address: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
    symbol: 'USDC.e',
    name: 'Bridged USDC.e (Gnosis)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'xdai:0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
  },
  {
    chain: 'gnosis',
    address: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
    symbol: 'USDC',
    name: 'USD Coin on xDai (Legacy)',
    decimals: 6,
    kind: 'erc20',
    llamaKey: 'xdai:0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
  },
  {
    chain: 'gnosis',
    address: '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1',
    symbol: 'WETH',
    name: 'Wrapped Ether on xDai',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'coingecko:ethereum',
  },
  {
    chain: 'gnosis',
    address: '0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
    symbol: 'GNO',
    name: 'Gnosis Token',
    decimals: 18,
    kind: 'erc20',
    llamaKey: 'xdai:0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb',
  },
  // DeFi Positions on Gnosis (Spark ERC-4626 sDAI, Lido wstETH, Aave v3 Pool 0xb50201558B00496A145fE76f7424749556E326D8)
  {
    chain: 'gnosis',
    address: '0xaf204776c7245bF4147c2612BF6e5972Ee483701',
    symbol: 'sDAI',
    name: 'Savings xDAI Vault (Gnosis ERC-4626)',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Spark ERC-4626',
    protocolAddress: '0xaf204776c7245bF4147c2612BF6e5972Ee483701',
    underlyingSymbol: 'WXDAI',
    underlyingAddress: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
    llamaKey: 'xdai:0xaf204776c7245bF4147c2612BF6e5972Ee483701',
  },
  {
    chain: 'gnosis',
    address: '0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6',
    symbol: 'wstETH',
    name: 'Wrapped Lido Staked ETH (Gnosis)',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Lido',
    protocolAddress: '0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6',
    underlyingSymbol: 'ETH',
    llamaKey: 'coingecko:wrapped-steth',
  },
  {
    chain: 'gnosis',
    address: '0xd0Dd6cEF72143E22cCED4867eb0d5F2328715533',
    symbol: 'aGnoWXDAI',
    name: 'Aave v3 Gnosis WXDAI',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0xb50201558B00496A145fE76f7424749556E326D8',
    underlyingSymbol: 'WXDAI',
    underlyingAddress: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
    llamaKey: 'xdai:0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
  },
  {
    chain: 'gnosis',
    address: '0xc0333cb85b59a788d8c7cae5e1fd6e229a3e5a65',
    symbol: 'aGnoUSDCe',
    name: 'Aave v3 Gnosis USDC.e',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0xb50201558B00496A145fE76f7424749556E326D8',
    underlyingSymbol: 'USDC.e',
    underlyingAddress: '0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
    llamaKey: 'xdai:0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0',
  },
  {
    chain: 'gnosis',
    address: '0xc6B7AcA6DE8a6044E0e32d0c841a89244A10D284',
    symbol: 'aGnoUSDC',
    name: 'Aave v3 Gnosis USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0xb50201558B00496A145fE76f7424749556E326D8',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
    llamaKey: 'xdai:0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83',
  },
  {
    chain: 'gnosis',
    address: '0x7a5c3860a77a8DC1b225BD46d0FB2ac1C6D191BC',
    symbol: 'aGnosDAI',
    name: 'Aave v3 Gnosis sDAI',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0xb50201558B00496A145fE76f7424749556E326D8',
    underlyingSymbol: 'sDAI',
    underlyingAddress: '0xaf204776c7245bF4147c2612BF6e5972Ee483701',
    llamaKey: 'xdai:0xaf204776c7245bF4147c2612BF6e5972Ee483701',
  },
];

const CURATED_REGISTRY_KEY_SET = new Set<string>(
  TOKEN_REGISTRY.map((t) => `${t.chain}:${t.address.toLowerCase()}`)
);

/**
 * Returns true if the given (chain, address) pair is a curated blue-chip or DeFi receipt token
 * in `TOKEN_REGISTRY`. Curated registry tokens must NEVER be classified as `BURN_ZERO_LIQUIDITY`.
 */
export function isCuratedRegistryToken(chain: string, address: string): boolean {
  if (!chain || !address) return false;
  return CURATED_REGISTRY_KEY_SET.has(`${chain.toLowerCase()}:${address.toLowerCase()}`);
}
