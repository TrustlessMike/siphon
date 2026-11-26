// =====================================================================
// TURGALIUM DEGEN TAB — LIVE JUPITER PREDICTION MARKETS, INLINE SIGNING,
// LIVE POSITIONS / CLAIMS & PRESERVATION-FIRST YIELD SPLIT UI
// Modular, XSS-safe, zero-overflow controller bound to #view-degen.
// =====================================================================

import {
  getConnectedSolanaAddress,
  isUserRejectedError,
  isValidSolanaBase58,
  signAndSendSolanaVersionedTx,
} from './wallets.js?v=7';

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
const MIN_JUPITER_ORDER_USD = 5;
const DEFAULT_YIELD_APY_PCT = 7;
const YIELD_HORIZON_DAYS = 30;
const JUPITER_ALLOWED_HOSTS = ['jup.ag'];
const SOLSCAN_ALLOWED_HOSTS = ['solscan.io'];

const state = {
  initialized: false,
  hasLoadedOnce: false,
  loading: false,
  activeCatId: 'trending',
  searchQuery: '',
  availableUsdc: 250,
  balanceSource: 'Model balance',
  userEditedBalance: false,
  turgaliumBalanceDetail: null, // populated by clean `turgalium:balance-updated` CustomEvent
  sidePocketMode: 'percent', // 'percent' | 'yield_funded'
  riskPct: 10,
  yieldApyPct: DEFAULT_YIELD_APY_PCT,
  events: [],
  gameModes: DEFAULT_FALLBACK_GAME_MODES,
  feedMeta: {
    ok: true,
    live: false,
    cached: false,
    fetchedAt: null,
    apiKeyConfigured: false,
    geoBlocked: false,
    error: null,
  },
  selected: null, // { eventId, eventTitle, eventSlug, jupiterUrl, marketId, marketTitle, side, yes, no }
  stakeUsd: 25,
  orderPreview: null,
  orderPreviewBindingKey: null,
  orderPreviewError: null,
  orderPreviewLoading: false,
  signingOrder: false,
  liveTxStatus: null,
  liveTxError: null,
  lastOrderTx: null, // { signature, solscanUrl, walletName, orderId }
  positions: [],
  positionsSummary: null,
  positionsOwner: '',
  positionsLoading: false,
  positionsError: null,
  positionsGeoBlocked: false,
  positionsSeq: 0,
  positionBusyId: null,
  positionActionFeedback: null, // { positionId, type: 'success'|'info'|'error', message, solscanUrl?, jupiterUrl? }
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

function hostMatchesAllowlist(hostname, allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return true;
  const host = String(hostname || '').toLowerCase();
  return allowedHosts.some((rawAllowed) => {
    const allowed = String(rawAllowed || '').toLowerCase().replace(/^\*\./, '');
    return Boolean(allowed) && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

function safeHttpsUrl(raw, fallback = 'https://jup.ag/prediction', allowedHosts = JUPITER_ALLOWED_HOSTS) {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('//')) return fallback;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      return fallback;
    }
    if (allowedHosts && !hostMatchesAllowlist(parsed.hostname, allowedHosts)) {
      return fallback;
    }
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function safeImageUrl(raw) {
  const url = safeHttpsUrl(raw, '', null);
  return url || null;
}

function buildOrderBindingKey(walletAddress, marketId, side, stakeUsd) {
  return `${String(walletAddress || '').trim()}|${String(marketId || '').trim()}|${String(side || '').trim()}|${Number(stakeUsd).toFixed(2)}`;
}

function clearOrderSigningState({ clearPositionFeedback = false } = {}) {
  state.previewSeq += 1;
  state.orderPreview = null;
  state.orderPreviewBindingKey = null;
  state.orderPreviewError = null;
  state.orderPreviewLoading = false;
  state.lastOrderTx = null;
  state.liveTxStatus = null;
  state.liveTxError = null;
  if (clearPositionFeedback) {
    state.positionActionFeedback = null;
  }
}

function fmtUsd(amount, decimals = 2) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '$0.00';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function fmtSignedUsd(amount, decimals = 2) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '$0.00';
  if (n > 0) return `+${fmtUsd(n, decimals)}`;
  return fmtUsd(n, decimals);
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

function shortSig(sig) {
  const s = String(sig || '').trim();
  if (s.length <= 16) return s;
  return `${s.slice(0, 6)}…${s.slice(-6)}`;
}

function computeLocalSidePocket(
  availableUsdc,
  requestedRiskPct,
  mode = state.sidePocketMode,
  yieldApyPct = state.yieldApyPct
) {
  const bal = Number.isFinite(availableUsdc) && availableUsdc >= 0 ? Math.round(availableUsdc * 100) / 100 : 0;
  const apy = Number.isFinite(yieldApyPct) && yieldApyPct >= 0 ? Math.min(100, yieldApyPct) : DEFAULT_YIELD_APY_PCT;

  if (mode === 'yield_funded') {
    const preservedUsdc = bal;
    const projectedAnnualYieldUsd = Math.round(preservedUsdc * (apy / 100) * 100) / 100;
    const projected30dYieldUsd =
      Math.floor(preservedUsdc * (apy / 100) * (YIELD_HORIZON_DAYS / 365) * 100 + 1e-9) / 100;
    const maxDegenBudgetUsd = projected30dYieldUsd;
    const effectiveRiskPct = bal > 0 ? Math.round((maxDegenBudgetUsd / bal) * 10000) / 100 : 0;
    return {
      mode: 'yield_funded',
      availableUsdc: bal,
      requestedRiskPct: 0,
      effectiveRiskPct,
      wasClamped: false,
      preservedPct: 100,
      preservedUsdc,
      maxDegenBudgetUsd,
      yieldApyPct: apy,
      projectedAnnualYieldUsd,
      projected30dYieldUsd,
      highRiskWarning: null,
    };
  }

  const reqPct = Number.isFinite(requestedRiskPct) && requestedRiskPct >= 0 ? requestedRiskPct : 10;
  const wasClamped = reqPct > MAX_RISK_PCT;
  const effectiveRiskPct = Math.round(Math.min(MAX_RISK_PCT, Math.max(0, reqPct)) * 100) / 100;
  const maxDegenBudgetUsd = Math.floor(bal * (effectiveRiskPct / 100) * 100 + 1e-9) / 100;
  const preservedUsdc = Math.round(Math.max(0, bal - maxDegenBudgetUsd) * 100) / 100;
  const preservedPct = Math.round((100 - effectiveRiskPct) * 100) / 100;
  const projectedAnnualYieldUsd = Math.round(preservedUsdc * (apy / 100) * 100) / 100;
  const projected30dYieldUsd =
    Math.round(preservedUsdc * (apy / 100) * (YIELD_HORIZON_DAYS / 365) * 100) / 100;

  let highRiskWarning = null;
  if (wasClamped) {
    highRiskWarning =
      `Requested ${reqPct.toFixed(0)}% exceeds Turgalium's 50% preservation hard cap and was clamped to 50%. ` +
      'Binary prediction contracts can settle to $0.';
  } else if (effectiveRiskPct > HIGH_RISK_WARN_PCT) {
    highRiskWarning =
      `High-risk side-pocket (${effectiveRiskPct}%): binary prediction markets can expire worthless ($0). ` +
      'Keep 75%–95% of your Solana USDC preserved.';
  }

  return {
    mode: 'percent',
    availableUsdc: bal,
    requestedRiskPct: reqPct,
    effectiveRiskPct,
    wasClamped,
    preservedPct,
    preservedUsdc,
    maxDegenBudgetUsd,
    yieldApyPct: apy,
    projectedAnnualYieldUsd,
    projected30dYieldUsd,
    highRiskWarning,
  };
}

function detectTurgaliumBalance() {
  // 1. Prefer clean structured balance detail emitted by `turgalium:balance-updated`
  const detail = state.turgaliumBalanceDetail;
  if (detail && typeof detail === 'object') {
    const liveSolUsdc = Number(detail.solanaUsdc) || 0;
    const sweptUsdc = Number(detail.projectedSweepUsdc) || 0;
    if (Number.isFinite(liveSolUsdc) && liveSolUsdc > 0 && Number.isFinite(sweptUsdc) && sweptUsdc > 0) {
      return { amount: Math.round((liveSolUsdc + sweptUsdc) * 100) / 100, source: 'Solana + Sweep USDC' };
    }
    if (Number.isFinite(liveSolUsdc) && liveSolUsdc > 0) {
      return { amount: Math.round(liveSolUsdc * 100) / 100, source: 'Live Solana USDC' };
    }
    if (Number.isFinite(sweptUsdc) && sweptUsdc > 0) {
      return { amount: Math.round(sweptUsdc * 100) / 100, source: 'Projected Sweep USDC' };
    }
  }

  // 2. Graceful fallback to existing input/balance readers if event has not fired yet
  const solBadgeText = document.getElementById('solanaLiveBalanceBadge')?.textContent || '';
  const solMatch = solBadgeText.match(/([\d,]+(?:\.\d+)?)\s*USDC/i);
  const liveSolUsdc = solMatch ? Number(solMatch[1].replaceAll(',', '')) : 0;

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

function syncBalanceFromTurgalium(force = false) {
  if (state.userEditedBalance && !force) return;
  const detected = detectTurgaliumBalance();
  if (detected && detected.amount > 0) {
    state.availableUsdc = detected.amount;
    state.balanceSource = detected.source;
    const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
    state.stakeUsd = pocket.maxDegenBudgetUsd;
    if (force) state.userEditedBalance = false;
  }
}

function getSelectedSolanaWallet() {
  const connected = getConnectedSolanaAddress();
  if (connected && isValidSolanaBase58(connected)) return connected;
  const fromEvent = state.turgaliumBalanceDetail?.solanaWallet;
  if (fromEvent && isValidSolanaBase58(fromEvent)) return fromEvent;
  const raw = document.getElementById('solanaDestInput')?.value?.trim() || '';
  return isValidSolanaBase58(raw) ? raw : '';
}

function hasConnectedSolanaSigner() {
  const connected = getConnectedSolanaAddress();
  return Boolean(connected && isValidSolanaBase58(connected));
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
  const claimable = state.positionsSummary?.claimableCount || 0;
  if (claimable > 0) {
    badge.textContent = `${claimable} WIN`;
  } else if (state.feedMeta.live && state.events.length > 0) {
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
        geoBlocked: false,
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
        geoBlocked: Boolean(data.geoBlocked),
        error: data.error || null,
      };
    }

    if (!state.selected || forceSearch) {
      const initial = pickInitialSelection(state.events);
      if (initial) {
        state.selected = initial;
        const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
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
      geoBlocked: false,
      error: err instanceof Error ? err.message : 'Network error contacting Turgalium Degen API.',
    };
    updateTabBadge();
    renderAll();
  }
}

async function fetchPositions({ silent = false } = {}) {
  const owner = getSelectedSolanaWallet();
  if (!owner) {
    state.positionsOwner = '';
    state.positions = [];
    state.positionsSummary = null;
    state.positionsError = null;
    state.positionsGeoBlocked = false;
    state.positionsLoading = false;
    updateTabBadge();
    renderPositionsStrip();
    return;
  }

  const seq = ++state.positionsSeq;
  state.positionsOwner = owner;
  if (!silent) {
    state.positionsLoading = true;
    renderPositionsStrip();
  }

  try {
    const resp = await fetch(`/api/degen/positions?owner=${encodeURIComponent(owner)}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await resp.json().catch(() => ({}));
    if (seq !== state.positionsSeq) return;
    state.positionsLoading = false;

    if (!resp.ok) {
      state.positions = [];
      state.positionsSummary = null;
      state.positionsGeoBlocked = false;
      state.positionsError = data?.error || `Failed to load positions (HTTP ${resp.status}).`;
    } else if (!data.ok) {
      state.positions = [];
      state.positionsSummary = data.summary || null;
      state.positionsGeoBlocked = Boolean(data.geoBlocked);
      state.positionsError = data.error || 'Live Jupiter positions currently unavailable.';
    } else {
      state.positions = Array.isArray(data.positions) ? data.positions : [];
      state.positionsSummary = data.summary || null;
      state.positionsGeoBlocked = false;
      state.positionsError = null;
    }

    updateTabBadge();
    renderPositionsStrip();
  } catch (err) {
    if (seq !== state.positionsSeq) return;
    state.positionsLoading = false;
    state.positionsError = err instanceof Error ? err.message : 'Unable to fetch Jupiter positions.';
    renderPositionsStrip();
  }
}

async function handlePositionAction(positionId, action) {
  if (!positionId || state.positionBusyId) return;
  const connected = getConnectedSolanaAddress();
  if (!connected || !isValidSolanaBase58(connected)) {
    state.positionActionFeedback = {
      positionId,
      type: 'error',
      message: 'Connect your Solana wallet (Phantom, Solflare, or Backpack) to claim or exit positions inline.',
      jupiterUrl: 'https://jup.ag/prediction/portfolio',
    };
    renderPositionsStrip();
    document.getElementById('connectSolBtn')?.click();
    return;
  }

  state.positionBusyId = positionId;
  state.positionActionFeedback = {
    positionId,
    type: 'info',
    message: action === 'claim' ? 'Building $1.00 payout claim transaction…' : 'Building early exit transaction…',
  };
  renderPositionsStrip();

  try {
    const endpoint = `/api/degen/positions/${encodeURIComponent(positionId)}/${action}`;
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerPubkey: connected }),
    });
    const data = await resp.json().catch(() => ({}));

    if (getConnectedSolanaAddress() !== connected) {
      state.positionActionFeedback = {
        positionId,
        type: 'error',
        message: 'Connected Solana wallet changed before signing. Please retry.',
      };
      return;
    }

    if (!resp.ok) {
      state.positionActionFeedback = {
        positionId,
        type: 'error',
        message: data?.error || `Failed to build ${action} transaction (HTTP ${resp.status}).`,
        jupiterUrl: 'https://jup.ag/prediction/portfolio',
      };
      return;
    }

    if (data?.available && data?.transactionBase64) {
      state.positionActionFeedback = {
        positionId,
        type: 'info',
        message: action === 'claim' ? 'Approve $1.00 payout claim in your Solana wallet…' : 'Approve early exit in your Solana wallet…',
      };
      renderPositionsStrip();

      const signed = await signAndSendSolanaVersionedTx(data.transactionBase64, {
        expectedFeePayer: connected,
        flow: 'jupiter_predict',
        autoConnect: false,
      });
      state.positionActionFeedback = {
        positionId,
        type: 'success',
        message:
          action === 'claim'
            ? `Claim submitted via ${signed.walletName} (${shortSig(signed.signature)})`
            : `Early exit submitted via ${signed.walletName} (${shortSig(signed.signature)})`,
        solscanUrl: signed.explorerUrl,
      };
      renderPositionsStrip();
      // Refresh live positions after tx dispatch
      fetchPositions({ silent: true });
      return;
    }

    state.positionActionFeedback = {
      positionId,
      type: 'info',
      message:
        data?.reason ||
        (action === 'claim'
          ? 'Open Jupiter Portfolio to claim your $1.00 winning payout.'
          : 'Open Jupiter Portfolio to close this position early.'),
      jupiterUrl: safeHttpsUrl(data?.jupiterUrl, 'https://jup.ag/prediction/portfolio', JUPITER_ALLOWED_HOSTS),
    };
  } catch (err) {
    state.positionActionFeedback = {
      positionId,
      type: 'error',
      message: isUserRejectedError(err)
        ? `Signature rejected in Solana wallet. ${action === 'claim' ? 'Claim' : 'Exit'} cancelled.`
        : err instanceof Error
          ? err.message
          : `Wallet rejected or failed ${action} transaction.`,
      jupiterUrl: 'https://jup.ag/prediction/portfolio',
    };
  } finally {
    state.positionBusyId = null;
    renderPositionsStrip();
  }
}

async function requestOrderPreview(requestLiveTx = false) {
  const sel = state.selected;
  const quote = getActiveQuote(sel);
  if (!sel || !quote) {
    state.orderPreview = null;
    state.orderPreviewBindingKey = null;
    state.orderPreviewError = null;
    renderSlip();
    return null;
  }

  const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
  const stake = Number(state.stakeUsd);
  if (!Number.isFinite(stake) || stake <= 0) {
    state.orderPreview = null;
    state.orderPreviewBindingKey = null;
    state.orderPreviewError = 'Enter a stake greater than $0.00.';
    renderSlip();
    return null;
  }
  if (stake < MIN_JUPITER_ORDER_USD - 1e-9) {
    state.orderPreview = null;
    state.orderPreviewBindingKey = null;
    state.orderPreviewError = `Jupiter Prediction minimum order size is $${MIN_JUPITER_ORDER_USD.toFixed(2)} USDC.`;
    renderSlip();
    return null;
  }
  if (stake > pocket.maxDegenBudgetUsd + 1e-9) {
    state.orderPreview = null;
    state.orderPreviewBindingKey = null;
    state.orderPreviewError =
      pocket.mode === 'yield_funded'
        ? `Stake ${fmtUsd(stake)} exceeds your 30d Yield-Funded budget of ${fmtUsd(pocket.maxDegenBudgetUsd)} (100% principal untouched).`
        : `Stake ${fmtUsd(stake)} exceeds your capped side-pocket of ${fmtUsd(pocket.maxDegenBudgetUsd)} (${pocket.effectiveRiskPct}% cap).`;
    renderSlip();
    return null;
  }

  const connectedSol = getConnectedSolanaAddress();
  if (requestLiveTx && (!connectedSol || !isValidSolanaBase58(connectedSol))) {
    state.orderPreview = null;
    state.orderPreviewBindingKey = null;
    state.liveTxStatus = null;
    state.liveTxError = 'Connect your Solana wallet (Phantom, Solflare, or Backpack) to build an inline order transaction.';
    renderSlip();
    return null;
  }
  const boundWallet = connectedSol && isValidSolanaBase58(connectedSol) ? connectedSol : '';
  const bindingKey = buildOrderBindingKey(boundWallet, sel.marketId, sel.side, stake);

  const seq = ++state.previewSeq;
  state.orderPreviewLoading = true;
  state.orderPreviewError = null;
  if (requestLiveTx) {
    state.liveTxError = null;
    state.liveTxStatus = 'Building signable Jupiter VersionedTransaction…';
  }
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
        sidePocketMode: state.sidePocketMode,
        yieldApyPct: state.yieldApyPct,
        priceUsd: quote.priceUsd,
        eventSlug: sel.eventSlug,
        eventTitle: sel.eventTitle,
        marketTitle: sel.marketTitle,
        walletAddress: requestLiveTx ? boundWallet : boundWallet || undefined,
        requestLiveTx,
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (seq !== state.previewSeq) return null;
    state.orderPreviewLoading = false;

    if (!resp.ok) {
      state.orderPreview = null;
      state.orderPreviewBindingKey = null;
      state.orderPreviewError = data?.error || `Order preview rejected (HTTP ${resp.status}).`;
      if (requestLiveTx) state.liveTxStatus = null;
      renderSlip();
      return null;
    }

    state.orderPreview = data;
    state.orderPreviewBindingKey = bindingKey;
    state.orderPreviewError = null;
    if (requestLiveTx) {
      if (data?.liveOrder?.available) {
        state.liveTxStatus = `Jupiter order transaction ready (${data.liveOrder.orderId || 'USDC'}).`;
      } else {
        state.liveTxStatus = data?.liveOrder?.reason || 'Use "Open on Jupiter ↗" to trade.';
      }
    }
    renderSlip();
    return data;
  } catch (err) {
    if (seq !== state.previewSeq) return null;
    state.orderPreviewLoading = false;
    state.orderPreviewBindingKey = null;
    state.orderPreviewError = err instanceof Error ? err.message : 'Preview request failed.';
    if (requestLiveTx) state.liveTxStatus = null;
    renderSlip();
    return null;
  }
}

async function handleSignAndPlaceOrder() {
  if (state.signingOrder) return;
  const connected = getConnectedSolanaAddress();
  if (!connected || !isValidSolanaBase58(connected)) {
    state.liveTxError = 'Connect Phantom, Solflare, or Backpack to sign inline, or click "Open on Jupiter ↗".';
    renderSlip();
    document.getElementById('connectSolBtn')?.click();
    return;
  }

  const sel = state.selected;
  const quote = getActiveQuote(sel);
  if (!sel || !quote) {
    state.liveTxError = 'Select a market outcome before signing.';
    renderSlip();
    return;
  }

  const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
  const stake = Number(state.stakeUsd);
  if (!Number.isFinite(stake) || stake < MIN_JUPITER_ORDER_USD - 1e-9) {
    state.liveTxError = `Jupiter Prediction minimum order size is $${MIN_JUPITER_ORDER_USD.toFixed(2)} USDC.`;
    renderSlip();
    return;
  }
  if (stake > pocket.maxDegenBudgetUsd + 1e-9) {
    state.liveTxError = `Stake ${fmtUsd(stake)} exceeds your capped side-pocket of ${fmtUsd(pocket.maxDegenBudgetUsd)}.`;
    renderSlip();
    return;
  }

  const expectedKey = buildOrderBindingKey(connected, sel.marketId, sel.side, stake);

  state.signingOrder = true;
  state.liveTxError = null;
  state.lastOrderTx = null;
  renderSlip();

  try {
    const canReusePreview =
      state.orderPreviewBindingKey === expectedKey &&
      Boolean(state.orderPreview?.liveOrder?.transactionBase64);

    let txBase64 = canReusePreview ? state.orderPreview.liveOrder.transactionBase64 : null;
    let orderId = canReusePreview ? state.orderPreview.liveOrder.orderId || null : null;

    if (!txBase64) {
      const built = await requestOrderPreview(true);
      txBase64 = built?.liveOrder?.transactionBase64 || null;
      orderId = built?.liveOrder?.orderId || null;
      if (!txBase64) {
        return;
      }
    }

    // Re-validate connected wallet, stake cap, and binding key right before signing
    const liveConnected = getConnectedSolanaAddress();
    const livePocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
    const liveStake = Number(state.stakeUsd);
    const liveKey = state.selected
      ? buildOrderBindingKey(liveConnected, state.selected.marketId, state.selected.side, liveStake)
      : '';
    if (
      !liveConnected ||
      liveConnected !== connected ||
      !Number.isFinite(liveStake) ||
      liveStake < MIN_JUPITER_ORDER_USD - 1e-9 ||
      liveStake > livePocket.maxDegenBudgetUsd + 1e-9 ||
      liveKey !== expectedKey ||
      state.orderPreviewBindingKey !== expectedKey
    ) {
      state.orderPreview = null;
      state.orderPreviewBindingKey = null;
      state.liveTxStatus = null;
      state.liveTxError = 'Order parameters or connected Solana wallet changed — please retry signing.';
      return;
    }

    state.liveTxStatus = 'Confirm order signature in your Solana wallet…';
    renderSlip();

    const signed = await signAndSendSolanaVersionedTx(txBase64, {
      expectedFeePayer: connected,
      flow: 'jupiter_predict',
      autoConnect: false,
    });
    state.lastOrderTx = {
      signature: signed.signature,
      solscanUrl: signed.explorerUrl,
      walletName: signed.walletName,
      orderId,
    };
    state.liveTxStatus = `Order placed via ${signed.walletName}!`;
    state.liveTxError = null;
    // Clear used transaction so subsequent click requests fresh blockhash
    if (state.orderPreview?.liveOrder) {
      state.orderPreview = {
        ...state.orderPreview,
        liveOrder: { ...state.orderPreview.liveOrder, transactionBase64: null },
      };
    }
    state.orderPreviewBindingKey = null;
    renderSlip();
    fetchPositions({ silent: true });
  } catch (err) {
    state.liveTxError = isUserRejectedError(err)
      ? 'Signature rejected in Solana wallet. Order cancelled.'
      : err instanceof Error
        ? err.message
        : 'Solana wallet signing cancelled or failed.';
    state.liveTxStatus = null;
  } finally {
    state.signingOrder = false;
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

  const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
  const detected = detectTurgaliumBalance();

  const is9010Active = pocket.mode === 'percent' && Math.abs(pocket.effectiveRiskPct - 10) < 0.01 && !pocket.wasClamped;
  const isYieldFundedActive = pocket.mode === 'yield_funded';

  const riskPillsHtml = RISK_PILLS.map((pct) => {
    const active = pocket.mode === 'percent' && Math.abs(pocket.effectiveRiskPct - pct) < 0.01 && !pocket.wasClamped;
    return `<button type="button" class="degen-pct-pill mono ${active ? 'active' : ''}" data-degen-risk="${pct}">${pct}%</button>`;
  }).join('');

  const warningHtml = pocket.highRiskWarning
    ? `<div class="degen-risk-warning ${pocket.wasClamped ? 'is-clamped' : ''}" role="alert">${esc(pocket.highRiskWarning)}</div>`
    : '';

  const liveBadgeHtml = state.feedMeta.geoBlocked
    ? `<span class="degen-pill-offline mono">Jupiter v1 · Region Restricted</span>`
    : state.feedMeta.live
      ? `<span class="degen-pill-live mono"><span class="degen-live-dot"></span>Jupiter Prediction v1 · Live</span>`
      : state.loading
        ? `<span class="degen-pill-live mono">Connecting Jupiter v1…</span>`
        : `<span class="degen-pill-offline mono">Jupiter v1 Offline</span>`;

  const headlineHtml = isYieldFundedActive
    ? `100% Principal Safe: <span class="degen-safe-num mono">${esc(fmtUsd(pocket.preservedUsdc))} Untouched</span> · Yield-Funded Degen: <span class="degen-cap-num mono">${esc(fmtUsd(pocket.maxDegenBudgetUsd))} (30d @ ${esc(pocket.yieldApyPct)}% APY)</span>`
    : `Preserved Safe: <span class="degen-safe-num mono">${esc(pocket.preservedPct)}% (${esc(fmtUsd(pocket.preservedUsdc))})</span> · Degen Side-Pocket: <span class="degen-cap-num mono">${esc(pocket.effectiveRiskPct)}% (${esc(fmtUsd(pocket.maxDegenBudgetUsd))})</span>`;

  const yieldSubline = isYieldFundedActive
    ? `Zero principal at risk: ${fmtUsd(pocket.preservedUsdc)} earns est. +${fmtUsd(pocket.projectedAnnualYieldUsd)}/yr (~${pocket.yieldApyPct}% APY); Degen cap strictly limited to 30-day yield (${fmtUsd(pocket.projected30dYieldUsd)}).`
    : `90%+ preservation target: ${fmtUsd(pocket.preservedUsdc)} safe principal earns est. +${fmtUsd(pocket.projectedAnnualYieldUsd)}/yr (~${pocket.yieldApyPct}% APY on Jupiter Lend / Kamino).`;

  const splitSafePct = isYieldFundedActive ? 100 : Math.max(0, Math.min(100, pocket.preservedPct));
  const splitCapPct = isYieldFundedActive ? 0 : Math.max(0, Math.min(100, pocket.effectiveRiskPct));

  host.innerHTML = `
    <div class="degen-pocket-card">
      <div class="degen-pocket-top">
        <div class="degen-pocket-headline">
          <div class="degen-eyebrow-row">
            <span class="degen-eyebrow mono">PRESERVATION-FIRST SIDE-POCKET</span>
            <span class="degen-pill-safe mono">${esc(pocket.preservedPct)}% Principal Guarded</span>
            ${liveBadgeHtml}
          </div>
          <p class="degen-split-summary" id="degenSplitHeadline">${headlineHtml}</p>
          <div class="degen-yield-meta mono" id="degenYieldProjectionLine">${esc(yieldSubline)}</div>
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
                  value="${esc(pocket.mode === 'yield_funded' ? 0 : pocket.effectiveRiskPct)}"
                  aria-label="Custom side-pocket risk percentage"
                />
                <span class="mono muted-xs">%</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="degen-split-presets" role="group" aria-label="Preservation-first split presets">
        <button
          type="button"
          class="degen-split-preset-btn ${is9010Active ? 'active' : ''}"
          id="degenPreset9010Btn"
          data-split-preset="yield_90_10"
        >
          <span class="degen-preset-title">90% Yield Safe / 10% Degen</span>
          <span class="degen-preset-sub mono">Est. +${esc(fmtUsd(computeLocalSidePocket(pocket.availableUsdc, 10, 'percent', pocket.yieldApyPct).projectedAnnualYieldUsd))}/yr @ ~${esc(pocket.yieldApyPct)}% APY</span>
        </button>
        <button
          type="button"
          class="degen-split-preset-btn is-yield-safe ${isYieldFundedActive ? 'active' : ''}"
          id="degenPresetYieldFundedBtn"
          data-split-preset="yield_funded"
        >
          <span class="degen-preset-title">100% Principal Safe · Yield-Funded Degen</span>
          <span class="degen-preset-sub mono">Principal untouched · ${esc(fmtUsd(computeLocalSidePocket(pocket.availableUsdc, 0, 'yield_funded', pocket.yieldApyPct).maxDegenBudgetUsd))} 30d yield budget</span>
        </button>
      </div>

      <div class="degen-split-bar" aria-hidden="true">
        <div class="degen-split-bar-safe" style="width: ${splitSafePct}%"></div>
        <div class="degen-split-bar-cap" style="width: ${splitCapPct}%"></div>
      </div>

      ${warningHtml}

      <div class="degen-pocket-foot">
        <span>Non-custodial guard: Turgalium caps optional Degen sizing so your migrated Solana principal stays untouched. Binary contracts can settle to $0.</span>
        ${detected ? `<button type="button" class="degen-sync-btn" id="degenSyncBalanceBtn">Sync ${esc(fmtUsd(detected.amount))} (${esc(detected.source)})</button>` : `<span class="mono">Min order $5 · Hard ceiling 50%</span>`}
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
        clearOrderSigningState();
        const nextPocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
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

  host.querySelectorAll('[data-split-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.splitPreset;
      if (preset === 'yield_funded') {
        state.sidePocketMode = 'yield_funded';
        state.riskPct = 0;
      } else {
        state.sidePocketMode = 'percent';
        state.riskPct = 10;
      }
      clearOrderSigningState();
      const nextPocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
      state.stakeUsd = nextPocket.maxDegenBudgetUsd;
      renderPocketBar();
      renderMarketsSection();
      renderSlip();
      requestOrderPreview(false);
    });
  });

  host.querySelectorAll('[data-degen-risk]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextPct = Number(btn.dataset.degenRisk);
      if (!Number.isFinite(nextPct)) return;
      state.sidePocketMode = 'percent';
      state.riskPct = nextPct;
      clearOrderSigningState();
      const nextPocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
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
      state.sidePocketMode = 'percent';
      state.riskPct = val;
      clearOrderSigningState();
      const nextPocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
      state.stakeUsd = nextPocket.maxDegenBudgetUsd;
      renderPocketBar();
      renderMarketsSection();
      renderSlip();
      requestOrderPreview(false);
    });
  }

  document.getElementById('degenSyncBalanceBtn')?.addEventListener('click', () => {
    syncBalanceFromTurgalium(true);
    clearOrderSigningState();
    renderPocketBar();
    renderMarketsSection();
    renderSlip();
    requestOrderPreview(false);
  });
}

