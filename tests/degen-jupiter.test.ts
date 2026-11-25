import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  buildJupiterEventUrl,
  buildSidePricingQuote,
  computeDegenSidePocket,
  computeProjectedPayout,
  JUPITER_GAME_MODES,
  JupiterMarketsClient,
  normalizeJupiterCategoryAndFilter,
  normalizeJupiterEvent,
  parseMicroUsd,
  sanitizeDegenText,
  sanitizeHttpsUrl,
  sanitizeJupiterSlug,
} from '../src/degen/jupiter-markets.js';
import { createSiphonServer } from '../src/server/app.js';

const VALID_SOLANA_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function makeMockJupiterEventsPayload() {
  return {
    data: [
      {
        eventId: 'POLY-1425701',
        isActive: true,
        isLive: true,
        category: 'crypto',
        subcategory: 'btc',
        tags: ['crypto', 'bitcoin', '<script>alert(1)</script>'],
        metadata: {
          slug: 'bitcoin-price-on-november-26-2026',
          title: 'Bitcoin price on November 26? <img src=x onerror=alert(1)>',
          subtitle: 'Binance BTC/USDT 1m close',
          imageUrl: 'https://polymarket-upload.s3.us-east-2.amazonaws.com/BTC+fullsize.png',
          closeTime: '2026-11-26T17:00:00Z',
          series: 'polymarket',
        },
        volumeUsd: '73251000000',
        volume24hr: '53902000000',
        markets: [
          {
            provider: 'polymarket',
            marketId: 'POLY-7176619',
            status: 'open',
            title: 'BTC > $120,000',
            closeTime: 1795712400,
            pricing: {
              buyYesPriceUsd: 194000,
              sellYesPriceUsd: 190000,
              buyNoPriceUsd: 806000,
              sellNoPriceUsd: 800000,
              volume: 47530,
            },
            outcomes: ['Yes', 'No'],
            sportsMarketType: null,
            comboStatus: 'disabled',
          },
          {
            provider: 'polymarket',
            marketId: 'POLY-7176617',
            status: 'open',
            title: 'BTC $100k–$120k',
            closeTime: 1795712400,
            pricing: {
              buyYesPriceUsd: '460000',
              sellYesPriceUsd: '450000',
              buyNoPriceUsd: '550000',
              sellNoPriceUsd: '540000',
              volume: 10696,
            },
            outcomes: ['Yes', 'No'],
            sportsMarketType: null,
            comboStatus: 'disabled',
          },
        ],
      },
      {
        eventId: 'POLY-EVIL-01',
        isActive: true,
        isLive: false,
        category: 'sports',
        subcategory: 'nba',
        tags: ['nba'],
        metadata: {
          slug: 'javascript:alert(1)',
          title: '<svg onload=alert(1)>Lakers vs Celtics</svg>',
          subtitle: 'Regular season',
          imageUrl: 'javascript:alert(document.cookie)',
          closeTime: '2026-11-28T03:00:00Z',
          series: 'polymarket',
        },
        volumeUsd: '1500000000',
        volume24hr: '500000000',
        markets: [
          {
            provider: 'polymarket',
            marketId: 'POLY-NBA-1',
            status: 'open',
            title: 'Lakers Moneyline',
            closeTime: '2026-11-28T03:00:00Z',
            pricing: {
              buyYesPriceUsd: 500000,
              buyNoPriceUsd: 520000,
              volume: 1200,
            },
            outcomes: ['Yes', 'No'],
            sportsMarketType: 'moneyline',
            comboStatus: 'enabled',
          },
        ],
      },
    ],
    pagination: { start: 0, end: 18, total: 2 },
  };
}

