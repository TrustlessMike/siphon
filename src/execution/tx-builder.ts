import {
  encodeCctpDepositForBurn,
  solanaAddressToBytes32,
  solanaOwnerToUsdcAtaBytes32,
} from '../bridge/cctp.js';
import {
  AAVE_V2_LENDING_POOLS,
  checkCompoundAccountSafety,
  type CompoundAccountSafety,
  computeAaveSafePartialWithdrawal,
  identifyProtocolExtractorId,
  isCuratedDefiVault,
  isKnownCooldownVault,
  isLiquidReceiptToken,
  MIN_SAFE_HEALTH_FACTOR,
  PROTOCOL_EXTRACTOR_REGISTRY,
  resolveDefiExitPlan,
  validateTrustedProtocolTarget,
} from '../defi/extractors.js';
import {
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  getProtocolFeeConfig,
  isCuratedRegistryToken,
  type ProtocolFeeConfig,
  SOLANA_CCTP_DOMAIN,
} from '../scanner/chains.js';
import {
  type AaveAccountSafety,
  checkAaveV3AccountSafety,
  checkErc20Allowance,
  isEip2612Token,
  simulateBurnTransferOnchain,
  SOLANA_USDC_MINT,
} from '../scanner/discovery.js';
import { evaluateLiveQuoteHaircut } from '../scanner/roi.js';
import { evmJsonRpcCall } from '../scanner/rpc.js';
import type {
  ChainedFollowUpPlan,
  DefiExitPlan,
  EvmChainId,
  ScannedAsset,
} from '../scanner/types.js';
import {
  type AuctionBridgeProvider,
  type AuctionProviderFn,
  type AuctionProviderQuote,
  computeDynamicGasReserveSummary,
  DEFAULT_AUCTION_TIMEOUT_MS,
  type RouteAuctionCandidateSummary,
  type RouteAuctionFetcher,
  type RouteAuctionMetadata,
  runLiveParallelRouteAuction,
  validateQuoteTransactions,
} from './route-auction.js';

export type {
  AuctionBridgeProvider,
  AuctionProviderFn,
  AuctionProviderQuote,
  RouteAuctionCandidateSummary,
  RouteAuctionFetcher,
  RouteAuctionMetadata,
};

export interface RouteAuctionExecutionOptions {
  timeoutMs?: number;
  fetcher?: RouteAuctionFetcher;
  providers?: Partial<Record<AuctionBridgeProvider, AuctionProviderFn>>;
  hasSolanaUsdcAta?: boolean;
  solPriceUsd?: number;
  allowHighCost?: boolean;
  slippageBps?: number;
}

const RELAY_SOLANA_CHAIN_ID = 792703809;
const LIFI_SOLANA_CHAIN_ID = 1151111081099710;
const SOLANA_NATIVE_MINT = '11111111111111111111111111111111';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const ALLOWED_COMPOUND_V3_COMETS: Partial<Record<EvmChainId, string[]>> = {
  ethereum: [
    '0xc3d688b66703497daa19211eedff47f25384cdc3', // cUSDCv3
    '0xa17581a9e3356d9a858b789d68b4d866e593ae94', // cWETHv3
    '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840', // cUSDTv3
  ],
  base: [
    '0xb125e6687d4313864e53df431d5425969c15eb2f', // cUSDCv3
    '0x46e6b214b524310239732d51387075e0e70970bf', // cWETHv3
    '0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf',
  ],
  arbitrum: [
    '0x9c4ec768c28520b50860ea7a15bd7213a9ff58bf', // cUSDCv3
    '0xa5edbdd9646f8dff606d7448e414884c7d905dca', // cUSDC.e v3
    '0x6f7d514bbd4aff3bcd1140b7344b32f063dee486', // cWETHv3
  ],
  optimism: [
    '0x2e44e174f7d53f0212823acc11c01a11d58c5bcb', // cUSDCv3
    '0xe36a30d249f7761327fd973001a32010b521b6fd', // cWETHv3
  ],
  polygon: [
    '0xf25212e676d1f7f89cd72ffee66158f541246445', // cUSDCv3
  ],
};

function assertEvmAddress(val: string | undefined | null, label: string, allowZero = false): string {
  if (typeof val !== 'string') {
    throw new Error(`Invalid ${label}: expected 20-byte 0x EVM address.`);
  }
  const clean = val.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) {
    throw new Error(`Invalid ${label}: must be a single 20-byte 0x EVM address.`);
  }
  if (!allowZero && clean.toLowerCase() === ZERO_ADDRESS) {
    throw new Error(`Invalid ${label}: zero address is not allowed.`);
  }
  return clean;
}

/** Set when a quote provider was rate-limited or unreachable, as opposed to answering "no route". */
interface QuoteState {
  throttled: boolean;
}

/** Max simultaneous live quote lookups per chain batch (public quote APIs rate-limit bursts). */
const QUOTE_CONCURRENCY = 4;

/**
 * Fetch with a per-attempt timeout and one backoff retry on 429 / 5xx / timeout,
 * so a rate-limited quote is not misreported as "no route".
 */
