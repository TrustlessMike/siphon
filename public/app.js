import { mountSiphonFunnelScene } from './siphon-3d.js?v=3';
import { renderConvergenceSvg } from './siphon-svg.js?v=3';
import {
  connectCoinbaseSmartWallet,
  connectEvmWallet,
  connectFamilyWallet,
  connectSolanaWallet,
  connectWalletConnect,
  disconnectEvmWallet,
  disconnectFamilyWallet,
  disconnectSolanaWallet,
  getConnectedEvmAddress,
  getConnectedFamilyWallet,
  getConnectedSolanaAddress,
  getConnectedSolanaWalletName,
  getConnectedWalletName,
  getEffectiveWalletConnectProjectId,
  getWalletBatchCapabilities,
  getWalletConnectorConfig,
  isChainBatchSupported,
  listAvailableEvmWallets,
  listAvailableFamilyWallets,
  listAvailableSolanaWallets,
  loadWalletConnectorConfig,
  preloadWalletSdks,
  refreshInstalledWallets,
  sendEip5792Batch,
  sendRealEvmTransaction,
  setSavedWalletConnectProjectId,
  signFamilyGaslessIntent,
  signGaslessTypedData,
  subscribeWalletDiscovery,
  waitForEip5792Batch,
} from './wallets.js?v=3';

let currentScan = null;
let currentPlan = null;
let selectedAssetIds = new Set();
let activeFamily = 'evm';
let familyMetas = {};
let activeFilter = 'all';
let activeChainFilter = 'all';
let activeView = 'scanner';
let executionMode = 'direct'; // 'direct' | 'gasless'
let outputAsset = 'USDC';
let heroScene = null;
let contractData = null;
let activeContractId = 'router';
let solanaBalances = null;
let latestPreSignProof = null;
let backgroundJobs = [];
let activeJobId = null;
let bgPollTimer = null;

const FEE_RECIPIENT_STORAGE_KEY = 'siphon_fee_recipient_evm';

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

function fmtUsd(val) {
  const n = Number(val || 0);
  if (n >= 10000) return `$${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `$${(n / 1000).toFixed(2)}k`;
  return `$${n.toFixed(2)}`;
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
  }, 3200);
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
  if (s.includes('keplr')) return '/logos/keplr.svg';
  if (s.includes('leap')) return '/logos/leap.svg';
  if (s.includes('slush') || s.includes('sui')) return '/logos/slush.svg';
  if (s.includes('petra')) return '/logos/petra.svg';
  if (s.includes('tonkeeper') || s.includes('openmask')) return '/logos/tonkeeper.svg';
  if (s.includes('tronlink')) return '/logos/tronlink.svg';
  if (s.includes('unisat')) return '/logos/unisat.svg';
  if (s.includes('xverse')) return '/logos/xverse.svg';
  return '/logos/ethereum.svg';
}

function getFamilyLogoPath(family) {
  const f = String(family || 'evm').toLowerCase();
  if (f === 'evm') return '/logos/ethereum.svg';
  if (['cosmos', 'sui', 'aptos', 'ton', 'tron', 'btc'].includes(f)) return `/logos/${f}.svg`;
  return '/logos/ethereum.svg';
}

function getChainLogoPath(chain) {
  const c = String(chain || '').toLowerCase();
  if (['cosmoshub', 'noble', 'celestia', 'injective', 'neutron'].includes(c)) {
    return '/logos/cosmos.svg';
  }
  if (
    [
      'ethereum',
      'base',
      'arbitrum',
      'optimism',
      'polygon',
      'avalanche',
      'bnb',
      'sonic',
      'unichain',
      'linea',
      'scroll',
      'mantle',
      'blast',
      'worldchain',
      'osmosis',
      'sui',
      'aptos',
      'ton',
      'tron',
      'btc',
      'solana',
    ].includes(c)
  ) {
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
  if (pref === 'cctp') return `<img src="/logos/circle.svg" alt="" class="chain-logo-xs" />`;
  if (pref === 'lifi') return `<img src="/logos/lifi.svg" alt="" class="chain-logo-xs" />`;
  if (pref === 'relay') return `<img src="/logos/relay.svg" alt="" class="chain-logo-xs" />`;
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

function showWebsite() {
  document.getElementById('siteShell').classList.remove('hidden');
  document.getElementById('appShell').classList.add('hidden');
  window.scrollTo({ top: 0, behavior: 'instant' });
  window.dispatchEvent(new Event('resize'));
  renderBackgroundAgentUI();
}

function openApp(viewName = 'scanner') {
  const mapped = viewName === 'burns' || viewName === 'pipeline' ? 'activity' : viewName;
  document.getElementById('siteShell').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  switchView(mapped);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function switchView(viewName) {
  activeView = viewName;
  document.querySelectorAll('.app-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.view-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.id === `view-${viewName}`);
  });
  if (viewName === 'contract' && !contractData) loadContract();
  renderBackgroundAgentUI();
}

window.showWebsite = showWebsite;
window.openApp = openApp;
window.switchView = switchView;

async function refreshSolanaBalance() {
  const solDest = document.getElementById('solanaDestInput')?.value.trim();
  const badge = document.getElementById('solanaLiveBalanceBadge');
  const summaryEl = document.getElementById('destAddrSummary');
  if (summaryEl && solDest) {
    const solWalletName = getConnectedSolanaWalletName();
    summaryEl.textContent = solWalletName
      ? `${solWalletName} · ${shortAddr(solDest)}`
      : shortAddr(solDest);
  }
  if (!solDest) return;
  try {
    solanaBalances = await api(`/api/solana/balance?address=${encodeURIComponent(solDest)}`);
    if (badge) {
      badge.textContent = `${solanaBalances.usdcBalance.toFixed(2)} USDC · ${solanaBalances.solBalance.toFixed(3)} SOL on Solana`;
    }
  } catch (err) {
    const isInvalid = String(err?.message || '').toLowerCase().includes('invalid');
    if (badge) {
      badge.textContent = isInvalid
        ? 'Invalid Solana address'
        : 'Valid Solana destination (RPC busy)';
    }
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

function getActiveSourceWallet() {
  return getConnectedFamilyWallet(activeFamily);
}

function updateFamilyChrome() {
  const meta = familyMetas[activeFamily];
  document.querySelectorAll('.family-pill[data-family]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.family === activeFamily);
  });
  const appIn = document.getElementById('appEvmInput');
  if (appIn && meta?.addressHint) {
    appIn.placeholder = `Scan ${meta.addressHint}`;
  }
  const presetsBar = document.getElementById('sourcePresetsBar');
  if (presetsBar) {
    if (activeFamily === 'evm') {
      presetsBar.innerHTML = `
        <button type="button" class="text-action" data-preset="vitalik_live">vitalik.eth</button>
        <span class="sep-dot">·</span>
        <button type="button" class="text-action muted" data-preset="veteran_defi">Sample DeFi</button>
      `;
      presetsBar.querySelectorAll('[data-preset]').forEach((btn) => {
        btn.addEventListener('click', () => runScan({ presetId: btn.dataset.preset, autoOpen: false }));
      });
    } else if (meta?.sampleAddress) {
      presetsBar.innerHTML = `
        <button type="button" class="text-action" id="familySampleBtn">${escapeHtml(meta.sampleLabel || `Sample ${meta.shortLabel}`)}</button>
      `;
      document.getElementById('familySampleBtn')?.addEventListener('click', () => {
        runScan({ address: meta.sampleAddress, family: activeFamily, autoOpen: false });
      });
    }
  }
  const proofBtn = document.getElementById('verifyProofBtn');
  if (proofBtn) {
    proofBtn.textContent =
      activeFamily === 'evm'
        ? 'Prove Swap & Gas Before Signing (Live eth_call)'
        : `Prove ${meta?.shortLabel || activeFamily.toUpperCase()} Sweep Before Signing`;
  }
  updateWalletButtons();
}

function selectFamily(family, { autoScanSample = true } = {}) {
  activeFamily = family || 'evm';
  if (activeFamily !== 'evm') {
    executionMode = 'gasless';
    document.querySelectorAll('.mode-opt[data-exec-mode]').forEach((b) => {
      b.classList.toggle('active', b.dataset.execMode === executionMode);
    });
  }
  updateFamilyChrome();
  const meta = familyMetas[activeFamily];
  const connected = getConnectedFamilyWallet(activeFamily);
  if (autoScanSample) {
    if (connected?.address) {
      runScan({ address: connected.address, family: activeFamily, autoOpen: false });
    } else if (activeFamily === 'evm') {
      if (currentScan?.family && currentScan.family !== 'evm') {
        runScan({ presetId: 'vitalik_live', autoOpen: false });
      }
    } else if (meta?.sampleAddress) {
      runScan({ address: meta.sampleAddress, family: activeFamily, autoOpen: false });
    }
  }
}

function updateWalletButtons() {
  const srcSession = getActiveSourceWallet();
  const srcAddr = srcSession?.address || null;
  const walletName = srcSession?.walletName || null;
  const solAddr = getConnectedSolanaAddress();
  const caps = getWalletBatchCapabilities();
  const stats = estimateChainCallCounts();
  const meta = familyMetas[activeFamily];
  const famShort = meta?.shortLabel || (activeFamily === 'evm' ? 'EVM' : activeFamily.toUpperCase());

  const evmBtn = document.getElementById('connectEvmBtn');
  const solBtn = document.getElementById('connectSolBtn');
  const siteBtn = document.getElementById('siteConnectBtn');
  const heroBtn = document.getElementById('heroConnectBtn');
  const ctaBtn = document.getElementById('runLiveQueueBtn');
  const ctaNote = document.getElementById('sweepCtaNote');

  if (evmBtn) {
    const shortName = walletName ? walletName.split(' ')[0] : famShort;
    const logo = srcAddr ? getWalletLogoPath(walletName) : getFamilyLogoPath(activeFamily);
    evmBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo" /><span>${escapeHtml(srcAddr ? `${shortName}: ${shortAddr(srcAddr)}` : `Connect ${famShort}`)}</span>`;
    evmBtn.classList.toggle('connected', Boolean(srcAddr));
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
    if (srcAddr) {
      const logo = getWalletLogoPath(walletName);
      siteBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo" /><span>${escapeHtml(`${shortName ? `${shortName} · ` : ''}${shortAddr(srcAddr)}`)}</span>`;
    } else if (solAddr) {
      const logo = getWalletLogoPath(getConnectedSolanaWalletName() || 'Phantom');
      siteBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo" /><span>${escapeHtml(`SOL · ${shortAddr(solAddr)}`)}</span>`;
    } else {
      siteBtn.textContent = 'Connect Wallet';
    }
    siteBtn.classList.toggle('connected', Boolean(srcAddr || solAddr));
    siteBtn.classList.toggle('btn-with-logo', Boolean(srcAddr || solAddr));
  }
  if (heroBtn) {
    heroBtn.textContent = srcAddr
      ? `${walletName || 'Wallet'} · ${shortAddr(srcAddr)}`
      : 'Connect Wallet';
  }

  if (ctaBtn) {
    const n = stats.totalChains;
    if (n === 0) {
      ctaBtn.textContent = 'Select assets to sweep';
      ctaBtn.disabled = true;
    } else if (!srcAddr) {
      ctaBtn.textContent = `Connect ${famShort} Wallet to Sweep (${n} ${n === 1 ? 'Chain' : 'Chains'})`;
      ctaBtn.disabled = false;
    } else if (executionMode === 'gasless' || activeFamily !== 'evm') {
      ctaBtn.textContent = `Gasless 1-Sig Sweep (${n} ${n === 1 ? 'Chain' : 'Chains'}) →`;
      ctaBtn.disabled = false;
    } else {
      ctaBtn.textContent = `Sweep ${n} ${n === 1 ? 'Chain' : 'Chains'} to Solana →`;
      ctaBtn.disabled = false;
    }
  }
  if (ctaNote) {
    if (activeFamily !== 'evm' && meta?.gasSponsorshipMechanism) {
      ctaNote.textContent = meta.gasSponsorshipMechanism;
    } else if (executionMode === 'gasless') {
      ctaNote.textContent = `$0 native gas required · 1 off-chain Permit2 / EIP-7702 signature · gas paid from fee`;
    } else if (srcAddr && caps.probed && caps.anySupported) {
      ctaNote.textContent = `EIP-5792 armed · 1 click per chain (${stats.popupsSaved} popups saved) · settles in background`;
    } else if (srcAddr && caps.probed && !caps.anySupported) {
      ctaNote.textContent = `EOA detected · switch to Gasless 1-Sig for 1 signature & $0 gas, or sign sequentially`;
    } else {
      ctaNote.textContent = `1 confirmation per chain · settles automatically in the background`;
    }
  }
}

