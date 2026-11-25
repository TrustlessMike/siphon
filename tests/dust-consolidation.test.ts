import test from 'node:test';
import assert from 'node:assert/strict';
import { planDustConversion } from '../src/scanner/dust.js';
import {
  prepareChainBatchExecution,
  type MultiInputSwapQuoteFn,
  type FollowUpQuoteFn,
} from '../src/execution/tx-builder.js';
import { buildGaslessSweepIntent } from '../src/relayer/sponsor.js';
import { createSiphonServer } from '../src/server/app.js';
import type { ScannedAsset, ScanReport } from '../src/scanner/types.js';

const USER_EVM = '0x1111111111111111111111111111111111111111';
const SOL_DEST = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ENSO_ROUTER = '0x80EbA3855878739F4710233A8a19d89Bdd2ffB8E';

function makeBaseDustAsset(overrides: Partial<ScannedAsset> & { id: string; symbol: string; address: string; grossUsd: number }): ScannedAsset {
  return {
    id: overrides.id,
    family: 'evm',
    chain: 'base',
    chainName: 'Base',
    address: overrides.address,
    symbol: overrides.symbol,
    name: overrides.name ?? overrides.symbol,
    decimals: overrides.decimals ?? 18,
    kind: overrides.kind ?? 'erc20',
    rawBalance: overrides.rawBalance ?? '10000000000000000000',
    uiBalance: overrides.uiBalance ?? 10,
    priceUsd: overrides.priceUsd ?? overrides.grossUsd / 10,
    grossUsd: overrides.grossUsd,
    liquidityUsd: overrides.liquidityUsd ?? 250_000,
    estimatedGasUsd: overrides.estimatedGasUsd ?? 0.03,
    batchedGasUsd: overrides.batchedGasUsd ?? 0.015,
    estimatedSlippageUsd: overrides.estimatedSlippageUsd ?? 0.05,
    netUsdcSingle: overrides.netUsdcSingle ?? overrides.grossUsd - 0.5,
    netUsdcBatched: overrides.netUsdcBatched ?? overrides.grossUsd - 0.2,
    action: overrides.action ?? 'SELL_AND_BRIDGE',
    actionReason: overrides.actionReason ?? 'Liquid dust token',
    selectedByDefault: true,
    honeypotSafe: true,
    permit2Approved: overrides.permit2Approved ?? false,
    eip2612Supported: overrides.eip2612Supported ?? false,
  };
}