async function fetchQuote(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  state?: QuoteState,
  opts?: {
    fetcher?: RouteAuctionFetcher;
    signal?: AbortSignal;
    retries?: number;
  }
): Promise<Response | null> {
  const fetcher = opts?.fetcher ?? globalThis.fetch.bind(globalThis);
  const maxAttempts = Math.max(1, (opts?.retries ?? 1) + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (opts?.signal?.aborted) return null;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (opts?.signal) {
      opts.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetcher(url, { ...init, signal: controller.signal });
      if (res.status !== 429 && res.status < 500) return res;
      if (state) state.throttled = true;
    } catch {
      // timeout or network error: retry once
      if (state) state.throttled = true;
    } finally {
      clearTimeout(timer);
      if (opts?.signal) {
        opts.signal.removeEventListener('abort', onParentAbort);
      }
    }
    if (attempt + 1 < maxAttempts && !opts?.signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
  }
  return null;
}

async function settleWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next;
      next += 1;
      try {
        results[idx] = { status: 'fulfilled', value: await worker(items[idx]) };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
const MAX_UINT256 = (1n << 256n) - 1n;

export interface ExecutableEvmTx {
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
  value: string; // hex wei string e.g. '0x0'
  gas?: string;
}

export interface FeeBreakdown {
  feeBps: number;
  feePercent: number;
  feeRecipientEvm: string | null;
  feeDestinationType: 'contract' | 'wallet';
  treasuryConfigured: boolean;
  collectionMethod: 'relay_app_fee' | 'onchain_split' | 'none';
  estimatedFeeUsd: number;
}

export interface PreparedExecution {
  assetId: string;
  action: ScannedAsset['action'];
  provider:
    | 'relay'
    | 'mayan_swift'
    | 'debridge_dln'
    | 'lifi'
    | 'circle_cctp'
    | 'enso_multi_input'
    | 'aave_v3'
    | 'aave_v2'
    | 'compound_v3'
    | 'compound_v2'
    | 'erc4626'
    | 'yearn_v2'
    | 'uniswap_v2_lp'
    | 'uniswap_v3_nft'
    | 'erc20_burn';
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  explorerUrl: string;
  estimatedOutput: string;
  estimatedSeconds: number;
  quotedOutUsd?: number;
  liveNetUsd?: number;
  liveHaircutPct?: number;
  estimatedGasUsd?: number;
  estimatedFeeUsd?: number;
  feeBreakdown?: FeeBreakdown;
  requestId?: string;
  routeAuction?: RouteAuctionMetadata;
  defiExitPlan?: DefiExitPlan;
  chainedFollowUpPlan?: ChainedFollowUpPlan;
  transactions: ExecutableEvmTx[];
  notes: string[];
}

export interface PreparedBatchCall {
  stepId: string;
  assetId: string;
  assetSymbol: string;
  action: ScannedAsset['action'];
  provider: PreparedExecution['provider'];
  label: string;
  description: string;
  to: string;
  data: string;
  value: string;
  gas?: string;
}

export interface PreparedChainBatch {
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  explorerUrl: string;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  calls: PreparedBatchCall[];
  bridgeTrackers: Array<{
    assetId: string;
    assetSymbol: string;
    provider: PreparedExecution['provider'];
    requestId?: string;
    estimatedOutput: string;
    estimatedSeconds: number;
    requiresSolanaClaim?: boolean;
  }>;
  skippedAssets: Array<{
    assetId: string;
    assetSymbol: string;
    reason: string;
  }>;
  savings: {
    totalCalls: number;
    walletPopupsEip5792: number;
    walletPopupsLegacy: number;
    popupsSaved: number;
    dedupedApprovals: number;
    permit2ReadyCount: number;
    eip2612Count: number;
  };
  feeBreakdown: FeeBreakdown;
  estimatedSeconds: number;
  routeAuction?: RouteAuctionMetadata;
  dynamicGasReserve?: {
    reserveWei: string;
    reserveNative: number;
    staticReserveNative: number;
    recoveredNative: number;
    recoveredUsd: number;
    effectiveSafetyRatio: number;
  };
  defiExitPlans?: Record<string, DefiExitPlan>;
  chainedFollowUpPlans?: ChainedFollowUpPlan[];
  dustConsolidation?: {
    consolidated: boolean;
    provider?: 'enso_multi_input';
    consolidatedTokenCount: number;
    consolidatedAssetIds: string[];
    estimatedUsdcOut?: string;
    approvalsSkipped: number;
    swapPopupsEliminated: number;
    instantGaslessEligibleIds: string[];
    instantGaslessCount: number;
    legacyRequiresApprovalCount: number;
  };
  notes: string[];
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

function asEvmChain(chain: string): EvmChainId {
  if (!(chain in EVM_CHAINS)) throw new Error(`Unsupported EVM chain: ${chain}`);
  return chain as EvmChainId;
}

function buildProtocolFeeTransferTx(params: {
  asset: ScannedAsset;
  userAddress: string;
  feeRaw: bigint;
  feeConfig: ProtocolFeeConfig;
}): ExecutableEvmTx | null {
  const { asset, userAddress, feeRaw, feeConfig } = params;
  if (!feeConfig.feeRecipientEvm || feeRaw <= 0n) return null;
  const evmChain = asEvmChain(asset.chain);
  const cfg = EVM_CHAINS[evmChain];
  const recipient = feeConfig.feeRecipientEvm;
  const destLabel = feeConfig.feeDestinationType === 'wallet' ? 'Treasury Wallet' : 'TurgaliumFeeVault';

  if (asset.address === 'native') {
    return {
      stepId: 'protocol_fee_transfer',
      label: `Protocol Fee (${feeConfig.feePercent}% ${asset.symbol} → ${destLabel})`,
      description: `Routes ${feeConfig.feePercent}% (${feeConfig.feeBps} bps) native ${asset.symbol} fee to ${recipient}`,
      chain: evmChain,
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
    chain: evmChain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    from: userAddress,
    to: asset.address,
    data: encodeErc20Transfer(recipient, feeRaw),
    value: '0x0',
  };
}

function toHexWei(val: string | number | bigint | undefined): string {
  if (val === undefined || val === null || val === '') return '0x0';
  if (typeof val === 'string' && val.startsWith('0x')) return val;
  try {
    return '0x' + BigInt(val).toString(16);
  } catch {
    return '0x0';
  }
}

function pad32Hex(val: string): string {
  const clean = assertEvmAddress(val, 'ABI address parameter', true);
  return clean.slice(2).toLowerCase().padStart(64, '0');
}

function encodeErc20Approve(spender: string, amount: bigint): string {
  return `0x095ea7b3${pad32Hex(spender)}${amount.toString(16).padStart(64, '0')}`;
}

function encodeErc20Transfer(to: string, amount: bigint): string {
  return `0xa9059cbb${pad32Hex(to)}${amount.toString(16).padStart(64, '0')}`;
}

/**
 * Builds REAL directly signable DeFi extraction calldata across ALL supported protocols:
 *   - Smart Exit Router: liquid receipts (wstETH, rETH, cbETH, weETH, ezETH, sUSDe, sDAI, sUSDS, stETH)
 *     bypass cooldowns & unwrap gas via Direct Swap & Bridge
 *   - Aave v3 & Aave v2 (with Safe Partial Debt Exit calculator keeping Health Factor >= 1.6)
 *   - Compound v3 (Comet.withdraw) & Compound v2 / Venus / Benqi (cToken.redeem)
 *   - ERC-4626 vaults (Morpho, Yearn v3, Spark, Sky, Fluid, Euler) using previewRedeem/convertToAssets
 *   - Uniswap v2 / Sushi / Aerodrome v2 LP (approve + removeLiquidity)
 *   - Uniswap v3 / Aerodrome CL NFT (NonfungiblePositionManager.multicall([decreaseLiquidity, collect, burn]))
 */
async function buildDefiWithdrawExecution(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp';
  feeConfig: ProtocolFeeConfig;
  followUpQuoteFn?: FollowUpQuoteFn;
  aaveSafetyCheckFn?: AaveSafetyCheckFn;
  compoundSafetyCheckFn?: CompoundSafetyCheckFn;
  routeAuctionOptions?: RouteAuctionExecutionOptions;
  allowanceCheckFn?: Erc20AllowanceCheckFn;
}): Promise<PreparedExecution> {
  const {
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    bridgePreference,
    feeConfig,
    followUpQuoteFn,
    aaveSafetyCheckFn = checkAaveV3AccountSafety,
    compoundSafetyCheckFn = checkCompoundAccountSafety,
    routeAuctionOptions,
    allowanceCheckFn,
  } = params;
  assertEvmAddress(userAddress, 'userAddress');
  const evmChain = asEvmChain(asset.chain);
  const cfg = EVM_CHAINS[evmChain];
  const protocolId = identifyProtocolExtractorId(asset);
  const quoteDirectBridge: FollowUpQuoteFn =
    followUpQuoteFn ??
    ((a, u, s, o, b, f) =>
      buildBridgeExecution(a, u, s, o, b, f, { routeAuctionOptions, allowanceCheckFn }));

  // 0. Security guard: verify protocolAddress against canonical trusted contracts before building calldata.
  // Never bypass validation when protocolAddress redirects away from the receipt contract itself.
  if (asset.protocolAddress) {
    const isDirectLiquidOnly =
      protocolId === 'liquid_receipt' &&
      isLiquidReceiptToken(asset.symbol, asset.address) &&
      asset.protocolAddress.toLowerCase() === asset.address.toLowerCase();
    if (!isDirectLiquidOnly) {
      const targetToVerify =
        protocolId === 'uniswap_v2_lp'
          ? asset.lpRouterAddress || asset.protocolAddress
          : protocolId === 'uniswap_v3_nft'
          ? asset.nftManagerAddress || asset.protocolAddress
          : asset.protocolAddress;
      const trust = validateTrustedProtocolTarget({
        chain: evmChain,
        protocolId: protocolId === 'liquid_receipt' ? 'erc4626' : protocolId,
        assetAddress: asset.address,
        protocolAddress: targetToVerify,
      });
      if (!trust.trusted) {
        throw new Error(trust.reason || `Blocked untrusted protocol target for ${asset.symbol}.`);
      }
    }
  }

  // Defense in depth: never allow Aave debt tokens to be executed as collateral withdrawals
  if (
    (protocolId === 'aave_v3' || protocolId === 'aave_v2') &&
    /^(variable|stable)debt/i.test(asset.symbol.trim())
  ) {
    throw new Error(
      `Blocked Aave debt token (${asset.symbol}): borrow debt tokens cannot be withdrawn as collateral.`
    );
  }

  // Block assets whose exit plan already failed preflight verification (unless liquid receipt direct swap)
  if (
    asset.defiExitPlan?.preflightStatus === 'blocked' &&
    !(isLiquidReceiptToken(asset.symbol, asset.address) && asset.defiExitPlan.cooldownDetected)
  ) {
    throw new Error(
      asset.defiExitPlan.preflightReason ||
        `${asset.protocol || 'Vault'} (${asset.symbol}) is blocked by preflight safety checks.`
    );
  }

  // 1. Cooldown-locked vaults (like Ethena sUSDe) MUST bypass redeem() via Direct Swap when liquid!
  const cooldownVault =
    isKnownCooldownVault(asset.symbol, asset.address) || Boolean(asset.defiExitPlan?.cooldownDetected);
  const shouldRouteDirectSwap =
    protocolId === 'liquid_receipt' ||
    (cooldownVault && isLiquidReceiptToken(asset.symbol, asset.address)) ||
    asset.defiExitPlan?.exitStrategy === 'direct_swap_bypass_cooldown';

  if (cooldownVault && !isLiquidReceiptToken(asset.symbol, asset.address)) {
    throw new Error(
      `${asset.protocol || 'Vault'} (${asset.symbol}) currently has a withdrawal cooldown lock and lacks deep DEX liquidity for an instant swap.`
    );
  }

  if (shouldRouteDirectSwap) {
    const directPlan =
      asset.defiExitPlan ??
      resolveDefiExitPlan({
        asset,
        outputAsset,
      });
    try {
      const bridged = await quoteDirectBridge(
        asset,
        userAddress,
        solanaDestination,
        outputAsset,
        bridgePreference,
        feeConfig
      );
      return {
        ...bridged,
        defiExitPlan: directPlan,
        notes: [directPlan.preflightReason, ...bridged.notes],
      };
    } catch (err) {
      // If a non-cooldown ERC-4626 vault (e.g. sDAI / sUSDS) couldn't fetch a live direct bridge quote,
      // fall back cleanly to ERC-4626 redeem instead of failing hard; for cooldown vaults/LSTs rethrow!
      if (protocolId !== 'erc4626' || cooldownVault) {
        throw err;
      }
    }
  }

  // 2. Aave v3 & Aave v2 live FAIL-CLOSED debt guard + Safe Partial Exit calculator (HF >= 1.6)
  let resolvedExitPlan = asset.defiExitPlan;
  if (protocolId === 'aave_v3' || protocolId === 'aave_v2') {
    const poolTarget =
      asset.protocolAddress ||
      (protocolId === 'aave_v2' ? AAVE_V2_LENDING_POOLS[evmChain] : cfg.aaveV3Pool);
    let debtUsd = asset.aaveDebtUsd ?? 0;
    let healthFactor = asset.aaveHealthFactor;
    let totalCollateralUsd = asset.aaveTotalCollateralUsd;
    let ltBps = asset.aaveLiquidationThresholdBps;

    if (debtUsd <= 0 && poolTarget) {
      const safety = await aaveSafetyCheckFn(evmChain, userAddress, poolTarget);
      if (!safety.checked) {
        throw new Error(
          `Aave v3 safety guard: could not verify onchain debt status (${safety.reason}). Blocking MAX withdrawal to protect against liquidation — please retry once RPC is reachable.`
        );
      }
      if (safety.hasActiveDebt) {
        debtUsd = safety.totalDebtUsd;
        healthFactor = safety.healthFactor;
        totalCollateralUsd = safety.totalCollateralUsd;
        ltBps = safety.currentLiquidationThresholdBps;
      }
    }

    if (debtUsd > 0) {
      const partial = computeAaveSafePartialWithdrawal({
        totalCollateralUsd,
        totalDebtUsd: debtUsd,
        liquidationThresholdBps: ltBps,
        currentHealthFactor: healthFactor,
        positionUsd: asset.grossUsd,
        positionRawBalance: BigInt(asset.rawBalance),
        positionDecimals: asset.decimals,
        positionPriceUsd: asset.priceUsd,
        minSafeHealthFactor: MIN_SAFE_HEALTH_FACTOR,
      });

      if (!partial.canWithdrawAny) {
        throw new Error(
          `Aave v3 safety guard: wallet has $${debtUsd.toFixed(2)} active debt (HF ${partial.currentHealthFactor.toFixed(2)}). ${partial.reason}`
        );
      }

      resolvedExitPlan = resolveDefiExitPlan({
        asset: {
          ...asset,
          aaveDebtUsd: debtUsd,
          aaveHealthFactor: partial.currentHealthFactor,
          aaveTotalCollateralUsd: totalCollateralUsd,
          aaveLiquidationThresholdBps: ltBps,
        },
        outputAsset,
      });
    }
  }

  // 2b. Compound v3 & Compound v2 / Venus / Benqi FAIL-CLOSED active borrow guard
  if (protocolId === 'compound_v3' || protocolId === 'compound_v2') {
    if (
      (asset.compoundDebtUsd && asset.compoundDebtUsd > 0) ||
      (asset.compoundShortfallUsd && asset.compoundShortfallUsd > 0)
    ) {
      throw new Error(
        `Compound safety guard: wallet has active borrow/shortfall on ${asset.protocol || 'Compound'}. Repay borrow before withdrawing collateral to prevent revert or liquidation.`
      );
    }
    const targetAddr =
      asset.protocolAddress ||
      asset.address ||
      (protocolId === 'compound_v3' ? cfg.compoundV3Comet : undefined);
    if (targetAddr) {
      const compSafety = await compoundSafetyCheckFn({
        chain: evmChain,
        userAddress,
        protocolId,
        targetAddress: targetAddr,
      });
      if (!compSafety.checked) {
        throw new Error(
          `Compound safety guard: could not verify onchain borrow status (${compSafety.reason}). Blocking withdrawal to protect against liquidation.`
        );
      }
      if (compSafety.hasActiveBorrow) {
        throw new Error(`Compound safety guard: ${compSafety.reason}`);
      }
    }
  }

  if (!resolvedExitPlan) {
    resolvedExitPlan = resolveDefiExitPlan({ asset, outputAsset });
  }

  // 3. Build protocol extraction transactions via the Modular Protocol Extractor Registry
  const extractor = PROTOCOL_EXTRACTOR_REGISTRY[protocolId];
  const built = extractor.buildExtraction({
    asset,
    userAddress,
    chain: evmChain,
    exitPlan: resolvedExitPlan,
  });

  if (built.provider === 'direct_swap') {
    const bridged = await quoteDirectBridge(
      asset,
      userAddress,
      solanaDestination,
      outputAsset,
      bridgePreference,
      feeConfig
    );
    return {
      ...bridged,
      defiExitPlan: resolvedExitPlan,
    };
  }

  const transactions: ExecutableEvmTx[] = built.transactions.map((t) => ({
    stepId: t.stepId,
    label: t.label,
    description: t.description,
    chain: evmChain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    from: userAddress,
    to: t.to,
    data: t.data,
    value: t.value,
  }));

  const chainedFollowUpPlan: ChainedFollowUpPlan | undefined = built.unlockedAssets.length
    ? {
        sourceAssetId: asset.id,
        sourceSymbol: asset.symbol,
        protocol: asset.protocol || extractor.name,
        chain: evmChain,
        unlockedAssets: built.unlockedAssets.map((u) => ({
          address: u.address,
          symbol: u.symbol,
          decimals: u.decimals,
          expectedRawAmount: u.expectedRawAmount.toString(),
          expectedUiAmount: u.expectedUiAmount,
          estimatedUsd: u.estimatedUsd,
        })),
        bundledInCurrentBatch: false,
        bridgeProvider: 'pending_after_unwind',
        solanaDestination,
        outputAsset,
        autoAdvanceAction: 'auto_quote_and_bridge_unlocked',
        plainEnglishSummary: `Auto-bridge ${built.unlockedAssets.map((u) => `${u.expectedUiAmount} ${u.symbol}`).join(' + ')} to Solana ${outputAsset} immediately after ${asset.protocol || extractor.name} unwind confirms.`,
      }
    : undefined;

  return {
    assetId: asset.id,
    action: asset.action,
    provider: built.provider,
    chain: evmChain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    estimatedOutput: built.estimatedOutput,
    estimatedSeconds: built.estimatedSeconds,
    defiExitPlan: resolvedExitPlan,
    chainedFollowUpPlan,
    transactions,
    notes: built.notes,
  };
}

/**
 * Builds REAL live Relay quote & signable transactions for ANY EVM token/native -> Solana USDC or SOL.
 */
async function tryRelayBridgeQuote(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  feeConfig: ProtocolFeeConfig;
  quoteState?: QuoteState;
  timeoutMs?: number;
  fetcher?: RouteAuctionFetcher;
  signal?: AbortSignal;
  retries?: number;
}): Promise<PreparedExecution | null> {
  const {
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    feeConfig,
    quoteState,
    timeoutMs = 7000,
    fetcher,
    signal,
    retries,
  } = params;
  const evmChain = asEvmChain(asset.chain);
  const cfg = EVM_CHAINS[evmChain];
  const originCurrency = asset.address === 'native' ? ZERO_ADDRESS : asset.address;
  const destinationCurrency = outputAsset === 'SOL' ? SOLANA_NATIVE_MINT : SOLANA_USDC_MINT;
  const rawTotal = BigInt(asset.rawBalance);
  const { feeRaw, netRaw } = splitRawAmountForFee(rawTotal, feeConfig);
  const estFeeUsd = Number(((asset.grossUsd * feeConfig.feeBps) / 10_000).toFixed(2));

  // Prefer Relay's native appFees (single solver fill, zero extra tx).
  // If Relay rejects appFees for a given route/bps, fall back cleanly to an explicit
  // onchain fee transfer + Relay quote on the exact net amount inside the same EIP-5792 batch.
  const attempts: Array<{ useAppFee: boolean; amount: bigint }> = feeConfig.feeRecipientEvm
    ? [
        { useAppFee: true, amount: rawTotal },
        { useAppFee: false, amount: netRaw },
      ]
    : [{ useAppFee: false, amount: rawTotal }];

  for (const attempt of attempts) {
    if (attempt.amount <= 0n) continue;
    try {
      const bodyPayload: Record<string, unknown> = {
        user: userAddress,
        originChainId: cfg.chainId,
        destinationChainId: RELAY_SOLANA_CHAIN_ID,
        originCurrency,
        destinationCurrency,
        recipient: solanaDestination,
        amount: attempt.amount.toString(),
        tradeType: 'EXACT_INPUT',
      };
      if (attempt.useAppFee && feeConfig.feeRecipientEvm) {
        bodyPayload.appFees = [
          {
            recipient: feeConfig.feeRecipientEvm,
            fee: String(feeConfig.feeBps),
          },
        ];
      }

      const res = await fetchQuote(
        'https://api.relay.link/quote',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyPayload),
        },
        timeoutMs,
        quoteState,
        { fetcher, signal, retries }
      );
      if (!res || !res.ok) continue;

      const json = (await res.json()) as {
        requestId?: string;
        details?: {
          timeEstimate?: number;
          currencyOut?: { amountFormatted?: string; amountUsd?: string; currency?: { symbol?: string } };
        };
        fees?: {
          gas?: { amountUsd?: string };
          relayer?: { amountUsd?: string };
          app?: { amountUsd?: string };
        };
        steps?: Array<{
          id: string;
          action?: string;
          description?: string;
          kind: string;
          requestId?: string;
          items?: Array<{
            status?: string;
            data?: {
              from?: string;
              to?: string;
              data?: string;
              value?: string;
              gas?: string;
              chainId?: number;
            };
          }>;
        }>;
      };

      const txs: ExecutableEvmTx[] = [];
      let collectionMethod: FeeBreakdown['collectionMethod'] = 'none';
      if (attempt.useAppFee && feeConfig.feeRecipientEvm) {
        collectionMethod = 'relay_app_fee';
      } else if (!attempt.useAppFee && feeConfig.feeRecipientEvm && feeRaw > 0n) {
        const feeTx = buildProtocolFeeTransferTx({ asset, userAddress, feeRaw, feeConfig });
        if (feeTx) {
          txs.push(feeTx);
          collectionMethod = 'onchain_split';
        }
      }

      let reqId = json.requestId;
      for (const step of json.steps ?? []) {
        if (step.requestId) reqId = step.requestId;
        if (step.kind !== 'transaction') continue;
        for (const item of step.items ?? []) {
          if (!item.data?.to || !item.data?.data) continue;
          txs.push({
            stepId: step.id,
            label: step.action || `Execute ${step.id}`,
            description: step.description || `${step.id} ${asset.symbol} on ${cfg.name}`,
            chain: evmChain,
            chainId: item.data.chainId ?? cfg.chainId,
            chainName: cfg.name,
            explorerUrl: cfg.explorerUrl,
            from: item.data.from ?? userAddress,
            to: item.data.to,
            data: item.data.data,
            value: toHexWei(item.data.value),
            gas: item.data.gas ? toHexWei(item.data.gas) : undefined,
          });
        }
      }

      if (!txs.length) continue;

      const txValidation = validateQuoteTransactions({
        transactions: txs,
        asset,
        chain: evmChain,
        userAddress,
        feeRecipientEvm: feeConfig.feeRecipientEvm,
      });
      if (!txValidation.valid) {
        throw new Error(`Relay security validation failed: ${txValidation.reason}`);
      }

      const outFormatted = json.details?.currencyOut?.amountFormatted ?? '0';
      const outSym = json.details?.currencyOut?.currency?.symbol ?? outputAsset;
      const appFeeUsd = Number(json.fees?.app?.amountUsd ?? estFeeUsd);
      const quotedOutUsd =
        Number(json.details?.currencyOut?.amountUsd) ||
        (outSym.toUpperCase() === 'USDC' ? Number(outFormatted) : asset.grossUsd);
      const actualGasUsd = Number(json.fees?.gas?.amountUsd ?? asset.batchedGasUsd ?? 0);
      const haircut = evaluateLiveQuoteHaircut({
        grossUsd: asset.grossUsd,
        quoteOutUsd: quotedOutUsd,
        actualGasUsd,
      });

      return {
        assetId: asset.id,
        action: asset.action,
        provider: 'relay',
        chain: evmChain,
        chainId: cfg.chainId,
        chainName: cfg.name,
        explorerUrl: cfg.explorerUrl,
        estimatedOutput: `${Number(outFormatted).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${outSym}`,
        estimatedSeconds: Math.max(2, Number(json.details?.timeEstimate ?? 10)),
        quotedOutUsd: haircut.quoteOutUsd,
        liveNetUsd: haircut.liveNetUsd,
        liveHaircutPct: haircut.liveHaircutPct,
        estimatedGasUsd: actualGasUsd,
        estimatedFeeUsd: Number(json.fees?.relayer?.amountUsd ?? 0) + (feeConfig.feeRecipientEvm ? appFeeUsd : 0),
        feeBreakdown: {
          feeBps: feeConfig.feeBps,
          feePercent: feeConfig.feePercent,
          feeRecipientEvm: feeConfig.feeRecipientEvm,
          feeDestinationType: feeConfig.feeDestinationType,
          treasuryConfigured: feeConfig.treasuryConfigured,
          collectionMethod,
          estimatedFeeUsd: feeConfig.feeRecipientEvm ? appFeeUsd : estFeeUsd,
        },
        requestId: reqId,
        transactions: txs,
        notes: [
          `Live Relay cross-chain route: swaps & fills directly into ${solanaDestination.slice(0, 6)}…${solanaDestination.slice(-4)} on Solana with zero manual claim.`,
          feeConfig.feeRecipientEvm
            ? `Protocol fee ${feeConfig.feePercent}% routed via ${collectionMethod === 'relay_app_fee' ? 'Relay native appFee' : 'onchain EIP-5792 split'} to ${feeConfig.feeRecipientEvm}.`
            : `Protocol fee ${feeConfig.feePercent}% modeled (set TURGALIUM_FEE_RECIPIENT_EVM or enter a treasury address to route onchain).`,
        ],
      };
    } catch (err) {
      if (err instanceof Error && /security validation failed/i.test(err.message)) {
        throw err;
      }
      continue;
    }
  }
  return null;
}

