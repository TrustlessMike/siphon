import { renderConvergenceSvg } from './turgalium-svg.js?v=4';
import {
  claimCctpOnSolana,
  connectCoinbaseSmartWallet,
  connectDualVmWallet,
  connectEvmWallet,
  connectFamilyWallet,
  connectSolanaWallet,
  connectWalletConnect,
  createChainBatchPrequoter,
  disconnectEvmWallet,
  disconnectFamilyWallet,
  disconnectSolanaWallet,
  executeNonEvmDirectBatch,
  findMatchingSolanaWalletForEvm,
  getConnectedEvmAddress,
  getConnectedFamilyWallet,
  getConnectedSolanaAddress,
  getConnectedSolanaWalletName,
  getConnectedWalletName,
  getEffectiveWalletConnectProjectId,
  getMobileEvmDeepLinks,
  getMobileSolanaDeepLinks,
  getWalletBatchCapabilities,
  getWalletConnectorConfig,
  isChainBatchSupported,
  isMobileBrowser,
  isUserRejectedError,
  isValidSolanaBase58,
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
} from './wallets.js?v=12';

let currentScan = null;
let currentPlan = null;
let selectedAssetIds = new Set();
let batchRescuedDustIds = new Set();
let lastDustPlan = null;
let activeFamily = 'evm';
let familyMetas = {};
let activeFilter = 'all';
let activeChainFilter = 'all';
let activeView = 'scanner';
let executionMode = 'direct'; // 'direct' | 'gasless'
let uiMode = 'lite'; // 'lite' | 'pro'
let outputAsset = 'USDC';
let heroScene = null;
let contractData = null;
let activeContractId = 'router';
let solanaBalances = null;
let latestPreSignProof = null;
let backgroundJobs = [];
let activeJobId = null;
let bgPollTimer = null;
let unifiedWallets = []; // [{ address, label, family }]
let agentMandates = [];
let agentApprovals = [];
let pluginSetupData = null;
let lastIssuedTokens = { claude_mcp: null, chatgpt_action: null };
let latestIssuedToken = null;
let defiStepperState = null;
let manualDestConfirmedAddress = null;
let isSweepQueueRunning = false;
const executingChains = new Set();
let planSeq = 0;
let solBalSeq = 0;
let adminSessionRequired = false;
let adminSessionLoaded = false;
let adminSessionToken = (() => {
  try {
    return window.sessionStorage?.getItem('turgalium_admin_session') || '';
  } catch {
    return '';
  }
})();

const ADMIN_SESSION_STORAGE_KEY = 'turgalium_admin_session';
const FEE_RECIPIENT_STORAGE_KEY = 'turgalium_fee_recipient_evm';
const INFLIGHT_BRIDGES_STORAGE_KEY = 'turgalium_inflight_bridges_v1';
const LOCAL_SWEEP_JOBS_STORAGE_KEY = 'turgalium_local_jobs_v1';
const LOCAL_SWEEP_JOBS_MAX_ITEMS = 20;
const INFLIGHT_BRIDGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const INFLIGHT_BRIDGE_MAX_ITEMS = 25;

let inFlightBridges = [];
let inFlightPollTimer = null;
let inFlightPollInProgress = false;
let activeReceiptData = null;
const observedActiveJobIds = new Set();
const shownReceiptJobIds = new Set();

function isAdminLocked() {
  return Boolean(adminSessionRequired && !adminSessionToken);
}

function canAccessAdminRoutes() {
  return adminSessionLoaded && !isAdminLocked();
}

function getAdminHeaders() {
  return adminSessionToken ? { 'X-Turgalium-Admin-Session': adminSessionToken } : {};
}

window.__turgaliumAdminAuth = {
  isAdminLocked,
  canAccessAdmin: canAccessAdminRoutes,
  getHeaders: getAdminHeaders,
};
const UI_MODE_STORAGE_KEY = 'turgalium_ui_mode';
const PRO_ONLY_FILTERS = new Set(['low_efficiency', 'burn', 'skipped']);
const PRO_ONLY_VIEWS = new Set(['agents', 'contract']);
// Neutral all-zero Solana System Program address used strictly for read-only /api/plan previews
// when the user has not yet connected or entered a Solana destination. Never used for execution.
const PREVIEW_SOLANA_PLACEHOLDER = '11111111111111111111111111111111';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const escHtml = escapeHtml;

