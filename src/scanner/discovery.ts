import { PublicKey } from '@solana/web3.js';
import {
  decodeAaveV3ReserveData,
  decodeAbiUint256Word,
  DEFI_SELECTORS,
  encodeAaveGetReserveData,
  encodeErc4626ConvertToAssets,
  isAllowedAaveV3Pool,
  isCuratedDefiVault,
  pad32Hex,
} from '../defi/extractors.js';
import { DEAD_BURN_ADDRESS, EVM_CHAINS } from './chains.js';
import {
  decodeMulticall3Aggregate3,
  encodeMulticall3Aggregate3,
  evmJsonRpcCall,
  isEvmExecutionRevertError,
} from './rpc.js';
import { sanitizeTokenName, sanitizeTokenSymbol } from './sanitize.js';
import type { EvmChainId } from './types.js';

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_RPC_URLS = [
  process.env.SOLANA_RPC_URL?.trim(),
  'https://api.mainnet-beta.solana.com',
  'https://solana.publicnode.com',
].filter((u): u is string => Boolean(u));
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const DEXSCREENER_CHAIN_SLUGS: Record<EvmChainId, string> = {
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
  scroll: 'scroll',
  mantle: 'mantle',
  blast: 'blast',
  worldchain: 'worldchain',
  hyperevm: 'hyperevm',
  berachain: 'berachain',
  zksync: 'zksync',
  ink: 'ink',
  gnosis: 'gnosischain',
  monad: 'monad',
};

export const ALCHEMY_NETWORK_SUBDOMAINS: Partial<Record<EvmChainId, string>> = {
  ethereum: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  polygon: 'polygon-mainnet',
  avalanche: 'avax-mainnet',
  bnb: 'bnb-mainnet',
  linea: 'linea-mainnet',
  scroll: 'scroll-mainnet',
  mantle: 'mantle-mainnet',
  blast: 'blast-mainnet',
  worldchain: 'worldchain-mainnet',
  unichain: 'unichain-mainnet',
  berachain: 'berachain-mainnet',
  zksync: 'zksync-mainnet',
  ink: 'ink-mainnet',
  gnosis: 'gnosis-mainnet',
  monad: 'monad-mainnet',
};

const MORALIS_CHAIN_HEX: Partial<Record<EvmChainId, string>> = {
  ethereum: '0x1',
  base: '0x2105',
  arbitrum: '0xa4b1',
  optimism: '0xa',
  polygon: '0x89',
  avalanche: '0xa86a',
  bnb: '0x38',
  linea: '0xe708',
  blast: '0x13e31',
  gnosis: '0x64',
  monad: '0x8f',
};

export const MIN_VERIFIED_DEX_LIQUIDITY_USD = 2_500;

export function getL2IndexerProvider(): 'sim' | 'alchemy' | 'moralis' | 'none' {
  if (process.env.SIM_API_KEY?.trim()) return 'sim';
  if (process.env.ALCHEMY_API_KEY?.trim()) return 'alchemy';
  if (process.env.MORALIS_API_KEY?.trim()) return 'moralis';
  return 'none';
}

export interface DetectedDefiReceipt {
  kind: 'aave_v3' | 'erc4626';
  protocol: string;
  protocolAddress: string;
  underlyingAddress: string;
}

function decodeAbiAddressWord(hex: string): string | null {
  const clean = hex.replace(/^0x/, '');
  if (clean.length < 64) return null;
  const addr = '0x' + clean.slice(24, 64).toLowerCase();
  if (addr === '0x0000000000000000000000000000000000000000') return null;
  return addr;
}

/**
 * Probes arbitrary discovered ERC-20 contracts in Multicall3 batches to automatically detect:
 *  - Verified Aave v3 aTokens via `UNDERLYING_ASSET_ADDRESS()` (0xb16a19de) + `POOL()` (0x7535d246),
 *    checked against the per-chain Aave v3 Pool allowlist AND authenticated via
 *    `POOL.getReserveData(underlying)` (`0x35ea6a75`) confirming `aTokenAddress === tokenAddr`
 *    (explicitly rejecting `variableDebt*`, `stableDebt*`, and spoofed airdrop contracts).
 *  - Verified ERC-4626 Vaults via `asset()` (0x38d52e0f) + onchain backing checks for non-curated vaults.
 */
export async function probeDefiReceiptContracts(
  chain: EvmChainId,
  tokenAddresses: string[],
  rawBalances?: Map<string, bigint>
): Promise<Map<string, DetectedDefiReceipt>> {
  const detected = new Map<string, DetectedDefiReceipt>();
  const cfg = EVM_CHAINS[chain];
  const unique = Array.from(
    new Set(tokenAddresses.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)).map((a) => a.toLowerCase()))
  ).slice(0, 20);
  if (!cfg || !unique.length) return detected;

  // Pass 1 — 3 probes per token: [0] UNDERLYING_ASSET_ADDRESS(), [1] POOL(), [2] asset()
  const calls = unique.flatMap((target) => [
    { target, allowFailure: true, callData: DEFI_SELECTORS.aaveUnderlyingAsset },
    { target, allowFailure: true, callData: DEFI_SELECTORS.aaveV3Pool },
    { target, allowFailure: true, callData: DEFI_SELECTORS.asset },
  ]);

  try {
    const mcData = encodeMulticall3Aggregate3(calls);
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: mcData }, 'latest'],
      3500
    );
    if (!json.result || json.result === '0x') return detected;
    const results = decodeMulticall3Aggregate3(json.result);

    const aaveCandidates: Array<{
      tokenAddress: string;
      poolAddress: string;
      underlyingAddress: string;
    }> = [];
    const erc4626Candidates: Array<{
      vaultAddress: string;
      underlyingAddress: string;
      userShares: bigint;
    }> = [];

    for (let i = 0; i < unique.length; i++) {
      const addr = unique[i];
      const rUnderlying = results[i * 3];
      const rPool = results[i * 3 + 1];
      const rAsset = results[i * 3 + 2];

      const aaveUnderlying = rUnderlying?.success ? decodeAbiAddressWord(rUnderlying.returnData) : null;
      const aavePool = rPool?.success ? decodeAbiAddressWord(rPool.returnData) : null;
      if (aaveUnderlying && aavePool) {
        if (isAllowedAaveV3Pool(chain, aavePool)) {
          aaveCandidates.push({
            tokenAddress: addr,
            poolAddress: aavePool,
            underlyingAddress: aaveUnderlying,
          });
        }
        // Never fall through to ERC-4626 on Aave-shaped contracts (including debt tokens or spoofed pools)
        continue;
      }

      const erc4626Asset = rAsset?.success ? decodeAbiAddressWord(rAsset.returnData) : null;
      if (erc4626Asset && erc4626Asset.toLowerCase() !== addr.toLowerCase()) {
        if (isCuratedDefiVault(chain, addr)) {
          detected.set(addr, {
            kind: 'erc4626',
            protocol: 'ERC-4626 Vault',
            protocolAddress: addr,
            underlyingAddress: erc4626Asset,
          });
        } else {
          erc4626Candidates.push({
            vaultAddress: addr,
            underlyingAddress: erc4626Asset,
            userShares: rawBalances?.get(addr) ?? 0n,
          });
        }
      }
    }

    // Pass 2 — Authenticate Aave v3 candidates via POOL.getReserveData(underlying) (`0x35ea6a75`)
    // and verify non-curated ERC-4626 vaults hold real redeemable underlying tokens.
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
        3500
      );
      if (verifyJson.result && verifyJson.result !== '0x') {
        const verifyDecoded = decodeMulticall3Aggregate3(verifyJson.result);
        for (let i = 0; i < aaveCandidates.length; i++) {
          const c = aaveCandidates[i];
          const r = verifyDecoded[i];
          if (!r?.success) continue;
          const reserve = decodeAaveV3ReserveData(r.returnData);
          if (!reserve?.aTokenAddress) continue;
          const tokenLower = c.tokenAddress.toLowerCase();
          if (
            reserve.variableDebtTokenAddress?.toLowerCase() === tokenLower ||
            reserve.stableDebtTokenAddress?.toLowerCase() === tokenLower
          ) {
            continue;
          }
          if (reserve.aTokenAddress.toLowerCase() === tokenLower) {
            detected.set(tokenLower, {
              kind: 'aave_v3',
              protocol: 'Aave v3',
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
          if (v.userShares > 0n && underlyingBal < convertAssets) {
            continue;
          }
          detected.set(v.vaultAddress.toLowerCase(), {
            kind: 'erc4626',
            protocol: 'ERC-4626 Vault',
            protocolAddress: v.vaultAddress,
            underlyingAddress: v.underlyingAddress,
          });
        }
      }
    }
  } catch {
    // non-fatal probe (fails closed)
  }
  return detected;
}

/**
 * Cryptographically verified 4-byte keccak256 ABI selectors for expanded DeFi receipt detection:
 * Morpho Blue / MetaMorpho ERC-4626 vaults, Fluid fTokens, Beefy mooTokens,
 * Pendle SY/PT/YT receipts, and Curve / Convex gauge staking tokens.
 */
export const EXPANDED_DEFI_SELECTORS = {
  // Morpho Blue / MetaMorpho ERC-4626
  morphoSingleton: '0x3acb5624', // MORPHO()
  morphoCurator: '0xe66f53b7', // curator()

  // Fluid fTokens (Instadapp Fluid ERC-4626)
  fluidLiquidity: '0x1a686502', // liquidity()

  // Beefy Finance mooTokens (Vault V6/V7)
  beefyWant: '0x1f1fcd51', // want()
  beefyPricePerFullShare: '0x77c7b8fc', // getPricePerFullShare()
  beefyStrategy: '0xa8c62e76', // strategy()
  beefyStrategyVault: '0xfbfa77cf', // vault()
  beefyBalance: '0xb69ef8a8', // balance()

  // Pendle SY / PT / YT receipts
  pendleSy: '0xafd27bf5', // SY()
  pendlePt: '0xd94073d4', // PT()
  pendleYt: '0x781c18db', // YT()
  pendleExpiry: '0xe184c9be', // expiry()
  pendleYieldToken: '0x76d5de85', // yieldToken()
  pendleAssetInfo: '0xa40bee50', // assetInfo()

  // Curve LiquidityGauge & Convex BaseRewardPool
  curveLpToken: '0x82c63066', // lp_token()
  curveWorkingSupply: '0x17e28089', // working_supply()
  convexStakingToken: '0x72f702f3', // stakingToken()
  convexOperator: '0x570ca735', // operator()
  convexPid: '0xf1068454', // pid()
  convexRewardToken: '0xf7c618c1', // rewardToken()
} as const;

