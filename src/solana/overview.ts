import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import {
  fetchSolanaWalletBalances,
  type SolanaWalletBalance,
} from '../scanner/discovery.js';
import {
  scanSolanaSplDust,
  type SolanaSplDustScanResult,
} from './spl-dust.js';
import {
  fetchSolanaYieldStrategiesWithLiveApy,
  type SolanaYieldStrategyWithApy,
} from './yield-park.js';

export interface SolanaOverviewParams {
  address: string;
  dustMaxUsd?: number;
  dustOutputAsset?: 'USDC' | 'SOL';
  refresh?: boolean;
  timeoutMs?: number;
  fetchBalancesFn?: (address: string) => Promise<SolanaWalletBalance>;
  scanDustFn?: (
    address: string,
    opts?: { maxDustUsd?: number; timeoutMs?: number }
  ) => Promise<SolanaSplDustScanResult>;
  fetchYieldStrategiesFn?: (opts?: {
    timeoutMs?: number;
    fetchLiveApy?: boolean;
  }) => Promise<SolanaYieldStrategyWithApy[]>;
}

export interface SolanaOverviewResult {
  address: string;
  durationMs: number;
  dustOutputAsset: 'USDC' | 'SOL';
  balances: SolanaWalletBalance | null;
  dust: SolanaSplDustScanResult | null;
  yieldStrategies: SolanaYieldStrategyWithApy[];
  rpcUnavailable: boolean;
}

/**
 * Fetches Solana wallet balances (SOL + USDC + ATA status), SPL dust scan,
 * and live principal-safe yield strategies/APY summary in parallel in a single server call.
 */
export async function fetchSolanaOverview(
  params: SolanaOverviewParams
): Promise<SolanaOverviewResult> {
  const startedAt = performance.now();
  const cleanAddr = typeof params.address === 'string' ? params.address.trim() : '';
  if (!cleanAddr) {
    throw new Error('address must be a non-empty Solana base58 public key.');
  }
  try {
    solanaAddressToBytes32(cleanAddr);
  } catch (err) {
    throw new Error(
      `Invalid Solana address: ${err instanceof Error ? err.message : 'expected base58 public key'}.`
    );
  }

  const dustOutputAsset: 'USDC' | 'SOL' =
    typeof params.dustOutputAsset === 'string' && params.dustOutputAsset.trim().toUpperCase() === 'SOL'
      ? 'SOL'
      : 'USDC';

  if (params.dustMaxUsd !== undefined) {
    if (
      typeof params.dustMaxUsd !== 'number' ||
      !Number.isFinite(params.dustMaxUsd) ||
      params.dustMaxUsd <= 0 ||
      params.dustMaxUsd > 10_000
    ) {
      throw new Error('dustMaxUsd must be a finite number between 0 and 10000.');
    }
  }

  const fetchBalancesFn = params.fetchBalancesFn ?? fetchSolanaWalletBalances;
  const scanDustFn = params.scanDustFn ?? scanSolanaSplDust;
  const fetchYieldStrategiesFn =
    params.fetchYieldStrategiesFn ?? fetchSolanaYieldStrategiesWithLiveApy;

  let balancesError = false;
  let dustError = false;

  const [balances, dust, yieldStrategies] = await Promise.all([
    fetchBalancesFn(cleanAddr).catch(() => {
      balancesError = true;
      return null;
    }),
    scanDustFn(cleanAddr, {
      maxDustUsd: params.dustMaxUsd,
      timeoutMs: params.timeoutMs,
    }).catch(() => {
      dustError = true;
      return null;
    }),
    fetchYieldStrategiesFn({
      timeoutMs: params.timeoutMs ?? 2_500,
      fetchLiveApy: true,
    }),
  ]);

  const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
  return {
    address: balances?.address ?? dust?.ownerAddress ?? cleanAddr,
    durationMs,
    dustOutputAsset,
    balances,
    dust,
    yieldStrategies,
    rpcUnavailable: balancesError || dustError,
  };
}
