import { EVM_CHAINS, TOKEN_REGISTRY } from '../scanner/chains.js';
import {
  decodeMulticall3Aggregate3,
  encodeMulticall3Aggregate3,
  evmJsonRpcCall,
  formatUnits,
} from '../scanner/rpc.js';
import type {
  DefiExitPlan,
  DefiExitStrategy,
  DefiPreflightStatus,
  DefiProtocolExtractorId,
  DefiRouteKind,
  EvmChainId,
  ScannedAsset,
} from '../scanner/types.js';
import type { AaveAccountSafety } from '../scanner/discovery.js';

export const MAX_UINT256 = (1n << 256n) - 1n;
export const MAX_UINT128 = (1n << 128n) - 1n;
export const MIN_SAFE_HEALTH_FACTOR = 1.6;

/**
 * Cryptographically verified 4-byte EVM ABI function selectors (keccak256).
 */
export const DEFI_SELECTORS = {
  // ERC-20
  balanceOf: '0x70a08231',
  approve: '0x095ea7b3',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  totalSupply: '0x18160ddd',

  // ERC-4626 (Morpho, Yearn v3, Spark, Sky, Ethena, Fluid, Euler)
  asset: '0x38d52e0f',
  erc4626TotalAssets: '0x01e1d114', // totalAssets()
  convertToAssets: '0x07a2d13a',
  previewRedeem: '0x4cdad506',
  maxRedeem: '0xd905777e',
  redeem4626: '0xba087652', // redeem(uint256,address,address)
  cooldownDuration: '0x35269315', // Ethena sUSDe cooldownDuration()

  // Yearn v2 Vaults (yvOP, yvUSDT, yvUSDC, yvWETH, etc.)
  yearnV2Token: '0xfc0c546a', // token()
  yearnV2PricePerShare: '0x99530b06', // pricePerShare()
  yearnV2Withdraw: '0x2e1a7d4d', // withdraw(uint256)

  // Aave v3 & Aave v2
  aaveWithdraw: '0x69328dec', // withdraw(address,uint256,address)
  aaveGetUserAccountData: '0xbf92857c', // getUserAccountData(address)
  aaveGetReserveData: '0x35ea6a75', // getReserveData(address)
  aaveUnderlyingAsset: '0xb16a19de', // UNDERLYING_ASSET_ADDRESS()
  aaveV3Pool: '0x7535d246', // POOL()
  aaveV2LendingPool: '0xb4dcfc77', // LENDING_POOL()

  // Compound v3 (Comet)
  compoundV3Withdraw: '0xf3fef3a3', // withdraw(address,uint256)
  compoundV3BaseToken: '0xc55dae63', // baseToken()
  compoundV3BorrowBalanceOf: '0x374c49b4', // borrowBalanceOf(address)
  compoundV3IsBorrowCollateralized: '0x38aa813f', // isBorrowCollateralized(address)

  // Compound v2 / Venus / Benqi / Moonwell
  compoundV2Underlying: '0x6f307dc3', // underlying()
  compoundV2ExchangeRateStored: '0x182df0f5', // exchangeRateStored()
  compoundV2Comptroller: '0x5fe3b567', // comptroller()
  compoundV2Redeem: '0xdb006a75', // redeem(uint256)
  compoundV2BorrowBalanceStored: '0x95dd9193', // borrowBalanceStored(address)
  compoundV2GetAccountLiquidity: '0x5ec88c79', // getAccountLiquidity(address)

  // Uniswap v2 / Sushi / Aerodrome v2 LP
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  getReserves: '0x0902f1ac',
  factory: '0xc45a0155',
  stable: '0x22be3de1', // Aerodrome / Velodrome v2 Pool.stable()
  removeLiquidityV2: '0xbaa2abde', // removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)
  removeLiquidityAero: '0x0dede6c4', // removeLiquidity(address,address,bool,uint256,uint256,uint256,address,uint256)

  // Uniswap v3 / Aerodrome Slipstream CL NonfungiblePositionManager
  tokenOfOwnerByIndex: '0x2f745c59',
  positions: '0x99fbab88',
  decreaseLiquidity: '0x0c49ccbe', // decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))
  collect: '0xfc6f7865', // collect((uint256,address,uint128,uint128))
  burnNft: '0x42966c68', // burn(uint256)
  multicall: '0xac9650d8', // multicall(bytes[])
} as const;

export const AAVE_V2_LENDING_POOLS: Partial<Record<EvmChainId, string>> = {
  ethereum: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
  polygon: '0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf',
  avalanche: '0x4F01AeD16D97E3aB5ab2B501154DC9bb0F1A5A2C',
};

/**
 * Audited per-chain Aave v3 Pool allowlist (always includes `EVM_CHAINS[chain].aaveV3Pool`).
 */
export const AUDITED_AAVE_V3_POOLS: Partial<Record<EvmChainId, string[]>> = {
  ethereum: [
    '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2', // Aave v3 Ethereum Core
    '0x4e033931ad43597d96D6bcc25c280717730B58B1', // Aave v3 Ethereum Prime (Lido)
  ],
};

export function getAllowedAaveV3Pools(chain: EvmChainId): Set<string> {
  const allowed = new Set<string>();
  const primary = EVM_CHAINS[chain]?.aaveV3Pool;
  if (primary) allowed.add(primary.toLowerCase());
  for (const p of AUDITED_AAVE_V3_POOLS[chain] ?? []) {
    allowed.add(p.toLowerCase());
  }
  return allowed;
}

export function isAllowedAaveV3Pool(chain: EvmChainId, poolAddress?: string | null): boolean {
  if (!poolAddress || !/^0x[0-9a-fA-F]{40}$/.test(poolAddress)) return false;
  return getAllowedAaveV3Pools(chain).has(poolAddress.toLowerCase());
}

const CURATED_DEFI_VAULT_KEYS = new Set<string>(
  TOKEN_REGISTRY.filter((t) => t.kind === 'defi_position').map(
    (t) => `${t.chain}:${t.address.toLowerCase()}`
  )
);

/**
 * Returns true if the given (chain, address) is an audited DeFi vault/receipt contract
 * explicitly curated in `TOKEN_REGISTRY`.
 */
export function isCuratedDefiVault(chain: EvmChainId, address?: string | null): boolean {
  if (!address) return false;
  return CURATED_DEFI_VAULT_KEYS.has(`${chain}:${address.toLowerCase()}`);
}

export const COMPOUND_V3_COMETS: Partial<Record<EvmChainId, string[]>> = {
  ethereum: [
    '0xc3d688B66703497DAA19211EEdff47f25384cdc3', // cUSDCv3
    '0xA17581A9E3356d9A858b789D68B4d866e593aE94', // cWETHv3
    '0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840', // cUSDTv3
  ],
  base: [
    '0xb125E6687d4313864e53df431d5425969c15Eb2F', // cUSDCv3
    '0x46e6b214b524310239732D51387075E0e70970bf', // cWETHv3
    '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', // cUSDbCv3
    '0x784efeB622244d2348d4F2522f8860B96fbEcE89', // cAEROv3
  ],
  arbitrum: [
    '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf', // cUSDCv3
    '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA', // cUSDC.ev3
    '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486', // cWETHv3
    '0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07', // cUSDTv3
  ],
  optimism: [
    '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB', // cUSDCv3
    '0x995E394b8B2437aC8Ce61Ee0bC610D617962B2Ac', // cUSDTv3
  ],
  polygon: [
    '0xF25212E676D1F7F89Cd72fFEe66158f541246445', // cUSDCv3
  ],
};

export const COMPOUND_V2_COMPTROLLERS: Partial<Record<EvmChainId, string[]>> = {
  ethereum: ['0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B'], // Compound v2 Comptroller
  bnb: ['0xfD36E2c2a6789Db23113685031d7F16329158384'], // Venus Unitroller
  avalanche: ['0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4'], // Benqi Comptroller
  base: ['0xfBb21d0380beE3312B33c4353c8936a0F13EF26C'], // Moonwell Comptroller
};

/**
 * Security guard against spoofed/malicious receipt tokens or tampered API payloads
 * injecting arbitrary `protocolAddress` calldata targets.
 */
export function validateTrustedProtocolTarget(params: {
  chain: EvmChainId;
  protocolId: DefiProtocolExtractorId;
  assetAddress: string;
  protocolAddress?: string;
}): { trusted: boolean; reason?: string } {
  const { chain, protocolId, assetAddress, protocolAddress } = params;
  const cfg = EVM_CHAINS[chain];
  if (!cfg) return { trusted: false, reason: `Unsupported chain ${chain}.` };
  if (!protocolAddress || !/^0x[0-9a-fA-F]{40}$/.test(protocolAddress)) {
    return { trusted: false, reason: `Missing or malformed protocol contract address.` };
  }
  const targetLower = protocolAddress.toLowerCase();
  const assetLower = assetAddress.toLowerCase();

  if (protocolId === 'aave_v3') {
    if (!isAllowedAaveV3Pool(chain, protocolAddress)) {
      return {
        trusted: false,
        reason: `Blocked untrusted Aave v3 Pool address — does not match the verified Aave v3 Pool on ${cfg.name}.`,
      };
    }
    return { trusted: true };
  }

  if (protocolId === 'aave_v2') {
    const expected = AAVE_V2_LENDING_POOLS[chain]?.toLowerCase();
    if (!expected || targetLower !== expected) {
      return {
        trusted: false,
        reason: `Blocked untrusted Aave v2 LendingPool address — does not match the verified Aave v2 pool on ${cfg.name}.`,
      };
    }
    return { trusted: true };
  }

  if (protocolId === 'compound_v3') {
    const allowed = new Set<string>(
      [...(COMPOUND_V3_COMETS[chain] ?? []), cfg.compoundV3Comet]
        .filter((a): a is string => Boolean(a))
        .map((a) => a.toLowerCase())
    );
    if (!allowed.has(targetLower)) {
      return {
        trusted: false,
        reason: `Blocked untrusted Compound v3 market address — does not match a verified Comet market on ${cfg.name}.`,
      };
    }
    return { trusted: true };
  }

  if (protocolId === 'uniswap_v2_lp') {
    const allowed = new Set((V2_DEX_ROUTERS[chain] ?? []).map((r) => r.router.toLowerCase()));
    if (!allowed.has(targetLower)) {
      return {
        trusted: false,
        reason: `Blocked untrusted DEX router address — does not match a verified v2 router on ${cfg.name}.`,
      };
    }
    return { trusted: true };
  }

  if (protocolId === 'uniswap_v3_nft') {
    const allowed = new Set((UNISWAP_V3_NFT_MANAGERS[chain] ?? []).map((m) => m.address.toLowerCase()));
    if (!allowed.has(targetLower)) {
      return {
        trusted: false,
        reason: `Blocked untrusted NFT Position Manager address — does not match a verified Uniswap v3 / Aerodrome CL manager on ${cfg.name}.`,
      };
    }
    return { trusted: true };
  }

  // ERC-4626 vaults, Yearn v2 vaults, and Compound v2 cTokens must ALWAYS call redeem/withdraw on the receipt token itself —
  // never allow a spoofed receipt token to redirect calldata to an unrelated third-party target!
  if (protocolId === 'erc4626' || protocolId === 'yearn_v2' || protocolId === 'compound_v2') {
    if (targetLower !== assetLower) {
      return {
        trusted: false,
        reason: `Blocked spoofed protocol target — vault/cToken redemption must target the receipt contract itself, not an external address.`,
      };
    }
    return { trusted: true };
  }

  if (protocolId === 'external_protocol') {
    return {
      trusted: false,
      reason: `External protocol position must be managed on its protocol app — Turgalium only executes verified native protocol extractors.`,
    };
  }

  return { trusted: true };
}

export interface V2DexRouterConfig {
  name: string;
  router: string;
  factory: string;
  isAerodromeStyle?: boolean;
}

export const V2_DEX_ROUTERS: Partial<Record<EvmChainId, V2DexRouterConfig[]>> = {
  ethereum: [
    {
      name: 'Uniswap v2',
      router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
      factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
    },
    {
      name: 'SushiSwap v2',
      router: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
      factory: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
    },
  ],
  base: [
    {
      name: 'Aerodrome v2',
      router: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      isAerodromeStyle: true,
    },
    {
      name: 'Uniswap v2',
      router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      factory: '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6',
    },
  ],
  arbitrum: [
    {
      name: 'Uniswap v2',
      router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24',
      factory: '0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9',
    },
    {
      name: 'SushiSwap v2',
      router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    },
  ],
  optimism: [
    {
      name: 'Velodrome v2',
      router: '0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858',
      factory: '0xF1046053aa5682b4F9a81b5481394DA16BE5FF5a',
      isAerodromeStyle: true,
    },
    {
      name: 'Uniswap v2',
      router: '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2',
      factory: '0x0c3c1c532F1e39EdF36BE9Fe0bE1410313E074Bf',
    },
  ],
  polygon: [
    {
      name: 'QuickSwap v2',
      router: '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
      factory: '0x5757371414417b8C6CAad45bAeF941aBc7d3Ab32',
    },
    {
      name: 'SushiSwap v2',
      router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    },
  ],
  avalanche: [
    {
      name: 'Trader Joe v1',
      router: '0x60aE616a2155Ee3d9A68541Ba4544862310933d4',
      factory: '0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10',
    },
  ],
  bnb: [
    {
      name: 'PancakeSwap v2',
      router: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
      factory: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',
    },
  ],
  berachain: [
    {
      name: 'Kodiak v2',
      router: '0xd91dd58387Ccd9B66B390ae2d7c66dBD46BC6022',
      factory: '0x5e705e184d233ff2a7cb1553793464a9d0c3028f',
    },
  ],
  gnosis: [
    {
      name: 'Honeyswap v2',
      router: '0x1C232F01118CB8B424793ae03F870aa7D0ac7f77',
      factory: '0xa818b4f111ccac7aa31d0bcc0806d64f2e0737d7',
    },
    {
      name: 'SushiSwap v2',
      router: '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
      factory: '0xc35DADB65012eC5796536bD9864eD8773aBc74C4',
    },
  ],
};

export interface NftPositionManagerConfig {
  protocol: string;
  address: string;
}