/** Canonical Morpho Blue singleton contracts by EVM chain (fail-closed allowlist). */
export const MORPHO_BLUE_SINGLETONS: Partial<Record<EvmChainId, string>> = {
  ethereum: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  base: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
  arbitrum: '0x6c247b1F6182318877311737BaC0844bAa518F5e',
  optimism: '0xce95AfbB8EA029495c66020883F87aaE8864AF92',
  polygon: '0x1bF0c2541F820E775182832f06c0B7Fc27A25f67',
  unichain: '0x8f5ae9CddB9f68de460C77730b018Ae7E04a140A',
  worldchain: '0xE741BC7c34758b4caE05062794E8Ae24978AF432',
  scroll: '0x2dB5a9056cF113342E9C06a26C255c24A19f59d7',
  ink: '0x857f37517a5f32d1239c58958f14c3f41a2b1f26',
};

/** Canonical Instadapp Fluid Liquidity Layer singletons by EVM chain (fail-closed allowlist). */
export const FLUID_LIQUIDITY_SINGLETONS: Partial<Record<EvmChainId, string>> = {
  ethereum: '0x52Aa899454998Be5b000Ad077a46Bbe360F4e497',
  arbitrum: '0x52Aa899454998Be5b000Ad077a46Bbe360F4e497',
  base: '0x52Aa899454998Be5b000Ad077a46Bbe360F4e497',
  polygon: '0x52Aa899454998Be5b000Ad077a46Bbe360F4e497',
};

/** Canonical Convex Booster contracts by EVM chain (fail-closed allowlist). */
export const CONVEX_BOOSTER_CONTRACTS: Partial<Record<EvmChainId, string>> = {
  ethereum: '0xF403C135812408BFbE8713b5A23a04b3D48AAE31',
  arbitrum: '0xF403C135812408BFbE8713b5A23a04b3D48AAE31',
  polygon: '0xF403C135812408BFbE8713b5A23a04b3D48AAE31',
  optimism: '0xF403C135812408BFbE8713b5A23a04b3D48AAE31',
};

export type ExpandedDefiProtocolKind =
  | 'morpho_vault'
  | 'fluid_ftoken'
  | 'beefy_mootoken'
  | 'pendle_sy'
  | 'pendle_pt'
  | 'pendle_yt'
  | 'curve_gauge'
  | 'convex_gauge';

export interface ExpandedDefiDetection {
  kind: ExpandedDefiProtocolKind;
  protocol: string;
  protocolAddress: string;
  underlyingAddress: string;
  /** Optional secondary protocol contract (e.g. Morpho Blue singleton, Fluid Liquidity, Beefy strategy, Pendle SY) */
  controllerAddress?: string;
  /** True when the receipt is ERC-4626 redeem()-compatible */
  erc4626Compatible: boolean;
  /** Optional Pendle maturity timestamp (epoch seconds) */
  expiryTimestamp?: number;
  /** Optional Beefy pricePerFullShare (1e18 scaled) */
  pricePerFullShare?: bigint;
  /** Optional Convex pool id */
  poolId?: number;
}

export interface ExpandedDefiProbeSignals {
  chain: EvmChainId;
  tokenAddress: string;
  erc4626Asset?: string | null;
  morphoSingleton?: string | null;
  fluidLiquidity?: string | null;
  beefyWant?: string | null;
  beefyPricePerFullShare?: bigint | null;
  beefyStrategy?: string | null;
  beefyBalance?: bigint | null;
  pendleSy?: string | null;
  pendlePt?: string | null;
  pendleYt?: string | null;
  pendleExpiry?: bigint | null;
  pendleYieldToken?: string | null;
  curveLpToken?: string | null;
  curveWorkingSupply?: bigint | null;
  convexStakingToken?: string | null;
  convexOperator?: string | null;
  convexPid?: bigint | null;
  // Pass-2 onchain authentication & backing signals
  totalAssets?: bigint | null;
  convertToAssets?: bigint | null;
  vaultUnderlyingBalance?: bigint | null;
  controllerUnderlyingBalance?: bigint | null;
  beefyStrategyVault?: string | null;
  pendleCrossRefMatch?: boolean;
  pendleSyYieldToken?: string | null;
  totalSupply?: bigint | null;
  userShares?: bigint;
}

/**
 * Pure, strictly fail-closed classifier for expanded DeFi protocol receipts:
 *  - Morpho Blue / MetaMorpho ERC-4626 vaults (verified against MORPHO_BLUE_SINGLETONS + onchain backing)
 *  - Fluid fTokens (verified against FLUID_LIQUIDITY_SINGLETONS + onchain backing)
 *  - Beefy mooTokens (verified via want() + strategy() + strategy.vault() === token + getPricePerFullShare() > 0 + balance() > 0)
 *  - Pendle PT / YT / SY receipts (verified via SY/PT/YT cross-references + non-zero expiry/yieldToken/totalSupply)
 *  - Convex BaseRewardPool gauges (verified against CONVEX_BOOSTER_CONTRACTS + stakingToken backing)
 *  - Curve LiquidityGauge tokens (verified via lp_token() + working_supply() > 0 + lp_token.balanceOf(gauge) > 0)
 */
export function classifyExpandedDefiProbeResult(
  signals: ExpandedDefiProbeSignals
): ExpandedDefiDetection | null {
  const addrLower = signals.tokenAddress.toLowerCase();
  const userShares = signals.userShares ?? 0n;

  // 1. Morpho Blue / MetaMorpho ERC-4626 Vault
  const expectedMorpho = MORPHO_BLUE_SINGLETONS[signals.chain]?.toLowerCase();
  if (
    expectedMorpho &&
    signals.morphoSingleton?.toLowerCase() === expectedMorpho &&
    signals.erc4626Asset &&
    signals.erc4626Asset.toLowerCase() !== addrLower
  ) {
    const backedByVault =
      signals.vaultUnderlyingBalance !== null &&
      signals.vaultUnderlyingBalance !== undefined &&
      signals.vaultUnderlyingBalance > 0n &&
      (userShares <= 0n ||
        (signals.convertToAssets !== null &&
          signals.convertToAssets !== undefined &&
          signals.vaultUnderlyingBalance >= signals.convertToAssets));
    const backedByMorpho =
      signals.controllerUnderlyingBalance !== null &&
      signals.controllerUnderlyingBalance !== undefined &&
      signals.controllerUnderlyingBalance > 0n &&
      (userShares <= 0n ||
        (signals.convertToAssets !== null &&
          signals.convertToAssets !== undefined &&
          signals.controllerUnderlyingBalance >= signals.convertToAssets));

    if (
      signals.totalAssets !== null &&
      signals.totalAssets !== undefined &&
      signals.totalAssets > 0n &&
      signals.convertToAssets !== null &&
      signals.convertToAssets !== undefined &&
      signals.convertToAssets > 0n &&
      (backedByVault || backedByMorpho)
    ) {
      return {
        kind: 'morpho_vault',
        protocol: 'Morpho Vault (MetaMorpho)',
        protocolAddress: addrLower,
        underlyingAddress: signals.erc4626Asset.toLowerCase(),
        controllerAddress: expectedMorpho,
        erc4626Compatible: true,
      };
    }
    return null;
  }

  // 2. Fluid fTokens (Instadapp Fluid ERC-4626)
  const expectedFluid = FLUID_LIQUIDITY_SINGLETONS[signals.chain]?.toLowerCase();
  if (
    expectedFluid &&
    signals.fluidLiquidity?.toLowerCase() === expectedFluid &&
    signals.erc4626Asset &&
    signals.erc4626Asset.toLowerCase() !== addrLower
  ) {
    const backedByVault =
      signals.vaultUnderlyingBalance !== null &&
      signals.vaultUnderlyingBalance !== undefined &&
      signals.vaultUnderlyingBalance > 0n;
    const backedByFluid =
      signals.controllerUnderlyingBalance !== null &&
      signals.controllerUnderlyingBalance !== undefined &&
      signals.controllerUnderlyingBalance > 0n &&
      (userShares <= 0n ||
        (signals.convertToAssets !== null &&
          signals.convertToAssets !== undefined &&
          signals.controllerUnderlyingBalance >= signals.convertToAssets));

    if (
      signals.totalAssets !== null &&
      signals.totalAssets !== undefined &&
      signals.totalAssets > 0n &&
      signals.convertToAssets !== null &&
      signals.convertToAssets !== undefined &&
      signals.convertToAssets > 0n &&
      (backedByVault || backedByFluid)
    ) {
      return {
        kind: 'fluid_ftoken',
        protocol: 'Fluid fToken',
        protocolAddress: addrLower,
        underlyingAddress: signals.erc4626Asset.toLowerCase(),
        controllerAddress: expectedFluid,
        erc4626Compatible: true,
      };
    }
    return null;
  }

  // 3. Beefy mooTokens (Vault V6/V7)
  if (
    signals.beefyWant &&
    signals.beefyWant.toLowerCase() !== addrLower &&
    signals.beefyStrategy &&
    signals.beefyStrategy.toLowerCase() !== addrLower &&
    signals.beefyPricePerFullShare !== null &&
    signals.beefyPricePerFullShare !== undefined &&
    signals.beefyPricePerFullShare > 0n &&
    signals.beefyBalance !== null &&
    signals.beefyBalance !== undefined &&
    signals.beefyBalance > 0n
  ) {
    // Fail-closed: strategy.vault() MUST point back to this vault contract
    if (signals.beefyStrategyVault?.toLowerCase() === addrLower) {
      return {
        kind: 'beefy_mootoken',
        protocol: 'Beefy Vault',
        protocolAddress: addrLower,
        underlyingAddress: signals.beefyWant.toLowerCase(),
        controllerAddress: signals.beefyStrategy.toLowerCase(),
        erc4626Compatible: false,
        pricePerFullShare: signals.beefyPricePerFullShare,
      };
    }
    return null;
  }

  // 4. Pendle PT / YT / SY receipts
  if (
    signals.pendleSy &&
    signals.pendleSy.toLowerCase() !== addrLower &&
    signals.pendleExpiry !== null &&
    signals.pendleExpiry !== undefined &&
    signals.pendleExpiry > 0n &&
    signals.pendleExpiry < 10_000_000_000n
  ) {
    const expiryNum = Number(signals.pendleExpiry);
    if (signals.pendleYt && signals.pendleYt.toLowerCase() !== addrLower && !signals.pendlePt) {
      if (signals.pendleCrossRefMatch && signals.pendleSyYieldToken) {
        return {
          kind: 'pendle_pt',
          protocol: 'Pendle PT',
          protocolAddress: addrLower,
          underlyingAddress: signals.pendleSyYieldToken.toLowerCase(),
          controllerAddress: signals.pendleSy.toLowerCase(),
          erc4626Compatible: false,
          expiryTimestamp: expiryNum,
        };
      }
      return null;
    }
    if (signals.pendlePt && signals.pendlePt.toLowerCase() !== addrLower && !signals.pendleYt) {
      if (signals.pendleCrossRefMatch && signals.pendleSyYieldToken) {
        return {
          kind: 'pendle_yt',
          protocol: 'Pendle YT',
          protocolAddress: addrLower,
          underlyingAddress: signals.pendleSyYieldToken.toLowerCase(),
          controllerAddress: signals.pendleSy.toLowerCase(),
          erc4626Compatible: false,
          expiryTimestamp: expiryNum,
        };
      }
      return null;
    }
  }

  if (
    signals.pendleYieldToken &&
    signals.pendleYieldToken.toLowerCase() !== addrLower &&
    signals.totalSupply !== null &&
    signals.totalSupply !== undefined &&
    signals.totalSupply > 0n &&
    signals.vaultUnderlyingBalance !== null &&
    signals.vaultUnderlyingBalance !== undefined &&
    signals.vaultUnderlyingBalance > 0n
  ) {
    return {
      kind: 'pendle_sy',
      protocol: 'Pendle SY',
      protocolAddress: addrLower,
      underlyingAddress: signals.pendleYieldToken.toLowerCase(),
      erc4626Compatible: false,
    };
  }

  // 5. Convex BaseRewardPool gauge (operator === canonical Convex Booster)
  const expectedConvexBooster = CONVEX_BOOSTER_CONTRACTS[signals.chain]?.toLowerCase();
  if (
    expectedConvexBooster &&
    signals.convexOperator?.toLowerCase() === expectedConvexBooster &&
    signals.convexStakingToken &&
    signals.convexStakingToken.toLowerCase() !== addrLower &&
    signals.convexPid !== null &&
    signals.convexPid !== undefined &&
    signals.convexPid < 100_000n &&
    signals.totalSupply !== null &&
    signals.totalSupply !== undefined &&
    signals.totalSupply > 0n
  ) {
    return {
      kind: 'convex_gauge',
      protocol: 'Convex Gauge',
      protocolAddress: addrLower,
      underlyingAddress: signals.convexStakingToken.toLowerCase(),
      controllerAddress: expectedConvexBooster,
      erc4626Compatible: false,
      poolId: Number(signals.convexPid),
    };
  }

  // 6. Curve LiquidityGauge (lp_token() + working_supply() > 0 + lp_token.balanceOf(gauge) > 0)
  if (
    signals.curveLpToken &&
    signals.curveLpToken.toLowerCase() !== addrLower &&
    signals.curveWorkingSupply !== null &&
    signals.curveWorkingSupply !== undefined &&
    signals.curveWorkingSupply > 0n &&
    signals.vaultUnderlyingBalance !== null &&
    signals.vaultUnderlyingBalance !== undefined &&
    signals.vaultUnderlyingBalance > 0n
  ) {
    return {
      kind: 'curve_gauge',
      protocol: 'Curve Gauge',
      protocolAddress: addrLower,
      underlyingAddress: signals.curveLpToken.toLowerCase(),
      erc4626Compatible: false,
    };
  }

  return null;
}