let scanSeq = 0;

async function runScan({ address = null, family = null, presetId = null, autoOpen = false } = {}) {
  const seq = ++scanSeq;
  heroScene?.setActive(true);
  const scanBtn = document.getElementById('appScanBtn');
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
  }
  try {
    const payload = presetId
      ? { presetId }
      : address
      ? { address, family: family || activeFamily }
      : { presetId: 'vitalik_live' };
    const scan = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (seq !== scanSeq) return;
    currentScan = scan;
    if (scan.family && scan.family !== activeFamily) {
      activeFamily = scan.family;
      if (activeFamily !== 'evm') executionMode = 'gasless';
    }
    updateFamilyChrome();
    activeChainFilter = 'all';
    renderPreSignProofCard(null);

    selectedAssetIds = new Set(
      currentScan.assets.filter((a) => a.selectedByDefault).map((a) => a.id)
    );

    const appIn = document.getElementById('appEvmInput');
    if (appIn) appIn.value = currentScan.walletAddress;
    if (address) {
      const heroIn = document.getElementById('heroWalletInput');
      if (heroIn) heroIn.value = currentScan.walletAddress;
    }

    const badge = document.getElementById('scanModeBadge');
    if (badge) {
      badge.textContent =
        currentScan.mode === 'live_rpc'
          ? `Live · ${currentScan.scanDurationMs}ms`
          : currentScan.walletLabel || 'Sample';
      badge.classList.toggle('is-live', currentScan.mode === 'live_rpc');
    }

    await Promise.all([recomputePlan(), refreshSolanaBalance()]);
    if (autoOpen) openApp('scanner');
  } catch (err) {
    if (seq === scanSeq) showToast(err.message);
  } finally {
    if (seq !== scanSeq) return;
    heroScene?.setActive(false);
    if (scanBtn) {
      scanBtn.disabled = false;
      scanBtn.textContent = 'Scan';
    }
  }
}