/**
 * Fallback #1: Live LI.FI executable quote (supports cross-chain EVM -> Solana via Relay/Mayan/deBridge/CCTP).
 */
async function tryLifiBridgeQuote(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset: 'USDC' | 'SOL';
  feeConfig: ProtocolFeeConfig;
  quoteState?: QuoteState;
  timeoutMs?: number;
  fetcher?: RouteAuctionFetcher;
  signal?: AbortSignal;
  retries?: number;
  allowanceCheckFn?: Erc20AllowanceCheckFn;
}): Promise<PreparedExecution | null> {
  const {
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    feeConfig,
    quoteState,
    timeoutMs = 7500,
    fetcher,
    signal,
    retries,
    allowanceCheckFn = checkErc20Allowance,
  } = params;
  const evmChain = asEvmChain(asset.chain);
  const cfg = EVM_CHAINS[evmChain];
  const fromToken = asset.address === 'native' ? ZERO_ADDRESS : asset.address;
  const toToken = outputAsset === 'SOL' ? SOLANA_NATIVE_MINT : SOLANA_USDC_MINT;
  const rawTotal = BigInt(asset.rawBalance);
  const { feeRaw, netRaw } = splitRawAmountForFee(rawTotal, feeConfig);
  const bridgeRaw = feeConfig.feeRecipientEvm ? netRaw : rawTotal;
  if (bridgeRaw <= 0n) return null;
  const estFeeUsd = Number(((asset.grossUsd * feeConfig.feeBps) / 10_000).toFixed(2));

  try {
    const url = new URL('https://li.quest/v1/quote');
    url.searchParams.set('fromChain', String(cfg.chainId));
    url.searchParams.set('toChain', String(LIFI_SOLANA_CHAIN_ID));
    url.searchParams.set('fromToken', fromToken);
    url.searchParams.set('toToken', toToken);
    url.searchParams.set('fromAmount', bridgeRaw.toString());
    url.searchParams.set('fromAddress', userAddress);
    url.searchParams.set('toAddress', solanaDestination);
    url.searchParams.set('integrator', 'turgalium');

    const res = await fetchQuote(
      url.toString(),
      // Keyless LI.FI is tightly rate-limited; set LIFI_API_KEY for production volume.
      process.env.LIFI_API_KEY ? { headers: { 'x-lifi-api-key': process.env.LIFI_API_KEY } } : {},
      timeoutMs,
      quoteState,
      { fetcher, signal, retries }
    );
    if (!res || !res.ok) return null;

    const json = (await res.json()) as {
      id?: string;
      toolDetails?: { name?: string };
      estimate?: {
        toAmount?: string;
        toAmountUSD?: string;
        executionDuration?: number;
        approvalAddress?: string;
      };
      action?: { toToken?: { decimals?: number; symbol?: string } };
      transactionRequest?: {
        from?: string;
        to?: string;
        data?: string;
        value?: string;
        gasLimit?: string;
        chainId?: number;
      };
    };

    const txReq = json.transactionRequest;
    if (!txReq?.to || !txReq?.data) return null;

    const txs: ExecutableEvmTx[] = [];
    let collectionMethod: FeeBreakdown['collectionMethod'] = 'none';
    if (feeConfig.feeRecipientEvm && feeRaw > 0n) {
      const feeTx = buildProtocolFeeTransferTx({ asset, userAddress, feeRaw, feeConfig });
      if (feeTx) {
        txs.push(feeTx);
        collectionMethod = 'onchain_split';
      }
    }

    const approvalAddr = json.estimate?.approvalAddress;
    if (asset.address !== 'native' && approvalAddr) {
      const allowance = await allowanceCheckFn({
        chain: evmChain,
        tokenAddress: asset.address,
        owner: userAddress,
        spender: approvalAddr,
      });
      if (allowance < bridgeRaw) {
        txs.push({
          stepId: 'approve',
          label: `Approve ${asset.symbol} for ${json.toolDetails?.name ?? 'LI.FI'}`,
          description: `ERC-20 allowance for ${approvalAddr}`,
          chain: evmChain,
          chainId: cfg.chainId,
          chainName: cfg.name,
          explorerUrl: cfg.explorerUrl,
          from: userAddress,
          to: asset.address,
          data: encodeErc20Approve(approvalAddr, bridgeRaw),
          value: '0x0',
        });
      }
    }

    txs.push({
      stepId: 'bridge',
      label: `Swap & Bridge ${asset.symbol} → Solana ${outputAsset}`,
      description: `Via LI.FI (${json.toolDetails?.name ?? 'aggregator'})`,
      chain: evmChain,
      chainId: txReq.chainId ?? cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      from: txReq.from ?? userAddress,
      to: txReq.to,
      data: txReq.data,
      value: toHexWei(txReq.value),
      gas: txReq.gasLimit ? toHexWei(txReq.gasLimit) : undefined,
    });

    const txValidation = validateQuoteTransactions({
      transactions: txs,
      asset,
      chain: evmChain,
      userAddress,
      feeRecipientEvm: feeConfig.feeRecipientEvm,
    });
    if (!txValidation.valid) {
      throw new Error(`LI.FI security validation failed: ${txValidation.reason}`);
    }

    const outDecimals = json.action?.toToken?.decimals ?? (outputAsset === 'SOL' ? 9 : 6);
    const outRaw = BigInt(json.estimate?.toAmount ?? '0');
    const outUi = Number(outRaw) / 10 ** outDecimals;
    const quotedOutUsd =
      Number(json.estimate?.toAmountUSD) ||
      (outputAsset === 'USDC' ? outUi : asset.grossUsd);
    const actualGasUsd = asset.batchedGasUsd || asset.estimatedGasUsd || 0;
    const haircut = evaluateLiveQuoteHaircut({
      grossUsd: asset.grossUsd,
      quoteOutUsd: quotedOutUsd,
      actualGasUsd,
    });

    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'lifi',
      chain: evmChain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      estimatedOutput: `${outUi.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${outputAsset}`,
      estimatedSeconds: Math.max(5, Number(json.estimate?.executionDuration ?? 30)),
      quotedOutUsd: haircut.quoteOutUsd,
      liveNetUsd: haircut.liveNetUsd,
      liveHaircutPct: haircut.liveHaircutPct,
      estimatedGasUsd: actualGasUsd,
      estimatedFeeUsd: estFeeUsd,
      feeBreakdown: {
        feeBps: feeConfig.feeBps,
        feePercent: feeConfig.feePercent,
        feeRecipientEvm: feeConfig.feeRecipientEvm,
        feeDestinationType: feeConfig.feeDestinationType,
        treasuryConfigured: feeConfig.treasuryConfigured,
        collectionMethod,
        estimatedFeeUsd: estFeeUsd,
      },
      requestId: json.id,
      transactions: txs,
      notes: [
        `Live LI.FI quote via ${json.toolDetails?.name ?? 'multi-bridge router'}.`,
        feeConfig.feeRecipientEvm
          ? `Protocol fee ${feeConfig.feePercent}% routed atomically onchain to ${feeConfig.feeRecipientEvm}.`
          : `Protocol fee ${feeConfig.feePercent}% modeled (set treasury address to collect onchain).`,
      ],
    };
  } catch (err) {
    if (err instanceof Error && /security validation failed/i.test(err.message)) {
      throw err;
    }
    return null;
  }
}

/**
 * Fallback #2 / Explicit Mode: Direct Native Circle CCTP TokenMessenger.depositForBurn for USDC.
 */
