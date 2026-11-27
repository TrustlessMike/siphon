import { EVM_CHAINS } from '../scanner/chains.js';
import {
  decodeMulticall3Aggregate3,
  encodeMulticall3Aggregate3,
  evmJsonRpcCall,
  formatUnits,
} from '../scanner/rpc.js';
import type { EvmChainId } from '../scanner/types.js';
import {
  AAVE_V3_UNWIND_SELECTORS,
  buildAaveRepayPreSteps,
  encodeErc20AllowanceCalldata,
  encodeErc20ApproveCalldata,
  type AaveActiveDebtItem,
  type AaveRepayStepTx,
} from './aave-unwind.js';
import { isAllowedAaveV3Pool } from './extractors.js';

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * Cryptographically verified 4-byte selectors from `forge inspect TurgaliumFlashUnwind methodIdentifiers`.
 */
export const FLASH_UNWIND_SELECTORS = {
  unwindSimple: '0x0ed15974',
  unwindMulti: '0xfd11edd9',
  flashLoanPremiumTotal: '0x074b2e43', // Pool.FLASHLOAN_PREMIUM_TOTAL() -> uint128 (bps, 10000 = 100%)
  balanceOf: '0x70a08231',
} as const;

export const CANONICAL_FLASH_SWAP_ROUTERS = {
  kyberswapV2: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5',
  lifiDiamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  lifiDiamondMonad: '0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37',
  openOceanExchange: '0x6352a56caadC4F1E25CD6c75970Fa768A3304e64',
} as const;

/**
 * KyberSwap aggregator chain slug mapping across all Aave V3 / fork EVM chains.
 */
const KYBERSWAP_CHAIN_SLUGS: Partial<Record<EvmChainId, string>> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  avalanche: 'avalanche',
  bnb: 'bsc',
  sonic: 'sonic',
  linea: 'linea',
  scroll: 'scroll',
  mantle: 'mantle',
  gnosis: 'gnosis',
  zksync: 'zksync',
  monad: 'monad',
  hyperevm: 'hyperevm',
};

export interface FlashUnwindCollateralItem {
  asset: string;
  symbol: string;
  decimals: number;
  aTokenAddress: string;
  aTokenBalanceRaw: bigint;
  aTokenBalanceUi: number;
  aTokenAllowanceRaw: bigint;
}

export interface FlashUnwindDebtItem extends AaveActiveDebtItem {
  flashLiquidityRaw: bigint;
  flashLiquidityUi: number;
  flashPremiumBps: number;
  flashPremiumRaw: bigint;
  flashPremiumUi: number;
  totalFlashRepayRaw: bigint;
  totalFlashRepayUi: number;
  hasSufficientFlashLiquidity: boolean;
}

export interface AavePoolFullPosition {
  checked: boolean;
  chain: EvmChainId;
  poolAddress: string;
  userAddress: string;
  reservesCount: number;
  flashLoanPremiumBps: number;
  collaterals: FlashUnwindCollateralItem[];
  activeDebts: FlashUnwindDebtItem[];
  canRepayAllFromWallet: boolean;
  reason?: string;
}

export interface FlashSwapQuote {
  provider: 'kyberswap' | 'lifi' | 'openocean';
  router: string;
  tokenIn: string;
  tokenInSymbol: string;
  tokenOut: string;
  tokenOutSymbol: string;
  amountInRaw: bigint;
  amountInUi: number;
  expectedOutRaw: bigint;
  expectedOutUi: number;
  minAmountOutRaw: bigint;
  minAmountOutUi: number;
  callData: string;
}

export interface FlashCollateralPullParam {
  asset: string;
  aTokenAmount: bigint;
  minRemainingOut: bigint;
}

export interface FlashSwapStepParam {
  router: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  minAmountOut: bigint;
  callData: string;
}

export interface FlashPermitApprovalParam {
  token: string;
  value: bigint;
  deadline: bigint;
  v: number;
  r: string;
  s: string;
}

export interface AaveFlashUnwindPlan {
  checked: boolean;
  supported: boolean;
  mode:
    | 'flash_simple'
    | 'flash_multi'
    | 'wallet_repay'
    | 'no_debt'
    | 'insufficient_liquidity'
    | 'swap_quote_unavailable'
    | 'unprofitable'
    | 'error';
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  poolAddress: string;
  protocolName: string;
  userAddress: string;
  recipient: string;
  flashUnwindContract: string | null;
  contractDeployed: boolean;
  previewOnly: boolean;
  flashLoanPremiumBps: number;
  slippageBps: number;
  collaterals: Array<{
    asset: string;
    symbol: string;
    decimals: number;
    aTokenAddress: string;
    balanceRaw: string;
    balanceUi: number;
    willSwap: boolean;
    estimatedRemainingUi: number;
  }>;
  activeDebts: Array<{
    asset: string;
    symbol: string;
    decimals: number;
    variableDebtToken: string;
    debtRaw: string;
    debtUi: number;
    walletBalanceUi: number;
    flashPremiumUi: number;
    totalFlashRepayUi: number;
    flashLiquidityUi: number;
    hasSufficientFlashLiquidity: boolean;
  }>;
  swaps: Array<{
    provider: FlashSwapQuote['provider'];
    router: string;
    tokenIn: string;
    tokenInSymbol: string;
    tokenOut: string;
    tokenOutSymbol: string;
    amountInRaw: string;
    amountInUi: number;
    expectedOutRaw: string;
    expectedOutUi: number;
    minAmountOutRaw: string;
    minAmountOutUi: number;
  }>;
  estimatedNetSurplus: Array<{
    asset: string;
    symbol: string;
    amountUi: number;
  }>;
  transactions: AaveRepayStepTx[];
  notes: string[];
  reason?: string;
}

export function getTrustedFlashSwapRouters(chain: EvmChainId): string[] {
  if (chain === 'monad') {
    return [
      CANONICAL_FLASH_SWAP_ROUTERS.kyberswapV2.toLowerCase(),
      CANONICAL_FLASH_SWAP_ROUTERS.lifiDiamondMonad.toLowerCase(),
      CANONICAL_FLASH_SWAP_ROUTERS.openOceanExchange.toLowerCase(),
    ];
  }
  return [
    CANONICAL_FLASH_SWAP_ROUTERS.kyberswapV2.toLowerCase(),
    CANONICAL_FLASH_SWAP_ROUTERS.lifiDiamond.toLowerCase(),
    CANONICAL_FLASH_SWAP_ROUTERS.openOceanExchange.toLowerCase(),
  ];
}

export function isTrustedFlashSwapRouter(chain: EvmChainId, router: string): boolean {
  if (!EVM_ADDR_RE.test(router)) return false;
  return getTrustedFlashSwapRouters(chain).includes(router.toLowerCase());
}

/**
 * Resolves the deployed `TurgaliumFlashUnwind` contract address for a given EVM chain from
 * `TURGALIUM_FLASH_UNWIND_<CHAIN>` (or `TURGALIUM_FLASH_UNWIND_DEFAULT` for identical CREATE2 deploys).
 */