function getActiveBridgePreference() {
  const select = document.getElementById('bridgePrefSelect');
  const cctpOpt = select?.querySelector('option[value="cctp"]');
  if (cctpOpt) {
    cctpOpt.disabled = outputAsset === 'SOL';
    cctpOpt.textContent = outputAsset === 'SOL' ? 'Circle CCTP (USDC only)' : 'Circle CCTP 1:1';
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
        hasSolanaUsdcAta: solanaBalances ? Boolean(solanaBalances.hasUsdcAta) : undefined,
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
  const feePct = currentPlan.protocolFeePercent ?? getActiveProtocolFeeBps() / 100;
  const stats = estimateChainCallCounts();

  // Topbar counters
  const tabLegEl = document.getElementById('tabLegCount');
  if (tabLegEl) tabLegEl.textContent = String(currentPlan.legs.length);
  const tabBurnEl = document.getElementById('tabBurnCount');
  const activeJobsCount = backgroundJobs.filter((j) => j.status === 'active').length;
  if (tabBurnEl) {
    tabBurnEl.textContent = String(activeJobsCount || currentPlan.burnManifest.length);
  }

  // Quiet source strip summary
  const sourceSummaryEl = document.getElementById('sourceSummaryText');
  if (sourceSummaryEl) {
    const blockedNote =
      t.honeypotsSkippedCount > 0 ? ` · ${t.honeypotsSkippedCount} honeypot blocked` : '';
    sourceSummaryEl.textContent = `$${currentScan.totals.grossUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })} across ${currentScan.chains.filter((c) => c.assetCount > 0).length} chains${blockedNote}`;
  }

  // Right Sticky Sweep Card: Payout Hero
  const payoutLogo = document.getElementById('payoutAssetLogo');
  if (payoutLogo) payoutLogo.src = outputAsset === 'SOL' ? '/logos/solana.svg' : '/logos/usdc.svg';

  const netEl = document.getElementById('kpiNetUsdc');
  if (netEl) {
    netEl.textContent =
      outputAsset === 'SOL'
        ? `${t.netSolanaSol.toFixed(2)} SOL`
        : `$${t.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }
  const subEl = document.getElementById('kpiNetSub');
  if (subEl) {
    const eta = pref === 'cctp' ? `~${t.estimatedFastestSec || 20}s Circle CCTP` : '~2–15s auto-fill';
    subEl.textContent =
      outputAsset === 'SOL'
        ? `≈ $${t.netSolanaUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })} USDC · ${eta}`
        : `≈ ${t.netSolanaSol.toFixed(2)} SOL · ${eta}`;
  }

  // Receipt Summary Rows
  const selTextEl = document.getElementById('summarySelectedText');
  if (selTextEl) {
    const burnPart = t.tokensBurnedCount > 0 ? ` · ${t.tokensBurnedCount} burns` : '';
    selTextEl.textContent = `${t.tokensSoldCount + t.defiWithdrawnCount} assets${burnPart} (${currentPlan.legs.length} chains)`;
  }
  const routeLogosEl = document.getElementById('summaryRouteLogos');
  if (routeLogosEl) routeLogosEl.innerHTML = getBridgeProviderLogosHtml(pref);

  const gasEl = document.getElementById('summaryGasText');
  if (gasEl) {
    const savedPart = stats.popupsSaved > 0 ? ` · saves ${stats.popupsSaved} popups` : '';
    gasEl.textContent = `~$${t.totalGasUsd.toFixed(2)}${savedPart}`;
  }

  const feeEl = document.getElementById('summaryFeeText');
  if (feeEl) {
    feeEl.textContent = `${feePct}% · $${t.protocolFeeUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }

  // Activity view topology SVG
  const flowMeta = document.getElementById('flowSummaryMeta');
  if (flowMeta) {
    flowMeta.textContent = `${currentPlan.legs.length} active chain(s) · ${t.selectedAssets} selected · ~$${t.totalGasUsd.toFixed(2)} est. gas`;
  }
  const svgHost = document.getElementById('convergenceSvgHost');
  if (svgHost) svgHost.innerHTML = renderConvergenceSvg(currentPlan, currentScan);

  renderChainFilterBar();
  renderAssetList();
  renderChainQueueList();
  renderBurnView();
  renderBackgroundAgentUI();
}

function renderChainFilterBar() {
  const host = document.getElementById('chainFilterBar');
  if (!host || !currentScan) return;

  const chips = [
    `<button type="button" class="chain-chip ${activeChainFilter === 'all' ? 'active' : ''}" data-chain-filter="all">
      <span>All Chains</span>
      <span class="chain-chip-val">${escapeHtml(fmtUsd(currentPlan.totals.netSolanaUsdc))}</span>
    </button>`,
  ];

  for (const c of currentScan.chains) {
    if (c.assetCount === 0) continue;
    const leg = currentPlan.legs.find((l) => l.chain === c.chain);
    const val = leg ? leg.bridgedUsdc : 0;
    chips.push(`
      <button type="button" class="chain-chip ${activeChainFilter === c.chain ? 'active' : ''}" data-chain-filter="${escapeHtml(c.chain)}">
        <img src="${escapeHtml(getChainLogoPath(c.chain))}" alt="" class="chain-logo-xs" />
        <span>${escapeHtml(c.chainName)}</span>
        <span class="chain-chip-val">${escapeHtml(fmtUsd(val))}</span>
      </button>
    `);
  }

  host.innerHTML = chips.join('');
  host.querySelectorAll('[data-chain-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeChainFilter = btn.dataset.chainFilter || 'all';
      renderChainFilterBar();
      renderAssetList();
    });
  });
}

function formatRoiTooltip(a) {
  const bd = a.roiCostBreakdown;
  if (!bd) return a.actionReason || '';
  const parts = [
    `Gas $${(bd.gasUsd || 0).toFixed(2)}`,
    bd.l1DataFeeUsd > 0 ? `L1 data $${bd.l1DataFeeUsd.toFixed(3)}` : null,
    `Slippage $${(bd.slippageUsd || 0).toFixed(2)}`,
    bd.bridgeFeeUsd > 0 ? `Bridge $${bd.bridgeFeeUsd.toFixed(2)}` : null,
    bd.solanaAtaRentUsd > 0 ? `Solana ATA rent $${bd.solanaAtaRentUsd.toFixed(2)}` : null,
    `Siphon fee $${(bd.protocolFeeUsd || 0).toFixed(2)}`,
  ].filter(Boolean);
  return `${parts.join(' + ')} = $${(bd.totalCostUsd || 0).toFixed(2)} total cost`;
}

function renderRoiVerdictBadge(a) {
  if (a.action === 'SKIP_HONEYPOT') return `<span class="action-tag tag-skip">Honeypot</span>`;
  if (a.action === 'BURN_ZERO_LIQUIDITY') return `<span class="action-tag tag-burn">Burn $0</span>`;
  const v = a.roiVerdict;
  const pct = typeof a.effectiveCostPct === 'number' ? a.effectiveCostPct.toFixed(0) : null;
  const net = typeof a.netRoiUsd === 'number' ? a.netRoiUsd : null;
  const tip = escapeHtml(formatRoiTooltip(a));
  if (v === 'worth_it') {
    return `<span class="roi-pill roi-worth" title="${tip}">Worth It</span>`;
  }
  if (v === 'low_efficiency') {
    return `<span class="roi-pill roi-low" title="${tip}">High Cost (${pct ?? '—'}% fees)</span>`;
  }
  if (v === 'negative_roi' || a.action === 'SKIP_GAS_NEGATIVE' || a.action === 'SKIP_NEGATIVE_ROI') {
    const signedStr =
      net !== null ? `${net < 0 ? '-' : ''}$${Math.abs(net).toFixed(2)}` : '-$0.00';
    return `<span class="roi-pill roi-neg" title="${tip}">Negative ROI (${signedStr})</span>`;
  }
  return compactActionTag(a.action);
}

function compactActionTag(action) {
  if (action === 'WITHDRAW_AND_BRIDGE') return `<span class="action-tag tag-defi">DeFi Exit</span>`;
  if (action === 'BRIDGE_DIRECT_USDC') return `<span class="action-tag tag-direct">USDC</span>`;
  if (action === 'SELL_AND_BRIDGE') return `<span class="action-tag tag-sell">Swap</span>`;
  if (action === 'BURN_ZERO_LIQUIDITY') return `<span class="action-tag tag-burn">Burn</span>`;
  if (action === 'SKIP_HONEYPOT') return `<span class="action-tag tag-skip">Honeypot</span>`;
  return `<span class="action-tag tag-skip">Dust</span>`;
}

