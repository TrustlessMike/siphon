import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  prepareBatchExecutions,
  MAX_PREPARE_BATCH_ASSETS,
} from '../src/execution/prepare-batch.js';
import type { PreparedExecution } from '../src/execution/tx-builder.js';
import type { DefiPreflightResult } from '../src/defi/preflight.js';
import { fetchSolanaOverview } from '../src/solana/overview.js';
import {
  clearPriceCache,
  fetchLiveUsdPricesWithStatus,
} from '../src/scanner/prices.js';
import { fetchSolanaWalletBalances } from '../src/scanner/discovery.js';
import { BoundedTtlCache, InFlightCoalescer } from '../src/server/cache.js';
import { createTurgaliumServer } from '../src/server/app.js';
import { TURGALIUM_MCP_TOOLS } from '../src/mcp/server.js';
import {
  buildAiPluginManifest,
  buildOpenApiSpec,
  buildPluginSetupGuide,
} from '../src/agent/plugin-spec.js';
import type { ScannedAsset } from '../src/scanner/types.js';

const VALID_EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const VALID_SOL = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

function makeAsset(overrides: Partial<ScannedAsset> = {}): ScannedAsset {
  return {
    id: overrides.id ?? 'base_usdc_1',
    chain: overrides.chain ?? 'base',
    chainName: overrides.chainName ?? 'Base',
    address: overrides.address ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: overrides.symbol ?? 'USDC',
    name: overrides.name ?? 'USD Coin',
    decimals: overrides.decimals ?? 6,
    kind: overrides.kind ?? 'erc20',
    rawBalance: overrides.rawBalance ?? '500000000',
    uiBalance: overrides.uiBalance ?? 500,
    priceUsd: overrides.priceUsd ?? 1,
    grossUsd: overrides.grossUsd ?? 500,
    liquidityUsd: overrides.liquidityUsd ?? 100_000_000,
    estimatedGasUsd: overrides.estimatedGasUsd ?? 0.05,
    batchedGasUsd: overrides.batchedGasUsd ?? 0.03,
    estimatedSlippageUsd: overrides.estimatedSlippageUsd ?? 0,
    netUsdcSingle: overrides.netUsdcSingle ?? 499.95,
    netUsdcBatched: overrides.netUsdcBatched ?? 499.97,
    action: overrides.action ?? 'BRIDGE_DIRECT_USDC',
    actionReason: overrides.actionReason ?? 'Direct USDC bridge',
    selectedByDefault: overrides.selectedByDefault ?? true,
    honeypotSafe: true,
    ...overrides,
  };
}

function makeStubPrepared(asset: ScannedAsset, netUsd = 499.5, gasUsd = 0.04, txCount = 1): PreparedExecution {
  return {
    assetId: asset.id,
    action: asset.action,
    provider: 'relay',
    chain: asset.chain as PreparedExecution['chain'],
    chainId: 8453,
    chainName: asset.chainName,
    explorerUrl: 'https://basescan.org',
    estimatedOutput: `${netUsd} USDC`,
    estimatedSeconds: 3,
    quotedOutUsd: netUsd + gasUsd,
    liveNetUsd: netUsd,
    estimatedGasUsd: gasUsd,
    estimatedFeeUsd: 0,
    transactions: Array.from({ length: txCount }, (_, idx) => ({
      stepId: `step_${idx}`,
      label: `Step ${idx + 1}`,
      description: 'Execute sweep',
      chain: asset.chain as PreparedExecution['chain'],
      chainId: 8453,
      chainName: asset.chainName,
      explorerUrl: 'https://basescan.org',
      from: VALID_EVM,
      to: '0xa5f565650890fba1824ee0f21ebbbf660a179934',
      data: '0x12345678',
      value: '0x0',
    })),
    notes: [],
  };
}