/**
 * Lightweight symbol/name metadata hint matcher for expanded DeFi receipt protocols.
 * Never authorizes onchain execution by itself — used only as a fast classification hint
 * alongside onchain verification in `probeExpandedDefiContracts`.
 */
export function identifyDefiProtocolByMetadata(params: {
  symbol?: string | null;
  name?: string | null;
}): { kind: ExpandedDefiProtocolKind; protocol: string } | null {
  const sym = (params.symbol ?? '').trim();
  const name = (params.name ?? '').trim().toLowerCase();
  const symLower = sym.toLowerCase();

  if (
    /^gt[a-z0-9]{2,}$/i.test(sym) ||
    /^steak[a-z0-9]{2,}$/i.test(sym) ||
    /^bb[a-z0-9]{2,}$/i.test(sym) ||
    name.includes('metamorpho') ||
    name.includes('morpho vault') ||
    name.includes('morpho blue')
  ) {
    return { kind: 'morpho_vault', protocol: 'Morpho Vault (MetaMorpho)' };
  }
  if (/^f(usdc|usdt|weth|eth|wsteth|wbtc|dai|usds|susde)$/i.test(sym) || name.includes('fluid ')) {
    return { kind: 'fluid_ftoken', protocol: 'Fluid fToken' };
  }
  if (/^moo[A-Za-z0-9_-]{2,}$/.test(sym) || name.includes('beefy')) {
    return { kind: 'beefy_mootoken', protocol: 'Beefy Vault' };
  }
  if (/^PT-[A-Za-z0-9._-]+/i.test(sym) || name.startsWith('pt ')) {
    return { kind: 'pendle_pt', protocol: 'Pendle PT' };
  }
  if (/^YT-[A-Za-z0-9._-]+/i.test(sym) || name.startsWith('yt ')) {
    return { kind: 'pendle_yt', protocol: 'Pendle YT' };
  }
  if (/^SY-[A-Za-z0-9._-]+/i.test(sym) || name.startsWith('sy ')) {
    return { kind: 'pendle_sy', protocol: 'Pendle SY' };
  }
  if (/^cvx[a-z0-9._-]*-f$/i.test(sym) || name.includes('convex') || symLower.includes('cvxcrv')) {
    return { kind: 'convex_gauge', protocol: 'Convex Gauge' };
  }
  if (/-gauge$/i.test(sym) || name.includes('curve') && name.includes('gauge')) {
    return { kind: 'curve_gauge', protocol: 'Curve Gauge' };
  }
  return null;
}

/**
 * Probes arbitrary discovered ERC-20 contracts in 2 fail-closed Multicall3 passes to identify
 * expanded DeFi receipt tokens:
 *  - Morpho Blue / MetaMorpho ERC-4626 vaults (`MORPHO()` + `asset()` + backing)
 *  - Fluid fTokens (`liquidity()` + `asset()` + backing)
 *  - Beefy mooTokens (`want()` + `getPricePerFullShare()` + `strategy()` + `balance()` + `strategy.vault() === token`)
 *  - Pendle SY / PT / YT receipts (`SY()`, `PT()`, `YT()`, `expiry()`, `yieldToken()` + cross-reference)
 *  - Curve / Convex gauge tokens (`lp_token()` + `working_supply()` / `stakingToken()` + `operator()` + `pid()`)
 *
 * Strictly fail-closed: RPC errors, spoofed singletons, unbacked vaults, or mismatched cross-references
 * are always rejected silently without throwing.
 */