export function getFlashUnwindContractAddress(chain: EvmChainId): string | null {
  const specific = process.env[`TURGALIUM_FLASH_UNWIND_${chain.toUpperCase()}`]?.trim();
  if (specific && EVM_ADDR_RE.test(specific) && specific.toLowerCase() !== ZERO_ADDRESS) {
    return specific;
  }
  const shared = process.env.TURGALIUM_FLASH_UNWIND_DEFAULT?.trim();
  if (shared && EVM_ADDR_RE.test(shared) && shared.toLowerCase() !== ZERO_ADDRESS) {
    return shared;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Low-level pure-TS ABI helpers (zero external deps, verified against Forge)
// ---------------------------------------------------------------------------

function padAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function padUint256(val: bigint | number): string {
  const bi = typeof val === 'bigint' ? val : BigInt(val);
  const clamped = bi < 0n ? 0n : bi > MAX_UINT256 ? MAX_UINT256 : bi;
  return clamped.toString(16).padStart(64, '0');
}

function padBytes32(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, '').padStart(64, '0').slice(0, 64);
}

function encodeDynamicBytes(hexData: string): string {
  const clean = hexData.startsWith('0x') ? hexData.slice(2).toLowerCase() : hexData.toLowerCase();
  const byteLen = clean.length / 2;
  const paddedLen = Math.ceil(clean.length / 64) * 64;
  return `${padUint256(byteLen)}${clean.padEnd(paddedLen, '0')}`;
}

function encodeCollateralPullArray(collaterals: FlashCollateralPullParam[]): string {
  const parts = [padUint256(collaterals.length)];
  for (const c of collaterals) {
    parts.push(padAddress(c.asset), padUint256(c.aTokenAmount), padUint256(c.minRemainingOut));
  }
  return parts.join('');
}

function encodeSwapStepArray(swaps: FlashSwapStepParam[]): string {
  if (swaps.length === 0) return padUint256(0);

  // Each SwapStep is dynamic (contains `bytes callData`), so array body has:
  //   length | offset[0] | ... | offset[n-1] | elem[0] | ... | elem[n-1]
  // where offsets are relative to the start of the offset table (right after `length`).
  const encodedElems = swaps.map((s) => {
    const head = [
      padAddress(s.router),
      padAddress(s.tokenIn),
      padAddress(s.tokenOut),
      padUint256(s.amountIn),
      padUint256(s.minAmountOut),
      padUint256(6 * 32), // callData starts right after the 6 head words (192 bytes)
    ].join('');
    return `${head}${encodeDynamicBytes(s.callData)}`;
  });

  const offsets: string[] = [];
  let cursorBytes = swaps.length * 32;
  for (const elem of encodedElems) {
    offsets.push(padUint256(cursorBytes));
    cursorBytes += elem.length / 2;
  }

  return `${padUint256(swaps.length)}${offsets.join('')}${encodedElems.join('')}`;
}

function encodePermitArray(permits: FlashPermitApprovalParam[]): string {
  const parts = [padUint256(permits.length)];
  for (const p of permits) {
    parts.push(
      padAddress(p.token),
      padUint256(p.value),
      padUint256(p.deadline),
      padUint256(p.v),
      padBytes32(p.r),
      padBytes32(p.s)
    );
  }
  return parts.join('');
}

function encodeAddressArray(addrs: string[]): string {
  return `${padUint256(addrs.length)}${addrs.map(padAddress).join('')}`;
}

function encodeUint256Array(vals: bigint[]): string {
  return `${padUint256(vals.length)}${vals.map(padUint256).join('')}`;
}

/**
 * Encodes `TurgaliumFlashUnwind.unwindSimple(address pool, SimpleUnwindParams p)`.
 */
export function encodeFlashUnwindSimpleCalldata(params: {
  pool: string;
  debtAsset: string;
  debtAmount: bigint;
  interestRateMode?: bigint;
  collaterals: FlashCollateralPullParam[];
  swaps: FlashSwapStepParam[];
  permits?: FlashPermitApprovalParam[];
  recipient: string;
  minDebtSurplus: bigint;
  deadline: bigint;
}): string {
  const rateMode = params.interestRateMode ?? 2n;
  const colEnc = encodeCollateralPullArray(params.collaterals);
  const swapEnc = encodeSwapStepArray(params.swaps);
  const permitEnc = encodePermitArray(params.permits ?? []);

  // SimpleUnwindParams has 9 head words = 288 bytes
  const headBytes = 9 * 32;
  const colOffset = headBytes;
  const swapOffset = colOffset + colEnc.length / 2;
  const permitOffset = swapOffset + swapEnc.length / 2;

  const tupleHead = [
    padAddress(params.debtAsset),
    padUint256(params.debtAmount),
    padUint256(rateMode),
    padUint256(colOffset),
    padUint256(swapOffset),
    padUint256(permitOffset),
    padAddress(params.recipient),
    padUint256(params.minDebtSurplus),
    padUint256(params.deadline),
  ].join('');

  const topHead = `${padAddress(params.pool)}${padUint256(2 * 32)}`;
  return `${FLASH_UNWIND_SELECTORS.unwindSimple}${topHead}${tupleHead}${colEnc}${swapEnc}${permitEnc}`;
}

/**
 * Encodes `TurgaliumFlashUnwind.unwindMulti(address pool, MultiUnwindParams p)`.
 */
export function encodeFlashUnwindMultiCalldata(params: {
  pool: string;
  debtAssets: string[];
  debtAmounts: bigint[];
  interestRateModes: bigint[];
  collaterals: FlashCollateralPullParam[];
  swaps: FlashSwapStepParam[];
  permits?: FlashPermitApprovalParam[];
  recipient: string;
  minDebtSurpluses: bigint[];
  deadline: bigint;
}): string {
  const debtAssetsEnc = encodeAddressArray(params.debtAssets);
  const debtAmountsEnc = encodeUint256Array(params.debtAmounts);
  const modesEnc = encodeUint256Array(params.interestRateModes);
  const colEnc = encodeCollateralPullArray(params.collaterals);
  const swapEnc = encodeSwapStepArray(params.swaps);
  const permitEnc = encodePermitArray(params.permits ?? []);
  const minSurplusEnc = encodeUint256Array(params.minDebtSurpluses);

  // MultiUnwindParams has 9 head words = 288 bytes
  let cursor = 9 * 32;
  const offDebtAssets = cursor;
  cursor += debtAssetsEnc.length / 2;
  const offDebtAmounts = cursor;
  cursor += debtAmountsEnc.length / 2;
  const offModes = cursor;
  cursor += modesEnc.length / 2;
  const offCols = cursor;
  cursor += colEnc.length / 2;
  const offSwaps = cursor;
  cursor += swapEnc.length / 2;
  const offPermits = cursor;
  cursor += permitEnc.length / 2;
  const offMinSurpluses = cursor;

  const tupleHead = [
    padUint256(offDebtAssets),
    padUint256(offDebtAmounts),
    padUint256(offModes),
    padUint256(offCols),
    padUint256(offSwaps),
    padUint256(offPermits),
    padAddress(params.recipient),
    padUint256(offMinSurpluses),
    padUint256(params.deadline),
  ].join('');

  const topHead = `${padAddress(params.pool)}${padUint256(2 * 32)}`;
  return `${FLASH_UNWIND_SELECTORS.unwindMulti}${topHead}${tupleHead}${debtAssetsEnc}${debtAmountsEnc}${modesEnc}${colEnc}${swapEnc}${permitEnc}${minSurplusEnc}`;
}

function decodeWordAddress(hex: string, wordIndex: number): string | null {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const start = wordIndex * 64;
  if (clean.length < start + 64) return null;
  const addr = `0x${clean.slice(start + 24, start + 64)}`;
  return EVM_ADDR_RE.test(addr) && addr.toLowerCase() !== ZERO_ADDRESS ? addr : null;
}

function decodeWordUint(hex: string, wordIndex = 0): bigint {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const start = wordIndex * 64;
  if (clean.length < start + 64) return 0n;
  try {
    return BigInt(`0x${clean.slice(start, start + 64)}`);
  } catch {
    return 0n;
  }
}

function decodeDynamicAddressArray(hex: string): string[] {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length < 128) return [];
  const offsetBytes = Number(decodeWordUint(clean, 0));
  if (!Number.isFinite(offsetBytes) || offsetBytes < 0 || offsetBytes % 32 !== 0) return [];
  const lenWord = offsetBytes / 32;
  const count = Number(decodeWordUint(clean, lenWord));
  if (!Number.isFinite(count) || count <= 0 || count > 200) return [];
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const addr = decodeWordAddress(clean, lenWord + 1 + i);
    if (addr) out.push(addr);
  }
  return out;
}