test('prepareBatchExecutions runs in parallel (bounded concurrency 6), clamps to 12, isolates failures, and runs DeFi preflight', async () => {
  let active = 0;
  let peakConcurrency = 0;
  let preflightCalls = 0;

  // Create 15 assets (should clamp to 12); asset #2 fails; asset #0 is a DeFi position
  const assets: ScannedAsset[] = Array.from({ length: 15 }, (_, i) =>
    makeAsset({
      id: `asset_${i}`,
      symbol: i === 0 ? 'aBasUSDC' : `TOK${i}`,
      kind: i === 0 ? 'defi_position' : 'erc20',
      action: i === 0 ? 'WITHDRAW_AND_BRIDGE' : 'SELL_AND_BRIDGE',
    })
  );

  const start = performance.now();
  const res = await prepareBatchExecutions({
    assets,
    userAddress: VALID_EVM,
    solanaDestination: VALID_SOL,
    outputAsset: 'USDC',
    bridgePreference: 'auto',
    hasSolanaUsdcAta: true,
    includePreflight: true,
    prepareAssetFn: async ({ asset }) => {
      active += 1;
      peakConcurrency = Math.max(peakConcurrency, active);
      await new Promise((r) => setTimeout(r, 35));
      active -= 1;
      if (asset.id === 'asset_2') {
        throw new Error('Transient quote timeout for TOK2');
      }
      return makeStubPrepared(asset, 100, 0.05, asset.id === 'asset_0' ? 2 : 1);
    },
    preflightAssetFn: async ({ asset }) => {
      preflightCalls += 1;
      await new Promise((r) => setTimeout(r, 25));
      return {
        assetId: asset.id,
        chain: 'base',
        symbol: asset.symbol,
        protocol: 'Aave v3',
        defiExitPlan: {
          protocolId: 'aave_v3',
          protocolName: 'Aave v3',
          routeKind: 'protocol_unwind',
          exitStrategy: 'instant_1click_unwind',
          preflightStatus: 'verified',
          preflightReason: 'Verified',
          plainEnglishSteps: ['Withdraw and bridge'],
          cooldownDetected: false,
        },
        simulatedCalls: [],
        canExecute1Click: true,
        blockNumber: 123456,
      } as DefiPreflightResult;
    },
  });
  const elapsedMs = performance.now() - start;

  assert.equal(res.count, MAX_PREPARE_BATCH_ASSETS, 'Must clamp batch to max 12 assets');
  assert.equal(res.readyCount, 11);
  assert.equal(res.failedCount, 1);
  assert.equal(res.totalProtocolFeeUsd, 0);
  assert.equal(res.totalNetUsd, 1100);
  assert.equal(res.totalGasUsd, 0.55);
  assert.equal(res.totalSignatures, 12); // asset_0 has 2 + 10 others have 1
  assert.equal(preflightCalls, 1, 'Only DeFi asset should run preflight');
  assert.ok(peakConcurrency >= 2 && peakConcurrency <= 6, `Expected concurrency in [2, 6], got ${peakConcurrency}`);
  // 12 items x 35ms serially would be >= 420ms; at concurrency 6 it completes in ~70–140ms
  assert.ok(elapsedMs < 320, `Parallel batch should beat serial waterfall (took ${Math.round(elapsedMs)}ms)`);

  const failedItem = res.items.find((i) => i.assetId === 'asset_2')!;
  assert.equal(failedItem.ok, false);
  assert.match(failedItem.error ?? '', /Transient quote timeout/i);
  const defiItem = res.items.find((i) => i.assetId === 'asset_0')!;
  assert.equal(defiItem.ok, true);
  assert.equal(defiItem.preflight?.canExecute1Click, true);
});