function safeInt(val) {
  const n = Number(val);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function safeNum(val) {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function safeHttpUrl(url) {
  const raw = String(url || '').trim();
  if (!raw || raw.startsWith('//')) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeTxHash(hash) {
  const s = String(hash || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return s;
  if (/^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(s)) return s;
  if (/^[0-9a-fA-F]{64}$/.test(s)) return s;
  return null;
}

function safeExplorerTxUrl(explorerBase, txHash) {
  const cleanHash = safeTxHash(txHash);
  const base = String(explorerBase || '').trim().replace(/\/+$/, '');
  if (!cleanHash || !/^https:\/\//i.test(base)) return null;
  return `${base}/tx/${encodeURIComponent(cleanHash)}`;
}

function safeWalletIconUrl(iconUrl, fallbackLocal) {
  const raw = String(iconUrl || '').trim();
  if (!raw) return fallbackLocal;
  if (/^\/logos\/[a-z0-9._-]+\.(svg|png|webp)$/i.test(raw)) return raw;
  if (/^data:image\/(png|jpeg|webp|gif|svg\+xml)(;charset=[^;,]+)?(;base64)?,/i.test(raw)) return raw;
  return fallbackLocal;
}

function csvCell(val) {
  const raw = String(val ?? '');
  const hadLeadingTrigger = /^[=+\-@\t\r]/.test(raw);
  // Strip CR/LF and NUL control characters so no cell can break CSV row boundaries
  let cleaned = raw
    .replace(/^[\r\n]+/, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\u0000/g, '');
  if (hadLeadingTrigger || /^[=+\-@\t\r]/.test(cleaned) || /^\s+[=+\-@]/.test(cleaned)) {
    cleaned = `'${cleaned}`;
  }
  return `"${cleaned.replaceAll('"', '""')}"`;
}

function needsDarkLogoBacking(str) {
  const s = String(str || '').toLowerCase();
  return s.includes('mantle') || s.includes('blast') || s.includes('solflare');
}

function getVerifiedSolanaDestination() {
  const raw = document.getElementById('solanaDestInput')?.value?.trim() || '';
  if (!raw || !isValidSolanaBase58(raw)) return null;
  const connectedSol = getConnectedSolanaAddress();
  if (connectedSol && connectedSol === raw) return raw;
  const chk = document.getElementById('manualDestConfirmChk');
  if (chk?.checked && manualDestConfirmedAddress === raw) return raw;
  return null;
}

function syncDestinationUiState() {
  const input = document.getElementById('solanaDestInput');
  const summaryEl = document.getElementById('destAddrSummary');
  const confirmWrap = document.getElementById('manualDestConfirmWrap');
  const confirmChk = document.getElementById('manualDestConfirmChk');
  const mandateNote = document.getElementById('mandateLockedDestNote');

  const raw = input?.value?.trim() || '';
  const connectedSol = getConnectedSolanaAddress();
  const solWalletName = getConnectedSolanaWalletName();
  const isConnectedMatch = Boolean(connectedSol && connectedSol === raw);
  const isValid = Boolean(raw && isValidSolanaBase58(raw));

  if (confirmWrap) {
    const showManualConfirm = Boolean(raw && !isConnectedMatch);
    confirmWrap.classList.toggle('hidden', !showManualConfirm);
    if (!showManualConfirm && confirmChk) {
      confirmChk.checked = false;
      manualDestConfirmedAddress = null;
    }
  }

  if (summaryEl) {
    if (!raw) {
      summaryEl.textContent = 'Connect Solana or enter destination';
    } else if (!isValid) {
      summaryEl.textContent = 'Invalid Solana address';
    } else if (isConnectedMatch) {
      summaryEl.textContent = solWalletName
        ? `${solWalletName} · ${shortAddr(raw)}`
        : shortAddr(raw);
    } else if (confirmChk?.checked && manualDestConfirmedAddress === raw) {
      summaryEl.textContent = `Manual (Verified) · ${shortAddr(raw)}`;
    } else {
      summaryEl.textContent = `Unconfirmed · ${shortAddr(raw)}`;
    }
  }

  if (mandateNote) {
    const verified = getVerifiedSolanaDestination();
    mandateNote.textContent = verified
      ? `Locked destination → ${shortAddr(verified)}`
      : 'Connect Solana or confirm a destination address first';
    const destDot = document.getElementById('mandateDestDot');
    destDot?.classList.toggle('is-ready', Boolean(verified));
    const inlineConnectBtn = document.getElementById('mandateConnectSolBtn');
    inlineConnectBtn?.classList.toggle('hidden', Boolean(verified));
  }
}

function requireVerifiedSolanaDestination(actionLabel = 'sweep') {
  const verified = getVerifiedSolanaDestination();
  if (verified) return verified;

  const wrap = document.getElementById('destEditWrap');
  const input = document.getElementById('solanaDestInput');
  const chk = document.getElementById('manualDestConfirmChk');
  wrap?.classList.remove('hidden');
  syncDestinationUiState();

  const raw = input?.value?.trim() || '';
  if (!raw) {
    showToast(`Connect a Solana wallet or enter & confirm a Solana destination before you ${actionLabel}.`);
    input?.focus();
  } else if (!isValidSolanaBase58(raw)) {
    showToast('Enter a valid Base58 Solana destination address before proceeding.');
    input?.focus();
  } else {
    showToast('Check "I verified this Solana destination address" (or connect Solana) before proceeding.');
    chk?.focus();
  }
  return null;
}

function clearSolanaDestinationUi() {
  const input = document.getElementById('solanaDestInput');
  const chk = document.getElementById('manualDestConfirmChk');
  const badge = document.getElementById('solanaLiveBalanceBadge');
  if (input) input.value = '';
  if (chk) chk.checked = false;
  manualDestConfirmedAddress = null;
  solanaBalances = null;
  if (badge) badge.textContent = 'Connect a Solana wallet or enter a destination address';
  syncDestinationUiState();
}

function buildEffectiveScanForPlan() {
  if (!currentScan) return null;
  if (!batchRescuedDustIds.size) return currentScan;
  return {
    ...currentScan,
    assets: currentScan.assets.map((a) => {
      if (
        batchRescuedDustIds.has(a.id) &&
        selectedAssetIds.has(a.id) &&
        (a.action === 'SKIP_GAS_NEGATIVE' || a.action === 'SKIP_NEGATIVE_ROI')
      ) {
        return {
          ...a,
          action: 'SELL_AND_BRIDGE',
          actionReason: 'Batch-rescued dust token promoted into single chain swap & bridge',
        };
      }
      return a;
    }),
  };
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

function formatCompactBalance(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15) {
    return n.toExponential(2).replace('+', '');
  }
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e5) return `${(n / 1e3).toFixed(1)}K`;
  if (abs < 0.0001) return '<0.0001';
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

const PRESERVATION_FEE_BRACKETS = [
  { minGrossUsd: 0, maxGrossUsd: 50, feeBps: 500, capUsd: null, tierLabel: 'Micro-Dust (<$50)' },
  { minGrossUsd: 50, maxGrossUsd: 500, feeBps: 100, capUsd: null, tierLabel: 'Small ($50–$500)' },
  { minGrossUsd: 500, maxGrossUsd: 5000, feeBps: 25, capUsd: null, tierLabel: 'Mid ($500–$5k)' },
  { minGrossUsd: 5000, maxGrossUsd: null, feeBps: 10, capUsd: 50, tierLabel: 'Principal ($5k+)' },
];

function computeTieredPreservationFee(grossUsdInput) {
  const raw = Number(grossUsdInput);
  const grossUsd = Number.isFinite(raw) && raw > 0 ? Number(raw.toFixed(2)) : 0;
  const legacy7PctUsd = Number(((grossUsd * 700) / 10_000).toFixed(2));
  return {
    grossUsd,
    feeBps: 0,
    effectiveFeeBps: 0,
    feePercentLabel: '0%',
    feeUsd: 0,
    capUsd: 0,
    capApplied: false,
    legacy7PctUsd,
    savedVs7PctUsd: legacy7PctUsd,
    tierLabel: 'Open Source (0% Fee)',
  };
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
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...getAdminHeaders(),
      ...(opts.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function hasExtendedLogos() {
  return Boolean(
    typeof window !== 'undefined' &&
      (typeof window.renderTurgaliumUiIcon === 'function' ||
        typeof window.renderUiIcon === 'function')
  );
}

function resolveLogo(preferred, fallback) {
  return hasExtendedLogos() ? preferred : fallback;
}

function needsLightLogoBacking(str) {
  if (hasExtendedLogos()) return false;
  const s = String(str || '').toLowerCase();
  return (
    s.includes('aptos') ||
    s.includes('linea') ||
    s.includes('sonic') ||
    s.includes('worldchain') ||
    s.includes('ledger') ||
    s.includes('okx')
  );
}

const LOCAL_UI_ICONS = {
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  'refresh-cw':
    '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  'shield-alert':
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  'shield-check':
    '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  ban: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
  'alert-triangle':
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  'x-circle':
    '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  'check-circle':
    '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  'activity-dot': '<circle cx="12" cy="12" r="4" fill="currentColor"/><circle cx="12" cy="12" r="9"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  'external-link':
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
};

function uiIcon(name, size = 13) {
  if (!name) return '';
  if (typeof window !== 'undefined') {
    if (typeof window.renderTurgaliumUiIcon === 'function') {
      return window.renderTurgaliumUiIcon(name, size);
    }
    if (typeof window.renderUiIcon === 'function') {
      return window.renderUiIcon(name, size);
    }
  }
  const paths = LOCAL_UI_ICONS[name];
  if (!paths) return '';
  const s = Number(size) || 13;
  return `<span class="ui-icon" aria-hidden="true"><svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></span>`;
}

function detectAddressFamily(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const first = s.includes(',') ? s.split(',')[0].trim() : s;
  if (/^0x[0-9a-fA-F]{40}$/.test(first) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i.test(first)) {
    return 'evm';
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(first)) {
    return activeFamily === 'aptos' ? 'aptos' : 'sui';
  }
  if (/^(cosmos|osmo|celestia|noble|inj|neutron)1[0-9a-z]{20,}$/i.test(first)) {
    return 'cosmos';
  }
  if (/^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}$/.test(first) || /^-?[0-9]+:[0-9a-fA-F]{64}$/.test(first)) {
    return 'ton';
  }
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(first)) {
    return 'tron';
  }
  if (/^(bc1[0-9a-z]{25,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i.test(first)) {
    return 'btc';
  }
  return null;
}

window.__turgaliumDetectAddressFamily = detectAddressFamily;

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
  if (s.includes('cosmostation')) return resolveLogo('/logos/cosmostation.svg', '/logos/cosmos.svg');
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
  if (c === 'cosmoshub') return '/logos/cosmos.svg';
  if (['celestia', 'noble', 'injective', 'neutron'].includes(c)) {
    return resolveLogo(`/logos/${c}.svg`, '/logos/cosmos.svg');
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
      'hyperevm',
      'berachain',
      'zksync',
      'ink',
      'gnosis',
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
  if (!p) return null;
  if (p.includes('aave')) return '/logos/aave.svg';
  if (p.includes('lido')) return '/logos/lido.svg';
  if (p.includes('compound')) return '/logos/compound.svg';
  if (p.includes('morpho')) return '/logos/morpho.svg';
  if (p.includes('uniswap')) return '/logos/uniswap.svg';
  if (p.includes('curve')) return '/logos/curve.svg';
  if (p.includes('spark')) return '/logos/spark.svg';
  if (p.includes('ethena')) return resolveLogo('/logos/ethena.svg', '/logos/vault.svg');
  if (p.includes('sky') || p.includes('maker')) return resolveLogo('/logos/sky.svg', '/logos/vault.svg');
  if (p.includes('yearn')) return resolveLogo('/logos/yearn.svg', '/logos/vault.svg');
  if (p.includes('aerodrome')) return resolveLogo('/logos/aerodrome.svg', '/logos/vault.svg');
  if (p.includes('velodrome')) return '/logos/vault.svg';
  if (p.includes('hyperlend')) return resolveLogo('/logos/hyperlend.svg', '/logos/hyperevm.svg');
  if (p.includes('kodiak')) return resolveLogo('/logos/kodiak.svg', '/logos/berachain.svg');
  if (p.includes('bex') || p.includes('balancer')) return resolveLogo('/logos/bex.svg', '/logos/berachain.svg');
  if (p.includes('moonwell')) return resolveLogo('/logos/moonwell.svg', '/logos/base.svg');
  if (p.includes('pendle')) return '/logos/vault.svg';
  if (p.includes('jupiter')) return resolveLogo('/logos/jupiter.svg', '/logos/solana.svg');
  if (p.includes('kamino')) return resolveLogo('/logos/kamino.svg', '/logos/vault.svg');
  if (p.includes('sanctum')) return resolveLogo('/logos/sanctum.svg', '/logos/solana.svg');
  if (p.includes('osmosis')) return '/logos/osmosis.svg';
  if (p.includes('cosmos')) return '/logos/cosmos.svg';
  if (p.includes('sui')) return '/logos/sui.svg';
  if (p.includes('vault') || p.includes('4626')) return '/logos/vault.svg';
  return '/logos/vault.svg';
}

function getTokenLogoPath(symbol, chain) {
  const sym = String(symbol || '').trim().toUpperCase();
  const chainLogo = getChainLogoPath(chain);
  if (!sym) return chainLogo;
  if (sym === 'USDC' || sym === 'USDBC' || sym === 'USDC.E' || sym === 'USDCE') return '/logos/usdc.svg';
  if (sym === 'USDT' || sym === 'USDT0' || sym === 'USD₮0') return resolveLogo('/logos/usdt.svg', chainLogo);
  if (sym === 'WBTC' || sym === 'BTCB' || sym === 'CBBTC' || sym === 'BTC') {
    return resolveLogo('/logos/wbtc.svg', '/logos/btc.svg');
  }
  if (sym === 'DAI' || sym === 'SDAI' || sym === 'USDS' || sym === 'SUSDS') {
    return resolveLogo('/logos/dai.svg', '/logos/ethereum.svg');
  }
  if (sym === 'JUPSOL') return resolveLogo('/logos/jupsol.svg', '/logos/solana.svg');
  if (sym === 'WSTETH' || sym === 'STETH') return resolveLogo('/logos/wsteth.svg', '/logos/lido.svg');
  if (sym === 'USDE' || sym === 'SUSDE') return resolveLogo('/logos/usde.svg', '/logos/vault.svg');
  if (sym === 'ETH' || sym === 'WETH') return '/logos/ethereum.svg';
  if (sym === 'SOL' || sym === 'WSOL') return '/logos/solana.svg';
  if (sym === 'ARB') return '/logos/arbitrum.svg';
  if (sym === 'OP') return '/logos/optimism.svg';
  if (sym === 'AAVE') return '/logos/aave.svg';
  if (sym === 'UNI') return '/logos/uniswap.svg';
  if (sym === 'GNO') return '/logos/gnosis.svg';
  if (sym === 'ZK') return '/logos/zksync.svg';
  if (sym === 'BNB' || sym === 'WBNB') return '/logos/bnb.svg';
  if (sym === 'AVAX' || sym === 'WAVAX') return '/logos/avalanche.svg';
  if (sym === 'POL' || sym === 'MATIC' || sym === 'WMATIC') return '/logos/polygon.svg';
  if (sym === 'HYPE' || sym === 'WHYPE') return '/logos/hyperevm.svg';
  if (sym === 'BERA' || sym === 'WBERA') return '/logos/berachain.svg';
  if (sym === 'S' || sym === 'WS') return '/logos/sonic.svg';
  if (sym === 'WLD') return '/logos/worldchain.svg';
  if (sym === 'AERO') return resolveLogo('/logos/aerodrome.svg', chainLogo);
  if (sym === 'TIA') return resolveLogo('/logos/celestia.svg', '/logos/cosmos.svg');
  if (sym === 'INJ') return resolveLogo('/logos/injective.svg', '/logos/cosmos.svg');
  if (sym === 'NTRN') return resolveLogo('/logos/neutron.svg', '/logos/cosmos.svg');
  if (sym === 'OSMO') return '/logos/osmosis.svg';
  if (sym === 'ATOM') return '/logos/cosmos.svg';
  if (sym === 'SUI') return '/logos/sui.svg';
  if (sym === 'APT') return '/logos/aptos.svg';
  if (sym === 'TON') return '/logos/ton.svg';
  if (sym === 'TRX') return '/logos/tron.svg';
  return chainLogo;
}

function getBridgeProviderLogosHtml(pref) {
  const p = String(pref || '').toLowerCase();
  if (p === 'cctp' || p === 'circle_cctp') return `<img src="/logos/circle.svg" width="14" height="14" alt="" class="chain-logo-xs" />`;
  if (p === 'lifi') return `<img src="/logos/lifi.svg" width="14" height="14" alt="" class="chain-logo-xs" />`;
  if (p === 'relay') return `<img src="/logos/relay.svg" width="14" height="14" alt="" class="chain-logo-xs" />`;
  if (p === 'mayan' || p === 'mayan_swift') {
    return `<img src="${resolveLogo('/logos/mayan.svg', '/logos/relay.svg')}" width="14" height="14" alt="" class="chain-logo-xs" />`;
  }
  if (p === 'debridge' || p === 'debridge_dln') {
    return `<img src="${resolveLogo('/logos/debridge.svg', '/logos/lifi.svg')}" width="14" height="14" alt="" class="chain-logo-xs" />`;
  }
  if (p === 'skip') {
    return `<img src="${resolveLogo('/logos/skip.svg', '/logos/cosmos.svg')}" width="14" height="14" alt="" class="chain-logo-xs" />`;
  }
  return `<img src="/logos/relay.svg" width="14" height="14" alt="" class="chain-logo-xs" /><img src="/logos/lifi.svg" width="14" height="14" alt="" class="chain-logo-xs" />`;
}

function isTieredFeeMode() {
  return true;
}

function getActiveProtocolFeeBps() {
  return 0;
}

function getActiveFeeRecipientEvm() {
  return null;
}

function isProMode() {
  return uiMode === 'pro';
}

function syncUiModeButtons() {
  document.documentElement.dataset.uiMode = uiMode;
  document.querySelectorAll('.ui-mode-btn[data-ui-mode]').forEach((btn) => {
    const isActive = btn.dataset.uiMode === uiMode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });
}

function initUiMode() {
  let saved = null;
  try {
    saved = window.localStorage?.getItem(UI_MODE_STORAGE_KEY);
  } catch {
    saved = null;
  }
  uiMode = saved === 'pro' ? 'pro' : 'lite';
  syncUiModeButtons();
}

function setUiMode(mode, { persist = true, silent = false } = {}) {
  const next = mode === 'pro' ? 'pro' : 'lite';
  const changed = next !== uiMode;
  uiMode = next;
  if (persist) {
    try {
      window.localStorage?.setItem(UI_MODE_STORAGE_KEY, uiMode);
    } catch {
      // ignore storage errors
    }
  }
  syncUiModeButtons();

  let needPlanRecompute = false;
  if (uiMode === 'lite') {
    document.getElementById('feeOptionsDrawer')?.classList.add('hidden');
    document.getElementById('unifiedWalletsBar')?.classList.add('hidden');
    if (executionMode !== 'direct') {
      executionMode = 'direct';
      document.querySelectorAll('.mode-opt[data-exec-mode]').forEach((b) => {
        b.classList.toggle('active', b.dataset.execMode === executionMode);
      });
    }
    const burnEl = document.getElementById('burnToggle');
    if (burnEl && burnEl.checked) {
      burnEl.checked = false;
      needPlanRecompute = true;
    }
    const feeSel = document.getElementById('protocolFeeSelect');
    if (feeSel && feeSel.value !== 'tiered') {
      feeSel.value = 'tiered';
      needPlanRecompute = true;
    }
    if (currentScan?.assets) {
      for (const a of currentScan.assets) {
        if (a.action === 'BURN_ZERO_LIQUIDITY' && selectedAssetIds.has(a.id)) {
          selectedAssetIds.delete(a.id);
          needPlanRecompute = true;
        }
      }
    }
    if (PRO_ONLY_VIEWS.has(activeView)) {
      switchView('scanner');
    }
    if (PRO_ONLY_FILTERS.has(activeFilter)) {
      activeFilter = 'all';
      document.querySelectorAll('.filter-pill').forEach((b) => {
        b.classList.toggle('active', b.dataset.filter === 'all');
      });
    }
  }

  updateFamilyChrome();
  updateWalletButtons();
  if (needPlanRecompute && currentScan) {
    recomputePlan();
  } else if (currentScan && currentPlan) {
    renderAll();
  }
  const modal = document.getElementById('walletModalBackdrop');
  if (modal && !modal.classList.contains('hidden')) {
    renderWalletModalContent();
  }
  if (changed && !silent) {
    showToast(
      uiMode === 'pro'
        ? 'Pro mode enabled — showing routing, EIP batching, proofs, and contract tools.'
        : 'Lite mode enabled — simplified view.'
    );
  }
}

let heroScenePromise = null;
let preservationToolsPromise = null;
let latestSolanaOverview = null;
let pendingBatchSummary = null;
let isPreparingOneClickBatch = false;

function ensureHeroScene() {
  if (heroScene) return Promise.resolve(heroScene);
  if (heroScenePromise) return heroScenePromise;
  const canvas = document.getElementById('turgaliumHeroCanvas');
  if (!canvas) return Promise.resolve(null);
  heroScenePromise = import('./turgalium-3d.js?v=3')
    .then(({ mountTurgaliumFunnelScene }) => {
      if (!heroScene) {
        heroScene = mountTurgaliumFunnelScene(canvas);
        window.__turgaliumHeroScene = heroScene;
        if (document.getElementById('siteShell')?.classList.contains('hidden')) {
          heroScene?.setPaused(true);
        }
      }
      return heroScene;
    })
    .catch(() => {
      heroScenePromise = null;
      return null;
    });
  return heroScenePromise;
}

function ensurePreservationToolsLoaded() {
  if (preservationToolsPromise) return preservationToolsPromise;
  preservationToolsPromise = import('./preservation-tools.js?v=4')
    .then((mod) => {
      if (currentScan) {
        window.dispatchEvent(
          new CustomEvent('turgalium:scan-updated', { detail: { scanReport: currentScan, scan: currentScan } })
        );
      }
      if (latestSolanaOverview) {
        window.dispatchEvent(
          new CustomEvent('turgalium:solana-overview', { detail: latestSolanaOverview })
        );
      }
      dispatchTurgaliumBalanceUpdated();
      return mod;
    })
    .catch((err) => {
      preservationToolsPromise = null;
      throw err;
    });
  return preservationToolsPromise;
}

function showWebsite() {
  document.getElementById('siteShell').classList.remove('hidden');
  document.getElementById('appShell').classList.add('hidden');
  ensureHeroScene().then((scene) => scene?.setPaused(false));
  window.scrollTo({ top: 0, behavior: 'instant' });
  window.dispatchEvent(new Event('resize'));
  renderBackgroundAgentUI();
  renderInflightBridgeBanner();
}

function openApp(viewName = 'scanner') {
  const mapped = viewName === 'burns' || viewName === 'pipeline' ? 'activity' : viewName;
  if (PRO_ONLY_VIEWS.has(mapped) && !isProMode()) {
    setUiMode('pro', { persist: true, silent: true });
  }
  document.getElementById('siteShell').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  heroScene?.setPaused(true);
  ensurePreservationToolsLoaded().catch(() => {});
  switchView(mapped);
  renderInflightBridgeBanner();
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
  if (viewName === 'ai') syncZeroKeyAiFromAppState();
  if (viewName === 'contract' && !contractData) loadContract();
  if (viewName === 'agents') loadAgentsAndPlugins();
  renderBackgroundAgentUI();
  syncMobileStickySweepBar();
}

window.showWebsite = showWebsite;
window.openApp = openApp;
window.switchView = switchView;
window.setUiMode = setUiMode;

function getEffectivePlanFinancials() {
  const t = currentPlan?.totals;
  if (!t) {
    return {
      useTiered: isTieredFeeMode(),
      tieredInfo: computeTieredPreservationFee(0),
      effectiveProtocolFeeUsd: 0,
      effectiveNetUsdc: 0,
      effectiveNetSol: 0,
    };
  }
  const useTiered = isTieredFeeMode();
  const grossUsd = safeNum(t.grossUsd);
  const tieredInfo = computeTieredPreservationFee(grossUsd);
  const hasLegs = Array.isArray(currentPlan?.legs) && currentPlan.legs.length > 0;
  const effectiveProtocolFeeUsd = useTiered && hasLegs ? tieredInfo.feeUsd : safeNum(t.protocolFeeUsd);
  const effectiveNetUsdc =
    useTiered && hasLegs
      ? Math.max(0, Number((safeNum(t.netSolanaUsdc) + safeNum(t.protocolFeeUsd) - tieredInfo.feeUsd).toFixed(2)))
      : safeNum(t.netSolanaUsdc);
  const solPrice =
    safeNum(currentScan?.totals?.solPriceUsd) ||
    (safeNum(t.netSolanaSol) > 0 ? safeNum(t.netSolanaUsdc) / safeNum(t.netSolanaSol) : 70);
  const effectiveNetSol = solPrice > 0 ? effectiveNetUsdc / solPrice : safeNum(t.netSolanaSol);
  return {
    useTiered,
    tieredInfo,
    effectiveProtocolFeeUsd,
    effectiveNetUsdc,
    effectiveNetSol,
  };
}

function dispatchTurgaliumBalanceUpdated() {
  if (typeof window === 'undefined' || typeof CustomEvent !== 'function') return;
  const solDest = document.getElementById('solanaDestInput')?.value.trim() || '';
  const connectedSol = getConnectedSolanaAddress();
  const fin = getEffectivePlanFinancials();
  window.dispatchEvent(
    new CustomEvent('turgalium:balance-updated', {
      detail: {
        solanaUsdc: safeNum(solanaBalances?.usdcBalance),
        solBalance: safeNum(solanaBalances?.solBalance),
        projectedSweepUsdc: fin.effectiveNetUsdc,
        solanaWallet: isValidSolanaBase58(solDest) ? solDest : '',
        connectedSolanaWallet: connectedSol || '',
        walletConnected: Boolean(connectedSol),
      },
    })
  );
}

function applySolanaOverviewPayload(overview, solDest) {
  const badge = document.getElementById('solanaLiveBalanceBadge');
  if (!overview || typeof overview !== 'object') return;
  latestSolanaOverview = overview;
  const bal = overview.balances || overview;
  if (bal && (bal.usdcBalance !== undefined || bal.solBalance !== undefined)) {
    solanaBalances = bal;
  }
  if (badge) {
    if (overview.rpcUnavailable && !solanaBalances) {
      badge.textContent = 'Valid Solana destination (RPC busy)';
    } else if (solanaBalances) {
      const dustCount = Array.isArray(overview.dust?.dustAccounts)
        ? overview.dust.dustAccounts.length
        : 0;
      const dustNote = dustCount > 0 ? ` · ${dustCount} SPL dust` : '';
      badge.textContent = `${safeNum(solanaBalances.usdcBalance).toFixed(2)} USDC · ${safeNum(solanaBalances.solBalance).toFixed(3)} SOL on Solana${dustNote}`;
    } else if (solDest) {
      badge.textContent = 'Valid Solana destination';
    }
  }
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('turgalium:solana-overview', { detail: overview }));
  }
  dispatchTurgaliumBalanceUpdated();
}

async function refreshSolanaBalance() {
  const seq = ++solBalSeq;
  const solDest = document.getElementById('solanaDestInput')?.value.trim() || '';
  const badge = document.getElementById('solanaLiveBalanceBadge');
  syncDestinationUiState();

  if (!solDest) {
    solanaBalances = null;
    latestSolanaOverview = null;
    if (badge) badge.textContent = 'Connect a Solana wallet or enter a destination address';
    dispatchTurgaliumBalanceUpdated();
    return;
  }
  if (!isValidSolanaBase58(solDest)) {
    solanaBalances = null;
    latestSolanaOverview = null;
    if (badge) badge.textContent = 'Invalid Solana address';
    dispatchTurgaliumBalanceUpdated();
    return;
  }

  try {
    const overview = await api('/api/solana/overview', {
      method: 'POST',
      body: JSON.stringify({
        address: solDest,
        dustMaxUsd: 50,
        dustOutputAsset: outputAsset,
      }),
    });
    if (seq !== solBalSeq) return;
    applySolanaOverviewPayload(overview, solDest);
    return;
  } catch (overviewErr) {
    if (seq !== solBalSeq) return;
    const isInvalid = String(overviewErr?.message || '').toLowerCase().includes('invalid');
    if (isInvalid) {
      solanaBalances = null;
      if (badge) badge.textContent = 'Invalid Solana address';
      dispatchTurgaliumBalanceUpdated();
      return;
    }
    // Graceful fallback to lightweight balance endpoint
    try {
      const res = await api(`/api/solana/balance?address=${encodeURIComponent(solDest)}`);
      if (seq !== solBalSeq) return;
      solanaBalances = res;
      if (badge) {
        badge.textContent = `${safeNum(solanaBalances.usdcBalance).toFixed(2)} USDC · ${safeNum(solanaBalances.solBalance).toFixed(3)} SOL on Solana`;
      }
      dispatchTurgaliumBalanceUpdated();
    } catch (err) {
      if (seq !== solBalSeq) return;
      const isBadAddr = String(err?.message || '').toLowerCase().includes('invalid');
      if (badge) {
        badge.textContent = isBadAddr
          ? 'Invalid Solana address'
          : 'Valid Solana destination (RPC busy)';
      }
      dispatchTurgaliumBalanceUpdated();
    }
  }
}

function estimateChainCallCounts() {
  if (!currentScan) return { totalCalls: 0, totalChains: 0, popupsSaved: 0, perChain: new Map() };
  const perChain = new Map();
  const chosen = currentScan.assets.filter(
    (a) => selectedAssetIds.has(a.id) && a.action !== 'SKIP_HONEYPOT' && a.action !== 'SKIP_UNPRICED'
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

function renderEmptyScanState() {
  const meta = familyMetas[activeFamily];
  const famShort = meta?.shortLabel || (activeFamily === 'evm' ? 'EVM' : activeFamily.toUpperCase());

  const badge = document.getElementById('scanModeBadge');
  if (badge) {
    badge.textContent = 'Live RPC';
    badge.classList.remove('is-live');
  }
  const sourceSummaryEl = document.getElementById('sourceSummaryText');
  if (sourceSummaryEl) {
    sourceSummaryEl.textContent = `Connect a ${famShort} wallet or enter an address to scan`;
  }
  const tabLegEl = document.getElementById('tabLegCount');
  if (tabLegEl) tabLegEl.textContent = '0';
  const tabBurnEl = document.getElementById('tabBurnCount');
  if (tabBurnEl) {
    const activeJobsCount = backgroundJobs.filter((j) => j.status === 'active').length;
    tabBurnEl.textContent = String(activeJobsCount);
  }
  const defiPanel = document.getElementById('defiUnwindPanel');
  if (defiPanel) defiPanel.classList.add('hidden');
  const defiGroups = document.getElementById('defiProtocolGroups');
  if (defiGroups) defiGroups.innerHTML = '';
  const chainFilterBar = document.getElementById('chainFilterBar');
  if (chainFilterBar) chainFilterBar.innerHTML = '';
  const assetListBody = document.getElementById('assetListBody');
  if (assetListBody) {
    assetListBody.innerHTML = `<div style="text-align:center; padding:42px 16px; color:var(--ink-3); font-size:13px;">Connect a ${escapeHtml(famShort)} wallet or enter an address above to scan balances across chains.</div>`;
  }
  const chainQueueList = document.getElementById('chainQueueList');
  if (chainQueueList) chainQueueList.innerHTML = '';
  const netEl = document.getElementById('kpiNetUsdc');
  if (netEl) netEl.textContent = outputAsset === 'SOL' ? '0.00 SOL' : '$0.00';
  const subEl = document.getElementById('kpiNetSub');
  if (subEl) subEl.textContent = outputAsset === 'SOL' ? '≈ $0.00 USDC · ~2–15s auto-fill' : '≈ 0.00 SOL · ~2–15s auto-fill';
  const selTextEl = document.getElementById('summarySelectedText');
  if (selTextEl) selTextEl.textContent = '0 assets (0 chains)';
  const fromSumEl = document.getElementById('sweepFromSummary');
  if (fromSumEl) fromSumEl.textContent = '0 assets (0 chains)';
  const liteCostEl = document.getElementById('summaryLiteCostText');
  if (liteCostEl) liteCostEl.textContent = '$0.00';
  const gasEl = document.getElementById('summaryGasText');
  if (gasEl) gasEl.textContent = '$0.00 · 1 click / chain';
  const feeEl = document.getElementById('summaryFeeText');
  if (feeEl) {
    feeEl.textContent = '0% · Free (MIT)';
  }
  const burnCount = document.getElementById('burnManifestCount');
  if (burnCount) burnCount.textContent = '0 tokens';
  const burnBody = document.getElementById('burnTableBody');
  if (burnBody) {
    burnBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:28px; color:var(--ink-3);">Scan a wallet to detect zero-liquidity or honeypot tokens.</td></tr>`;
  }
  const svgHost = document.getElementById('convergenceSvgHost');
  if (svgHost) svgHost.innerHTML = '';
  renderPreSignProofCard(null);
  updateWalletButtons();
  dispatchTurgaliumBalanceUpdated();
  if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('turgalium:scan-cleared', { detail: { family: activeFamily } }));
  }
}

function updateFamilyChrome() {
  const meta = familyMetas[activeFamily];
  document.querySelectorAll('.family-pill[data-family]').forEach((btn) => {
    const fam = btn.dataset.family;
    btn.classList.toggle('active', fam === activeFamily);
    const fMeta = fam ? familyMetas[fam] : null;
    const countEl = btn.querySelector('.family-count');
    if (countEl && fMeta && Array.isArray(fMeta.chains) && fMeta.chains.length > 0) {
      countEl.textContent = String(fMeta.chains.length);
    }
  });
  const appIn = document.getElementById('appEvmInput');
  if (appIn) {
    appIn.placeholder =
      activeFamily === 'evm'
        ? 'Paste any wallet address or .eth name'
        : meta?.addressHint
        ? `Paste ${meta.addressHint} or any address`
        : 'Paste any wallet address or .eth name';
  }
  if (!currentScan) {
    const famShort = meta?.shortLabel || (activeFamily === 'evm' ? 'EVM' : activeFamily.toUpperCase());
    const sourceSummaryEl = document.getElementById('sourceSummaryText');
    if (sourceSummaryEl) {
      sourceSummaryEl.textContent = `Connect a ${famShort} wallet or paste any address to scan`;
    }
    const assetListBody = document.getElementById('assetListBody');
    if (assetListBody) {
      assetListBody.innerHTML = `<div style="text-align:center; padding:36px 16px; color:var(--ink-2); font-size:13px;">Connect a ${escapeHtml(famShort)} wallet or paste an address above to scan balances across chains.</div>`;
    }
  }
  const proofBtn = document.getElementById('verifyProofBtn');
  if (proofBtn) {
    proofBtn.textContent =
      activeFamily === 'evm'
        ? 'Simulate before signing'
        : `Simulate ${meta?.shortLabel || activeFamily.toUpperCase()} before signing`;
  }
  updateWalletButtons();
}

function getScanAddressForSession(family, session) {
  if (!session) return null;
  if (family === 'cosmos' && session.addressesByChain) {
    const multiAddrs = Array.from(new Set(Object.values(session.addressesByChain).filter(Boolean)));
    if (multiAddrs.length > 1) return multiAddrs.join(',');
  }
  return session.address || null;
}

function selectFamily(family, { autoScanConnected = true } = {}) {
  activeFamily = family || 'evm';
  // Default to Direct conversion mode across all families (matches Rabby/EVM UX; users can still toggle Gasless)
  executionMode = 'direct';
  document.querySelectorAll('.mode-opt[data-exec-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.execMode === executionMode);
  });
  updateFamilyChrome();
  const connected = getConnectedFamilyWallet(activeFamily);
  const scanAddr = getScanAddressForSession(activeFamily, connected);
  if (autoScanConnected && scanAddr) {
    runScan({ address: scanAddr, family: activeFamily, autoOpen: false });
  } else if (currentScan && (currentScan.family || 'evm') !== activeFamily) {
    currentScan = null;
    currentPlan = null;
    selectedAssetIds.clear();
    batchRescuedDustIds.clear();
    lastDustPlan = null;
    renderDustStrategyBanner();
    defiStepperState = null;
    const appIn = document.getElementById('appEvmInput');
    if (appIn) appIn.value = '';
    renderEmptyScanState();
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
    const darkCls = needsDarkLogoBacking(logo) ? ' logo-dark-backing' : '';
    evmBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo${darkCls}" /><span>${escapeHtml(srcAddr ? `${shortName}: ${shortAddr(srcAddr)}` : `Connect ${famShort}`)}</span>`;
    evmBtn.classList.toggle('connected', Boolean(srcAddr));
  }
  if (solBtn) {
    const solFull = getConnectedSolanaWalletName();
    const solName = solFull?.split(' ')[0] || 'SOL';
    const logo = solAddr ? getWalletLogoPath(solFull || 'Phantom') : '/logos/solana.svg';
    const darkCls = needsDarkLogoBacking(logo) ? ' logo-dark-backing' : '';
    solBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo${darkCls}" /><span>${escapeHtml(solAddr ? `${solName}: ${shortAddr(solAddr)}` : 'Connect Solana')}</span>`;
    solBtn.classList.toggle('connected', Boolean(solAddr));
  }
  if (siteBtn) {
    const shortName = walletName ? walletName.split(' ')[0] : null;
    if (srcAddr) {
      const logo = getWalletLogoPath(walletName);
      const darkCls = needsDarkLogoBacking(logo) ? ' logo-dark-backing' : '';
      siteBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo${darkCls}" /><span class="site-connect-label">${escapeHtml(`${shortName ? `${shortName} · ` : ''}${shortAddr(srcAddr)}`)}</span>`;
    } else if (solAddr) {
      const logo = getWalletLogoPath(getConnectedSolanaWalletName() || 'Phantom');
      const darkCls = needsDarkLogoBacking(logo) ? ' logo-dark-backing' : '';
      siteBtn.innerHTML = `<img src="${escapeHtml(logo)}" alt="" class="btn-logo${darkCls}" /><span class="site-connect-label">${escapeHtml(`SOL · ${shortAddr(solAddr)}`)}</span>`;
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
    const n = currentPlan ? currentPlan.legs.length : 0;
    if (n === 0) {
      ctaBtn.textContent = 'Select assets to sweep';
      ctaBtn.disabled = true;
    } else if (isPreparingOneClickBatch) {
      ctaBtn.textContent = 'Preparing 1-Click Sweep…';
      ctaBtn.disabled = true;
    } else if (isSweepQueueRunning) {
      ctaBtn.textContent = 'Sweep in progress…';
      ctaBtn.disabled = true;
    } else if (!srcAddr) {
      ctaBtn.textContent = isProMode()
        ? `Connect ${famShort} Wallet to Sweep (${n} ${n === 1 ? 'Chain' : 'Chains'})`
        : `Connect ${famShort} Wallet to Sweep`;
      ctaBtn.disabled = false;
    } else if (pendingBatchSummary) {
      const sigs = Math.max(1, safeInt(pendingBatchSummary.batch?.totalSignatures || n));
      ctaBtn.textContent = `Confirm & Sign Sweep (${sigs} ${sigs === 1 ? 'sig' : 'sigs'})`;
      ctaBtn.disabled = false;
    } else if (!isProMode()) {
      ctaBtn.textContent = '1-Click Sweep to Solana';
      ctaBtn.disabled = false;
    } else if (executionMode === 'gasless') {
      ctaBtn.textContent = `1-Click Gasless Sweep (${n} ${n === 1 ? 'Chain' : 'Chains'})`;
      ctaBtn.disabled = false;
    } else {
      ctaBtn.textContent = `1-Click Sweep (${n} ${n === 1 ? 'Chain' : 'Chains'})`;
      ctaBtn.disabled = false;
    }
  }
  if (ctaNote) {
    if (!isProMode()) {
      ctaNote.textContent = 'Sweeps directly to your Solana wallet';
    } else if (activeFamily !== 'evm' && meta?.gasSponsorshipMechanism) {
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
  syncMobileStickySweepBar();
}

let primaryCtaInView = true;
let scanSeq = 0;

function syncMobileStickySweepBar() {
  const bar = document.getElementById('mobileStickySweepBar');
  if (!bar) return;
  const appVisible = !document.getElementById('appShell')?.classList.contains('hidden');
  const isScanner = activeView === 'scanner';
  const isNarrow = typeof window !== 'undefined' && window.innerWidth <= 720;
  const legs = currentPlan?.legs || [];
  const ctaBtn = document.getElementById('runLiveQueueBtn');
  const shouldShow =
    appVisible && isScanner && isNarrow && legs.length > 0 && !primaryCtaInView && Boolean(ctaBtn);
  bar.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) return;
  const fin = getEffectivePlanFinancials();
  const valEl = document.getElementById('mobileStickySweepVal');
  const subEl = document.getElementById('mobileStickySweepSub');
  const btnEl = document.getElementById('mobileStickySweepBtn');
  if (valEl) valEl.textContent = fmtUsd(fin.effectiveNetUsdc);
  if (subEl) {
    const assetCount = selectedAssetIds.size;
    subEl.textContent = `${assetCount} ${assetCount === 1 ? 'asset' : 'assets'} · ${legs.length} ${legs.length === 1 ? 'chain' : 'chains'} · 0% fee`;
  }
  if (btnEl && ctaBtn) {
    btnEl.textContent = isPreparingOneClickBatch
      ? 'Preparing…'
      : isSweepQueueRunning
      ? 'Sweeping…'
      : pendingBatchSummary
      ? 'Confirm Sweep'
      : `1-Click Sweep (${legs.length})`;
    btnEl.disabled = Boolean(ctaBtn.disabled);
  }
}

async function runScan({
  address = null,
  presetId = null,
  family = null,
  chains = null,
  refresh = false,
  autoOpen = false,
} = {}) {
  const cleanAddr = String(address || '').trim();
  const cleanPreset = String(presetId || '').trim();
  if (!cleanAddr && !cleanPreset) {
    showToast('Enter a wallet address to scan.');
    return;
  }
  const seq = ++scanSeq;
  heroScene?.setActive(true);
  clearOneClickSweepSummary();
  const scanBtn = document.getElementById('appScanBtn');
  if (scanBtn) {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning…';
  }
  const badge = document.getElementById('scanModeBadge');
  const rawSolDest = document.getElementById('solanaDestInput')?.value.trim() || '';
  const hasValidDest = Boolean(rawSolDest && isValidSolanaBase58(rawSolDest));
  const usePermit2Batch = Boolean(document.getElementById('permit2Toggle')?.checked ?? true);
  const includeBurns = Boolean(document.getElementById('burnToggle')?.checked ?? false);
  const bridgePreference = getActiveBridgePreference();

  const applyScannedReport = (scan) => {
    currentScan = scan;
    batchRescuedDustIds.clear();
    lastDustPlan = null;
    renderDustStrategyBanner();
    if (scan.family && scan.family !== activeFamily) {
      activeFamily = scan.family;
    }
    updateFamilyChrome();
    activeChainFilter = 'all';
    defiStepperState = null;
    renderPreSignProofCard(null);
    clearOneClickSweepSummary();

    selectedAssetIds = new Set(
      currentScan.assets.filter((a) => a.selectedByDefault).map((a) => a.id)
    );

    const appIn = document.getElementById('appEvmInput');
    if (appIn) appIn.value = currentScan.walletAddress;
    if (cleanAddr || cleanPreset) {
      const heroIn = document.getElementById('heroWalletInput');
      if (heroIn) heroIn.value = currentScan.walletAddress;
    }
  };

  try {
    // 1-round-trip hydration via POST /api/workspace/hydrate (scan + plan + preservation + Solana overview)
    let hydrated = null;
    let fallbackToScan = false;
    try {
      const hydrateBody = {
        ...(cleanPreset ? { presetId: cleanPreset } : { address: cleanAddr }),
        family: family || activeFamily,
        ...(Array.isArray(chains) && chains.length ? { chains } : {}),
        ...(refresh ? { refresh: true } : {}),
        ...(hasValidDest ? { solanaDestination: rawSolDest } : {}),
        outputAsset,
        bridgePreference,
        usePermit2Batch,
        includeBurns,
        includePreservation: true,
        includeSolanaOverview: hasValidDest,
      };
      const hydrateRes = await fetch('/api/workspace/hydrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hydrateBody),
      });
      if (hydrateRes.ok) {
        hydrated = await hydrateRes.json();
      } else if (hydrateRes.status === 404 || hydrateRes.status === 405 || hydrateRes.status === 501) {
        fallbackToScan = true;
      } else {
        const errData = await hydrateRes.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${hydrateRes.status}`);
      }
    } catch (hydrateErr) {
      if (!fallbackToScan && !(hydrateErr instanceof TypeError)) {
        throw hydrateErr;
      }
      fallbackToScan = true;
    }

    if (seq !== scanSeq) return;

    if (hydrated && hydrated.scan && hydrated.plan) {
      applyScannedReport(hydrated.scan);

      if (hydrated.solanaOverview) {
        applySolanaOverviewPayload(hydrated.solanaOverview, rawSolDest);
      } else if (hydrated.solanaBalances) {
        solanaBalances = hydrated.solanaBalances;
        const solBadge = document.getElementById('solanaLiveBalanceBadge');
        if (solBadge) {
          solBadge.textContent = `${safeNum(solanaBalances.usdcBalance).toFixed(2)} USDC · ${safeNum(solanaBalances.solBalance).toFixed(3)} SOL on Solana`;
        }
      }

      if (badge) {
        const totalMs =
          typeof hydrated.timingMs === 'number'
            ? hydrated.timingMs
            : typeof hydrated.timingMs?.total === 'number'
            ? hydrated.timingMs.total
            : currentScan.scanDurationMs;
        badge.textContent = `${hydrated.cached ? 'Instant' : 'Live'} · ${Math.round(safeNum(totalMs))}ms`;
        badge.classList.toggle('is-live', currentScan.mode === 'live_rpc');
      }

      currentPlan = {
        ...hydrated.plan,
        solanaDestination: hasValidDest ? rawSolDest : '',
      };
      renderAll();
      if (autoOpen) openApp('scanner');
      return;
    }

    // Graceful NDJSON streaming fallback to POST /api/scan
    const payload = { address: cleanAddr, family: family || activeFamily };
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson, application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${res.status}`);
    }
    let scan = null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/x-ndjson') && res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev = null;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (seq !== scanSeq) {
            reader.cancel().catch(() => {});
            return;
          }
          if (ev.type === 'chain' && scanBtn) {
            scanBtn.textContent = `Scanning ${ev.completed}/${ev.total}…`;
            if (badge) badge.textContent = `Scanning ${ev.completed}/${ev.total} chains…`;
          } else if (ev.type === 'done' && ev.report) {
            scan = ev.report;
          } else if (ev.type === 'error') {
            throw new Error(ev.error || 'Wallet scan failed.');
          }
        }
      }
      if (!scan) throw new Error('Scan stream ended before completing.');
    } else {
      scan = await res.json();
    }
    if (seq !== scanSeq) return;
    applyScannedReport(scan);

    if (badge) {
      badge.textContent = `Live · ${currentScan.scanDurationMs}ms`;
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
  const cctpOpt = select ? Array.from(select.options).find((o) => o.value === 'cctp') : null;
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
  clearOneClickSweepSummary();
  const seq = ++planSeq;
  const rawSolDest = document.getElementById('solanaDestInput')?.value.trim() || '';
  const hasValidDest = Boolean(rawSolDest && isValidSolanaBase58(rawSolDest));
  const previewSolDest = hasValidDest ? rawSolDest : PREVIEW_SOLANA_PLACEHOLDER;
  const usePermit2Batch = document.getElementById('permit2Toggle').checked;
  const includeBurns = document.getElementById('burnToggle').checked;
  const bridgePreference = getActiveBridgePreference();
  const protocolFeeBps = getActiveProtocolFeeBps();
  const feeRecipientEvm = getActiveFeeRecipientEvm();
  const effectiveScan = buildEffectiveScanForPlan();

  try {
    const plan = await api('/api/plan', {
      method: 'POST',
      body: JSON.stringify({
        scan: effectiveScan,
        selectedAssetIds: Array.from(selectedAssetIds),
        solanaDestination: previewSolDest,
        usePermit2Batch,
        includeBurns,
        outputAsset,
        bridgePreference,
        protocolFeeBps,
        feeRecipientEvm,
        hasSolanaUsdcAta: solanaBalances ? Boolean(solanaBalances.hasUsdcAta) : undefined,
      }),
    });
    if (seq !== planSeq) return;
    currentPlan = {
      ...plan,
      solanaDestination: hasValidDest ? rawSolDest : '',
    };
    renderAll();
  } catch (err) {
    if (seq === planSeq) showToast(err.message);
  }
}

function renderAll() {
  if (!currentScan || !currentPlan) return;
  updateWalletButtons();

  const t = currentPlan.totals;
  const pref = currentPlan.bridgePreference || getActiveBridgePreference();
  const feePct = currentPlan.protocolFeePercent ?? (getActiveProtocolFeeBps() ?? 0) / 100;
  const stats = estimateChainCallCounts();

  // Topbar counters
  const tabLegEl = document.getElementById('tabLegCount');
  if (tabLegEl) tabLegEl.textContent = String(currentPlan.legs.length);
  const tabBurnEl = document.getElementById('tabBurnCount');
  const activeJobsCount = backgroundJobs.filter((j) => j.status === 'active').length;
  if (tabBurnEl) {
    tabBurnEl.textContent = String(
      isProMode() ? activeJobsCount || currentPlan.burnManifest.length : activeJobsCount
    );
  }

  // Quiet source strip summary
  const sourceSummaryEl = document.getElementById('sourceSummaryText');
  if (sourceSummaryEl) {
    const activeChainCount = currentScan.chains.filter((c) => c.assetCount > 0).length;
    const blockedNote =
      isProMode() && t.honeypotsSkippedCount > 0 ? ` · ${t.honeypotsSkippedCount} honeypot blocked` : '';
    sourceSummaryEl.textContent = `$${currentScan.totals.grossUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })} across ${activeChainCount} ${activeChainCount === 1 ? 'chain' : 'chains'}${blockedNote}`;
  }

  // Right Sticky Sweep Card: Payout Hero
  const payoutLogo = document.getElementById('payoutAssetLogo');
  if (payoutLogo) payoutLogo.src = outputAsset === 'SOL' ? '/logos/solana.svg' : '/logos/usdc.svg';

  const fin = getEffectivePlanFinancials();
  const netEl = document.getElementById('kpiNetUsdc');
  if (netEl) {
    netEl.textContent =
      outputAsset === 'SOL'
        ? `${fin.effectiveNetSol.toFixed(2)} SOL`
        : `$${fin.effectiveNetUsdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  dispatchTurgaliumBalanceUpdated();
  const subEl = document.getElementById('kpiNetSub');
  if (subEl) {
    const eta = !isProMode()
      ? 'arrives in seconds'
      : pref === 'cctp'
      ? `~${t.estimatedFastestSec || 20}s Circle CCTP`
      : '~2–15s auto-fill';
    subEl.textContent =
      outputAsset === 'SOL'
        ? `≈ $${fin.effectiveNetUsdc.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC · ${eta}`
        : `≈ ${fin.effectiveNetSol.toFixed(2)} SOL · ${eta}`;
  }

  // Receipt Summary Rows & From Well
  const selTextEl = document.getElementById('summarySelectedText');
  const fromSumEl = document.getElementById('sweepFromSummary');
  {
    const assetCount = t.tokensSoldCount + t.defiWithdrawnCount;
    const chainCount = currentPlan.legs.length;
    const burnPart = isProMode() && t.tokensBurnedCount > 0 ? ` · ${t.tokensBurnedCount} burns` : '';
    const summaryStr = `${assetCount} ${assetCount === 1 ? 'asset' : 'assets'}${burnPart} (${chainCount} ${chainCount === 1 ? 'chain' : 'chains'})`;
    if (selTextEl) selTextEl.textContent = summaryStr;
    if (fromSumEl) {
      const grossSelectedUsd = safeNum(t.grossUsd);
      fromSumEl.textContent =
        assetCount > 0 && grossSelectedUsd > 0
          ? `${fmtUsd(grossSelectedUsd)} · ${assetCount} ${assetCount === 1 ? 'asset' : 'assets'} (${chainCount} ${chainCount === 1 ? 'chain' : 'chains'})`
          : summaryStr;
    }
  }
  const liteCostEl = document.getElementById('summaryLiteCostText');
  if (liteCostEl) {
    const combinedFees = safeNum(t.totalGasUsd) + fin.effectiveProtocolFeeUsd;
    liteCostEl.textContent =
      currentPlan.legs.length > 0
        ? `~$${combinedFees.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : '$0.00';
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
    feeEl.textContent = '0% · Free (MIT)';
  }

  // Activity view topology SVG
  const flowMeta = document.getElementById('flowSummaryMeta');
  if (flowMeta) {
    flowMeta.textContent = `${currentPlan.legs.length} active chain(s) · ${t.selectedAssets} selected · ~$${t.totalGasUsd.toFixed(2)} est. gas`;
  }
  const svgHost = document.getElementById('convergenceSvgHost');
  if (svgHost) {
    const svgPlan = {
      ...currentPlan,
      effectiveFeeLabel: fin.useTiered ? fin.tieredInfo.feePercentLabel : `${feePct}%`,
      totals: {
        ...t,
        effectiveProtocolFeeUsd: fin.useTiered ? fin.tieredInfo.feeUsd : safeNum(t.protocolFeeUsd),
        effectiveNetSolanaUsdc: fin.netUsdc,
        effectiveNetSolanaSol: fin.netSol,
      },
    };
    svgHost.innerHTML = renderConvergenceSvg(svgPlan, currentScan);
  }

  renderDefiUnwindPanel();
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
    const logoPath = getChainLogoPath(c.chain);
    const darkCls = needsDarkLogoBacking(c.chain) ? ' logo-dark-backing' : '';
    chips.push(`
      <button type="button" class="chain-chip ${activeChainFilter === c.chain ? 'active' : ''}" data-chain-filter="${escapeHtml(c.chain)}">
        <img src="${escapeHtml(logoPath)}" alt="" class="chain-logo-xs${darkCls}" />
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
    `Turgalium fee $${(bd.protocolFeeUsd || 0).toFixed(2)}`,
  ].filter(Boolean);
  return `${parts.join(' + ')} = $${(bd.totalCostUsd || 0).toFixed(2)} total cost`;
}

function renderRoiVerdictBadge(a) {
  if (a.action === 'SKIP_HONEYPOT') return `<span class="action-tag tag-skip">Honeypot</span>`;
  if (a.action === 'SKIP_UNPRICED') return `<span class="action-tag tag-skip" title="${escapeHtml(a.actionReason || 'Price or liquidity lookup unavailable')}">Unpriced</span>`;
  if (a.action === 'BURN_ZERO_LIQUIDITY') return `<span class="action-tag tag-burn">Burn $0</span>`;
  if (isDefiAsset(a) && a.defiExitPlan?.preflightStatus === 'blocked') {
    const tip = escapeHtml(a.defiExitPlan?.preflightReason || a.actionReason || '');
    if (a.defiExitPlan.exitStrategy === 'cooldown_blocked' || a.defiExitPlan.cooldownDetected) {
      return `<span class="roi-pill roi-low" title="${tip}">Locked</span>`;
    }
    if ((a.defiDebtUsd || a.defiExitPlan.debtUsd || 0) > 0) {
      return `<span class="roi-pill roi-low" title="${tip}">Debt Guard</span>`;
    }
    if (a.defiExitPlan.exitStrategy === 'external_app_exit') {
      return `<span class="action-tag tag-defi" title="${tip}">Protocol App</span>`;
    }
  }
  const v = a.roiVerdict;
  const pct = typeof a.effectiveCostPct === 'number' ? a.effectiveCostPct.toFixed(0) : null;
  const net = typeof a.netRoiUsd === 'number' ? a.netRoiUsd : null;
  const tip = escapeHtml(formatRoiTooltip(a));
  if (v === 'worth_it') {
    return `<span class="roi-pill roi-worth" title="${tip}">Worth It</span>`;
  }
  if (v === 'low_efficiency') {
    if (typeof a.effectiveCostPct === 'number' && a.effectiveCostPct < 15) {
      return `<span class="roi-pill roi-low" title="${tip}">Small Balance</span>`;
    }
    return `<span class="roi-pill roi-low" title="${tip}">High Cost (${pct ?? '—'}% fees)</span>`;
  }
  if (v === 'negative_roi' || a.action === 'SKIP_GAS_NEGATIVE' || a.action === 'SKIP_NEGATIVE_ROI') {
    if (net !== null && net > 0) {
      const posStr = `$${net.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      return `<span class="roi-pill roi-low" title="${tip}">Unroutable (Est. ${posStr})</span>`;
    }
    const negAbs = net !== null ? Math.abs(net) : 0;
    const signedStr = `-$${negAbs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return `<span class="roi-pill roi-neg" title="${tip}">Negative ROI (${signedStr})</span>`;
  }
  return compactActionTag(a.action);
}

function compactActionTag(action) {
  if (action === 'WITHDRAW_AND_BRIDGE') return `<span class="action-tag tag-defi">1-Click Exit</span>`;
  if (action === 'BRIDGE_DIRECT_USDC') return `<span class="action-tag tag-direct">USDC</span>`;
  if (action === 'SELL_AND_BRIDGE') return `<span class="action-tag tag-sell">Swap</span>`;
  if (action === 'BURN_ZERO_LIQUIDITY') return `<span class="action-tag tag-burn">Burn</span>`;
  if (action === 'SKIP_HONEYPOT') return `<span class="action-tag tag-skip">Honeypot</span>`;
  if (action === 'SKIP_UNPRICED') return `<span class="action-tag tag-skip">Unpriced</span>`;
  return `<span class="action-tag tag-skip">Dust</span>`;
}

// =====================================================================
// DEDICATED DEFI QUICK-UNWIND PANEL & AUTOMATIC GUIDED STEPPER
// =====================================================================

function isDefiAsset(a) {
  return Boolean(a && (a.kind === 'defi_position' || a.action === 'WITHDRAW_AND_BRIDGE' || a.defiExitPlan));
}

function sanitizePlainDefiText(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/\bWITHDRAW_AND_BRIDGE\b/g, 'protocol withdrawal')
    .replace(/\bSELL_AND_BRIDGE\b/g, 'instant swap')
    .replace(/\bBRIDGE_DIRECT_USDC\b/g, 'direct bridge')
    .replace(/\bComet\.withdraw\([^)]*\)/gi, 'Compound withdrawal')
    .replace(/\bPool\.withdraw\([^)]*\)/gi, 'Aave withdrawal')
    .replace(/\bERC4626\.redeem\([^)]*\)/gi, 'Vault withdrawal')
    .replace(/\b0x[0-9a-fA-F]{8,}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function getProtocolGroupName(asset) {
  const raw = String(
    asset?.defiExitPlan?.protocolName || asset?.defiExitPlan?.protocol || asset?.protocol || ''
  ).trim();
  const low = raw.toLowerCase();
  if (low.includes('aave')) return 'Aave v3';
  if (low.includes('compound')) return 'Compound v3';
  if (low.includes('morpho')) return 'Morpho / Vaults';
  if (low.includes('lido')) return 'Lido';
  if (low.includes('uniswap')) return 'Uniswap LP';
  if (low.includes('curve')) return 'Curve';
  if (low.includes('spark')) return 'Spark Vaults';
  if (low.includes('sky')) return 'Sky Vaults';
  if (low.includes('ethena')) return 'Ethena Vaults';
  if (low.includes('erc-4626') || low.includes('erc4626') || low === 'vault') return 'Morpho / Vaults';
  if (low.includes('cosmos')) return 'Cosmos Staking';
  if (low.includes('sui')) return 'Sui Staking';
  return raw || 'DeFi Vaults';
}

function getPlainDisplayToken(asset, plan) {
  const sym = String(asset?.symbol || '').trim();
  const underlying = String(plan?.underlyingSymbol || asset?.underlyingSymbol || '').trim();
  if (!underlying) return sym || 'Token';
  const lowSym = sym.toLowerCase();
  const isReceiptToken =
    lowSym.startsWith('aeth') ||
    lowSym.startsWith('aarb') ||
    lowSym.startsWith('apol') ||
    lowSym.startsWith('abas') ||
    lowSym.startsWith('aopt') ||
    lowSym.startsWith('aava') ||
    lowSym.startsWith('cusdc') ||
    lowSym.startsWith('cweth') ||
    lowSym.startsWith('sdai') ||
    lowSym.startsWith('susds') ||
    lowSym.startsWith('susde') ||
    lowSym.startsWith('gt') ||
    lowSym.startsWith('mw') ||
    lowSym.startsWith('yv') ||
    lowSym.includes('vault');
  if (isReceiptToken) return underlying;
  return sym || underlying;
}

function normalizeDefiPosition(asset, targetOut = outputAsset) {
  const plan = asset?.defiExitPlan && typeof asset.defiExitPlan === 'object' ? asset.defiExitPlan : null;
  const backendDisplay =
    asset?.defiDisplay && typeof asset.defiDisplay === 'object' ? asset.defiDisplay : null;
  const protocolGroup =
    plan?.protocolName || plan?.protocol
      ? getProtocolGroupName(asset)
      : backendDisplay?.protocolGroup || getProtocolGroupName(asset);
  const localLogo = getProtocolLogoPath(protocolGroup) || getProtocolLogoPath(asset?.protocol) || '/logos/vault.svg';
  const remoteLogo = safeHttpUrl(asset?.protocolLogoUrl || plan?.protocolLogoUrl);
  const protocolLogo = localLogo === '/logos/vault.svg' && remoteLogo ? remoteLogo : localLogo;
  const protocolUrl = safeHttpUrl(asset?.protocolUrl || plan?.protocolUrl);
  const chainLogo = getChainLogoPath(asset?.chain);
  const modeRaw = String(
    plan?.exitStrategy || plan?.routeKind || plan?.mode || plan?.exitMode || plan?.strategy || ''
  ).toLowerCase();
  const statusRaw = String(plan?.preflightStatus || plan?.status || plan?.healthStatus || '').toLowerCase();
  const protoLow = protocolGroup.toLowerCase();

  const debtUsd = Number(asset?.aaveDebtUsd || asset?.defiDebtUsd || plan?.debtUsd || 0);
  const netUsd =
    typeof asset?.defiNetUsd === 'number'
      ? asset.defiNetUsd
      : typeof plan?.netUsd === 'number'
      ? plan.netUsd
      : null;
  const healthFactor =
    typeof asset?.aaveHealthFactor === 'number'
      ? asset.aaveHealthFactor
      : typeof asset?.defiHealthFactor === 'number'
      ? asset.defiHealthFactor
      : typeof plan?.projectedHealthFactor === 'number'
      ? plan.projectedHealthFactor
      : null;
  const unlockAt = Number(asset?.defiUnlockAt || plan?.unlockAt || 0);
  const isExternalApp = Boolean(
    plan?.protocolId === 'external_protocol' ||
      plan?.exitStrategy === 'external_app_exit' ||
      plan?.routeKind === 'external_app'
  );

  const hasDebt = Boolean(
    plan?.debtGuardActive ||
      modeRaw.includes('debt') ||
      modeRaw.includes('partial') ||
      debtUsd > 0
  );
  const explicitSwapStrategy = Boolean(
    modeRaw.includes('direct_swap') ||
      modeRaw.includes('instant_dex_swap') ||
      modeRaw.includes('swap') ||
      asset?.stakedExitMode === 'instant_liquid_stake'
  );
  const hasCooldown = Boolean(
    !explicitSwapStrategy &&
      (plan?.cooldownDetected ||
        modeRaw.includes('cooldown') ||
        modeRaw.includes('unbonding') ||
        modeRaw.includes('lock') ||
        modeRaw.includes('unstake') ||
        statusRaw === 'cooldown' ||
        statusRaw === 'locked' ||
        unlockAt > Math.floor(Date.now() / 1000) ||
        asset?.stakedExitMode === 'native_unstake' ||
        asset?.stakedExitMode === 'scheduled_authz_autosweep')
  );
  const isInstantSwap = Boolean(
    explicitSwapStrategy || (!hasCooldown && protoLow.includes('lido'))
  );

  let category = 'one_click';
  if (hasCooldown) category = 'cooldown';
  else if (hasDebt) category = 'debt_guard';
  else if (isInstantSwap) category = 'instant_swap';
  else if (isExternalApp) category = 'external_app';

  const defaultBadges = {
    one_click: { icon: 'zap', text: '1-Click Extract → Solana' },
    instant_swap: { icon: 'refresh-cw', text: 'Instant Swap (Skips Cooldown)' },
    debt_guard: isExternalApp
      ? { icon: 'shield-alert', text: 'Active Borrow · Protocol App' }
      : { icon: 'shield-check', text: 'Safe Partial (Debt Guard)' },
    cooldown: { icon: 'clock', text: 'Cooldown / Locked' },
    external_app: { icon: 'external-link', text: 'Protocol App Position' },
  };
  let badgeIcon = defaultBadges[category]?.icon || 'zap';
  const badgeText =
    plan?.badgeLabel || plan?.humanBadge
      ? sanitizePlainDefiText(plan.badgeLabel || plan.humanBadge)
      : defaultBadges[category].text;

  const underlyingSym = String(plan?.underlyingSymbol || asset?.underlyingSymbol || asset?.symbol || 'USDC');
  const displayToken = getPlainDisplayToken(asset, plan);
  const withdrawableUi =
    typeof plan?.withdrawableUi === 'number'
      ? plan.withdrawableUi
      : typeof plan?.maxSafeWithdrawUi === 'number'
      ? plan.maxSafeWithdrawUi
      : typeof plan?.expectedUnderlyingUi === 'number' && plan.expectedUnderlyingUi > 0
      ? plan.expectedUnderlyingUi
      : Number(asset?.uiBalance || 0);
  const amountFmt = formatCompactBalance(withdrawableUi);

  const isNonUsdcContractExit =
    category === 'one_click' &&
    !isInstantSwap &&
    underlyingSym.toUpperCase() !== 'USDC' &&
    asset?.family !== 'cosmos' &&
    asset?.family !== 'sui';
  const requiresTwoStep = Boolean(
    plan?.requiresSecondStep || plan?.twoStep || plan?.requiresFollowUpBridge || isNonUsdcContractExit
  );
  const sigCount =
    typeof plan?.signaturesRequired === 'number'
      ? plan.signaturesRequired
      : typeof plan?.signatureCount === 'number'
      ? plan.signatureCount
      : requiresTwoStep || category === 'cooldown'
      ? 2
      : 1;
  const sigLabel = sigCount <= 1 ? '1 signature' : `${sigCount} guided steps`;

  // Pre-flight status pill & plain-English warning reason
  let preflightLevel = 'verified'; // 'verified' | 'warn' | 'blocked'
  let preflightIcon = 'check';
  let preflightLabel = 'Verified withdrawable';
  let warningReason = '';

  const isZeroValueDefi =
    Number(asset?.grossUsd || 0) <= 0 || asset?.action === 'BURN_ZERO_LIQUIDITY';
  const explicitlyBlocked = Boolean(
    plan?.blocked ||
      statusRaw === 'blocked' ||
      statusRaw === 'reverted' ||
      statusRaw === 'failed' ||
      asset?.action === 'SKIP_HONEYPOT' ||
      asset?.action === 'SKIP_UNPRICED'
  );
  const safePartialReady = Boolean(
    plan?.safePartialSupported ||
      plan?.exitStrategy === 'safe_partial_debt_exit' ||
      (typeof plan?.maxSafeWithdrawUi === 'number' && plan.maxSafeWithdrawUi > 0) ||
      (typeof plan?.safeMaxWithdrawUsd === 'number' && plan.safeMaxWithdrawUsd > 0)
  );
  const planReason = sanitizePlainDefiText(
    plan?.blockReason || plan?.preflightReason || plan?.preflightMessage || plan?.warning || plan?.reason
  );

  if (explicitlyBlocked && hasCooldown) {
    preflightLevel = 'blocked';
    preflightIcon = 'lock';
    const unlockStr =
      unlockAt > 0
        ? new Date(unlockAt * 1000).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            timeZone: 'UTC',
          })
        : '';
    preflightLabel = unlockStr ? `Locked until ${unlockStr}` : 'Locked';
    warningReason =
      planReason || 'This position is currently locked and must unlock before it can be withdrawn.';
  } else if (explicitlyBlocked && hasDebt) {
    preflightLevel = 'blocked';
    preflightIcon = 'shield-alert';
    preflightLabel =
      healthFactor !== null
        ? `Debt guard · HF ${healthFactor.toFixed(2)}`
        : 'Debt guard active';
    warningReason =
      planReason ||
      `Active borrow of $${debtUsd.toFixed(2)}. Repay debt or manage directly on ${protocolGroup}.`;
  } else if (explicitlyBlocked && isExternalApp) {
    preflightLevel = 'blocked';
    preflightIcon = 'external-link';
    preflightLabel = `Manage on ${protocolGroup}`;
    warningReason =
      planReason ||
      `Withdraw on ${protocolGroup}, then sweep unlocked ${displayToken} to Solana.`;
  } else if (explicitlyBlocked) {
    preflightLevel = 'blocked';
    preflightIcon = 'x-circle';
    preflightLabel = 'Cannot withdraw';
    warningReason = planReason || 'Pre-flight check detected a restriction on this position.';
  } else if (hasCooldown) {
    preflightLevel = 'warn';
    preflightIcon = 'clock';
    preflightLabel = 'Cooldown required';
    warningReason =
      planReason ||
      sanitizePlainDefiText(plan?.cooldownLabel) ||
      'This protocol requires an unbonding cooldown period before tokens can be bridged to Solana.';
  } else if (hasDebt) {
    preflightLevel = safePartialReady ? 'warn' : 'blocked';
    preflightIcon = safePartialReady ? 'shield-check' : 'shield-alert';
    preflightLabel = safePartialReady ? 'Safe partial ready' : 'Debt guard active';
    const debtStr = debtUsd > 0 ? `$${debtUsd.toFixed(2)}` : 'active';
    const hfStr = healthFactor !== null ? ` (health factor ${healthFactor.toFixed(2)})` : '';
    warningReason =
      planReason ||
      (safePartialReady
        ? `Active borrow of ${debtStr}${hfStr}. Turgalium withdraws only the safe excess collateral.`
        : `Active borrow of ${debtStr}${hfStr}. Repay borrow before full withdrawal to protect your position.`);
  } else if (isZeroValueDefi) {
    preflightLevel = 'blocked';
    preflightIcon = 'ban';
    preflightLabel = 'Zero Liquidity · Unextractable';
    warningReason = 'No verified withdrawable liquidity ($0.00). Position cannot be extracted to Solana.';
  } else if (asset?.roiVerdict === 'negative_roi') {
    preflightLevel = 'blocked';
    preflightIcon = 'ban';
    preflightLabel = 'Fees exceed value';
    const cleanedReason = sanitizePlainDefiText(plan?.preflightMessage || asset?.actionReason);
    warningReason =
      cleanedReason && !/opt-in burn|0x\.\.\.dead/i.test(cleanedReason)
        ? cleanedReason
        : 'Estimated network and bridge costs exceed the withdrawable value.';
  } else if (asset?.roiVerdict === 'low_efficiency') {
    preflightLevel = 'warn';
    preflightIcon = 'alert-triangle';
    if (typeof asset?.effectiveCostPct === 'number' && asset.effectiveCostPct < 15) {
      preflightLabel = 'Small balance';
      const valUsd = safeNum(asset?.grossUsd).toFixed(2);
      warningReason = `Verified withdrawable ($${valUsd}). Small balance — best swept together with other assets on this chain.`;
    } else {
      preflightLabel = 'High network cost';
      const pct = typeof asset?.effectiveCostPct === 'number' ? `${asset.effectiveCostPct.toFixed(0)}%` : 'elevated';
      warningReason = `Verified withdrawable, though total fees are ${pct} of position value.`;
    }
  } else if (statusRaw === 'warn' || statusRaw === 'warning' || statusRaw === 'caution') {
    preflightLevel = 'warn';
    preflightIcon = 'alert-triangle';
    preflightLabel = sanitizePlainDefiText(plan?.preflightLabel) || 'Review before exit';
    warningReason = planReason || '';
  }

  let finalBadgeText = badgeText;
  if (preflightLevel === 'blocked' && (category === 'one_click' || category === 'instant_swap')) {
    category = 'blocked';
    badgeIcon = 'ban';
    finalBadgeText = isZeroValueDefi
      ? 'Zero Liquidity · Unextractable'
      : asset?.roiVerdict === 'negative_roi'
      ? 'Unextractable · Fees Exceed Value'
      : 'Blocked · Cannot Extract';
  }

  const posType = asset?.defiPositionType || plan?.positionType || '';
  const customRoute = plan?.routeLine || plan?.routeSummary || plan?.plainRoute;
  let routeLine;
  if (customRoute && category !== 'blocked') {
    routeLine = sanitizePlainDefiText(customRoute);
  } else if (isExternalApp && hasDebt) {
    const netPart = netUsd !== null ? ` · Net $${netUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '';
    const hfPart = healthFactor !== null ? ` · HF ${healthFactor.toFixed(2)}` : '';
    routeLine = `${protocolGroup} (${asset?.chainName || asset?.chain}) · ${amountFmt} ${displayToken} supplied${netPart}${hfPart}`;
  } else if (isExternalApp || category === 'blocked') {
    routeLine = `${protocolGroup} (${asset?.chainName || asset?.chain}) · ${amountFmt} ${displayToken}${posType ? ` · ${posType}` : ''}`;
  } else {
    routeLine = `${protocolGroup} (${asset?.chainName || asset?.chain}) · ${amountFmt} ${displayToken} → Solana ${targetOut} · ${sigLabel}`;
  }

  const isReady =
    !isExternalApp &&
    category !== 'blocked' &&
    (preflightLevel === 'verified' ||
      (preflightLevel === 'warn' && !hasCooldown && (!hasDebt || safePartialReady)));

  const contractAddress =
    plan?.contractAddress || plan?.targetContract || plan?.poolAddress || asset?.protocolAddress || asset?.address || '—';
  const calldataPreview = plan?.calldataPreview || plan?.calldata || asset?.calldataPreview || '';
  const methodLabel = plan?.methodName || plan?.methodSignature || '';

  return {
    asset,
    protocolGroup,
    protocolLogo,
    protocolUrl,
    chainLogo,
    category,
    badgeIcon,
    badgeText: finalBadgeText,
    routeLine,
    preflightLevel,
    preflightIcon,
    preflightLabel,
    warningReason,
    isReady,
    isExternalApp,
    debtUsd,
    netUsd,
    requiresTwoStep,
    sigCount,
    underlyingSym,
    displayToken,
    contractAddress,
    calldataPreview,
    methodLabel,
  };
}

function renderDefiGuidedStepper() {
  const host = document.getElementById('defiGuidedStepper');
  if (!host) return;
  if (!defiStepperState) {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  host.classList.remove('hidden');
  const st = defiStepperState;
  const stepsHtml = st.steps
    .map((step, idx) => {
      const dotHtml =
        step.status === 'done'
          ? uiIcon('check', 11)
          : step.status === 'failed'
          ? uiIcon('alert-triangle', 11)
          : step.status === 'active'
          ? uiIcon('activity-dot', 11)
          : escHtml(String(idx + 1));
      const safeTxUrl = safeHttpUrl(step.txUrl);
      const txHtml = safeTxUrl
        ? ` <a class="explorer-link" href="${escHtml(safeTxUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(step.txLabel || 'View tx')}</a>`
        : '';
      return `
        <div class="defi-step is-${escHtml(step.status)}" data-stepper-step="${escHtml(step.id)}">
          <div class="defi-step-top">
            <span class="defi-step-dot">${dotHtml}</span>
            <strong class="defi-step-title">${escHtml(step.title)}</strong>
          </div>
          <div class="defi-step-detail">${escHtml(step.detail || '')}${txHtml}</div>
        </div>
      `;
    })
    .join('');

  host.innerHTML = `
    <div class="defi-stepper-head">
      <div class="inline-logo-row">
        <span class="agent-pulse-dot ${st.active ? '' : 'is-idle'}"></span>
        <strong>${escHtml(st.title)}</strong>
        <span class="muted-xs pro-only">${escHtml(st.mode === 'two_stage' ? 'Guided 2-Stage Auto-Bridge' : '1-Click Atomic Extract')}</span>
      </div>
      ${
        st.dismissible
          ? `<button type="button" class="text-action muted" id="dismissDefiStepperBtn">Dismiss</button>`
          : `<span class="muted-xs">Auto-continuing…</span>`
      }
    </div>
    <div class="defi-stepper-rail">${stepsHtml}</div>
  `;

  document.getElementById('dismissDefiStepperBtn')?.addEventListener('click', () => {
    defiStepperState = null;
    renderDefiGuidedStepper();
    renderDefiUnwindPanel();
  });
}

function initDefiStepper({ title, mode = 'atomic', jobId = null }) {
  defiStepperState = {
    active: true,
    dismissible: false,
    jobId,
    title,
    mode,
    steps: [
      {
        id: 'withdraw',
        title: 'Step 1: Withdraw from Protocol',
        status: 'active',
        detail: 'Preparing protocol withdrawal…',
      },
      {
        id: 'bridge',
        title: 'Step 2: Bridge Unlocked Asset to Solana',
        status: 'pending',
        detail: mode === 'two_stage' ? 'Starts automatically once Step 1 confirms' : `Bundled into Solana ${outputAsset} route`,
      },
      {
        id: 'confirm',
        title: 'Step 3: Confirmed on Solana',
        status: 'pending',
        detail: `Waiting for ${outputAsset} arrival on Solana`,
      },
    ],
  };
  renderDefiGuidedStepper();
}

function updateDefiStepperStep(stepId, patch, metaPatch = {}) {
  if (!defiStepperState) return;
  const target = defiStepperState.steps.find((s) => s.id === stepId);
  if (target) Object.assign(target, patch);
  Object.assign(defiStepperState, metaPatch);
  renderDefiGuidedStepper();
}

function renderDefiUnwindPanel() {
  const panel = document.getElementById('defiUnwindPanel');
  const groupsHost = document.getElementById('defiProtocolGroups');
  const countBadge = document.getElementById('defiCountBadge');
  const subEl = document.getElementById('defiUnwindSub');
  const extractAllBtn = document.getElementById('extractAllDefiBtn');
  if (!panel || !groupsHost || !currentScan) return;

  const defiRaw = currentScan.assets.filter(isDefiAsset);
  if (!defiRaw.length && !defiStepperState) {
    panel.classList.add('hidden');
    groupsHost.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');
  renderDefiGuidedStepper();

  const normalized = defiRaw.map((a) => normalizeDefiPosition(a, outputAsset));
  const readyPositions = normalized.filter((n) => n.isReady);
  const totalDefiUsd = normalized.reduce((s, n) => s + Number(n.asset.grossUsd || 0), 0);
  const readyUsd = readyPositions.reduce((s, n) => s + Number(n.asset.grossUsd || 0), 0);
  const uniqueChains = new Set(normalized.map((n) => n.asset.chain)).size;

  if (countBadge) countBadge.textContent = String(normalized.length);
  if (subEl) {
    const readyPart =
      readyPositions.length === normalized.length
        ? `${readyPositions.length} ready ${readyPositions.length === 1 ? 'position' : 'positions'}`
        : `${readyPositions.length} of ${normalized.length} ready`;
    subEl.textContent = `${readyPart} · $${totalDefiUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })} across ${uniqueChains} ${uniqueChains === 1 ? 'chain' : 'chains'} → Solana ${outputAsset}`;
  }

  if (extractAllBtn) {
    extractAllBtn.disabled = readyPositions.length === 0;
    extractAllBtn.textContent =
      readyPositions.length > 0
        ? `Extract Ready DeFi (${fmtUsd(readyUsd)})`
        : 'No Ready DeFi Positions';
  }

  // Group by normalized protocol name; sort Ready positions & Ready groups FIRST
  const groupMap = new Map();
  for (const pos of normalized) {
    const key = pos.protocolGroup;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        name: key,
        logo: pos.protocolLogo,
        protocolUrl: pos.protocolUrl || '',
        positions: [],
        totalUsd: 0,
        readyUsd: 0,
        readyCount: 0,
      });
    }
    const grp = groupMap.get(key);
    grp.positions.push(pos);
    grp.totalUsd += Number(pos.asset.grossUsd || 0);
    if (!grp.protocolUrl && pos.protocolUrl) grp.protocolUrl = pos.protocolUrl;
    if (pos.isReady) {
      grp.readyCount += 1;
      grp.readyUsd += Number(pos.asset.grossUsd || 0);
    }
  }
  const allGroups = Array.from(groupMap.values()).map((grp) => {
    grp.positions.sort((a, b) => {
      if (a.isReady !== b.isReady) return a.isReady ? -1 : 1;
      return Number(b.asset.grossUsd || 0) - Number(a.asset.grossUsd || 0);
    });
    return grp;
  });
  const readyGroups = allGroups
    .filter((g) => g.readyCount > 0)
    .sort((a, b) => b.readyUsd - a.readyUsd || b.totalUsd - a.totalUsd);
  const unavailableGroups = allGroups
    .filter((g) => g.readyCount === 0)
    .sort((a, b) => b.totalUsd - a.totalUsd);
  const unavailablePositionsCount = unavailableGroups.reduce((s, g) => s + g.positions.length, 0);

  const renderGroupCard = (grp) => {
    const posRowsHtml = grp.positions
      .map((pos) => {
        const a = pos.asset;
        const checked = selectedAssetIds.has(a.id);
        const badgeClass =
          pos.category === 'one_click'
            ? 'defi-badge-oneclick'
            : pos.category === 'instant_swap' || pos.category === 'external_app'
            ? 'defi-badge-swap'
            : pos.category === 'debt_guard'
            ? 'defi-badge-guard'
            : pos.category === 'blocked'
            ? 'defi-badge-blocked'
            : 'defi-badge-cooldown';
        const statusClass =
          pos.preflightLevel === 'verified'
            ? 'defi-status-verified'
            : pos.preflightLevel === 'warn'
            ? 'defi-status-warn'
            : 'defi-status-blocked';
        const usdStr = `$${Number(a.grossUsd || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        const netSubStr =
          pos.debtUsd > 0 && pos.netUsd !== null
            ? `Net $${pos.netUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}`
            : a.chainName;
        const chainLogoCls = needsLightLogoBacking(a.chain) ? ' logo-light-backing' : '';

        const techDetailsRows = [
          `<div class="defi-tech-kv"><span>Protocol contract</span><code class="mono">${escHtml(pos.contractAddress)}</code></div>`,
          `<div class="defi-tech-kv"><span>Position token</span><code class="mono">${escHtml(a.symbol)} (${escHtml(a.address)})</code></div>`,
          `<div class="defi-tech-kv"><span>Raw balance</span><code class="mono">${escHtml(String(a.rawBalance || '0'))} (${escHtml(String(a.decimals ?? 18))} dec)</code></div>`,
          pos.methodLabel
            ? `<div class="defi-tech-kv"><span>Method</span><code class="mono">${escHtml(pos.methodLabel)}</code></div>`
            : '',
          pos.calldataPreview
            ? `<div class="defi-tech-kv"><span>Calldata preview</span><code class="mono">${escHtml(pos.calldataPreview)}</code></div>`
            : '',
        ]
          .filter(Boolean)
          .join('');

        return `
          <div class="defi-pos-row ${checked ? 'is-checked' : ''} ${pos.isReady ? '' : 'is-restricted'}" data-defi-asset-id="${escHtml(a.id)}">
            <div class="defi-pos-main">
              <label class="defi-pos-check-wrap" title="Include in Sweep">
                <input type="checkbox" class="defi-pos-chk" data-defi-chk="${escHtml(a.id)}" ${checked ? 'checked' : ''} ${pos.preflightLevel === 'blocked' ? 'disabled' : ''} aria-label="Select ${escHtml(pos.routeLine)}" />
              </label>
              <div class="defi-pos-body">
                <div class="defi-pos-route-line">
                  <img src="${escHtml(pos.chainLogo)}" width="15" height="15" alt="" class="chain-logo-xs${chainLogoCls}" />
                  <span class="defi-route-text">${escHtml(pos.routeLine)}</span>
                </div>
                <div class="defi-pos-badges">
                  <span class="defi-exit-badge ${badgeClass}">${uiIcon(pos.badgeIcon, 12)}<span>${escHtml(pos.badgeText)}</span></span>
                  ${
                    pos.category === 'blocked'
                      ? ''
                      : `<span class="defi-status-pill ${statusClass}">${uiIcon(pos.preflightIcon, 12)}<span>${escHtml(pos.preflightLabel)}</span></span>`
                  }
                </div>
                ${
                  pos.warningReason
                    ? `<div class="defi-pos-warning is-${escHtml(pos.preflightLevel)}">${escHtml(pos.warningReason)}</div>`
                    : ''
                }
                <details class="defi-tech-details pro-only">
                  <summary>Technical details</summary>
                  <div class="defi-tech-grid">${techDetailsRows}</div>
                </details>
              </div>
              <div class="defi-pos-right">
                <strong class="defi-pos-usd">${escHtml(usdStr)}</strong>
                <span class="muted-xs">${escHtml(netSubStr)}</span>
              </div>
            </div>
          </div>
        `;
      })
      .join('');

    const headerActionHtml =
      grp.readyCount > 0
        ? `<button
            type="button"
            class="btn-outline-sm defi-proto-extract-btn"
            data-extract-protocol="${escHtml(grp.name)}"
          >Extract ${escHtml(grp.name)}</button>`
        : grp.protocolUrl
        ? `<a
            class="btn-outline-sm defi-proto-extract-btn"
            href="${escHtml(grp.protocolUrl)}"
            target="_blank"
            rel="noopener noreferrer"
            style="text-decoration:none; display:inline-flex; align-items:center;"
          >Manage on ${escHtml(grp.name)}</a>`
        : `<button
            type="button"
            class="btn-outline-sm defi-proto-extract-btn"
            disabled
          >Unavailable</button>`;

    return `
      <div class="defi-protocol-group" data-protocol-group="${escHtml(grp.name)}">
        <div class="defi-proto-head">
          <div class="defi-proto-id">
            <span class="defi-proto-logo-tile">
              <img src="${escHtml(grp.logo)}" width="20" height="20" alt="" class="defi-proto-logo-img" />
            </span>
            <div class="defi-proto-meta">
              <strong>${escHtml(grp.name)}</strong>
              <span class="muted-xs tabular-nums">${grp.positions.length} ${grp.positions.length === 1 ? 'position' : 'positions'} · $${grp.totalUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
          </div>
          ${headerActionHtml}
        </div>
        <div class="defi-pos-list">${posRowsHtml}</div>
      </div>
    `;
  };

  const readyHtml = readyGroups.map(renderGroupCard).join('');
  const unavailableHtml = unavailableGroups.length
    ? `<details class="defi-unavailable-details"${unavailablePositionsCount <= 2 ? ' open' : ''}>
        <summary>
          <span>Show ${unavailablePositionsCount} unavailable ${unavailablePositionsCount === 1 ? 'position' : 'positions'}</span>
          <span class="muted-xs">${unavailableGroups.length} ${unavailableGroups.length === 1 ? 'protocol' : 'protocols'}</span>
        </summary>
        <div class="defi-unavailable-body">${unavailableGroups.map(renderGroupCard).join('')}</div>
      </details>`
    : '';

  groupsHost.innerHTML = `${readyHtml}${unavailableHtml}`;

  groupsHost.querySelectorAll('.defi-proto-logo-img').forEach((img) => {
    img.addEventListener('error', () => {
      if (!img.src.endsWith('/logos/vault.svg')) img.src = '/logos/vault.svg';
    });
  });

  // Wire checkboxes inside DeFi panel to stay 100% synced with selectedAssetIds & plan
  groupsHost.querySelectorAll('.defi-pos-chk').forEach((chk) => {
    chk.addEventListener('change', () => {
      const id = chk.dataset.defiChk;
      if (chk.checked) selectedAssetIds.add(id);
      else selectedAssetIds.delete(id);
      recomputePlan();
    });
  });

  // Wire per-protocol 1-click Extract buttons
  groupsHost.querySelectorAll('[data-extract-protocol]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const protoName = btn.dataset.extractProtocol;
      const protoReady = normalized
        .filter((n) => n.protocolGroup === protoName && n.isReady)
        .map((n) => n.asset);
      extractDefiAssets(protoReady, protoName);
    });
  });
}

function buildUnlockedUnderlyingAssets(chain, withdrawnDefiAssets) {
  const chainUsdcMap = {
    ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  };

  const unlocked = [];
  for (const a of withdrawnDefiAssets) {
    const plan = a.defiExitPlan || {};
    const sym = String(plan.underlyingSymbol || a.underlyingSymbol || 'USDC');
    const addr =
      plan.underlyingAddress ||
      a.underlyingAddress ||
      (sym.toUpperCase() === 'USDC' ? chainUsdcMap[chain] : null);
    if (!addr) continue;
    const isUsdc = sym.toUpperCase() === 'USDC';
    unlocked.push({
      ...a,
      id: `${a.id}:unlocked`,
      kind: 'erc20',
      address: addr,
      symbol: sym,
      name: `${sym} (Unlocked from ${a.protocol || 'DeFi'})`,
      protocol: undefined,
      protocolAddress: undefined,
      defiExitPlan: undefined,
      action: isUsdc ? 'BRIDGE_DIRECT_USDC' : 'SELL_AND_BRIDGE',
      actionReason: `Automatically bridging unlocked ${sym} to Solana ${outputAsset}`,
      selectedByDefault: true,
    });
  }
  return unlocked;
}

async function extractDefiAssets(assetsToExtract, scopeTitle = 'DeFi Positions') {
  if (!currentScan || !assetsToExtract?.length) {
    showToast('No ready DeFi positions to extract.');
    return;
  }
  if (isSweepQueueRunning) {
    showToast('A sweep is already in progress.');
    return;
  }

  const srcSession = getActiveSourceWallet();
  const connectedSrc = srcSession?.address || null;
  if (!connectedSrc) {
    showToast('Connect your wallet to extract DeFi positions to Solana.');
    openWalletModal('evm');
    return;
  }

  const solDest = requireVerifiedSolanaDestination('extract DeFi positions');
  if (!solDest) return;

  const byChain = new Map();
  for (const a of assetsToExtract) {
    const list = byChain.get(a.chain) || [];
    list.push(a);
    byChain.set(a.chain, list);
  }

  const chains = Array.from(byChain.keys());
  const hasTwoStage = assetsToExtract.some((a) => normalizeDefiPosition(a, outputAsset).requiresTwoStep);

  isSweepQueueRunning = true;
  updateWalletButtons();
  try {
    const job = await createSweepJob({
      sourceWallet: connectedSrc,
      solanaDestination: solDest,
      outputAsset,
      bridgePreference: getActiveBridgePreference(),
      protocolFeeBps: getActiveProtocolFeeBps(),
      feeRecipientEvm: getActiveFeeRecipientEvm(),
      legs: chains.map((c) => {
        const list = byChain.get(c);
        const gross = list.reduce((s, x) => s + safeNum(x.grossUsd), 0);
        const explicitBps = getActiveProtocolFeeBps();
        const legFeeUsd =
          explicitBps !== undefined
            ? Number(((gross * explicitBps) / 10_000).toFixed(2))
            : computeTieredPreservationFee(gross).feeUsd;
        return {
          chain: c,
          chainName: list[0]?.chainName || c,
          assetCount: list.length,
          estimatedNetUsd: Math.max(0, Number((gross - legFeeUsd).toFixed(2))),
          estimatedFeeUsd: legFeeUsd,
        };
      }),
    });
    activeJobId = job.jobId;
    backgroundJobs.unshift(job);
    saveLocalSweepJobs();
    renderBackgroundAgentUI();

    initDefiStepper({
      title: `${scopeTitle} (${chains.length} ${chains.length === 1 ? 'chain' : 'chains'})`,
      mode: hasTwoStage ? 'two_stage' : 'atomic',
      jobId: job.jobId,
    });

    for (const chain of chains) {
      const stepRes = await executeChainBatchLive(chain, job.jobId, {
        overrideAssets: byChain.get(chain),
        defiGuided: true,
        scopeTitle,
      });
      if (stepRes?.userRejected) {
        showToast('Wallet signature rejected — aborted remaining DeFi chains.');
        break;
      }
    }
  } catch (err) {
    showToast(err?.message || 'Failed to start DeFi extraction.');
  } finally {
    isSweepQueueRunning = false;
    updateWalletButtons();
  }
}

function renderAssetList() {
  const host = document.getElementById('assetListBody');
  if (!host || !currentScan) return;

  const filtered = currentScan.assets.filter((a) => {
    if (activeChainFilter !== 'all' && a.chain !== activeChainFilter) return false;
    if (activeFilter === 'defi') return isDefiAsset(a);
    if (activeFilter === 'dust')
      return (
        a.grossUsd > 0 &&
        a.grossUsd <= 25 &&
        a.kind !== 'defi_position' &&
        a.action !== 'SKIP_HONEYPOT' &&
        a.action !== 'SKIP_UNPRICED' &&
        a.action !== 'BURN_ZERO_LIQUIDITY'
      );
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
        a.action === 'SKIP_UNPRICED' ||
        a.action === 'SKIP_GAS_NEGATIVE' ||
        a.action === 'SKIP_NEGATIVE_ROI' ||
        a.roiVerdict === 'negative_roi'
      );
    return true;
  });

  if (!filtered.length) {
    host.innerHTML = `<div style="text-align:center; padding:32px 16px; color:var(--ink-2); font-size:13px;">No assets in this filter.</div>`;
    return;
  }

  // Sort actionable / selected / worth-it assets first, zero-value & blocked last
  const sorted = [...filtered].sort((a, b) => {
    const rank = (x) => {
      if (selectedAssetIds.has(x.id)) return 0;
      if (x.roiVerdict === 'worth_it') return 1;
      if (x.action === 'BRIDGE_DIRECT_USDC' || x.action === 'SELL_AND_BRIDGE' || x.action === 'WITHDRAW_AND_BRIDGE') return 2;
      if (x.grossUsd > 0 && x.action !== 'SKIP_HONEYPOT' && x.action !== 'SKIP_UNPRICED') return 3;
      return 4;
    };
    const dr = rank(a) - rank(b);
    if (dr !== 0) return dr;
    return Number(b.grossUsd || 0) - Number(a.grossUsd || 0);
  });

  host.innerHTML = sorted
    .map((a) => {
      const checked = selectedAssetIds.has(a.id);
      const defiNorm = isDefiAsset(a) ? normalizeDefiPosition(a, outputAsset) : null;
      const disabled =
        a.action === 'SKIP_HONEYPOT' ||
        a.action === 'SKIP_UNPRICED' ||
        Boolean(defiNorm && defiNorm.preflightLevel === 'blocked');
      const localProtoLogo = a.protocol ? getProtocolLogoPath(a.protocol) : null;
      const remoteProtoLogo = safeHttpUrl(a.protocolLogoUrl || a.defiExitPlan?.protocolLogoUrl);
      const protoLogo =
        localProtoLogo === '/logos/vault.svg' && remoteProtoLogo ? remoteProtoLogo : localProtoLogo;
      const chainLogo = getChainLogoPath(a.chain);
      const tokenLogo = getTokenLogoPath(a.symbol, a.chain);
      const mainLogo = protoLogo || tokenLogo;
      const showSubLogo = Boolean(mainLogo !== chainLogo);
      const mainLightCls = needsLightLogoBacking(mainLogo) ? ' logo-light-backing' : '';
      const subLightCls = needsLightLogoBacking(a.chain) ? ' logo-light-backing' : '';
      const usdStr =
        a.action === 'BURN_ZERO_LIQUIDITY'
          ? '$0.00'
          : a.action === 'SKIP_HONEYPOT'
          ? 'Blocked'
          : a.action === 'SKIP_UNPRICED'
          ? 'Unpriced'
          : `$${a.grossUsd.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      const fullBalStr = `${Number(a.uiBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} ${a.symbol}`;
      const balStr = `${formatCompactBalance(a.uiBalance)} ${a.symbol}`;
      const debtBadge =
        defiNorm && defiNorm.category === 'debt_guard'
          ? `<span class="micro-pill is-warn">Debt Guard</span>`
          : defiNorm && defiNorm.category === 'cooldown'
          ? `<span class="micro-pill is-warn">Locked</span>`
          : a.aaveDebtUsd > 0
          ? `<span class="micro-pill is-danger">Debt Guard</span>`
          : '';
      const walletTag =
        currentScan?.unifiedWallets?.length > 1 && a.sourceWalletLabel
          ? `<span class="micro-pill">${escHtml(a.sourceWalletLabel)}</span>`
          : '';

      const rowTip = escHtml(formatRoiTooltip(a));
      const subMeta = defiNorm
        ? `${defiNorm.protocolGroup} · ${a.chainName} · ${defiNorm.preflightLabel}`
        : `${a.name} · ${a.chainName}`;
      return `
        <div class="asset-row ${checked ? 'is-checked' : ''} ${disabled ? 'is-blocked' : ''}" data-row-asset="${escHtml(a.id)}" title="${rowTip}">
          <input type="checkbox" class="asset-chk" data-asset-id="${escHtml(a.id)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} aria-label="Select ${escHtml(a.symbol)} on ${escHtml(a.chainName)}" />
          <div class="asset-row-id">
            <span class="asset-logo-wrap">
              <img src="${escHtml(mainLogo)}" width="19" height="19" alt="" class="asset-logo-main${mainLightCls}" />
              ${showSubLogo ? `<img src="${escHtml(chainLogo)}" width="14" height="14" alt="" class="asset-logo-sub${subLightCls}" />` : ''}
            </span>
            <div class="asset-row-name-col">
              <div class="asset-row-sym">
                <span>${escHtml(a.symbol)}</span>
                ${a.protocol ? `<span class="muted-xs" style="font-weight:400;">${escHtml(defiNorm ? defiNorm.protocolGroup : a.protocol)}</span>` : ''}
                ${walletTag}
                ${debtBadge}
              </div>
              <div class="asset-row-meta">${escHtml(subMeta)}</div>
            </div>
          </div>
          <div class="asset-row-val-col">
            <div class="asset-row-usd">${escHtml(usdStr)}</div>
            <div class="asset-row-bal" title="${escHtml(fullBalStr)}">${escHtml(balStr)}</div>
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
      if (chk.checked) {
        selectedAssetIds.add(id);
        const matched = currentScan?.assets?.find((a) => a.id === id);
        if (matched?.action === 'BURN_ZERO_LIQUIDITY') {
          const burnEl = document.getElementById('burnToggle');
          if (burnEl && !burnEl.checked) burnEl.checked = true;
        }
      } else {
        selectedAssetIds.delete(id);
      }
      recomputePlan();
    });
  });

  host.querySelectorAll('[data-row-asset]').forEach((row) => {
    row.addEventListener('click', () => {
      const id = row.dataset.rowAsset;
      const chk = row.querySelector('.asset-chk');
      if (!chk || chk.disabled) return;
      chk.checked = !chk.checked;
      if (chk.checked) {
        selectedAssetIds.add(id);
        const matched = currentScan?.assets?.find((a) => a.id === id);
        if (matched?.action === 'BURN_ZERO_LIQUIDITY') {
          const burnEl = document.getElementById('burnToggle');
          if (burnEl && !burnEl.checked) burnEl.checked = true;
        }
      } else {
        selectedAssetIds.delete(id);
      }
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
          ? `<span class="roi-pill roi-low">${safeNum(leg.effectiveCostPct).toFixed(0)}% fees</span>`
          : `<span class="roi-pill roi-worth">Worth It</span>`;
      const breakEvenHtml =
        leg.skippedNegativeRoi && leg.breakEvenHint
          ? `<div class="breakeven-banner mono">${escapeHtml(leg.breakEvenHint)}</div>`
          : '';
      const itemCount = safeInt(leg.defiExits) + safeInt(leg.swaps) + safeInt(leg.burns);
      const bridgedStr = safeNum(leg.bridgedUsdc).toLocaleString(undefined, { minimumFractionDigits: 2 });
      const darkCls = needsDarkLogoBacking(leg.chain) ? ' logo-dark-backing' : '';
      return `
      <div>
        <div class="chain-queue-item">
          <span class="inline-logo-row">
            <img src="${escapeHtml(getChainLogoPath(leg.chain))}" alt="" class="chain-logo-xs${darkCls}" />
            <strong>${escapeHtml(leg.chainName)}</strong>
            <span class="mono muted-xs">${itemCount} ${itemCount === 1 ? 'item' : 'items'}</span>
            ${legRoiPill}
            ${noGasBadge}
          </span>
          <span class="inline-logo-row">
            <span class="mono" style="font-weight:600;">$${escapeHtml(bridgedStr)}</span>
            <button type="button" class="chain-queue-run" data-exec-chain-batch="${escapeHtml(leg.chain)}" ${executingChains.has(leg.chain) ? 'disabled' : ''}>${executionMode === 'gasless' ? '1-Sig' : 'Run'}</button>
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

  const gasIcon = proof.hasEnoughNativeGas ? uiIcon('check', 12) : uiIcon('alert-triangle', 12);
  const gasLabel = proof.hasEnoughNativeGas
    ? `${proof.nativeBalanceUi} ${proof.nativeSymbol} (~$${safeNum(proof.nativeBalanceUsd).toFixed(2)})`
    : `Low gas (${proof.nativeBalanceUi} ${proof.nativeSymbol}) · Switch to Gasless 1-Sig`;
  const checkRows = (proof.checks || [])
    .slice(0, 6)
    .map((c) => {
      const markHtml =
        c.preflightStatus === 'verified'
          ? uiIcon('check', 12)
          : c.preflightStatus === 'reverted'
          ? uiIcon('x-circle', 12)
          : uiIcon('circle', 10);
      return `<div class="proof-check-row"><span class="proof-check-left">${markHtml}<span>${escapeHtml(c.assetSymbol)}: ${escapeHtml(c.summary)}</span></span><span class="mono muted-xs">${escapeHtml(c.preflightStatus)}</span></div>`;
    })
    .join('');

  const blockStr = proof.blockNumber ? safeInt(proof.blockNumber).toLocaleString() : 'live';
  const minNetStr = safeNum(proof.guaranteedMinNetUsd).toLocaleString(undefined, { minimumFractionDigits: 2 });
  const feePctStr = safeNum(proof.protocolFee?.feePercent).toString();
  const feeEstStr = safeNum(proof.protocolFee?.estimatedFeeUsd).toFixed(2);
  const haircutCount = safeInt(proof.haircutDroppedAssets?.length);

  const headerIcon = proof.allChecksSafe ? uiIcon('check-circle', 13) : uiIcon('alert-triangle', 13);
  const headerLabel = proof.allChecksSafe
    ? 'Real-Time Pre-Sign Proof'
    : proof.simulatedLive === false
    ? 'Pre-Flight Only (Not Live-Simulated)'
    : 'Simulation Warning';

  card.innerHTML = `
    <div class="proof-head">
      <span class="proof-head-title">${headerIcon}<span>${headerLabel} (${escapeHtml(proof.chainName)} #${escapeHtml(blockStr)})</span></span>
      <span class="mono muted-xs">${escapeHtml(shortAddr(proof.proofDigestSha256))}</span>
    </div>
    ${proof.simulationNote ? `<div class="breakeven-banner mono">${escapeHtml(proof.simulationNote)}</div>` : ''}
    <div class="proof-kv"><span>Wallet Proven</span><strong class="mono">${escapeHtml(shortAddr(proof.userAddress))}</strong></div>
    <div class="proof-kv"><span>Gas Check</span><span class="proof-kv-val mono">${gasIcon}<span>${escapeHtml(gasLabel)}</span></span></div>
    <div class="proof-kv"><span>Solana Recipient bytes32</span><span class="proof-kv-val mono">${proof.mintRecipientVerified ? `${uiIcon('check', 12)}<span>Matched bit-for-bit</span>` : `${uiIcon('x-circle', 12)}<span>Mismatch</span>`}</span></div>
    <div class="proof-kv"><span>Guaranteed Min Output</span><strong class="mono">≥ $${escapeHtml(minNetStr)} ${escapeHtml(proof.outputAsset)}</strong></div>
    <div class="proof-kv"><span>Protocol Fee (${escapeHtml(feePctStr)}%)</span><span class="mono">$${escapeHtml(feeEstStr)} (${escapeHtml(proof.protocolFee?.collectionMethod)})</span></div>
    ${
      proof.quotedCostBreakdown
        ? `<div class="proof-kv"><span>All-In Quoted Cost</span><span class="mono">${safeNum(proof.quotedCostBreakdown.effectiveCostPct).toFixed(1)}% · gas $${safeNum(proof.quotedCostBreakdown.estimatedGasUsd).toFixed(2)} + bridge/slip $${safeNum(proof.quotedCostBreakdown.bridgeAndSlippageUsd).toFixed(2)}${safeNum(proof.quotedCostBreakdown.solanaAtaRentUsd) > 0 ? ` + ATA $${safeNum(proof.quotedCostBreakdown.solanaAtaRentUsd).toFixed(2)}` : ''}</span></div>`
        : ''
    }
    ${
      haircutCount > 0
        ? `<div class="breakeven-banner mono">Haircut Gate dropped ${haircutCount} high-cost asset(s) (&gt;50% fee).</div>`
        : ''
    }
    ${proof.preSolanaSnapshot ? `<div class="proof-kv"><span>Pre-Sweep Solana Snapshot</span><span class="mono">${safeNum(proof.preSolanaSnapshot.usdcBalance).toFixed(2)} USDC · slot #${safeInt(proof.preSolanaSnapshot.slot).toLocaleString()}</span></div>` : ''}
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
    a.download = `turgalium-proof-${proof.chain}-${proof.proofId}.json`;
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
  const solDest = requireVerifiedSolanaDestination('run a pre-sign proof');
  if (!solDest) return;

  const targetChain =
    activeChainFilter !== 'all' && currentPlan.legs.some((l) => l.chain === activeChainFilter)
      ? activeChainFilter
      : currentPlan.legs[0].chain;
  const effectiveScan = buildEffectiveScanForPlan();
  const chainAssets = effectiveScan.assets.filter(
    (a) =>
      a.chain === targetChain &&
      selectedAssetIds.has(a.id) &&
      a.action !== 'SKIP_HONEYPOT' &&
      a.action !== 'SKIP_UNPRICED'
  );
  if (!chainAssets.length) return;

  const btn = document.getElementById('verifyProofBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = `Simulating ${targetChain} on live RPC…`;
  }
  try {
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
    }
    updateFamilyChrome();
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
  if (status === 'landed' || status === 'attested') return { cls: 'tag-defi', iconName: 'check' };
  if (status === 'failed') return { cls: 'tag-burn', iconName: 'alert-triangle' };
  if (status === 'relaying' || status === 'confirming' || status === 'signing' || status === 'preparing') {
    return { cls: 'tag-sell', iconName: 'activity-dot' };
  }
  return { cls: 'tag-skip', iconName: 'circle' };
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

  const makeExplorerLink = (href, label) => {
    const a = document.createElement('a');
    a.className = 'explorer-link';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = label;
    return a;
  };

  if (card && feed) {
    if (!activeJob) {
      card.classList.add('hidden');
    } else {
      card.classList.remove('hidden');
      const legs = Array.isArray(activeJob.legs) ? activeJob.legs : [];
      const doneCount = legs.filter(
        (l) => l.status === 'landed' || l.status === 'attested'
      ).length;
      const total = Math.max(1, legs.length);
      const pct = Math.round((doneCount / total) * 100);
      if (meta) {
        meta.textContent =
          activeJob.status === 'completed'
            ? `${doneCount}/${total} settled`
            : `${doneCount}/${total} chains · running`;
      }
      const shareAgentBtn = document.getElementById('agentShareReceiptBtn');
      if (shareAgentBtn) {
        const canShareJob = legs.some(
          (l) => l.status === 'landed' || l.status === 'attested' || l.status === 'relaying'
        );
        shareAgentBtn.classList.toggle('hidden', !canShareJob);
      }
      if (fill) fill.style.width = `${Math.max(activeJob.status === 'active' ? 12 : 0, pct)}%`;
      if (pulse) pulse.classList.toggle('is-idle', activeJob.status !== 'active');

      feed.replaceChildren();
      for (const leg of legs) {
        const b = legStatusBadge(leg.status);
        const row = document.createElement('div');
        row.className = 'agent-leg-row';

        const left = document.createElement('div');
        left.style.minWidth = '0';

        const top = document.createElement('div');
        top.className = 'inline-logo-row';
        const img = document.createElement('img');
        img.src = getChainLogoPath(leg.chain);
        img.alt = '';
        img.className = `chain-logo-xs${needsDarkLogoBacking(leg.chain) ? ' logo-dark-backing' : ''}`;
        const chainStrong = document.createElement('strong');
        chainStrong.textContent = String(leg.chainName || leg.chain || '');
        const usdSpan = document.createElement('span');
        usdSpan.className = 'mono muted-xs';
        usdSpan.textContent = `$${safeNum(leg.estimatedNetUsd).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
        top.append(img, chainStrong, usdSpan);

        const statusLine = document.createElement('div');
        statusLine.className = 'agent-leg-status';
        statusLine.append(document.createTextNode(String(leg.statusText || '')));

        const linkEls = [];
        const evmUrl = safeExplorerTxUrl(leg.explorerUrl, leg.evmTxHash);
        const solUrl = safeExplorerTxUrl('https://solscan.io', leg.solanaTxHash);
        if (evmUrl) linkEls.push(makeExplorerLink(evmUrl, 'EVM ↗'));
        if (solUrl) linkEls.push(makeExplorerLink(solUrl, 'Solscan ↗'));
        if (safeTxHash(leg.evmTxHash)) {
          const proveBtn = document.createElement('button');
          proveBtn.type = 'button';
          proveBtn.className = 'text-action pro-only';
          proveBtn.dataset.proveJobId = String(activeJob.jobId || '');
          proveBtn.dataset.proveChain = String(leg.chain || '');
          proveBtn.innerHTML = `${uiIcon('check', 12)}<span>Prove</span>`;
          proveBtn.addEventListener('click', () => {
            proveLegOnchain(activeJob.jobId, leg.chain, proveBtn);
          });
          linkEls.push(proveBtn);
        }
        if (
          (leg.status === 'attested' || leg.attestationStatus === 'complete') &&
          !leg.solanaTxHash &&
          safeTxHash(leg.evmTxHash)
        ) {
          const claimBtn = document.createElement('button');
          claimBtn.type = 'button';
          claimBtn.className = 'text-action';
          claimBtn.dataset.claimCctpJob = String(activeJob.jobId || '');
          claimBtn.dataset.claimCctpChain = String(leg.chain || '');
          claimBtn.textContent = 'Claim USDC on Solana';
          claimBtn.addEventListener('click', () => {
            claimCctpLegOnSolana(activeJob, leg, claimBtn);
          });
          linkEls.push(claimBtn);
        }
        if (linkEls.length) {
          statusLine.append(document.createTextNode(' · '));
          linkEls.forEach((el, idx) => {
            if (idx > 0) statusLine.append(document.createTextNode(' · '));
            statusLine.append(el);
          });
        }

        left.append(top, statusLine);

        const badge = document.createElement('span');
        badge.className = `action-tag ${b.cls}`;
        badge.innerHTML = uiIcon(b.iconName, 11);
        badge.appendChild(document.createTextNode(String(leg.status || '')));

        row.append(left, badge);
        feed.append(row);
      }
    }
  }

  // Floating bottom-right Background Agent Pill (visible whenever a job is active and user isn't on Sweep)
  if (dock && dockText) {
    const runningJob = backgroundJobs.find((j) => j.status === 'active');
    const siteVisible = !document.getElementById('siteShell')?.classList.contains('hidden');
    const showDock = Boolean(runningJob) && (siteVisible || activeView !== 'scanner');
    dock.classList.toggle('hidden', !showDock);
    if (runningJob) {
      const legs = Array.isArray(runningJob.legs) ? runningJob.legs : [];
      const done = legs.filter(
        (l) => l.status === 'landed' || l.status === 'attested'
      ).length;
      dockText.textContent = `Turgalium Agent · ${done}/${legs.length} chains settled`;
    }
  }

  // Activity Table (pure DOM construction — zero innerHTML injection sinks)
  const body = document.getElementById('liveExecLogBody');
  const statusMeta = document.getElementById('liveExecStatusMeta');
  if (body) {
    const trNodes = [];
    for (const job of backgroundJobs) {
      const legs = Array.isArray(job.legs) ? job.legs : [];
      for (const leg of legs) {
        const b = legStatusBadge(leg.status);
        const safeAssetCount = safeInt(leg.assetCount);
        const tr = document.createElement('tr');

        const tdChain = document.createElement('td');
        const titleDiv = document.createElement('div');
        titleDiv.className = 'asset-title inline-logo-row';
        const chainImg = document.createElement('img');
        chainImg.src = getChainLogoPath(leg.chain);
        chainImg.alt = '';
        chainImg.className = `chain-logo-xs${needsDarkLogoBacking(leg.chain) ? ' logo-dark-backing' : ''}`;
        const chainLabel = document.createElement('span');
        chainLabel.textContent = `${String(leg.chainName || leg.chain || '')} (${safeAssetCount} assets)`;
        titleDiv.append(chainImg, chainLabel);
        const subDiv = document.createElement('div');
        subDiv.className = 'asset-sub mono';
        subDiv.textContent = String(leg.statusText || '');
        tdChain.append(titleDiv, subDiv);

        const tdProv = document.createElement('td');
        tdProv.className = 'mono';
        tdProv.textContent = String(leg.provider || job.bridgePreference || '');

        const tdOut = document.createElement('td');
        tdOut.className = 'mono';
        tdOut.textContent = `$${safeNum(leg.estimatedNetUsd).toLocaleString(undefined, { minimumFractionDigits: 2 })} ${String(job.outputAsset || 'USDC')}`;

        const tdStat = document.createElement('td');
        const statBadge = document.createElement('span');
        statBadge.className = `action-tag ${b.cls}`;
        statBadge.textContent = String(leg.status || '');
        tdStat.append(statBadge);

        const tdLinks = document.createElement('td');
        tdLinks.className = 'mono';
        tdLinks.style.fontSize = '11.5px';
        const evmUrl = safeExplorerTxUrl(leg.explorerUrl, leg.evmTxHash);
        const solUrl = safeExplorerTxUrl('https://solscan.io', leg.solanaTxHash);
        let hasAny = false;
        if (evmUrl) {
          tdLinks.append(makeExplorerLink(evmUrl, 'EVM Tx ↗'));
          hasAny = true;
        } else {
          tdLinks.append(document.createTextNode('—'));
        }
        if (solUrl) {
          tdLinks.append(document.createTextNode(' · '), makeExplorerLink(solUrl, 'Solscan ↗'));
          hasAny = true;
        }
        if (leg.requiresSolanaClaim && safeTxHash(leg.evmTxHash)) {
          const cctpBtn = document.createElement('button');
          cctpBtn.type = 'button';
          cctpBtn.className = 'text-action pro-only';
          cctpBtn.dataset.checkCctpJob = String(job.jobId || '');
          cctpBtn.dataset.checkCctpChain = String(leg.chain || '');
          cctpBtn.textContent = 'Check CCTP Iris';
          cctpBtn.addEventListener('click', async () => {
            try {
              cctpBtn.textContent = 'Checking Iris…';
              const att = await api('/api/cctp/attestation', {
                method: 'POST',
                body: JSON.stringify({
                  chain: leg.chain,
                  txHash: leg.evmTxHash,
                  solanaDestination: job.solanaDestination,
                }),
              });
              await patchJobLeg(job.jobId, leg.chain, {
                status: att.attestationStatus === 'complete' ? 'attested' : 'relaying',
                statusText: att.nextStep,
                attestationStatus: att.attestationStatus,
              });
              await syncBackgroundJobs();
              showToast(att.nextStep);
            } catch (err) {
              showToast(err.message);
            } finally {
              cctpBtn.textContent = 'Check CCTP Iris';
            }
          });
          tdLinks.append(document.createTextNode(' · '), cctpBtn);
          hasAny = true;
        }
        if (
          (leg.status === 'attested' ||
            leg.attestationStatus === 'complete' ||
            leg.requiresSolanaClaim) &&
          !leg.solanaTxHash &&
          safeTxHash(leg.evmTxHash)
        ) {
          const claimBtn = document.createElement('button');
          claimBtn.type = 'button';
          claimBtn.className = 'text-action';
          claimBtn.dataset.claimCctpJob = String(job.jobId || '');
          claimBtn.dataset.claimCctpChain = String(leg.chain || '');
          claimBtn.textContent = 'Claim USDC on Solana';
          claimBtn.addEventListener('click', () => {
            claimCctpLegOnSolana(job, leg, claimBtn);
          });
          tdLinks.append(document.createTextNode(' · '), claimBtn);
          hasAny = true;
        }
        if (leg.status === 'landed' || leg.status === 'attested') {
          const receiptBtn = document.createElement('button');
          receiptBtn.type = 'button';
          receiptBtn.className = 'text-action';
          receiptBtn.textContent = 'Receipt';
          receiptBtn.addEventListener('click', () => {
            openReceiptModal(job);
          });
          tdLinks.append(document.createTextNode(' · '), receiptBtn);
          hasAny = true;
        }
        void hasAny;

        tr.append(tdChain, tdProv, tdOut, tdStat, tdLinks);
        trNodes.push(tr);
      }
    }
    if (trNodes.length) {
      body.replaceChildren(...trNodes);
      if (statusMeta) statusMeta.textContent = `${backgroundJobs.length} job(s) · ${trNodes.length} chain leg(s)`;
    } else if (statusMeta) {
      statusMeta.textContent = 'No active jobs yet';
    }
  }
}

function loadLocalSweepJobs() {
  try {
    const raw = window.localStorage?.getItem(LOCAL_SWEEP_JOBS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((j) => j && typeof j.jobId === 'string' && Array.isArray(j.legs))
      .slice(0, LOCAL_SWEEP_JOBS_MAX_ITEMS);
  } catch {
    return [];
  }
}

function saveLocalSweepJobs() {
  try {
    const localJobs = backgroundJobs
      .filter((j) => j && typeof j.jobId === 'string' && j.jobId.startsWith('local_'))
      .slice(0, LOCAL_SWEEP_JOBS_MAX_ITEMS);
    window.localStorage?.setItem(LOCAL_SWEEP_JOBS_STORAGE_KEY, JSON.stringify(localJobs));
  } catch {
    // ignore storage quota errors
  }
}

function buildLocalSweepJob(payload) {
  const now = new Date().toISOString();
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 12)
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const legs = (Array.isArray(payload?.legs) ? payload.legs : []).map((l, idx) => ({
    legId: l.legId || `${l.chain || 'chain'}_${idx}`,
    chain: l.chain,
    chainName: l.chainName || l.chain,
    assetCount: safeInt(l.assetCount),
    estimatedNetUsd: safeNum(l.estimatedNetUsd),
    estimatedFeeUsd: safeNum(l.estimatedFeeUsd),
    status: 'queued',
    statusText: 'Ready for wallet signature',
    updatedAt: now,
  }));
  return {
    jobId: `local_${rand}`,
    localOnly: true,
    status: legs.length ? 'active' : 'completed',
    createdAt: now,
    updatedAt: now,
    sourceWallet: payload?.sourceWallet || '',
    solanaDestination: payload?.solanaDestination || '',
    outputAsset: payload?.outputAsset || 'USDC',
    bridgePreference: payload?.bridgePreference || 'auto',
    protocolFeeBps: safeInt(payload?.protocolFeeBps ?? 0),
    legs,
  };
}

async function createSweepJob(payload) {
  if (canAccessAdminRoutes()) {
    try {
      const serverJob = await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (serverJob && serverJob.jobId) return serverJob;
    } catch {
      // Fall back to non-custodial local browser tracking if server job store is locked/unavailable
    }
  }
  const localJob = buildLocalSweepJob(payload);
  return localJob;
}

function checkJobCompletionAndUi(jobsList) {
  for (const job of jobsList) {
    if (!job?.jobId) continue;
    if (job.status === 'active') {
      observedActiveJobIds.add(job.jobId);
    } else if (
      job.status === 'completed' &&
      observedActiveJobIds.has(job.jobId) &&
      !shownReceiptJobIds.has(job.jobId) &&
      Array.isArray(job.legs) &&
      job.legs.some((l) => l.status === 'landed' || l.status === 'attested')
    ) {
      shownReceiptJobIds.add(job.jobId);
      openReceiptModal(job);
    }
  }

  if (defiStepperState?.jobId) {
    const tracked = jobsList.find((j) => j.jobId === defiStepperState.jobId);
    if (tracked) {
      const allSettled =
        tracked.legs.length > 0 &&
        tracked.legs.every((l) => l.status === 'landed' || l.status === 'attested');
      const anyFailed = tracked.legs.some((l) => l.status === 'failed');
      const solLeg = tracked.legs.find((l) => l.solanaTxHash);
      if (allSettled) {
        updateDefiStepperStep(
          'confirm',
          {
            status: 'done',
            detail: `Settled on Solana (${tracked.legs.length}/${tracked.legs.length} chains confirmed)`,
            txUrl: safeExplorerTxUrl('https://solscan.io', solLeg?.solanaTxHash) || undefined,
            txLabel: 'Solscan ↗',
          },
          { active: false, dismissible: true }
        );
      } else if (anyFailed && !defiStepperState.dismissible) {
        updateDefiStepperStep('confirm', { status: 'failed', detail: 'Check Activity for leg status' }, { active: false, dismissible: true });
      }
    }
  }
}

function applyLocalJobLegPatch(jobId, chain, patch) {
  const job = backgroundJobs.find((j) => j && j.jobId === jobId);
  if (!job || !Array.isArray(job.legs)) return null;
  const now = new Date().toISOString();
  const leg = job.legs.find((l) => l.chain === chain || (patch?.legId && l.legId === patch.legId));
  if (leg) {
    Object.assign(leg, patch, { updatedAt: now });
  }
  const terminal = new Set(['landed', 'attested', 'failed']);
  const allDone = job.legs.length > 0 && job.legs.every((l) => terminal.has(l.status));
  job.status = allDone ? 'completed' : 'active';
  job.updatedAt = now;
  saveLocalSweepJobs();
  renderBackgroundAgentUI();
  if (patch && (patch.evmTxHash || patch.status === 'landed' || patch.status === 'attested' || patch.status === 'failed')) {
    reconcileJobsIntoInflightBridges(backgroundJobs);
  }
  checkJobCompletionAndUi(backgroundJobs);
  return job;
}

async function syncBackgroundJobs() {
  if (!canAccessAdminRoutes()) {
    if (!backgroundJobs.length) {
      const persisted = loadLocalSweepJobs();
      if (persisted.length) {
        backgroundJobs = persisted;
      }
    }
    renderBackgroundAgentUI();
    reconcileJobsIntoInflightBridges(backgroundJobs);
    checkJobCompletionAndUi(backgroundJobs);
    return;
  }
  try {
    const res = await api('/api/jobs');
    const serverJobs = Array.isArray(res.jobs) ? res.jobs : [];
    const localOnly = backgroundJobs.filter((j) => j?.jobId?.startsWith('local_'));
    backgroundJobs = [...localOnly, ...serverJobs];
    renderBackgroundAgentUI();
    reconcileJobsIntoInflightBridges(backgroundJobs);
    checkJobCompletionAndUi(backgroundJobs);

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
  applyLocalJobLegPatch(jobId, chain, patch);
  if (!canAccessAdminRoutes() || String(jobId).startsWith('local_')) {
    return;
  }
  try {
    const updated = await api(`/api/jobs/${encodeURIComponent(jobId)}/leg`, {
      method: 'POST',
      body: JSON.stringify({ chain, ...patch }),
    });
    const idx = backgroundJobs.findIndex((j) => j.jobId === updated.jobId);
    if (idx >= 0) backgroundJobs[idx] = updated;
    else backgroundJobs.unshift(updated);
    renderBackgroundAgentUI();
    checkJobCompletionAndUi(backgroundJobs);
  } catch {
    // ignore transient job patch errors (local state already updated)
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
    if (btnEl) btnEl.innerHTML = `${uiIcon('check', 12)}<span>Prove</span>`;
  }
}

async function claimCctpLegOnSolana(job, leg, btnEl = null) {
  if (!job || !leg?.evmTxHash) return;
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = 'Preparing Claim…';
  }
  try {
    let solPayer = getConnectedSolanaAddress();
    if (!solPayer) {
      const avail = listAvailableSolanaWallets();
      if (avail.length) {
        const conn = await connectSolanaWallet();
        solPayer = conn?.address || getConnectedSolanaAddress();
        updateWalletButtons();
      }
    }

    const claimPlan = await api('/api/cctp/solana-claim-tx', {
      method: 'POST',
      body: JSON.stringify({
        chain: leg.chain,
        txHash: leg.evmTxHash,
        solanaDestination: job.solanaDestination,
        payer: solPayer || job.solanaDestination,
      }),
    });

    if (btnEl) btnEl.textContent = 'Sign in Solana Wallet…';
    const result = await claimCctpOnSolana(claimPlan, {
      expectedSolanaDestination: job.solanaDestination,
      autoConnect: true,
    });

    await patchJobLeg(job.jobId, leg.chain, {
      status: 'landed',
      solanaTxHash: result.signature,
      attestationStatus: 'claimed',
      statusText: `Claimed ${safeNum(claimPlan.amountUsdc).toFixed(2)} USDC on Solana (${result.walletName})`,
    });
    upsertInflightBridge({
      chain: leg.chain,
      chainName: leg.chainName || leg.chain,
      provider: leg.provider || 'cctp',
      txHash: leg.evmTxHash,
      jobId: job.jobId || '',
      solanaDestination: job.solanaDestination || '',
      outputAsset: job.outputAsset || 'USDC',
      amountUsd: safeNum(claimPlan.amountUsdc) || safeNum(leg.estimatedNetUsd),
      requiresSolanaClaim: true,
      status: 'landed',
      attestationStatus: 'claimed',
      solanaTxHash: result.signature,
      statusText: `Claimed ${safeNum(claimPlan.amountUsdc).toFixed(2)} USDC on Solana`,
    });
    await syncBackgroundJobs();
    refreshSolanaBalance();
    showToast(
      `Claimed ${safeNum(claimPlan.amountUsdc).toFixed(2)} USDC on Solana (${shortAddr(result.signature)}).`
    );
  } catch (err) {
    if (isUserRejectedError(err)) {
      showToast('Solana CCTP claim signature cancelled in wallet.');
    } else if (Array.isArray(err?.fallbackInstructions) && err.fallbackInstructions.length) {
      const fallbackNote = `${err.message} ${err.fallbackInstructions[0]}`;
      await patchJobLeg(job.jobId, leg.chain, {
        status: leg.status === 'attested' ? 'attested' : 'relaying',
        statusText: fallbackNote,
      });
      showToast(fallbackNote);
    } else {
      showToast(err?.message || 'Could not claim CCTP USDC on Solana.');
    }
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = 'Claim USDC on Solana';
    }
  }
}

async function executeGaslessIntentChain(chain, jobId, chainAssets, userAddress, solDest) {
  const legFamily =
    chainAssets[0]?.family ||
    (currentScan.family && currentScan.family !== 'mixed' ? currentScan.family : activeFamily);
  const isNonEvm = legFamily !== 'evm';

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
  if (!isNonEvm && (intent.previewOnly || (!intent.typedData && !intent.signPayload))) {
    const msg =
      intent.explanation ||
      'Gasless relayer is in preview mode (router/treasury not configured on this chain). Switch to Direct 1-Click mode.';
    await patchJobLeg(jobId, chain, {
      status: 'skipped',
      provider: intent.mode,
      statusText: msg,
    });
    showToast(msg);
    return;
  }
  await patchJobLeg(jobId, chain, {
    status: 'signing',
    provider: intent.mode,
    statusText: `Sign 1 gasless message ($0 gas · ${intent.coveredAssets.length} asset(s))…`,
  });
  const signOpts = {
    expectedFrom: userAddress,
    expectedSolanaDestination: solDest,
  };
  const signature = isNonEvm
    ? await signFamilyGaslessIntent(legFamily, intent, signOpts)
    : await signGaslessTypedData(intent.typedData || intent.signPayload, intent.chainId, signOpts);
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
  const broadcasted = Boolean(receipt.broadcasted || (receipt.mode === 'relayer_submitted' && receipt.txHash));
  await patchJobLeg(jobId, chain, {
    status: broadcasted ? 'relaying' : 'queued',
    provider: intent.mode,
    evmTxHash: receipt.txHash,
    statusText: receipt.nextStep,
  });
  if (receipt.txHash) {
    const legEst = currentPlan?.legs?.find((l) => l.chain === chain);
    upsertInflightBridge({
      chain,
      chainName: legEst?.chainName || chainAssets[0]?.chainName || chain,
      provider: intent.mode || 'gasless_intent',
      txHash: receipt.txHash,
      jobId: jobId || '',
      solanaDestination: solDest,
      outputAsset,
      amountUsd: safeNum(legEst?.bridgedUsdc),
      assetCount: chainAssets.length,
      explorerUrl: currentScan?.chains?.find((c) => c.chain === chain)?.explorerUrl || '',
      requiresSolanaClaim: false,
      status: broadcasted ? 'relaying' : 'confirming',
      statusText: receipt.nextStep || 'Relaying gasless sweep to Solana…',
    });
  }
  showToast(receipt.nextStep);
}

async function sendCallsWithFallback({
  chainId,
  chain,
  chainName,
  calls,
  jobId,
  primaryProvider,
  stepLabelPrefix = '',
  expectedFrom,
  expectedSolanaDestination,
}) {
  const chainCap = isChainBatchSupported(chainId);
  let submittedHashes = [];
  let usedEip5792 = false;
  const shouldTryEip5792 =
    chainCap.supported || (chainCap.status === 'unknown' && calls.length > 1);

  if (shouldTryEip5792) {
    try {
      await patchJobLeg(jobId, chain, {
        status: 'signing',
        provider: primaryProvider,
        callsBatched: calls.length,
        statusText: `${stepLabelPrefix}Confirm 1 batch (${calls.length} calls) in your wallet…`,
      });

      const { batchId } = await sendEip5792Batch({
        chainId,
        calls,
        expectedFrom,
        expectedSolanaDestination,
      });
      usedEip5792 = true;

      await patchJobLeg(jobId, chain, {
        status: 'confirming',
        statusText: `${stepLabelPrefix}Batch submitted (${shortAddr(batchId)}) · confirming…`,
      });

      const settled = await waitForEip5792Batch(batchId, (upd) => {
        patchJobLeg(jobId, chain, {
          status: 'confirming',
          evmTxHash: upd.txHashes?.[0],
          statusText: `${stepLabelPrefix}Confirming on ${chainName}…`,
        });
      });

      submittedHashes = settled.txHashes || [];
      if (settled.failed) {
        return {
          failed: true,
          failedReason: `Batch ${settled.status || 'reverted'} onchain`,
          submittedHashes,
          usedEip5792,
        };
      }
      if (settled.status === 'TIMEOUT' || !settled.confirmed) {
        return {
          failed: false,
          timedOut: true,
          submittedHashes,
          usedEip5792,
        };
      }
    } catch (err) {
      if (isUserRejectedError(err)) throw err;
      if (!err?.unsupportedEip5792) throw err;
      showToast(`${chainName}: wallet lacks EIP-5792 — using sequential signing.`);
    }
  }

  if (!usedEip5792) {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i];
      await patchJobLeg(jobId, chain, {
        status: 'signing',
        provider: primaryProvider,
        statusText: `${stepLabelPrefix}Sign step ${i + 1}/${calls.length}: ${call.label}`,
      });
      const txHash = await sendRealEvmTransaction(
        {
          chainId,
          to: call.to,
          data: call.data,
          value: call.value,
          gas: call.gas,
          stepId: call.stepId,
          solanaDestination: call.solanaDestination,
        },
        {
          expectedFrom,
          expectedSolanaDestination,
        }
      );
      submittedHashes.push(txHash);
      const needsMining = i < calls.length - 1;
      if (needsMining) {
        await patchJobLeg(jobId, chain, {
          status: 'confirming',
          evmTxHash: txHash,
          statusText: `${stepLabelPrefix}Waiting for step ${i + 1}/${calls.length} confirmation…`,
        });
        const receipt = await waitForEvmReceipt(chain, txHash);
        if (!receipt?.evmConfirmed || receipt.evmFailed) {
          const reason = receipt?.evmFailed
            ? `${stepLabelPrefix}Step ${i + 1}/${calls.length} (${call.label}) reverted onchain — aborted remaining steps.`
            : `${stepLabelPrefix}Step ${i + 1}/${calls.length} (${call.label}) did not confirm in time — aborted remaining steps.`;
          return {
            failed: true,
            failedReason: reason,
            submittedHashes,
            usedEip5792,
          };
        }
      }
    }
  }

  return { failed: false, timedOut: false, submittedHashes, usedEip5792 };
}

function buildPrequoteFingerprint({
  chain,
  chainAssets,
  outputAsset: targetOut,
  solanaDestination,
  bridgePreference,
  protocolFeeBps,
  feeRecipientEvm,
  sourceAddress,
}) {
  const assetIds = Array.isArray(chainAssets)
    ? chainAssets
        .map((a) => String(a?.id || ''))
        .sort()
        .join(',')
    : '';
  return [
    String(chain || ''),
    String(sourceAddress || '').toLowerCase(),
    String(solanaDestination || '').trim(),
    String(targetOut || ''),
    String(bridgePreference || ''),
    String(protocolFeeBps ?? ''),
    String(feeRecipientEvm || '').toLowerCase(),
    assetIds,
  ].join('|');
}

async function executeChainBatchLive(chain, existingJobId = null, opts = {}) {
  if (!currentScan || !currentPlan) return;
  if (executingChains.has(chain)) {
    showToast(`${chain}: execution already in progress.`);
    return;
  }
  const effectiveScan = buildEffectiveScanForPlan();
  const overrideAssets = Array.isArray(opts?.overrideAssets) ? opts.overrideAssets : null;
  const chainAssets = overrideAssets
    ? overrideAssets.filter(
        (a) => a.chain === chain && a.action !== 'SKIP_HONEYPOT' && a.action !== 'SKIP_UNPRICED'
      )
    : effectiveScan.assets.filter(
        (a) =>
          a.chain === chain &&
          selectedAssetIds.has(a.id) &&
          a.action !== 'SKIP_HONEYPOT' &&
          a.action !== 'SKIP_UNPRICED'
      );
  if (!chainAssets.length) {
    showToast(`No selected assets on ${chain}.`);
    return;
  }

  const solDest = requireVerifiedSolanaDestination('sweep to Solana');
  if (!solDest) return;

  const isDefiGuided = Boolean(opts?.defiGuided || chainAssets.some(isDefiAsset));
  const bridgePreference = getActiveBridgePreference();
  const protocolFeeBps = getActiveProtocolFeeBps();
  const feeRecipientEvm = getActiveFeeRecipientEvm();
  const connectedEvm = getConnectedEvmAddress();
  const srcSession = getActiveSourceWallet();
  const userAddress = srcSession?.address || currentScan.walletAddress;
  const legSummary = currentPlan.legs.find((l) => l.chain === chain);

  executingChains.add(chain);
  renderChainQueueList();

  let jobId = existingJobId;
  try {
    if (!jobId) {
      const job = await createSweepJob({
        sourceWallet: userAddress,
        solanaDestination: solDest,
        outputAsset,
        bridgePreference,
        protocolFeeBps,
        feeRecipientEvm,
        legs: [
          {
            chain,
            chainName: legSummary?.chainName || chainAssets[0]?.chainName || chain,
            assetCount: chainAssets.length,
            estimatedNetUsd: legSummary?.bridgedUsdc ?? 0,
            estimatedFeeUsd: legSummary?.feeUsdc ?? 0,
          },
        ],
      });
      jobId = job.jobId;
      activeJobId = jobId;
      backgroundJobs.unshift(job);
      saveLocalSweepJobs();
      renderBackgroundAgentUI();
    }

    if (isDefiGuided && !defiStepperState) {
      const hasTwoStage = chainAssets.some((a) => isDefiAsset(a) && normalizeDefiPosition(a, outputAsset).requiresTwoStep);
      initDefiStepper({
        title: opts?.scopeTitle || `${legSummary?.chainName || chainAssets[0]?.chainName || chain} DeFi Exit`,
        mode: hasTwoStage ? 'two_stage' : 'atomic',
        jobId,
      });
    }

    await patchJobLeg(jobId, chain, {
      status: 'preparing',
      statusText: `Preparing ${chainAssets.length} asset(s) & live routes…`,
    });
    if (isDefiGuided) {
      updateDefiStepperStep('withdraw', {
        status: 'active',
        detail: `Preparing protocol withdrawal on ${legSummary?.chainName || chainAssets[0]?.chainName || chain}…`,
      });
    }

    const legFamily =
      chainAssets[0]?.family ||
      (currentScan.family && currentScan.family !== 'mixed' ? currentScan.family : activeFamily);
    const isNonEvm = legFamily !== 'evm';
    const legSession = isNonEvm ? getConnectedFamilyWallet(legFamily) : srcSession;
    const connectedSrc =
      (legFamily === 'cosmos' && legSession?.addressesByChain?.[chain]) ||
      legSession?.address ||
      null;
    if (isNonEvm) {
      const effectiveNonEvmAddr =
        connectedSrc || chainAssets[0]?.sourceWallet || userAddress;
      if (executionMode === 'gasless') {
        if (!connectedSrc) {
          await patchJobLeg(jobId, chain, {
            status: 'signing',
            statusText: `Connect ${legFamily.toUpperCase()} wallet to sign gasless sweep`,
          });
          openWalletModal('evm');
          return;
        }
        await executeGaslessIntentChain(chain, jobId, chainAssets, connectedSrc, solDest);
        if (isDefiGuided) {
          updateDefiStepperStep('withdraw', { status: 'done', detail: 'Signed 1-click withdrawal & bridge intent' });
          updateDefiStepperStep('bridge', { status: 'done', detail: `Relaying to Solana ${outputAsset}` });
          updateDefiStepperStep('confirm', { status: 'active', detail: 'Confirming arrival on Solana…' }, { dismissible: true });
        }
        return;
      }

      // Direct Native Non-EVM Conversion Mode (mirrors EVM/Rabby prepare-chain-batch -> native wallet execution!)
      const expectedNonEvmFp = buildPrequoteFingerprint({
        chain,
        chainAssets,
        outputAsset,
        solanaDestination: solDest,
        bridgePreference,
        protocolFeeBps,
        feeRecipientEvm: '',
        sourceAddress: effectiveNonEvmAddr,
      });
      const rawPrefetchedNonEvm = opts?.prequoter ? await opts.prequoter.getBatch(chain) : null;
      const prefetchedNonEvm =
        rawPrefetchedNonEvm && rawPrefetchedNonEvm.__prequoteFingerprint === expectedNonEvmFp
          ? rawPrefetchedNonEvm
          : null;
      const nonEvmBatch =
        prefetchedNonEvm ||
        (await api('/api/tx/prepare-chain-batch', {
          method: 'POST',
          body: JSON.stringify({
            chain,
            assets: chainAssets,
            userAddress: effectiveNonEvmAddr,
            solanaDestination: solDest,
            outputAsset,
            bridgePreference,
            protocolFeeBps,
            addressesByChain: legSession?.addressesByChain || undefined,
          }),
        }));

      if (!nonEvmBatch.calls?.length) {
        const skipReason =
          (nonEvmBatch.skippedAssets || []).map((s) => `${s.assetSymbol}: ${s.reason}`).join(' · ') ||
          nonEvmBatch.notes?.[0] ||
          `No live ${legFamily.toUpperCase()} → Solana conversion routes available`;
        await patchJobLeg(jobId, chain, {
          status: 'skipped',
          statusText: skipReason,
        });
        if (isDefiGuided) {
          updateDefiStepperStep('withdraw', { status: 'failed', detail: skipReason }, { active: false, dismissible: true });
        }
        showToast(skipReason);
        return;
      }

      if (!connectedSrc) {
        await patchJobLeg(jobId, chain, {
          status: 'signing',
          callsBatched: nonEvmBatch.calls.length,
          popupsSaved: nonEvmBatch.savings?.popupsSaved ?? 0,
          statusText: `${nonEvmBatch.calls.length} live ${nonEvmBatch.chainName} step(s) ready — connect ${legFamily.toUpperCase()} wallet to sign`,
        });
        openWalletModal('evm');
        return;
      }

      const primaryTracker = nonEvmBatch.bridgeTrackers?.[0];
      const execRes = await executeNonEvmDirectBatch(legFamily, nonEvmBatch, {
        expectedSolanaDestination: solDest,
        onStep: (idx, total, call) => {
          patchJobLeg(jobId, chain, {
            status: 'signing',
            provider: call.provider,
            callsBatched: total,
            statusText: `Confirm step ${idx + 1}/${total} in ${legSession?.walletName || legFamily.toUpperCase()}: ${call.label}`,
          });
        },
      });

      const primaryTxHash = execRes.txHashes?.[execRes.txHashes.length - 1];
      await patchJobLeg(jobId, chain, {
        status: 'relaying',
        provider: primaryTracker?.provider || execRes.mode,
        evmTxHash: primaryTxHash,
        requestId: primaryTracker?.requestId,
        requiresSolanaClaim: Boolean(primaryTracker?.requiresSolanaClaim),
        statusText: `Submitted on ${nonEvmBatch.chainName} (${primaryTracker?.estimatedOutput || outputAsset}) · tracking settlement to Solana…`,
      });
      if (primaryTxHash) {
        upsertInflightBridge({
          chain,
          chainName: nonEvmBatch.chainName || chain,
          provider: primaryTracker?.provider || execRes.mode || 'bridge',
          txHash: primaryTxHash,
          requestId: primaryTracker?.requestId || '',
          jobId: jobId || '',
          solanaDestination: solDest,
          outputAsset,
          amountUsd: safeNum(legSummary?.bridgedUsdc),
          assetCount: chainAssets.length,
          explorerUrl: currentScan?.chains?.find((c) => c.chain === chain)?.explorerUrl || '',
          requiresSolanaClaim: Boolean(primaryTracker?.requiresSolanaClaim),
          status: 'relaying',
          statusText: `Submitted on ${nonEvmBatch.chainName} · tracking settlement to Solana…`,
        });
      }
      if (isDefiGuided) {
        updateDefiStepperStep('withdraw', { status: 'done', detail: `Confirmed on ${nonEvmBatch.chainName}` });
        updateDefiStepperStep('bridge', { status: 'done', detail: `Relaying to Solana ${outputAsset}` });
        updateDefiStepperStep('confirm', { status: 'active', detail: 'Confirming arrival on Solana…' }, { dismissible: true });
      }
      showToast(`${nonEvmBatch.chainName}: conversion submitted → tracking arrival on Solana.`);
      return;
    }

    const hasSolanaSigner = Boolean(getConnectedSolanaAddress());
    const expectedEvmFp = buildPrequoteFingerprint({
      chain,
      chainAssets,
      outputAsset,
      solanaDestination: solDest,
      bridgePreference,
      protocolFeeBps,
      feeRecipientEvm,
      sourceAddress: connectedEvm || userAddress,
    });
    const rawPrefetchedEvmBatch = opts?.prequoter ? await opts.prequoter.getBatch(chain) : null;
    const prefetchedEvmBatch =
      rawPrefetchedEvmBatch &&
      rawPrefetchedEvmBatch.__prequoteFingerprint === expectedEvmFp &&
      (!opts?.snapshotSourceAddress ||
        (connectedEvm && connectedEvm.toLowerCase() === String(opts.snapshotSourceAddress).toLowerCase()))
        ? rawPrefetchedEvmBatch
        : null;
    const batch =
      prefetchedEvmBatch ||
      (await api('/api/tx/prepare-chain-batch', {
        method: 'POST',
        body: JSON.stringify({
          chain,
          assets: chainAssets,
          userAddress: connectedEvm || userAddress,
          solanaDestination: solDest,
          outputAsset,
          bridgePreference,
          protocolFeeBps,
          feeRecipientEvm,
          bundleDefiCctp: hasSolanaSigner || bridgePreference === 'cctp',
          consolidateMultiInputDust: true,
        }),
      }));

    if (batch.dustConsolidation?.consolidated) {
      showToast(
        `${batch.chainName}: consolidated ${safeInt(batch.dustConsolidation.consolidatedTokenCount)} dust tokens into 1 multi-input swap (${safeInt(batch.dustConsolidation.swapPopupsEliminated)} prompt(s) eliminated).`
      );
    }

    if (!batch.calls.length) {
      const skipReason =
        batch.skippedAssets.map((s) => `${s.assetSymbol}: ${sanitizePlainDefiText(s.reason)}`).join(' · ') ||
        'No executable calls';
      await patchJobLeg(jobId, chain, {
        status: 'skipped',
        statusText: skipReason,
      });
      if (isDefiGuided) {
        updateDefiStepperStep('withdraw', { status: 'failed', detail: skipReason }, { active: false, dismissible: true });
      }
      return;
    }

    if (!connectedEvm) {
      await patchJobLeg(jobId, chain, {
        status: 'signing',
        callsBatched: batch.calls.length,
        popupsSaved: batch.savings.popupsSaved,
        statusText: `${batch.calls.length} calls ready in 1 click — connect EVM wallet to sign`,
      });
      if (isDefiGuided) {
        updateDefiStepperStep('withdraw', { status: 'active', detail: 'Connect your EVM wallet to sign withdrawal' }, { dismissible: true });
      }
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

    const hasDefiContractExits = chainAssets.some(
      (a) =>
        a.action === 'WITHDRAW_AND_BRIDGE' &&
        a.protocol &&
        !a.protocol.toLowerCase().includes('lido')
    );

    if (executionMode === 'gasless' && !hasDefiContractExits) {
      await executeGaslessIntentChain(chain, jobId, chainAssets, connectedEvm, solDest);
      if (isDefiGuided) {
        updateDefiStepperStep('withdraw', { status: 'done', detail: `Signed instant swap on ${batch.chainName}` });
        updateDefiStepperStep('bridge', { status: 'done', detail: `Relaying to Solana ${outputAsset}` });
        updateDefiStepperStep('confirm', { status: 'active', detail: 'Tracking confirmation on Solana…' }, { dismissible: true });
      }
      return;
    }
    if (executionMode === 'gasless' && hasDefiContractExits) {
      showToast(
        `${batch.chainName}: withdrawing from DeFi protocol directly via wallet batch so funds unlock cleanly.`
      );
    }

    const requiresSolanaClaim = batch.bridgeTrackers.some((t) => t.requiresSolanaClaim);
    const primaryRelay = batch.bridgeTrackers.find((t) => t.provider === 'relay' && t.requestId);
    const primaryProvider = primaryRelay?.provider || batch.bridgeTrackers[0]?.provider || 'eip5792_batch';

    if (isDefiGuided) {
      updateDefiStepperStep('withdraw', {
        status: 'active',
        detail: `Confirm withdrawal on ${batch.chainName} (${batch.calls.length} ${batch.calls.length === 1 ? 'call' : 'calls'})…`,
      });
    }

    // Zero-gas pre-sign guard: never open a doomed wallet popup when live native balance is 0
    const liveChainMeta = currentScan.chains.find((c) => c.chain === chain);
    const liveNativeBal = safeNum(liveChainMeta?.nativeBalance);
    const liveRpcMode = String(liveChainMeta?.rpcStatus || '').toLowerCase();
    if (
      liveChainMeta &&
      liveRpcMode &&
      liveRpcMode !== 'preset' &&
      liveRpcMode !== 'error' &&
      liveNativeBal <= 0
    ) {
      const sym = liveChainMeta.nativeSymbol || 'gas';
      const noGasMsg = `${batch.chainName} has 0 ${sym} ($0.00) for gas — refuel ~$1 ${sym} from a funded chain first.`;
      await patchJobLeg(jobId, chain, {
        status: 'failed',
        statusText: noGasMsg,
      });
      if (isDefiGuided) {
        updateDefiStepperStep('withdraw', { status: 'failed', detail: noGasMsg }, { active: false, dismissible: true });
      }
      showToast(noGasMsg);
      return { userRejected: false, failed: true, zeroGas: true };
    }

    const stage1 = await sendCallsWithFallback({
      chainId: batch.chainId,
      chain,
      chainName: batch.chainName,
      calls: batch.calls,
      jobId,
      primaryProvider,
      expectedFrom: connectedEvm,
      expectedSolanaDestination: solDest,
    });

    if (stage1.failed) {
      const failText = stage1.failedReason || 'Batch reverted onchain';
      await patchJobLeg(jobId, chain, {
        status: 'failed',
        evmTxHash: stage1.submittedHashes[0],
        statusText: failText,
      });
      if (isDefiGuided) {
        updateDefiStepperStep('withdraw', { status: 'failed', detail: failText }, { active: false, dismissible: true });
      }
      showToast(failText);
      return;
    }

    if (stage1.timedOut) {
      await patchJobLeg(jobId, chain, {
        status: 'confirming',
        evmTxHash: stage1.submittedHashes[0],
        statusText: `Still confirming on ${batch.chainName} — check wallet or explorer before retrying.`,
      });
      showToast(`${batch.chainName} batch confirmation timed out — still pending onchain.`);
      return;
    }

    const stage1TxHash = stage1.submittedHashes[stage1.submittedHashes.length - 1];
    const hasDefiExitCall = batch.calls.some(
      (c) =>
        c.stepId === 'aave_withdraw' ||
        c.stepId === 'compound_withdraw' ||
        c.stepId === 'erc4626_redeem' ||
        c.stepId.includes('withdraw') ||
        c.stepId.includes('redeem')
    );
    const hasCctpAfterDefi = batch.calls.some((c) => c.stepId === 'cctp_deposit_for_burn_after_defi');
    const needsAutoStage2Bridge = hasDefiExitCall && !hasCctpAfterDefi && !batch.bridgeTrackers.length;
    const explorerBase = currentScan.chains.find((c) => c.chain === chain)?.explorerUrl || '';
    const stage1TxUrl = safeExplorerTxUrl(explorerBase, stage1TxHash) || undefined;

    if (needsAutoStage2Bridge) {
      // Wait for Stage 1 withdrawal confirmation, then AUTOMATICALLY launch Stage 2 Bridge!
      if (!stage1.usedEip5792 && stage1TxHash) {
        await patchJobLeg(jobId, chain, {
          status: 'confirming',
          evmTxHash: stage1TxHash,
          statusText: `Step 1/2: Confirming protocol withdrawal on ${batch.chainName}…`,
        });
        if (isDefiGuided) {
          updateDefiStepperStep(
            'withdraw',
            {
              status: 'active',
              detail: `Waiting for withdrawal confirmation on ${batch.chainName}…`,
              txUrl: stage1TxUrl,
              txLabel: 'EVM ↗',
            },
            { mode: 'two_stage' }
          );
        }
        const receipt1 = await waitForEvmReceipt(batch.chain, stage1TxHash);
        if (!receipt1?.evmConfirmed || receipt1.evmFailed) {
          const reason1 = receipt1?.evmFailed
            ? 'Step 1 protocol withdrawal failed onchain'
            : 'Step 1 protocol withdrawal did not confirm in time — aborted bridge step';
          await patchJobLeg(jobId, chain, {
            status: 'failed',
            evmTxHash: stage1TxHash,
            statusText: reason1,
          });
          if (isDefiGuided) {
            updateDefiStepperStep('withdraw', { status: 'failed', detail: reason1 }, { active: false, dismissible: true });
          }
          showToast(reason1);
          return;
        }
      }

      if (isDefiGuided) {
        updateDefiStepperStep(
          'withdraw',
          {
            status: 'done',
            detail: `Withdrawn on ${batch.chainName}`,
            txUrl: stage1TxUrl,
            txLabel: 'EVM ↗',
          },
          { mode: 'two_stage' }
        );
        updateDefiStepperStep('bridge', {
          status: 'active',
          detail: `Withdrawal confirmed — auto-preparing bridge to Solana ${outputAsset}…`,
        });
      }

      await patchJobLeg(jobId, chain, {
        status: 'preparing',
        evmTxHash: stage1TxHash,
        statusText: `Step 2/2: Unlocked on ${batch.chainName} — auto-preparing bridge to Solana…`,
      });

      const unlockedAssets = buildUnlockedUnderlyingAssets(chain, chainAssets.filter(isDefiAsset));
      if (unlockedAssets.length > 0) {
        const stage2Batch = await api('/api/tx/prepare-chain-batch', {
          method: 'POST',
          body: JSON.stringify({
            chain,
            assets: unlockedAssets,
            userAddress: connectedEvm,
            solanaDestination: solDest,
            outputAsset,
            bridgePreference,
            protocolFeeBps,
            feeRecipientEvm,
            bundleDefiCctp: false,
          }),
        });

        if (stage2Batch.calls.length > 0) {
          const s2Relay = stage2Batch.bridgeTrackers.find((t) => t.provider === 'relay' && t.requestId);
          const s2Provider = s2Relay?.provider || stage2Batch.bridgeTrackers[0]?.provider || primaryProvider;
          const s2NeedsClaim = stage2Batch.bridgeTrackers.some((t) => t.requiresSolanaClaim);

          if (isDefiGuided) {
            updateDefiStepperStep('bridge', {
              status: 'active',
              detail: `Confirm bridge to Solana ${outputAsset} (${stage2Batch.calls.length} ${stage2Batch.calls.length === 1 ? 'call' : 'calls'})…`,
            });
          }

          const stage2 = await sendCallsWithFallback({
            chainId: stage2Batch.chainId,
            chain,
            chainName: stage2Batch.chainName,
            calls: stage2Batch.calls,
            jobId,
            primaryProvider: s2Provider,
            stepLabelPrefix: 'Step 2/2: ',
            expectedFrom: connectedEvm,
            expectedSolanaDestination: solDest,
          });

          if (stage2.failed) {
            const failMsg = stage2.failedReason || 'Step 2 bridge transaction reverted — unlocked tokens remain safely in your wallet.';
            await patchJobLeg(jobId, chain, {
              status: 'failed',
              evmTxHash: stage2.submittedHashes[0] || stage1TxHash,
              statusText: failMsg,
            });
            if (isDefiGuided) {
              updateDefiStepperStep(
                'bridge',
                { status: 'failed', detail: failMsg },
                { active: false, dismissible: true }
              );
            }
            showToast(failMsg);
            return;
          }

          if (stage2.timedOut) {
            await patchJobLeg(jobId, chain, {
              status: 'confirming',
              evmTxHash: stage2.submittedHashes[0] || stage1TxHash,
              statusText: `Step 2 bridge still confirming on ${batch.chainName}…`,
            });
            return;
          }

          const stage2TxHash = stage2.submittedHashes[stage2.submittedHashes.length - 1];
          const stage2TxUrl = safeExplorerTxUrl(explorerBase, stage2TxHash) || undefined;

          await patchJobLeg(jobId, chain, {
            status: stage2Batch.bridgeTrackers.length ? 'relaying' : 'landed',
            provider: s2Provider,
            evmTxHash: stage2TxHash || stage1TxHash,
            requestId: s2Relay?.requestId,
            requiresSolanaClaim: s2NeedsClaim,
            statusText: `Withdrawn & bridging unlocked funds on ${batch.chainName} → Solana ${outputAsset}…`,
          });
          if (stage2TxHash || stage1TxHash) {
            upsertInflightBridge({
              chain,
              chainName: batch.chainName || chain,
              provider: s2Provider,
              txHash: stage2TxHash || stage1TxHash,
              requestId: s2Relay?.requestId || '',
              jobId: jobId || '',
              solanaDestination: solDest,
              outputAsset,
              amountUsd: safeNum(legSummary?.bridgedUsdc),
              assetCount: chainAssets.length,
              explorerUrl: explorerBase,
              requiresSolanaClaim: s2NeedsClaim,
              status: stage2Batch.bridgeTrackers.length ? 'relaying' : 'landed',
              statusText: `Bridging unlocked funds on ${batch.chainName} → Solana ${outputAsset}…`,
            });
          }

          if (isDefiGuided) {
            updateDefiStepperStep('bridge', {
              status: 'done',
              detail: `Bridge submitted on ${batch.chainName}`,
              txUrl: stage2TxUrl,
              txLabel: 'Bridge Tx ↗',
            });
            updateDefiStepperStep(
              'confirm',
              { status: 'active', detail: `Relaying ${outputAsset} to your Solana wallet…` },
              { dismissible: true }
            );
          }

          showToast(`${batch.chainName}: withdrawal confirmed and bridge to Solana ${outputAsset} submitted automatically!`);
          syncBackgroundJobs();
          return;
        }
      }

      // Graceful fallback if Stage 2 bridge calls weren't available (e.g., unsupported underlying)
      await patchJobLeg(jobId, chain, {
        status: 'landed',
        provider: primaryProvider,
        evmTxHash: stage1TxHash,
        statusText: `Withdrawn from protocol on ${batch.chainName} — unlocked tokens are in your wallet.`,
      });
      if (isDefiGuided) {
        updateDefiStepperStep(
          'bridge',
          { status: 'done', detail: 'Unlocked tokens delivered to your wallet — ready for Solana sweep' },
          { active: false, dismissible: true }
        );
      }
      showToast(`${batch.chainName}: protocol withdrawal confirmed! Refreshing balances…`);
      syncBackgroundJobs();
      setTimeout(() => runScan({ address: connectedEvm, family: 'evm', autoOpen: false }), 2200);
      return;
    }

    // Atomic 1-Click path (Instant swap or Atomic Withdraw + CCTP/Relay)
    await patchJobLeg(jobId, chain, {
      status: batch.bridgeTrackers.length ? 'relaying' : 'landed',
      provider: primaryProvider,
      evmTxHash: stage1TxHash,
      requestId: primaryRelay?.requestId,
      requiresSolanaClaim,
      statusText: batch.bridgeTrackers.length
        ? `Confirmed on ${batch.chainName} · relaying to Solana in background…`
        : `Confirmed on ${batch.chainName}`,
    });
    if (stage1TxHash && (batch.bridgeTrackers.length > 0 || requiresSolanaClaim)) {
      upsertInflightBridge({
        chain,
        chainName: batch.chainName || chain,
        provider: primaryProvider,
        txHash: stage1TxHash,
        requestId: primaryRelay?.requestId || '',
        jobId: jobId || '',
        solanaDestination: solDest,
        outputAsset,
        amountUsd: safeNum(legSummary?.bridgedUsdc),
        assetCount: chainAssets.length,
        explorerUrl: explorerBase,
        requiresSolanaClaim,
        status: 'relaying',
        statusText: `Confirmed on ${batch.chainName} · relaying to Solana…`,
      });
    }

    if (isDefiGuided) {
      updateDefiStepperStep('withdraw', {
        status: 'done',
        detail: `Confirmed on ${batch.chainName}`,
        txUrl: stage1TxUrl,
        txLabel: 'EVM ↗',
      });
      updateDefiStepperStep('bridge', {
        status: 'done',
        detail: batch.bridgeTrackers.length
          ? `Routed atomically to Solana ${outputAsset}`
          : `Settled on ${batch.chainName}`,
      });
      updateDefiStepperStep(
        'confirm',
        {
          status: batch.bridgeTrackers.length ? 'active' : 'done',
          detail: batch.bridgeTrackers.length
            ? `Tracking ${outputAsset} confirmation on Solana…`
            : 'Confirmed onchain',
        },
        { active: Boolean(batch.bridgeTrackers.length), dismissible: true }
      );
    }

    showToast(`${batch.chainName} submitted — Turgalium Background Agent is tracking Solana settlement.`);
    syncBackgroundJobs();
    return { userRejected: false, failed: false };
  } catch (err) {
    const userRejected = isUserRejectedError(err);
    if (jobId) {
      await patchJobLeg(jobId, chain, {
        status: 'failed',
        statusText: err?.message || 'Cancelled or failed',
      });
    }
    if (isDefiGuided) {
      updateDefiStepperStep(
        'withdraw',
        { status: 'failed', detail: err?.message || 'Cancelled or failed' },
        { active: false, dismissible: true }
      );
    }
    showToast(err?.message || 'Execution failed');
    return { userRejected, failed: true, error: err };
  } finally {
    executingChains.delete(chain);
    renderChainQueueList();
  }
}

function buildOneClickFingerprint({ activeChains, solDest, sourceAddress, bridgePreference, selectedIds }) {
  return [
    String(sourceAddress || '').toLowerCase(),
    String(solDest || ''),
    outputAsset,
    String(bridgePreference || 'auto'),
    executionMode,
    Array.from(activeChains || []).sort().join(','),
    Array.from(selectedIds || []).sort().join(','),
  ].join('|');
}

function clearOneClickSweepSummary() {
  pendingBatchSummary = null;
  const card = document.getElementById('oneClickSweepSummaryCard');
  if (card) {
    card.classList.add('hidden');
    card.classList.remove('is-ready', 'is-warn');
    card.innerHTML = '';
  }
}

function findBestGasRefuelSourceChain(targetChain) {
  const chains = Array.isArray(currentScan?.chains) ? currentScan.chains : [];
  const preferredOrder = ['base', 'arbitrum', 'optimism', 'avalanche', 'polygon', 'ethereum'];
  const candidates = chains
    .filter((c) => {
      if (!c || !c.chain || c.chain === targetChain) return false;
      const usd = safeNum(c.nativeBalance) * safeNum(c.nativePriceUsd);
      return usd >= 1.35 && c.rpcStatus !== 'error';
    })
    .sort((a, b) => {
      const ia = preferredOrder.indexOf(a.chain);
      const ib = preferredOrder.indexOf(b.chain);
      const pa = ia >= 0 ? ia : 99;
      const pb = ib >= 0 ? ib : 99;
      if (pa !== pb) return pa - pb;
      return safeNum(b.nativeBalance) * safeNum(b.nativePriceUsd) - safeNum(a.nativeBalance) * safeNum(a.nativePriceUsd);
    });
  return candidates[0] || null;
}

async function executeOneClickGasRefuel(fromChain, toChain, triggerBtn) {
  const connectedEvm = getConnectedEvmAddress();
  if (!connectedEvm) {
    showToast('Connect your EVM wallet first to refuel gas.');
    openWalletModal('evm');
    return;
  }
  const origText = triggerBtn?.textContent || '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Building 1-Click Refuel…';
  }
  try {
    const quote = await api('/api/gas/refuel-quote', {
      method: 'POST',
      body: JSON.stringify({
        fromChain,
        toChain,
        userAddress: connectedEvm,
        amountUsd: 1.0,
      }),
    });
    const tx = quote?.transaction;
    if (!tx?.to || !tx?.chainId) {
      throw new Error('Could not build gas refuel transaction.');
    }
    if (triggerBtn) triggerBtn.textContent = `Confirm in Wallet (${quote.fromChainName})…`;
    const sendRes = await sendCallsWithFallback({
      chainId: tx.chainId,
      chain: tx.chain,
      chainName: quote.fromChainName,
      calls: [
        {
          to: tx.to,
          data: tx.data || '0x',
          value: tx.value || '0x0',
          gas: tx.gas || undefined,
          stepId: 'gas_refuel',
          label: tx.label || `Refuel ${quote.toChainName} gas`,
        },
      ],
      primaryProvider: 'relay',
      expectedFrom: connectedEvm,
    });
    if (sendRes?.failed) {
      throw new Error(sendRes.failedReason || 'Gas refuel transaction failed.');
    }
    showToast(
      `Gas refuel sent: ${quote.estimatedOutFormatted} arriving on ${quote.toChainName} in ~${quote.estimatedSeconds}s. Refreshing balances…`
    );
    clearOneClickSweepSummary();
    setTimeout(() => {
      if (connectedEvm) {
        runScan({ address: connectedEvm, refresh: true, autoOpen: true }).catch(() => {});
      }
    }, Math.min(8000, Math.max(3500, safeInt(quote.estimatedSeconds) * 1000)));
  } catch (err) {
    showToast(err?.message || 'Gas refuel failed.');
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = origText;
    }
  }
}

function renderOneClickSweepSummary() {
  const card = document.getElementById('oneClickSweepSummaryCard');
  if (!card) return;
  if (!pendingBatchSummary || !pendingBatchSummary.batch) {
    clearOneClickSweepSummary();
    return;
  }

  const { batch, activeChains, outputAsset: snapOut } = pendingBatchSummary;
  const items = Array.isArray(batch.items) ? batch.items : [];
  const failedItems = items.filter((it) => it && it.ok === false);
  const readyCount = safeInt(batch.readyCount);
  const totalCount = Math.max(readyCount + safeInt(batch.failedCount), safeInt(batch.count));
  const totalNetUsd = safeNum(batch.totalNetUsd);
  const totalGasUsd = safeNum(batch.totalGasUsd);
  const totalSignatures = Math.max(1, safeInt(batch.totalSignatures || activeChains.length));
  const durationMs = Math.max(0, Math.round(safeNum(batch.durationMs)));

  const chainsCovered = Array.from(
    new Set(
      items.filter((it) => it && it.ok !== false && it.chain).map((it) => it.chain)
    )
  );
  const displayChains = chainsCovered.length ? chainsCovered : activeChains;

  // Detect zero-gas chains from live RPC chainGasStatus OR live scan nativeBalance === 0
  const batchZeroGas = Array.isArray(batch.zeroGasChains) ? batch.zeroGasChains : [];
  const gasStatusMap = batch.chainGasStatus && typeof batch.chainGasStatus === 'object' ? batch.chainGasStatus : {};
  const zeroGasSet = new Set(batchZeroGas);
  for (const ch of displayChains) {
    const sc = currentScan?.chains?.find((c) => c.chain === ch);
    if (
      sc &&
      sc.rpcStatus &&
      sc.rpcStatus !== 'preset' &&
      sc.rpcStatus !== 'error' &&
      safeNum(sc.nativeBalance) <= 0
    ) {
      zeroGasSet.add(ch);
    }
  }
  const zeroGasChains = displayChains.filter((ch) => zeroGasSet.has(ch));
  const fundedChains = displayChains.filter((ch) => !zeroGasSet.has(ch));
  const hasZeroGas = zeroGasChains.length > 0 && executionMode !== 'gasless';
  const primaryZeroGasChain = zeroGasChains[0] || null;
  const primaryZeroGasInfo = primaryZeroGasChain
    ? gasStatusMap[primaryZeroGasChain] || currentScan?.chains?.find((c) => c.chain === primaryZeroGasChain)
    : null;
  const refuelSource = primaryZeroGasChain ? findBestGasRefuelSourceChain(primaryZeroGasChain) : null;

  const hasFailures = failedItems.length > 0 || hasZeroGas;
  const canProceed =
    (!hasZeroGas || fundedChains.length > 0) &&
    (readyCount > 0 || (items.length === 0 && displayChains.length > 0));

  card.classList.remove('hidden');
  card.classList.toggle('is-ready', !hasFailures && canProceed);
  card.classList.toggle('is-warn', hasFailures || !canProceed);

  const chainChipsHtml = displayChains
    .slice(0, 8)
    .map((ch) => {
      const logo = getChainLogoPath(ch);
      const darkCls = needsDarkLogoBacking(ch) ? ' logo-dark-backing' : '';
      const noGasCls = zeroGasSet.has(ch) ? ' is-no-gas' : '';
      const noGasTag = zeroGasSet.has(ch) ? ' · No Gas' : '';
      return `<span class="one-click-chain-chip${noGasCls}"><img src="${escapeHtml(logo)}" width="13" height="13" alt="" class="chain-logo-xs${darkCls}" />${escapeHtml(ch)}${escapeHtml(noGasTag)}</span>`;
    })
    .join('');

  const zeroGasHtml = hasZeroGas
    ? (() => {
        const names = zeroGasChains
          .map((ch) => {
            const st = gasStatusMap[ch] || currentScan?.chains?.find((c) => c.chain === ch);
            const sym = st?.nativeSymbol || 'gas';
            const bal = safeNum(st?.nativeBalanceUi ?? st?.nativeBalance ?? 0).toFixed(4);
            return `${st?.chainName || ch} (${bal} ${sym})`;
          })
          .join(', ');
        const targetSym = primaryZeroGasInfo?.nativeSymbol || 'gas';
        const targetName = primaryZeroGasInfo?.chainName || primaryZeroGasChain;
        const refuelBtnHtml = refuelSource
          ? `<button type="button" class="btn-pill-dark btn-sm" id="oneClickRefuelGasBtn">Refuel $1 ${escapeHtml(targetSym)} from ${escapeHtml(refuelSource.chainName || refuelSource.chain)}</button>`
          : '';
        const skipBtnHtml =
          fundedChains.length > 0
            ? `<button type="button" class="btn-outline-sm" id="oneClickSkipZeroGasBtn">Skip ${escapeHtml(zeroGasChains.length === 1 ? targetName : `${zeroGasChains.length} Zero-Gas`)} &amp; Sweep Funded (${fundedChains.length})</button>`
            : '';
        return `
          <div class="one-click-gas-rescue" id="oneClickGasRescueBox">
            <div class="one-click-gas-rescue-text">
              <strong>Not enough gas on ${escapeHtml(names)}.</strong>
              <span>Deposit ~$0.50 ${escapeHtml(targetSym)} or refuel in 1 click from a funded chain before signing.</span>
            </div>
            ${
              refuelBtnHtml || skipBtnHtml
                ? `<div class="one-click-gas-rescue-actions">${refuelBtnHtml}${skipBtnHtml}</div>`
                : ''
            }
          </div>`;
      })()
    : '';

  const warnHtml =
    failedItems.length > 0
      ? `<div class="one-click-warn-box">${escapeHtml(
          `${failedItems.length} asset(s) skipped (${failedItems
            .slice(0, 3)
            .map((f) => `${f.symbol || f.assetId}: ${f.error || 'unavailable'}`)
            .join(' · ')}). ${
            canProceed
              ? `Remaining ${readyCount} ready asset(s) can still sweep cleanly.`
              : 'Adjust selection or retry.'
          }`
        )}</div>`
      : '';

  const badgeText = batch.fallbackSummary
    ? `${displayChains.length} ${displayChains.length === 1 ? 'chain' : 'chains'} ready`
    : `${readyCount}/${totalCount} ready${durationMs > 0 ? ` · ${durationMs}ms` : ''}`;

  const confirmLabel = hasZeroGas
    ? `Sweep ${fundedChains.length} Funded ${fundedChains.length === 1 ? 'Chain' : 'Chains'} Only`
    : `Confirm & Sign Sweep (${totalSignatures} ${totalSignatures === 1 ? 'sig' : 'sigs'})`;

  card.innerHTML = `
    <div class="one-click-summary-head">
      <span class="one-click-summary-title">${uiIcon(canProceed && !hasZeroGas ? 'check-circle' : 'alert-triangle', 14)}<span>Pre-Sign Sweep Summary</span></span>
      <span class="one-click-summary-badge mono">${escapeHtml(badgeText)}</span>
    </div>
    <div class="one-click-summary-grid">
      <div class="one-click-metric">
        <span class="one-click-metric-label">Arriving on Solana (${escapeHtml(snapOut || outputAsset)})</span>
        <strong class="one-click-metric-val mono is-emerald">${escapeHtml(fmtUsd(totalNetUsd))}</strong>
      </div>
      <div class="one-click-metric">
        <span class="one-click-metric-label">Turgalium Fee</span>
        <strong class="one-click-metric-val mono">0% ($0.00)</strong>
      </div>
      <div class="one-click-metric">
        <span class="one-click-metric-label">Signatures</span>
        <strong class="one-click-metric-val mono">${totalSignatures} ${totalSignatures === 1 ? 'sig' : 'sigs'} · ${displayChains.length} ${displayChains.length === 1 ? 'chain' : 'chains'}</strong>
      </div>
      <div class="one-click-metric">
        <span class="one-click-metric-label">Est. Network Gas</span>
        <strong class="one-click-metric-val mono">~${escapeHtml(fmtUsd(totalGasUsd))}</strong>
      </div>
    </div>
    ${chainChipsHtml ? `<div class="one-click-chains-row">${chainChipsHtml}</div>` : ''}
    ${zeroGasHtml}
    ${warnHtml}
    <div class="one-click-summary-actions">
      ${
        canProceed
          ? `<button type="button" class="btn-pill-dark one-click-confirm-btn" id="confirmOneClickSweepBtn">${escapeHtml(confirmLabel)}</button>`
          : ''
      }
      <button type="button" class="btn-outline-sm one-click-cancel-btn" id="cancelOneClickSweepBtn">Cancel</button>
    </div>
  `;

  document.getElementById('oneClickRefuelGasBtn')?.addEventListener('click', (ev) => {
    if (!refuelSource || !primaryZeroGasChain) return;
    executeOneClickGasRefuel(refuelSource.chain, primaryZeroGasChain, ev.currentTarget);
  });

  const runFilteredFundedSweep = () => {
    const snap = pendingBatchSummary;
    if (!snap) return;
    if (hasZeroGas && fundedChains.length > 0) {
      const fundedSet = new Set(fundedChains);
      const filteredSnap = {
        ...snap,
        activeChains: snap.activeChains.filter((ch) => fundedSet.has(ch)),
      };
      runPreparedSweepQueue(filteredSnap);
      return;
    }
    runPreparedSweepQueue(snap);
  };

  document.getElementById('oneClickSkipZeroGasBtn')?.addEventListener('click', runFilteredFundedSweep);
  document.getElementById('confirmOneClickSweepBtn')?.addEventListener('click', runFilteredFundedSweep);
  document.getElementById('cancelOneClickSweepBtn')?.addEventListener('click', () => {
    clearOneClickSweepSummary();
    updateWalletButtons();
  });
}

async function executeSelectedLiveQueue() {
  if (!currentScan || !currentPlan) return;
  if (isSweepQueueRunning || isPreparingOneClickBatch) {
    showToast(isPreparingOneClickBatch ? 'Preparing your 1-Click Sweep batch…' : 'A sweep queue is already running.');
    return;
  }
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

  const solDest = requireVerifiedSolanaDestination('sweep to Solana');
  if (!solDest) return;

  const snapshotBridgePreference = getActiveBridgePreference();
  const snapshotProtocolFeeBps = getActiveProtocolFeeBps();
  const snapshotFeeRecipientEvm = getActiveFeeRecipientEvm();
  const snapshotOutputAsset = outputAsset;
  const effectiveScan = buildEffectiveScanForPlan();
  const snapshotChainAssetsMap = new Map();
  const allSelectedAssets = [];

  for (const ch of activeChains) {
    const assetsForChain = (effectiveScan?.assets || []).filter(
      (a) =>
        a.chain === ch &&
        selectedAssetIds.has(a.id) &&
        a.action !== 'SKIP_HONEYPOT' &&
        a.action !== 'SKIP_UNPRICED'
    );
    snapshotChainAssetsMap.set(ch, assetsForChain);
    for (const a of assetsForChain) allSelectedAssets.push(a);
  }

  const fp = buildOneClickFingerprint({
    activeChains,
    solDest,
    sourceAddress: connectedSrc,
    bridgePreference: snapshotBridgePreference,
    selectedIds: selectedAssetIds,
  });

  // If pre-sign summary is already prepared & matches, confirm immediately on second CTA click
  if (pendingBatchSummary && pendingBatchSummary.fingerprint === fp) {
    await runPreparedSweepQueue(pendingBatchSummary);
    return;
  }

  isPreparingOneClickBatch = true;
  updateWalletButtons();

  try {
    let batchRes = null;
    try {
      batchRes = await api('/api/tx/prepare-batch', {
        method: 'POST',
        body: JSON.stringify({
          assets: allSelectedAssets.slice(0, 12),
          userAddress: connectedSrc,
          solanaDestination: solDest,
          outputAsset: snapshotOutputAsset,
          bridgePreference: snapshotBridgePreference,
          hasSolanaUsdcAta: solanaBalances ? Boolean(solanaBalances.hasUsdcAta) : undefined,
          includePreflight: true,
        }),
      });
    } catch {
      // Graceful fallback summary derived from live plan if prepare-batch is unavailable
      const fin = getEffectivePlanFinancials();
      batchRes = {
        fallbackSummary: true,
        preparedAt: new Date().toISOString(),
        durationMs: 0,
        count: allSelectedAssets.length,
        readyCount: allSelectedAssets.length,
        failedCount: 0,
        totalNetUsd: fin.effectiveNetUsdc,
        totalGasUsd: safeNum(currentPlan?.totals?.totalGasUsd),
        totalProtocolFeeUsd: 0,
        totalSignatures: activeChains.length,
        items: [],
      };
    }

    pendingBatchSummary = {
      fingerprint: fp,
      batch: batchRes,
      activeChains,
      solDest,
      sourceAddress: connectedSrc,
      outputAsset: snapshotOutputAsset,
      bridgePreference: snapshotBridgePreference,
      protocolFeeBps: snapshotProtocolFeeBps,
      feeRecipientEvm: snapshotFeeRecipientEvm,
      snapshotChainAssetsMap,
      preparedAt: Date.now(),
    };
    renderOneClickSweepSummary();
    document.getElementById('oneClickSweepSummaryCard')?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  } catch (err) {
    showToast(err?.message || 'Failed to prepare 1-Click Sweep batch.');
  } finally {
    isPreparingOneClickBatch = false;
    updateWalletButtons();
  }
}

async function runPreparedSweepQueue(summary) {
  if (!currentScan || !currentPlan || !summary) return;
  if (isSweepQueueRunning) {
    showToast('A sweep queue is already running.');
    return;
  }

  const {
    batch,
    activeChains: rawChains,
    solDest: snapshotSolDest,
    sourceAddress: snapshotSourceAddress,
    outputAsset: snapshotOutputAsset,
    bridgePreference: snapshotBridgePreference,
    protocolFeeBps: snapshotProtocolFeeBps,
    feeRecipientEvm: snapshotFeeRecipientEvm,
    snapshotChainAssetsMap,
  } = summary;

  // Gracefully exclude individual assets that failed inside prepare-batch while keeping ready assets
  const failedAssetIds = new Set(
    (Array.isArray(batch?.items) ? batch.items : [])
      .filter((it) => it && it.ok === false && it.assetId)
      .map((it) => it.assetId)
  );
  const filteredChainAssetsMap = new Map();
  const activeChains = [];
  for (const ch of rawChains) {
    const rawList = snapshotChainAssetsMap.get(ch) || [];
    const usable =
      failedAssetIds.size > 0 ? rawList.filter((a) => !failedAssetIds.has(a.id)) : rawList;
    if (usable.length > 0) {
      filteredChainAssetsMap.set(ch, usable);
      activeChains.push(ch);
    }
  }
  if (!activeChains.length) {
    showToast('No ready assets left to sweep. Adjust selection and try again.');
    return;
  }

  clearOneClickSweepSummary();
  isSweepQueueRunning = true;
  updateWalletButtons();
  let prequoter = null;
  try {
    const legsToRun = currentPlan.legs.filter((l) => activeChains.includes(l.chain));
    const job = await createSweepJob({
      sourceWallet: snapshotSourceAddress,
      solanaDestination: snapshotSolDest,
      outputAsset: snapshotOutputAsset,
      bridgePreference: snapshotBridgePreference,
      protocolFeeBps: snapshotProtocolFeeBps,
      feeRecipientEvm: snapshotFeeRecipientEvm,
      legs: legsToRun.map((l) => ({
        chain: l.chain,
        chainName: l.chainName,
        assetCount: safeInt(l.defiExits) + safeInt(l.swaps) + safeInt(l.burns),
        estimatedNetUsd: l.bridgedUsdc,
        estimatedFeeUsd: l.feeUsdc,
      })),
    });
    activeJobId = job.jobId;
    backgroundJobs.unshift(job);
    saveLocalSweepJobs();
    renderBackgroundAgentUI();

    // Parallel chain pre-quoting (bounded concurrency <= 3) using upfront immutable snapshot + fingerprint
    if (activeChains.length > 1 && executionMode !== 'gasless') {
      const snapshotHasSolanaSigner = Boolean(getConnectedSolanaAddress());
      const snapshotScanFamily =
        currentScan.family && currentScan.family !== 'mixed' ? currentScan.family : activeFamily;
      prequoter = createChainBatchPrequoter(
        activeChains,
        async (chain) => {
          const chainAssets = filteredChainAssetsMap.get(chain) || [];
          if (!chainAssets.length) return null;
          const legFamily = chainAssets[0]?.family || snapshotScanFamily;
          if (legFamily !== 'evm') {
            const legSession = getConnectedFamilyWallet(legFamily);
            const effectiveNonEvmAddr =
              (legFamily === 'cosmos' && legSession?.addressesByChain?.[chain]) ||
              legSession?.address ||
              chainAssets[0]?.sourceWallet ||
              snapshotSourceAddress;
            const res = await api('/api/tx/prepare-chain-batch', {
              method: 'POST',
              body: JSON.stringify({
                chain,
                assets: chainAssets,
                userAddress: effectiveNonEvmAddr,
                solanaDestination: snapshotSolDest,
                outputAsset: snapshotOutputAsset,
                bridgePreference: snapshotBridgePreference,
                protocolFeeBps: snapshotProtocolFeeBps,
                addressesByChain: legSession?.addressesByChain || undefined,
              }),
            });
            if (res && typeof res === 'object') {
              res.__prequoteFingerprint = buildPrequoteFingerprint({
                chain,
                chainAssets,
                outputAsset: snapshotOutputAsset,
                solanaDestination: snapshotSolDest,
                bridgePreference: snapshotBridgePreference,
                protocolFeeBps: snapshotProtocolFeeBps,
                feeRecipientEvm: '',
                sourceAddress: effectiveNonEvmAddr,
              });
            }
            return res;
          }
          const res = await api('/api/tx/prepare-chain-batch', {
            method: 'POST',
            body: JSON.stringify({
              chain,
              assets: chainAssets,
              userAddress: snapshotSourceAddress,
              solanaDestination: snapshotSolDest,
              outputAsset: snapshotOutputAsset,
              bridgePreference: snapshotBridgePreference,
              protocolFeeBps: snapshotProtocolFeeBps,
              feeRecipientEvm: snapshotFeeRecipientEvm,
              bundleDefiCctp: snapshotHasSolanaSigner || snapshotBridgePreference === 'cctp',
              consolidateMultiInputDust: true,
            }),
          });
          if (res && typeof res === 'object') {
            res.__prequoteFingerprint = buildPrequoteFingerprint({
              chain,
              chainAssets,
              outputAsset: snapshotOutputAsset,
              solanaDestination: snapshotSolDest,
              bridgePreference: snapshotBridgePreference,
              protocolFeeBps: snapshotProtocolFeeBps,
              feeRecipientEvm: snapshotFeeRecipientEvm,
              sourceAddress: snapshotSourceAddress,
            });
          }
          return res;
        },
        { maxConcurrency: 3, maxQuoteAgeMs: 45_000 }
      );
    }

    let queueCompletedChains = 0;
    let queueAborted = false;
    for (const chain of activeChains) {
      const stepRes = await executeChainBatchLive(chain, job.jobId, {
        prequoter,
        snapshotSourceAddress,
      });
      if (stepRes?.userRejected) {
        queueAborted = true;
        prequoter?.cancel();
        showToast('Wallet signature rejected — aborted remaining chains in sweep queue.');
        break;
      }
      if (!stepRes?.failed) {
        queueCompletedChains += 1;
      }
    }
    if (!queueAborted && queueCompletedChains > 0) {
      pollInflightBridgesFinality({ manual: false });
    }
    if (!queueAborted && queueCompletedChains > 0 && !shownReceiptJobIds.has(job.jobId)) {
      const latestJob = backgroundJobs.find((j) => j.jobId === job.jobId) || job;
      const allLegsDone =
        Array.isArray(latestJob?.legs) &&
        latestJob.legs.length > 0 &&
        latestJob.legs.every((l) => l.status === 'landed' || l.status === 'attested');
      if (allLegsDone) {
        shownReceiptJobIds.add(job.jobId);
        openReceiptModal(latestJob);
      }
    }
  } catch (err) {
    showToast(err?.message || 'Failed to start sweep queue.');
  } finally {
    prequoter?.cancel();
    isSweepQueueRunning = false;
    updateWalletButtons();
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
      filename: 'contracts/TurgaliumRouter.sol',
      source: contractData.source || '',
    };
  const src = chosen.source || '';
  document.getElementById('contractCodeHost').textContent = src;
  const fileEl = document.getElementById('contractFileLabel');
  if (fileEl) fileEl.textContent = chosen.filename;
  const lines = src.split('\n').length;
  const feePct = ((contractData.protocolFeeBps ?? 0) / 100).toFixed(1);
  document.getElementById('contractStats').textContent =
    `Solidity ${contractData.solidityVersion} · ${lines} lines · ${feePct}% Fee (MIT) · Domain ${contractData.solanaCctpDomain} → Solana`;
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
let walletModalErrorAction = null;
let walletModalConnecting = null;
let walletWcPromptOpen = false;

function closeWalletModal() {
  walletModalError = null;
  walletModalErrorAction = null;
  walletModalConnecting = null;
  walletWcPromptOpen = false;
  document.getElementById('walletModalBackdrop')?.classList.add('hidden');
}

function buildSolanaAccountChangedHandler() {
  return (nextAddr, meta) => {
    const solInput = document.getElementById('solanaDestInput');
    const currentVal = solInput?.value?.trim() || '';
    const prevAddr = meta?.previousAddress || null;
    const followsConnectedWallet = !currentVal || (prevAddr && currentVal === prevAddr);

    if (followsConnectedWallet) {
      if (nextAddr) {
        if (solInput) solInput.value = nextAddr;
        manualDestConfirmedAddress = null;
        const chk = document.getElementById('manualDestConfirmChk');
        if (chk) chk.checked = false;
        syncDestinationUiState();
      } else {
        clearSolanaDestinationUi();
      }
      updateWalletButtons();
      recomputePlan();
      refreshSolanaBalance();
    } else {
      // Never clobber a manually edited #solanaDestInput on wallet accountChanged/disconnect
      syncDestinationUiState();
      updateWalletButtons();
      dispatchTurgaliumBalanceUpdated();
      showToast(
        nextAddr
          ? `${meta?.walletName || 'Solana wallet'} switched to ${shortAddr(nextAddr)} — kept your manual destination (${shortAddr(currentVal)}).`
          : `${meta?.walletName || 'Solana wallet'} disconnected — kept your manual destination (${shortAddr(currentVal)}).`
      );
    }
  };
}

async function handleEvmConnected({ address, walletName, capabilities, solana }) {
  if (solana?.address) {
    const solInput = document.getElementById('solanaDestInput');
    if (solInput && !solInput.value.trim()) {
      solInput.value = solana.address;
      manualDestConfirmedAddress = null;
      const confirmChk = document.getElementById('manualDestConfirmChk');
      if (confirmChk) confirmChk.checked = false;
      syncDestinationUiState();
    }
  }
  closeWalletModal();
  updateWalletButtons();
  const batchNote = capabilities?.anySupported
    ? '1-Click EIP-5792 Batch armed'
    : 'Sequential signing ready';
  if (solana?.address) {
    showToast(
      `Connected ${walletName} (EVM + Solana): ${shortAddr(address)} → ${shortAddr(solana.address)}`
    );
    await runScan({ address, autoOpen: true });
    return;
  }
  showToast(
    isProMode()
      ? `Connected ${walletName} (${shortAddr(address)}) · ${batchNote}`
      : `Connected ${walletName} (${shortAddr(address)})`
  );
  await runScan({ address, autoOpen: true });
}

function resetEvmScanState() {
  currentScan = null;
  currentPlan = null;
  selectedAssetIds.clear();
  batchRescuedDustIds.clear();
  lastDustPlan = null;
  latestPreSignProof = null;
  defiStepperState = null;
  clearOneClickSweepSummary();
  renderDefiGuidedStepper();
  renderEmptyScanState();
}

function getWalletBrandBadge(name, iconUrl, rdns = '') {
  const localLogo = getWalletLogoPath(name, rdns);
  const src = safeWalletIconUrl(iconUrl, localLogo);
  const isDark = needsDarkLogoBacking(name) || needsDarkLogoBacking(localLogo);
  return `<span class="wallet-logo-tile${isDark ? ' is-dark' : ''}"><img src="${escapeHtml(src)}" data-fallback-logo="${escapeHtml(localLogo)}" alt="" class="wallet-logo-img" /></span>`;
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
    ? 'Sign exits, swaps, burns, and bridges across 19 EVM chains.'
    : isEvm
    ? meta?.signingMechanism || `Connect your ${famShort} wallet to sign 1-sig gasless sweeps.`
    : 'Receive native USDC or SOL on Solana.';

  const rows = [];
  if (walletModalError) {
    const safeErrActionUrl = walletModalErrorAction?.url ? safeHttpUrl(walletModalErrorAction.url) : null;
    const actionLink = safeErrActionUrl
      ? ` <a class="explorer-link" href="${escapeHtml(safeErrActionUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(walletModalErrorAction.label || 'Install wallet ↗')}</a>`
      : '';
    rows.push(`<div class="wallet-modal-error">${escapeHtml(walletModalError)}${actionLink}</div>`);
  }

  if (isEvm && !isSourceEvm) {
    const detectedFam = listAvailableFamilyWallets(activeFamily);
    if (detectedFam.length) {
      rows.push(`<div class="wallet-section-label">Installed ${escapeHtml(famShort)} wallets</div>`);
      for (const w of detectedFam) {
        const isBusy = walletModalConnecting === `fam:${w.id}`;
        rows.push(`
          <button type="button" class="wallet-option-row" data-pick-family-wallet="${escapeHtml(w.id)}" data-wallet-installed="true" data-wallet-name="${escapeHtml(w.name)}" ${walletModalConnecting ? 'disabled' : ''}>
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
    if (activeFamily === 'cosmos') {
      // Show uninstalled Cosmos wallet rows clearly without silently falling back to wallets[0]
      const detectedIds = new Set(detectedFam.map((w) => w.id));
      const cosmosChoices = [
        {
          id: 'keplr',
          name: 'Keplr',
          logo: '/logos/keplr.svg',
          installUrl: 'https://www.keplr.app',
          sub: 'Cosmos Hub · Osmosis · Noble · Celestia · Injective · Neutron',
        },
        {
          id: 'leap',
          name: 'Leap Wallet',
          logo: '/logos/leap.svg',
          installUrl: 'https://www.leapwallet.io',
          sub: 'All 6 Cosmos / IBC chains',
        },
        {
          id: 'cosmostation',
          name: 'Cosmostation',
          logo: resolveLogo('/logos/cosmostation.svg', '/logos/cosmos.svg'),
          installUrl: 'https://www.cosmostation.io/wallet',
          sub: 'Cosmostation browser extension',
        },
        {
          id: 'okx-cosmos',
          name: 'OKX Wallet (Cosmos)',
          logo: '/logos/okx.svg',
          installUrl: 'https://www.okx.com/web3',
          sub: 'OKX multi-chain Cosmos provider',
        },
      ].filter((cw) => !detectedIds.has(cw.id));
      if (cosmosChoices.length) {
        rows.push(
          `<div class="wallet-section-label">${detectedFam.length ? 'Other Cosmos wallets (not detected)' : 'Install or unlock a Cosmos wallet'}</div>`
        );
        for (const cw of cosmosChoices) {
          const isBusy = walletModalConnecting === `fam:${cw.id}`;
          const safeCwInstall = safeHttpUrl(cw.installUrl) || '';
          rows.push(`
            <button type="button" class="wallet-option-row" data-pick-family-wallet="${escapeHtml(cw.id)}" data-wallet-installed="false" data-wallet-name="${escapeHtml(cw.name)}" data-install-url="${escapeHtml(safeCwInstall)}" ${walletModalConnecting ? 'disabled' : ''}>
              <div class="wallet-option-left">
                ${getWalletBrandBadge(cw.name, cw.logo)}
                <div>
                  <div class="wallet-option-name">${escapeHtml(cw.name)}</div>
                  <div class="wallet-option-meta mono">Not detected · ${escapeHtml(cw.sub)}</div>
                </div>
              </div>
              <span class="mono wallet-option-action">${isBusy ? 'Checking…' : 'Install / Retry ↗'}</span>
            </button>
          `);
        }
      }
    }
    if (meta?.wallets?.length) {
      rows.push(`<div class="wallet-section-label">Supported ${escapeHtml(famShort)} wallets</div>`);
      rows.push(
        `<div class="wallet-install-strip">${meta.wallets
          .map((w) => {
            const safeWUrl = safeHttpUrl(w.installUrl);
            if (!safeWUrl) return '';
            const safeWLogo = safeWalletIconUrl(w.logo, getWalletLogoPath(w.name));
            return `<a class="wallet-install-chip" href="${escHtml(safeWUrl)}" target="_blank" rel="noopener noreferrer"><img src="${escHtml(safeWLogo)}" alt="" class="chain-logo-xs" />${escHtml(w.name)} ↗</a>`;
          })
          .join('')}</div>`
      );
    }
    rows.push(`
      <div class="wallet-section-label">Or inspect any ${escapeHtml(famShort)} address</div>
      <form class="wallet-manual-form" id="modalFamilyManualForm">
        <input type="text" id="modalFamilyAddrInput" class="field-input mono" value="" placeholder="${escapeHtml(meta?.addressHint || '')}" aria-label="${escapeHtml(famShort)} source address" />
        <button type="submit" class="btn-outline-dark">Scan</button>
      </form>
    `);
  } else if (isEvm) {
    const detected = listAvailableEvmWallets();
    const currentSolDestVal = document.getElementById('solanaDestInput')?.value.trim() || '';
    const canAutoDualVm = !solAddr && !currentSolDestVal;
    if (detected.length) {
      rows.push(`<div class="wallet-section-label">Installed in browser</div>`);
      for (const w of detected) {
        const isBusy = walletModalConnecting === `evm:${w.id}`;
        const matchedSol = findMatchingSolanaWalletForEvm(w);
        const isDualVmReady = Boolean(matchedSol && canAutoDualVm);
        const metaText = isDualVmReady
          ? isProMode()
            ? `1-Click EVM + Solana · ${w.standard}`
            : '1-Click EVM + Solana'
          : matchedSol
          ? isProMode()
            ? `EVM + Solana · ${w.standard}`
            : 'Installed · EVM + Solana'
          : isProMode()
          ? `Detected · ${w.standard}`
          : 'Installed';
        rows.push(`
          <button type="button" class="wallet-option-row" data-pick-evm="${escapeHtml(w.id)}" data-dual-vm="${matchedSol ? 'true' : 'false'}" ${walletModalConnecting ? 'disabled' : ''}>
            <div class="wallet-option-left">
              ${getWalletBrandBadge(w.name, w.icon, w.rdns)}
              <div>
                <div class="wallet-option-name">${escapeHtml(w.name)}</div>
                <div class="wallet-option-meta mono">${escapeHtml(metaText)}</div>
              </div>
            </div>
            <span class="mono wallet-option-action">${isBusy ? 'Connecting…' : activeName === w.name && activeAddr ? 'Connected' : isDualVmReady ? 'Connect Both →' : 'Connect →'}</span>
          </button>
        `);
      }
    }

    rows.push(`<div class="wallet-section-label">Universal &amp; Mobile</div>`);
    if (!detected.length && isMobileBrowser()) {
      const mobileLinks = getMobileEvmDeepLinks();
      for (const link of mobileLinks) {
        const safeUrl = safeHttpUrl(link?.deepLinkUrl);
        if (!safeUrl) continue;
        rows.push(`
          <a class="wallet-option-row" href="${escapeHtml(safeUrl)}" rel="noopener noreferrer" data-mobile-deeplink="${escapeHtml(link.walletKey)}">
            <div class="wallet-option-left">
              ${getWalletBrandBadge(link.name, link.logo)}
              <div>
                <div class="wallet-option-name">${escapeHtml(link.name)}</div>
                <div class="wallet-option-meta mono">${escapeHtml(link.subtitle)}</div>
              </div>
            </div>
            <span class="mono wallet-option-action">Open ↗</span>
          </a>
        `);
      }
    }
    if (cfg.coinbaseSmartWalletEnabled) {
      const isBusy = walletModalConnecting === 'coinbase';
      rows.push(`
        <button type="button" class="wallet-option-row" data-pick-coinbase="true" ${walletModalConnecting ? 'disabled' : ''}>
          <div class="wallet-option-left">
            ${getWalletBrandBadge('Coinbase Smart Wallet', null)}
            <div>
              <div class="wallet-option-name">Coinbase Smart Wallet</div>
              <div class="wallet-option-meta mono">${isProMode() ? 'Passkey / Popup · Native EIP-5792' : 'Passkey / Popup · Smart Wallet'}</div>
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
            Get a free Project ID at <a href="https://cloud.reown.com" target="_blank" rel="noopener noreferrer" class="explorer-link">cloud.reown.com ↗</a> (saved locally in your browser).
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
          <a class="wallet-install-chip" href="https://rabby.io" target="_blank" rel="noopener noreferrer"><img src="/logos/rabby.svg" alt="" class="chain-logo-xs" />Rabby ↗</a>
          <a class="wallet-install-chip" href="https://metamask.io" target="_blank" rel="noopener noreferrer"><img src="/logos/metamask.svg" alt="" class="chain-logo-xs" />MetaMask ↗</a>
          <a class="wallet-install-chip" href="https://phantom.app" target="_blank" rel="noopener noreferrer"><img src="/logos/phantom.svg" alt="" class="chain-logo-xs" />Phantom ↗</a>
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
    } else if (isMobileBrowser()) {
      const mobileLinks = getMobileSolanaDeepLinks();
      rows.push(`<div class="wallet-section-label">Open in Mobile Wallet</div>`);
      for (const dl of mobileLinks) {
        const safeDlUrl = safeHttpUrl(dl.deepLinkUrl);
        if (!safeDlUrl) continue;
        rows.push(`
          <a class="wallet-option-row" href="${escapeHtml(safeDlUrl)}" rel="noopener noreferrer" data-mobile-deeplink="${escapeHtml(dl.walletKey)}">
            <div class="wallet-option-left">
              ${getWalletBrandBadge(dl.name, dl.logo)}
              <div>
                <div class="wallet-option-name">${escapeHtml(dl.name)}</div>
                <div class="wallet-option-meta mono">${escapeHtml(dl.subtitle)}</div>
              </div>
            </div>
            <span class="mono wallet-option-action">Open ↗</span>
          </a>
        `);
      }
    } else {
      rows.push(`
        <div class="wallet-section-label">Browser extensions</div>
        <div class="wallet-install-strip">
          <a class="wallet-install-chip" href="https://phantom.app" target="_blank" rel="noopener noreferrer"><img src="/logos/phantom.svg" alt="" class="chain-logo-xs" />Phantom ↗</a>
          <a class="wallet-install-chip" href="https://backpack.app" target="_blank" rel="noopener noreferrer"><img src="/logos/backpack.svg" alt="" class="chain-logo-xs" />Backpack ↗</a>
          <a class="wallet-install-chip" href="https://solflare.com" target="_blank" rel="noopener noreferrer"><img src="/logos/solflare.svg" alt="" class="chain-logo-xs" />Solflare ↗</a>
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
  listEl.querySelectorAll('img[data-fallback-logo]').forEach((img) => {
    img.addEventListener(
      'error',
      () => {
        const fb = img.dataset.fallbackLogo;
        if (fb && img.getAttribute('src') !== fb) img.setAttribute('src', fb);
      },
      { once: true }
    );
  });
  if (isSourceEvm) {
    footEl.textContent = isProMode()
      ? 'Supports EIP-6963 extensions, Coinbase Smart Wallet, WalletConnect v2, and EIP-5792 batch signing.'
      : 'Connect a browser extension, Coinbase Smart Wallet, or mobile wallet via WalletConnect.';
  } else if (isEvm) {
    const familyFooters = {
      cosmos: 'Supports Keplr, Leap, Cosmostation, and OKX Cosmos extensions across 6 IBC chains.',
      sui: 'Supports Sui Wallet Standard (Slush, Phantom Sui) or read-only Sui address inspection.',
      aptos: 'Supports Petra and Phantom Aptos extensions or read-only Aptos address inspection.',
      ton: 'Supports TonConnect 2 wallets (Tonkeeper) or read-only TON address inspection.',
      tron: 'Supports TronLink extension or read-only Tron address inspection.',
      btc: 'Supports UniSat, Xverse (payment address), and Phantom Bitcoin wallets.',
    };
    footEl.textContent =
      familyFooters[activeFamily] ||
      meta?.signingMechanism ||
      `Supports native ${famShort} browser extensions or address inspection.`;
  } else {
    footEl.textContent = 'Supports Solana Wallet Standard or direct destination address paste.';
  }

  const evmCallbacks = {
    onAccountsChanged: (next) => {
      updateWalletButtons();
      if (next) {
        runScan({ address: next, autoOpen: true });
      } else if (activeFamily === 'evm') {
        resetEvmScanState();
      }
    },
    onChainChanged: () => updateWalletButtons(),
  };

  listEl.querySelectorAll('[data-pick-evm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const walletId = btn.dataset.pickEvm;
      const isDualVm = btn.dataset.dualVm === 'true';
      const solDestEmpty = !(document.getElementById('solanaDestInput')?.value.trim() || '');
      const shouldAutoDualVm = isDualVm && solDestEmpty && !getConnectedSolanaAddress();
      walletModalError = null;
      walletModalConnecting = `evm:${walletId}`;
      renderWalletModalContent();
      try {
        const res = shouldAutoDualVm
          ? await connectDualVmWallet({
              walletId,
              autoConnectSolana: true,
              skipSolanaIfConnected: true,
              ...evmCallbacks,
              onSolanaAccountChanged: buildSolanaAccountChangedHandler(),
            })
          : await connectEvmWallet({ walletId, ...evmCallbacks });
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
      walletModalErrorAction = null;
      walletModalConnecting = `sol:${walletId}`;
      renderWalletModalContent();
      try {
        const { address, walletName } = await connectSolanaWallet({
          walletId,
          onAccountChanged: buildSolanaAccountChangedHandler(),
        });
        document.getElementById('solanaDestInput').value = address;
        manualDestConfirmedAddress = null;
        const confirmChk = document.getElementById('manualDestConfirmChk');
        if (confirmChk) confirmChk.checked = false;
        syncDestinationUiState();
        closeWalletModal();
        updateWalletButtons();
        showToast(`Connected ${walletName}: ${shortAddr(address)}`);
        await Promise.all([recomputePlan(), refreshSolanaBalance()]);
      } catch (err) {
        walletModalConnecting = null;
        walletModalError = err?.message || 'Solana wallet connection cancelled.';
        walletModalErrorAction = null;
        renderWalletModalContent();
        showToast(walletModalError);
      }
    });
  });

  document.getElementById('modalSolanaManualForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const addr = document.getElementById('modalSolanaInput')?.value.trim();
    if (!addr) return;
    if (!isValidSolanaBase58(addr)) {
      walletModalError = 'Invalid Solana base58 destination address.';
      walletModalErrorAction = null;
      renderWalletModalContent();
      return;
    }
    document.getElementById('solanaDestInput').value = addr;
    manualDestConfirmedAddress = addr;
    const chk = document.getElementById('manualDestConfirmChk');
    if (chk) chk.checked = true;
    syncDestinationUiState();
    closeWalletModal();
    showToast(`Destination confirmed: ${shortAddr(addr)}`);
    await Promise.all([recomputePlan(), refreshSolanaBalance()]);
  });

  document.getElementById('walletModalDisconnectBtn')?.addEventListener('click', () => {
    if (isEvm) {
      disconnectFamilyWallet(activeFamily);
      resetEvmScanState();
    } else {
      const prevSol = getConnectedSolanaAddress();
      const curVal = document.getElementById('solanaDestInput')?.value?.trim() || '';
      const followsConnectedWallet = !curVal || (prevSol && curVal === prevSol);
      disconnectSolanaWallet();
      if (followsConnectedWallet) {
        clearSolanaDestinationUi();
        recomputePlan();
      } else {
        syncDestinationUiState();
      }
      dispatchTurgaliumBalanceUpdated();
    }
    updateWalletButtons();
    renderWalletModalContent();
    showToast(isEvm ? `Disconnected ${famShort} wallet.` : 'Disconnected Solana wallet and cleared destination.');
  });

  listEl.querySelectorAll('[data-pick-family-wallet]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const walletId = btn.dataset.pickFamilyWallet;
      const isInstalledAttr = btn.dataset.walletInstalled;
      const displayName = btn.dataset.walletName || walletId;
      const installUrl = btn.dataset.installUrl || null;
      const targetFamily = activeFamily;

      walletModalError = null;
      walletModalErrorAction = null;

      if (isInstalledAttr === 'false') {
        refreshInstalledWallets();
        const nowDetected = listAvailableFamilyWallets(targetFamily).some((w) => w.id === walletId);
        if (!nowDetected) {
          walletModalError = `${displayName} is not detected on this page. Install ${displayName} or unlock it and allow site access on 127.0.0.1, then retry.`;
          walletModalErrorAction = installUrl ? { label: `Install ${displayName} ↗`, url: installUrl } : null;
          renderWalletModalContent();
          showToast(walletModalError);
          return;
        }
      }

      walletModalConnecting = `fam:${walletId}`;
      renderWalletModalContent();
      try {
        const res = await connectFamilyWallet(targetFamily, {
          walletId,
          onAccountChanged: (next, meta) => {
            updateWalletButtons();
            const modalEl = document.getElementById('walletModalBackdrop');
            if (modalEl && !modalEl.classList.contains('hidden')) {
              renderWalletModalContent();
            }
            if (!next || !next.address) {
              const reasonMsg =
                meta?.message ||
                `${meta?.walletName || targetFamily.toUpperCase()} wallet disconnected.`;
              showToast(reasonMsg);
              if (activeFamily === targetFamily) {
                currentScan = null;
                currentPlan = null;
                selectedAssetIds.clear();
                batchRescuedDustIds.clear();
                lastDustPlan = null;
                renderEmptyScanState();
              }
              return;
            }
            const nextMultiAddrs =
              targetFamily === 'cosmos' && next.addressesByChain
                ? Array.from(new Set(Object.values(next.addressesByChain).filter(Boolean)))
                : [];
            const nextChainNote =
              nextMultiAddrs.length > 1 ? ` · ${nextMultiAddrs.length} Cosmos chains` : '';
            showToast(
              `Switched ${next.walletName || targetFamily.toUpperCase()} account (${shortAddr(next.address)})${nextChainNote}`
            );
            if (activeFamily === targetFamily) {
              const nextScanAddr = getScanAddressForSession(targetFamily, next.session || next);
              if (nextScanAddr) {
                runScan({ address: nextScanAddr, family: targetFamily, autoOpen: false });
              }
            }
          },
          onNetworkChanged: () => {
            updateWalletButtons();
          },
        });
        closeWalletModal();
        updateWalletButtons();
        const multiAddrs =
          targetFamily === 'cosmos' && res.addressesByChain
            ? Array.from(new Set(Object.values(res.addressesByChain).filter(Boolean)))
            : [];
        const totalCosmos = 6;
        const chainCountNote =
          targetFamily === 'cosmos' && res.failedChains?.length
            ? ` · ${multiAddrs.length}/${totalCosmos} Cosmos chains`
            : multiAddrs.length > 1
            ? ` · ${multiAddrs.length} Cosmos chains`
            : '';
        showToast(`Connected ${res.walletName} (${shortAddr(res.address)})${chainCountNote}`);
        await runScan({
          address: getScanAddressForSession(targetFamily, res),
          family: targetFamily,
          autoOpen: true,
        });
      } catch (err) {
        walletModalConnecting = null;
        walletModalError = err?.message || 'Wallet connection cancelled.';
        walletModalErrorAction = err?.installUrl
          ? { label: `Install ${err.walletName || displayName} ↗`, url: err.installUrl }
          : null;
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
  walletModalErrorAction = null;
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

  document.querySelectorAll('.ui-mode-btn[data-ui-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setUiMode(btn.dataset.uiMode));
  });

  document.getElementById('bgAgentDock')?.addEventListener('click', () => openApp('scanner'));

  document.getElementById('walletModalCloseBtn')?.addEventListener('click', closeWalletModal);
  document.getElementById('walletModalBackdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeWalletModal();
  });
  document.getElementById('receiptModalCloseBtn')?.addEventListener('click', closeReceiptModal);
  document.getElementById('receiptModalBackdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeReceiptModal();
  });
  document.getElementById('openReceiptModalBtn')?.addEventListener('click', () => {
    openReceiptModal();
  });
  document.getElementById('agentShareReceiptBtn')?.addEventListener('click', () => {
    const activeJob =
      backgroundJobs.find((j) => j.jobId === activeJobId) || backgroundJobs[0] || null;
    openReceiptModal(activeJob);
  });
  document.getElementById('receiptIncludeAddrToggle')?.addEventListener('change', () => {
    renderActiveReceiptCard();
  });
  document.getElementById('receiptDownloadPngBtn')?.addEventListener('click', downloadReceiptPng);
  document.getElementById('receiptCopySummaryBtn')?.addEventListener('click', copyReceiptSummary);
  document.getElementById('receiptShareXBtn')?.addEventListener('click', shareReceiptOnX);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeWalletModal();
      closeReceiptModal();
    }
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
      selectFamily(btn.dataset.family);
    });
  });

  document.getElementById('heroScanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('heroWalletInput');
    const addr = input?.value.trim();
    if (addr) {
      const detected = detectAddressFamily(addr);
      if (detected && detected !== activeFamily) {
        activeFamily = detected;
        updateFamilyChrome();
      }
      runScan({ address: addr, family: detected || activeFamily, autoOpen: true });
    } else {
      showToast('Enter a wallet address to scan.');
      input?.focus();
    }
  });

  document.getElementById('appEvmInput')?.addEventListener('input', (e) => {
    const val = String(e.target?.value || '').trim();
    const detected = detectAddressFamily(val);
    if (detected && detected !== activeFamily) {
      activeFamily = detected;
      document.querySelectorAll('.family-pill[data-family]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.family === activeFamily);
      });
      updateWalletButtons();
    }
  });

  document.getElementById('appScanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('appEvmInput');
    const addr = input?.value.trim();
    if (addr) {
      const detected = detectAddressFamily(addr);
      if (detected && detected !== activeFamily) {
        activeFamily = detected;
        updateFamilyChrome();
      }
      runScan({ address: addr, family: detected || activeFamily, autoOpen: false });
    } else {
      showToast('Enter a wallet address to scan.');
      input?.focus();
    }
  });

  const solInputEl = document.getElementById('solanaDestInput');
  const onSolDestEdited = () => {
    const val = solInputEl?.value?.trim() || '';
    const connectedSol = getConnectedSolanaAddress();
    if (!connectedSol || val !== connectedSol) {
      manualDestConfirmedAddress = null;
      const chk = document.getElementById('manualDestConfirmChk');
      if (chk) chk.checked = false;
    }
    syncDestinationUiState();
  };
  solInputEl?.addEventListener('input', onSolDestEdited);
  solInputEl?.addEventListener('change', () => {
    onSolDestEdited();
    recomputePlan();
    refreshSolanaBalance();
  });
  document.getElementById('manualDestConfirmChk')?.addEventListener('change', (e) => {
    const val = solInputEl?.value?.trim() || '';
    if (e.target.checked) {
      if (!isValidSolanaBase58(val)) {
        e.target.checked = false;
        manualDestConfirmedAddress = null;
        showToast('Enter a valid Base58 Solana address before confirming.');
      } else {
        manualDestConfirmedAddress = val;
      }
    } else {
      manualDestConfirmedAddress = null;
    }
    syncDestinationUiState();
  });
  document.getElementById('permit2Toggle').addEventListener('change', recomputePlan);
  document.getElementById('burnToggle').addEventListener('change', (e) => {
    if (currentScan?.assets) {
      for (const a of currentScan.assets) {
        if (a.action === 'BURN_ZERO_LIQUIDITY') {
          if (e.target.checked) selectedAssetIds.add(a.id);
          else selectedAssetIds.delete(a.id);
        }
      }
    }
    recomputePlan();
  });
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
      renderDustStrategyBanner();
      renderAssetList();
    });
  });

  document.getElementById('selectDustBtn')?.addEventListener('click', selectConvertibleDust);

  document.getElementById('toggleUnifyBarBtn')?.addEventListener('click', () => {
    const bar = document.getElementById('unifiedWalletsBar');
    if (!bar) return;
    if (!unifiedWallets.length && currentScan?.walletAddress && !currentScan.walletAddress.includes(',')) {
      unifiedWallets.push({
        address: currentScan.walletAddress,
        label: currentScan.walletLabel || shortAddr(currentScan.walletAddress),
        family: currentScan.family || activeFamily,
      });
    }
    bar.classList.toggle('hidden');
    renderUnifiedWalletsBar();
  });

  document.getElementById('unifiedAddForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const addrIn = document.getElementById('unifiedWalletInput');
    const lblIn = document.getElementById('unifiedWalletLabelInput');
    const addr = addrIn?.value.trim();
    if (!addr) return;
    if (!unifiedWallets.length && currentScan?.walletAddress && !currentScan.walletAddress.includes(',')) {
      unifiedWallets.push({
        address: currentScan.walletAddress,
        label: currentScan.walletLabel || shortAddr(currentScan.walletAddress),
        family: currentScan.family || activeFamily,
      });
    }
    if (!unifiedWallets.some((w) => w.address.toLowerCase() === addr.toLowerCase())) {
      unifiedWallets.push({
        address: addr,
        label: lblIn?.value.trim() || shortAddr(addr),
      });
    }
    if (addrIn) addrIn.value = '';
    if (lblIn) lblIn.value = '';
    await runUnifiedScan();
  });

  document.getElementById('adminSessionUnlockForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('adminSessionTokenInput');
    const btn = document.getElementById('adminSessionUnlockBtn');
    const candidate = input?.value?.trim() || '';
    if (!candidate) {
      showToast('Enter your X-Turgalium-Admin-Session token to unlock.');
      input?.focus();
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Verifying…';
    }
    try {
      const res = await fetch('/api/plugin/setup', {
        headers: {
          'Content-Type': 'application/json',
          'X-Turgalium-Admin-Session': candidate,
        },
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody?.error || 'Invalid admin session token.');
      }
      adminSessionToken = candidate;
      try {
        window.sessionStorage?.setItem(ADMIN_SESSION_STORAGE_KEY, candidate);
      } catch {
        // ignore storage errors
      }
      if (input) input.value = '';
      showToast('Admin session unlocked.');
      window.dispatchEvent(new CustomEvent('turgalium:admin-unlocked'));
      await Promise.all([syncBackgroundJobs(), loadAgentsAndPlugins()]);
    } catch (err) {
      showToast(err?.message || 'Invalid admin session token.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Unlock';
      }
    }
  });

  document.getElementById('createMandateForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isAdminLocked()) {
      showToast('Admin session required — unlock above or run Turgalium locally to grant spending mandates.');
      document.getElementById('adminSessionTokenInput')?.focus();
      return;
    }
    const solDest = requireVerifiedSolanaDestination('create an agent mandate');
    if (!solDest) return;
    const owner = getActiveSourceWallet()?.address || currentScan?.walletAddress?.split(',')[0] || '0x0000000000000000000000000000000000000001';
    const actions = Array.from(document.querySelectorAll('input[name="mandateAction"]:checked')).map((el) => el.value);
    if (!actions.length) {
      showToast('Select at least one allowed action for the agent mandate.');
      return;
    }
    try {
      const created = await api('/api/agents/mandates', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('mandateNameInput')?.value.trim(),
          ownerAddress: owner,
          lockedSolanaRecipient: solDest,
          maxPerTxUsd: Number(document.getElementById('mandateMaxTxInput')?.value || 250),
          dailyCapUsd: Number(document.getElementById('mandateDailyCapInput')?.value || 1000),
          autoApproveUnderUsd: Number(document.getElementById('mandateAutoTierInput')?.value || 50),
          allowedActions: actions,
        }),
      });
      showToast(`Granted TurgaliumAgentVault mandate (${created.mandateId})`);
      await loadAgentsAndPlugins();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('mandateConnectSolBtn')?.addEventListener('click', () => openWalletModal('solana'));

  document.getElementById('copyIssuedTokenBtn')?.addEventListener('click', async () => {
    if (!latestIssuedToken?.token) return;
    await navigator.clipboard?.writeText(latestIssuedToken.token).catch(() => {});
    showToast('Copied API token.');
  });

  document.getElementById('copyClaudeMcpBtn')?.addEventListener('click', async () => {
    const cfg = buildRenderedClaudeDesktopConfig();
    if (!cfg) {
      showToast('Claude Desktop MCP config is not available yet.');
      return;
    }
    await navigator.clipboard?.writeText(JSON.stringify(cfg, null, 2)).catch(() => {});
    showToast(
      isAdminLocked()
        ? 'Copied self-host Claude Desktop MCP template JSON.'
        : lastIssuedTokens.claude_mcp
        ? 'Copied Claude Desktop MCP config (with your token).'
        : 'Copied Claude Desktop MCP config JSON.'
    );
  });

  document.getElementById('copyClaudeCliBtn')?.addEventListener('click', async () => {
    const cmd = buildRenderedClaudeCliCommand();
    if (!cmd) {
      showToast('Claude Code CLI command is not available yet.');
      return;
    }
    await navigator.clipboard?.writeText(cmd).catch(() => {});
    showToast(
      isAdminLocked()
        ? 'Copied self-host Claude Code CLI template command.'
        : lastIssuedTokens.claude_mcp
        ? 'Copied Claude Code CLI command (with your token).'
        : 'Copied Claude Code CLI command.'
    );
  });

  document.getElementById('copyChatgptUrlBtn')?.addEventListener('click', async () => {
    const openApiUrl =
      pluginSetupData?.chatgptOpenApiUrl ||
      `${window.location?.origin || 'http://127.0.0.1:4321'}/openapi.json`;
    await navigator.clipboard?.writeText(openApiUrl).catch(() => {});
    showToast('Copied ChatGPT OpenAPI 3.1 URL.');
  });

  document.getElementById('issueGptTokenBtn')?.addEventListener('click', async () => {
    if (isAdminLocked()) {
      showToast('Admin session required — unlock above or run Turgalium locally to mint ChatGPT tokens.');
      document.getElementById('adminSessionTokenInput')?.focus();
      return;
    }
    try {
      const issued = await api('/api/plugin/tokens', {
        method: 'POST',
        body: JSON.stringify({ label: 'ChatGPT Custom GPT Action', client: 'chatgpt_action' }),
      });
      lastIssuedTokens.chatgpt_action = issued.token;
      latestIssuedToken = { client: 'chatgpt_action', label: 'ChatGPT Token', token: issued.token };
      await navigator.clipboard?.writeText(issued.token).catch(() => {});
      showToast(`Generated & copied ChatGPT token (${issued.record.tokenPreview})`);
      await loadAgentsAndPlugins();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('issueMcpTokenBtn')?.addEventListener('click', async () => {
    if (isAdminLocked()) {
      showToast('Admin session required — unlock above or run Turgalium locally to mint Claude MCP tokens.');
      document.getElementById('adminSessionTokenInput')?.focus();
      return;
    }
    try {
      const issued = await api('/api/plugin/tokens', {
        method: 'POST',
        body: JSON.stringify({ label: 'Claude MCP HTTP Bearer', client: 'claude_mcp' }),
      });
      lastIssuedTokens.claude_mcp = issued.token;
      latestIssuedToken = { client: 'claude_mcp', label: 'Claude MCP Token', token: issued.token };
      await navigator.clipboard?.writeText(issued.token).catch(() => {});
      showToast(`Generated & copied Claude token (${issued.record.tokenPreview}) — filled into config below.`);
      await loadAgentsAndPlugins();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('selectProfitableBtn').addEventListener('click', () => {
    if (!currentScan || !Array.isArray(currentScan.assets)) return;
    selectedAssetIds = new Set(currentScan.assets.filter((a) => a.selectedByDefault).map((a) => a.id));
    recomputePlan();
  });

  document.getElementById('clearSelectionBtn').addEventListener('click', () => {
    selectedAssetIds.clear();
    recomputePlan();
  });

  document.getElementById('extractAllDefiBtn')?.addEventListener('click', () => {
    if (!currentScan) return;
    const readyDefi = currentScan.assets
      .filter(isDefiAsset)
      .filter((a) => normalizeDefiPosition(a, outputAsset).isReady);
    extractDefiAssets(readyDefi, 'All Ready DeFi');
  });

  document.getElementById('runLiveQueueBtn').addEventListener('click', executeSelectedLiveQueue);
  document.getElementById('verifyProofBtn')?.addEventListener('click', runPreSignProof);
  document.querySelectorAll('.mode-opt[data-exec-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setExecutionMode(btn.dataset.execMode));
  });

  document.getElementById('downloadBurnCsvBtn').addEventListener('click', () => {
    if (!currentPlan) return;
    const header = 'chain,symbol,token_address,amount,status,burn_sink,reason';
    const lines = (currentPlan.burnManifest || []).map((b) =>
      [b.chain, b.symbol, b.tokenAddress, b.amount, b.status, b.burnSink, b.reason].map(csvCell).join(',')
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `turgalium-burn-receipt-${Date.now()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    const title = chosen?.title || 'TurgaliumRouter.sol';
    await navigator.clipboard?.writeText(src).catch(() => {});
    showToast(`Copied ${title}.`);
  });
}

initUiMode();
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
  adminSessionRequired = Boolean(cfg?.adminSessionRequired);
  adminSessionLoaded = true;
  const feeInput = document.getElementById('feeRecipientInput');
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
  syncDestinationUiState();
  window.dispatchEvent(
    new CustomEvent('turgalium:config-loaded', {
      detail: { adminSessionRequired, canAccessAdmin: canAccessAdminRoutes() },
    })
  );
  if (canAccessAdminRoutes()) {
    syncBackgroundJobs();
    loadAgentsAndPlugins();
  } else {
    renderAgentsLockedState();
  }
});
const heroCanvasEl = document.getElementById('turgaliumHeroCanvas');
if (heroCanvasEl && typeof window.IntersectionObserver === 'function') {
  const heroIo = new window.IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      const siteVisible = !document.getElementById('siteShell')?.classList.contains('hidden');
      if (entry && entry.isIntersecting && siteVisible) {
        ensureHeroScene().then((scene) => scene?.setPaused(false));
      } else {
        heroScene?.setPaused(true);
      }
    },
    { threshold: 0.35 }
  );
  heroIo.observe(heroCanvasEl);
} else {
  const scheduleHeroScene = () => {
    if (!document.getElementById('siteShell')?.classList.contains('hidden')) {
      ensureHeroScene();
    }
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(scheduleHeroScene, { timeout: 250 });
  } else {
    setTimeout(scheduleHeroScene, 60);
  }
}

const primarySweepCtaEl = document.getElementById('runLiveQueueBtn');
if (primarySweepCtaEl && typeof window.IntersectionObserver === 'function') {
  const ctaIo = new window.IntersectionObserver(
    (entries) => {
      primaryCtaInView = Boolean(entries[0]?.isIntersecting);
      syncMobileStickySweepBar();
    },
    { threshold: 0.1 }
  );
  ctaIo.observe(primarySweepCtaEl);
}
document.getElementById('mobileStickySweepBtn')?.addEventListener('click', () => {
  document.getElementById('runLiveQueueBtn')?.click();
});
window.addEventListener('resize', () => syncMobileStickySweepBar());
renderEmptyScanState();
let zeroKeyAiAgent = 'ChatGPT';
let zeroKeyAiOutput = 'USDC';
let zeroKeyAiInitialized = false;

initInflightBridgeTracker();
registerServiceWorker();
initZeroKeyAiLaunchpad();
hydrateFromReviewLink();

async function runUnifiedScan() {
  if (!unifiedWallets.length) return;
  const btn = document.getElementById('unifiedAddSubmitBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Unifying…';
  }
  try {
    const scan = await api('/api/scan/unified', {
      method: 'POST',
      body: JSON.stringify({
        wallets: unifiedWallets,
        hasSolanaUsdcAta: solanaBalances ? Boolean(solanaBalances.hasUsdcAta) : undefined,
      }),
    });
    currentScan = scan;
    activeChainFilter = 'all';
    selectedAssetIds = new Set(scan.assets.filter((a) => a.selectedByDefault).map((a) => a.id));
    renderUnifiedWalletsBar();
    await recomputePlan();
    showToast(`Unified ${scan.unifiedWallets?.length || unifiedWallets.length} wallets across ${scan.chains.filter((c) => c.assetCount > 0).length} active chains.`);
  } catch (err) {
    showToast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Add & Unify';
    }
  }
}

function renderUnifiedWalletsBar() {
  const pillsHost = document.getElementById('unifiedWalletPills');
  if (!pillsHost) return;
  const summaries = currentScan?.unifiedWallets || [];
  if (!unifiedWallets.length) {
    pillsHost.innerHTML = `<span class="muted-xs">Add 2+ wallets (EVM, Cosmos, Sui, Aptos, TON, Tron, Bitcoin) to consolidate them into one Solana sweep.</span>`;
    return;
  }
  pillsHost.innerHTML = unifiedWallets
    .map((w, idx) => {
      const s = summaries.find((u) => u.address.toLowerCase() === w.address.toLowerCase());
      const usdTag = s ? ` · ${fmtUsd(s.grossUsd)}` : '';
      return `
        <span class="unified-wallet-pill mono">
          <span>${escapeHtml(w.label || shortAddr(w.address))}${escapeHtml(usdTag)}</span>
          <button type="button" class="unified-wallet-remove" data-remove-unified="${idx}" aria-label="Remove wallet">×</button>
        </span>
      `;
    })
    .join('');

  pillsHost.querySelectorAll('[data-remove-unified]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.removeUnified);
      unifiedWallets.splice(idx, 1);
      renderUnifiedWalletsBar();
      if (unifiedWallets.length >= 1) {
        await runUnifiedScan();
      }
    });
  });
}

function renderDustStrategyBanner() {
  const host = document.getElementById('dustStrategyBanner');
  if (!host) return;
  if (!lastDustPlan || !lastDustPlan.convertibleCount || activeFilter !== 'dust') {
    host.classList.add('hidden');
    host.innerHTML = '';
    return;
  }

  const instantCount = safeInt(lastDustPlan.instantSingleSigCount);
  const legacyCount = safeInt(lastDustPlan.multiInputSwapCount);
  const naiveSigs = safeInt(lastDustPlan.totalNaiveLegacySignatures);
  const optSigs = safeInt(lastDustPlan.totalOptimizedLegacySignatures);
  const savedSigs = safeInt(lastDustPlan.totalSignaturesEliminated);
  const eip5792Sigs = safeInt(lastDustPlan.totalEip5792Signatures);

  const lanePills = [];
  if (instantCount > 0) {
    lanePills.push(
      `<span class="dust-lane-pill is-instant">1-Sig Gasless: ${instantCount} (Permit2 / EIP-2612)</span>`
    );
  }
  if (legacyCount > 0) {
    lanePills.push(
      `<span class="dust-lane-pill is-multi">Consolidated Swap: ${legacyCount} legacy ERC-20</span>`
    );
  }
  if (savedSigs > 0) {
    lanePills.push(
      `<span class="dust-lane-pill is-saved">${naiveSigs} → ${optSigs} EOA prompts (−${savedSigs}) · ${eip5792Sigs} on EIP-5792</span>`
    );
  }

  const showInstantOnlyBtn = instantCount > 0 && legacyCount > 0;
  const showAllDustBtn =
    instantCount > 0 &&
    legacyCount > 0 &&
    selectedAssetIds.size !== lastDustPlan.convertibleAssetIds.length;

  host.innerHTML = `
    <div class="dust-strategy-row">
      <div class="dust-strategy-pills">${lanePills.join('')}</div>
      <div class="dust-strategy-actions">
        ${
          showInstantOnlyBtn
            ? `<button type="button" class="text-action" id="dustInstantLaneBtn">1-Sig lane only (${instantCount})</button>`
            : ''
        }
        ${
          showAllDustBtn
            ? `<button type="button" class="text-action muted" id="dustAllLaneBtn">All dust (${safeInt(lastDustPlan.convertibleCount)})</button>`
            : ''
        }
      </div>
    </div>
  `;
  host.classList.remove('hidden');

  const instantBtn = document.getElementById('dustInstantLaneBtn');
  if (instantBtn) {
    instantBtn.addEventListener('click', async () => {
      selectedAssetIds = new Set(lastDustPlan.instantSingleSigAssetIds || []);
      setExecutionMode('gasless');
      await recomputePlan();
      renderDustStrategyBanner();
      showToast(
        `Selected ${instantCount} Permit2/EIP-2612 dust token(s) in 1-Signature Gasless mode (0 per-token approvals).`
      );
    });
  }
  const allBtn = document.getElementById('dustAllLaneBtn');
  if (allBtn) {
    allBtn.addEventListener('click', async () => {
      selectedAssetIds = new Set(lastDustPlan.convertibleAssetIds || []);
      await recomputePlan();
      renderDustStrategyBanner();
    });
  }
}

async function selectConvertibleDust() {
  if (!currentScan) return;
  const seq = scanSeq;
  try {
    const dustPlan = await api('/api/dust/plan', {
      method: 'POST',
      body: JSON.stringify({
        scan: currentScan,
        maxDustThresholdUsd: 25,
        protocolFeeBps: getActiveProtocolFeeBps(),
        hasSolanaUsdcAta: solanaBalances ? Boolean(solanaBalances.hasUsdcAta) : undefined,
      }),
    });
    if (seq !== scanSeq) return;
    lastDustPlan = dustPlan;
    if (!dustPlan.convertibleAssetIds?.length) {
      renderDustStrategyBanner();
      showToast(`Found ${safeInt(dustPlan.totalDustAssetsFound)} dust tokens — none are net-positive after fees/gas (negative-ROI protected).`);
      return;
    }
    batchRescuedDustIds = new Set(dustPlan.convertibleAssetIds);
    selectedAssetIds = new Set(dustPlan.convertibleAssetIds);
    activeChainFilter = 'all';
    activeFilter = 'dust';
    document.querySelectorAll('.filter-pill').forEach((b) => b.classList.toggle('active', b.dataset.filter === 'dust'));
    await recomputePlan();
    renderDustStrategyBanner();
    const sigPart =
      dustPlan.totalSignaturesEliminated > 0
        ? ` · ${safeInt(dustPlan.totalNaiveLegacySignatures)}→${safeInt(dustPlan.totalOptimizedLegacySignatures)} EOA prompts`
        : '';
    showToast(
      `Selected ${safeInt(dustPlan.convertibleCount)} convertible dust tokens (est. $${safeNum(dustPlan.estimatedNetSolanaUsdc).toFixed(2)} USDC · +$${safeNum(dustPlan.totalBatchRescueGainUsd).toFixed(2)} batch rescue gain${sigPart}).`
    );
  } catch (err) {
    showToast(err.message);
  }
}

function buildSelfHostTemplateSetup() {
  const origin = (typeof window !== 'undefined' && window.location?.origin) || 'http://127.0.0.1:4321';
  return {
    claudeDesktopConfig: {
      mcpServers: {
        turgalium: {
          command: 'node',
          args: ['dist/src/mcp/server.js'],
          env: {
            TURGALIUM_API_URL: origin,
            TURGALIUM_API_TOKEN: '<MINT_TOKEN_ON_SELF_HOSTED_INSTANCE>',
          },
        },
      },
    },
    claudeCodeCommand: `claude mcp add --transport http turgalium ${origin}/mcp --header "Authorization: Bearer <MINT_TOKEN_ON_SELF_HOSTED_INSTANCE>"`,
    chatgptPluginManifestUrl: `${origin}/.well-known/ai-plugin.json`,
    chatgptOpenApiUrl: `${origin}/openapi.json`,
    mcpHttpEndpoint: `${origin}/mcp`,
  };
}

function renderAgentsLockedState() {
  const banner = document.getElementById('agentsAdminLockedBanner');
  banner?.classList.remove('hidden');

  const tabCountEl = document.getElementById('tabApprovalCount');
  if (tabCountEl) {
    tabCountEl.textContent = '0';
    tabCountEl.classList.add('muted');
  }
  const metaEl = document.getElementById('approvalsCountMeta');
  if (metaEl) metaEl.textContent = 'Locked · Self-host or unlock';

  syncDestinationUiState();

  const approvalsHost = document.getElementById('agentApprovalsHost');
  if (approvalsHost) {
    approvalsHost.innerHTML = `<div class="agents-empty-state">Admin session required to inspect or approve live agent proposals. Unlock above or run Turgalium locally (<code class="code-inline">npm run dev</code>).</div>`;
  }

  const mandatesHost = document.getElementById('agentMandatesHost');
  if (mandatesHost) {
    mandatesHost.innerHTML = `<div class="agents-empty-state">Spending mandates are locked on public deployments. Unlock with your <code class="code-inline">X-Turgalium-Admin-Session</code> token or self-host locally.</div>`;
  }

  const tokHost = document.getElementById('pluginTokensHost');
  if (tokHost) {
    tokHost.innerHTML = `<div class="agents-empty-state">API token minting is locked on public deployments. Unlock above or run locally to generate scoped Claude MCP &amp; ChatGPT bearer tokens.</div>`;
  }

  const tpl = buildSelfHostTemplateSetup();
  const claudeHost = document.getElementById('claudeMcpConfigHost');
  if (claudeHost) claudeHost.textContent = JSON.stringify(tpl.claudeDesktopConfig, null, 2);
  const cmdHost = document.getElementById('claudeCodeCmdHost');
  if (cmdHost) cmdHost.textContent = tpl.claudeCodeCommand;
  const gptHost = document.getElementById('chatgptPluginHost');
  if (gptHost) {
    gptHost.textContent = JSON.stringify(
      {
        manifest: tpl.chatgptPluginManifestUrl,
        openApiSpec: tpl.chatgptOpenApiUrl,
        mcpHttp: tpl.mcpHttpEndpoint,
        auth: 'Bearer <mint token on self-hosted instance>',
      },
      null,
      2
    );
  }
}

async function loadAgentsAndPlugins() {
  if (!canAccessAdminRoutes()) {
    renderAgentsLockedState();
    return;
  }
  try {
    const [mRes, aRes, pRes] = await Promise.all([
      api('/api/agents/mandates'),
      api('/api/agents/approvals'),
      api('/api/plugin/setup'),
    ]);
    agentMandates = mRes.mandates || [];
    agentApprovals = aRes.approvals || [];
    pluginSetupData = pRes;
    document.getElementById('agentsAdminLockedBanner')?.classList.add('hidden');
    renderAgentsAndPlugins();
  } catch {
    if (adminSessionRequired) {
      adminSessionToken = '';
      try {
        window.sessionStorage?.removeItem(ADMIN_SESSION_STORAGE_KEY);
      } catch {
        // ignore
      }
      renderAgentsLockedState();
    }
  }
}

function buildRenderedClaudeDesktopConfig() {
  if (!pluginSetupData?.claudeDesktopConfig) {
    return isAdminLocked() ? buildSelfHostTemplateSetup().claudeDesktopConfig : null;
  }
  const cloned = JSON.parse(JSON.stringify(pluginSetupData.claudeDesktopConfig));
  if (lastIssuedTokens.claude_mcp && cloned?.mcpServers?.turgalium?.env) {
    cloned.mcpServers.turgalium.env.TURGALIUM_API_TOKEN = lastIssuedTokens.claude_mcp;
  }
  return cloned;
}

function buildRenderedClaudeCliCommand() {
  if (!pluginSetupData?.claudeCodeCommand) {
    return isAdminLocked() ? buildSelfHostTemplateSetup().claudeCodeCommand : '';
  }
  if (lastIssuedTokens.claude_mcp) {
    return pluginSetupData.claudeCodeCommand.replace('<TURGALIUM_API_TOKEN>', lastIssuedTokens.claude_mcp);
  }
  return pluginSetupData.claudeCodeCommand;
}

function renderAgentsAndPlugins() {
  const pendingCount = agentApprovals.filter((a) => a.status === 'pending_approval').length;
  const tabCountEl = document.getElementById('tabApprovalCount');
  if (tabCountEl) {
    tabCountEl.textContent = String(pendingCount);
    tabCountEl.classList.toggle('muted', pendingCount === 0);
  }
  const metaEl = document.getElementById('approvalsCountMeta');
  if (metaEl) metaEl.textContent = `${pendingCount} pending · ${agentApprovals.length} total`;

  syncDestinationUiState();

  const approvalsHost = document.getElementById('agentApprovalsHost');
  if (approvalsHost) {
    if (!agentApprovals.length) {
      approvalsHost.innerHTML = `<div class="muted-xs" style="padding:10px 0;">No permission requests yet. Connect Claude MCP or ChatGPT Actions to queue permission-gated sweeps.</div>`;
    } else {
      approvalsHost.innerHTML = agentApprovals
        .map((req) => {
          const isPending = req.status === 'pending_approval';
          const isApproved = req.status === 'approved' || req.status === 'auto_approved_by_mandate';
          const badgeClass = isPending ? 'roi-low' : isApproved ? 'roi-worth' : 'roi-neg';
          const clientLabel =
            req.client === 'claude_mcp'
              ? 'Claude MCP'
              : req.client === 'chatgpt_action'
              ? 'ChatGPT Action'
              : 'Smart-Contract Agent';
          return `
            <div class="approval-card ${isPending ? 'is-pending' : isApproved ? 'is-approved' : ''}">
              <div class="approval-card-head">
                <div>
                  <strong>${escapeHtml(req.summary)}</strong>
                  <div class="muted-xs mono">${escapeHtml(clientLabel)} · ${escapeHtml(req.actionType)} · ${escapeHtml(req.chains.join(', ') || 'multi-chain')}</div>
                </div>
                <span class="roi-pill ${badgeClass}">${escapeHtml(req.status.replaceAll('_', ' '))}</span>
              </div>
              <div class="muted-xs mono">Gross $${Number(req.grossUsd).toFixed(2)} → Est. $${Number(req.estimatedNetUsdc).toFixed(2)} USDC · Dest ${escapeHtml(shortAddr(req.solanaDestination))} · Digest ${escapeHtml(shortAddr(req.requestDigestSha256))}</div>
              <div class="muted-xs">${escapeHtml(req.decisionReason || '')}</div>
              ${
                isPending
                  ? `<div class="btn-row" style="margin-top:4px;">
                      <button type="button" class="btn-pill-dark btn-sm" data-decide-approval="${escapeHtml(req.approvalId)}" data-decision="approve">Approve Permission</button>
                      <button type="button" class="btn-outline-sm" data-decide-approval="${escapeHtml(req.approvalId)}" data-decision="reject">Reject</button>
                    </div>`
                  : ''
              }
            </div>
          `;
        })
        .join('');

      approvalsHost.querySelectorAll('[data-decide-approval]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          try {
            await api(`/api/agents/approvals/${encodeURIComponent(btn.dataset.decideApproval)}/decide`, {
              method: 'POST',
              body: JSON.stringify({ decision: btn.dataset.decision }),
            });
            showToast(btn.dataset.decision === 'approve' ? 'Permission approved.' : 'Permission rejected.');
            await loadAgentsAndPlugins();
          } catch (err) {
            showToast(err.message);
          }
        });
      });
    }
  }

  const mandatesHost = document.getElementById('agentMandatesHost');
  if (mandatesHost) {
    if (!agentMandates.length) {
      mandatesHost.innerHTML = `<div class="muted-xs">No active smart-contract agent mandates yet. Grant one above to set an immutable Solana destination and daily USD cap.</div>`;
    } else {
      mandatesHost.innerHTML = agentMandates
        .map(
          (m) => `
          <div class="mandate-card">
            <div class="approval-card-head">
              <div>
                <strong>${escapeHtml(m.name)}</strong>
                <div class="muted-xs mono">${escapeHtml(m.mandateId)} · Locked → ${escapeHtml(shortAddr(m.lockedSolanaRecipient))}</div>
              </div>
              <span class="roi-pill ${m.active ? 'roi-worth' : 'roi-neg'}">${m.active ? 'Active' : 'Revoked'}</span>
            </div>
            <div class="muted-xs mono">Caps: $${safeNum(m.maxPerTxUsd)}/tx · $${safeNum(m.remainingDailyUsd)}/$${safeNum(m.dailyCapUsd)} daily left · Auto <= $${safeNum(m.autoApproveUnderUsd)} · Actions: ${escapeHtml((m.allowedActions || []).join(', '))}</div>
            ${
              m.active
                ? `<div><button type="button" class="btn-outline-sm" data-revoke-mandate="${escapeHtml(m.mandateId)}">Revoke Mandate</button></div>`
                : ''
            }
          </div>
        `
        )
        .join('');

      mandatesHost.querySelectorAll('[data-revoke-mandate]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api(`/api/agents/mandates/${encodeURIComponent(btn.dataset.revokeMandate)}/revoke`, {
              method: 'POST',
            });
            showToast('Mandate revoked immediately.');
            await loadAgentsAndPlugins();
          } catch (err) {
            showToast(err?.message || 'Failed to revoke mandate.');
          } finally {
            btn.disabled = false;
          }
        });
      });
    }
  }

  if (pluginSetupData) {
    const banner = document.getElementById('issuedTokenBanner');
    const bannerTitle = document.getElementById('issuedTokenBannerTitle');
    const bannerVal = document.getElementById('issuedTokenBannerValue');
    if (banner && bannerTitle && bannerVal) {
      if (latestIssuedToken?.token) {
        banner.classList.remove('hidden');
        bannerTitle.textContent = `${latestIssuedToken.label} ready`;
        bannerVal.textContent = latestIssuedToken.token;
      } else {
        banner.classList.add('hidden');
      }
    }

    const claudeFilledBadge = document.getElementById('claudeTokenFilledBadge');
    claudeFilledBadge?.classList.toggle('hidden', !lastIssuedTokens.claude_mcp);

    const claudeHost = document.getElementById('claudeMcpConfigHost');
    if (claudeHost) claudeHost.textContent = JSON.stringify(buildRenderedClaudeDesktopConfig(), null, 2);
    const cmdHost = document.getElementById('claudeCodeCmdHost');
    if (cmdHost) cmdHost.textContent = buildRenderedClaudeCliCommand();
    const gptHost = document.getElementById('chatgptPluginHost');
    if (gptHost) {
      gptHost.textContent = JSON.stringify(
        {
          manifest: pluginSetupData.chatgptPluginManifestUrl,
          openApiSpec: pluginSetupData.chatgptOpenApiUrl,
          mcpHttp: pluginSetupData.mcpHttpEndpoint,
          auth: lastIssuedTokens.chatgpt_action
            ? `Bearer ${lastIssuedTokens.chatgpt_action}`
            : 'Bearer <generate ChatGPT token above>',
        },
        null,
        2
      );
    }

    const tokHost = document.getElementById('pluginTokensHost');
    if (tokHost) {
      const toks = pluginSetupData.tokens || [];
      tokHost.innerHTML = toks.length
        ? toks
            .map(
              (t) => `
              <div class="mandate-card">
                <div class="approval-card-head">
                  <div>
                    <strong>${escapeHtml(t.label)}</strong>
                    <div class="muted-xs mono">${escapeHtml(t.tokenPreview)} · Scopes: ${escapeHtml(t.scopes.join(', '))}</div>
                  </div>
                  ${
                    t.revoked
                      ? `<span class="roi-pill roi-neg">Revoked</span>`
                      : `<button type="button" class="btn-outline-sm" data-revoke-token="${escapeHtml(t.tokenId)}" data-token-client="${escapeHtml(t.client || '')}">Revoke</button>`
                  }
                </div>
              </div>
            `
            )
            .join('')
        : `<div class="muted-xs">No API tokens generated yet. Click a button above to mint one.</div>`;

      tokHost.querySelectorAll('[data-revoke-token]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api(`/api/plugin/tokens/${encodeURIComponent(btn.dataset.revokeToken)}/revoke`, {
              method: 'POST',
            });
            const client = btn.dataset.tokenClient;
            if (client && lastIssuedTokens[client]) lastIssuedTokens[client] = null;
            if (latestIssuedToken && latestIssuedToken.client === client) latestIssuedToken = null;
            showToast('AI plugin token revoked.');
            await loadAgentsAndPlugins();
          } catch (err) {
            showToast(err?.message || 'Failed to revoke AI plugin token.');
          } finally {
            btn.disabled = false;
          }
        });
      });
    }
  }
}


