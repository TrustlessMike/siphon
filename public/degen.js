// =====================================================================
// SIPHON DEGEN TAB — LIVE JUPITER PREDICTION MARKETS & SIDE-POCKET UI
// Modular, XSS-safe, zero-overflow controller bound to #view-degen.
// =====================================================================

const DEFAULT_FALLBACK_GAME_MODES = [
  {
    id: 'arcade',
    name: 'Jupiter Arcade',
    shortTitle: 'Arcade',
    cadence: '1m rounds',
    badge: 'Up / Down',
    description: '1-min BTC & SOL Up/Down rolling pool rounds.',
    url: 'https://jup.ag/prediction/arcade',
    riskTag: 'High variance · Binary',
  },
  {
    id: 'degen',
    name: 'Jupiter Degen',
    shortTitle: 'Degen',
    cadence: '5m / 15m',
    badge: 'Fast Crypto',
    description: '5-min & 15-min fast crypto Up/Down binary contracts.',
    url: 'https://jup.ag/prediction/degen',
    riskTag: 'High variance · Binary',
  },
  {
    id: 'sports',
    name: 'Jupiter Sports',
    shortTitle: 'Sports',
    cadence: 'Live lines',
    badge: 'No-fee Tickets',
    description: 'Live moneylines, spreads, totals & no-fee game tickets.',
    url: 'https://jup.ag/prediction/sports',
    riskTag: 'Event settlement',
  },
  {
    id: 'combos',
    name: 'Jupiter Combos',
    shortTitle: 'Combos',
    cadence: '2–50 legs',
    badge: 'Parlays',
    description: '2–50 leg sports & esports parlays settled on Solana.',
    url: 'https://jup.ag/prediction/combos',
    riskTag: 'Multi-leg · High variance',
  },
  {
    id: 'perps',
    name: 'Jupiter Perps',
    shortTitle: 'Perps',
    cadence: 'Up to 100x',
    badge: 'Perpetuals',
    description: 'SOL / BTC / ETH perpetuals up to 100x leverage.',
    url: 'https://jup.ag/perps',
    riskTag: 'Liquidation risk',
  },
];

const CATEGORY_TABS = [
  { id: 'trending', label: 'Trending', category: 'all', filter: 'trending' },
  { id: 'live', label: 'Live', category: 'all', filter: 'live' },
  { id: 'sports', label: 'Sports', category: 'sports', filter: 'trending' },
  { id: 'crypto', label: 'Crypto', category: 'crypto', filter: 'trending' },
  { id: 'esports', label: 'Esports', category: 'esports', filter: 'trending' },
  { id: 'politics', label: 'Politics', category: 'politics', filter: 'trending' },
  { id: 'tech', label: 'Tech', category: 'tech', filter: 'trending' },
];

const RISK_PILLS = [5, 10, 20];
const MAX_RISK_PCT = 50;
const HIGH_RISK_WARN_PCT = 25;

const state = {
  initialized: false,
  hasLoadedOnce: false,
  loading: false,
  activeCatId: 'trending',
  searchQuery: '',
  availableUsdc: 250,
  balanceSource: 'Model balance',
  userEditedBalance: false,
  riskPct: 10,
  events: [],
  gameModes: DEFAULT_FALLBACK_GAME_MODES,
  feedMeta: {
    ok: true,
    live: false,
    cached: false,
    fetchedAt: null,
    apiKeyConfigured: false,
    error: null,
  },
  selected: null, // { eventId, eventTitle, eventSlug, jupiterUrl, marketId, marketTitle, side, yes, no }
  stakeUsd: 25,
  orderPreview: null,
  orderPreviewError: null,
  orderPreviewLoading: false,
  liveTxStatus: null,
  previewSeq: 0,
  fetchSeq: 0,
  searchTimer: null,
};

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeHttpsUrl(raw, fallback = 'https://jup.ag/prediction') {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('//')) return fallback;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      return fallback;
    }
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function safeImageUrl(raw) {
  const url = safeHttpsUrl(raw, '');
  return url || null;
}

