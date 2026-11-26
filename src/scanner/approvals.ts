import { CCTP_V2_TOKEN_MESSENGER, EVM_CHAINS, TOKEN_REGISTRY } from './chains.js';
import {
  decodeMulticall3Aggregate3,
  encodeMulticall3Aggregate3,
  evmJsonRpcCall,
  formatUnits,
  isValidEvmAddress,
} from './rpc.js';
import type { EvmChainId } from './types.js';

export const ALLOWANCE_SELECTOR = 'dd62ed3e'; // allowance(address,address)
export const APPROVE_SELECTOR = '095ea7b3'; // approve(address,uint256)
export const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';
export const UNLIMITED_ALLOWANCE_THRESHOLD = 1n << 255n; // >= 2^255 treated as unlimited
export const MAX_UINT256 = (1n << 256n) - 1n;

export type SpenderCategory = 'dex_router' | 'bridge' | 'defi_lending' | 'permit2' | 'legacy_high_risk' | 'custom';
export type SpenderRiskLevel = 'high' | 'medium' | 'low';
export type ApprovalSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface KnownApprovalSpender {
  address: string;
  label: string;
  protocol: string;
  category: SpenderCategory;
  riskLevel: SpenderRiskLevel;
  deprecated?: boolean;
  note?: string;
}

export interface ApprovalTokenInput {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
}

export interface ApprovalSpenderInput {
  address: string;
  label?: string;
  protocol?: string;
  category?: SpenderCategory;
  riskLevel?: SpenderRiskLevel;
  deprecated?: boolean;
  note?: string;
}

/**
 * Matches Solidity `SiphonSweepDelegate.ApprovalRevoke { address token; address spender; }`
 * while also carrying ready-to-sign ERC-20 `approve(spender, 0)` transaction calldata.
 */
export interface ApprovalRevoke {
  token: string;
  spender: string;
  to: string;
  data: string;
  value: '0x0';
  chainId: number;
  tokenSymbol: string;
  spenderLabel: string;
  isUnlimited: boolean;
  severity: ApprovalSeverity;
}

export interface StaleApprovalFinding {
  chain: EvmChainId;
  chainId: number;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  spender: string;
  spenderLabel: string;
  spenderProtocol: string;
  spenderCategory: SpenderCategory;
  spenderRiskLevel: SpenderRiskLevel;
  allowanceRaw: string;
  allowanceFormatted: string;
  isUnlimited: boolean;
  isMaxUint256: boolean;
  severity: ApprovalSeverity;
  riskReason: string;
  revokeCall: {
    to: string;
    data: string;
    value: '0x0';
    chainId: number;
    label: string;
  };
}

export type ApprovalRpcCallFn = (
  rpcUrls: string[],
  method: string,
  params: unknown[],
  timeoutMs?: number
) => Promise<{ result?: string; error?: { message?: string; code?: number } }>;

export interface ScanApprovalsOptions {
  /** Merge built-in known spenders when explicit `spenders` are supplied (default: false when explicit spenders passed) */
  includeKnownSpenders?: boolean;
  /** Return only unlimited (`>= 2^255`) approvals */
  unlimitedOnly?: boolean;
  /** Multicall3 chunk size (default: 80, clamped 1..200) */
  multicallChunkSize?: number;
  /** RPC call timeout in ms (default: 4500) */
  timeoutMs?: number;
  /** Dependency injection hook for deterministic offline tests / custom RPC transports */
  rpcCall?: ApprovalRpcCallFn;
}

export interface StaleApprovalScanResult {
  chain: EvmChainId;
  chainName: string;
  chainId: number;
  walletAddress: string;
  multicall3: string;
  tokensScanned: number;
  spendersScanned: number;
  scannedPairs: number;
  failedPairs: number;
  activeApprovalsCount: number;
  unlimitedCount: number;
  highRiskCount: number;
  findings: StaleApprovalFinding[];
  revokes: ApprovalRevoke[];
  warnings: string[];
  scannedAt: string;
}