function decodeAbiString(hex: string, fallback: string): string {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length < 64) return fallback;
  if (clean.length >= 128) {
    const offset = Number(decodeWordUint(clean, 0));
    if (offset === 32) {
      const len = Number(decodeWordUint(clean, 1));
      if (len > 0 && len <= 64 && clean.length >= 128 + len * 2) {
        const str = Buffer.from(clean.slice(128, 128 + len * 2), 'hex')
          .toString('utf8')
          .replace(/\0/g, '')
          .trim();
        if (str) return str;
      }
    }
  }
  const raw = Buffer.from(clean.slice(0, 64), 'hex')
    .toString('utf8')
    .replace(/\0/g, '')
    .trim();
  return raw || fallback;
}

// ---------------------------------------------------------------------------
// Full Position Inspector (Collaterals + Active Debts + Live Flash Loan Fee)
// ---------------------------------------------------------------------------

/**
 * Inspects ANY Aave V3 or Aave V3 fork Pool in 2 batched Multicall3 RPCs to discover:
 *   - Live `FLASHLOAN_PREMIUM_TOTAL()` bps (e.g. 50 bps on Neverland, 5 bps on Aave v3)
 *   - Every supplied collateral (`aToken.balanceOf(user) > 0`) + allowance to `flashUnwindContract`
 *   - Every active variable debt (`variableDebtToken.balanceOf(user) > 0`) + pool flash liquidity
 */
