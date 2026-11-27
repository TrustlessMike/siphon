import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  fetchDeBridgeDlnQuote,
  runLiveParallelRouteAuction,
  type AuctionExecutableTx,
} from '../src/execution/route-auction.js';
import {
  buildGasRefuelQuote,
  evaluateChainNativeGasStatus,
} from '../src/execution/gas-refuel.js';
import { prepareBatchExecutions } from '../src/execution/prepare-batch.js';
import { getProtocolFeeConfig } from '../src/scanner/chains.js';
import type { ScannedAsset } from '../src/scanner/types.js';
import { createTurgaliumServer } from '../src/server/app.js';

const USER_ADDR = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const SOL_DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const DLN_SOURCE = '0x663dc15d3c1ac63ff12e45ab68fea3f0a883c251';
const RELAY_ROUTER = '0xa5f565650890fba1824ee0f21ebbbf660a179934';
const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const POLYGON_ASSET: ScannedAsset = {
  id: 'polygon:usdc',
  chain: 'polygon',
  chainName: 'Polygon',
  address: POLYGON_USDC,
  symbol: 'USDC',
  name: 'USD Coin',
  decimals: 6,
  kind: 'erc20',
  rawBalance: '100000000', // 100 USDC
  uiBalance: 100,
  priceUsd: 1,
  grossUsd: 100,
  liquidityUsd: 50_000_000,
  action: 'BRIDGE_DIRECT_USDC',
  actionReason: 'Direct bridge to Solana USDC',
  selectedByDefault: true,
  estimatedGasUsd: 0.01,
  batchedGasUsd: 0.01,
  estimatedSlippageUsd: 0.05,
  netUsdcSingle: 99.5,
  netUsdcBatched: 99.5,
  honeypotSafe: true,
};

function mkTx(to: string, stepId: string, value = '0x0'): AuctionExecutableTx {
  return {
    stepId,
    label: stepId,
    description: stepId,
    chain: 'polygon',
    chainId: 137,
    chainName: 'Polygon',
    explorerUrl: 'https://polygonscan.com',
    from: USER_ADDR,
    to,
    data: '0x12345678' + '00'.repeat(32),
    value,
  };
}