export async function probeExpandedDefiContracts(params: {
  chain: EvmChainId;
  tokenAddresses: string[];
  rawBalances?: Map<string, bigint>;
}): Promise<Map<string, ExpandedDefiDetection>> {
  const detected = new Map<string, ExpandedDefiDetection>();
  const cfg = EVM_CHAINS[params.chain];
  const unique = Array.from(
    new Set(
      params.tokenAddresses
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        .map((a) => a.toLowerCase())
    )
  ).slice(0, 16);
  if (!cfg || !unique.length) return detected;

  // Pass 1 — 16 probes per token in 1 Multicall3 batch
  const PROBES_PER_TOKEN = 16;
  const calls = unique.flatMap((target) => [
    { target, allowFailure: true, callData: DEFI_SELECTORS.asset }, // 0
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.morphoSingleton }, // 1
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.fluidLiquidity }, // 2
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.beefyWant }, // 3
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.beefyPricePerFullShare }, // 4
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.beefyStrategy }, // 5
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.beefyBalance }, // 6
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.pendleSy }, // 7
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.pendlePt }, // 8
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.pendleYt }, // 9
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.pendleExpiry }, // 10
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.pendleYieldToken }, // 11
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.curveLpToken }, // 12
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.curveWorkingSupply }, // 13
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.convexStakingToken }, // 14
    { target, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.convexOperator }, // 15
  ]);

  try {
    const mcData = encodeMulticall3Aggregate3(calls);
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: mcData }, 'latest'],
      4000
    );
    if (!json.result || json.result === '0x') return detected;
    const results = decodeMulticall3Aggregate3(json.result);

    type VerifyPlan = {
      signals: ExpandedDefiProbeSignals;
      kindHint:
        | 'morpho'
        | 'fluid'
        | 'beefy'
        | 'pendle_pt'
        | 'pendle_yt'
        | 'pendle_sy'
        | 'convex'
        | 'curve';
      callStartIndex: number;
      callCount: number;
    };

    const verifyCalls: Array<{ target: string; allowFailure: boolean; callData: string }> = [];
    const plans: VerifyPlan[] = [];
    const expectedMorpho = MORPHO_BLUE_SINGLETONS[params.chain]?.toLowerCase();
    const expectedFluid = FLUID_LIQUIDITY_SINGLETONS[params.chain]?.toLowerCase();
    const expectedConvex = CONVEX_BOOSTER_CONTRACTS[params.chain]?.toLowerCase();

    for (let i = 0; i < unique.length; i++) {
      const addr = unique[i];
      const base = i * PROBES_PER_TOKEN;
      const userShares = params.rawBalances?.get(addr) ?? 0n;
      const probeShares = userShares > 0n ? userShares : 1n;

      const erc4626Asset = results[base]?.success ? decodeAbiAddressWord(results[base].returnData) : null;
      const morphoSingleton = results[base + 1]?.success ? decodeAbiAddressWord(results[base + 1].returnData) : null;
      const fluidLiquidity = results[base + 2]?.success ? decodeAbiAddressWord(results[base + 2].returnData) : null;
      const beefyWant = results[base + 3]?.success ? decodeAbiAddressWord(results[base + 3].returnData) : null;
      const beefyPps = results[base + 4]?.success ? decodeAbiUint256Word(results[base + 4].returnData) : null;
      const beefyStrategy = results[base + 5]?.success ? decodeAbiAddressWord(results[base + 5].returnData) : null;
      const beefyBalance = results[base + 6]?.success ? decodeAbiUint256Word(results[base + 6].returnData) : null;
      const pendleSy = results[base + 7]?.success ? decodeAbiAddressWord(results[base + 7].returnData) : null;
      const pendlePt = results[base + 8]?.success ? decodeAbiAddressWord(results[base + 8].returnData) : null;
      const pendleYt = results[base + 9]?.success ? decodeAbiAddressWord(results[base + 9].returnData) : null;
      const pendleExpiry = results[base + 10]?.success ? decodeAbiUint256Word(results[base + 10].returnData) : null;
      const pendleYieldToken = results[base + 11]?.success ? decodeAbiAddressWord(results[base + 11].returnData) : null;
      const curveLpToken = results[base + 12]?.success ? decodeAbiAddressWord(results[base + 12].returnData) : null;
      const curveWorkingSupply = results[base + 13]?.success ? decodeAbiUint256Word(results[base + 13].returnData) : null;
      const convexStakingToken = results[base + 14]?.success ? decodeAbiAddressWord(results[base + 14].returnData) : null;
      const convexOperator = results[base + 15]?.success ? decodeAbiAddressWord(results[base + 15].returnData) : null;

      const baseSignals: ExpandedDefiProbeSignals = {
        chain: params.chain,
        tokenAddress: addr,
        erc4626Asset,
        morphoSingleton,
        fluidLiquidity,
        beefyWant,
        beefyPricePerFullShare: beefyPps,
        beefyStrategy,
        beefyBalance,
        pendleSy,
        pendlePt,
        pendleYt,
        pendleExpiry,
        pendleYieldToken,
        curveLpToken,
        curveWorkingSupply,
        convexStakingToken,
        convexOperator,
        userShares,
      };

      const start = verifyCalls.length;
      if (expectedMorpho && morphoSingleton?.toLowerCase() === expectedMorpho && erc4626Asset && erc4626Asset !== addr) {
        verifyCalls.push(
          { target: addr, allowFailure: true, callData: DEFI_SELECTORS.erc4626TotalAssets },
          { target: addr, allowFailure: true, callData: encodeErc4626ConvertToAssets(probeShares) },
          { target: erc4626Asset, allowFailure: true, callData: `${DEFI_SELECTORS.balanceOf}${pad32Hex(addr)}` },
          { target: erc4626Asset, allowFailure: true, callData: `${DEFI_SELECTORS.balanceOf}${pad32Hex(expectedMorpho)}` }
        );
        plans.push({ signals: baseSignals, kindHint: 'morpho', callStartIndex: start, callCount: 4 });
        continue;
      }

      if (expectedFluid && fluidLiquidity?.toLowerCase() === expectedFluid && erc4626Asset && erc4626Asset !== addr) {
        verifyCalls.push(
          { target: addr, allowFailure: true, callData: DEFI_SELECTORS.erc4626TotalAssets },
          { target: addr, allowFailure: true, callData: encodeErc4626ConvertToAssets(probeShares) },
          { target: erc4626Asset, allowFailure: true, callData: `${DEFI_SELECTORS.balanceOf}${pad32Hex(addr)}` },
          { target: erc4626Asset, allowFailure: true, callData: `${DEFI_SELECTORS.balanceOf}${pad32Hex(expectedFluid)}` }
        );
        plans.push({ signals: baseSignals, kindHint: 'fluid', callStartIndex: start, callCount: 4 });
        continue;
      }

      if (beefyWant && beefyWant !== addr && beefyStrategy && beefyStrategy !== addr && beefyPps && beefyPps > 0n && beefyBalance && beefyBalance > 0n) {
        verifyCalls.push({
          target: beefyStrategy,
          allowFailure: true,
          callData: EXPANDED_DEFI_SELECTORS.beefyStrategyVault,
        });
        plans.push({ signals: baseSignals, kindHint: 'beefy', callStartIndex: start, callCount: 1 });
        continue;
      }

      if (pendleSy && pendleSy !== addr && pendleExpiry && pendleExpiry > 0n && pendleYt && pendleYt !== addr && !pendlePt) {
        verifyCalls.push(
          { target: pendleYt, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.pendlePt },
          { target: pendleSy, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.pendleYieldToken }
        );
        plans.push({ signals: baseSignals, kindHint: 'pendle_pt', callStartIndex: start, callCount: 2 });
        continue;
      }

      if (pendleSy && pendleSy !== addr && pendleExpiry && pendleExpiry > 0n && pendlePt && pendlePt !== addr && !pendleYt) {
        verifyCalls.push(
          { target: pendlePt, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.pendleYt },
          { target: pendleSy, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.pendleYieldToken }
        );
        plans.push({ signals: baseSignals, kindHint: 'pendle_yt', callStartIndex: start, callCount: 2 });
        continue;
      }

      if (pendleYieldToken && pendleYieldToken !== addr) {
        verifyCalls.push(
          { target: addr, allowFailure: true, callData: DEFI_SELECTORS.totalSupply },
          { target: pendleYieldToken, allowFailure: true, callData: `${DEFI_SELECTORS.balanceOf}${pad32Hex(addr)}` }
        );
        plans.push({ signals: baseSignals, kindHint: 'pendle_sy', callStartIndex: start, callCount: 2 });
        continue;
      }

      if (expectedConvex && convexOperator?.toLowerCase() === expectedConvex && convexStakingToken && convexStakingToken !== addr) {
        verifyCalls.push(
          { target: addr, allowFailure: true, callData: EXPANDED_DEFI_SELECTORS.convexPid },
          { target: addr, allowFailure: true, callData: DEFI_SELECTORS.totalSupply }
        );
        plans.push({ signals: baseSignals, kindHint: 'convex', callStartIndex: start, callCount: 2 });
        continue;
      }

      if (curveLpToken && curveLpToken !== addr && curveWorkingSupply && curveWorkingSupply > 0n) {
        verifyCalls.push({
          target: curveLpToken,
          allowFailure: true,
          callData: `${DEFI_SELECTORS.balanceOf}${pad32Hex(addr)}`,
        });
        plans.push({ signals: baseSignals, kindHint: 'curve', callStartIndex: start, callCount: 1 });
      }
    }

    if (verifyCalls.length > 0) {
      const verifyMc = encodeMulticall3Aggregate3(verifyCalls);
      const verifyJson = await evmJsonRpcCall<string>(
        cfg.rpcUrls,
        'eth_call',
        [{ to: cfg.multicall3, data: verifyMc }, 'latest'],
        4000
      );
      if (verifyJson.result && verifyJson.result !== '0x') {
        const vRes = decodeMulticall3Aggregate3(verifyJson.result);
        for (const plan of plans) {
          const idx = plan.callStartIndex;
          const s = plan.signals;
          if (plan.kindHint === 'morpho' || plan.kindHint === 'fluid') {
            s.totalAssets = vRes[idx]?.success ? decodeAbiUint256Word(vRes[idx].returnData) : null;
            s.convertToAssets = vRes[idx + 1]?.success ? decodeAbiUint256Word(vRes[idx + 1].returnData) : null;
            s.vaultUnderlyingBalance = vRes[idx + 2]?.success ? decodeAbiUint256Word(vRes[idx + 2].returnData) : null;
            s.controllerUnderlyingBalance = vRes[idx + 3]?.success ? decodeAbiUint256Word(vRes[idx + 3].returnData) : null;
          } else if (plan.kindHint === 'beefy') {
            s.beefyStrategyVault = vRes[idx]?.success ? decodeAbiAddressWord(vRes[idx].returnData) : null;
          } else if (plan.kindHint === 'pendle_pt' || plan.kindHint === 'pendle_yt') {
            const crossRefAddr = vRes[idx]?.success ? decodeAbiAddressWord(vRes[idx].returnData) : null;
            s.pendleCrossRefMatch = crossRefAddr?.toLowerCase() === s.tokenAddress.toLowerCase();
            s.pendleSyYieldToken = vRes[idx + 1]?.success ? decodeAbiAddressWord(vRes[idx + 1].returnData) : null;
          } else if (plan.kindHint === 'pendle_sy') {
            s.totalSupply = vRes[idx]?.success ? decodeAbiUint256Word(vRes[idx].returnData) : null;
            s.vaultUnderlyingBalance = vRes[idx + 1]?.success ? decodeAbiUint256Word(vRes[idx + 1].returnData) : null;
          } else if (plan.kindHint === 'convex') {
            s.convexPid = vRes[idx]?.success ? decodeAbiUint256Word(vRes[idx].returnData) : null;
            s.totalSupply = vRes[idx + 1]?.success ? decodeAbiUint256Word(vRes[idx + 1].returnData) : null;
          } else if (plan.kindHint === 'curve') {
            s.vaultUnderlyingBalance = vRes[idx]?.success ? decodeAbiUint256Word(vRes[idx].returnData) : null;
          }

          const classified = classifyExpandedDefiProbeResult(s);
          if (classified) {
            detected.set(s.tokenAddress.toLowerCase(), classified);
          }
        }
      }
    }
  } catch {
    // non-fatal probe (strictly fail-closed)
  }

  return detected;
}

export interface AaveAccountSafety {
  checked: boolean;
  hasActiveDebt: boolean;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  currentLiquidationThresholdBps: number;
  healthFactor: number;
  safeForMaxWithdraw: boolean;
  reason: string;
}

/**
 * Decodes Aave v3 Pool.getUserAccountData(address) 6-word return tuple:
 * (totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor).
 */
export function decodeAaveAccountData(hexResult: string): AaveAccountSafety {
  const clean = hexResult.replace(/^0x/, '');
  if (clean.length < 64 * 6) {
    return {
      checked: false,
      hasActiveDebt: false,
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      currentLiquidationThresholdBps: 8000,
      healthFactor: Number.POSITIVE_INFINITY,
      safeForMaxWithdraw: false,
      reason: 'Empty Aave account data response (fail-closed safety pause).',
    };
  }
  const word = (i: number) => BigInt('0x' + clean.slice(i * 64, (i + 1) * 64));
  const totalCollateralBase = word(0);
  const totalDebtBase = word(1);
  const currentLiquidationThreshold = Number(word(3));
  const hfRaw = word(5);

  const totalCollateralUsd = Number(totalCollateralBase) / 1e8;
  const totalDebtUsd = Number(totalDebtBase) / 1e8;
  const hasActiveDebt = totalDebtBase > 0n;
  const healthFactor =
    !hasActiveDebt || hfRaw > 10n ** 24n ? Number.POSITIVE_INFINITY : Number(hfRaw) / 1e18;

  return {
    checked: true,
    hasActiveDebt,
    totalCollateralUsd: Number(totalCollateralUsd.toFixed(2)),
    totalDebtUsd: Number(totalDebtUsd.toFixed(2)),
    currentLiquidationThresholdBps:
      currentLiquidationThreshold > 0 && currentLiquidationThreshold <= 10_000
        ? currentLiquidationThreshold
        : 8000,
    healthFactor: Number.isFinite(healthFactor) ? Number(healthFactor.toFixed(2)) : 999,
    safeForMaxWithdraw: !hasActiveDebt,
    reason: hasActiveDebt
      ? `Active Aave v3 borrow detected ($${totalDebtUsd.toFixed(2)} debt · HF ${healthFactor.toFixed(2)}). Repay debt before MAX withdrawal to prevent revert or liquidation.`
      : 'Verified onchain: zero Aave v3 debt (safe for MAX withdrawal).',
  };
}

/**
 * Queries Aave v3 Pool.getUserAccountData(user) (`0xbf92857c`) live onchain with multi-RPC failover.
 */
export async function checkAaveV3AccountSafety(
  chain: EvmChainId,
  userAddress: string,
  poolAddressOverride?: string
): Promise<AaveAccountSafety> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(userAddress)) {
    return {
      checked: true,
      hasActiveDebt: true,
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      currentLiquidationThresholdBps: 8000,
      healthFactor: 0,
      safeForMaxWithdraw: false,
      reason: 'Invalid EVM address supplied to Aave v3 account safety check (failing closed).',
    };
  }
  const cfg = EVM_CHAINS[chain];
  const poolAddress = poolAddressOverride || cfg?.aaveV3Pool;
  if (!cfg || !poolAddress) {
    return {
      checked: false,
      hasActiveDebt: false,
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      currentLiquidationThresholdBps: 8000,
      healthFactor: 999,
      safeForMaxWithdraw: false,
      reason: 'Aave Pool not configured on this chain.',
    };
  }

  const userPad = userAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const data = `0xbf92857c${userPad}`;
  try {
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: poolAddress, data }, 'latest'],
      3500
    );
    if (!json.result || json.result === '0x') {
      return {
        checked: false,
        hasActiveDebt: false,
        totalCollateralUsd: 0,
        totalDebtUsd: 0,
        currentLiquidationThresholdBps: 8000,
        healthFactor: 999,
        safeForMaxWithdraw: false,
        reason: 'Could not read Aave account data from RPC.',
      };
    }
    return decodeAaveAccountData(json.result);
  } catch {
    return {
      checked: false,
      hasActiveDebt: false,
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      currentLiquidationThresholdBps: 8000,
      healthFactor: 999,
      safeForMaxWithdraw: false,
      reason: 'Aave account debt check timed out on RPC.',
    };
  }
}

