import { mountSiphonFunnelScene } from './siphon-3d.js';
import { renderConvergenceSvg } from './siphon-svg.js';
import {
  connectCoinbaseSmartWallet,
  connectEvmWallet,
  connectSolanaWallet,
  connectWalletConnect,
  disconnectEvmWallet,
  disconnectSolanaWallet,
  getConnectedEvmAddress,
  getConnectedSolanaAddress,
  getConnectedSolanaWalletName,
  getConnectedWalletName,
  getEffectiveWalletConnectProjectId,
  getWalletBatchCapabilities,
  getWalletConnectorConfig,
  isChainBatchSupported,
  listAvailableEvmWallets,
  listAvailableSolanaWallets,
  loadWalletConnectorConfig,
  preloadWalletSdks,
  refreshInstalledWallets,
  sendEip5792Batch,
  sendRealEvmTransaction,
  setSavedWalletConnectProjectId,
  subscribeWalletDiscovery,
  waitForEip5792Batch,
} from './wallets.js';

let currentScan = null;
let currentPlan = null;
let selectedAssetIds = new Set();
let activeFilter = 'all';
let outputAsset = 'USDC';
let heroScene = null;
let contractData = null;
let activeContractId = 'router';
let solanaBalances = null;
const liveExecutionLog = [];

const FEE_RECIPIENT_STORAGE_KEY = 'siphon_fee_recipient_evm';

function getWalletLogoPath(name, rdns = '') {
  const s = `${name || ''} ${rdns || ''}`.toLowerCase();
  if (s.includes('metamask')) return '/logos/metamask.svg';
  if (s.includes('rabby')) return '/logos/rabby.svg';
  if (s.includes('phantom')) return '/logos/phantom.svg';
  if (s.includes('coinbase')) return '/logos/coinbase.svg';
  if (s.includes('walletconnect')) return '/logos/walletconnect.svg';
  if (s.includes('okx') || s.includes('okex')) return '/logos/okx.svg';
  if (s.includes('backpack')) return '/logos/backpack.svg';
  if (s.includes('solflare')) return '/logos/solflare.svg';
  if (s.includes('trust')) return '/logos/trust.svg';
  if (s.includes('brave')) return '/logos/brave.svg';
  if (s.includes('rainbow')) return '/logos/rainbow.svg';
  if (s.includes('ledger')) return '/logos/ledger.svg';
  return '/logos/ethereum.svg';
}

function getChainLogoPath(chain) {
  const c = String(chain || '').toLowerCase();
  if (['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche', 'solana'].includes(c)) {
    return `/logos/${c}.svg`;
  }
  return '/logos/ethereum.svg';
}

function getProtocolLogoPath(protocol) {
  const p = String(protocol || '').toLowerCase();
  if (p.includes('aave')) return '/logos/aave.svg';
  if (p.includes('lido')) return '/logos/lido.svg';
  if (p.includes('compound')) return '/logos/compound.svg';
  return null;
}

function getBridgeProviderLogosHtml(pref) {
  if (pref === 'cctp') {
    return `<img src="/logos/circle.svg" alt="" class="chain-logo-xs" />`;
  }
  if (pref === 'lifi') {
    return `<img src="/logos/lifi.svg" alt="" class="chain-logo-xs" />`;
  }
  if (pref === 'relay') {
    return `<img src="/logos/relay.svg" alt="" class="chain-logo-xs" />`;
  }
  return `<img src="/logos/relay.svg" alt="" class="chain-logo-xs" /><img src="/logos/lifi.svg" alt="" class="chain-logo-xs" />`;
}

function getActiveProtocolFeeBps() {
  const sel = document.getElementById('protocolFeeSelect');
  const raw = Number(sel?.value || 700);
  if (!Number.isFinite(raw)) return 700;
  return Math.min(1000, Math.max(500, Math.round(raw)));
}

function getActiveFeeRecipientEvm() {
  const input = document.getElementById('feeRecipientInput');
  const val = input?.value?.trim();
  if (val && /^0x[0-9a-fA-F]{40}$/.test(val)) return val;
  const serverCfg = getWalletConnectorConfig()?.protocolFee?.feeRecipientEvm;
  if (serverCfg && /^0x[0-9a-fA-F]{40}$/.test(serverCfg)) return serverCfg;
  return null;
}

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
    const ataNote = solanaBalances.hasUsdcAta ? 'USDC ATA ready' : 'No USDC ATA yet (CCTP needs ~0.002 SOL)';
    const summary = `${solanaBalances.usdcBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC · ${solanaBalances.solBalance.toFixed(4)} SOL · ${ataNote} (slot ${solanaBalances.slot.toLocaleString()})`;
    if (badge) badge.textContent = `Live Solana: ${solanaBalances.usdcBalance.toFixed(2)} USDC · ${solanaBalances.solBalance.toFixed(3)} SOL`;
    if (execEl) execEl.textContent = summary;
  } catch (err) {
    const isInvalid = String(err?.message || '').toLowerCase().includes('invalid');
    const msg = isInvalid ? 'Invalid Solana address' : 'Solana RPC busy · valid Ed25519 destination';
    if (badge) badge.textContent = msg;
    if (execEl) execEl.textContent = msg;
  }
}

function estimateChainCallCounts() {
  if (!currentScan) return { totalCalls: 0, totalChains: 0, popupsSaved: 0, perChain: new Map() };
  const perChain = new Map();
  const chosen = currentScan.assets.filter(
    (a) => selectedAssetIds.has(a.id) && a.action !== 'SKIP_HONEYPOT'
  );
  for (const a of chosen) {
    const entry = perChain.get(a.chain) || { assets: [], estCalls: 0, permit2Count: 0, eip2612Count: 0 };
    entry.assets.push(a);
    // Estimate raw individual txs: DeFi USDC withdraw + approve + CCTP = 3, Swap/Bridge = 2 (approve + swap) or 1 (native), Burn = 1
    if (a.action === 'WITHDRAW_AND_BRIDGE' && a.underlyingSymbol === 'USDC') entry.estCalls += 3;
    else if (a.action === 'BURN_ZERO_LIQUIDITY' || a.address === 'native') entry.estCalls += 1;
    else entry.estCalls += 2;
    if (a.permit2Approved) entry.permit2Count += 1;
    if (a.eip2612Supported) entry.eip2612Count += 1;
    perChain.set(a.chain, entry);
  }
  const totalChains = perChain.size;
  let totalCalls = 0;
  for (const v of perChain.values()) totalCalls += v.estCalls;
  return {
    totalCalls,
    totalChains,
    popupsSaved: Math.max(0, totalCalls - totalChains),
    perChain,
  };
}