async function buildDirectCctpUsdcExecution(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  feeConfig: ProtocolFeeConfig;
  allowanceCheckFn?: Erc20AllowanceCheckFn;
}): Promise<PreparedExecution> {
  const {
    asset,
    userAddress,
    solanaDestination,
    feeConfig,
    allowanceCheckFn = checkErc20Allowance,
  } = params;
  const cfg = EVM_CHAINS[asset.chain as EvmChainId];
  if (!cfg.cctpTokenMessenger || cfg.cctpDomain === null) {
    throw new Error(`${cfg.name} does not support native Circle CCTP — use Relay or LI.FI auto-routing.`);
  }
  const messenger = cfg.cctpTokenMessenger;
  const rawTotal = BigInt(asset.rawBalance);
  const { feeRaw, netRaw } = splitRawAmountForFee(rawTotal, feeConfig);
  const bridgeRaw = feeConfig.feeRecipientEvm ? netRaw : rawTotal;
  if (bridgeRaw <= 0n) {
    throw new Error('Bridgeable USDC amount after protocol fee must be greater than zero.');
  }
  // CRIT-04: Circle CCTP Solana mintRecipient MUST be the canonical 32-byte USDC ATA PDA (not raw wallet pubkey)
  const mintRecipientBytes32 = solanaOwnerToUsdcAtaBytes32(solanaDestination);
  const txs: ExecutableEvmTx[] = [];
  const estFeeUsd = Number(((asset.grossUsd * feeConfig.feeBps) / 10_000).toFixed(2));
  let collectionMethod: FeeBreakdown['collectionMethod'] = 'none';

  if (feeConfig.feeRecipientEvm && feeRaw > 0n) {
    const feeTx = buildProtocolFeeTransferTx({ asset, userAddress, feeRaw, feeConfig });
    if (feeTx) {
      txs.push(feeTx);
      collectionMethod = 'onchain_split';
    }
  }

  const allowance = await allowanceCheckFn({
    chain: asset.chain as EvmChainId,
    tokenAddress: cfg.usdcAddress,
    owner: userAddress,
    spender: messenger,
  });

  const netUiUsdc = Number(bridgeRaw) / 1_000_000;
  if (allowance < bridgeRaw) {
    txs.push({
      stepId: 'approve_cctp',
      label: `Approve USDC for Circle CCTP`,
      description: `Grants Circle TokenMessenger (${messenger}) exact spend for ${netUiUsdc.toFixed(2)} USDC`,
      chain: asset.chain as EvmChainId,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      from: userAddress,
      to: cfg.usdcAddress,
      data: encodeErc20Approve(messenger, bridgeRaw),
      value: '0x0',
    });
  }

  const calldata = encodeCctpDepositForBurn({
    rawUsdcAmount: bridgeRaw,
    destinationDomain: SOLANA_CCTP_DOMAIN,
    solanaMintRecipientBytes32: mintRecipientBytes32,
    usdcAddress: cfg.usdcAddress,
    cctpVersion: cfg.cctpVersion ?? 1,
  });

  txs.push({
    stepId: 'cctp_deposit_for_burn',
    label: `Circle CCTP depositForBurn (${netUiUsdc.toFixed(2)} USDC → Solana)`,
    description: `Native 1:1 burn on ${cfg.name} (Domain ${cfg.cctpDomain} → Domain 5 Solana)`,
    chain: asset.chain as EvmChainId,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    from: userAddress,
    to: messenger,
    data: calldata,
    value: '0x0',
  });

  const cctpActualGasUsd = asset.batchedGasUsd || asset.estimatedGasUsd || 0;
  const cctpHaircut = evaluateLiveQuoteHaircut({
    grossUsd: asset.grossUsd,
    quoteOutUsd: netUiUsdc,
    actualGasUsd: cctpActualGasUsd,
  });

  return {
    assetId: asset.id,
    action: asset.action,
    provider: 'circle_cctp',
    chain: asset.chain as EvmChainId,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    estimatedOutput: `${netUiUsdc.toFixed(2)} USDC (1:1 Native CCTP)`,
    estimatedSeconds: cfg.cctpAttestationSec,
    quotedOutUsd: cctpHaircut.quoteOutUsd,
    liveNetUsd: cctpHaircut.liveNetUsd,
    liveHaircutPct: cctpHaircut.liveHaircutPct,
    estimatedGasUsd: cctpActualGasUsd,
    estimatedFeeUsd: estFeeUsd,
    feeBreakdown: {
      feeBps: feeConfig.feeBps,
      feePercent: feeConfig.feePercent,
      feeRecipientEvm: feeConfig.feeRecipientEvm,
      feeDestinationType: feeConfig.feeDestinationType,
      treasuryConfigured: feeConfig.treasuryConfigured,
      collectionMethod,
      estimatedFeeUsd: estFeeUsd,
    },
    transactions: txs,
    notes: [
      `Direct Circle CCTP burn-and-mint targeting Solana bytes32 ${mintRecipientBytes32}.`,
      feeConfig.feeRecipientEvm
        ? `Protocol fee ${feeConfig.feePercent}% (${(Number(feeRaw) / 1_000_000).toFixed(2)} USDC) transferred atomically to ${feeConfig.feeRecipientEvm}.`
        : `Protocol fee ${feeConfig.feePercent}% modeled (configure treasury address to split onchain).`,
    ],
  };
}

function preparedToAuctionQuote(
  prep: PreparedExecution,
  provider: AuctionBridgeProvider,
  extra?: Partial<AuctionProviderQuote>
): AuctionProviderQuote {
  return {
    provider,
    requestId: prep.requestId,
    estimatedOutput: prep.estimatedOutput,
    estimatedSeconds: prep.estimatedSeconds,
    quotedOutUsd: prep.quotedOutUsd ?? 0,
    estimatedGasUsd: prep.estimatedGasUsd ?? 0,
    estimatedFeeUsd: prep.estimatedFeeUsd,
    collectionMethod: prep.feeBreakdown?.collectionMethod,
    transactions: prep.transactions,
    notes: prep.notes,
    ...extra,
  };
}

async function buildBridgeExecution(
  asset: ScannedAsset,
  userAddress: string,
  solanaDestination: string,
  outputAsset: 'USDC' | 'SOL',
  bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp',
  feeConfig: ProtocolFeeConfig,
  options?: {
    routeAuctionOptions?: RouteAuctionExecutionOptions;
    allowanceCheckFn?: Erc20AllowanceCheckFn;
  }
): Promise<PreparedExecution> {
  const evmChain = asEvmChain(asset.chain);
  const cfg = EVM_CHAINS[evmChain];
  const isNativeUsdc =
    asset.address.toLowerCase() === cfg.usdcAddress.toLowerCase();
  const hasNativeCctp = Boolean(cfg.cctpTokenMessenger && cfg.cctpDomain !== null);
  const quoteState: QuoteState = { throttled: false };
  const allowanceCheckFn = options?.allowanceCheckFn ?? checkErc20Allowance;
  const auctionOpts = options?.routeAuctionOptions;

  if (bridgePreference === 'cctp' && isNativeUsdc && hasNativeCctp) {
    return buildDirectCctpUsdcExecution({
      asset,
      userAddress,
      solanaDestination,
      feeConfig,
      allowanceCheckFn,
    });
  }

  // Explicit single-provider overrides ('relay' or 'lifi')
  if (bridgePreference === 'relay') {
    const relay = await tryRelayBridgeQuote({
      asset,
      userAddress,
      solanaDestination,
      outputAsset,
      feeConfig,
      quoteState,
      fetcher: auctionOpts?.fetcher,
    });
    if (relay) return relay;
    if (quoteState.throttled) {
      throw new Error(
        `Relay was rate-limited or unreachable for ${asset.symbol} on ${cfg.name}. Retry shortly.`
      );
    }
    throw new Error(
      `No live Relay route found for ${asset.symbol} on ${cfg.name} (amount may be below bridge minimum or illiquid).`
    );
  }

  if (bridgePreference === 'lifi') {
    const lifi = await tryLifiBridgeQuote({
      asset,
      userAddress,
      solanaDestination,
      outputAsset,
      feeConfig,
      quoteState,
      fetcher: auctionOpts?.fetcher,
      allowanceCheckFn,
    });
    if (lifi) return lifi;
    if (quoteState.throttled) {
      throw new Error(
        `LI.FI was rate-limited or unreachable for ${asset.symbol} on ${cfg.name}. Retry shortly.`
      );
    }
    throw new Error(
      `No live LI.FI route found for ${asset.symbol} on ${cfg.name} (amount may be below bridge minimum or illiquid).`
    );
  }

  // Default 'auto' mode: True Live Parallel Route Auction across Relay, Mayan Swift, deBridge DLN, LI.FI, and Circle CCTP
  const customProviders = auctionOpts?.providers ?? {};
  const auctionTimeoutMs = auctionOpts?.timeoutMs ?? DEFAULT_AUCTION_TIMEOUT_MS;

  const auctionProviders: Partial<Record<AuctionBridgeProvider, AuctionProviderFn>> = {
    relay:
      customProviders.relay ??
      (async ({ signal, timeoutMs }) => {
        const res = await tryRelayBridgeQuote({
          asset,
          userAddress,
          solanaDestination,
          outputAsset,
          feeConfig,
          quoteState,
          timeoutMs,
          fetcher: auctionOpts?.fetcher,
          signal,
          retries: 0,
        });
        return res
          ? preparedToAuctionQuote(res, 'relay', {
              label: 'Relay',
              sponsorsSolanaAta: true,
            })
          : null;
      }),
    lifi:
      customProviders.lifi ??
      (async ({ signal, timeoutMs }) => {
        const res = await tryLifiBridgeQuote({
          asset,
          userAddress,
          solanaDestination,
          outputAsset,
          feeConfig,
          quoteState,
          timeoutMs,
          fetcher: auctionOpts?.fetcher,
          signal,
          retries: 0,
          allowanceCheckFn,
        });
        return res
          ? preparedToAuctionQuote(res, 'lifi', {
              label: 'LI.FI',
              sponsorsSolanaAta: true,
            })
          : null;
      }),
    ...(customProviders.mayan_swift ? { mayan_swift: customProviders.mayan_swift } : {}),
    ...(customProviders.debridge_dln ? { debridge_dln: customProviders.debridge_dln } : {}),
    ...(isNativeUsdc && hasNativeCctp && outputAsset === 'USDC'
      ? {
          circle_cctp:
            customProviders.circle_cctp ??
            (async () => {
              const res = await buildDirectCctpUsdcExecution({
                asset,
                userAddress,
                solanaDestination,
                feeConfig,
                allowanceCheckFn,
              });
              return preparedToAuctionQuote(res, 'circle_cctp', {
                label: 'Circle CCTP',
                extraBridgeFeeUsd: 0.01, // Solana receiveMessage tx fee
                bridgeFeeUsd: 0.01,
                sponsorsSolanaAta: false,
              });
            }),
        }
      : {}),
  };

  const { winner, routeAuction } = await runLiveParallelRouteAuction({
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    feeConfig,
    timeoutMs: auctionTimeoutMs,
    allowHighCost: auctionOpts?.allowHighCost ?? false,
    hasSolanaUsdcAta: auctionOpts?.hasSolanaUsdcAta ?? true,
    solPriceUsd: auctionOpts?.solPriceUsd,
    slippageBps: auctionOpts?.slippageBps,
    fetcher: auctionOpts?.fetcher,
    allowanceCheckFn,
    providers: auctionProviders,
  });

  const estFeeUsd = Number(((asset.grossUsd * feeConfig.feeBps) / 10_000).toFixed(2));
  const auctionNote = routeAuction.runnerUpProvider
    ? `Live Parallel Auction (${routeAuction.providersSucceeded}/${routeAuction.providersQueried.length} providers in ${routeAuction.totalAuctionDurationMs}ms): ${routeAuction.winnerProvider} won at $${routeAuction.winnerNetUsd.toFixed(2)} net, saving $${routeAuction.dollarsSavedOverRunnerUp.toFixed(2)} (+${routeAuction.bpsSavedOverRunnerUp} bps) vs ${routeAuction.runnerUpProvider}.`
    : `Live Parallel Auction (${routeAuction.providersSucceeded}/${routeAuction.providersQueried.length} providers in ${routeAuction.totalAuctionDurationMs}ms): ${routeAuction.winnerProvider} selected at $${routeAuction.winnerNetUsd.toFixed(2)} net.`;

  return {
    assetId: asset.id,
    action: asset.action,
    provider: winner.provider,
    chain: evmChain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    estimatedOutput: winner.estimatedOutput,
    estimatedSeconds: winner.estimatedSeconds,
    quotedOutUsd: winner.quotedOutUsd,
    liveNetUsd: winner.liveNetUsd,
    liveHaircutPct: winner.liveHaircutPct,
    estimatedGasUsd: winner.estimatedGasUsd,
    estimatedFeeUsd: winner.estimatedFeeUsd ?? estFeeUsd,
    feeBreakdown: {
      feeBps: feeConfig.feeBps,
      feePercent: feeConfig.feePercent,
      feeRecipientEvm: feeConfig.feeRecipientEvm,
      feeDestinationType: feeConfig.feeDestinationType,
      treasuryConfigured: feeConfig.treasuryConfigured,
      collectionMethod: winner.collectionMethod ?? (feeConfig.feeRecipientEvm ? 'onchain_split' : 'none'),
      estimatedFeeUsd: winner.estimatedFeeUsd ?? estFeeUsd,
    },
    requestId: winner.requestId,
    routeAuction,
    transactions: winner.transactions,
    notes: [auctionNote, ...winner.notes],
  };
}

export type FollowUpQuoteFn = (
  asset: ScannedAsset,
  userAddress: string,
  solanaDestination: string,
  outputAsset: 'USDC' | 'SOL',
  bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp',
  feeConfig: ProtocolFeeConfig
) => Promise<PreparedExecution>;

export type AaveSafetyCheckFn = (
  chain: EvmChainId,
  userAddress: string,
  poolAddressOverride?: string
) => Promise<AaveAccountSafety>;

export type CompoundSafetyCheckFn = (params: {
  chain: EvmChainId;
  userAddress: string;
  protocolId: 'compound_v3' | 'compound_v2';
  targetAddress: string;
}) => Promise<CompoundAccountSafety>;

