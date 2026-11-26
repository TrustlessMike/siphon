import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  type ProtocolFeeConfig,
} from '../scanner/chains.js';
import {
  checkErc20Allowance,
  SOLANA_USDC_MINT,
} from '../scanner/discovery.js';
import {
  evaluateLiveQuoteHaircut,
  SOLANA_USDC_ATA_RENT_SOL,
} from '../scanner/roi.js';
import type { EvmChainId, ScannedAsset } from '../scanner/types.js';

export const SOLANA_NATIVE_MINT = '11111111111111111111111111111111';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const MAYAN_FORWARDER_CONTRACT = '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2';
export const MAYAN_SOLANA_PROGRAM_ID = 'FC4eXxkyrMPTjiYUpp4EAnkmwMbQyZ6NDCh1kfLn6vsf';
export const MAYAN_SDK_VERSION = '16_1_0';
export const DEBRIDGE_SOLANA_CHAIN_ID = 7565164;
export const DEFAULT_AUCTION_TIMEOUT_MS = 3500;
export const DEFAULT_SOL_PRICE_USD = 150;
export const MIN_GAS_RESERVE_SAFETY_MULTIPLIER = 2.0;
export const DEFAULT_GAS_RESERVE_SAFETY_MULTIPLIER = 2.25;

export type AuctionBridgeProvider =
  | 'relay'
  | 'mayan_swift'
  | 'debridge_dln'
  | 'lifi'
  | 'circle_cctp';

export type RouteAuctionFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type RouteAuctionAllowanceCheckFn = (params: {
  chain: EvmChainId;
  tokenAddress: string;
  owner: string;
  spender: string;
}) => Promise<bigint>;

export interface AuctionExecutableTx {
  stepId: string;
  label: string;
  description: string;
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  explorerUrl: string;
  from: string;
  to: string;
  data: string;
  value: string;
  gas?: string;
}

export interface AuctionProviderQuote {
  provider: AuctionBridgeProvider;
  label?: string;
  requestId?: string;
  estimatedOutput: string;
  estimatedSeconds: number;
  quotedOutUsd: number;
  estimatedGasUsd: number;
  /** Additional fixed bridge / relayer fee USD NOT already deducted from quotedOutUsd */
  extraBridgeFeeUsd?: number;
  /** Informational total bridge fee USD (for telemetry / breakdown) */
  bridgeFeeUsd?: number;
  /** Additional slippage USD NOT already deducted from quotedOutUsd */
  extraSlippageUsd?: number;
  /** Informational slippage USD */
  slippageUsd?: number;
  /** True if the provider creates/funds Solana USDC ATA without charging the user separately */
  sponsorsSolanaAta?: boolean;
  estimatedFeeUsd?: number;
  collectionMethod?: 'relay_app_fee' | 'onchain_split' | 'none';
  transactions: AuctionExecutableTx[];
  notes: string[];
}

export type AuctionProviderFn = (ctx: {
  signal: AbortSignal;
  timeoutMs: number;
  slippageBps: number;
}) => Promise<AuctionProviderQuote | null>;

export interface RouteAuctionCandidateSummary {
  provider: AuctionBridgeProvider;
  label: string;
  status: 'ok' | 'rejected_security' | 'rejected_haircut' | 'timeout' | 'error' | 'ineligible';
  quotedOutUsd: number;
  gasUsd: number;
  bridgeFeeUsd: number;
  slippageUsd: number;
  ataRentUsd: number;
  /** Net USD after gas, bridge fee, slippage, and ATA rent (alias of liveNetUsd) */
  netUsd: number;
  liveNetUsd: number;
  liveHaircutPct: number;
  etaSeconds: number;
  latencyMs: number;
  requestId?: string;
  reason?: string;
}

export interface RouteAuctionMetadata {
  winnerProvider: AuctionBridgeProvider;
  winnerNetUsd: number;
  runnerUpProvider?: AuctionBridgeProvider;
  runnerUpNetUsd?: number;
  dollarsSavedOverRunnerUp: number;
  bpsSavedOverRunnerUp: number;
  totalAuctionDurationMs: number;
  providersQueried: AuctionBridgeProvider[];
  providersSucceeded: number;
  candidates: RouteAuctionCandidateSummary[];
  perAssetAuctions?: Record<string, Omit<RouteAuctionMetadata, 'perAssetAuctions'>>;
}

export interface RouteAuctionResult {
  winner: AuctionProviderQuote & {
    liveNetUsd: number;
    liveHaircutPct: number;
    ataRentUsd: number;
  };
  routeAuction: RouteAuctionMetadata;
}

export interface RouterTargetValidationResult {
  valid: boolean;
  reason?: string;
}

const PROVIDER_LABELS: Record<AuctionBridgeProvider, string> = {
  circle_cctp: 'Circle CCTP',
  mayan_swift: 'Mayan Swift',
  debridge_dln: 'deBridge DLN',
  relay: 'Relay',
  lifi: 'LI.FI',
};

const PROVIDER_TIE_BREAK_ORDER: Record<AuctionBridgeProvider, number> = {
  circle_cctp: 1,
  mayan_swift: 2,
  relay: 3,
  debridge_dln: 4,
  lifi: 5,
};

const MAYAN_CHAIN_SLUGS: Partial<Record<EvmChainId, string>> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  avalanche: 'avalanche',
  bnb: 'bsc',
  sonic: 'sonic',
  unichain: 'unichain',
  linea: 'linea',
  hyperevm: 'hyperevm',
};

const DEBRIDGE_SUPPORTED_CHAINS = new Set<EvmChainId>([
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'avalanche',
  'bnb',
  'linea',
  'sonic',
  'mantle',
  'scroll',
  'hyperevm',
]);

/** Chains where deBridge DLN uses an internal non-EIP-155 chain ID */
export const DEBRIDGE_CHAIN_ID_OVERRIDE: Partial<Record<EvmChainId, number>> = {
  hyperevm: 100000022,
};

const L2_ROLLUP_CHAINS = new Set<EvmChainId>([
  'base',
  'arbitrum',
  'optimism',
  'unichain',
  'linea',
  'scroll',
  'mantle',
  'blast',
  'worldchain',
  'zksync',
  'ink',
]);

const STABLE_OR_MAJOR_SYMBOLS = new Set<string>([
  'USDC',
  'USDT',
  'USDT0',
  'DAI',
  'XDAI',
  'WXDAI',
  'HONEY',
  'USDS',
  'USDC.E',
  'USDBC',
  'PYUSD',
  'FDUSD',
  'ETH',
  'WETH',
  'UETH',
  'WBTC',
  'UBTC',
  'KBTC',
  'BTC',
  'CBBTC',
  'HYPE',
  'WHYPE',
  'BERA',
  'WBERA',
  'ZK',
  'GNO',
  'SOL',
  'WSOL',
  'SUI',
  'ATOM',
  'OSMO',
  'TRX',
  'TON',
  'BNB',
  'AVAX',
  'POL',
  'MATIC',
]);

function r2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
}

function r4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(4));
}

function isValidEvmAddressFormat(val: string | undefined | null): val is string {
  return typeof val === 'string' && /^0x[0-9a-fA-F]{40}$/.test(val.trim());
}

function toHexWei(val: string | number | bigint | undefined): string {
  if (val === undefined || val === null || val === '') return '0x0';
  if (typeof val === 'string' && /^0x[0-9a-fA-F]+$/.test(val.trim())) return val.trim().toLowerCase();
  try {
    const big = BigInt(val);
    return big < 0n ? '0x0' : `0x${big.toString(16)}`;
  } catch {
    return '0x0';
  }
}

function pad32Address(addr: string): string {
  const clean = addr.trim();
  if (!isValidEvmAddressFormat(clean)) {
    throw new Error(`Invalid EVM address for ABI encoding: ${addr}`);
  }
  return clean.slice(2).toLowerCase().padStart(64, '0');
}

function encodeErc20Approve(spender: string, amount: bigint): string {
  return `0x095ea7b3${pad32Address(spender)}${amount.toString(16).padStart(64, '0')}`;
}

function encodeErc20Transfer(to: string, amount: bigint): string {
  return `0xa9059cbb${pad32Address(to)}${amount.toString(16).padStart(64, '0')}`;
}

function decodeApproveSpender(data: string): string | null {
  const clean = data.trim().toLowerCase();
  if (!clean.startsWith('0x095ea7b3') || clean.length < 138) return null;
  const spender = `0x${clean.slice(34, 74)}`;
  return isValidEvmAddressFormat(spender) ? spender : null;
}

function splitRawAmountForFee(
  rawAmount: bigint,
  feeConfig: ProtocolFeeConfig
): { feeRaw: bigint; netRaw: bigint } {
  if (!feeConfig.feeRecipientEvm || feeConfig.feeBps <= 0 || rawAmount <= 0n) {
    return { feeRaw: 0n, netRaw: rawAmount };
  }
  const feeRaw = (rawAmount * BigInt(feeConfig.feeBps)) / 10_000n;
  const netRaw = rawAmount - feeRaw;
  return { feeRaw, netRaw };
}

function buildProtocolFeeTx(params: {
  asset: ScannedAsset;
  chain: EvmChainId;
  userAddress: string;
  feeRaw: bigint;
  feeConfig: ProtocolFeeConfig;
}): AuctionExecutableTx | null {
  const { asset, chain, userAddress, feeRaw, feeConfig } = params;
  if (!feeConfig.feeRecipientEvm || feeRaw <= 0n) return null;
  const cfg = EVM_CHAINS[chain];
  const recipient = feeConfig.feeRecipientEvm;
  const destLabel = feeConfig.feeDestinationType === 'wallet' ? 'Treasury Wallet' : 'TurgaliumFeeVault';

  if (asset.address === 'native') {
    return {
      stepId: 'protocol_fee_transfer',
      label: `Protocol Fee (${feeConfig.feePercent}% ${asset.symbol} → ${destLabel})`,
      description: `Routes ${feeConfig.feePercent}% (${feeConfig.feeBps} bps) native ${asset.symbol} fee to ${recipient}`,
      chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      from: userAddress,
      to: recipient,
      data: '0x',
      value: toHexWei(feeRaw),
    };
  }

  return {
    stepId: 'protocol_fee_transfer',
    label: `Protocol Fee (${feeConfig.feePercent}% ${asset.symbol} → ${destLabel})`,
    description: `Transfers ${feeConfig.feePercent}% (${feeConfig.feeBps} bps) ${asset.symbol} fee to ${recipient}`,
    chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    from: userAddress,
    to: asset.address,
    data: encodeErc20Transfer(recipient, feeRaw),
    value: '0x0',
  };
}