function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function pad32(hex: string): string {
  return strip0x(hex).toLowerCase().padStart(64, '0');
}

function assertNonZeroEvmAddress(addr: string, label: string): string {
  const clean = String(addr ?? '').trim();
  if (!isValidEvmAddress(clean) || clean.toLowerCase() === ZERO_EVM_ADDRESS) {
    throw new Error(`Invalid ${label}: expected non-zero 20-byte EVM address.`);
  }
  return clean;
}

/**
 * Encodes `IERC20.allowance(address owner, address spender)` (`0xdd62ed3e`).
 */
export function encodeErc20AllowanceCalldata(owner: string, spender: string): string {
  const validOwner = assertNonZeroEvmAddress(owner, 'owner address');
  const validSpender = assertNonZeroEvmAddress(spender, 'spender address');
  return '0x' + ALLOWANCE_SELECTOR + pad32(validOwner) + pad32(validSpender);
}

/**
 * Encodes `IERC20.approve(address spender, uint256 0)` (`0x095ea7b3`) revoke calldata.
 */
export function encodeErc20RevokeCalldata(spender: string): string {
  const validSpender = assertNonZeroEvmAddress(spender, 'spender address');
  return '0x' + APPROVE_SELECTOR + pad32(validSpender) + '0'.repeat(64);
}

/**
 * Decodes `IERC20.approve(address spender, uint256 amount)` calldata for verification & testing.
 */
export function decodeErc20ApproveCalldata(calldata: string): {
  selector: string;
  spender: string;
  amount: bigint;
  isRevoke: boolean;
} | null {
  if (typeof calldata !== 'string') return null;
  const raw = strip0x(calldata.trim()).toLowerCase();
  if (raw.length !== 8 + 64 + 64 || !/^[0-9a-f]+$/.test(raw)) return null;
  const selector = raw.slice(0, 8);
  if (selector !== APPROVE_SELECTOR) return null;
  const spenderWord = raw.slice(8, 72);
  if (!spenderWord.startsWith('0'.repeat(24))) return null;
  const spender = '0x' + spenderWord.slice(24);
  const amount = BigInt('0x' + raw.slice(72, 136));
  return {
    selector: '0x' + selector,
    spender,
    amount,
    isRevoke: amount === 0n,
  };
}

/**
 * Universal CREATE2 spenders deployed at identical addresses across major EVM chains.
 */
const UNIVERSAL_KNOWN_SPENDERS: readonly KnownApprovalSpender[] = [
  {
    address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    label: 'Uniswap Permit2',
    protocol: 'Uniswap',
    category: 'permit2',
    riskLevel: 'medium',
    note: 'Universal Permit2 allowance hub — revoke if unused to eliminate signature-based spender surface.',
  },
  {
    address: '0x1111111254EEB25477B68fb85Ed929f73A960582',
    label: '1inch Aggregation Router v5 (Legacy)',
    protocol: '1inch',
    category: 'legacy_high_risk',
    riskLevel: 'high',
    deprecated: true,
    note: 'Legacy aggregator router superseded by v6 — lingering unlimited approvals should be revoked.',
  },
  {
    address: '0x111111125421cA6dc452d289314280a0f8842A65',
    label: '1inch Aggregation Router v6',
    protocol: '1inch',
    category: 'dex_router',
    riskLevel: 'medium',
  },
  {
    address: '0xDef1C0ded9bec7F1a1670819833240f027b25EfF',
    label: '0x Exchange Proxy (Legacy)',
    protocol: '0x',
    category: 'legacy_high_risk',
    riskLevel: 'high',
    deprecated: true,
    note: 'Legacy 0x Exchange Proxy — revoke stale approvals after migrating away.',
  },
  {
    address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    label: 'LI.FI Diamond Bridge Router',
    protocol: 'LI.FI',
    category: 'bridge',
    riskLevel: 'medium',
    note: 'Cross-chain bridge aggregator diamond — avoid leaving open-ended ERC-20 allowances.',
  },
  {
    address: '0x3a23F943181408EAC424116Af7b7790c94Cb97a5',
    label: 'Socket / Bungee Gateway (Legacy)',
    protocol: 'Socket',
    category: 'legacy_high_risk',
    riskLevel: 'high',
    deprecated: true,
    note: 'Historically targeted bridge gateway — revoke all lingering approvals immediately.',
  },
  {
    address: CCTP_V2_TOKEN_MESSENGER,
    label: 'Circle CCTP V2 TokenMessenger',
    protocol: 'Circle CCTP',
    category: 'bridge',
    riskLevel: 'low',
  },
];

