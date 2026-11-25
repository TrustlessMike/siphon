import assert from 'node:assert/strict';
import test from 'node:test';
import { SOLANA_CCTP_PROGRAMS } from '../src/bridge/cctp.js';
import { buildGaslessSweepIntent } from '../src/relayer/sponsor.js';
import { EVM_CHAINS } from '../src/scanner/chains.js';
import {
  applyTwoLevelRoiToReport,
  classifyRoiVerdict,
  computeRelayerBreakEven,
  evaluateAssetRoi,
  evaluateChainBatchRoi,
  evaluateLiveQuoteHaircut,
  evaluatePortfolioRoi,
  isCanonicalDirectUsdc,
  RELAYER_BREAK_EVEN_MULTIPLIER,
} from '../src/scanner/roi.js';
import type { AnyChainId, ChainScanSummary, ScannedAsset, ScanReport } from '../src/scanner/types.js';
import { createSiphonServer } from '../src/server/app.js';
import {
  BackgroundJobStore,
  computePollerMaxAttempts,
  DEFAULT_POLL_INTERVAL_MS,
  isEvmChainId,
} from '../src/server/jobs.js';

const SAMPLE_SOLANA_WALLET = 'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n';
const WALLET_A = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const WALLET_B = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';

function makeAsset(overrides: Partial<ScannedAsset> = {}): ScannedAsset {
  return {
    id: 'eth:tok',
    chain: 'ethereum',
    chainName: 'Ethereum',
    address: '0x0000000000000000000000000000000000000001',
    symbol: 'TOK',
    name: 'Token',
    decimals: 18,
    kind: 'erc20',
    rawBalance: '1000000000000000000',
    uiBalance: 1,
    priceUsd: 10,
    grossUsd: 10,
    liquidityUsd: 1_000_000,
    estimatedGasUsd: 2.0,
    batchedGasUsd: 1.0,
    estimatedSlippageUsd: 0,
    netUsdcSingle: 0,
    netUsdcBatched: 0,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Swap & bridge TOK to Solana',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

function makeChainSummary(chain: AnyChainId, overrides: Partial<ChainScanSummary> = {}): ChainScanSummary {
  return {
    chain,
    chainName: chain.toUpperCase(),
    chainId: 1,
    cctpDomain: 0,
    rpcStatus: 'live',
    blockNumber: 1,
    gasPriceGwei: 5,
    nativeBalance: 1,
    nativeSymbol: 'ETH',
    nativePriceUsd: 2500,
    assetCount: 0,
    defiCount: 0,
    liquidCount: 0,
    burnCount: 0,
    skippedCount: 0,
    grossUsd: 0,
    netUsdcBridged: 0,
    totalGasUsd: 0,
    gasSavedByBatchUsd: 0,
    cctpAttestationSec: 18,
    needsGasSponsorship: false,
    ...overrides,
  };
}

function makeReport(
  chains: ChainScanSummary[],
  assets: ScannedAsset[],
  overrides: Partial<ScanReport['totals']> = {}
): ScanReport {
  return {
    scanId: 'scan_backtest',
    mode: 'live_rpc',
    walletAddress: WALLET_A,
    scannedAt: new Date().toISOString(),
    scanDurationMs: 10,
    chainsScanned: chains.length,
    chains,
    assets,
    totals: {
      grossUsd: 0,
      defiGrossUsd: 0,
      liquidGrossUsd: 0,
      protocolFeeBps: 700,
      protocolFeeUsd: 0,
      singleTxGasUsd: 0,
      batchedGasUsd: 0,
      gasSavedUsd: 0,
      estimatedSlippageUsd: 0,
      netSolanaUsdc: 0,
      solEquivalent: 0,
      solPriceUsd: 150,
      defiPositionCount: 0,
      liquidDustCount: 0,
      burnCandidateCount: 0,
      honeypotSkippedCount: 0,
      gasNegativeCount: 0,
      ...overrides,
    },
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// 1. ECONOMIC BACKTEST MATRIX (ALL 7 CHAIN FAMILIES, GAS REGIMES, FEE TIERS)
// ---------------------------------------------------------------------------

test('Economic Backtest Matrix: all 7 chain families across gas regimes, $0.05–$50k balances, and 500–1000 bps fee tiers', () => {
  const familyChains: Array<{
    family: string;
    chain: AnyChainId;
    gasRegimes: Array<{ label: string; gwei: number; soloGas: number; batchedGas: number }>;
  }> = [
    {
      family: 'evm-l2',
      chain: 'base',
      gasRegimes: [
        { label: '0.01 gwei L2', gwei: 0.01, soloGas: 0.01, batchedGas: 0.005 },
        { label: '5 gwei L2 surge', gwei: 5, soloGas: 0.12, batchedGas: 0.06 },
      ],
    },
    {
      family: 'evm-l1',
      chain: 'ethereum',
      gasRegimes: [
        { label: '5 gwei normal', gwei: 5, soloGas: 1.8, batchedGas: 0.9 },
        { label: '150 gwei L1 spike', gwei: 150, soloGas: 48.0, batchedGas: 24.0 },
      ],
    },
    {
      family: 'cosmos',
      chain: 'cosmoshub',
      gasRegimes: [{ label: 'cosmos normal', gwei: 0, soloGas: 0.03, batchedGas: 0.015 }],
    },
    {
      family: 'sui',
      chain: 'sui',
      gasRegimes: [{ label: 'sui normal', gwei: 0, soloGas: 0.02, batchedGas: 0.01 }],
    },
    {
      family: 'aptos',
      chain: 'aptos',
      gasRegimes: [{ label: 'aptos normal', gwei: 0, soloGas: 0.02, batchedGas: 0.01 }],
    },
    {
      family: 'ton',
      chain: 'ton',
      gasRegimes: [{ label: 'ton normal', gwei: 0, soloGas: 0.08, batchedGas: 0.04 }],
    },
    {
      family: 'tron',
      chain: 'tron',
      gasRegimes: [{ label: 'tron energy', gwei: 420, soloGas: 0.7, batchedGas: 0.35 }],
    },
    {
      family: 'btc',
      chain: 'btc',
      gasRegimes: [{ label: 'btc 20 sat/vB', gwei: 20, soloGas: 3.5, batchedGas: 2.0 }],
    },
  ];

  const balances = [0.05, 0.4, 1.5, 5, 25, 250, 5_000, 50_000];
  const feeTiers = [500, 700, 850, 1000];

  let scenariosRun = 0;

  for (const fc of familyChains) {
    for (const regime of fc.gasRegimes) {
      for (const balance of balances) {
        let prevNetAtLowerFee = Infinity;
        for (const feeBps of feeTiers) {
          const asset = makeAsset({
            id: `${fc.chain}:bal_${balance}`,
            chain: fc.chain,
            chainName: fc.chain,
            grossUsd: balance,
            priceUsd: balance,
            liquidityUsd: Math.max(5_000_000, balance * 200),
            estimatedGasUsd: regime.soloGas,
            batchedGasUsd: regime.batchedGas,
          });
          const batch = evaluateChainBatchRoi({
            chain: fc.chain,
            assets: [asset],
            protocolFeeBps: feeBps,
            gasPriceGwei: regime.gwei,
          });

          scenariosRun += 1;
          assert.ok(Number.isFinite(batch.chainLegNetUsd), `${fc.chain} finite net`);
          assert.ok(Number.isFinite(batch.chainLegCostPct), `${fc.chain} finite costPct`);

          // Micro-dust $0.05 must ALWAYS be skipped across every chain/gas/fee regime
          if (balance === 0.05) {
            assert.equal(batch.skipChainNegativeRoi, true, `${fc.chain} $0.05 dust must skip`);
            assert.equal(batch.recommendedExecution, 'skip_negative_roi');
          }

          // Whale $50,000 exit must ALWAYS be profitable and relayer-eligible across every regime
          if (balance === 50_000) {
            assert.equal(batch.skipChainNegativeRoi, false, `${fc.chain} $50k whale must execute`);
            assert.equal(batch.roiVerdict, 'worth_it');
            assert.equal(batch.recommendedExecution, 'sponsored_gasless');
            assert.equal(batch.relayerBreakEven.isRelayerProfitable, true);
          }

          // Higher protocol fee bps must monotonically reduce (or tie) net output on executing legs
          if (!batch.skipChainNegativeRoi && prevNetAtLowerFee !== Infinity) {
            assert.ok(
              batch.chainLegNetUsd <= prevNetAtLowerFee + 0.02,
              `Expected higher fee (${feeBps} bps) not to increase net (${batch.chainLegNetUsd} > ${prevNetAtLowerFee})`
            );
          }
          if (!batch.skipChainNegativeRoi) {
            prevNetAtLowerFee = batch.chainLegNetUsd;
          }
        }
      }
    }
  }

  // Verify gas spike monotonicity on Ethereum: 150 gwei spike strictly reduces net vs 5 gwei normal
  const ethAssetNormal = makeAsset({
    id: 'eth:25',
    chain: 'ethereum',
    grossUsd: 25,
    estimatedGasUsd: 1.8,
    batchedGasUsd: 0.9,
  });
  const ethAssetSpike = makeAsset({
    id: 'eth:25',
    chain: 'ethereum',
    grossUsd: 25,
    estimatedGasUsd: 48.0,
    batchedGasUsd: 24.0,
  });
  const normalRes = evaluateChainBatchRoi({ chain: 'ethereum', assets: [ethAssetNormal], gasPriceGwei: 5 });
  const spikeRes = evaluateChainBatchRoi({ chain: 'ethereum', assets: [ethAssetSpike], gasPriceGwei: 150 });
  assert.equal(normalRes.skipChainNegativeRoi, false);
  assert.equal(spikeRes.skipChainNegativeRoi, true);
  assert.ok(spikeRes.breakEvenHint?.includes('gwei'), 'ETH L1 spike should emit gwei break-even hint');

  // Non-EVM chains (BTC / Tron) must never mislabel fees as "gwei"
  const btcSkip = evaluateChainBatchRoi({
    chain: 'btc',
    assets: [makeAsset({ id: 'btc:tiny', chain: 'btc', grossUsd: 1.0, estimatedGasUsd: 3.5, batchedGasUsd: 2.0 })],
    gasPriceGwei: 20,
  });
  assert.equal(btcSkip.skipChainNegativeRoi, true);
  assert.ok(!btcSkip.breakEvenHint?.includes('gwei'), `BTC hint must not say gwei: ${btcSkip.breakEvenHint}`);

  assert.ok(scenariosRun >= 250, `Expected wide backtest coverage, ran ${scenariosRun}`);
});

// ---------------------------------------------------------------------------
// 2. RELAYER BREAK-EVEN SOLVENCY BACKTEST (CRIT-01)
// ---------------------------------------------------------------------------

test('CRIT-01: Relayer break-even solvency across reimbursed & unreimbursed modes has zero contradictions', () => {
  // 1. Circular 2.5x maxGasReimbursementUsd attack MUST fail (caps reimbursement at actual gas G!)
  const circular = buildGaslessSweepIntent({
    chain: 'ethereum',
    userAddress: WALLET_A,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    protocolFeeBps: 700,
    assets: [
      makeAsset({
        id: 'e1',
        chain: 'ethereum',
        grossUsd: 2.6,
        priceUsd: 2.6,
        estimatedGasUsd: 3.0,
        batchedGasUsd: 1.5,
      }),
    ],
  });
  assert.equal(circular.sponsorEligible, false, '2.5x reimbursement cap must NOT defeat 1.5x break-even');
  assert.ok(circular.sponsorRejectionReason?.includes('Below gasless sponsorship break-even'));

  // 2. Unreimbursed mode (maxGasReimbursementUsd omitted) MUST enforce 1.5x (not 1.0x!)
  const omittedBypass = computeRelayerBreakEven({
    sponsoredGasUsd: 1.0,
    protocolFeeBps: 700,
    grossUsd: 15.0, // fee = $1.05 < 1.5 * ($1.00 + $0.02) = $1.53
  });
  assert.equal(omittedBypass.isRelayerProfitable, false, 'Unreimbursed mode must enforce 1.5x coverage');
  assert.equal(omittedBypass.requiredRelayerCoverageUsd, 1.53);
  assert.ok(
    omittedBypass.rejectionReason?.includes(`$${omittedBypass.breakEvenGrossUsd.toFixed(2)}`),
    'rejectionReason must match breakEvenGrossUsd'
  );

  // 3. Reimbursed mode enforces protocolFeeUsd >= 0.5 * G (exact match to SiphonRouter.sol)
  const reimbLow = computeRelayerBreakEven({
    sponsoredGasUsd: 1.0,
    fixedRelayerOverheadUsd: 0,
    protocolFeeBps: 700,
    grossUsd: 5.0, // fee = $0.35 < 0.5 * $1.00 = $0.50
    maxGasReimbursementUsd: 2.5, // 2.5x inflated safety cap!
  });
  assert.equal(reimbLow.isRelayerProfitable, false);
  assert.equal(reimbLow.requiredRelayerCoverageUsd, 1.5);
  // At breakEvenGrossUsd ($7.15 * 7% = $0.50 >= 0.5 * $1.00), must flip profitable!
  const reimbAtBe = computeRelayerBreakEven({
    sponsoredGasUsd: 1.0,
    fixedRelayerOverheadUsd: 0,
    protocolFeeBps: 700,
    grossUsd: reimbLow.breakEvenGrossUsd,
    maxGasReimbursementUsd: 2.5,
  });
  assert.equal(reimbAtBe.isRelayerProfitable, true);
  assert.ok(reimbAtBe.protocolFeeUsd >= 0.5 * reimbAtBe.effectiveRelayerCostUsd);
  assert.ok(reimbAtBe.relayerNetMarginUsd >= 0);

  // 4. Exhaustive solvency matrix across gas levels, fee tiers, slippage, reimbursed & unreimbursed
  const gasLevels = [0.05, 0.25, 1.0, 3.5, 15.0, 45.0];
  const feeBpsList = [500, 700, 1000];
  const slippageRates = [0, 0.02, 0.1];

  for (const gas of gasLevels) {
    for (const bps of feeBpsList) {
      for (const slipRate of slippageRates) {
        for (const reimbursed of [false, true]) {
          const maxReimb = reimbursed ? Number((gas * 2.5 + 0.25).toFixed(2)) : undefined;
          const probeGross = 1.0;
          const low = computeRelayerBreakEven({
            sponsoredGasUsd: gas,
            protocolFeeBps: bps,
            grossUsd: probeGross,
            slippageUsd: Number((probeGross * slipRate).toFixed(2)),
            maxGasReimbursementUsd: maxReimb,
          });

          if (!low.isRelayerProfitable) {
            assert.ok(low.rejectionReason, 'Unprofitable check must include rejectionReason');
            assert.ok(
              low.rejectionReason!.includes(`$${low.breakEvenGrossUsd.toFixed(2)}`),
              `rejectionReason (${low.rejectionReason}) must match breakEvenGrossUsd (${low.breakEvenGrossUsd})`
            );

            // Re-evaluating at breakEvenGrossUsd (plus $0.05 rounding cushion when slippage is present) MUST succeed!
            const targetGross = Number((low.breakEvenGrossUsd + (slipRate > 0 ? 0.05 : 0)).toFixed(2));
            const atBe = computeRelayerBreakEven({
              sponsoredGasUsd: gas,
              protocolFeeBps: bps,
              grossUsd: targetGross,
              slippageUsd: Number((targetGross * slipRate).toFixed(2)),
              maxGasReimbursementUsd: maxReimb,
            });
            assert.equal(
              atBe.isRelayerProfitable,
              true,
              `Expected breakEvenGrossUsd=${targetGross} to be profitable (gas=${gas}, bps=${bps}, slip=${slipRate}, reimb=${reimbursed}), got ${JSON.stringify(atBe)}`
            );
            assert.ok(
              atBe.relayerNetMarginUsd >= 0,
              `Profitable relayer check must never report negative relayerNetMarginUsd (${atBe.relayerNetMarginUsd})`
            );
            assert.equal(atBe.rejectionReason, undefined);
          } else {
            assert.ok(low.relayerNetMarginUsd >= 0);
            assert.equal(low.rejectionReason, undefined);
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 3. LEVEL 2 BATCH MONOTONICITY & PHANTOM DUST FIX (CRIT-03)
// ---------------------------------------------------------------------------

test('CRIT-03: evaluateChainBatchRoi preserves low_efficiency assets monotonically and never causes batch wipeout', () => {
  // Repro 1 (Ethereum): 1 worth_it USDC ($1.60) + 5 low_efficiency tokens ($3.00 each)
  const ethWorthIt = makeAsset({
    id: 'eth:usdc',
    chain: 'ethereum',
    address: EVM_CHAINS.ethereum.usdcAddress,
    symbol: 'USDC',
    grossUsd: 1.6,
    estimatedGasUsd: 0.6,
    batchedGasUsd: 0.4,
    action: 'BRIDGE_DIRECT_USDC',
  });
  const ethLowEff = Array.from({ length: 5 }, (_, i) =>
    makeAsset({
      id: `eth:low_${i}`,
      chain: 'ethereum',
      symbol: `LOW${i}`,
      grossUsd: 3.0,
      estimatedGasUsd: 2.0,
      batchedGasUsd: 1.1,
    })
  );
  const ethBatch = evaluateChainBatchRoi({
    chain: 'ethereum',
    assets: [ethWorthIt, ...ethLowEff],
    protocolFeeBps: 700,
  });
  assert.equal(ethBatch.skipChainNegativeRoi, false, 'Combined ETH batch must NOT be skipped');
  assert.equal(ethBatch.includedAssetIds.length, 6);
  assert.ok(ethBatch.chainLegNetUsd > 8.0, `Expected combined ETH net > $8, got ${ethBatch.chainLegNetUsd}`);

  // Repro 2 (Base Mode B non-monotonic wipeout): adding 1 worth_it token to 5 low_efficiency tokens MUST NOT wipe out batch!
  const fiveBaseLowEff = Array.from({ length: 5 }, (_, i) =>
    makeAsset({
      id: `base:low_${i}`,
      chain: 'base',
      chainName: 'Base',
      symbol: `BLOW${i}`,
      grossUsd: 0.5,
      estimatedGasUsd: 0.6,
      batchedGasUsd: 0.2,
    })
  );
  const oneBaseWorthIt = makeAsset({
    id: 'base:win',
    chain: 'base',
    chainName: 'Base',
    symbol: 'WIN',
    grossUsd: 0.4,
    estimatedGasUsd: 0.12,
    batchedGasUsd: 0.08,
  });

  const withoutWin = evaluateChainBatchRoi({
    chain: 'base',
    assets: fiveBaseLowEff,
    protocolFeeBps: 700,
  });
  const withWin = evaluateChainBatchRoi({
    chain: 'base',
    assets: [oneBaseWorthIt, ...fiveBaseLowEff],
    protocolFeeBps: 700,
  });
  assert.equal(withoutWin.skipChainNegativeRoi, false);
  assert.equal(withWin.skipChainNegativeRoi, false, 'Adding a worth_it token MUST NOT wipe out batch');
  assert.ok(
    withWin.chainLegNetUsd > withoutWin.chainLegNetUsd,
    `Expected monotonic net increase: ${withWin.chainLegNetUsd} > ${withoutWin.chainLegNetUsd}`
  );
  assert.equal(withWin.includedAssetIds.length, 6);

  // Repro 3 (Mode A phantom dust): 1 worth_it ($10) + 5 low_efficiency ($0.50) + 2 negative_roi ($0.05)
  const baseWhale = makeAsset({
    id: 'base:ten',
    chain: 'base',
    chainName: 'Base',
    grossUsd: 10.0,
    estimatedGasUsd: 0.02,
    batchedGasUsd: 0.01,
  });
  const twoBadDust = Array.from({ length: 2 }, (_, i) =>
    makeAsset({
      id: `base:bad_${i}`,
      chain: 'base',
      chainName: 'Base',
      grossUsd: 0.05,
      estimatedGasUsd: 0.2,
      batchedGasUsd: 0.15,
    })
  );
  const modeA = evaluateChainBatchRoi({
    chain: 'base',
    assets: [baseWhale, ...fiveBaseLowEff, ...twoBadDust],
    protocolFeeBps: 700,
  });
  assert.equal(modeA.keptGrossUsd, 12.5, 'All 6 positive assets must be priced in keptGrossUsd');
  assert.equal(modeA.includedAssetIds.length, 6);
  assert.ok(!modeA.includedAssetIds.includes('base:bad_0'));
  assert.ok(!modeA.includedAssetIds.includes('base:bad_1'));
  assert.ok(modeA.chainLegNetUsd > 10.0);
});

// ---------------------------------------------------------------------------
// 4. NaN / INFINITY / ZERO FAIL-CLOSED FUZZING (HIGH-01)
// ---------------------------------------------------------------------------

test('HIGH-01: evaluateLiveQuoteHaircut, classifyRoiVerdict, and computeRelayerBreakEven fail closed on NaN/Infinity/0', () => {
  const nonFiniteValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const bad of nonFiniteValues) {
    assert.equal(classifyRoiVerdict(bad, 10), 'negative_roi');
    assert.equal(classifyRoiVerdict(10, bad), 'negative_roi');
    assert.equal(classifyRoiVerdict(bad, bad), 'negative_roi');
  }
  assert.equal(classifyRoiVerdict(-10, 10), 'negative_roi');

  const invalidQuoteValues = [...nonFiniteValues, -10];
  for (const bad of invalidQuoteValues) {
    for (const allowHighCost of [false, true]) {
      const h1 = evaluateLiveQuoteHaircut({ grossUsd: 100, quoteOutUsd: bad, actualGasUsd: 1, allowHighCost });
      const h2 = evaluateLiveQuoteHaircut({ grossUsd: 100, quoteOutUsd: 95, actualGasUsd: bad, allowHighCost });
      const h3 = evaluateLiveQuoteHaircut({ grossUsd: bad, quoteOutUsd: 95, actualGasUsd: 1, allowHighCost });
      const h4 = evaluateLiveQuoteHaircut({
        grossUsd: 100,
        quoteOutUsd: 95,
        actualGasUsd: 1,
        maxHaircutPct: bad,
        allowHighCost,
      });
      for (const h of [h1, h2, h3, h4]) {
        assert.equal(h.passed, false, `Haircut gate must fail closed on ${bad} (allowHighCost=${allowHighCost})`);
        assert.equal(h.overridden, false);
        assert.ok(Number.isFinite(h.liveNetUsd) && Number.isFinite(h.liveHaircutPct));
      }
    }
  }

  for (const bad of nonFiniteValues) {
    const r1 = computeRelayerBreakEven({ sponsoredGasUsd: bad, grossUsd: 100 });
    const r2 = computeRelayerBreakEven({ sponsoredGasUsd: 1, grossUsd: bad });
    const r3 = computeRelayerBreakEven({ sponsoredGasUsd: 1, grossUsd: 100, maxGasReimbursementUsd: bad });
    for (const r of [r1, r2, r3]) {
      assert.equal(r.isRelayerProfitable, false, `Relayer break-even must fail closed on ${bad}`);
    }
  }

  // Zero gross USD must also fail closed even if quoteOutUsd > 0
  const zeroGross = evaluateLiveQuoteHaircut({ grossUsd: 0, quoteOutUsd: 10, actualGasUsd: 1, allowHighCost: true });
  assert.equal(zeroGross.passed, false);
});

// ---------------------------------------------------------------------------
// 5. isDirectUsdc CANONICAL VS SPOOFED ERC-20 & 1:1 DEFI USDC (HIGH-03)
// ---------------------------------------------------------------------------

test('HIGH-03: isDirectUsdc zeroes slippage on 1:1 DeFi USDC & Noble USDC while charging spoofed "USDC" ERC-20s', () => {
  // 1. Aave v3 aEthUSDC (1:1 DeFi USDC withdrawal) -> $0 slippage!
  const aaveUsdc = makeAsset({
    id: 'eth:aethusdc',
    chain: 'ethereum',
    address: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
    symbol: 'aEthUSDC',
    kind: 'defi_position',
    protocol: 'Aave v3',
    underlyingSymbol: 'USDC',
    grossUsd: 1240.5,
    liquidityUsd: 250_000_000,
    estimatedSlippageUsd: 0,
    action: 'WITHDRAW_AND_BRIDGE',
  });
  assert.equal(isCanonicalDirectUsdc(aaveUsdc), true);
  assert.equal(evaluateAssetRoi(aaveUsdc).slippageUsd, 0);

  // 2. Noble native USDC (kind: 'native', address: 'uusdc', even if pre-flagged SKIP_GAS_NEGATIVE) -> $0 slippage!
  const nobleUsdc = makeAsset({
    id: 'noble:uusdc',
    chain: 'noble',
    chainName: 'Noble',
    address: 'uusdc',
    symbol: 'USDC',
    kind: 'native',
    grossUsd: 500,
    liquidityUsd: 100_000_000,
    estimatedSlippageUsd: 0,
    action: 'SKIP_GAS_NEGATIVE',
  });
  assert.equal(isCanonicalDirectUsdc(nobleUsdc), true);
  assert.equal(evaluateAssetRoi(nobleUsdc).slippageUsd, 0);

  // 3. Canonical EVM USDC -> $0 slippage!
  const realBaseUsdc = makeAsset({
    id: 'base:usdc',
    chain: 'base',
    address: EVM_CHAINS.base.usdcAddress,
    symbol: 'USDC',
    kind: 'erc20',
    grossUsd: 1000,
    action: 'BRIDGE_DIRECT_USDC',
  });
  assert.equal(isCanonicalDirectUsdc(realBaseUsdc), true);
  assert.equal(evaluateAssetRoi(realBaseUsdc).slippageUsd, 0);

  // 4. Spoofed ERC-20 named "USDC" with non-canonical address -> MUST be charged liquidity-scaled slippage!
  const spoofedUsdc = makeAsset({
    id: 'eth:fake_usdc',
    chain: 'ethereum',
    address: '0x9999999999999999999999999999999999999999',
    symbol: 'USDC',
    kind: 'erc20',
    grossUsd: 1000,
    liquidityUsd: 50_000,
    estimatedSlippageUsd: 0,
    action: 'BRIDGE_DIRECT_USDC',
  });
  assert.equal(isCanonicalDirectUsdc(spoofedUsdc), false);
  const spoofEval = evaluateAssetRoi(spoofedUsdc);
  assert.ok(spoofEval.slippageUsd > 10, `Spoofed USDC must incur DEX slippage, got ${spoofEval.slippageUsd}`);

  // 5. Spoofed DeFi position with non-canonical underlyingAddress -> NOT zero-slippage USDC!
  const spoofedDefi = makeAsset({
    id: 'eth:fake_defi_usdc',
    chain: 'ethereum',
    address: '0x8888888888888888888888888888888888888888',
    symbol: 'aFakeUSDC',
    kind: 'defi_position',
    underlyingSymbol: 'USDC',
    underlyingAddress: '0x9999999999999999999999999999999999999999',
    grossUsd: 1000,
    liquidityUsd: 50_000,
    action: 'WITHDRAW_AND_BRIDGE',
  });
  assert.equal(isCanonicalDirectUsdc(spoofedDefi), false);
  assert.ok(evaluateAssetRoi(spoofedDefi).slippageUsd > 10);
});

// ---------------------------------------------------------------------------
// 6. applyTwoLevelRoiToReport SYNC, NO RESURRECTION, SINGLE ATA RENT (HIGH-02/04/05)
// ---------------------------------------------------------------------------

test('HIGH-02 & HIGH-04: applyTwoLevelRoiToReport synchronizes totals, avoids resurrecting SKIP_GAS_NEGATIVE, avoids double-wrapping actionReason, and charges ATA rent ONCE', () => {
  const skippedEthDust = makeAsset({
    id: 'eth:dust',
    chain: 'ethereum',
    chainName: 'Ethereum',
    grossUsd: 1.0,
    estimatedGasUsd: 4.0,
    batchedGasUsd: 2.5,
    action: 'SELL_AND_BRIDGE',
    selectedByDefault: true,
  });
  const baseProfitable = makeAsset({
    id: 'base:usdc',
    chain: 'base',
    chainName: 'Base',
    address: EVM_CHAINS.base.usdcAddress,
    symbol: 'USDC',
    grossUsd: 50.0,
    estimatedGasUsd: 0.04,
    batchedGasUsd: 0.02,
    action: 'BRIDGE_DIRECT_USDC',
    selectedByDefault: true,
  });
  const baseLowEff = makeAsset({
    id: 'base:low',
    chain: 'base',
    chainName: 'Base',
    symbol: 'LOW',
    grossUsd: 0.6,
    estimatedGasUsd: 0.35,
    batchedGasUsd: 0.22,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Swap & bridge LOW',
    selectedByDefault: true,
  });
  const cosmosFloorSkip = makeAsset({
    id: 'cosmoshub:uatom',
    chain: 'cosmoshub',
    chainName: 'Cosmos Hub',
    symbol: 'ATOM',
    kind: 'native',
    grossUsd: 0.4,
    estimatedGasUsd: 0.014,
    batchedGasUsd: 0.014,
    action: 'SKIP_GAS_NEGATIVE',
    actionReason: 'Below $0.50 Cosmos dust floor — skipped.',
    selectedByDefault: false,
  });

  const report = makeReport(
    [
      makeChainSummary('ethereum'),
      makeChainSummary('base'),
      makeChainSummary('cosmoshub'),
    ],
    [skippedEthDust, baseProfitable, baseLowEff, cosmosFloorSkip],
    { solPriceUsd: 150, protocolFeeBps: 700 }
  );

  // Run applyTwoLevelRoiToReport TWICE (simulating unified multi-wallet double-pass!)
  applyTwoLevelRoiToReport(report, { hasSolanaUsdcAta: false });
  applyTwoLevelRoiToReport(report, { hasSolanaUsdcAta: false });

  // 1. Cosmos pre-skipped dust MUST NOT be resurrected as selectedByDefault: true
  assert.equal(cosmosFloorSkip.action, 'SKIP_GAS_NEGATIVE');
  assert.equal(cosmosFloorSkip.selectedByDefault, false);
  assert.equal(cosmosFloorSkip.roiVerdict, 'negative_roi');

  // 2. actionReason on low_efficiency asset MUST NOT be double-wrapped
  const highCostOccurrences = (baseLowEff.actionReason.match(/High cost \(/g) || []).length;
  assert.equal(highCostOccurrences, 1, `Expected single High cost wrapper, got: ${baseLowEff.actionReason}`);

  // 3. chainSummary counts and report.totals MUST be completely synchronized
  for (const cs of report.chains) {
    assert.equal(
      cs.defiCount + cs.liquidCount + cs.burnCount + cs.skippedCount,
      cs.assetCount,
      `Chain ${cs.chain} count mismatch`
    );
  }
  assert.equal(report.totals.gasNegativeCount, 2); // skippedEthDust + cosmosFloorSkip
  assert.equal(report.totals.liquidDustCount, 2); // baseProfitable + baseLowEff
  assert.equal(report.totals.grossUsd, 50.6); // excludes skippedEthDust ($1) and cosmosFloorSkip ($0.40)

  // 4. Solana ATA rent ($0.31 at $150 SOL) MUST be charged EXACTLY ONCE on executing chain, $0 on skipped chains
  const ethChain = report.chains.find((c) => c.chain === 'ethereum')!;
  const baseChain = report.chains.find((c) => c.chain === 'base')!;
  const cosmosChain = report.chains.find((c) => c.chain === 'cosmoshub')!;
  assert.equal(ethChain.skipChainNegativeRoi, true);
  assert.equal(ethChain.solanaAtaRentUsd, 0, 'Skipped ETH chain must NOT be stamped with ATA rent');
  assert.equal(cosmosChain.solanaAtaRentUsd, 0, 'Skipped Cosmos chain must NOT be stamped with ATA rent');
  assert.equal(baseChain.skipChainNegativeRoi, false);
  assert.equal(baseChain.solanaAtaRentUsd, 0.31, 'Executing Base chain must carry the single ATA rent');
  const totalChainAta = Number(report.chains.reduce((s, c) => s + (c.solanaAtaRentUsd ?? 0), 0).toFixed(2));
  assert.equal(totalChainAta, 0.31);

  // 5. evaluatePortfolioRoi must also charge ATA rent once on executing chain & exclude skipped chains from totals
  const portfolio = evaluatePortfolioRoi(report, { hasSolanaUsdcAta: false, protocolFeeBps: 700 });
  assert.equal(portfolio.solanaAtaRentUsd, 0.31);
  assert.equal(
    Number(portfolio.chains.reduce((s, c) => s + c.solanaAtaRentUsd, 0).toFixed(2)),
    0.31
  );
  const portfolioBase = portfolio.chains.find((c) => c.chain === 'base')!;
  const portfolioEth = portfolio.chains.find((c) => c.chain === 'ethereum')!;
  assert.equal(portfolioEth.skipChainNegativeRoi, true);
  assert.equal(portfolioEth.solanaAtaRentUsd, 0);
  assert.equal(portfolioBase.solanaAtaRentUsd, 0.31);
  assert.equal(portfolio.totalSignedUserNetUsd, portfolioBase.chainLegNetUsd);
  assert.equal(portfolio.totalGrossUsd, portfolioBase.keptGrossUsd);
});

// ---------------------------------------------------------------------------
// 7. BACKGROUND JOB STORE STRESS BACKTEST (CRIT-06, CRIT-07, HIGH-09/10, MED-07)
// ---------------------------------------------------------------------------

test('CRIT-06 & CRIT-07 (HTTP): partial /api/jobs/:id/leg preserves fields, rejects malicious assetCount with 400, and isolates multi-wallet same-chain legs', async () => {
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Malicious non-integer assetCount payloads MUST return HTTP 400 (XSS defense-in-depth)
    const maliciousCounts: unknown[] = [
      '<img src=x onerror=alert(1)>',
      -1,
      2.5,
      null,
      '4',
    ];
    for (const badCount of maliciousCounts) {
      const badRes = await fetch(`${base}/api/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceWallet: WALLET_A,
          solanaDestination: SAMPLE_SOLANA_WALLET,
          legs: [{ chain: 'base', assetCount: badCount, estimatedNetUsd: 100 }],
        }),
      });
      assert.equal(badRes.status, 400, `Expected HTTP 400 for assetCount=${JSON.stringify(badCount)}`);
    }

    // 2. Multi-wallet same-chain job: Wallet A + Wallet B BOTH on 'base'
    const createRes = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWallet: WALLET_A,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
        bridgePreference: 'relay',
        protocolFeeBps: 700,
        legs: [
          { sourceWallet: WALLET_A, chain: 'base', assetCount: 2, estimatedNetUsd: 150, estimatedFeeUsd: 10.5 },
          { sourceWallet: WALLET_B, chain: 'base', assetCount: 3, estimatedNetUsd: 250, estimatedFeeUsd: 17.5 },
        ],
      }),
    });
    assert.equal(createRes.status, 200);
    const job = await createRes.json();
    assert.equal(job.legs.length, 2);
    assert.notEqual(job.legs[0].legId, job.legs[1].legId, 'Same-chain multi-wallet legs must have unique legIds');

    // 3. Partial POST /api/jobs/:id/leg MUST NEVER wipe evmTxHash / provider / requestId
    const txHashA = '0x' + '1'.repeat(64);
    const setInitial = await fetch(`${base}/api/jobs/${job.jobId}/leg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legId: job.legs[0].legId,
        status: 'confirming',
        statusText: 'Submitted to Base',
        provider: 'relay',
        evmTxHash: txHashA,
        requestId: 'relay_req_abc123',
        callsBatched: 3,
        popupsSaved: 2,
      }),
    }).then((r) => r.json());
    assert.equal(setInitial.legs[0].provider, 'relay');
    assert.equal(setInitial.legs[0].evmTxHash, txHashA);
    assert.equal(setInitial.legs[0].requestId, 'relay_req_abc123');

    // Now send a partial update omitting provider/evmTxHash/requestId/callsBatched/popupsSaved!
    const partialRes = await fetch(`${base}/api/jobs/${job.jobId}/leg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legId: job.legs[0].legId,
        status: 'relaying',
        statusText: 'Waiting for Relay fill',
      }),
    }).then((r) => r.json());
    assert.equal(partialRes.legs[0].status, 'relaying');
    assert.equal(partialRes.legs[0].provider, 'relay', 'Partial update must preserve provider');
    assert.equal(partialRes.legs[0].evmTxHash, txHashA, 'Partial update must preserve evmTxHash');
    assert.equal(partialRes.legs[0].requestId, 'relay_req_abc123', 'Partial update must preserve requestId');
    assert.equal(partialRes.legs[0].callsBatched, 3);
    assert.equal(partialRes.legs[0].popupsSaved, 2);

    // Invalid status must return HTTP 400
    const badStatusRes = await fetch(`${base}/api/jobs/${job.jobId}/leg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ legId: job.legs[0].legId, status: 'not_a_real_status' }),
    });
    assert.equal(badStatusRes.status, 400);

    // 4. Update Wallet B's 'base' leg independently by (sourceWallet, chain)
    const landedB = await fetch(`${base}/api/jobs/${job.jobId}/leg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWallet: WALLET_B,
        chain: 'base',
        status: 'landed',
        statusText: 'Wallet B landed on Solana',
      }),
    }).then((r) => r.json());
    assert.equal(landedB.legs[0].status, 'relaying', 'Updating Wallet B must not touch Wallet A');
    assert.equal(landedB.legs[1].status, 'landed');
    assert.equal(landedB.status, 'active');
    assert.equal(landedB.settledNetUsd, 250);

    // Land Wallet A -> entire multi-wallet job completes cleanly!
    const landedA = await fetch(`${base}/api/jobs/${job.jobId}/leg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        legId: job.legs[0].legId,
        status: 'landed',
        statusText: 'Wallet A landed on Solana',
      }),
    }).then((r) => r.json());
    assert.equal(landedA.status, 'completed');
    assert.equal(landedA.settledNetUsd, 400);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HIGH-09, HIGH-10, MED-07, CRIT-07: poller concurrency guard, ETH 780s CCTP window, Object.hasOwn, summary semantics & active-job retention', async () => {
  // 1. Prototype-chain Object.hasOwn check (HIGH-10)
  assert.equal(isEvmChainId('toString'), false);
  assert.equal(isEvmChainId('constructor'), false);
  assert.equal(isEvmChainId('__proto__'), false);
  assert.equal(isEvmChainId('valueOf'), false);
  assert.equal(isEvmChainId('ethereum'), true);
  assert.equal(isEvmChainId('base'), true);

  // 2. Ethereum CCTP polling window MUST exceed 780s finality (HIGH-09)
  const ethCctpAttempts = computePollerMaxAttempts(
    'ethereum',
    { provider: 'circle_cctp', requiresSolanaClaim: true },
    DEFAULT_POLL_INTERVAL_MS
  );
  const ethCctpWindowSec = (ethCctpAttempts * DEFAULT_POLL_INTERVAL_MS) / 1000;
  assert.ok(
    ethCctpWindowSec >= 1000,
    `Expected Ethereum CCTP polling window >= 1000s (covering 780s finality), got ${ethCctpWindowSec}s`
  );

  // 3. Overlapping async poller concurrency guard + no state regression + no false 'landed' on unbridged Relay leg
  let inFlightCalls = 0;
  let maxConcurrentCalls = 0;
  let totalCalls = 0;
  let releaseFirstTick!: () => void;
  const firstTickStarted = new Promise<void>((resolve) => {
    releaseFirstTick = resolve;
  });
  let finishSlowTick!: () => void;
  const slowTickGate = new Promise<void>((resolve) => {
    finishSlowTick = resolve;
  });

  const store = new BackgroundJobStore({
    pollIntervalMs: 15,
    statusChecker: async () => {
      totalCalls += 1;
      inFlightCalls += 1;
      maxConcurrentCalls = Math.max(maxConcurrentCalls, inFlightCalls);
      if (totalCalls === 1) {
        releaseFirstTick();
        await slowTickGate;
      }
      inFlightCalls -= 1;
      return {
        chain: 'base',
        evmConfirmed: true,
        evmFailed: false,
        bridgeStatus: 'pending',
        message: 'Waiting for Relay',
      };
    },
  });

  try {
    const raceJob = store.createJob({
      sourceWallet: WALLET_A,
      solanaDestination: SAMPLE_SOLANA_WALLET,
      outputAsset: 'USDC',
      bridgePreference: 'relay',
      protocolFeeBps: 700,
      feeRecipientEvm: null,
      legs: [{ chain: 'base', assetCount: 2, estimatedNetUsd: 100 }],
    });

    store.updateLeg(raceJob.jobId, 'base', {
      status: 'confirming',
      provider: 'relay',
      evmTxHash: '0x' + 'b'.repeat(64),
      requestId: 'req_race_1',
    });

    // Wait until tick #1 enters statusChecker, then wait ~60ms (> 3 intervals) while tick #1 is still pending
    await firstTickStarted;
    await new Promise((r) => setTimeout(r, 65));
    assert.equal(maxConcurrentCalls, 1, 'Poller must NEVER run overlapping async ticks');

    // Also test direct updateLeg with explicit undefined values (must NOT wipe fields!)
    store.updateLeg(raceJob.jobId, 'base', {
      status: 'confirming',
      provider: undefined,
      evmTxHash: undefined,
      requestId: undefined,
    });
    assert.equal(raceJob.legs[0].requestId, 'req_race_1');
    assert.equal(raceJob.legs[0].provider, 'relay');

    // Now manually mark leg as 'landed' WHILE slow tick #1 is still in-flight, then release slow tick #1!
    store.updateLeg(raceJob.jobId, 'base', { status: 'landed', statusText: 'Claimed on Solana' });
    finishSlowTick();
    await new Promise((r) => setTimeout(r, 40));

    // Must NOT regress from 'landed' back to 'relaying' or reopen 'completed' to 'active'!
    assert.equal(raceJob.legs[0].status, 'landed', 'Slow resuming tick must NOT regress landed -> relaying');
    assert.equal(raceJob.status, 'completed');

    // 4. Unclaimed 'attested' CCTP leg & all-skipped job summary (MED-07)
    let ethTicks = 0;
    const cctpStore = new BackgroundJobStore({
      pollIntervalMs: 10,
      statusChecker: async () => {
        ethTicks += 1;
        return {
          chain: 'ethereum',
          evmConfirmed: true,
          evmFailed: false,
          bridgeStatus: 'pending',
          message: 'ETH confirmed',
        };
      },
      attestationFetcher: async () => ({
        found: true,
        chain: 'ethereum',
        txHash: '0x' + 'c'.repeat(64),
        messageBytesHex: '0x1234',
        messageHash: '0x' + 'd'.repeat(64),
        attestationStatus: ethTicks >= 45 ? 'complete' : 'pending_confirmations',
        attestation: ethTicks >= 45 ? '0xabcd' : undefined,
        solanaProgramIds: SOLANA_CCTP_PROGRAMS,
        nextStep: 'Claim on Solana',
      }),
    });

    try {
      const cctpJob = cctpStore.createJob({
        sourceWallet: WALLET_A,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
        bridgePreference: 'cctp',
        protocolFeeBps: 700,
        feeRecipientEvm: null,
        legs: [{ chain: 'ethereum', assetCount: 1, estimatedNetUsd: 500 }],
      });
      cctpStore.updateLeg(cctpJob.jobId, 'ethereum', {
        status: 'confirming',
        provider: 'circle_cctp',
        evmTxHash: '0x' + 'c'.repeat(64),
        requiresSolanaClaim: true,
      });

      // Wait until >45 ticks complete (proving poller does NOT stop at the old 40-tick / 140s limit!)
      const deadline = Date.now() + 2000;
      while (cctpJob.legs[0].status !== 'attested' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.ok(ethTicks >= 45, `Expected ETH CCTP poller to continue past 40 ticks, stopped at ${ethTicks}`);
      assert.equal(cctpJob.legs[0].status, 'attested');
      assert.equal(cctpJob.settledNetUsd, 0, 'Unclaimed attested CCTP leg must NOT count in settledNetUsd');
      assert.equal(cctpJob.attestedNetUsd, 500);
      assert.equal(cctpJob.status, 'active', 'Job with unclaimed attested leg must remain active until claimed');

      const ticksAtAttested = ethTicks;
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(ethTicks, ticksAtAttested, 'Poller must stop once leg reaches attested');

      // Once user claims on Solana -> transitions cleanly to landed & completed
      cctpStore.updateLeg(cctpJob.jobId, 'ethereum', { status: 'landed', solanaTxHash: '5SolSig...' });
      assert.equal(cctpJob.settledNetUsd, 500);
      assert.equal(cctpJob.attestedNetUsd, 0);
      assert.equal(cctpJob.status, 'completed');

      // Unbridged Relay leg (evmConfirmed=true, bridgeStatus='pending', even with omitted requestId) MUST NOT falsely flip to 'landed'
      const unbridgedJob = cctpStore.createJob({
        sourceWallet: WALLET_A,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
        bridgePreference: 'relay',
        protocolFeeBps: 700,
        feeRecipientEvm: null,
        legs: [{ chain: 'base', assetCount: 1, estimatedNetUsd: 200 }],
      });
      cctpStore.updateLeg(unbridgedJob.jobId, 'base', {
        status: 'confirming',
        provider: 'relay',
        evmTxHash: '0x' + 'e'.repeat(64),
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(
        unbridgedJob.legs[0].status,
        'relaying',
        'Unbridged Relay leg must stay relaying (never falsely flip to landed on EVM confirmation alone)'
      );
      assert.equal(unbridgedJob.settledNetUsd, 0);

      // All-skipped job MUST NOT report 'failed'
      const skipJob = cctpStore.createJob({
        sourceWallet: WALLET_A,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
        bridgePreference: 'auto',
        protocolFeeBps: 700,
        feeRecipientEvm: null,
        legs: [
          { chain: 'ethereum', assetCount: 1, estimatedNetUsd: 10 },
          { chain: 'base', assetCount: 1, estimatedNetUsd: 5 },
        ],
      });
      cctpStore.updateLeg(skipJob.jobId, 'ethereum', { status: 'skipped', statusText: 'User skipped' });
      cctpStore.updateLeg(skipJob.jobId, 'base', { status: 'skipped', statusText: 'User skipped' });
      assert.notEqual(skipJob.status, 'failed', 'All-skipped job must NOT report failed');
      assert.equal(skipJob.status, 'skipped');
      assert.equal(skipJob.settledNetUsd, 0);
    } finally {
      cctpStore.dispose();
    }

    // 5. Active-job retention under >30 job load (CRIT-07)
    const loadStore = new BackgroundJobStore({ maxJobs: 30 });
    try {
      const activeVictim = loadStore.createJob({
        sourceWallet: WALLET_A,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
        bridgePreference: 'cctp',
        protocolFeeBps: 700,
        feeRecipientEvm: null,
        legs: [{ chain: 'ethereum', assetCount: 3, estimatedNetUsd: 2500 }],
      });
      loadStore.updateLeg(activeVictim.jobId, 'ethereum', {
        status: 'relaying',
        statusText: 'Waiting for ETH CCTP',
      });

      // Flood 40 additional jobs (mix of empty completed jobs and active jobs)
      for (let i = 0; i < 40; i++) {
        const j = loadStore.createJob({
          sourceWallet: WALLET_B,
          solanaDestination: SAMPLE_SOLANA_WALLET,
          outputAsset: 'USDC',
          bridgePreference: 'auto',
          protocolFeeBps: 700,
          feeRecipientEvm: null,
          legs: i % 2 === 0 ? [] : [{ chain: 'base', assetCount: 1, estimatedNetUsd: 10 }],
        });
        if (i % 4 === 1) {
          loadStore.updateLeg(j.jobId, 'base', { status: 'landed' });
        }
      }

      assert.ok(
        loadStore.getJob(activeVictim.jobId),
        'Active in-progress job MUST NOT be evicted during >30 job pruning'
      );
      assert.equal(loadStore.getJob(activeVictim.jobId)?.status, 'active');
    } finally {
      loadStore.dispose();
    }
  } finally {
    store.dispose();
  }
});
