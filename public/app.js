import { mountSiphonFunnelScene } from './siphon-3d.js';
import { renderConvergenceSvg } from './siphon-svg.js';
import {
  connectEvmWallet,
  connectSolanaWallet,
  getConnectedEvmAddress,
  getConnectedSolanaAddress,
  sendRealEvmTransaction,
} from './wallets.js';

let currentScan = null;
let currentPlan = null;
let selectedAssetIds = new Set();
let activeFilter = 'all';
let outputAsset = 'USDC';
let heroScene = null;
let contractData = null;
let solanaBalances = null;
const liveExecutionLog = [];

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
  }, 3000);
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

async function refreshSolanaBalance() {
  const solDest = document.getElementById('solanaDestInput')?.value.trim();
  const badge = document.getElementById('solanaLiveBalanceBadge');
  const execEl = document.getElementById('execSolanaBalance');
  if (!solDest) return;
  try {
    solanaBalances = await api(`/api/solana/balance?address=${encodeURIComponent(solDest)}`);
    const summary = `${solanaBalances.usdcBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC · ${solanaBalances.solBalance.toFixed(4)} SOL (slot ${solanaBalances.slot.toLocaleString()})`;
    if (badge) badge.textContent = `Live Solana: ${solanaBalances.usdcBalance.toFixed(2)} USDC · ${solanaBalances.solBalance.toFixed(3)} SOL`;
    if (execEl) execEl.textContent = summary;
  } catch {
    if (badge) badge.textContent = 'Invalid Solana address';
    if (execEl) execEl.textContent = 'Invalid Solana address';
  }
}

function updateWalletButtons() {
  const evmAddr = getConnectedEvmAddress();
  const solAddr = getConnectedSolanaAddress();
  const evmBtn = document.getElementById('connectEvmBtn');
  const solBtn = document.getElementById('connectSolBtn');
  const execEvm = document.getElementById('execConnectedEvm');

  if (evmBtn) {
    evmBtn.textContent = evmAddr ? `EVM: ${shortAddr(evmAddr)}` : 'Connect EVM';
    evmBtn.classList.toggle('connected', Boolean(evmAddr));
  }
  if (solBtn) {
    solBtn.textContent = solAddr ? `SOL: ${shortAddr(solAddr)}` : 'Connect Solana';
    solBtn.classList.toggle('connected', Boolean(solAddr));
  }
  if (execEvm) {
    execEvm.textContent = evmAddr
      ? `${evmAddr} (Live Signing Armed)`
      : 'Not connected — Connect EVM wallet to sign real transactions';
  }
}

async function runScan({ address = null, presetId = null, autoOpen = false } = {}) {
  heroScene?.setActive(true);
  const scanBtn = document.getElementById('appScanBtn');
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
  }
  try {
    const payload = presetId ? { presetId } : address ? { address } : { presetId: 'vitalik_live' };
    currentScan = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

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
        : currentScan.walletLabel || 'Preset Demo';
    badge.classList.toggle('is-live', currentScan.mode === 'live_rpc');

    await Promise.all([recomputePlan(), refreshSolanaBalance()]);
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
  updateWalletButtons();
  const t = currentPlan.totals;

  document.getElementById('kpiNetUsdc').textContent =
    outputAsset === 'SOL'
      ? `${t.netSolanaSol.toFixed(2)} SOL`
      : `$${t.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  document.getElementById('kpiNetLabel').textContent =
    outputAsset === 'SOL' ? 'Net Solana SOL' : 'Net Solana USDC';
  document.getElementById('kpiNetSub').textContent =
    outputAsset === 'SOL'
      ? `$${t.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC eq`
      : `${t.netSolanaSol.toFixed(2)} SOL eq · live Relay/CCTP`;

  const selectedAssets = currentScan.assets.filter((a) => selectedAssetIds.has(a.id));
  const defiUsd = selectedAssets
    .filter((a) => a.action === 'WITHDRAW_AND_BRIDGE')
    .reduce((s, a) => s + a.grossUsd, 0);
  const dustUsd = selectedAssets
    .filter((a) => a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC')
    .reduce((s, a) => s + a.grossUsd, 0);

  document.getElementById('kpiDefiUsd').textContent = `$${defiUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  document.getElementById('kpiDefiSub').textContent = `${t.defiWithdrawnCount} contract position(s)`;

  document.getElementById('kpiDustUsd').textContent = `$${dustUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  document.getElementById('kpiDustSub').textContent = `${t.tokensSoldCount} asset(s) across ${currentPlan.legs.length} chain(s)`;

  document.getElementById('kpiBurnCount').textContent = String(t.tokensBurnedCount);
  document.getElementById('kpiBurnSub').textContent =
    `${t.honeypotsSkippedCount} honeypot skipped · eth_call verified`;

  document.getElementById('tabLegCount').textContent = String(currentPlan.legs.length);
  document.getElementById('tabBurnCount').textContent = String(currentPlan.burnManifest.length);

  document.getElementById('flowSummaryMeta').textContent =
    `${currentPlan.legs.length} active chain(s) · ${t.selectedAssets} selected · ~$${t.totalGasUsd.toFixed(2)} est. gas`;
  document.getElementById('convergenceSvgHost').innerHTML = renderConvergenceSvg(currentPlan, currentScan);

  renderChainCards();
  renderAssetTable();
  renderPipelineView();
  renderBurnView();
  renderLiveExecutionLog();
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
            <span class="mono muted-xs">${c.rpcStatus === 'live' ? `blk ${c.blockNumber.toLocaleString()}` : `D${c.cctpDomain}`}</span>
          </div>
          <div class="chain-mini-val mono">$${val.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div class="chain-mini-sub mono">
            ${c.assetCount} asset(s) · ${c.gasPriceGwei} gwei
          </div>
        </div>
      `;
    })
    .join('');
}

