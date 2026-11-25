import { encodeCctpDepositForBurn, solanaAddressToBytes32 } from '../bridge/cctp.js';
import {
  AAVE_V2_LENDING_POOLS,
  computeAaveSafePartialWithdrawal,
  identifyProtocolExtractorId,
  isKnownCooldownVault,
  isLiquidReceiptToken,
  MIN_SAFE_HEALTH_FACTOR,
  PROTOCOL_EXTRACTOR_REGISTRY,
  resolveDefiExitPlan,
} from '../defi/extractors.js';
import {
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  getProtocolFeeConfig,
  type ProtocolFeeConfig,
  SOLANA_CCTP_DOMAIN,
} from '../scanner/chains.js';
import {
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

const RELAY_SOLANA_CHAIN_ID = 792703809;
const LIFI_SOLANA_CHAIN_ID = 1151111081099710;
const SOLANA_NATIVE_MINT = '11111111111111111111111111111111';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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
  state?: QuoteState
): Promise<Response | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.status !== 429 && res.status < 500) return res;
      if (state) state.throttled = true;
    } catch {
      // timeout or network error: retry once
      if (state) state.throttled = true;
    } finally {
      clearTimeout(timer);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 900));
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
    | 'lifi'
    | 'circle_cctp'
    | 'aave_v3'
    | 'aave_v2'
    | 'compound_v3'
    | 'compound_v2'
    | 'erc4626'
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
  defiExitPlans?: Record<string, DefiExitPlan>;
  chainedFollowUpPlans?: ChainedFollowUpPlan[];
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
  const destLabel = feeConfig.feeDestinationType === 'wallet' ? 'Treasury Wallet' : 'SiphonFeeVault';

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
  return val.replace(/^0x/, '').toLowerCase().padStart(64, '0');
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
}): Promise<PreparedExecution> {
  const { asset, userAddress, solanaDestination, outputAsset, bridgePreference, feeConfig, followUpQuoteFn } = params;
  const evmChain = asEvmChain(asset.chain);
  const cfg = EVM_CHAINS[evmChain];
  const protocolId = identifyProtocolExtractorId(asset);
  const quoteDirectBridge = followUpQuoteFn ?? buildBridgeExecution;

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

  // 2. Aave v3 & Aave v2 live debt guard + Safe Partial Exit calculator (HF >= 1.6)
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
      const safety = await checkAaveV3AccountSafety(evmChain, userAddress, poolTarget);
      if (safety.checked && safety.hasActiveDebt) {
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
}): Promise<PreparedExecution | null> {
  const { asset, userAddress, solanaDestination, outputAsset, feeConfig, quoteState } = params;
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
        7000,
        quoteState
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
            : `Protocol fee ${feeConfig.feePercent}% modeled (set SIPHON_FEE_RECIPIENT_EVM or enter a treasury address to route onchain).`,
        ],
      };
    } catch {
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
}): Promise<PreparedExecution | null> {
  const { asset, userAddress, solanaDestination, outputAsset, feeConfig, quoteState } = params;
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
    url.searchParams.set('integrator', 'siphon');

    const res = await fetchQuote(
      url.toString(),
      // Keyless LI.FI is tightly rate-limited; set LIFI_API_KEY for production volume.
      process.env.LIFI_API_KEY ? { headers: { 'x-lifi-api-key': process.env.LIFI_API_KEY } } : {},
      7500,
      quoteState
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
      const allowance = await checkErc20Allowance({
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
  } catch {
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
}): Promise<PreparedExecution> {
  const { asset, userAddress, solanaDestination, feeConfig } = params;
  const cfg = EVM_CHAINS[asset.chain as EvmChainId];
  if (!cfg.cctpTokenMessenger || cfg.cctpDomain === null) {
    throw new Error(`${cfg.name} does not support native Circle CCTP — use Relay or LI.FI auto-routing.`);
  }
  const messenger = cfg.cctpTokenMessenger;
  const rawTotal = BigInt(asset.rawBalance);
  const { feeRaw, netRaw } = splitRawAmountForFee(rawTotal, feeConfig);
  const bridgeRaw = feeConfig.feeRecipientEvm ? netRaw : rawTotal;
  const mintRecipientBytes32 = solanaAddressToBytes32(solanaDestination);
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

  const allowance = await checkErc20Allowance({
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

async function buildBridgeExecution(
  asset: ScannedAsset,
  userAddress: string,
  solanaDestination: string,
  outputAsset: 'USDC' | 'SOL',
  bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp',
  feeConfig: ProtocolFeeConfig
): Promise<PreparedExecution> {
  const evmChain = asEvmChain(asset.chain);
  const cfg = EVM_CHAINS[evmChain];
  const isNativeUsdc =
    asset.address.toLowerCase() === cfg.usdcAddress.toLowerCase();
  const hasNativeCctp = Boolean(cfg.cctpTokenMessenger && cfg.cctpDomain !== null);
  const quoteState: QuoteState = { throttled: false };

  if (bridgePreference === 'cctp' && isNativeUsdc && hasNativeCctp) {
    return buildDirectCctpUsdcExecution({ asset, userAddress, solanaDestination, feeConfig });
  }

  if (bridgePreference !== 'lifi') {
    const relay = await tryRelayBridgeQuote({
      asset,
      userAddress,
      solanaDestination,
      outputAsset,
      feeConfig,
      quoteState,
    });
    if (relay) return relay;
  }

  const lifi = await tryLifiBridgeQuote({
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    feeConfig,
    quoteState,
  });
  if (lifi) return lifi;

  if (isNativeUsdc && hasNativeCctp) {
    return buildDirectCctpUsdcExecution({ asset, userAddress, solanaDestination, feeConfig });
  }

  if (quoteState.throttled) {
    throw new Error(
      `Quote providers were rate-limited or unreachable for ${asset.symbol} on ${cfg.name}. Not a routing verdict; retry in about a minute.`
    );
  }

  throw new Error(
    `No live bridge route found for ${asset.symbol} on ${cfg.name} (amount may be below bridge minimum or illiquid).`
  );
}

export type FollowUpQuoteFn = (
  asset: ScannedAsset,
  userAddress: string,
  solanaDestination: string,
  outputAsset: 'USDC' | 'SOL',
  bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp',
  feeConfig: ProtocolFeeConfig
) => Promise<PreparedExecution>;

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
  } = params;
  const feeConfig = getProtocolFeeConfig({ feeBps: protocolFeeBps, feeRecipientEvm });

  const evmChain = asEvmChain(asset.chain);
  const cfg = EVM_CHAINS[evmChain];
  if (!cfg) throw new Error(`Unsupported chain: ${asset.chain}`);

  // Validate Solana destination up front
  solanaAddressToBytes32(solanaDestination);

  if (asset.action === 'SKIP_HONEYPOT') {
    throw new Error(`${asset.symbol} is flagged as a reverting honeypot and cannot be executed.`);
  }

  if (asset.action === 'BURN_ZERO_LIQUIDITY') {
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
    });
  }

  return (followUpQuoteFn ?? buildBridgeExecution)(
    asset,
    userAddress,
    solanaDestination,
    outputAsset,
    bridgePreference,
    feeConfig
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
  followUpQuoteFn?: FollowUpQuoteFn;
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
    followUpQuoteFn,
  } = params;
  const feeConfig = getProtocolFeeConfig({ feeBps: protocolFeeBps, feeRecipientEvm });

  const cfg = EVM_CHAINS[chain];
  if (!cfg) throw new Error(`Unsupported chain: ${chain}`);

  const mintRecipientBytes32 = solanaAddressToBytes32(solanaDestination);
  const chainAssets = assets.filter((a) => a.chain === chain);

  const actionOrder: Record<ScannedAsset['action'], number> = {
    WITHDRAW_AND_BRIDGE: 1,
    SELL_AND_BRIDGE: 2,
    BRIDGE_DIRECT_USDC: 3,
    BURN_ZERO_LIQUIDITY: 4,
    SKIP_GAS_NEGATIVE: 5,
    SKIP_NEGATIVE_ROI: 5,
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
    executableAssets.push(asset);
  }

  const results = await settleWithConcurrency(executableAssets, QUOTE_CONCURRENCY, (asset) =>
    prepareRealExecution({
      asset,
      userAddress,
      solanaDestination,
      outputAsset,
      bridgePreference,
      protocolFeeBps: feeConfig.feeBps,
      feeRecipientEvm: feeConfig.feeRecipientEvm,
      followUpQuoteFn,
    })
  );

  const rawCalls: PreparedBatchCall[] = [];
  const bridgeTrackers: PreparedChainBatch['bridgeTrackers'] = [];
  const chainedFollowUpPlans: ChainedFollowUpPlan[] = [];
  const defiExitPlans: Record<string, DefiExitPlan> = {};
  const notes: string[] = [];
  let maxSeconds = 10;

  const DEFI_UNWIND_PROVIDERS = new Set<PreparedExecution['provider']>([
    'aave_v3',
    'aave_v2',
    'compound_v3',
    'compound_v2',
    'erc4626',
    'uniswap_v2_lp',
    'uniswap_v3_nft',
  ]);
  const quoteFollowUpBridge = followUpQuoteFn ?? buildBridgeExecution;

  for (let idx = 0; idx < results.length; idx++) {
    const res = results[idx];
    const asset = executableAssets[idx];
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
      (prep.provider === 'relay' || prep.provider === 'lifi' || prep.provider === 'circle_cctp') &&
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
          const canCctpBundle =
            isNativeUsdc &&
            outputAsset === 'USDC' &&
            Boolean(cfg.cctpTokenMessenger && cfg.cctpDomain !== null) &&
            (bridgePreference === 'cctp' ||
              (bridgePreference === 'auto' &&
                (prep.provider === 'aave_v3' ||
                  prep.provider === 'aave_v2' ||
                  prep.provider === 'compound_v3' ||
                  prep.provider === 'compound_v2' ||
                  prep.provider === 'erc4626')));

          if (canCctpBundle && cfg.cctpTokenMessenger) {
            const { feeRaw, netRaw } = splitRawAmountForFee(unlockedRaw, feeConfig);
            const bridgeRaw = feeConfig.feeRecipientEvm ? netRaw : unlockedRaw;
            const netUi = Number(bridgeRaw) / 10 ** unlocked.decimals;

            if (feeConfig.feeRecipientEvm && feeRaw > 0n) {
              rawCalls.push({
                stepId: 'protocol_fee_transfer_after_defi',
                assetId: asset.id,
                assetSymbol: asset.symbol,
                action: asset.action,
                provider: 'circle_cctp',
                label: `Protocol Fee (${feeConfig.feePercent}% USDC → ${feeConfig.feeDestinationType === 'wallet' ? 'Treasury Wallet' : 'SiphonFeeVault'})`,
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

            const gateOk =
              typeof followUpPrep.quotedOutUsd === 'number'
                ? evaluateLiveQuoteHaircut({
                    grossUsd: unlocked.estimatedUsd,
                    quoteOutUsd: followUpPrep.quotedOutUsd,
                    actualGasUsd: followUpPrep.estimatedGasUsd ?? asset.batchedGasUsd ?? 0,
                    allowHighCost,
                  }).passed
                : true;

            if (gateOk && followUpPrep.transactions.length > 0) {
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
    } else if (prep.provider === 'relay' || prep.provider === 'lifi' || prep.provider === 'circle_cctp') {
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
    defiExitPlans: Object.keys(defiExitPlans).length ? defiExitPlans : undefined,
    chainedFollowUpPlans: chainedFollowUpPlans.length ? chainedFollowUpPlans : undefined,
    notes,
  };
}

/**
 * Checks real onchain EVM tx receipt + live Relay cross-chain settlement status (including Solana tx hash!).
 */
export async function checkLiveExecutionStatus(params: {
  chain: EvmChainId;
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
}> {
  const cfg = EVM_CHAINS[params.chain];
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

  if (params.provider === 'relay' && params.requestId) {
    try {
      const res = await fetch(
        `https://api.relay.link/intents/status/v2?requestId=${encodeURIComponent(params.requestId)}`
      );
      if (res.ok) {
        const st = (await res.json()) as {
          status?: string;
          txHashes?: string[];
          details?: string;
        };
        if (st.status) bridgeStatus = st.status;
        if (st.txHashes && st.txHashes.length > 0) solanaTxHash = st.txHashes[0];
        if (st.details) details = st.details;
      }
    } catch {
      // Keep polling
    }
  }

  return {
    evmConfirmed,
    evmFailed,
    blockNumber,
    bridgeStatus,
    solanaTxHash,
    details,
  };
}