function updateWalletButtons() {
  const evmAddr = getConnectedEvmAddress();
  const solAddr = getConnectedSolanaAddress();
  const walletName = getConnectedWalletName();
  const caps = getWalletBatchCapabilities();
  const stats = estimateChainCallCounts();

  const evmBtn = document.getElementById('connectEvmBtn');
  const solBtn = document.getElementById('connectSolBtn');
  const siteBtn = document.getElementById('siteConnectBtn');
  const heroBtn = document.getElementById('heroConnectBtn');
  const execEvm = document.getElementById('execConnectedEvm');
  const execBatch = document.getElementById('execBatchMode');
  const topBtn = document.getElementById('topExecuteLiveBtn');
  const queueBtn = document.getElementById('runLiveQueueBtn');

  if (evmBtn) {
    const shortName = walletName ? walletName.split(' ')[0] : 'EVM';
    const logo = evmAddr ? getWalletLogoPath(walletName) : '/logos/ethereum.svg';
    evmBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo" /><span>${escapeHtml(evmAddr ? `${shortName}: ${shortAddr(evmAddr)}` : 'Connect EVM')}</span>`;
    evmBtn.classList.toggle('connected', Boolean(evmAddr));
  }
  if (solBtn) {
    const solFull = getConnectedSolanaWalletName();
    const solName = solFull?.split(' ')[0] || 'SOL';
    const logo = solAddr ? getWalletLogoPath(solFull || 'Phantom') : '/logos/solana.svg';
    solBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo" /><span>${escapeHtml(solAddr ? `${solName}: ${shortAddr(solAddr)}` : 'Connect Solana')}</span>`;
    solBtn.classList.toggle('connected', Boolean(solAddr));
  }
  if (siteBtn) {
    const shortName = walletName ? walletName.split(' ')[0] : null;
    if (evmAddr) {
      const logo = getWalletLogoPath(walletName);
      siteBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo" /><span>${escapeHtml(`${shortName ? `${shortName} · ` : ''}${shortAddr(evmAddr)}`)}</span>`;
    } else if (solAddr) {
      const logo = getWalletLogoPath(getConnectedSolanaWalletName() || 'Phantom');
      siteBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo" /><span>${escapeHtml(`SOL · ${shortAddr(solAddr)}`)}</span>`;
    } else {
      siteBtn.textContent = 'Connect Wallet';
    }
    siteBtn.classList.toggle('connected', Boolean(evmAddr || solAddr));
    siteBtn.classList.toggle('btn-with-logo', Boolean(evmAddr || solAddr));
  }
  if (heroBtn) {
    heroBtn.textContent = evmAddr
      ? `${walletName || 'Wallet'} · ${shortAddr(evmAddr)}`
      : 'Connect Wallet';
  }
  if (execEvm) {
    execEvm.textContent = evmAddr
      ? `${evmAddr} (${walletName || 'EVM'} · Live Signing Armed)`
      : 'Not connected — Connect EVM wallet to sign real batches';
  }
  if (execBatch) {
    const reduction =
      stats.totalChains > 0
        ? ` · ${stats.totalCalls} calls → ${stats.totalChains} click(s) (${stats.popupsSaved} popups saved)`
        : '';
    if (evmAddr && caps.probed && caps.anySupported) {
      execBatch.innerHTML = `<span class="batch-pill armed">EIP-5792 Armed</span> ${escapeHtml(caps.modeLabel)}${escapeHtml(reduction)}`;
    } else if (evmAddr && caps.probed && !caps.anySupported) {
      execBatch.innerHTML = `<span class="batch-pill fallback">Sequential Fallback</span> ${escapeHtml(caps.modeLabel)}`;
    } else {
      execBatch.innerHTML = `<span class="batch-pill">EIP-5792 Ready</span> 1 Click / Chain via wallet_sendCalls${escapeHtml(reduction)}`;
    }
  }
  if (topBtn) {
    topBtn.textContent =
      stats.totalChains > 0
        ? `Batch (${stats.totalChains} ${stats.totalChains === 1 ? 'Click' : 'Clicks'})`
        : 'Batch Execute';
  }
  if (queueBtn) {
    queueBtn.textContent =
      stats.totalChains > 0
        ? `Execute ${stats.totalChains} Chain${stats.totalChains === 1 ? '' : 's'} (${stats.totalChains} Click${stats.totalChains === 1 ? '' : 's'})`
        : 'Execute All Chains (1 Click / Chain)';
  }
}

// Latest scan wins: a slower earlier scan must never overwrite a newer one.
let scanSeq = 0;

async function runScan({ address = null, presetId = null, autoOpen = false } = {}) {
  const seq = ++scanSeq;
  heroScene?.setActive(true);
  const scanBtn = document.getElementById('appScanBtn');
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
  }
  try {
    const payload = presetId ? { presetId } : address ? { address } : { presetId: 'vitalik_live' };
    const scan = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (seq !== scanSeq) return;
    currentScan = scan;

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
    if (seq === scanSeq) showToast(err.message);
  } finally {
    if (seq !== scanSeq) return;
    heroScene?.setActive(false);
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.textContent = 'Scan Live';
    }
  }
}

function getActiveBridgePreference() {
  const select = document.getElementById('bridgePrefSelect');
  const cctpOpt = select?.querySelector('option[value="cctp"]');
  if (cctpOpt) {
    cctpOpt.disabled = outputAsset === 'SOL';
    cctpOpt.textContent =
      outputAsset === 'SOL'
        ? 'Direct Circle CCTP (USDC only)'
        : 'Direct Circle CCTP (USDC)';
  }
  if (select && outputAsset === 'SOL' && select.value === 'cctp') {
    select.value = 'auto';
  }
  return select?.value || 'auto';
}