function actionBadge(action) {
  if (action === 'WITHDRAW_AND_BRIDGE') return `<span class="action-tag tag-defi">DeFi Withdraw</span>`;
  if (action === 'BRIDGE_DIRECT_USDC') return `<span class="action-tag tag-direct">Bridge USDC</span>`;
  if (action === 'SELL_AND_BRIDGE') return `<span class="action-tag tag-sell">Swap &amp; Bridge</span>`;
  if (action === 'BURN_ZERO_LIQUIDITY') return `<span class="action-tag tag-burn">Burn 0x…dEaD</span>`;
  if (action === 'SKIP_HONEYPOT') return `<span class="action-tag tag-skip">Honeypot Skipped</span>`;
  return `<span class="action-tag tag-skip">Gas-Negative</span>`;
}

function rowExecLabel(asset) {
  if (asset.action === 'SKIP_HONEYPOT') return 'Blocked';
  if (asset.action === 'BURN_ZERO_LIQUIDITY') return 'Burn Live';
  if (asset.action === 'WITHDRAW_AND_BRIDGE') return 'Withdraw';
  return getConnectedEvmAddress() ? 'Bridge Live' : 'Live Quote';
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
    body.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:28px; color:var(--ink-3);">No assets in this category for this wallet.</td></tr>`;
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
          <td style="text-align:right;">
            <button type="button" class="btn-row-exec" data-exec-asset="${escapeHtml(a.id)}" ${disabled ? 'disabled' : ''}>
              ${escapeHtml(rowExecLabel(a))}
            </button>
          </td>
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

  body.querySelectorAll('[data-exec-asset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const asset = currentScan.assets.find((a) => a.id === btn.dataset.execAsset);
      if (asset) executeSingleAssetLive(asset);
    });
  });
}

function renderLiveExecutionLog() {
  const card = document.getElementById('liveExecLogCard');
  const body = document.getElementById('liveExecLogBody');
  const meta = document.getElementById('liveExecStatusMeta');
  if (!card || !body) return;

  if (!liveExecutionLog.length) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  meta.textContent = `${liveExecutionLog.length} item(s)`;
  body.innerHTML = liveExecutionLog
    .map(
      (entry) => `
      <tr>
        <td>
          <div class="asset-title">${escapeHtml(entry.title)}</div>
          <div class="asset-sub mono">${escapeHtml(entry.chainName)} · ${escapeHtml(entry.detail)}</div>
        </td>
        <td class="mono">${escapeHtml(entry.provider)}</td>
        <td class="mono">${escapeHtml(entry.estimatedOutput || '—')}</td>
        <td><span class="action-tag ${entry.toneClass}">${escapeHtml(entry.status)}</span></td>
        <td class="mono" style="font-size:11.5px;">
          ${entry.evmTxHash ? `<a class="explorer-link" href="${escapeHtml(entry.explorerUrl)}/tx/${escapeHtml(entry.evmTxHash)}" target="_blank" rel="noreferrer">EVM Tx ↗</a>` : '—'}
          ${entry.solanaTxHash ? ` · <a class="explorer-link" href="https://solscan.io/tx/${escapeHtml(entry.solanaTxHash)}" target="_blank" rel="noreferrer">Solscan ↗</a>` : ''}
        </td>
      </tr>
    `
    )
    .join('');
}