function makeScanReport(assets: ScannedAsset[]): ScanReport {
  const gross = assets.reduce((s, a) => s + a.grossUsd, 0);
  return {
    scanId: 'scan_dust_opt_test',
    family: 'evm',
    mode: 'preset',
    walletAddress: USER_EVM,
    scannedAt: new Date().toISOString(),
    scanDurationMs: 12,
    chainsScanned: 1,
    chains: [
      {
        family: 'evm',
        chain: 'base',
        chainName: 'Base',
        chainId: 8453,
        cctpDomain: 6,
        rpcStatus: 'preset',
        blockNumber: 25_000_000,
        gasPriceGwei: 0.05,
        nativeBalance: 0.05,
        nativeSymbol: 'ETH',
        nativePriceUsd: 3000,
        assetCount: assets.length,
        defiCount: 0,
        liquidCount: assets.length,
        burnCount: 0,
        skippedCount: 0,
        grossUsd: gross,
        netUsdcBridged: gross * 0.9,
        totalGasUsd: 0.12,
        gasSavedByBatchUsd: 0.06,
        cctpAttestationSec: 15,
        needsGasSponsorship: false,
      },
    ],
    assets,
    totals: {
      grossUsd: gross,
      defiGrossUsd: 0,
      liquidGrossUsd: gross,
      protocolFeeBps: 700,
      protocolFeeUsd: Number((gross * 0.07).toFixed(2)),
      singleTxGasUsd: 0.25,
      batchedGasUsd: 0.1,
      gasSavedUsd: 0.15,
      estimatedSlippageUsd: 0.1,
      netSolanaUsdc: Number((gross * 0.9).toFixed(2)),
      solEquivalent: Number(((gross * 0.9) / 150).toFixed(4)),
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

test('Two-Lane Dust Planner partitions Permit2/EIP-2612 instant 1-sig vs legacy multi-input swap and computes signature savings', () => {
  const assets: ScannedAsset[] = [
    makeBaseDustAsset({
      id: 'base:p2_a',
      symbol: 'DEGEN',
      address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
      grossUsd: 8,
      permit2Approved: true,
    }),
    makeBaseDustAsset({
      id: 'base:p2_b',
      symbol: 'BRETT',
      address: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
      grossUsd: 7,
      permit2Approved: true,
    }),
    makeBaseDustAsset({
      id: 'base:eip2612_aero',
      symbol: 'AERO',
      address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
      grossUsd: 9,
      eip2612Supported: true,
    }),
    makeBaseDustAsset({
      id: 'base:legacy_1',
      symbol: 'TOSHI',
      address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
      grossUsd: 6,
    }),
    makeBaseDustAsset({
      id: 'base:legacy_2',
      symbol: 'WELL',
      address: '0xA88594D404727625A9437C3f886C7643872296AE',
      grossUsd: 5,
    }),
    makeBaseDustAsset({
      id: 'base:legacy_3',
      symbol: 'VIRTUAL',
      address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
      grossUsd: 6,
    }),
    // Microscopic negative-ROI dust should be skipped
    makeBaseDustAsset({
      id: 'base:micro_skip',
      symbol: 'PENNY',
      address: '0x2222222222222222222222222222222222222222',
      grossUsd: 0.02,
      liquidityUsd: 500,
    }),
  ];

  const plan = planDustConversion({ scan: makeScanReport(assets), hasSolanaUsdcAta: true });
  assert.equal(plan.convertibleCount, 6);
  assert.equal(plan.skippedUnprofitableCount, 1);
  assert.equal(plan.instantSingleSigCount, 3);
  assert.equal(plan.multiInputSwapCount, 3);
  assert.deepEqual(
    plan.instantSingleSigAssetIds.sort(),
    ['base:eip2612_aero', 'base:p2_a', 'base:p2_b']
  );
  assert.deepEqual(
    plan.multiInputSwapAssetIds.sort(),
    ['base:legacy_1', 'base:legacy_2', 'base:legacy_3']
  );

  // 6 ERC-20s naive = 12 EOA popups; Two-lane = 1 instant EIP-712 + (3 approves + 1 multi-swap + 1 bridge) = 6
  assert.equal(plan.totalNaiveLegacySignatures, 12);
  assert.equal(plan.totalOptimizedLegacySignatures, 6);
  assert.equal(plan.totalSignaturesEliminated, 6);
  assert.equal(plan.totalEip5792Signatures, 1);
  assert.equal(plan.chains[0].recommendedExecutionLane, 'hybrid_single_sig_and_multi_swap');
  assert.equal(plan.chains[0].permit2ReadyCount, 2);
  assert.equal(plan.chains[0].eip2612Count, 1);

  // Pure Permit2/EIP-2612 batch collapses to 1 single signature
  const pureInstant = planDustConversion({
    scan: makeScanReport(assets.slice(0, 3)),
    hasSolanaUsdcAta: true,
  });
  assert.equal(pureInstant.chains[0].recommendedExecutionLane, 'instant_single_sig');
  assert.equal(pureInstant.totalNaiveLegacySignatures, 6);
  assert.equal(pureInstant.totalOptimizedLegacySignatures, 1);
  assert.equal(pureInstant.totalSignaturesEliminated, 5);
});

test('prepareChainBatchExecution consolidates N>=2 legacy dust ERC-20s into 1 multi-input swap + 1 bridge and skips existing allowances', async () => {
  const dustAssets = [
    makeBaseDustAsset({
      id: 'base:t1',
      symbol: 'TOSHI',
      address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
      grossUsd: 10,
      rawBalance: '100000000000000000000',
    }),
    makeBaseDustAsset({
      id: 'base:t2',
      symbol: 'WELL',
      address: '0xA88594D404727625A9437C3f886C7643872296AE',
      grossUsd: 10,
      rawBalance: '200000000000000000000',
    }),
    makeBaseDustAsset({
      id: 'base:t3',
      symbol: 'VIRTUAL',
      address: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b',
      grossUsd: 10,
      rawBalance: '300000000000000000000',
    }),
    makeBaseDustAsset({
      id: 'base:t4',
      symbol: 'BRETT',
      address: '0x532f27101965dd16442E59d40670FaF5eBB142E4',
      grossUsd: 10,
      rawBalance: '400000000000000000000',
      permit2Approved: true,
    }),
  ];

  const mockMultiSwap: MultiInputSwapQuoteFn = async ({ assets }) => {
    assert.equal(assets.length, 4);
    return {
      provider: 'enso_multi_input',
      routerAddress: ENSO_ROUTER,
      data: '0x11223344' + '00'.repeat(64),
      value: '0x0',
      outUsdcRaw: '38800000', // $38.80 USDC out on $40 gross
      outUsdcDecimals: 6,
      estimatedGasUsd: 0.04,
      estimatedSeconds: 10,
    };
  };

  let bridgeCalls = 0;
  const mockFollowUpBridge: FollowUpQuoteFn = async (asset) => {
    bridgeCalls += 1;
    assert.equal(asset.address.toLowerCase(), BASE_USDC.toLowerCase());
    assert.equal(asset.rawBalance, '38800000');
    return {
      assetId: asset.id,
      action: 'BRIDGE_DIRECT_USDC',
      provider: 'relay',
      chain: 'base',
      chainId: 8453,
      chainName: 'Base',
      explorerUrl: 'https://basescan.org',
      estimatedOutput: '36.08 USDC',
      estimatedSeconds: 8,
      quotedOutUsd: 36.08,
      estimatedGasUsd: 0.02,
      requestId: 'relay_consolidated_123',
      transactions: [
        {
          stepId: 'deposit',
          label: 'Bridge 38.80 USDC → Solana USDC',
          description: 'Relay consolidated dust bridge',
          chain: 'base',
          chainId: 8453,
          chainName: 'Base',
          explorerUrl: 'https://basescan.org',
          from: USER_EVM,
          to: '0xa5f565650890fba1824ee0f21ebbbf660a179934',
          data: '0xaabbccdd' + '00'.repeat(32),
          value: '0x0',
        },
      ],
      notes: [],
    };
  };

  // Token 1 already has sufficient allowance to ENSO_ROUTER -> its approve call should be skipped!
  const mockAllowance = async ({ tokenAddress }: { tokenAddress: string }) =>
    tokenAddress.toLowerCase() === dustAssets[0].address.toLowerCase()
      ? BigInt(dustAssets[0].rawBalance) * 2n
      : 0n;

  const batch = await prepareChainBatchExecution({
    chain: 'base',
    assets: dustAssets,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    consolidateMultiInputDust: true,
    multiInputSwapQuoteFn: mockMultiSwap,
    followUpQuoteFn: mockFollowUpBridge,
    allowanceCheckFn: mockAllowance,
  });

  assert.equal(bridgeCalls, 1, 'Should invoke single consolidated USDC bridge instead of 4 separate bridges');
  assert.equal(batch.dustConsolidation?.consolidated, true);
  assert.equal(batch.dustConsolidation?.provider, 'enso_multi_input');
  assert.equal(batch.dustConsolidation?.consolidatedTokenCount, 4);
  assert.equal(batch.dustConsolidation?.approvalsSkipped, 1);
  assert.equal(batch.dustConsolidation?.swapPopupsEliminated, 4); // 3 swaps + 1 skipped approval
  assert.equal(batch.dustConsolidation?.instantGaslessCount, 1);
  assert.equal(batch.dustConsolidation?.legacyRequiresApprovalCount, 3);

  // Exact call list: 3 approves + 1 multi_input_dust_swap + 1 consolidated bridge = 5 calls total
  assert.equal(batch.calls.length, 5);
  assert.equal(batch.calls.filter((c) => c.stepId.startsWith('approve_multi_input_')).length, 3);
  assert.equal(batch.calls[3].stepId, 'multi_input_dust_swap');
  assert.equal(batch.calls[3].to, ENSO_ROUTER);
  assert.equal(batch.calls[4].stepId, 'deposit_consolidated_dust');
});

test('Multi-input consolidation fails closed on spoofed router or >50% haircut and falls back to individual routes', async () => {
  const dustAssets = [
    makeBaseDustAsset({
      id: 'base:t1',
      symbol: 'TOSHI',
      address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
      grossUsd: 10,
    }),
    makeBaseDustAsset({
      id: 'base:t2',
      symbol: 'WELL',
      address: '0xA88594D404727625A9437C3f886C7643872296AE',
      grossUsd: 10,
    }),
  ];

  let individualCalls = 0;
  const fallbackQuote: FollowUpQuoteFn = async (asset) => {
    individualCalls += 1;
    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'relay',
      chain: 'base',
      chainId: 8453,
      chainName: 'Base',
      explorerUrl: 'https://basescan.org',
      estimatedOutput: '9.20 USDC',
      estimatedSeconds: 8,
      quotedOutUsd: 9.2,
      estimatedGasUsd: 0.02,
      transactions: [
        {
          stepId: 'deposit',
          label: `Bridge ${asset.symbol}`,
          description: 'Fallback individual bridge',
          chain: 'base',
          chainId: 8453,
          chainName: 'Base',
          explorerUrl: 'https://basescan.org',
          from: USER_EVM,
          to: '0xa5f565650890fba1824ee0f21ebbbf660a179934',
          data: '0xdeadbeef' + '00'.repeat(32),
          value: '0x0',
        },
      ],
      notes: [],
    };
  };

  // Case 1: Spoofed router address equal to userAddress must be rejected
  const spoofedBatch = await prepareChainBatchExecution({
    chain: 'base',
    assets: dustAssets,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    consolidateMultiInputDust: true,
    multiInputSwapQuoteFn: async () => ({
      provider: 'enso_multi_input',
      routerAddress: USER_EVM, // spoofed!
      data: '0x11223344' + '00'.repeat(32),
      value: '0x0',
      outUsdcRaw: '19500000',
      outUsdcDecimals: 6,
    }),
    followUpQuoteFn: fallbackQuote,
    allowanceCheckFn: async () => 0n,
  });

  assert.equal(spoofedBatch.dustConsolidation?.consolidated, false);
  assert.equal(individualCalls, 2);

  // Case 2: Severe haircut (>50% loss: $20 gross -> $8 USDC) must be rejected fail-closed
  individualCalls = 0;
  const haircutBatch = await prepareChainBatchExecution({
    chain: 'base',
    assets: dustAssets,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    consolidateMultiInputDust: true,
    multiInputSwapQuoteFn: async () => ({
      provider: 'enso_multi_input',
      routerAddress: ENSO_ROUTER,
      data: '0x11223344' + '00'.repeat(32),
      value: '0x0',
      outUsdcRaw: '8000000', // $8 out on $20 gross -> 60% haircut!
      outUsdcDecimals: 6,
    }),
    followUpQuoteFn: fallbackQuote,
    allowanceCheckFn: async () => 0n,
  });

  assert.equal(haircutBatch.dustConsolidation?.consolidated, false);
  assert.equal(individualCalls, 2);
});

test('buildGaslessSweepIntent surfaces instantSingleSigBreakdown and supports filterToInstantSingleSig', () => {
  const assets: ScannedAsset[] = [
    makeBaseDustAsset({
      id: 'base:p2',
      symbol: 'DEGEN',
      address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
      grossUsd: 12,
      permit2Approved: true,
    }),
    makeBaseDustAsset({
      id: 'base:eip2612',
      symbol: 'AERO',
      address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
      grossUsd: 11,
      eip2612Supported: true,
    }),
    makeBaseDustAsset({
      id: 'base:legacy',
      symbol: 'TOSHI',
      address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
      grossUsd: 10,
    }),
  ];

  const fullIntent = buildGaslessSweepIntent({
    chain: 'base',
    assets,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
  });
  assert.equal(fullIntent.coveredAssets.length, 3);
  assert.equal(fullIntent.instantSingleSigBreakdown.zeroPopupReadyCount, 2);
  assert.equal(fullIntent.instantSingleSigBreakdown.requiresApprovalCount, 1);
  assert.deepEqual(fullIntent.instantSingleSigBreakdown.permit2ApprovedIds, ['base:p2']);
  assert.deepEqual(fullIntent.instantSingleSigBreakdown.eip2612SupportedIds, ['base:eip2612']);
  assert.deepEqual(fullIntent.instantSingleSigBreakdown.requiresOnchainApprovalIds, ['base:legacy']);

  const instantOnlyIntent = buildGaslessSweepIntent({
    chain: 'base',
    assets,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    filterToInstantSingleSig: true,
  });
  assert.equal(instantOnlyIntent.coveredAssets.length, 2);
  assert.deepEqual(
    instantOnlyIntent.coveredAssets.map((a) => a.id).sort(),
    ['base:eip2612', 'base:p2']
  );
});

test('HTTP /api/dust/plan exposes two-lane signature optimization metrics', async () => {
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    const scan = makeScanReport([
      makeBaseDustAsset({
        id: 'base:p2',
        symbol: 'DEGEN',
        address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed',
        grossUsd: 10,
        permit2Approved: true,
      }),
      makeBaseDustAsset({
        id: 'base:legacy_1',
        symbol: 'TOSHI',
        address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4',
        grossUsd: 8,
      }),
      makeBaseDustAsset({
        id: 'base:legacy_2',
        symbol: 'WELL',
        address: '0xA88594D404727625A9437C3f886C7643872296AE',
        grossUsd: 8,
      }),
    ]);

    const res = await fetch(`${baseUrl}/api/dust/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scan, hasSolanaUsdcAta: true }),
    });
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      instantSingleSigCount: number;
      multiInputSwapCount: number;
      totalSignaturesEliminated: number;
      chains: Array<{ recommendedExecutionLane: string }>;
    };
    assert.equal(json.instantSingleSigCount, 1);
    assert.equal(json.multiInputSwapCount, 2);
    assert.equal(json.totalSignaturesEliminated, 1); // 6 naive -> 1 instant + 4 legacy = 5
    assert.equal(json.chains[0].recommendedExecutionLane, 'hybrid_single_sig_and_multi_swap');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