function fmtUsd(amount, decimals = 2) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function fmtCompactUsd(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtCloseDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function computeLocalSidePocket(availableUsdc, requestedRiskPct) {
  const bal = Number.isFinite(availableUsdc) && availableUsdc >= 0 ? Math.round(availableUsdc * 100) / 100 : 0;
  const reqPct = Number.isFinite(requestedRiskPct) && requestedRiskPct >= 0 ? requestedRiskPct : 10;
  const wasClamped = reqPct > MAX_RISK_PCT;
  const effectiveRiskPct = Math.round(Math.min(MAX_RISK_PCT, Math.max(0, reqPct)) * 100) / 100;
  const maxDegenBudgetUsd = Math.floor(bal * (effectiveRiskPct / 100) * 100 + 1e-9) / 100;
  const preservedUsdc = Math.round(Math.max(0, bal - maxDegenBudgetUsd) * 100) / 100;
  const preservedPct = Math.round((100 - effectiveRiskPct) * 100) / 100;

  let highRiskWarning = null;
  if (wasClamped) {
    highRiskWarning =
      `Requested ${reqPct.toFixed(0)}% exceeds Siphon's 50% preservation hard cap and was clamped to 50%. ` +
      'Binary prediction contracts can settle to $0.';
  } else if (effectiveRiskPct > HIGH_RISK_WARN_PCT) {
    highRiskWarning =
      `High-risk side-pocket (${effectiveRiskPct}%): binary prediction markets can expire worthless ($0). ` +
      'Keep 75%–95% of your Solana USDC preserved.';
  }

  return {
    availableUsdc: bal,
    requestedRiskPct: reqPct,
    effectiveRiskPct,
    wasClamped,
    preservedPct,
    preservedUsdc,
    maxDegenBudgetUsd,
    highRiskWarning,
  };
}

function detectSiphonBalance() {
  // 1. Check live Solana USDC balance badge if connected
  const solBadgeText = document.getElementById('solanaLiveBalanceBadge')?.textContent || '';
  const solMatch = solBadgeText.match(/([\d,]+(?:\.\d+)?)\s*USDC/i);
  const liveSolUsdc = solMatch ? Number(solMatch[1].replaceAll(',', '')) : 0;

  // 2. Check projected net swept USDC on Sweep tab
  const kpiNetText = document.getElementById('kpiNetUsdc')?.textContent || '';
  const sweepMatch = kpiNetText.match(/\$([\d,]+(?:\.\d+)?)/);
  const sweptUsdc = sweepMatch ? Number(sweepMatch[1].replaceAll(',', '')) : 0;

  if (Number.isFinite(liveSolUsdc) && liveSolUsdc > 0 && Number.isFinite(sweptUsdc) && sweptUsdc > 0) {
    return { amount: Math.round((liveSolUsdc + sweptUsdc) * 100) / 100, source: 'Solana + Sweep USDC' };
  }
  if (Number.isFinite(liveSolUsdc) && liveSolUsdc > 0) {
    return { amount: Math.round(liveSolUsdc * 100) / 100, source: 'Live Solana USDC' };
  }
  if (Number.isFinite(sweptUsdc) && sweptUsdc > 0) {
    return { amount: Math.round(sweptUsdc * 100) / 100, source: 'Projected Sweep USDC' };
  }
  return null;
}

function syncBalanceFromSiphon(force = false) {
  if (state.userEditedBalance && !force) return;
  const detected = detectSiphonBalance();
  if (detected && detected.amount > 0) {
    state.availableUsdc = detected.amount;
    state.balanceSource = detected.source;
    const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
    state.stakeUsd = pocket.maxDegenBudgetUsd;
    if (force) state.userEditedBalance = false;
  }
}

function getSelectedSolanaWallet() {
  const raw = document.getElementById('solanaDestInput')?.value?.trim() || '';
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw) ? raw : '';
}

function pickInitialSelection(events) {
  for (const ev of events) {
    for (const m of ev.markets || []) {
      if (m.yes || m.no) {
        return {
          eventId: ev.eventId,
          eventTitle: ev.title,
          eventSlug: ev.slug,
          jupiterUrl: ev.jupiterUrl,
          marketId: m.marketId,
          marketTitle: m.title,
          side: m.yes ? 'yes' : 'no',
          yes: m.yes,
          no: m.no,
        };
      }
    }
  }
  return null;
}

function getActiveQuote(selection) {
  if (!selection) return null;
  return selection.side === 'yes' ? selection.yes : selection.no;
}

function computeLocalPayout(stakeUsd, priceUsd) {
  if (!Number.isFinite(stakeUsd) || stakeUsd <= 0 || !Number.isFinite(priceUsd) || priceUsd <= 0 || priceUsd > 1) {
    return null;
  }
  const shares = stakeUsd / priceUsd;
  const projectedPayoutUsd = Math.round(shares * 100) / 100;
  const projectedProfitUsd = Math.round((projectedPayoutUsd - stakeUsd) * 100) / 100;
  const roiPct = Math.round(((projectedPayoutUsd - stakeUsd) / stakeUsd) * 100);
  return {
    stakeUsd: Math.round(stakeUsd * 100) / 100,
    priceUsd,
    shares: Math.round(shares * 100) / 100,
    projectedPayoutUsd,
    projectedProfitUsd,
    payoutMultiplier: Math.round((1 / priceUsd) * 100) / 100,
    roiPct,
    breakevenProbPct: Math.round(priceUsd * 1000) / 10,
    maxLossUsd: Math.round(stakeUsd * 100) / 100,
  };
}

function updateTabBadge() {
  const badge = document.getElementById('tabDegenCount');
  if (!badge) return;
  if (state.feedMeta.live && state.events.length > 0) {
    badge.textContent = String(state.events.length);
  } else {
    badge.textContent = 'JUP';
  }
}