export interface DexLiquidityInfo {
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  dexId?: string;
}

export interface DexLiquidityBatchResult {
  liquidity: Map<string, DexLiquidityInfo>;
  ok: boolean;
  queriedAddresses: Set<string>;
  error?: string;
}

/**
 * Batch-verifies real DEX liquidity & spot price for up to 30 token addresses on a chain
 * using DexScreener's free public API, explicitly distinguishing a genuine 0-pair response
 * (`ok: true`) from an HTTP error / timeout / network failure (`ok: false`).
 */
export async function fetchDexLiquidityBatchWithStatus(
  chain: EvmChainId,
  tokenAddresses: string[]
): Promise<DexLiquidityBatchResult> {
  const out = new Map<string, DexLiquidityInfo>();
  const slug = DEXSCREENER_CHAIN_SLUGS[chain];
  const unique = Array.from(
    new Set(
      tokenAddresses
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        .map((a) => a.toLowerCase())
    )
  ).slice(0, 30);
  const queriedAddresses = new Set<string>(unique);

  if (!slug) {
    return { liquidity: out, ok: false, queriedAddresses: new Set(), error: `Unsupported DexScreener chain ${chain}` };
  }
  if (!unique.length) {
    return { liquidity: out, ok: true, queriedAddresses };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const url = `https://api.dexscreener.com/tokens/v1/${slug}/${unique.join(',')}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        liquidity: out,
        ok: false,
        queriedAddresses,
        error: `DexScreener HTTP ${res.status}`,
      };
    }

    const pairs = (await res.json()) as Array<{
      dexId?: string;
      baseToken?: { address?: string };
      quoteToken?: { address?: string };
      priceUsd?: string;
      priceNative?: string;
      liquidity?: { usd?: number };
      volume?: { h24?: number };
    }>;

    if (!Array.isArray(pairs)) {
      return {
        liquidity: out,
        ok: false,
        queriedAddresses,
        error: 'Malformed DexScreener response',
      };
    }
    for (const pair of pairs) {
      const baseAddr = pair.baseToken?.address?.toLowerCase();
      const quoteAddr = pair.quoteToken?.address?.toLowerCase();
      const rawLiq = Number(pair.liquidity?.usd ?? 0);
      const safeLiq = Number.isFinite(rawLiq) && rawLiq > 0 ? rawLiq : 0;
      const rawPrice = Number(pair.priceUsd ?? 0);
      const safeBasePrice = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : 0;
      const rawVol = Number(pair.volume?.h24 ?? 0);
      const safeVol = Number.isFinite(rawVol) && rawVol > 0 ? rawVol : 0;

      if (baseAddr) {
        const prev = out.get(baseAddr);
        if (!prev || safeLiq > prev.liquidityUsd || (safeBasePrice > 0 && prev.priceUsd <= 0)) {
          out.set(baseAddr, {
            priceUsd: safeBasePrice > 0 ? safeBasePrice : prev?.priceUsd ?? 0,
            liquidityUsd: Math.max(safeLiq, prev?.liquidityUsd ?? 0),
            volume24hUsd: safeLiq >= (prev?.liquidityUsd ?? 0) ? safeVol : prev?.volume24hUsd ?? safeVol,
            dexId: pair.dexId ?? prev?.dexId,
          });
        }
      }

      // HIGH-07: Also match queried tokens that appear on the quote side of a DexScreener pair
      // (e.g., WETH / USDC / WBTC / major quote assets) so they are never treated as zero liquidity.
      if (quoteAddr && quoteAddr !== baseAddr && queriedAddresses.has(quoteAddr)) {
        const rawPriceNative = Number(pair.priceNative ?? 0);
        const derivedQuotePrice =
          safeBasePrice > 0 && Number.isFinite(rawPriceNative) && rawPriceNative > 0
            ? safeBasePrice / rawPriceNative
            : 0;
        const safeQuotePrice =
          Number.isFinite(derivedQuotePrice) && derivedQuotePrice > 0 ? derivedQuotePrice : 0;
        const prev = out.get(quoteAddr);
        if (
          !prev ||
          (safeQuotePrice > 0 && (prev.priceUsd <= 0 || safeLiq > prev.liquidityUsd)) ||
          (prev.priceUsd <= 0 && safeLiq > prev.liquidityUsd)
        ) {
          out.set(quoteAddr, {
            priceUsd: safeQuotePrice > 0 ? safeQuotePrice : prev?.priceUsd ?? 0,
            liquidityUsd: Math.max(safeLiq, prev?.liquidityUsd ?? 0),
            volume24hUsd: safeLiq >= (prev?.liquidityUsd ?? 0) ? safeVol : prev?.volume24hUsd ?? safeVol,
            dexId: pair.dexId ?? prev?.dexId,
          });
        }
      }
    }
    return { liquidity: out, ok: true, queriedAddresses };
  } catch (err) {
    clearTimeout(timer);
    return {
      liquidity: out,
      ok: false,
      queriedAddresses,
      error: err instanceof Error ? err.message : 'DexScreener lookup failed',
    };
  }
}

/**
 * Batch-verifies real DEX liquidity & spot price for up to 30 token addresses on a chain
 * using DexScreener's free public API so fake-price spam tokens never inflate portfolio totals.
 */
export async function fetchDexLiquidityBatch(
  chain: EvmChainId,
  tokenAddresses: string[]
): Promise<Map<string, DexLiquidityInfo>> {
  const res = await fetchDexLiquidityBatchWithStatus(chain, tokenAddresses);
  return res.liquidity;
}

const KNOWN_EIP2612_SYMBOLS = new Set([
  'USDC',
  'DAI',
  'USDS',
  'sUSDS',
  'sDAI',
  'UNI',
  'AAVE',
  'wstETH',
  'ARB',
  'OP',
  'AERO',
  'PENDLE',
  'cbETH',
]);

/**
 * Returns true if the token contract is known to implement EIP-2612 gasless permit()
 * (native Circle USDC v2+ across all 6 CCTP chains + major DeFi ERC-20s).
 */
export function isEip2612Token(chain: EvmChainId, address: string, symbol?: string): boolean {
  if (!address || address === 'native') return false;
  const cfg = EVM_CHAINS[chain];
  if (cfg && address.toLowerCase() === cfg.usdcAddress.toLowerCase()) return true;
  if (symbol && KNOWN_EIP2612_SYMBOLS.has(symbol)) return true;
  return false;
}

/**
 * Checks in a SINGLE Multicall3.aggregate3 RPC call which ERC-20 tokens on a chain
 * already have non-zero allowance granted to Uniswap's canonical Permit2 contract.
 */
export async function detectPermit2Allowances(params: {
  chain: EvmChainId;
  owner: string;
  tokenAddresses: string[];
}): Promise<Set<string>> {
  const approved = new Set<string>();
  const cfg = EVM_CHAINS[params.chain];
  const uniqueTokens = Array.from(
    new Set(
      params.tokenAddresses
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        .map((a) => a.toLowerCase())
    )
  );
  if (!cfg || !uniqueTokens.length) return approved;

  const ownerPad = params.owner.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const permit2Pad = PERMIT2_ADDRESS.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const callData = `0xdd62ed3e${ownerPad}${permit2Pad}`;

  const mcData = encodeMulticall3Aggregate3(
    uniqueTokens.map((target) => ({
      target,
      allowFailure: true,
      callData,
    }))
  );

  try {
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: mcData }, 'latest'],
      3500
    );
    if (!json.result || json.result === '0x') return approved;

    const decoded = decodeMulticall3Aggregate3(json.result);
    for (let i = 0; i < Math.min(uniqueTokens.length, decoded.length); i++) {
      const item = decoded[i];
      if (!item.success) continue;
      const hex = item.returnData.replace(/^0x/, '');
      if (hex.length < 64) continue;
      try {
        if (BigInt('0x' + hex.slice(0, 64)) > 0n) {
          approved.add(uniqueTokens[i]);
        }
      } catch {
        // ignore malformed return
      }
    }
  } catch {
    // Non-fatal: simply return empty set on RPC timeout
  }

  return approved;
}

export interface DiscoveredEthToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  rawBalance: bigint;
  ethplorerPriceUsd: number;
}

/**
 * Discovers arbitrary ERC-20 tokens (including long-tail dust & zero-liquidity dead tokens)
 * held by an Ethereum Mainnet address via Ethplorer's free public API.
 */
export async function discoverEthereumTokens(
  walletAddress: string,
  maxTokens = 30
): Promise<DiscoveredEthToken[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const url = `https://api.ethplorer.io/getAddressInfo/${encodeURIComponent(walletAddress)}?apiKey=freekey`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];

    const json = (await res.json()) as {
      tokens?: Array<{
        rawBalance?: string;
        tokenInfo?: {
          address?: string;
          symbol?: string;
          name?: string;
          decimals?: string | number;
          price?: { rate?: number } | false;
        };
      }>;
    };

    const items = json.tokens ?? [];
    const out: DiscoveredEthToken[] = [];

    for (const item of items) {
      const info = item.tokenInfo;
      if (!info?.address || !item.rawBalance) continue;
      if (!/^0x[0-9a-fA-F]{40}$/.test(info.address)) continue;

      let rawBal = 0n;
      try {
        rawBal = BigInt(item.rawBalance);
      } catch {
        continue;
      }
      if (rawBal <= 0n) continue;

      const decimals = Math.min(36, Math.max(0, Number(info.decimals ?? 18) || 18));
      const priceUsd =
        info.price && typeof info.price === 'object' && typeof info.price.rate === 'number'
          ? info.price.rate
          : 0;

      out.push({
        address: info.address,
        symbol: sanitizeTokenSymbol(info.symbol, 'UNKNOWN'),
        name: sanitizeTokenName(info.name || info.symbol, 'ERC-20 Token'),
        decimals,
        rawBalance: rawBal,
        ethplorerPriceUsd: priceUsd,
      });
    }

    // Reserve room for both valued tokens and zero-liquidity dead tokens so real wallets surface burn candidates
    const deadCap = Math.min(6, Math.floor(maxTokens / 4));
    const dead = out.filter((t) => t.ethplorerPriceUsd === 0).slice(0, deadCap);
    const valued = out.filter((t) => t.ethplorerPriceUsd > 0).slice(0, maxTokens - dead.length);
    return [...valued, ...dead];
  } catch {
    return [];
  }
}