async function pollLiveStatus(entry) {
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const st = await api('/api/tx/status', {
        method: 'POST',
        body: JSON.stringify({
          chain: entry.chain,
          txHash: entry.evmTxHash,
          requestId: entry.requestId,
          provider: entry.provider,
        }),
      });
      if (st.evmFailed) {
        entry.status = 'EVM Reverted';
        entry.toneClass = 'tag-burn';
        renderLiveExecutionLog();
        return;
      }
      if (st.solanaTxHash) {
        entry.solanaTxHash = st.solanaTxHash;
      }
      if (st.bridgeStatus === 'success' || (st.evmConfirmed && !entry.requestId)) {
        entry.status = st.solanaTxHash ? 'Landed on Solana' : 'Confirmed Onchain';
        entry.toneClass = 'tag-defi';
        renderLiveExecutionLog();
        refreshSolanaBalance();
        return;
      }
      if (st.evmConfirmed) {
        entry.status = `Relaying (${st.bridgeStatus})`;
        entry.toneClass = 'tag-sell';
        renderLiveExecutionLog();
      }
    } catch {
      // Keep polling
    }
  }
}

/**
 * Executes ONE real asset (DeFi withdraw, live Relay/LI.FI/CCTP bridge to Solana, or eth_call-verified Burn).
 * If an EVM wallet matching the scanned address is connected, prompts real signing via eth_sendTransaction.
 * Otherwise fetches & displays the REAL live quote + executable calldata so the user can inspect and connect to sign!
 */
async function executeSingleAssetLive(asset) {
  switchView('pipeline');
  const solDest = document.getElementById('solanaDestInput').value.trim();
  const bridgePreference = document.getElementById('bridgePrefSelect')?.value || 'auto';
  const connectedEvm = getConnectedEvmAddress();
  const userAddress = connectedEvm || currentScan.walletAddress;

  const entry = {
    title: `${asset.symbol} (${asset.action.replaceAll('_', ' ')})`,
    chain: asset.chain,
    chainName: asset.chainName,
    explorerUrl: '',
    provider: 'quoting…',
    estimatedOutput: 'Fetching live quote…',
    detail: 'Querying live mainnet route & calldata',
    status: 'Quoting',
    toneClass: 'tag-skip',
    evmTxHash: null,
    solanaTxHash: null,
    requestId: null,
  };
  liveExecutionLog.unshift(entry);
  renderLiveExecutionLog();

  try {
    const prepared = await api('/api/tx/prepare', {
      method: 'POST',
      body: JSON.stringify({
        asset,
        userAddress,
        solanaDestination: solDest,
        outputAsset,
        bridgePreference,
      }),
    });

    entry.provider = prepared.provider;
    entry.estimatedOutput = prepared.estimatedOutput;
    entry.explorerUrl = prepared.explorerUrl;
    entry.requestId = prepared.requestId || null;
    entry.detail = `${prepared.transactions.length} tx(s) · ~${prepared.estimatedSeconds}s`;

    if (!connectedEvm) {
      entry.status = 'Quote Ready (Connect EVM to Sign)';
      entry.toneClass = 'tag-sell';
      renderLiveExecutionLog();
      showToast(`Live ${prepared.provider} quote ready: ${prepared.estimatedOutput}. Connect EVM wallet to sign.`);
      return;
    }

    if (connectedEvm.toLowerCase() !== currentScan.walletAddress.toLowerCase()) {
      entry.status = 'Switch to Connected Wallet Scan';
      entry.toneClass = 'tag-burn';
      renderLiveExecutionLog();
      showToast('Connected EVM wallet does not match the scanned address. Scanning your connected wallet now.');
      await runScan({ address: connectedEvm, autoOpen: true });
      return;
    }

    for (let i = 0; i < prepared.transactions.length; i++) {
      const tx = prepared.transactions[i];
      entry.status = `Sign ${i + 1}/${prepared.transactions.length}: ${tx.stepId}`;
      entry.toneClass = 'tag-sell';
      renderLiveExecutionLog();

      const txHash = await sendRealEvmTransaction(tx);
      entry.evmTxHash = txHash;
      entry.status = `Submitted (${shortAddr(txHash)})`;
      renderLiveExecutionLog();
    }

    showToast(`Submitted on ${prepared.chainName}! Tracking live confirmation…`);
    pollLiveStatus(entry);
  } catch (err) {
    entry.status = 'Failed / Cancelled';
    entry.detail = err.message;
    entry.toneClass = 'tag-burn';
    renderLiveExecutionLog();
    showToast(err.message);
  }
}

