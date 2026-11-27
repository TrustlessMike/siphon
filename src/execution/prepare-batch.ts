import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import {
  preflightDefiAsset,
  type DefiPreflightResult,
} from '../defi/preflight.js';
import { EVM_CHAINS } from '../scanner/chains.js';
import { evmJsonRpcCall } from '../scanner/rpc.js';
import type { EvmChainId, ScannedAsset } from '../scanner/types.js';
import {
  evaluateChainNativeGasStatus,
  fetchChainNativeBalancesWei,
  parseHexOrDecWei,
  type ChainNativeGasStatus,
} from './gas-refuel.js';
import type { AuctionExecutableTx } from './route-auction.js';
import {
  prepareRealExecution,
  type PreparedExecution,
} from './tx-builder.js';

export const MAX_PREPARE_BATCH_ASSETS = 12;
export const DEFAULT_PREPARE_BATCH_CONCURRENCY = 6;

const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface PrepareBatchRequest {
  assets: ScannedAsset[];
  userAddress: string;
  solanaDestination: string;
  outputAsset?: 'USDC' | 'SOL';
  bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
  hasSolanaUsdcAta?: boolean;
  includePreflight?: boolean;
  includeGasCheck?: boolean;
  concurrency?: number;
  prepareAssetFn?: typeof prepareRealExecution;
  preflightAssetFn?: typeof preflightDefiAsset;
  fetchChainBalancesFn?: typeof fetchChainNativeBalancesWei;
  simulateTxFn?: (tx: AuctionExecutableTx) => Promise<{ ok: boolean; reason?: string }>;
}

export interface PrepareBatchItemResult {
  assetId: string;
  chain: string;
  symbol: string;
  ok: boolean;
  error?: string;
  prepared?: PreparedExecution;
  preflight?: DefiPreflightResult;
}

export interface PrepareBatchResponse {
  preparedAt: string;
  durationMs: number;
  count: number;
  readyCount: number;
  failedCount: number;
  totalNetUsd: number;
  totalGasUsd: number;
  totalProtocolFeeUsd: 0;
  totalSignatures: number;
  chainGasStatus: Record<string, ChainNativeGasStatus>;
  zeroGasChains: string[];
  items: PrepareBatchItemResult[];
}

function round2(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function round4(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  const runWorker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: limit }, runWorker));
  return results;
}

function isDefiEvmAsset(asset: ScannedAsset): boolean {
  return (
    (asset.kind === 'defi_position' || asset.action === 'WITHDRAW_AND_BRIDGE') &&
    Object.hasOwn(EVM_CHAINS, asset.chain)
  );
}

/**
 * Prepares up to 12 executable asset transactions (plus optional live DeFi preflight)
 * in parallel with bounded concurrency (default 6) in a single server round-trip.
 * Individual asset failures are isolated so healthy assets remain ready to sign.
 */