export const UNISWAP_V3_NFT_MANAGERS: Partial<Record<EvmChainId, NftPositionManagerConfig[]>> = {
  ethereum: [
    { protocol: 'Uniswap v3', address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
  ],
  base: [
    { protocol: 'Uniswap v3', address: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1' },
    { protocol: 'Aerodrome CL', address: '0x827922686190790b37229fd06084350E74485b72' },
  ],
  arbitrum: [
    { protocol: 'Uniswap v3', address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
  ],
  optimism: [
    { protocol: 'Uniswap v3', address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
  ],
  polygon: [
    { protocol: 'Uniswap v3', address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
  ],
  avalanche: [
    { protocol: 'Uniswap v3', address: '0x655C406EBFa14EE2006250925e54ec43AD184f8B' },
  ],
  bnb: [
    { protocol: 'Uniswap v3', address: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613' },
  ],
  berachain: [
    { protocol: 'Kodiak v3', address: '0xFE5E8C83FFE4d9627A75EaA7Fee864768dB989bD' },
  ],
};

/**
 * Liquid receipt tokens with deep DEX liquidity that route directly to
 * Swap & Bridge (1 tx, instant, skipping cooldown queues & unwrap gas).
 */
export interface LiquidReceiptInfo {
  symbol: string;
  protocolName: string;
  underlyingSymbol: string;
  hasNativeCooldown: boolean;
  cooldownSummary?: string;
}

export const LIQUID_RECEIPT_REGISTRY: Record<string, LiquidReceiptInfo> = {
  wsteth: {
    symbol: 'wstETH',
    protocolName: 'Lido',
    underlyingSymbol: 'ETH',
    hasNativeCooldown: true,
    cooldownSummary: 'Lido unstaking queue takes 1-5 days',
  },
  steth: {
    symbol: 'stETH',
    protocolName: 'Lido',
    underlyingSymbol: 'ETH',
    hasNativeCooldown: true,
    cooldownSummary: 'Lido unstaking queue takes 1-5 days',
  },
  reth: {
    symbol: 'rETH',
    protocolName: 'Rocket Pool',
    underlyingSymbol: 'ETH',
    hasNativeCooldown: true,
    cooldownSummary: 'Rocket Pool deposit pool liquidity can cap direct burns',
  },
  cbeth: {
    symbol: 'cbETH',
    protocolName: 'Coinbase Staked ETH',
    underlyingSymbol: 'ETH',
    hasNativeCooldown: true,
    cooldownSummary: 'cbETH has no permissionless onchain unwrap',
  },
  weeth: {
    symbol: 'weETH',
    protocolName: 'ether.fi',
    underlyingSymbol: 'ETH',
    hasNativeCooldown: true,
    cooldownSummary: 'ether.fi native withdrawal queue takes 7-14 days',
  },
  ezeth: {
    symbol: 'ezETH',
    protocolName: 'Renzo',
    underlyingSymbol: 'ETH',
    hasNativeCooldown: true,
    cooldownSummary: 'Renzo native restaking cooldown takes 7+ days',
  },
  susde: {
    symbol: 'sUSDe',
    protocolName: 'Ethena',
    underlyingSymbol: 'USDe',
    hasNativeCooldown: true,
    cooldownSummary: 'Ethena enforces a 7-day cooldown where redeem() reverts',
  },
  sdai: {
    symbol: 'sDAI',
    protocolName: 'Spark Savings',
    underlyingSymbol: 'DAI',
    hasNativeCooldown: false,
  },
  susds: {
    symbol: 'sUSDS',
    protocolName: 'Sky Savings',
    underlyingSymbol: 'USDS',
    hasNativeCooldown: false,
  },
};

export const KNOWN_COOLDOWN_VAULT_ADDRESSES = new Set([
  '0x9d39a5de30e57443bff2a8307a4256c8797a3497', // Ethereum Ethena sUSDe
]);

export function getLiquidReceiptInfo(symbol?: string, address?: string): LiquidReceiptInfo | null {
  if (address && KNOWN_COOLDOWN_VAULT_ADDRESSES.has(address.toLowerCase())) {
    return LIQUID_RECEIPT_REGISTRY.susde;
  }
  if (!symbol) return null;
  return LIQUID_RECEIPT_REGISTRY[symbol.trim().toLowerCase()] ?? null;
}

export function isLiquidReceiptToken(symbol?: string, address?: string): boolean {
  return getLiquidReceiptInfo(symbol, address) !== null;
}

export function isKnownCooldownVault(symbol?: string, address?: string): boolean {
  if (address && KNOWN_COOLDOWN_VAULT_ADDRESSES.has(address.toLowerCase())) return true;
  const info = getLiquidReceiptInfo(symbol, address);
  return Boolean(info && info.symbol === 'sUSDe');
}

// ========================== ABI ENCODING / DECODING ==========================

function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

export function pad32Hex(val: string): string {
  return strip0x(val).toLowerCase().padStart(64, '0');
}

export function padUint256(val: bigint): string {
  const clamped = val < 0n ? 0n : val > MAX_UINT256 ? MAX_UINT256 : val;
  return clamped.toString(16).padStart(64, '0');
}

export function decodeAbiAddressWord(hex: string): string | null {
  const clean = strip0x(hex);
  if (clean.length < 64) return null;
  const addr = '0x' + clean.slice(24, 64).toLowerCase();
  if (addr === '0x0000000000000000000000000000000000000000') return null;
  return addr;
}

export function decodeAbiUint256Word(hex: string, wordIndex = 0): bigint | null {
  const clean = strip0x(hex);
  const start = wordIndex * 64;
  if (clean.length < start + 64) return null;
  try {
    return BigInt('0x' + clean.slice(start, start + 64));
  } catch {
    return null;
  }
}

export function decodeAbiBoolWord(hex: string, wordIndex = 0): boolean | null {
  const v = decodeAbiUint256Word(hex, wordIndex);
  if (v === null) return null;
  return v !== 0n;
}

export function encodeErc20Approve(spender: string, amount: bigint): string {
  return `${DEFI_SELECTORS.approve}${pad32Hex(spender)}${padUint256(amount)}`;
}

// ERC-4626 encoders
export function encodeErc4626ConvertToAssets(shares: bigint): string {
  return `${DEFI_SELECTORS.convertToAssets}${padUint256(shares)}`;
}

export function encodeErc4626PreviewRedeem(shares: bigint): string {
  return `${DEFI_SELECTORS.previewRedeem}${padUint256(shares)}`;
}

export function encodeErc4626MaxRedeem(owner: string): string {
  return `${DEFI_SELECTORS.maxRedeem}${pad32Hex(owner)}`;
}

export function encodeErc4626Redeem(shares: bigint, receiver: string, owner: string): string {
  return `${DEFI_SELECTORS.redeem4626}${padUint256(shares)}${pad32Hex(receiver)}${pad32Hex(owner)}`;
}

// Aave v3 & Aave v2 withdraw(address asset, uint256 amount, address to)
export function encodeAaveWithdraw(underlyingAsset: string, amount: bigint, to: string): string {
  return `${DEFI_SELECTORS.aaveWithdraw}${pad32Hex(underlyingAsset)}${padUint256(amount)}${pad32Hex(to)}`;
}

// Aave v3 & Aave v2 Pool.getReserveData(address asset) (`0x35ea6a75`)
export function encodeAaveGetReserveData(underlyingAsset: string): string {
  return `${DEFI_SELECTORS.aaveGetReserveData}${pad32Hex(underlyingAsset)}`;
}

export interface AaveReserveTokenAddresses {
  aTokenAddress: string | null;
  stableDebtTokenAddress: string | null;
  variableDebtTokenAddress: string | null;
}

/**
 * Decodes Aave v3 `IPool.getReserveData(address)` struct return (15 words):
 *   word 8: aTokenAddress
 *   word 9: stableDebtTokenAddress
 *   word 10: variableDebtTokenAddress
 */
export function decodeAaveV3ReserveData(hex: string): AaveReserveTokenAddresses | null {
  const clean = strip0x(hex);
  if (clean.length < 64 * 11) return null;
  return {
    aTokenAddress: decodeAbiAddressWord('0x' + clean.slice(8 * 64, 9 * 64)),
    stableDebtTokenAddress: decodeAbiAddressWord('0x' + clean.slice(9 * 64, 10 * 64)),
    variableDebtTokenAddress: decodeAbiAddressWord('0x' + clean.slice(10 * 64, 11 * 64)),
  };
}

/**
 * Decodes Aave v2 `ILendingPool.getReserveData(address)` struct return (12 words):
 *   word 7: aTokenAddress
 *   word 8: stableDebtTokenAddress
 *   word 9: variableDebtTokenAddress
 */
export function decodeAaveV2ReserveData(hex: string): AaveReserveTokenAddresses | null {
  const clean = strip0x(hex);
  if (clean.length < 64 * 10) return null;
  return {
    aTokenAddress: decodeAbiAddressWord('0x' + clean.slice(7 * 64, 8 * 64)),
    stableDebtTokenAddress: decodeAbiAddressWord('0x' + clean.slice(8 * 64, 9 * 64)),
    variableDebtTokenAddress: decodeAbiAddressWord('0x' + clean.slice(9 * 64, 10 * 64)),
  };
}

/**
 * Verifies in a SINGLE Multicall3 batch that candidate Aave v3/v2 receipt tokens are genuine
 * collateral `aTokenAddress` contracts by calling `POOL.getReserveData(underlying)` (`0x35ea6a75`)
 * on an allowlisted pool. Explicitly rejects `variableDebtTokenAddress`, `stableDebtTokenAddress`,
 * and any spoofed airdrop contract. Fails closed on RPC error.
 */
export async function verifyAaveReserveATokens(params: {
  chain: EvmChainId;
  candidates: Array<{
    tokenAddress: string;
    poolAddress: string;
    underlyingAddress: string;
    version: 'v3' | 'v2';
  }>;
}): Promise<Set<string>> {
  const verified = new Set<string>();
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg || !params.candidates.length) return verified;

  const allowedCandidates = params.candidates.filter((c) => {
    const check = validateTrustedProtocolTarget({
      chain: params.chain,
      protocolId: c.version === 'v3' ? 'aave_v3' : 'aave_v2',
      assetAddress: c.tokenAddress,
      protocolAddress: c.poolAddress,
    });
    return check.trusted;
  });
  if (!allowedCandidates.length) return verified;

  try {
    const mcData = encodeMulticall3Aggregate3(
      allowedCandidates.map((c) => ({
        target: c.poolAddress,
        allowFailure: true,
        callData: encodeAaveGetReserveData(c.underlyingAddress),
      }))
    );
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: mcData }, 'latest'],
      4000
    );
    if (!json.result || json.result === '0x') return verified;
    const results = decodeMulticall3Aggregate3(json.result);
    for (let i = 0; i < allowedCandidates.length; i++) {
      const c = allowedCandidates[i];
      const r = results[i];
      if (!r?.success) continue;
      const decoded =
        c.version === 'v3'
          ? decodeAaveV3ReserveData(r.returnData)
          : decodeAaveV2ReserveData(r.returnData);
      if (!decoded?.aTokenAddress) continue;
      const tokenLower = c.tokenAddress.toLowerCase();
      if (
        decoded.variableDebtTokenAddress &&
        decoded.variableDebtTokenAddress.toLowerCase() === tokenLower
      ) {
        continue;
      }
      if (
        decoded.stableDebtTokenAddress &&
        decoded.stableDebtTokenAddress.toLowerCase() === tokenLower
      ) {
        continue;
      }
      if (decoded.aTokenAddress.toLowerCase() === tokenLower) {
        verified.add(tokenLower);
      }
    }
  } catch {
    // Fail closed: never trust unverified Aave receipt tokens when getReserveData fails
  }

  return verified;
}

// Compound v3 Comet.withdraw(address asset, uint256 amount)
export function encodeCompoundV3Withdraw(underlyingAsset: string, amount: bigint): string {
  return `${DEFI_SELECTORS.compoundV3Withdraw}${pad32Hex(underlyingAsset)}${padUint256(amount)}`;
}

// Compound v2 / Venus / Benqi cToken.redeem(uint256 redeemTokens)
export function encodeCompoundV2Redeem(cTokenAmount: bigint): string {
  return `${DEFI_SELECTORS.compoundV2Redeem}${padUint256(cTokenAmount)}`;
}

// Yearn v2 Vault.withdraw(uint256 maxShares)
export function encodeYearnV2Withdraw(shares: bigint): string {
  return `${DEFI_SELECTORS.yearnV2Withdraw}${padUint256(shares)}`;
}

export function computeYearnV2UnderlyingRaw(
  sharesRaw: bigint,
  pricePerShare: bigint,
  vaultDecimals: number
): bigint {
  if (sharesRaw <= 0n || pricePerShare <= 0n) return 0n;
  const scale = 10n ** BigInt(Math.max(0, Math.min(36, vaultDecimals)));
  return (sharesRaw * pricePerShare) / scale;
}

export function computeCompoundV2UnderlyingRaw(
  cTokenRaw: bigint,
  exchangeRateStored: bigint
): bigint {
  if (cTokenRaw <= 0n || exchangeRateStored <= 0n) return 0n;
  return (cTokenRaw * exchangeRateStored) / 10n ** 18n;
}

// Uniswap v2 / Sushi / Aerodrome v2 LP encoders & decoders
export function decodeUniswapV2Reserves(hex: string): {
  reserve0: bigint;
  reserve1: bigint;
  blockTimestampLast: number;
} | null {
  const r0 = decodeAbiUint256Word(hex, 0);
  const r1 = decodeAbiUint256Word(hex, 1);
  const ts = decodeAbiUint256Word(hex, 2);
  if (r0 === null || r1 === null) return null;
  return {
    reserve0: r0,
    reserve1: r1,
    blockTimestampLast: ts !== null ? Number(ts) : 0,
  };
}

export function computeUniswapV2UnderlyingAmounts(params: {
  lpBalance: bigint;
  totalSupply: bigint;
  reserve0: bigint;
  reserve1: bigint;
  slippageBps?: number;
}): {
  amount0: bigint;
  amount1: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
} {
  const { lpBalance, totalSupply, reserve0, reserve1, slippageBps = 100 } = params;
  if (lpBalance <= 0n || totalSupply <= 0n) {
    return { amount0: 0n, amount1: 0n, amount0Min: 0n, amount1Min: 0n };
  }
  const amount0 = (lpBalance * reserve0) / totalSupply;
  const amount1 = (lpBalance * reserve1) / totalSupply;
  const factor = BigInt(Math.max(0, 10_000 - slippageBps));
  return {
    amount0,
    amount1,
    amount0Min: (amount0 * factor) / 10_000n,
    amount1Min: (amount1 * factor) / 10_000n,
  };
}

export function encodeUniswapV2RemoveLiquidity(params: {
  tokenA: string;
  tokenB: string;
  liquidity: bigint;
  amountAMin: bigint;
  amountBMin: bigint;
  to: string;
  deadline: bigint;
  stable?: boolean;
}): string {
  const { tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline, stable } = params;
  if (typeof stable === 'boolean') {
    // Aerodrome / Velodrome v2 Router.removeLiquidity(tokenA, tokenB, stable, liquidity, amountAMin, amountBMin, to, deadline)
    return (
      DEFI_SELECTORS.removeLiquidityAero +
      pad32Hex(tokenA) +
      pad32Hex(tokenB) +
      padUint256(stable ? 1n : 0n) +
      padUint256(liquidity) +
      padUint256(amountAMin) +
      padUint256(amountBMin) +
      pad32Hex(to) +
      padUint256(deadline)
    );
  }
  // Uniswap v2 / SushiSwap / PancakeSwap Router.removeLiquidity(tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline)
  return (
    DEFI_SELECTORS.removeLiquidityV2 +
    pad32Hex(tokenA) +
    pad32Hex(tokenB) +
    padUint256(liquidity) +
    padUint256(amountAMin) +
    padUint256(amountBMin) +
    pad32Hex(to) +
    padUint256(deadline)
  );
}

// Uniswap v3 / Aerodrome CL NonfungiblePositionManager encoders & decoders
export interface UniswapV3PositionData {
  tokenId: bigint;
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
}

function decodeSignedInt24Word(hex: string, wordIndex: number): number {
  const raw = decodeAbiUint256Word(hex, wordIndex);
  if (raw === null) return 0;
  const maxSigned = 1n << 255n;
  const signed = raw >= maxSigned ? raw - (1n << 256n) : raw;
  return Number(signed);
}

export function decodeUniswapV3Position(tokenId: bigint, hex: string): UniswapV3PositionData | null {
  const clean = strip0x(hex);
  if (clean.length < 64 * 12) return null;
  const token0 = decodeAbiAddressWord('0x' + clean.slice(2 * 64, 3 * 64));
  const token1 = decodeAbiAddressWord('0x' + clean.slice(3 * 64, 4 * 64));
  const fee = decodeAbiUint256Word(hex, 4);
  const liquidity = decodeAbiUint256Word(hex, 7);
  const tokensOwed0 = decodeAbiUint256Word(hex, 10);
  const tokensOwed1 = decodeAbiUint256Word(hex, 11);
  if (!token0 || !token1 || fee === null || liquidity === null || tokensOwed0 === null || tokensOwed1 === null) {
    return null;
  }
  return {
    tokenId,
    token0,
    token1,
    fee: Number(fee),
    tickLower: decodeSignedInt24Word(hex, 5),
    tickUpper: decodeSignedInt24Word(hex, 6),
    liquidity,
    tokensOwed0,
    tokensOwed1,
  };
}

export function encodeUniswapV3DecreaseLiquidity(params: {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min?: bigint;
  amount1Min?: bigint;
  deadline: bigint;
}): string {
  return (
    DEFI_SELECTORS.decreaseLiquidity +
    padUint256(params.tokenId) +
    padUint256(params.liquidity) +
    padUint256(params.amount0Min ?? 0n) +
    padUint256(params.amount1Min ?? 0n) +
    padUint256(params.deadline)
  );
}

export function encodeUniswapV3Collect(params: {
  tokenId: bigint;
  recipient: string;
  amount0Max?: bigint;
  amount1Max?: bigint;
}): string {
  return (
    DEFI_SELECTORS.collect +
    padUint256(params.tokenId) +
    pad32Hex(params.recipient) +
    padUint256(params.amount0Max ?? MAX_UINT128) +
    padUint256(params.amount1Max ?? MAX_UINT128)
  );
}

export function encodeUniswapV3Burn(tokenId: bigint): string {
  return `${DEFI_SELECTORS.burnNft}${padUint256(tokenId)}`;
}

/**
 * Encodes `multicall(bytes[] data)` (`0xac9650d8`) for Uniswap v3 / Aerodrome CL
 * NonfungiblePositionManager so decreaseLiquidity + collect + burn execute atomically in 1 call.
 */
export function encodeMulticallBytes(innerCalls: string[]): string {
  const n = innerCalls.length;
  const header = padUint256(0x20n) + padUint256(BigInt(n));
  const encodedItems = innerCalls.map((call) => {
    const clean = strip0x(call).toLowerCase();
    const byteLen = clean.length / 2;
    const paddedLen = Math.ceil(clean.length / 64) * 64;
    return padUint256(BigInt(byteLen)) + clean.padEnd(paddedLen, '0');
  });

  const offsets: string[] = [];
  let runningBytes = n * 32;
  for (const item of encodedItems) {
    offsets.push(padUint256(BigInt(runningBytes)));
    runningBytes += item.length / 2;
  }

  return DEFI_SELECTORS.multicall + header + offsets.join('') + encodedItems.join('');
}

/**
 * Decodes `multicall(bytes[] data)` (`0xac9650d8`) back into its ordered inner calldata items
 * for verification, pre-sign proofs, and backtesting.
 */
export function decodeMulticallBytes(calldata: string): string[] {
  const clean = strip0x(calldata).toLowerCase();
  if (!clean.startsWith(strip0x(DEFI_SELECTORS.multicall)) || clean.length < 8 + 128) return [];
  const body = clean.slice(8);
  const arrayOffset = Number(BigInt('0x' + body.slice(0, 64))) * 2;
  if (body.length < arrayOffset + 64) return [];
  const count = Number(BigInt('0x' + body.slice(arrayOffset, arrayOffset + 64)));
  const tableStart = arrayOffset + 64;
  const out: string[] = [];

  for (let i = 0; i < count; i++) {
    const relOffset = Number(BigInt('0x' + body.slice(tableStart + i * 64, tableStart + (i + 1) * 64))) * 2;
    const itemStart = tableStart + relOffset;
    if (body.length < itemStart + 64) break;
    const byteLen = Number(BigInt('0x' + body.slice(itemStart, itemStart + 64)));
    const itemHex = body.slice(itemStart + 64, itemStart + 64 + byteLen * 2);
    out.push('0x' + itemHex);
  }
  return out;
}

export function buildUniswapV3NftExitCalldata(params: {
  tokenId: bigint;
  liquidity: bigint;
  recipient: string;
  deadline?: bigint;
  amount0Min?: bigint;
  amount1Min?: bigint;
  includeBurn?: boolean;
}): { data: string; innerCalls: string[] } {
  const deadline = params.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 1800);
  const innerCalls: string[] = [];
  if (params.liquidity > 0n) {
    innerCalls.push(
      encodeUniswapV3DecreaseLiquidity({
        tokenId: params.tokenId,
        liquidity: params.liquidity,
        amount0Min: params.amount0Min ?? 0n,
        amount1Min: params.amount1Min ?? 0n,
        deadline,
      })
    );
  }
  innerCalls.push(
    encodeUniswapV3Collect({
      tokenId: params.tokenId,
      recipient: params.recipient,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    })
  );
  if (params.includeBurn !== false) {
    innerCalls.push(encodeUniswapV3Burn(params.tokenId));
  }
  return {
    data: encodeMulticallBytes(innerCalls),
    innerCalls,
  };
}

// ========================== SAFE PARTIAL DEBT EXIT MATH ==========================

export interface AaveSafePartialWithdrawalResult {
  hasActiveDebt: boolean;
  canWithdrawAny: boolean;
  canWithdrawFull: boolean;
  currentHealthFactor: number;
  projectedHealthFactor: number;
  minSafeHealthFactor: number;
  safeMaxWithdrawUsd: number;
  safeMaxWithdrawRaw: bigint;
  safeMaxWithdrawUi: number;
  reason: string;
}

/**
 * Computes the maximum safe withdrawal from an Aave v3 / v2 collateral position
 * when active debt exists, keeping Health Factor >= minSafeHealthFactor (default 1.6).
 *
 * Math:
 *   HF_post = ((C - W) * LT) / D >= HF_min
 *   => W_max = C - (HF_min * D) / LT
 * Applied with a 0.5% safety buffer for borrow interest accrual & price movement.
 */
export function computeAaveSafePartialWithdrawal(params: {
  totalCollateralUsd?: number;
  totalDebtUsd: number;
  liquidationThresholdBps?: number;
  currentHealthFactor?: number;
  positionUsd: number;
  positionRawBalance: bigint;
  positionDecimals: number;
  positionPriceUsd: number;
  minSafeHealthFactor?: number;
}): AaveSafePartialWithdrawalResult {
  const minSafeHf = params.minSafeHealthFactor ?? MIN_SAFE_HEALTH_FACTOR;
  const debtUsd = Math.max(0, params.totalDebtUsd || 0);
  const lt =
    params.liquidationThresholdBps && params.liquidationThresholdBps > 0 && params.liquidationThresholdBps <= 10_000
      ? params.liquidationThresholdBps / 10_000
      : 0.8;

  if (debtUsd <= 0.01) {
    const ui = formatUnits(params.positionRawBalance, params.positionDecimals);
    return {
      hasActiveDebt: false,
      canWithdrawAny: params.positionRawBalance > 0n,
      canWithdrawFull: true,
      currentHealthFactor: 999,
      projectedHealthFactor: 999,
      minSafeHealthFactor: minSafeHf,
      safeMaxWithdrawUsd: Number(params.positionUsd.toFixed(2)),
      safeMaxWithdrawRaw: params.positionRawBalance,
      safeMaxWithdrawUi: Number(ui.toFixed(6)),
      reason: 'Zero active borrow detected — full collateral withdrawal is safe.',
    };
  }

  // Derive total collateral if only HF and debt were passed
  const currentHf =
    typeof params.currentHealthFactor === 'number' && Number.isFinite(params.currentHealthFactor)
      ? params.currentHealthFactor
      : params.totalCollateralUsd && params.totalCollateralUsd > 0
      ? (params.totalCollateralUsd * lt) / debtUsd
      : 0;

  const totalCollateralUsd =
    typeof params.totalCollateralUsd === 'number' && params.totalCollateralUsd > 0
      ? params.totalCollateralUsd
      : currentHf > 0
      ? (currentHf * debtUsd) / lt
      : params.positionUsd;

  if (currentHf <= minSafeHf + 0.01) {
    return {
      hasActiveDebt: true,
      canWithdrawAny: false,
      canWithdrawFull: false,
      currentHealthFactor: Number(currentHf.toFixed(2)),
      projectedHealthFactor: Number(currentHf.toFixed(2)),
      minSafeHealthFactor: minSafeHf,
      safeMaxWithdrawUsd: 0,
      safeMaxWithdrawRaw: 0n,
      safeMaxWithdrawUi: 0,
      reason: `Active borrow of $${debtUsd.toFixed(2)} puts Health Factor at ${currentHf.toFixed(2)} (at or below the ${minSafeHf.toFixed(1)} safety floor). Repay part of your borrow before withdrawing.`,
    };
  }

  const requiredCollateralUsd = (minSafeHf * debtUsd) / lt;
  const rawHeadroomUsd = Math.max(0, totalCollateralUsd - requiredCollateralUsd);
  // Apply 0.5% interest/oracle safety buffer
  const safeHeadroomUsd = rawHeadroomUsd * 0.995;
  const safeMaxWithdrawUsd = Number(Math.min(params.positionUsd, safeHeadroomUsd).toFixed(2));

  if (safeMaxWithdrawUsd < 1.0 || params.positionPriceUsd <= 0 || params.positionRawBalance <= 0n) {
    return {
      hasActiveDebt: true,
      canWithdrawAny: false,
      canWithdrawFull: false,
      currentHealthFactor: Number(currentHf.toFixed(2)),
      projectedHealthFactor: Number(currentHf.toFixed(2)),
      minSafeHealthFactor: minSafeHf,
      safeMaxWithdrawUsd: 0,
      safeMaxWithdrawRaw: 0n,
      safeMaxWithdrawUi: 0,
      reason: `Active borrow of $${debtUsd.toFixed(2)} leaves less than $1.00 safely withdrawable above Health Factor ${minSafeHf.toFixed(1)}. Repay borrow first.`,
    };
  }

  const canWithdrawFull = safeMaxWithdrawUsd >= params.positionUsd - 0.01;
  let safeMaxWithdrawRaw: bigint;
  if (canWithdrawFull) {
    safeMaxWithdrawRaw = params.positionRawBalance;
  } else {
    // Proportional raw amount with high precision (scaled to 1e6 bps)
    const ratioBps = BigInt(Math.floor((safeMaxWithdrawUsd / params.positionUsd) * 1_000_000));
    const computed = (params.positionRawBalance * ratioBps) / 1_000_000n;
    safeMaxWithdrawRaw = computed > params.positionRawBalance ? params.positionRawBalance : computed;
  }

  const remainingCollateralUsd = Math.max(0, totalCollateralUsd - safeMaxWithdrawUsd);
  const projectedHealthFactor = Number(((remainingCollateralUsd * lt) / debtUsd).toFixed(2));
  const safeMaxWithdrawUi = Number(formatUnits(safeMaxWithdrawRaw, params.positionDecimals).toFixed(6));

  return {
    hasActiveDebt: true,
    canWithdrawAny: safeMaxWithdrawRaw > 0n,
    canWithdrawFull,
    currentHealthFactor: Number(currentHf.toFixed(2)),
    projectedHealthFactor: Math.max(minSafeHf, projectedHealthFactor),
    minSafeHealthFactor: minSafeHf,
    safeMaxWithdrawUsd,
    safeMaxWithdrawRaw,
    safeMaxWithdrawUi,
    reason: canWithdrawFull
      ? `Safe to withdraw 100% of this position ($${safeMaxWithdrawUsd.toFixed(2)}) — your other collateral keeps Health Factor at ${projectedHealthFactor.toFixed(2)} (above ${minSafeHf.toFixed(1)}).`
      : `Safe partial exit available: withdraw up to $${safeMaxWithdrawUsd.toFixed(2)} (${safeMaxWithdrawUi} tokens) while keeping your Health Factor at ${Math.max(minSafeHf, projectedHealthFactor).toFixed(2)} (min ${minSafeHf.toFixed(1)}) against $${debtUsd.toFixed(2)} debt.`,
  };
}

export interface CompoundAccountSafety {
  checked: boolean;
  protocolId: 'compound_v3' | 'compound_v2';
  hasActiveBorrow: boolean;
  borrowBalanceRaw: bigint;
  isCollateralized: boolean;
  accountLiquidityUsd?: number;
  shortfallUsd?: number;
  safeForWithdraw: boolean;
  reason: string;
}

/**
 * Fail-closed live borrow safety check for Compound v3 (Comet `borrowBalanceOf` + `isBorrowCollateralized`)
 * and Compound v2 / Venus / Benqi (`cToken.borrowBalanceStored` + `Comptroller.getAccountLiquidity`).
 */
export async function checkCompoundAccountSafety(params: {
  chain: EvmChainId;
  userAddress: string;
  protocolId: 'compound_v3' | 'compound_v2';
  targetAddress: string;
}): Promise<CompoundAccountSafety> {
  const { chain, userAddress, protocolId, targetAddress } = params;
  const cfg = EVM_CHAINS[chain];
  if (!cfg || !/^0x[0-9a-fA-F]{40}$/.test(userAddress) || !/^0x[0-9a-fA-F]{40}$/.test(targetAddress)) {
    return {
      checked: false,
      protocolId,
      hasActiveBorrow: false,
      borrowBalanceRaw: 0n,
      isCollateralized: false,
      safeForWithdraw: false,
      reason: 'Could not verify Compound borrow status (invalid chain or contract address).',
    };
  }

  const userPad = pad32Hex(userAddress);

  if (protocolId === 'compound_v3') {
    try {
      const mc = encodeMulticall3Aggregate3([
        { target: targetAddress, allowFailure: true, callData: `${DEFI_SELECTORS.compoundV3BorrowBalanceOf}${userPad}` },
        {
          target: targetAddress,
          allowFailure: true,
          callData: `${DEFI_SELECTORS.compoundV3IsBorrowCollateralized}${userPad}`,
        },
      ]);
      const res = await evmJsonRpcCall<string>(
        cfg.rpcUrls,
        'eth_call',
        [{ to: cfg.multicall3, data: mc }, 'latest'],
        3500
      );
      if (!res.result || res.result === '0x') {
        return {
          checked: false,
          protocolId,
          hasActiveBorrow: false,
          borrowBalanceRaw: 0n,
          isCollateralized: false,
          safeForWithdraw: false,
          reason: 'Compound v3 borrow safety check returned empty data — pausing withdrawal for safety.',
        };
      }
      const dec = decodeMulticall3Aggregate3(res.result);
      const borrowRaw = dec[0]?.success ? decodeAbiUint256Word(dec[0].returnData) : null;
      const collat = dec[1]?.success ? decodeAbiBoolWord(dec[1].returnData) : null;
      if (borrowRaw === null) {
        return {
          checked: false,
          protocolId,
          hasActiveBorrow: false,
          borrowBalanceRaw: 0n,
          isCollateralized: false,
          safeForWithdraw: false,
          reason: 'Compound v3 borrowBalanceOf check failed — pausing withdrawal to prevent liquidation.',
        };
      }
      const hasActiveBorrow = borrowRaw > 0n;
      return {
        checked: true,
        protocolId,
        hasActiveBorrow,
        borrowBalanceRaw: borrowRaw,
        isCollateralized: collat !== false,
        safeForWithdraw: !hasActiveBorrow,
        reason: hasActiveBorrow
          ? 'Active Compound v3 borrow detected on this market. Repay your borrow before withdrawing collateral to avoid revert or liquidation.'
          : 'Verified onchain: zero active Compound v3 borrow on this market.',
      };
    } catch {
      return {
        checked: false,
        protocolId,
        hasActiveBorrow: false,
        borrowBalanceRaw: 0n,
        isCollateralized: false,
        safeForWithdraw: false,
        reason: 'Compound v3 borrow check timed out on RPC — pausing withdrawal for safety.',
      };
    }
  }

  // Compound v2 / Venus / Benqi
  try {
    const mc = encodeMulticall3Aggregate3([
      {
        target: targetAddress,
        allowFailure: true,
        callData: `${DEFI_SELECTORS.compoundV2BorrowBalanceStored}${userPad}`,
      },
      { target: targetAddress, allowFailure: true, callData: DEFI_SELECTORS.compoundV2Comptroller },
    ]);
    const res = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: mc }, 'latest'],
      3500
    );
    if (!res.result || res.result === '0x') {
      return {
        checked: false,
        protocolId,
        hasActiveBorrow: false,
        borrowBalanceRaw: 0n,
        isCollateralized: false,
        safeForWithdraw: false,
        reason: 'Compound v2 borrow check returned empty data — pausing withdrawal for safety.',
      };
    }
    const dec = decodeMulticall3Aggregate3(res.result);
    const borrowRaw = dec[0]?.success ? decodeAbiUint256Word(dec[0].returnData) : null;
    const comptroller = dec[1]?.success ? decodeAbiAddressWord(dec[1].returnData) : null;
    if (borrowRaw === null) {
      return {
        checked: false,
        protocolId,
        hasActiveBorrow: false,
        borrowBalanceRaw: 0n,
        isCollateralized: false,
        safeForWithdraw: false,
        reason: 'Could not read Compound v2 borrow balance — pausing withdrawal for safety.',
      };
    }

    let accountLiquidityUsd: number | undefined;
    let shortfallUsd: number | undefined;
    if (comptroller) {
      const liqRes = await evmJsonRpcCall<string>(
        cfg.rpcUrls,
        'eth_call',
        [{ to: comptroller, data: `${DEFI_SELECTORS.compoundV2GetAccountLiquidity}${userPad}` }, 'latest'],
        3500
      ).catch(() => ({ result: undefined }));
      if (liqRes.result && liqRes.result !== '0x') {
        const errCode = decodeAbiUint256Word(liqRes.result, 0);
        const liqRaw = decodeAbiUint256Word(liqRes.result, 1);
        const shortRaw = decodeAbiUint256Word(liqRes.result, 2);
        if (errCode === 0n && liqRaw !== null && shortRaw !== null) {
          accountLiquidityUsd = Number(formatUnits(liqRaw, 18).toFixed(2));
          shortfallUsd = Number(formatUnits(shortRaw, 18).toFixed(2));
        }
      }
    }

    const hasShortfall = (shortfallUsd ?? 0) > 0;
    const hasActiveBorrow = borrowRaw > 0n || hasShortfall;
    return {
      checked: true,
      protocolId,
      hasActiveBorrow,
      borrowBalanceRaw: borrowRaw,
      isCollateralized: !hasShortfall,
      accountLiquidityUsd,
      shortfallUsd,
      safeForWithdraw: !hasActiveBorrow,
      reason: hasShortfall
        ? `Account has a $${shortfallUsd?.toFixed(2)} collateral shortfall — repay borrow before redeeming.`
        : hasActiveBorrow
        ? 'Active borrow detected on this Compound v2 / fork market. Repay your borrow before redeeming collateral.'
        : 'Verified onchain: zero active borrow and healthy collateral on Compound v2 market.',
    };
  } catch {
    return {
      checked: false,
      protocolId,
      hasActiveBorrow: false,
      borrowBalanceRaw: 0n,
      isCollateralized: false,
      safeForWithdraw: false,
      reason: 'Compound v2 borrow safety check timed out on RPC — pausing withdrawal for safety.',
    };
  }
}