function renderPositionsStrip() {
  const host = document.getElementById('degenPositionsHost');
  if (!host) return;

  const owner = getSelectedSolanaWallet();
  const summary = state.positionsSummary;
  const feedback = state.positionActionFeedback;

  if (!owner) {
    host.innerHTML = `
      <div class="degen-positions-card">
        <div class="degen-positions-head">
          <div class="degen-positions-title-wrap">
            <h2 class="degen-section-title">My Positions &amp; Claims</h2>
            <span class="mono muted-xs">Track active YES/NO bets, unrealized P&amp;L, early exit &amp; $1.00 winning claims</span>
          </div>
          <button type="button" class="degen-pos-connect-btn mono" id="degenPositionsConnectBtn">
            Connect Solana Wallet
          </button>
        </div>
      </div>
    `;
    document.getElementById('degenPositionsConnectBtn')?.addEventListener('click', () => {
      document.getElementById('connectSolBtn')?.click();
    });
    return;
  }

  const pnlVal = summary ? summary.totalUnrealizedPnlUsd : 0;
  const pnlClass = pnlVal > 0 ? 'is-pos' : pnlVal < 0 ? 'is-neg' : '';
  const summaryPills = summary
    ? `
      <div class="degen-pos-summary-pills mono">
        <span class="degen-pos-pill">${esc(summary.openCount)} Open</span>
        ${summary.claimableCount > 0 ? `<span class="degen-pos-pill is-claimable">${esc(summary.claimableCount)} Claimable (${esc(fmtUsd(summary.totalClaimablePayoutUsd))})</span>` : ''}
        <span class="degen-pos-pill ${pnlClass}">Live P&amp;L ${esc(fmtSignedUsd(pnlVal))}</span>
      </div>
    `
    : '';

  let bodyHtml = '';
  if (state.positionsLoading && state.positions.length === 0) {
    bodyHtml = `<div class="degen-pos-empty mono">Loading live Jupiter positions for ${esc(shortSig(owner))}…</div>`;
  } else if (state.positionsError) {
    bodyHtml = `
      <div class="degen-pos-banner ${state.positionsGeoBlocked ? 'is-warn' : ''}">
        <span>${esc(state.positionsError)}</span>
        <a href="https://jup.ag/prediction/portfolio" target="_blank" rel="noopener noreferrer" class="degen-jup-link">Open Portfolio on Jupiter ↗</a>
      </div>
    `;
  } else if (state.positions.length === 0) {
    bodyHtml = `
      <div class="degen-pos-empty">
        <span>No active or claimable Jupiter Prediction positions for <strong class="mono">${esc(shortSig(owner))}</strong> yet.</span>
        <a href="https://jup.ag/prediction/portfolio" target="_blank" rel="noopener noreferrer" class="degen-jup-link">Jupiter Portfolio ↗</a>
      </div>
    `;
  } else {
    bodyHtml = `<div class="degen-positions-list">${state.positions
      .map((pos) => {
        const pnlCls = pos.unrealizedPnlUsd > 0 ? 'is-pos' : pos.unrealizedPnlUsd < 0 ? 'is-neg' : '';
        const busy = state.positionBusyId === pos.positionId;
        const posUrl = safeHttpsUrl(pos.jupiterUrl, 'https://jup.ag/prediction/portfolio');
        const entryCents = `${(pos.avgEntryPriceUsd * 100).toFixed(1)}¢`;
        const markCents = `${(pos.markPriceUsd * 100).toFixed(1)}¢`;
        const pnlPctText = `${pos.unrealizedPnlPct >= 0 ? '+' : ''}${pos.unrealizedPnlPct.toFixed(1)}%`;

        let actionBtnHtml = `<a href="${esc(posUrl)}" target="_blank" rel="noopener noreferrer" class="degen-pos-link-btn">View on Jupiter ↗</a>`;
        if (pos.claimable) {
          actionBtnHtml = `
            <button
              type="button"
              class="degen-claim-btn mono"
              data-claim-position="${esc(pos.positionId)}"
              ${busy ? 'disabled' : ''}
            >
              ${busy ? 'Claiming…' : `Claim ${esc(fmtUsd(pos.claimablePayoutUsd))} ($1.00/sh)`}
            </button>
          `;
        } else if (pos.canCloseEarly) {
          actionBtnHtml = `
            <button
              type="button"
              class="degen-exit-btn mono"
              data-close-position="${esc(pos.positionId)}"
              ${busy ? 'disabled' : ''}
            >
              ${busy ? 'Exiting…' : 'Early Exit'}
            </button>
          `;
        }

        const statusBadge = pos.claimable
          ? `<span class="degen-pos-status is-claimable mono">WIN · CLAIM $1.00</span>`
          : pos.status === 'settled'
            ? `<span class="degen-pos-status mono">SETTLED ${esc(fmtUsd(pos.settledPayoutUsd))}</span>`
            : `<span class="degen-pos-status mono">${esc(pos.status.toUpperCase())}</span>`;

        return `
          <div class="degen-position-row ${pos.claimable ? 'is-claimable' : ''}">
            <div class="degen-pos-main">
              <div class="degen-pos-badges">
                <span class="degen-pos-side mono ${pos.side === 'yes' ? 'is-yes' : 'is-no'}">${esc(pos.side.toUpperCase())}</span>
                ${statusBadge}
                <span class="mono muted-xs">${esc(pos.shares.toFixed(2))} sh · Entry ${esc(entryCents)} → Mark ${esc(markCents)}</span>
              </div>
              <div class="degen-pos-title">${esc(pos.eventTitle)}</div>
              <div class="degen-pos-market">${esc(pos.marketTitle)}</div>
            </div>
            <div class="degen-pos-right">
              <div class="degen-pos-pnl mono">
                <strong class="${pnlCls}">${esc(fmtSignedUsd(pos.unrealizedPnlUsd))}</strong>
                <span class="muted-xs">${esc(pnlPctText)} · Val ${esc(fmtUsd(pos.currentValueUsd))}</span>
              </div>
              <div class="degen-pos-actions">
                ${actionBtnHtml}
              </div>
            </div>
          </div>
        `;
      })
      .join('')}</div>`;
  }

  const feedbackHtml = feedback
    ? `
      <div class="degen-pos-feedback is-${esc(feedback.type)} mono">
        <span>${esc(feedback.message)}</span>
        ${feedback.solscanUrl ? `<a href="${esc(safeHttpsUrl(feedback.solscanUrl, 'https://solscan.io', SOLSCAN_ALLOWED_HOSTS))}" target="_blank" rel="noopener noreferrer" class="degen-solscan-link">View on Solscan ↗</a>` : ''}
        ${feedback.jupiterUrl ? `<a href="${esc(safeHttpsUrl(feedback.jupiterUrl, 'https://jup.ag/prediction/portfolio', JUPITER_ALLOWED_HOSTS))}" target="_blank" rel="noopener noreferrer" class="degen-jup-link">Open on Jupiter ↗</a>` : ''}
      </div>
    `
    : '';

  host.innerHTML = `
    <div class="degen-positions-card">
      <div class="degen-positions-head">
        <div class="degen-positions-title-wrap">
          <h2 class="degen-section-title">My Positions &amp; Claims</h2>
          <span class="mono muted-xs">${esc(shortSig(owner))}</span>
          ${summaryPills}
        </div>
        <button type="button" class="degen-refresh-btn" id="degenRefreshPositionsBtn">Refresh</button>
      </div>
      ${feedbackHtml}
      ${bodyHtml}
    </div>
  `;

  document.getElementById('degenRefreshPositionsBtn')?.addEventListener('click', () => {
    fetchPositions({ silent: false });
  });

  host.querySelectorAll('[data-claim-position]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.claimPosition;
      if (id) handlePositionAction(id, 'claim');
    });
  });

  host.querySelectorAll('[data-close-position]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.closePosition;
      if (id) handlePositionAction(id, 'close');
    });
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

  const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
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
        <strong>${state.feedMeta.geoBlocked ? 'Jupiter Prediction API geo-restricted in this region' : 'Live Jupiter markets temporarily unreachable'}</strong>
        <span>${esc(state.feedMeta.error || 'Unable to fetch live events from Jupiter Prediction API.')}</span>
        <span class="muted-xs">Turgalium never fabricates placeholder markets when live odds are unavailable.</span>
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
      clearOrderSigningState();
      const curPocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
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

  const pocket = computeLocalSidePocket(state.availableUsdc, state.riskPct, state.sidePocketMode, state.yieldApyPct);
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
          Click any <strong>YES ¢</strong> or <strong>NO ¢</strong> odds pill on a live Jupiter market to model capped payout math and sign inline or launch on Jupiter.
        </div>
      </div>
    `;
    return;
  }

  const stake = Number.isFinite(state.stakeUsd) ? state.stakeUsd : 0;
  const localPayout = computeLocalPayout(stake, quote.priceUsd);
  const serverPayout = state.orderPreview?.payout || null;
  const displayPayout = serverPayout || localPayout;
  const underMin = stake > 0 && stake < MIN_JUPITER_ORDER_USD - 1e-9;
  const overCap = stake > pocket.maxDegenBudgetUsd + 1e-9;
  const tradeUrl = safeHttpsUrl(state.orderPreview?.jupiterUrl || sel.jupiterUrl, 'https://jup.ag/prediction');
  const canLaunch = !overCap && !underMin && stake >= MIN_JUPITER_ORDER_USD - 1e-9 && !state.orderPreviewError;

  const signerReady = hasConnectedSolanaSigner();
  const hasReadyTx = Boolean(state.orderPreview?.liveOrder?.available && state.orderPreview?.liveOrder?.transactionBase64);
  const canInlineSign = canLaunch && signerReady && (hasReadyTx || state.feedMeta.apiKeyConfigured);
  const geoBlocked = Boolean(state.orderPreview?.liveOrder?.geoBlocked || state.feedMeta.geoBlocked);

  const yesLabel = sel.yes ? `YES ${sel.yes.cents.toFixed(1)}¢ (${sel.yes.payoutMultiplier.toFixed(2)}x)` : 'YES —';
  const noLabel = sel.no ? `NO ${sel.no.cents.toFixed(1)}¢ (${sel.no.payoutMultiplier.toFixed(2)}x)` : 'NO —';

  let primaryCtaHtml = '';
  if (canInlineSign && !geoBlocked) {
    primaryCtaHtml = `
      <button
        type="button"
        class="degen-trade-cta is-inline-sign"
        id="degenSignOrderBtn"
        ${state.signingOrder || state.orderPreviewLoading ? 'disabled' : ''}
      >
        ${state.signingOrder ? 'Signing in Wallet…' : 'Sign & Place Order in Wallet'}
      </button>
      <a
        href="${esc(tradeUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        class="degen-live-tx-btn degen-fallback-link ${canLaunch ? '' : 'is-disabled'}"
        id="degenTradeJupiterLink"
      >
        Open on Jupiter ↗
      </a>
    `;
  } else {
    primaryCtaHtml = `
      <a
        href="${esc(tradeUrl)}"
        target="_blank"
        rel="noopener noreferrer"
        class="degen-trade-cta ${canLaunch ? '' : 'is-disabled'}"
        id="degenTradeJupiterLink"
      >
        Open on Jupiter ↗
      </a>
      ${
        state.feedMeta.apiKeyConfigured && !geoBlocked
          ? `<button type="button" class="degen-live-tx-btn mono" id="degenBuildLiveTxBtn" ${!canLaunch || state.signingOrder || state.orderPreviewLoading ? 'disabled' : ''}>${signerReady ? 'Sign & Place Order in Wallet' : 'Connect Solana for 1-Click Inline Signing'}</button>`
          : ''
      }
    `;
  }

  const orderTxBannerHtml = state.lastOrderTx
    ? `
      <div class="degen-tx-success mono" role="status">
        <span>Placed via ${esc(state.lastOrderTx.walletName)} · ${esc(shortSig(state.lastOrderTx.signature))}</span>
        <a href="${esc(safeHttpsUrl(state.lastOrderTx.solscanUrl, 'https://solscan.io', SOLSCAN_ALLOWED_HOSTS))}" target="_blank" rel="noopener noreferrer" class="degen-solscan-link">Solscan ↗</a>
      </div>
    `
    : '';

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
          <span class="mono">Min $5 · Max ${esc(fmtUsd(pocket.maxDegenBudgetUsd))}</span>
        </div>
        <div class="degen-stake-input-row">
          <span class="mono muted-xs">$</span>
          <input
            type="number"
            id="degenStakeInput"
            class="degen-stake-input mono"
            min="5"
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
      ${state.liveTxError ? `<div class="degen-slip-error" role="alert">${esc(state.liveTxError)}</div>` : ''}

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

      ${primaryCtaHtml}
      ${orderTxBannerHtml}
      ${state.liveTxStatus ? `<div class="degen-slip-note mono">${esc(state.liveTxStatus)}</div>` : ''}

      <div class="degen-slip-note">
        ${state.orderPreviewLoading ? 'Verifying side-pocket cap & $5 min order…' : 'Non-custodial payout calculator verified against Turgalium side-pocket cap. Settlement uses Solana USDC directly on Jupiter.'}
      </div>
    </div>
  `;

  document.getElementById('degenSlipYesBtn')?.addEventListener('click', () => {
    if (!sel.yes) return;
    state.selected = { ...sel, side: 'yes' };
    clearOrderSigningState();
    renderMarketsSection();
    renderSlip();
    requestOrderPreview(false);
  });

  document.getElementById('degenSlipNoBtn')?.addEventListener('click', () => {
    if (!sel.no) return;
    state.selected = { ...sel, side: 'no' };
    clearOrderSigningState();
    renderMarketsSection();
    renderSlip();
    requestOrderPreview(false);
  });

  const stakeInput = document.getElementById('degenStakeInput');
  if (stakeInput) {
    stakeInput.addEventListener('change', () => {
      const val = Number(stakeInput.value);
      state.stakeUsd = Number.isFinite(val) ? Math.round(val * 100) / 100 : 0;
      clearOrderSigningState();
      renderSlip();
      requestOrderPreview(false);
    });
  }

  host.querySelectorAll('[data-stake-frac]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const frac = Number(btn.dataset.stakeFrac);
      if (!Number.isFinite(frac)) return;
      state.stakeUsd = Math.floor(pocket.maxDegenBudgetUsd * frac * 100) / 100;
      clearOrderSigningState();
      renderSlip();
      requestOrderPreview(false);
    });
  });

  document.getElementById('degenSignOrderBtn')?.addEventListener('click', () => {
    handleSignAndPlaceOrder();
  });

  document.getElementById('degenBuildLiveTxBtn')?.addEventListener('click', () => {
    if (!hasConnectedSolanaSigner()) {
      document.getElementById('connectSolBtn')?.click();
      return;
    }
    handleSignAndPlaceOrder();
  });
}