// =====================================================================
// PERSISTENT IN-FLIGHT BRIDGE TRACKER (localStorage < 24h)
// Tracks CCTP V2, Mayan, Relay, LI.FI & cross-chain bridge legs across
// page reloads with live finality status & 1-tap Solana claiming.
// =====================================================================
function normalizeBridgeProviderLabel(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 'Bridge';
  if (s.includes('cctp') || s.includes('circle')) return 'CCTP V2';
  if (s.includes('mayan')) return 'Mayan';
  if (s.includes('relay')) return 'Relay';
  if (s.includes('lifi') || s.includes('li.fi')) return 'LI.FI';
  if (s.includes('debridge') || s.includes('dln')) return 'deBridge';
  if (s.includes('gasless')) return 'Gasless Relay';
  if (s.includes('eip5792')) return 'Batch Bridge';
  return String(raw).trim().slice(0, 24);
}

function isCctpBridgeEntry(entry) {
  if (!entry) return false;
  if (entry.requiresSolanaClaim) return true;
  const p = String(entry.provider || '').toLowerCase();
  return p.includes('cctp') || p.includes('circle');
}

function isTrackableBridgeTxHash(hash) {
  if (typeof hash !== 'string') return false;
  const h = hash.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(h)) return true;
  return /^[A-Za-z0-9_-]{16,128}$/.test(h);
}