// ========================== LIVE MULTICALL3 PROBERS ==========================

export interface Erc4626VaultState {
  vaultAddress: string;
  underlyingAddress: string | null;
  sharesRaw: bigint;
  onchainBalanceRaw?: bigint | null;
  convertToAssetsRaw: bigint | null;
  previewRedeemRaw: bigint | null;
  expectedUnderlyingRaw: bigint;
  verifiedUnderlyingOutput?: boolean;
  maxRedeemRaw: bigint | null;
  cooldownDurationSec: number | null;
  cooldownDetected: boolean;
  shareExchangeRate: number; // underlying units per 1 share unit
}

/**
 * Queries ERC-4626 vault state for one or more vaults on a chain in a SINGLE Multicall3 batch:
 *   - asset()
 *   - convertToAssets(shares)
 *   - previewRedeem(shares)
 *   - maxRedeem(owner)
 *   - cooldownDuration() (Ethena sUSDe and cooldown-enabled ERC-4626 vaults)
 *   - balanceOf(owner) (distinguishes real pause/cooldown from zero onchain wallet balance!)
 */
export async function probeErc4626VaultStates(params: {
  chain: EvmChainId;
  owner: string;
  vaults: Array<{
    address: string;
    rawBalance: bigint;
    decimals: number;
    underlyingDecimals?: number;
  }>;
}): Promise<Map<string, Erc4626VaultState>> {
  const out = new Map<string, Erc4626VaultState>();
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg || !params.vaults.length) return out;

  const ownerBalData = `${DEFI_SELECTORS.balanceOf}${pad32Hex(params.owner)}`;
  const calls = params.vaults.flatMap((v) => {
    const shares = v.rawBalance > 0n ? v.rawBalance : 10n ** BigInt(v.decimals);
    return [
      { target: v.address, allowFailure: true, callData: DEFI_SELECTORS.asset },
      { target: v.address, allowFailure: true, callData: encodeErc4626ConvertToAssets(shares) },
      { target: v.address, allowFailure: true, callData: encodeErc4626PreviewRedeem(shares) },
      { target: v.address, allowFailure: true, callData: encodeErc4626MaxRedeem(params.owner) },
      { target: v.address, allowFailure: true, callData: DEFI_SELECTORS.cooldownDuration },
      { target: v.address, allowFailure: true, callData: ownerBalData },
    ];
  });

  try {
    const mcData = encodeMulticall3Aggregate3(calls);
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: mcData }, 'latest'],
      4000
    );
    if (!json.result || json.result === '0x') return out;
    const decoded = decodeMulticall3Aggregate3(json.result);

    for (let i = 0; i < params.vaults.length; i++) {
      const v = params.vaults[i];
      const base = i * 6;
      const rAsset = decoded[base];
      const rConvert = decoded[base + 1];
      const rPreview = decoded[base + 2];
      const rMax = decoded[base + 3];
      const rCooldown = decoded[base + 4];
      const rBalance = decoded[base + 5];

      const underlyingAddress = rAsset?.success ? decodeAbiAddressWord(rAsset.returnData) : null;
      const convertToAssetsRaw = rConvert?.success ? decodeAbiUint256Word(rConvert.returnData) : null;
      const previewRedeemRaw = rPreview?.success ? decodeAbiUint256Word(rPreview.returnData) : null;
      const maxRedeemRaw = rMax?.success ? decodeAbiUint256Word(rMax.returnData) : null;
      const cooldownBig = rCooldown?.success ? decodeAbiUint256Word(rCooldown.returnData) : null;
      const onchainBalanceRaw = rBalance?.success ? decodeAbiUint256Word(rBalance.returnData) : null;
      const cooldownDurationSec = cooldownBig !== null ? Number(cooldownBig) : null;

      const shares = v.rawBalance > 0n ? v.rawBalance : 10n ** BigInt(v.decimals);
      const verifiedUnderlyingOutput = previewRedeemRaw !== null || convertToAssetsRaw !== null;
      const expectedUnderlyingRaw = previewRedeemRaw ?? convertToAssetsRaw ?? 0n;

      // Cooldown / pause detection:
      // 1) Explicit cooldownDuration() > 0 (e.g. Ethena sUSDe = 86400s / 604800s)
      // 2) maxRedeem(owner) == 0 ONLY when user actually holds onchain balanceOf(owner) > 0
      // 3) previewRedeem(shares) reverted while convertToAssets(shares) succeeded (paused/locked ERC-4626)
      // 4) Known cooldown vault address (Ethena sUSDe)
      const userHoldsOnchainShares = onchainBalanceRaw !== null ? onchainBalanceRaw > 0n : v.rawBalance > 0n;
      const cooldownDetected = Boolean(
        (cooldownDurationSec !== null && cooldownDurationSec > 0) ||
          (userHoldsOnchainShares && maxRedeemRaw !== null && maxRedeemRaw === 0n) ||
          (convertToAssetsRaw !== null && !rPreview?.success) ||
          KNOWN_COOLDOWN_VAULT_ADDRESSES.has(v.address.toLowerCase())
      );

      const uDec = v.underlyingDecimals ?? v.decimals;
      const sharesUi = formatUnits(shares, v.decimals);
      const underlyingUi = formatUnits(expectedUnderlyingRaw, uDec);
      const shareExchangeRate = sharesUi > 0 ? Number((underlyingUi / sharesUi).toFixed(6)) : 1;

      out.set(v.address.toLowerCase(), {
        vaultAddress: v.address,
        underlyingAddress,
        sharesRaw: v.rawBalance,
        onchainBalanceRaw,
        convertToAssetsRaw,
        previewRedeemRaw,
        expectedUnderlyingRaw,
        verifiedUnderlyingOutput,
        maxRedeemRaw,
        cooldownDurationSec,
        cooldownDetected,
        shareExchangeRate,
      });
    }
  } catch {
    // Non-fatal: caller falls back gracefully
  }

  return out;
}

