import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildMigrationPlan,
  CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_V2_FALLBACK_FAST_FEE_BPS,
  CCTP_V2_FAST_FINALITY_THRESHOLD,
  CCTP_V2_STANDARD_FINALITY_THRESHOLD,
  getCctpEstimatedSeconds,
} from '../src/bridge/cctp.js';
import {
  BALANCER_V2_VAULTS,
  COMPOUND_V3_COMETS,
  DEFI_SELECTORS,
  encodeBalancerV2ExitPool,
  identifyProtocolExtractorId,
  PROTOCOL_EXTRACTOR_REGISTRY,
  resolveDefiExitPlan,
  validateTrustedProtocolTarget,
} from '../src/defi/extractors.js';
import { preflightDefiAsset } from '../src/defi/preflight.js';
import { quoteMayanSwiftNonEvm } from '../src/execution/non-evm-converter.js';
import { evaluatePreservationPlan } from '../src/execution/preservation-optimizer.js';
import {
  fetchMayanSwiftQuote,
  MAYAN_FORWARDER_CONTRACT,
  MAYAN_SDK_VERSION,
} from '../src/execution/route-auction.js';
import { prepareChainBatchExecution, prepareRealExecution } from '../src/execution/tx-builder.js';
import {
  computePreservationFee,
  EVM_CHAINS,
  getChainUsdcDecimals,
  getProtocolFeeConfig,
  resolveUnderlyingDecimals,
} from '../src/scanner/chains.js';
import { DEFILLAMA_CHAIN_SLUGS, scanPresetWallet } from '../src/scanner/classifier.js';
import { applyTwoLevelRoiToReport, evaluateAssetRoi, evaluateChainBatchRoi } from '../src/scanner/roi.js';
import type { EvmChainId, ScannedAsset } from '../src/scanner/types.js';

const USER_EVM = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const USER_SOL = 'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n';