async function executeSelectedLiveQueue() {
  if (!currentScan) return;
  const chosen = currentScan.assets.filter(
    (a) => selectedAssetIds.has(a.id) && a.action !== 'SKIP_HONEYPOT'
  );
  if (!chosen.length) {
    showToast('Select at least one asset to execute.');
    return;
  }

  // Execute DeFi withdrawals first, then liquid swaps/bridges, then burns
  const order = {
    WITHDRAW_AND_BRIDGE: 1,
    SELL_AND_BRIDGE: 2,
    BRIDGE_DIRECT_USDC: 3,
    BURN_ZERO_LIQUIDITY: 4,
    SKIP_GAS_NEGATIVE: 5,
    SKIP_HONEYPOT: 6,
  };
  chosen.sort((a, b) => (order[a.action] ?? 9) - (order[b.action] ?? 9));

  const connectedEvm = getConnectedEvmAddress();
  if (!connectedEvm) {
    // If no wallet connected yet, fetch live quotes for top 3 items so user sees real live routes immediately
    showToast('No EVM wallet connected — fetching live quotes for preview. Connect EVM to sign.');
    for (const asset of chosen.slice(0, 3)) {
      await executeSingleAssetLive(asset);
    }
    return;
  }

  for (const asset of chosen) {
    await executeSingleAssetLive(asset);
  }
}

function renderPipelineView() {
  document.getElementById('planSolAddr').textContent = currentPlan.solanaDestination;
  document.getElementById('planSolBytes32').textContent = currentPlan.solanaMintRecipientBytes32;

  const grid = document.getElementById('cctpLegsGrid');
  if (!currentPlan.legs.length) {
    grid.innerHTML = `<div class="card pad-card muted-xs">Select at least one asset in Scanner &amp; Plan to prepare execution routes.</div>`;
    return;
  }

  grid.innerHTML = currentPlan.legs
    .map((leg) => {
      return `
        <div class="card leg-card">
          <div class="leg-head">
            <div>
              <strong>${escapeHtml(leg.chainName)} → Solana (Domain ${leg.sourceDomain} → 5)</strong>
              <div class="mono muted-xs">Est. Gas $${leg.gasUsd.toFixed(2)} · Relay ~10s / CCTP ~${leg.estimatedSeconds}s</div>
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
            <div style="color:var(--ink-0); font-weight:600; margin-bottom:3px;">Direct CCTP depositForBurn (${shortAddr(leg.tokenMessenger)})</div>
            ${escapeHtml(leg.cctpCalldata.slice(0, 88))}…
          </div>
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

  document.getElementById('connectEvmBtn').addEventListener('click', async () => {
    try {
      const { address, walletName } = await connectEvmWallet((next) => {
        updateWalletButtons();
        if (next) runScan({ address: next, autoOpen: true });
      });
      updateWalletButtons();
      showToast(`Connected ${walletName}: ${shortAddr(address)} — scanning live across 6 chains!`);
      await runScan({ address, autoOpen: true });
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('connectSolBtn').addEventListener('click', async () => {
    try {
      const { address, walletName } = await connectSolanaWallet();
      document.getElementById('solanaDestInput').value = address;
      updateWalletButtons();
      showToast(`Connected ${walletName}: ${shortAddr(address)}`);
      await Promise.all([recomputePlan(), refreshSolanaBalance()]);
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('heroScanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const addr = document.getElementById('heroWalletInput').value.trim();
    if (addr) runScan({ address: addr, autoOpen: true });
    else runScan({ presetId: 'vitalik_live', autoOpen: true });
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

  document.getElementById('solanaDestInput').addEventListener('change', () => {
    recomputePlan();
    refreshSolanaBalance();
  });
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

  document.getElementById('topExecuteLiveBtn').addEventListener('click', executeSelectedLiveQueue);
  document.getElementById('runLiveQueueBtn').addEventListener('click', executeSelectedLiveQueue);

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
// Default load: REAL live mainnet scan of vitalik.eth (not a fake preset!)
runScan({ presetId: 'vitalik_live', autoOpen: false });