export interface ExpandedDefiProbeMatch {
  protocolId: DefiProtocolExtractorId;
  protocol: string;
  protocolAddress: string;
  underlyingAddress: string;
  secondaryUnderlyingAddress?: string;
  exchangeRateStored?: bigint;
  expectedUnderlyingRaw?: bigint;
  expectedSecondaryRaw?: bigint;
  lpRouterAddress?: string;
  lpStable?: boolean;
  reserve0?: bigint;
  reserve1?: bigint;
  totalSupply?: bigint;
}

/**
 * Probes arbitrary discovered ERC-20 tokens in ONE Multicall3 batch to automatically detect:
 *  - Aave v3 aToken (`UNDERLYING_ASSET_ADDRESS()` + `POOL()`)
 *  - Aave v2 aToken (`UNDERLYING_ASSET_ADDRESS()` + `LENDING_POOL()`)
 *  - ERC-4626 Vault (`asset()`)
 *  - Compound v2 / Venus / Benqi cToken (`underlying()` + `exchangeRateStored()` + `comptroller()`)
 *  - Uniswap v2 / Sushi / Aerodrome v2 LP (`token0()` + `token1()` + `getReserves()` + `totalSupply()` + `factory()` + `stable()`)
 */
export async function probeExpandedDefiContracts(params: {
  chain: EvmChainId;
  tokenAddresses: string[];
  rawBalances?: Map<string, bigint>;
}): Promise<Map<string, ExpandedDefiProbeMatch>> {
  const detected = new Map<string, ExpandedDefiProbeMatch>();
  const cfg = EVM_CHAINS[params.chain];
  const unique = Array.from(
    new Set(
      params.tokenAddresses
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        .map((a) => a.toLowerCase())
    )
  ).slice(0, 16);

  if (!cfg || !unique.length) return detected;

  // 15 probes per token in 1 Multicall3 batch
  const PROBES_PER_TOKEN = 15;
  const calls = unique.flatMap((target) => [
    { target, allowFailure: true, callData: DEFI_SELECTORS.aaveUnderlyingAsset }, // 0
    { target, allowFailure: true, callData: DEFI_SELECTORS.aaveV3Pool }, // 1
    { target, allowFailure: true, callData: DEFI_SELECTORS.aaveV2LendingPool }, // 2
    { target, allowFailure: true, callData: DEFI_SELECTORS.asset }, // 3
    { target, allowFailure: true, callData: DEFI_SELECTORS.compoundV2Underlying }, // 4
    { target, allowFailure: true, callData: DEFI_SELECTORS.compoundV2ExchangeRateStored }, // 5
    { target, allowFailure: true, callData: DEFI_SELECTORS.compoundV2Comptroller }, // 6
    { target, allowFailure: true, callData: DEFI_SELECTORS.token0 }, // 7
    { target, allowFailure: true, callData: DEFI_SELECTORS.token1 }, // 8
    { target, allowFailure: true, callData: DEFI_SELECTORS.getReserves }, // 9
    { target, allowFailure: true, callData: DEFI_SELECTORS.totalSupply }, // 10
    { target, allowFailure: true, callData: DEFI_SELECTORS.factory }, // 11
    { target, allowFailure: true, callData: DEFI_SELECTORS.stable }, // 12
    { target, allowFailure: true, callData: DEFI_SELECTORS.yearnV2Token }, // 13
    { target, allowFailure: true, callData: DEFI_SELECTORS.yearnV2PricePerShare }, // 14
  ]);

  try {
    const mcData = encodeMulticall3Aggregate3(calls);
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: mcData }, 'latest'],
      4200
    );
    if (!json.result || json.result === '0x') return detected;
    const results = decodeMulticall3Aggregate3(json.result);
    const chainRouters = V2_DEX_ROUTERS[params.chain] ?? [];

    const aaveCandidates: Array<{
      tokenAddress: string;
      poolAddress: string;
      underlyingAddress: string;
      version: 'v3' | 'v2';
    }> = [];
    const erc4626Candidates: Array<{
      vaultAddress: string;
      underlyingAddress: string;
      userShares: bigint;
    }> = [];

    for (let i = 0; i < unique.length; i++) {
      const addr = unique[i];
      const base = i * PROBES_PER_TOKEN;
      const lpBal = params.rawBalances?.get(addr) ?? 0n;

      const aaveUnderlying = results[base]?.success ? decodeAbiAddressWord(results[base].returnData) : null;
      const aaveV3Pool = results[base + 1]?.success ? decodeAbiAddressWord(results[base + 1].returnData) : null;
      const aaveV2Pool = results[base + 2]?.success ? decodeAbiAddressWord(results[base + 2].returnData) : null;

      if (aaveUnderlying && aaveV3Pool) {
        const check = validateTrustedProtocolTarget({
          chain: params.chain,
          protocolId: 'aave_v3',
          assetAddress: addr,
          protocolAddress: aaveV3Pool,
        });
        if (check.trusted) {
          aaveCandidates.push({
            tokenAddress: addr,
            poolAddress: aaveV3Pool,
            underlyingAddress: aaveUnderlying,
            version: 'v3',
          });
        }
        continue;
      }

      if (aaveUnderlying && aaveV2Pool) {
        const check = validateTrustedProtocolTarget({
          chain: params.chain,
          protocolId: 'aave_v2',
          assetAddress: addr,
          protocolAddress: aaveV2Pool,
        });
        if (check.trusted) {
          aaveCandidates.push({
            tokenAddress: addr,
            poolAddress: aaveV2Pool,
            underlyingAddress: aaveUnderlying,
            version: 'v2',
          });
        }
        continue;
      }

      const erc4626Asset = results[base + 3]?.success ? decodeAbiAddressWord(results[base + 3].returnData) : null;
      if (erc4626Asset && erc4626Asset.toLowerCase() !== addr.toLowerCase()) {
        if (isCuratedDefiVault(params.chain, addr)) {
          detected.set(addr, {
            protocolId: 'erc4626',
            protocol: 'ERC-4626 Vault',
            protocolAddress: addr,
            underlyingAddress: erc4626Asset,
          });
        } else {
          erc4626Candidates.push({
            vaultAddress: addr,
            underlyingAddress: erc4626Asset,
            userShares: lpBal,
          });
        }
        continue;
      }

      const cUnderlying = results[base + 4]?.success ? decodeAbiAddressWord(results[base + 4].returnData) : null;
      const cRate = results[base + 5]?.success ? decodeAbiUint256Word(results[base + 5].returnData) : null;
      const cComptroller = results[base + 6]?.success ? decodeAbiAddressWord(results[base + 6].returnData) : null;
      const trustedComptrollers = new Set(
        (COMPOUND_V2_COMPTROLLERS[params.chain] ?? []).map((c) => c.toLowerCase())
      );
      if (
        cUnderlying &&
        cComptroller &&
        trustedComptrollers.has(cComptroller.toLowerCase()) &&
        cRate !== null &&
        cRate > 0n
      ) {
        const protocolLabel =
          params.chain === 'bnb'
            ? 'Venus (Compound v2)'
            : params.chain === 'avalanche'
            ? 'Benqi (Compound v2)'
            : 'Compound v2';
        detected.set(addr, {
          protocolId: 'compound_v2',
          protocol: protocolLabel,
          protocolAddress: addr,
          underlyingAddress: cUnderlying,
          exchangeRateStored: cRate,
          expectedUnderlyingRaw: lpBal > 0n ? computeCompoundV2UnderlyingRaw(lpBal, cRate) : undefined,
        });
        continue;
      }

      const token0 = results[base + 7]?.success ? decodeAbiAddressWord(results[base + 7].returnData) : null;
      const token1 = results[base + 8]?.success ? decodeAbiAddressWord(results[base + 8].returnData) : null;
      const reserves = results[base + 9]?.success ? decodeUniswapV2Reserves(results[base + 9].returnData) : null;
      const totalSupply = results[base + 10]?.success ? decodeAbiUint256Word(results[base + 10].returnData) : null;
      const factoryAddr = results[base + 11]?.success ? decodeAbiAddressWord(results[base + 11].returnData) : null;
      const stableFlag = results[base + 12]?.success ? decodeAbiBoolWord(results[base + 12].returnData) : null;

      if (token0 && token1 && reserves && totalSupply && totalSupply > 0n && factoryAddr) {
        const matchedRouter = chainRouters.find(
          (r) => r.factory.toLowerCase() === factoryAddr.toLowerCase()
        );
        if (!matchedRouter) {
          continue;
        }
        const amounts =
          lpBal > 0n
            ? computeUniswapV2UnderlyingAmounts({
                lpBalance: lpBal,
                totalSupply,
                reserve0: reserves.reserve0,
                reserve1: reserves.reserve1,
              })
            : null;
        detected.set(addr, {
          protocolId: 'uniswap_v2_lp',
          protocol: `${matchedRouter.name} LP`,
          protocolAddress: matchedRouter.router,
          underlyingAddress: token0,
          secondaryUnderlyingAddress: token1,
          lpRouterAddress: matchedRouter.router,
          lpStable: matchedRouter.isAerodromeStyle ? Boolean(stableFlag) : undefined,
          reserve0: reserves.reserve0,
          reserve1: reserves.reserve1,
          totalSupply,
          expectedUnderlyingRaw: amounts?.amount0,
          expectedSecondaryRaw: amounts?.amount1,
        });
        continue;
      }

      const yearnToken = results[base + 13]?.success ? decodeAbiAddressWord(results[base + 13].returnData) : null;
      const yearnPps = results[base + 14]?.success ? decodeAbiUint256Word(results[base + 14].returnData) : null;
      if (yearnToken && yearnToken.toLowerCase() !== addr.toLowerCase() && yearnPps !== null && yearnPps > 0n) {
        detected.set(addr, {
          protocolId: 'yearn_v2',
          protocol: 'Yearn v2',
          protocolAddress: addr,
          underlyingAddress: yearnToken,
          exchangeRateStored: yearnPps,
        });
      }
    }

    // Pass 2 (CRIT-02 authentication):
    //  - Verify Aave v3/v2 candidates via POOL.getReserveData(underlying) (`0x35ea6a75`) so
    //    variableDebt* / stableDebt* tokens and spoofed contracts are NEVER classified as collateral!
    //  - Verify non-curated ERC-4626 candidates prove real totalAssets(), convertToAssets(),
    //    and real underlying token backing (`underlying.balanceOf(vault)`) before accepting.
    if (aaveCandidates.length > 0 || erc4626Candidates.length > 0) {
      const verifyCalls: Array<{ target: string; allowFailure: boolean; callData: string }> = [];
      for (const c of aaveCandidates) {
        verifyCalls.push({
          target: c.poolAddress,
          allowFailure: true,
          callData: encodeAaveGetReserveData(c.underlyingAddress),
        });
      }
      for (const v of erc4626Candidates) {
        const probeShares = v.userShares > 0n ? v.userShares : 1n;
        verifyCalls.push(
          { target: v.vaultAddress, allowFailure: true, callData: DEFI_SELECTORS.erc4626TotalAssets },
          { target: v.vaultAddress, allowFailure: true, callData: encodeErc4626ConvertToAssets(probeShares) },
          {
            target: v.underlyingAddress,
            allowFailure: true,
            callData: `${DEFI_SELECTORS.balanceOf}${pad32Hex(v.vaultAddress)}`,
          }
        );
      }

      const verifyMc = encodeMulticall3Aggregate3(verifyCalls);
      const verifyJson = await evmJsonRpcCall<string>(
        cfg.rpcUrls,
        'eth_call',
        [{ to: cfg.multicall3, data: verifyMc }, 'latest'],
        4000
      );
      if (verifyJson.result && verifyJson.result !== '0x') {
        const verifyDecoded = decodeMulticall3Aggregate3(verifyJson.result);

        for (let i = 0; i < aaveCandidates.length; i++) {
          const c = aaveCandidates[i];
          const r = verifyDecoded[i];
          if (!r?.success) continue;
          const decoded =
            c.version === 'v3'
              ? decodeAaveV3ReserveData(r.returnData)
              : decodeAaveV2ReserveData(r.returnData);
          if (!decoded?.aTokenAddress) continue;
          const tokenLower = c.tokenAddress.toLowerCase();
          if (
            decoded.variableDebtTokenAddress?.toLowerCase() === tokenLower ||
            decoded.stableDebtTokenAddress?.toLowerCase() === tokenLower
          ) {
            continue;
          }
          if (decoded.aTokenAddress.toLowerCase() === tokenLower) {
            detected.set(tokenLower, {
              protocolId: c.version === 'v3' ? 'aave_v3' : 'aave_v2',
              protocol: c.version === 'v3' ? 'Aave v3' : 'Aave v2',
              protocolAddress: c.poolAddress,
              underlyingAddress: c.underlyingAddress,
            });
          }
        }

        const ercOffset = aaveCandidates.length;
        for (let i = 0; i < erc4626Candidates.length; i++) {
          const v = erc4626Candidates[i];
          const baseIdx = ercOffset + i * 3;
          const rTotalAssets = verifyDecoded[baseIdx];
          const rConvert = verifyDecoded[baseIdx + 1];
          const rUnderlyingBal = verifyDecoded[baseIdx + 2];

          const totalAssets = rTotalAssets?.success ? decodeAbiUint256Word(rTotalAssets.returnData) : null;
          const convertAssets = rConvert?.success ? decodeAbiUint256Word(rConvert.returnData) : null;
          const underlyingBal = rUnderlyingBal?.success
            ? decodeAbiUint256Word(rUnderlyingBal.returnData)
            : null;

          if (
            totalAssets === null ||
            totalAssets <= 0n ||
            convertAssets === null ||
            convertAssets <= 0n ||
            underlyingBal === null ||
            underlyingBal <= 0n
          ) {
            continue;
          }
          // Reject spoofed vaults claiming more redeemable underlying than they actually hold
          if (v.userShares > 0n && underlyingBal < convertAssets) {
            continue;
          }
          detected.set(v.vaultAddress.toLowerCase(), {
            protocolId: 'erc4626',
            protocol: 'ERC-4626 Vault',
            protocolAddress: v.vaultAddress,
            underlyingAddress: v.underlyingAddress,
            expectedUnderlyingRaw: v.userShares > 0n ? convertAssets : undefined,
          });
        }
      }
    }
  } catch {
    // non-fatal probe
  }

  return detected;
}