// =====================================================================
// FAIL-CLOSED ROUTER TARGET & CALLDATA VALIDATION
// =====================================================================

/**
 * Fail-closed validator for any router/bridge execution target returned by an external quote API.
 * Rejects zero address, dead burn address, user address, any token address, and missing/malformed calldata.
 */
export function validateRouterCallTarget(params: {
  to: string | undefined | null;
  data: string | undefined | null;
  userAddress: string;
  tokenAddresses?: Array<string | undefined | null>;
  requireCalldata?: boolean;
}): RouterTargetValidationResult {
  const { to, data, userAddress, tokenAddresses = [], requireCalldata = true } = params;

  if (!isValidEvmAddressFormat(to)) {
    return { valid: false, reason: 'Invalid router target: expected 20-byte 0x EVM address.' };
  }
  const targetLower = to.trim().toLowerCase();

  if (targetLower === ZERO_ADDRESS) {
    return { valid: false, reason: 'Blocked router target: zero address is forbidden.' };
  }
  if (targetLower === DEAD_BURN_ADDRESS.toLowerCase()) {
    return { valid: false, reason: 'Blocked router target: dead burn address is forbidden.' };
  }
  if (isValidEvmAddressFormat(userAddress) && targetLower === userAddress.trim().toLowerCase()) {
    return { valid: false, reason: 'Blocked router target: spoofed user self-address is forbidden.' };
  }

  for (const tok of tokenAddresses) {
    if (tok && tok !== 'native' && isValidEvmAddressFormat(tok)) {
      if (targetLower === tok.trim().toLowerCase()) {
        return {
          valid: false,
          reason: `Blocked router target: target matches token contract ${tok} (possible direct transfer spoof).`,
        };
      }
    }
  }

  if (requireCalldata) {
    if (typeof data !== 'string') {
      return { valid: false, reason: 'Blocked router call: missing hex calldata.' };
    }
    const cleanData = data.trim();
    if (!/^0x[0-9a-fA-F]{8,}$/.test(cleanData) || (cleanData.length - 2) % 2 !== 0) {
      return {
        valid: false,
        reason: 'Blocked router call: calldata must be non-empty valid even-length hex with 4-byte selector.',
      };
    }
  }

  return { valid: true };
}

/**
 * Validates every transaction in a candidate quote fail-closed:
 * - `protocol_fee_transfer` steps may target the configured fee recipient (native) or asset token (ERC-20 transfer).
 * - `approve` steps must target the asset token address and approve a safe non-spoofed spender.
 * - All router/bridge execution steps must pass `validateRouterCallTarget` with non-empty hex calldata.
 */
export function validateQuoteTransactions(params: {
  transactions: AuctionExecutableTx[];
  asset: ScannedAsset;
  chain: EvmChainId;
  userAddress: string;
  feeRecipientEvm?: string | null;
}): RouterTargetValidationResult {
  const { transactions, asset, chain, userAddress, feeRecipientEvm } = params;
  if (!Array.isArray(transactions) || transactions.length === 0) {
    return { valid: false, reason: 'Quote returned zero executable transactions.' };
  }

  const cfg = EVM_CHAINS[chain];
  const forbiddenTokens: string[] = [];
  if (asset.address && asset.address !== 'native') forbiddenTokens.push(asset.address);
  if (cfg?.usdcAddress) forbiddenTokens.push(cfg.usdcAddress);

  let bridgeExecutionCount = 0;

  for (const tx of transactions) {
    const stepLower = (tx.stepId || '').toLowerCase();

    if (stepLower === 'protocol_fee_transfer' || stepLower.startsWith('protocol_fee_transfer')) {
      if (!feeRecipientEvm || !isValidEvmAddressFormat(feeRecipientEvm)) {
        return { valid: false, reason: 'Unexpected protocol_fee_transfer without configured fee recipient.' };
      }
      if (asset.address === 'native') {
        if (tx.to.trim().toLowerCase() !== feeRecipientEvm.trim().toLowerCase()) {
          return { valid: false, reason: 'Protocol fee native transfer target does not match fee recipient.' };
        }
      } else {
        if (tx.to.trim().toLowerCase() !== asset.address.trim().toLowerCase()) {
          return { valid: false, reason: 'Protocol fee ERC-20 transfer target does not match token contract.' };
        }
      }
      continue;
    }

    const approveSpender = decodeApproveSpender(tx.data || '');
    if (approveSpender) {
      if (asset.address === 'native') {
        return { valid: false, reason: 'Unexpected ERC-20 approve step for native gas asset.' };
      }
      if (tx.to.trim().toLowerCase() !== asset.address.trim().toLowerCase()) {
        return {
          valid: false,
          reason: `Blocked approve step: target ${tx.to} does not match input token ${asset.address}.`,
        };
      }
      const spenderCheck = validateRouterCallTarget({
        to: approveSpender,
        data: '0x00000000',
        userAddress,
        tokenAddresses: forbiddenTokens,
        requireCalldata: false,
      });
      if (!spenderCheck.valid) {
        return {
          valid: false,
          reason: `Blocked approve spender (${approveSpender}): ${spenderCheck.reason}`,
        };
      }
      continue;
    }

    const check = validateRouterCallTarget({
      to: tx.to,
      data: tx.data,
      userAddress,
      tokenAddresses: forbiddenTokens,
      requireCalldata: true,
    });
    if (!check.valid) {
      return check;
    }
    bridgeExecutionCount += 1;
  }

  if (bridgeExecutionCount === 0) {
    return { valid: false, reason: 'Quote contained no executable bridge/router call.' };
  }

  return { valid: true };
}

// =====================================================================
// DYNAMIC TIER-SCALED SLIPPAGE (EVM & NON-EVM)
// =====================================================================

export interface TierScaledSlippageResult {
  slippageBps: number;
  slippageFraction: number;
  slippagePercent: number;
  tier: 'principal_major' | 'standard_major' | 'mid_cap' | 'micro_dust' | 'thin_liquidity';
  impactRatio: number;
}

/**
 * Computes dynamic tier-scaled slippage tolerance (in bps) based on trade size vs liquidity depth.
 * Prevents MEV sandwiching on large/stable swaps (0.20%-0.50%) while giving micro-dust / thin pools
 * enough headroom (1.0%-2.0%) to execute reliably without reverting.
 */
export function computeTierScaledSlippageBps(params: {
  tradeUsd?: number;
  liquidityUsd?: number;
  symbol?: string;
  isStableOrMajor?: boolean;
  overrideBps?: number;
}): TierScaledSlippageResult {
  if (
    typeof params.overrideBps === 'number' &&
    Number.isFinite(params.overrideBps) &&
    params.overrideBps > 0
  ) {
    const bps = Math.max(10, Math.min(500, Math.round(params.overrideBps)));
    return {
      slippageBps: bps,
      slippageFraction: Number((bps / 10_000).toFixed(4)),
      slippagePercent: Number((bps / 100).toFixed(2)),
      tier: bps <= 35 ? 'principal_major' : bps <= 75 ? 'standard_major' : bps <= 125 ? 'mid_cap' : 'micro_dust',
      impactRatio: 0,
    };
  }

  const sym = (params.symbol ?? '').trim().toUpperCase();
  const isMajor = Boolean(params.isStableOrMajor) || (sym.length > 0 && STABLE_OR_MAJOR_SYMBOLS.has(sym));
  const tradeUsd =
    typeof params.tradeUsd === 'number' && Number.isFinite(params.tradeUsd) && params.tradeUsd > 0
      ? params.tradeUsd
      : undefined;
  const liquidityUsd =
    typeof params.liquidityUsd === 'number' &&
    Number.isFinite(params.liquidityUsd) &&
    params.liquidityUsd > 0
      ? params.liquidityUsd
      : undefined;

  let baseBps: number;
  let tier: TierScaledSlippageResult['tier'];

  if (tradeUsd === undefined) {
    baseBps = isMajor ? 50 : 100;
    tier = isMajor ? 'standard_major' : 'mid_cap';
  } else if (isMajor && tradeUsd >= 10_000) {
    baseBps = 25;
    tier = 'principal_major';
  } else if (isMajor && tradeUsd >= 1_000) {
    baseBps = 30;
    tier = 'principal_major';
  } else if (tradeUsd >= 500 || (isMajor && tradeUsd >= 100)) {
    baseBps = 50;
    tier = 'standard_major';
  } else if (tradeUsd >= 50) {
    baseBps = 100;
    tier = 'mid_cap';
  } else {
    baseBps = 175;
    tier = 'micro_dust';
  }

  let impactRatio = 0;
  let liquidityBufferBps = 0;

  if (tradeUsd !== undefined && liquidityUsd !== undefined) {
    impactRatio = tradeUsd / liquidityUsd;
    // Constant-product usable quote reserve is ~50% of TVL; add 1.5x buffer for live price movement.
    if (impactRatio > 0.0005) {
      const approxImpactBps = (impactRatio / (0.5 + impactRatio)) * 10_000;
      liquidityBufferBps = Math.ceil(approxImpactBps * 1.25);
    }
    if (liquidityUsd < 25_000) {
      tier = 'thin_liquidity';
      baseBps = Math.max(baseBps, 150);
    } else if (liquidityUsd < 100_000 && !isMajor) {
      baseBps = Math.max(baseBps, 100);
    }
  }

  const maxCapBps =
    tier === 'thin_liquidity' || (tradeUsd !== undefined && tradeUsd < 50) ? 250 : isMajor && (tradeUsd ?? 0) >= 1_000 ? 100 : 200;
  const minFloorBps = isMajor && (tradeUsd ?? 0) >= 10_000 && (liquidityUsd ?? 10_000_000) >= 5_000_000 ? 20 : 30;
  const clampedBps = Math.max(minFloorBps, Math.min(maxCapBps, Math.round(baseBps + liquidityBufferBps)));

  return {
    slippageBps: clampedBps,
    slippageFraction: Number((clampedBps / 10_000).toFixed(4)),
    slippagePercent: Number((clampedBps / 100).toFixed(2)),
    tier,
    impactRatio: r4(impactRatio),
  };
}