/**
 * Discovers arbitrary ERC-20 tokens on ANY of the 6 EVM chains when SIM_API_KEY,
 * MORALIS_API_KEY, or ALCHEMY_API_KEY is configured, falling back to Ethplorer on Ethereum.
 */
const BLOCKSCOUT_V2_HOSTS: Partial<Record<EvmChainId, string>> = {
  ethereum: 'https://eth.blockscout.com',
  base: 'https://base.blockscout.com',
  optimism: 'https://optimism.blockscout.com',
  arbitrum: 'https://arbitrum.blockscout.com',
  polygon: 'https://polygon.blockscout.com',
  scroll: 'https://scroll.blockscout.com',
  unichain: 'https://unichain.blockscout.com',
  worldchain: 'https://worldchain-mainnet.explorer.alchemy.com',
  zksync: 'https://zksync.blockscout.com',
  ink: 'https://explorer.inkonchain.com',
};

/**
 * Zero-key public Blockscout v2 token-balances discovery covering Ethereum + major L2s
 * (Base, Optimism, Arbitrum, Polygon, Scroll, Unichain, World Chain) without needing paid API keys.
 */
async function discoverBlockscoutTokens(
  chain: EvmChainId,
  walletAddress: string,
  maxTokens = 24
): Promise<DiscoveredEthToken[]> {
  const host = BLOCKSCOUT_V2_HOSTS[chain];
  if (!host) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3800);
  try {
    const res = await fetch(
      `${host}/api/v2/addresses/${encodeURIComponent(walletAddress)}/token-balances`,
      { headers: { Accept: 'application/json' }, signal: controller.signal }
    );
    clearTimeout(timer);
    if (!res.ok) return [];
    const items = (await res.json()) as Array<{
      value?: string;
      token?: {
        address?: string;
        address_hash?: string;
        symbol?: string;
        name?: string;
        decimals?: string | number;
        type?: string;
        exchange_rate?: string | number | null;
      };
    }>;
    if (!Array.isArray(items)) return [];
    const out: DiscoveredEthToken[] = [];
    for (const item of items) {
      const tok = item.token;
      const addr = tok?.address_hash || tok?.address;
      if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) continue;
      if (tok?.type && tok.type !== 'ERC-20') continue;
      if (!item.value) continue;
      try {
        const rawBalance = BigInt(item.value);
        if (rawBalance <= 0n) continue;
        const decimals = Math.min(36, Math.max(0, Number(tok?.decimals ?? 18) || 18));
        const rate = Number(tok?.exchange_rate ?? 0);
        out.push({
          address: addr,
          symbol: sanitizeTokenSymbol(tok?.symbol, 'UNKNOWN'),
          name: sanitizeTokenName(tok?.name || tok?.symbol, 'ERC-20 Token'),
          decimals,
          rawBalance,
          ethplorerPriceUsd: Number.isFinite(rate) && rate > 0 ? rate : 0,
        });
      } catch {
        // ignore malformed balance
      }
    }
    const deadCap = Math.min(5, Math.floor(maxTokens / 4));
    const dead = out.filter((t) => t.ethplorerPriceUsd === 0).slice(0, deadCap);
    const valued = out.filter((t) => t.ethplorerPriceUsd > 0).slice(0, maxTokens - dead.length);
    return [...valued, ...dead];
  } catch {
    clearTimeout(timer);
    return [];
  }
}

/**
 * Zero-key Routescan public ERC-20 holdings fallback for chains without Blockscout v2
 * (Avalanche, BNB Chain, Mantle, Blast, Linea, Sonic).
 */
export async function discoverRoutescanTokens(
  chain: EvmChainId,
  walletAddress: string,
  maxTokens = 24
): Promise<DiscoveredEthToken[]> {
  const cfg = EVM_CHAINS[chain];
  if (!cfg) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3800);
  try {
    const url = `https://api.routescan.io/v2/network/mainnet/evm/${cfg.chainId}/address/${encodeURIComponent(walletAddress)}/erc20-holdings?limit=${maxTokens}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const json = (await res.json()) as {
      items?: Array<{
        tokenAddress?: string;
        tokenSymbol?: string;
        tokenName?: string;
        tokenDecimals?: number | string;
        tokenQuantity?: string;
        tokenPrice?: number | string;
        holderBalance?: string;
        token?: {
          address?: string;
          symbol?: string;
          name?: string;
          decimals?: number | string;
          price?: number | string;
        };
      }>;
    };
    const out: DiscoveredEthToken[] = [];
    for (const item of json.items ?? []) {
      const tokenAddress = item.tokenAddress ?? item.token?.address;
      const qty = item.holderBalance ?? item.tokenQuantity;
      if (!tokenAddress || !/^0x[0-9a-fA-F]{40}$/.test(tokenAddress) || !qty) continue;
      try {
        const rawBalance = BigInt(qty);
        if (rawBalance <= 0n) continue;
        const decimals = Math.min(
          36,
          Math.max(0, Number(item.token?.decimals ?? item.tokenDecimals ?? 18) || 18)
        );
        const price = Number(item.token?.price ?? item.tokenPrice ?? 0);
        const rawSym = item.token?.symbol ?? item.tokenSymbol;
        const rawName = item.token?.name ?? item.tokenName ?? rawSym;
        out.push({
          address: tokenAddress,
          symbol: sanitizeTokenSymbol(rawSym, 'UNKNOWN'),
          name: sanitizeTokenName(rawName, 'ERC-20 Token'),
          decimals,
          rawBalance,
          ethplorerPriceUsd: Number.isFinite(price) && price > 0 ? price : 0,
        });
      } catch {
        // ignore
      }
    }
    return out.slice(0, maxTokens);
  } catch {
    clearTimeout(timer);
    return [];
  }
}

const RABBY_CHAIN_TO_EVM: Record<string, EvmChainId> = {
  eth: 'ethereum',
  ethereum: 'ethereum',
  base: 'base',
  arb: 'arbitrum',
  arbitrum: 'arbitrum',
  op: 'optimism',
  optimism: 'optimism',
  matic: 'polygon',
  polygon: 'polygon',
  avax: 'avalanche',
  avalanche: 'avalanche',
  bsc: 'bnb',
  bnb: 'bnb',
  sonic: 'sonic',
  uni: 'unichain',
  unichain: 'unichain',
  linea: 'linea',
  scrl: 'scroll',
  scroll: 'scroll',
  mnt: 'mantle',
  mantle: 'mantle',
  blast: 'blast',
  world: 'worldchain',
  worldchain: 'worldchain',
  hyper: 'hyperevm',
  hyperevm: 'hyperevm',
  bera: 'berachain',
  berachain: 'berachain',
  era: 'zksync',
  zksync: 'zksync',
  ink: 'ink',
  xdai: 'gnosis',
  gnosis: 'gnosis',
  monad: 'monad',
};

function sanitizeHttpsUrl(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:') return parsed.toString();
  } catch {
    // ignore malformed URL
  }
  return undefined;
}

export interface DiscoveredProtocolToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  amount: number;
  priceUsd: number;
}

export interface DiscoveredProtocolPosition {
  chain: EvmChainId;
  protocolId: string;
  protocolName: string;
  protocolLogoUrl?: string;
  protocolSiteUrl?: string;
  positionType: string;
  detailTypes: string[];
  poolAddress: string;
  positionIndex?: string;
  description?: string;
  supplyTokens: DiscoveredProtocolToken[];
  borrowTokens: DiscoveredProtocolToken[];
  rewardTokens: DiscoveredProtocolToken[];
  assetUsdValue: number;
  debtUsdValue: number;
  netUsdValue: number;
  healthRate?: number;
  unlockAt?: number;
  hasWithdrawAction: boolean;
}

/**
 * Discovers live protocol-level DeFi positions across ALL 14 supported EVM chains
 * (lending markets, locked/veNFT staking, margin deposits, yield vaults, LP positions, etc.)
 * via Rabby's public multi-chain protocol indexer so non-ERC20 / custom-contract DeFi
 * (e.g. 40 Acres, Wayfinder, Velodrome veNFT, Carbon/IntentX, Yearn, Pendle, GMX) is always surfaced.
 */
export async function discoverDefiProtocolPositions(
  walletAddress: string
): Promise<DiscoveredProtocolPosition[]> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    const res = await fetch(
      `https://api.rabby.io/v1/user/complex_protocol_list?id=${encodeURIComponent(walletAddress)}`,
      {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      }
    );
    clearTimeout(timer);
    if (!res.ok) return [];

    type RawRabbyToken = {
      id?: string;
      symbol?: string;
      optimized_symbol?: string;
      display_symbol?: string | null;
      name?: string;
      decimals?: number;
      price?: number;
      amount?: number;
    };

    type RawRabbyProtocol = {
      id?: string;
      chain?: string;
      name?: string;
      site_url?: string;
      logo_url?: string;
      portfolio_item_list?: Array<{
        name?: string;
        detail_types?: string[];
        position_index?: string;
        stats?: {
          asset_usd_value?: number;
          debt_usd_value?: number;
          net_usd_value?: number;
        };
        asset_token_list?: RawRabbyToken[];
        withdraw_actions?: Array<{ type?: string }>;
        detail?: {
          supply_token_list?: RawRabbyToken[];
          borrow_token_list?: RawRabbyToken[];
          reward_token_list?: RawRabbyToken[];
          health_rate?: number;
          unlock_at?: number;
          description?: string;
        };
        pool?: {
          id?: string;
          controller?: string;
        };
      }>;
    };

    const protocols = (await res.json()) as RawRabbyProtocol[];
    if (!Array.isArray(protocols)) return [];

    const mapToken = (t: RawRabbyToken): DiscoveredProtocolToken | null => {
      const amount = Math.abs(Number(t.amount ?? 0));
      if (!Number.isFinite(amount) || amount <= 0) return null;
      const priceUsd = Number(t.price ?? 0);
      const rawAddr = String(t.id ?? '').trim();
      const address = /^0x[0-9a-fA-F]{40}$/.test(rawAddr) ? rawAddr : 'native';
      const decimals = Math.min(36, Math.max(0, Number(t.decimals ?? 18) || 18));
      const sym = sanitizeTokenSymbol(t.optimized_symbol || t.display_symbol || t.symbol, 'TOKEN');
      const name = sanitizeTokenName(t.name || sym, sym);
      return {
        address,
        symbol: sym,
        name,
        decimals,
        amount,
        priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : 0,
      };
    };

    const out: DiscoveredProtocolPosition[] = [];
    for (const proto of protocols) {
      const chain = RABBY_CHAIN_TO_EVM[String(proto.chain ?? '').toLowerCase()];
      if (!chain) continue;

      const protocolName = sanitizeTokenName(proto.name || proto.id, 'DeFi Protocol');
      const protocolLogoUrl = sanitizeHttpsUrl(proto.logo_url);
      const protocolSiteUrl = sanitizeHttpsUrl(proto.site_url);

      for (const item of proto.portfolio_item_list ?? []) {
        const assetUsdValue = Number(item.stats?.asset_usd_value ?? 0);
        const debtUsdValue = Number(item.stats?.debt_usd_value ?? 0);
        const netUsdValue = Number(item.stats?.net_usd_value ?? assetUsdValue - debtUsdValue);

        // Skip microscopic sub-cent dust leftovers
        if (assetUsdValue < 0.01 && debtUsdValue < 0.01) continue;

        const supplyTokens = (
          item.detail?.supply_token_list?.length
            ? item.detail.supply_token_list
            : (item.asset_token_list ?? []).filter((t) => Number(t.amount ?? 0) > 0)
        )
          .map(mapToken)
          .filter((t): t is DiscoveredProtocolToken => Boolean(t));

        const borrowTokens = (
          item.detail?.borrow_token_list?.length
            ? item.detail.borrow_token_list
            : (item.asset_token_list ?? []).filter((t) => Number(t.amount ?? 0) < 0)
        )
          .map(mapToken)
          .filter((t): t is DiscoveredProtocolToken => Boolean(t));

        const rewardTokens = (item.detail?.reward_token_list ?? [])
          .map(mapToken)
          .filter((t): t is DiscoveredProtocolToken => Boolean(t));

        if (!supplyTokens.length && !rewardTokens.length) continue;

        const rawPool = item.pool?.controller || item.pool?.id || supplyTokens[0]?.address || '0x0000000000000000000000000000000000000000';
        const poolAddress = /^0x[0-9a-fA-F]{40}$/.test(rawPool)
          ? rawPool
          : supplyTokens[0]?.address || '0x0000000000000000000000000000000000000000';

        const healthRate =
          typeof item.detail?.health_rate === 'number' && Number.isFinite(item.detail.health_rate)
            ? Number(item.detail.health_rate.toFixed(2))
            : undefined;
        const unlockAt =
          typeof item.detail?.unlock_at === 'number' && Number.isFinite(item.detail.unlock_at) && item.detail.unlock_at > 0
            ? Math.round(item.detail.unlock_at)
            : undefined;

        out.push({
          chain,
          protocolId: String(proto.id ?? protocolName.toLowerCase().replace(/\s+/g, '_')),
          protocolName,
          protocolLogoUrl,
          protocolSiteUrl,
          positionType: sanitizeTokenName(item.name || 'Position', 'Position'),
          detailTypes: Array.isArray(item.detail_types) ? item.detail_types.map(String) : [],
          poolAddress,
          positionIndex: item.position_index ? String(item.position_index) : undefined,
          description: item.detail?.description
            ? sanitizeTokenName(item.detail.description, '')
            : undefined,
          supplyTokens,
          borrowTokens,
          rewardTokens,
          assetUsdValue: Number(assetUsdValue.toFixed(2)),
          debtUsdValue: Number(debtUsdValue.toFixed(2)),
          netUsdValue: Number(netUsdValue.toFixed(2)),
          healthRate,
          unlockAt,
          hasWithdrawAction: Boolean(
            item.withdraw_actions?.some((a) => a.type === 'withdraw')
          ),
        });
      }
    }

    return out;
  } catch {
    clearTimeout(timer);
    return [];
  }
}