export interface DiscoveredUniswapV3NftPosition {
  chain: EvmChainId;
  protocol: string;
  managerAddress: string;
  position: UniswapV3PositionData;
}

/**
 * Discovers active Uniswap v3 / Aerodrome CL NFT positions owned by `walletAddress` on a chain
 * using Multicall3 (`balanceOf` -> `tokenOfOwnerByIndex` -> `positions`).
 */
export async function discoverUniswapV3NftPositions(
  chain: EvmChainId,
  walletAddress: string,
  maxPerManager = 6
): Promise<DiscoveredUniswapV3NftPosition[]> {
  const cfg = EVM_CHAINS[chain];
  const managers = UNISWAP_V3_NFT_MANAGERS[chain];
  if (!cfg || !managers?.length) return [];

  const out: DiscoveredUniswapV3NftPosition[] = [];
  const balCallData = `${DEFI_SELECTORS.balanceOf}${pad32Hex(walletAddress)}`;

  try {
    // 1. Check NFT count across all managers on this chain in 1 Multicall3
    const countMc = encodeMulticall3Aggregate3(
      managers.map((m) => ({ target: m.address, allowFailure: true, callData: balCallData }))
    );
    const countRes = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: countMc }, 'latest'],
      3500
    );
    if (!countRes.result || countRes.result === '0x') return out;
    const countDecoded = decodeMulticall3Aggregate3(countRes.result);

    const indexCalls: Array<{ manager: NftPositionManagerConfig; index: number }> = [];
    managers.forEach((m, idx) => {
      const item = countDecoded[idx];
      if (!item?.success) return;
      const count = decodeAbiUint256Word(item.returnData);
      if (!count || count <= 0n) return;
      const capped = Number(count > BigInt(maxPerManager) ? BigInt(maxPerManager) : count);
      for (let k = 0; k < capped; k++) {
        indexCalls.push({ manager: m, index: k });
      }
    });
    if (!indexCalls.length) return out;

    // 2. Fetch tokenIds via tokenOfOwnerByIndex(owner, i)
    const idMc = encodeMulticall3Aggregate3(
      indexCalls.map((c) => ({
        target: c.manager.address,
        allowFailure: true,
        callData: `${DEFI_SELECTORS.tokenOfOwnerByIndex}${pad32Hex(walletAddress)}${padUint256(BigInt(c.index))}`,
      }))
    );
    const idRes = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: idMc }, 'latest'],
      3500
    );
    if (!idRes.result || idRes.result === '0x') return out;
    const idDecoded = decodeMulticall3Aggregate3(idRes.result);

    const tokenIds: Array<{ manager: NftPositionManagerConfig; tokenId: bigint }> = [];
    indexCalls.forEach((c, idx) => {
      const item = idDecoded[idx];
      if (!item?.success) return;
      const tid = decodeAbiUint256Word(item.returnData);
      if (tid !== null && tid > 0n) {
        tokenIds.push({ manager: c.manager, tokenId: tid });
      }
    });
    if (!tokenIds.length) return out;

    // 3. Read positions(tokenId) in 1 Multicall3
    const posMc = encodeMulticall3Aggregate3(
      tokenIds.map((t) => ({
        target: t.manager.address,
        allowFailure: true,
        callData: `${DEFI_SELECTORS.positions}${padUint256(t.tokenId)}`,
      }))
    );
    const posRes = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: posMc }, 'latest'],
      3500
    );
    if (!posRes.result || posRes.result === '0x') return out;
    const posDecoded = decodeMulticall3Aggregate3(posRes.result);

    tokenIds.forEach((t, idx) => {
      const item = posDecoded[idx];
      if (!item?.success) return;
      const pos = decodeUniswapV3Position(t.tokenId, item.returnData);
      if (!pos) return;
      if (pos.liquidity > 0n || pos.tokensOwed0 > 0n || pos.tokensOwed1 > 0n) {
        out.push({
          chain,
          protocol: t.manager.protocol,
          managerAddress: t.manager.address,
          position: pos,
        });
      }
    });
  } catch {
    // non-fatal
  }

  return out;
}

// ========================== SMART EXIT ROUTER ==========================

export function identifyProtocolExtractorId(asset: Pick<
  ScannedAsset,
  | 'protocol'
  | 'symbol'
  | 'address'
  | 'nftTokenId'
  | 'lpToken0Address'
  | 'lpToken1Address'
  | 'defiPositionType'
  | 'defiExitPlan'
>): DefiProtocolExtractorId {
  if (asset.defiExitPlan?.protocolId === 'external_protocol') {
    return 'external_protocol';
  }
  const proto = (asset.protocol ?? '').toLowerCase();
  if (asset.nftTokenId || proto.includes('uniswap v3') || proto.includes('aerodrome cl')) {
    return 'uniswap_v3_nft';
  }
  if (
    (asset.lpToken0Address && asset.lpToken1Address) ||
    proto.includes('uniswap v2') ||
    proto.includes('sushiswap') ||
    proto.includes('aerodrome v2') ||
    proto.includes('velodrome') ||
    proto.includes('pancakeswap') ||
    proto.includes('quickswap') ||
    proto.includes(' lp')
  ) {
    if (asset.defiPositionType && !(asset.lpToken0Address && asset.lpToken1Address)) {
      return 'external_protocol';
    }
    return 'uniswap_v2_lp';
  }
  if (proto.includes('yearn v2') || proto.includes('yearn2')) return 'yearn_v2';
  if (proto.includes('aave v2')) return 'aave_v2';
  if (proto.includes('aave')) return 'aave_v3';
  if (proto.includes('compound v2') || proto.includes('venus') || proto.includes('benqi')) {
    return 'compound_v2';
  }
  if (proto.includes('compound')) return 'compound_v3';
  if (
    proto.includes('erc-4626') ||
    proto.includes('erc4626') ||
    proto.includes('spark') ||
    proto.includes('sky') ||
    proto.includes('morpho') ||
    proto.includes('ethena') ||
    proto.includes('yearn') ||
    proto.includes('fluid') ||
    proto.includes('euler') ||
    proto.includes('vault')
  ) {
    return 'erc4626';
  }
  if (isLiquidReceiptToken(asset.symbol, asset.address)) {
    return 'liquid_receipt';
  }
  if (asset.defiPositionType) {
    return 'external_protocol';
  }
  return 'erc4626';
}

export interface ResolveDefiExitPlanInput {
  asset: Pick<
    ScannedAsset,
    | 'chain'
    | 'address'
    | 'symbol'
    | 'decimals'
    | 'protocol'
    | 'protocolAddress'
    | 'protocolUrl'
    | 'protocolLogoUrl'
    | 'underlyingSymbol'
    | 'underlyingAddress'
    | 'rawBalance'
    | 'uiBalance'
    | 'priceUsd'
    | 'grossUsd'
    | 'liquidityUsd'
    | 'aaveDebtUsd'
    | 'aaveHealthFactor'
    | 'aaveTotalCollateralUsd'
    | 'aaveLiquidationThresholdBps'
    | 'compoundDebtUsd'
    | 'compoundShortfallUsd'
    | 'lpToken0Address'
    | 'lpToken0Symbol'
    | 'lpToken0Decimals'
    | 'lpToken1Address'
    | 'lpToken1Symbol'
    | 'lpToken1Decimals'
    | 'lpRouterAddress'
    | 'nftTokenId'
    | 'nftLiquidity'
    | 'nftManagerAddress'
    | 'defiPositionType'
    | 'defiDebtUsd'
    | 'defiHealthFactor'
    | 'defiUnlockAt'
    | 'defiNetUsd'
    | 'defiDebtSummary'
    | 'defiExitPlan'
  >;
  outputAsset?: 'USDC' | 'SOL';
  vaultState?: Erc4626VaultState;
  aaveSafety?: AaveAccountSafety;
  compoundSafety?: CompoundAccountSafety;
  expectedUnderlyingRaw?: bigint;
  expectedUnderlyingUi?: number;
  expectedSecondaryRaw?: bigint;
  expectedSecondaryUi?: number;
  preflightStatus?: DefiPreflightStatus;
  preflightReason?: string;
  simulatedLive?: boolean;
  simulatedAtBlock?: number;
}

/**
 * Smart Exit Router: computes the optimal, plain-English `DefiExitPlan` for any DeFi asset:
 *  - Security check: blocks any spoofed/untrusted `protocolAddress` before building calldata
 *  - Liquid receipt tokens with deep DEX liquidity (wstETH, rETH, cbETH, weETH, ezETH, sUSDe, sDAI, sUSDS, stETH)
 *    -> `direct_swap` / `direct_swap_bypass_cooldown` (1 tx, instant, skips cooldowns & unwrap gas!)
 *  - Cooldown-locked vaults WITHOUT deep DEX liquidity -> `unbonding_required` / `cooldown_blocked`
 *  - Aave v3/v2 with active debt -> `partial_unwind` / `safe_partial_debt_exit` (keeping HF >= 1.6) or `blocked`
 *  - Compound v3/v2 with active borrow or RPC check failure -> `blocked` (fail-closed)
 *  - Illiquid protocol receipts (Aave, Compound v2/v3, Morpho/Yearn/Fluid/Euler ERC-4626, Uni v2/v3 LP)
 *    -> `protocol_unwind` / `instant_1click_unwind`
 */
