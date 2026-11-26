import assert from 'node:assert/strict';
import test from 'node:test';
import {
  quoteLifiNonEvm,
  quoteSkipGoCosmos,
} from '../src/execution/non-evm-converter.js';
import {
  type AuctionExecutableTx,
  type AuctionProviderQuote,
  computeDynamicGasReserveSummary,
  computeDynamicGasReserveWei,
  computeTierScaledSlippageBps,
  DEBRIDGE_SOLANA_CHAIN_ID,
  fetchDeBridgeDlnQuote,
  fetchMayanSwiftQuote,
  MIN_GAS_RESERVE_SAFETY_MULTIPLIER,
  type RouteAuctionFetcher,
  runLiveParallelRouteAuction,
  validateRouterCallTarget,
  ZERO_ADDRESS,
} from '../src/execution/route-auction.js';
import {
  prepareChainBatchExecution,
  prepareRealExecution,
} from '../src/execution/tx-builder.js';
import {
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  getProtocolFeeConfig,
} from '../src/scanner/chains.js';
import type { EvmChainId, ScannedAsset } from '../src/scanner/types.js';

const USER_EVM = '0x1111111111111111111111111111111111111111';
const TREASURY_EVM = '0x9999999999999999999999999999999999999999';
const SOL_DEST = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

const MAYAN_FORWARDER = '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2';
const DLN_SOURCE = '0xeF4fB24aD0916217251F553c0596F8Edc630EB66';
const RELAY_DEPOSITORY = '0xa5f565650890fba1824ee0f21ebbbf660a179934';
const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const VALID_CALLDATA = `0xabcdef01${'11'.repeat(64)}`;

const BASE_WETH = '0x4200000000000000000000000000000000000006';