// =====================================================================
// DYNAMIC NATIVE GAS RESERVE SIZING (RECOVERS STRANDED ETH / L2 DUST)
// =====================================================================

const FALLBACK_GAS_PRICE_WEI: Record<EvmChainId, bigint> = {
  ethereum: 10_000_000_000n, // 10 gwei
  base: 50_000_000n, // 0.05 gwei
  arbitrum: 100_000_000n, // 0.1 gwei
  optimism: 50_000_000n, // 0.05 gwei
  polygon: 40_000_000_000n, // 40 gwei
  avalanche: 25_000_000_000n, // 25 gwei
  bnb: 3_000_000_000n, // 3 gwei
  sonic: 50_000_000_000n, // 50 gwei
  unichain: 50_000_000n, // 0.05 gwei
  linea: 100_000_000n, // 0.1 gwei
  scroll: 150_000_000n, // 0.15 gwei
  mantle: 20_000_000n, // 0.02 gwei
  blast: 50_000_000n, // 0.05 gwei
  worldchain: 50_000_000n, // 0.05 gwei
  hyperevm: 100_000_000n, // 0.1 gwei
  berachain: 100_000_000n, // 0.1 gwei
  zksync: 25_000_000n, // 0.025 gwei
  ink: 50_000_000n, // 0.05 gwei
  gnosis: 2_000_000_000n, // 2 gwei
};

/** Per-tx L1 blob data posting floor (in native wei) for L2 chains under EIP-4844 */
const DEFAULT_L2_DATA_FEE_PER_TX_WEI: Partial<Record<EvmChainId, bigint>> = {
  base: 4_000_000_000_000n, // 0.000004 ETH (~$0.01)
  arbitrum: 5_000_000_000_000n, // 0.000005 ETH (~$0.0125)
  optimism: 4_000_000_000_000n, // 0.000004 ETH
  unichain: 4_000_000_000_000n,
  linea: 10_000_000_000_000n, // 0.00001 ETH (~$0.025)
  scroll: 12_000_000_000_000n, // 0.000012 ETH (~$0.03)
  blast: 4_000_000_000_000n,
  worldchain: 4_000_000_000_000n,
  mantle: 1_000_000_000_000_000n, // 0.001 MNT (~$0.001)
  zksync: 10_000_000_000_000n, // 0.00001 ETH (~$0.025)
  ink: 4_000_000_000_000n, // 0.000004 ETH (~$0.01)
};

export interface DynamicGasReserveOptions {
  /** When EIP-7702 / ERC-7677 Paymaster sponsors gas, reserve drops to 0n (100% native sweep) */
  gasSponsored?: boolean;
  /** Optional explicit L1 data fee per tx in wei */
  l1DataFeePerTxWei?: bigint;
  /** Safety multiplier for final sweep tx (strictly enforced >= 2.0x; defaults to 2.25x) */
  safetyMultiplier?: number;
  /** Override per-tx gas units (defaults to max(swapGasUnits, bridgeGasUnits)) */
  perTxGasUnits?: number;
}

/**
 * Dynamically computes the native gas reserve (in wei) required to safely execute `plannedTxCount`
 * final transactions at `liveGasPriceWei` while preserving at least a 2.0x safety multiplier.
 *
 * Replaces oversized static reserves (`0.0005 ETH` on L2s, `0.002 ETH` on Ethereum) so users
 * recover $10–$18 of previously stranded native dust across multi-chain wallets without ever
 * risking an out-of-gas failure on the final sweep tx (including during L1 gas spikes).
 */
export function computeDynamicGasReserveWei(
  chain: EvmChainId,
  liveGasPriceWei: bigint,
  plannedTxCount = 1,
  options: DynamicGasReserveOptions = {}
): bigint {
  const cfg = EVM_CHAINS[chain];
  if (!cfg) {
    throw new Error(`Unsupported EVM chain for dynamic gas reserve: ${chain}`);
  }

  if (options.gasSponsored) {
    return 0n;
  }

  const safeTxCount =
    Number.isFinite(plannedTxCount) && plannedTxCount > 0
      ? Math.min(50, Math.max(1, Math.ceil(plannedTxCount)))
      : 1;

  const effectiveGasPriceWei =
    liveGasPriceWei > 0n ? liveGasPriceWei : FALLBACK_GAS_PRICE_WEI[chain];

  const perTxUnits = BigInt(
    options.perTxGasUnits && Number.isFinite(options.perTxGasUnits) && options.perTxGasUnits > 0
      ? Math.ceil(options.perTxGasUnits)
      : Math.max(cfg.swapGasUnits, cfg.bridgeGasUnits)
  );

  // Enforce >= 2.0x safety multiplier strictly (default 2.25x)
  const rawMult =
    typeof options.safetyMultiplier === 'number' && Number.isFinite(options.safetyMultiplier)
      ? options.safetyMultiplier
      : DEFAULT_GAS_RESERVE_SAFETY_MULTIPLIER;
  const clampedMult = Math.max(MIN_GAS_RESERVE_SAFETY_MULTIPLIER, Math.min(5.0, rawMult));
  const multiplierBps = BigInt(Math.ceil(clampedMult * 10_000));

  const executionGasWei = BigInt(safeTxCount) * perTxUnits * effectiveGasPriceWei;
  const l1DataFeePerTx =
    options.l1DataFeePerTxWei !== undefined
      ? options.l1DataFeePerTxWei > 0n
        ? options.l1DataFeePerTxWei
        : 0n
      : L2_ROLLUP_CHAINS.has(chain)
      ? DEFAULT_L2_DATA_FEE_PER_TX_WEI[chain] ?? 4_000_000_000_000n
      : 0n;
  const totalL1DataFeeWei = BigInt(safeTxCount) * l1DataFeePerTx;

  const totalBaseCostWei = executionGasWei + totalL1DataFeeWei;
  // Ceiling division: ceil(totalBaseCostWei * multiplierBps / 10_000)
  return (totalBaseCostWei * multiplierBps + 9_999n) / 10_000n;
}

export function computeDynamicGasReserveSummary(params: {
  chain: EvmChainId;
  liveGasPriceWei: bigint;
  plannedTxCount?: number;
  nativePriceUsd?: number;
  options?: DynamicGasReserveOptions;
}): {
  chain: EvmChainId;
  reserveWei: bigint;
  reserveNative: number;
  staticReserveWei: bigint;
  staticReserveNative: number;
  recoveredWei: bigint;
  recoveredNative: number;
  recoveredUsd: number;
  singleTxEstimatedWei: bigint;
  effectiveSafetyRatio: number;
} {
  const cfg = EVM_CHAINS[params.chain];
  const txCount = Math.max(1, Math.ceil(params.plannedTxCount ?? 1));
  const reserveWei = computeDynamicGasReserveWei(
    params.chain,
    params.liveGasPriceWei,
    txCount,
    params.options
  );
  const staticReserveWei = BigInt(Math.round(cfg.gasReserveNative * 1e9)) * 1_000_000_000n;
  const recoveredWei = staticReserveWei > reserveWei ? staticReserveWei - reserveWei : 0n;
  const reserveNative = Number(reserveWei) / 1e18;
  const recoveredNative = Number(recoveredWei) / 1e18;
  const nativePriceUsd = params.nativePriceUsd ?? 0;

  const effectiveGasPriceWei =
    params.liveGasPriceWei > 0n ? params.liveGasPriceWei : FALLBACK_GAS_PRICE_WEI[params.chain];
  const perTxUnits = BigInt(
    params.options?.perTxGasUnits ?? Math.max(cfg.swapGasUnits, cfg.bridgeGasUnits)
  );
  const l1PerTx = L2_ROLLUP_CHAINS.has(params.chain)
    ? DEFAULT_L2_DATA_FEE_PER_TX_WEI[params.chain] ?? 4_000_000_000_000n
    : 0n;
  const singleTxEstimatedWei = perTxUnits * effectiveGasPriceWei + l1PerTx;
  const effectiveSafetyRatio =
    singleTxEstimatedWei > 0n
      ? Number(((reserveWei * 1000n) / (singleTxEstimatedWei * BigInt(txCount)))) / 1000
      : 0;

  return {
    chain: params.chain,
    reserveWei,
    reserveNative: Number(reserveNative.toFixed(8)),
    staticReserveWei,
    staticReserveNative: cfg.gasReserveNative,
    recoveredWei,
    recoveredNative: Number(recoveredNative.toFixed(8)),
    recoveredUsd: r2(recoveredNative * nativePriceUsd),
    singleTxEstimatedWei,
    effectiveSafetyRatio,
  };
}

// =====================================================================
// TIMEOUT FETCH HELPER (3.5s ABORTCONTROLLER + INJECTABLE FETCHER)
// =====================================================================

async function fetchWithStrictTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetcher: RouteAuctionFetcher,
  parentSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }
}

// =====================================================================
// DIRECT QUOTE ADAPTER 1: MAYAN SWIFT (EVM -> Solana, ~3 bps)
// =====================================================================