function renderAssetList() {
  const host = document.getElementById('assetListBody');
  if (!host || !currentScan) return;

  const filtered = currentScan.assets.filter((a) => {
    if (activeChainFilter !== 'all' && a.chain !== activeChainFilter) return false;
    if (activeFilter === 'defi') return a.action === 'WITHDRAW_AND_BRIDGE';
    if (activeFilter === 'liquid')
      return (
        (a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC') &&
        a.roiVerdict !== 'low_efficiency'
      );
    if (activeFilter === 'low_efficiency') return a.roiVerdict === 'low_efficiency';
    if (activeFilter === 'burn') return a.action === 'BURN_ZERO_LIQUIDITY';
    if (activeFilter === 'skipped')
      return (
        a.action === 'SKIP_HONEYPOT' ||
        a.action === 'SKIP_GAS_NEGATIVE' ||
        a.action === 'SKIP_NEGATIVE_ROI' ||
        a.roiVerdict === 'negative_roi'
      );
    return true;
  });

  if (!filtered.length) {
    host.innerHTML = `<div style="text-align:center; padding:36px 16px; color:var(--ink-3); font-size:13px;">No assets in this filter.</div>`;
    return;
  }

  host.innerHTML = filtered
    .map((a) => {
      const checked = selectedAssetIds.has(a.id);
      const disabled = a.action === 'SKIP_HONEYPOT';
      const protoLogo = a.protocol ? getProtocolLogoPath(a.protocol) : null;
      const chainLogo = getChainLogoPath(a.chain);
      const mainLogo = protoLogo || (a.symbol === 'USDC' ? '/logos/usdc.svg' : chainLogo);
      const showSubLogo = Boolean(protoLogo || a.symbol === 'USDC');
      const usdStr =
        a.action === 'BURN_ZERO_LIQUIDITY'
          ? '$0.00'
          : a.action === 'SKIP_HONEYPOT'
          ? 'Blocked'
          : `$${a.grossUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      const balStr = `${a.uiBalance.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${a.symbol}`;
      const debtBadge =
        a.aaveDebtUsd > 0
          ? `<span class="micro-pill" style="background:var(--block-bg);border-color:#fecaca;color:#991b1b;">Debt Guard</span>`
          : '';

      const rowTip = escapeHtml(formatRoiTooltip(a));
      return `
        <div class="asset-row ${checked ? 'is-checked' : ''} ${disabled ? 'is-blocked' : ''}" data-row-asset="${escapeHtml(a.id)}" title="${rowTip}">
          <input type="checkbox" class="asset-chk" data-asset-id="${escapeHtml(a.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="Select ${escapeHtml(a.symbol)} on ${escapeHtml(a.chainName)}" />
          <div class="asset-row-id">
            <span class="asset-logo-wrap">
              <img src="${escapeHtml(mainLogo)}" alt="" class="asset-logo-main" />
              ${showSubLogo ? `<img src="${escapeHtml(chainLogo)}" alt="" class="asset-logo-sub" />` : ''}
            </span>
            <div class="asset-row-name-col">
              <div class="asset-row-sym">
                <span>${escapeHtml(a.symbol)}</span>
                ${a.protocol ? `<span class="muted-xs" style="font-weight:400;">${escapeHtml(a.protocol)}</span>` : ''}
                ${debtBadge}
              </div>
              <div class="asset-row-meta">${escapeHtml(a.name)} · ${escapeHtml(a.chainName)}</div>
            </div>
          </div>
          <div class="asset-row-val-col">
            <div class="asset-row-usd">${escapeHtml(usdStr)}</div>
            <div class="asset-row-bal">${escapeHtml(balStr)}</div>
          </div>
          <div class="asset-row-tag">${renderRoiVerdictBadge(a)}</div>
        </div>
      `;
    })
    .join('');

  host.querySelectorAll('.asset-chk').forEach((chk) => {
    chk.addEventListener('click', (e) => e.stopPropagation());
    chk.addEventListener('change', () => {
      const id = chk.dataset.assetId;
      if (chk.checked) selectedAssetIds.add(id);
      else selectedAssetIds.delete(id);
      recomputePlan();
    });
  });

  host.querySelectorAll('[data-row-asset]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.rowAsset;
      const chk = row.querySelector('.asset-chk');
      if (!chk || chk.disabled) return;
      chk.checked = !chk.checked;
      if (chk.checked) selectedAssetIds.add(id);
      else selectedAssetIds.delete(id);
      recomputePlan();
    });
  });
}

function renderChainQueueList() {
  const host = document.getElementById('chainQueueList');
  if (!host || !currentPlan) return;
  if (!currentPlan.legs.length) {
    host.innerHTML = '';
    return;
  }

  host.innerHTML = currentPlan.legs
    .map((leg) => {
      const chainMeta = currentScan.chains.find((c) => c.chain === leg.chain);
      const noGasBadge = chainMeta?.needsGasSponsorship
        ? `<span class="gas-warn-pill" title="Low native gas on ${escapeHtml(leg.chainName)} — use Gasless 1-Sig sponsored mode">No Gas · Sponsor</span>`
        : '';
      const legRoiPill =
        leg.roiVerdict === 'negative_roi'
          ? `<span class="roi-pill roi-neg" title="${escapeHtml(leg.breakEvenHint || '')}">Neg ROI</span>`
          : leg.roiVerdict === 'low_efficiency'
          ? `<span class="roi-pill roi-low">${Number(leg.effectiveCostPct || 0).toFixed(0)}% fees</span>`
          : `<span class="roi-pill roi-worth">Worth It</span>`;
      const breakEvenHtml =
        leg.skippedNegativeRoi && leg.breakEvenHint
          ? `<div class="breakeven-banner mono">${escapeHtml(leg.breakEvenHint)}</div>`
          : '';
      return `
      <div>
        <div class="chain-queue-item">
          <span class="inline-logo-row">
            <img src="${escapeHtml(getChainLogoPath(leg.chain))}" alt="" class="chain-logo-xs" />
            <strong>${escapeHtml(leg.chainName)}</strong>
            <span class="mono muted-xs">${leg.defiExits + leg.swaps + leg.burns} items</span>
            ${legRoiPill}
            ${noGasBadge}
          </span>
          <span class="inline-logo-row">
            <span class="mono" style="font-weight:600;">$${leg.bridgedUsdc.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            <button type="button" class="chain-queue-run" data-exec-chain-batch="${escapeHtml(leg.chain)}">${executionMode === 'gasless' ? '1-Sig' : 'Run'}</button>
          </span>
        </div>
        ${breakEvenHtml}
      </div>
    `;
    })
    .join('');

  host.querySelectorAll('[data-exec-chain-batch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      executeChainBatchLive(btn.dataset.execChainBatch);
    });
  });
}

function renderPreSignProofCard(proof) {
  const card = document.getElementById('preSignProofCard');
  if (!card) return;
  if (!proof) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  card.classList.toggle('is-safe', Boolean(proof.allChecksSafe && proof.hasEnoughNativeGas));
  card.classList.toggle('is-warn', !proof.allChecksSafe || !proof.hasEnoughNativeGas);

  const gasLabel = proof.hasEnoughNativeGas
    ? `✓ ${proof.nativeBalanceUi} ${proof.nativeSymbol} (~$${proof.nativeBalanceUsd.toFixed(2)})`
    : `! Low gas (${proof.nativeBalanceUi} ${proof.nativeSymbol}) → Switch to Gasless 1-Sig`;
  const checkRows = (proof.checks || [])
    .slice(0, 6)
    .map((c) => {
      const mark =
        c.preflightStatus === 'verified'
          ? '✓'
          : c.preflightStatus === 'reverted'
          ? '✕'
          : '•';
      return `<div class="proof-check-row"><span>${mark} ${escapeHtml(c.assetSymbol)}: ${escapeHtml(c.summary)}</span><span class="mono muted-xs">${escapeHtml(c.preflightStatus)}</span></div>`;
    })
    .join('');

  card.innerHTML = `
    <div class="proof-head">
      <span>${proof.allChecksSafe ? '✓ Real-Time Pre-Sign Proof' : '! Simulation Warning'} (${escapeHtml(proof.chainName)} #${proof.blockNumber ? proof.blockNumber.toLocaleString() : 'live'})</span>
      <span class="mono muted-xs">${escapeHtml(shortAddr(proof.proofDigestSha256))}</span>
    </div>
    <div class="proof-kv"><span>Wallet Proven</span><strong class="mono">${escapeHtml(shortAddr(proof.userAddress))}</strong></div>
    <div class="proof-kv"><span>Gas Check</span><span class="mono">${escapeHtml(gasLabel)}</span></div>
    <div class="proof-kv"><span>Solana Recipient bytes32</span><span class="mono">${proof.mintRecipientVerified ? '✓ Matched bit-for-bit' : '✕ Mismatch'}</span></div>
    <div class="proof-kv"><span>Guaranteed Min Output</span><strong class="mono">≥ $${proof.guaranteedMinNetUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${escapeHtml(proof.outputAsset)}</strong></div>
    <div class="proof-kv"><span>Protocol Fee (${proof.protocolFee.feePercent}%)</span><span class="mono">$${proof.protocolFee.estimatedFeeUsd.toFixed(2)} (${escapeHtml(proof.protocolFee.collectionMethod)})</span></div>
    ${
      proof.quotedCostBreakdown
        ? `<div class="proof-kv"><span>All-In Quoted Cost</span><span class="mono">${proof.quotedCostBreakdown.effectiveCostPct.toFixed(1)}% · gas $${proof.quotedCostBreakdown.estimatedGasUsd.toFixed(2)} + bridge/slip $${proof.quotedCostBreakdown.bridgeAndSlippageUsd.toFixed(2)}${proof.quotedCostBreakdown.solanaAtaRentUsd > 0 ? ` + ATA $${proof.quotedCostBreakdown.solanaAtaRentUsd.toFixed(2)}` : ''}</span></div>`
        : ''
    }
    ${
      proof.haircutDroppedAssets?.length
        ? `<div class="breakeven-banner mono">Haircut Gate dropped ${proof.haircutDroppedAssets.length} high-cost asset(s) (&gt;50% fee).</div>`
        : ''
    }
    ${proof.preSolanaSnapshot ? `<div class="proof-kv"><span>Pre-Sweep Solana Snapshot</span><span class="mono">${proof.preSolanaSnapshot.usdcBalance.toFixed(2)} USDC · slot #${proof.preSolanaSnapshot.slot.toLocaleString()}</span></div>` : ''}
    ${checkRows ? `<div class="proof-checks">${checkRows}</div>` : ''}
    <div style="display:flex; justify-content:flex-end; padding-top:4px;">
      <button type="button" class="text-action mono" id="downloadProofCertBtn">Download Proof Certificate (JSON) ↓</button>
    </div>
  `;
  document.getElementById('downloadProofCertBtn')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(proof, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `siphon-proof-${proof.chain}-${proof.proofId}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Downloaded cryptographic migration proof certificate.');
  });
}

async function runPreSignProof() {
  if (!currentScan || !currentPlan || !currentPlan.legs.length) {
    showToast('Select at least one asset to prove.');
    return;
  }
  const targetChain =
    activeChainFilter !== 'all' && currentPlan.legs.some((l) => l.chain === activeChainFilter)
      ? activeChainFilter
      : currentPlan.legs[0].chain;
  const chainAssets = currentScan.assets.filter(
    (a) => a.chain === targetChain && selectedAssetIds.has(a.id) && a.action !== 'SKIP_HONEYPOT'
  );
  if (!chainAssets.length) return;

  const btn = document.getElementById('verifyProofBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = `Simulating ${targetChain} on live RPC…`;
  }
  try {
    const solDest = document.getElementById('solanaDestInput').value.trim();
    const srcSession = getActiveSourceWallet();
    const userAddress = srcSession?.address || currentScan.walletAddress;
    const chainMeta = currentScan.chains.find((c) => c.chain === targetChain);

    const res = await api('/api/tx/simulate-proof', {
      method: 'POST',
      body: JSON.stringify({
        chain: targetChain,
        assets: chainAssets,
        userAddress,
        solanaDestination: solDest,
        outputAsset,
        bridgePreference: getActiveBridgePreference(),
        protocolFeeBps: getActiveProtocolFeeBps(),
        feeRecipientEvm: getActiveFeeRecipientEvm(),
        nativePriceUsd: chainMeta?.nativePriceUsd,
      }),
    });
    latestPreSignProof = res.proof;
    renderPreSignProofCard(res.proof);
    if (!res.proof.hasEnoughNativeGas && executionMode !== 'gasless') {
      setExecutionMode('gasless');
      showToast(`Low gas on ${res.proof.chainName} — switched to $0 Gasless 1-Sig Mode.`);
    } else {
      showToast(`Pre-sign proof verified on ${res.proof.chainName} (${shortAddr(res.proof.proofDigestSha256)}).`);
    }
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Prove Swap & Gas Before Signing (Live eth_call)';
    }
  }
}

function setExecutionMode(mode) {
  executionMode = mode === 'gasless' ? 'gasless' : 'direct';
  document.querySelectorAll('.mode-opt[data-exec-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.execMode === executionMode);
  });
  updateWalletButtons();
  renderChainQueueList();
}

function legStatusBadge(status) {
  if (status === 'landed' || status === 'attested') return { cls: 'tag-defi', icon: '✓' };
  if (status === 'failed') return { cls: 'tag-burn', icon: '!' };
  if (status === 'relaying' || status === 'confirming' || status === 'signing' || status === 'preparing') {
    return { cls: 'tag-sell', icon: '◉' };
  }
  return { cls: 'tag-skip', icon: '○' };
}

function renderBackgroundAgentUI() {
  const card = document.getElementById('agentStatusCard');
  const feed = document.getElementById('agentLegsFeed');
  const meta = document.getElementById('agentProgressMeta');
  const fill = document.getElementById('agentProgressFill');
  const pulse = document.getElementById('agentPulseDot');
  const dock = document.getElementById('bgAgentDock');
  const dockText = document.getElementById('bgAgentDockText');

  const activeJob =
    backgroundJobs.find((j) => j.jobId === activeJobId) || backgroundJobs[0] || null;

  if (card && feed) {
    if (!activeJob) {
      card.classList.add('hidden');
    } else {
      card.classList.remove('hidden');
      const doneCount = activeJob.legs.filter(
        (l) => l.status === 'landed' || l.status === 'attested'
      ).length;
      const total = Math.max(1, activeJob.legs.length);
      const pct = Math.round((doneCount / total) * 100);
      if (meta) {
        meta.textContent =
          activeJob.status === 'completed'
            ? `${doneCount}/${total} settled`
            : `${doneCount}/${total} chains · running`;
      }
      if (fill) fill.style.width = `${Math.max(activeJob.status === 'active' ? 12 : 0, pct)}%`;
      if (pulse) pulse.classList.toggle('is-idle', activeJob.status !== 'active');

      feed.innerHTML = activeJob.legs
        .map((leg) => {
          const b = legStatusBadge(leg.status);
          const links = [
            leg.evmTxHash
              ? `<a class="explorer-link" href="${escapeHtml(leg.explorerUrl)}/tx/${escapeHtml(leg.evmTxHash)}" target="_blank" rel="noreferrer">EVM ↗</a>`
              : '',
            leg.solanaTxHash
              ? `<a class="explorer-link" href="https://solscan.io/tx/${escapeHtml(leg.solanaTxHash)}" target="_blank" rel="noreferrer">Solscan ↗</a>`
              : '',
            leg.evmTxHash
              ? `<button type="button" class="text-action" data-prove-leg="${escapeHtml(activeJob.jobId)}:${escapeHtml(leg.chain)}">Prove ✓</button>`
              : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return `
            <div class="agent-leg-row">
              <div style="min-width:0;">
                <div class="inline-logo-row">
                  <img src="${escapeHtml(getChainLogoPath(leg.chain))}" alt="" class="chain-logo-xs" />
                  <strong>${escapeHtml(leg.chainName)}</strong>
                  <span class="mono muted-xs">$${leg.estimatedNetUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div class="agent-leg-status">${escapeHtml(leg.statusText)}${links ? ` · ${links}` : ''}</div>
              </div>
              <span class="action-tag ${b.cls}">${b.icon} ${escapeHtml(leg.status)}</span>
            </div>
          `;
        })
        .join('');

      feed.querySelectorAll('[data-prove-leg]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const [jId, chain] = String(btn.dataset.proveLeg).split(':');
          proveLegOnchain(jId, chain, btn);
        });
      });
    }
  }

  // Floating bottom-right Background Agent Pill (visible whenever a job is active and user isn't on Sweep)
  if (dock && dockText) {
    const runningJob = backgroundJobs.find((j) => j.status === 'active');
    const siteVisible = !document.getElementById('siteShell')?.classList.contains('hidden');
    const showDock = Boolean(runningJob) && (siteVisible || activeView !== 'scanner');
    dock.classList.toggle('hidden', !showDock);
    if (runningJob) {
      const done = runningJob.legs.filter(
        (l) => l.status === 'landed' || l.status === 'attested'
      ).length;
      dockText.textContent = `Siphon Agent · ${done}/${runningJob.legs.length} chains settled`;
    }
  }

  // Activity Table
  const body = document.getElementById('liveExecLogBody');
  const statusMeta = document.getElementById('liveExecStatusMeta');
  if (body) {
    const rows = [];
    for (const job of backgroundJobs) {
      for (const leg of job.legs) {
        const b = legStatusBadge(leg.status);
        rows.push(`
          <tr>
            <td>
              <div class="asset-title inline-logo-row">
                <img src="${escapeHtml(getChainLogoPath(leg.chain))}" alt="" class="chain-logo-xs" />
                <span>${escapeHtml(leg.chainName)} (${leg.assetCount} assets)</span>
              </div>
              <div class="asset-sub mono">${escapeHtml(leg.statusText)}</div>
            </td>
            <td class="mono">${escapeHtml(leg.provider || job.bridgePreference)}</td>
            <td class="mono">$${leg.estimatedNetUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${escapeHtml(job.outputAsset)}</td>
            <td><span class="action-tag ${b.cls}">${escapeHtml(leg.status)}</span></td>
            <td class="mono" style="font-size:11.5px;">
              ${leg.evmTxHash ? `<a class="explorer-link" href="${escapeHtml(leg.explorerUrl)}/tx/${escapeHtml(leg.evmTxHash)}" target="_blank" rel="noreferrer">EVM Tx ↗</a>` : '—'}
              ${leg.solanaTxHash ? ` · <a class="explorer-link" href="https://solscan.io/tx/${escapeHtml(leg.solanaTxHash)}" target="_blank" rel="noreferrer">Solscan ↗</a>` : ''}
              ${leg.requiresSolanaClaim && leg.evmTxHash ? ` · <button type="button" class="text-action" data-check-cctp="${escapeHtml(job.jobId)}:${escapeHtml(leg.chain)}">Check CCTP Iris</button>` : ''}
            </td>
          </tr>
        `);
      }
    }
    if (rows.length) {
      body.innerHTML = rows.join('');
      if (statusMeta) statusMeta.textContent = `${backgroundJobs.length} job(s) · ${rows.length} chain leg(s)`;
      body.querySelectorAll('[data-check-cctp]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const [jId, chain] = String(btn.dataset.checkCctp).split(':');
          const job = backgroundJobs.find((j) => j.jobId === jId);
          const leg = job?.legs.find((l) => l.chain === chain);
          if (!leg?.evmTxHash) return;
          try {
            btn.textContent = 'Checking Iris…';
            const att = await api('/api/cctp/attestation', {
              method: 'POST',
              body: JSON.stringify({
                chain,
                txHash: leg.evmTxHash,
                solanaDestination: job.solanaDestination,
              }),
            });
            await api(`/api/jobs/${encodeURIComponent(jId)}/leg`, {
              method: 'POST',
              body: JSON.stringify({
                chain,
                status: att.attestationStatus === 'complete' ? 'attested' : 'relaying',
                statusText: att.nextStep,
                attestationStatus: att.attestationStatus,
              }),
            });
            await syncBackgroundJobs();
            showToast(att.nextStep);
          } catch (err) {
            showToast(err.message);
          }
        });
      });
    } else if (statusMeta) {
      statusMeta.textContent = 'No active jobs yet';
    }
  }
}