function mkAsset(overrides: Partial<ScannedAsset> = {}): ScannedAsset {
  const chain = (overrides.chain ?? 'base') as EvmChainId;
  const cfg = EVM_CHAINS[chain];
  return {
    id: `${chain}:weth`,
    family: 'evm',
    chain,
    chainName: cfg.name,
    address: BASE_WETH,
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    kind: 'erc20',
    rawBalance: '4000000000000000000', // 4 WETH
    uiBalance: 4,
    priceUsd: 2500,
    grossUsd: 10_000,
    liquidityUsd: 50_000_000,
    estimatedGasUsd: 0.05,
    batchedGasUsd: 0.03,
    estimatedSlippageUsd: 10,
    netUsdcSingle: 9980,
    netUsdcBatched: 9985,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Liquid ERC-20',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

function mkUsdcAsset(chain: EvmChainId, usdAmount: number): ScannedAsset {
  const cfg = EVM_CHAINS[chain];
  const raw = BigInt(Math.round(usdAmount * 1_000_000)).toString();
  return mkAsset({
    id: `${chain}:usdc`,
    chain,
    chainName: cfg.name,
    address: cfg.usdcAddress,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    rawBalance: raw,
    uiBalance: usdAmount,
    priceUsd: 1,
    grossUsd: usdAmount,
    liquidityUsd: 200_000_000,
    estimatedGasUsd: chain === 'ethereum' ? 2.5 : 0.03,
    batchedGasUsd: chain === 'ethereum' ? 1.8 : 0.02,
    action: 'BRIDGE_DIRECT_USDC',
  });
}

function mkTx(
  chain: EvmChainId,
  to: string,
  stepId = 'bridge',
  data = VALID_CALLDATA,
  value = '0x0'
): AuctionExecutableTx {
  const cfg = EVM_CHAINS[chain];
  return {
    stepId,
    label: `Execute ${stepId}`,
    description: `Mock ${stepId}`,
    chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    explorerUrl: cfg.explorerUrl,
    from: USER_EVM,
    to,
    data,
    value,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// =====================================================================
// 1. DIRECT QUOTE ADAPTERS: MAYAN SWIFT & DEBRIDGE DLN
// =====================================================================

test('fetchMayanSwiftQuote builds live EVM->Solana Swift quote, checks allowance, and validates targets', async () => {
  const asset = mkAsset({ chain: 'base', grossUsd: 10_000 });
  const feeConfig = getProtocolFeeConfig({ feeBps: 500, feeRecipientEvm: null });
  let capturedUrl = '';

  const mockFetcher: RouteAuctionFetcher = async (url) => {
    capturedUrl = url;
    return jsonResponse([
      {
        type: 'MCTP',
        quoteId: 'mayan_mctp_slow',
        expectedAmountOut: '9980.00',
        etaSeconds: 45,
        tx: { to: MAYAN_FORWARDER, data: VALID_CALLDATA, value: '0x0' },
      },
      {
        type: 'SWIFT',
        quoteId: 'mayan_swift_fast',
        expectedAmountOut: '9996.50',
        etaSeconds: 11,
        bridgeFeeUsd: 3.0,
        gasCostUsd: 0.04,
        forwarderAddress: MAYAN_FORWARDER,
        tx: { to: MAYAN_FORWARDER, data: VALID_CALLDATA, value: '0x0', gasLimit: '220000' },
      },
    ]);
  };

  const quote = await fetchMayanSwiftQuote({
    asset,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    feeConfig,
    fetcher: mockFetcher,
    allowanceCheckFn: async () => 0n,
  });

  assert.ok(quote, 'Expected Mayan Swift quote');
  assert.equal(quote.provider, 'mayan_swift');
  assert.equal(quote.requestId, 'mayan_swift_fast');
  assert.equal(quote.quotedOutUsd, 9996.5);
  assert.equal(quote.estimatedSeconds, 11);
  assert.equal(quote.transactions.length, 2, 'Should prepend ERC-20 approve when allowance is 0');
  assert.equal(quote.transactions[0].stepId, 'approve_mayan_swift');
  assert.equal(quote.transactions[0].to.toLowerCase(), BASE_WETH.toLowerCase());
  assert.equal(quote.transactions[1].to, MAYAN_FORWARDER);
  assert.ok(capturedUrl.startsWith('https://price-api.mayan.finance/v3/quote?'));
  assert.ok(capturedUrl.includes('fromChain=base'));
  assert.ok(capturedUrl.includes('toChain=solana'));
  assert.ok(capturedUrl.includes('swift=true'));
  assert.ok(capturedUrl.includes(`destAddress=${SOL_DEST}`));
});

test('fetchDeBridgeDlnQuote builds executable DLN order tx and accounts for native fixFee', async () => {
  const asset = mkAsset({ chain: 'arbitrum', grossUsd: 10_000 });
  const feeConfig = getProtocolFeeConfig({ feeBps: 500, feeRecipientEvm: null });
  let capturedUrl = '';

  const mockFetcher: RouteAuctionFetcher = async (url) => {
    capturedUrl = url;
    return jsonResponse({
      orderId: '0xdeadbeef1234',
      fixFee: '1000000000000000', // 0.001 ETH
      estimation: {
        dstChainTokenOut: {
          amount: '9994000000',
          recommendedAmount: '9995000000',
          decimals: 6,
          symbol: 'USDC',
          approximateUsdValue: 9995.0,
        },
        costsDetails: [
          { type: 'DlnProtocolFee', payload: { feeApproximateUsdValue: '2.50' } },
          { type: 'TakerMargin', payload: { feeApproximateUsdValue: '1.50' } },
        ],
      },
      tx: {
        to: DLN_SOURCE,
        data: VALID_CALLDATA,
        value: '1000000000000000',
        gasLimit: '260000',
      },
      order: { approximateFulfillmentDelay: 14 },
    });
  };

  const quote = await fetchDeBridgeDlnQuote({
    asset,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    feeConfig,
    fetcher: mockFetcher,
    allowanceCheckFn: async () => BigInt(asset.rawBalance) * 2n, // already approved!
  });

  assert.ok(quote, 'Expected deBridge DLN quote');
  assert.equal(quote.provider, 'debridge_dln');
  assert.equal(quote.requestId, '0xdeadbeef1234');
  assert.equal(quote.quotedOutUsd, 9995.0);
  assert.equal(quote.extraBridgeFeeUsd, 2.5, 'Should capture native protocol fixFee');
  assert.equal(quote.estimatedSeconds, 14);
  assert.equal(quote.transactions.length, 1, 'Should skip approve when allowance already sufficient');
  assert.equal(quote.transactions[0].to, DLN_SOURCE);
  assert.equal(quote.transactions[0].value, '0x38d7ea4c68000');
  assert.ok(capturedUrl.startsWith('https://dln.debridge.finance/v1.0/dln/order/create-tx?'));
  assert.ok(capturedUrl.includes(`dstChainId=${DEBRIDGE_SOLANA_CHAIN_ID}`));
  assert.ok(capturedUrl.includes('srcChainId=42161'));
});

// =====================================================================
// 2. PARALLEL AUCTION BUDGET & GRACEFUL DEGRADATION ON TIMEOUTS/ERRORS
// =====================================================================

test('runLiveParallelRouteAuction finishes strictly within timeout budget even when 2 providers hang & 1 rejects', async () => {
  const asset = mkAsset({ chain: 'base', grossUsd: 10_000 });
  const feeConfig = getProtocolFeeConfig({ feeBps: 500, feeRecipientEvm: null });

  const hangingProvider = () =>
    new Promise<AuctionProviderQuote | null>(() => {
      // Never resolves — simulates dead/stalled upstream RPC/API
    });

  const startedAt = Date.now();
  const result = await runLiveParallelRouteAuction({
    asset,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    feeConfig,
    timeoutMs: 180,
    providers: {
      relay: hangingProvider,
      lifi: hangingProvider,
      debridge_dln: async () => {
        throw new Error('HTTP 429 rate limited');
      },
      mayan_swift: async () => {
        await new Promise((r) => setTimeout(r, 25));
        return {
          provider: 'mayan_swift',
          label: 'Mayan Swift',
          estimatedOutput: '9,996.50 USDC',
          estimatedSeconds: 12,
          quotedOutUsd: 9996.5,
          estimatedGasUsd: 0.05,
          sponsorsSolanaAta: true,
          transactions: [mkTx('base', MAYAN_FORWARDER, 'bridge_mayan_swift')],
          notes: ['Mayan Swift live fill'],
        };
      },
    },
  });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(
    elapsedMs < 600,
    `Parallel auction should finish near 180ms budget, took ${elapsedMs}ms`
  );
  assert.equal(result.routeAuction.winnerProvider, 'mayan_swift');
  assert.equal(result.routeAuction.providersSucceeded, 1);
  assert.equal(result.routeAuction.providersQueried.length, 4);

  const byProvider = new Map(result.routeAuction.candidates.map((c) => [c.provider, c]));
  assert.equal(byProvider.get('mayan_swift')?.status, 'ok');
  assert.equal(byProvider.get('relay')?.status, 'timeout');
  assert.equal(byProvider.get('lifi')?.status, 'timeout');
  assert.equal(byProvider.get('debridge_dln')?.status, 'error');
});

// =====================================================================
// 3. $10K-$100K NATIVE USDC (CCTP WINS) VS NON-USDC (MAYAN/DLN/RELAY COMPETE)
// =====================================================================

test('On $10k and $100k native USDC, Circle CCTP beats high-spread bridge quotes and surfaces exact auction savings', async () => {
  const feeConfig = getProtocolFeeConfig({ feeBps: 500, feeRecipientEvm: null });

  for (const principalUsd of [10_000, 100_000]) {
    const usdc = mkUsdcAsset('base', principalUsd);

    const mockFetcher: RouteAuctionFetcher = async (url) => {
      if (url.includes('api.relay.link/quote')) {
        // Relay ~15 bps solver spread
        const out = principalUsd * (1 - 0.0015);
        return jsonResponse({
          requestId: 'relay_usdc_1',
          details: {
            timeEstimate: 8,
            currencyOut: { amountFormatted: out.toFixed(2), amountUsd: out.toFixed(2), currency: { symbol: 'USDC' } },
          },
          fees: { gas: { amountUsd: '0.04' }, relayer: { amountUsd: '1.50' } },
          steps: [
            {
              id: 'deposit',
              kind: 'transaction',
              items: [{ data: { to: RELAY_DEPOSITORY, data: VALID_CALLDATA, value: '0x0' } }],
            },
          ],
        });
      }
      if (url.includes('price-api.mayan.finance/v3/quote')) {
        // Mayan Swift ~4 bps spread
        const out = principalUsd * (1 - 0.0004);
        return jsonResponse([
          {
            type: 'SWIFT',
            quoteId: 'mayan_usdc_1',
            expectedAmountOut: out.toFixed(2),
            etaSeconds: 12,
            gasCostUsd: 0.04,
            tx: { to: MAYAN_FORWARDER, data: VALID_CALLDATA, value: '0x0' },
          },
        ]);
      }
      if (url.includes('dln.debridge.finance/v1.0/dln/order/create-tx')) {
        // deBridge DLN ~5 bps + $1.00 fixFee
        const outRaw = BigInt(Math.round(principalUsd * (1 - 0.0005) * 1_000_000)).toString();
        return jsonResponse({
          orderId: 'dln_usdc_1',
          estimation: {
            dstChainTokenOut: {
              recommendedAmount: outRaw,
              decimals: 6,
              symbol: 'USDC',
              approximateUsdValue: principalUsd * (1 - 0.0005),
            },
            costsDetails: [{ type: 'DlnProtocolFee', payload: { feeApproximateUsdValue: '1.00' } }],
          },
          tx: { to: DLN_SOURCE, data: VALID_CALLDATA, value: '0x0' },
          order: { approximateFulfillmentDelay: 15 },
        });
      }
      if (url.includes('li.quest/v1/quote')) {
        // LI.FI ~25 bps aggregator markup
        const outRaw = BigInt(Math.round(principalUsd * (1 - 0.0025) * 1_000_000)).toString();
        return jsonResponse({
          id: 'lifi_usdc_1',
          toolDetails: { name: 'Stargate' },
          estimate: {
            toAmount: outRaw,
            toAmountUSD: (principalUsd * (1 - 0.0025)).toFixed(2),
            executionDuration: 25,
          },
          action: { toToken: { decimals: 6, symbol: 'USDC' } },
          transactionRequest: { to: LIFI_DIAMOND, data: VALID_CALLDATA, value: '0x0' },
        });
      }
      return new Response('Not found', { status: 404 });
    };

    const batch = await prepareChainBatchExecution({
      chain: 'base',
      assets: [usdc],
      userAddress: USER_EVM,
      solanaDestination: SOL_DEST,
      outputAsset: 'USDC',
      bridgePreference: 'auto',
      protocolFeeBps: feeConfig.feeBps,
      allowanceCheckFn: async () => BigInt(usdc.rawBalance) * 2n,
      routeAuctionOptions: {
        fetcher: mockFetcher,
        timeoutMs: 2000,
      },
    });

    assert.ok(batch.routeAuction, `Expected routeAuction metadata on $${principalUsd} batch`);
    assert.equal(
      batch.routeAuction.winnerProvider,
      'circle_cctp',
      `Circle CCTP (0 bps 1:1) must beat spread bridges on $${principalUsd} native USDC`
    );
    assert.equal(batch.routeAuction.runnerUpProvider, 'mayan_swift');
    assert.equal(batch.routeAuction.providersSucceeded, 5);
    assert.ok(
      batch.routeAuction.dollarsSavedOverRunnerUp > 0,
      `Expected positive savings vs runner-up on $${principalUsd}`
    );

    // Every candidate exposes netUsd and etaSeconds
    for (const c of batch.routeAuction.candidates) {
      assert.equal(c.status, 'ok');
      assert.equal(typeof c.netUsd, 'number');
      assert.equal(c.netUsd, c.liveNetUsd);
      assert.ok(c.etaSeconds > 0);
    }

    // Verify strict descending netUsd ordering among passing candidates
    for (let i = 1; i < batch.routeAuction.candidates.length; i += 1) {
      assert.ok(
        batch.routeAuction.candidates[i - 1].netUsd >= batch.routeAuction.candidates[i].netUsd,
        'Auction candidates must be sorted strictly by highest liveNetUsd'
      );
    }

    assert.equal(batch.bridgeTrackers[0].provider, 'circle_cctp');
    assert.equal(batch.bridgeTrackers[0].requiresSolanaClaim, true);
  }
});

test('On non-USDC ($10k WETH), CCTP is excluded and Mayan Swift / deBridge DLN / Relay compete strictly on liveNetUsd', async () => {
  const weth = mkAsset({ chain: 'base', grossUsd: 10_000 });

  // Scenario A: Mayan Swift (~3 bps) beats deBridge DLN, Relay, and LI.FI
  const batchMayan = await prepareChainBatchExecution({
    chain: 'base',
    assets: [weth],
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    bridgePreference: 'auto',
    allowanceCheckFn: async () => BigInt(weth.rawBalance) * 2n,
    routeAuctionOptions: {
      providers: {
        relay: async () => ({
          provider: 'relay',
          estimatedOutput: '9,982.00 USDC',
          estimatedSeconds: 8,
          quotedOutUsd: 9982,
          estimatedGasUsd: 0.04,
          sponsorsSolanaAta: true,
          transactions: [mkTx('base', RELAY_DEPOSITORY, 'deposit')],
          notes: [],
        }),
        mayan_swift: async () => ({
          provider: 'mayan_swift',
          estimatedOutput: '9,997.00 USDC',
          estimatedSeconds: 12,
          quotedOutUsd: 9997,
          estimatedGasUsd: 0.05,
          sponsorsSolanaAta: true,
          transactions: [mkTx('base', MAYAN_FORWARDER, 'bridge_mayan_swift')],
          notes: [],
        }),
        debridge_dln: async () => ({
          provider: 'debridge_dln',
          estimatedOutput: '9,995.00 USDC',
          estimatedSeconds: 15,
          quotedOutUsd: 9995,
          estimatedGasUsd: 0.05,
          extraBridgeFeeUsd: 1.5, // net = 9993.45
          sponsorsSolanaAta: true,
          transactions: [mkTx('base', DLN_SOURCE, 'bridge_debridge_dln')],
          notes: [],
        }),
        lifi: async () => ({
          provider: 'lifi',
          estimatedOutput: '9,970.00 USDC',
          estimatedSeconds: 25,
          quotedOutUsd: 9970,
          estimatedGasUsd: 0.05,
          sponsorsSolanaAta: true,
          transactions: [mkTx('base', LIFI_DIAMOND, 'bridge')],
          notes: [],
        }),
      },
    },
  });

  assert.equal(batchMayan.routeAuction?.winnerProvider, 'mayan_swift');
  assert.equal(batchMayan.routeAuction?.runnerUpProvider, 'debridge_dln');
  assert.equal(
    batchMayan.routeAuction?.providersQueried.includes('circle_cctp'),
    false,
    'Circle CCTP must NOT be queried for non-USDC WETH'
  );
  assert.ok(Math.abs((batchMayan.routeAuction?.dollarsSavedOverRunnerUp ?? 0) - 3.5) < 0.05);
  assert.equal(batchMayan.bridgeTrackers[0].provider, 'mayan_swift');
  assert.equal(batchMayan.bridgeTrackers[0].requiresSolanaClaim, false);

  // Scenario B: deBridge DLN wins when its net output is highest
  const prepDln = await prepareRealExecution({
    asset: weth,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    bridgePreference: 'auto',
    routeAuctionOptions: {
      providers: {
        relay: async () => ({
          provider: 'relay',
          estimatedOutput: '9,980.00 USDC',
          estimatedSeconds: 8,
          quotedOutUsd: 9980,
          estimatedGasUsd: 0.04,
          sponsorsSolanaAta: true,
          transactions: [mkTx('base', RELAY_DEPOSITORY, 'deposit')],
          notes: [],
        }),
        mayan_swift: async () => ({
          provider: 'mayan_swift',
          estimatedOutput: '9,988.00 USDC',
          estimatedSeconds: 12,
          quotedOutUsd: 9988,
          estimatedGasUsd: 0.05,
          sponsorsSolanaAta: true,
          transactions: [mkTx('base', MAYAN_FORWARDER, 'bridge_mayan_swift')],
          notes: [],
        }),
        debridge_dln: async () => ({
          provider: 'debridge_dln',
          estimatedOutput: '9,996.00 USDC',
          estimatedSeconds: 14,
          quotedOutUsd: 9996,
          estimatedGasUsd: 0.05,
          extraBridgeFeeUsd: 0.5, // net = 9995.45 -> wins!
          sponsorsSolanaAta: true,
          transactions: [mkTx('base', DLN_SOURCE, 'bridge_debridge_dln')],
          notes: [],
        }),
        lifi: async () => null,
      },
    },
  });

  assert.equal(prepDln.provider, 'debridge_dln');
  assert.equal(prepDln.routeAuction?.winnerProvider, 'debridge_dln');
  assert.equal(prepDln.routeAuction?.runnerUpProvider, 'mayan_swift');
});

// =====================================================================
// 4. ADVERSARIAL FAIL-CLOSED SECURITY & HAIRCUT REJECTION TESTS
// =====================================================================

test('validateRouterCallTarget and auction reject spoofed to addresses, token targets, and empty calldata fail-closed', async () => {
  const baseUsdc = EVM_CHAINS.base.usdcAddress;
  const badTargets: Array<{ label: string; to: string; data: string }> = [
    { label: 'zero address', to: ZERO_ADDRESS, data: VALID_CALLDATA },
    { label: 'dead burn address', to: DEAD_BURN_ADDRESS, data: VALID_CALLDATA },
    { label: 'user self address', to: USER_EVM, data: VALID_CALLDATA },
    { label: 'input token address', to: BASE_WETH, data: VALID_CALLDATA },
    { label: 'chain USDC address', to: baseUsdc, data: VALID_CALLDATA },
    { label: 'empty calldata 0x', to: MAYAN_FORWARDER, data: '0x' },
    { label: 'short calldata < 4 bytes', to: MAYAN_FORWARDER, data: '0x1234' },
    { label: 'odd-length hex calldata', to: MAYAN_FORWARDER, data: '0x123456789' },
    { label: 'non-hex calldata', to: MAYAN_FORWARDER, data: '0xzzzzzzzz' },
  ];

  for (const tc of badTargets) {
    const check = validateRouterCallTarget({
      to: tc.to,
      data: tc.data,
      userAddress: USER_EVM,
      tokenAddresses: [BASE_WETH, baseUsdc],
    });
    assert.equal(check.valid, false, `Expected fail-closed rejection for ${tc.label}`);
  }

  // Adversarial auction: spoofed Mayan quote claims $999,999 out, spoofed DLN targets token contract,
  // spoofed LI.FI has empty calldata, and Relay has >50% haircut ($400 out on $1,000 gross)!
  const asset = mkAsset({ chain: 'base', grossUsd: 1_000 });
  const feeConfig = getProtocolFeeConfig({ feeBps: 500, feeRecipientEvm: null });

  await assert.rejects(
    () =>
      runLiveParallelRouteAuction({
        asset,
        userAddress: USER_EVM,
        solanaDestination: SOL_DEST,
        outputAsset: 'USDC',
        feeConfig,
        providers: {
          mayan_swift: async () => ({
            provider: 'mayan_swift',
            estimatedOutput: '999,999 USDC',
            estimatedSeconds: 5,
            quotedOutUsd: 999_999, // tempting spoof!
            estimatedGasUsd: 0.01,
            transactions: [mkTx('base', USER_EVM, 'bridge_mayan_swift')], // SPOOFED user address
            notes: [],
          }),
          debridge_dln: async () => ({
            provider: 'debridge_dln',
            estimatedOutput: '999.00 USDC',
            estimatedSeconds: 10,
            quotedOutUsd: 999,
            estimatedGasUsd: 0.02,
            transactions: [mkTx('base', BASE_WETH, 'bridge_debridge_dln')], // SPOOFED token address
            notes: [],
          }),
          lifi: async () => ({
            provider: 'lifi',
            estimatedOutput: '998.00 USDC',
            estimatedSeconds: 10,
            quotedOutUsd: 998,
            estimatedGasUsd: 0.02,
            transactions: [mkTx('base', LIFI_DIAMOND, 'bridge', '0x')], // EMPTY calldata
            notes: [],
          }),
          relay: async () => ({
            provider: 'relay',
            estimatedOutput: '450.00 USDC',
            estimatedSeconds: 8,
            quotedOutUsd: 450, // 55% haircut (>50% cap!)
            estimatedGasUsd: 0.05,
            transactions: [mkTx('base', RELAY_DEPOSITORY, 'deposit')],
            notes: [],
          }),
        },
      }),
    /No safe live bridge route|Haircut Gate|security/i
  );

  // Now add ONE honest safe provider (Relay at $992 net) alongside spoofed Mayan ($50,000 fake) and >50% haircut LI.FI:
  // Honest Relay MUST win and adversarial candidates must be labeled rejected_security / rejected_haircut!
  const safeResult = await runLiveParallelRouteAuction({
    asset,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    feeConfig,
    providers: {
      mayan_swift: async () => ({
        provider: 'mayan_swift',
        estimatedOutput: '50,000 USDC',
        estimatedSeconds: 5,
        quotedOutUsd: 50_000,
        estimatedGasUsd: 0.01,
        transactions: [mkTx('base', DEAD_BURN_ADDRESS, 'bridge_mayan_swift')], // SPOOFED dead address
        notes: [],
      }),
      debridge_dln: async () => ({
        provider: 'debridge_dln',
        estimatedOutput: '999 USDC',
        estimatedSeconds: 10,
        quotedOutUsd: 999,
        estimatedGasUsd: 0.01,
        transactions: [
          // Spoofed approve spender = ZERO_ADDRESS!
          mkTx(
            'base',
            BASE_WETH,
            'approve_debridge_dln',
            `0x095ea7b3${'0'.repeat(64)}${'f'.repeat(64)}`
          ),
          mkTx('base', DLN_SOURCE, 'bridge_debridge_dln'),
        ],
        notes: [],
      }),
      lifi: async () => ({
        provider: 'lifi',
        estimatedOutput: '400.00 USDC',
        estimatedSeconds: 12,
        quotedOutUsd: 400, // 60% haircut!
        estimatedGasUsd: 0.05,
        transactions: [mkTx('base', LIFI_DIAMOND, 'bridge')],
        notes: [],
      }),
      relay: async () => ({
        provider: 'relay',
        estimatedOutput: '992.00 USDC',
        estimatedSeconds: 8,
        quotedOutUsd: 992,
        estimatedGasUsd: 0.05,
        sponsorsSolanaAta: true,
        transactions: [mkTx('base', RELAY_DEPOSITORY, 'deposit')],
        notes: [],
      }),
    },
  });

  assert.equal(safeResult.routeAuction.winnerProvider, 'relay');
  assert.equal(safeResult.routeAuction.providersSucceeded, 1);
  const byProv = new Map(safeResult.routeAuction.candidates.map((c) => [c.provider, c]));
  assert.equal(byProv.get('mayan_swift')?.status, 'rejected_security');
  assert.equal(byProv.get('debridge_dln')?.status, 'rejected_security');
  assert.equal(byProv.get('lifi')?.status, 'rejected_haircut');
  assert.equal(byProv.get('relay')?.status, 'ok');
});

test('fetchMayanSwiftQuote and fetchDeBridgeDlnQuote reject spoofed router targets directly fail-closed', async () => {
  const asset = mkAsset({ chain: 'base', grossUsd: 500 });
  const feeConfig = getProtocolFeeConfig({ feeBps: 500, feeRecipientEvm: TREASURY_EVM });

  await assert.rejects(
    () =>
      fetchMayanSwiftQuote({
        asset,
        userAddress: USER_EVM,
        solanaDestination: SOL_DEST,
        outputAsset: 'USDC',
        feeConfig,
        fetcher: async () =>
          jsonResponse([
            {
              type: 'SWIFT',
              expectedAmountOut: '499.00',
              tx: { to: ZERO_ADDRESS, data: VALID_CALLDATA },
            },
          ]),
      }),
    /security validation failed/i
  );

  await assert.rejects(
    () =>
      fetchDeBridgeDlnQuote({
        asset,
        userAddress: USER_EVM,
        solanaDestination: SOL_DEST,
        outputAsset: 'USDC',
        feeConfig,
        fetcher: async () =>
          jsonResponse({
            orderId: 'bad_dln',
            estimation: { dstChainTokenOut: { amount: '499000000', decimals: 6 } },
            tx: { to: USER_EVM, data: VALID_CALLDATA },
          }),
      }),
    /security validation failed/i
  );
});

// =====================================================================
// 5. DYNAMIC TIER-SCALED SLIPPAGE (EVM & NON-EVM CONVERTER)
// =====================================================================

test('Tier-scaled slippage tightens for large liquid majors and widens dynamically for thin pools & micro-dust', async () => {
  // Large principal USDC/SUI on deep pool -> tight 25-30 bps (0.25-0.30%), NOT flat 200 bps!
  const whaleStable = computeTierScaledSlippageBps({
    tradeUsd: 25_000,
    liquidityUsd: 100_000_000,
    symbol: 'USDC',
  });
  assert.ok(whaleStable.slippageBps <= 30, `Expected <= 30 bps for $25k USDC, got ${whaleStable.slippageBps}`);
  assert.equal(whaleStable.tier, 'principal_major');

  // Mid-cap $100 swap -> ~100 bps
  const midCap = computeTierScaledSlippageBps({
    tradeUsd: 100,
    liquidityUsd: 2_000_000,
    symbol: 'AERO',
  });
  assert.ok(midCap.slippageBps >= 50 && midCap.slippageBps <= 120);

  // Micro-dust $15 -> ~175-200 bps
  const microDust = computeTierScaledSlippageBps({
    tradeUsd: 15,
    liquidityUsd: 500_000,
    symbol: 'MEME',
  });
  assert.ok(microDust.slippageBps >= 150 && microDust.slippageBps <= 200);

  // Thin liquidity ($2,000 trade into $15,000 pool) -> scales up well above whaleStable
  const thinPool = computeTierScaledSlippageBps({
    tradeUsd: 2_000,
    liquidityUsd: 15_000,
    symbol: 'THIN',
  });
  assert.equal(thinPool.tier, 'thin_liquidity');
  assert.ok(thinPool.slippageBps > whaleStable.slippageBps * 5);

  // Verify quoteLifiNonEvm sends dynamic slippage (NOT hardcoded 0.02!)
  let lifiUrl = '';
  const lifiRes = await quoteLifiNonEvm({
    fromChainId: 9270000000000000,
    fromToken: '0x2::sui::SUI',
    fromAmount: '5000000000000',
    fromAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    tradeUsd: 12_000,
    liquidityUsd: 50_000_000,
    symbol: 'SUI',
    fetcher: async (url) => {
      lifiUrl = url;
      return jsonResponse({
        id: 'lifi_sui_dyn',
        tool: 'mayan',
        estimate: { toAmount: '11960000000', toAmountUSD: '11960', executionDuration: 20 },
        transactionRequest: { data: '0x1234' },
      });
    },
  });
  assert.ok(lifiRes);
  assert.ok(lifiUrl.includes('slippage=0.0025') || lifiUrl.includes('slippage=0.0030'), `Unexpected LI.FI URL: ${lifiUrl}`);
  assert.ok(!lifiUrl.includes('slippage=0.02'), 'Must not hardcode 2% slippage on $12k liquid SUI');
  assert.ok((lifiRes.appliedSlippageBps ?? 999) <= 30);

  // Verify quoteSkipGoCosmos sends dynamic slippage_tolerance_percent (NOT hardcoded '2'!)
  let skipMsgsBody = '';
  const skipRes = await quoteSkipGoCosmos({
    sourceChainId: 'noble-1',
    sourceDenom: 'uusdc',
    amountInRaw: '15000000000',
    userAddress: 'noble1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    tradeUsd: 15_000,
    liquidityUsd: 80_000_000,
    symbol: 'USDC',
    fetcher: async (url, init) => {
      if (url.includes('/v2/fungible/route')) {
        return jsonResponse({
          source_asset_denom: 'uusdc',
          source_asset_chain_id: 'noble-1',
          dest_asset_denom: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          dest_asset_chain_id: 'solana',
          amount_in: '15000000000',
          amount_out: '14992000000',
          usd_amount_out: '14992',
          estimated_route_duration_seconds: 35,
          chain_ids: ['noble-1', 'solana'],
          required_chain_addresses: ['noble-1', 'solana'],
          operations: [{ cctp_transfer: {} }],
        });
      }
      skipMsgsBody = String(init?.body ?? '');
      return jsonResponse({
        txs: [
          {
            cosmos_tx: {
              chain_id: 'noble-1',
              msgs: [{ msg_type_url: '/circle.cctp.v1.MsgDepositForBurn', msg: '{}' }],
              signer_address: 'noble1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
            },
          },
        ],
      });
    },
  });
  assert.ok(skipRes);
  const parsedMsgs = JSON.parse(skipMsgsBody) as { slippage_tolerance_percent: string };
  assert.notEqual(parsedMsgs.slippage_tolerance_percent, '2');
  assert.ok(Number(parsedMsgs.slippage_tolerance_percent) <= 0.3);
  assert.ok((skipRes.appliedSlippageBps ?? 999) <= 30);
});

test('Parallel auction deducts Solana ATA rent for non-sponsoring routes when hasSolanaUsdcAta is false', async () => {
  const usdc = mkUsdcAsset('base', 100);
  const feeConfig = getProtocolFeeConfig({ feeBps: 500, feeRecipientEvm: null });

  const result = await runLiveParallelRouteAuction({
    asset: usdc,
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    feeConfig,
    hasSolanaUsdcAta: false,
    solPriceUsd: 150, // ATA rent = 0.00203928 * 150 ~= $0.31
    providers: {
      circle_cctp: async () => ({
        provider: 'circle_cctp',
        estimatedOutput: '100.00 USDC',
        estimatedSeconds: 18,
        quotedOutUsd: 100.0,
        estimatedGasUsd: 0.02,
        extraBridgeFeeUsd: 0.01,
        sponsorsSolanaAta: false, // user must pay ~$0.31 ATA rent -> net ~$99.66
        transactions: [mkTx('base', EVM_CHAINS.base.cctpTokenMessenger!, 'cctp_deposit_for_burn')],
        notes: [],
      }),
      mayan_swift: async () => ({
        provider: 'mayan_swift',
        estimatedOutput: '99.90 USDC',
        estimatedSeconds: 10,
        quotedOutUsd: 99.9,
        estimatedGasUsd: 0.03,
        sponsorsSolanaAta: true, // solver sponsors ATA -> net = $99.87 -> beats CCTP on $100!
        transactions: [mkTx('base', MAYAN_FORWARDER, 'bridge_mayan_swift')],
        notes: [],
      }),
      relay: async () => null,
      debridge_dln: async () => null,
      lifi: async () => null,
    },
  });

  assert.equal(result.routeAuction.winnerProvider, 'mayan_swift');
  const cctpCand = result.routeAuction.candidates.find((c) => c.provider === 'circle_cctp');
  assert.ok(cctpCand && cctpCand.ataRentUsd >= 0.3, `Expected >= $0.30 ATA rent deducted on CCTP, got ${cctpCand?.ataRentUsd}`);
  assert.ok(result.routeAuction.dollarsSavedOverRunnerUp > 0.15);
});

// =====================================================================
// 6. DYNAMIC GAS RESERVE: RECOVER STRANDED DUST + >= 2X SAFETY MARGIN
// =====================================================================

test('computeDynamicGasReserveWei recovers $10+ stranded multi-chain ETH/L2 dust while enforcing >= 2x safety margin', async () => {
  const ETH_PRICE = 2500;
  const multiChainWallet: Array<{ chain: EvmChainId; gasWei: bigint; txCount: number }> = [
    { chain: 'ethereum', gasWei: 3_000_000_000n, txCount: 1 }, // 3 gwei quiet L1
    { chain: 'base', gasWei: 10_000_000n, txCount: 1 }, // 0.01 gwei
    { chain: 'arbitrum', gasWei: 20_000_000n, txCount: 1 }, // 0.02 gwei
    { chain: 'optimism', gasWei: 10_000_000n, txCount: 1 }, // 0.01 gwei
    { chain: 'unichain', gasWei: 10_000_000n, txCount: 1 }, // 0.01 gwei
    { chain: 'linea', gasWei: 50_000_000n, txCount: 1 }, // 0.05 gwei
    { chain: 'scroll', gasWei: 50_000_000n, txCount: 1 }, // 0.05 gwei
    { chain: 'blast', gasWei: 10_000_000n, txCount: 1 }, // 0.01 gwei
  ];

  let totalRecoveredUsd = 0;

  for (const item of multiChainWallet) {
    const summary = computeDynamicGasReserveSummary({
      chain: item.chain,
      liveGasPriceWei: item.gasWei,
      plannedTxCount: item.txCount,
      nativePriceUsd: ETH_PRICE,
    });

    assert.ok(
      summary.reserveWei < summary.staticReserveWei,
      `${item.chain}: dynamic reserve (${summary.reserveNative}) must be smaller than static (${summary.staticReserveNative})`
    );
    assert.ok(
      summary.effectiveSafetyRatio >= MIN_GAS_RESERVE_SAFETY_MULTIPLIER,
      `${item.chain}: safety ratio (${summary.effectiveSafetyRatio}) must be >= 2.0x`
    );
    assert.ok(
      summary.reserveWei >= summary.singleTxEstimatedWei * 2n,
      `${item.chain}: reserveWei must cover >= 2x exact final tx cost`
    );
    totalRecoveredUsd += summary.recoveredUsd;
  }

  assert.ok(
    totalRecoveredUsd >= 10,
    `Expected >= $10 stranded native dust recovered across multi-chain wallet, got $${totalRecoveredUsd.toFixed(2)}`
  );

  // Attempting to pass an unsafe safetyMultiplier < 2.0 must clamp strictly to >= 2.0x!
  const clamped = computeDynamicGasReserveWei('ethereum', 10_000_000_000n, 1, {
    safetyMultiplier: 0.5,
  });
  const exactSingleTxEth = BigInt(EVM_CHAINS.ethereum.swapGasUnits) * 10_000_000_000n;
  assert.ok(
    clamped >= exactSingleTxEth * 2n,
    'Safety multiplier below 2.0 must be clamped up to >= 2.0x fail-closed'
  );

  // Ethereum L1 gas spike (80 gwei, 2 txs): MUST scale UP above static 0.002 ETH so final tx never reverts!
  const spikeReserveWei = computeDynamicGasReserveWei('ethereum', 80_000_000_000n, 2);
  const staticEthReserveWei = 2_000_000_000_000_000n; // 0.002 ETH
  const spikeExact2Tx = 2n * BigInt(EVM_CHAINS.ethereum.swapGasUnits) * 80_000_000_000n;
  assert.ok(spikeReserveWei > staticEthReserveWei, 'L1 gas spike reserve must scale above static 0.002 ETH');
  assert.ok(spikeReserveWei >= spikeExact2Tx * 2n, 'L1 gas spike reserve must preserve >= 2x margin');

  // EIP-7702 / Paymaster gas sponsorship -> 0n reserve (sweep 100% native dust!)
  assert.equal(
    computeDynamicGasReserveWei('base', 50_000_000n, 3, { gasSponsored: true }),
    0n
  );

  // Zero / invalid gas price fails closed to safe non-zero fallback reserve
  assert.ok(computeDynamicGasReserveWei('base', 0n, 1) > 0n);
  assert.ok(computeDynamicGasReserveWei('base', 10_000_000n, 0) > 0n);

  // End-to-end PreparedChainBatch surfaces dynamicGasReserve when liveGasPriceWei is passed
  const usdc = mkUsdcAsset('base', 1000);
  const batchWithReserve = await prepareChainBatchExecution({
    chain: 'base',
    assets: [usdc],
    userAddress: USER_EVM,
    solanaDestination: SOL_DEST,
    bridgePreference: 'cctp',
    allowanceCheckFn: async () => BigInt(usdc.rawBalance) * 2n,
    liveGasPriceWei: 10_000_000n,
    nativePriceUsd: ETH_PRICE,
  });
  assert.ok(batchWithReserve.dynamicGasReserve);
  assert.ok(batchWithReserve.dynamicGasReserve.recoveredNative > 0.0004);
  assert.ok(batchWithReserve.dynamicGasReserve.effectiveSafetyRatio >= 2.0);
});