test('Wave 24: fetchDeBridgeDlnQuote sets prependOperatingExpenses=false to prevent ERC20 transfer amount exceeds balance', async () => {
  let capturedUrl = '';
  const fakeFetcher = async (url: string) => {
    capturedUrl = url;
    return new Response(
      JSON.stringify({
        orderId: '0xabc',
        fixFee: '500000000000000000', // 0.5 POL
        estimation: {
          dstChainTokenOut: {
            amount: '99100000',
            recommendedAmount: '99100000',
            decimals: 6,
            approximateUsdValue: 99.1,
          },
          costsDetails: [{ type: 'DlnProtocolFee', payload: { feeApproximateUsdValue: '0.15' } }],
        },
        tx: {
          to: DLN_SOURCE,
          data: '0x12345678' + 'aa'.repeat(32),
          value: '500000000000000000',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const quote = await fetchDeBridgeDlnQuote({
    asset: POLYGON_ASSET,
    userAddress: USER_ADDR,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    feeConfig: getProtocolFeeConfig(),
    fetcher: fakeFetcher as unknown as typeof fetch,
    allowanceCheckFn: async () => 10n ** 18n,
  });

  assert.ok(quote, 'Should return quote');
  const parsed = new URL(capturedUrl);
  assert.equal(
    parsed.searchParams.get('prependOperatingExpenses'),
    'false',
    'Must use prependOperatingExpenses=false so 100% balance sweeps never exceed balance'
  );
  assert.equal(parsed.searchParams.get('srcChainTokenInAmount'), '100000000');
});

test('Wave 24: route auction disqualifies deBridge 0.5 POL fixFee when wallet nativeBalanceWei < 0.5 POL and picks $0-msg.value Relay', async () => {
  const res = await runLiveParallelRouteAuction({
    asset: POLYGON_ASSET,
    userAddress: USER_ADDR,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    feeConfig: getProtocolFeeConfig(),
    nativeBalanceWei: 50_000_000_000_000_000n, // 0.05 POL (enough for gas, NOT enough for 0.5 POL fixFee)
    providers: {
      debridge_dln: async () => ({
        provider: 'debridge_dln',
        label: 'deBridge DLN',
        estimatedOutput: '99.60 USDC',
        estimatedSeconds: 8,
        quotedOutUsd: 99.6,
        estimatedGasUsd: 0.01,
        extraBridgeFeeUsd: 0.15,
        transactions: [mkTx(DLN_SOURCE, 'bridge_debridge_dln', '0x6f05b59d3b20000')], // 0.5 POL
        notes: [],
      }),
      relay: async () => ({
        provider: 'relay',
        label: 'Relay',
        estimatedOutput: '99.40 USDC',
        estimatedSeconds: 5,
        quotedOutUsd: 99.4,
        estimatedGasUsd: 0.01,
        sponsorsSolanaAta: true,
        transactions: [mkTx(RELAY_ROUTER, 'bridge_relay', '0x0')],
        notes: [],
      }),
      mayan_swift: async () => null,
      lifi: async () => null,
    },
  });

  assert.equal(res.winner.provider, 'relay', 'Relay ($0 msg.value) should win over deBridge (0.5 POL fixFee)');
  const dlnCand = res.routeAuction.candidates.find((c) => c.provider === 'debridge_dln');
  assert.equal(dlnCand?.status, 'rejected_insufficient_gas');
  assert.match(dlnCand?.reason ?? '', /msg\.value/i);
});

test('Wave 24: route auction automatically falls back to runner-up when winning tx reverts in eth_call simulation', async () => {
  const res = await runLiveParallelRouteAuction({
    asset: POLYGON_ASSET,
    userAddress: USER_ADDR,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    feeConfig: getProtocolFeeConfig(),
    simulateTxFn: async (tx) => {
      if (tx.to.toLowerCase() === DLN_SOURCE.toLowerCase()) {
        return { ok: false, reason: 'revert: ERC20: transfer amount exceeds balance' };
      }
      return { ok: true };
    },
    providers: {
      debridge_dln: async () => ({
        provider: 'debridge_dln',
        label: 'deBridge DLN',
        estimatedOutput: '99.80 USDC',
        estimatedSeconds: 8,
        quotedOutUsd: 99.8,
        estimatedGasUsd: 0.01,
        transactions: [mkTx(DLN_SOURCE, 'bridge_debridge_dln', '0x0')],
        notes: [],
      }),
      relay: async () => ({
        provider: 'relay',
        label: 'Relay',
        estimatedOutput: '99.45 USDC',
        estimatedSeconds: 5,
        quotedOutUsd: 99.45,
        estimatedGasUsd: 0.01,
        sponsorsSolanaAta: true,
        transactions: [mkTx(RELAY_ROUTER, 'bridge_relay', '0x0')],
        notes: [],
      }),
      mayan_swift: async () => null,
      lifi: async () => null,
    },
  });

  assert.equal(res.winner.provider, 'relay', 'Should promote Relay runner-up after deBridge sim revert');
  const dlnCand = res.routeAuction.candidates.find((c) => c.provider === 'debridge_dln');
  assert.equal(dlnCand?.status, 'rejected_simulation');
  assert.match(dlnCand?.reason ?? '', /exceeds balance/i);
});

test('Wave 24: prepareBatchExecutions flags zero-gas chains and passes nativeBalanceWei into preparation', async () => {
  const seenNativeBals: Array<bigint | undefined> = [];
  const res = await prepareBatchExecutions({
    assets: [POLYGON_ASSET],
    userAddress: USER_ADDR,
    solanaDestination: SOL_DEST,
    includePreflight: false,
    fetchChainBalancesFn: async () => ({ polygon: 0n }),
    prepareAssetFn: (async (p: { routeAuctionOptions?: { nativeBalanceWei?: bigint } }) => {
      seenNativeBals.push(p.routeAuctionOptions?.nativeBalanceWei);
      return {
        assetId: POLYGON_ASSET.id,
        action: POLYGON_ASSET.action,
        provider: 'relay',
        chain: 'polygon',
        chainId: 137,
        chainName: 'Polygon',
        explorerUrl: 'https://polygonscan.com',
        estimatedOutput: '99.40 USDC',
        estimatedSeconds: 5,
        quotedOutUsd: 99.4,
        liveNetUsd: 99.39,
        estimatedGasUsd: 0.01,
        transactions: [mkTx(RELAY_ROUTER, 'bridge_relay', '0x0')],
        notes: [],
      };
    }) as unknown as NonNullable<Parameters<typeof prepareBatchExecutions>[0]['prepareAssetFn']>,
  });

  assert.deepEqual(seenNativeBals, [0n]);
  assert.deepEqual(res.zeroGasChains, ['polygon']);
  assert.equal(res.chainGasStatus.polygon.hasEnoughGas, false);
  assert.equal(res.chainGasStatus.polygon.nativeBalanceUi, 0);
  assert.match(res.chainGasStatus.polygon.reason ?? '', /0 POL/i);
});

test('Wave 24: evaluateChainNativeGasStatus and buildGasRefuelQuote + HTTP /api/gas/refuel-quote work cleanly', async () => {
  const statusOk = evaluateChainNativeGasStatus({
    chain: 'polygon',
    nativeBalanceWei: 2_000_000_000_000_000_000n, // 2 POL
    requiredMsgValueWei: 0n,
    estimatedGasUsd: 0.01,
    nativePriceUsd: 0.25,
  });
  assert.equal(statusOk.hasEnoughGas, true);

  const quote = await buildGasRefuelQuote({
    fromChain: 'base',
    toChain: 'polygon',
    userAddress: USER_ADDR,
    amountUsd: 1.0,
    nativePrices: { ETH: 2500, POL: 0.25 },
    fetcher: (async () =>
      new Response(
        JSON.stringify({
          requestId: 'req_refuel_1',
          details: {
            timeEstimate: 5,
            currencyOut: { amountFormatted: '3.95', amountUsd: '0.99', currency: { symbol: 'POL' } },
          },
          steps: [
            {
              id: 'deposit',
              kind: 'transaction',
              items: [
                {
                  data: {
                    from: USER_ADDR,
                    to: RELAY_ROUTER,
                    data: '0x',
                    value: '400000000000000',
                    chainId: 8453,
                  },
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch,
  });

  assert.equal(quote.provider, 'relay');
  assert.equal(quote.fromChain, 'base');
  assert.equal(quote.toChain, 'polygon');
  assert.equal(quote.transaction.to, RELAY_ROUTER);
  assert.equal(quote.transaction.chainId, 8453);
  assert.ok(quote.amountInUi < 0.01, `Expected ~$1 in ETH (<0.01 ETH), got ${quote.amountInUi}`);

  // Regression guard: using default FALLBACK_PRICES via nativeLlamaId must NOT fall back to $1/ETH (1.0 ETH!)
  const quoteDefaultPrices = await buildGasRefuelQuote({
    fromChain: 'base',
    toChain: 'polygon',
    userAddress: USER_ADDR,
    amountUsd: 1.0,
    nativePrices: {},
    fetcher: (async () =>
      new Response(
        JSON.stringify({
          requestId: 'req_refuel_default',
          details: {
            timeEstimate: 4,
            currencyOut: { amountFormatted: '4.10', amountUsd: '0.98', currency: { symbol: 'POL' } },
          },
          steps: [
            {
              id: 'deposit',
              kind: 'transaction',
              items: [{ data: { from: USER_ADDR, to: RELAY_ROUTER, data: '0x', value: '595000000000000', chainId: 8453 } }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch,
  });
  assert.ok(
    quoteDefaultPrices.amountInUi > 0 && quoteDefaultPrices.amountInUi < 0.005,
    `Expected fallback ETH price via coingecko:ethereum (~0.0006 ETH), got ${quoteDefaultPrices.amountInUi}`
  );

  // HTTP validation check on POST /api/gas/refuel-quote (same chain rejected 400)
  const app = createTurgaliumServer({ enableBackgroundPollers: false });
  const srv = app.server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const badRes = await fetch(`http://127.0.0.1:${port}/api/gas/refuel-quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromChain: 'polygon', toChain: 'polygon', userAddress: USER_ADDR }),
    });
    assert.equal(badRes.status, 400);
    const badJson = (await badRes.json()) as { error: string };
    assert.match(badJson.error, /different/i);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