test('fetchSolanaOverview fetches balances, dust, and live yield strategies in parallel and degrades gracefully on RPC failure', async () => {
  const start = performance.now();
  const okOverview = await fetchSolanaOverview({
    address: VALID_SOL,
    dustMaxUsd: 40,
    dustOutputAsset: 'SOL',
    fetchBalancesFn: async (address) => {
      await new Promise((r) => setTimeout(r, 40));
      return {
        address,
        solBalance: 1.5,
        usdcBalance: 250,
        hasUsdcAta: true,
        slot: 300_000_000,
        checkedAt: new Date().toISOString(),
      };
    },
    scanDustFn: async (address) => {
      await new Promise((r) => setTimeout(r, 40));
      return {
        scanVersion: 'turgalium-solana-spl-dust-scan-v1',
        ownerAddress: address,
        programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        maxDustUsd: 40,
        minDustUsd: 0.01,
        totalTokenAccountsScanned: 5,
        dustCount: 2,
        skippedProtectedCount: 2,
        skippedZeroBalanceCount: 1,
        skippedFrozenCount: 0,
        skippedUncloseableCount: 0,
        skippedAboveMaxUsdCount: 0,
        skippedBelowMinUsdCount: 0,
        totalDustUsd: 12.5,
        reclaimableRentLamports: 4_078_560,
        reclaimableRentSol: 0.00407856,
        reclaimableRentUsd: 0.61,
        totalEstimatedRecoveryUsd: 13.11,
        solPriceUsd: 150,
        solPriceSource: 'live',
        dustAccounts: [],
      };
    },
    fetchYieldStrategiesFn: async () => {
      await new Promise((r) => setTimeout(r, 40));
      return [
        {
          id: 'jupiter_lend_usdc',
          name: 'Jupiter Lend USDC (jlUSDC)',
          protocol: 'Jupiter Lend',
          symbol: 'jlUSDC',
          outputMint: '9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D',
          outputDecimals: 6,
          assetClass: 'usdc_savings',
          executionMode: 'vault_deposit_preview',
          baselineApyPct: 7.4,
          apyRangePct: [5.5, 9.5],
          riskTier: 'low',
          preservesUsdPeg: true,
          description: 'Principal-safe USDC yield',
          appUrl: 'https://jup.ag/lend/earn',
          estimatedApyPct: 8.1,
          apySource: 'live',
        },
      ];
    },
  });
  const elapsedMs = performance.now() - start;

  assert.equal(okOverview.address, VALID_SOL);
  assert.equal(okOverview.dustOutputAsset, 'SOL');
  assert.equal(okOverview.rpcUnavailable, false);
  assert.equal(okOverview.balances?.usdcBalance, 250);
  assert.equal(okOverview.dust?.dustCount, 2);
  assert.equal(okOverview.yieldStrategies.length, 1);
  // 3 x 40ms in parallel should finish well under 110ms (vs 120ms+ serial)
  assert.ok(elapsedMs < 110, `Expected parallel Solana overview <110ms, got ${Math.round(elapsedMs)}ms`);

  // Graceful degradation when Solana RPC is unavailable
  const degraded = await fetchSolanaOverview({
    address: VALID_SOL,
    fetchBalancesFn: async () => {
      throw new Error('Solana RPC 503');
    },
    scanDustFn: async () => {
      throw new Error('Solana RPC timeout');
    },
    fetchYieldStrategiesFn: async () => [],
  });
  assert.equal(degraded.rpcUnavailable, true);
  assert.equal(degraded.balances, null);
  assert.equal(degraded.dust, null);
});