export interface MultiInputSwapQuoteResult {
  provider: 'enso_multi_input';
  routerAddress: string;
  data: string;
  value: string;
  gas?: string;
  outUsdcRaw: string;
  outUsdcDecimals: number;
  estimatedGasUsd?: number;
  estimatedSeconds?: number;
}

export type MultiInputSwapQuoteFn = (params: {
  chain: EvmChainId;
  assets: ScannedAsset[];
  userAddress: string;
  usdcAddress: string;
  slippageBps?: number;
}) => Promise<MultiInputSwapQuoteResult | null>;

export type Erc20AllowanceCheckFn = (params: {
  chain: EvmChainId;
  tokenAddress: string;
  owner: string;
  spender: string;
}) => Promise<bigint>;

/**
 * Collapses N >= 2 non-USDC ERC-20 dust tokens into 1 single multi-input swap → chain USDC
 * via Enso Shortcut Bundle API (requires ENSO_API_KEY). Eliminates N-1 swap popups on
 * legacy EOAs (e.g. Rabby 0.94.x) and reduces batch gas on EIP-5792/7702 wallets.
 */
export async function tryEnsoMultiInputDustSwap(params: {
  chain: EvmChainId;
  assets: ScannedAsset[];
  userAddress: string;
  usdcAddress: string;
  slippageBps?: number;
}): Promise<MultiInputSwapQuoteResult | null> {
  const apiKey = process.env.ENSO_API_KEY?.trim();
  if (!apiKey) return null;
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg || params.assets.length < 2) return null;

  const slippageBps = Math.max(50, Math.min(500, Number(params.slippageBps ?? 150)));
  const url = new URL('https://api.enso.finance/api/v1/shortcuts/bundle');
  url.searchParams.set('chainId', String(cfg.chainId));
  url.searchParams.set('fromAddress', params.userAddress);
  url.searchParams.set('routingStrategy', 'router');

  const actions = params.assets.map((asset) => ({
    protocol: 'enso',
    action: 'route',
    args: {
      tokenIn: asset.address,
      tokenOut: params.usdcAddress,
      amountIn: asset.rawBalance,
      slippage: String(slippageBps),
    },
  }));

  try {
    const res = await fetchQuote(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(actions),
      },
      8000
    );
    if (!res || !res.ok) return null;

    const json = (await res.json()) as {
      gas?: string | number;
      amountsOut?: Record<string, string>;
      tx?: {
        to?: string;
        data?: string;
        value?: string;
      };
    };

    const routerTo = json.tx?.to?.trim();
    const txData = json.tx?.data?.trim();
    if (!routerTo || !txData) return null;

    const amountsOut = json.amountsOut ?? {};
    const outEntry = Object.entries(amountsOut).find(
      ([addr]) => addr.toLowerCase() === params.usdcAddress.toLowerCase()
    );
    const outUsdcRaw = outEntry?.[1] ?? '0';
    if (!/^\d+$/.test(outUsdcRaw) || BigInt(outUsdcRaw) <= 0n) return null;

    return {
      provider: 'enso_multi_input',
      routerAddress: routerTo,
      data: txData,
      value: toHexWei(json.tx?.value),
      gas: json.gas ? toHexWei(String(json.gas)) : undefined,
      outUsdcRaw,
      outUsdcDecimals: cfg.id === 'bnb' ? 18 : 6,
      estimatedSeconds: 12,
    };
  } catch {
    return null;
  }
}