function mkAsset(overrides: Partial<ScannedAsset> = {}): ScannedAsset {
  const chain = (overrides.chain as EvmChainId) ?? 'ethereum';
  const cfg = EVM_CHAINS[chain];
  return {
    id: `${chain}:test`,
    family: 'evm',
    chain,
    chainName: cfg.name,
    address: cfg.usdcAddress,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: getChainUsdcDecimals(chain),
    kind: 'erc20',
    rawBalance: (10_000n * 10n ** BigInt(getChainUsdcDecimals(chain))).toString(),
    uiBalance: 10_000,
    priceUsd: 1,
    grossUsd: 10_000,
    liquidityUsd: 100_000_000,
    estimatedGasUsd: 1.5,
    batchedGasUsd: 1.0,
    estimatedSlippageUsd: 0,
    netUsdcSingle: 9_998,
    netUsdcBatched: 9_999,
    action: 'BRIDGE_DIRECT_USDC',
    actionReason: 'Direct native USDC bridge',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

function decodeCctpV2Words(calldata: string) {
  assert.ok(calldata.startsWith(`0x${CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR}`));
  const word = (idx: number) => calldata.slice(10 + idx * 64, 10 + (idx + 1) * 64);
  return {
    amount: BigInt('0x' + word(0)),
    destinationDomain: Number(BigInt('0x' + word(1))),
    mintRecipient: '0x' + word(2).toLowerCase(),
    burnToken: '0x' + word(3).slice(24).toLowerCase(),
    maxFee: BigInt('0x' + word(5)),
    minFinalityThreshold: Number(BigInt('0x' + word(6))),
  };
}

// ============================================================================
// 1. HIGH-1: Mayan Swift sdkVersion + forwarderAddress + Swift V2 ABI Encoding
// ============================================================================

test('HIGH-1: Mayan Swift EVM & Sui requests send sdkVersion + forwarderAddress and encode canonical Swift V2 calldata', async () => {
  let capturedEvmUrl = '';
  const mockEvmFetcher = async (url: string): Promise<Response> => {
    capturedEvmUrl = url;
    // Live Mayan v3 Swift V2 response shape (NO pre-encoded `tx` field)
    return new Response(
      JSON.stringify({
        quotes: [
          {
            type: 'SWIFT',
            swiftVersion: 'V2',
            quoteId: '0x0ab7aeb384260c0d390d6d9b96d1c018',
            swiftMayanContract: '0x40fFE85A28DC9993541449464d7529a922142960',
            swiftInputContract: EVM_CHAINS.base.usdcAddress,
            swiftInputDecimals: 6,
            swiftAuctionMode: 3,
            swiftWrapAndLock: false,
            effectiveAmountIn: 1000,
            effectiveAmountIn64: '1000000000',
            expectedAmountOut: 999.5,
            minAmountOut: 999.0,
            minAmountOutBaseUnits: '999000000',
            cancelRelayerFee64: '819',
            refundRelayerFee64: '1671',
            deadline64: '1895681969',
            etaSeconds: 4,
            fromToken: { contract: EVM_CHAINS.base.usdcAddress, decimals: 6 },
            toToken: { contract: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const baseUsdc = mkAsset({
    chain: 'base',
    rawBalance: '1000000000',
    uiBalance: 1000,
    grossUsd: 1000,
  });
  const evmQuote = await fetchMayanSwiftQuote({
    asset: baseUsdc,
    userAddress: USER_EVM,
    solanaDestination: USER_SOL,
    outputAsset: 'USDC',
    feeConfig: getProtocolFeeConfig({ grossUsd: 1000 }),
    fetcher: mockEvmFetcher,
    allowanceCheckFn: async () => 10n ** 18n,
  });

  assert.ok(evmQuote, 'Mayan Swift EVM quote must succeed on live v3 Swift V2 response shape');
  const parsedUrl = new URL(capturedEvmUrl);
  assert.equal(parsedUrl.searchParams.get('sdkVersion'), MAYAN_SDK_VERSION);
  assert.equal(parsedUrl.searchParams.get('forwarderAddress'), MAYAN_FORWARDER_CONTRACT);
  assert.equal(parsedUrl.searchParams.get('swift'), 'true');
  assert.equal(evmQuote.transactions.length, 1);
  assert.equal(evmQuote.transactions[0].to, MAYAN_FORWARDER_CONTRACT);
  assert.ok(
    evmQuote.transactions[0].data.startsWith('0xe4269fc4'),
    'Direct ERC-20 Swift V2 order must encode MayanForwarder.forwardERC20 (0xe4269fc4)'
  );
  assert.ok(
    evmQuote.transactions[0].data.includes('a3a30834'),
    'Inner protocolData must encode MayanSwiftV2.createOrderWithToken (0xa3a30834)'
  );

  // Sui Mayan quote sends sdkVersion + forwarderAddress + mctp=true
  let capturedSuiUrl = '';
  const suiQuote = await quoteMayanSwiftNonEvm({
    fromChain: 'sui',
    fromToken: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    fromAmount: '100000000',
    fromDecimals: 6,
    fromAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
    solanaDestination: USER_SOL,
    outputAsset: 'USDC',
    tradeUsd: 100,
    fetcher: async (url: string) => {
      capturedSuiUrl = url;
      return new Response(
        JSON.stringify({
          quotes: [
            {
              type: 'MCTP',
              expectedAmountOut: 99.65,
              etaSeconds: 10,
              toPrice: 1,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    },
  });
  assert.ok(suiQuote);
  const parsedSui = new URL(capturedSuiUrl);
  assert.equal(parsedSui.searchParams.get('sdkVersion'), MAYAN_SDK_VERSION);
  assert.equal(parsedSui.searchParams.get('forwarderAddress'), MAYAN_FORWARDER_CONTRACT);
  assert.equal(parsedSui.searchParams.get('mctp'), 'true');
  assert.equal(suiQuote.quotedOutUsd, 99.65);
});

// ============================================================================
// 2. HIGH-2 & MEDIUM-12: Dead Blast / Polygon / BNB RPCs Replaced
// ============================================================================

test('HIGH-2 & MEDIUM-12: Dead Blast, Polygon, and BNB RPC fallbacks are removed from EVM_CHAINS', () => {
  const deadUrls = [
    'https://rpc.blast.io',
    'https://blast-rpc.publicnode.com',
    'https://blast.drpc.org',
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon.drpc.org',
    'https://bsc-dataseed.binance.org',
  ];

  for (const chainId of ['blast', 'polygon', 'bnb'] as EvmChainId[]) {
    const cfg = EVM_CHAINS[chainId];
    assert.ok(cfg.rpcUrls.length >= 2, `${chainId} must have at least 2 working RPCs`);
    for (const dead of deadUrls) {
      assert.ok(
        !cfg.rpcUrls.includes(dead) && cfg.rpcUrl !== dead,
        `${chainId} must not include dead RPC ${dead}`
      );
    }
  }
  assert.ok(EVM_CHAINS.blast.rpcUrls.includes('https://blast.api.pocket.network'));
});

// ============================================================================
// 3. HIGH-3: Monotonic Progressive Tiered Preservation Fee + Default Wiring
// ============================================================================

test('HIGH-3: computePreservationFee defaults to 0% open-source fee across ROI, planning, batching, and optimizer while explicit tiered mode stays strictly monotonic', async () => {
  // Check strict monotonicity of explicit tiered schedule across boundary cliffs ($50, $500, $5,000) and whale range up to $250k
  const samplePoints = [
    0, 0.01, 1, 10, 49, 49.98, 49.99, 50, 50.01, 51, 100, 250, 499, 499.99, 500, 500.01,
    1_000, 2_000, 4_999, 4_999.99, 5_000, 5_000.01, 10_000, 25_000, 36_750, 50_000, 100_000, 250_000,
  ];
  let prevFee = -1;
  let prevNet = -1;
  for (const x of samplePoints) {
    const res = computePreservationFee(x, { mode: 'tiered' });
    assert.ok(
      res.feeUsd >= prevFee,
      `Fee cliff detected at $${x}: fee($${x}) = $${res.feeUsd} < previous $${prevFee}`
    );
    assert.ok(
      res.netAfterFeeUsd >= prevNet,
      `Net drop detected at $${x}: net($${x}) = $${res.netAfterFeeUsd} < previous $${prevNet}`
    );
    assert.ok(res.feeUsd <= 50, `Fee at $${x} exceeded $50 hard cap: $${res.feeUsd}`);
    prevFee = res.feeUsd;
    prevNet = res.netAfterFeeUsd;
  }

  // Exact boundary continuity checks (explicit tiered) + default 0% open-source fee
  assert.equal(computePreservationFee(49.99, { mode: 'tiered' }).feeUsd, 2.5);
  assert.equal(computePreservationFee(50.0, { mode: 'tiered' }).feeUsd, 2.5);
  assert.equal(computePreservationFee(4_999.99, { mode: 'tiered' }).feeUsd, 18.25);
  assert.equal(computePreservationFee(5_000.0, { mode: 'tiered' }).feeUsd, 18.25);
  assert.equal(computePreservationFee(100_000, { mode: 'tiered' }).feeUsd, 50);
  assert.equal(computePreservationFee(100_000).feeUsd, 0);

  // Open-source default on Noble / $10,000 USDC is 0 bps ($0 protocol fee)!
  const noble10kFeeCfg = getProtocolFeeConfig({ grossUsd: 10_000 });
  assert.equal(noble10kFeeCfg.feeSchedule, 'zero');
  assert.equal(noble10kFeeCfg.preservationFee?.feeUsd, 0);
  assert.equal(noble10kFeeCfg.feeBps, 0);

  // Explicit override still respected
  const explicitFlat = getProtocolFeeConfig({ feeBps: 700, grossUsd: 10_000 });
  assert.equal(explicitFlat.feeBps, 700);
  assert.equal(explicitFlat.feeSchedule, 'flat');

  // ROI default uses 0% open-source fee; explicit protocolFeeBps: 700 uses flat 7%
  const usdc10k = mkAsset({ chain: 'base', grossUsd: 10_000 });
  const defaultAssetRoi = evaluateAssetRoi(usdc10k);
  const flatAssetRoi = evaluateAssetRoi(usdc10k, { protocolFeeBps: 700 });
  assert.equal(defaultAssetRoi.protocolFeeUsd, 0);
  assert.equal(flatAssetRoi.protocolFeeUsd, 700);

  const defaultChainRoi = evaluateChainBatchRoi({ chain: 'base', assets: [usdc10k] });
  assert.equal(defaultChainRoi.protocolFeeUsd, 0);

  // buildMigrationPlan + evaluatePreservationPlan + applyTwoLevelRoiToReport default to 0% open-source fee!
  const preset = await scanPresetWallet('veteran_defi');
  assert.equal(preset.totals.protocolFeeBps, 0);
  const plan = buildMigrationPlan({ scan: preset, solanaDestination: USER_SOL });
  assert.equal(plan.protocolFeeBps, 0);
  assert.equal(plan.totals.protocolFeeUsd, 0);
  const flatPlan = buildMigrationPlan({
    scan: preset,
    solanaDestination: USER_SOL,
    protocolFeeBps: 700,
  });
  assert.equal(flatPlan.protocolFeeBps, 700);

  const presReport = await evaluatePreservationPlan(preset);
  assert.equal(presReport.protocolFeeBps, 0);
  assert.ok(
    presReport.totals.preservationRatePct > 98,
    `Expected >98% preservation rate with 0% fee, got ${presReport.totals.preservationRatePct}%`
  );

  // applyTwoLevelRoiToReport default uses 0% fee
  const roiApplied = applyTwoLevelRoiToReport(structuredClone(preset));
  assert.equal(roiApplied.totals.protocolFeeBps, 0);
});

// ============================================================================
// 4. HIGH-4: CCTP V2 Fast Transfer Encoding & Linea Fallback Fee
// ============================================================================

test('HIGH-4: CCTP V2 encodes Fast Transfer (threshold=1000, maxFee>0, 15s ETA) vs Standard (threshold=2000, maxFee=0, 780s ETA) and Linea fallback is 15 bps', async () => {
  assert.equal(CCTP_V2_FALLBACK_FAST_FEE_BPS[11], 15);
  assert.equal(getCctpEstimatedSeconds('ethereum', 'fast'), 15);
  assert.equal(getCctpEstimatedSeconds('ethereum', 'standard'), 780);

  const mockIrisFetcher = async (url: string): Promise<Response> => {
    if (url.includes('iris-api.circle.com/v2/burn/USDC/fees/0/5')) {
      return new Response(
        JSON.stringify([
          { finalityThreshold: 1000, minimumFee: 1.0 },
          { finalityThreshold: 2000, minimumFee: 0 },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  const ethUsdc10k = mkAsset({ chain: 'ethereum', grossUsd: 10_000 });

  // Fast Transfer (default for CCTP V2)
  const fastBatch = await prepareChainBatchExecution({
    chain: 'ethereum',
    assets: [ethUsdc10k],
    userAddress: USER_EVM,
    solanaDestination: USER_SOL,
    bridgePreference: 'cctp',
    allowanceCheckFn: async () => 10n ** 18n,
    routeAuctionOptions: { fetcher: mockIrisFetcher },
  });
  const fastCall = fastBatch.calls.find((c) => c.stepId === 'cctp_deposit_for_burn');
  assert.ok(fastCall);
  const decFast = decodeCctpV2Words(fastCall.data);
  assert.equal(decFast.minFinalityThreshold, CCTP_V2_FAST_FINALITY_THRESHOLD);
  assert.equal(decFast.maxFee, 1_000_000n); // 1 bps of $10,000 = $1.00
  assert.equal(fastBatch.estimatedSeconds, 15);
  assert.ok(fastBatch.feeBreakdown.feeBps < 30, 'Batch fee must default to tiered preservation fee');

  // Standard Transfer (explicitly requested)
  const stdBatch = await prepareChainBatchExecution({
    chain: 'ethereum',
    assets: [ethUsdc10k],
    userAddress: USER_EVM,
    solanaDestination: USER_SOL,
    bridgePreference: 'cctp',
    cctpTransferMode: 'standard',
    allowanceCheckFn: async () => 10n ** 18n,
    routeAuctionOptions: { fetcher: mockIrisFetcher },
  });
  const stdCall = stdBatch.calls.find((c) => c.stepId === 'cctp_deposit_for_burn');
  assert.ok(stdCall);
  const decStd = decodeCctpV2Words(stdCall.data);
  assert.equal(decStd.minFinalityThreshold, CCTP_V2_STANDARD_FINALITY_THRESHOLD);
  assert.equal(decStd.maxFee, 0n);
  assert.equal(stdBatch.estimatedSeconds, 780);
});

// ============================================================================
// 5. HIGH-5: Compound v3 Optimism Comet Allowlist + On-Chain balanceOf Cap
// ============================================================================

test('HIGH-5: Optimism cWETHv3 is trusted, dead cUSDTv3 removed, and Compound v3 strictly caps withdraw at Comet.balanceOf(user)', async () => {
  const OP_CWETH_V3 = '0xE36A30D249f7761327fd973001A32010b521b6Fd';
  const DEAD_OP_COMET = '0x995E394b8B2437aC8Ce61Ee0bC610D617962B2Ac';

  assert.ok(
    (COMPOUND_V3_COMETS.optimism ?? []).some((a) => a.toLowerCase() === OP_CWETH_V3.toLowerCase()),
    'Optimism cWETHv3 must be in COMPOUND_V3_COMETS'
  );
  assert.ok(
    !(COMPOUND_V3_COMETS.optimism ?? []).some((a) => a.toLowerCase() === DEAD_OP_COMET.toLowerCase()),
    'Nonexistent Optimism Comet must be removed'
  );
  assert.equal(
    validateTrustedProtocolTarget({
      chain: 'optimism',
      protocolId: 'compound_v3',
      assetAddress: OP_CWETH_V3,
      protocolAddress: OP_CWETH_V3,
    }).trusted,
    true
  );

  const opCometAsset = mkAsset({
    chain: 'optimism',
    address: OP_CWETH_V3,
    symbol: 'cWETHv3',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Compound v3',
    protocolAddress: OP_CWETH_V3,
    underlyingSymbol: 'WETH',
    underlyingAddress: '0x4200000000000000000000000000000000000006',
    rawBalance: (5n * 10n ** 18n).toString(), // Stale scan claims 5 WETH
    uiBalance: 5,
    priceUsd: 2500,
    grossUsd: 12_500,
    action: 'WITHDRAW_AND_BRIDGE',
  });

  // Case A: On-chain Comet.balanceOf(user) is only 1.5 WETH -> withdraw MUST be strictly capped at 1.5 WETH!
  const cappedPrep = await prepareRealExecution({
    asset: opCometAsset,
    userAddress: USER_EVM,
    solanaDestination: USER_SOL,
    compoundSafetyCheckFn: async () => ({
      checked: true,
      protocolId: 'compound_v3',
      hasActiveBorrow: false,
      borrowBalanceRaw: 0n,
      suppliedBalanceRaw: 1_500_000_000_000_000_000n, // 1.5 WETH
      isCollateralized: true,
      safeForWithdraw: true,
      reason: 'Verified onchain.',
    }),
  });
  assert.equal(cappedPrep.provider, 'compound_v3');
  const encodedWithdrawAmt = BigInt('0x' + cappedPrep.transactions[0].data.slice(10 + 64, 10 + 128));
  assert.equal(
    encodedWithdrawAmt,
    1_500_000_000_000_000_000n,
    'Comet.withdraw amount MUST be capped to min(rawBalance, Comet.balanceOf(user))'
  );

  // Case B: On-chain Comet.balanceOf(user) is 0n -> MUST fail closed (never open a borrow!)
  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: opCometAsset,
        userAddress: USER_EVM,
        solanaDestination: USER_SOL,
        compoundSafetyCheckFn: async () => ({
          checked: true,
          protocolId: 'compound_v3',
          hasActiveBorrow: false,
          borrowBalanceRaw: 0n,
          suppliedBalanceRaw: 0n,
          isCollateralized: true,
          safeForWithdraw: true,
          reason: 'Zero supplied base balance verified onchain via Comet.balanceOf(user).',
        }),
      }),
    /Zero supplied base balance|Compound safety guard/i
  );
});

// ============================================================================
// 6. HIGH-6: Compound v2 Non-Zero Return Code + exchangeRateStored Math
// ============================================================================

test('HIGH-6: Compound v2 preflight computes expectedUnderlyingUi via exchangeRateStored and rejects non-zero redeem() error code', async () => {
  const cUsdcAddr = '0x39AA39c021dfbaE8faC545936693aC917d5E7563';
  const cUsdcAsset = mkAsset({
    chain: 'ethereum',
    address: cUsdcAddr,
    symbol: 'cUSDC',
    decimals: 8,
    kind: 'defi_position',
    protocol: 'Compound v2',
    protocolAddress: cUsdcAddr,
    underlyingSymbol: 'USDC',
    underlyingAddress: EVM_CHAINS.ethereum.usdcAddress,
    rawBalance: (500n * 10n ** 8n).toString(), // 500 cUSDC
    uiBalance: 500,
    priceUsd: 0.025,
    grossUsd: 12.5,
    action: 'WITHDRAW_AND_BRIDGE',
  });

  // Verify resolveDefiExitPlan uses exchangeRateStoredRaw (500 cUSDC * 2.53233129693876e14 / 1e18 = 12.661656 USDC)
  const plan = resolveDefiExitPlan({
    asset: cUsdcAsset,
    compoundSafety: {
      checked: true,
      protocolId: 'compound_v2',
      hasActiveBorrow: false,
      borrowBalanceRaw: 0n,
      exchangeRateStoredRaw: 253_233_129_693_876n,
      underlyingAddress: EVM_CHAINS.ethereum.usdcAddress,
      underlyingDecimals: 6,
      isCollateralized: true,
      safeForWithdraw: true,
      reason: 'OK',
    },
  });
  assert.equal(plan.underlyingDecimals, 6);
  assert.equal(plan.expectedUnderlyingRaw, '12661656');
  assert.equal(plan.expectedUnderlyingUi, 12.661656);

  // Verify preflight.ts explicitly decodes non-zero uint256 return word for 0xdb006a75 & 0x852a12e3
  const preflightSrc = fs.readFileSync(path.resolve('src/defi/preflight.ts'), 'utf8');
  assert.ok(preflightSrc.includes('0xdb006a75') && preflightSrc.includes('0x852a12e3'));
  assert.ok(preflightSrc.includes('errCode !== 0n'));
});

// ============================================================================
// 7. HIGH-7: Lido wstETH & Ethena sUSDe when liquidityUsd is undefined
// ============================================================================

test('HIGH-7: wstETH and sUSDe route via direct_swap_bypass_cooldown when liquidityUsd is undefined and wstETH never falls through to ERC4626.redeem()', async () => {
  const wstEth = mkAsset({
    chain: 'ethereum',
    address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    symbol: 'wstETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Lido',
    protocolAddress: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
    underlyingSymbol: 'ETH',
    rawBalance: (10n ** 18n).toString(),
    uiBalance: 1,
    priceUsd: 3000,
    grossUsd: 3000,
    liquidityUsd: undefined as unknown as number,
    action: 'WITHDRAW_AND_BRIDGE',
  });
  const sUsde = mkAsset({
    chain: 'ethereum',
    address: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    symbol: 'sUSDe',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Ethena',
    protocolAddress: '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497',
    underlyingSymbol: 'USDe',
    rawBalance: (1000n * 10n ** 18n).toString(),
    uiBalance: 1000,
    priceUsd: 1.1,
    grossUsd: 1100,
    liquidityUsd: undefined as unknown as number,
    action: 'WITHDRAW_AND_BRIDGE',
  });

  const wstRes = await preflightDefiAsset({ asset: wstEth, walletAddress: USER_EVM, skipRpc: true });
  const sUsdeRes = await preflightDefiAsset({ asset: sUsde, walletAddress: USER_EVM, skipRpc: true });

  assert.equal(wstRes.defiExitPlan.exitStrategy, 'direct_swap_bypass_cooldown');
  assert.equal(wstRes.defiExitPlan.preflightStatus, 'verified');
  assert.equal(sUsdeRes.defiExitPlan.exitStrategy, 'direct_swap_bypass_cooldown');
  assert.equal(sUsdeRes.defiExitPlan.preflightStatus, 'verified');

  // Even when liquidityUsd is explicitly tiny ($100), wstETH MUST NOT fall through to ERC4626.redeem()!
  const lowLiqWstEth = { ...wstEth, liquidityUsd: 100 };
  const lowLiqPlan = resolveDefiExitPlan({ asset: lowLiqWstEth });
  assert.equal(lowLiqPlan.protocolId, 'liquid_receipt');
  assert.equal(lowLiqPlan.preflightStatus, 'blocked');
  assert.notEqual(lowLiqPlan.protocolId, 'erc4626');
});

// ============================================================================
// 8. MEDIUM-8, 9, 10, 11, 12: Gas Reserve, 18-Dec BNB/Blast, Slugs, Moonwell/Kodiak/BEX, BridgeProvider
// ============================================================================

test('MEDIUM-8/9/10/11/12: gasReserveNative, 18-dec BNB/Blast decimals, Wave 7B DeFiLlama slugs, Moonwell/Kodiak/BEX extractors, and chainedFollowUpPlan.bridgeProvider', async () => {
  // MEDIUM-8: classifier.ts uses c.gasReserveNative
  const classifierSrc = fs.readFileSync(path.resolve('src/scanner/classifier.ts'), 'utf8');
  assert.ok(classifierSrc.includes('const gasReserve = c.gasReserveNative;'));
  assert.ok(!classifierSrc.includes("c.id === 'ethereum' ? 0.002 : 0.0005"));

  // MEDIUM-9: BNB (18-dec USDC) & Blast (18-dec USDB) decimals
  assert.equal(getChainUsdcDecimals('bnb'), 18);
  assert.equal(getChainUsdcDecimals('blast'), 18);
  assert.equal(getChainUsdcDecimals('ethereum'), 6);
  assert.equal(getChainUsdcDecimals('base'), 6);
  assert.equal(
    resolveUnderlyingDecimals({ chain: 'bnb', underlyingAddress: EVM_CHAINS.bnb.usdcAddress }),
    18
  );
  assert.equal(
    resolveUnderlyingDecimals({ chain: 'blast', underlyingAddress: EVM_CHAINS.blast.usdcAddress }),
    18
  );

  // MEDIUM-10: Wave 7B DeFiLlama chain slugs
  assert.equal(DEFILLAMA_CHAIN_SLUGS.hyperevm, 'hyperliquid');
  assert.equal(DEFILLAMA_CHAIN_SLUGS.zksync, 'era');
  assert.equal(DEFILLAMA_CHAIN_SLUGS.gnosis, 'xdai');
  assert.equal(DEFILLAMA_CHAIN_SLUGS.berachain, 'berachain');
  assert.equal(DEFILLAMA_CHAIN_SLUGS.ink, 'ink');
  assert.equal(DEFILLAMA_CHAIN_SLUGS.avalanche, 'avax');
  assert.equal(DEFILLAMA_CHAIN_SLUGS.bnb, 'bsc');

  // MEDIUM-11: Moonwell, Kodiak v2/v3, and Berachain BEX Vault extractor
  assert.equal(
    identifyProtocolExtractorId({ protocol: 'Moonwell', symbol: 'mUSDC', address: '0x1111111111111111111111111111111111111111' }),
    'compound_v2'
  );
  assert.equal(
    PROTOCOL_EXTRACTOR_REGISTRY.compound_v2.matches(
      mkAsset({ chain: 'base', protocol: 'Moonwell', symbol: 'mUSDC', kind: 'defi_position' })
    ),
    true
  );
  assert.equal(
    identifyProtocolExtractorId({ protocol: 'Kodiak v2', symbol: 'KDK-LP', address: '0x1111111111111111111111111111111111111111' }),
    'uniswap_v2_lp'
  );
  assert.equal(
    identifyProtocolExtractorId({ protocol: 'Kodiak v3', symbol: 'KDK-V3', address: '0x1111111111111111111111111111111111111111' }),
    'uniswap_v3_nft'
  );

  const BEX_VAULT = '0x4Be03f781C497A489E3cB0287833452cA9B9E80B';
  assert.equal(BALANCER_V2_VAULTS.berachain?.[0]?.vault, BEX_VAULT);
  const poolId = '0x' + 'ab'.repeat(32);
  const bexAsset = mkAsset({
    chain: 'berachain',
    address: '0x2c4a603A2aA5596287A06886862dc29d56DbC354',
    symbol: 'BEX-HONEY-WBERA',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'BEX',
    protocolAddress: BEX_VAULT,
    balancerPoolId: poolId,
    lpToken0Address: '0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce',
    lpToken0Symbol: 'HONEY',
    lpToken0Decimals: 18,
    lpToken1Address: '0x6969696969696969696969696969696969696969',
    lpToken1Symbol: 'WBERA',
    lpToken1Decimals: 18,
    rawBalance: (10n * 10n ** 18n).toString(),
    uiBalance: 10,
    grossUsd: 500,
    action: 'WITHDRAW_AND_BRIDGE',
  });
  assert.equal(identifyProtocolExtractorId(bexAsset), 'balancer_v2_lp');
  const bexExitData = encodeBalancerV2ExitPool({
    poolId,
    sender: USER_EVM,
    recipient: USER_EVM,
    assets: [bexAsset.lpToken0Address!, bexAsset.lpToken1Address!],
    minAmountsOut: [0n, 0n],
    bptAmountIn: 10n * 10n ** 18n,
  });
  assert.ok(bexExitData.startsWith(DEFI_SELECTORS.balancerExitPool)); // 0x8bdb3913

  const bexBuilt = PROTOCOL_EXTRACTOR_REGISTRY.balancer_v2_lp.buildExtraction({
    asset: bexAsset,
    userAddress: USER_EVM,
    chain: 'berachain',
  });
  assert.equal(bexBuilt.provider, 'balancer_v2_lp');
  assert.equal(bexBuilt.transactions[0].to, BEX_VAULT);
  assert.ok(bexBuilt.transactions[0].data.startsWith('0x8bdb3913'));

  // Untrusted BEX vault target rejected
  assert.equal(
    validateTrustedProtocolTarget({
      chain: 'berachain',
      protocolId: 'balancer_v2_lp',
      assetAddress: bexAsset.address,
      protocolAddress: '0x9999999999999999999999999999999999999999',
    }).trusted,
    false
  );

  // MEDIUM-12: chainedFollowUpPlan.bridgeProvider preserves mayan_swift & debridge_dln
  const aaveWeth = mkAsset({
    chain: 'base',
    address: '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7',
    symbol: 'aBasWETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: EVM_CHAINS.base.aaveV3Pool,
    underlyingSymbol: 'WETH',
    underlyingAddress: '0x4200000000000000000000000000000000000006',
    rawBalance: (10n ** 18n).toString(),
    uiBalance: 1,
    priceUsd: 2500,
    grossUsd: 2500,
    action: 'WITHDRAW_AND_BRIDGE',
  });
  for (const prov of ['mayan_swift', 'debridge_dln'] as const) {
    const batch = await prepareChainBatchExecution({
      chain: 'base',
      assets: [aaveWeth],
      userAddress: USER_EVM,
      solanaDestination: USER_SOL,
      aaveSafetyCheckFn: async () => ({
        checked: true,
        hasActiveDebt: false,
        totalCollateralUsd: 2500,
        totalDebtUsd: 0,
        healthFactor: 999,
        currentLiquidationThresholdBps: 8250,
        safeForMaxWithdraw: true,
        reason: 'No debt',
      }),
      followUpQuoteFn: async () => ({
        assetId: aaveWeth.id,
        action: 'SELL_AND_BRIDGE',
        provider: prov,
        chain: 'base',
        chainId: 8453,
        chainName: 'Base',
        explorerUrl: EVM_CHAINS.base.explorerUrl,
        estimatedOutput: '2495 USDC',
        estimatedSeconds: 6,
        quotedOutUsd: 2495,
        estimatedGasUsd: 0.05,
        transactions: [
          {
            stepId: `bridge_${prov}`,
            label: `Bridge via ${prov}`,
            description: 'Test',
            chain: 'base',
            chainId: 8453,
            chainName: 'Base',
            explorerUrl: EVM_CHAINS.base.explorerUrl,
            from: USER_EVM,
            to: MAYAN_FORWARDER_CONTRACT,
            data: '0x12345678',
            value: '0x0',
          },
        ],
        notes: [],
      }),
    });
    assert.equal(batch.chainedFollowUpPlans?.[0]?.bridgeProvider, prov);
  }
});