interface MayanQuotePayload {
  type?: string;
  quoteId?: string;
  expectedAmountOut?: string | number;
  expectedAmountOutBaseUnits?: string | number;
  expectedAmountOutUsd?: string | number;
  minAmountOut?: string | number;
  minAmountOutBaseUnits?: string | number;
  minMiddleAmount?: string | number;
  effectiveAmountIn?: string | number;
  effectiveAmountIn64?: string;
  toTokenPrice?: number;
  toPrice?: number;
  price?: number;
  etaSeconds?: number;
  eta?: number;
  bridgeFee?: number | string;
  bridgeFeeUsd?: number | string;
  swapRelayerFee?: number | string;
  relayerFeeUsd?: number | string;
  clientRelayerFeeSuccess?: number | string | null;
  cancelRelayerFee64?: string | null;
  refundRelayerFee64?: string | null;
  deadline64?: string | null;
  referrerBps?: number;
  slippageBps?: number;
  gasDrop?: number;
  swiftVersion?: string;
  swiftMayanContract?: string;
  swiftInputContract?: string;
  swiftInputDecimals?: number;
  swiftAuctionMode?: number;
  swiftWrapAndLock?: boolean;
  fromToken?: { contract?: string; decimals?: number };
  toToken?: { contract?: string; decimals?: number; mint?: string };
  gasCostUsd?: number | string;
  estimatedGasUsd?: number | string;
  forwarderAddress?: string;
  approvalAddress?: string;
  to?: string;
  data?: string;
  calldata?: string;
  value?: string | number;
  gasLimit?: string | number;
  tx?: {
    from?: string;
    to?: string;
    data?: string;
    value?: string | number;
    gasLimit?: string | number;
    gas?: string | number;
    chainId?: number;
  };
  transactionRequest?: {
    from?: string;
    to?: string;
    data?: string;
    value?: string | number;
    gasLimit?: string | number;
    chainId?: number;
  };
  evmTx?: {
    from?: string;
    to?: string;
    data?: string;
    value?: string | number;
    gasLimit?: string | number;
    chainId?: number;
  };
}

// Verified keccak256 selectors from @mayanfinance/swap-sdk MayanSwiftV2 & MayanForwarder artifacts
const MAYAN_SWIFT_V2_CREATE_ORDER_WITH_TOKEN_SEL = 'a3a30834';
const MAYAN_FORWARDER_FORWARD_ERC20_SEL = 'e4269fc4';
const MAYAN_FORWARDER_SWAP_AND_FORWARD_ERC20_SEL = '30dedc57';
const MAYAN_FORWARDER_SWAP_AND_FORWARD_ETH_SEL = 'fa74fd43';

function abiPadUint(v: bigint | number): string {
  const n = typeof v === 'bigint' ? v : BigInt(Math.max(0, Math.trunc(v)));
  return (n < 0n ? 0n : n).toString(16).padStart(64, '0');
}

function abiPadAddr(addr: string): string {
  return addr.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
}

function abiPadBytes32(hex32: string): string {
  return hex32.replace(/^0x/i, '').toLowerCase().padStart(64, '0').slice(-64);
}

function abiEncodeBytesBody(hexData: string): string {
  const clean = hexData.replace(/^0x/i, '').toLowerCase();
  const byteLen = Math.floor(clean.length / 2);
  const paddedLen = Math.ceil(byteLen / 32) * 64;
  return abiPadUint(byteLen) + clean.slice(0, byteLen * 2).padEnd(paddedLen, '0');
}

function solanaPubkeyToHex32(base58OrZero: string): string {
  const trimmed = base58OrZero.trim();
  if (
    !trimmed ||
    trimmed === ZERO_ADDRESS ||
    trimmed === SOLANA_NATIVE_MINT
  ) {
    return '00'.repeat(32);
  }
  const pk = new PublicKey(trimmed);
  return Buffer.from(pk.toBytes()).toString('hex').padStart(64, '0');
}

function deriveMayanSwiftRandomHex32(quoteId?: string): string {
  if (quoteId) {
    const clean = quoteId.replace(/^0x/i, '').toLowerCase();
    if (/^[0-9a-f]+$/.test(clean) && clean.length > 0 && clean.length <= 64) {
      return clean.padStart(32, '0').slice(-32) + '00'.repeat(16);
    }
  }
  return crypto.randomBytes(32).toString('hex');
}

function encodeMayanSwiftV2CreateOrderWithToken(params: {
  tokenIn: string;
  amountIn: bigint;
  traderAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  minAmountOut: bigint;
  cancelFee: bigint;
  refundFee: bigint;
  deadline: bigint;
  referrerBps: number;
  auctionMode: number;
  quoteId?: string;
}): string {
  // createOrderWithToken(address tokenIn, uint256 amountIn, OrderParams params, bytes customPayload)
  // OrderParams has 14 static fields (14 * 32 = 448 bytes), so head is:
  //   word 0: tokenIn (address)
  //   word 1: amountIn (uint256)
  //   words 2..15: OrderParams inline tuple (14 static words)
  //   word 16: offset to customPayload bytes = 17 * 32 = 544 (0x220)
  //   word 17: customPayload length = 0
  const destAddrHex = solanaPubkeyToHex32(params.solanaDestination);
  const tokenOutHex =
    params.outputAsset === 'SOL'
      ? '00'.repeat(32)
      : solanaPubkeyToHex32(SOLANA_USDC_MINT);
  const randomHex = deriveMayanSwiftRandomHex32(params.quoteId);

  const headAndTuple = [
    abiPadAddr(params.tokenIn),
    abiPadUint(params.amountIn),
    // OrderParams (14 fields in exact MayanSwiftV2 ABI order):
    abiPadUint(1), // payloadType = 1 (DEFAULT)
    abiPadAddr(params.traderAddress), // trader (bytes32 left-padded EVM address)
    abiPadBytes32(destAddrHex), // destAddr (bytes32 Solana pubkey)
    abiPadUint(1), // destChainId = 1 (Solana Wormhole chain ID)
    '00'.repeat(32), // referrerAddr
    abiPadBytes32(tokenOutHex), // tokenOut (bytes32)
    abiPadUint(params.minAmountOut), // minAmountOut (uint64)
    abiPadUint(0n), // gasDrop (uint64)
    abiPadUint(params.cancelFee), // cancelFee (uint64)
    abiPadUint(params.refundFee), // refundFee (uint64)
    abiPadUint(params.deadline), // deadline (uint64)
    abiPadUint(params.referrerBps), // referrerBps (uint8)
    abiPadUint(params.auctionMode), // auctionMode (uint8)
    abiPadBytes32(randomHex), // random (bytes32)
    abiPadUint(17 * 32), // offset to customPayload (bytes)
    abiPadUint(0), // customPayload length = 0
  ];
  return `0x${MAYAN_SWIFT_V2_CREATE_ORDER_WITH_TOKEN_SEL}${headAndTuple.join('')}`;
}

function encodeMayanForwardErc20(params: {
  tokenIn: string;
  amountIn: bigint;
  mayanProtocol: string;
  protocolData: string;
}): string {
  // forwardERC20(address tokenIn, uint256 amountIn, PermitParams(5 static words), address mayanProtocol, bytes protocolData)
  // Head = 1 + 1 + 5 + 1 + 1 = 9 words (288 bytes)
  const head = [
    abiPadAddr(params.tokenIn),
    abiPadUint(params.amountIn),
    abiPadUint(0), // permit.value
    abiPadUint(0), // permit.deadline
    abiPadUint(0), // permit.v
    '00'.repeat(32), // permit.r
    '00'.repeat(32), // permit.s
    abiPadAddr(params.mayanProtocol),
    abiPadUint(9 * 32),
  ];
  return `0x${MAYAN_FORWARDER_FORWARD_ERC20_SEL}${head.join('')}${abiEncodeBytesBody(params.protocolData)}`;
}

function encodeMayanSwapAndForwardErc20(params: {
  tokenIn: string;
  amountIn: bigint;
  swapProtocol: string;
  swapData: string;
  middleToken: string;
  minMiddleAmount: bigint;
  mayanProtocol: string;
  mayanData: string;
}): string {
  // swapAndForwardERC20(address, uint256, PermitParams(5), address, bytes, address, uint256, address, bytes)
  // Head = 1 + 1 + 5 + 1 + 1(off swapData) + 1 + 1 + 1 + 1(off mayanData) = 13 words (416 bytes)
  const swapBody = abiEncodeBytesBody(params.swapData);
  const mayanBody = abiEncodeBytesBody(params.mayanData);
  const swapOffset = 13 * 32;
  const mayanOffset = swapOffset + swapBody.length / 2;
  const head = [
    abiPadAddr(params.tokenIn),
    abiPadUint(params.amountIn),
    abiPadUint(0), // permit.value
    abiPadUint(0), // permit.deadline
    abiPadUint(0), // permit.v
    '00'.repeat(32), // permit.r
    '00'.repeat(32), // permit.s
    abiPadAddr(params.swapProtocol),
    abiPadUint(swapOffset),
    abiPadAddr(params.middleToken),
    abiPadUint(params.minMiddleAmount),
    abiPadAddr(params.mayanProtocol),
    abiPadUint(mayanOffset),
  ];
  return `0x${MAYAN_FORWARDER_SWAP_AND_FORWARD_ERC20_SEL}${head.join('')}${swapBody}${mayanBody}`;
}

function encodeMayanSwapAndForwardEth(params: {
  amountIn: bigint;
  swapProtocol: string;
  swapData: string;
  middleToken: string;
  minMiddleAmount: bigint;
  mayanProtocol: string;
  mayanData: string;
}): string {
  // swapAndForwardEth(uint256, address, bytes, address, uint256, address, bytes)
  // Head = 7 words (224 bytes)
  const swapBody = abiEncodeBytesBody(params.swapData);
  const mayanBody = abiEncodeBytesBody(params.mayanData);
  const swapOffset = 7 * 32;
  const mayanOffset = swapOffset + swapBody.length / 2;
  const head = [
    abiPadUint(params.amountIn),
    abiPadAddr(params.swapProtocol),
    abiPadUint(swapOffset),
    abiPadAddr(params.middleToken),
    abiPadUint(params.minMiddleAmount),
    abiPadAddr(params.mayanProtocol),
    abiPadUint(mayanOffset),
  ];
  return `0x${MAYAN_FORWARDER_SWAP_AND_FORWARD_ETH_SEL}${head.join('')}${swapBody}${mayanBody}`;
}

