import { mountSiphonFunnelScene } from './siphon-3d.js';
import { renderConvergenceSvg } from './siphon-svg.js';

let currentScan = null;
let currentPlan = null;
let lastSimulation = null;
let selectedAssetIds = new Set();
let activeFilter = 'all';
let outputAsset = 'USDC';
let heroScene = null;
let contractData = null;

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function shortAddr(addr) {
  if (!addr || addr.length <= 12) return addr || '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function showToast(msg) {
  const host = document.getElementById('toastRegion');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 180ms ease';
    setTimeout(() => el.remove(), 200);
  }, 2400);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showWebsite() {
  document.getElementById('siteShell').classList.remove('hidden');
  document.getElementById('appShell').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'instant' });
  window.dispatchEvent(new Event('resize'));
}

function openApp(viewName = 'scanner') {
  document.getElementById('siteShell').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  switchView(viewName);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function switchView(viewName) {
  document.querySelectorAll('.app-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.view-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `view-${viewName}`);
  });
  if (viewName === 'contract' && !contractData) loadContract();
}

window.showWebsite = showWebsite;
window.openApp = openApp;
window.switchView = switchView;

async function runScan({ address = null, presetId = null, autoOpen = false } = {}) {
  heroScene?.setActive(true);
  const scanBtn = document.getElementById('appScanBtn');
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
  }
  try {
    const payload = presetId ? { presetId } : address ? { address } : { presetId: 'veteran_defi' };
    currentScan = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    lastSimulation = null;
    document.getElementById('simulationBanner').classList.add('hidden');

    selectedAssetIds = new Set(
      currentScan.assets.filter((a) => a.selectedByDefault).map((a) => a.id)
    );

    document.getElementById('appEvmInput').value = currentScan.walletAddress;
    if (address) {
      document.getElementById('heroWalletInput').value = currentScan.walletAddress;
    }

    const badge = document.getElementById('scanModeBadge');
    badge.textContent =
      currentScan.mode === 'live_rpc'
        ? `Live RPC · ${currentScan.scanDurationMs}ms`
        : currentScan.walletLabel || 'Multi-Chain Preset';
    badge.classList.toggle('is-live', currentScan.mode === 'live_rpc');

    await recomputePlan();
    if (autoOpen) openApp('scanner');
  } catch (err) {
    showToast(err.message);
  } finally {
    heroScene?.setActive(false);
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.textContent = 'Scan Live';
    }
  }
}

async function recomputePlan() {
  if (!currentScan) return;
  const solDest = document.getElementById('solanaDestInput').value.trim();
  const usePermit2Batch = document.getElementById('permit2Toggle').checked;
  const includeBurns = document.getElementById('burnToggle').checked;

  try {
    currentPlan = await api('/api/plan', {
      method: 'POST',
      body: JSON.stringify({
        scan: currentScan,
        selectedAssetIds: Array.from(selectedAssetIds),
        solanaDestination: solDest,
        usePermit2Batch,
        includeBurns,
        outputAsset,
      }),
    });
    renderAll();
  } catch (err) {
    showToast(err.message);
  }
}