export async function inspectAavePoolFullPosition(params: {
  chain: EvmChainId;
  poolAddress: string;
  userAddress: string;
  flashUnwindContract?: string | null;
  timeoutMs?: number;
  rpcCallFn?: typeof evmJsonRpcCall;
}): Promise<AavePoolFullPosition> {
  const { chain, poolAddress, userAddress } = params;
  const cfg = EVM_CHAINS[chain];
  if (!cfg || !EVM_ADDR_RE.test(poolAddress) || !EVM_ADDR_RE.test(userAddress)) {
    return {
      checked: false,
      chain,
      poolAddress,
      userAddress,
      reservesCount: 0,
      flashLoanPremiumBps: 5,
      collaterals: [],
      activeDebts: [],
      canRepayAllFromWallet: false,
      reason: 'Invalid chain, poolAddress, or userAddress.',
    };
  }

  const rpcFn = params.rpcCallFn ?? evmJsonRpcCall;
  const timeoutMs = params.timeoutMs ?? 4_500;
  const spenderForAToken =
    params.flashUnwindContract && EVM_ADDR_RE.test(params.flashUnwindContract)
      ? params.flashUnwindContract
      : poolAddress;

  try {
    // 1. Fetch reserves list + live FLASHLOAN_PREMIUM_TOTAL() in ONE Multicall3 call
    const mc0 = await rpcFn<string>(
      cfg.rpcUrls,
      'eth_call',
      [
        {
          to: cfg.multicall3,
          data: encodeMulticall3Aggregate3([
            {
              target: poolAddress,
              allowFailure: true,
              callData: AAVE_V3_UNWIND_SELECTORS.getReservesList,
            },
            {
              target: poolAddress,
              allowFailure: true,
              callData: FLASH_UNWIND_SELECTORS.flashLoanPremiumTotal,
            },
          ]),
        },
        'latest',
      ],
      timeoutMs
    );

    if (!mc0.result || mc0.error) {
      return {
        checked: false,
        chain,
        poolAddress,
        userAddress,
        reservesCount: 0,
        flashLoanPremiumBps: 5,
        collaterals: [],
        activeDebts: [],
        canRepayAllFromWallet: false,
        reason: mc0.error?.message || 'Pool.getReservesList() multicall failed.',
      };
    }

    const mc0Decoded = decodeMulticall3Aggregate3(mc0.result);
    const reserves = mc0Decoded[0]?.success
      ? decodeDynamicAddressArray(mc0Decoded[0].returnData)
      : [];
    const rawPremium = mc0Decoded[1]?.success
      ? Number(decodeWordUint(mc0Decoded[1].returnData, 0))
      : 5;
    const flashLoanPremiumBps =
      Number.isFinite(rawPremium) && rawPremium >= 0 && rawPremium <= 500 ? rawPremium : 5;

    if (!reserves.length) {
      return {
        checked: true,
        chain,
        poolAddress,
        userAddress,
        reservesCount: 0,
        flashLoanPremiumBps,
        collaterals: [],
        activeDebts: [],
        canRepayAllFromWallet: true,
      };
    }

    // 2. Multicall3 #1: Pool.getReserveData(reserve) for every reserve
    const mc1 = await rpcFn<string>(
      cfg.rpcUrls,
      'eth_call',
      [
        {
          to: cfg.multicall3,
          data: encodeMulticall3Aggregate3(
            reserves.map((r) => ({
              target: poolAddress,
              allowFailure: true,
              callData: `${AAVE_V3_UNWIND_SELECTORS.getReserveData}${padAddress(r)}`,
            }))
          ),
        },
        'latest',
      ],
      timeoutMs
    );

    if (!mc1.result || mc1.error) {
      return {
        checked: false,
        chain,
        poolAddress,
        userAddress,
        reservesCount: reserves.length,
        flashLoanPremiumBps,
        collaterals: [],
        activeDebts: [],
        canRepayAllFromWallet: false,
        reason: mc1.error?.message || 'Multicall3 getReserveData failed.',
      };
    }

    const mc1Decoded = decodeMulticall3Aggregate3(mc1.result);
    const parsedReserves: Array<{
      asset: string;
      aTokenAddress: string;
      variableDebtToken: string;
    }> = [];

    for (let i = 0; i < reserves.length; i += 1) {
      const entry = mc1Decoded[i];
      if (!entry?.success) continue;
      const aToken = decodeWordAddress(entry.returnData, 8);
      const vDebt = decodeWordAddress(entry.returnData, 10);
      if (aToken && vDebt) {
        parsedReserves.push({
          asset: reserves[i],
          aTokenAddress: aToken,
          variableDebtToken: vDebt,
        });
      }
    }

    // 3. Multicall3 #2: 8 reads per reserve in ONE single RPC call:
    //    [0] aToken.balanceOf(user)
    //    [1] aToken.allowance(user, flashUnwindContract)
    //    [2] variableDebt.balanceOf(user)
    //    [3] underlying.balanceOf(user)
    //    [4] underlying.allowance(user, pool)
    //    [5] underlying.balanceOf(aToken)  <- available flash-loan liquidity!
    //    [6] underlying.symbol()
    //    [7] underlying.decimals()
    const userBalCall = `${FLASH_UNWIND_SELECTORS.balanceOf}${padAddress(userAddress)}`;
    const aTokenAllowCall = encodeErc20AllowanceCalldata(userAddress, spenderForAToken);
    const underlyingAllowCall = encodeErc20AllowanceCalldata(userAddress, poolAddress);
    const mc2Calls = parsedReserves.flatMap((r) => [
      { target: r.aTokenAddress, allowFailure: true, callData: userBalCall },
      { target: r.aTokenAddress, allowFailure: true, callData: aTokenAllowCall },
      { target: r.variableDebtToken, allowFailure: true, callData: userBalCall },
      { target: r.asset, allowFailure: true, callData: userBalCall },
      { target: r.asset, allowFailure: true, callData: underlyingAllowCall },
      {
        target: r.asset,
        allowFailure: true,
        callData: `${FLASH_UNWIND_SELECTORS.balanceOf}${padAddress(r.aTokenAddress)}`,
      },
      { target: r.asset, allowFailure: true, callData: AAVE_V3_UNWIND_SELECTORS.symbol },
      { target: r.asset, allowFailure: true, callData: AAVE_V3_UNWIND_SELECTORS.decimals },
    ]);

    const mc2 = await rpcFn<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: encodeMulticall3Aggregate3(mc2Calls) }, 'latest'],
      timeoutMs
    );

    if (!mc2.result || mc2.error) {
      return {
        checked: false,
        chain,
        poolAddress,
        userAddress,
        reservesCount: reserves.length,
        flashLoanPremiumBps,
        collaterals: [],
        activeDebts: [],
        canRepayAllFromWallet: false,
        reason: mc2.error?.message || 'Multicall3 full position scan failed.',
      };
    }

    const mc2Decoded = decodeMulticall3Aggregate3(mc2.result);
    const collaterals: FlashUnwindCollateralItem[] = [];
    const activeDebts: FlashUnwindDebtItem[] = [];

    for (let i = 0; i < parsedReserves.length; i += 1) {
      const base = i * 8;
      const r = parsedReserves[i];
      const aTokenBalRaw = mc2Decoded[base]?.success
        ? decodeWordUint(mc2Decoded[base].returnData, 0)
        : 0n;
      const debtRaw = mc2Decoded[base + 2]?.success
        ? decodeWordUint(mc2Decoded[base + 2].returnData, 0)
        : 0n;

      if (aTokenBalRaw <= 0n && debtRaw <= 0n) continue;

      const aTokenAllowRaw = mc2Decoded[base + 1]?.success
        ? decodeWordUint(mc2Decoded[base + 1].returnData, 0)
        : 0n;
      const walletBalRaw = mc2Decoded[base + 3]?.success
        ? decodeWordUint(mc2Decoded[base + 3].returnData, 0)
        : 0n;
      const underlyingAllowRaw = mc2Decoded[base + 4]?.success
        ? decodeWordUint(mc2Decoded[base + 4].returnData, 0)
        : 0n;
      const flashLiquidityRaw = mc2Decoded[base + 5]?.success
        ? decodeWordUint(mc2Decoded[base + 5].returnData, 0)
        : 0n;
      const symbol = mc2Decoded[base + 6]?.success
        ? decodeAbiString(mc2Decoded[base + 6].returnData, 'TOKEN')
        : 'TOKEN';
      const rawDec = mc2Decoded[base + 7]?.success
        ? Number(decodeWordUint(mc2Decoded[base + 7].returnData, 0))
        : 18;
      const decimals = Number.isFinite(rawDec) && rawDec >= 0 && rawDec <= 36 ? rawDec : 18;

      if (aTokenBalRaw > 0n) {
        collaterals.push({
          asset: r.asset,
          symbol,
          decimals,
          aTokenAddress: r.aTokenAddress,
          aTokenBalanceRaw: aTokenBalRaw,
          aTokenBalanceUi: Number(formatUnits(aTokenBalRaw, decimals).toFixed(6)),
          aTokenAllowanceRaw: aTokenAllowRaw,
        });
      }

      if (debtRaw > 0n) {
        const bufferedDebtRaw = (debtRaw * 10025n) / 10000n + 1n;
        const canRepayFull = walletBalRaw >= bufferedDebtRaw;
        const shortfallRaw = canRepayFull ? 0n : bufferedDebtRaw - walletBalRaw;
        const flashBufferRaw = debtRaw + debtRaw / 1_000_000n + 2n;
        const flashPremiumRaw = (flashBufferRaw * BigInt(flashLoanPremiumBps)) / 10_000n + 1n;
        const totalFlashRepayRaw = flashBufferRaw + flashPremiumRaw;

        activeDebts.push({
          asset: r.asset,
          symbol,
          decimals,
          aTokenAddress: r.aTokenAddress,
          variableDebtToken: r.variableDebtToken,
          debtRaw,
          debtUi: Number(formatUnits(debtRaw, decimals).toFixed(6)),
          walletBalanceRaw: walletBalRaw,
          walletBalanceUi: Number(formatUnits(walletBalRaw, decimals).toFixed(6)),
          allowanceRaw: underlyingAllowRaw,
          canRepayFull,
          shortfallRaw,
          shortfallUi: Number(formatUnits(shortfallRaw, decimals).toFixed(6)),
          repayCallAmountRaw: canRepayFull ? MAX_UINT256 : walletBalRaw,
          repayApproveAmountRaw: canRepayFull ? bufferedDebtRaw : walletBalRaw,
          flashLiquidityRaw,
          flashLiquidityUi: Number(formatUnits(flashLiquidityRaw, decimals).toFixed(6)),
          flashPremiumBps: flashLoanPremiumBps,
          flashPremiumRaw,
          flashPremiumUi: Number(formatUnits(flashPremiumRaw, decimals).toFixed(6)),
          totalFlashRepayRaw,
          totalFlashRepayUi: Number(formatUnits(totalFlashRepayRaw, decimals).toFixed(6)),
          hasSufficientFlashLiquidity: flashLiquidityRaw >= flashBufferRaw,
        });
      }
    }

    return {
      checked: true,
      chain,
      poolAddress,
      userAddress,
      reservesCount: reserves.length,
      flashLoanPremiumBps,
      collaterals,
      activeDebts,
      canRepayAllFromWallet: activeDebts.every((d) => d.canRepayFull),
    };
  } catch (err) {
    return {
      checked: false,
      chain,
      poolAddress,
      userAddress,
      reservesCount: 0,
      flashLoanPremiumBps: 5,
      collaterals: [],
      activeDebts: [],
      canRepayAllFromWallet: false,
      reason: err instanceof Error ? err.message : 'Unexpected RPC error inspecting Aave pool.',
    };
  }
}

