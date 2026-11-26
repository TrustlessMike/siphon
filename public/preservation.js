/**
 * Siphon Capital-Preservation Optimizer, Tiered Fee Clarity, Route Auction Winner
 * & Gas-Window Watchdog UI Module.
 * Self-contained browser module cleanly integrated without bloating public/app.js.
 */

let latestScanReport = null;
let latestPreservation = null;
let latestRouteAuction = null;
let appliedRouteSignature = null;
let activeGasTriggers = [];
let latestEthGwei = null;
let optimizeSeq = 0;

const ROUTE_PROVIDER_LABELS = {
  circle_cctp: 'CCTP V2 Fast',
  cctp: 'CCTP V2 Fast',
  mayan_swift: 'Mayan Swift',
  mayan: 'Mayan Swift',
  debridge_dln: 'deBridge DLN',
  debridge: 'deBridge DLN',
  relay: 'Relay',
  lifi: 'LI.FI',
  direct_swap_only: 'Direct Swap',
};

function fmtUsd(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

function formatProviderName(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (ROUTE_PROVIDER_LABELS[key]) return ROUTE_PROVIDER_LABELS[key];
  return String(raw || 'Auto Optimal').trim() || 'Auto Optimal';
}

/**
 * Mirrors src/scanner/chains.ts `computePreservationFee` progressive tier table
 * so the UI surfaces exact active bps, hard USD cap, and savings vs legacy 7% flat fee.
 */
function computeTieredPreservationFee(grossUsdInput) {
  const grossUsd = Math.max(0, Number(grossUsdInput) || 0);
  if (grossUsd <= 0) {
    return {
      grossUsd: 0,
      feeBps: 0,
      feePercentLabel: '0.00%',
      feeUsd: 0,
      capUsd: null,
      capApplied: false,
      legacy7PctUsd: 0,
      savedVs7PctUsd: 0,
      tierLabel: 'Zero',
    };
  }

  let feeBps = 10;
  let capUsd = 50;
  let tierLabel = 'Principal ($5k+)';
  if (grossUsd < 50) {
    feeBps = 500;
    capUsd = null;
    tierLabel = 'Micro-Dust (<$50)';
  } else if (grossUsd < 500) {
    feeBps = 100;
    capUsd = null;
    tierLabel = 'Small ($50–$500)';
  } else if (grossUsd < 5000) {
    feeBps = 25;
    capUsd = null;
    tierLabel = 'Mid ($500–$5k)';
  }

  const uncappedFeeUsd = Number(((grossUsd * feeBps) / 10_000).toFixed(2));
  const capApplied = capUsd !== null && uncappedFeeUsd > capUsd;
  const feeUsd = capApplied ? capUsd : uncappedFeeUsd;
  const legacy7PctUsd = Number(((grossUsd * 700) / 10_000).toFixed(2));
  const savedVs7PctUsd = Number(Math.max(0, legacy7PctUsd - feeUsd).toFixed(2));
  const feePercentLabel = `${(feeBps / 100).toFixed(2)}%`;

  return {
    grossUsd,
    feeBps,
    feePercentLabel,
    feeUsd,
    capUsd,
    capApplied,
    legacy7PctUsd,
    savedVs7PctUsd,
    tierLabel,
  };
}

/**
 * Derives winning cross-chain route + runner-up savings from either live `/api/tx/prepare-chain-batch`
 * route auction metadata OR `/api/optimize/preservation` per-chain candidate audits.
 */
function resolveRouteAuctionSummary() {
  if (latestRouteAuction && latestRouteAuction.winnerProvider) {
    const winnerLabel = formatProviderName(latestRouteAuction.winnerProvider);
    const runnerUpLabel = latestRouteAuction.runnerUpProvider
      ? formatProviderName(latestRouteAuction.runnerUpProvider)
      : null;
    const savedUsd = Math.max(0, Number(latestRouteAuction.dollarsSavedOverRunnerUp) || 0);
    const savedBps = Math.max(0, Number(latestRouteAuction.bpsSavedOverRunnerUp) || 0);
    return {
      source: 'live_auction',
      winnerLabel,
      runnerUpLabel,
      savedOverRunnerUpUsd: savedUsd,
      savedOverRunnerUpBps: savedBps,
      providersSucceeded: Number(latestRouteAuction.providersSucceeded) || 0,
      providersQueried: Array.isArray(latestRouteAuction.providersQueried)
        ? latestRouteAuction.providersQueried.length
        : 0,
    };
  }

  if (!latestPreservation) return null;

  const recLabel = formatProviderName(
    latestPreservation.recommendedBridgePreference &&
      latestPreservation.recommendedBridgePreference !== 'auto'
      ? latestPreservation.recommendedBridgePreference
      : latestPreservation.recommendedRouteLabel || 'Relay'
  );

  // Compute exact runner-up delta across chain candidate quotes if present
  let runnerUpLabel = null;
  let runnerUpDeltaUsd = 0;
  const chains = Array.isArray(latestPreservation.chains) ? latestPreservation.chains : [];
  let topChain = null;
  for (const ch of chains) {
    if (!topChain || (Number(ch.grossUsd) || 0) > (Number(topChain.grossUsd) || 0)) {
      topChain = ch;
    }
    const eligible = (Array.isArray(ch.candidates) ? ch.candidates : [])
      .filter((c) => c && c.eligible && c.settlesOnSolana)
      .sort((a, b) => (Number(b.netUsdPreserved) || 0) - (Number(a.netUsdPreserved) || 0));
    if (eligible.length >= 2) {
      const delta = Math.max(
        0,
        (Number(eligible[0].netUsdPreserved) || 0) - (Number(eligible[1].netUsdPreserved) || 0)
      );
      runnerUpDeltaUsd += delta;
      if (!runnerUpLabel) {
        runnerUpLabel = formatProviderName(eligible[1].route || eligible[1].label);
      }
    }
  }

  const winnerLabel = topChain?.bestRoute
    ? formatProviderName(topChain.bestRoute)
    : latestPreservation.recommendedRouteLabel || recLabel;

  const auctionSavedTotal = Math.max(
    runnerUpDeltaUsd,
    Number(latestPreservation.totals?.dollarsSavedRouteAuctionUsd) || 0
  );

  return {
    source: 'optimizer',
    winnerLabel,
    runnerUpLabel,
    savedOverRunnerUpUsd: Number(auctionSavedTotal.toFixed(2)),
    savedOverRunnerUpBps: 0,
    providersSucceeded: 0,
    providersQueried: 0,
  };
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

function updateSummaryProClarity(feeInfo, routeSummary) {
  const row = document.getElementById('preservationFeeRouteRow');
  const valEl = document.getElementById('preservationFeeRouteText');
  if (!row || !valEl) return;

  if (!feeInfo || feeInfo.grossUsd <= 0) {
    row.classList.add('hidden');
    valEl.textContent = '—';
    return;
  }

  row.classList.remove('hidden');
  const capPart = feeInfo.capUsd !== null ? ` cap ${fmtUsd(feeInfo.capUsd)}` : '';
  const routePart = routeSummary?.winnerLabel ? ` · ${routeSummary.winnerLabel}` : '';
  valEl.textContent = `${feeInfo.feePercentLabel}${capPart} (save +${fmtUsd(feeInfo.savedVs7PctUsd)} vs 7%)${routePart}`;
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = String(text);
  return el;
}

function renderPreservationStrip() {
  const host = document.getElementById('preservationStripHost');
  if (!host) return;

  if (!latestPreservation || !latestPreservation.totals) {
    host.classList.add('hidden');
    host.replaceChildren();
    updateSummaryProClarity(null, null);
    return;
  }

  const t = latestPreservation.totals;
  const grossSweepable = Math.max(0, Number(t.grossSweepableUsd) || 0);
  const hasSweepable = grossSweepable > 0;
  if (!hasSweepable && !latestPreservation.gasTiming?.primary?.shouldWait) {
    host.classList.add('hidden');
    host.replaceChildren();
    updateSummaryProClarity(null, null);
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

  const feeInfo = computeTieredPreservationFee(grossSweepable);
  const routeSummary = resolveRouteAuctionSummary();
  updateSummaryProClarity(feeInfo, routeSummary);

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

  const card = createEl('div', 'preservation-strip');
  card.id = 'preservationStripCard';

  // Row 1: Primary metrics + Apply Optimal Route CTA
  const mainRow = createEl('div', 'preservation-main-row');
  const metrics = createEl('div', 'preservation-metrics');

  const scoreBadge = createEl('span', 'preservation-score-badge');
  scoreBadge.title = 'Net capital preserved after gas, slippage, bridge & protocol fees';
  scoreBadge.appendChild(createEl('span', 'preservation-score-dot'));
  scoreBadge.appendChild(createEl('span', '', `Keeping ${pctNum.toFixed(1)}% of your value`));
  metrics.appendChild(scoreBadge);

  metrics.appendChild(
    createEl(
      'span',
      'preservation-pill preservation-pill-saved mono',
      `+${fmtUsd(savedNum)} saved vs manual swaps`
    )
  );

  if (popupsNaive > 0) {
    metrics.appendChild(
      createEl(
        'span',
        'preservation-pill preservation-pill-popups mono',
        `${popupsNaive} → ${popupsOpt} popups`
      )
    );
  }

  const actions = createEl('div', 'preservation-actions');
  const applyBtn = createEl(
    'button',
    `btn-pill-dark btn-sm preservation-apply-btn${isApplied ? ' is-applied' : ''}`,
    isApplied ? 'Optimal Route Applied ✓' : 'Apply Optimal Route'
  );
  applyBtn.type = 'button';
  applyBtn.id = 'applyOptimalRouteBtn';
  applyBtn.addEventListener('click', handleApplyOptimalRoute);
  actions.appendChild(applyBtn);

  mainRow.appendChild(metrics);
  mainRow.appendChild(actions);
  card.appendChild(mainRow);

  // Row 2: Tiered Preservation Fee + Winning Cross-Chain Route Auction Clarity
  if (hasSweepable) {
    const clarityRow = createEl('div', 'preservation-clarity-row');

    const feePill = createEl('span', 'preservation-pill preservation-pill-fee mono');
    feePill.id = 'preservationTieredFeePill';
    const capPart = feeInfo.capUsd !== null ? ` cap ${fmtUsd(feeInfo.capUsd)}` : '';
    const savePart =
      feeInfo.savedVs7PctUsd > 0
        ? ` · Saving +${fmtUsd(feeInfo.savedVs7PctUsd)} vs 7%`
        : ` (${feeInfo.feeBps} bps)`;
    feePill.textContent = `Tiered Fee: ${feeInfo.feePercentLabel}${capPart}${savePart}`;
    clarityRow.appendChild(feePill);

    if (routeSummary?.winnerLabel) {
      const routePill = createEl('span', 'preservation-pill preservation-pill-route mono');
      routePill.id = 'preservationRouteWinnerPill';
      let routeText = `Route Winner: ${routeSummary.winnerLabel}`;
      if (routeSummary.savedOverRunnerUpUsd > 0) {
        const vsWho = routeSummary.runnerUpLabel ? ` vs ${routeSummary.runnerUpLabel}` : ' vs runner-up';
        routeText += ` · +${fmtUsd(routeSummary.savedOverRunnerUpUsd)}${vsWho}`;
      }
      routePill.textContent = routeText;
      clarityRow.appendChild(routePill);
    }

    card.appendChild(clarityRow);
  }

  // Row 3: Pro-only granular savings breakdown
  if (savedNum > 0) {
    const breakdown = createEl('div', 'preservation-breakdown mono pro-only');
    breakdown.appendChild(createEl('span', '', `Route: ${recLabel}`));
    breakdown.appendChild(createEl('span', '', `Gas ${fmtUsd(t.dollarsSavedGasUsd)}`));
    breakdown.appendChild(createEl('span', '', `Approvals ${fmtUsd(t.dollarsSavedApprovalsUsd)}`));
    breakdown.appendChild(
      createEl('span', '', `Route Auction ${fmtUsd(t.dollarsSavedRouteAuctionUsd)}`)
    );
    breakdown.appendChild(
      createEl('span', '', `Neg-ROI Pruned ${fmtUsd(t.dollarsSavedNegativeRoiPrunedUsd)}`)
    );
    breakdown.appendChild(createEl('span', '', `Execution Eff. ${effNum.toFixed(1)}%`));
    card.appendChild(breakdown);
  }

  // Row 4: Gas-Window Watchdog quick pill + Unlock schedule chip
  if (showGasPill || nextUnlock) {
    const subRow = createEl('div', 'preservation-sub-row');

    if (showGasPill) {
      const gasBtn = createEl(
        'button',
        `preservation-gas-pill${ethWatching ? ' is-watching' : ''}`
      );
      gasBtn.type = 'button';
      gasBtn.id = 'gasWatchQuickPill';
      gasBtn.dataset.targetGwei = String(primaryGas.targetMaxGwei);
      gasBtn.dataset.estSavings = String(primaryGas.estimatedWaitSavingsUsd);
      gasBtn.appendChild(createEl('span', 'preservation-gas-dot'));
      gasBtn.appendChild(
        createEl(
          'span',
          '',
          ethWatching
            ? `Gas Watchdog active · waiting for ≤ ${primaryGas.targetMaxGwei} gwei`
            : `Save ~${fmtUsd(primaryGas.estimatedWaitSavingsUsd)} by waiting for ≤ ${primaryGas.targetMaxGwei} gwei · Watch & Notify`
        )
      );
      gasBtn.addEventListener('click', handleQuickGasWatchClick);
      subRow.appendChild(gasBtn);
    }

    if (nextUnlock) {
      subRow.appendChild(
        createEl(
          'span',
          'preservation-unlock-chip mono',
          `${unlocks.length} scheduled · ${nextUnlock.symbol} (${nextUnlock.actionLabel})`
        )
      );
    }

    card.appendChild(subRow);
  }

  host.replaceChildren(card);
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
    const opt = Array.from(select.options).find((o) => o.value === recPref);
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
    const empty = createEl(
      'div',
      'muted-xs',
      'No gas-window triggers active yet. Set a target gwei threshold above or click the inline Watch & Notify pill in the Sweep view.'
    );
    empty.style.padding = '4px 0';
    listHost.replaceChildren(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const tr of activeGasTriggers) {
    const canCancel = tr.status === 'watching' || tr.status === 'ready';
    const statusClass =
      tr.status === 'ready'
        ? 'is-ready'
        : tr.status === 'watching'
        ? 'is-watching'
        : tr.status === 'cancelled'
        ? 'is-cancelled'
        : 'is-expired';

    const item = createEl('div', 'gas-watch-item');
    item.dataset.gasWatchId = String(tr.id || '');

    const top = createEl('div', 'gas-watch-item-top');
    const left = createEl('div');
    left.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;';
    left.appendChild(
      createEl('strong', 'mono', `${String(tr.chain || '').toUpperCase()} ≤ ${tr.maxBaseFeeGwei} gwei`)
    );
    left.appendChild(createEl('span', `gas-watch-status ${statusClass} mono`, String(tr.status || '')));

    if (Number(tr.estimatedSavingsUsd) > 0) {
      left.appendChild(
        createEl(
          'span',
          'preservation-pill preservation-pill-saved mono',
          `~${fmtUsd(tr.estimatedSavingsUsd)} est. save`
        )
      );
    }
    top.appendChild(left);

    if (canCancel) {
      const cancelBtn = createEl('button', 'btn-row-exec', 'Cancel');
      cancelBtn.type = 'button';
      cancelBtn.setAttribute('data-cancel-gas-watch', String(tr.id || ''));
      cancelBtn.addEventListener('click', async () => {
        const id = String(tr.id || '');
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
      top.appendChild(cancelBtn);
    }

    const metaText = `${shortAddr(tr.sourceWallet)} → ${shortAddr(tr.solanaDestination)}${
      typeof tr.lastObservedGwei === 'number'
        ? ` · Last observed: ${tr.lastObservedGwei.toFixed(1)} gwei`
        : ''
    }`;
    const meta = createEl('div', 'gas-watch-meta mono', metaText);
    const safety = createEl('div', 'gas-watch-safety', tr.safetyNote || '');

    item.appendChild(top);
    item.appendChild(meta);
    item.appendChild(safety);
    frag.appendChild(item);
  }

  listHost.replaceChildren(frag);
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
  window.dispatchEvent(new CustomEvent('siphon:scan-updated', { detail: { scanReport } }));
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
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url || '';
      const method = (
        init?.method ||
        (typeof input !== 'string' && input?.method) ||
        'GET'
      ).toUpperCase();

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
              latestRouteAuction = null;
              runPreservationOptimization(scanData);
            }
          })
          .catch(() => {});
      } else if (
        response.ok &&
        method === 'POST' &&
        (url.endsWith('/api/tx/prepare-chain-batch') || url.includes('/api/tx/prepare-chain-batch?'))
      ) {
        response
          .clone()
          .json()
          .then((batchData) => {
            const auction =
              batchData?.routeAuction ||
              (Array.isArray(batchData?.bridgeTrackers)
                ? batchData.bridgeTrackers.find((b) => b?.routeAuction)?.routeAuction
                : null);
            if (auction && auction.winnerProvider) {
              latestRouteAuction = auction;
              renderPreservationStrip();
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

  window.addEventListener('siphon:wallet-changed', (ev) => {
    const detail = ev?.detail;
    if (!detail || detail.family !== 'evm') return;
    if (detail.action === 'disconnect' || !detail.address) {
      optimizeSeq += 1;
      latestScanReport = null;
      latestPreservation = null;
      latestRouteAuction = null;
      appliedRouteSignature = null;
      renderPreservationStrip();
    }
  });

  document.getElementById('createGasWatchForm')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const chain = document.getElementById('gasWatchChainSelect')?.value || 'ethereum';
    const maxGwei = Number(document.getElementById('gasWatchMaxGweiInput')?.value || 15);
    const estSavings =
      chain === 'ethereum'
        ? Number(latestPreservation?.gasTiming?.primary?.estimatedWaitSavingsUsd || 0)
        : 0;
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
  getLatestRouteAuction: () => latestRouteAuction,
  computeTieredPreservationFee,
  refreshGasWatchAgents,
  runPreservationOptimization,
};