test('micro-USD (1e6) parsing and payout math produce exact odds, multipliers, and projected payouts', () => {
  // Volume micro-USD conversion
  assert.equal(parseMicroUsd('73251000000'), 73251);
  assert.equal(parseMicroUsd('53902000000'), 53902);
  assert.equal(parseMicroUsd(194000), 0.194);
  assert.equal(parseMicroUsd('194000'), 0.194);
  assert.equal(parseMicroUsd(0), 0);

  // Fail closed on invalid inputs
  assert.equal(parseMicroUsd(-5), null);
  assert.equal(parseMicroUsd('NaN'), null);
  assert.equal(parseMicroUsd(Number.NaN), null);
  assert.equal(parseMicroUsd(Number.POSITIVE_INFINITY), null);
  assert.equal(parseMicroUsd('not-a-number'), null);
  assert.equal(parseMicroUsd(null), null);
  assert.equal(parseMicroUsd(true), null);

  // Exact quote for 194000 micro-USD ($0.194 = 19.4¢ YES -> 5.15x)
  const yesQuote = buildSidePricingQuote(parseMicroUsd(194000), parseMicroUsd(190000));
  assert.ok(yesQuote);
  assert.equal(yesQuote.priceUsd, 0.194);
  assert.equal(yesQuote.cents, 19.4);
  assert.equal(yesQuote.impliedProbPct, 19.4);
  assert.equal(yesQuote.payoutMultiplier, 5.15);
  assert.equal(yesQuote.sellPriceUsd, 0.19);

  // Exact projected payout for $25 @ 19.4¢ YES -> $128.87 payout (+415.46% / +$103.87 profit)
  const payout = computeProjectedPayout(25, yesQuote.priceUsd);
  assert.equal(payout.stakeUsd, 25);
  assert.equal(payout.priceUsd, 0.194);
  assert.equal(payout.projectedPayoutUsd, 128.87);
  assert.equal(payout.projectedProfitUsd, 103.87);
  assert.equal(payout.payoutMultiplier, 5.15);
  assert.equal(Math.floor(payout.roiPct), 415);
  assert.equal(payout.breakevenProbPct, 19.4);
  assert.equal(payout.maxLossUsd, 25);

  // Fail closed on out-of-range prices or non-positive stakes
  assert.equal(buildSidePricingQuote(0), null);
  assert.equal(buildSidePricingQuote(1.05), null);
  assert.throws(() => computeProjectedPayout(0, 0.5));
  assert.throws(() => computeProjectedPayout(-10, 0.5));
  assert.throws(() => computeProjectedPayout(Number.NaN, 0.5));
  assert.throws(() => computeProjectedPayout(10, 0));
  assert.throws(() => computeProjectedPayout(10, 1.2));
});

test('computeDegenSidePocket preserves 90% default principal, warns >25%, clamps >50%, and fails closed on invalid input', () => {
  // Default 10% side-pocket preserves 90%
  const def = computeDegenSidePocket({ availableUsdc: 250 });
  assert.equal(def.effectiveRiskPct, 10);
  assert.equal(def.preservedPct, 90);
  assert.equal(def.preservedUsdc, 225);
  assert.equal(def.maxDegenBudgetUsd, 25);
  assert.equal(def.wasClamped, false);
  assert.equal(def.highRiskWarning, null);
  assert.deepEqual([...def.presetsPct], [5, 10, 15, 25]);

  // 25% boundary has no high-risk warning
  const p25 = computeDegenSidePocket({ availableUsdc: 1000, riskPct: 25 });
  assert.equal(p25.maxDegenBudgetUsd, 250);
  assert.equal(p25.preservedUsdc, 750);
  assert.equal(p25.highRiskWarning, null);

  // 30% triggers explicit high-risk warning (>25%) without clamping
  const p30 = computeDegenSidePocket({ availableUsdc: 1000, riskPct: 30 });
  assert.equal(p30.effectiveRiskPct, 30);
  assert.equal(p30.wasClamped, false);
  assert.equal(p30.maxDegenBudgetUsd, 300);
  assert.equal(p30.preservedUsdc, 700);
  assert.ok(p30.highRiskWarning && p30.highRiskWarning.includes('High-risk'));

  // 80% is hard-clamped to 50% with explicit clamp warning
  const p80 = computeDegenSidePocket({ availableUsdc: 1000, riskPct: 80 });
  assert.equal(p80.requestedRiskPct, 80);
  assert.equal(p80.effectiveRiskPct, 50);
  assert.equal(p80.wasClamped, true);
  assert.equal(p80.maxDegenBudgetUsd, 500);
  assert.equal(p80.preservedUsdc, 500);
  assert.ok(p80.highRiskWarning && p80.highRiskWarning.includes('50%'));

  // Cent flooring guarantees budget never rounds above percentage cap
  const odd = computeDegenSidePocket({ availableUsdc: 33.33, riskPct: 10 });
  assert.equal(odd.maxDegenBudgetUsd, 3.33);
  assert.equal(odd.preservedUsdc, 30);

  // Fail closed on NaN, Infinity, negative balances or negative riskPct
  assert.throws(() => computeDegenSidePocket({ availableUsdc: Number.NaN }));
  assert.throws(() => computeDegenSidePocket({ availableUsdc: -100 }));
  assert.throws(() => computeDegenSidePocket({ availableUsdc: Number.POSITIVE_INFINITY }));
  assert.throws(() => computeDegenSidePocket({ availableUsdc: 100, riskPct: -5 }));
  assert.throws(() => computeDegenSidePocket({ availableUsdc: 100, riskPct: Number.NaN }));
});