async function fetchMarkets({ forceSearch = false } = {}) {
  const seq = ++state.fetchSeq;
  state.loading = true;
  renderMarketsSection();

  try {
    let endpoint;
    const q = state.searchQuery.trim();
    if (q) {
      endpoint = `/api/degen/search?q=${encodeURIComponent(q)}&limit=18`;
    } else {
      const tab = CATEGORY_TABS.find((t) => t.id === state.activeCatId) || CATEGORY_TABS[0];
      endpoint = `/api/degen/markets?category=${encodeURIComponent(tab.category)}&filter=${encodeURIComponent(tab.filter)}&limit=18`;
    }

    const resp = await fetch(endpoint, { headers: { Accept: 'application/json' } });
    const data = await resp.json().catch(() => ({}));
    if (seq !== state.fetchSeq) return;

    state.loading = false;
    state.hasLoadedOnce = true;

    if (!resp.ok) {
      state.events = [];
      state.feedMeta = {
        ok: false,
        live: false,
        cached: false,
        fetchedAt: new Date().toISOString(),
        apiKeyConfigured: false,
        error: data?.error || `HTTP ${resp.status} fetching Jupiter markets.`,
      };
    } else {
      state.events = Array.isArray(data.events) ? data.events : [];
      if (Array.isArray(data.gameModes) && data.gameModes.length > 0) {
        state.gameModes = data.gameModes;
      }
      state.feedMeta = {
        ok: Boolean(data.ok),
        live: Boolean(data.live),
        cached: Boolean(data.cached),
        fetchedAt: data.fetchedAt || null,
        apiKeyConfigured: Boolean(data.apiKeyConfigured),
        error: data.error || null,
      };
    }

    // Keep current selection if still valid, else pick first priced outcome
    if (!state.selected || forceSearch) {
      const initial = pickInitialSelection(state.events);
      if (initial) {
        state.selected = initial;
        const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
        if (!Number.isFinite(state.stakeUsd) || state.stakeUsd <= 0 || state.stakeUsd > pocket.maxDegenBudgetUsd) {
          state.stakeUsd = pocket.maxDegenBudgetUsd;
        }
      }
    }

    updateTabBadge();
    renderAll();
    if (state.selected) {
      requestOrderPreview(false);
    }
  } catch (err) {
    if (seq !== state.fetchSeq) return;
    state.loading = false;
    state.hasLoadedOnce = true;
    state.events = [];
    state.feedMeta = {
      ok: false,
      live: false,
      cached: false,
      fetchedAt: new Date().toISOString(),
      apiKeyConfigured: false,
      error: err instanceof Error ? err.message : 'Network error contacting Siphon Degen API.',
    };
    updateTabBadge();
    renderAll();
  }
}

async function requestOrderPreview(requestLiveTx = false) {
  const sel = state.selected;
  const quote = getActiveQuote(sel);
  if (!sel || !quote) {
    state.orderPreview = null;
    state.orderPreviewError = null;
    renderSlip();
    return;
  }

  const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
  const stake = Number(state.stakeUsd);
  if (!Number.isFinite(stake) || stake <= 0) {
    state.orderPreview = null;
    state.orderPreviewError = 'Enter a stake greater than $0.00.';
    renderSlip();
    return;
  }
  if (stake > pocket.maxDegenBudgetUsd + 1e-9) {
    state.orderPreview = null;
    state.orderPreviewError = `Stake ${fmtUsd(stake)} exceeds your capped side-pocket of ${fmtUsd(pocket.maxDegenBudgetUsd)} (${pocket.effectiveRiskPct}% cap).`;
    renderSlip();
    return;
  }

  const seq = ++state.previewSeq;
  state.orderPreviewLoading = true;
  state.orderPreviewError = null;
  if (requestLiveTx) state.liveTxStatus = 'Requesting signable Jupiter transaction…';
  renderSlip();

  try {
    const resp = await fetch('/api/degen/order-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        marketId: sel.marketId,
        side: sel.side,
        stakeUsd: stake,
        availableUsdc: pocket.availableUsdc,
        riskPct: state.riskPct,
        priceUsd: quote.priceUsd,
        eventSlug: sel.eventSlug,
        eventTitle: sel.eventTitle,
        marketTitle: sel.marketTitle,
        walletAddress: getSelectedSolanaWallet() || undefined,
        requestLiveTx,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (seq !== state.previewSeq) return;
    state.orderPreviewLoading = false;

    if (!resp.ok) {
      state.orderPreview = null;
      state.orderPreviewError = data?.error || `Order preview rejected (HTTP ${resp.status}).`;
      if (requestLiveTx) state.liveTxStatus = null;
    } else {
      state.orderPreview = data;
      state.orderPreviewError = null;
      if (requestLiveTx) {
        if (data?.liveOrder?.available) {
          state.liveTxStatus = `Inline Jupiter tx built (Order ${data.liveOrder.orderId || 'ready'}).`;
        } else {
          state.liveTxStatus = data?.liveOrder?.reason || 'Use the direct Jupiter launch button to trade.';
        }
      }
    }
    renderSlip();
  } catch (err) {
    if (seq !== state.previewSeq) return;
    state.orderPreviewLoading = false;
    state.orderPreviewError = err instanceof Error ? err.message : 'Preview request failed.';
    if (requestLiveTx) state.liveTxStatus = null;
    renderSlip();
  }
}

function attachThumbFallbacks(container) {
  if (!container) return;
  container.querySelectorAll('img.degen-event-thumb').forEach((img) => {
    if (img.dataset.fallbackBound === '1') return;
    img.dataset.fallbackBound = '1';
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.className = 'degen-event-thumb-fallback';
      span.textContent = (img.dataset.initials || 'JP').slice(0, 2).toUpperCase();
      img.replaceWith(span);
    });
  });
}