async function syncBackgroundJobs() {
  try {
    const res = await api('/api/jobs');
    backgroundJobs = Array.isArray(res.jobs) ? res.jobs : [];
    renderBackgroundAgentUI();
    const hasActive = backgroundJobs.some((j) => j.status === 'active');
    if (hasActive && !bgPollTimer) {
      bgPollTimer = setInterval(syncBackgroundJobs, 3000);
    } else if (!hasActive && bgPollTimer) {
      clearInterval(bgPollTimer);
      bgPollTimer = null;
      refreshSolanaBalance();
    }
  } catch {
    // non-fatal background sync error
  }
}

async function patchJobLeg(jobId, chain, patch) {
  if (!jobId) return;
  try {
    const updated = await api(`/api/jobs/${encodeURIComponent(jobId)}/leg`, {
      method: 'POST',
      body: JSON.stringify({ chain, ...patch }),
    });
    const idx = backgroundJobs.findIndex((j) => j.jobId === updated.jobId);
    if (idx >= 0) backgroundJobs[idx] = updated;
    else backgroundJobs.unshift(updated);
    renderBackgroundAgentUI();
  } catch {
    // ignore transient job patch errors
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

async function proveLegOnchain(jobId, chain, btnEl = null) {
  const job = backgroundJobs.find((j) => j.jobId === jobId);
  const leg = job?.legs.find((l) => l.chain === chain);
  if (!job || !leg?.evmTxHash) return;
  if (btnEl) btnEl.textContent = 'Proving…';
  try {
    const proof = await api('/api/tx/prove', {
      method: 'POST',
      body: JSON.stringify({
        chain,
        txHash: leg.evmTxHash,
        userAddress: job.sourceWallet,
        solanaDestination: job.solanaDestination,
        requestId: leg.requestId,
        provider: leg.provider,
        feeRecipientEvm: job.feeRecipientEvm,
        preSolanaUsdc: latestPreSignProof?.preSolanaSnapshot?.usdcBalance ?? solanaBalances?.usdcBalance,
        preSolanaSol: latestPreSignProof?.preSolanaSnapshot?.solBalance ?? solanaBalances?.solBalance,
      }),
    });
    const deltaPart =
      proof.solanaDeltaProof?.deltaUsdc > 0
        ? ` · +${proof.solanaDeltaProof.deltaUsdc} USDC verified on Solana`
        : '';
    await patchJobLeg(jobId, chain, {
      status: proof.verified ? 'landed' : leg.status,
      solanaTxHash: proof.bridgeProof?.solanaTxHash || leg.solanaTxHash,
      statusText: `${proof.summary}${deltaPart} (${shortAddr(proof.proofDigestSha256)})`,
    });
    showToast(proof.summary);
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btnEl) btnEl.textContent = 'Prove ✓';
  }
}

async function executeGaslessIntentChain(chain, jobId, chainAssets, userAddress, solDest) {
  const isNonEvm = (currentScan.family || activeFamily) !== 'evm';

  await patchJobLeg(jobId, chain, {
    status: 'preparing',
    provider: 'gasless_intent',
    statusText: 'Preparing 1-signature gasless sweep intent ($0 user gas)…',
  });
  const intent = await api('/api/relayer/prepare-intent', {
    method: 'POST',
    body: JSON.stringify({
      chain,
      assets: chainAssets,
      userAddress,
      solanaDestination: solDest,
      outputAsset,
      protocolFeeBps: getActiveProtocolFeeBps(),
      feeRecipientEvm: getActiveFeeRecipientEvm(),
    }),
  });
  await patchJobLeg(jobId, chain, {
    status: 'signing',
    provider: intent.mode,
    statusText: `Sign 1 gasless message ($0 gas · ${intent.coveredAssets.length} asset(s))…`,
  });
  const signature = isNonEvm
    ? await signFamilyGaslessIntent(currentScan.family || activeFamily, intent)
    : await signGaslessTypedData(intent.typedData || intent.signPayload, intent.chainId);
  const receipt = await api('/api/relayer/submit', {
    method: 'POST',
    body: JSON.stringify({
      intentId: intent.intentId,
      chain,
      userAddress,
      solanaDestination: solDest,
      signature,
      deadline: intent.deadline,
    }),
  });
  await patchJobLeg(jobId, chain, {
    status: receipt.mode === 'relayer_submitted' ? 'relaying' : 'attested',
    provider: intent.mode,
    evmTxHash: receipt.txHash,
    statusText: receipt.nextStep,
  });
  showToast(receipt.nextStep);
}

async function executeChainBatchLive(chain, existingJobId = null) {
  if (!currentScan || !currentPlan) return;
  const chainAssets = currentScan.assets.filter(
    (a) => a.chain === chain && selectedAssetIds.has(a.id) && a.action !== 'SKIP_HONEYPOT'
  );
  if (!chainAssets.length) {
    showToast(`No selected assets on ${chain}.`);
    return;
  }

  const solDest = document.getElementById('solanaDestInput').value.trim();
  const bridgePreference = getActiveBridgePreference();
  const protocolFeeBps = getActiveProtocolFeeBps();
  const feeRecipientEvm = getActiveFeeRecipientEvm();
  const connectedEvm = getConnectedEvmAddress();
  const userAddress = connectedEvm || currentScan.walletAddress;
  const legSummary = currentPlan.legs.find((l) => l.chain === chain);

  let jobId = existingJobId;
  if (!jobId) {
    const job = await api('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({
        sourceWallet: userAddress,
        solanaDestination: solDest,
        outputAsset,
        bridgePreference,
        protocolFeeBps,
        feeRecipientEvm,
        legs: [
          {
            chain,
            chainName: legSummary?.chainName || chain,
            assetCount: chainAssets.length,
            estimatedNetUsd: legSummary?.bridgedUsdc ?? 0,
            estimatedFeeUsd: legSummary?.feeUsdc ?? 0,
          },
        ],
      }),
    });
    jobId = job.jobId;
    activeJobId = jobId;
    backgroundJobs.unshift(job);
    renderBackgroundAgentUI();
  }

  await patchJobLeg(jobId, chain, {
    status: 'preparing',
    statusText: `Preparing ${chainAssets.length} asset(s) & live routes…`,
  });

  try {
    const isNonEvm = (currentScan.family || activeFamily) !== 'evm';
    const srcSession = getActiveSourceWallet();
    const connectedSrc = srcSession?.address || null;
    if (isNonEvm) {
      if (!connectedSrc) {
        await patchJobLeg(jobId, chain, {
          status: 'signing',
          statusText: `Connect ${(currentScan.family || activeFamily).toUpperCase()} wallet to sign 1-sig gasless sweep`,
        });
        openWalletModal('evm');
        return;
      }
      await executeGaslessIntentChain(chain, jobId, chainAssets, connectedSrc, solDest);
      return;
    }

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
        protocolFeeBps,
        feeRecipientEvm,
        bundleDefiCctp: hasSolanaSigner || bridgePreference === 'cctp',
      }),
    });

    if (!batch.calls.length) {
      await patchJobLeg(jobId, chain, {
        status: 'skipped',
        statusText: batch.skippedAssets.map((s) => `${s.assetSymbol}: ${s.reason}`).join(' · ') || 'No executable calls',
      });
      return;
    }

    if (!connectedEvm) {
      await patchJobLeg(jobId, chain, {
        status: 'signing',
        callsBatched: batch.calls.length,
        popupsSaved: batch.savings.popupsSaved,
        statusText: `${batch.calls.length} calls ready in 1 click — connect EVM wallet to sign`,
      });
      openWalletModal('evm');
      return;
    }

    if (connectedEvm.toLowerCase() !== currentScan.walletAddress.toLowerCase()) {
      await patchJobLeg(jobId, chain, {
        status: 'skipped',
        statusText: 'Scanning your connected wallet first…',
      });
      showToast('Connected EVM wallet differs from scanned address. Scanning your wallet now.');
      await runScan({ address: connectedEvm, autoOpen: true });
      return;
    }

    if (executionMode === 'gasless') {
      await executeGaslessIntentChain(chain, jobId, chainAssets, connectedEvm, solDest);
      return;
    }

    const chainCap = isChainBatchSupported(batch.chainId);
    const requiresSolanaClaim = batch.bridgeTrackers.some((t) => t.requiresSolanaClaim);
    const primaryRelay = batch.bridgeTrackers.find((t) => t.provider === 'relay' && t.requestId);
    const primaryProvider = primaryRelay?.provider || batch.bridgeTrackers[0]?.provider || 'eip5792_batch';
    let submittedHashes = [];
    let usedEip5792 = false;

    if (chainCap.supported || batch.calls.length > 1) {
      try {
        await patchJobLeg(jobId, chain, {
          status: 'signing',
          provider: primaryProvider,
          callsBatched: batch.calls.length,
          popupsSaved: batch.savings.popupsSaved,
          statusText: `Confirm 1 batch (${batch.calls.length} calls) in your wallet…`,
        });

        const { batchId } = await sendEip5792Batch({
          chainId: batch.chainId,
          calls: batch.calls,
        });
        usedEip5792 = true;

        await patchJobLeg(jobId, chain, {
          status: 'confirming',
          statusText: `Batch submitted (${shortAddr(batchId)}) · confirming…`,
        });

        const settled = await waitForEip5792Batch(batchId, (upd) => {
          patchJobLeg(jobId, chain, {
            status: 'confirming',
            evmTxHash: upd.txHashes?.[0],
            statusText: `Confirming on ${batch.chainName}…`,
          });
        });

        submittedHashes = settled.txHashes || [];
        if (settled.failed) {
          await patchJobLeg(jobId, chain, {
            status: 'failed',
            evmTxHash: submittedHashes[0],
            statusText: 'Batch reverted onchain',
          });
          return;
        }
      } catch (err) {
        if (err?.code === 4001) throw err;
        if (!err?.unsupportedEip5792) throw err;
        showToast(`${batch.chainName}: wallet lacks EIP-5792 — using sequential signing.`);
      }
    }

    if (!usedEip5792) {
      for (let i = 0; i < batch.calls.length; i++) {
        const call = batch.calls[i];
        await patchJobLeg(jobId, chain, {
          status: 'signing',
          provider: primaryProvider,
          statusText: `Sign step ${i + 1}/${batch.calls.length}: ${call.label}`,
        });
        const txHash = await sendRealEvmTransaction({
          chainId: batch.chainId,
          to: call.to,
          data: call.data,
          value: call.value,
          gas: call.gas,
        });
        submittedHashes.push(txHash);
        const needsMining =
          i < batch.calls.length - 1 &&
          (call.stepId.includes('withdraw') ||
            call.stepId.includes('redeem') ||
            call.stepId.includes('approve'));
        if (needsMining) {
          await patchJobLeg(jobId, chain, {
            status: 'confirming',
            evmTxHash: txHash,
            statusText: `Waiting for step ${i + 1}/${batch.calls.length} confirmation…`,
          });
          await waitForEvmReceipt(batch.chain, txHash);
        }
      }
    }

    // Hand off to Siphon's server-side background settlement watcher!
    await patchJobLeg(jobId, chain, {
      status: batch.bridgeTrackers.length ? 'relaying' : 'landed',
      provider: primaryProvider,
      evmTxHash: submittedHashes[submittedHashes.length - 1],
      requestId: primaryRelay?.requestId,
      requiresSolanaClaim,
      statusText: batch.bridgeTrackers.length
        ? `Confirmed on ${batch.chainName} · relaying to Solana in background…`
        : `Confirmed on ${batch.chainName}`,
    });

    showToast(
      `${batch.chainName} submitted — Siphon Background Agent is tracking Solana settlement.`
    );
    syncBackgroundJobs();
  } catch (err) {
    await patchJobLeg(jobId, chain, {
      status: 'failed',
      statusText: err?.message || 'Cancelled or failed',
    });
    showToast(err?.message || 'Execution failed');
  }
}