function validateMultiInputRouterTarget(params: {
  routerAddress: string;
  txData: string;
  userAddress: string;
  usdcAddress: string;
  inputAssets: ScannedAsset[];
}): boolean {
  try {
    const cleanRouter = assertEvmAddress(params.routerAddress, 'multiInputRouter').toLowerCase();
    if (!/^0x[0-9a-fA-F]{8,}$/.test(params.txData)) return false;
    if (cleanRouter === params.userAddress.toLowerCase()) return false;
    if (cleanRouter === DEAD_BURN_ADDRESS.toLowerCase()) return false;
    if (cleanRouter === params.usdcAddress.toLowerCase()) return false;
    for (const asset of params.inputAssets) {
      if (asset.address.toLowerCase() === cleanRouter) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepares REAL executable mainnet transaction(s) for any scanned asset:
 *   - DeFi Position -> Aave v2/v3 (full or safe partial exit) / Compound v2/v3 / ERC-4626 / Uni v2/v3 LP / Direct Swap liquid receipt
 *   - Liquid Dust / USDC -> Live Relay -> LI.FI -> Circle CCTP bridge directly to Solana
 *   - Zero-Liquidity Dead Token -> Live eth_call honeypot check + ERC20.transfer(0x...dEaD)
 */
export async function prepareRealExecution(params: {
  asset: ScannedAsset;
  userAddress: string;
  solanaDestination: string;
  outputAsset?: 'USDC' | 'SOL';
  bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
  protocolFeeBps?: number;
  feeRecipientEvm?: string | null;
  followUpQuoteFn?: FollowUpQuoteFn;
  aaveSafetyCheckFn?: AaveSafetyCheckFn;
  compoundSafetyCheckFn?: CompoundSafetyCheckFn;
  allowanceCheckFn?: Erc20AllowanceCheckFn;
  routeAuctionOptions?: RouteAuctionExecutionOptions;
}): Promise<PreparedExecution> {
  const {
    asset,
    userAddress,
    solanaDestination,
    outputAsset = 'USDC',
    bridgePreference = 'auto',
    protocolFeeBps,
    feeRecipientEvm,
    followUpQuoteFn,
    aaveSafetyCheckFn,
    compoundSafetyCheckFn,
    allowanceCheckFn,
    routeAuctionOptions,
  } = params;
  const feeConfig = getProtocolFeeConfig({ feeBps: protocolFeeBps, feeRecipientEvm });

  const evmChain = asEvmChain(asset.chain);
  const cfg = EVM_CHAINS[evmChain];
  if (!cfg) throw new Error(`Unsupported chain: ${asset.chain}`);

  // Validate EVM userAddress and Solana destination up front (prevents comma-joined ABI corruption)
  assertEvmAddress(userAddress, 'userAddress');
  solanaAddressToBytes32(solanaDestination);

  if (asset.action === 'SKIP_HONEYPOT') {
    throw new Error(`${asset.symbol} is flagged as a reverting honeypot and cannot be executed.`);
  }

  if (asset.action === 'SKIP_UNPRICED') {
    throw new Error(
      `${asset.symbol} could not be priced or liquidity-verified due to an API outage and is safely skipped.`
    );
  }

  if (asset.action === 'BURN_ZERO_LIQUIDITY') {
    if (isCuratedRegistryToken(evmChain, asset.address)) {
      throw new Error(
        `Blocked burn on curated blue-chip registry token ${asset.symbol} (${asset.address}) — curated tokens can never be burned to 0x…dEaD.`
      );
    }
    const rawAmount = BigInt(asset.rawBalance);
    const check = await simulateBurnTransferOnchain({
      chain: evmChain,
      walletAddress: userAddress,
      tokenAddress: asset.address,
      rawAmount,
    });
    if (!check.safeToBurn) {
      throw new Error(`Aborted burn: ${check.reason}`);
    }
    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'erc20_burn',
      chain: evmChain,
      chainId: cfg.chainId,
      chainName: cfg.name,
      explorerUrl: cfg.explorerUrl,
      estimatedOutput: `Burn ${asset.uiBalance.toLocaleString()} ${asset.symbol} → 0x000…dEaD`,
      estimatedSeconds: 10,
      transactions: [
        {
          stepId: 'erc20_burn',
          label: `Burn ${asset.symbol} to 0x000…dEaD`,
          description: check.reason,
          chain: evmChain,
          chainId: cfg.chainId,
          chainName: cfg.name,
          explorerUrl: cfg.explorerUrl,
          from: userAddress,
          to: asset.address,
          data: encodeErc20Transfer(DEAD_BURN_ADDRESS, rawAmount),
          value: '0x0',
        },
      ],
      notes: [check.reason],
    };
  }

  if (asset.action === 'WITHDRAW_AND_BRIDGE' || asset.kind === 'defi_position') {
    return buildDefiWithdrawExecution({
      asset,
      userAddress,
      solanaDestination,
      outputAsset,
      bridgePreference,
      feeConfig,
      followUpQuoteFn,
      aaveSafetyCheckFn,
      compoundSafetyCheckFn,
      routeAuctionOptions,
      allowanceCheckFn,
    });
  }

  if (followUpQuoteFn) {
    return followUpQuoteFn(
      asset,
      userAddress,
      solanaDestination,
      outputAsset,
      bridgePreference,
      feeConfig
    );
  }

  return buildBridgeExecution(
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    bridgePreference,
    feeConfig,
    { routeAuctionOptions, allowanceCheckFn }
  );
}

function decodeApproveCalldata(data: string): { spender: string; amount: bigint } | null {
  const clean = data.toLowerCase();
  if (!clean.startsWith('0x095ea7b3') || clean.length < 138) return null;
  const spender = '0x' + clean.slice(34, 74);
  try {
    const amount = BigInt('0x' + clean.slice(74, 138));
    return { spender, amount };
  } catch {
    return null;
  }
}

/**
 * Prepares ONE unified EIP-5792 (`wallet_sendCalls`) atomic batch for an ENTIRE EVM chain:
 *   1. Orders calls: DeFi withdrawals (optionally bundled with atomic Circle CCTP USDC bridge!)
 *      -> Liquid swaps/bridges -> eth_call-verified zero-liquidity burns.
 *   2. Deduplicates any duplicate ERC-20 `approve(spender, amount)` calls targeting the same
 *      (token, spender) pair by summing their allowances into a single leading approval.
 *   3. Returns exact `calls[]` ready for 1-click-per-chain signing via `wallet_sendCalls`,
 *      plus legacy fallback metadata and Permit2 / EIP-2612 capability counts.
 */
const BRIDGE_EXECUTION_PROVIDERS = new Set<PreparedExecution['provider']>([
  'relay',
  'mayan_swift',
  'debridge_dln',
  'lifi',
  'circle_cctp',
]);

function aggregateBatchRouteAuctions(
  entries: Array<{ assetId: string; grossUsd: number; auction: RouteAuctionMetadata }>
): RouteAuctionMetadata | undefined {
  if (!entries.length) return undefined;
  if (entries.length === 1) {
    return {
      ...entries[0].auction,
      perAssetAuctions: { [entries[0].assetId]: entries[0].auction },
    };
  }

  const perAssetAuctions: Record<string, Omit<RouteAuctionMetadata, 'perAssetAuctions'>> = {};
  const volumeByWinner = new Map<AuctionBridgeProvider, number>();
  const aggCandidates = new Map<AuctionBridgeProvider, RouteAuctionCandidateSummary>();
  const queriedSet = new Set<AuctionBridgeProvider>();
  let totalWinnerNetUsd = 0;
  let totalRunnerUpNetUsd = 0;
  let totalDollarsSaved = 0;
  let totalGrossUsd = 0;
  let maxDurationMs = 0;
  let hasRunnerUp = false;

  for (const { assetId, grossUsd, auction } of entries) {
    perAssetAuctions[assetId] = auction;
    totalGrossUsd += grossUsd;
    totalWinnerNetUsd += auction.winnerNetUsd;
    totalDollarsSaved += auction.dollarsSavedOverRunnerUp;
    maxDurationMs = Math.max(maxDurationMs, auction.totalAuctionDurationMs);
    volumeByWinner.set(
      auction.winnerProvider,
      (volumeByWinner.get(auction.winnerProvider) ?? 0) + auction.winnerNetUsd
    );
    if (auction.runnerUpProvider && typeof auction.runnerUpNetUsd === 'number') {
      hasRunnerUp = true;
      totalRunnerUpNetUsd += auction.runnerUpNetUsd;
    } else {
      totalRunnerUpNetUsd += auction.winnerNetUsd;
    }

    for (const p of auction.providersQueried) queriedSet.add(p);
    for (const c of auction.candidates) {
      const existing = aggCandidates.get(c.provider);
      if (!existing) {
        aggCandidates.set(c.provider, { ...c });
      } else {
        existing.quotedOutUsd = Number((existing.quotedOutUsd + c.quotedOutUsd).toFixed(2));
        existing.gasUsd = Number((existing.gasUsd + c.gasUsd).toFixed(4));
        existing.bridgeFeeUsd = Number((existing.bridgeFeeUsd + c.bridgeFeeUsd).toFixed(4));
        existing.slippageUsd = Number((existing.slippageUsd + c.slippageUsd).toFixed(4));
        existing.ataRentUsd = Number((existing.ataRentUsd + c.ataRentUsd).toFixed(4));
        existing.liveNetUsd = Number((existing.liveNetUsd + c.liveNetUsd).toFixed(2));
        existing.netUsd = existing.liveNetUsd;
        existing.etaSeconds = Math.max(existing.etaSeconds, c.etaSeconds);
        existing.latencyMs = Math.max(existing.latencyMs, c.latencyMs);
        if (existing.status !== 'ok' && c.status === 'ok') {
          existing.status = 'ok';
          existing.reason = undefined;
        }
      }
    }
  }

  const winnerProvider =
    Array.from(volumeByWinner.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    entries[0].auction.winnerProvider;
  const candidates = Array.from(aggCandidates.values()).sort((a, b) => {
    if (a.status === 'ok' && b.status !== 'ok') return -1;
    if (a.status !== 'ok' && b.status === 'ok') return 1;
    return b.liveNetUsd - a.liveNetUsd;
  });
  const okCandidates = candidates.filter((c) => c.status === 'ok');
  const runnerUpCandidate = okCandidates.find((c) => c.provider !== winnerProvider);
  const dollarsSavedOverRunnerUp = Number(totalDollarsSaved.toFixed(2));
  const bpsSavedOverRunnerUp =
    totalGrossUsd > 0 ? Math.round((dollarsSavedOverRunnerUp / totalGrossUsd) * 10_000) : 0;

  return {
    winnerProvider,
    winnerNetUsd: Number(totalWinnerNetUsd.toFixed(2)),
    runnerUpProvider: hasRunnerUp ? runnerUpCandidate?.provider : undefined,
    runnerUpNetUsd: hasRunnerUp ? Number(totalRunnerUpNetUsd.toFixed(2)) : undefined,
    dollarsSavedOverRunnerUp,
    bpsSavedOverRunnerUp,
    totalAuctionDurationMs: maxDurationMs,
    providersQueried: Array.from(queriedSet),
    providersSucceeded: okCandidates.length,
    candidates,
    perAssetAuctions,
  };
}

export async function prepareChainBatchExecution(params: {
  chain: EvmChainId;
  assets: ScannedAsset[];
  userAddress: string;
  solanaDestination: string;
  outputAsset?: 'USDC' | 'SOL';
  bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
  bundleDefiCctp?: boolean;
  protocolFeeBps?: number;
  feeRecipientEvm?: string | null;
  allowHighCost?: boolean;
  consolidateMultiInputDust?: boolean;
  followUpQuoteFn?: FollowUpQuoteFn;
  multiInputSwapQuoteFn?: MultiInputSwapQuoteFn;
  allowanceCheckFn?: Erc20AllowanceCheckFn;
  aaveSafetyCheckFn?: AaveSafetyCheckFn;
  compoundSafetyCheckFn?: CompoundSafetyCheckFn;
  routeAuctionOptions?: RouteAuctionExecutionOptions;
  liveGasPriceWei?: bigint;
  gasSponsored?: boolean;
  nativePriceUsd?: number;
}): Promise<PreparedChainBatch> {
  const {
    chain,
    assets,
    userAddress,
    solanaDestination,
    outputAsset = 'USDC',
    bridgePreference = 'auto',
    bundleDefiCctp = true,
    protocolFeeBps,
    feeRecipientEvm,
    allowHighCost = false,
    consolidateMultiInputDust = true,
    followUpQuoteFn,
    multiInputSwapQuoteFn,
    allowanceCheckFn,
    aaveSafetyCheckFn,
    compoundSafetyCheckFn,
    routeAuctionOptions,
    liveGasPriceWei,
    gasSponsored = false,
    nativePriceUsd,
  } = params;
  const effectiveAuctionOptions: RouteAuctionExecutionOptions | undefined = routeAuctionOptions
    ? { ...routeAuctionOptions, allowHighCost: routeAuctionOptions.allowHighCost ?? allowHighCost }
    : allowHighCost
    ? { allowHighCost }
    : undefined;
  const feeConfig = getProtocolFeeConfig({ feeBps: protocolFeeBps, feeRecipientEvm });

  const cfg = EVM_CHAINS[chain];
  if (!cfg) throw new Error(`Unsupported chain: ${chain}`);

  assertEvmAddress(userAddress, 'userAddress');
  const mintRecipientBytes32 = solanaOwnerToUsdcAtaBytes32(solanaDestination);
  const chainAssets = assets.filter((a) => a.chain === chain);

  const actionOrder: Record<ScannedAsset['action'], number> = {
    WITHDRAW_AND_BRIDGE: 1,
    SELL_AND_BRIDGE: 2,
    BRIDGE_DIRECT_USDC: 3,
    BURN_ZERO_LIQUIDITY: 4,
    SKIP_GAS_NEGATIVE: 5,
    SKIP_NEGATIVE_ROI: 5,
    SKIP_UNPRICED: 6,
    SKIP_HONEYPOT: 6,
  };

  const ordered = [...chainAssets].sort((a, b) => {
    // Always sweep native gas token (ETH/POL/AVAX) AFTER ERC-20s so we never drain gas mid-batch!
    const aNativeLast = a.address === 'native' ? 1 : 0;
    const bNativeLast = b.address === 'native' ? 1 : 0;
    if (aNativeLast !== bNativeLast) return aNativeLast - bNativeLast;
    return (actionOrder[a.action] ?? 9) - (actionOrder[b.action] ?? 9);
  });

  const skippedAssets: PreparedChainBatch['skippedAssets'] = [];
  const executableAssets: ScannedAsset[] = [];

  for (const asset of ordered) {
    if (asset.action === 'SKIP_HONEYPOT') {
      skippedAssets.push({
        assetId: asset.id,
        assetSymbol: asset.symbol,
        reason: 'Reverting honeypot — safely skipped from chain batch.',
      });
      continue;
    }
    if (asset.action === 'SKIP_UNPRICED') {
      skippedAssets.push({
        assetId: asset.id,
        assetSymbol: asset.symbol,
        reason: 'Unpriced or liquidity lookup unavailable — safely skipped from chain batch.',
      });
      continue;
    }
    executableAssets.push(asset);
  }

  const rawCalls: PreparedBatchCall[] = [];
  const bridgeTrackers: PreparedChainBatch['bridgeTrackers'] = [];
  const chainedFollowUpPlans: ChainedFollowUpPlan[] = [];
  const defiExitPlans: Record<string, DefiExitPlan> = {};
  const collectedAuctions: Array<{
    assetId: string;
    grossUsd: number;
    auction: RouteAuctionMetadata;
  }> = [];
  const notes: string[] = [];
  let maxSeconds = 10;

  const quoteFollowUpBridge: FollowUpQuoteFn =
    followUpQuoteFn ??
    ((a, u, s, o, b, f) =>
      buildBridgeExecution(a, u, s, o, b, f, {
        routeAuctionOptions: effectiveAuctionOptions,
        allowanceCheckFn,
      }));
  const checkAllowance = allowanceCheckFn ?? checkErc20Allowance;

  // Multi-Input Dust Swap Consolidation:
  // When >= 2 non-USDC liquid ERC-20 dust tokens are selected on the same chain and a
  // multi-input swap router (Enso Bundle API or injected consolidator) is available,
  // collapse all N swaps into 1 single multi-input swap -> chain USDC + 1 single bridge -> Solana.
  // Eliminates N-1 swap popups on non-EIP-5792 EOAs (e.g. Rabby 0.94.x) and reduces batch gas.
  const multiInputCandidates = executableAssets.filter(
    (a) =>
      a.action === 'SELL_AND_BRIDGE' &&
      a.address !== 'native' &&
      a.kind !== 'defi_position' &&
      a.address.toLowerCase() !== cfg.usdcAddress.toLowerCase() &&
      /^\d+$/.test(a.rawBalance) &&
      BigInt(a.rawBalance) > 0n
  );
  const consolidatedAssetIdSet = new Set<string>();
  let consolidatedApprovalsSkipped = 0;
  let consolidatedUsdcOutStr: string | undefined;
  let consolidatedProvider: 'enso_multi_input' | undefined;

  if (
    consolidateMultiInputDust &&
    multiInputCandidates.length >= 2 &&
    (Boolean(multiInputSwapQuoteFn) || Boolean(process.env.ENSO_API_KEY?.trim()))
  ) {
    try {
      const multiQuote = await (multiInputSwapQuoteFn ?? tryEnsoMultiInputDustSwap)({
        chain,
        assets: multiInputCandidates,
        userAddress,
        usdcAddress: cfg.usdcAddress,
        slippageBps: 150,
      });

      if (
        multiQuote &&
        validateMultiInputRouterTarget({
          routerAddress: multiQuote.routerAddress,
          txData: multiQuote.data,
          userAddress,
          usdcAddress: cfg.usdcAddress,
          inputAssets: multiInputCandidates,
        })
      ) {
        const outUsdcRaw = BigInt(multiQuote.outUsdcRaw);
        const usdcDecimals = multiQuote.outUsdcDecimals || (cfg.id === 'bnb' ? 18 : 6);
        const quotedUsdcUi = Number(outUsdcRaw) / 10 ** usdcDecimals;
        const combinedGrossUsd = multiInputCandidates.reduce((s, a) => s + a.grossUsd, 0);
        const combinedGasUsd =
          multiQuote.estimatedGasUsd ??
          multiInputCandidates.reduce((s, a) => s + (a.batchedGasUsd || a.estimatedGasUsd || 0), 0);

        const multiGate = evaluateLiveQuoteHaircut({
          grossUsd: combinedGrossUsd,
          quoteOutUsd: quotedUsdcUi,
          actualGasUsd: combinedGasUsd,
          allowHighCost,
        });

        if (outUsdcRaw > 0n && multiGate.passed) {
          const syntheticConsolidatedUsdc: ScannedAsset = {
            ...multiInputCandidates[0],
            id: `${chain}:consolidated_dust_usdc`,
            address: cfg.usdcAddress,
            symbol: 'USDC',
            name: `Consolidated USDC (${multiInputCandidates.length} dust tokens)`,
            decimals: usdcDecimals,
            kind: 'erc20',
            protocol: undefined,
            protocolAddress: undefined,
            rawBalance: outUsdcRaw.toString(),
            uiBalance: quotedUsdcUi,
            priceUsd: 1,
            grossUsd: quotedUsdcUi,
            action: 'BRIDGE_DIRECT_USDC',
          };

          const bridgePrep = await quoteFollowUpBridge(
            syntheticConsolidatedUsdc,
            userAddress,
            solanaDestination,
            outputAsset,
            bridgePreference,
            feeConfig
          );

          const bridgeGate =
            typeof bridgePrep.quotedOutUsd === 'number'
              ? evaluateLiveQuoteHaircut({
                  grossUsd: combinedGrossUsd,
                  quoteOutUsd: bridgePrep.quotedOutUsd,
                  actualGasUsd: bridgePrep.estimatedGasUsd ?? combinedGasUsd,
                  allowHighCost,
                })
              : { passed: true, reason: '' };

          if (bridgePrep.transactions.length > 0 && bridgeGate.passed) {
            const allowances = await Promise.all(
              multiInputCandidates.map((asset) =>
                checkAllowance({
                  chain,
                  tokenAddress: asset.address,
                  owner: userAddress,
                  spender: multiQuote.routerAddress,
                }).catch(() => 0n)
              )
            );

            for (let i = 0; i < multiInputCandidates.length; i++) {
              const asset = multiInputCandidates[i];
              const needRaw = BigInt(asset.rawBalance);
              if (allowances[i] >= needRaw) {
                consolidatedApprovalsSkipped += 1;
                continue;
              }
              rawCalls.push({
                stepId: `approve_multi_input_${i}`,
                assetId: asset.id,
                assetSymbol: asset.symbol,
                action: asset.action,
                provider: multiQuote.provider,
                label: `Approve ${asset.symbol} for Consolidated Dust Swap`,
                description: `ERC-20 allowance for Enso multi-input router (${multiQuote.routerAddress})`,
                to: asset.address,
                data: encodeErc20Approve(multiQuote.routerAddress, needRaw),
                value: '0x0',
              });
            }

            const symbolSummary = multiInputCandidates.map((a) => a.symbol).join(' + ');
            rawCalls.push({
              stepId: 'multi_input_dust_swap',
              assetId: syntheticConsolidatedUsdc.id,
              assetSymbol: `${multiInputCandidates.length} tokens`,
              action: 'SELL_AND_BRIDGE',
              provider: multiQuote.provider,
              label: `Consolidated Swap (${multiInputCandidates.length} dust tokens → ${quotedUsdcUi.toFixed(2)} USDC)`,
              description: `Single multi-input swap consolidating ${symbolSummary} into USDC before 1 Solana bridge`,
              to: multiQuote.routerAddress,
              data: multiQuote.data,
              value: multiQuote.value || '0x0',
              gas: multiQuote.gas,
            });

            for (const btx of bridgePrep.transactions) {
              rawCalls.push({
                stepId: btx.stepId.includes('consolidated') ? btx.stepId : `${btx.stepId}_consolidated_dust`,
                assetId: syntheticConsolidatedUsdc.id,
                assetSymbol: 'USDC',
                action: 'BRIDGE_DIRECT_USDC',
                provider: bridgePrep.provider,
                label: btx.label,
                description: `${btx.description} (single bridge for ${multiInputCandidates.length} consolidated dust tokens)`,
                to: btx.to,
                data: btx.data,
                value: btx.value || '0x0',
                gas: btx.gas,
              });
            }

            bridgeTrackers.push({
              assetId: syntheticConsolidatedUsdc.id,
              assetSymbol: `${multiInputCandidates.length} dust → ${outputAsset}`,
              provider: bridgePrep.provider,
              requestId: bridgePrep.requestId,
              estimatedOutput: bridgePrep.estimatedOutput,
              estimatedSeconds: bridgePrep.estimatedSeconds,
              requiresSolanaClaim: bridgePrep.provider === 'circle_cctp',
            });
            if (bridgePrep.routeAuction) {
              collectedAuctions.push({
                assetId: syntheticConsolidatedUsdc.id,
                grossUsd: combinedGrossUsd,
                auction: bridgePrep.routeAuction,
              });
            }

            maxSeconds = Math.max(
              maxSeconds,
              multiQuote.estimatedSeconds ?? 12,
              bridgePrep.estimatedSeconds
            );
            for (const a of multiInputCandidates) consolidatedAssetIdSet.add(a.id);
            consolidatedUsdcOutStr = `${quotedUsdcUi.toFixed(2)} USDC`;
            consolidatedProvider = multiQuote.provider;
            const swapsEliminated = Math.max(0, multiInputCandidates.length - 1);
            notes.push(
              `Consolidated ${multiInputCandidates.length} dust ERC-20s (${symbolSummary}) into 1 multi-input swap → ${quotedUsdcUi.toFixed(2)} USDC + 1 Solana bridge (${swapsEliminated} swap tx(s) & ${consolidatedApprovalsSkipped} existing approval(s) eliminated).`
            );
          }
        } else if (!multiGate.passed) {
          notes.push(`Multi-input consolidation skipped (${multiGate.reason}); falling back to individual routes.`);
        }
      }
    } catch {
      // Fail-open fallback to standard per-asset Relay/LI.FI routing
    }
  }

  const remainingExecutableAssets = executableAssets.filter(
    (a) => !consolidatedAssetIdSet.has(a.id)
  );

  const results = await settleWithConcurrency(remainingExecutableAssets, QUOTE_CONCURRENCY, (asset) =>
    prepareRealExecution({
      asset,
      userAddress,
      solanaDestination,
      outputAsset,
      bridgePreference,
      protocolFeeBps: feeConfig.feeBps,
      feeRecipientEvm: feeConfig.feeRecipientEvm,
      followUpQuoteFn,
      aaveSafetyCheckFn,
      compoundSafetyCheckFn,
      allowanceCheckFn,
      routeAuctionOptions: effectiveAuctionOptions,
    })
  );

  const DEFI_UNWIND_PROVIDERS = new Set<PreparedExecution['provider']>([
    'aave_v3',
    'aave_v2',
    'compound_v3',
    'compound_v2',
    'erc4626',
    'yearn_v2',
    'uniswap_v2_lp',
    'uniswap_v3_nft',
  ]);

  for (let idx = 0; idx < results.length; idx++) {
    const res = results[idx];
    const asset = remainingExecutableAssets[idx];
    if (res.status === 'rejected') {
      skippedAssets.push({
        assetId: asset.id,
        assetSymbol: asset.symbol,
        reason: res.reason instanceof Error ? res.reason.message : 'Route unavailable',
      });
      continue;
    }

    const prep = res.value;
    if (prep.defiExitPlan) {
      defiExitPlans[asset.id] = prep.defiExitPlan;
    }

    // Live Quote Haircut Gate: drop any bridged/swapped quote that turns net-negative or >50% haircut
    if (
      asset.action !== 'BURN_ZERO_LIQUIDITY' &&
      BRIDGE_EXECUTION_PROVIDERS.has(prep.provider) &&
      typeof prep.quotedOutUsd === 'number'
    ) {
      const gate = evaluateLiveQuoteHaircut({
        grossUsd: asset.grossUsd,
        quoteOutUsd: prep.quotedOutUsd,
        actualGasUsd: prep.estimatedGasUsd ?? asset.batchedGasUsd ?? 0,
        allowHighCost,
      });
      if (!gate.passed) {
        skippedAssets.push({
          assetId: asset.id,
          assetSymbol: asset.symbol,
          reason: gate.reason,
        });
        notes.push(`${asset.symbol}: ${gate.reason}`);
        continue;
      }
    }

    if (prep.routeAuction) {
      collectedAuctions.push({
        assetId: asset.id,
        grossUsd: asset.grossUsd,
        auction: prep.routeAuction,
      });
    }

    maxSeconds = Math.max(maxSeconds, prep.estimatedSeconds);

    for (const tx of prep.transactions) {
      rawCalls.push({
        stepId: tx.stepId,
        assetId: asset.id,
        assetSymbol: asset.symbol,
        action: asset.action,
        provider: prep.provider,
        label: tx.label,
        description: tx.description,
        to: tx.to,
        data: tx.data,
        value: tx.value || '0x0',
        gas: tx.gas,
      });
    }

    // 1-Click Withdraw -> Swap -> Bridge Chaining for ALL DeFi protocols
    // (Aave v2/v3 USDC & non-USDC, Compound v2/v3, ERC-4626 using previewRedeem, Uni v2/v3 LP)
    if (DEFI_UNWIND_PROVIDERS.has(prep.provider)) {
      const unlockedList = prep.chainedFollowUpPlan?.unlockedAssets ?? [];
      let bundledAny = false;
      let lastBundledProvider: ChainedFollowUpPlan['bridgeProvider'] = 'pending_after_unwind';

      if (bundleDefiCctp && unlockedList.length > 0) {
        for (const unlocked of unlockedList) {
          let unlockedRaw = 0n;
          try {
            unlockedRaw = BigInt(unlocked.expectedRawAmount);
          } catch {
            unlockedRaw = 0n;
          }
          if (unlockedRaw <= 0n || !unlocked.address) continue;

          const isNativeUsdc = unlocked.address.toLowerCase() === cfg.usdcAddress.toLowerCase();
          const expectedUsdcDecimals = cfg.id === 'bnb' ? 18 : 6;
          // CRIT-02: Never size bundled CCTP transfers (which spend user's real USDC in the same atomic batch)
          // from an unverified/uncurated ERC-4626 or receipt balance!
          const erc4626CctpAllowed =
            prep.provider !== 'erc4626' ||
            (Boolean(prep.defiExitPlan?.expectedUnderlyingRaw) &&
              prep.defiExitPlan?.preflightStatus === 'verified' &&
              prep.defiExitPlan?.supportsAtomicBatch !== false &&
              unlocked.decimals === expectedUsdcDecimals &&
              (isCuratedDefiVault(chain, asset.address) || Boolean(prep.defiExitPlan?.simulatedLive)));
          const receiptOutputVerified =
            (prep.provider !== 'yearn_v2' && prep.provider !== 'compound_v2') ||
            (Boolean(prep.defiExitPlan?.expectedUnderlyingRaw) &&
              prep.defiExitPlan?.preflightStatus !== 'blocked');

          if (isNativeUsdc && (!erc4626CctpAllowed || !receiptOutputVerified)) {
            notes.push(
              `Skipped atomic CCTP bundling for ${asset.symbol}: unverified or non-curated vault receipt output must confirm onchain before sizing a USDC bridge.`
            );
            continue;
          }

          const canCctpBundle =
            isNativeUsdc &&
            erc4626CctpAllowed &&
            receiptOutputVerified &&
            outputAsset === 'USDC' &&
            Boolean(cfg.cctpTokenMessenger && cfg.cctpDomain !== null) &&
            (bridgePreference === 'cctp' ||
              (bridgePreference === 'auto' &&
                (prep.provider === 'aave_v3' ||
                  prep.provider === 'aave_v2' ||
                  prep.provider === 'compound_v3' ||
                  prep.provider === 'compound_v2' ||
                  prep.provider === 'erc4626' ||
                  prep.provider === 'yearn_v2')));

          if (canCctpBundle && cfg.cctpTokenMessenger) {
            const { feeRaw, netRaw } = splitRawAmountForFee(unlockedRaw, feeConfig);
            const bridgeRaw = feeConfig.feeRecipientEvm ? netRaw : unlockedRaw;
            if (bridgeRaw <= 0n) continue;
            const netUi = Number(bridgeRaw) / 10 ** unlocked.decimals;

            if (feeConfig.feeRecipientEvm && feeRaw > 0n) {
              rawCalls.push({
                stepId: 'protocol_fee_transfer_after_defi',
                assetId: asset.id,
                assetSymbol: asset.symbol,
                action: asset.action,
                provider: 'circle_cctp',
                label: `Protocol Fee (${feeConfig.feePercent}% USDC → ${feeConfig.feeDestinationType === 'wallet' ? 'Treasury Wallet' : 'TurgaliumFeeVault'})`,
                description: `Routes ${(Number(feeRaw) / 10 ** unlocked.decimals).toFixed(2)} USDC (${feeConfig.feeBps} bps) to ${feeConfig.feeRecipientEvm}`,
                to: cfg.usdcAddress,
                data: encodeErc20Transfer(feeConfig.feeRecipientEvm, feeRaw),
                value: '0x0',
              });
            }
            rawCalls.push({
              stepId: 'approve_cctp_after_defi',
              assetId: asset.id,
              assetSymbol: asset.symbol,
              action: asset.action,
              provider: 'circle_cctp',
              label: `Approve withdrawn ${netUi.toFixed(2)} USDC for Circle CCTP`,
              description: `Batched immediately after ${asset.protocol} withdrawal in the same atomic call bundle`,
              to: cfg.usdcAddress,
              data: encodeErc20Approve(cfg.cctpTokenMessenger, bridgeRaw),
              value: '0x0',
            });
            rawCalls.push({
              stepId: 'cctp_deposit_for_burn_after_defi',
              assetId: asset.id,
              assetSymbol: asset.symbol,
              action: asset.action,
              provider: 'circle_cctp',
              label: `Bridge withdrawn ${netUi.toFixed(2)} USDC → Solana (Circle CCTP)`,
              description: `Native 1:1 Circle CCTP burn (Domain ${cfg.cctpDomain} → Domain 5 Solana) in the same click`,
              to: cfg.cctpTokenMessenger,
              data: encodeCctpDepositForBurn({
                rawUsdcAmount: bridgeRaw,
                destinationDomain: SOLANA_CCTP_DOMAIN,
                solanaMintRecipientBytes32: mintRecipientBytes32,
                usdcAddress: cfg.usdcAddress,
                cctpVersion: cfg.cctpVersion ?? 1,
              }),
              value: '0x0',
            });
            maxSeconds = Math.max(maxSeconds, cfg.cctpAttestationSec);
            bridgeTrackers.push({
              assetId: asset.id,
              assetSymbol: asset.symbol,
              provider: 'circle_cctp',
              estimatedOutput: `${netUi.toFixed(2)} USDC (Atomic DeFi Exit + CCTP)`,
              estimatedSeconds: cfg.cctpAttestationSec,
              requiresSolanaClaim: true,
            });
            notes.push(
              `Bundled ${asset.protocol} ${asset.symbol} withdrawal + ${feeConfig.feePercent}% protocol fee + Circle CCTP bridge atomically in 1 click (poll /api/cctp/attestation for Solana receiveMessage claim).`
            );
            bundledAny = true;
            lastBundledProvider = 'circle_cctp';
            continue;
          }

          // Non-USDC underlying (aWETH, cWETHv3, ERC-4626 DAI/USDS/WETH, LP token0/token1, or SOL output):
          // Chain live Relay / LI.FI swap+bridge call(s) in the SAME EIP-5792 atomic batch!
          const syntheticUnderlyingAsset: ScannedAsset = {
            ...asset,
            id: `${asset.id}:unlocked:${unlocked.symbol.toLowerCase()}`,
            address: unlocked.address,
            symbol: unlocked.symbol,
            name: `${unlocked.symbol} (unlocked from ${asset.symbol})`,
            decimals: unlocked.decimals,
            kind: 'erc20',
            protocol: undefined,
            protocolAddress: undefined,
            rawBalance: unlockedRaw.toString(),
            uiBalance: unlocked.expectedUiAmount,
            grossUsd: unlocked.estimatedUsd,
            action: isNativeUsdc ? 'BRIDGE_DIRECT_USDC' : 'SELL_AND_BRIDGE',
          };

          try {
            const followUpPrep = await quoteFollowUpBridge(
              syntheticUnderlyingAsset,
              userAddress,
              solanaDestination,
              outputAsset,
              bridgePreference,
              feeConfig
            );

            const gateResult =
              typeof followUpPrep.quotedOutUsd === 'number'
                ? evaluateLiveQuoteHaircut({
                    grossUsd: unlocked.estimatedUsd,
                    quoteOutUsd: followUpPrep.quotedOutUsd,
                    actualGasUsd: followUpPrep.estimatedGasUsd ?? asset.batchedGasUsd ?? 0,
                    allowHighCost,
                  })
                : { passed: true, reason: '' };

            if (!gateResult.passed) {
              notes.push(`${unlocked.symbol} (post-${asset.symbol} unwind): ${gateResult.reason}`);
              continue;
            }

            if (followUpPrep.transactions.length > 0) {
              for (const ftx of followUpPrep.transactions) {
                const taggedStepId = ftx.stepId.includes('after_defi')
                  ? ftx.stepId
                  : `${ftx.stepId}_after_defi`;
                rawCalls.push({
                  stepId: taggedStepId,
                  assetId: asset.id,
                  assetSymbol: unlocked.symbol,
                  action: asset.action,
                  provider: followUpPrep.provider,
                  label: ftx.label,
                  description: `${ftx.description} (chained immediately after ${asset.symbol} unwind)`,
                  to: ftx.to,
                  data: ftx.data,
                  value: ftx.value || '0x0',
                  gas: ftx.gas,
                });
              }
              maxSeconds = Math.max(maxSeconds, followUpPrep.estimatedSeconds);
              bridgeTrackers.push({
                assetId: asset.id,
                assetSymbol: `${asset.symbol}→${unlocked.symbol}`,
                provider: followUpPrep.provider,
                requestId: followUpPrep.requestId,
                estimatedOutput: followUpPrep.estimatedOutput,
                estimatedSeconds: followUpPrep.estimatedSeconds,
                requiresSolanaClaim: followUpPrep.provider === 'circle_cctp',
              });
              if (followUpPrep.routeAuction) {
                collectedAuctions.push({
                  assetId: syntheticUnderlyingAsset.id,
                  grossUsd: unlocked.estimatedUsd,
                  auction: followUpPrep.routeAuction,
                });
              }
              notes.push(
                `Chained ${asset.protocol || prep.provider} ${asset.symbol} unwind → ${unlocked.expectedUiAmount} ${unlocked.symbol} swap & bridge via ${followUpPrep.provider} in 1 EIP-5792 batch.`
              );
              bundledAny = true;
              if (
                followUpPrep.provider === 'relay' ||
                followUpPrep.provider === 'lifi' ||
                followUpPrep.provider === 'circle_cctp'
              ) {
                lastBundledProvider = followUpPrep.provider;
              }
            }
          } catch {
            // Non-fatal: keep the DeFi unwind call in the batch and emit clean chainedFollowUpPlan
            // so legacy wallets / UI can auto-advance to bridging without manual re-scanning!
          }
        }
      }

      if (prep.chainedFollowUpPlan) {
        chainedFollowUpPlans.push({
          ...prep.chainedFollowUpPlan,
          bundledInCurrentBatch: bundledAny,
          bridgeProvider: bundledAny ? lastBundledProvider : 'pending_after_unwind',
          autoAdvanceAction: bundledAny
            ? 'complete_in_single_batch'
            : 'auto_quote_and_bridge_unlocked',
          plainEnglishSummary: bundledAny
            ? `Atomic 1-click batch ready: unwind ${asset.symbol} and immediately bridge ${prep.chainedFollowUpPlan.unlockedAssets.map((u) => `${u.expectedUiAmount} ${u.symbol}`).join(' + ')} to Solana ${outputAsset}.`
            : prep.chainedFollowUpPlan.plainEnglishSummary,
        });
      }
    } else if (BRIDGE_EXECUTION_PROVIDERS.has(prep.provider)) {
      bridgeTrackers.push({
        assetId: asset.id,
        assetSymbol: asset.symbol,
        provider: prep.provider,
        requestId: prep.requestId,
        estimatedOutput: prep.estimatedOutput,
        estimatedSeconds: prep.estimatedSeconds,
        requiresSolanaClaim: prep.provider === 'circle_cctp',
      });
    }
  }

  // Deduplicate identical ERC-20 approve(spender, amount) calls by summing required amounts
  const mergedApprovals = new Map<
    string,
    { firstIdx: number; call: PreparedBatchCall; amount: bigint; spender: string; count: number }
  >();
  const skipIndices = new Set<number>();
  let dedupedApprovals = 0;

  rawCalls.forEach((call, idx) => {
    const decoded = decodeApproveCalldata(call.data);
    if (!decoded) return;
    const key = `${call.to.toLowerCase()}:${decoded.spender.toLowerCase()}`;
    const existing = mergedApprovals.get(key);
    if (!existing) {
      mergedApprovals.set(key, {
        firstIdx: idx,
        call,
        amount: decoded.amount,
        spender: decoded.spender,
        count: 1,
      });
    } else {
      const summed = existing.amount + decoded.amount;
      existing.amount = summed > MAX_UINT256 ? MAX_UINT256 : summed;
      existing.count += 1;
      skipIndices.add(idx);
      dedupedApprovals += 1;
    }
  });

  const finalCalls: PreparedBatchCall[] = [];
  rawCalls.forEach((call, idx) => {
    if (skipIndices.has(idx)) return;
    const decoded = decodeApproveCalldata(call.data);
    if (decoded) {
      const key = `${call.to.toLowerCase()}:${decoded.spender.toLowerCase()}`;
      const merged = mergedApprovals.get(key);
      if (merged && merged.firstIdx === idx && merged.count > 1) {
        finalCalls.push({
          ...call,
          label: `Combined Approve (${merged.count} batched ops)`,
          description: `Deduplicated ${merged.count} ERC-20 approvals to ${merged.spender} into 1 call`,
          data: encodeErc20Approve(merged.spender, merged.amount),
        });
        return;
      }
    }
    finalCalls.push(call);
  });

  const permit2ReadyCount = executableAssets.filter((a) => Boolean(a.permit2Approved)).length;
  const eip2612Count = executableAssets.filter(
    (a) =>
      a.eip2612Supported ?? (a.kind !== 'dead_token' && isEip2612Token(asEvmChain(a.chain), a.address, a.symbol))
  ).length;
  const instantGaslessEligibleIds = executableAssets
    .filter(
      (a) =>
        a.address !== 'native' &&
        a.kind !== 'defi_position' &&
        a.kind !== 'dead_token' &&
        (Boolean(a.permit2Approved) ||
          Boolean(a.eip2612Supported ?? isEip2612Token(asEvmChain(a.chain), a.address, a.symbol)))
    )
    .map((a) => a.id);
  const legacyRequiresApprovalCount = executableAssets.filter(
    (a) =>
      a.address !== 'native' &&
      a.kind !== 'defi_position' &&
      a.kind !== 'dead_token' &&
      !instantGaslessEligibleIds.includes(a.id)
  ).length;

  const totalCalls = finalCalls.length;
  const walletPopupsEip5792 = totalCalls > 0 ? 1 : 0;
  const walletPopupsLegacy = totalCalls;
  const popupsSaved = Math.max(0, walletPopupsLegacy - walletPopupsEip5792);

  if (dedupedApprovals > 0) {
    notes.push(`Deduplicated ${dedupedApprovals} redundant ERC-20 approval(s) inside this chain batch.`);
  }
  if (totalCalls > 1) {
    notes.push(
      `EIP-5792 wallet_sendCalls bundles all ${totalCalls} calls on ${cfg.name} into 1 single wallet confirmation (${popupsSaved} popups eliminated).`
    );
  }

  const batchGrossUsd = executableAssets
    .filter((a) => a.action !== 'BURN_ZERO_LIQUIDITY')
    .reduce((sum, a) => sum + a.grossUsd, 0);
  const estimatedBatchFeeUsd = Number(((batchGrossUsd * feeConfig.feeBps) / 10_000).toFixed(2));
  const hasOnchainFeeCall = finalCalls.some((c) => c.stepId.startsWith('protocol_fee_transfer'));
  const hasRelayAppFee = results.some(
    (r) => r.status === 'fulfilled' && r.value.feeBreakdown?.collectionMethod === 'relay_app_fee'
  );
  const batchCollectionMethod: FeeBreakdown['collectionMethod'] = hasOnchainFeeCall
    ? 'onchain_split'
    : hasRelayAppFee
    ? 'relay_app_fee'
    : 'none';

  const consolidatedIds = Array.from(consolidatedAssetIdSet);
  const routeAuction = aggregateBatchRouteAuctions(collectedAuctions);

  if (routeAuction && routeAuction.dollarsSavedOverRunnerUp > 0 && routeAuction.runnerUpProvider) {
    notes.push(
      `Live Route Auction: ${routeAuction.winnerProvider} won at $${routeAuction.winnerNetUsd.toFixed(2)} net (saved $${routeAuction.dollarsSavedOverRunnerUp.toFixed(2)} / +${routeAuction.bpsSavedOverRunnerUp} bps vs ${routeAuction.runnerUpProvider}).`
    );
  }

  let dynamicGasReserve: PreparedChainBatch['dynamicGasReserve'];
  if (liveGasPriceWei !== undefined) {
    const reserveSummary = computeDynamicGasReserveSummary({
      chain,
      liveGasPriceWei,
      plannedTxCount: Math.max(1, totalCalls),
      nativePriceUsd,
      options: { gasSponsored },
    });
    dynamicGasReserve = {
      reserveWei: reserveSummary.reserveWei.toString(),
      reserveNative: reserveSummary.reserveNative,
      staticReserveNative: reserveSummary.staticReserveNative,
      recoveredNative: reserveSummary.recoveredNative,
      recoveredUsd: reserveSummary.recoveredUsd,
      effectiveSafetyRatio: reserveSummary.effectiveSafetyRatio,
    };
    if (reserveSummary.recoveredNative > 0) {
      notes.push(
        `Dynamic gas reserve (${reserveSummary.reserveNative} ${cfg.nativeSymbol} vs ${reserveSummary.staticReserveNative} static) recovers ${reserveSummary.recoveredNative} ${cfg.nativeSymbol}${reserveSummary.recoveredUsd > 0 ? ` (~$${reserveSummary.recoveredUsd.toFixed(2)})` : ''} while preserving ${reserveSummary.effectiveSafetyRatio.toFixed(2)}x safety margin.`
      );
    }
  }

  return {
    chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    userAddress,
    solanaDestination,
    outputAsset,
    calls: finalCalls,
    bridgeTrackers,
    skippedAssets,
    savings: {
      totalCalls,
      walletPopupsEip5792,
      walletPopupsLegacy,
      popupsSaved,
      dedupedApprovals,
      permit2ReadyCount,
      eip2612Count,
    },
    feeBreakdown: {
      feeBps: feeConfig.feeBps,
      feePercent: feeConfig.feePercent,
      feeRecipientEvm: feeConfig.feeRecipientEvm,
      feeDestinationType: feeConfig.feeDestinationType,
      treasuryConfigured: feeConfig.treasuryConfigured,
      collectionMethod: batchCollectionMethod,
      estimatedFeeUsd: estimatedBatchFeeUsd,
    },
    estimatedSeconds: maxSeconds,
    routeAuction,
    dynamicGasReserve,
    defiExitPlans: Object.keys(defiExitPlans).length ? defiExitPlans : undefined,
    chainedFollowUpPlans: chainedFollowUpPlans.length ? chainedFollowUpPlans : undefined,
    dustConsolidation: {
      consolidated: consolidatedIds.length >= 2,
      provider: consolidatedProvider,
      consolidatedTokenCount: consolidatedIds.length,
      consolidatedAssetIds: consolidatedIds,
      estimatedUsdcOut: consolidatedUsdcOutStr,
      approvalsSkipped: consolidatedApprovalsSkipped,
      swapPopupsEliminated:
        consolidatedIds.length >= 2 ? consolidatedIds.length - 1 + consolidatedApprovalsSkipped : 0,
      instantGaslessEligibleIds,
      instantGaslessCount: instantGaslessEligibleIds.length,
      legacyRequiresApprovalCount,
    },
    notes,
  };
}

/**
 * Checks real onchain EVM tx receipt + live Relay cross-chain settlement status (including Solana tx hash!).
 */
export async function checkLiveExecutionStatus(params: {
  chain: string;
  txHash?: string;
  requestId?: string;
  provider?: string;
}): Promise<{
  evmConfirmed: boolean;
  evmFailed: boolean;
  blockNumber?: number;
  bridgeStatus: string;
  solanaTxHash?: string;
  details?: string;
  relayOriginTxHashes?: string[];
  relayDestinationRecipient?: string;
  relayBoundToTx?: boolean;
}> {
  const cfg = params.chain in EVM_CHAINS ? EVM_CHAINS[params.chain as EvmChainId] : undefined;
  let evmConfirmed = false;
  let evmFailed = false;
  let blockNumber: number | undefined;

  if (cfg && params.txHash) {
    try {
      const json = await evmJsonRpcCall<{ status?: string; blockNumber?: string } | null>(
        cfg.rpcUrls,
        'eth_getTransactionReceipt',
        [params.txHash],
        4000
      );
      if (json.result) {
        evmConfirmed = json.result.status === '0x1';
        evmFailed = json.result.status === '0x0';
        if (json.result.blockNumber) blockNumber = Number(BigInt(json.result.blockNumber));
      }
    } catch {
      // Keep polling
    }
  }

  let bridgeStatus = evmConfirmed ? 'confirmed' : evmFailed ? 'failed' : 'pending';
  let solanaTxHash: string | undefined;
  let details: string | undefined;
  let relayOriginTxHashes: string[] | undefined;
  let relayDestinationRecipient: string | undefined;
  let relayBoundToTx = false;

  if (params.provider === 'relay' && params.requestId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(
        `https://api.relay.link/intents/status/v2?requestId=${encodeURIComponent(params.requestId)}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      if (res.ok) {
        const st = (await res.json()) as {
          status?: string;
          inTxHashes?: string[];
          txHashes?: string[];
          details?: string;
          recipient?: string;
          destinationAddress?: string;
        };
        if (st.status) bridgeStatus = st.status;
        if (st.txHashes && st.txHashes.length > 0) solanaTxHash = st.txHashes[0];
        if (st.inTxHashes && st.inTxHashes.length > 0) {
          relayOriginTxHashes = st.inTxHashes.map((h) => h.toLowerCase());
          if (params.txHash) {
            relayBoundToTx = relayOriginTxHashes.includes(params.txHash.toLowerCase());
          }
        }
        relayDestinationRecipient = st.recipient ?? st.destinationAddress;
        if (st.details) details = st.details;
      }
    } catch {
      clearTimeout(timer);
      // Keep polling
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    evmConfirmed,
    evmFailed,
    blockNumber,
    bridgeStatus,
    solanaTxHash,
    details,
    relayOriginTxHashes,
    relayDestinationRecipient,
    relayBoundToTx,
  };
}