function renderAll() {
  if (!currentScan || !currentPlan) return;
  const t = currentPlan.totals;

  // KPIs
  document.getElementById('kpiNetUsdc').textContent =
    outputAsset === 'SOL'
      ? `${t.netSolanaSol.toFixed(2)} SOL`
      : `$${t.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  document.getElementById('kpiNetLabel').textContent =
    outputAsset === 'SOL' ? 'Net Solana SOL (via Jupiter)' : 'Net Solana USDC';
  document.getElementById('kpiNetSub').textContent =
    outputAsset === 'SOL'
      ? `$${t.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC · $${t.protocolFeeUsd.toFixed(2)} fee`
      : `${t.netSolanaSol.toFixed(2)} SOL eq · $${t.protocolFeeUsd.toFixed(2)} fee (0.35%)`;

  const selectedAssets = currentScan.assets.filter((a) => selectedAssetIds.has(a.id));
  const defiUsd = selectedAssets
    .filter((a) => a.action === 'WITHDRAW_AND_BRIDGE')
    .reduce((s, a) => s + a.grossUsd, 0);
  const dustUsd = selectedAssets
    .filter((a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC')
    .reduce((s, a) => s + a.grossUsd, 0);

  document.getElementById('kpiDefiUsd').textContent = `$${defiUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  document.getElementById('kpiDefiSub').textContent = `${t.defiWithdrawnCount} contract position(s) to withdraw`;

  document.getElementById('kpiDustUsd').textContent = `$${dustUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  document.getElementById('kpiDustSub').textContent = `${t.tokensSoldCount} asset(s) across ${currentPlan.legs.length} chain(s)`;

  document.getElementById('kpiBurnCount').textContent = String(t.tokensBurnedCount);
  document.getElementById('kpiBurnSub').textContent =
    `${t.honeypotsSkippedCount} honeypot skipped · $${t.gasSavedUsd.toFixed(2)} gas saved`;

  document.getElementById('tabLegCount').textContent = String(currentPlan.legs.length);
  document.getElementById('tabBurnCount').textContent = String(currentPlan.burnManifest.length);

  // Convergence SVG
  document.getElementById('flowSummaryMeta').textContent =
    `${currentPlan.legs.length} active chain(s) · ${t.selectedAssets} selected · ~$${t.totalGasUsd.toFixed(2)} total gas`;
  document.getElementById('convergenceSvgHost').innerHTML = renderConvergenceSvg(currentPlan, currentScan);

  renderChainCards();
  renderAssetTable();
  renderPipelineView();
  renderBurnView();
}

function renderChainCards() {
  const host = document.getElementById('chainCardsGrid');
  host.innerHTML = currentScan.chains
    .map((c) => {
      const leg = currentPlan.legs.find((l) => l.chain === c.chain);
      const val = leg ? leg.bridgedUsdc : 0;
      const sponsored = leg?.gasSponsored;
      return `
        <div class="chain-mini-card ${sponsored ? 'sponsored' : ''}">
          <div class="chain-mini-top">
            <span>${escapeHtml(c.chainName)}</span>
            <span class="mono muted-xs">D${c.cctpDomain}</span>
          </div>
          <div class="chain-mini-val mono">$${val.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div class="chain-mini-sub mono">
            ${sponsored ? 'Gas-Sponsored Rescue' : `${c.assetCount} asset(s) · ${c.gasPriceGwei} gwei`}
          </div>
        </div>
      `;
    })
    .join('');
}

function actionBadge(action) {
  if (action === 'WITHDRAW_AND_BRIDGE') return `<span class="action-tag tag-defi">DeFi Withdraw</span>`;
  if (action === 'BRIDGE_DIRECT_USDC') return `<span class="action-tag tag-direct">Direct CCTP</span>`;
  if (action === 'SELL_AND_BRIDGE') return `<span class="action-tag tag-sell">Sell → USDC</span>`;
  if (action === 'BURN_ZERO_LIQUIDITY') return `<span class="action-tag tag-burn">Burn 0x…dEaD</span>`;
  if (action === 'SKIP_HONEYPOT') return `<span class="action-tag tag-skip">Honeypot Skipped</span>`;
  return `<span class="action-tag tag-skip">Gas-Negative</span>`;
}

function renderAssetTable() {
  const body = document.getElementById('assetTableBody');
  const useBatch = document.getElementById('permit2Toggle').checked;

  const filtered = currentScan.assets.filter((a) => {
    if (activeFilter === 'defi') return a.action === 'WITHDRAW_AND_BRIDGE';
    if (activeFilter === 'liquid')
      return a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC';
    if (activeFilter === 'burn') return a.action === 'BURN_ZERO_LIQUIDITY';
    if (activeFilter === 'skipped')
      return a.action === 'SKIP_HONEYPOT' || a.action === 'SKIP_GAS_NEGATIVE';
    return true;
  });

  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:28px; color:var(--ink-3);">No assets in this category for this wallet.</td></tr>`;
    return;
  }

  body.innerHTML = filtered
    .map((a) => {
      const checked = selectedAssetIds.has(a.id);
      const disabled = a.action === 'SKIP_HONEYPOT';
      const gas = useBatch ? a.batchedGasUsd : a.estimatedGasUsd;
      const net = useBatch ? a.netUsdcBatched : a.netUsdcSingle;
      const netStr =
        a.action === 'BURN_ZERO_LIQUIDITY'
          ? 'Burn'
          : a.action === 'SKIP_HONEYPOT'
          ? 'Blocked'
          : `$${net.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

      return `
        <tr class="${checked ? 'is-checked' : ''}">
          <td>
            <input type="checkbox" class="asset-chk" data-asset-id="${escapeHtml(a.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} />
          </td>
          <td>
            <div class="asset-title">${escapeHtml(a.symbol)}${a.protocol ? ` <span class="muted-xs">· ${escapeHtml(a.protocol)}</span>` : ''}</div>
            <div class="asset-sub">${escapeHtml(a.name)}</div>
          </td>
          <td class="mono">${escapeHtml(a.chainName)}</td>
          <td class="mono">${a.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
          <td class="mono">$${a.grossUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
          <td class="mono muted-xs">$${gas.toFixed(2)}</td>
          <td>${actionBadge(a.action)}</td>
          <td class="mono" style="text-align:right; font-weight:600;">${escapeHtml(netStr)}</td>
        </tr>
      `;
    })
    .join('');

  body.querySelectorAll('.asset-chk').forEach((chk) => {
    chk.addEventListener('change', () => {
      const id = chk.dataset.assetId;
      if (chk.checked) selectedAssetIds.add(id);
      else selectedAssetIds.delete(id);
      recomputePlan();
    });
  });
}

function renderPipelineView() {
  document.getElementById('planSolAddr').textContent = currentPlan.solanaDestination;
  document.getElementById('planSolBytes32').textContent = currentPlan.solanaMintRecipientBytes32;
  document.getElementById('planTiming').textContent = currentPlan.legs.length
    ? `Fastest L2 leg ~${currentPlan.totals.estimatedFastestSec}s · Full completion ~${Math.round(currentPlan.totals.estimatedFullSec / 60)}m (ETH L1 finality)`
    : 'No active bridge legs';

  const grid = document.getElementById('cctpLegsGrid');
  if (!currentPlan.legs.length) {
    grid.innerHTML = `<div class="card pad-card muted-xs">Select at least one asset in Scanner &amp; Plan to generate Circle CCTP legs.</div>`;
    return;
  }

  grid.innerHTML = currentPlan.legs
    .map((leg) => {
      const simExec = lastSimulation?.executions?.find((e) => e.chain === leg.chain);
      return `
        <div class="card leg-card">
          <div class="leg-head">
            <div>
              <strong>${escapeHtml(leg.chainName)} → Solana (CCTP Domain ${leg.sourceDomain} → 5)</strong>
              <div class="mono muted-xs">${leg.gasSponsored ? 'Permit2 Gas-Sponsored' : `Est. Gas $${leg.gasUsd.toFixed(2)}`} · ~${leg.estimatedSeconds}s</div>
            </div>
            <strong class="mono" style="font-size:16px;">$${leg.bridgedUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
          </div>

          <div class="leg-steps">
            ${leg.steps
              .map(
                (s) => `
              <div class="leg-step">
                <strong>${escapeHtml(s.step)}</strong>
                <span class="muted-xs">${escapeHtml(s.detail)}</span>
              </div>
            `
              )
              .join('')}
          </div>

          <div class="calldata-box mono">
            <div style="color:var(--ink-0); font-weight:600; margin-bottom:3px;">depositForBurn calldata (${shortAddr(leg.tokenMessenger)})</div>
            ${escapeHtml(leg.cctpCalldata.slice(0, 88))}…
          </div>

          ${
            simExec
              ? `<div class="mono" style="font-size:11.5px; color:var(--allow);">✓ Simulated · CCTP Nonce #${simExec.cctpNonce} · Solana Mint ${escapeHtml(shortAddr(simExec.solanaMintSig))}</div>`
              : ''
          }
        </div>
      `;
    })
    .join('');
}

function renderBurnView() {
  const rows = currentPlan.burnManifest;
  document.getElementById('burnManifestCount').textContent = `${rows.length} token(s)`;
  const body = document.getElementById('burnTableBody');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:28px; color:var(--ink-3);">No zero-liquidity or honeypot tokens detected in this wallet.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (b) => `
      <tr>
        <td>
          <div class="asset-title">${escapeHtml(b.symbol)}</div>
          <div class="asset-sub mono">${escapeHtml(shortAddr(b.tokenAddress))}</div>
        </td>
        <td class="mono">${escapeHtml(b.chain)}</td>
        <td class="mono">${escapeHtml(b.amount)}</td>
        <td>${b.status === 'BURN_READY' ? `<span class="action-tag tag-burn">Burn to 0x…dEaD</span>` : `<span class="action-tag tag-skip">Skipped Honeypot</span>`}</td>
        <td class="muted-xs">${escapeHtml(b.reason)}</td>
      </tr>
    `
    )
    .join('');
}

async function executeDryRunSimulation() {
  if (!currentScan || !currentPlan) return;
  try {
    lastSimulation = await api('/api/simulate', {
      method: 'POST',
      body: JSON.stringify({
        scan: currentScan,
        selectedAssetIds: Array.from(selectedAssetIds),
        solanaDestination: currentPlan.solanaDestination,
        usePermit2Batch: document.getElementById('permit2Toggle').checked,
        includeBurns: document.getElementById('burnToggle').checked,
        outputAsset,
      }),
    });
    const banner = document.getElementById('simulationBanner');
    banner.classList.remove('hidden');
    banner.innerHTML = `<strong>Dry-Run Simulation Complete (${escapeHtml(lastSimulation.simulationId)})</strong> — ${lastSimulation.executions.length} Circle CCTP leg(s) attested, <strong>$${lastSimulation.plan.totals.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC</strong> bridged to <span class="mono">${escapeHtml(shortAddr(lastSimulation.plan.solanaDestination))}</span>, ${lastSimulation.plan.totals.tokensBurnedCount} dead token(s) burned cleanly.`;
    renderPipelineView();
    switchView('pipeline');
    showToast('Dry-run simulation complete across all active chains.');
  } catch (err) {
    showToast(err.message);
  }
}

async function loadContract() {
  try {
    contractData = await api('/api/contract');
    document.getElementById('contractCodeHost').textContent = contractData.source;
    const lines = contractData.source.split('\n').length;
    document.getElementById('contractStats').textContent =
      `Solidity ${contractData.solidityVersion} · ${lines} lines · Domain ${contractData.solanaCctpDomain} → Solana`;
  } catch (err) {
    document.getElementById('contractCodeHost').textContent = err.message;
  }
}

function wireEvents() {
  document.getElementById('navLaunchBtn').addEventListener('click', () => openApp('scanner'));
  document.getElementById('backToSiteBtn').addEventListener('click', showWebsite);

  document.querySelectorAll('[data-open-app]').forEach((btn) => {
    btn.addEventListener('click', () => openApp(btn.dataset.openApp));
  });

  document.querySelectorAll('.app-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('heroScanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const addr = document.getElementById('heroWalletInput').value.trim();
    if (addr) runScan({ address: addr, autoOpen: true });
    else runScan({ presetId: 'veteran_defi', autoOpen: true });
  });

  document.getElementById('appScanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const addr = document.getElementById('appEvmInput').value.trim();
    if (addr) runScan({ address: addr, autoOpen: false });
  });

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      runScan({ presetId: btn.dataset.preset, autoOpen: true });
    });
  });

  document.getElementById('solanaDestInput').addEventListener('change', recomputePlan);
  document.getElementById('permit2Toggle').addEventListener('change', recomputePlan);
  document.getElementById('burnToggle').addEventListener('change', recomputePlan);

  document.querySelectorAll('.seg-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      outputAsset = btn.dataset.outAsset;
      document.querySelectorAll('.seg-opt').forEach((b) => b.classList.toggle('active', b === btn));
      recomputePlan();
    });
  });

  document.querySelectorAll('.filter-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-pill').forEach((b) => b.classList.toggle('active', b === btn));
      renderAssetTable();
    });
  });

  document.getElementById('selectProfitableBtn').addEventListener('click', () => {
    selectedAssetIds = new Set(currentScan.assets.filter((a) => a.selectedByDefault).map((a) => a.id));
    recomputePlan();
  });

  document.getElementById('clearSelectionBtn').addEventListener('click', () => {
    selectedAssetIds.clear();
    recomputePlan();
  });

  document.getElementById('topSimulateBtn').addEventListener('click', executeDryRunSimulation);
  document.getElementById('runSimulationBtn').addEventListener('click', executeDryRunSimulation);

  document.getElementById('downloadBurnCsvBtn').addEventListener('click', () => {
    if (!currentPlan) return;
    const header = 'chain,symbol,token_address,amount,status,burn_sink,reason';
    const lines = currentPlan.burnManifest.map((b) =>
      [b.chain, b.symbol, b.tokenAddress, `"${b.amount}"`, b.status, b.burnSink, `"${b.reason}"`].join(',')
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `siphon-burn-receipt-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Downloaded CSV burn receipt.');
  });

  document.getElementById('copyBurnJsonBtn').addEventListener('click', async () => {
    if (!currentPlan) return;
    await navigator.clipboard?.writeText(JSON.stringify(currentPlan.burnManifest, null, 2)).catch(() => {});
    showToast('Copied JSON burn manifest.');
  });

  document.getElementById('copyContractBtn').addEventListener('click', async () => {
    const src = contractData?.source || '';
    await navigator.clipboard?.writeText(src).catch(() => {});
    showToast('Copied SiphonRouter.sol.');
  });
}

wireEvents();
heroScene = mountSiphonFunnelScene(document.getElementById('siphonHeroCanvas'));
runScan({ presetId: 'veteran_defi', autoOpen: false });