function renderAll() {
  renderPocketBar();
  renderPositionsStrip();
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
    <div id="degenPositionsHost"></div>
    <div id="degenGamesHost"></div>
    <div class="degen-workspace">
      <div class="degen-feed-col" id="degenFeedHost"></div>
      <aside class="degen-slip-col" id="degenSlipHost" aria-label="Quick Bet Slip and Payout Calculator"></aside>
    </div>
  `;

  syncBalanceFromTurgalium(false);
  renderAll();
}

function onDegenTabActivated() {
  mountShell();
  syncBalanceFromTurgalium(false);
  renderPocketBar();
  renderPositionsStrip();
  renderSlip();
  if (!state.hasLoadedOnce && !state.loading) {
    fetchMarkets({ forceSearch: false });
  }
  const owner = getSelectedSolanaWallet();
  if (owner && owner !== state.positionsOwner && !state.positionsLoading) {
    fetchPositions({ silent: false });
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

  // Strict state isolation on Solana wallet connect / account switch / disconnect
  window.addEventListener('turgalium:wallet-changed', (event) => {
    const detail = event?.detail;
    if (!detail || detail.family !== 'solana') return;
    clearOrderSigningState({ clearPositionFeedback: true });
    state.positionsSeq += 1;
    state.positions = [];
    state.positionsSummary = null;
    state.positionsError = null;
    state.positionsGeoBlocked = false;
    state.positionsOwner = '';
    updateTabBadge();
    if (pane.classList.contains('active')) {
      renderSlip();
      renderPositionsStrip();
      if (getSelectedSolanaWallet()) {
        fetchPositions({ silent: false });
      }
    }
  });

  // Clean event-driven balance & Solana wallet sync dispatched by app.js
  window.addEventListener('turgalium:balance-updated', (event) => {
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : null;
    if (!detail) return;
    state.turgaliumBalanceDetail = detail;

    if (!state.userEditedBalance) {
      syncBalanceFromTurgalium(false);
    }

    const nextWallet = getSelectedSolanaWallet();
    const walletChanged = nextWallet !== state.positionsOwner;
    if (walletChanged) {
      clearOrderSigningState({ clearPositionFeedback: true });
    }

    if (pane.classList.contains('active')) {
      renderPocketBar();
      renderSlip();
      if (walletChanged) {
        fetchPositions({ silent: false });
      } else {
        renderPositionsStrip();
      }
    } else if (!nextWallet && state.positionsOwner) {
      // Clear stale positions immediately when wallet disconnects
      state.positionsSeq += 1;
      state.positionsOwner = '';
      state.positions = [];
      state.positionsSummary = null;
      updateTabBadge();
    }
  });

  // Graceful fallback if #solanaDestInput is edited directly by the user
  document.getElementById('solanaDestInput')?.addEventListener('change', () => {
    clearOrderSigningState({ clearPositionFeedback: true });
    if (pane.classList.contains('active')) {
      renderSlip();
      fetchPositions({ silent: false });
    }
  });

  if (pane.classList.contains('active')) {
    onDegenTabActivated();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initDegenModule);
} else {
  initDegenModule();
}
