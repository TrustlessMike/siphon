import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateDustAutoHarvestEligibility,
  evaluateGasWatchTriggers,
  PreservationAgentStore,
} from '../src/agent/preservation-agents.js';
import { evaluatePreservationPlan } from '../src/execution/preservation-optimizer.js';
import { EVM_CHAINS } from '../src/scanner/chains.js';
import { scanPresetWallet } from '../src/scanner/classifier.js';
import type { ScannedAsset, ScanReport } from '../src/scanner/types.js';
import { createTurgaliumServer } from '../src/server/app.js';

const EVM_WALLET = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const SOL_DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const SOL_DEST_OTHER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function makeAsset(overrides: Partial<ScannedAsset>): ScannedAsset {
  return {
    id: 'base:tok',
    family: 'evm',
    chain: 'base',
    chainName: 'Base',
    address: '0x1111111111111111111111111111111111111111',
    symbol: 'AERO',
    name: 'Aerodrome',
    decimals: 18,
    kind: 'erc20',
    rawBalance: '100000000000000000000',
    uiBalance: 100,
    priceUsd: 2.0,
    grossUsd: 200,
    liquidityUsd: 2_000_000,
    estimatedGasUsd: 0.04,
    batchedGasUsd: 0.02,
    estimatedSlippageUsd: 0.3,
    netUsdcSingle: 185,
    netUsdcBatched: 185.5,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Liquid token',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

function makeScanReport(
  assets: ScannedAsset[],
  chainOverrides: Partial<Record<string, { gasPriceGwei: number; nativePriceUsd: number }>> = {}
): ScanReport {
  const uniqueChains = Array.from(new Set(assets.map((a) => a.chain)));
  const chains = uniqueChains.map((chain) => {
    const cfg = EVM_CHAINS[chain as keyof typeof EVM_CHAINS];
    const chainAssets = assets.filter((a) => a.chain === chain);
    const over = chainOverrides[chain];
    return {
      family: 'evm' as const,
      chain,
      chainName: cfg?.name ?? chain,
      chainId: cfg?.chainId ?? 1,
      cctpDomain: cfg?.cctpDomain ?? null,
      rpcStatus: 'preset' as const,
      blockNumber: 1000,
      gasPriceGwei: over?.gasPriceGwei ?? (chain === 'ethereum' ? 22 : 0.05),
      nativeBalance: 1,
      nativeSymbol: cfg?.nativeSymbol ?? 'ETH',
      nativePriceUsd: over?.nativePriceUsd ?? (chain === 'bnb' ? 600 : 2500),
      assetCount: chainAssets.length,
      defiCount: chainAssets.filter((a) => a.kind === 'defi_position').length,
      liquidCount: chainAssets.filter((a) => a.kind !== 'defi_position').length,
      burnCount: 0,
      skippedCount: 0,
      grossUsd: round2(chainAssets.reduce((s, a) => s + a.grossUsd, 0)),
      netUsdcBridged: round2(chainAssets.reduce((s, a) => s + a.grossUsd, 0)),
      totalGasUsd: round2(chainAssets.reduce((s, a) => s + a.batchedGasUsd, 0)),
      gasSavedByBatchUsd: 0.5,
      cctpAttestationSec: cfg?.cctpAttestationSec ?? 20,
      needsGasSponsorship: false,
    };
  });

  const grossUsd = round2(assets.reduce((s, a) => s + a.grossUsd, 0));
  return {
    scanId: 'scan_preservation_test',
    family: 'evm',
    mode: 'preset',
    walletAddress: EVM_WALLET,
    walletLabel: 'Preservation Test Wallet',
    scannedAt: new Date().toISOString(),
    scanDurationMs: 12,
    chainsScanned: chains.length,
    chains,
    assets,
    totals: {
      grossUsd,
      defiGrossUsd: 0,
      liquidGrossUsd: grossUsd,
      protocolFeeBps: 700,
      protocolFeeUsd: 0,
      singleTxGasUsd: 5,
      batchedGasUsd: 2,
      gasSavedUsd: 3,
      estimatedSlippageUsd: 1,
      netSolanaUsdc: grossUsd,
      solEquivalent: round2(grossUsd / 150),
      solPriceUsd: 150,
      defiPositionCount: 0,
      liquidDustCount: assets.length,
      burnCandidateCount: 0,
      honeypotSkippedCount: 0,
      gasNegativeCount: 0,
    },
    warnings: [],
  };
}

test('Route auction chooses Circle CCTP (0-bps) for large native USDC on Ethereum, Arbitrum, and Base', async () => {
  const scan = makeScanReport(
    [
      makeAsset({
        id: 'eth:usdc',
        chain: 'ethereum',
        chainName: 'Ethereum',
        address: EVM_CHAINS.ethereum.usdcAddress,
        symbol: 'USDC',
        decimals: 6,
        uiBalance: 10_000,
        priceUsd: 1,
        grossUsd: 10_000,
        liquidityUsd: 100_000_000,
        estimatedGasUsd: 6,
        batchedGasUsd: 4,
        estimatedSlippageUsd: 0,
        action: 'BRIDGE_DIRECT_USDC',
      }),
      makeAsset({
        id: 'arb:usdc',
        chain: 'arbitrum',
        chainName: 'Arbitrum',
        address: EVM_CHAINS.arbitrum.usdcAddress,
        symbol: 'USDC',
        decimals: 6,
        uiBalance: 5_000,
        priceUsd: 1,
        grossUsd: 5_000,
        liquidityUsd: 50_000_000,
        estimatedGasUsd: 0.05,
        batchedGasUsd: 0.02,
        estimatedSlippageUsd: 0,
        action: 'BRIDGE_DIRECT_USDC',
      }),
      makeAsset({
        id: 'base:usdc',
        chain: 'base',
        chainName: 'Base',
        address: EVM_CHAINS.base.usdcAddress,
        symbol: 'USDC',
        decimals: 6,
        uiBalance: 4_000,
        priceUsd: 1,
        grossUsd: 4_000,
        liquidityUsd: 50_000_000,
        estimatedGasUsd: 0.03,
        batchedGasUsd: 0.015,
        estimatedSlippageUsd: 0,
        action: 'BRIDGE_DIRECT_USDC',
      }),
    ],
    {
      ethereum: { gasPriceGwei: 12, nativePriceUsd: 2500 },
      arbitrum: { gasPriceGwei: 0.05, nativePriceUsd: 2500 },
      base: { gasPriceGwei: 0.05, nativePriceUsd: 2500 },
    }
  );

  const report = await evaluatePreservationPlan(scan, {
    outputAsset: 'USDC',
    liveGasGweiByChain: { ethereum: 12, arbitrum: 0.05, base: 0.05 },
  });

  assert.equal(report.chains.length, 3);
  for (const chainAudit of report.chains) {
    assert.equal(
      chainAudit.bestRoute,
      'circle_cctp',
      `Expected Circle CCTP on ${chainAudit.chain}, got ${chainAudit.bestRoute}`
    );
    const eligibleCrossChain = chainAudit.candidates.filter((c) => c.eligible && c.settlesOnSolana);
    const maxNet = Math.max(...eligibleCrossChain.map((c) => c.netUsdPreserved));
    assert.equal(chainAudit.bestNetUsdPreserved, maxNet);
    const cctp = chainAudit.candidates.find((c) => c.route === 'circle_cctp')!;
    const relay = chainAudit.candidates.find((c) => c.route === 'relay')!;
    const lifi = chainAudit.candidates.find((c) => c.route === 'lifi')!;
    assert.ok(cctp.netUsdPreserved > relay.netUsdPreserved);
    assert.ok(cctp.netUsdPreserved > lifi.netUsdPreserved);
  }
  assert.equal(report.recommendedBridgePreference, 'cctp');
  assert.ok(report.totals.dollarsSavedRouteAuctionUsd > 0);
});

test('Route auction chooses Relay for fast L2 non-USDC swaps, LI.FI for thin-liquidity DEX pairs, and disables CCTP for SOL output', async () => {
  const scan = makeScanReport(
    [
      // Fast L2 non-USDC swaps on Base -> Relay should win
      makeAsset({
        id: 'base:aero',
        chain: 'base',
        chainName: 'Base',
        address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
        symbol: 'AERO',
        grossUsd: 180,
        liquidityUsd: 1_200_000,
        estimatedSlippageUsd: 0.5,
      }),
      makeAsset({
        id: 'base:brett',
        chain: 'base',
        chainName: 'Base',
        address: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
        symbol: 'BRETT',
        grossUsd: 140,
        liquidityUsd: 800_000,
        estimatedSlippageUsd: 0.4,
      }),
      // Thinner-liquidity non-USDC on BNB (no native CCTP) -> LI.FI multi-DEX slippage reduction beats Relay
      makeAsset({
        id: 'bnb:exotic',
        chain: 'bnb',
        chainName: 'BNB Chain',
        address: '0x3333333333333333333333333333333333333333',
        symbol: 'EXOTIC',
        grossUsd: 1_500,
        liquidityUsd: 35_000,
        estimatedGasUsd: 0.15,
        batchedGasUsd: 0.08,
        estimatedSlippageUsd: 0,
      }),
    ],
    {
      base: { gasPriceGwei: 0.05, nativePriceUsd: 2500 },
      bnb: { gasPriceGwei: 1, nativePriceUsd: 600 },
    }
  );

  const usdcPlan = await evaluatePreservationPlan(scan, {
    outputAsset: 'USDC',
    liveGasGweiByChain: { ethereum: 12, base: 0.05, bnb: 1 },
  });

  const baseAudit = usdcPlan.chains.find((c) => c.chain === 'base')!;
  const bnbAudit = usdcPlan.chains.find((c) => c.chain === 'bnb')!;
  assert.equal(baseAudit.bestRoute, 'relay');
  assert.equal(bnbAudit.bestRoute, 'lifi');

  // Verify every chain picks the maximum netUsdPreserved among eligible cross-chain routes
  for (const chainAudit of usdcPlan.chains) {
    const maxNet = Math.max(
      ...chainAudit.candidates.filter((c) => c.eligible && c.settlesOnSolana).map((c) => c.netUsdPreserved)
    );
    assert.equal(chainAudit.bestNetUsdPreserved, maxNet);
  }

  // Output SOL strictly disqualifies Circle CCTP
  const solPlan = await evaluatePreservationPlan(scan, {
    outputAsset: 'SOL',
    liveGasGweiByChain: { ethereum: 12, base: 0.05, bnb: 1 },
  });
  for (const chainAudit of solPlan.chains) {
    const cctp = chainAudit.candidates.find((c) => c.route === 'circle_cctp')!;
    assert.equal(cctp.eligible, false);
    assert.notEqual(chainAudit.bestRoute, 'circle_cctp');
  }
});

test('Route auction falls back to direct_swap_only when Ethereum bridge fees destroy >35% of a small balance', async () => {
  const scan = makeScanReport(
    [
      makeAsset({
        id: 'eth:small-uni',
        chain: 'ethereum',
        chainName: 'Ethereum',
        address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
        symbol: 'UNI',
        grossUsd: 5.5,
        liquidityUsd: 5_000_000,
        estimatedGasUsd: 0.8,
        batchedGasUsd: 0.5,
        estimatedSlippageUsd: 0.02,
      }),
    ],
    {
      ethereum: { gasPriceGwei: 4.5, nativePriceUsd: 2500 },
    }
  );

  const report = await evaluatePreservationPlan(scan, {
    outputAsset: 'USDC',
    liveGasGweiByChain: { ethereum: 4.5 },
  });

  const ethAudit = report.chains.find((c) => c.chain === 'ethereum')!;
  assert.equal(ethAudit.bestRoute, 'direct_swap_only');
  assert.ok(ethAudit.bestNetUsdPreserved > 0);
});

test('Exact dollars saved math reconciles cleanly and stays finite & non-negative on veteran_defi preset', async () => {
  const preset = await scanPresetWallet('veteran_defi');
  const report = await evaluatePreservationPlan(preset, {
    outputAsset: 'USDC',
    liveGasGweiByChain: { ethereum: 28 },
  });

  const t = report.totals;
  const numericFields = [
    t.grossSweepableUsd,
    t.optimizedNetUsd,
    t.naiveManualNetUsd,
    t.dollarsSavedGasUsd,
    t.dollarsSavedApprovalsUsd,
    t.dollarsSavedNegativeRoiPrunedUsd,
    t.dollarsSavedRouteAuctionUsd,
    t.totalDollarsPreservedUsd,
    t.preservationRatePct,
    t.executionEfficiencyPct,
    t.popupsNaive,
    t.popupsOptimized,
    t.popupsEliminated,
  ];
  for (const val of numericFields) {
    assert.ok(Number.isFinite(val), `Expected finite metric, got ${val}`);
  }

  assert.ok(t.dollarsSavedGasUsd >= 0);
  assert.ok(t.dollarsSavedApprovalsUsd >= 0);
  assert.ok(t.dollarsSavedNegativeRoiPrunedUsd >= 0);
  assert.ok(t.dollarsSavedRouteAuctionUsd >= 0);
  assert.ok(t.totalDollarsPreservedUsd > 0);

  // Exact cent-level reconciliation of all 4 savings components
  const sumComponents = round2(
    t.dollarsSavedGasUsd +
      t.dollarsSavedApprovalsUsd +
      t.dollarsSavedNegativeRoiPrunedUsd +
      t.dollarsSavedRouteAuctionUsd
  );
  assert.equal(t.totalDollarsPreservedUsd, sumComponents);

  // Popups reconciliation
  assert.ok(t.popupsNaive > t.popupsOptimized);
  assert.equal(t.popupsNaive - t.popupsOptimized, t.popupsEliminated);

  // Preservation rates bounded in [0, 100]
  assert.ok(t.preservationRatePct > 80 && t.preservationRatePct <= 100);
  assert.ok(t.executionEfficiencyPct >= t.preservationRatePct && t.executionEfficiencyPct <= 100);
  assert.ok(t.optimizedNetUsd > t.naiveManualNetUsd);

  // High Ethereum gas (28 gwei vs 15 gwei target) triggers wait recommendation
  assert.equal(report.gasTiming.primary.chain, 'ethereum');
  assert.equal(report.gasTiming.primary.currentGwei, 28);
  assert.equal(report.gasTiming.primary.targetMaxGwei, 15);
  assert.equal(report.gasTiming.primary.shouldWait, true);
  assert.ok(report.gasTiming.primary.estimatedWaitSavingsUsd > 0);
  assert.ok(report.gasTiming.primary.immediateGasUsd > report.gasTiming.primary.targetWindowGasUsd);
});

test('Live gas-timing uses injectable gasPriceFetcher and reports favorable window when <= target gwei', async () => {
  const scan = makeScanReport([
    makeAsset({
      id: 'eth:weth',
      chain: 'ethereum',
      chainName: 'Ethereum',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      symbol: 'WETH',
      grossUsd: 2500,
    }),
  ]);

  const lowGasReport = await evaluatePreservationPlan(scan, {
    maxBaseFeeGwei: 15,
    gasPriceFetcher: async () => 9.5,
  });

  assert.equal(lowGasReport.gasTiming.primary.source, 'live_rpc');
  assert.equal(lowGasReport.gasTiming.primary.currentGwei, 9.5);
  assert.equal(lowGasReport.gasTiming.primary.shouldWait, false);
  assert.equal(lowGasReport.gasTiming.primary.estimatedWaitSavingsUsd, 0);
});

test('Unlock & Claim Schedule surfaces locked DeFi positions and attested CCTP legs sorted earliest-first', async () => {
  const now = Date.UTC(2026, 10, 25, 12, 0, 0);
  const scan = makeScanReport([
    makeAsset({
      id: 'eth:ve-locked',
      chain: 'ethereum',
      chainName: 'Ethereum',
      kind: 'defi_position',
      protocol: 'Ethena Staking',
      symbol: 'sUSDe',
      grossUsd: 1200,
      defiUnlockAt: Math.floor((now + 48 * 3600 * 1000) / 1000), // 48h in seconds
    }),
    makeAsset({
      id: 'base:ready-claim',
      chain: 'base',
      chainName: 'Base',
      kind: 'defi_position',
      protocol: 'Aerodrome Lock',
      symbol: 'veAERO',
      grossUsd: 450,
      defiUnlockAt: now - 60_000, // already unlocked (ms timestamp)
    }),
  ]);

  const report = await evaluatePreservationPlan(scan, {
    nowMs: now,
    liveGasGweiByChain: { ethereum: 10 },
    attestedCctpLegs: [
      {
        chain: 'arbitrum',
        amountUsdc: 2_500,
        txHash: '0x' + 'ab'.repeat(32),
        attestationStatus: 'complete',
      },
      {
        chain: 'ethereum',
        amountUsdc: 1_000,
        txHash: '0x' + 'cd'.repeat(32),
        attestationStatus: 'pending_confirmations',
        estimatedReadyAt: now + 600_000,
      },
    ],
  });

  assert.equal(report.unlockSchedule.length, 4);
  // Sorted earliest first: already unlocked DeFi -> complete CCTP -> pending CCTP -> 48h locked DeFi
  assert.equal(report.unlockSchedule[0].symbol, 'veAERO');
  assert.equal(report.unlockSchedule[0].status, 'ready_to_claim');
  assert.equal(report.unlockSchedule[1].kind, 'cctp_claim');
  assert.equal(report.unlockSchedule[1].status, 'ready_to_claim');
  assert.equal(report.unlockSchedule[2].kind, 'cctp_claim');
  assert.equal(report.unlockSchedule[2].status, 'attestation_pending');
  assert.equal(report.unlockSchedule[3].symbol, 'sUSDe');
  assert.equal(report.unlockSchedule[3].status, 'locked_waiting');
  assert.ok(report.unlockSchedule[3].secondsRemaining > 170_000);
});

test('Gas-Window Watchdog triggers enforce watching -> ready transition, fail-closed mandate safety, expiration, and LRU cap (50)', () => {
  let fakeNow = Date.UTC(2026, 10, 25, 12, 0, 0);
  const store = new PreservationAgentStore({ nowMs: () => fakeNow });
  assert.equal(store.capacity, 50);

  const t1 = store.createTrigger({
    sourceWallet: EVM_WALLET,
    solanaDestination: SOL_DEST,
    chain: 'ethereum',
    maxBaseFeeGwei: 15,
    estimatedSavingsUsd: 12.4,
  });
  assert.equal(t1.status, 'watching');
  assert.equal(t1.autoExecuteAllowed, false);

  // Above threshold (15.1 gwei) -> remains watching
  const evalHigh = store.evaluateGasWatchTriggers({ ethereum: 15.1 });
  assert.equal(evalHigh.transitionedToReady.length, 0);
  assert.equal(store.getTrigger(t1.id)?.status, 'watching');

  // At or below threshold (15.0 gwei) -> transitions to ready, STILL fail-closed without mandate!
  const evalHit = store.evaluateGasWatchTriggers({ ethereum: 15.0 });
  assert.equal(evalHit.transitionedToReady.length, 1);
  const readyT1 = store.getTrigger(t1.id)!;
  assert.equal(readyT1.status, 'ready');
  assert.equal(readyT1.autoExecuteAllowed, false);
  assert.ok(readyT1.readyAt);

  // With a mandateId, autoExecuteAllowed ONLY flips true when mandateValidator passes
  const t2 = store.createTrigger({
    sourceWallet: EVM_WALLET,
    solanaDestination: SOL_DEST,
    chain: 'ethereum',
    maxBaseFeeGwei: 18,
    mandateId: 'mnd_valid_1',
  });
  store.evaluateGasWatchTriggers({ ethereum: 14 }, { mandateValidator: () => false });
  assert.equal(store.getTrigger(t2.id)?.status, 'ready');
  assert.equal(store.getTrigger(t2.id)?.autoExecuteAllowed, false);

  store.evaluateGasWatchTriggers(
    { ethereum: 14 },
    { mandateValidator: (id) => id === 'mnd_valid_1' }
  );
  assert.equal(store.getTrigger(t2.id)?.autoExecuteAllowed, true);

  // Cancel disables trigger & autoExecuteAllowed
  const cancelled = store.cancelTrigger(t2.id)!;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.autoExecuteAllowed, false);

  // Standalone pure evaluator also transitions & enforces fail-closed safety
  const standalone = evaluateGasWatchTriggers([t1], { ethereum: 11 }, { nowMs: fakeNow });
  assert.equal(standalone[0].status, 'ready');
  assert.equal(standalone[0].autoExecuteAllowed, false);

  // Expiration check
  const tExp = store.createTrigger({
    sourceWallet: EVM_WALLET,
    solanaDestination: SOL_DEST,
    chain: 'ethereum',
    maxBaseFeeGwei: 10,
    ttlHours: 2,
  });
  fakeNow += 3 * 3600 * 1000;
  store.evaluateGasWatchTriggers({ ethereum: 8 });
  assert.equal(store.getTrigger(tExp.id)?.status, 'expired');

  // Bounded LRU capacity cap (50) evicts oldest triggers cleanly
  const lruStore = new PreservationAgentStore({ nowMs: () => fakeNow });
  const ids: string[] = [];
  for (let i = 0; i < 55; i += 1) {
    const tr = lruStore.createTrigger({
      sourceWallet: EVM_WALLET,
      solanaDestination: SOL_DEST,
      chain: 'ethereum',
      maxBaseFeeGwei: 15,
    });
    ids.push(tr.id);
  }
  assert.equal(lruStore.size, 50);
  assert.equal(lruStore.getTrigger(ids[0]), null);
  assert.equal(lruStore.getTrigger(ids[4]), null);
  assert.ok(lruStore.getTrigger(ids[5]));
  assert.ok(lruStore.getTrigger(ids[54]));

  // Strict input validation rejects malformed wallets, zero addresses, and invalid gwei
  assert.throws(() =>
    store.createTrigger({
      sourceWallet: 'not-an-address',
      solanaDestination: SOL_DEST,
      maxBaseFeeGwei: 15,
    })
  );
  assert.throws(() =>
    store.createTrigger({
      sourceWallet: '0x0000000000000000000000000000000000000000',
      solanaDestination: SOL_DEST,
      maxBaseFeeGwei: 15,
    })
  );
  assert.throws(() =>
    store.createTrigger({
      sourceWallet: EVM_WALLET,
      solanaDestination: 'invalid-solana!',
      maxBaseFeeGwei: 15,
    })
  );
  assert.throws(() =>
    store.createTrigger({
      sourceWallet: EVM_WALLET,
      solanaDestination: SOL_DEST,
      maxBaseFeeGwei: 0,
    })
  );
  assert.throws(() =>
    store.createTrigger({
      sourceWallet: EVM_WALLET,
      solanaDestination: SOL_DEST,
      maxBaseFeeGwei: Number.NaN,
    })
  );
  assert.throws(() =>
    store.createTrigger({
      sourceWallet: EVM_WALLET,
      solanaDestination: SOL_DEST,
      maxBaseFeeGwei: 501,
    })
  );
});

test('Dust Auto-Harvest Evaluator blocks tiny $1 dust and approves efficient batched dust (>= $10 & >= 85% kept)', () => {
  // Tiny $1 dust pile -> must NOT trigger sweep!
  const tinyDustScan = makeScanReport([
    makeAsset({
      id: 'base:tiny1',
      chain: 'base',
      symbol: 'TINY',
      grossUsd: 1.0,
      estimatedGasUsd: 0.05,
      batchedGasUsd: 0.02,
      estimatedSlippageUsd: 0.01,
    }),
  ]);
  const tinyEval = evaluateDustAutoHarvestEligibility(tinyDustScan, {
    minHarvestUsd: 10,
    minPreservationRatePct: 85,
  });
  assert.equal(tinyEval.eligible, false);
  assert.equal(tinyEval.canAutoExecute, false);
  assert.ok(tinyEval.shortfallUsd > 8);

  // Healthy multi-token L2 dust ($24 total on Base, high efficiency) -> eligible!
  const healthyDustScan = makeScanReport([
    makeAsset({
      id: 'base:d1',
      chain: 'base',
      symbol: 'DEGEN',
      grossUsd: 8.5,
      estimatedGasUsd: 0.04,
      batchedGasUsd: 0.015,
      estimatedSlippageUsd: 0.02,
    }),
    makeAsset({
      id: 'base:d2',
      chain: 'base',
      symbol: 'AERO',
      grossUsd: 9.0,
      estimatedGasUsd: 0.04,
      batchedGasUsd: 0.015,
      estimatedSlippageUsd: 0.02,
    }),
    makeAsset({
      id: 'base:d3',
      chain: 'base',
      symbol: 'BRETT',
      grossUsd: 7.0,
      estimatedGasUsd: 0.04,
      batchedGasUsd: 0.015,
      estimatedSlippageUsd: 0.02,
    }),
  ]);
  const healthyNoMandate = evaluateDustAutoHarvestEligibility(healthyDustScan, {
    minHarvestUsd: 10,
    minPreservationRatePct: 85,
    protocolFeeBps: 500,
    hasValidMandate: false,
  });
  assert.equal(healthyNoMandate.eligible, true);
  assert.equal(healthyNoMandate.canAutoExecute, false);
  assert.ok(healthyNoMandate.netBatchedUsd >= 10);
  assert.ok(healthyNoMandate.preservationRatePct >= 85);

  const healthyWithMandate = evaluateDustAutoHarvestEligibility(healthyDustScan, {
    minHarvestUsd: 10,
    minPreservationRatePct: 85,
    protocolFeeBps: 500,
    hasValidMandate: true,
  });
  assert.equal(healthyWithMandate.eligible, true);
  assert.equal(healthyWithMandate.canAutoExecute, true);
});

test('HTTP endpoints /api/optimize/preservation and /api/agents/gas-watch work end-to-end with validation & CSRF guards', async () => {
  let mockEthGwei = 28;
  const { server } = createTurgaliumServer({
    liveGasFetcher: async () => mockEthGwei,
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Scan preset so scanCache has the wallet cached
    const scanRes = await fetch(`${baseUrl}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId: 'veteran_defi' }),
    });
    assert.equal(scanRes.status, 200);
    const scan = (await scanRes.json()) as ScanReport;

    // 2. POST /api/optimize/preservation using cached walletAddress
    const optByWalletRes = await fetch(`${baseUrl}/api/optimize/preservation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: scan.walletAddress, maxBaseFeeGwei: 15 }),
    });
    assert.equal(optByWalletRes.status, 200);
    const optByWallet = (await optByWalletRes.json()) as Awaited<
      ReturnType<typeof evaluatePreservationPlan>
    > & { dustHarvest: { eligible: boolean } };
    assert.ok(optByWallet.totals.totalDollarsPreservedUsd > 0);
    assert.equal(optByWallet.gasTiming.primary.currentGwei, 28);
    assert.equal(optByWallet.gasTiming.primary.shouldWait, true);
    assert.equal(typeof optByWallet.dustHarvest.eligible, 'boolean');

    // 3. POST /api/optimize/preservation with missing scanReport returns 400
    const badOptRes = await fetch(`${baseUrl}/api/optimize/preservation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: '0x0000000000000000000000000000000000009999' }),
    });
    assert.equal(badOptRes.status, 400);

    // 4. POST /api/agents/gas-watch rejects invalid inputs with HTTP 400
    const badGweiRes = await fetch(`${baseUrl}/api/agents/gas-watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWallet: EVM_WALLET,
        solanaDestination: SOL_DEST,
        chain: 'ethereum',
        maxBaseFeeGwei: -10,
      }),
    });
    assert.equal(badGweiRes.status, 400);

    const badAddrRes = await fetch(`${baseUrl}/api/agents/gas-watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWallet: 'invalid_wallet',
        solanaDestination: SOL_DEST,
        chain: 'ethereum',
        maxBaseFeeGwei: 15,
      }),
    });
    assert.equal(badAddrRes.status, 400);

    // 5. CSRF guard blocks cross-origin POST to /api/agents/gas-watch with HTTP 403
    const csrfRes = await fetch(`${baseUrl}/api/agents/gas-watch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil-phishing.example',
      },
      body: JSON.stringify({
        sourceWallet: EVM_WALLET,
        solanaDestination: SOL_DEST,
        chain: 'ethereum',
        maxBaseFeeGwei: 15,
      }),
    });
    assert.equal(csrfRes.status, 403);

    // 6. Create valid gas-window trigger while L1 gas is 28 gwei -> status === 'watching'
    const createRes = await fetch(`${baseUrl}/api/agents/gas-watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWallet: EVM_WALLET,
        solanaDestination: SOL_DEST,
        chain: 'ethereum',
        maxBaseFeeGwei: 15,
        estimatedSavingsUsd: 14.2,
      }),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as {
      id: string;
      status: string;
      autoExecuteAllowed: boolean;
      ethereumGwei: number;
    };
    assert.equal(created.status, 'watching');
    assert.equal(created.autoExecuteAllowed, false);
    assert.equal(created.ethereumGwei, 28);

    // 7. Drop live L1 gas to 12 gwei -> GET /api/agents/gas-watch transitions watching -> ready (fail-closed!)
    mockEthGwei = 12;
    const listRes = await fetch(`${baseUrl}/api/agents/gas-watch`);
    assert.equal(listRes.status, 200);
    const listData = (await listRes.json()) as {
      ethereumGwei: number;
      readyCount: number;
      triggers: Array<{ id: string; status: string; autoExecuteAllowed: boolean }>;
    };
    assert.equal(listData.ethereumGwei, 12);
    assert.equal(listData.readyCount, 1);
    const found = listData.triggers.find((tr) => tr.id === created.id)!;
    assert.equal(found.status, 'ready');
    assert.equal(found.autoExecuteAllowed, false);

    // 8. Linking a mismatched mandate destination fails closed with HTTP 400
    const mandateRes = await fetch(`${baseUrl}/api/agents/mandates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress: EVM_WALLET,
        lockedSolanaRecipient: SOL_DEST_OTHER,
      }),
    });
    assert.equal(mandateRes.status, 200);
    const mandate = (await mandateRes.json()) as { mandateId: string };

    const mismatchMandateTrigger = await fetch(`${baseUrl}/api/agents/gas-watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWallet: EVM_WALLET,
        solanaDestination: SOL_DEST,
        chain: 'ethereum',
        maxBaseFeeGwei: 15,
        mandateId: mandate.mandateId,
      }),
    });
    assert.equal(mismatchMandateTrigger.status, 400);

    // 9. Cancel trigger via POST /api/agents/gas-watch/:id/cancel
    const cancelRes = await fetch(`${baseUrl}/api/agents/gas-watch/${created.id}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(cancelRes.status, 200);
    const cancelled = (await cancelRes.json()) as { status: string; autoExecuteAllowed: boolean };
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.autoExecuteAllowed, false);

    // Unknown trigger returns 404
    const notFoundRes = await fetch(`${baseUrl}/api/agents/gas-watch/gw_nonexistent/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(notFoundRes.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