export async function fetchMayanSwiftQuote(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  feeConfig: ProtocolFeeConfig;
  timeoutMs?: number;
  slippageBps?: number;
  fetcher?: RouteAuctionFetcher;
  allowanceCheckFn?: RouteAuctionAllowanceCheckFn;
  signal?: AbortSignal;
}): Promise<AuctionProviderQuote | null> {
  const {
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    feeConfig,
    timeoutMs = DEFAULT_AUCTION_TIMEOUT_MS,
    fetcher = globalThis.fetch.bind(globalThis),
    allowanceCheckFn = checkErc20Allowance,
    signal,
  } = params;

  const chain = asset.chain as EvmChainId;
  const cfg = EVM_CHAINS[chain];
  const mayanFromChain = MAYAN_CHAIN_SLUGS[chain];
  if (!cfg || !mayanFromChain) return null;

  const rawTotal = BigInt(asset.rawBalance);
  const { feeRaw, netRaw } = splitRawAmountForFee(rawTotal, feeConfig);
  const bridgeRaw = feeConfig.feeRecipientEvm ? netRaw : rawTotal;
  if (bridgeRaw <= 0n) return null;

  const slippageBps =
    params.slippageBps ??
    computeTierScaledSlippageBps({
      tradeUsd: asset.grossUsd,
      liquidityUsd: asset.liquidityUsd,
      symbol: asset.symbol,
    }).slippageBps;

  const fromToken = asset.address === 'native' ? ZERO_ADDRESS : asset.address;
  const toToken = outputAsset === 'SOL' ? ZERO_ADDRESS : SOLANA_USDC_MINT;
  const amountInUi = Number(bridgeRaw) / 10 ** asset.decimals;

  const url = new URL('https://price-api.mayan.finance/v3/quote');
  url.searchParams.set('amountIn64', bridgeRaw.toString());
  url.searchParams.set('amountIn', String(amountInUi));
  url.searchParams.set('fromToken', fromToken);
  url.searchParams.set('fromChain', mayanFromChain);
  url.searchParams.set('toToken', toToken);
  url.searchParams.set('toChain', 'solana');
  url.searchParams.set('slippageBps', String(slippageBps));
  url.searchParams.set('swift', 'true');
  url.searchParams.set('mctp', 'true');
  url.searchParams.set('fastMctp', 'true');
  url.searchParams.set('gasless', 'false');
  url.searchParams.set('solanaProgram', MAYAN_SOLANA_PROGRAM_ID);
  url.searchParams.set('forwarderAddress', MAYAN_FORWARDER_CONTRACT);
  url.searchParams.set('sdkVersion', MAYAN_SDK_VERSION);
  url.searchParams.set('fromAddress', userAddress);
  url.searchParams.set('destAddress', solanaDestination);
  url.searchParams.set('destinationAddress', solanaDestination);
  url.searchParams.set('swapperAddress', userAddress);
  url.searchParams.set('gasDrop', '0');

  const res = await fetchWithStrictTimeout(
    url.toString(),
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
    fetcher,
    signal
  );
  if (!res.ok) return null;

  const rawJson = (await res.json()) as
    | MayanQuotePayload
    | MayanQuotePayload[]
    | { quotes?: MayanQuotePayload[] };

  const candidatesList: MayanQuotePayload[] = Array.isArray(rawJson)
    ? rawJson
    : Array.isArray((rawJson as { quotes?: MayanQuotePayload[] })?.quotes)
    ? ((rawJson as { quotes?: MayanQuotePayload[] }).quotes ?? [])
    : rawJson && typeof rawJson === 'object'
    ? [rawJson as MayanQuotePayload]
    : [];

  if (!candidatesList.length) return null;

  // Prefer SWIFT quotes first, then highest finite expectedAmountOut
  const sorted = [...candidatesList].sort((a, b) => {
    const aSwift = (a.type ?? '').toUpperCase().includes('SWIFT') ? 1 : 0;
    const bSwift = (b.type ?? '').toUpperCase().includes('SWIFT') ? 1 : 0;
    if (aSwift !== bSwift) return bSwift - aSwift;
    const aOut = Number(a.expectedAmountOut ?? 0);
    const bOut = Number(b.expectedAmountOut ?? 0);
    const safeA = Number.isFinite(aOut) ? aOut : -Infinity;
    const safeB = Number.isFinite(bOut) ? bOut : -Infinity;
    return safeB - safeA;
  });

  const best = sorted[0];
  let txObj: {
    from?: string;
    to?: string;
    data?: string;
    value?: string | number;
    gasLimit?: string | number;
    gas?: string | number;
    chainId?: number;
  } = best.tx ?? best.transactionRequest ?? best.evmTx ?? {
    to: best.to ?? best.forwarderAddress,
    data: best.data ?? best.calldata,
    value: best.value,
    gasLimit: best.gasLimit,
  };

  // Live Mayan v3/quote returns Swift V2 order parameters without pre-encoded EVM calldata;
  // encode canonical MayanForwarder -> MayanSwiftV2.createOrderWithToken calldata locally!
  if (
    (!txObj?.data || !/^0x[0-9a-fA-F]{8,}$/.test(txObj.data)) &&
    String(best.type ?? '').toUpperCase() === 'SWIFT' &&
    best.swiftMayanContract &&
    /^0x[0-9a-fA-F]{40}$/.test(best.swiftMayanContract) &&
    best.swiftInputContract &&
    /^0x[0-9a-fA-F]{40}$/.test(best.swiftInputContract) &&
    best.deadline64 &&
    best.cancelRelayerFee64 &&
    best.refundRelayerFee64 &&
    best.swiftAuctionMode
  ) {
    const swiftInputContract = best.swiftInputContract;
    const swiftContractAddress = best.swiftMayanContract;
    const orderAmountIn = BigInt(best.effectiveAmountIn64 || bridgeRaw.toString());
    const toDecimals = best.toToken?.decimals ?? (outputAsset === 'SOL' ? 9 : 6);
    const normDecimals = Math.min(toDecimals, 8);
    let minAmountOutNorm: bigint;
    if (best.minAmountOutBaseUnits && /^\d+$/.test(String(best.minAmountOutBaseUnits))) {
      const rawMin = BigInt(best.minAmountOutBaseUnits);
      minAmountOutNorm =
        toDecimals > normDecimals
          ? rawMin / 10n ** BigInt(toDecimals - normDecimals)
          : rawMin;
    } else {
      const minUi = Number(best.minAmountOut ?? best.expectedAmountOut ?? 0);
      minAmountOutNorm = BigInt(Math.max(1, Math.floor(minUi * 10 ** normDecimals)));
    }

    const swiftCallData = encodeMayanSwiftV2CreateOrderWithToken({
      tokenIn: best.swiftWrapAndLock ? ZERO_ADDRESS : swiftInputContract,
      amountIn: orderAmountIn,
      traderAddress: userAddress,
      solanaDestination,
      outputAsset,
      minAmountOut: minAmountOutNorm,
      cancelFee: BigInt(best.cancelRelayerFee64),
      refundFee: BigInt(best.refundRelayerFee64),
      deadline: BigInt(best.deadline64),
      referrerBps: best.referrerBps ?? 0,
      auctionMode: best.swiftAuctionMode,
      quoteId: best.quoteId,
    });

    const quoteFromContract = (best.fromToken?.contract ?? fromToken).toLowerCase();
    if (quoteFromContract === swiftInputContract.toLowerCase() && quoteFromContract !== ZERO_ADDRESS) {
      txObj = {
        from: userAddress,
        to: MAYAN_FORWARDER_CONTRACT,
        data: encodeMayanForwardErc20({
          tokenIn: swiftInputContract,
          amountIn: orderAmountIn,
          mayanProtocol: swiftContractAddress,
          protocolData: swiftCallData,
        }),
        value: '0x0',
        chainId: cfg.chainId,
      };
    } else if (best.minMiddleAmount !== undefined) {
      // Non-direct token (e.g. ETH / WETH / alt ERC-20) -> fetch Mayan EVM pre-swap calldata
      const swapUrl = new URL('https://price-api.mayan.finance/v3/get-swap/evm');
      swapUrl.searchParams.set('forwarderAddress', MAYAN_FORWARDER_CONTRACT);
      swapUrl.searchParams.set('slippageBps', String(best.slippageBps ?? slippageBps));
      swapUrl.searchParams.set('fromToken', fromToken);
      swapUrl.searchParams.set('middleToken', swiftInputContract);
      swapUrl.searchParams.set('chainName', mayanFromChain);
      swapUrl.searchParams.set('amountIn64', orderAmountIn.toString());
      swapUrl.searchParams.set('userWallet', userAddress);
      swapUrl.searchParams.set('destinationWallet', solanaDestination);
      swapUrl.searchParams.set('sdkVersion', MAYAN_SDK_VERSION);

      const swapRes = await fetchWithStrictTimeout(
        swapUrl.toString(),
        { method: 'GET', headers: { Accept: 'application/json' } },
        Math.min(timeoutMs, 2500),
        fetcher,
        signal
      ).catch(() => null);
      if (!swapRes || !swapRes.ok) return null;
      const swapJson = (await swapRes.json().catch(() => null)) as {
        swapRouterAddress?: string;
        swapRouterCalldata?: string;
      } | null;
      if (
        !swapJson?.swapRouterAddress ||
        !/^0x[0-9a-fA-F]{40}$/.test(swapJson.swapRouterAddress) ||
        !swapJson.swapRouterCalldata ||
        !/^0x[0-9a-fA-F]{8,}$/.test(swapJson.swapRouterCalldata)
      ) {
        return null;
      }
      const midDecimals = best.swiftInputDecimals ?? 6;
      const minMiddleRaw = BigInt(
        Math.max(1, Math.floor(Number(best.minMiddleAmount) * 10 ** midDecimals))
      );
      if (fromToken.toLowerCase() === ZERO_ADDRESS) {
        txObj = {
          from: userAddress,
          to: MAYAN_FORWARDER_CONTRACT,
          data: encodeMayanSwapAndForwardEth({
            amountIn: orderAmountIn,
            swapProtocol: swapJson.swapRouterAddress,
            swapData: swapJson.swapRouterCalldata,
            middleToken: swiftInputContract,
            minMiddleAmount: minMiddleRaw,
            mayanProtocol: swiftContractAddress,
            mayanData: swiftCallData,
          }),
          value: toHexWei(orderAmountIn),
          chainId: cfg.chainId,
        };
      } else {
        txObj = {
          from: userAddress,
          to: MAYAN_FORWARDER_CONTRACT,
          data: encodeMayanSwapAndForwardErc20({
            tokenIn: fromToken,
            amountIn: orderAmountIn,
            swapProtocol: swapJson.swapRouterAddress,
            swapData: swapJson.swapRouterCalldata,
            middleToken: swiftInputContract,
            minMiddleAmount: minMiddleRaw,
            mayanProtocol: swiftContractAddress,
            mayanData: swiftCallData,
          }),
          value: '0x0',
          chainId: cfg.chainId,
        };
      }
    }
  }

  const tokenAddresses = [asset.address !== 'native' ? asset.address : undefined, cfg.usdcAddress];
  const targetCheck = validateRouterCallTarget({
    to: txObj?.to,
    data: txObj?.data,
    userAddress,
    tokenAddresses,
    requireCalldata: true,
  });
  if (!targetCheck.valid) {
    throw new Error(`Mayan Swift security validation failed: ${targetCheck.reason}`);
  }

  const txs: AuctionExecutableTx[] = [];
  let collectionMethod: 'relay_app_fee' | 'onchain_split' | 'none' = 'none';
  if (feeConfig.feeRecipientEvm && feeRaw > 0n) {
    const feeTx = buildProtocolFeeTx({ asset, chain, userAddress, feeRaw, feeConfig });
    if (feeTx) {
      txs.push(feeTx);
      collectionMethod = 'onchain_split';
    }
  }

  const approvalTarget = best.approvalAddress ?? best.forwarderAddress ?? txObj.to;
  if (asset.address !== 'native' && approvalTarget) {
    const approvalCheck = validateRouterCallTarget({
      to: approvalTarget,
      data: '0x00000000',
      userAddress,
      tokenAddresses,
      requireCalldata: false,
    });
    if (!approvalCheck.valid) {
      throw new Error(`Mayan Swift approval spender failed validation: ${approvalCheck.reason}`);
    }
    const allowance = await allowanceCheckFn({
      chain,
      tokenAddress: asset.address,
      owner: userAddress,
      spender: approvalTarget,
    }).catch(() => 0n);
    if (allowance < bridgeRaw) {
      txs.push({
        stepId: 'approve_mayan_swift',
        label: `Approve ${asset.symbol} for Mayan Swift`,
        description: `ERC-20 allowance for Mayan Swift forwarder (${approvalTarget})`,
        chain,
        chainId: cfg.chainId,
        chainName: cfg.name,
        explorerUrl: cfg.explorerUrl,
        from: userAddress,
        to: asset.address,
        data: encodeErc20Approve(approvalTarget, bridgeRaw),
        value: '0x0',
      });
    }
  }

  txs.push({
    stepId: 'bridge_mayan_swift',
    label: `Mayan Swift ${asset.symbol} → Solana ${outputAsset}`,
    description: `Direct Mayan Swift cross-chain auction order (${cfg.name} → Solana)`,
    chain,
    chainId: txObj.chainId ?? cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    from: txObj.from ?? userAddress,
    to: txObj.to!.trim(),
    data: txObj.data!.trim(),
    value: toHexWei(txObj.value ?? (asset.address === 'native' ? bridgeRaw : 0n)),
    gas: txObj.gasLimit
      ? toHexWei(txObj.gasLimit)
      : 'gas' in txObj && (typeof txObj.gas === 'string' || typeof txObj.gas === 'number')
      ? toHexWei(txObj.gas)
      : undefined,
  });

  const outUi = Number(best.expectedAmountOut ?? 0);
  if (!Number.isFinite(outUi) || outUi <= 0) return null;

  const quotedOutUsd =
    Number(best.expectedAmountOutUsd) ||
    (outputAsset === 'USDC'
      ? outUi
      : Number(best.toTokenPrice ?? best.price ?? 0) > 0
      ? outUi * Number(best.toTokenPrice ?? best.price)
      : 0);
  if (!Number.isFinite(quotedOutUsd) || quotedOutUsd <= 0) return null;

  const gasUsd = Number(best.gasCostUsd ?? best.estimatedGasUsd ?? asset.batchedGasUsd ?? asset.estimatedGasUsd ?? 0);
  const bridgeFeeUsd = Number(best.bridgeFeeUsd ?? best.relayerFeeUsd ?? best.bridgeFee ?? 0);
  const estFeeUsd = r2((asset.grossUsd * feeConfig.feeBps) / 10_000);
  const rawEta = Number(best.etaSeconds ?? best.eta ?? 14);
  const etaSeconds = Number.isFinite(rawEta) ? Math.max(4, Math.round(rawEta)) : 14;

  return {
    provider: 'mayan_swift',
    label: 'Mayan Swift',
    requestId: best.quoteId,
    estimatedOutput: `${outUi.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${outputAsset}`,
    estimatedSeconds: etaSeconds,
    quotedOutUsd: r2(quotedOutUsd),
    estimatedGasUsd: Number.isFinite(gasUsd) ? r4(Math.max(0, gasUsd)) : 0,
    bridgeFeeUsd: Number.isFinite(bridgeFeeUsd) ? r4(Math.max(0, bridgeFeeUsd)) : 0,
    extraBridgeFeeUsd: 0, // Mayan expectedAmountOut is already net of Swift auction & relayer fees
    sponsorsSolanaAta: true, // Mayan Swift solver creates destination USDC ATA on fill
    estimatedFeeUsd: estFeeUsd,
    collectionMethod,
    transactions: txs,
    notes: [
      `Direct Mayan Swift quote (~3 bps solver auction) settling directly into ${solanaDestination.slice(0, 6)}…${solanaDestination.slice(-4)} on Solana.`,
      feeConfig.feeRecipientEvm
        ? `Protocol fee ${feeConfig.feePercent}% routed atomically onchain to ${feeConfig.feeRecipientEvm}.`
        : `Protocol fee ${feeConfig.feePercent}% modeled (configure treasury address to split onchain).`,
    ],
  };
}