function renderPocketBar() {
  const host = document.getElementById('degenPocketHost');
  if (!host) return;

  const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
  const detected = detectSiphonBalance();

  const riskPillsHtml = RISK_PILLS.map((pct) => {
    const active = Math.abs(pocket.effectiveRiskPct - pct) < 0.01 && !pocket.wasClamped;
    return `<button type="button" class="degen-pct-pill mono ${active ? 'active' : ''}" data-degen-risk="${pct}">${pct}%</button>`;
  }).join('');

  const warningHtml = pocket.highRiskWarning
    ? `<div class="degen-risk-warning ${pocket.wasClamped ? 'is-clamped' : ''}" role="alert">${esc(pocket.highRiskWarning)}</div>`
    : '';

  const liveBadgeHtml = state.feedMeta.live
    ? `<span class="degen-pill-live mono"><span class="degen-live-dot"></span>Jupiter Prediction v1 · Live</span>`
    : state.loading
      ? `<span class="degen-pill-live mono">Connecting Jupiter v1…</span>`
      : `<span class="degen-pill-offline mono">Jupiter v1 Offline</span>`;

  host.innerHTML = `
    <div class="degen-pocket-card">
      <div class="degen-pocket-top">
        <div class="degen-pocket-headline">
          <div class="degen-eyebrow-row">
            <span class="degen-eyebrow mono">PRESERVATION-FIRST SIDE-POCKET</span>
            <span class="degen-pill-safe mono">${esc(pocket.preservedPct)}% Principal Guarded</span>
            ${liveBadgeHtml}
          </div>
          <p class="degen-split-summary" id="degenSplitHeadline">
            Preserved Safe: <span class="degen-safe-num mono">${esc(pocket.preservedPct)}% (${esc(fmtUsd(pocket.preservedUsdc))})</span>
            · Degen Side-Pocket: <span class="degen-cap-num mono">${esc(pocket.effectiveRiskPct)}% (${esc(fmtUsd(pocket.maxDegenBudgetUsd))})</span>
          </p>
        </div>

        <div class="degen-pocket-controls">
          <div class="degen-control-group">
            <label class="degen-control-label" for="degenBalanceInput">
              <span>Solana USDC</span>
              <span class="mono muted-xs">${esc(state.balanceSource)}</span>
            </label>
            <div class="degen-balance-input-wrap">
              <span class="mono muted-xs">$</span>
              <input
                type="number"
                id="degenBalanceInput"
                class="degen-balance-input mono"
                min="0"
                max="10000000"
                step="10"
                value="${esc(pocket.availableUsdc)}"
                aria-label="Available Solana USDC balance"
              />
            </div>
          </div>

          <div class="degen-control-group">
            <span class="degen-control-label">Side-Pocket Cap (max 50%)</span>
            <div class="degen-preset-row" role="group" aria-label="Side-pocket risk percentage">
              ${riskPillsHtml}
              <div class="degen-custom-pct-wrap" title="Custom allocation up to 50% hard cap">
                <input
                  type="number"
                  id="degenCustomPctInput"
                  class="degen-custom-pct-input mono"
                  min="0"
                  max="100"
                  step="1"
                  value="${esc(pocket.effectiveRiskPct)}"
                  aria-label="Custom side-pocket risk percentage"
                />
                <span class="mono muted-xs">%</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="degen-split-bar" aria-hidden="true">
        <div class="degen-split-bar-safe" style="width: ${Math.max(0, Math.min(100, pocket.preservedPct))}%"></div>
        <div class="degen-split-bar-cap" style="width: ${Math.max(0, Math.min(100, pocket.effectiveRiskPct))}%"></div>
      </div>

      ${warningHtml}

      <div class="degen-pocket-foot">
        <span>Non-custodial guard: Siphon caps optional Degen sizing so your migrated Solana principal stays untouched. Binary contracts can settle to $0.</span>
        ${detected ? `<button type="button" class="degen-sync-btn" id="degenSyncBalanceBtn">Sync ${esc(fmtUsd(detected.amount))} (${esc(detected.source)})</button>` : `<span class="mono">Hard ceiling: 50% max</span>`}
      </div>
    </div>
  `;

  const balInput = document.getElementById('degenBalanceInput');
  if (balInput) {
    balInput.addEventListener('change', () => {
      const val = Number(balInput.value);
      if (Number.isFinite(val) && val >= 0) {
        state.availableUsdc = Math.round(val * 100) / 100;
        state.balanceSource = 'Custom balance';
        state.userEditedBalance = true;
        const nextPocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
        if (state.stakeUsd > nextPocket.maxDegenBudgetUsd || state.stakeUsd <= 0) {
          state.stakeUsd = nextPocket.maxDegenBudgetUsd;
        }
        renderPocketBar();
        renderMarketsSection();
        renderSlip();
        requestOrderPreview(false);
      }
    });
  }

  host.querySelectorAll('[data-degen-risk]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextPct = Number(btn.dataset.degenRisk);
      if (!Number.isFinite(nextPct)) return;
      state.riskPct = nextPct;
      const nextPocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
      state.stakeUsd = nextPocket.maxDegenBudgetUsd;
      renderPocketBar();
      renderMarketsSection();
      renderSlip();
      requestOrderPreview(false);
    });
  });

  const customPctInput = document.getElementById('degenCustomPctInput');
  if (customPctInput) {
    customPctInput.addEventListener('change', () => {
      const val = Number(customPctInput.value);
      if (!Number.isFinite(val) || val < 0) return;
      state.riskPct = val;
      const nextPocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
      state.stakeUsd = nextPocket.maxDegenBudgetUsd;
      renderPocketBar();
      renderMarketsSection();
      renderSlip();
      requestOrderPreview(false);
    });
  }

  document.getElementById('degenSyncBalanceBtn')?.addEventListener('click', () => {
    syncBalanceFromSiphon(true);
    renderPocketBar();
    renderMarketsSection();
    renderSlip();
    requestOrderPreview(false);
  });
}