function formatRelativeAgeShort(ts) {
  const diffSec = Math.max(0, Math.floor((Date.now() - safeNum(ts)) / 1000));
  if (diffSec < 60) return 'just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function sanitizeInflightBridgeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const chain = String(raw.chain || '').trim().slice(0, 48);
  const txHash = String(raw.txHash || '').trim();
  if (!chain || !isTrackableBridgeTxHash(txHash)) return null;
  const now = Date.now();
  const timestamp = safeNum(raw.timestamp) > 0 ? safeNum(raw.timestamp) : now;
  if (now - timestamp >= INFLIGHT_BRIDGE_MAX_AGE_MS) return null;
  if (raw.dismissed) return null;

  const validStatuses = new Set(['confirming', 'relaying', 'attested', 'landed', 'failed']);
  const status = validStatuses.has(raw.status) ? raw.status : 'relaying';
  const id = `${chain.toLowerCase()}:${txHash.toLowerCase()}`;
  return {
    id,
    chain,
    chainName: String(raw.chainName || chain).trim().slice(0, 48),
    provider: String(raw.provider || 'bridge').trim().slice(0, 40),
    txHash,
    requestId: typeof raw.requestId === 'string' ? raw.requestId.trim().slice(0, 128) : '',
    jobId: typeof raw.jobId === 'string' ? raw.jobId.trim().slice(0, 80) : '',
    solanaDestination:
      typeof raw.solanaDestination === 'string' ? raw.solanaDestination.trim().slice(0, 64) : '',
    outputAsset: String(raw.outputAsset || 'USDC').toUpperCase() === 'SOL' ? 'SOL' : 'USDC',
    amountUsd: Math.max(0, safeNum(raw.amountUsd)),
    assetCount: Math.max(1, safeInt(raw.assetCount) || 1),
    explorerUrl: safeHttpUrl(raw.explorerUrl) || '',
    requiresSolanaClaim: Boolean(raw.requiresSolanaClaim),
    status,
    statusText: String(raw.statusText || '').trim().slice(0, 180),
    attestationStatus:
      typeof raw.attestationStatus === 'string' ? raw.attestationStatus.trim().slice(0, 32) : '',
    solanaTxHash:
      typeof raw.solanaTxHash === 'string' && isTrackableBridgeTxHash(raw.solanaTxHash)
        ? raw.solanaTxHash.trim()
        : '',
    timestamp,
    updatedAt: safeNum(raw.updatedAt) > 0 ? safeNum(raw.updatedAt) : now,
  };
}