const ERC20_DECIMALS_SELECTOR = '0x313ce567'; // decimals()
const ERC20_SYMBOL_SELECTOR = '0x95d89b41'; // symbol()
const ERC20_NAME_SELECTOR = '0x06fdde03'; // name()
const MAX_ALCHEMY_PAGES = 10;

export interface ResolvedErc20Metadata {
  decimals?: number;
  symbol?: string;
  name?: string;
}

/**
 * Decodes either a standard ABI dynamic `string` or a fixed `bytes32` (e.g. MKR)
 * returned by ERC-20 `symbol()` / `name()` calls.
 */
export function decodeAbiStringOrBytes32(hex: string): string | null {
  const clean = hex.replace(/^0x/i, '');
  if (!clean || clean.length < 64 || clean.length % 2 !== 0) return null;

  if (clean.length >= 128) {
    try {
      const offsetBytes = Number(BigInt('0x' + clean.slice(0, 64)));
      const offsetHex = offsetBytes * 2;
      if (offsetBytes >= 32 && offsetHex + 64 <= clean.length) {
        const byteLen = Number(BigInt('0x' + clean.slice(offsetHex, offsetHex + 64)));
        const dataStart = offsetHex + 64;
        const dataEnd = dataStart + byteLen * 2;
        if (byteLen > 0 && byteLen <= 256 && dataEnd <= clean.length) {
          const str = Buffer.from(clean.slice(dataStart, dataEnd), 'hex')
            .toString('utf8')
            .replace(/\0+$/g, '')
            .trim();
          if (str) return str;
        }
      }
    } catch {
      // fall through to bytes32 decode
    }
  }

  if (clean.length === 64) {
    const buf = Buffer.from(clean, 'hex');
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0) end--;
    if (end > 0) {
      const str = buf.subarray(0, end).toString('utf8').replace(/\0/g, '').trim();
      if (str) return str;
    }
  }

  return null;
}

function decodeErc20Decimals(hex: string): number | undefined {
  const val = decodeAbiUint256Word(hex);
  if (val === null || val < 0n || val > 36n) return undefined;
  return Number(val);
}

/**
 * Resolves real ERC-20 `decimals()`, `symbol()`, and `name()` in a single Multicall3 batch,
 * falling back to batched `alchemy_getTokenMetadata` when provided and any field is unresolved.
 */
export async function resolveErc20Metadata(params: {
  chain: EvmChainId;
  tokenAddresses: string[];
  alchemyUrl?: string;
}): Promise<Map<string, ResolvedErc20Metadata>> {
  const out = new Map<string, ResolvedErc20Metadata>();
  const cfg = EVM_CHAINS[params.chain];
  const unique = Array.from(
    new Set(
      params.tokenAddresses
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        .map((a) => a.toLowerCase())
    )
  );
  if (!cfg || !unique.length) return out;

  // Pass 1: Single Multicall3.aggregate3 call for decimals(), symbol(), name() across all tokens
  const calls = unique.flatMap((target) => [
    { target, allowFailure: true, callData: ERC20_DECIMALS_SELECTOR },
    { target, allowFailure: true, callData: ERC20_SYMBOL_SELECTOR },
    { target, allowFailure: true, callData: ERC20_NAME_SELECTOR },
  ]);

  const rpcUrls = params.alchemyUrl
    ? Array.from(new Set([params.alchemyUrl, ...cfg.rpcUrls]))
    : cfg.rpcUrls;

  try {
    const mcData = encodeMulticall3Aggregate3(calls);
    const json = await evmJsonRpcCall<string>(
      rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: mcData }, 'latest'],
      4000
    );
    if (json.result && json.result !== '0x') {
      const decoded = decodeMulticall3Aggregate3(json.result);
      for (let i = 0; i < unique.length; i++) {
        const addr = unique[i];
        const rDec = decoded[i * 3];
        const rSym = decoded[i * 3 + 1];
        const rName = decoded[i * 3 + 2];
        const decimals = rDec?.success ? decodeErc20Decimals(rDec.returnData) : undefined;
        const symbol = rSym?.success ? decodeAbiStringOrBytes32(rSym.returnData) ?? undefined : undefined;
        const name = rName?.success ? decodeAbiStringOrBytes32(rName.returnData) ?? undefined : undefined;
        if (decimals !== undefined || symbol !== undefined || name !== undefined) {
          out.set(addr, { decimals, symbol, name });
        }
      }
    }
  } catch {
    // Non-fatal: fall through to alchemy_getTokenMetadata fallback
  }

  // Pass 2: For any token still missing decimals/symbol/name, batch-query alchemy_getTokenMetadata
  if (params.alchemyUrl) {
    const missing = unique.filter((addr) => {
      const meta = out.get(addr);
      return !meta || meta.decimals === undefined || !meta.symbol || !meta.name;
    });
    if (missing.length > 0) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      try {
        const payload = missing.map((addr, idx) => ({
          jsonrpc: '2.0',
          id: idx + 1,
          method: 'alchemy_getTokenMetadata',
          params: [addr],
        }));
        const res = await fetch(params.alchemyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const rawJson = await res.json();
          const responses = (Array.isArray(rawJson) ? rawJson : [rawJson]) as Array<{
            id?: number;
            result?: { decimals?: number | null; symbol?: string | null; name?: string | null };
          }>;
          const byId = new Map(responses.map((r) => [r.id, r.result]));
          missing.forEach((addr, idx) => {
            const metaRes = byId.get(idx + 1);
            if (!metaRes) return;
            const prev = out.get(addr) ?? {};
            const parsedDec =
              typeof metaRes.decimals === 'number' &&
              Number.isInteger(metaRes.decimals) &&
              metaRes.decimals >= 0 &&
              metaRes.decimals <= 36
                ? metaRes.decimals
                : undefined;
            const parsedSym =
              typeof metaRes.symbol === 'string' && metaRes.symbol.trim()
                ? metaRes.symbol.trim()
                : undefined;
            const parsedName =
              typeof metaRes.name === 'string' && metaRes.name.trim()
                ? metaRes.name.trim()
                : undefined;
            out.set(addr, {
              decimals: prev.decimals ?? parsedDec,
              symbol: prev.symbol ?? parsedSym,
              name: prev.name ?? parsedName,
            });
          });
        }
      } catch {
        clearTimeout(timer);
      }
    }
  }

  return out;
}

