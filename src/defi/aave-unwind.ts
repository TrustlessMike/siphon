import { EVM_CHAINS } from '../scanner/chains.js';
import {
  encodeMulticall3Aggregate3,
  decodeMulticall3Aggregate3,
  evmJsonRpcCall,
  formatUnits,
} from '../scanner/rpc.js';
import type { EvmChainId } from '../scanner/types.js';

interface Multicall3Call {
  target: string;
  allowFailure: boolean;
  callData: string;
}

function encodeBalanceOf(owner: string): string {
  return `0x70a08231${owner.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT256 = (1n << 256n) - 1n;

export const AAVE_V3_UNWIND_SELECTORS = {
  getReservesList: '0xd1946dbc', // getReservesList() -> address[]
  getReserveData: '0x35ea6a75', // getReserveData(address) -> ReserveData struct (15 words; word 8 = aToken, word 10 = variableDebtToken)
  repay: '0x573ade81', // repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
  withdraw: '0x69328dec', // withdraw(address asset, uint256 amount, address to)
  approve: '0x095ea7b3', // approve(address spender, uint256 value)
  allowance: '0xdd62ed3e', // allowance(address owner, address spender)
  symbol: '0x95d89b41', // symbol()
  decimals: '0x313ce567', // decimals()
} as const;

export interface AaveActiveDebtItem {
  asset: string;
  symbol: string;
  decimals: number;
  aTokenAddress: string;
  variableDebtToken: string;
  debtRaw: bigint;
  debtUi: number;
  walletBalanceRaw: bigint;
  walletBalanceUi: number;
  allowanceRaw: bigint;
  canRepayFull: boolean;
  shortfallRaw: bigint;
  shortfallUi: number;
  /** Amount to pass to Pool.repay (MAX_UINT256 when wallet covers debt + 0.2% interest buffer) */
  repayCallAmountRaw: bigint;
  /** Amount to approve on ERC-20 before calling Pool.repay */
  repayApproveAmountRaw: bigint;
}

export interface AavePoolDebtInspection {
  checked: boolean;
  chain: EvmChainId;
  poolAddress: string;
  userAddress: string;
  reservesCount: number;
  activeDebts: AaveActiveDebtItem[];
  canRepayAllFromWallet: boolean;
  reason?: string;
}

export interface AaveRepayStepTx {
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
}

function padAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

function padUint256(val: bigint): string {
  const clamped = val < 0n ? 0n : val > MAX_UINT256 ? MAX_UINT256 : val;
  return clamped.toString(16).padStart(64, '0');
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
  // Standard ABI dynamic string
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
  // bytes32 symbol fallback (e.g. MKR)
  const raw = Buffer.from(clean.slice(0, 64), 'hex')
    .toString('utf8')
    .replace(/\0/g, '')
    .trim();
  return raw || fallback;
}

export function encodeErc20AllowanceCalldata(owner: string, spender: string): string {
  return `${AAVE_V3_UNWIND_SELECTORS.allowance}${padAddress(owner)}${padAddress(spender)}`;
}

export function encodeErc20ApproveCalldata(spender: string, amount: bigint): string {
  return `${AAVE_V3_UNWIND_SELECTORS.approve}${padAddress(spender)}${padUint256(amount)}`;
}

/**
 * Encodes Aave V3 / Neverland / SparkLend / Seamless / Hyperlend / Lendle
 * `Pool.repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)`.
 */
export function encodeAaveV3RepayCalldata(params: {
  asset: string;
  amount: bigint;
  interestRateMode?: bigint;
  onBehalfOf: string;
}): string {
  const mode = params.interestRateMode ?? 2n; // 2 = variable debt (universal across Aave V3 forks)
  return `${AAVE_V3_UNWIND_SELECTORS.repay}${padAddress(params.asset)}${padUint256(
    params.amount
  )}${padUint256(mode)}${padAddress(params.onBehalfOf)}`;
}

export function encodeAaveV3WithdrawCalldata(params: {
  asset: string;
  amount: bigint;
  to: string;
}): string {
  return `${AAVE_V3_UNWIND_SELECTORS.withdraw}${padAddress(params.asset)}${padUint256(
    params.amount
  )}${padAddress(params.to)}`;
}

/**
 * Inspects ANY Aave V3 or Aave V3 fork Pool (Neverland on Monad, Aave v3 on 14+ chains,
 * SparkLend on Ethereum/Gnosis, Seamless on Base, Hyperlend on HyperEVM, Lendle on Mantle)
 * in 2 fast batched Multicall3 RPC calls to discover every active variable debt token
 * and verify whether the user's wallet already holds enough underlying to execute a
 * 1-click `Approve -> Pool.repay -> Pool.withdraw` unwind.
 */
export async function inspectAavePoolActiveDebts(params: {
  chain: EvmChainId;
  poolAddress: string;
  userAddress: string;
  timeoutMs?: number;
  rpcCallFn?: typeof evmJsonRpcCall;
}): Promise<AavePoolDebtInspection> {
  const { chain, poolAddress, userAddress } = params;
  const cfg = EVM_CHAINS[chain];
  if (!cfg || !EVM_ADDR_RE.test(poolAddress) || !EVM_ADDR_RE.test(userAddress)) {
    return {
      checked: false,
      chain,
      poolAddress,
      userAddress,
      reservesCount: 0,
      activeDebts: [],
      canRepayAllFromWallet: false,
      reason: 'Invalid chain, poolAddress, or userAddress.',
    };
  }

  const rpcFn = params.rpcCallFn ?? evmJsonRpcCall;
  const timeoutMs = params.timeoutMs ?? 4_000;

  try {
    // 1. Read all reserves from Pool.getReservesList()
    const reservesRes = await rpcFn<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: poolAddress, data: AAVE_V3_UNWIND_SELECTORS.getReservesList }, 'latest'],
      timeoutMs
    );
    if (!reservesRes.result || reservesRes.error) {
      return {
        checked: false,
        chain,
        poolAddress,
        userAddress,
        reservesCount: 0,
        activeDebts: [],
        canRepayAllFromWallet: false,
        reason: reservesRes.error?.message || 'Pool.getReservesList() returned empty result.',
      };
    }

    const reserves = decodeDynamicAddressArray(reservesRes.result);
    if (!reserves.length) {
      return {
        checked: true,
        chain,
        poolAddress,
        userAddress,
        reservesCount: 0,
        activeDebts: [],
        canRepayAllFromWallet: true,
      };
    }

    // 2. Multicall3 #1: Pool.getReserveData(reserve) for every reserve to get aToken & variableDebtToken
    const reserveDataCalls: Multicall3Call[] = reserves.map((r) => ({
      target: poolAddress,
      allowFailure: true,
      callData: `${AAVE_V3_UNWIND_SELECTORS.getReserveData}${padAddress(r)}`,
    }));

    const mc1 = await rpcFn<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: encodeMulticall3Aggregate3(reserveDataCalls) }, 'latest'],
      timeoutMs
    );
    if (!mc1.result || mc1.error) {
      return {
        checked: false,
        chain,
        poolAddress,
        userAddress,
        reservesCount: reserves.length,
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
      // Standard Aave V3 ReserveData struct: word 8 = aTokenAddress, word 10 = variableDebtTokenAddress
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

    if (!parsedReserves.length) {
      return {
        checked: true,
        chain,
        poolAddress,
        userAddress,
        reservesCount: reserves.length,
        activeDebts: [],
        canRepayAllFromWallet: true,
      };
    }

    // 3. Multicall3 #2: for each reserve, check variableDebt.balanceOf(user), underlying.balanceOf(user),
    //    underlying.allowance(user, pool), underlying.symbol(), underlying.decimals() in ONE single RPC call.
    const balCall = encodeBalanceOf(userAddress);
    const allowanceCall = encodeErc20AllowanceCalldata(userAddress, poolAddress);
    const mc2Calls: Multicall3Call[] = [];
    for (const r of parsedReserves) {
      mc2Calls.push(
        { target: r.variableDebtToken, allowFailure: true, callData: balCall },
        { target: r.asset, allowFailure: true, callData: balCall },
        { target: r.asset, allowFailure: true, callData: allowanceCall },
        { target: r.asset, allowFailure: true, callData: AAVE_V3_UNWIND_SELECTORS.symbol },
        { target: r.asset, allowFailure: true, callData: AAVE_V3_UNWIND_SELECTORS.decimals }
      );
    }

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
        activeDebts: [],
        canRepayAllFromWallet: false,
        reason: mc2.error?.message || 'Multicall3 debt/balance scan failed.',
      };
    }

    const mc2Decoded = decodeMulticall3Aggregate3(mc2.result);
    const activeDebts: AaveActiveDebtItem[] = [];

    for (let i = 0; i < parsedReserves.length; i += 1) {
      const base = i * 5;
      const r = parsedReserves[i];
      const debtRaw = mc2Decoded[base]?.success ? decodeWordUint(mc2Decoded[base].returnData, 0) : 0n;
      if (debtRaw <= 0n) continue;

      const walletBalanceRaw = mc2Decoded[base + 1]?.success
        ? decodeWordUint(mc2Decoded[base + 1].returnData, 0)
        : 0n;
      const allowanceRaw = mc2Decoded[base + 2]?.success
        ? decodeWordUint(mc2Decoded[base + 2].returnData, 0)
        : 0n;
      const symbol = mc2Decoded[base + 3]?.success
        ? decodeAbiString(mc2Decoded[base + 3].returnData, 'TOKEN')
        : 'TOKEN';
      const rawDec = mc2Decoded[base + 4]?.success
        ? Number(decodeWordUint(mc2Decoded[base + 4].returnData, 0))
        : 18;
      const decimals = Number.isFinite(rawDec) && rawDec >= 0 && rawDec <= 36 ? rawDec : 18;

      // Add a 0.25% buffer for per-second interest accrual between quote & block inclusion
      const bufferedDebtRaw = (debtRaw * 10025n) / 10000n + 1n;
      const canRepayFull = walletBalanceRaw >= bufferedDebtRaw;
      const shortfallRaw = canRepayFull ? 0n : bufferedDebtRaw - walletBalanceRaw;
      const repayCallAmountRaw = canRepayFull ? MAX_UINT256 : walletBalanceRaw;
      const repayApproveAmountRaw = canRepayFull ? bufferedDebtRaw : walletBalanceRaw;

      activeDebts.push({
        asset: r.asset,
        symbol,
        decimals,
        aTokenAddress: r.aTokenAddress,
        variableDebtToken: r.variableDebtToken,
        debtRaw,
        debtUi: Number(formatUnits(debtRaw, decimals).toFixed(6)),
        walletBalanceRaw,
        walletBalanceUi: Number(formatUnits(walletBalanceRaw, decimals).toFixed(6)),
        allowanceRaw,
        canRepayFull,
        shortfallRaw,
        shortfallUi: Number(formatUnits(shortfallRaw, decimals).toFixed(6)),
        repayCallAmountRaw,
        repayApproveAmountRaw,
      });
    }

    return {
      checked: true,
      chain,
      poolAddress,
      userAddress,
      reservesCount: reserves.length,
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
      activeDebts: [],
      canRepayAllFromWallet: false,
      reason: err instanceof Error ? err.message : 'Unexpected RPC error inspecting Aave pool debts.',
    };
  }
}

/**
 * Builds ordered `ERC20.approve -> Pool.repay` transactions to wipe 100% of active Aave V3 /
 * Neverland / Spark / Seamless / Hyperlend / Lendle variable debt from the user's wallet balance
 * immediately prior to `Pool.withdraw(collateral, MAX_UINT256, userAddress)`.
 */
export function buildAaveRepayPreSteps(params: {
  chain: EvmChainId;
  poolAddress: string;
  protocolName: string;
  userAddress: string;
  activeDebts: AaveActiveDebtItem[];
}): AaveRepayStepTx[] {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) return [];

  const steps: AaveRepayStepTx[] = [];
  for (const debt of params.activeDebts) {
    if (!debt.canRepayFull || debt.debtRaw <= 0n) continue;

    if (debt.allowanceRaw < debt.repayApproveAmountRaw) {
      steps.push({
        stepId: `approve_repay_${debt.symbol.toLowerCase()}`,
        label: `Approve ${debt.symbol} to repay ${params.protocolName} debt`,
        description: `Authorize ${params.protocolName} Pool to pull ${debt.debtUi} ${debt.symbol} (+0.25% accrual buffer) to clear active borrow.`,
        chain: params.chain,
        chainId: cfg.chainId,
        chainName: cfg.name,
        explorerUrl: cfg.explorerUrl,
        from: params.userAddress,
        to: debt.asset,
        data: encodeErc20ApproveCalldata(params.poolAddress, debt.repayApproveAmountRaw),
        value: '0x0',
      });
    }

    steps.push({
      stepId: `aave_repay_${debt.symbol.toLowerCase()}`,
      label: `Repay ${debt.debtUi} ${debt.symbol} debt on ${params.protocolName}`,
      description: `Calls Pool.repay(${debt.symbol}, MAX, variable, user) on ${cfg.name} to clear 100% of active borrow before collateral exit.`,
      chain: params.chain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      from: params.userAddress,
      to: params.poolAddress,
      data: encodeAaveV3RepayCalldata({
        asset: debt.asset,
        amount: debt.repayCallAmountRaw,
        interestRateMode: 2n,
        onBehalfOf: params.userAddress,
      }),
      value: '0x0',
    });
  }

  return steps;
}