function saveInflightBridges() {
  try {
    const now = Date.now();
    inFlightBridges = inFlightBridges
      .filter((item) => item && now - safeNum(item.timestamp) < INFLIGHT_BRIDGE_MAX_AGE_MS)
      .slice(0, INFLIGHT_BRIDGE_MAX_ITEMS);
    if (inFlightBridges.length) {
      window.localStorage?.setItem(INFLIGHT_BRIDGES_STORAGE_KEY, JSON.stringify(inFlightBridges));
    } else {
      window.localStorage?.removeItem(INFLIGHT_BRIDGES_STORAGE_KEY);
    }
  } catch {
    // ignore storage quota / privacy mode errors
  }
}

function loadInflightBridges() {
  try {
    const raw = window.localStorage?.getItem(INFLIGHT_BRIDGES_STORAGE_KEY);
    if (!raw) {
      inFlightBridges = [];
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      inFlightBridges = [];
      saveInflightBridges();
      return;
    }
    const seen = new Set();
    const clean = [];
    for (const item of parsed) {
      const sanitized = sanitizeInflightBridgeRecord(item);
      if (sanitized && !seen.has(sanitized.id)) {
        seen.add(sanitized.id);
        clean.push(sanitized);
      }
    }
    inFlightBridges = clean.slice(0, INFLIGHT_BRIDGE_MAX_ITEMS);
    if (inFlightBridges.length !== parsed.length) {
      saveInflightBridges();
    }
  } catch {
    inFlightBridges = [];
  }
}