const CHAIN_SPECIFIC_SPENDERS: Partial<Record<EvmChainId, readonly KnownApprovalSpender[]>> = {
  ethereum: [
    {
      address: '0x6b7a87899490EcE95443e979cA9485CBE7E71522',
      label: 'Multichain / Anyswap v4 Router (Exploited)',
      protocol: 'Multichain',
      category: 'legacy_high_risk',
      riskLevel: 'high',
      deprecated: true,
      note: 'Compromised legacy bridge router — revoke immediately.',
    },
    {
      address: '0xBd3fa81B58Ba92a82136038B25aDec7066af3155',
      label: 'Circle CCTP V1 TokenMessenger (Legacy)',
      protocol: 'Circle CCTP',
      category: 'bridge',
      riskLevel: 'medium',
      deprecated: true,
    },
    {
      address: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      label: 'Uniswap V2 Router 02',
      protocol: 'Uniswap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      label: 'Uniswap V3 SwapRouter',
      protocol: 'Uniswap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      label: 'Uniswap Universal Router',
      protocol: 'Uniswap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
      label: 'SushiSwap V2 Router (Legacy)',
      protocol: 'SushiSwap',
      category: 'legacy_high_risk',
      riskLevel: 'high',
      deprecated: true,
    },
  ],
  base: [
    {
      address: '0x1682Ae6375C4E4A97e4B583BC394c861A46D8962',
      label: 'Circle CCTP V1 TokenMessenger (Legacy)',
      protocol: 'Circle CCTP',
      category: 'bridge',
      riskLevel: 'medium',
      deprecated: true,
    },
    {
      address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      label: 'Uniswap Universal Router',
      protocol: 'Uniswap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      label: 'Aerodrome Router',
      protocol: 'Aerodrome',
      category: 'dex_router',
      riskLevel: 'medium',
    },
  ],
  arbitrum: [
    {
      address: '0x19330d10D9Cc8751218eaf51E8885D058642E08A',
      label: 'Circle CCTP V1 TokenMessenger (Legacy)',
      protocol: 'Circle CCTP',
      category: 'bridge',
      riskLevel: 'medium',
      deprecated: true,
    },
    {
      address: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      label: 'Uniswap V3 SwapRouter',
      protocol: 'Uniswap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
      label: 'Uniswap Universal Router',
      protocol: 'Uniswap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
  ],
  optimism: [
    {
      address: '0x2B4069517957735bE00ceE0fadAE88a26365528f',
      label: 'Circle CCTP V1 TokenMessenger (Legacy)',
      protocol: 'Circle CCTP',
      category: 'bridge',
      riskLevel: 'medium',
      deprecated: true,
    },
    {
      address: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      label: 'Uniswap V3 SwapRouter',
      protocol: 'Uniswap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
  ],
  polygon: [
    {
      address: '0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE',
      label: 'Circle CCTP V1 TokenMessenger (Legacy)',
      protocol: 'Circle CCTP',
      category: 'bridge',
      riskLevel: 'medium',
      deprecated: true,
    },
    {
      address: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      label: 'Uniswap V3 SwapRouter',
      protocol: 'Uniswap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
      label: 'QuickSwap V2 Router (Legacy)',
      protocol: 'QuickSwap',
      category: 'legacy_high_risk',
      riskLevel: 'high',
      deprecated: true,
    },
  ],
  avalanche: [
    {
      address: '0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982',
      label: 'Circle CCTP V1 TokenMessenger (Legacy)',
      protocol: 'Circle CCTP',
      category: 'bridge',
      riskLevel: 'medium',
      deprecated: true,
    },
    {
      address: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
      label: 'Trader Joe V1 Router (Legacy)',
      protocol: 'Trader Joe',
      category: 'legacy_high_risk',
      riskLevel: 'high',
      deprecated: true,
    },
  ],
  bnb: [
    {
      address: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      label: 'PancakeSwap V2 Router',
      protocol: 'PancakeSwap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
  ],
  hyperevm: [
    {
      address: '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b',
      label: 'HyperLend V3 Pool (HyperEVM)',
      protocol: 'HyperLend',
      category: 'defi_lending',
      riskLevel: 'low',
    },
  ],
  berachain: [
    {
      address: '0x4Be03f781C497A489E3cB0287833452cA9B9E80B',
      label: 'BEX Vault (Berachain)',
      protocol: 'BEX',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0xd91dd58387Ccd9B66B390ae2d7c66dBD46BC6022',
      label: 'Kodiak V2 Router (Berachain)',
      protocol: 'Kodiak',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0xe301E48F77963D3F7DbD2a4796962Bd7f3867Fb4',
      label: 'Kodiak V3 SwapRouter (Berachain)',
      protocol: 'Kodiak',
      category: 'dex_router',
      riskLevel: 'medium',
    },
  ],
  zksync: [
    {
      address: '0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295',
      label: 'SyncSwap Classic Router (zkSync Era)',
      protocol: 'SyncSwap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0x8B791913eB07C32779a16750e3868aA8495F5964',
      label: 'Mute.io Switch Router (zkSync Era)',
      protocol: 'Mute.io',
      category: 'legacy_high_risk',
      riskLevel: 'high',
      deprecated: true,
      note: 'Legacy zkSync Era AMM router — revoke unused unlimited allowances.',
    },
  ],
  ink: [
    {
      address: '0x3a63171DD9Bebf4D07BC782FECC7eb0b890C2A45',
      label: 'Velodrome Slipstream Router (Ink)',
      protocol: 'Velodrome',
      category: 'dex_router',
      riskLevel: 'medium',
    },
  ],
  gnosis: [
    {
      address: '0x1C232F01118CB8B424793ae03F870aa7D0ac7f77',
      label: 'Honeyswap V2 Router (Gnosis)',
      protocol: 'Honeyswap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
    {
      address: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      label: 'SushiSwap V2 Router (Gnosis)',
      protocol: 'SushiSwap',
      category: 'legacy_high_risk',
      riskLevel: 'high',
      deprecated: true,
      note: 'Legacy SushiSwap v2 router on Gnosis — revoke lingering approvals.',
    },
    {
      address: '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110',
      label: 'CoW Protocol GPv2VaultRelayer (Gnosis)',
      protocol: 'CoW Swap',
      category: 'dex_router',
      riskLevel: 'medium',
    },
  ],
};

/**
 * Returns the deduplicated list of known high-risk / legacy DeFi & bridge spenders for an EVM chain.
 */
export function getKnownApprovalSpenders(chain: EvmChainId): KnownApprovalSpender[] {
  const chainCfg = EVM_CHAINS[chain];
  if (!chainCfg) {
    throw new Error(`Unsupported EVM chain for approval scan: ${String(chain)}`);
  }

  const out: KnownApprovalSpender[] = [];
  const seen = new Set<string>();
  const add = (entry: KnownApprovalSpender) => {
    const key = entry.address.toLowerCase();
    if (!isValidEvmAddress(entry.address) || key === ZERO_EVM_ADDRESS || seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  for (const s of CHAIN_SPECIFIC_SPENDERS[chain] ?? []) add(s);
  if (chainCfg.aaveV3Pool) {
    add({
      address: chainCfg.aaveV3Pool,
      label: `Aave v3 Pool (${chainCfg.name})`,
      protocol: 'Aave v3',
      category: 'defi_lending',
      riskLevel: 'low',
    });
  }
  if (chainCfg.compoundV3Comet) {
    add({
      address: chainCfg.compoundV3Comet,
      label: `Compound v3 Comet (${chainCfg.name})`,
      protocol: 'Compound v3',
      category: 'defi_lending',
      riskLevel: 'low',
    });
  }
  if (chainCfg.cctpTokenMessenger) {
    add({
      address: chainCfg.cctpTokenMessenger,
      label: `Circle CCTP TokenMessenger (${chainCfg.name})`,
      protocol: 'Circle CCTP',
      category: 'bridge',
      riskLevel: 'low',
    });
  }
  for (const s of UNIVERSAL_KNOWN_SPENDERS) add(s);

  return out;
}

function classifyApprovalRisk(
  spender: KnownApprovalSpender,
  isUnlimited: boolean
): { severity: ApprovalSeverity; riskReason: string } {
  const isLegacyOrHighRisk =
    spender.category === 'legacy_high_risk' || spender.riskLevel === 'high' || Boolean(spender.deprecated);

  if (isUnlimited && isLegacyOrHighRisk) {
    return {
      severity: 'critical',
      riskReason:
        spender.note ??
        `Unlimited ERC-20 allowance granted to legacy/high-risk spender ${spender.label} — revoke immediately.`,
    };
  }
  if (isUnlimited) {
    return {
      severity: 'high',
      riskReason:
        spender.note ??
        `Unlimited ERC-20 allowance (>= 2^255) open on ${spender.label} — revoking eliminates lingering drain risk.`,
    };
  }
  if (isLegacyOrHighRisk) {
    return {
      severity: 'high',
      riskReason:
        spender.note ??
        `Non-zero allowance remains on deprecated/high-risk contract ${spender.label}.`,
    };
  }
  if (spender.category === 'bridge' || spender.category === 'permit2' || spender.riskLevel === 'medium') {
    return {
      severity: 'medium',
      riskReason: `Residual ERC-20 allowance remains on ${spender.label} (${spender.protocol}).`,
    };
  }
  return {
    severity: 'low',
    riskReason: `Non-zero ERC-20 allowance remains on ${spender.label}.`,
  };
}

const SEVERITY_RANK: Record<ApprovalSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function normalizeTokens(
  chain: EvmChainId,
  tokens?: Array<ApprovalTokenInput | string>
): Array<{ address: string; symbol: string; decimals: number }> {
  const registryByAddr = new Map(
    TOKEN_REGISTRY.filter((t) => t.chain === chain && t.address !== 'native').map((t) => [
      t.address.toLowerCase(),
      t,
    ])
  );

  const sourceList: Array<ApprovalTokenInput | string> =
    Array.isArray(tokens) && tokens.length > 0
      ? tokens
      : TOKEN_REGISTRY.filter((t) => t.chain === chain && t.address !== 'native' && t.kind === 'erc20').slice(0, 30);

  const out: Array<{ address: string; symbol: string; decimals: number }> = [];
  const seen = new Set<string>();

  for (const item of sourceList) {
    const rawAddr = typeof item === 'string' ? item : item?.address;
    if (!rawAddr || rawAddr === 'native') continue;
    const validAddr = assertNonZeroEvmAddress(rawAddr, 'token address');
    const key = validAddr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const reg = registryByAddr.get(key);
    const symbol =
      (typeof item === 'object' && item.symbol?.trim()) ||
      reg?.symbol ||
      `${validAddr.slice(0, 6)}…${validAddr.slice(-4)}`;
    const decimalsRaw = typeof item === 'object' && item.decimals !== undefined ? Number(item.decimals) : reg?.decimals;
    const decimals =
      decimalsRaw !== undefined && Number.isInteger(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 36
        ? decimalsRaw
        : 18;

    out.push({ address: validAddr, symbol, decimals });
  }

  return out;
}

function normalizeSpenders(
  chain: EvmChainId,
  spenders?: Array<ApprovalSpenderInput | string>,
  includeKnownSpenders = false
): KnownApprovalSpender[] {
  const known = getKnownApprovalSpenders(chain);
  const knownByAddr = new Map(known.map((k) => [k.address.toLowerCase(), k]));

  const hasExplicit = Array.isArray(spenders) && spenders.length > 0;
  const out: KnownApprovalSpender[] = [];
  const seen = new Set<string>();

  const pushSpender = (entry: KnownApprovalSpender) => {
    const key = entry.address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  if (hasExplicit) {
    for (const item of spenders!) {
      const rawAddr = typeof item === 'string' ? item : item?.address;
      const validAddr = assertNonZeroEvmAddress(rawAddr ?? '', 'spender address');
      const knownMatch = knownByAddr.get(validAddr.toLowerCase());
      if (typeof item === 'string') {
        pushSpender(
          knownMatch ?? {
            address: validAddr,
            label: `Spender ${validAddr.slice(0, 6)}…${validAddr.slice(-4)}`,
            protocol: 'Custom',
            category: 'custom',
            riskLevel: 'medium',
          }
        );
      } else {
        pushSpender({
          address: validAddr,
          label: item.label?.trim() || knownMatch?.label || `Spender ${validAddr.slice(0, 6)}…${validAddr.slice(-4)}`,
          protocol: item.protocol?.trim() || knownMatch?.protocol || 'Custom',
          category: item.category ?? knownMatch?.category ?? 'custom',
          riskLevel: item.riskLevel ?? knownMatch?.riskLevel ?? 'medium',
          deprecated: item.deprecated ?? knownMatch?.deprecated,
          note: item.note ?? knownMatch?.note,
        });
      }
    }
    if (includeKnownSpenders) {
      for (const k of known) pushSpender(k);
    }
  } else {
    for (const k of known) pushSpender(k);
  }

  return out;
}

/**
 * Scans live ERC-20 `allowance(owner, spender)` values via Multicall3.aggregate3 against known
 * high-risk / legacy DeFi & bridge spenders (and optional custom spenders), flags non-zero and
 * unlimited (`>= 2^255`) approvals, and builds ready-to-sign `approve(spender, 0)` revoke calldata.
 */
export async function scanStaleErc20Approvals(
  chain: EvmChainId,
  walletAddress: string,
  tokens?: Array<ApprovalTokenInput | string>,
  spenders?: Array<ApprovalSpenderInput | string>,
  opts: ScanApprovalsOptions = {}
): Promise<StaleApprovalScanResult> {
  const chainCfg = EVM_CHAINS[chain];
  if (!chainCfg) {
    throw new Error(`Unsupported EVM chain for approval scan: ${String(chain)}`);
  }

  const validWallet = assertNonZeroEvmAddress(walletAddress, 'walletAddress');
  const normTokens = normalizeTokens(chain, tokens);
  const normSpenders = normalizeSpenders(chain, spenders, Boolean(opts.includeKnownSpenders));

  const pairs: Array<{
    token: { address: string; symbol: string; decimals: number };
    spender: KnownApprovalSpender;
  }> = [];
  for (const token of normTokens) {
    for (const spender of normSpenders) {
      // Skip self-approval pair where token === spender
      if (token.address.toLowerCase() === spender.address.toLowerCase()) continue;
      pairs.push({ token, spender });
    }
  }

  const findings: StaleApprovalFinding[] = [];
  const warnings: string[] = [];
  let failedPairs = 0;

  const chunkSize = Math.max(1, Math.min(200, Math.trunc(opts.multicallChunkSize ?? 80)));
  const timeoutMs = Math.max(500, Math.min(30_000, Math.trunc(opts.timeoutMs ?? 4500)));
  const rpcCall = opts.rpcCall ?? evmJsonRpcCall;
  const rpcUrls = chainCfg.rpcUrls?.length ? chainCfg.rpcUrls : [chainCfg.rpcUrl];

  for (let offset = 0; offset < pairs.length; offset += chunkSize) {
    const slice = pairs.slice(offset, offset + chunkSize);
    const mcCalldata = encodeMulticall3Aggregate3(
      slice.map(({ token, spender }) => ({
        target: token.address,
        allowFailure: true,
        callData: encodeErc20AllowanceCalldata(validWallet, spender.address),
      }))
    );

    const resp = await rpcCall(
      rpcUrls,
      'eth_call',
      [{ to: chainCfg.multicall3, data: mcCalldata }, 'latest'],
      timeoutMs
    );

    if (!resp.result) {
      throw new Error(
        resp.error?.message || `Multicall3 allowance scan failed on ${chainCfg.name}.`
      );
    }

    const decoded = decodeMulticall3Aggregate3(resp.result);
    if (decoded.length < slice.length) {
      warnings.push(
        `Multicall3 returned ${decoded.length}/${slice.length} allowance results in chunk at offset ${offset}.`
      );
    }

    for (let i = 0; i < Math.min(slice.length, decoded.length); i++) {
      const item = decoded[i];
      const { token, spender } = slice[i];
      if (!item.success) {
        failedPairs += 1;
        continue;
      }
      const cleanHex = strip0x(item.returnData);
      if (cleanHex.length < 64) {
        failedPairs += 1;
        continue;
      }

      const allowanceRaw = BigInt('0x' + cleanHex.slice(0, 64));
      if (allowanceRaw === 0n) continue;

      const isUnlimited = allowanceRaw >= UNLIMITED_ALLOWANCE_THRESHOLD;
      if (opts.unlimitedOnly && !isUnlimited) continue;

      const isMaxUint256 = allowanceRaw === MAX_UINT256;
      const { severity, riskReason } = classifyApprovalRisk(spender, isUnlimited);
      const revokeData = encodeErc20RevokeCalldata(spender.address);
      const allowanceFormatted = isUnlimited
        ? 'UNLIMITED'
        : formatUnits(allowanceRaw, token.decimals).toString();

      findings.push({
        chain,
        chainId: chainCfg.chainId,
        token: token.address,
        tokenSymbol: token.symbol,
        tokenDecimals: token.decimals,
        spender: spender.address,
        spenderLabel: spender.label,
        spenderProtocol: spender.protocol,
        spenderCategory: spender.category,
        spenderRiskLevel: spender.riskLevel,
        allowanceRaw: allowanceRaw.toString(),
        allowanceFormatted,
        isUnlimited,
        isMaxUint256,
        severity,
        riskReason,
        revokeCall: {
          to: token.address,
          data: revokeData,
          value: '0x0',
          chainId: chainCfg.chainId,
          label: `Revoke ${token.symbol} approval for ${spender.label}`,
        },
      });
    }
  }

  findings.sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    if (a.isUnlimited !== b.isUnlimited) return a.isUnlimited ? -1 : 1;
    return a.tokenSymbol.localeCompare(b.tokenSymbol);
  });

  const revokes: ApprovalRevoke[] = findings.map((f) => ({
    token: f.token,
    spender: f.spender,
    to: f.revokeCall.to,
    data: f.revokeCall.data,
    value: '0x0',
    chainId: f.chainId,
    tokenSymbol: f.tokenSymbol,
    spenderLabel: f.spenderLabel,
    isUnlimited: f.isUnlimited,
    severity: f.severity,
  }));

  return {
    chain,
    chainName: chainCfg.name,
    chainId: chainCfg.chainId,
    walletAddress: validWallet,
    multicall3: chainCfg.multicall3,
    tokensScanned: normTokens.length,
    spendersScanned: normSpenders.length,
    scannedPairs: pairs.length,
    failedPairs,
    activeApprovalsCount: findings.length,
    unlimitedCount: findings.filter((f) => f.isUnlimited).length,
    highRiskCount: findings.filter((f) => f.severity === 'critical' || f.severity === 'high').length,
    findings,
    revokes,
    warnings,
    scannedAt: new Date().toISOString(),
  };
}