export async function prepareBatchExecutions(
  params: PrepareBatchRequest
): Promise<PrepareBatchResponse> {
  const startedAt = performance.now();

  if (!Array.isArray(params.assets) || params.assets.length === 0) {
    throw new Error('assets must be a non-empty array.');
  }

  const userAddress = typeof params.userAddress === 'string' ? params.userAddress.trim() : '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(userAddress) || userAddress.toLowerCase() === ZERO_EVM_ADDRESS) {
    throw new Error('userAddress must be a valid non-zero 20-byte 0x EVM address.');
  }

  const solanaDestination =
    typeof params.solanaDestination === 'string' ? params.solanaDestination.trim() : '';
  if (!solanaDestination) {
    throw new Error('solanaDestination is required.');
  }
  try {
    solanaAddressToBytes32(solanaDestination);
  } catch (err) {
    throw new Error(
      `Invalid solanaDestination: ${err instanceof Error ? err.message : 'expected base58 public key'}.`
    );
  }

  const outputAsset: 'USDC' | 'SOL' = params.outputAsset === 'SOL' ? 'SOL' : 'USDC';
  if (
    params.outputAsset !== undefined &&
    params.outputAsset !== 'USDC' &&
    params.outputAsset !== 'SOL'
  ) {
    throw new Error("outputAsset must be 'USDC' or 'SOL'.");
  }

  const bridgePreference = params.bridgePreference ?? 'auto';
  if (!['auto', 'relay', 'lifi', 'cctp'].includes(bridgePreference)) {
    throw new Error("bridgePreference must be 'auto', 'relay', 'lifi', or 'cctp'.");
  }

  const includePreflight = params.includePreflight !== false;
  const clampedAssets = params.assets.slice(0, MAX_PREPARE_BATCH_ASSETS);
  const concurrency = Math.max(
    1,
    Math.min(
      MAX_PREPARE_BATCH_ASSETS,
      Math.floor(params.concurrency ?? DEFAULT_PREPARE_BATCH_CONCURRENCY)
    )
  );

  const prepareFn = params.prepareAssetFn ?? prepareRealExecution;
  const preflightFn = params.preflightAssetFn ?? preflightDefiAsset;
  const shouldCheckGas = params.includeGasCheck !== false && !params.prepareAssetFn;
  const fetchBalancesFn = params.fetchChainBalancesFn ?? fetchChainNativeBalancesWei;

  const uniqueEvmChains = Array.from(
    new Set(
      clampedAssets
        .map((a) => a?.chain)
        .filter((c): c is EvmChainId => typeof c === 'string' && Object.hasOwn(EVM_CHAINS, c))
    )
  );

  // Fetch live native balances across unique EVM chains once in parallel (~80ms)
  // so route auctions disqualify routes whose msg.value (e.g. deBridge 0.5 POL fixFee) exceeds balance
  // and the UI can flag zero-gas chains BEFORE opening the user's wallet.
  const nativeBalancesByChain =
    shouldCheckGas || params.fetchChainBalancesFn
      ? await fetchBalancesFn({
          chains: uniqueEvmChains,
          userAddress,
          timeoutMs: 2_500,
        }).catch(() => ({} as Partial<Record<EvmChainId, bigint>>))
      : ({} as Partial<Record<EvmChainId, bigint>>);

  const defaultSimulateTxFn:
    | ((tx: AuctionExecutableTx) => Promise<{ ok: boolean; reason?: string }>)
    | undefined =
    params.simulateTxFn ??
    (shouldCheckGas
      ? async (tx: AuctionExecutableTx) => {
          const cfg = EVM_CHAINS[tx.chain];
          if (!cfg) return { ok: true };
          const res = await evmJsonRpcCall<string>(
            cfg.rpcUrls,
            'eth_call',
            [
              {
                from: tx.from,
                to: tx.to,
                data: tx.data,
                ...(tx.value && tx.value !== '0x0' ? { value: tx.value } : {}),
              },
              'latest',
            ],
            2_200
          ).catch(() => null);
          if (res?.error) {
            const msg = String(res.error.message || 'execution reverted');
            if (/revert|exceeds balance|insufficient|execution reverted/i.test(msg)) {
              return { ok: false, reason: msg.slice(0, 140) };
            }
          }
          return { ok: true };
        }
      : undefined);

  const items = await mapWithConcurrency(
    clampedAssets,
    concurrency,
    async (asset): Promise<PrepareBatchItemResult> => {
      const assetId = typeof asset?.id === 'string' ? asset.id : 'unknown';
      const chain = typeof asset?.chain === 'string' ? asset.chain : 'unknown';
      const symbol = typeof asset?.symbol === 'string' ? asset.symbol : 'UNKNOWN';

      const shouldPreflight = includePreflight && isDefiEvmAsset(asset);
      const chainNativeBal = Object.hasOwn(EVM_CHAINS, chain)
        ? nativeBalancesByChain[chain as EvmChainId]
        : undefined;

      const [prepSettled, preflightSettled] = await Promise.allSettled([
        prepareFn({
          asset,
          userAddress,
          solanaDestination,
          outputAsset,
          bridgePreference,
          protocolFeeBps: 0,
          feeRecipientEvm: undefined,
          routeAuctionOptions: {
            ...(params.hasSolanaUsdcAta !== undefined
              ? { hasSolanaUsdcAta: params.hasSolanaUsdcAta }
              : {}),
            ...(chainNativeBal !== undefined ? { nativeBalanceWei: chainNativeBal } : {}),
            ...(defaultSimulateTxFn ? { simulateTxFn: defaultSimulateTxFn } : {}),
          },
        }),
        shouldPreflight
          ? preflightFn({
              asset,
              walletAddress: userAddress,
              outputAsset,
            })
          : Promise.resolve(undefined),
      ]);

      const preflight =
        preflightSettled.status === 'fulfilled' ? preflightSettled.value : undefined;

      if (prepSettled.status === 'fulfilled') {
        return {
          assetId,
          chain,
          symbol,
          ok: true,
          prepared: prepSettled.value,
          ...(preflight ? { preflight } : {}),
        };
      }

      return {
        assetId,
        chain,
        symbol,
        ok: false,
        error:
          prepSettled.reason instanceof Error
            ? prepSettled.reason.message
            : 'Could not prepare transaction for asset.',
        ...(preflight ? { preflight } : {}),
      };
    }
  );

  let readyCount = 0;
  let failedCount = 0;
  let totalNetUsd = 0;
  let totalGasUsd = 0;
  let totalSignatures = 0;

  const msgValueByChain = new Map<EvmChainId, bigint>();
  const estGasByChain = new Map<EvmChainId, number>();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const srcAsset = clampedAssets[i];
    if (item.ok && item.prepared) {
      readyCount += 1;
      const netUsd =
        typeof item.prepared.liveNetUsd === 'number' && Number.isFinite(item.prepared.liveNetUsd)
          ? item.prepared.liveNetUsd
          : typeof item.prepared.quotedOutUsd === 'number' &&
            Number.isFinite(item.prepared.quotedOutUsd)
          ? item.prepared.quotedOutUsd
          : typeof srcAsset?.netUsdcBatched === 'number' && Number.isFinite(srcAsset.netUsdcBatched)
          ? Math.max(0, srcAsset.netUsdcBatched)
          : 0;
      const gasUsd =
        typeof item.prepared.estimatedGasUsd === 'number' &&
        Number.isFinite(item.prepared.estimatedGasUsd)
          ? item.prepared.estimatedGasUsd
          : typeof srcAsset?.batchedGasUsd === 'number' && Number.isFinite(srcAsset.batchedGasUsd)
          ? Math.max(0, srcAsset.batchedGasUsd)
          : 0;
      totalNetUsd += Math.max(0, netUsd);
      totalGasUsd += Math.max(0, gasUsd);
      totalSignatures += Array.isArray(item.prepared.transactions)
        ? item.prepared.transactions.length
        : 0;

      if (Object.hasOwn(EVM_CHAINS, item.chain)) {
        const evmChain = item.chain as EvmChainId;
        estGasByChain.set(evmChain, (estGasByChain.get(evmChain) ?? 0) + Math.max(0, gasUsd));
        let itemMsgVal = 0n;
        for (const tx of item.prepared.transactions ?? []) {
          itemMsgVal += parseHexOrDecWei(tx?.value);
        }
        msgValueByChain.set(evmChain, (msgValueByChain.get(evmChain) ?? 0n) + itemMsgVal);
      }
    } else {
      failedCount += 1;
    }
  }

  const chainGasStatus: Record<string, ChainNativeGasStatus> = {};
  const zeroGasChains: string[] = [];
  for (const chain of uniqueEvmChains) {
    const status = evaluateChainNativeGasStatus({
      chain,
      nativeBalanceWei: nativeBalancesByChain[chain],
      requiredMsgValueWei: msgValueByChain.get(chain) ?? 0n,
      estimatedGasUsd: estGasByChain.get(chain) ?? 0.02,
    });
    chainGasStatus[chain] = status;
    if (!status.hasEnoughGas) {
      zeroGasChains.push(chain);
    }
  }

  return {
    preparedAt: new Date().toISOString(),
    durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    count: items.length,
    readyCount,
    failedCount,
    totalNetUsd: round2(totalNetUsd),
    totalGasUsd: round4(totalGasUsd),
    totalProtocolFeeUsd: 0,
    totalSignatures,
    chainGasStatus,
    zeroGasChains,
    items,
  };
}