function renderGamesStrip() {
  const host = document.getElementById('degenGamesHost');
  if (!host) return;

  const cardsHtml = state.gameModes
    .map((mode) => {
      const url = safeHttpsUrl(mode.url, 'https://jup.ag/prediction');
      return `
        <a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="degen-game-card">
          <div>
            <div class="degen-game-top">
              <span class="degen-game-name">${esc(mode.name)}</span>
              <span class="degen-game-cadence mono">${esc(mode.cadence)}</span>
            </div>
            <p class="degen-game-desc" style="margin-top:6px;">${esc(mode.description)}</p>
          </div>
          <div class="degen-game-foot">
            <span class="mono">${esc(mode.badge)}</span>
            <span class="degen-game-launch">Launch ↗</span>
          </div>
        </a>
      `;
    })
    .join('');

  host.innerHTML = `
    <div class="degen-games-section">
      <div class="degen-section-head">
        <h2 class="degen-section-title">Jupiter Games &amp; Perps</h2>
        <span class="mono muted-xs">Direct non-custodial Solana venues</span>
      </div>
      <div class="degen-games-grid">${cardsHtml}</div>
    </div>
  `;
}

function renderMarketsSection() {
  const host = document.getElementById('degenFeedHost');
  if (!host) return;

  const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
  const previewStake = pocket.maxDegenBudgetUsd > 0 ? pocket.maxDegenBudgetUsd : 0;

  const catPillsHtml = CATEGORY_TABS.map((cat) => {
    const active = !state.searchQuery.trim() && state.activeCatId === cat.id;
    return `<button type="button" class="degen-cat-pill ${active ? 'active' : ''}" data-degen-cat="${esc(cat.id)}">${esc(cat.label)}</button>`;
  }).join('');

  let statusText = 'Loading live Jupiter Prediction Markets…';
  if (!state.loading) {
    if (state.feedMeta.live) {
      const cacheLabel = state.feedMeta.cached ? 'cached 30s' : 'fresh';
      statusText = state.searchQuery.trim()
        ? `${state.events.length} live matches for “${state.searchQuery.trim()}” · ${cacheLabel}`
        : `${state.events.length} live Jupiter prediction events · ${cacheLabel}`;
    } else if (state.feedMeta.error) {
      statusText = `Live Jupiter feed unavailable: ${state.feedMeta.error}`;
    }
  }

  let cardsHtml = '';
  if (state.loading && state.events.length === 0) {
    cardsHtml = `
      <div class="degen-empty-state">
        <span class="mono">Fetching live odds from api.jup.ag/prediction/v1…</span>
      </div>
    `;
  } else if (!state.feedMeta.live && state.events.length === 0) {
    cardsHtml = `
      <div class="degen-empty-state">
        <strong>Live Jupiter markets temporarily unreachable</strong>
        <span>${esc(state.feedMeta.error || 'Unable to fetch live events from Jupiter Prediction API.')}</span>
        <span class="muted-xs">Siphon never fabricates placeholder markets when live odds are unavailable.</span>
        <button type="button" class="btn-outline-sm" id="degenRetryFeedBtn">Retry Live Feed</button>
      </div>
    `;
  } else if (state.events.length === 0) {
    cardsHtml = `
      <div class="degen-empty-state">
        <strong>No live events matched this filter</strong>
        <span>Try another category or clear your search query.</span>
      </div>
    `;
  } else {
    cardsHtml = state.events
      .map((ev) => {
        const safeUrl = safeHttpsUrl(ev.jupiterUrl, 'https://jup.ag/prediction');
        const imgUrl = safeImageUrl(ev.imageUrl);
        const initials = (ev.title || 'JP')
          .replace(/[^A-Za-z0-9 ]/g, '')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((w) => w[0])
          .join('') || 'JP';
        const thumbHtml = imgUrl
          ? `<img src="${esc(imgUrl)}" alt="" class="degen-event-thumb" loading="lazy" referrerpolicy="no-referrer" data-initials="${esc(initials)}" />`
          : `<span class="degen-event-thumb-fallback">${esc(initials.toUpperCase())}</span>`;

        const topMarkets = (ev.markets || []).slice(0, 3);
        const isEventSelected = state.selected && state.selected.eventId === ev.eventId;

        const outcomesHtml = topMarkets.length
          ? topMarkets
              .map((m) => {
                const isYesActive =
                  state.selected && state.selected.marketId === m.marketId && state.selected.side === 'yes';
                const isNoActive =
                  state.selected && state.selected.marketId === m.marketId && state.selected.side === 'no';
                const yesBtn = m.yes
                  ? `<button type="button" class="degen-quote-btn is-yes mono ${isYesActive ? 'active' : ''}" data-pick-event="${esc(ev.eventId)}" data-pick-market="${esc(m.marketId)}" data-pick-side="yes">YES ${esc(m.yes.cents.toFixed(1))}¢</button>`
                  : `<button type="button" class="degen-quote-btn is-yes mono" disabled>YES —</button>`;
                const noBtn = m.no
                  ? `<button type="button" class="degen-quote-btn is-no mono ${isNoActive ? 'active' : ''}" data-pick-event="${esc(ev.eventId)}" data-pick-market="${esc(m.marketId)}" data-pick-side="no">NO ${esc(m.no.cents.toFixed(1))}¢</button>`
                  : `<button type="button" class="degen-quote-btn is-no mono" disabled>NO —</button>`;

                return `
                  <div class="degen-outcome-row">
                    <span class="degen-outcome-label" title="${esc(m.title)}">${esc(m.title)}</span>
                    <div class="degen-quote-btns">${yesBtn}${noBtn}</div>
                  </div>
                `;
              })
              .join('')
          : `<div class="muted-xs">View active contracts on Jupiter.</div>`;

        const leadQuote = topMarkets[0]?.yes || topMarkets[0]?.no || null;
        let payoutSnippet = 'Select YES or NO for payout math';
        if (leadQuote && previewStake > 0) {
          const proj = computeLocalPayout(previewStake, leadQuote.priceUsd);
          if (proj) {
            payoutSnippet = `${fmtUsd(previewStake, 0)} cap → ${fmtUsd(proj.projectedPayoutUsd)} (${leadQuote.payoutMultiplier.toFixed(2)}x)`;
          }
        }

        const closeLabel = fmtCloseDate(ev.closeTime);
        const volLabel = ev.volume24hrUsd > 0 ? `${fmtCompactUsd(ev.volume24hrUsd)} 24h` : `${fmtCompactUsd(ev.volumeUsd)} vol`;

        return `
          <article class="degen-market-card ${isEventSelected ? 'is-selected' : ''}">
            <div class="degen-event-head">
              ${thumbHtml}
              <div class="degen-event-meta">
                <div class="degen-event-badges mono">
                  ${ev.isLive ? `<span class="degen-live-tag"><span class="degen-live-dot"></span>LIVE</span>` : ''}
                  <span class="degen-cat-tag">${esc(ev.category)}</span>
                  <span>·</span>
                  <span>${esc(volLabel)}</span>
                  ${closeLabel ? `<span>· Ends ${esc(closeLabel)}</span>` : ''}
                </div>
                <h3 class="degen-event-title">${esc(ev.title)}</h3>
              </div>
            </div>

            <div class="degen-outcomes-list">${outcomesHtml}</div>

            <div class="degen-card-foot">
              <span class="mono">${esc(payoutSnippet)}</span>
              <a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" class="degen-jup-link">Jupiter ↗</a>
            </div>
          </article>
        `;
      })
      .join('');
  }

  host.innerHTML = `
    <div class="degen-toolbar">
      <div class="degen-cat-pills" role="tablist" aria-label="Prediction market categories">
        ${catPillsHtml}
      </div>
      <form class="degen-search-form" id="degenSearchForm">
        <input
          type="search"
          id="degenSearchInput"
          class="degen-search-input"
          placeholder="Search Jupiter markets…"
          value="${esc(state.searchQuery)}"
          aria-label="Search live Jupiter prediction markets"
        />
        <button type="button" class="degen-refresh-btn" id="degenRefreshBtn" title="Refresh live markets">Refresh</button>
      </form>
    </div>
    <div class="degen-feed-status mono">
      <span>${esc(statusText)}</span>
      <span>Prices in ¢ · 1 share pays $1.00 if right</span>
    </div>
    <div class="degen-markets-grid" id="degenMarketsGrid">${cardsHtml}</div>
  `;

  attachThumbFallbacks(host);

  host.querySelectorAll('[data-degen-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const catId = btn.dataset.degenCat;
      if (!catId) return;
      state.activeCatId = catId;
      state.searchQuery = '';
      fetchMarkets({ forceSearch: false });
    });
  });

  const searchForm = document.getElementById('degenSearchForm');
  const searchInput = document.getElementById('degenSearchInput');
  if (searchForm && searchInput) {
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      state.searchQuery = searchInput.value.trim();
      fetchMarkets({ forceSearch: true });
    });
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      if (state.searchTimer) clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        fetchMarkets({ forceSearch: true });
      }, 320);
    });
  }

  document.getElementById('degenRefreshBtn')?.addEventListener('click', () => {
    fetchMarkets({ forceSearch: false });
  });
  document.getElementById('degenRetryFeedBtn')?.addEventListener('click', () => {
    fetchMarkets({ forceSearch: false });
  });

  host.querySelectorAll('[data-pick-market]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const eventId = btn.dataset.pickEvent;
      const marketId = btn.dataset.pickMarket;
      const side = btn.dataset.pickSide === 'no' ? 'no' : 'yes';
      const ev = state.events.find((e) => e.eventId === eventId);
      const market = ev?.markets?.find((m) => m.marketId === marketId);
      if (!ev || !market) return;

      state.selected = {
        eventId: ev.eventId,
        eventTitle: ev.title,
        eventSlug: ev.slug,
        jupiterUrl: ev.jupiterUrl,
        marketId: market.marketId,
        marketTitle: market.title,
        side,
        yes: market.yes,
        no: market.no,
      };
      state.liveTxStatus = null;
      const curPocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
      if (!Number.isFinite(state.stakeUsd) || state.stakeUsd <= 0 || state.stakeUsd > curPocket.maxDegenBudgetUsd) {
        state.stakeUsd = curPocket.maxDegenBudgetUsd;
      }
      renderMarketsSection();
      renderSlip();
      requestOrderPreview(false);
    });
  });
}

