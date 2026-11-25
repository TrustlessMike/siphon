/**
 * Siphon Capital-Preservation Optimizer & Gas-Window Watchdog UI Module.
 * Self-contained browser module cleanly integrated without bloating public/app.js.
 */

let latestScanReport = null;
let latestPreservation = null;
let appliedRouteSignature = null;
let activeGasTriggers = [];
let latestEthGwei = null;
let optimizeSeq = 0;

function esc(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtUsd(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toFixed(2)}`;
}

function isValidEvmAddr(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

function isValidSolanaAddr(addr) {
  if (typeof addr !== 'string') return false;
  const s = addr.trim();
  if (!s || s === '11111111111111111111111111111111') return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function shortAddr(addr) {
  const s = String(addr || '').trim();
  if (s.length <= 12) return s || '—';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function showPreservationToast(msg) {
  const host = document.getElementById('toastRegion');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = String(msg ?? '');
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 180ms ease';
    setTimeout(() => el.remove(), 200);
  }, 3200);
}

function getActiveOutputAsset() {
  const activeBtn = document.querySelector('.seg-opt.active[data-out-asset]');
  return activeBtn?.dataset?.outAsset === 'SOL' ? 'SOL' : 'USDC';
}

function getActiveProtocolFeeBps() {
  const sel = document.getElementById('protocolFeeSelect');
  const parsed = Number(sel?.value ?? 700);
  return Number.isFinite(parsed) && parsed >= 500 && parsed <= 1000 ? parsed : 700;
}

function getCurrentSourceWallet() {
  const inputVal = document.getElementById('appEvmInput')?.value?.trim() || '';
  if (isValidEvmAddr(inputVal)) return inputVal;
  if (latestScanReport?.walletAddress && isValidEvmAddr(latestScanReport.walletAddress)) {
    return latestScanReport.walletAddress;
  }
  return '';
}

function getCurrentSolanaDest() {
  const inputVal = document.getElementById('solanaDestInput')?.value?.trim() || '';
  if (isValidSolanaAddr(inputVal)) return inputVal;
  return '';
}

async function fetchJsonSilent(rawFetch, url, opts = {}) {
  const res = await rawFetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

const nativeFetch = window.fetch.bind(window);

function renderPreservationStrip() {
  const host = document.getElementById('preservationStripHost');
  if (!host) return;

  if (!latestPreservation || !latestPreservation.totals) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  const t = latestPreservation.totals;
  const hasSweepable = Number(t.grossSweepableUsd) > 0;
  if (!hasSweepable && !latestPreservation.gasTiming?.primary?.shouldWait) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  host.classList.remove('hidden');

  const recPref = latestPreservation.recommendedBridgePreference || 'auto';
  const recLabel = latestPreservation.recommendedRouteLabel || 'Auto Optimal';
  const currentSelectVal = document.getElementById('bridgePrefSelect')?.value || 'auto';
  const routeSig = `${latestScanReport?.scanId || ''}:${recPref}:${latestPreservation.outputAsset}`;
  const isApplied = appliedRouteSignature === routeSig && currentSelectVal === recPref;

  const pctNum = Number.isFinite(Number(t.preservationRatePct))
    ? Number(t.preservationRatePct)
    : 100;
  const effNum = Number.isFinite(Number(t.executionEfficiencyPct))
    ? Number(t.executionEfficiencyPct)
    : pctNum;
  const savedNum = Math.max(0, Number(t.totalDollarsPreservedUsd) || 0);
  const popupsNaive = Math.max(0, Number(t.popupsNaive) || 0);
  const popupsOpt = Math.max(0, Number(t.popupsOptimized) || 0);

  const primaryGas = latestPreservation.gasTiming?.primary;
  const showGasPill = Boolean(
    primaryGas &&
      (primaryGas.shouldWait ||
        (Number(primaryGas.currentGwei) > Number(primaryGas.targetMaxGwei) &&
          Number(primaryGas.estimatedWaitSavingsUsd) > 0))
  );
  const ethWatching = activeGasTriggers.some(
    (tr) => tr.chain === 'ethereum' && (tr.status === 'watching' || tr.status === 'ready')
  );

  const unlocks = Array.isArray(latestPreservation.unlockSchedule)
    ? latestPreservation.unlockSchedule
    : [];
  const nextUnlock = unlocks[0] || null;

  const gasPillHtml = showGasPill
    ? `<button type="button" class="preservation-gas-pill ${ethWatching ? 'is-watching' : ''}" id="gasWatchQuickPill" data-target-gwei="${esc(primaryGas.targetMaxGwei)}" data-est-savings="${esc(primaryGas.estimatedWaitSavingsUsd)}">
        <span class="preservation-gas-dot"></span>
        <span>${
          ethWatching
            ? `Gas Watchdog active · waiting for ≤ ${esc(primaryGas.targetMaxGwei)} gwei`
            : `Save ~${esc(fmtUsd(primaryGas.estimatedWaitSavingsUsd))} by waiting for ≤ ${esc(primaryGas.targetMaxGwei)} gwei · Watch &amp; Notify`
        }</span>
      </button>`
    : '';

  const unlockHtml = nextUnlock
    ? `<span class="preservation-unlock-chip mono">${esc(unlocks.length)} scheduled · ${esc(nextUnlock.symbol)} (${esc(nextUnlock.actionLabel)})</span>`
    : '';

  const subRowHtml =
    gasPillHtml || unlockHtml
      ? `<div class="preservation-sub-row">${gasPillHtml}${unlockHtml}</div>`
      : '';

  const breakdownHtml =
    savedNum > 0
      ? `<div class="preservation-breakdown mono pro-only">
          <span>Route: ${esc(recLabel)}</span>
          <span>Gas ${esc(fmtUsd(t.dollarsSavedGasUsd))}</span>
          <span>Approvals ${esc(fmtUsd(t.dollarsSavedApprovalsUsd))}</span>
          <span>Route Auction ${esc(fmtUsd(t.dollarsSavedRouteAuctionUsd))}</span>
          <span>Neg-ROI Pruned ${esc(fmtUsd(t.dollarsSavedNegativeRoiPrunedUsd))}</span>
          <span>Execution Eff. ${esc(effNum.toFixed(1))}%</span>
        </div>`
      : '';

  host.innerHTML = `
    <div class="preservation-strip" id="preservationStripCard">
      <div class="preservation-main-row">
        <div class="preservation-metrics">
          <span class="preservation-score-badge" title="Net capital preserved after gas, slippage, bridge &amp; protocol fees">
            <span class="preservation-score-dot"></span>
            <span>Keeping ${esc(pctNum.toFixed(1))}% of your value</span>
          </span>
          <span class="preservation-pill preservation-pill-saved mono">+${esc(fmtUsd(savedNum))} saved vs manual swaps</span>
          ${
            popupsNaive > 0
              ? `<span class="preservation-pill preservation-pill-popups mono">${esc(popupsNaive)} → ${esc(popupsOpt)} popups</span>`
              : ''
          }
        </div>
        <div class="preservation-actions">
          <button type="button" class="btn-pill-dark btn-sm preservation-apply-btn ${isApplied ? 'is-applied' : ''}" id="applyOptimalRouteBtn">
            ${isApplied ? 'Optimal Route Applied ✓' : 'Apply Optimal Route'}
          </button>
        </div>
      </div>
      ${breakdownHtml}
      ${subRowHtml}
    </div>
  `;

  document.getElementById('applyOptimalRouteBtn')?.addEventListener('click', handleApplyOptimalRoute);
  document.getElementById('gasWatchQuickPill')?.addEventListener('click', handleQuickGasWatchClick);
}

function handleApplyOptimalRoute() {
  if (!latestPreservation) return;
  const recPref = latestPreservation.recommendedBridgePreference || 'auto';
  const select = document.getElementById('bridgePrefSelect');
  const permit2 = document.getElementById('permit2Toggle');

  if (permit2 && !permit2.checked) {
    permit2.checked = true;
    permit2.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (select) {
    const opt = select.querySelector(`option[value="${recPref}"]`);
    const targetVal = opt && !opt.disabled ? recPref : 'auto';
    select.value = targetVal;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  appliedRouteSignature = `${latestScanReport?.scanId || ''}:${recPref}:${latestPreservation.outputAsset}`;
  renderPreservationStrip();
  showPreservationToast(
    `Applied optimal preservation route (${latestPreservation.recommendedRouteLabel}).`
  );
}

async function registerGasWatchTrigger({ chain, maxBaseFeeGwei, estimatedSavingsUsd }) {
  const sourceWallet = getCurrentSourceWallet();
  if (!sourceWallet) {
    showPreservationToast('Scan or connect an EVM wallet first before setting a gas watchdog.');
    document.getElementById('appEvmInput')?.focus();
    return false;
  }

  const solanaDestination = getCurrentSolanaDest();
  if (!solanaDestination) {
    const wrap = document.getElementById('destEditWrap');
    wrap?.classList.remove('hidden');
    document.getElementById('solanaDestInput')?.focus();
    showPreservationToast(
      'Connect Solana or enter a Solana destination address before registering a Gas-Window Watchdog.'
    );
    return false;
  }

  const gwei = Number(maxBaseFeeGwei);
  if (!Number.isFinite(gwei) || gwei <= 0 || gwei > 500) {
    showPreservationToast('Target max gas must be between 1 and 500 gwei.');
    return false;
  }

  try {
    const created = await fetchJsonSilent(nativeFetch, '/api/agents/gas-watch', {
      method: 'POST',
      body: JSON.stringify({
        sourceWallet,
        solanaDestination,
        chain: chain || 'ethereum',
        maxBaseFeeGwei: gwei,
        estimatedSavingsUsd: Math.max(0, Number(estimatedSavingsUsd) || 0),
      }),
    });
    await refreshGasWatchAgents();
    renderPreservationStrip();
    showPreservationToast(
      created.status === 'ready'
        ? `Gas window already met on ${created.chain} (≤ ${created.maxBaseFeeGwei} gwei) — ready to sweep!`
        : `Gas-Window Watchdog active: watching ${created.chain} for ≤ ${created.maxBaseFeeGwei} gwei.`
    );
    return true;
  } catch (err) {
    showPreservationToast(err instanceof Error ? err.message : 'Could not register gas watchdog.');
    return false;
  }
}

async function handleQuickGasWatchClick() {
  const primary = latestPreservation?.gasTiming?.primary;
  if (!primary) return;
  await registerGasWatchTrigger({
    chain: primary.chain || 'ethereum',
    maxBaseFeeGwei: primary.targetMaxGwei || 15,
    estimatedSavingsUsd: primary.estimatedWaitSavingsUsd || 0,
  });
}

function renderGasWatchAgentsPanel() {
  const liveBadge = document.getElementById('gasWatchLiveGweiBadge');
  if (liveBadge) {
    liveBadge.textContent =
      typeof latestEthGwei === 'number' && Number.isFinite(latestEthGwei)
        ? `Live L1: ${latestEthGwei.toFixed(1)} gwei`
        : 'Live L1: —';
  }

  const listHost = document.getElementById('gasWatchListHost');
  if (!listHost) return;

  if (!activeGasTriggers.length) {
    listHost.innerHTML =
      '<div class="muted-xs" style="padding:4px 0;">No gas-window triggers active yet. Set a target gwei threshold above or click the inline Watch &amp; Notify pill in the Sweep view.</div>';
    return;
  }

  listHost.innerHTML = activeGasTriggers
    .map((tr) => {
      const canCancel = tr.status === 'watching' || tr.status === 'ready';
      const statusClass =
        tr.status === 'ready'
          ? 'is-ready'
          : tr.status === 'watching'
          ? 'is-watching'
          : tr.status === 'cancelled'
          ? 'is-cancelled'
          : 'is-expired';
      return `
        <div class="gas-watch-item" data-gas-watch-id="${esc(tr.id)}">
          <div class="gas-watch-item-top">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;">
              <strong class="mono">${esc(tr.chain.toUpperCase())} ≤ ${esc(tr.maxBaseFeeGwei)} gwei</strong>
              <span class="gas-watch-status ${statusClass} mono">${esc(tr.status)}</span>
              ${
                Number(tr.estimatedSavingsUsd) > 0
                  ? `<span class="preservation-pill preservation-pill-saved mono">~${esc(fmtUsd(tr.estimatedSavingsUsd))} est. save</span>`
                  : ''
              }
            </div>
            ${
              canCancel
                ? `<button type="button" class="btn-row-exec" data-cancel-gas-watch="${esc(tr.id)}">Cancel</button>`
                : ''
            }
          </div>
          <div class="gas-watch-meta mono">
            ${esc(shortAddr(tr.sourceWallet))} → ${esc(shortAddr(tr.solanaDestination))}${
              typeof tr.lastObservedGwei === 'number'
                ? ` · Last observed: ${esc(tr.lastObservedGwei.toFixed(1))} gwei`
                : ''
            }
          </div>
          <div class="gas-watch-safety">${esc(tr.safetyNote)}</div>
        </div>
      `;
    })
    .join('');

  listHost.querySelectorAll('[data-cancel-gas-watch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-cancel-gas-watch');
      if (!id) return;
      try {
        await fetchJsonSilent(nativeFetch, `/api/agents/gas-watch/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        await refreshGasWatchAgents();
        renderPreservationStrip();
        showPreservationToast('Gas-window watchdog trigger cancelled.');
      } catch (err) {
        showPreservationToast(err instanceof Error ? err.message : 'Failed to cancel trigger.');
      }
    });
  });
}