// =====================================================================
// DIRECT QUOTE ADAPTER 2: DEBRIDGE DLN (EVM -> Solana executable calldata)
// =====================================================================

interface DeBridgeDlnResponse {
  orderId?: string;
  fixFee?: string;
  estimation?: {
    srcChainTokenIn?: {
      approximateUsdValue?: number;
      approximateOperatingExpense?: string;
    };
    dstChainTokenOut?: {
      amount?: string;
      recommendedAmount?: string;
      decimals?: number;
      symbol?: string;
      approximateUsdValue?: number;
    };
    costsDetails?: Array<{
      type?: string;
      payload?: {
        feeApproximateUsdValue?: string | number;
      };
    }>;
  };
  tx?: {
    to?: string;
    data?: string;
    value?: string | number;
    gasLimit?: string | number;
    approvalAddress?: string;
  };
  order?: {
    approximateFulfillmentDelay?: number;
  };
}

export async function fetchDeBridgeDlnQuote(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  feeConfig: ProtocolFeeConfig;
  timeoutMs?: number;
  slippageBps?: number;
  fetcher?: RouteAuctionFetcher;
  allowanceCheckFn?: RouteAuctionAllowanceCheckFn;
  signal?: AbortSignal;
}): Promise<AuctionProviderQuote | null> {
  const {
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    feeConfig,
    timeoutMs = DEFAULT_AUCTION_TIMEOUT_MS,
    fetcher = globalThis.fetch.bind(globalThis),
    allowanceCheckFn = checkErc20Allowance,
    signal,
  } = params;

  const chain = asset.chain as EvmChainId;
  const cfg = EVM_CHAINS[chain];
  if (!cfg || !DEBRIDGE_SUPPORTED_CHAINS.has(chain)) return null;

  const rawTotal = BigInt(asset.rawBalance);
  const { feeRaw, netRaw } = splitRawAmountForFee(rawTotal, feeConfig);
  const bridgeRaw = feeConfig.feeRecipientEvm ? netRaw : rawTotal;
  if (bridgeRaw <= 0n) return null;

  const srcToken = asset.address === 'native' ? ZERO_ADDRESS : asset.address;
  const dstToken = outputAsset === 'SOL' ? SOLANA_NATIVE_MINT : SOLANA_USDC_MINT;

  const url = new URL('https://dln.debridge.finance/v1.0/dln/order/create-tx');
  const debridgeSrcChainId = DEBRIDGE_CHAIN_ID_OVERRIDE[chain] ?? cfg.chainId;
  url.searchParams.set('srcChainId', String(debridgeSrcChainId));
  url.searchParams.set('srcChainTokenIn', srcToken);
  url.searchParams.set('srcChainTokenInAmount', bridgeRaw.toString());
  url.searchParams.set('dstChainId', String(DEBRIDGE_SOLANA_CHAIN_ID));
  url.searchParams.set('dstChainTokenOut', dstToken);
  url.searchParams.set('dstChainTokenOutAmount', 'auto');
  url.searchParams.set('dstChainTokenOutRecipient', solanaDestination);
  url.searchParams.set('srcChainOrderAuthorityAddress', userAddress);
  url.searchParams.set('dstChainOrderAuthorityAddress', solanaDestination);
  url.searchParams.set('prependOperatingExpenses', 'true');

  const res = await fetchWithStrictTimeout(
    url.toString(),
    { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs,
    fetcher,
    signal
  );
  if (!res.ok) return null;

  const json = (await res.json()) as DeBridgeDlnResponse;
  const txObj = json.tx;
  const tokenAddresses = [asset.address !== 'native' ? asset.address : undefined, cfg.usdcAddress];

  const targetCheck = validateRouterCallTarget({
    to: txObj?.to,
    data: txObj?.data,
    userAddress,
    tokenAddresses,
    requireCalldata: true,
  });
  if (!targetCheck.valid) {
    throw new Error(`deBridge DLN security validation failed: ${targetCheck.reason}`);
  }

  const txs: AuctionExecutableTx[] = [];
  let collectionMethod: 'relay_app_fee' | 'onchain_split' | 'none' = 'none';
  if (feeConfig.feeRecipientEvm && feeRaw > 0n) {
    const feeTx = buildProtocolFeeTx({ asset, chain, userAddress, feeRaw, feeConfig });
    if (feeTx) {
      txs.push(feeTx);
      collectionMethod = 'onchain_split';
    }
  }

  const approvalTarget = txObj?.approvalAddress ?? txObj?.to;
  if (asset.address !== 'native' && approvalTarget) {
    const approvalCheck = validateRouterCallTarget({
      to: approvalTarget,
      data: '0x00000000',
      userAddress,
      tokenAddresses,
      requireCalldata: false,
    });
    if (!approvalCheck.valid) {
      throw new Error(`deBridge DLN approval spender failed validation: ${approvalCheck.reason}`);
    }
    const allowance = await allowanceCheckFn({
      chain,
      tokenAddress: asset.address,
      owner: userAddress,
      spender: approvalTarget,
    }).catch(() => 0n);
    if (allowance < bridgeRaw) {
      txs.push({
        stepId: 'approve_debridge_dln',
        label: `Approve ${asset.symbol} for deBridge DLN`,
        description: `ERC-20 allowance for deBridge DLN source contract (${approvalTarget})`,
        chain,
        chainId: cfg.chainId,
        chainName: cfg.name,
        explorerUrl: cfg.explorerUrl,
        from: userAddress,
        to: asset.address,
        data: encodeErc20Approve(approvalTarget, bridgeRaw),
        value: '0x0',
      });
    }
  }

  txs.push({
    stepId: 'bridge_debridge_dln',
    label: `deBridge DLN ${asset.symbol} → Solana ${outputAsset}`,
    description: `Direct deBridge DLN order creation (${cfg.name} → Solana)`,
    chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    from: userAddress,
    to: txObj!.to!.trim(),
    data: txObj!.data!.trim(),
    value: toHexWei(txObj!.value ?? json.fixFee ?? '0'),
    gas: txObj!.gasLimit ? toHexWei(txObj!.gasLimit) : undefined,
  });

  const dstOut = json.estimation?.dstChainTokenOut;
  const outDecimals = dstOut?.decimals ?? (outputAsset === 'SOL' ? 9 : 6);
  const outRawStr = dstOut?.recommendedAmount ?? dstOut?.amount ?? '0';
  if (!/^\d+$/.test(outRawStr) || BigInt(outRawStr) <= 0n) return null;

  const outUi = Number(BigInt(outRawStr)) / 10 ** outDecimals;
  const quotedOutUsd =
    Number(dstOut?.approximateUsdValue) || (outputAsset === 'USDC' ? outUi : 0);
  if (!Number.isFinite(quotedOutUsd) || quotedOutUsd <= 0) return null;

  // Sum protocol fixed fee USD from costsDetails (DLN native fixFee is paid via msg.value on source EVM chain)
  let dlnFixFeeUsd = 0;
  let totalCostsUsd = 0;
  for (const item of json.estimation?.costsDetails ?? []) {
    const val = Number(item.payload?.feeApproximateUsdValue ?? 0);
    if (!Number.isFinite(val) || val <= 0) continue;
    totalCostsUsd += val;
    if ((item.type ?? '').toLowerCase().includes('protocol') || (item.type ?? '').toLowerCase().includes('fix')) {
      dlnFixFeeUsd += val;
    }
  }

  const gasUsd = Number(asset.batchedGasUsd || asset.estimatedGasUsd || 0);
  const estFeeUsd = r2((asset.grossUsd * feeConfig.feeBps) / 10_000);
  const rawEta = Number(json.order?.approximateFulfillmentDelay ?? 15);
  const etaSeconds = Number.isFinite(rawEta) ? Math.max(4, Math.round(rawEta)) : 15;

  return {
    provider: 'debridge_dln',
    label: 'deBridge DLN',
    requestId: json.orderId,
    estimatedOutput: `${outUi.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${outputAsset}`,
    estimatedSeconds: etaSeconds,
    quotedOutUsd: r2(quotedOutUsd),
    estimatedGasUsd: Number.isFinite(gasUsd) ? r4(Math.max(0, gasUsd)) : 0,
    bridgeFeeUsd: r4(totalCostsUsd),
    // Native fixFee is paid by sender in msg.value in addition to dstChainTokenOut output
    extraBridgeFeeUsd: r4(dlnFixFeeUsd),
    sponsorsSolanaAta: true,
    estimatedFeeUsd: estFeeUsd,
    collectionMethod,
    transactions: txs,
    notes: [
      `Direct deBridge DLN cross-chain order settling into ${solanaDestination.slice(0, 6)}…${solanaDestination.slice(-4)} on Solana.`,
      feeConfig.feeRecipientEvm
        ? `Protocol fee ${feeConfig.feePercent}% routed atomically onchain to ${feeConfig.feeRecipientEvm}.`
        : `Protocol fee ${feeConfig.feePercent}% modeled (configure treasury address to split onchain).`,
    ],
  };
}

// =====================================================================
// LIVE PARALLEL ROUTE AUCTION ENGINE (Promise.allSettled + 3.5s BUDGET)
// =====================================================================

class AuctionTimeoutError extends Error {
  constructor(provider: AuctionBridgeProvider, timeoutMs: number) {
    super(`${PROVIDER_LABELS[provider]} timed out after ${timeoutMs}ms`);
    this.name = 'AuctionTimeoutError';
  }
}

async function runWithHardTimeout<T>(
  provider: AuctionBridgeProvider,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<{ value: T; latencyMs: number }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AuctionTimeoutError(provider, timeoutMs));
      }, timeoutMs);
    });

    const value = await Promise.race([fn(controller.signal), timeoutPromise]);
    return { value, latencyMs: Math.max(0, Date.now() - startedAt) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RunLiveParallelRouteAuctionParams {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  feeConfig: ProtocolFeeConfig;
  timeoutMs?: number;
  allowHighCost?: boolean;
  hasSolanaUsdcAta?: boolean;
  solPriceUsd?: number;
  slippageBps?: number;
  fetcher?: RouteAuctionFetcher;
  allowanceCheckFn?: RouteAuctionAllowanceCheckFn;
  /**
   * Provider runners keyed by provider name.
   * Defaults to Mayan Swift + deBridge DLN built-in adapters; tx-builder supplies Relay, LI.FI & Circle CCTP.
   */
  providers?: Partial<Record<AuctionBridgeProvider, AuctionProviderFn>>;
}

/**
 * Races Relay, Mayan Swift, deBridge DLN, LI.FI, and Circle CCTP (for native USDC) concurrently
 * via `Promise.allSettled` under a strict per-provider & auction timeout budget (default 3.5s).
 *
 * Security & Ranking Invariants:
 *  1. Every candidate's router targets & hex calldata are validated fail-closed before ranking.
 *  2. Every candidate is passed through `evaluateLiveQuoteHaircut` (net of gas, extra bridge fee,
 *     slippage, and Solana ATA rent) — quotes with >50% haircut or negative net are rejected.
 *  3. Passing candidates are ranked strictly by highest `liveNetUsd` (ties broken by lowest `etaSeconds`).
 *  4. Timed-out or failing providers degrade gracefully without blocking the auction.
 */
export async function runLiveParallelRouteAuction(
  params: RunLiveParallelRouteAuctionParams
): Promise<RouteAuctionResult> {
  const {
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    feeConfig,
    timeoutMs = DEFAULT_AUCTION_TIMEOUT_MS,
    allowHighCost = false,
    hasSolanaUsdcAta = true,
    solPriceUsd = DEFAULT_SOL_PRICE_USD,
    fetcher = globalThis.fetch.bind(globalThis),
    allowanceCheckFn = checkErc20Allowance,
    providers = {},
  } = params;

  const auctionStartMs = Date.now();
  const chain = asset.chain as EvmChainId;
  const cfg = EVM_CHAINS[chain];
  if (!cfg) {
    throw new Error(`Unsupported EVM chain for route auction: ${asset.chain}`);
  }

  const slippagePlan = computeTierScaledSlippageBps({
    tradeUsd: asset.grossUsd,
    liquidityUsd: asset.liquidityUsd,
    symbol: asset.symbol,
    overrideBps: params.slippageBps,
  });

  const isNativeUsdc =
    asset.address !== 'native' &&
    asset.address.toLowerCase() === cfg.usdcAddress.toLowerCase();
  const hasNativeCctp = Boolean(cfg.cctpTokenMessenger && cfg.cctpDomain !== null);

  const ataRentUsdBase =
    !hasSolanaUsdcAta && outputAsset === 'USDC'
      ? r2(SOLANA_USDC_ATA_RENT_SOL * solPriceUsd)
      : 0;

  const providerRunners: Array<{ provider: AuctionBridgeProvider; run: AuctionProviderFn }> = [];

  if (providers.relay) {
    providerRunners.push({ provider: 'relay', run: providers.relay });
  }

  if (providers.mayan_swift) {
    providerRunners.push({ provider: 'mayan_swift', run: providers.mayan_swift });
  } else if (MAYAN_CHAIN_SLUGS[chain]) {
    providerRunners.push({
      provider: 'mayan_swift',
      run: ({ signal, timeoutMs: tMs, slippageBps }) =>
        fetchMayanSwiftQuote({
          asset,
          userAddress,
          solanaDestination,
          outputAsset,
          feeConfig,
          timeoutMs: tMs,
          slippageBps,
          fetcher,
          allowanceCheckFn,
          signal,
        }),
    });
  }

  if (providers.debridge_dln) {
    providerRunners.push({ provider: 'debridge_dln', run: providers.debridge_dln });
  } else if (DEBRIDGE_SUPPORTED_CHAINS.has(chain)) {
    providerRunners.push({
      provider: 'debridge_dln',
      run: ({ signal, timeoutMs: tMs, slippageBps }) =>
        fetchDeBridgeDlnQuote({
          asset,
          userAddress,
          solanaDestination,
          outputAsset,
          feeConfig,
          timeoutMs: tMs,
          slippageBps,
          fetcher,
          allowanceCheckFn,
          signal,
        }),
    });
  }

  if (providers.lifi) {
    providerRunners.push({ provider: 'lifi', run: providers.lifi });
  }

  if (providers.circle_cctp && isNativeUsdc && hasNativeCctp && outputAsset === 'USDC') {
    providerRunners.push({ provider: 'circle_cctp', run: providers.circle_cctp });
  }

  const providersQueried = providerRunners.map((p) => p.provider);

  const settled = await Promise.allSettled(
    providerRunners.map(async ({ provider, run }) => {
      const result = await runWithHardTimeout(provider, timeoutMs, (signal) =>
        run({ signal, timeoutMs, slippageBps: slippagePlan.slippageBps })
      );
      return { provider, quote: result.value, latencyMs: result.latencyMs };
    })
  );

  const candidateSummaries: RouteAuctionCandidateSummary[] = [];
  const validWinners: Array<{
    summary: RouteAuctionCandidateSummary;
    quote: AuctionProviderQuote;
  }> = [];

  for (let i = 0; i < settled.length; i += 1) {
    const provider = providerRunners[i].provider;
    const outcome = settled[i];

    if (outcome.status === 'rejected') {
      const err = outcome.reason;
      const isTimeout =
        err instanceof AuctionTimeoutError ||
        (err instanceof Error && (err.name === 'AbortError' || /timeout|aborted/i.test(err.message)));
      const isSecurity = err instanceof Error && /security|blocked|spoof|validation/i.test(err.message);
      candidateSummaries.push({
        provider,
        label: PROVIDER_LABELS[provider],
        status: isSecurity ? 'rejected_security' : isTimeout ? 'timeout' : 'error',
        quotedOutUsd: 0,
        gasUsd: 0,
        bridgeFeeUsd: 0,
        slippageUsd: 0,
        ataRentUsd: 0,
        netUsd: 0,
        liveNetUsd: 0,
        liveHaircutPct: 100,
        etaSeconds: 0,
        latencyMs: Math.max(0, Date.now() - auctionStartMs),
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const { quote, latencyMs } = outcome.value;
    if (!quote) {
      candidateSummaries.push({
        provider,
        label: PROVIDER_LABELS[provider],
        status: 'ineligible',
        quotedOutUsd: 0,
        gasUsd: 0,
        bridgeFeeUsd: 0,
        slippageUsd: 0,
        ataRentUsd: 0,
        netUsd: 0,
        liveNetUsd: 0,
        liveHaircutPct: 100,
        etaSeconds: 0,
        latencyMs,
        reason: 'Provider returned no executable route.',
      });
      continue;
    }

    // 1. Fail-closed router target & calldata validation
    const txValidation = validateQuoteTransactions({
      transactions: quote.transactions,
      asset,
      chain,
      userAddress,
      feeRecipientEvm: feeConfig.feeRecipientEvm,
    });
    if (!txValidation.valid) {
      candidateSummaries.push({
        provider,
        label: quote.label || PROVIDER_LABELS[provider],
        status: 'rejected_security',
        quotedOutUsd: r2(quote.quotedOutUsd),
        gasUsd: r4(quote.estimatedGasUsd),
        bridgeFeeUsd: r4(quote.bridgeFeeUsd ?? quote.extraBridgeFeeUsd ?? 0),
        slippageUsd: r4(quote.slippageUsd ?? quote.extraSlippageUsd ?? 0),
        ataRentUsd: 0,
        netUsd: 0,
        liveNetUsd: 0,
        liveHaircutPct: 100,
        etaSeconds: Number.isFinite(quote.estimatedSeconds)
          ? Math.max(1, Math.round(quote.estimatedSeconds))
          : 15,
        latencyMs,
        requestId: quote.requestId,
        reason: txValidation.reason,
      });
      continue;
    }

    // 2. Exact net output calculation + Live Quote Haircut Gate
    const gasUsd = Number.isFinite(quote.estimatedGasUsd) ? Math.max(0, quote.estimatedGasUsd) : 0;
    const extraBridgeFeeUsd =
      typeof quote.extraBridgeFeeUsd === 'number' && Number.isFinite(quote.extraBridgeFeeUsd)
        ? Math.max(0, quote.extraBridgeFeeUsd)
        : 0;
    const extraSlippageUsd =
      typeof quote.extraSlippageUsd === 'number' && Number.isFinite(quote.extraSlippageUsd)
        ? Math.max(0, quote.extraSlippageUsd)
        : 0;
    const ataRentUsd = quote.sponsorsSolanaAta ? 0 : ataRentUsdBase;
    const totalDeductionsUsd = gasUsd + extraBridgeFeeUsd + extraSlippageUsd + ataRentUsd;

    const haircut = evaluateLiveQuoteHaircut({
      grossUsd: asset.grossUsd,
      quoteOutUsd: quote.quotedOutUsd,
      actualGasUsd: totalDeductionsUsd,
      allowHighCost,
    });

    const summary: RouteAuctionCandidateSummary = {
      provider,
      label: quote.label || PROVIDER_LABELS[provider],
      status: haircut.passed ? 'ok' : 'rejected_haircut',
      quotedOutUsd: haircut.quoteOutUsd,
      gasUsd: r4(gasUsd),
      bridgeFeeUsd: r4(quote.bridgeFeeUsd ?? extraBridgeFeeUsd),
      slippageUsd: r4(quote.slippageUsd ?? extraSlippageUsd),
      ataRentUsd: r4(ataRentUsd),
      netUsd: haircut.liveNetUsd,
      liveNetUsd: haircut.liveNetUsd,
      liveHaircutPct: haircut.liveHaircutPct,
      etaSeconds: Number.isFinite(quote.estimatedSeconds)
        ? Math.max(1, Math.round(quote.estimatedSeconds))
        : 15,
      latencyMs,
      requestId: quote.requestId,
      reason: haircut.passed ? undefined : haircut.reason,
    };

    candidateSummaries.push(summary);
    if (haircut.passed) {
      validWinners.push({ summary, quote });
    }
  }

  // Sort strictly by highest liveNetUsd, then lowest etaSeconds, then deterministic tie-breaker
  validWinners.sort((a, b) => {
    const netDiff = b.summary.liveNetUsd - a.summary.liveNetUsd;
    if (Math.abs(netDiff) > 0.005) return netDiff;
    if (a.summary.etaSeconds !== b.summary.etaSeconds) {
      return a.summary.etaSeconds - b.summary.etaSeconds;
    }
    return PROVIDER_TIE_BREAK_ORDER[a.summary.provider] - PROVIDER_TIE_BREAK_ORDER[b.summary.provider];
  });

  // Sort candidateSummaries so passing candidates appear first (best-to-worst), then rejected/timed-out
  const sortedCandidates = [...candidateSummaries].sort((a, b) => {
    if (a.status === 'ok' && b.status !== 'ok') return -1;
    if (a.status !== 'ok' && b.status === 'ok') return 1;
    if (a.status === 'ok' && b.status === 'ok') {
      const netDiff = b.liveNetUsd - a.liveNetUsd;
      if (Math.abs(netDiff) > 0.005) return netDiff;
      return a.etaSeconds - b.etaSeconds;
    }
    return PROVIDER_TIE_BREAK_ORDER[a.provider] - PROVIDER_TIE_BREAK_ORDER[b.provider];
  });

  const totalAuctionDurationMs = Math.max(0, Date.now() - auctionStartMs);

  if (validWinners.length === 0) {
    const securityRejected = sortedCandidates.filter((c) => c.status === 'rejected_security');
    const haircutRejected = sortedCandidates.filter((c) => c.status === 'rejected_haircut');
    const timedOut = sortedCandidates.filter((c) => c.status === 'timeout');

    if (haircutRejected.length > 0 && securityRejected.length === 0) {
      throw new Error(
        `All live bridge quotes for ${asset.symbol} on ${cfg.name} were rejected by the Live Quote Haircut Gate (${haircutRejected[0].reason}).`
      );
    }
    if (securityRejected.length > 0 && timedOut.length === 0 && haircutRejected.length === 0) {
      throw new Error(
        `All live bridge quotes for ${asset.symbol} on ${cfg.name} failed fail-closed router security validation (${securityRejected[0].reason}).`
      );
    }
    if (timedOut.length > 0 && timedOut.length === sortedCandidates.length) {
      throw new Error(
        `Quote providers were rate-limited or timed out for ${asset.symbol} on ${cfg.name} (${timeoutMs}ms budget). Retry shortly.`
      );
    }
    const detail = sortedCandidates
      .map((c) => `${c.provider}:${c.status}`)
      .join(', ');
    throw new Error(
      `No safe live bridge route found for ${asset.symbol} on ${cfg.name} (auction results: ${detail || 'none'}).`
    );
  }

  const best = validWinners[0];
  const runnerUp = validWinners[1];
  const dollarsSavedOverRunnerUp = runnerUp
    ? r2(Math.max(0, best.summary.liveNetUsd - runnerUp.summary.liveNetUsd))
    : 0;
  const bpsSavedOverRunnerUp =
    runnerUp && asset.grossUsd > 0
      ? Math.round((dollarsSavedOverRunnerUp / asset.grossUsd) * 10_000)
      : 0;

  const routeAuction: RouteAuctionMetadata = {
    winnerProvider: best.summary.provider,
    winnerNetUsd: best.summary.liveNetUsd,
    runnerUpProvider: runnerUp?.summary.provider,
    runnerUpNetUsd: runnerUp?.summary.liveNetUsd,
    dollarsSavedOverRunnerUp,
    bpsSavedOverRunnerUp,
    totalAuctionDurationMs,
    providersQueried,
    providersSucceeded: validWinners.length,
    candidates: sortedCandidates,
  };

  return {
    winner: {
      ...best.quote,
      liveNetUsd: best.summary.liveNetUsd,
      liveHaircutPct: best.summary.liveHaircutPct,
      ataRentUsd: best.summary.ataRentUsd,
    },
    routeAuction,
  };
}