async function recomputePlan() {
  if (!currentScan) return;
  const solDest = document.getElementById('solanaDestInput').value.trim();
  const usePermit2Batch = document.getElementById('permit2Toggle').checked;
  const includeBurns = document.getElementById('burnToggle').checked;
  const bridgePreference = getActiveBridgePreference();
  const protocolFeeBps = getActiveProtocolFeeBps();
  const feeRecipientEvm = getActiveFeeRecipientEvm();

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
        bridgePreference,
        protocolFeeBps,
        feeRecipientEvm,
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
  const pref = currentPlan.bridgePreference || getActiveBridgePreference();
  const shortProvider =
    pref === 'cctp'
      ? 'Circle CCTP 1:1'
      : pref === 'relay'
      ? 'Relay (~2s fill)'
      : pref === 'lifi'
      ? 'LI.FI aggregator'
      : 'Relay / LI.FI auto-fill';

  document.getElementById('kpiNetUsdc').textContent =
    outputAsset === 'SOL'
      ? `${t.netSolanaSol.toFixed(2)} SOL`
      : `$${t.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  document.getElementById('kpiNetLabel').textContent =
    outputAsset === 'SOL' ? 'Net Solana SOL' : 'Net Solana USDC';
  const feePct = currentPlan.protocolFeePercent ?? (getActiveProtocolFeeBps() / 100);
  document.getElementById('kpiNetSub').textContent =
    outputAsset === 'SOL'
      ? `$${t.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })} eq · ${shortProvider} · ${feePct}% fee`
      : `${t.netSolanaSol.toFixed(2)} SOL eq · ${shortProvider} · ${feePct}% fee`;

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
            <span class="inline-logo-row">
              <img src="${escapeHtml(getChainLogoPath(c.chain))}" alt="" class="chain-logo-sm" />
              <span>${escapeHtml(c.chainName)}</span>
            </span>
            <span class="mono muted-xs">${c.rpcStatus === 'live' ? `Live` : `D${c.cctpDomain}`}</span>
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
            <div class="asset-title inline-logo-row">
              ${a.protocol && getProtocolLogoPath(a.protocol) ? `<img src="${escapeHtml(getProtocolLogoPath(a.protocol))}" alt="" class="chain-logo-xs" />` : ''}
              <span>${escapeHtml(a.symbol)}</span>${a.protocol ? ` <span class="muted-xs">· ${escapeHtml(a.protocol)}</span>` : ''}${a.aaveDebtUsd > 0 ? `<span class="micro-pill" style="background:var(--block-bg);border-color:#fecaca;color:#991b1b;" title="${escapeHtml(a.actionReason)}">Debt Guard</span>` : a.permit2Approved ? `<span class="micro-pill permit2" title="Already approved on Uniswap Permit2 (no approval tx needed)">Permit2</span>` : a.eip2612Supported ? `<span class="micro-pill eip2612" title="Supports EIP-2612 gasless signature permit">EIP-2612</span>` : ''}
            </div>
            <div class="asset-sub">${escapeHtml(a.name)}</div>
          </td>
          <td class="mono"><span class="inline-logo-row"><img src="${escapeHtml(getChainLogoPath(a.chain))}" alt="" class="chain-logo-xs" /><span>${escapeHtml(a.chainName)}</span></span></td>
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
      (entry, idx) => `
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
            ${entry.requiresSolanaClaim && entry.evmTxHash ? ` · <button type="button" class="text-action" data-check-cctp="${idx}">Check CCTP Iris</button>` : ''}
          </td>
        </tr>
      `
    )
    .join('');

  body.querySelectorAll('[data-check-cctp]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.checkCctp);
      const entry = liveExecutionLog[idx];
      if (!entry?.evmTxHash) return;
      const solDest = document.getElementById('solanaDestInput')?.value.trim();
      try {
        btn.textContent = 'Checking Iris…';
        const att = await api('/api/cctp/attestation', {
          method: 'POST',
          body: JSON.stringify({ chain: entry.chain, txHash: entry.evmTxHash, solanaDestination: solDest }),
        });
        entry.status =
          att.attestationStatus === 'complete'
            ? 'CCTP Attested · Ready to Claim'
            : `CCTP: ${att.attestationStatus}`;
        entry.detail = att.nextStep;
        entry.toneClass = att.attestationStatus === 'complete' ? 'tag-defi' : 'tag-sell';
        renderLiveExecutionLog();
        showToast(att.nextStep);
      } catch (err) {
        showToast(err.message);
      }
    });
  });
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
        protocolFeeBps: getActiveProtocolFeeBps(),
        feeRecipientEvm: getActiveFeeRecipientEvm(),
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

/**
 * Executes an ENTIRE EVM chain in ONE wallet confirmation popup using EIP-5792 `wallet_sendCalls`
 * (bundles DeFi exits + deduped approvals + Relay/LI.FI/CCTP bridges + eth_call-verified burns).
 * Automatically falls back to sequential `eth_sendTransaction` if the connected wallet lacks EIP-5792.
 */
async function executeChainBatchLive(chain) {
  if (!currentScan) return;
  switchView('pipeline');

  const chainAssets = currentScan.assets.filter(
    (a) => a.chain === chain && selectedAssetIds.has(a.id) && a.action !== 'SKIP_HONEYPOT'
  );
  if (!chainAssets.length) {
    showToast(`No selected executable assets on ${chain}.`);
    return;
  }

  const solDest = document.getElementById('solanaDestInput').value.trim();
  const bridgePreference = document.getElementById('bridgePrefSelect')?.value || 'auto';
  const connectedEvm = getConnectedEvmAddress();
  const userAddress = connectedEvm || currentScan.walletAddress;
  const chainName = chainAssets[0]?.chainName || chain;

  const entry = {
    title: `${chainName} Atomic Chain Batch (${chainAssets.length} asset${chainAssets.length === 1 ? '' : 's'})`,
    chain,
    chainName,
    explorerUrl: '',
    provider: 'eip5792_batch',
    estimatedOutput: 'Preparing batched calldata…',
    detail: `Bundling ${chainAssets.map((a) => a.symbol).join(', ')}`,
    status: 'Preparing Batch',
    toneClass: 'tag-skip',
    evmTxHash: null,
    solanaTxHash: null,
    requestId: null,
  };
  liveExecutionLog.unshift(entry);
  renderLiveExecutionLog();

  try {
    const hasSolanaSigner = Boolean(getConnectedSolanaAddress());
    const batch = await api('/api/tx/prepare-chain-batch', {
      method: 'POST',
      body: JSON.stringify({
        chain,
        assets: chainAssets,
        userAddress,
        solanaDestination: solDest,
        outputAsset,
        bridgePreference,
        protocolFeeBps: getActiveProtocolFeeBps(),
        feeRecipientEvm: getActiveFeeRecipientEvm(),
        // Only bundle direct Circle CCTP after DeFi USDC exits when Solana signer is connected or CCTP was explicitly chosen;
        // otherwise withdraw cleanly to wallet so auto-delivered Relay/LI.FI can bridge with zero manual Solana claim.
        bundleDefiCctp: hasSolanaSigner || bridgePreference === 'cctp',
      }),
    });

    entry.explorerUrl = batch.explorerUrl;
    entry.requiresSolanaClaim = batch.bridgeTrackers.some((t) => t.requiresSolanaClaim);
    const trackerSummary = batch.bridgeTrackers
      .map((t) => `${t.assetSymbol}→${t.estimatedOutput}`)
      .slice(0, 2)
      .join(' + ');
    entry.estimatedOutput =
      trackerSummary || `${batch.calls.length} call(s) batched (~${batch.estimatedSeconds}s)`;
    entry.detail = `${batch.savings.totalCalls} call(s) → 1 EIP-5792 click (${batch.savings.popupsSaved} popup${batch.savings.popupsSaved === 1 ? '' : 's'} saved${batch.savings.dedupedApprovals ? ` · ${batch.savings.dedupedApprovals} deduped` : ''})`;

    if (!batch.calls.length) {
      entry.status = 'No Executable Route';
      entry.detail = batch.skippedAssets.map((s) => `${s.assetSymbol}: ${s.reason}`).join(' | ') || 'No calls built';
      entry.toneClass = 'tag-skip';
      renderLiveExecutionLog();
      return;
    }

    if (!connectedEvm) {
      entry.status = `Batch Ready (${batch.calls.length} → 1 Click · Connect EVM)`;
      entry.toneClass = 'tag-sell';
      renderLiveExecutionLog();
      showToast(
        `${batch.chainName} EIP-5792 batch ready: ${batch.calls.length} calls in 1 click (${batch.savings.popupsSaved} popups saved). Connect EVM wallet to sign.`
      );
      return;
    }

    if (connectedEvm.toLowerCase() !== currentScan.walletAddress.toLowerCase()) {
      entry.status = 'Switch to Connected Wallet Scan';
      entry.toneClass = 'tag-burn';
      renderLiveExecutionLog();
      showToast('Connected EVM wallet differs from scanned address. Scanning your connected wallet now.');
      await runScan({ address: connectedEvm, autoOpen: true });
      return;
    }

    const chainCap = isChainBatchSupported(batch.chainId);
    let submittedHashes = [];
    let usedEip5792 = false;

    // Try EIP-5792 wallet_sendCalls first (1 popup for the entire chain!)
    if (chainCap.supported || batch.calls.length > 1) {
      try {
        entry.status = `Sign 1 Click (${batch.calls.length} Batched Calls)`;
        entry.toneClass = 'tag-sell';
        renderLiveExecutionLog();

        const { batchId } = await sendEip5792Batch({
          chainId: batch.chainId,
          calls: batch.calls,
        });
        usedEip5792 = true;
        entry.status = `EIP-5792 Submitted (${shortAddr(batchId)})`;
        renderLiveExecutionLog();

        const settled = await waitForEip5792Batch(batchId, (upd) => {
          if (upd.txHashes?.length) entry.evmTxHash = upd.txHashes[0];
          entry.status = `Batch Status: ${upd.status}`;
          renderLiveExecutionLog();
        });

        submittedHashes = settled.txHashes || [];
        if (submittedHashes[0]) entry.evmTxHash = submittedHashes[0];

        if (settled.failed) {
          entry.status = 'Batch Failed Onchain';
          entry.toneClass = 'tag-burn';
          renderLiveExecutionLog();
          return;
        }

        entry.status = batch.bridgeTrackers.length
          ? 'Batch Confirmed · Tracking Solana'
          : 'Batch Confirmed Onchain';
        entry.toneClass = 'tag-defi';
        renderLiveExecutionLog();
      } catch (err) {
        if (err?.code === 4001) throw err; // User rejected
        if (!err?.unsupportedEip5792) throw err;
        // Transparent fallback for legacy wallets without EIP-5792
        showToast(`${batch.chainName}: wallet lacks EIP-5792 — switching to sequential signing.`);
      }
    }

    if (!usedEip5792) {
      entry.provider = 'sequential_fallback';
      for (let i = 0; i < batch.calls.length; i++) {
        const call = batch.calls[i];
        entry.status = `Sign ${i + 1}/${batch.calls.length}: ${call.stepId}`;
        entry.toneClass = 'tag-sell';
        renderLiveExecutionLog();

        const txHash = await sendRealEvmTransaction({
          chainId: batch.chainId,
          to: call.to,
          data: call.data,
          value: call.value,
          gas: call.gas,
        });
        submittedHashes.push(txHash);
        entry.evmTxHash = txHash;
        entry.status = `Submitted ${i + 1}/${batch.calls.length} (${shortAddr(txHash)})`;
        renderLiveExecutionLog();

        // Wait for mining confirmation after withdraw/approve before firing the next dependent tx
        const needsMiningBeforeNext =
          i < batch.calls.length - 1 &&
          (call.stepId.includes('withdraw') ||
            call.stepId.includes('redeem') ||
            call.stepId.includes('approve'));
        if (needsMiningBeforeNext) {
          entry.status = `Waiting confirm ${i + 1}/${batch.calls.length}…`;
          renderLiveExecutionLog();
          await waitForEvmReceipt(batch.chain, txHash);
        }
      }
    }

    // Track Relay / bridge landing on Solana across ALL bridged assets in the chain batch
    const relayTrackers = batch.bridgeTrackers.filter((t) => t.provider === 'relay' && t.requestId);
    if (relayTrackers.length > 0) {
      entry.provider = 'relay';
      entry.requestId = relayTrackers[0].requestId;
      pollBatchBridgeTrackers(entry, batch.chain, relayTrackers);
    } else if (entry.evmTxHash) {
      pollLiveStatus(entry);
    }

    showToast(
      usedEip5792
        ? `${batch.chainName} EIP-5792 batch confirmed in 1 click!`
        : `${batch.chainName} sequential execution submitted.`
    );
    refreshSolanaBalance();
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
  const stats = estimateChainCallCounts();
  const activeChains = Array.from(stats.perChain.keys());
  if (!activeChains.length) {
    showToast('Select at least one asset to execute.');
    return;
  }

  const connectedEvm = getConnectedEvmAddress();
  if (!connectedEvm) {
    showToast(
      `No EVM wallet connected — preparing live EIP-5792 chain batches (${stats.totalCalls} calls → ${activeChains.length} clicks).`
    );
    for (const chain of activeChains.slice(0, 3)) {
      await executeChainBatchLive(chain);
    }
    return;
  }

  for (const chain of activeChains) {
    await executeChainBatchLive(chain);
  }
}

function renderPipelineView() {
  document.getElementById('planSolAddr').textContent = currentPlan.solanaDestination;
  document.getElementById('planSolBytes32').textContent = currentPlan.solanaMintRecipientBytes32;
  const pref = currentPlan.bridgePreference || getActiveBridgePreference();
  const activeProvEl = document.getElementById('execActiveProvider');
  if (activeProvEl) {
    activeProvEl.innerHTML = `${getBridgeProviderLogosHtml(pref)}<span>${escapeHtml(
      currentPlan.activeBridgeLabel || 'Auto (Relay → LI.FI → Circle CCTP)'
    )}</span>`;
  }
  const feeUsdEl = document.getElementById('execFeeUsdSummary');
  if (feeUsdEl) {
    const feeUsd = Number(currentPlan.totals.protocolFeeUsd || 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
    });
    const destTag = currentPlan.feeRecipientEvm ? shortAddr(currentPlan.feeRecipientEvm) : 'Set treasury';
    feeUsdEl.textContent = `$${feeUsd} → ${destTag}`;
  }

  const grid = document.getElementById('cctpLegsGrid');
  if (!currentPlan.legs.length) {
    grid.innerHTML = `<div class="card pad-card muted-xs">Select at least one asset in Scanner &amp; Plan to prepare execution routes.</div>`;
    return;
  }

  const stats = estimateChainCallCounts();

  grid.innerHTML = currentPlan.legs
    .map((leg) => {
      const chainStats = stats.perChain.get(leg.chain);
      const estCalls = chainStats?.estCalls ?? Math.max(1, leg.defiExits + leg.swaps + leg.burns);
      const saved = Math.max(0, estCalls - 1);
      const chainCfg = currentScan.chains.find((c) => c.chain === leg.chain);
      const cap = chainCfg ? isChainBatchSupported(chainCfg.chainId) : { supported: false };
      const routeMeta =
        pref === 'cctp'
          ? `Circle CCTP Domain ${leg.sourceDomain} → 5 · ~${leg.estimatedSeconds}s finality`
          : pref === 'lifi'
          ? `LI.FI Multi-Bridge → Solana ${currentPlan.outputAsset} · ~15–30s`
          : pref === 'relay'
          ? `Relay Instant Fill → Solana ${currentPlan.outputAsset} · ~2–10s`
          : `Relay → LI.FI Auto-Fill → Solana ${currentPlan.outputAsset} · ~2–15s`;

      const routeBoxHtml =
        pref === 'cctp'
          ? `
          <div class="calldata-box mono">
            <div class="calldata-title">
              <img src="/logos/circle.svg" alt="" class="chain-logo-xs" />
              <span>Circle CCTP depositForBurn (${shortAddr(leg.tokenMessenger)})</span>
            </div>
            <div>${escapeHtml(leg.cctpCalldata.slice(0, 88))}…</div>
          </div>`
          : `
          <div class="calldata-box mono">
            <div class="calldata-title">
              ${getBridgeProviderLogosHtml(pref)}
              <span>Live ${pref === 'lifi' ? 'LI.FI /v1/quote' : 'Relay /quote'} Route (${leg.chainName} #${chainCfg?.chainId ?? ''} → Solana ${currentPlan.outputAsset})</span>
            </div>
            <div>Exact calldata fetched fresh on click · Zero manual Solana claim · Exact ERC-20 approvals only</div>
          </div>`;

      return `
        <div class="card leg-card">
          <div class="leg-head">
            <div>
              <strong class="inline-logo-row">
                <img src="${escapeHtml(getChainLogoPath(leg.chain))}" alt="" class="chain-logo-sm" />
                <span>${escapeHtml(leg.chainName)}</span>
                <span class="muted-xs">→</span>
                <img src="/logos/solana.svg" alt="" class="chain-logo-sm" />
                <span>Solana ${escapeHtml(currentPlan.outputAsset)}</span>
              </strong>
              <div class="mono muted-xs" style="margin-top:3px;">Est. Gas $${leg.gasUsd.toFixed(2)} · ${escapeHtml(routeMeta)}</div>
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

          ${routeBoxHtml}

          <div class="leg-batch-footer">
            <div class="leg-batch-meta mono">
              <span class="batch-pill ${cap.supported ? 'armed' : ''}">${estCalls} call${estCalls === 1 ? '' : 's'} → 1 click</span>
              ${saved > 0 ? `<span>${saved} popup${saved === 1 ? '' : 's'} saved</span>` : `<span>atomic</span>`}
              ${chainStats?.permit2Count ? `<span class="micro-pill permit2">${chainStats.permit2Count} Permit2</span>` : ''}
              ${chainStats?.eip2612Count ? `<span class="micro-pill eip2612">${chainStats.eip2612Count} EIP-2612</span>` : ''}
            </div>
            <button type="button" class="btn-pill-dark btn-sm" data-exec-chain-batch="${escapeHtml(leg.chain)}">
              Execute ${escapeHtml(leg.chainName)} (1 Click)
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  grid.querySelectorAll('[data-exec-chain-batch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      executeChainBatchLive(btn.dataset.execChainBatch);
    });
  });
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