function ensureInflightPolling() {
  const hasPending = inFlightBridges.some(
    (b) => b.status !== 'landed' && b.status !== 'failed'
  );
  if (hasPending && !inFlightPollTimer) {
    inFlightPollTimer = setInterval(() => {
      pollInflightBridgesFinality({ manual: false });
    }, 12000);
  } else if (!hasPending && inFlightPollTimer) {
    clearInterval(inFlightPollTimer);
    inFlightPollTimer = null;
  }
}

function upsertInflightBridge(record) {
  const incoming = sanitizeInflightBridgeRecord(record);
  if (!incoming) return null;

  const idx = inFlightBridges.findIndex((b) => b.id === incoming.id);
  if (idx >= 0) {
    const prev = inFlightBridges[idx];
    inFlightBridges[idx] = {
      ...prev,
      ...incoming,
      timestamp: prev.timestamp || incoming.timestamp,
      amountUsd: incoming.amountUsd > 0 ? incoming.amountUsd : prev.amountUsd,
      assetCount: incoming.assetCount > 0 ? incoming.assetCount : prev.assetCount,
      solanaDestination: incoming.solanaDestination || prev.solanaDestination,
      explorerUrl: incoming.explorerUrl || prev.explorerUrl,
      requestId: incoming.requestId || prev.requestId,
      jobId: incoming.jobId || prev.jobId,
      solanaTxHash: incoming.solanaTxHash || prev.solanaTxHash,
      requiresSolanaClaim: Boolean(prev.requiresSolanaClaim || incoming.requiresSolanaClaim),
      updatedAt: Date.now(),
    };
  } else {
    inFlightBridges.unshift(incoming);
  }
  saveInflightBridges();
  renderInflightBridgeBanner();
  ensureInflightPolling();
  return inFlightBridges[idx >= 0 ? idx : 0];
}