async function refreshGasWatchAgents() {
  try {
    const data = await fetchJsonSilent(nativeFetch, '/api/agents/gas-watch', { method: 'GET' });
    activeGasTriggers = Array.isArray(data.triggers) ? data.triggers : [];
    if (typeof data.ethereumGwei === 'number' && Number.isFinite(data.ethereumGwei)) {
      latestEthGwei = data.ethereumGwei;
    }
    renderGasWatchAgentsPanel();
  } catch {
    // Non-fatal: avoid console noise if auth/network unavailable
  }
}

async function runPreservationOptimization(scanReport) {
  if (
    !scanReport ||
    typeof scanReport.walletAddress !== 'string' ||
    !Array.isArray(scanReport.assets) ||
    !Array.isArray(scanReport.chains)
  ) {
    return;
  }

  latestScanReport = scanReport;
  const seq = ++optimizeSeq;

  try {
    const data = await fetchJsonSilent(nativeFetch, '/api/optimize/preservation', {
      method: 'POST',
      body: JSON.stringify({
        scanReport,
        outputAsset: getActiveOutputAsset(),
        protocolFeeBps: getActiveProtocolFeeBps(),
      }),
    });
    if (seq !== optimizeSeq) return;
    latestPreservation = data;
    if (typeof data.gasTiming?.primary?.currentGwei === 'number') {
      latestEthGwei = data.gasTiming.primary.currentGwei;
    }
    renderPreservationStrip();
    renderGasWatchAgentsPanel();
  } catch {
    // Non-fatal silent failure keeps console clean
  }
}