export function resolveDefiExitPlan(input: ResolveDefiExitPlanInput): DefiExitPlan {
  const { asset, outputAsset = 'USDC', vaultState, aaveSafety, compoundSafety } = input;
  const protocolId = identifyProtocolExtractorId(asset);
  const protocolName = asset.protocol || 'DeFi Protocol';
  const rawBal = BigInt(asset.rawBalance || '0');
  const liquidReceipt = getLiquidReceiptInfo(asset.symbol, asset.address);
  const hasDeepDexLiquidity =
    Boolean(liquidReceipt) && (asset.liquidityUsd >= 50_000 || asset.liquidityUsd === 0);

  // 0. Protocol-indexed external positions (e.g. 40 Acres lending, Wayfinder lock, Carbon deposit, Velodrome veNFT)
  // Always surfaced transparently with exact debt/lock/value metadata — never blindly executed with synthetic calldata.
  if (protocolId === 'external_protocol') {
    const uSym = asset.underlyingSymbol ?? asset.symbol;
    const posType = asset.defiPositionType || 'Position';
    const debtUsd = Number(asset.defiDebtUsd ?? 0);
    const netUsd =
      typeof asset.defiNetUsd === 'number'
        ? asset.defiNetUsd
        : Number(Math.max(0, asset.grossUsd - debtUsd).toFixed(2));
    const nowSec = Math.floor(Date.now() / 1000);
    const isTimeLocked = Boolean(
      (asset.defiUnlockAt && asset.defiUnlockAt > nowSec) ||
        posType.toLowerCase().includes('lock')
    );

    if (isTimeLocked) {
      const unlockDateStr = asset.defiUnlockAt
        ? new Date(asset.defiUnlockAt * 1000).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
          })
        : null;
      return {
        protocolId: 'external_protocol',
        protocolName,
        routeKind: 'unbonding_required',
        exitStrategy: 'cooldown_blocked',
        preflightStatus: 'blocked',
        preflightReason:
          input.preflightReason ||
          (unlockDateStr
            ? `Locked on ${protocolName} until ${unlockDateStr} (${asset.uiBalance} ${uSym} · $${asset.grossUsd.toFixed(2)}). Manage unlock on ${protocolName}.`
            : `Locked ${posType.toLowerCase()} position on ${protocolName} (${asset.uiBalance} ${uSym} · $${asset.grossUsd.toFixed(2)}). Unlock on ${protocolName} before bridging.`),
        plainEnglishSteps: [
          unlockDateStr
            ? `Wait until ${unlockDateStr} and unlock ${asset.uiBalance} ${uSym} on ${protocolName}`
            : `Unlock ${asset.uiBalance} ${uSym} directly on ${protocolName}`,
          `Return to Turgalium to sweep unlocked ${uSym} to Solana ${outputAsset}`,
        ],
        cooldownDetected: true,
        underlyingSymbol: uSym,
        underlyingAddress: asset.underlyingAddress,
        underlyingDecimals: asset.decimals,
        supportsAtomicBatch: false,
        protocolUrl: asset.protocolUrl,
        protocolLogoUrl: asset.protocolLogoUrl,
        positionType: posType,
        debtUsd: debtUsd > 0 ? debtUsd : undefined,
        netUsd,
        unlockAt: asset.defiUnlockAt,
        debtSummary: asset.defiDebtSummary,
        simulatedLive: input.simulatedLive,
        simulatedAtBlock: input.simulatedAtBlock,
      };
    }

    if (debtUsd > 0) {
      const hfPart =
        typeof asset.defiHealthFactor === 'number'
          ? ` · Health Factor ${asset.defiHealthFactor.toFixed(2)}`
          : '';
      const debtDetail = asset.defiDebtSummary || `$${debtUsd.toFixed(2)} borrowed`;
      return {
        protocolId: 'external_protocol',
        protocolName,
        routeKind: 'partial_unwind',
        exitStrategy: 'external_app_exit',
        preflightStatus: 'blocked',
        preflightReason:
          input.preflightReason ||
          `Active borrow on ${protocolName} (${debtDetail}${hfPart} · Net $${netUsd.toFixed(2)}). Repay debt or manage collateral directly on ${protocolName}.`,
        plainEnglishSteps: [
          `Open ${protocolName} to repay ${debtDetail} or adjust collateral (Net $${netUsd.toFixed(2)})`,
          `Return to Turgalium once unlocked to sweep ${uSym} to Solana ${outputAsset}`,
        ],
        underlyingSymbol: uSym,
        underlyingAddress: asset.underlyingAddress,
        underlyingDecimals: asset.decimals,
        projectedHealthFactor: asset.defiHealthFactor,
        supportsAtomicBatch: false,
        protocolUrl: asset.protocolUrl,
        protocolLogoUrl: asset.protocolLogoUrl,
        positionType: posType,
        debtUsd,
        netUsd,
        debtSummary: asset.defiDebtSummary,
        simulatedLive: input.simulatedLive,
        simulatedAtBlock: input.simulatedAtBlock,
      };
    }

    return {
      protocolId: 'external_protocol',
      protocolName,
      routeKind: 'external_app',
      exitStrategy: 'external_app_exit',
      preflightStatus: 'blocked',
      preflightReason:
        input.preflightReason ||
        `${protocolName} ${posType} ($${asset.grossUsd.toFixed(2)} ${uSym}) uses custom protocol contracts — withdraw on ${protocolName}, then sweep to Solana ${outputAsset}.`,
      plainEnglishSteps: [
        `Withdraw ${asset.uiBalance} ${uSym} directly on ${protocolName}`,
        `Sweep unlocked ${uSym} to Solana ${outputAsset} in 1 click`,
      ],
      underlyingSymbol: uSym,
      underlyingAddress: asset.underlyingAddress,
      underlyingDecimals: asset.decimals,
      supportsAtomicBatch: false,
      protocolUrl: asset.protocolUrl,
      protocolLogoUrl: asset.protocolLogoUrl,
      positionType: posType,
      netUsd,
      simulatedLive: input.simulatedLive,
      simulatedAtBlock: input.simulatedAtBlock,
    };
  }

  // 0b. Security check against spoofed/untrusted protocolAddress injection.
  // Never bypass validation when a spoofed asset redirects protocolAddress away from its canonical target!
  if (asset.protocolAddress && asset.chain in EVM_CHAINS) {
    const isDirectLiquidOnly =
      protocolId === 'liquid_receipt' &&
      Boolean(liquidReceipt && hasDeepDexLiquidity) &&
      asset.protocolAddress.toLowerCase() === asset.address.toLowerCase();
    if (!isDirectLiquidOnly) {
      const targetAddr =
        protocolId === 'uniswap_v2_lp'
          ? asset.lpRouterAddress || asset.protocolAddress
          : protocolId === 'uniswap_v3_nft'
          ? asset.nftManagerAddress || asset.protocolAddress
          : asset.protocolAddress;
      const trust = validateTrustedProtocolTarget({
        chain: asset.chain as EvmChainId,
        protocolId: protocolId === 'liquid_receipt' ? 'erc4626' : protocolId,
        assetAddress: asset.address,
        protocolAddress: targetAddr,
      });
      if (!trust.trusted) {
        return {
          protocolId,
          protocolName,
          routeKind: 'unbonding_required',
          exitStrategy: 'cooldown_blocked',
          preflightStatus: 'blocked',
          preflightReason:
            trust.reason ||
            `Blocked untrusted contract target for ${asset.symbol}. Only verified protocol contracts are allowed.`,
          plainEnglishSteps: [
            `Blocked for your safety: ${asset.symbol} pointed to an unverified contract address.`,
          ],
          supportsAtomicBatch: false,
          simulatedLive: input.simulatedLive,
          simulatedAtBlock: input.simulatedAtBlock,
        };
      }
    }
  }

  // 1. Smart Exit Router: Liquid receipt tokens with deep DEX liquidity -> Direct Swap & Bridge!
  if (liquidReceipt && hasDeepDexLiquidity) {
    const cooldownDetected = Boolean(liquidReceipt.hasNativeCooldown || vaultState?.cooldownDetected);
    const steps: string[] = [
      `Swap ${asset.uiBalance} ${asset.symbol} directly on DEX and bridge to Solana ${outputAsset} in 1 transaction`,
    ];
    const reason =
      input.preflightReason ||
      (liquidReceipt.symbol === 'sUSDe'
        ? 'Ethena sUSDe has a 7-day unstaking cooldown where redeem() reverts — routing via instant Direct Swap & Bridge in 1 transaction with zero wait.'
        : liquidReceipt.hasNativeCooldown
        ? `${liquidReceipt.protocolName} ${asset.symbol} has deep DEX liquidity — bypassing native unstaking (${liquidReceipt.cooldownSummary}) via instant 1-tx Swap & Bridge.`
        : `${liquidReceipt.protocolName} ${asset.symbol} has deep DEX liquidity — routing directly via 1-tx Swap & Bridge to skip extra vault redeem gas.`);

    return {
      protocolId: protocolId === 'erc4626' ? 'erc4626' : 'liquid_receipt',
      protocolName,
      routeKind: 'direct_swap',
      exitStrategy: 'direct_swap_bypass_cooldown',
      preflightStatus: input.preflightStatus ?? 'verified',
      preflightReason: reason,
      plainEnglishSteps: steps,
      cooldownDetected,
      expectedUnderlyingRaw: vaultState?.expectedUnderlyingRaw?.toString(),
      expectedUnderlyingUi: vaultState
        ? Number(formatUnits(vaultState.expectedUnderlyingRaw, asset.decimals).toFixed(6))
        : undefined,
      underlyingSymbol: asset.underlyingSymbol ?? liquidReceipt.underlyingSymbol,
      underlyingAddress: asset.underlyingAddress ?? vaultState?.underlyingAddress ?? undefined,
      shareExchangeRate: vaultState?.shareExchangeRate,
      maxRedeemRaw: vaultState?.maxRedeemRaw?.toString(),
      supportsAtomicBatch: true,
      simulatedLive: input.simulatedLive,
      simulatedAtBlock: input.simulatedAtBlock,
    };
  }

  // 2. Cooldown-locked ERC-4626 vault WITHOUT deep DEX liquidity -> cooldown_blocked
  if (protocolId === 'erc4626' && vaultState?.cooldownDetected) {
    return {
      protocolId: 'erc4626',
      protocolName,
      routeKind: 'unbonding_required',
      exitStrategy: 'cooldown_blocked',
      preflightStatus: 'blocked',
      preflightReason:
        input.preflightReason ||
        `${protocolName} (${asset.symbol}) currently enforces a withdrawal cooldown lock (maxRedeem is 0) and lacks deep DEX liquidity for an instant swap. Start cooldown on ${protocolName} first.`,
      plainEnglishSteps: [
        `Initiate withdrawal cooldown on ${protocolName} for ${asset.uiBalance} ${asset.symbol}`,
        `Return after cooldown finishes to claim ${asset.underlyingSymbol ?? 'underlying'} and bridge to Solana ${outputAsset}`,
      ],
      cooldownDetected: true,
      expectedUnderlyingRaw: vaultState.expectedUnderlyingRaw.toString(),
      expectedUnderlyingUi: Number(formatUnits(vaultState.expectedUnderlyingRaw, asset.decimals).toFixed(6)),
      underlyingSymbol: asset.underlyingSymbol,
      underlyingAddress: asset.underlyingAddress ?? vaultState.underlyingAddress ?? undefined,
      shareExchangeRate: vaultState.shareExchangeRate,
      maxRedeemRaw: vaultState.maxRedeemRaw?.toString() ?? '0',
      supportsAtomicBatch: false,
      simulatedLive: input.simulatedLive,
      simulatedAtBlock: input.simulatedAtBlock,
    };
  }

  // 3. Aave v3 & Aave v2 (fail-closed on RPC error + Safe Partial Exit calculator when active debt exists)
  if (protocolId === 'aave_v3' || protocolId === 'aave_v2') {
    if (aaveSafety && !aaveSafety.checked) {
      return {
        protocolId,
        protocolName,
        routeKind: 'partial_unwind',
        exitStrategy: 'cooldown_blocked',
        preflightStatus: 'blocked',
        preflightReason: `Paused for your safety: could not verify your ${protocolName} borrow status onchain (${aaveSafety.reason}). Retry once RPC is reachable.`,
        plainEnglishSteps: [
          `Wait a moment and re-run preflight to verify your ${protocolName} debt status before withdrawing`,
        ],
        underlyingSymbol: asset.underlyingSymbol,
        underlyingAddress: asset.underlyingAddress,
        underlyingDecimals: asset.decimals,
        supportsAtomicBatch: false,
        simulatedLive: input.simulatedLive,
        simulatedAtBlock: input.simulatedAtBlock,
      };
    }
    const debtUsd = aaveSafety?.checked ? aaveSafety.totalDebtUsd : asset.aaveDebtUsd ?? 0;
    const hf = aaveSafety?.checked ? aaveSafety.healthFactor : asset.aaveHealthFactor;
    const totalCollateralUsd = aaveSafety?.checked
      ? aaveSafety.totalCollateralUsd
      : asset.aaveTotalCollateralUsd;
    const ltBps = aaveSafety?.checked
      ? aaveSafety.currentLiquidationThresholdBps
      : asset.aaveLiquidationThresholdBps;

    if (debtUsd > 0) {
      const partial = computeAaveSafePartialWithdrawal({
        totalCollateralUsd,
        totalDebtUsd: debtUsd,
        liquidationThresholdBps: ltBps,
        currentHealthFactor: hf,
        positionUsd: asset.grossUsd,
        positionRawBalance: rawBal,
        positionDecimals: asset.decimals,
        positionPriceUsd: asset.priceUsd,
        minSafeHealthFactor: MIN_SAFE_HEALTH_FACTOR,
      });

      if (partial.canWithdrawAny) {
        const uSym = asset.underlyingSymbol ?? asset.symbol.replace(/^a[A-Za-z]*/, '');
        return {
          protocolId,
          protocolName,
          routeKind: 'partial_unwind',
          exitStrategy: 'safe_partial_debt_exit',
          preflightStatus: input.preflightStatus ?? 'warning',
          preflightReason: input.preflightReason || partial.reason,
          plainEnglishSteps: [
            `Safely withdraw ${partial.safeMaxWithdrawUi} ${uSym} ($${partial.safeMaxWithdrawUsd.toFixed(2)}) from ${protocolName} while keeping Health Factor at ${partial.projectedHealthFactor.toFixed(2)}`,
            uSym === 'USDC' && outputAsset === 'USDC'
              ? `Bridge unlocked USDC directly to Solana USDC`
              : `Swap & bridge ${uSym} to Solana ${outputAsset}`,
          ],
          expectedUnderlyingRaw: partial.safeMaxWithdrawRaw.toString(),
          expectedUnderlyingUi: partial.safeMaxWithdrawUi,
          underlyingSymbol: uSym,
          underlyingAddress: asset.underlyingAddress,
          underlyingDecimals: asset.decimals,
          safeMaxWithdrawRaw: partial.safeMaxWithdrawRaw.toString(),
          safeMaxWithdrawUsd: partial.safeMaxWithdrawUsd,
          projectedHealthFactor: partial.projectedHealthFactor,
          minSafeHealthFactor: partial.minSafeHealthFactor,
          supportsAtomicBatch: true,
          simulatedLive: input.simulatedLive,
          simulatedAtBlock: input.simulatedAtBlock,
        };
      }

      return {
        protocolId,
        protocolName,
        routeKind: 'partial_unwind',
        exitStrategy: 'cooldown_blocked',
        preflightStatus: 'blocked',
        preflightReason: input.preflightReason || partial.reason,
        plainEnglishSteps: [
          `Repay part of your $${debtUsd.toFixed(2)} ${protocolName} borrow to raise Health Factor above ${MIN_SAFE_HEALTH_FACTOR.toFixed(1)}`,
          `Withdraw ${asset.uiBalance} ${asset.underlyingSymbol ?? asset.symbol} and bridge to Solana ${outputAsset}`,
        ],
        underlyingSymbol: asset.underlyingSymbol,
        underlyingAddress: asset.underlyingAddress,
        underlyingDecimals: asset.decimals,
        safeMaxWithdrawRaw: '0',
        safeMaxWithdrawUsd: 0,
        projectedHealthFactor: partial.currentHealthFactor,
        minSafeHealthFactor: MIN_SAFE_HEALTH_FACTOR,
        supportsAtomicBatch: false,
        simulatedLive: input.simulatedLive,
        simulatedAtBlock: input.simulatedAtBlock,
      };
    }

    const uSym = asset.underlyingSymbol ?? 'USDC';
    return {
      protocolId,
      protocolName,
      routeKind: 'protocol_unwind',
      exitStrategy: 'instant_1click_unwind',
      preflightStatus: input.preflightStatus ?? 'verified',
      preflightReason:
        input.preflightReason ||
        `No active ${protocolName} debt detected — full 1-click withdrawal and Solana bridge ready.`,
      plainEnglishSteps: [
        `Withdraw ${asset.uiBalance} ${uSym} from ${protocolName}`,
        uSym === 'USDC' && outputAsset === 'USDC'
          ? `Bridge USDC directly to Solana USDC`
          : `Swap & bridge ${uSym} to Solana ${outputAsset}`,
      ],
      expectedUnderlyingRaw: rawBal.toString(),
      expectedUnderlyingUi: asset.uiBalance,
      underlyingSymbol: uSym,
      underlyingAddress: asset.underlyingAddress,
      underlyingDecimals: asset.decimals,
      supportsAtomicBatch: true,
      simulatedLive: input.simulatedLive,
      simulatedAtBlock: input.simulatedAtBlock,
    };
  }

  // 4. Compound v3 & Compound v2 / Venus / Benqi (with fail-closed active borrow guard)
  if (protocolId === 'compound_v3' || protocolId === 'compound_v2') {
    const uSym = asset.underlyingSymbol ?? 'USDC';
    if (compoundSafety && !compoundSafety.checked) {
      return {
        protocolId,
        protocolName,
        routeKind: 'partial_unwind',
        exitStrategy: 'cooldown_blocked',
        preflightStatus: 'blocked',
        preflightReason: `Paused for your safety: ${compoundSafety.reason}`,
        plainEnglishSteps: [
          `Retry preflight once RPC responds to confirm you have no active ${protocolName} borrow`,
        ],
        underlyingSymbol: uSym,
        underlyingAddress: asset.underlyingAddress,
        underlyingDecimals: asset.decimals,
        supportsAtomicBatch: false,
        simulatedLive: input.simulatedLive,
        simulatedAtBlock: input.simulatedAtBlock,
      };
    }

    const hasBorrow = Boolean(
      compoundSafety?.hasActiveBorrow ||
        (asset.compoundDebtUsd && asset.compoundDebtUsd > 0) ||
        (asset.compoundShortfallUsd && asset.compoundShortfallUsd > 0)
    );
    if (hasBorrow) {
      return {
        protocolId,
        protocolName,
        routeKind: 'partial_unwind',
        exitStrategy: 'cooldown_blocked',
        preflightStatus: 'blocked',
        preflightReason:
          compoundSafety?.reason ||
          `Active borrow detected on ${protocolName}${asset.compoundDebtUsd ? ` ($${asset.compoundDebtUsd.toFixed(2)})` : ''}. Repay your borrow before withdrawing collateral to avoid revert or liquidation.`,
        plainEnglishSteps: [
          `Repay your active borrow on ${protocolName}`,
          `Return to withdraw ${asset.uiBalance} ${uSym} and bridge to Solana ${outputAsset}`,
        ],
        underlyingSymbol: uSym,
        underlyingAddress: asset.underlyingAddress,
        underlyingDecimals: asset.decimals,
        supportsAtomicBatch: false,
        simulatedLive: input.simulatedLive,
        simulatedAtBlock: input.simulatedAtBlock,
      };
    }

    const expectedUi = vaultState
      ? Number(formatUnits(vaultState.expectedUnderlyingRaw, asset.decimals).toFixed(6))
      : asset.uiBalance;
    return {
      protocolId,
      protocolName,
      routeKind: 'protocol_unwind',
      exitStrategy: 'instant_1click_unwind',
      preflightStatus: input.preflightStatus ?? 'verified',
      preflightReason:
        input.preflightReason ||
        `${protocolName} position has zero active borrow — ready for 1-click withdrawal and Solana bridging.`,
      plainEnglishSteps: [
        protocolId === 'compound_v2'
          ? `Redeem ${asset.uiBalance} ${asset.symbol} from ${protocolName} into ${uSym}`
          : `Withdraw ${expectedUi} ${uSym} from ${protocolName}`,
        uSym === 'USDC' && outputAsset === 'USDC'
          ? `Bridge USDC directly to Solana USDC`
          : `Swap & bridge ${uSym} to Solana ${outputAsset}`,
      ],
      expectedUnderlyingRaw: vaultState?.expectedUnderlyingRaw?.toString() ?? rawBal.toString(),
      expectedUnderlyingUi: expectedUi,
      underlyingSymbol: uSym,
      underlyingAddress: asset.underlyingAddress,
      underlyingDecimals: asset.decimals,
      supportsAtomicBatch: true,
      simulatedLive: input.simulatedLive,
      simulatedAtBlock: input.simulatedAtBlock,
    };
  }

  // 5. Uniswap v2 / Sushi / Aerodrome v2 LP
  if (protocolId === 'uniswap_v2_lp') {
    const sym0 = asset.lpToken0Symbol ?? asset.underlyingSymbol ?? 'Token A';
    const sym1 = asset.lpToken1Symbol ?? 'Token B';
    return {
      protocolId: 'uniswap_v2_lp',
      protocolName,
      routeKind: 'protocol_unwind',
      exitStrategy: 'instant_1click_unwind',
      preflightStatus: input.preflightStatus ?? 'verified',
      preflightReason:
        input.preflightReason ||
        `${protocolName} liquidity shares can be removed and both underlying tokens bridged to Solana.`,
      plainEnglishSteps: [
        `Approve and remove ${asset.uiBalance} ${asset.symbol} LP shares on ${protocolName}`,
        `Receive ${sym0} and ${sym1} in your wallet`,
        `Swap & bridge ${sym0} + ${sym1} to Solana ${outputAsset}`,
      ],
      expectedUnderlyingRaw: vaultState?.expectedUnderlyingRaw?.toString(),
      underlyingSymbol: sym0,
      underlyingAddress: asset.lpToken0Address ?? asset.underlyingAddress,
      underlyingDecimals: asset.lpToken0Decimals ?? 18,
      secondaryUnderlyingSymbol: sym1,
      secondaryUnderlyingAddress: asset.lpToken1Address,
      secondaryUnderlyingDecimals: asset.lpToken1Decimals ?? 18,
      expectedSecondaryRaw: input.expectedSecondaryRaw?.toString(),
      expectedSecondaryUi: input.expectedSecondaryUi,
      supportsAtomicBatch: true,
      simulatedLive: input.simulatedLive,
      simulatedAtBlock: input.simulatedAtBlock,
    };
  }

  // 6. Uniswap v3 / Aerodrome CL NFT Positions
  if (protocolId === 'uniswap_v3_nft') {
    const sym0 = asset.lpToken0Symbol ?? asset.underlyingSymbol ?? 'Token A';
    const sym1 = asset.lpToken1Symbol ?? 'Token B';
    const isZeroLiquidity = (asset.nftLiquidity ?? asset.rawBalance ?? '0') === '0';
    return {
      protocolId: 'uniswap_v3_nft',
      protocolName,
      routeKind: 'protocol_unwind',
      exitStrategy: 'instant_1click_unwind',
      preflightStatus: input.preflightStatus ?? (isZeroLiquidity && asset.grossUsd <= 0 ? 'warning' : 'verified'),
      preflightReason:
        input.preflightReason ||
        (isZeroLiquidity
          ? `${protocolName} NFT #${asset.nftTokenId ?? '—'} has zero active liquidity — collects any uncollected fees and burns the empty NFT in 1 call.`
          : `${protocolName} NFT #${asset.nftTokenId ?? '—'} can decrease liquidity, collect fees, and burn in 1 atomic multicall.`),
      plainEnglishSteps: isZeroLiquidity
        ? [
            `Collect any remaining fees from empty ${protocolName} position #${asset.nftTokenId ?? '—'} and burn the NFT in 1 call`,
          ]
        : [
            `Close ${protocolName} position #${asset.nftTokenId ?? '—'} (decrease liquidity, collect fees & burn NFT in 1 call)`,
            `Swap & bridge unlocked ${sym0} + ${sym1} to Solana ${outputAsset}`,
          ],
      underlyingSymbol: sym0,
      underlyingAddress: asset.lpToken0Address ?? asset.underlyingAddress,
      underlyingDecimals: asset.lpToken0Decimals ?? 18,
      secondaryUnderlyingSymbol: sym1,
      secondaryUnderlyingAddress: asset.lpToken1Address,
      secondaryUnderlyingDecimals: asset.lpToken1Decimals ?? 18,
      nftTokenId: asset.nftTokenId,
      nftManagerAddress: asset.nftManagerAddress ?? asset.protocolAddress,
      supportsAtomicBatch: true,
      simulatedLive: input.simulatedLive,
      simulatedAtBlock: input.simulatedAtBlock,
    };
  }

  // 6b. Yearn v2 Vault (yvOP, yvUSDT, yvUSDC, etc. — direct withdraw(uint256))
  if (protocolId === 'yearn_v2') {
    const uSym = asset.underlyingSymbol ?? asset.symbol.replace(/^yv/i, '') ?? 'underlying';
    const uDec = asset.decimals;
    const expectedRaw = input.expectedUnderlyingRaw ?? rawBal;
    const expectedUi =
      input.expectedUnderlyingUi ?? Number(formatUnits(expectedRaw, uDec).toFixed(6));
    const shareRate = asset.uiBalance > 0 ? Number((expectedUi / asset.uiBalance).toFixed(6)) : 1;
    return {
      protocolId: 'yearn_v2',
      protocolName,
      routeKind: 'protocol_unwind',
      exitStrategy: 'instant_1click_unwind',
      preflightStatus: input.preflightStatus ?? 'verified',
      preflightReason:
        input.preflightReason ||
        `${protocolName} vault verified: ${asset.uiBalance} ${asset.symbol} withdraws ~${expectedUi} ${uSym} directly to your wallet.`,
      plainEnglishSteps: [
        `Withdraw ${asset.uiBalance} ${asset.symbol} from ${protocolName} into ~${expectedUi} ${uSym}`,
        uSym === 'USDC' && outputAsset === 'USDC'
          ? `Bridge ${uSym} directly to Solana USDC`
          : `Swap & bridge ${uSym} to Solana ${outputAsset}`,
      ],
      cooldownDetected: false,
      expectedUnderlyingRaw: expectedRaw.toString(),
      expectedUnderlyingUi: expectedUi,
      underlyingSymbol: uSym,
      underlyingAddress: asset.underlyingAddress,
      underlyingDecimals: uDec,
      shareExchangeRate: shareRate,
      supportsAtomicBatch: true,
      protocolUrl: asset.protocolUrl,
      protocolLogoUrl: asset.protocolLogoUrl,
      positionType: asset.defiPositionType ?? 'Yield',
      simulatedLive: input.simulatedLive,
      simulatedAtBlock: input.simulatedAtBlock,
    };
  }

  // 7. Standard ERC-4626 Vault (Morpho, Yearn v3, Fluid, Euler, etc.)
  const uSym = asset.underlyingSymbol ?? 'underlying';
  const uDec =
    asset.chain in EVM_CHAINS &&
    asset.underlyingAddress?.toLowerCase() === EVM_CHAINS[asset.chain as EvmChainId].usdcAddress.toLowerCase()
      ? 6
      : asset.decimals;

  if (vaultState && (vaultState.verifiedUnderlyingOutput === false || vaultState.expectedUnderlyingRaw <= 0n)) {
    return {
      protocolId: 'erc4626',
      protocolName,
      routeKind: 'unbonding_required',
      exitStrategy: 'cooldown_blocked',
      preflightStatus: 'blocked',
      preflightReason:
        input.preflightReason ||
        `${protocolName} (${asset.symbol}) failed ERC-4626 previewRedeem / convertToAssets verification — blocked to prevent unverified vault execution.`,
      plainEnglishSteps: [
        `Blocked for your safety: ${asset.symbol} did not return a verifiable redeemable underlying balance.`,
      ],
      cooldownDetected: false,
      underlyingSymbol: uSym,
      underlyingAddress: asset.underlyingAddress ?? vaultState.underlyingAddress ?? undefined,
      underlyingDecimals: uDec,
      supportsAtomicBatch: false,
      simulatedLive: input.simulatedLive,
      simulatedAtBlock: input.simulatedAtBlock,
    };
  }

  const verifiedExpectedRaw =
    vaultState?.expectedUnderlyingRaw ??
    (input.expectedUnderlyingRaw !== undefined && input.expectedUnderlyingRaw > 0n
      ? input.expectedUnderlyingRaw
      : undefined);
  const expectedUi =
    verifiedExpectedRaw !== undefined
      ? Number(formatUnits(verifiedExpectedRaw, uDec).toFixed(6))
      : input.expectedUnderlyingUi ?? asset.uiBalance;

  return {
    protocolId: 'erc4626',
    protocolName,
    routeKind: 'protocol_unwind',
    exitStrategy: 'instant_1click_unwind',
    preflightStatus: input.preflightStatus ?? 'verified',
    preflightReason:
      input.preflightReason ||
      (vaultState
        ? `${protocolName} vault verified: ${asset.uiBalance} ${asset.symbol} redeems for ~${expectedUi} ${uSym} (rate ${vaultState.shareExchangeRate.toFixed(4)}).`
        : `${protocolName} vault shares ready to redeem into ${uSym} and bridge to Solana ${outputAsset}.`),
    plainEnglishSteps: [
      `Redeem ${asset.uiBalance} ${asset.symbol} shares from ${protocolName} into ${expectedUi} ${uSym}`,
      uSym === 'USDC' && outputAsset === 'USDC'
        ? `Bridge ${uSym} directly to Solana USDC`
        : `Swap & bridge ${uSym} to Solana ${outputAsset}`,
    ],
    cooldownDetected: false,
    expectedUnderlyingRaw: verifiedExpectedRaw?.toString(),
    expectedUnderlyingUi: expectedUi,
    underlyingSymbol: uSym,
    underlyingAddress: asset.underlyingAddress ?? vaultState?.underlyingAddress ?? undefined,
    underlyingDecimals: uDec,
    shareExchangeRate: vaultState?.shareExchangeRate ?? 1,
    maxRedeemRaw: vaultState?.maxRedeemRaw?.toString() ?? rawBal.toString(),
    supportsAtomicBatch: Boolean(verifiedExpectedRaw !== undefined),
    simulatedLive: input.simulatedLive,
    simulatedAtBlock: input.simulatedAtBlock,
  };
}