function dismissInflightBridge(id) {
  inFlightBridges = inFlightBridges.filter((b) => b.id !== id);
  saveInflightBridges();
  renderInflightBridgeBanner();
  ensureInflightPolling();
}

function dismissAllInflightBridges() {
  inFlightBridges = [];
  saveInflightBridges();
  renderInflightBridgeBanner();
  ensureInflightPolling();
}

function reconcileJobsIntoInflightBridges(jobs) {
  if (!Array.isArray(jobs) || !jobs.length) return;
  let changed = false;
  for (const job of jobs) {
    const legs = Array.isArray(job?.legs) ? job.legs : [];
    for (const leg of legs) {
      if (!isTrackableBridgeTxHash(leg?.evmTxHash)) continue;
      const id = `${String(leg.chain || '').toLowerCase()}:${String(leg.evmTxHash).trim().toLowerCase()}`;
      const existing = inFlightBridges.find((b) => b.id === id);
      if (!existing) continue;

      const updated = upsertInflightBridge({
        chain: leg.chain,
        chainName: leg.chainName || leg.chain,
        provider: leg.provider || job.bridgePreference || 'bridge',
        txHash: leg.evmTxHash,
        requestId: leg.requestId || '',
        jobId: job.jobId || '',
        solanaDestination: job.solanaDestination || '',
        outputAsset: job.outputAsset || 'USDC',
        amountUsd: safeNum(leg.estimatedNetUsd),
        assetCount: safeInt(leg.assetCount) || 1,
        explorerUrl: leg.explorerUrl || '',
        requiresSolanaClaim: Boolean(leg.requiresSolanaClaim),
        status: leg.status || 'relaying',
        statusText: leg.statusText || '',
        attestationStatus: leg.attestationStatus || '',
        solanaTxHash: leg.solanaTxHash || '',
      });
      if (updated) changed = true;
    }
  }
  if (changed) {
    renderInflightBridgeBanner();
    ensureInflightPolling();
  }
}

async function pollInflightBridgesFinality({ manual = false } = {}) {
  if (inFlightPollInProgress) return;
  const pending = inFlightBridges.filter(
    (b) => b.status !== 'landed' && b.status !== 'failed'
  );
  if (!pending.length) {
    ensureInflightPolling();
    return;
  }

  inFlightPollInProgress = true;
  let anyChanged = false;
  let anyLanded = false;

  try {
    const batchTargets = pending.slice(0, 12);
    const resp = await api('/api/bridge/status-batch', {
      method: 'POST',
      body: JSON.stringify({
        bridges: batchTargets.map((entry) => ({
          id: entry.id,
          chain: entry.chain,
          chainName: entry.chainName,
          txHash: entry.txHash,
          provider: entry.provider || undefined,
          requestId: entry.requestId || undefined,
          solanaDestination: entry.solanaDestination || undefined,
          status: entry.status,
        })),
      }),
    });
    const results = Array.isArray(resp?.results) ? resp.results : [];
    const byId = new Map(results.map((r) => [r.id, r]));

    for (const entry of batchTargets) {
      const next = byId.get(entry.id);
      if (!next) continue;
      if (next.status && next.status !== entry.status) {
        entry.status = next.status;
        anyChanged = true;
        if (next.status === 'landed') anyLanded = true;
      }
      if (next.attestationStatus && next.attestationStatus !== entry.attestationStatus) {
        entry.attestationStatus = next.attestationStatus;
        anyChanged = true;
      }
      if (next.requiresSolanaClaim && !entry.requiresSolanaClaim) {
        entry.requiresSolanaClaim = true;
        anyChanged = true;
      }
      if (next.solanaTxHash && isTrackableBridgeTxHash(next.solanaTxHash) && next.solanaTxHash !== entry.solanaTxHash) {
        entry.solanaTxHash = next.solanaTxHash;
        anyChanged = true;
      }
      if (next.statusText && next.statusText !== entry.statusText) {
        entry.statusText = String(next.statusText).slice(0, 180);
        anyChanged = true;
      }
      if (anyChanged) {
        entry.updatedAt = Date.now();
      }
    }

    if (anyChanged) {
      saveInflightBridges();
      renderInflightBridgeBanner();
    }
    if (anyLanded) {
      refreshSolanaBalance();
    }
    if (manual) {
      showToast('Checked live bridge finality status.');
    }
  } catch {
    // non-fatal batch poll error
  } finally {
    inFlightPollInProgress = false;
    ensureInflightPolling();
  }
}

async function claimInflightBridgeOnSolana(entry, btnEl) {
  if (!entry) return;
  const solDest =
    entry.solanaDestination ||
    getVerifiedSolanaDestination() ||
    getConnectedSolanaAddress() ||
    '';
  if (!solDest) {
    showToast('Connect your Solana wallet to claim this bridge transfer.');
    openWalletModal('solana');
    return;
  }
  const syntheticJob = {
    jobId: entry.jobId || '',
    solanaDestination: solDest,
    outputAsset: entry.outputAsset || 'USDC',
  };
  const syntheticLeg = {
    chain: entry.chain,
    chainName: entry.chainName,
    provider: entry.provider,
    evmTxHash: entry.txHash,
    estimatedNetUsd: entry.amountUsd,
    status: entry.status,
    requiresSolanaClaim: true,
  };
  await claimCctpLegOnSolana(syntheticJob, syntheticLeg, btnEl);
  if (btnEl && !btnEl.disabled) {
    btnEl.textContent = 'Claim on Solana';
  }
}