test('InFlightCoalescer & fetchLiveUsdPricesWithStatus deduplicate concurrent upstream calls and honor refresh:true', async () => {
  let now = 1_000_000;
  const cache = new BoundedTtlCache<string, number>({
    maxEntries: 16,
    ttlMs: 10_000,
    nowMs: () => now,
  });
  const coalescer = new InFlightCoalescer<string, number>(cache);

  let upstreamCalls = 0;
  const factory = async () => {
    upstreamCalls += 1;
    await new Promise((r) => setTimeout(r, 25));
    return upstreamCalls * 100;
  };

  // 5 concurrent callers -> 1 upstream call
  const burst = await Promise.all(
    Array.from({ length: 5 }, () => coalescer.run('k1', factory))
  );
  assert.equal(upstreamCalls, 1);
  assert.ok(burst.every((r) => r.value === 100));
  assert.equal(burst.filter((r) => r.coalesced).length, 4);

  // Subsequent call hits TTL cache -> still 1 upstream call
  const cachedHit = await coalescer.run('k1', factory);
  assert.equal(cachedHit.cached, true);
  assert.equal(cachedHit.value, 100);
  assert.equal(upstreamCalls, 1);

  // refresh: true bypasses TTL cache -> 2nd upstream call
  const refreshed = await coalescer.run('k1', factory, { refresh: true });
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.value, 200);
  assert.equal(upstreamCalls, 2);

  // DeFiLlama price coalescing: 4 concurrent calls for the same uncached key trigger only 1 fetch
  clearPriceCache();
  const origFetch = globalThis.fetch;
  let llamaCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('coins.llama.fi')) {
      llamaCalls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(
        JSON.stringify({ coins: { 'coingecko:solana': { price: 175.5 } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    throw new Error(`Unexpected fetch ${url}`);
  }) as typeof fetch;

  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => fetchLiveUsdPricesWithStatus(['coingecko:solana']))
    );
    assert.equal(llamaCalls, 1, 'Concurrent DeFiLlama calls must coalesce into 1 HTTP request');
    for (const r of results) {
      assert.equal(r.prices.get('coingecko:solana'), 175.5);
    }

    // refresh: true bypasses priceCache
    const fresh = await fetchLiveUsdPricesWithStatus(['coingecko:solana'], { refresh: true });
    assert.equal(llamaCalls, 2);
    assert.equal(fresh.prices.get('coingecko:solana'), 175.5);
  } finally {
    globalThis.fetch = origFetch;
    clearPriceCache();
  }

  // fetchSolanaWalletBalances in-flight coalescing
  let solRpcCalls = 0;
  globalThis.fetch = (async () => {
    solRpcCalls += 1;
    await new Promise((r) => setTimeout(r, 30));
    return new Response(
      JSON.stringify([
        { jsonrpc: '2.0', id: 1, result: { context: { slot: 999 }, value: 2_000_000_000 } },
        { jsonrpc: '2.0', id: 2, result: { value: [] } },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;
  try {
    const solBurst = await Promise.all([
      fetchSolanaWalletBalances(VALID_SOL),
      fetchSolanaWalletBalances(VALID_SOL),
      fetchSolanaWalletBalances(VALID_SOL),
    ]);
    assert.equal(solRpcCalls, 1, 'Concurrent Solana balance calls must coalesce into 1 RPC');
    assert.equal(solBurst[0].solBalance, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('HTTP endpoints: POST /api/tx/prepare-batch, POST /api/solana/overview, enhanced /api/workspace/hydrate, and zero gambling/degen surface', async () => {
  const { server } = createTurgaliumServer({
    enableBackgroundPollers: false,
    rateLimit: { enabled: false },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const origFetch = globalThis.fetch;
  let solanaOverviewRpcCalls = 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(base)) {
      return origFetch(input, init);
    }
    if (url.includes('solana')) {
      solanaOverviewRpcCalls += 1;
      const bodyStr = String(init?.body ?? '');
      if (bodyStr.startsWith('[')) {
        return new Response(
          JSON.stringify([
            { jsonrpc: '2.0', id: 1, result: { context: { slot: 400_000_000 }, value: 1_250_000_000 } },
            {
              jsonrpc: '2.0',
              id: 2,
              result: {
                value: [
                  {
                    account: {
                      data: { parsed: { info: { tokenAmount: { uiAmount: 420.5 } } } },
                    },
                  },
                ],
              },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('lend/v1/earn/tokens')) {
      return new Response(
        JSON.stringify([{ symbol: 'jlUSDC', assetAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', totalRate: 785 }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('api.kamino.finance')) {
      return new Response(
        JSON.stringify([{ liquidityToken: 'USDC', supplyApy: 0.071 }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('coins.llama.fi')) {
      return new Response(
        JSON.stringify({ coins: { 'coingecko:solana': { price: 160 } } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('api.relay.link')) {
      return new Response(
        JSON.stringify({
          steps: [
            {
              id: 'deposit',
              kind: 'transaction',
              requestId: 'req_batch_1',
              items: [
                {
                  data: {
                    from: VALID_EVM,
                    to: '0xa5f565650890fba1824ee0f21ebbbf660a179934',
                    data: '0xdeadbeef00000000000000000000000000000000000000000000000000000001',
                    value: '0x0',
                    gas: '0x30d40',
                    chainId: 8453,
                  },
                },
              ],
            },
          ],
          details: {
            currencyOut: { amountUsd: '499.2', amountFormatted: '499.2', currency: { symbol: 'USDC' } },
            timeEstimate: 4,
          },
          fees: { gas: { amountUsd: '0.04' }, relayer: { amountUsd: '0.25' } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    // 1. All /api/degen/* routes MUST be gone (404)
    for (const [method, ep] of [
      ['GET', '/api/degen/markets'],
      ['GET', '/api/degen/search?q=sol'],
      ['POST', '/api/degen/order-preview'],
      ['GET', `/api/degen/positions?owner=${VALID_SOL}`],
    ] as const) {
      const r = await fetch(`${base}${ep}`, {
        method,
        ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      });
      assert.equal(r.status, 404, `${method} ${ep} must return 404`);
    }

    // 2. OpenAPI, AI Plugin Manifest, Setup Guide, and MCP tools MUST contain zero gambling/degen/prediction-market text
    const bannedRe = /degen|gambl|side-pocket|side_pocket|jup\.ag\/prediction|prediction market/i;
    const openapiRes = await fetch(`${base}/openapi.json`);
    assert.equal(openapiRes.status, 200);
    const openapiText = await openapiRes.text();
    assert.equal(bannedRe.test(openapiText), false, 'OpenAPI spec must have zero gambling/degen content');

    const manifestRes = await fetch(`${base}/.well-known/ai-plugin.json`);
    assert.equal(manifestRes.status, 200);
    const manifestText = await manifestRes.text();
    assert.equal(bannedRe.test(manifestText), false, 'AI plugin manifest must have zero gambling/degen content');

    assert.equal(
      bannedRe.test(JSON.stringify(TURGALIUM_MCP_TOOLS)),
      false,
      'MCP tools must have zero gambling/degen content'
    );
    assert.equal(
      bannedRe.test(JSON.stringify(buildAiPluginManifest(base))),
      false
    );
    assert.equal(
      bannedRe.test(JSON.stringify(buildOpenApiSpec(base))),
      false
    );
    assert.equal(
      bannedRe.test(JSON.stringify(buildPluginSetupGuide({ baseUrl: base, rootDir: process.cwd() }))),
      false
    );

    // 3. POST /api/solana/overview returns balances + dust + live yield strategies in 1 call & caches
    const ov1 = await fetch(`${base}/api/solana/overview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: VALID_SOL, dustMaxUsd: 25, dustOutputAsset: 'USDC' }),
    });
    assert.equal(ov1.status, 200);
    const ovData = (await ov1.json()) as {
      address: string;
      durationMs: number;
      balances: { solBalance: number; usdcBalance: number; hasUsdcAta: boolean } | null;
      dust: { dustCount: number } | null;
      yieldStrategies: Array<{ id: string; estimatedApyPct: number; apySource: string }>;
      rpcUnavailable: boolean;
    };
    assert.equal(ovData.address, VALID_SOL);
    assert.ok(ovData.durationMs >= 1);
    assert.equal(ovData.rpcUnavailable, false);
    assert.equal(ovData.balances?.solBalance, 1.25);
    assert.equal(ovData.balances?.usdcBalance, 420.5);
    assert.equal(ovData.balances?.hasUsdcAta, true);
    assert.equal(ovData.dust?.dustCount, 0);
    assert.equal(ovData.yieldStrategies.length, 3);
    assert.equal(ovData.yieldStrategies.find((s) => s.id === 'jupiter_lend_usdc')?.estimatedApyPct, 7.85);

    const rpcCallsAfterFirst = solanaOverviewRpcCalls;
    // Cached repeat call makes 0 new Solana RPC calls
    const ov2 = await fetch(`${base}/api/solana/overview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: VALID_SOL, dustMaxUsd: 25, dustOutputAsset: 'USDC' }),
    });
    assert.equal(ov2.status, 200);
    assert.equal(solanaOverviewRpcCalls, rpcCallsAfterFirst, 'Cached /api/solana/overview must not hit RPC again');

    // refresh: true bypasses cache
    const ov3 = await fetch(`${base}/api/solana/overview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: VALID_SOL, dustMaxUsd: 25, dustOutputAsset: 'USDC', refresh: true }),
    });
    assert.equal(ov3.status, 200);
    assert.ok(solanaOverviewRpcCalls > rpcCallsAfterFirst, 'refresh:true must bypass Solana overview cache');

    // Invalid Solana address -> 400
    const badOv = await fetch(`${base}/api/solana/overview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: 'not-a-solana-pubkey' }),
    });
    assert.equal(badOv.status, 400);

    // 4. Enhanced POST /api/workspace/hydrate returns timingMs + optional solanaOverview
    const hydRes = await fetch(`${base}/api/workspace/hydrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        presetId: 'veteran_defi',
        solanaDestination: VALID_SOL,
        outputAsset: 'USDC',
        includeSolanaOverview: true,
      }),
    });
    assert.equal(hydRes.status, 200);
    const hyd = (await hydRes.json()) as {
      timingMs: { total: number; scan: number; plan: number; solana: number };
      scan: { assets: Array<{ symbol: string; name: string }> };
      plan: { totals: { protocolFeeUsd: number } };
      solanaBalances: { usdcBalance: number } | null;
      solanaOverview: { address: string; yieldStrategies: unknown[] } | null;
    };
    assert.ok(hyd.timingMs && typeof hyd.timingMs.total === 'number' && hyd.timingMs.total >= 1);
    assert.equal(typeof hyd.timingMs.scan, 'number');
    assert.equal(typeof hyd.timingMs.plan, 'number');
    assert.equal(typeof hyd.timingMs.solana, 'number');
    assert.equal(hyd.plan.totals.protocolFeeUsd, 0);
    assert.equal(hyd.solanaBalances?.usdcBalance, 420.5);
    assert.equal(hyd.solanaOverview?.address, VALID_SOL);
    assert.equal(hyd.solanaOverview?.yieldStrategies.length, 3);
    // Preset scan MUST contain zero DEGEN/gambling tokens
    assert.equal(
      hyd.scan.assets.some((a) => bannedRe.test(`${a.symbol} ${a.name}`)),
      false,
      'Preset scan assets must not render gambling/degen copy into UI'
    );

    // 5. POST /api/tx/prepare-batch executes cleanly and rejects feeRecipientEvm override
    const batchRes = await fetch(`${base}/api/tx/prepare-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assets: [makeAsset({ id: 'base_usdc_a' }), makeAsset({ id: 'base_usdc_b' })],
        userAddress: VALID_EVM,
        solanaDestination: VALID_SOL,
        outputAsset: 'USDC',
        bridgePreference: 'relay',
        hasSolanaUsdcAta: true,
        includePreflight: false,
      }),
    });
    assert.equal(batchRes.status, 200);
    const batch = (await batchRes.json()) as {
      preparedAt: string;
      durationMs: number;
      count: number;
      readyCount: number;
      failedCount: number;
      totalNetUsd: number;
      totalGasUsd: number;
      totalProtocolFeeUsd: number;
      totalSignatures: number;
      items: Array<{ assetId: string; ok: boolean }>;
    };
    assert.ok(batch.preparedAt);
    assert.equal(batch.count, 2);
    assert.equal(batch.readyCount, 2);
    assert.equal(batch.failedCount, 0);
    assert.equal(batch.totalProtocolFeeUsd, 0);
    assert.equal(batch.totalSignatures, 2);
    assert.ok(batch.totalNetUsd > 990);

    // feeRecipientEvm override MUST fail closed (400)
    const spoofFeeRes = await fetch(`${base}/api/tx/prepare-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assets: [makeAsset()],
        userAddress: VALID_EVM,
        solanaDestination: VALID_SOL,
        feeRecipientEvm: '0x0000000000000000000000000000000000001234',
      }),
    });
    assert.equal(spoofFeeRes.status, 400);
  } finally {
    globalThis.fetch = origFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