test('malicious slugs, XSS titles, and unsafe URLs are strictly neutralized', () => {
  // Slug validation
  assert.equal(sanitizeJupiterSlug('bitcoin-price-on-november-26-2026'), 'bitcoin-price-on-november-26-2026');
  assert.equal(sanitizeJupiterSlug('nba_finals_2026'), 'nba_finals_2026');
  assert.equal(sanitizeJupiterSlug('javascript:alert(1)'), null);
  assert.equal(sanitizeJupiterSlug('../../evil'), null);
  assert.equal(sanitizeJupiterSlug('foo/bar?x=1'), null);
  assert.equal(sanitizeJupiterSlug('<script>alert(1)</script>'), null);
  assert.equal(sanitizeJupiterSlug('slug with spaces'), null);

  // Event URL deep link fallback
  assert.equal(
    buildJupiterEventUrl('bitcoin-price-on-november-26-2026'),
    'https://jup.ag/prediction/bitcoin-price-on-november-26-2026'
  );
  assert.equal(buildJupiterEventUrl('javascript:alert(1)'), 'https://jup.ag/prediction');
  assert.equal(buildJupiterEventUrl('../../evil'), 'https://jup.ag/prediction');

  // HTTPS-only image/link sanitizer
  assert.equal(
    sanitizeHttpsUrl('https://polymarket-upload.s3.us-east-2.amazonaws.com/BTC+fullsize.png'),
    'https://polymarket-upload.s3.us-east-2.amazonaws.com/BTC+fullsize.png'
  );
  assert.equal(sanitizeHttpsUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeHttpsUrl('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeHttpsUrl('http://insecure.example/img.png'), null);
  assert.equal(sanitizeHttpsUrl('//protocol-relative.example/img.png'), null);
  assert.equal(sanitizeHttpsUrl('https://user:pass@evil.example/a.png'), null);

  // XSS text neutralization
  const cleanTitle = sanitizeDegenText('BTC? <img src=x onerror=alert(1)> <b>Now</b>');
  assert.equal(cleanTitle.includes('<'), false);
  assert.equal(cleanTitle.includes('>'), false);
  assert.equal(cleanTitle, 'BTC? Now');

  // Full event normalization on malicious fixture
  const payload = makeMockJupiterEventsPayload();
  const safeEv = normalizeJupiterEvent(payload.data[0]);
  assert.ok(safeEv);
  assert.equal(safeEv.volumeUsd, 73251);
  assert.equal(safeEv.volume24hrUsd, 53902);
  assert.equal(safeEv.jupiterUrl, 'https://jup.ag/prediction/bitcoin-price-on-november-26-2026');
  assert.equal(safeEv.title.includes('<img'), false);
  assert.equal(safeEv.markets[0].yes?.cents, 19.4);
  assert.equal(safeEv.markets[0].yes?.payoutMultiplier, 5.15);

  const evilEv = normalizeJupiterEvent(payload.data[1]);
  assert.ok(evilEv);
  assert.equal(evilEv.slug, null);
  assert.equal(evilEv.jupiterUrl, 'https://jup.ag/prediction');
  assert.equal(evilEv.imageUrl, null);
  assert.equal(evilEv.title.includes('<svg'), false);
  assert.equal(evilEv.title, 'Lakers vs Celtics');
});

test('JUPITER_GAME_MODES exposes all 5 verified Jupiter venues over HTTPS', () => {
  const ids = JUPITER_GAME_MODES.map((m) => m.id);
  assert.deepEqual(ids, ['arcade', 'degen', 'sports', 'combos', 'perps']);
  for (const mode of JUPITER_GAME_MODES) {
    assert.ok(mode.url.startsWith('https://jup.ag/'), `Expected https://jup.ag/ URL for ${mode.id}`);
  }
  assert.deepEqual(normalizeJupiterCategoryAndFilter('trending', null), {
    category: 'all',
    filter: 'trending',
  });
  assert.deepEqual(normalizeJupiterCategoryAndFilter('sports', 'live'), {
    category: 'sports',
    filter: 'live',
  });
});

test('JupiterMarketsClient enforces 30s TTL cache, forwards x-api-key, and never fabricates markets on error', async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  let capturedHeaders: Record<string, string> = {};

  const client = new JupiterMarketsClient({
    apiKey: 'test-jup-key-123',
    cacheTtlMs: 30_000,
    nowMs: () => now,
    fetchImpl: async (_input, init) => {
      calls += 1;
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify(makeMockJupiterEventsPayload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const first = await client.fetchEvents({ category: 'crypto', filter: 'trending', limit: 18 });
  assert.equal(first.ok, true);
  assert.equal(first.live, true);
  assert.equal(first.cached, false);
  assert.equal(first.events.length, 2);
  assert.equal(calls, 1);
  assert.equal(capturedHeaders['x-api-key'], 'test-jup-key-123');

  // Within 30s TTL -> cache hit, 0 extra fetches
  now += 15_000;
  const second = await client.fetchEvents({ category: 'crypto', filter: 'trending', limit: 18 });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);

  // Past 30s TTL -> refreshes live
  now += 20_000;
  const third = await client.fetchEvents({ category: 'crypto', filter: 'trending', limit: 18 });
  assert.equal(third.cached, false);
  assert.equal(calls, 2);

  // Upstream failure -> honest error, ZERO fabricated events
  const failingClient = new JupiterMarketsClient({
    fetchImpl: async () => new Response('upstream down', { status: 503 }),
  });
  const failed = await failingClient.fetchEvents({ category: 'all', filter: 'trending' });
  assert.equal(failed.ok, false);
  assert.equal(failed.live, false);
  assert.equal(failed.events.length, 0);
  assert.ok(failed.error && failed.error.includes('503'));
  assert.equal(failed.gameModes.length, 5);
});

test('HTTP endpoints GET /api/degen/markets, GET /api/degen/search, and POST /api/degen/order-preview work end-to-end', async () => {
  const mockPayload = makeMockJupiterEventsPayload();
  const orderPostBodies: Array<Record<string, unknown>> = [];

  const degenClient = new JupiterMarketsClient({
    apiKey: 'jup-live-key',
    fetchImpl: async (input, init) => {
      const urlStr = String(input);
      if (urlStr.includes('/orders')) {
        orderPostBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(
          JSON.stringify({
            orderId: 'ord_jup_999',
            transaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAA==',
            expiresAt: '2026-11-26T17:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify(mockPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const { server } = createSiphonServer({ degenClient });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /api/degen/markets
    const mResp = await fetch(`${base}/api/degen/markets?category=trending&filter=trending&limit=18`);
    assert.equal(mResp.status, 200);
    const mJson = (await mResp.json()) as {
      ok: boolean;
      live: boolean;
      events: Array<{ eventId: string; jupiterUrl: string; markets: Array<{ marketId: string; yes: { cents: number } }> }>;
      gameModes: Array<{ id: string }>;
    };
    assert.equal(mJson.ok, true);
    assert.equal(mJson.live, true);
    assert.equal(mJson.events.length, 2);
    assert.equal(mJson.gameModes.length, 5);
    assert.equal(mJson.events[0].markets[0].yes.cents, 19.4);
    assert.equal(mJson.events[1].jupiterUrl, 'https://jup.ag/prediction');

    // Invalid limit fails closed with 400
    const badLimitResp = await fetch(`${base}/api/degen/markets?limit=999`);
    assert.equal(badLimitResp.status, 400);

    // 2. GET /api/degen/search
    const sResp = await fetch(`${base}/api/degen/search?q=bitcoin`);
    assert.equal(sResp.status, 200);
    const sJson = (await sResp.json()) as { ok: boolean; query: string; events: unknown[] };
    assert.equal(sJson.ok, true);
    assert.equal(sJson.query, 'bitcoin');
    assert.equal(sJson.events.length, 2);

    const emptySearchResp = await fetch(`${base}/api/degen/search?q=`);
    assert.equal(emptySearchResp.status, 400);

    // 3. POST /api/degen/order-preview — valid capped stake ($25 @ 19.4¢ YES)
    const pResp = await fetch(`${base}/api/degen/order-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketId: 'POLY-7176619',
        side: 'yes',
        stakeUsd: 25,
        availableUsdc: 250,
        riskPct: 10,
        eventSlug: 'bitcoin-price-on-november-26-2026',
      }),
    });
    assert.equal(pResp.status, 200);
    const pJson = (await pResp.json()) as {
      ok: boolean;
      jupiterUrl: string;
      sidePocket: { preservedUsdc: number; maxDegenBudgetUsd: number };
      payout: { projectedPayoutUsd: number; payoutMultiplier: number; roiPct: number };
      remainingSidePocketUsd: number;
    };
    assert.equal(pJson.ok, true);
    assert.equal(pJson.sidePocket.preservedUsdc, 225);
    assert.equal(pJson.sidePocket.maxDegenBudgetUsd, 25);
    assert.equal(pJson.payout.projectedPayoutUsd, 128.87);
    assert.equal(pJson.payout.payoutMultiplier, 5.15);
    assert.equal(Math.floor(pJson.payout.roiPct), 415);
    assert.equal(pJson.remainingSidePocketUsd, 0);
    assert.equal(pJson.jupiterUrl, 'https://jup.ag/prediction/bitcoin-price-on-november-26-2026');

    // 4. POST /api/degen/order-preview — stake exceeding side-pocket cap MUST fail closed (400)
    const overCapResp = await fetch(`${base}/api/degen/order-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketId: 'POLY-7176619',
        side: 'yes',
        stakeUsd: 25.01,
        availableUsdc: 250,
        riskPct: 10,
      }),
    });
    assert.equal(overCapResp.status, 400);
    const overCapJson = (await overCapResp.json()) as { error: string };
    assert.ok(overCapJson.error.includes('exceeds'));

    // 5. POST /api/degen/order-preview — optional live Jupiter order builder with API key + Solana wallet
    const liveTxResp = await fetch(`${base}/api/degen/order-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketId: 'POLY-7176619',
        side: 'yes',
        stakeUsd: 10,
        availableUsdc: 250,
        riskPct: 10,
        walletAddress: VALID_SOLANA_WALLET,
        requestLiveTx: true,
      }),
    });
    assert.equal(liveTxResp.status, 200);
    const liveTxJson = (await liveTxResp.json()) as {
      liveOrder: { attempted: boolean; available: boolean; orderId: string; transactionBase64: string };
    };
    assert.equal(liveTxJson.liveOrder.attempted, true);
    assert.equal(liveTxJson.liveOrder.available, true);
    assert.equal(liveTxJson.liveOrder.orderId, 'ord_jup_999');
    assert.ok(liveTxJson.liveOrder.transactionBase64.length > 10);
    assert.equal(orderPostBodies.length, 1);
    assert.equal(orderPostBodies[0]?.ownerPubkey, VALID_SOLANA_WALLET);
    assert.equal(orderPostBodies[0]?.depositAmount, '10000000');

    // Invalid Solana wallet on live tx request fails closed (400)
    const badWalletResp = await fetch(`${base}/api/degen/order-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketId: 'POLY-7176619',
        side: 'yes',
        stakeUsd: 10,
        availableUsdc: 250,
        riskPct: 10,
        walletAddress: 'not-a-solana-key!!!',
        requestLiveTx: true,
      }),
    });
    assert.equal(badWalletResp.status, 400);

    // 6. Static assets served cleanly
    const jsResp = await fetch(`${base}/degen.js`);
    const cssResp = await fetch(`${base}/degen.css`);
    assert.equal(jsResp.status, 200);
    assert.equal(cssResp.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