function getInflightStatusMeta(entry) {
  if (entry.status === 'landed') {
    return { label: 'Settled', cls: 'is-settled', icon: 'check-circle' };
  }
  if (entry.status === 'attested' || entry.attestationStatus === 'complete') {
    return { label: 'Ready to Claim', cls: 'is-ready', icon: 'shield-check' };
  }
  if (entry.status === 'failed') {
    return { label: 'Attention', cls: 'is-failed', icon: 'alert-triangle' };
  }
  if (entry.status === 'confirming') {
    return { label: 'Confirming', cls: 'is-pending', icon: 'clock' };
  }
  return { label: 'In Flight', cls: 'is-pending', icon: 'activity-dot' };
}

function renderInflightBridgeBanner() {
  const banner = document.getElementById('inflightBridgeBanner');
  const sitePill = document.getElementById('inflightSitePill');
  const siteVisible = !document.getElementById('siteShell')?.classList.contains('hidden');

  const now = Date.now();
  const activeEntries = inFlightBridges.filter(
    (b) => b && now - safeNum(b.timestamp) < INFLIGHT_BRIDGE_MAX_AGE_MS
  );

  if (banner) {
    if (!activeEntries.length) {
      banner.classList.add('hidden');
      banner.replaceChildren();
    } else {
      banner.classList.remove('hidden');
      banner.replaceChildren();

      const header = document.createElement('div');
      header.className = 'inflight-head';

      const titleGroup = document.createElement('div');
      titleGroup.className = 'inflight-title-group';
      const dot = document.createElement('span');
      const hasPending = activeEntries.some((e) => e.status !== 'landed' && e.status !== 'failed');
      dot.className = `inflight-live-dot${hasPending ? '' : ' is-idle'}`;
      const titleStrong = document.createElement('strong');
      titleStrong.textContent =
        activeEntries.length === 1
          ? 'In-Flight Bridge Transfer'
          : `In-Flight Bridge Transfers (${activeEntries.length})`;
      const subtitle = document.createElement('span');
      subtitle.className = 'muted-xs';
      subtitle.textContent = 'Restored locally · <24h window';
      titleGroup.append(dot, titleStrong, subtitle);

      const headActions = document.createElement('div');
      headActions.className = 'inflight-head-actions';
      if (hasPending) {
        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'text-action';
        refreshBtn.textContent = 'Refresh';
        refreshBtn.addEventListener('click', () => pollInflightBridgesFinality({ manual: true }));
        headActions.append(refreshBtn);
      }
      if (activeEntries.length > 1) {
        const dismissAllBtn = document.createElement('button');
        dismissAllBtn.type = 'button';
        dismissAllBtn.className = 'text-action muted';
        dismissAllBtn.textContent = 'Dismiss all';
        dismissAllBtn.addEventListener('click', dismissAllInflightBridges);
        headActions.append(dismissAllBtn);
      }
      header.append(titleGroup, headActions);

      const list = document.createElement('div');
      list.className = 'inflight-rows';

      for (const entry of activeEntries) {
        const meta = getInflightStatusMeta(entry);
        const row = document.createElement('div');
        row.className = 'inflight-row';
        row.dataset.inflightId = entry.id;

        const left = document.createElement('div');
        left.className = 'inflight-row-left';

        const logo = document.createElement('img');
        logo.src = getChainLogoPath(entry.chain);
        logo.alt = '';
        logo.width = 16;
        logo.height = 16;
        logo.className = `chain-logo-xs${needsDarkLogoBacking(entry.chain) ? ' logo-dark-backing' : ''}`;

        const info = document.createElement('div');
        info.className = 'inflight-row-info';

        const topLine = document.createElement('div');
        topLine.className = 'inflight-row-top';
        const chainSpan = document.createElement('strong');
        chainSpan.textContent = entry.chainName;
        const provPill = document.createElement('span');
        provPill.className = 'inflight-provider-pill';
        provPill.textContent = normalizeBridgeProviderLabel(entry.provider);
        const amtSpan = document.createElement('span');
        amtSpan.className = 'mono inflight-amount';
        amtSpan.textContent =
          entry.amountUsd > 0
            ? `+$${entry.amountUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${entry.outputAsset}`
            : `→ Solana ${entry.outputAsset}`;
        const ageSpan = document.createElement('span');
        ageSpan.className = 'muted-xs';
        ageSpan.textContent = formatRelativeAgeShort(entry.timestamp);
        topLine.append(chainSpan, provPill, amtSpan, ageSpan);

        const subLine = document.createElement('div');
        subLine.className = 'inflight-row-sub';
        const statusPill = document.createElement('span');
        statusPill.className = `inflight-status-pill ${meta.cls}`;
        statusPill.innerHTML = uiIcon(meta.icon, 11);
        statusPill.appendChild(document.createTextNode(meta.label));
        subLine.append(statusPill);

        const detailText = document.createElement('span');
        detailText.className = 'inflight-detail-text';
        detailText.textContent =
          entry.statusText ||
          (entry.status === 'landed'
            ? `Arrived on Solana (${entry.outputAsset})`
            : `Tracking ${normalizeBridgeProviderLabel(entry.provider)} finality to Solana`);
        subLine.append(detailText);

        const srcUrl = safeExplorerTxUrl(entry.explorerUrl, entry.txHash);
        if (srcUrl) {
          const a = document.createElement('a');
          a.className = 'explorer-link mono';
          a.href = srcUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'Tx ↗';
          subLine.append(a);
        }
        const solUrl = safeExplorerTxUrl('https://solscan.io', entry.solanaTxHash);
        if (solUrl) {
          const a = document.createElement('a');
          a.className = 'explorer-link mono';
          a.href = solUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'Solscan ↗';
          subLine.append(a);
        }

        info.append(topLine, subLine);
        left.append(logo, info);

        const right = document.createElement('div');
        right.className = 'inflight-row-actions';

        const canClaim =
          (isCctpBridgeEntry(entry) ||
            entry.status === 'attested' ||
            entry.attestationStatus === 'complete') &&
          !entry.solanaTxHash &&
          entry.status !== 'landed';

        if (canClaim) {
          const claimBtn = document.createElement('button');
          claimBtn.type = 'button';
          claimBtn.className = 'btn-pill-dark inflight-claim-btn';
          claimBtn.textContent = 'Claim on Solana';
          claimBtn.addEventListener('click', () => claimInflightBridgeOnSolana(entry, claimBtn));
          right.append(claimBtn);
        } else if (entry.status === 'landed') {
          const receiptBtn = document.createElement('button');
          receiptBtn.type = 'button';
          receiptBtn.className = 'btn-outline-sm inflight-mini-btn';
          receiptBtn.textContent = 'Receipt';
          receiptBtn.addEventListener('click', () => {
            openReceiptModal(buildReceiptDataFromBridges([entry]));
          });
          right.append(receiptBtn);
        }

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.className = 'inflight-dismiss-btn';
        dismissBtn.setAttribute('aria-label', `Dismiss ${entry.chainName} bridge tracker`);
        dismissBtn.title = 'Dismiss';
        dismissBtn.innerHTML = uiIcon('x', 13);
        dismissBtn.addEventListener('click', () => dismissInflightBridge(entry.id));
        right.append(dismissBtn);

        row.append(left, right);
        list.append(row);
      }

      banner.append(header, list);
    }
  }

  // Compact porcelain pill on the landing page when restored transfers exist
  if (sitePill) {
    if (!siteVisible || !activeEntries.length) {
      sitePill.classList.add('hidden');
      sitePill.replaceChildren();
    } else {
      const lead = activeEntries[0];
      const meta = getInflightStatusMeta(lead);
      sitePill.classList.remove('hidden');
      sitePill.replaceChildren();

      const dot = document.createElement('span');
      dot.className = `inflight-live-dot${lead.status === 'landed' ? ' is-idle' : ''}`;

      const textWrap = document.createElement('div');
      textWrap.className = 'inflight-site-pill-copy';
      const label = document.createElement('strong');
      label.textContent =
        activeEntries.length === 1
          ? `${lead.chainName} · ${normalizeBridgeProviderLabel(lead.provider)} (${meta.label})`
          : `${activeEntries.length} in-flight bridges · ${meta.label}`;
      textWrap.append(label);

      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'btn-pill-dark inflight-claim-btn';
      const needsClaim =
        (isCctpBridgeEntry(lead) ||
          lead.status === 'attested' ||
          lead.attestationStatus === 'complete') &&
        !lead.solanaTxHash &&
        lead.status !== 'landed';
      if (needsClaim) {
        actionBtn.textContent = 'Claim on Solana';
        actionBtn.addEventListener('click', () => {
          openApp('activity');
          claimInflightBridgeOnSolana(lead, actionBtn);
        });
      } else {
        actionBtn.textContent = 'Track';
        actionBtn.addEventListener('click', () => openApp('activity'));
      }

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'inflight-dismiss-btn';
      dismissBtn.setAttribute('aria-label', 'Dismiss in-flight bridge notice');
      dismissBtn.innerHTML = uiIcon('x', 13);
      dismissBtn.addEventListener('click', dismissAllInflightBridges);

      sitePill.append(dot, textWrap, actionBtn, dismissBtn);
    }
  }
}

function initInflightBridgeTracker() {
  loadInflightBridges();
  renderInflightBridgeBanner();
  if (inFlightBridges.some((b) => b.status !== 'landed' && b.status !== 'failed')) {
    ensureInflightPolling();
    pollInflightBridgesFinality({ manual: false });
  }
}

// =====================================================================
// SHAREABLE DAYLIGHT-PORCELAIN SWEEP RECEIPT CARD MODAL
// Privacy-safe by default: NEVER includes wallet addresses unless the
// user explicitly toggles "Include truncated address".
// =====================================================================
function buildReceiptDataFromBridges(bridges) {
  const list = Array.isArray(bridges) ? bridges : [];
  const chains = Array.from(new Set(list.map((b) => b.chainName || b.chain).filter(Boolean)));
  const providers = Array.from(
    new Set(list.map((b) => normalizeBridgeProviderLabel(b.provider)).filter(Boolean))
  );
  const netUsd = list.reduce((sum, b) => sum + safeNum(b.amountUsd), 0);
  const assetCount = list.reduce((sum, b) => sum + Math.max(1, safeInt(b.assetCount) || 1), 0);
  const outAsset = list[0]?.outputAsset || outputAsset || 'USDC';
  const solDest = list.find((b) => b.solanaDestination)?.solanaDestination || '';
  return {
    assetCount: Math.max(1, assetCount),
    chainCount: Math.max(1, chains.length),
    chainNames: chains,
    netUsd,
    outputAsset: outAsset,
    providerLabel: providers.slice(0, 2).join(' + ') || 'Auto Route',
    solanaDestination: solDest,
    timestamp: list[0]?.timestamp || Date.now(),
    isPreview: false,
  };
}

function buildReceiptData(source = null) {
  if (source && typeof source === 'object' && typeof source.assetCount === 'number' && !source.legs) {
    return source;
  }

  const job =
    (source && Array.isArray(source.legs) ? source : null) ||
    backgroundJobs.find(
      (j) =>
        Array.isArray(j.legs) &&
        j.legs.some((l) => l.status === 'landed' || l.status === 'attested')
    ) ||
    backgroundJobs[0] ||
    null;

  if (job && Array.isArray(job.legs) && job.legs.length) {
    const legs = job.legs;
    const chains = Array.from(new Set(legs.map((l) => l.chainName || l.chain).filter(Boolean)));
    const providers = Array.from(
      new Set(
        legs
          .map((l) => normalizeBridgeProviderLabel(l.provider || job.bridgePreference))
          .filter(Boolean)
      )
    );
    const assetCount = legs.reduce((sum, l) => sum + Math.max(1, safeInt(l.assetCount) || 1), 0);
    const netUsd = legs.reduce((sum, l) => sum + safeNum(l.estimatedNetUsd), 0);
    return {
      assetCount: Math.max(1, assetCount),
      chainCount: Math.max(1, chains.length),
      chainNames: chains,
      netUsd,
      outputAsset: String(job.outputAsset || outputAsset || 'USDC').toUpperCase() === 'SOL' ? 'SOL' : 'USDC',
      providerLabel: providers.slice(0, 2).join(' + ') || 'Auto Route',
      solanaDestination: String(job.solanaDestination || '').trim(),
      timestamp: safeNum(job.updatedAt) || safeNum(job.createdAt) || Date.now(),
      isPreview: false,
    };
  }

  if (inFlightBridges.length) {
    return buildReceiptDataFromBridges(inFlightBridges);
  }

  if (currentPlan && Array.isArray(currentPlan.legs) && currentPlan.legs.length) {
    const legs = currentPlan.legs;
    const chains = Array.from(new Set(legs.map((l) => l.chainName || l.chain).filter(Boolean)));
    const assetCount = legs.reduce(
      (sum, l) => sum + safeInt(l.defiExits) + safeInt(l.swaps) + safeInt(l.burns),
      0
    );
    const netUsd = safeNum(currentPlan.totals?.estimatedNetSolanaUsdc);
    const pref = getActiveBridgePreference();
    return {
      assetCount: Math.max(1, assetCount),
      chainCount: Math.max(1, chains.length),
      chainNames: chains,
      netUsd,
      outputAsset: outputAsset || 'USDC',
      providerLabel: pref === 'auto' ? 'Best Route' : normalizeBridgeProviderLabel(pref),
      solanaDestination: getVerifiedSolanaDestination() || getConnectedSolanaAddress() || '',
      timestamp: Date.now(),
      isPreview: true,
    };
  }

  return {
    assetCount: 0,
    chainCount: 0,
    chainNames: [],
    netUsd: 0,
    outputAsset: outputAsset || 'USDC',
    providerLabel: 'Multi-Bridge',
    solanaDestination: getVerifiedSolanaDestination() || getConnectedSolanaAddress() || '',
    timestamp: Date.now(),
    isPreview: true,
  };
}

function formatReceiptSummaryText(data, includeTruncatedAddr = false) {
  const assets = safeInt(data?.assetCount);
  const chains = safeInt(data?.chainCount);
  const usdStr = safeNum(data?.netUsd).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const assetWord = assets === 1 ? 'asset' : 'assets';
  const chainWord = chains === 1 ? 'chain' : 'chains';
  const out = data?.outputAsset === 'SOL' ? 'SOL' : 'USDC';
  let text = `Swept ${assets} ${assetWord} across ${chains} ${chainWord} → +$${usdStr} ${out} on Solana · 0% protocol fee · MIT Open Source`;
  if (includeTruncatedAddr && data?.solanaDestination) {
    text += ` · ${shortAddr(data.solanaDestination)}`;
  }
  return text;
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function drawReceiptCardCanvas(canvas, data, includeTruncatedAddr = false) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = 1200;
  const H = 630;
  canvas.width = W;
  canvas.height = H;

  // 1. Daylight Porcelain canvas backdrop (#FCFCFC -> subtle cool tint)
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#FCFCFC');
  bgGrad.addColorStop(1, '#F3F6F9');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Soft Kamino ice-cyan ambient glow top-right
  const glow = ctx.createRadialGradient(W - 140, 80, 10, W - 140, 80, 420);
  glow.addColorStop(0, 'rgba(198, 244, 255, 0.55)');
  glow.addColorStop(1, 'rgba(198, 244, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Subtle architectural hairline grid
  ctx.strokeStyle = 'rgba(10, 10, 10, 0.03)';
  ctx.lineWidth = 1;
  for (let gx = 48; gx < W; gx += 72) {
    ctx.beginPath();
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, H);
    ctx.stroke();
  }
  for (let gy = 48; gy < H; gy += 72) {
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.lineTo(W, gy);
    ctx.stroke();
  }

  // 2. Main Porcelain Surface Card (#FFFFFF)
  const cardX = 48;
  const cardY = 44;
  const cardW = W - 96;
  const cardH = H - 88;
  ctx.save();
  ctx.shadowColor = 'rgba(10, 10, 10, 0.06)';
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 12;
  drawRoundedRectPath(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.restore();

  drawRoundedRectPath(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.strokeStyle = '#E4E6EB';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Top ice-cyan accent bar clipped cleanly inside card
  ctx.save();
  drawRoundedRectPath(ctx, cardX, cardY, cardW, cardH, 28);
  ctx.clip();
  const topBarGrad = ctx.createLinearGradient(cardX, cardY, cardX + cardW, cardY);
  topBarGrad.addColorStop(0, '#0A0A0A');
  topBarGrad.addColorStop(0.55, '#C6F4FF');
  topBarGrad.addColorStop(1, '#7DD3FC');
  ctx.fillStyle = topBarGrad;
  ctx.fillRect(cardX, cardY, cardW, 7);
  ctx.restore();

  // 3. Header row: Turgalium Vector Logo + Wordmark + Status Pill + Date
  const padX = cardX + 48;
  const headY = cardY + 46;

  // Draw crisp Turgalium vector mark (#0A0A0A tile + #C6F4FF prism)
  drawRoundedRectPath(ctx, padX, headY, 44, 44, 11);
  ctx.fillStyle = '#0A0A0A';
  ctx.fill();

  const scale = 44 / 32;
  ctx.save();
  ctx.translate(padX, headY);
  ctx.scale(scale, scale);
  ctx.beginPath();
  ctx.moveTo(7, 9);
  ctx.lineTo(25, 9);
  ctx.lineTo(18.5, 16.5);
  ctx.lineTo(22, 23);
  ctx.lineTo(10, 23);
  ctx.lineTo(13.5, 16.5);
  ctx.closePath();
  ctx.fillStyle = '#C6F4FF';
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#0A0A0A';
  ctx.font = '800 28px "Plus Jakarta Sans", "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('Turgalium', padX + 58, headY + 23);

  // Mode pill next to wordmark
  const pillLabel = data.isPreview ? 'SWEEP PREVIEW' : 'SWEEP RECEIPT';
  ctx.font = '700 13px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
  const pillW = ctx.measureText(pillLabel).width + 28;
  drawRoundedRectPath(ctx, padX + 216, headY + 8, pillW, 28, 999);
  ctx.fillStyle = '#E8FAFF';
  ctx.fill();
  ctx.strokeStyle = '#7DD3FC';
  ctx.lineWidth = 1.25;
  ctx.stroke();
  ctx.fillStyle = '#0369A1';
  ctx.fillText(pillLabel, padX + 230, headY + 22);

  // Right-side MIT Open Source badge + UTC Date
  const dateObj = new Date(safeNum(data.timestamp) || Date.now());
  const dateLabel = dateObj.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  ctx.font = '600 15px "JetBrains Mono", ui-monospace, monospace';
  ctx.fillStyle = '#52525B';
  ctx.textAlign = 'right';
  ctx.fillText(`${dateLabel} · MIT OPEN SOURCE`, cardX + cardW - 48, headY + 23);
  ctx.textAlign = 'left';

  // 4. Center Hero Statement
  const assets = safeInt(data.assetCount);
  const chains = safeInt(data.chainCount);
  const usdFormatted = safeNum(data.netUsd).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const outSymbol = data.outputAsset === 'SOL' ? 'SOL' : 'USDC';
  const assetWord = assets === 1 ? 'asset' : 'assets';
  const chainWord = chains === 1 ? 'chain' : 'chains';

  const heroLine1 = `Swept ${assets} ${assetWord} across ${chains} ${chainWord}`;
  const heroLine2 = `→ +$${usdFormatted} ${outSymbol} on Solana`;

  ctx.fillStyle = '#0A0A0A';
  ctx.font = '700 40px "Plus Jakarta Sans", "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(heroLine1, padX, headY + 114);

  // Highlighted arrival row with Kamino ice-cyan pill backdrop
  ctx.font = '800 54px "Plus Jakarta Sans", "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
  const hero2Width = Math.min(cardW - 96, ctx.measureText(heroLine2).width + 36);
  drawRoundedRectPath(ctx, padX - 8, headY + 148, hero2Width, 74, 16);
  ctx.fillStyle = '#C6F4FF';
  ctx.fill();
  ctx.fillStyle = '#0A0A0A';
  ctx.fillText(heroLine2, padX + 10, headY + 187, cardW - 116);

  ctx.fillStyle = '#52525B';
  ctx.font = '500 20px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('0% protocol fee · Non-custodial · Direct to Solana', padX, headY + 252);

  // 5. Four Porcelain Metric Wells
  const wellY = cardY + 344;
  const wellH = 114;
  const gap = 18;
  const wellW = (cardW - 96 - gap * 3) / 4;
  const chainSubtitle =
    data.chainNames && data.chainNames.length
      ? data.chainNames.slice(0, 3).join(', ') +
        (data.chainNames.length > 3 ? ` +${data.chainNames.length - 3}` : '')
      : '30 chains supported';

  const metrics = [
    {
      label: 'ASSETS SWEPT',
      value: `${assets} ${assetWord}`,
      sub: 'Consolidated in 1 pass',
      accent: '#0A0A0A',
    },
    {
      label: 'SOURCE NETWORKS',
      value: `${chains} ${chainWord}`,
      sub: chainSubtitle,
      accent: '#0A0A0A',
    },
    {
      label: 'PROTOCOL FEE',
      value: '0% ($0.00)',
      sub: 'MIT Open Source',
      accent: '#059669',
    },
    {
      label: 'BRIDGE ROUTE',
      value: data.providerLabel || 'Auto Route',
      sub: `Settled as ${outSymbol}`,
      accent: '#0369A1',
    },
  ];

  metrics.forEach((m, i) => {
    const x = padX + i * (wellW + gap);
    drawRoundedRectPath(ctx, x, wellY, wellW, wellH, 16);
    ctx.fillStyle = '#F4F5F7';
    ctx.fill();
    ctx.strokeStyle = '#E4E6EB';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#71717A';
    ctx.font = '700 12px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(m.label, x + 18, wellY + 28);

    ctx.fillStyle = m.accent;
    ctx.font = '800 24px "Plus Jakarta Sans", "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(m.value, x + 18, wellY + 62, wellW - 36);

    ctx.fillStyle = '#52525B';
    ctx.font = '500 13.5px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(m.sub, x + 18, wellY + 91, wellW - 36);
  });

  // 6. Footer hairline + privacy-safe address line
  const footY = cardY + cardH - 42;
  ctx.strokeStyle = '#E4E6EB';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padX, footY - 26);
  ctx.lineTo(cardX + cardW - 48, footY - 26);
  ctx.stroke();

  ctx.fillStyle = '#52525B';
  ctx.font = '600 15px "JetBrains Mono", ui-monospace, monospace';
  const leftFoot =
    includeTruncatedAddr && data.solanaDestination
      ? `turgalium · Solana ${shortAddr(data.solanaDestination)}`
      : 'turgalium · Privacy-safe receipt (0 wallet addresses exposed)';
  ctx.fillText(leftFoot, padX, footY);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#0A0A0A';
  ctx.font = '700 15px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('0% Protocol Fee · MIT Open Source', cardX + cardW - 48, footY);
  ctx.textAlign = 'left';
}

function renderActiveReceiptCard() {
  if (!activeReceiptData) return;
  const includeToggle = document.getElementById('receiptIncludeAddrToggle');
  const privacyStatus = document.getElementById('receiptPrivacyStatus');
  const summaryBox = document.getElementById('receiptSummaryPreview');
  const canvas = document.getElementById('receiptCardCanvas');

  const canIncludeAddr = Boolean(activeReceiptData.solanaDestination);
  if (includeToggle) {
    includeToggle.disabled = !canIncludeAddr;
    if (!canIncludeAddr) includeToggle.checked = false;
  }
  const includeTruncated = Boolean(includeToggle?.checked && canIncludeAddr);

  if (privacyStatus) {
    privacyStatus.textContent = includeTruncated
      ? `Showing truncated Solana destination (${shortAddr(activeReceiptData.solanaDestination)})`
      : 'No wallet addresses included';
  }

  const summary = formatReceiptSummaryText(activeReceiptData, includeTruncated);
  if (summaryBox) {
    summaryBox.textContent = summary;
  }
  drawReceiptCardCanvas(canvas, activeReceiptData, includeTruncated);
}

function openReceiptModal(source = null) {
  const backdrop = document.getElementById('receiptModalBackdrop');
  if (!backdrop) return;
  activeReceiptData = buildReceiptData(source);
  const includeToggle = document.getElementById('receiptIncludeAddrToggle');
  if (includeToggle) includeToggle.checked = false; // Privacy-safe default!
  const sub = document.getElementById('receiptModalSub');
  if (sub) {
    sub.textContent = activeReceiptData.isPreview
      ? 'Preview of your active sweep plan — wallet addresses hidden by default.'
      : 'Privacy-safe porcelain card — wallet addresses hidden by default.';
  }
  renderActiveReceiptCard();
  backdrop.classList.remove('hidden');
}

function closeReceiptModal() {
  document.getElementById('receiptModalBackdrop')?.classList.add('hidden');
}

function downloadReceiptPng() {
  const canvas = document.getElementById('receiptCardCanvas');
  if (!canvas) return;
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `turgalium-sweep-receipt-${stamp}.png`;
  const triggerUrl = (url, revoke = false) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast('Downloaded sweep receipt PNG.');
  };

  if (typeof canvas.toBlob === 'function') {
    canvas.toBlob((blob) => {
      if (blob) {
        triggerUrl(URL.createObjectURL(blob), true);
      } else {
        triggerUrl(canvas.toDataURL('image/png'), false);
      }
    }, 'image/png');
  } else {
    triggerUrl(canvas.toDataURL('image/png'), false);
  }
}

async function copyReceiptSummary() {
  if (!activeReceiptData) return;
  const includeTruncated = Boolean(document.getElementById('receiptIncludeAddrToggle')?.checked);
  const summary = formatReceiptSummaryText(activeReceiptData, includeTruncated);
  try {
    await navigator.clipboard?.writeText(summary);
    showToast('Copied sweep receipt summary.');
  } catch {
    showToast('Could not copy summary to clipboard.');
  }
}

function shareReceiptOnX() {
  if (!activeReceiptData) return;
  const includeTruncated = Boolean(document.getElementById('receiptIncludeAddrToggle')?.checked);
  const summary = formatReceiptSummaryText(activeReceiptData, includeTruncated);
  const intentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(summary)}`;
  window.open(intentUrl, '_blank', 'noopener,noreferrer');
}

// =====================================================================
// PWA SERVICE WORKER REGISTRATION (HTTPS or localhost only, silent fail)
// =====================================================================
function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  const proto = window.location?.protocol || '';
  const host = window.location?.hostname || '';
  const isSecureOrLocal =
    proto === 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (!isSecureOrLocal) return;

  const registerNow = () => {
    try {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    } catch {
      // ignore service worker registration errors
    }
  };

  if (document.readyState === 'complete') {
    registerNow();
  } else {
    window.addEventListener('load', registerNow, { once: true });
  }
}

// =====================================================================
// WAVE 21: ZERO-KEY AI LAUNCHPAD & NON-CUSTODIAL REVIEW-LINK HANDOFF
// =====================================================================
function getTurgaliumPublicOrigin() {
  const origin = typeof window !== 'undefined' ? window.location?.origin || '' : '';
  return origin && origin !== 'null' ? origin.replace(/\/$/, '') : 'https://turgalium.vercel.app';
}

function buildZeroKeyAgentPrompt() {
  const origin = getTurgaliumPublicOrigin();
  const walletVal = document.getElementById('aiWalletInput')?.value.trim() || '<MY_PUBLIC_WALLET_ADDRESS>';
  const solDestVal = document.getElementById('aiSolDestInput')?.value.trim() || '';
  const destClause = solDestVal
    ? `Target Solana destination: ${solDestVal} (receive ${zeroKeyAiOutput}).`
    : `Receive ${zeroKeyAiOutput} on Solana.`;
  const toolHint =
    zeroKeyAiAgent === 'Claude' || zeroKeyAiAgent === 'Cursor / OpenClaw'
      ? `Connect via Turgalium MCP (${origin}/mcp or \`npx turgalium-mcp\`) or REST API (${origin}/openapi.json).`
      : `Use Turgalium's public OpenAPI (${origin}/openapi.json) or live endpoints at ${origin}.`;

  return [
    `Use Turgalium (0% protocol fee, MIT open-source) to audit my public wallet across 30 chains and prepare a sweep to Solana.`,
    toolHint,
    `Public source wallet: ${walletVal}`,
    destClause,
    `Steps:`,
    `1. Scan & hydrate my public address via POST /api/workspace/hydrate (or turgalium_scan_wallets) to identify DeFi deposits, liquid tokens, profitable dust, and traps to skip.`,
    `2. Summarize the highest-net bridge route and any free Solana ATA rent or SPL dust I can reclaim.`,
    `3. Call POST /api/agent/review-link (or turgalium_build_review_link) and return the clickable Turgalium Review & Sign Link so I can inspect and sign locally in my own wallet.`,
    `Security rule: NEVER ask me for a private key, seed phrase, or wallet signature.`,
  ].join('\n');
}

function buildLocalZeroKeyReviewUrl() {
  const origin = getTurgaliumPublicOrigin();
  const walletVal = document.getElementById('aiWalletInput')?.value.trim() || '';
  const solDestVal = document.getElementById('aiSolDestInput')?.value.trim() || '';
  const u = new URL('/', origin);
  u.searchParams.set('view', 'scanner');
  if (walletVal) {
    const fam = detectAddressFamily(walletVal);
    if (fam) u.searchParams.set('family', fam);
    u.searchParams.set('wallet', walletVal);
  }
  if (solDestVal && isValidSolanaBase58(solDestVal)) {
    u.searchParams.set('dest', solDestVal);
  }
  if (zeroKeyAiOutput === 'SOL') {
    u.searchParams.set('output', 'SOL');
  }
  u.searchParams.set('agent', zeroKeyAiAgent);
  return u.toString();
}

function renderZeroKeyAiPrompt() {
  const origin = getTurgaliumPublicOrigin();
  const openApiEl = document.getElementById('aiOpenApiUrl');
  const mcpUrlEl = document.getElementById('aiMcpUrl');
  const reviewApiEl = document.getElementById('aiReviewApiUrl');
  if (openApiEl) openApiEl.textContent = `${origin}/openapi.json`;
  if (mcpUrlEl) mcpUrlEl.textContent = `${origin}/mcp`;
  if (reviewApiEl) reviewApiEl.textContent = `POST ${origin}/api/agent/review-link`;

  const prompt = buildZeroKeyAgentPrompt();
  const box = document.getElementById('aiPromptPreview');
  if (box) box.textContent = prompt;

  const gptBtn = document.getElementById('openChatGptBtn');
  if (gptBtn) {
    gptBtn.href = `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`;
  }
  const claudeBtn = document.getElementById('openClaudeBtn');
  if (claudeBtn) {
    claudeBtn.href = `https://claude.ai/new?q=${encodeURIComponent(prompt)}`;
  }
}

function syncZeroKeyAiFromAppState() {
  const walletIn = document.getElementById('aiWalletInput');
  const solIn = document.getElementById('aiSolDestInput');
  if (walletIn && !walletIn.value.trim()) {
    const candidate =
      getActiveSourceWallet()?.address ||
      currentScan?.walletAddress ||
      document.getElementById('appEvmInput')?.value.trim() ||
      document.getElementById('heroWalletInput')?.value.trim() ||
      '';
    if (candidate) walletIn.value = candidate;
  }
  if (solIn && !solIn.value.trim()) {
    const solCandidate =
      getConnectedSolanaAddress() ||
      document.getElementById('solanaDestInput')?.value.trim() ||
      '';
    if (solCandidate) solIn.value = solCandidate;
  }
  renderZeroKeyAiPrompt();
}

function initZeroKeyAiLaunchpad() {
  if (zeroKeyAiInitialized) return;
  zeroKeyAiInitialized = true;

  document.querySelectorAll('.ai-agent-chip[data-ai-agent]').forEach((btn) => {
    btn.addEventListener('click', () => {
      zeroKeyAiAgent = btn.dataset.aiAgent || 'ChatGPT';
      document.querySelectorAll('.ai-agent-chip[data-ai-agent]').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      renderZeroKeyAiPrompt();
    });
  });

  document.querySelectorAll('.ai-out-btn[data-ai-output]').forEach((btn) => {
    btn.addEventListener('click', () => {
      zeroKeyAiOutput = btn.dataset.aiOutput === 'SOL' ? 'SOL' : 'USDC';
      document.querySelectorAll('.ai-out-btn[data-ai-output]').forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
      renderZeroKeyAiPrompt();
    });
  });

  document.getElementById('aiWalletInput')?.addEventListener('input', renderZeroKeyAiPrompt);
  document.getElementById('aiSolDestInput')?.addEventListener('input', renderZeroKeyAiPrompt);

  document.getElementById('copyAiPromptBtn')?.addEventListener('click', async () => {
    const prompt = buildZeroKeyAgentPrompt();
    await navigator.clipboard?.writeText(prompt).catch(() => {});
    showToast(`Copied zero-key ${zeroKeyAiAgent} prompt.`);
  });

  document.getElementById('copyAiReviewLinkBtn')?.addEventListener('click', async () => {
    const walletVal = document.getElementById('aiWalletInput')?.value.trim() || '';
    if (!walletVal) {
      showToast('Enter a public wallet address first to generate a Review & Sign Link.');
      document.getElementById('aiWalletInput')?.focus();
      return;
    }
    const solDestVal = document.getElementById('aiSolDestInput')?.value.trim() || '';
    try {
      const res = await api('/api/agent/review-link', {
        method: 'POST',
        body: JSON.stringify({
          wallet: walletVal,
          solanaDestination: solDestVal || undefined,
          outputAsset: zeroKeyAiOutput,
          agentName: zeroKeyAiAgent,
        }),
      });
      const url = res?.reviewUrl || buildLocalZeroKeyReviewUrl();
      await navigator.clipboard?.writeText(url).catch(() => {});
      showToast('Copied non-custodial Review & Sign Link.');
    } catch (err) {
      showToast(err?.message || 'Enter a valid public wallet address.');
    }
  });

  document.querySelectorAll('[data-copy-el]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const targetId = btn.dataset.copyEl;
      const text = document.getElementById(targetId)?.textContent?.trim() || '';
      if (!text) return;
      await navigator.clipboard?.writeText(text).catch(() => {});
      showToast('Copied to clipboard.');
    });
  });

  renderZeroKeyAiPrompt();
}

function renderAgentHandoffBanner({ agentName, wallet, note }) {
  const host = document.getElementById('agentHandoffBanner');
  if (!host) return;
  const safeAgent = escapeHtml(agentName || 'AI Agent');
  const safeWallet = escapeHtml(shortAddr(wallet || ''));
  const safeNote = note ? escapeHtml(note) : 'Review scanned assets & sign locally in your own wallet — zero private keys shared.';
  host.innerHTML = `
    <div class="agent-handoff-main">
      <span class="agent-handoff-pill">Prepared via ${safeAgent}</span>
      <div class="agent-handoff-copy">
        <strong>Non-custodial review for ${safeWallet}</strong>
        <span>${safeNote}</span>
      </div>
    </div>
    <button type="button" class="btn-outline-sm" id="dismissAgentHandoffBtn">Dismiss</button>
  `;
  host.classList.remove('hidden');
  document.getElementById('dismissAgentHandoffBtn')?.addEventListener('click', () => {
    host.classList.add('hidden');
  });
}

function hydrateFromReviewLink() {
  if (typeof window === 'undefined' || !window.location?.search) return;
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return;
  }
  const viewParam = (params.get('view') || '').trim().toLowerCase();
  const rawWallet = (params.get('wallet') || '').trim();
  const rawFamily = (params.get('family') || '').trim().toLowerCase();
  const rawDest = (params.get('dest') || '').trim();
  const rawOutput = (params.get('output') || '').trim().toUpperCase();
  const rawAgent = (params.get('agent') || '').trim().slice(0, 40);
  const rawNote = (params.get('note') || '').trim().slice(0, 160);

  if (viewParam === 'ai') {
    if (rawWallet) {
      const aiW = document.getElementById('aiWalletInput');
      if (aiW) aiW.value = rawWallet;
    }
    if (rawDest && isValidSolanaBase58(rawDest)) {
      const aiD = document.getElementById('aiSolDestInput');
      if (aiD) aiD.value = rawDest;
    }
    openApp('ai');
    renderZeroKeyAiPrompt();
    return;
  }

  if (!rawWallet) return;
  const detectedFam = detectAddressFamily(rawWallet, rawFamily || undefined);
  if (!detectedFam) return;

  if (rawOutput === 'SOL' || rawOutput === 'USDC') {
    outputAsset = rawOutput;
    document.querySelectorAll('.out-btn[data-output]').forEach((b) => {
      b.classList.toggle('active', b.dataset.output === outputAsset);
    });
  }
  if (rawDest && isValidSolanaBase58(rawDest)) {
    const destInput = document.getElementById('solanaDestInput');
    if (destInput) destInput.value = rawDest;
    syncDestinationUiState();
  }

  activeFamily = detectedFam;
  updateFamilyChrome();
  openApp('scanner');
  renderAgentHandoffBanner({
    agentName: rawAgent || 'AI Agent',
    wallet: rawWallet,
    note: rawNote,
  });
  runScan({ address: rawWallet, family: detectedFam, autoOpen: true });
}