function renderSlip() {
  const host = document.getElementById('degenSlipHost');
  if (!host) return;

  const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct);
  const sel = state.selected;
  const quote = getActiveQuote(sel);

  if (!sel || !quote) {
    host.innerHTML = `
      <div class="degen-slip-card">
        <div class="degen-slip-head">
          <h2>Quick Bet Slip</h2>
          <span class="degen-cap-badge mono">Cap ${esc(fmtUsd(pocket.maxDegenBudgetUsd))}</span>
        </div>
        <div class="muted-xs" style="padding:14px 0;">
          Click any <strong>YES ¢</strong> or <strong>NO ¢</strong> odds pill on a live Jupiter market to model capped payout math and launch directly on Jupiter.
        </div>
      </div>
    `;
    return;
  }

  const stake = Number.isFinite(state.stakeUsd) ? state.stakeUsd : 0;
  const localPayout = computeLocalPayout(stake, quote.priceUsd);
  const serverPayout = state.orderPreview?.payout || null;
  const displayPayout = serverPayout || localPayout;
  const overCap = stake > pocket.maxDegenBudgetUsd + 1e-9;
  const tradeUrl = safeHttpsUrl(state.orderPreview?.jupiterUrl || sel.jupiterUrl, 'https://jup.ag/prediction');
  const canLaunch = !overCap && stake > 0 && !state.orderPreviewError;
  const walletConnected = Boolean(getSelectedSolanaWallet());

  const yesLabel = sel.yes ? `YES ${sel.yes.cents.toFixed(1)}¢ (${sel.yes.payoutMultiplier.toFixed(2)}x)` : 'YES —';
  const noLabel = sel.no ? `NO ${sel.no.cents.toFixed(1)}¢ (${sel.no.payoutMultiplier.toFixed(2)}x)` : 'NO —';

  host.innerHTML = `
    <div class="degen-slip-card">
      <div class="degen-slip-head">
        <h2>Quick Bet Slip</h2>
        <span class="degen-cap-badge mono">Cap ${esc(fmtUsd(pocket.maxDegenBudgetUsd))}</span>
      </div>

      <div class="degen-slip-selection">
        <div class="degen-slip-event">${esc(sel.eventTitle)}</div>
        <div class="degen-slip-market">Outcome: <strong>${esc(sel.marketTitle)}</strong></div>
        <div class="degen-side-toggle" role="group" aria-label="Contract side">
          <button type="button" class="degen-side-opt mono ${sel.side === 'yes' ? 'active-yes' : ''}" id="degenSlipYesBtn" ${sel.yes ? '' : 'disabled'}>${esc(yesLabel)}</button>
          <button type="button" class="degen-side-opt mono ${sel.side === 'no' ? 'active-no' : ''}" id="degenSlipNoBtn" ${sel.no ? '' : 'disabled'}>${esc(noLabel)}</button>
        </div>
      </div>

      <div class="degen-stake-block">
        <div class="degen-stake-head">
          <label for="degenStakeInput">Side-Pocket Wager (USDC)</label>
          <span class="mono">Max ${esc(fmtUsd(pocket.maxDegenBudgetUsd))}</span>
        </div>
        <div class="degen-stake-input-row">
          <span class="mono muted-xs">$</span>
          <input
            type="number"
            id="degenStakeInput"
            class="degen-stake-input mono"
            min="0"
            max="${esc(pocket.maxDegenBudgetUsd)}"
            step="1"
            value="${esc(stake)}"
            aria-label="Wager amount in USD"
          />
          <span class="mono muted-xs">USDC</span>
        </div>
        <div class="degen-quick-stakes">
          <button type="button" class="degen-quick-btn mono" data-stake-frac="0.25">25% cap</button>
          <button type="button" class="degen-quick-btn mono" data-stake-frac="0.5">50% cap</button>
          <button type="button" class="degen-quick-btn mono" data-stake-frac="1">Max cap</button>
        </div>
      </div>

      ${state.orderPreviewError ? `<div class="degen-slip-error" role="alert">${esc(state.orderPreviewError)}</div>` : ''}

      <div class="degen-payout-hero">
        <span class="degen-eyebrow mono">PROJECTED PAYOUT IF ${esc(sel.side.toUpperCase())} WINS</span>
        <div class="degen-payout-row">
          <strong class="degen-payout-val mono" id="degenProjectedPayoutVal">${esc(displayPayout ? fmtUsd(displayPayout.projectedPayoutUsd) : '$0.00')}</strong>
          <span class="degen-payout-roi mono">${esc(displayPayout ? `+${Math.round(displayPayout.roiPct)}% (${displayPayout.payoutMultiplier.toFixed(2)}x)` : '—')}</span>
        </div>
      </div>

      <div class="degen-receipt-list">
        <div class="degen-receipt-row">
          <span>Entry Price / Odds</span>
          <strong class="mono">${esc(quote.cents.toFixed(1))}¢ (${esc(quote.impliedProbPct.toFixed(1))}%)</strong>
        </div>
        <div class="degen-receipt-row">
          <span>Est. Shares ($1 payout ea)</span>
          <strong class="mono">${esc(displayPayout ? displayPayout.shares.toFixed(2) : '0.00')}</strong>
        </div>
        <div class="degen-receipt-row">
          <span>Projected Profit</span>
          <strong class="mono">${esc(displayPayout ? `+${fmtUsd(displayPayout.projectedProfitUsd)}` : '$0.00')}</strong>
        </div>
        <div class="degen-receipt-row">
          <span>Max Loss (Capped)</span>
          <strong class="mono">${esc(displayPayout ? fmtUsd(displayPayout.maxLossUsd) : '$0.00')}</strong>
        </div>
        <div class="degen-receipt-row">
          <span>Principal Preserved Safe</span>
          <strong class="mono" style="color:#065f46;">${esc(fmtUsd(pocket.preservedUsdc))} (${esc(pocket.preservedPct)}%)</strong>
        </div>
      </div>

      <a
        href="${esc(tradeUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        class="degen-trade-cta ${canLaunch ? '' : 'is-disabled'}"
        id="degenTradeJupiterLink"
      >
        Trade on Jupiter →
      </a>

      ${
        state.feedMeta.apiKeyConfigured
          ? `<button type="button" class="degen-live-tx-btn mono" id="degenBuildLiveTxBtn">${walletConnected ? 'Build Signable Jupiter Tx' : 'Connect Solana for Inline Tx'}</button>`
          : ''
      }
      ${state.liveTxStatus ? `<div class="degen-slip-note mono">${esc(state.liveTxStatus)}</div>` : ''}

      <div class="degen-slip-note">
        ${state.orderPreviewLoading ? 'Verifying side-pocket cap…' : 'Non-custodial payout calculator verified against Siphon side-pocket cap. Execution settles directly on Jupiter / Solana.'}
      </div>
    </div>
  `;

  document.getElementById('degenSlipYesBtn')?.addEventListener('click', () => {
    if (!sel.yes) return;
    state.selected = { ...sel, side: 'yes' };
    renderMarketsSection();
    renderSlip();
    requestOrderPreview(false);
  });

  document.getElementById('degenSlipNoBtn')?.addEventListener('click', () => {
    if (!sel.no) return;
    state.selected = { ...sel, side: 'no' };
    renderMarketsSection();
    renderSlip();
    requestOrderPreview(false);
  });

  const stakeInput = document.getElementById('degenStakeInput');
  if (stakeInput) {
    stakeInput.addEventListener('change', () => {
      const val = Number(stakeInput.value);
      state.stakeUsd = Number.isFinite(val) ? Math.round(val * 100) / 100 : 0;
      renderSlip();
      requestOrderPreview(false);
    });
  }

  host.querySelectorAll('[data-stake-frac]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const frac = Number(btn.dataset.stakeFrac);
      if (!Number.isFinite(frac)) return;
      state.stakeUsd = Math.floor(pocket.maxDegenBudgetUsd * frac * 100) / 100;
      renderSlip();
      requestOrderPreview(false);
    });
  });

  document.getElementById('degenBuildLiveTxBtn')?.addEventListener('click', () => {
    if (!getSelectedSolanaWallet()) {
      document.getElementById('connectSolBtn')?.click();
      return;
    }
    requestOrderPreview(true);
  });
}