async function executeSelectedLiveQueue() {
  if (!currentScan || !currentPlan) return;
  const activeChains = currentPlan.legs.map((l) => l.chain);
  if (!activeChains.length) {
    showToast('Select at least one asset to sweep.');
    return;
  }

  const srcSession = getActiveSourceWallet();
  const connectedSrc = srcSession?.address || null;
  if (!connectedSrc) {
    openWalletModal('evm');
    return;
  }

  const solDest = document.getElementById('solanaDestInput').value.trim();
  const job = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({
      sourceWallet: connectedSrc,
      solanaDestination: solDest,
      outputAsset,
      bridgePreference: getActiveBridgePreference(),
      protocolFeeBps: getActiveProtocolFeeBps(),
      feeRecipientEvm: getActiveFeeRecipientEvm(),
      legs: currentPlan.legs.map((l) => ({
        chain: l.chain,
        chainName: l.chainName,
        assetCount: l.defiExits + l.swaps + l.burns,
        estimatedNetUsd: l.bridgedUsdc,
        estimatedFeeUsd: l.feeUsdc,
      })),
    }),
  });
  activeJobId = job.jobId;
  backgroundJobs.unshift(job);
  renderBackgroundAgentUI();

  for (const chain of activeChains) {
    await executeChainBatchLive(chain, job.jobId);
  }
}