function renderActiveContract() {
  if (!contractData) return;
  const list = Array.isArray(contractData.contracts) ? contractData.contracts : [];
  const chosen =
    list.find((c) => c.id === activeContractId) || {
      id: 'router',
      filename: 'contracts/SiphonRouter.sol',
      source: contractData.source || '',
    };
  const src = chosen.source || '';
  document.getElementById('contractCodeHost').textContent = src;
  const fileEl = document.getElementById('contractFileLabel');
  if (fileEl) fileEl.textContent = chosen.filename;
  const lines = src.split('\n').length;
  const feePct = ((contractData.protocolFeeBps ?? 700) / 100).toFixed(1);
  document.getElementById('contractStats').textContent =
    `Solidity ${contractData.solidityVersion} · ${lines} lines · ${feePct}% Fee (5–10%) · Domain ${contractData.solanaCctpDomain} → Solana`;
  document.querySelectorAll('.contract-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.contractId === activeContractId);
  });
}

async function loadContract() {
  try {
    contractData = await api('/api/contract');
    renderActiveContract();
  } catch (err) {
    document.getElementById('contractCodeHost').textContent = err.message;
  }
}

async function waitForEvmReceipt(chain, txHash, maxAttempts = 12) {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const st = await api('/api/tx/status', {
        method: 'POST',
        body: JSON.stringify({ chain, txHash }),
      });
      if (st.evmConfirmed || st.evmFailed) return st;
    } catch {
      // Keep polling
    }
  }
  return null;
}