function installScanObserver() {
  if (window.__siphonPreservationInstalled) return;
  window.__siphonPreservationInstalled = true;

  window.fetch = async function wrappedFetch(input, init) {
    const response = await nativeFetch(input, init);
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '';
      const method = (init?.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
      if (
        response.ok &&
        method === 'POST' &&
        (url.endsWith('/api/scan') ||
          url.includes('/api/scan?') ||
          url.endsWith('/api/scan/unified'))
      ) {
        response
          .clone()
          .json()
          .then((scanData) => {
            if (scanData && Array.isArray(scanData.assets)) {
              runPreservationOptimization(scanData);
            }
          })
          .catch(() => {});
      }
    } catch {
      // Never interfere with app.js fetch responses
    }
    return response;
  };
}

function bindPreservationEvents() {
  document.querySelectorAll('.seg-opt[data-out-asset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (latestScanReport) {
        setTimeout(() => runPreservationOptimization(latestScanReport), 0);
      }
    });
  });

  document.getElementById('protocolFeeSelect')?.addEventListener('change', () => {
    if (latestScanReport) {
      runPreservationOptimization(latestScanReport);
    }
  });

  document.getElementById('bridgePrefSelect')?.addEventListener('change', () => {
    renderPreservationStrip();
  });

  document.querySelectorAll('.app-tab[data-view="agents"]').forEach((tab) => {
    tab.addEventListener('click', () => {
      refreshGasWatchAgents();
    });
  });

  document.getElementById('refreshGasWatchBtn')?.addEventListener('click', () => {
    refreshGasWatchAgents();
  });

  document.getElementById('createGasWatchForm')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const chain = document.getElementById('gasWatchChainSelect')?.value || 'ethereum';
    const maxGwei = Number(document.getElementById('gasWatchMaxGweiInput')?.value || 15);
    const estSavings =
      chain === 'ethereum' ? Number(latestPreservation?.gasTiming?.primary?.estimatedWaitSavingsUsd || 0) : 0;
    await registerGasWatchTrigger({
      chain,
      maxBaseFeeGwei: maxGwei,
      estimatedSavingsUsd: estSavings,
    });
  });
}

installScanObserver();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindPreservationEvents);
} else {
  bindPreservationEvents();
}

window.__siphonPreservation = {
  getLatest: () => latestPreservation,
  refreshGasWatchAgents,
  runPreservationOptimization,
};