// ========================== MODULAR EXTRACTOR REGISTRY ==========================

export interface BuiltDefiExtractionTx {
  stepId: string;
  label: string;
  description: string;
  to: string;
  data: string;
  value: string;
}

export interface DefiExtractorBuildResult {
  protocolId: DefiProtocolExtractorId;
  provider:
    | 'aave_v3'
    | 'aave_v2'
    | 'compound_v3'
    | 'compound_v2'
    | 'erc4626'
    | 'yearn_v2'
    | 'uniswap_v2_lp'
    | 'uniswap_v3_nft'
    | 'direct_swap';
  transactions: BuiltDefiExtractionTx[];
  unlockedAssets: Array<{
    address: string;
    symbol: string;
    decimals: number;
    expectedRawAmount: bigint;
    expectedUiAmount: number;
    estimatedUsd: number;
  }>;
  estimatedOutput: string;
  estimatedSeconds: number;
  notes: string[];
}

export interface ProtocolExtractor {
  id: DefiProtocolExtractorId;
  name: string;
  matches: (asset: ScannedAsset) => boolean;
  buildExtraction: (params: {
    asset: ScannedAsset;
    userAddress: string;
    chain: EvmChainId;
    exitPlan?: DefiExitPlan;
    deadlineSec?: number;
  }) => DefiExtractorBuildResult;
}