async function pollBatchBridgeTrackers(entry, chain, trackers) {
  const landed = new Set();
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    for (const tr of trackers) {
      if (landed.has(tr.requestId)) continue;
      try {
        const st = await api('/api/tx/status', {
          method: 'POST',
          body: JSON.stringify({
            chain,
            txHash: entry.evmTxHash,
            requestId: tr.requestId,
            provider: tr.provider,
          }),
        });
        if (st.solanaTxHash && !entry.solanaTxHash) entry.solanaTxHash = st.solanaTxHash;
        if (st.bridgeStatus === 'success') landed.add(tr.requestId);
      } catch {
        // Keep polling
      }
    }
    if (landed.size > 0) {
      entry.status =
        landed.size === trackers.length
          ? `Landed on Solana (${landed.size}/${trackers.length})`
          : `Relaying (${landed.size}/${trackers.length} landed)`;
      entry.toneClass = landed.size === trackers.length ? 'tag-defi' : 'tag-sell';
      renderLiveExecutionLog();
    }
    if (landed.size === trackers.length) {
      refreshSolanaBalance();
      return;
    }
  }
}

let activeWalletModalTab = 'evm';
let walletModalError = null;
let walletModalConnecting = null;
let walletWcPromptOpen = false;

function closeWalletModal() {
  walletModalError = null;
  walletModalConnecting = null;
  walletWcPromptOpen = false;
  document.getElementById('walletModalBackdrop')?.classList.add('hidden');
}