// ---------------------------------------------------------------------------
// Live Same-Chain DEX Aggregator Quoter (KyberSwap + LI.FI + OpenOcean)
// ---------------------------------------------------------------------------

export async function quoteFlashUnwindSwap(params: {
  chain: EvmChainId;
  tokenIn: string;
  tokenInSymbol: string;
  tokenInDecimals: number;
  tokenOut: string;
  tokenOutSymbol: string;
  tokenOutDecimals: number;
  amountInRaw: bigint;
  executorAddress: string;
  slippageBps?: number;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<FlashSwapQuote | null> {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg || params.amountInRaw <= 0n) return null;

  const fetcher = params.fetchFn ?? fetch;
  const slippageBps = Math.max(20, Math.min(500, params.slippageBps ?? 100)); // default 1.00%
  const timeoutMs = params.timeoutMs ?? 4_500;
  const amountInStr = params.amountInRaw.toString();
  const amountInUi = Number(formatUnits(params.amountInRaw, params.tokenInDecimals).toFixed(6));

  const fetchWithTimeout = async (url: string, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetcher(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  // 1. KyberSwap (supports Monad + 15 Aave V3 chains; 2-step routes -> build for exact calldata)
  const quoteKyber = async (): Promise<FlashSwapQuote | null> => {
    const slug = KYBERSWAP_CHAIN_SLUGS[params.chain];
    if (!slug) return null;
    try {
      const routeRes = await fetchWithTimeout(
        `https://aggregator-api.kyberswap.com/${slug}/api/v1/routes?tokenIn=${params.tokenIn}&tokenOut=${params.tokenOut}&amountIn=${amountInStr}`,
        { headers: { 'x-client-id': 'turgalium' } }
      );
      if (!routeRes.ok) return null;
      const routeJson = (await routeRes.json()) as {
        code?: number;
        data?: { routeSummary?: { amountOut?: string }; routerAddress?: string };
      };
      if (routeJson.code !== 0 || !routeJson.data?.routeSummary?.amountOut) return null;

      const buildRes = await fetchWithTimeout(
        `https://aggregator-api.kyberswap.com/${slug}/api/v1/route/build`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-client-id': 'turgalium' },
          body: JSON.stringify({
            routeSummary: routeJson.data.routeSummary,
            sender: params.executorAddress,
            recipient: params.executorAddress,
            slippageTolerance: slippageBps,
          }),
        }
      );
      if (!buildRes.ok) return null;
      const buildJson = (await buildRes.json()) as {
        code?: number;
        data?: { data?: string; routerAddress?: string; amountOut?: string };
      };
      const router = buildJson.data?.routerAddress || routeJson.data.routerAddress || '';
      const callData = buildJson.data?.data || '';
      const outStr = buildJson.data?.amountOut || routeJson.data.routeSummary.amountOut;
      if (!isTrustedFlashSwapRouter(params.chain, router) || !/^0x[0-9a-fA-F]{8,}$/.test(callData)) {
        return null;
      }
      const expectedOutRaw = BigInt(outStr);
      const minAmountOutRaw = (expectedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
      return {
        provider: 'kyberswap',
        router,
        tokenIn: params.tokenIn,
        tokenInSymbol: params.tokenInSymbol,
        tokenOut: params.tokenOut,
        tokenOutSymbol: params.tokenOutSymbol,
        amountInRaw: params.amountInRaw,
        amountInUi,
        expectedOutRaw,
        expectedOutUi: Number(formatUnits(expectedOutRaw, params.tokenOutDecimals).toFixed(6)),
        minAmountOutRaw,
        minAmountOutUi: Number(formatUnits(minAmountOutRaw, params.tokenOutDecimals).toFixed(6)),
        callData,
      };
    } catch {
      return null;
    }
  };

  // 2. LI.FI same-chain swap quote
  const quoteLifi = async (): Promise<FlashSwapQuote | null> => {
    try {
      const slippageFrac = (slippageBps / 10_000).toFixed(4);
      const url = `https://li.quest/v1/quote?fromChain=${cfg.chainId}&toChain=${cfg.chainId}&fromToken=${params.tokenIn}&toToken=${params.tokenOut}&fromAmount=${amountInStr}&fromAddress=${params.executorAddress}&toAddress=${params.executorAddress}&slippage=${slippageFrac}`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) return null;
      const json = (await res.json()) as {
        estimate?: { toAmount?: string; toAmountMin?: string };
        transactionRequest?: { to?: string; data?: string };
      };
      const router = json.transactionRequest?.to || '';
      const callData = json.transactionRequest?.data || '';
      const outStr = json.estimate?.toAmount || '';
      if (
        !outStr ||
        !isTrustedFlashSwapRouter(params.chain, router) ||
        !/^0x[0-9a-fA-F]{8,}$/.test(callData)
      ) {
        return null;
      }
      const expectedOutRaw = BigInt(outStr);
      const minAmountOutRaw = json.estimate?.toAmountMin
        ? BigInt(json.estimate.toAmountMin)
        : (expectedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
      return {
        provider: 'lifi',
        router,
        tokenIn: params.tokenIn,
        tokenInSymbol: params.tokenInSymbol,
        tokenOut: params.tokenOut,
        tokenOutSymbol: params.tokenOutSymbol,
        amountInRaw: params.amountInRaw,
        amountInUi,
        expectedOutRaw,
        expectedOutUi: Number(formatUnits(expectedOutRaw, params.tokenOutDecimals).toFixed(6)),
        minAmountOutRaw,
        minAmountOutUi: Number(formatUnits(minAmountOutRaw, params.tokenOutDecimals).toFixed(6)),
        callData,
      };
    } catch {
      return null;
    }
  };

  // 3. OpenOcean v4 same-chain swap quote
  const quoteOpenOcean = async (): Promise<FlashSwapQuote | null> => {
    try {
      const slipPct = (slippageBps / 100).toFixed(2);
      const url = `https://open-api.openocean.finance/v4/${cfg.chainId}/swap?inTokenAddress=${params.tokenIn}&outTokenAddress=${params.tokenOut}&amountDecimals=${amountInStr}&slippage=${slipPct}&account=${params.executorAddress}&gasPrice=50`;
      const res = await fetchWithTimeout(url);
      if (!res.ok) return null;
      const json = (await res.json()) as {
        code?: number;
        data?: { to?: string; data?: string; outAmount?: string; minOutAmount?: string };
      };
      const router = json.data?.to || '';
      const callData = json.data?.data || '';
      const outStr = json.data?.outAmount || '';
      if (
        json.code !== 200 ||
        !outStr ||
        !isTrustedFlashSwapRouter(params.chain, router) ||
        !/^0x[0-9a-fA-F]{8,}$/.test(callData)
      ) {
        return null;
      }
      const expectedOutRaw = BigInt(outStr);
      const minAmountOutRaw = json.data?.minOutAmount
        ? BigInt(json.data.minOutAmount)
        : (expectedOutRaw * BigInt(10_000 - slippageBps)) / 10_000n;
      return {
        provider: 'openocean',
        router,
        tokenIn: params.tokenIn,
        tokenInSymbol: params.tokenInSymbol,
        tokenOut: params.tokenOut,
        tokenOutSymbol: params.tokenOutSymbol,
        amountInRaw: params.amountInRaw,
        amountInUi,
        expectedOutRaw,
        expectedOutUi: Number(formatUnits(expectedOutRaw, params.tokenOutDecimals).toFixed(6)),
        minAmountOutRaw,
        minAmountOutUi: Number(formatUnits(minAmountOutRaw, params.tokenOutDecimals).toFixed(6)),
        callData,
      };
    } catch {
      return null;
    }
  };

  const candidates = (await Promise.all([quoteKyber(), quoteLifi(), quoteOpenOcean()])).filter(
    (q): q is FlashSwapQuote => q !== null && q.expectedOutRaw > 0n
  );
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.expectedOutRaw > a.expectedOutRaw ? 1 : b.expectedOutRaw < a.expectedOutRaw ? -1 : 0));
  return candidates[0];
}

// ---------------------------------------------------------------------------
// High-Level Cross-Chain Flash-Loan Self-Unwind Planner
// ---------------------------------------------------------------------------

/**
 * Builds a complete 1-click atomic Flash-Loan Self-Unwind plan for ANY Aave V3 / fork Pool
 * across all 20 EVM chains (Monad Neverland, Ethereum/Base/Arbitrum/Optimism/Polygon/Avalanche/
 * BNB/Gnosis/Scroll/Linea/Sonic/zkSync/Ink Aave V3, SparkLend, Seamless, Lendle, HyperLend).
 *
 * Automatically:
 *   1. Reads all collaterals, active variable debts, and live `FLASHLOAN_PREMIUM_TOTAL()` on-chain.
 *   2. If the user already holds the debt token in wallet, returns the cheaper 0-premium wallet repay path.
 *   3. Otherwise quotes live DEX swaps (KyberSwap / LI.FI / OpenOcean) for ONLY the collateral legs
 *      needed to cover `debt + flashLoanPremium` (or all collaterals if `swapAllCollaterals: true`).
 *   4. Emits ready-to-sign `[aToken.approve..., TurgaliumFlashUnwind.unwindSimple/Multi]` txs when
 *      `TURGALIUM_FLASH_UNWIND_<CHAIN>` is configured, or an accurate live-quoted preview otherwise.
 */
export async function buildAaveFlashUnwindPlan(params: {
  chain: EvmChainId;
  poolAddress: string;
  userAddress: string;
  recipient?: string;
  slippageBps?: number;
  swapAllCollaterals?: boolean;
  flashUnwindContractOverride?: string | null;
  positionInspectorFn?: typeof inspectAavePoolFullPosition;
  swapQuoterFn?: typeof quoteFlashUnwindSwap;
  nowUnixSec?: number;
}): Promise<AaveFlashUnwindPlan> {
  const cfg = EVM_CHAINS[params.chain];
  const protocolName =
    params.chain === 'monad' ? 'Neverland' : `Aave v3 (${cfg?.name ?? params.chain})`;
  const recipient =
    params.recipient && EVM_ADDR_RE.test(params.recipient) ? params.recipient : params.userAddress;
  const slippageBps = Math.max(25, Math.min(500, params.slippageBps ?? 100));
  const flashUnwindContract =
    params.flashUnwindContractOverride !== undefined
      ? params.flashUnwindContractOverride
      : getFlashUnwindContractAddress(params.chain);
  const contractDeployed = Boolean(
    flashUnwindContract && EVM_ADDR_RE.test(flashUnwindContract) && flashUnwindContract.toLowerCase() !== ZERO_ADDRESS
  );

  const baseResult = (
    overrides: Partial<AaveFlashUnwindPlan>
  ): AaveFlashUnwindPlan => ({
    checked: false,
    supported: false,
    mode: 'error',
    chain: params.chain,
    chainId: cfg?.chainId ?? 0,
    chainName: cfg?.name ?? params.chain,
    poolAddress: params.poolAddress,
    protocolName,
    userAddress: params.userAddress,
    recipient,
    flashUnwindContract: contractDeployed ? flashUnwindContract : null,
    contractDeployed,
    previewOnly: !contractDeployed,
    flashLoanPremiumBps: 5,
    slippageBps,
    collaterals: [],
    activeDebts: [],
    swaps: [],
    estimatedNetSurplus: [],
    transactions: [],
    notes: [],
    ...overrides,
  });

  if (!cfg || !isAllowedAaveV3Pool(params.chain, params.poolAddress)) {
    return baseResult({
      reason: `Pool ${params.poolAddress} is not an audited Aave V3 / fork Pool on ${params.chain}.`,
    });
  }

  const inspector = params.positionInspectorFn ?? inspectAavePoolFullPosition;
  const pos = await inspector({
    chain: params.chain,
    poolAddress: params.poolAddress,
    userAddress: params.userAddress,
    flashUnwindContract,
  });

  if (!pos.checked) {
    return baseResult({
      reason: pos.reason || 'Could not inspect on-chain Aave V3 position.',
    });
  }

  const formattedDebts = pos.activeDebts.map((d) => ({
    asset: d.asset,
    symbol: d.symbol,
    decimals: d.decimals,
    variableDebtToken: d.variableDebtToken,
    debtRaw: d.debtRaw.toString(),
    debtUi: d.debtUi,
    walletBalanceUi: d.walletBalanceUi,
    flashPremiumUi: d.flashPremiumUi,
    totalFlashRepayUi: d.totalFlashRepayUi,
    flashLiquidityUi: d.flashLiquidityUi,
    hasSufficientFlashLiquidity: d.hasSufficientFlashLiquidity,
  }));

  if (pos.activeDebts.length === 0) {
    return baseResult({
      checked: true,
      supported: true,
      mode: 'no_debt',
      flashLoanPremiumBps: pos.flashLoanPremiumBps,
      collaterals: pos.collaterals.map((c) => ({
        asset: c.asset,
        symbol: c.symbol,
        decimals: c.decimals,
        aTokenAddress: c.aTokenAddress,
        balanceRaw: c.aTokenBalanceRaw.toString(),
        balanceUi: c.aTokenBalanceUi,
        willSwap: false,
        estimatedRemainingUi: c.aTokenBalanceUi,
      })),
      activeDebts: [],
      notes: ['No active debt on this pool — standard 1-click Pool.withdraw is already unlocked.'],
    });
  }

  // If wallet already holds 100% of all debts, wallet-repay avoids flash-loan premium & swap slippage!
  if (pos.canRepayAllFromWallet) {
    const repayTxs = buildAaveRepayPreSteps({
      chain: params.chain,
      poolAddress: params.poolAddress,
      protocolName,
      userAddress: params.userAddress,
      activeDebts: pos.activeDebts,
    });
    return baseResult({
      checked: true,
      supported: true,
      mode: 'wallet_repay',
      previewOnly: false,
      flashLoanPremiumBps: pos.flashLoanPremiumBps,
      collaterals: pos.collaterals.map((c) => ({
        asset: c.asset,
        symbol: c.symbol,
        decimals: c.decimals,
        aTokenAddress: c.aTokenAddress,
        balanceRaw: c.aTokenBalanceRaw.toString(),
        balanceUi: c.aTokenBalanceUi,
        willSwap: false,
        estimatedRemainingUi: c.aTokenBalanceUi,
      })),
      activeDebts: formattedDebts,
      transactions: repayTxs,
      notes: [
        'Wallet already holds enough debt tokens to repay directly with 0% flash-loan premium.',
      ],
    });
  }

  // Check flash-loan liquidity across all debt reserves
  const illiquidDebt = pos.activeDebts.find((d) => !d.hasSufficientFlashLiquidity);
  if (illiquidDebt) {
    return baseResult({
      checked: true,
      supported: false,
      mode: 'insufficient_liquidity',
      flashLoanPremiumBps: pos.flashLoanPremiumBps,
      activeDebts: formattedDebts,
      reason: `${protocolName} currently has ${illiquidDebt.flashLiquidityUi} ${illiquidDebt.symbol} available for flash loans, below the ${illiquidDebt.debtUi} ${illiquidDebt.symbol} needed.`,
    });
  }

  // Only single-debt flashLoanSimple is auto-quoted in v1 when swaps are needed; multi-debt supported too!
  const quoter = params.swapQuoterFn ?? quoteFlashUnwindSwap;
  const quoteExecutor = contractDeployed && flashUnwindContract ? flashUnwindContract : params.userAddress;
  const isSingleDebt = pos.activeDebts.length === 1;
  const primaryDebt = pos.activeDebts[0];

  // Sort collaterals so same-asset collateral comes first, then largest token balance first
  const orderedCollaterals = [...pos.collaterals].sort((a, b) => {
    const aMatchesDebt = a.asset.toLowerCase() === primaryDebt.asset.toLowerCase() ? 1 : 0;
    const bMatchesDebt = b.asset.toLowerCase() === primaryDebt.asset.toLowerCase() ? 1 : 0;
    if (aMatchesDebt !== bMatchesDebt) return bMatchesDebt - aMatchesDebt;
    return b.aTokenBalanceUi - a.aTokenBalanceUi;
  });

  // Track how much debt token we'll have inside TurgaliumFlashUnwind to cover totalFlashRepayRaw
  const swapQuotes: FlashSwapQuote[] = [];
  const swappedAssetSet = new Set<string>();
  const debtCoverageByAsset = new Map<string, bigint>();

  // First credit any same-asset collateral directly (zero DEX swap needed!)
  for (const col of orderedCollaterals) {
    const key = col.asset.toLowerCase();
    const matchingDebt = pos.activeDebts.find((d) => d.asset.toLowerCase() === key);
    if (matchingDebt) {
      debtCoverageByAsset.set(key, (debtCoverageByAsset.get(key) ?? 0n) + col.aTokenBalanceRaw);
    }
  }

  // Quote swaps for non-debt collaterals until every debt leg's totalFlashRepayRaw is covered
  // (or all collaterals if swapAllCollaterals === true)
  const nonDebtCollaterals = orderedCollaterals.filter(
    (c) => !pos.activeDebts.some((d) => d.asset.toLowerCase() === c.asset.toLowerCase())
  );

  for (const debt of pos.activeDebts) {
    const debtKey = debt.asset.toLowerCase();
    for (const col of nonDebtCollaterals) {
      const colKey = col.asset.toLowerCase();
      if (swappedAssetSet.has(colKey)) continue;

      const currentCovered = debtCoverageByAsset.get(debtKey) ?? 0n;
      const needMore = currentCovered < debt.totalFlashRepayRaw;
      if (!needMore && !params.swapAllCollaterals) continue;

      const q = await quoter({
        chain: params.chain,
        tokenIn: col.asset,
        tokenInSymbol: col.symbol,
        tokenInDecimals: col.decimals,
        tokenOut: debt.asset,
        tokenOutSymbol: debt.symbol,
        tokenOutDecimals: debt.decimals,
        amountInRaw: col.aTokenBalanceRaw,
        executorAddress: quoteExecutor,
        slippageBps,
      });

      if (!q) continue;

      swapQuotes.push(q);
      swappedAssetSet.add(colKey);
      // Credit conservative minAmountOutRaw when testing debt coverage so flash repay never reverts on slippage!
      debtCoverageByAsset.set(debtKey, currentCovered + q.minAmountOutRaw);
    }
  }

  // Verify every debt leg is safely covered by withdrawn collateral + quoted swaps
  const uncoveredDebt = pos.activeDebts.find(
    (d) => (debtCoverageByAsset.get(d.asset.toLowerCase()) ?? 0n) < d.totalFlashRepayRaw
  );
  if (uncoveredDebt) {
    const coveredRaw = debtCoverageByAsset.get(uncoveredDebt.asset.toLowerCase()) ?? 0n;
    const coveredUi = Number(formatUnits(coveredRaw, uncoveredDebt.decimals).toFixed(4));
    const mode = swapQuotes.length === 0 && nonDebtCollaterals.length > 0 ? 'swap_quote_unavailable' : 'unprofitable';
    return baseResult({
      checked: true,
      supported: false,
      mode,
      flashLoanPremiumBps: pos.flashLoanPremiumBps,
      collaterals: orderedCollaterals.map((c) => ({
        asset: c.asset,
        symbol: c.symbol,
        decimals: c.decimals,
        aTokenAddress: c.aTokenAddress,
        balanceRaw: c.aTokenBalanceRaw.toString(),
        balanceUi: c.aTokenBalanceUi,
        willSwap: swappedAssetSet.has(c.asset.toLowerCase()),
        estimatedRemainingUi: swappedAssetSet.has(c.asset.toLowerCase()) ? 0 : c.aTokenBalanceUi,
      })),
      activeDebts: formattedDebts,
      swaps: swapQuotes.map((s) => ({
        provider: s.provider,
        router: s.router,
        tokenIn: s.tokenIn,
        tokenInSymbol: s.tokenInSymbol,
        tokenOut: s.tokenOut,
        tokenOutSymbol: s.tokenOutSymbol,
        amountInRaw: s.amountInRaw.toString(),
        amountInUi: s.amountInUi,
        expectedOutRaw: s.expectedOutRaw.toString(),
        expectedOutUi: s.expectedOutUi,
        minAmountOutRaw: s.minAmountOutRaw.toString(),
        minAmountOutUi: s.minAmountOutUi,
      })),
      reason:
        mode === 'swap_quote_unavailable'
          ? `Could not fetch a live DEX quote to swap collateral into ${uncoveredDebt.symbol} on ${cfg.name}.`
          : `Quoted collateral output after ${pos.flashLoanPremiumBps / 100}% flash loan fee & ${slippageBps / 100}% slippage (${coveredUi} ${uncoveredDebt.symbol}) is below the ${uncoveredDebt.totalFlashRepayUi} ${uncoveredDebt.symbol} required to repay debt.`,
    });
  }

  // Compute expected net equity returned to user (surplus debt tokens + unswapped collaterals)
  const expectedDebtTotals = new Map<string, bigint>();
  for (const col of orderedCollaterals) {
    const key = col.asset.toLowerCase();
    if (pos.activeDebts.some((d) => d.asset.toLowerCase() === key)) {
      expectedDebtTotals.set(key, (expectedDebtTotals.get(key) ?? 0n) + col.aTokenBalanceRaw);
    }
  }
  for (const q of swapQuotes) {
    const key = q.tokenOut.toLowerCase();
    expectedDebtTotals.set(key, (expectedDebtTotals.get(key) ?? 0n) + q.expectedOutRaw);
  }

  const estimatedNetSurplus: Array<{ asset: string; symbol: string; amountUi: number }> = [];
  for (const debt of pos.activeDebts) {
    const expTotal = expectedDebtTotals.get(debt.asset.toLowerCase()) ?? 0n;
    const surplusRaw = expTotal > debt.totalFlashRepayRaw ? expTotal - debt.totalFlashRepayRaw : 0n;
    if (surplusRaw > 0n) {
      estimatedNetSurplus.push({
        asset: debt.asset,
        symbol: debt.symbol,
        amountUi: Number(formatUnits(surplusRaw, debt.decimals).toFixed(6)),
      });
    }
  }
  for (const col of orderedCollaterals) {
    const isDebtAsset = pos.activeDebts.some((d) => d.asset.toLowerCase() === col.asset.toLowerCase());
    if (!isDebtAsset && !swappedAssetSet.has(col.asset.toLowerCase())) {
      estimatedNetSurplus.push({
        asset: col.asset,
        symbol: col.symbol,
        amountUi: col.aTokenBalanceUi,
      });
    }
  }

  // Build transactions (aToken.approve -> TurgaliumFlashUnwind.unwindSimple/Multi)
  const transactions: AaveRepayStepTx[] = [];
  const deadlineSec = BigInt((params.nowUnixSec ?? Math.floor(Date.now() / 1000)) + 900); // 15 min

  const collateralParams: FlashCollateralPullParam[] = orderedCollaterals.map((c) => {
    const isSwapped = swappedAssetSet.has(c.asset.toLowerCase());
    const isDebtAsset = pos.activeDebts.some((d) => d.asset.toLowerCase() === c.asset.toLowerCase());
    return {
      asset: c.asset,
      aTokenAmount: MAX_UINT256,
      minRemainingOut: isSwapped || isDebtAsset ? 0n : (c.aTokenBalanceRaw * 9950n) / 10000n,
    };
  });

  const swapParams: FlashSwapStepParam[] = swapQuotes.map((s) => ({
    router: s.router,
    tokenIn: s.tokenIn,
    tokenOut: s.tokenOut,
    amountIn: s.amountInRaw,
    minAmountOut: s.minAmountOutRaw,
    callData: s.callData,
  }));

  if (contractDeployed && flashUnwindContract) {
    for (const col of orderedCollaterals) {
      if (col.aTokenAllowanceRaw < col.aTokenBalanceRaw) {
        transactions.push({
          stepId: `approve_atoken_${col.symbol.toLowerCase()}`,
          label: `Approve ${col.symbol} aToken for Flash Unwind`,
          description: `Allows TurgaliumFlashUnwind (${flashUnwindContract.slice(0, 10)}...) to withdraw your ${col.aTokenBalanceUi} ${col.symbol} collateral atomically right after clearing debt.`,
          chain: params.chain,
          chainId: cfg.chainId,
          chainName: cfg.name,
          explorerUrl: cfg.explorerUrl,
          from: params.userAddress,
          to: col.aTokenAddress,
          data: encodeErc20ApproveCalldata(flashUnwindContract, MAX_UINT256),
          value: '0x0',
        });
      }
    }

    const callData = isSingleDebt
      ? encodeFlashUnwindSimpleCalldata({
          pool: params.poolAddress,
          debtAsset: primaryDebt.asset,
          debtAmount: MAX_UINT256,
          interestRateMode: 2n,
          collaterals: collateralParams,
          swaps: swapParams,
          recipient,
          minDebtSurplus: 0n,
          deadline: deadlineSec,
        })
      : encodeFlashUnwindMultiCalldata({
          pool: params.poolAddress,
          debtAssets: pos.activeDebts.map((d) => d.asset),
          debtAmounts: pos.activeDebts.map(() => MAX_UINT256),
          interestRateModes: pos.activeDebts.map(() => 2n),
          collaterals: collateralParams,
          swaps: swapParams,
          recipient,
          minDebtSurpluses: pos.activeDebts.map(() => 0n),
          deadline: deadlineSec,
        });

    const debtDesc = pos.activeDebts.map((d) => `${d.debtUi} ${d.symbol}`).join(' + ');
    const netDesc = estimatedNetSurplus.map((s) => `${s.amountUi} ${s.symbol}`).join(' + ');

    transactions.push({
      stepId: isSingleDebt ? 'aave_flash_unwind_simple' : 'aave_flash_unwind_multi',
      label: `Flash-Unwind ${protocolName} (${debtDesc} debt -> ${netDesc || 'net equity'})`,
      description: `Atomic 1-tx flash loan unwind on ${cfg.name} (0% Turgalium fee, ${(pos.flashLoanPremiumBps / 100).toFixed(2)}% pool flash fee): clears 100% debt with $0 upfront capital and returns ${netDesc || 'net equity'} to ${recipient.slice(0, 10)}...`,
      chain: params.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      from: params.userAddress,
      to: flashUnwindContract,
      data: callData,
      value: '0x0',
    });
  }

  const notes: string[] = [
    `0% Turgalium protocol fee · Pool flash-loan fee: ${(pos.flashLoanPremiumBps / 100).toFixed(2)}% (${pos.flashLoanPremiumBps} bps).`,
  ];
  if (swapQuotes.length > 0) {
    notes.push(
      `DEX route: ${swapQuotes
        .map((q) => `${q.amountInUi} ${q.tokenInSymbol} -> ${q.expectedOutUi} ${q.tokenOutSymbol} via ${q.provider}`)
        .join('; ')}.`
    );
  }
  if (!contractDeployed) {
    notes.push(
      `Preview quote ready: deploy TurgaliumFlashUnwind on ${cfg.name} (contracts/script/DeployTurgaliumFlashUnwind.s.sol) and set TURGALIUM_FLASH_UNWIND_${params.chain.toUpperCase()} to emit live signable calldata.`
    );
  }

  return baseResult({
    checked: true,
    supported: true,
    mode: isSingleDebt ? 'flash_simple' : 'flash_multi',
    flashLoanPremiumBps: pos.flashLoanPremiumBps,
    collaterals: orderedCollaterals.map((c) => ({
      asset: c.asset,
      symbol: c.symbol,
      decimals: c.decimals,
      aTokenAddress: c.aTokenAddress,
      balanceRaw: c.aTokenBalanceRaw.toString(),
      balanceUi: c.aTokenBalanceUi,
      willSwap: swappedAssetSet.has(c.asset.toLowerCase()),
      estimatedRemainingUi: swappedAssetSet.has(c.asset.toLowerCase()) ? 0 : c.aTokenBalanceUi,
    })),
    activeDebts: formattedDebts,
    swaps: swapQuotes.map((s) => ({
      provider: s.provider,
      router: s.router,
      tokenIn: s.tokenIn,
      tokenInSymbol: s.tokenInSymbol,
      tokenOut: s.tokenOut,
      tokenOutSymbol: s.tokenOutSymbol,
      amountInRaw: s.amountInRaw.toString(),
      amountInUi: s.amountInUi,
      expectedOutRaw: s.expectedOutRaw.toString(),
      expectedOutUi: s.expectedOutUi,
      minAmountOutRaw: s.minAmountOutRaw.toString(),
      minAmountOutUi: s.minAmountOutUi,
    })),
    estimatedNetSurplus,
    transactions,
    notes,
  });
}