export const PROTOCOL_EXTRACTOR_REGISTRY: Record<DefiProtocolExtractorId, ProtocolExtractor> = {
  liquid_receipt: {
    id: 'liquid_receipt',
    name: 'Liquid Receipt Direct Swap Router',
    matches: (asset) => isLiquidReceiptToken(asset.symbol, asset.address),
    buildExtraction: ({ asset }) => ({
      protocolId: 'liquid_receipt',
      provider: 'direct_swap',
      transactions: [],
      unlockedAssets: [
        {
          address: asset.address,
          symbol: asset.symbol,
          decimals: asset.decimals,
          expectedRawAmount: BigInt(asset.rawBalance || '0'),
          expectedUiAmount: asset.uiBalance,
          estimatedUsd: asset.grossUsd,
        },
      ],
      estimatedOutput: `Direct Swap & Bridge ${asset.uiBalance} ${asset.symbol}`,
      estimatedSeconds: 10,
      notes: ['Liquid receipt routes directly through DEX + bridge in 1 transaction.'],
    }),
  },

  aave_v3: {
    id: 'aave_v3',
    name: 'Aave v3 Pool',
    matches: (asset) =>
      (asset.protocol ?? '').toLowerCase().includes('aave') &&
      !(asset.protocol ?? '').toLowerCase().includes('aave v2'),
    buildExtraction: ({ asset, userAddress, chain, exitPlan }) => {
      const cfg = EVM_CHAINS[chain];
      const poolTarget = asset.protocolAddress || cfg.aaveV3Pool;
      const trust = validateTrustedProtocolTarget({
        chain,
        protocolId: 'aave_v3',
        assetAddress: asset.address,
        protocolAddress: poolTarget,
      });
      if (!trust.trusted || !poolTarget) {
        throw new Error(trust.reason || `Missing Aave v3 Pool address on ${cfg.name}.`);
      }
      const underlying =
        asset.underlyingAddress ||
        exitPlan?.underlyingAddress ||
        (asset.underlyingSymbol === 'USDC' ? cfg.usdcAddress : undefined);
      if (!underlying) {
        throw new Error(
          `Cannot build Aave v3 Pool.withdraw for ${asset.symbol}: missing underlying ERC-20 asset address.`
        );
      }

      const isPartial = exitPlan?.exitStrategy === 'safe_partial_debt_exit' && exitPlan.safeMaxWithdrawRaw;
      const withdrawAmount = isPartial ? BigInt(exitPlan.safeMaxWithdrawRaw!) : MAX_UINT256;
      const expectedRaw = isPartial ? BigInt(exitPlan.safeMaxWithdrawRaw!) : BigInt(asset.rawBalance);
      const expectedUi = isPartial
        ? Number(formatUnits(expectedRaw, asset.decimals).toFixed(6))
        : asset.uiBalance;
      const expectedUsd = isPartial && exitPlan.safeMaxWithdrawUsd ? exitPlan.safeMaxWithdrawUsd : asset.grossUsd;
      const uSym = asset.underlyingSymbol ?? 'USDC';

      return {
        protocolId: 'aave_v3',
        provider: 'aave_v3',
        transactions: [
          {
            stepId: isPartial ? 'aave_partial_withdraw' : 'aave_withdraw',
            label: isPartial
              ? `Safely withdraw ${expectedUi} ${uSym} from Aave v3 (keeps HF >= ${MIN_SAFE_HEALTH_FACTOR})`
              : `Withdraw ${asset.symbol} from Aave v3`,
            description: isPartial
              ? `Calls Aave v3 Pool.withdraw(${uSym}, ${expectedUi}, your wallet) keeping Health Factor safe`
              : `Calls Aave v3 Pool.withdraw(${uSym}, MAX, your wallet)`,
            to: poolTarget,
            data: encodeAaveWithdraw(underlying, withdrawAmount, userAddress),
            value: '0x0',
          },
        ],
        unlockedAssets: [
          {
            address: underlying,
            symbol: uSym,
            decimals: asset.decimals,
            expectedRawAmount: expectedRaw,
            expectedUiAmount: expectedUi,
            estimatedUsd: expectedUsd,
          },
        ],
        estimatedOutput: `${expectedUi} ${uSym} withdrawn to wallet`,
        estimatedSeconds: 12,
        notes: [
          isPartial
            ? `Safe partial withdrawal: withdraws $${expectedUsd.toFixed(2)} while keeping your Aave v3 Health Factor >= ${MIN_SAFE_HEALTH_FACTOR}.`
            : 'After Aave withdrawal confirms, bridge the unlocked balance to Solana.',
        ],
      };
    },
  },

  aave_v2: {
    id: 'aave_v2',
    name: 'Aave v2 LendingPool',
    matches: (asset) => (asset.protocol ?? '').toLowerCase().includes('aave v2'),
    buildExtraction: ({ asset, userAddress, chain, exitPlan }) => {
      const cfg = EVM_CHAINS[chain];
      const poolTarget = asset.protocolAddress || AAVE_V2_LENDING_POOLS[chain];
      const trust = validateTrustedProtocolTarget({
        chain,
        protocolId: 'aave_v2',
        assetAddress: asset.address,
        protocolAddress: poolTarget,
      });
      if (!trust.trusted || !poolTarget) {
        throw new Error(trust.reason || `Missing Aave v2 LendingPool address on ${cfg.name}.`);
      }
      const underlying =
        asset.underlyingAddress ||
        exitPlan?.underlyingAddress ||
        (asset.underlyingSymbol === 'USDC' ? cfg.usdcAddress : undefined);
      if (!underlying) {
        throw new Error(
          `Cannot build Aave v2 LendingPool.withdraw for ${asset.symbol}: missing underlying ERC-20 asset address.`
        );
      }

      const isPartial = exitPlan?.exitStrategy === 'safe_partial_debt_exit' && exitPlan.safeMaxWithdrawRaw;
      const withdrawAmount = isPartial ? BigInt(exitPlan.safeMaxWithdrawRaw!) : MAX_UINT256;
      const expectedRaw = isPartial ? BigInt(exitPlan.safeMaxWithdrawRaw!) : BigInt(asset.rawBalance);
      const expectedUi = isPartial
        ? Number(formatUnits(expectedRaw, asset.decimals).toFixed(6))
        : asset.uiBalance;
      const expectedUsd = isPartial && exitPlan.safeMaxWithdrawUsd ? exitPlan.safeMaxWithdrawUsd : asset.grossUsd;
      const uSym = asset.underlyingSymbol ?? 'USDC';

      return {
        protocolId: 'aave_v2',
        provider: 'aave_v2',
        transactions: [
          {
            stepId: isPartial ? 'aave_v2_partial_withdraw' : 'aave_v2_withdraw',
            label: `Withdraw ${asset.symbol} from Aave v2`,
            description: `Calls Aave v2 LendingPool.withdraw(${uSym}, ${isPartial ? expectedUi : 'MAX'}, your wallet)`,
            to: poolTarget,
            data: encodeAaveWithdraw(underlying, withdrawAmount, userAddress),
            value: '0x0',
          },
        ],
        unlockedAssets: [
          {
            address: underlying,
            symbol: uSym,
            decimals: asset.decimals,
            expectedRawAmount: expectedRaw,
            expectedUiAmount: expectedUi,
            estimatedUsd: expectedUsd,
          },
        ],
        estimatedOutput: `${expectedUi} ${uSym} withdrawn to wallet`,
        estimatedSeconds: 12,
        notes: ['Aave v2 LendingPool.withdraw returns the underlying ERC-20 directly to your wallet.'],
      };
    },
  },

  compound_v3: {
    id: 'compound_v3',
    name: 'Compound v3 Comet',
    matches: (asset) =>
      (asset.protocol ?? '').toLowerCase().includes('compound') &&
      !(asset.protocol ?? '').toLowerCase().includes('compound v2'),
    buildExtraction: ({ asset, chain }) => {
      const cfg = EVM_CHAINS[chain];
      const cometTarget = asset.protocolAddress || asset.address || cfg.compoundV3Comet;
      const trust = validateTrustedProtocolTarget({
        chain,
        protocolId: 'compound_v3',
        assetAddress: asset.address,
        protocolAddress: cometTarget,
      });
      if (!trust.trusted || !cometTarget) {
        throw new Error(trust.reason || `Missing Compound v3 Comet address on ${cfg.name}.`);
      }
      const rawBal = BigInt(asset.rawBalance);
      const underlying = asset.underlyingAddress || cfg.usdcAddress;
      const uSym = asset.underlyingSymbol ?? 'USDC';

      return {
        protocolId: 'compound_v3',
        provider: 'compound_v3',
        transactions: [
          {
            stepId: 'compound_withdraw',
            label: `Withdraw ${asset.symbol} from Compound v3`,
            description: `Calls Compound v3 Comet.withdraw(${uSym}, ${asset.uiBalance})`,
            to: cometTarget,
            data: encodeCompoundV3Withdraw(underlying, rawBal),
            value: '0x0',
          },
        ],
        unlockedAssets: [
          {
            address: underlying,
            symbol: uSym,
            decimals: asset.decimals,
            expectedRawAmount: rawBal,
            expectedUiAmount: asset.uiBalance,
            estimatedUsd: asset.grossUsd,
          },
        ],
        estimatedOutput: `${asset.uiBalance} ${uSym} withdrawn to wallet`,
        estimatedSeconds: 12,
        notes: [
          'After Compound withdrawal confirms, bridge the unlocked asset directly to Solana via Relay or Circle CCTP.',
        ],
      };
    },
  },

  compound_v2: {
    id: 'compound_v2',
    name: 'Compound v2 / Venus / Benqi',
    matches: (asset) => {
      const p = (asset.protocol ?? '').toLowerCase();
      return p.includes('compound v2') || p.includes('venus') || p.includes('benqi');
    },
    buildExtraction: ({ asset, chain, exitPlan }) => {
      const cfg = EVM_CHAINS[chain];
      const cTokenTarget = asset.protocolAddress || asset.address;
      const trust = validateTrustedProtocolTarget({
        chain,
        protocolId: 'compound_v2',
        assetAddress: asset.address,
        protocolAddress: cTokenTarget,
      });
      if (!trust.trusted) {
        throw new Error(trust.reason || `Untrusted Compound v2 cToken address.`);
      }
      const rawBal = BigInt(asset.rawBalance);
      const underlying = asset.underlyingAddress || exitPlan?.underlyingAddress || cfg.usdcAddress;
      const uSym = asset.underlyingSymbol ?? 'USDC';
      const uDec = exitPlan?.underlyingDecimals ?? asset.decimals;
      const expectedRaw = exitPlan?.expectedUnderlyingRaw ? BigInt(exitPlan.expectedUnderlyingRaw) : rawBal;
      const expectedUi =
        exitPlan?.expectedUnderlyingUi ?? Number(formatUnits(expectedRaw, uDec).toFixed(6));

      return {
        protocolId: 'compound_v2',
        provider: 'compound_v2',
        transactions: [
          {
            stepId: 'compound_v2_redeem',
            label: `Redeem ${asset.symbol} from ${asset.protocol || 'Compound v2'}`,
            description: `Calls cToken.redeem(${asset.uiBalance} ${asset.symbol}) to unlock ${uSym}`,
            to: cTokenTarget,
            data: encodeCompoundV2Redeem(rawBal),
            value: '0x0',
          },
        ],
        unlockedAssets: [
          {
            address: underlying,
            symbol: uSym,
            decimals: uDec,
            expectedRawAmount: expectedRaw,
            expectedUiAmount: expectedUi,
            estimatedUsd: asset.grossUsd,
          },
        ],
        estimatedOutput: `${expectedUi} ${uSym} redeemed to wallet`,
        estimatedSeconds: 14,
        notes: [`Redeems ${asset.symbol} shares directly into underlying ${uSym} via cToken.redeem(uint256).`],
      };
    },
  },

  erc4626: {
    id: 'erc4626',
    name: 'ERC-4626 Vault',
    matches: (asset) => identifyProtocolExtractorId(asset) === 'erc4626',
    buildExtraction: ({ asset, userAddress, chain, exitPlan }) => {
      const vaultTarget = asset.protocolAddress || asset.address;
      const trust = validateTrustedProtocolTarget({
        chain,
        protocolId: 'erc4626',
        assetAddress: asset.address,
        protocolAddress: vaultTarget,
      });
      if (!trust.trusted) {
        throw new Error(trust.reason || `Untrusted ERC-4626 vault target.`);
      }
      const rawBal = BigInt(asset.rawBalance);
      const uSym = asset.underlyingSymbol ?? exitPlan?.underlyingSymbol ?? 'underlying';
      const uAddr = asset.underlyingAddress ?? exitPlan?.underlyingAddress ?? '';
      const uDec = exitPlan?.underlyingDecimals ?? asset.decimals;
      const hasVerifiedExpected =
        Boolean(exitPlan?.expectedUnderlyingRaw) &&
        BigInt(exitPlan!.expectedUnderlyingRaw!) > 0n &&
        exitPlan?.preflightStatus !== 'blocked';
      const expectedRaw = hasVerifiedExpected ? BigInt(exitPlan!.expectedUnderlyingRaw!) : 0n;
      const expectedUi =
        exitPlan?.expectedUnderlyingUi ??
        (hasVerifiedExpected ? Number(formatUnits(expectedRaw, uDec).toFixed(6)) : asset.uiBalance);

      return {
        protocolId: 'erc4626',
        provider: 'erc4626',
        transactions: [
          {
            stepId: 'erc4626_redeem',
            label: `Redeem ${asset.symbol} Vault Shares`,
            description: `Calls ERC-4626 redeem(${asset.uiBalance} shares) directly on ${vaultTarget}`,
            to: vaultTarget,
            data: encodeErc4626Redeem(rawBal, userAddress, userAddress),
            value: '0x0',
          },
        ],
        // Never size follow-up CCTP / bridge transfers from unverified raw share balances!
        unlockedAssets:
          uAddr && hasVerifiedExpected
            ? [
                {
                  address: uAddr,
                  symbol: uSym,
                  decimals: uDec,
                  expectedRawAmount: expectedRaw,
                  expectedUiAmount: expectedUi,
                  estimatedUsd: asset.grossUsd,
                },
              ]
            : [],
        estimatedOutput: `${expectedUi} ${uSym} redeemed from ${asset.symbol}`,
        estimatedSeconds: 15,
        notes: ['Underlying tokens return to your wallet for direct Solana bridging.'],
      };
    },
  },

  uniswap_v2_lp: {
    id: 'uniswap_v2_lp',
    name: 'Uniswap v2 / Sushi / Aerodrome v2 LP',
    matches: (asset) => identifyProtocolExtractorId(asset) === 'uniswap_v2_lp',
    buildExtraction: ({ asset, userAddress, chain, exitPlan, deadlineSec }) => {
      const cfg = EVM_CHAINS[chain];
      const routers = V2_DEX_ROUTERS[chain] ?? [];
      const routerAddr = asset.lpRouterAddress || asset.protocolAddress || routers[0]?.router;
      const trust = validateTrustedProtocolTarget({
        chain,
        protocolId: 'uniswap_v2_lp',
        assetAddress: asset.address,
        protocolAddress: routerAddr,
      });
      if (!trust.trusted || !routerAddr) {
        throw new Error(trust.reason || `No Uniswap v2 / Aerodrome v2 router configured on ${cfg.name}.`);
      }
      const tokenA = asset.lpToken0Address || asset.underlyingAddress || exitPlan?.underlyingAddress;
      const tokenB = asset.lpToken1Address || exitPlan?.secondaryUnderlyingAddress;
      if (!tokenA || !tokenB) {
        throw new Error(`Cannot build removeLiquidity for ${asset.symbol}: missing token0/token1 addresses.`);
      }
      const rawLp = BigInt(asset.rawBalance);
      const deadline = BigInt(deadlineSec ?? Math.floor(Date.now() / 1000) + 1800);
      const expected0 = exitPlan?.expectedUnderlyingRaw ? BigInt(exitPlan.expectedUnderlyingRaw) : 0n;
      const expected1 = exitPlan?.expectedSecondaryRaw ? BigInt(exitPlan.expectedSecondaryRaw) : 0n;
      const amountAMin = (expected0 * 99n) / 100n;
      const amountBMin = (expected1 * 99n) / 100n;

      const isAeroStyle =
        typeof asset.lpStable === 'boolean' ||
        (asset.protocol ?? '').toLowerCase().includes('aerodrome') ||
        (asset.protocol ?? '').toLowerCase().includes('velodrome');

      const sym0 = asset.lpToken0Symbol ?? asset.underlyingSymbol ?? 'Token0';
      const sym1 = asset.lpToken1Symbol ?? exitPlan?.secondaryUnderlyingSymbol ?? 'Token1';
      const dec0 = asset.lpToken0Decimals ?? exitPlan?.underlyingDecimals ?? 18;
      const dec1 = asset.lpToken1Decimals ?? exitPlan?.secondaryUnderlyingDecimals ?? 18;

      const unlocked: DefiExtractorBuildResult['unlockedAssets'] = [];
      if (expected0 > 0n) {
        unlocked.push({
          address: tokenA,
          symbol: sym0,
          decimals: dec0,
          expectedRawAmount: expected0,
          expectedUiAmount: Number(formatUnits(expected0, dec0).toFixed(6)),
          estimatedUsd: Number((asset.grossUsd / 2).toFixed(2)),
        });
      }
      if (expected1 > 0n) {
        unlocked.push({
          address: tokenB,
          symbol: sym1,
          decimals: dec1,
          expectedRawAmount: expected1,
          expectedUiAmount: Number(formatUnits(expected1, dec1).toFixed(6)),
          estimatedUsd: Number((asset.grossUsd / 2).toFixed(2)),
        });
      }

      return {
        protocolId: 'uniswap_v2_lp',
        provider: 'uniswap_v2_lp',
        transactions: [
          {
            stepId: 'approve_lp_router',
            label: `Approve ${asset.symbol} LP tokens for ${asset.protocol || 'DEX Router'}`,
            description: `Grants exact LP token approval to ${routerAddr}`,
            to: asset.address,
            data: encodeErc20Approve(routerAddr, rawLp),
            value: '0x0',
          },
          {
            stepId: 'uniswap_v2_remove_liquidity',
            label: `Remove Liquidity (${sym0} / ${sym1})`,
            description: `Calls removeLiquidity on ${asset.protocol || 'Uniswap v2'} router to return ${sym0} and ${sym1}`,
            to: routerAddr,
            data: encodeUniswapV2RemoveLiquidity({
              tokenA,
              tokenB,
              liquidity: rawLp,
              amountAMin,
              amountBMin,
              to: userAddress,
              deadline,
              stable: isAeroStyle ? Boolean(asset.lpStable) : undefined,
            }),
            value: '0x0',
          },
        ],
        unlockedAssets: unlocked,
        estimatedOutput: `Unlock ${sym0} + ${sym1} from ${asset.symbol} LP`,
        estimatedSeconds: 15,
        notes: [
          `Approves and removes ${asset.symbol} liquidity in 1 batch, unlocking ${sym0} and ${sym1} for Solana bridging.`,
        ],
      };
    },
  },

  uniswap_v3_nft: {
    id: 'uniswap_v3_nft',
    name: 'Uniswap v3 / Aerodrome CL NFT',
    matches: (asset) => identifyProtocolExtractorId(asset) === 'uniswap_v3_nft',
    buildExtraction: ({ asset, userAddress, chain, exitPlan, deadlineSec }) => {
      const cfg = EVM_CHAINS[chain];
      const managers = UNISWAP_V3_NFT_MANAGERS[chain] ?? [];
      const managerAddr =
        asset.nftManagerAddress || asset.protocolAddress || exitPlan?.nftManagerAddress || managers[0]?.address;
      const trust = validateTrustedProtocolTarget({
        chain,
        protocolId: 'uniswap_v3_nft',
        assetAddress: asset.address,
        protocolAddress: managerAddr,
      });
      if (!trust.trusted || !managerAddr) {
        throw new Error(trust.reason || `No Uniswap v3 / Aerodrome CL Position Manager configured on ${cfg.name}.`);
      }
      const tokenIdStr = asset.nftTokenId || exitPlan?.nftTokenId;
      if (!tokenIdStr) {
        throw new Error(`Cannot close Uniswap v3 NFT position ${asset.symbol}: missing nftTokenId.`);
      }
      const tokenId = BigInt(tokenIdStr);
      const liquidity = BigInt(asset.nftLiquidity ?? asset.rawBalance ?? '0');
      const deadline = BigInt(deadlineSec ?? Math.floor(Date.now() / 1000) + 1800);

      const { data } = buildUniswapV3NftExitCalldata({
        tokenId,
        liquidity,
        recipient: userAddress,
        deadline,
        includeBurn: true,
      });

      const sym0 = asset.lpToken0Symbol ?? asset.underlyingSymbol ?? 'Token0';
      const sym1 = asset.lpToken1Symbol ?? exitPlan?.secondaryUnderlyingSymbol ?? 'Token1';
      const tokenA = asset.lpToken0Address ?? asset.underlyingAddress ?? exitPlan?.underlyingAddress;
      const tokenB = asset.lpToken1Address ?? exitPlan?.secondaryUnderlyingAddress;
      const dec0 = asset.lpToken0Decimals ?? exitPlan?.underlyingDecimals ?? 18;
      const dec1 = asset.lpToken1Decimals ?? exitPlan?.secondaryUnderlyingDecimals ?? 18;
      const expected0 = exitPlan?.expectedUnderlyingRaw ? BigInt(exitPlan.expectedUnderlyingRaw) : 0n;
      const expected1 = exitPlan?.expectedSecondaryRaw ? BigInt(exitPlan.expectedSecondaryRaw) : 0n;

      const unlocked: DefiExtractorBuildResult['unlockedAssets'] = [];
      if (tokenA && expected0 > 0n) {
        unlocked.push({
          address: tokenA,
          symbol: sym0,
          decimals: dec0,
          expectedRawAmount: expected0,
          expectedUiAmount: Number(formatUnits(expected0, dec0).toFixed(6)),
          estimatedUsd: Number((asset.grossUsd / 2).toFixed(2)),
        });
      }
      if (tokenB && expected1 > 0n) {
        unlocked.push({
          address: tokenB,
          symbol: sym1,
          decimals: dec1,
          expectedRawAmount: expected1,
          expectedUiAmount: Number(formatUnits(expected1, dec1).toFixed(6)),
          estimatedUsd: Number((asset.grossUsd / 2).toFixed(2)),
        });
      }

      return {
        protocolId: 'uniswap_v3_nft',
        provider: 'uniswap_v3_nft',
        transactions: [
          {
            stepId: 'uniswap_v3_nft_multicall_exit',
            label: `Close ${asset.protocol || 'Uniswap v3'} Position #${tokenId.toString()}`,
            description: `Atomic multicall([decreaseLiquidity, collect, burn]) on ${managerAddr}`,
            to: managerAddr,
            data,
            value: '0x0',
          },
        ],
        unlockedAssets: unlocked,
        estimatedOutput: `Closed NFT #${tokenId.toString()} → unlocked ${sym0} + ${sym1}`,
        estimatedSeconds: 15,
        notes: [
          `Executes decreaseLiquidity + collect + burn atomically in a single NonfungiblePositionManager.multicall transaction.`,
        ],
      };
    },
  },

  yearn_v2: {
    id: 'yearn_v2',
    name: 'Yearn v2 Vault',
    matches: (asset) => identifyProtocolExtractorId(asset) === 'yearn_v2',
    buildExtraction: ({ asset, chain, exitPlan }) => {
      const vaultTarget = asset.protocolAddress || asset.address;
      const trust = validateTrustedProtocolTarget({
        chain,
        protocolId: 'yearn_v2',
        assetAddress: asset.address,
        protocolAddress: vaultTarget,
      });
      if (!trust.trusted) {
        throw new Error(trust.reason || `Untrusted Yearn v2 vault target.`);
      }
      const rawBal = BigInt(asset.rawBalance);
      const uSym = asset.underlyingSymbol ?? exitPlan?.underlyingSymbol ?? asset.symbol.replace(/^yv/i, '');
      const uAddr = asset.underlyingAddress ?? exitPlan?.underlyingAddress ?? '';
      const uDec = exitPlan?.underlyingDecimals ?? asset.decimals;
      const expectedRaw = exitPlan?.expectedUnderlyingRaw ? BigInt(exitPlan.expectedUnderlyingRaw) : rawBal;
      const expectedUi =
        exitPlan?.expectedUnderlyingUi ?? Number(formatUnits(expectedRaw, uDec).toFixed(6));

      return {
        protocolId: 'yearn_v2',
        provider: 'yearn_v2',
        transactions: [
          {
            stepId: 'yearn_v2_withdraw',
            label: `Withdraw ${asset.symbol} from Yearn v2`,
            description: `Calls Yearn v2 Vault.withdraw(${asset.uiBalance} shares) directly on ${vaultTarget}`,
            to: vaultTarget,
            data: encodeYearnV2Withdraw(rawBal),
            value: '0x0',
          },
        ],
        unlockedAssets: uAddr
          ? [
              {
                address: uAddr,
                symbol: uSym,
                decimals: uDec,
                expectedRawAmount: expectedRaw,
                expectedUiAmount: expectedUi,
                estimatedUsd: asset.grossUsd,
              },
            ]
          : [],
        estimatedOutput: `${expectedUi} ${uSym} withdrawn from ${asset.symbol}`,
        estimatedSeconds: 15,
        notes: ['Calls Yearn v2 withdraw(uint256) to unlock underlying tokens directly into your wallet.'],
      };
    },
  },

  external_protocol: {
    id: 'external_protocol',
    name: 'External DeFi Protocol',
    matches: (asset) => identifyProtocolExtractorId(asset) === 'external_protocol',
    buildExtraction: ({ asset }) => {
      throw new Error(
        `${asset.protocol || 'This DeFi protocol'} (${asset.symbol}) requires managing on the protocol app${asset.protocolUrl ? ` (${asset.protocolUrl})` : ''} before sweeping to Solana.`
      );
    },
  },
};