async function handleEvmConnected({ address, walletName, capabilities }) {
  closeWalletModal();
  updateWalletButtons();
  const batchNote = capabilities?.anySupported
    ? '1-Click EIP-5792 Batch armed'
    : 'Sequential signing ready';
  showToast(`Connected ${walletName} (${shortAddr(address)}) · ${batchNote}`);
  await runScan({ address, autoOpen: true });
}

function getWalletBrandBadge(name, iconUrl, rdns = '') {
  const localLogo = getWalletLogoPath(name, rdns);
  const src = iconUrl || localLogo;
  const isDark = String(name || '').toLowerCase().includes('solflare');
  return `<span class="wallet-logo-tile${isDark ? ' is-dark' : ''}"><img src="${escapeHtml(src)}" alt="" class="wallet-logo-img" onerror="this.onerror=null;this.src='${escapeHtml(localLogo)}';" /></span>`;
}

function renderWalletModalContent() {
  const titleEl = document.getElementById('walletModalTitle');
  const subEl = document.getElementById('walletModalSub');
  const listEl = document.getElementById('walletModalList');
  const footEl = document.getElementById('walletModalFoot');
  const evmDot = document.getElementById('walletTabEvmDot');
  const solDot = document.getElementById('walletTabSolDot');
  if (!listEl) return;

  const evmAddr = getConnectedEvmAddress();
  const solAddr = getConnectedSolanaAddress();
  evmDot?.classList.toggle('hidden', !evmAddr);
  solDot?.classList.toggle('hidden', !solAddr);

  document.querySelectorAll('.wallet-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.walletTab === activeWalletModalTab);
  });

  const isEvm = activeWalletModalTab === 'evm';
  const activeAddr = isEvm ? evmAddr : solAddr;
  const activeName = isEvm ? getConnectedWalletName() : getConnectedSolanaWalletName();
  const cfg = getWalletConnectorConfig();
  const effectiveWcId = getEffectiveWalletConnectProjectId();

  titleEl.textContent = isEvm ? 'Connect EVM Wallet' : 'Connect Solana Wallet';
  subEl.textContent = isEvm
    ? 'Sign exits, swaps, burns, and bridges across six EVM chains.'
    : 'Receive native USDC or SOL on Solana.';

  const rows = [];

  if (walletModalError) {
    rows.push(`<div class="wallet-modal-error">${escapeHtml(walletModalError)}</div>`);
  }

  if (isEvm) {
    const detected = listAvailableEvmWallets();
    if (detected.length) {
      rows.push(`<div class="wallet-section-label">Installed in browser</div>`);
      for (const w of detected) {
        const isBusy = walletModalConnecting === `evm:${w.id}`;
        rows.push(`
          <button type="button" class="wallet-option-row" data-pick-evm="${escapeHtml(w.id)}" ${walletModalConnecting ? 'disabled' : ''}>
            <div class="wallet-option-left">
              ${getWalletBrandBadge(w.name, w.icon, w.rdns)}
              <div>
                <div class="wallet-option-name">${escapeHtml(w.name)}</div>
                <div class="wallet-option-meta mono">Detected · ${escapeHtml(w.standard)}</div>
              </div>
            </div>
            <span class="mono wallet-option-action">${isBusy ? 'Connecting…' : activeName === w.name && activeAddr ? 'Connected' : 'Connect →'}</span>
          </button>
        `);
      }
    }

    rows.push(`<div class="wallet-section-label">Universal &amp; Mobile</div>`);
    if (cfg.coinbaseSmartWalletEnabled) {
      const isBusy = walletModalConnecting === 'coinbase';
      rows.push(`
        <button type="button" class="wallet-option-row" data-pick-coinbase="true" ${walletModalConnecting ? 'disabled' : ''}>
          <div class="wallet-option-left">
            ${getWalletBrandBadge('Coinbase Smart Wallet', null)}
            <div>
              <div class="wallet-option-name">Coinbase Smart Wallet</div>
              <div class="wallet-option-meta mono">Passkey / Popup · Native EIP-5792</div>
            </div>
          </div>
          <span class="mono wallet-option-action">${isBusy ? 'Opening…' : activeName === 'Coinbase Wallet' && activeAddr ? 'Connected' : 'Connect →'}</span>
        </button>
      `);
    }

    const wcBusy = walletModalConnecting === 'wc';
    rows.push(`
      <button type="button" class="wallet-option-row" data-pick-wc="true" ${walletModalConnecting ? 'disabled' : ''}>
        <div class="wallet-option-left">
          ${getWalletBrandBadge('WalletConnect', null)}
          <div>
            <div class="wallet-option-name">WalletConnect (Mobile QR)</div>
            <div class="wallet-option-meta mono">${
              effectiveWcId
                ? 'MetaMask · Rabby · Rainbow · Ledger'
                : 'Scan QR · Paste free Reown Project ID'
            }</div>
          </div>
        </div>
        <span class="mono wallet-option-action">${wcBusy ? 'Opening QR…' : effectiveWcId ? 'QR →' : 'Set ID →'}</span>
      </button>
    `);

    if (walletWcPromptOpen) {
      rows.push(`
        <form class="wallet-wc-inline-form" id="modalWcProjectForm">
          <div class="muted-xs" style="margin-bottom:6px;">
            Get a free Project ID at <a href="https://cloud.reown.com" target="_blank" rel="noreferrer" class="explorer-link">cloud.reown.com ↗</a> (saved locally in your browser).
          </div>
          <div class="wallet-manual-form">
            <input type="text" id="modalWcProjectIdInput" class="field-input mono" value="${escapeHtml(effectiveWcId || '')}" placeholder="Paste 32-char Reown Project ID" aria-label="WalletConnect Project ID" />
            <button type="submit" class="btn-pill-dark btn-sm">Launch QR</button>
          </div>
        </form>
      `);
    }

    if (!detected.length) {
      rows.push(`
        <div class="wallet-section-label">Browser extensions</div>
        <div class="wallet-install-strip">
          <a class="wallet-install-chip" href="https://rabby.io" target="_blank" rel="noreferrer"><img src="/logos/rabby.svg" alt="" class="chain-logo-xs" />Rabby ↗</a>
          <a class="wallet-install-chip" href="https://metamask.io" target="_blank" rel="noreferrer"><img src="/logos/metamask.svg" alt="" class="chain-logo-xs" />MetaMask ↗</a>
          <a class="wallet-install-chip" href="https://phantom.app" target="_blank" rel="noreferrer"><img src="/logos/phantom.svg" alt="" class="chain-logo-xs" />Phantom ↗</a>
        </div>
      `);
    }
  } else {
    const solWallets = listAvailableSolanaWallets();
    if (solWallets.length) {
      rows.push(`<div class="wallet-section-label">Installed in browser</div>`);
      for (const w of solWallets) {
        const isBusy = walletModalConnecting === `sol:${w.id}`;
        rows.push(`
          <button type="button" class="wallet-option-row" data-pick-sol="${escapeHtml(w.id)}" ${walletModalConnecting ? 'disabled' : ''}>
            <div class="wallet-option-left">
              ${getWalletBrandBadge(w.name, w.icon)}
              <div>
                <div class="wallet-option-name">${escapeHtml(w.name)}</div>
                <div class="wallet-option-meta mono">Detected · ${escapeHtml(w.standard)}</div>
              </div>
            </div>
            <span class="mono wallet-option-action">${isBusy ? 'Connecting…' : activeName === w.name && activeAddr ? 'Connected' : 'Connect →'}</span>
          </button>
        `);
      }
    } else {
      rows.push(`
        <div class="wallet-section-label">Browser extensions</div>
        <div class="wallet-install-strip">
          <a class="wallet-install-chip" href="https://phantom.app" target="_blank" rel="noreferrer"><img src="/logos/phantom.svg" alt="" class="chain-logo-xs" />Phantom ↗</a>
          <a class="wallet-install-chip" href="https://backpack.app" target="_blank" rel="noreferrer"><img src="/logos/backpack.svg" alt="" class="chain-logo-xs" />Backpack ↗</a>
          <a class="wallet-install-chip" href="https://solflare.com" target="_blank" rel="noreferrer"><img src="/logos/solflare.svg" alt="" class="chain-logo-xs" />Solflare ↗</a>
        </div>
      `);
    }

    const currentDest = document.getElementById('solanaDestInput')?.value.trim() || '';
    rows.push(`
      <div class="wallet-section-label">Or paste Solana destination</div>
      <form class="wallet-manual-form" id="modalSolanaManualForm">
        <input type="text" id="modalSolanaInput" class="field-input mono" value="${escapeHtml(currentDest)}" placeholder="Paste any Solana address" aria-label="Solana destination address" />
        <button type="submit" class="btn-outline-dark">Use</button>
      </form>
    `);
  }

  if (activeAddr) {
    rows.push(`
      <button type="button" class="wallet-disconnect-btn" id="walletModalDisconnectBtn">
        Disconnect ${escapeHtml(activeName || (isEvm ? 'EVM' : 'Solana'))} (${escapeHtml(shortAddr(activeAddr))})
      </button>
    `);
  }

  listEl.innerHTML = rows.join('');
  footEl.textContent = isEvm
    ? 'Supports EIP-6963 extensions, Coinbase Smart Wallet, WalletConnect v2, and EIP-5792 batch signing.'
    : 'Supports Solana Wallet Standard or direct destination address paste.';

  const evmCallbacks = {
    onAccountsChanged: (next) => {
      updateWalletButtons();
      if (next) runScan({ address: next, autoOpen: true });
    },
    onChainChanged: () => updateWalletButtons(),
  };

  listEl.querySelectorAll('[data-pick-evm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const walletId = btn.dataset.pickEvm;
      walletModalError = null;
      walletModalConnecting = `evm:${walletId}`;
      renderWalletModalContent();
      try {
        const res = await connectEvmWallet({ walletId, ...evmCallbacks });
        await handleEvmConnected(res);
      } catch (err) {
        walletModalConnecting = null;
        walletModalError = err?.message || 'Wallet connection cancelled.';
        renderWalletModalContent();
        showToast(walletModalError);
      }
    });
  });

  listEl.querySelector('[data-pick-coinbase]')?.addEventListener('click', async () => {
    // Call connectCoinbaseSmartWallet BEFORE re-rendering DOM so browser popup blockers keep the user click gesture!
    const connectPromise = connectCoinbaseSmartWallet(evmCallbacks);
    walletModalError = null;
    walletModalConnecting = 'coinbase';
    renderWalletModalContent();
    try {
      const res = await connectPromise;
      await handleEvmConnected(res);
    } catch (err) {
      walletModalConnecting = null;
      walletModalError = err?.message || 'Coinbase Smart Wallet connection cancelled.';
      renderWalletModalContent();
      showToast(walletModalError);
    }
  });

  listEl.querySelector('[data-pick-wc]')?.addEventListener('click', async () => {
    if (!getEffectiveWalletConnectProjectId()) {
      walletModalError = null;
      walletWcPromptOpen = !walletWcPromptOpen;
      renderWalletModalContent();
      document.getElementById('modalWcProjectIdInput')?.focus();
      return;
    }
    walletModalError = null;
    walletModalConnecting = 'wc';
    renderWalletModalContent();
    try {
      const res = await connectWalletConnect(evmCallbacks);
      await handleEvmConnected(res);
    } catch (err) {
      walletModalConnecting = null;
      walletModalError = err?.message || 'WalletConnect session cancelled.';
      renderWalletModalContent();
      showToast(walletModalError);
    }
  });

  document.getElementById('modalWcProjectForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const projectId = document.getElementById('modalWcProjectIdInput')?.value.trim();
    if (!projectId) {
      walletModalError = 'Paste a valid Reown / WalletConnect Project ID from cloud.reown.com.';
      renderWalletModalContent();
      return;
    }
    setSavedWalletConnectProjectId(projectId);
    walletModalError = null;
    walletWcPromptOpen = false;
    walletModalConnecting = 'wc';
    renderWalletModalContent();
    try {
      const res = await connectWalletConnect({ ...evmCallbacks, projectId });
      await handleEvmConnected(res);
    } catch (err) {
      walletModalConnecting = null;
      walletModalError = err?.message || 'WalletConnect failed — verify your Project ID.';
      walletWcPromptOpen = true;
      renderWalletModalContent();
      showToast(walletModalError);
    }
  });

  listEl.querySelectorAll('[data-pick-sol]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const walletId = btn.dataset.pickSol;
      walletModalError = null;
      walletModalConnecting = `sol:${walletId}`;
      renderWalletModalContent();
      try {
        const { address, walletName } = await connectSolanaWallet({
          walletId,
          onAccountChanged: (nextAddr) => {
            if (nextAddr) document.getElementById('solanaDestInput').value = nextAddr;
            updateWalletButtons();
            recomputePlan();
            refreshSolanaBalance();
          },
        });
        document.getElementById('solanaDestInput').value = address;
        closeWalletModal();
        updateWalletButtons();
        showToast(`Connected ${walletName}: ${shortAddr(address)}`);
        await Promise.all([recomputePlan(), refreshSolanaBalance()]);
      } catch (err) {
        walletModalConnecting = null;
        walletModalError = err?.message || 'Solana wallet connection cancelled.';
        renderWalletModalContent();
        showToast(walletModalError);
      }
    });
  });

  document.getElementById('modalSolanaManualForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const addr = document.getElementById('modalSolanaInput')?.value.trim();
    if (!addr) return;
    document.getElementById('solanaDestInput').value = addr;
    closeWalletModal();
    showToast(`Destination set to ${shortAddr(addr)}`);
    await Promise.all([recomputePlan(), refreshSolanaBalance()]);
  });

  document.getElementById('walletModalDisconnectBtn')?.addEventListener('click', () => {
    if (isEvm) disconnectEvmWallet();
    else disconnectSolanaWallet();
    updateWalletButtons();
    renderWalletModalContent();
    showToast(isEvm ? 'Disconnected EVM wallet.' : 'Disconnected Solana wallet.');
  });
}