function renderAll() {
  renderPocketBar();
  renderGamesStrip();
  renderMarketsSection();
  renderSlip();
}

function mountShell() {
  const root = document.getElementById('degenRoot');
  if (!root || state.initialized) return;
  state.initialized = true;

  root.innerHTML = `
    <div id="degenPocketHost"></div>
    <div id="degenGamesHost"></div>
    <div class="degen-workspace">
      <div class="degen-feed-col" id="degenFeedHost"></div>
      <aside class="degen-slip-col" id="degenSlipHost" aria-label="Quick Bet Slip and Payout Calculator"></aside>
    </div>
  `;

  syncBalanceFromSiphon(false);
  renderAll();
}

function onDegenTabActivated() {
  mountShell();
  syncBalanceFromSiphon(false);
  renderPocketBar();
  if (!state.hasLoadedOnce && !state.loading) {
    fetchMarkets({ forceSearch: false });
  }
}

function initDegenModule() {
  const pane = document.getElementById('view-degen');
  if (!pane) return;

  mountShell();

  // Trigger live load when user activates the Degen tab (via click or switchView)
  const paneObserver = new MutationObserver(() => {
    if (pane.classList.contains('active')) {
      onDegenTabActivated();
    }
  });
  paneObserver.observe(pane, { attributes: true, attributeFilter: ['class'] });

  document.querySelectorAll('.app-tab[data-view="degen"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      onDegenTabActivated();
    });
  });

  // Auto-sync balance if Solana live balance or Sweep payout hero updates
  const watchEl = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const obs = new MutationObserver(() => {
      if (!state.userEditedBalance) {
        syncBalanceFromSiphon(false);
        if (pane.classList.contains('active')) {
          renderPocketBar();
          renderSlip();
        }
      }
    });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
  };
  watchEl('solanaLiveBalanceBadge');
  watchEl('kpiNetUsdc');

  if (pane.classList.contains('active')) {
    onDegenTabActivated();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDegenModule);
} else {
  initDegenModule();
}