function renderBurnView() {
  const rows = currentPlan.burnManifest;
  const countEl = document.getElementById('burnManifestCount');
  if (countEl) countEl.textContent = `${rows.length} token(s)`;
  const body = document.getElementById('burnTableBody');
  if (!body) return;
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
        <td class="mono"><span class="inline-logo-row"><img src="${escapeHtml(getChainLogoPath(b.chain))}" alt="" class="chain-logo-xs" /><span>${escapeHtml(b.chain)}</span></span></td>
        <td class="mono">${escapeHtml(b.amount)}</td>
        <td>${b.status === 'BURN_READY' ? `<span class="action-tag tag-burn">Burn 0x…dEaD</span>` : `<span class="action-tag tag-skip">Honeypot Skipped</span>`}</td>
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

// =====================================================================
// UNIFIED DUAL-ECOSYSTEM WALLET MODAL (Official Brand SVGs)
// =====================================================================
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

  const srcSession = getActiveSourceWallet();
  const srcAddr = srcSession?.address || null;
  const solAddr = getConnectedSolanaAddress();
  evmDot?.classList.toggle('hidden', !srcAddr);
  solDot?.classList.toggle('hidden', !solAddr);

  const meta = familyMetas[activeFamily];
  const famShort = meta?.shortLabel || (activeFamily === 'evm' ? 'EVM' : activeFamily.toUpperCase());
  const evmTabBtn = document.getElementById('walletTabEvm');
  if (evmTabBtn) {
    evmTabBtn.innerHTML = `${escapeHtml(famShort)} Source <span class="wallet-tab-dot ${srcAddr ? '' : 'hidden'}" id="walletTabEvmDot"></span>`;
  }

  document.querySelectorAll('.wallet-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.walletTab === activeWalletModalTab);
  });

  const isEvm = activeWalletModalTab === 'evm';
  const isSourceEvm = isEvm && activeFamily === 'evm';
  const activeAddr = isEvm ? srcAddr : solAddr;
  const activeName = isEvm ? srcSession?.walletName : getConnectedSolanaWalletName();
  const cfg = getWalletConnectorConfig();
  const effectiveWcId = getEffectiveWalletConnectProjectId();

  titleEl.textContent = isEvm ? `Connect ${famShort} Wallet` : 'Connect Solana Wallet';
  subEl.textContent = isSourceEvm
    ? 'Sign exits, swaps, burns, and bridges across 14 EVM chains.'
    : isEvm
    ? meta?.signingMechanism || `Connect your ${famShort} wallet to sign 1-sig gasless sweeps.`
    : 'Receive native USDC or SOL on Solana.';

  const rows = [];
  if (walletModalError) {
    rows.push(`<div class="wallet-modal-error">${escapeHtml(walletModalError)}</div>`);
  }

  if (isEvm && !isSourceEvm) {
    const detectedFam = listAvailableFamilyWallets(activeFamily);
    if (detectedFam.length) {
      rows.push(`<div class="wallet-section-label">Installed ${escapeHtml(famShort)} wallets</div>`);
      for (const w of detectedFam) {
        const isBusy = walletModalConnecting === `fam:${w.id}`;
        rows.push(`
          <button type="button" class="wallet-option-row" data-pick-family-wallet="${escapeHtml(w.id)}" ${walletModalConnecting ? 'disabled' : ''}>
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
    }
    if (meta?.wallets?.length) {
      rows.push(`<div class="wallet-section-label">Supported ${escapeHtml(famShort)} wallets</div>`);
      rows.push(
        `<div class="wallet-install-strip">${meta.wallets
          .map(
            (w) =>
              `<a class="wallet-install-chip" href="${escapeHtml(w.installUrl)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(w.logo)}" alt="" class="chain-logo-xs" />${escapeHtml(w.name)} ↗</a>`
          )
          .join('')}</div>`
      );
    }
    rows.push(`
      <div class="wallet-section-label">Or inspect any ${escapeHtml(famShort)} address</div>
      <form class="wallet-manual-form" id="modalFamilyManualForm">
        <input type="text" id="modalFamilyAddrInput" class="field-input mono" value="${escapeHtml(meta?.sampleAddress || '')}" placeholder="${escapeHtml(meta?.addressHint || '')}" aria-label="${escapeHtml(famShort)} source address" />
        <button type="submit" class="btn-outline-dark">Scan</button>
      </form>
    `);
  } else if (isEvm) {
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
    if (isEvm) disconnectFamilyWallet(activeFamily);
    else disconnectSolanaWallet();
    updateWalletButtons();
    renderWalletModalContent();
    showToast(isEvm ? `Disconnected ${famShort} wallet.` : 'Disconnected Solana wallet.');
  });

  listEl.querySelectorAll('[data-pick-family-wallet]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const walletId = btn.dataset.pickFamilyWallet;
      walletModalError = null;
      walletModalConnecting = `fam:${walletId}`;
      renderWalletModalContent();
      try {
        const res = await connectFamilyWallet(activeFamily, { walletId });
        closeWalletModal();
        updateWalletButtons();
        showToast(`Connected ${res.walletName} (${shortAddr(res.address)})`);
        await runScan({ address: res.address, family: activeFamily, autoOpen: true });
      } catch (err) {
        walletModalConnecting = null;
        walletModalError = err?.message || 'Wallet connection cancelled.';
        renderWalletModalContent();
        showToast(walletModalError);
      }
    });
  });

  document.getElementById('modalFamilyManualForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const addr = document.getElementById('modalFamilyAddrInput')?.value.trim();
    if (!addr) return;
    closeWalletModal();
    await runScan({ address: addr, family: activeFamily, autoOpen: true });
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

  document.getElementById('bgAgentDock')?.addEventListener('click', () => openApp('scanner'));

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

  document.getElementById('toggleDestEditBtn')?.addEventListener('click', () => {
    const wrap = document.getElementById('destEditWrap');
    if (!wrap) return;
    wrap.classList.toggle('hidden');
    if (!wrap.classList.contains('hidden')) {
      document.getElementById('solanaDestInput')?.focus();
    }
  });

  document.getElementById('toggleFeeDrawerBtn')?.addEventListener('click', () => {
    document.getElementById('feeOptionsDrawer')?.classList.toggle('hidden');
  });

  document.querySelectorAll('.family-pill[data-family]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectFamily(btn.dataset.family, { autoScanSample: true });
    });
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
    if (addr) runScan({ address: addr, family: activeFamily, autoOpen: false });
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
      renderAssetList();
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

  document.getElementById('runLiveQueueBtn').addEventListener('click', executeSelectedLiveQueue);
  document.getElementById('verifyProofBtn')?.addEventListener('click', runPreSignProof);
  document.querySelectorAll('.mode-opt[data-exec-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setExecutionMode(btn.dataset.execMode));
  });

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
api('/api/families')
  .then((res) => {
    for (const f of res.families || []) {
      familyMetas[f.family] = f;
    }
    updateFamilyChrome();
  })
  .catch(() => {});
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
  setTimeout(() => preloadWalletSdks(), 600);
  syncBackgroundJobs();
});
heroScene = mountSiphonFunnelScene(document.getElementById('siphonHeroCanvas'));
runScan({ presetId: 'vitalik_live', autoOpen: false });