function openWalletModal(kind = 'evm') {
  refreshInstalledWallets();
  preloadWalletSdks();
  walletModalError = null;
  walletModalConnecting = null;
  walletWcPromptOpen = false;
  activeWalletModalTab = kind;
  renderWalletModalContent();
  document.getElementById('walletModalBackdrop')?.classList.remove('hidden');
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

  document.getElementById('walletModalCloseBtn')?.addEventListener('click', closeWalletModal);
  document.getElementById('walletModalBackdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeWalletModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeWalletModal();
  });
  document.querySelectorAll('.wallet-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeWalletModalTab = tab.dataset.walletTab;
      renderWalletModalContent();
    });
  });

  document.getElementById('siteConnectBtn')?.addEventListener('click', () => openWalletModal('evm'));
  document.getElementById('heroConnectBtn')?.addEventListener('click', () => openWalletModal('evm'));
  document.getElementById('connectEvmBtn').addEventListener('click', () => openWalletModal('evm'));
  document.getElementById('connectSolBtn').addEventListener('click', () => openWalletModal('solana'));

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
  document.getElementById('bridgePrefSelect')?.addEventListener('change', recomputePlan);
  document.getElementById('protocolFeeSelect')?.addEventListener('change', recomputePlan);
  document.getElementById('feeRecipientInput')?.addEventListener('change', (e) => {
    const val = e.target.value.trim();
    try {
      if (val && /^0x[0-9a-fA-F]{40}$/.test(val)) {
        window.localStorage?.setItem(FEE_RECIPIENT_STORAGE_KEY, val);
      } else if (!val) {
        window.localStorage?.removeItem(FEE_RECIPIENT_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
    recomputePlan();
  });

  document.querySelectorAll('.contract-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeContractId = btn.dataset.contractId || 'router';
      renderActiveContract();
    });
  });

  subscribeWalletDiscovery(() => {
    const modal = document.getElementById('walletModalBackdrop');
    if (modal && !modal.classList.contains('hidden')) {
      renderWalletModalContent();
    }
  });

  document.querySelectorAll('.seg-opt[data-out-asset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      outputAsset = btn.dataset.outAsset;
      document
        .querySelectorAll('.seg-opt[data-out-asset]')
        .forEach((b) => b.classList.toggle('active', b === btn));
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
    const list = Array.isArray(contractData?.contracts) ? contractData.contracts : [];
    const chosen = list.find((c) => c.id === activeContractId);
    const src = chosen?.source || contractData?.source || '';
    const title = chosen?.title || 'SiphonRouter.sol';
    await navigator.clipboard?.writeText(src).catch(() => {});
    showToast(`Copied ${title}.`);
  });
}

wireEvents();
loadWalletConnectorConfig().then((cfg) => {
  const feeSel = document.getElementById('protocolFeeSelect');
  const feeInput = document.getElementById('feeRecipientInput');
  if (feeSel && cfg?.protocolFee?.feeBps) {
    const bps = String(cfg.protocolFee.feeBps);
    if (feeSel.querySelector(`option[value="${bps}"]`)) feeSel.value = bps;
  }
  if (feeInput) {
    let saved = null;
    try {
      saved = window.localStorage?.getItem(FEE_RECIPIENT_STORAGE_KEY);
    } catch {
      saved = null;
    }
    const initial = cfg?.protocolFee?.feeRecipientEvm || saved || '';
    if (initial && !feeInput.value) feeInput.value = initial;
  }
  // Eagerly warm wallet SDKs on idle so Coinbase Smart Wallet popup fires synchronously on click
  setTimeout(() => preloadWalletSdks(), 600);
});
heroScene = mountSiphonFunnelScene(document.getElementById('siphonHeroCanvas'));
// Default load: REAL live mainnet scan of vitalik.eth
runScan({ presetId: 'vitalik_live', autoOpen: false });