export async function discoverChainTokens(
  chain: EvmChainId,
  walletAddress: string,
  maxTokens = 24
): Promise<DiscoveredEthToken[]> {
  const cfg = EVM_CHAINS[chain];
  if (!cfg) return [];

  const simKey = process.env.SIM_API_KEY?.trim();
  if (simKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(
        `https://api.sim.dune.com/v1/evm/balances/${encodeURIComponent(walletAddress)}?chain_ids=${cfg.chainId}&limit=${maxTokens}`,
        { headers: { 'X-Sim-Api-Key': simKey }, signal: controller.signal }
      );
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as {
          balances?: Array<{
            address?: string;
            amount?: string;
            decimals?: number;
            symbol?: string;
            name?: string;
            price_usd?: number;
          }>;
        };
        const out: DiscoveredEthToken[] = [];
        for (const b of json.balances ?? []) {
          if (!b.address || b.address === 'native' || !/^0x[0-9a-fA-F]{40}$/.test(b.address)) continue;
          if (!b.amount) continue;
          try {
            const rawBalance = BigInt(b.amount);
            if (rawBalance <= 0n) continue;
            out.push({
              address: b.address,
              symbol: sanitizeTokenSymbol(b.symbol, 'UNKNOWN'),
              name: sanitizeTokenName(b.name || b.symbol, 'ERC-20 Token'),
              decimals: Math.min(36, Math.max(0, Number(b.decimals ?? 18))),
              rawBalance,
              ethplorerPriceUsd: Number(b.price_usd ?? 0),
            });
          } catch {
            // ignore malformed balance
          }
        }
        if (out.length) return out.slice(0, maxTokens);
      }
    } catch {
      // fall through
    }
  }

  const moralisKey = process.env.MORALIS_API_KEY?.trim();
  if (moralisKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(
        `https://deep-index.moralis.io/api/v2.2/${encodeURIComponent(walletAddress)}/erc20?chain=${MORALIS_CHAIN_HEX[chain]}`,
        { headers: { 'X-API-Key': moralisKey }, signal: controller.signal }
      );
      clearTimeout(timer);
      if (res.ok) {
        const items = (await res.json()) as Array<{
          token_address?: string;
          symbol?: string;
          name?: string;
          decimals?: number;
          balance?: string;
        }>;
        const out: DiscoveredEthToken[] = [];
        for (const item of Array.isArray(items) ? items : []) {
          if (!item.token_address || !item.balance || !/^0x[0-9a-fA-F]{40}$/.test(item.token_address)) continue;
          try {
            const rawBalance = BigInt(item.balance);
            if (rawBalance <= 0n) continue;
            out.push({
              address: item.token_address,
              symbol: sanitizeTokenSymbol(item.symbol, 'UNKNOWN'),
              name: sanitizeTokenName(item.name || item.symbol, 'ERC-20 Token'),
              decimals: Math.min(36, Math.max(0, Number(item.decimals ?? 18))),
              rawBalance,
              ethplorerPriceUsd: 0,
            });
          } catch {
            // ignore
          }
        }
        if (out.length) return out.slice(0, maxTokens);
      }
    } catch {
      // fall through
    }
  }

  const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
  const alchemySub = ALCHEMY_NETWORK_SUBDOMAINS[chain];
  if (alchemyKey && alchemySub) {
    try {
      const alchemyUrl = `https://${alchemySub}.g.alchemy.com/v2/${alchemyKey}`;
      const rawEntries: Array<{ address: string; rawBalance: bigint }> = [];
      const seenContracts = new Set<string>();
      const seenPageKeys = new Set<string>();
      let pageKey: string | undefined;

      for (let page = 0; page < MAX_ALCHEMY_PAGES && rawEntries.length < maxTokens; page++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4500);
        try {
          const reqParams = pageKey
            ? [walletAddress, 'erc20', { pageKey }]
            : [walletAddress, 'erc20'];
          const res = await fetch(alchemyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: page + 1,
              method: 'alchemy_getTokenBalances',
              params: reqParams,
            }),
            signal: controller.signal,
          });
          clearTimeout(timer);
          if (!res.ok) break;
          const json = (await res.json()) as {
            result?: {
              tokenBalances?: Array<{
                contractAddress?: string;
                tokenBalance?: string;
                error?: unknown;
              }>;
              pageKey?: string;
            };
          };
          for (const item of json.result?.tokenBalances ?? []) {
            if (!item.contractAddress || !item.tokenBalance || item.error) continue;
            if (!/^0x[0-9a-fA-F]{40}$/.test(item.contractAddress)) continue;
            const addrLower = item.contractAddress.toLowerCase();
            if (seenContracts.has(addrLower)) continue;
            try {
              const rawBalance = BigInt(item.tokenBalance);
              if (rawBalance <= 0n) continue;
              seenContracts.add(addrLower);
              rawEntries.push({ address: item.contractAddress, rawBalance });
              if (rawEntries.length >= maxTokens) break;
            } catch {
              // ignore malformed balance
            }
          }
          const nextPageKey = json.result?.pageKey;
          if (!nextPageKey || seenPageKeys.has(nextPageKey)) break;
          seenPageKeys.add(nextPageKey);
          pageKey = nextPageKey;
        } catch {
          clearTimeout(timer);
          break;
        }
      }

      if (rawEntries.length > 0) {
        const limited = rawEntries.slice(0, maxTokens);
        const metadataMap = await resolveErc20Metadata({
          chain,
          tokenAddresses: limited.map((e) => e.address),
          alchemyUrl,
        });
        return limited.map((entry) => {
          const meta = metadataMap.get(entry.address.toLowerCase());
          const decimals =
            meta?.decimals !== undefined && meta.decimals >= 0 && meta.decimals <= 36
              ? meta.decimals
              : 18;
          const symbol = sanitizeTokenSymbol(meta?.symbol, 'UNKNOWN');
          const name = sanitizeTokenName(meta?.name || meta?.symbol, 'ERC-20 Token');
          return {
            address: entry.address,
            symbol,
            name,
            decimals,
            rawBalance: entry.rawBalance,
            ethplorerPriceUsd: 0,
          };
        });
      }
    } catch {
      // fall through
    }
  }

  if (chain === 'ethereum') {
    const ethplorer = await discoverEthereumTokens(walletAddress, maxTokens);
    if (ethplorer.length) return ethplorer;
  }
  const blockscout = await discoverBlockscoutTokens(chain, walletAddress, maxTokens);
  if (blockscout.length) return blockscout;
  return discoverRoutescanTokens(chain, walletAddress, maxTokens);
}

/**
 * Simulates `ERC20.transfer(0x000...dEaD, amount)` live via `eth_call` on the chain's RPC.
 * If the contract reverts or returns `false`, the token is flagged as an onchain honeypot / transfer-locked token.
 */
export async function simulateBurnTransferOnchain(params: {
  chain: EvmChainId;
  walletAddress: string;
  tokenAddress: string;
  rawAmount: bigint;
}): Promise<{ safeToBurn: boolean; reason: string }> {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg || params.rawAmount <= 0n) {
    return { safeToBurn: false, reason: 'Zero balance or unsupported chain.' };
  }

  const deadPadded = DEAD_BURN_ADDRESS.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const amtPadded = params.rawAmount.toString(16).padStart(64, '0');
  const data = `0xa9059cbb${deadPadded}${amtPadded}`;

  try {
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [
        {
          from: params.walletAddress,
          to: params.tokenAddress,
          data,
        },
        'latest',
      ],
      3500
    );

    if (json.error) {
      if (isEvmExecutionRevertError(json.error)) {
        return {
          safeToBurn: false,
          reason: `eth_call burn simulation reverted (${json.error.message ?? 'transfer locked'}). Safely skipped.`,
        };
      }
      return {
        safeToBurn: true,
        reason: `RPC simulation error (${json.error.message ?? 'unavailable'}); not classified as honeypot.`,
      };
    }

    const resultHex = (json.result ?? '0x').toLowerCase();
    // Standard ERC-20 returns true (0x...01) or empty bytes (USDT-style non-returning transfer)
    const returnedTrue =
      resultHex === '0x' ||
      resultHex === '0x1' ||
      resultHex === '0x01' ||
      (/^0x[0-9a-f]{64,}$/.test(resultHex) && BigInt(resultHex.slice(0, 66)) === 1n);
    if (returnedTrue) {
      return {
        safeToBurn: true,
        reason: 'Verified live via eth_call: transfer(0x…dEaD) succeeds with zero revert.',
      };
    }

    return {
      safeToBurn: false,
      reason: 'eth_call transfer(0x…dEaD) returned false. Safely skipped.',
    };
  } catch {
    return {
      safeToBurn: true,
      reason: 'Zero liquidity detected (RPC simulation timed out; try/catch isolated).',
    };
  }
}

/**
 * Checks real onchain ERC-20 allowance(owner, spender) via `eth_call`.
 */
export async function checkErc20Allowance(params: {
  chain: EvmChainId;
  tokenAddress: string;
  owner: string;
  spender: string;
}): Promise<bigint> {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) return 0n;
  const ownerPad = params.owner.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const spenderPad = params.spender.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const data = `0xdd62ed3e${ownerPad}${spenderPad}`;

  try {
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: params.tokenAddress, data }, 'latest'],
      3500
    );
    if (!json.result || json.result === '0x') return 0n;
    return BigInt(json.result);
  } catch {
    return 0n;
  }
}

export interface SolanaWalletBalance {
  address: string;
  solBalance: number;
  usdcBalance: number;
  hasUsdcAta: boolean;
  slot: number;
  checkedAt: string;
}

const inFlightSolanaBalances = new Map<string, Promise<SolanaWalletBalance>>();

/**
 * Fetches live Solana Mainnet SOL + native USDC balances for a Solana public key.
 * Validates the base58 Ed25519 key first, coalesces concurrent in-flight requests for the
 * same pubkey, and queries PublicNode -> Solana Mainnet RPC with failover.
 */
export async function fetchSolanaWalletBalances(
  solanaAddress: string
): Promise<SolanaWalletBalance> {
  let pubkey: string;
  try {
    pubkey = new PublicKey(solanaAddress.trim()).toBase58();
  } catch {
    throw new Error('Invalid Solana address');
  }

  const existing = inFlightSolanaBalances.get(pubkey);
  if (existing) return existing;

  const task = (async (): Promise<SolanaWalletBalance> => {
    let lastErr: unknown;
    for (const rpcUrl of SOLANA_RPC_URLS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([
            { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pubkey, { commitment: 'confirmed' }] },
            {
              jsonrpc: '2.0',
              id: 2,
              method: 'getTokenAccountsByOwner',
              params: [pubkey, { mint: SOLANA_USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
            },
          ]),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          lastErr = new Error(`Solana RPC HTTP ${res.status}`);
          continue;
        }

        const parsed = (await res.json()) as Array<{
          id: number;
          result?: {
            context?: { slot?: number };
            value?:
              | number
              | Array<{
                  account?: {
                    data?: {
                      parsed?: { info?: { tokenAmount?: { uiAmount?: number } } };
                    };
                  };
                }>;
          };
        }>;

        const byId = new Map((Array.isArray(parsed) ? parsed : [parsed]).map((r) => [r.id, r]));
        const balRes = byId.get(1)?.result;
        const tokRes = byId.get(2)?.result;
        if (!balRes) {
          lastErr = new Error('Solana RPC returned empty balance response');
          continue;
        }

        const lamports = typeof balRes.value === 'number' ? balRes.value : 0;
        const accounts = Array.isArray(tokRes?.value) ? tokRes.value : [];
        const usdcBalance = accounts.reduce(
          (sum, acc) => sum + Number(acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
          0
        );

        return {
          address: pubkey,
          solBalance: Number((lamports / 1e9).toFixed(6)),
          usdcBalance: Number(usdcBalance.toFixed(6)),
          hasUsdcAta: accounts.length > 0,
          slot: balRes.context?.slot ?? 0,
          checkedAt: new Date().toISOString(),
        };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
      }
    }

    throw new Error(
      `Solana RPC unavailable (${lastErr instanceof Error ? lastErr.message : 'timeout'})`
    );
  })().finally(() => {
    inFlightSolanaBalances.delete(pubkey);
  });

  inFlightSolanaBalances.set(pubkey, task);
  return task;
}
