/**
 * Turgalium Capital-Preservation & Post-Arrival Solana Tools Module:
 *  1. 1-Click Reclaim Free SOL (Empty-ATA Rent Vacuum) -> POST /api/solana/rent-scan
 *  2. 1-Click Sweep Solana SPL Dust (Swap to USDC/SOL + Atomic CloseAccount Rent Reclaim) -> POST /api/solana/dust-scan + /api/solana/dust-sweep
 *  3. 1-Click Post-Arrival Solana Yield Park (100% Principal-Safe) -> GET /api/solana/yield-strategies + POST /api/solana/yield-park
 *  4. 1-Click Stale ERC-20 Approval Revoker -> POST /api/approvals/scan + EIP-5792 / sequential revoke
 *
 * Security: Zero `innerHTML` with untrusted API strings — all dynamic values rendered strictly via `textContent`.
 */

import {
  getConnectedEvmAddress,
  getConnectedSolanaAddress,
  isUserRejectedError,
  isValidSolanaBase58,
  sendEvmRevokeCalls,
  signAndSendSolanaVersionedTx,
} from './wallets.js?v=12';

const SUPPORTED_APPROVAL_CHAINS = [
  { id: 'ethereum', label: 'Ethereum', explorer: 'https://etherscan.io/tx/' },
  { id: 'base', label: 'Base', explorer: 'https://basescan.org/tx/' },
  { id: 'arbitrum', label: 'Arbitrum', explorer: 'https://arbiscan.io/tx/' },
  { id: 'optimism', label: 'Optimism', explorer: 'https://optimistic.etherscan.io/tx/' },
  { id: 'polygon', label: 'Polygon', explorer: 'https://polygonscan.com/tx/' },
  { id: 'avalanche', label: 'Avalanche', explorer: 'https://snowtrace.io/tx/' },
  { id: 'bnb', label: 'BNB Chain', explorer: 'https://bscscan.com/tx/' },
  { id: 'sonic', label: 'Sonic', explorer: 'https://sonicscan.org/tx/' },
  { id: 'unichain', label: 'Unichain', explorer: 'https://uniscan.xyz/tx/' },
  { id: 'linea', label: 'Linea', explorer: 'https://lineascan.build/tx/' },
  { id: 'scroll', label: 'Scroll', explorer: 'https://scrollscan.com/tx/' },
  { id: 'mantle', label: 'Mantle', explorer: 'https://mantlescan.xyz/tx/' },
  { id: 'blast', label: 'Blast', explorer: 'https://blastscan.io/tx/' },
  { id: 'worldchain', label: 'World Chain', explorer: 'https://worldscan.org/tx/' },
  { id: 'hyperevm', label: 'HyperEVM', explorer: 'https://hyperevmscan.io/tx/' },
  { id: 'berachain', label: 'Berachain', explorer: 'https://berascan.com/tx/' },
  { id: 'zksync', label: 'zkSync Era', explorer: 'https://explorer.zksync.io/tx/' },
  { id: 'ink', label: 'Ink', explorer: 'https://explorer.inkonchain.com/tx/' },
  { id: 'gnosis', label: 'Gnosis', explorer: 'https://gnosisscan.io/tx/' },
  { id: 'monad', label: 'Monad', explorer: 'https://monadvision.com/tx/' },
];

const SOLSCAN_ALLOWED_HOSTS = ['solscan.io'];
const YIELD_VAULT_ALLOWED_HOSTS = [
  'jup.ag',
  'app.kamino.finance',
  'kamino.finance',
  'marinade.finance',
  'app.marinade.finance',
];
const EVM_EXPLORER_ALLOWED_HOSTS = [
  'etherscan.io',
  'basescan.org',
  'arbiscan.io',
  'optimistic.etherscan.io',
  'polygonscan.com',
  'snowtrace.io',
  'bscscan.com',
  'sonicscan.org',
  'uniscan.xyz',
  'lineascan.build',
  'scrollscan.com',
  'mantlescan.xyz',
  'blastscan.io',
  'worldscan.org',
  'hyperevmscan.io',
  'berascan.com',
  'explorer.zksync.io',
  'explorer.inkonchain.com',
  'gnosisscan.io',
  'monadvision.com',
  'monadscan.com',
];

const state = {
  // Rent Vacuum
  rentScan: null,
  rentLoading: false,
  rentError: null,
  rentSigning: false,
  rentLastTx: null, // { signature, explorerUrl, count, reclaimedSol }
  rentSeq: 0,
  userEditedRentOwner: false,

  // Yield Park (100% principal-safe)
  strategies: [],
  strategiesLoaded: false,
  selectedStrategyId: 'jupsol',
  yieldAmountUsdc: 100,
  userEditedYieldAmount: false,
  yieldPlan: null,
  yieldLoading: false,
  yieldError: null,
  yieldSigning: false,
  yieldLastTx: null, // { signature, explorerUrl, strategyName, yieldUsdc }
  yieldSeq: 0,

  // Stale Approval Revoker
  selectedApprovalChain: 'ethereum',
  approvalScan: null,
  approvalLoading: false,
  approvalError: null,
  revokingKey: null, // 'all' | findingKey
  revokedKeys: new Set(),
  approvalLastResult: null, // { mode, count, txHashes, batchId }
  approvalSeq: 0,

  // Solana SPL Dust Sweeper
  dustTargetAsset: 'usdc', // 'usdc' | 'sol'
  dustMaxUsd: 50,
  dustScan: null,
  dustLoading: false,
  dustError: null,
  dustSweepingKey: null, // 'all' | tokenAccount
  sweptDustAccounts: new Set(),
  dustLastResult: null, // { count, targetSymbol, outputUi, reclaimedSol, signatures, explorerUrl }
  dustSeq: 0,

  // Shared context from app.js events
  latestScanReport: null,
  balanceDetail: null,
};

function isValidEvmAddr(addr) {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

function shortAddr(addr) {
  const s = String(addr || '').trim();
  if (s.length <= 12) return s || '—';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function fmtUsd(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '$0.00';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtSol(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '0.00000000';
  return n.toFixed(n > 0 && n < 0.01 ? 8 : 5);
}

function hostMatchesAllowlist(hostname, allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return true;
  const host = String(hostname || '').toLowerCase();
  return allowedHosts.some((rawAllowed) => {
    const allowed = String(rawAllowed || '').toLowerCase().replace(/^\*\./, '');
    return Boolean(allowed) && (host === allowed || host.endsWith(`.${allowed}`));
  });
}

function safeHttpsUrl(raw, allowedHosts = null) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      return null;
    }
    if (allowedHosts && !hostMatchesAllowlist(parsed.hostname, allowedHosts)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function showToast(msg) {
  const host = document.getElementById('toastRegion');
  if (!host) return;
  const toast = el('div', 'toast-msg', String(msg ?? ''));
  host.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 180ms ease';
    setTimeout(() => toast.remove(), 200);
  }, 3400);
}

async function apiJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  }
  return data;
}

function resolveRentOwnerAddress() {
  const customVal = document.getElementById('rentOwnerInput')?.value?.trim() || '';
  if (customVal) {
    return isValidSolanaBase58(customVal) ? customVal : '';
  }
  const connected = getConnectedSolanaAddress();
  if (connected && isValidSolanaBase58(connected)) return connected;
  const destVal = document.getElementById('solanaDestInput')?.value?.trim() || '';
  if (isValidSolanaBase58(destVal)) return destVal;
  return '';
}

function resolveSolanaAddress() {
  const connected = getConnectedSolanaAddress();
  if (connected && isValidSolanaBase58(connected)) return connected;
  const destVal = document.getElementById('solanaDestInput')?.value?.trim() || '';
  if (isValidSolanaBase58(destVal)) return destVal;
  const customVal = document.getElementById('rentOwnerInput')?.value?.trim() || '';
  if (isValidSolanaBase58(customVal)) return customVal;
  return '';
}

function resolveEvmAddress() {
  const connected = getConnectedEvmAddress();
  if (connected && isValidEvmAddr(connected)) return connected;
  const inputVal = document.getElementById('appEvmInput')?.value?.trim() || '';
  if (isValidEvmAddr(inputVal)) return inputVal;
  const scanAddr = state.latestScanReport?.walletAddress;
  if (isValidEvmAddr(scanAddr)) return scanAddr;
  return '';
}

function findingKey(f) {
  return `${String(f.chain || '')}:${String(f.token || '').toLowerCase()}:${String(f.spender || '').toLowerCase()}`;
}

function getChainExplorerPrefix(chainIdOrSlug) {
  const entry = SUPPORTED_APPROVAL_CHAINS.find((c) => c.id === chainIdOrSlug);
  return entry ? entry.explorer : 'https://etherscan.io/tx/';
}

function updateSectionSummaryBadges() {
  const rentBadge = document.getElementById('toolsSummaryRentBadge');
  if (rentBadge) {
    if (state.rentScan && Number(state.rentScan.reclaimableCount) > 0) {
      rentBadge.textContent = `${state.rentScan.reclaimableCount} Empty ATAs · ${fmtSol(state.rentScan.reclaimableSol)} SOL`;
      rentBadge.classList.add('is-active');
    } else {
      rentBadge.textContent = 'Rent Vacuum';
      rentBadge.classList.remove('is-active');
    }
  }

  const yieldBadge = document.getElementById('toolsSummaryYieldBadge');
  if (yieldBadge) {
    const activeStrat =
      state.strategies.find((s) => s.id === state.selectedStrategyId) || state.strategies[0];
    const apy = state.yieldPlan?.apy?.estimatedApyPct ?? activeStrat?.baselineApyPct;
    if (Number.isFinite(Number(apy))) {
      yieldBadge.textContent = `100% Safe Yield · ~${Number(apy).toFixed(1)}% APY`;
      yieldBadge.classList.add('is-active');
    } else {
      yieldBadge.textContent = 'Earn on Solana';
      yieldBadge.classList.remove('is-active');
    }
  }

  const apprBadge = document.getElementById('toolsSummaryApprovalsBadge');
  if (apprBadge) {
    if (state.approvalScan) {
      const remaining = (state.approvalScan.findings || []).filter(
        (f) => !state.revokedKeys.has(findingKey(f))
      ).length;
      apprBadge.textContent =
        remaining > 0 ? `${remaining} Active Approvals` : '0 Stale Approvals';
      apprBadge.classList.toggle('is-warn', remaining > 0);
      apprBadge.classList.toggle('is-active', remaining === 0);
    } else {
      apprBadge.textContent = 'Approval Hygiene';
      apprBadge.classList.remove('is-warn', 'is-active');
    }
  }

  const dustBadge = document.getElementById('toolsSummaryDustBadge');
  if (dustBadge) {
    if (state.dustScan) {
      const remaining = (state.dustScan.dustAccounts || []).filter(
        (a) => !state.sweptDustAccounts.has(a.tokenAccount)
      );
      if (remaining.length > 0) {
        dustBadge.textContent = `${remaining.length} SPL Dust · +${fmtSol(remaining.reduce((s, a) => s + (Number(a.rentSol) || 0.00203928), 0))} SOL`;
        dustBadge.classList.add('is-active');
      } else {
        dustBadge.textContent = '0 SPL Dust';
        dustBadge.classList.add('is-active');
      }
    } else {
      dustBadge.textContent = 'SPL Dust Sweep';
      dustBadge.classList.remove('is-active');
    }
  }
}

// =========================================================================
// 1. EMPTY-ATA RENT VACUUM (1-CLICK RECLAIM FREE SOL)
// =========================================================================

async function runSolanaRentScan({ silent = false, forceOwnerAddress = null } = {}) {
  const customRaw = document.getElementById('rentOwnerInput')?.value?.trim() || '';
  const ownerAddress = forceOwnerAddress || resolveRentOwnerAddress();
  if (!ownerAddress) {
    if (!silent) {
      state.rentError = customRaw
        ? 'Enter a valid Base58 Solana address to scan empty ATAs.'
        : 'Connect a Solana wallet or enter a Solana address to scan empty ATAs.';
      renderRentVacuumCard();
      document.getElementById('rentOwnerInput')?.focus();
    }
    return;
  }

  const seq = ++state.rentSeq;
  state.rentLoading = true;
  state.rentError = null;
  renderRentVacuumCard();

  try {
    const data = await apiJson('/api/solana/rent-scan', {
      method: 'POST',
      body: JSON.stringify({
        ownerAddress,
        includeUnsignedTx: true,
      }),
    });
    if (seq !== state.rentSeq) return;
    state.rentScan = data;
    state.rentLastTx = null;
  } catch (err) {
    if (seq !== state.rentSeq) return;
    if (!silent) {
      state.rentError = err instanceof Error ? err.message : 'Failed to scan Solana rent.';
    }
  } finally {
    if (seq === state.rentSeq) {
      state.rentLoading = false;
      renderRentVacuumCard();
      updateSectionSummaryBadges();
    }
  }
}

async function handleReclaimSolClick() {
  const connectedSol = getConnectedSolanaAddress();
  if (!connectedSol) {
    showToast('Connect your Solana wallet (Phantom, Backpack, or Solflare) to reclaim SOL rent.');
    document.getElementById('connectSolBtn')?.click();
    return;
  }

  // Ensure we have an unsigned tx for the connected wallet
  let scan = state.rentScan;
  const txBase64 =
    scan?.unsignedCloseTx?.serializedTransactionBase64 ||
    scan?.unsignedTxBase64 ||
    (Array.isArray(scan?.transactions) ? scan.transactions[0] : null);

  if (!scan || scan.ownerAddress !== connectedSol || !txBase64) {
    await runSolanaRentScan({ silent: false, forceOwnerAddress: connectedSol });
    scan = state.rentScan;
  }

  const finalTxBase64 =
    scan?.unsignedCloseTx?.serializedTransactionBase64 ||
    scan?.unsignedTxBase64 ||
    (Array.isArray(scan?.transactions) ? scan.transactions[0] : null);

  if (!scan || Number(scan.reclaimableCount) <= 0) {
    showToast('No empty SPL token accounts available to close.');
    return;
  }
  if (!finalTxBase64) {
    state.rentError =
      scan.txBuildWarning ||
      'Unsigned close transaction unavailable (RPC blockhash missing). Retry scan.';
    renderRentVacuumCard();
    return;
  }

  state.rentSigning = true;
  state.rentError = null;
  renderRentVacuumCard();

  try {
    const res = await signAndSendSolanaVersionedTx(finalTxBase64, {
      expectedFeePayer: connectedSol,
      flow: 'rent_reclaim',
      autoConnect: false,
    });
    const closedCount = Number(scan.unsignedCloseTx?.accountCount || scan.reclaimableCount || 0);
    const reclaimedSol = Number(scan.unsignedCloseTx?.reclaimedSol || scan.reclaimableSol || 0);
    // Clear consumed unsignedCloseTx immediately so duplicate clicks cannot resubmit a spent tx
    if (state.rentScan) {
      state.rentScan = {
        ...state.rentScan,
        unsignedCloseTx: null,
        unsignedTxBase64: null,
        transactions: [],
      };
    }
    state.rentLastTx = {
      signature: res.signature,
      explorerUrl: res.explorerUrl,
      walletName: res.walletName,
      count: closedCount,
      reclaimedSol,
    };
    showToast(`Reclaimed ${fmtSol(reclaimedSol)} SOL from ${closedCount} empty token account(s)!`);
  } catch (err) {
    state.rentError = isUserRejectedError(err)
      ? 'Signature rejected in Solana wallet. No accounts were closed.'
      : err instanceof Error
      ? err.message
      : 'Failed to submit Solana rent reclaim transaction.';
  } finally {
    state.rentSigning = false;
    renderRentVacuumCard();
    updateSectionSummaryBadges();
  }
}

function renderRentVacuumCard() {
  const host = document.getElementById('rentVacuumBody');
  const badge = document.getElementById('rentCountBadge');
  const scanBtn = document.getElementById('scanSolanaRentBtn');
  const inputEl = document.getElementById('rentOwnerInput');
  if (!host) return;

  const connectedSol = getConnectedSolanaAddress();
  const activeSol = resolveRentOwnerAddress();
  if (
    inputEl &&
    document.activeElement !== inputEl &&
    !state.userEditedRentOwner &&
    !inputEl.value.trim() &&
    activeSol
  ) {
    inputEl.value = activeSol;
  }
  if (scanBtn) {
    scanBtn.disabled = state.rentLoading || state.rentSigning;
    scanBtn.textContent = state.rentLoading ? 'Scanning…' : 'Scan Empty ATAs';
  }

  const scan = state.rentScan;
  if (badge) {
    badge.textContent = scan
      ? `${Number(scan.reclaimableCount || 0)} empty`
      : '0.00203928 SOL / ATA';
  }

  const frag = document.createDocumentFragment();

  if (state.rentError) {
    frag.appendChild(el('div', 'ptool-alert is-error', state.rentError));
  }

  if (state.rentLastTx) {
    const okBox = el('div', 'ptool-alert is-success');
    okBox.appendChild(
      el(
        'span',
        '',
        `Reclaimed ${fmtSol(state.rentLastTx.reclaimedSol)} SOL (${state.rentLastTx.count} ATAs closed) · `
      )
    );
    const linkHref = safeHttpsUrl(state.rentLastTx.explorerUrl, SOLSCAN_ALLOWED_HOSTS);
    if (linkHref) {
      const a = el('a', 'ptool-link mono', `${shortAddr(state.rentLastTx.signature)} ↗`);
      a.href = linkHref;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      okBox.appendChild(a);
    }
    frag.appendChild(okBox);
  }

  if (!scan) {
    frag.appendChild(
      el(
        'p',
        'ptool-empty',
        activeSol
          ? `Ready to inspect ${shortAddr(activeSol)} for zero-balance SPL & Token-2022 accounts locking 0.00203928 SOL rent each.`
          : 'Connect Solana or enter a base58 Solana address to find zero-balance SPL token accounts locking free SOL rent.'
      )
    );
    host.replaceChildren(frag);
    return;
  }

  const count = Number(scan.reclaimableCount || 0);
  const solTotal = Number(scan.reclaimableSol || 0);
  const usdTotal = Number(scan.reclaimableUsd || 0);
  const perAtaSol = Number(scan.rentPerEmptyAccountSol || 0.00203928);

  const metrics = el('div', 'ptool-kpi-grid');
  const k1 = el('div', 'ptool-kpi');
  k1.appendChild(el('span', 'ptool-kpi-label', 'Empty ATAs'));
  k1.appendChild(el('strong', 'ptool-kpi-val mono', String(count)));
  metrics.appendChild(k1);

  const k2 = el('div', 'ptool-kpi');
  k2.appendChild(el('span', 'ptool-kpi-label', 'Reclaimable SOL'));
  k2.appendChild(el('strong', 'ptool-kpi-val mono is-emerald', `${fmtSol(solTotal)} SOL`));
  metrics.appendChild(k2);

  const k3 = el('div', 'ptool-kpi');
  k3.appendChild(el('span', 'ptool-kpi-label', 'Est. Value'));
  k3.appendChild(el('strong', 'ptool-kpi-val mono', fmtUsd(usdTotal)));
  metrics.appendChild(k3);
  frag.appendChild(metrics);

  frag.appendChild(
    el(
      'div',
      'ptool-meta-line mono',
      `Scanned ${Number(scan.totalTokenAccountsScanned || 0)} accounts · ${perAtaSol.toFixed(8)} SOL / empty ATA · owner-only destination`
    )
  );

  if (count === 0) {
    frag.appendChild(
      el('div', 'ptool-alert is-success', 'Clean wallet — 0 empty SPL token accounts locking rent.')
    );
    host.replaceChildren(frag);
    return;
  }

  if (!connectedSol) {
    frag.appendChild(
      el(
        'div',
        'ptool-alert is-info',
        'Read-only preview — connect Phantom, Backpack, or Solflare to sign the closeAccount batch.'
      )
    );
  }

  const accounts = Array.isArray(scan.reclaimableAccounts) ? scan.reclaimableAccounts : [];
  if (accounts.length > 0) {
    const list = el('div', 'ptool-list');
    const visible = accounts.slice(0, 5);
    for (const acc of visible) {
      const row = el('div', 'ptool-list-row');
      const left = el('div', 'ptool-list-main');
      left.appendChild(el('span', 'ptool-list-primary mono', shortAddr(acc.tokenAccount)));
      left.appendChild(
        el(
          'span',
          'ptool-list-sub mono',
          `Mint ${shortAddr(acc.mint)} · ${acc.programKind === 'token-2022' ? 'Token-2022' : 'SPL'}`
        )
      );
      row.appendChild(left);
      row.appendChild(
        el('span', 'ptool-pill is-emerald mono', `+${Number(acc.rentSol || perAtaSol).toFixed(5)} SOL`)
      );
      list.appendChild(row);
    }
    if (accounts.length > visible.length) {
      list.appendChild(
        el(
          'div',
          'ptool-meta-line mono',
          `+${accounts.length - visible.length} more empty account(s) included in batch`
        )
      );
    }
    frag.appendChild(list);
  }

  const actionBtn = el(
    'button',
    'btn-pill-dark btn-sm ptool-primary-btn',
    state.rentSigning
      ? 'Confirm in Solana Wallet…'
      : connectedSol
      ? `1-Click Reclaim ${fmtSol(solTotal)} SOL`
      : 'Connect Solana to Reclaim SOL'
  );
  actionBtn.type = 'button';
  actionBtn.id = 'reclaimSolBtn';
  actionBtn.disabled = state.rentSigning || state.rentLoading;
  actionBtn.addEventListener('click', handleReclaimSolClick);
  frag.appendChild(actionBtn);

  host.replaceChildren(frag);
}

// =========================================================================
// 2. POST-ARRIVAL SOLANA YIELD PARK (100% PRINCIPAL-SAFE)
// =========================================================================

async function loadSolanaYieldStrategies() {
  if (state.strategiesLoaded) return;
  try {
    const data = await apiJson('/api/solana/yield-strategies', { method: 'GET' });
    if (Array.isArray(data?.strategies) && data.strategies.length > 0) {
      state.strategies = data.strategies;
      state.strategiesLoaded = true;
      populateYieldStrategySelect();
      renderYieldParkCard();
      updateSectionSummaryBadges();
    }
  } catch {
    // Non-fatal on initial load
  }
}

function populateYieldStrategySelect() {
  const select = document.getElementById('yieldStrategySelect');
  if (!select || !state.strategies.length) return;
  const frag = document.createDocumentFragment();
  for (const s of state.strategies) {
    const opt = document.createElement('option');
    opt.value = String(s.id);
    const apyStr = Number.isFinite(Number(s.baselineApyPct))
      ? `~${Number(s.baselineApyPct).toFixed(1)}% APY`
      : '';
    opt.textContent = `${s.name}${apyStr ? ` (${apyStr})` : ''}`;
    if (s.id === state.selectedStrategyId) opt.selected = true;
    frag.appendChild(opt);
  }
  select.replaceChildren(frag);
}

async function runYieldParkRequest({ buildTransaction = false } = {}) {
  const connectedSol = getConnectedSolanaAddress();
  const ownerAddress =
    resolveSolanaAddress() || '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

  const amountInput = document.getElementById('yieldAmountInput');
  const parsedAmount = Number(amountInput?.value ?? state.yieldAmountUsdc);
  if (!Number.isFinite(parsedAmount) || parsedAmount < 1) {
    state.yieldError = 'Enter at least $1.00 USDC to park in yield.';
    renderYieldParkCard();
    return null;
  }
  state.yieldAmountUsdc = parsedAmount;

  if (buildTransaction && !connectedSol) {
    showToast('Connect your Solana wallet to sign & park yield.');
    document.getElementById('connectSolBtn')?.click();
    return null;
  }

  const seq = ++state.yieldSeq;
  state.yieldLoading = !buildTransaction;
  state.yieldSigning = buildTransaction;
  state.yieldError = null;
  renderYieldParkCard();

  try {
    const plan = await apiJson('/api/solana/yield-park', {
      method: 'POST',
      body: JSON.stringify({
        ownerAddress: buildTransaction ? connectedSol : ownerAddress,
        totalUsdcAmount: parsedAmount,
        preservePct: 100,
        strategy: state.selectedStrategyId,
        buildTransaction,
      }),
    });
    if (seq !== state.yieldSeq) return null;
    state.yieldPlan = plan;

    if (buildTransaction) {
      if (getConnectedSolanaAddress() !== connectedSol) {
        state.yieldError = 'Connected Solana wallet changed before signing. Please retry.';
        return null;
      }
      const txB64 = plan?.transaction?.swapTransactionBase64;
      if (txB64) {
        const res = await signAndSendSolanaVersionedTx(txB64, {
          expectedFeePayer: connectedSol,
          flow: 'jupiter_yield',
          autoConnect: false,
        });
        if (seq !== state.yieldSeq) return null;
        state.yieldLastTx = {
          signature: res.signature,
          explorerUrl: res.explorerUrl,
          walletName: res.walletName,
          strategyName: plan.strategy?.symbol || plan.strategy?.name || 'Yield',
          yieldUsdc: plan.split?.yieldUsdc || parsedAmount,
        };
        showToast(
          `Parked ${fmtUsd(plan.split?.yieldUsdc)} into ${plan.strategy?.symbol || 'Solana Yield'}!`
        );
      } else {
        const vaultUrl = safeHttpsUrl(plan?.strategy?.appUrl, YIELD_VAULT_ALLOWED_HOSTS);
        showToast(
          plan?.warnings?.[0] ||
            `${plan?.strategy?.name || 'Strategy'} quote ready — deposit directly on protocol.`
        );
        if (vaultUrl) {
          state.yieldLastTx = {
            signature: null,
            explorerUrl: vaultUrl,
            strategyName: plan.strategy?.name || 'Vault',
            yieldUsdc: plan.split?.yieldUsdc || parsedAmount,
            isExternalVault: true,
          };
        }
      }
    }
    return plan;
  } catch (err) {
    if (seq !== state.yieldSeq) return null;
    state.yieldError = isUserRejectedError(err)
      ? 'Signature rejected in Solana wallet. Yield park cancelled.'
      : err instanceof Error
      ? err.message
      : 'Failed to build Solana yield park plan.';
    return null;
  } finally {
    if (seq === state.yieldSeq) {
      state.yieldLoading = false;
      state.yieldSigning = false;
      renderYieldParkCard();
      updateSectionSummaryBadges();
    }
  }
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

function getYieldStrategyLogo(strategyId) {
  const id = String(strategyId || '').toLowerCase();
  if (id.includes('kamino')) return resolveLogo('/logos/kamino.svg', '/logos/vault.svg');
  if (id.includes('marinade') || id.includes('msol')) return '/logos/solana.svg';
  if (id.includes('sanctum')) return resolveLogo('/logos/sanctum.svg', '/logos/solana.svg');
  if (id.includes('jupsol')) return resolveLogo('/logos/jupsol.svg', '/logos/solana.svg');
  if (id.includes('jupiter')) return resolveLogo('/logos/jupiter.svg', '/logos/usdc.svg');
  return '/logos/usdc.svg';
}

function uiIconSvg(name, size = 12) {
  if (typeof window !== 'undefined') {
    if (typeof window.renderTurgaliumUiIcon === 'function') {
      return window.renderTurgaliumUiIcon(name, size);
    }
    if (typeof window.renderUiIcon === 'function') {
      return window.renderUiIcon(name, size);
    }
  }
  const s = Number(size) || 12;
  if (name === 'check') {
    return `<span class="ui-icon" aria-hidden="true"><svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>`;
  }
  return '';
}

function renderYieldParkCard() {
  const host = document.getElementById('yieldParkBody');
  const badge = document.getElementById('yieldApyBadge');
  const amountInput = document.getElementById('yieldAmountInput');
  const previewBtn = document.getElementById('previewYieldBtn');
  const stratLogoEl = document.getElementById('yieldStrategyLogoImg');
  if (!host) return;

  if (stratLogoEl) {
    stratLogoEl.src = getYieldStrategyLogo(state.selectedStrategyId);
  }

  if (amountInput && document.activeElement !== amountInput) {
    const formatted = Number(state.yieldAmountUsdc.toFixed(2));
    if (Number(amountInput.value) !== formatted) {
      amountInput.value = String(formatted);
    }
  }

  if (previewBtn) {
    previewBtn.disabled = state.yieldLoading || state.yieldSigning;
    previewBtn.textContent = state.yieldLoading ? 'Quoting…' : 'Preview Quote';
  }

  const activeStrat =
    state.strategies.find((s) => s.id === state.selectedStrategyId) ||
    state.yieldPlan?.strategy ||
    null;

  const plan = state.yieldPlan;
  const apyPct =
    plan?.apy?.estimatedApyPct ?? activeStrat?.baselineApyPct ?? 7.1;
  const apySourceLabel = plan?.apy?.source === 'live' ? 'Live APY' : 'Est. APY';

  if (badge) {
    badge.textContent = `${Number(apyPct).toFixed(2)}% ${apySourceLabel}`;
  }

  const frag = document.createDocumentFragment();

  if (state.yieldError) {
    frag.appendChild(el('div', 'ptool-alert is-error', state.yieldError));
  }

  if (state.yieldLastTx) {
    const okBox = el('div', 'ptool-alert is-success');
    if (state.yieldLastTx.isExternalVault) {
      okBox.appendChild(
        el(
          'span',
          '',
          `Vault ready (${fmtUsd(state.yieldLastTx.yieldUsdc)} → ${state.yieldLastTx.strategyName}) · `
        )
      );
      const vaultHref = safeHttpsUrl(state.yieldLastTx.explorerUrl, YIELD_VAULT_ALLOWED_HOSTS);
      if (vaultHref) {
        const a = el('a', 'ptool-link mono', 'Open Protocol Vault ↗');
        a.href = vaultHref;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        okBox.appendChild(a);
      }
    } else {
      okBox.appendChild(
        el(
          'span',
          '',
          `Parked ${fmtUsd(state.yieldLastTx.yieldUsdc)} in ${state.yieldLastTx.strategyName} · `
        )
      );
      const href = safeHttpsUrl(state.yieldLastTx.explorerUrl, SOLSCAN_ALLOWED_HOSTS);
      if (href) {
        const a = el('a', 'ptool-link mono', `${shortAddr(state.yieldLastTx.signature)} ↗`);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        okBox.appendChild(a);
      }
    }
    frag.appendChild(okBox);
  }

  // 100% principal-safe projection preview
  const totalUsdc = Math.max(0, Number(state.yieldAmountUsdc) || 0);
  const yieldUsdc = plan?.split?.yieldUsdc ?? Number(totalUsdc.toFixed(2));
  const annualUsd =
    plan?.projections?.projectedAnnualYieldUsd ??
    Number(((yieldUsdc * Number(apyPct)) / 100).toFixed(2));
  const monthlyUsd =
    plan?.projections?.projectedMonthlyYieldUsd ?? Number((annualUsd / 12).toFixed(2));

  const kpis = el('div', 'ptool-kpi-grid');
  const k1 = el('div', 'ptool-kpi');
  k1.appendChild(el('span', 'ptool-kpi-label', 'Deposited (100%)'));
  k1.appendChild(el('strong', 'ptool-kpi-val mono is-emerald', fmtUsd(yieldUsdc)));
  kpis.appendChild(k1);

  const k2 = el('div', 'ptool-kpi');
  k2.appendChild(el('span', 'ptool-kpi-label', 'Projected APY'));
  k2.appendChild(el('strong', 'ptool-kpi-val mono', `${Number(apyPct).toFixed(2)}%`));
  kpis.appendChild(k2);

  const k3 = el('div', 'ptool-kpi');
  k3.appendChild(el('span', 'ptool-kpi-label', 'Est. Yield'));
  k3.appendChild(el('strong', 'ptool-kpi-val mono', `+${fmtUsd(annualUsd)}/yr`));
  kpis.appendChild(k3);
  frag.appendChild(kpis);

  if (activeStrat?.description) {
    frag.appendChild(el('div', 'ptool-meta-line', activeStrat.description));
  }

  if (plan?.jupiterQuote) {
    const q = plan.jupiterQuote;
    const routesText =
      Array.isArray(q.routeLabels) && q.routeLabels.length
        ? ` via ${q.routeLabels.join(' → ')}`
        : '';
    const quoteBox = el('div', 'ptool-quote-box mono');
    quoteBox.appendChild(
      el(
        'div',
        '',
        `Quote: ~${Number(q.estimatedOutputUi || 0).toFixed(5)} ${plan.strategy?.symbol || 'JupSOL'} (min ${Number(q.minOutputUi || 0).toFixed(5)})${routesText}`
      )
    );
    quoteBox.appendChild(
      el(
        'div',
        'ptool-list-sub',
        `Impact: ${Number(q.priceImpactPct || 0).toFixed(3)}% · Slippage: ${(Number(q.slippageBps || 50) / 100).toFixed(2)}% · Est. +${fmtUsd(monthlyUsd)}/mo`
      )
    );
    frag.appendChild(quoteBox);
  } else {
    frag.appendChild(
      el(
        'div',
        'ptool-meta-line mono',
        `Projected monthly yield: +${fmtUsd(monthlyUsd)}/mo · ${activeStrat?.preservesUsdPeg ? 'USD-pegged principal' : 'Liquid-staked SOL yield'}`
      )
    );
  }

  if (Array.isArray(plan?.warnings) && plan.warnings.length > 0) {
    for (const w of plan.warnings) {
      frag.appendChild(el('div', 'ptool-alert is-info', String(w)));
    }
  }

  const connectedSol = getConnectedSolanaAddress();
  const isSwapMode = (activeStrat?.executionMode || 'jupiter_swap_v0') === 'jupiter_swap_v0';
  const parkBtnLabel = state.yieldSigning
    ? 'Confirm in Solana Wallet…'
    : !connectedSol
    ? 'Connect Solana to Park Yield'
    : isSwapMode
    ? `1-Click Park ${fmtUsd(yieldUsdc)} → ${activeStrat?.symbol || 'JupSOL'}`
    : `1-Click Quote & Open ${activeStrat?.symbol || 'Vault'}`;

  const parkBtn = el('button', 'btn-pill-dark btn-sm ptool-primary-btn', parkBtnLabel);
  parkBtn.type = 'button';
  parkBtn.id = 'parkYieldBtn';
  parkBtn.disabled = state.yieldSigning || state.yieldLoading;
  parkBtn.addEventListener('click', () => runYieldParkRequest({ buildTransaction: true }));
  frag.appendChild(parkBtn);

  host.replaceChildren(frag);
}

// =========================================================================
// 3. STALE ERC-20 APPROVAL REVOKER (1-CLICK REVOKE / BATCH REVOKE)
// =========================================================================

async function runApprovalScan({ silent = false } = {}) {
  const walletAddress = resolveEvmAddress();
  if (!walletAddress) {
    if (!silent) {
      state.approvalError = 'Scan or connect an EVM wallet (0x…) first to inspect stale ERC-20 approvals.';
      renderApprovalRevokerCard();
      document.getElementById('appEvmInput')?.focus();
    }
    return;
  }

  const seq = ++state.approvalSeq;
  state.approvalLoading = true;
  state.approvalError = null;
  state.approvalLastResult = null;
  renderApprovalRevokerCard();

  try {
    const data = await apiJson('/api/approvals/scan', {
      method: 'POST',
      body: JSON.stringify({
        chain: state.selectedApprovalChain,
        walletAddress,
      }),
    });
    if (seq !== state.approvalSeq) return;
    state.approvalScan = data;
    state.revokedKeys.clear();
  } catch (err) {
    if (seq !== state.approvalSeq) return;
    if (!silent) {
      state.approvalError =
        err instanceof Error ? err.message : 'Failed to scan stale ERC-20 approvals.';
    }
  } finally {
    if (seq === state.approvalSeq) {
      state.approvalLoading = false;
      renderApprovalRevokerCard();
      updateSectionSummaryBadges();
    }
  }
}

async function handleRevokeFindings(findingsToRevoke, keyLabel) {
  const connectedEvm = getConnectedEvmAddress();
  if (!connectedEvm) {
    showToast('Read-only scan — connect your EVM wallet to sign ERC-20 revocations.');
    document.getElementById('connectEvmBtn')?.click();
    return;
  }

  const scannedWallet = state.approvalScan?.walletAddress;
  if (!scannedWallet || scannedWallet.toLowerCase() !== connectedEvm.toLowerCase()) {
    state.approvalError =
      'Connected EVM wallet does not match the scanned approval report. Re-scan your connected wallet before revoking.';
    renderApprovalRevokerCard();
    return;
  }

  const valid = findingsToRevoke.filter((f) => f?.revokeCall?.to && f?.revokeCall?.data);
  if (!valid.length) return;

  const targetChainId = Number(valid[0].chainId || state.approvalScan?.chainId || 1);
  state.revokingKey = keyLabel;
  state.approvalError = null;
  renderApprovalRevokerCard();

  try {
    const res = await sendEvmRevokeCalls({
      chainId: targetChainId,
      calls: valid.map((f) => ({
        to: f.revokeCall.to,
        data: f.revokeCall.data,
        value: f.revokeCall.value || '0x0',
        chainId: Number(f.revokeCall.chainId || targetChainId),
      })),
      expectedFrom: connectedEvm,
    });

    const indices = Array.isArray(res.revokedIndices)
      ? res.revokedIndices
      : valid.map((_, idx) => idx);
    for (const idx of indices) {
      if (valid[idx]) state.revokedKeys.add(findingKey(valid[idx]));
    }
    state.approvalLastResult = {
      mode: res.mode,
      count: res.revokedCount,
      txHashes: res.txHashes || [],
      batchId: res.batchId || null,
      chain: state.approvalScan?.chain || state.selectedApprovalChain,
    };
    showToast(
      res.mode === 'eip5792'
        ? `Revoked ${res.revokedCount} approval(s) in 1 EIP-5792 batch!`
        : `Submitted ${res.revokedCount} ERC-20 approval revocation(s).`
    );
  } catch (err) {
    const partialIndices = Array.isArray(err?.revokedIndices) ? err.revokedIndices : [];
    const partialHashes = Array.isArray(err?.txHashes) ? err.txHashes : [];
    if (partialIndices.length > 0) {
      for (const idx of partialIndices) {
        if (valid[idx]) state.revokedKeys.add(findingKey(valid[idx]));
      }
      state.approvalLastResult = {
        mode: 'sequential',
        count: partialIndices.length,
        txHashes: partialHashes,
        batchId: null,
        chain: state.approvalScan?.chain || state.selectedApprovalChain,
      };
    }
    state.approvalError = isUserRejectedError(err)
      ? partialIndices.length > 0
        ? `Revoked ${partialIndices.length}/${valid.length} approval(s) before signature was rejected in EVM wallet.`
        : 'Signature rejected in EVM wallet. No approvals were changed.'
      : err instanceof Error
      ? err.message
      : 'Failed to submit ERC-20 revoke transaction.';
  } finally {
    state.revokingKey = null;
    renderApprovalRevokerCard();
    updateSectionSummaryBadges();
  }
}

function renderApprovalRevokerCard() {
  const host = document.getElementById('approvalRevokerBody');
  const badge = document.getElementById('approvalRiskBadge');
  const scanBtn = document.getElementById('scanApprovalsBtn');
  const chainSelect = document.getElementById('approvalChainSelect');
  if (!host) return;

  if (chainSelect && chainSelect.value !== state.selectedApprovalChain) {
    chainSelect.value = state.selectedApprovalChain;
  }
  if (scanBtn) {
    scanBtn.disabled = state.approvalLoading || Boolean(state.revokingKey);
    scanBtn.textContent = state.approvalLoading ? 'Scanning…' : 'Scan Approvals';
  }

  const connectedEvm = getConnectedEvmAddress();
  const targetWallet = resolveEvmAddress();
  const scan = state.approvalScan;
  const allFindings = Array.isArray(scan?.findings) ? scan.findings : [];
  const activeFindings = allFindings.filter((f) => !state.revokedKeys.has(findingKey(f)));

  if (badge) {
    if (!scan) {
      badge.textContent = 'Multicall3 Scan';
      badge.className = 'ptool-badge mono';
    } else if (activeFindings.length === 0) {
      badge.textContent = '0 risky open';
      badge.className = 'ptool-badge is-emerald mono';
    } else {
      badge.textContent = `${activeFindings.length} open · ${Number(scan.unlimitedCount || 0)} unlimited`;
      badge.className = 'ptool-badge is-warn mono';
    }
  }

  const frag = document.createDocumentFragment();

  if (state.approvalError) {
    frag.appendChild(el('div', 'ptool-alert is-error', state.approvalError));
  }

  if (state.approvalLastResult) {
    const r = state.approvalLastResult;
    const okBox = el('div', 'ptool-alert is-success');
    const summaryText =
      r.mode === 'eip5792'
        ? `Revoked ${r.count} approval(s) via EIP-5792 batch (${shortAddr(r.batchId)}).`
        : `Submitted ${r.count} revocation tx(s). `;
    okBox.appendChild(el('span', '', summaryText));
    if (r.txHashes?.length) {
      const href = safeHttpsUrl(
        `${getChainExplorerPrefix(r.chain)}${encodeURIComponent(r.txHashes[0])}`,
        EVM_EXPLORER_ALLOWED_HOSTS
      );
      if (href) {
        const a = el('a', 'ptool-link mono', `${shortAddr(r.txHashes[0])} ↗`);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        okBox.appendChild(a);
      }
    }
    frag.appendChild(okBox);
  }

  if (!scan) {
    frag.appendChild(
      el(
        'p',
        'ptool-empty',
        targetWallet
          ? `Ready to check ${shortAddr(targetWallet)} on ${state.selectedApprovalChain} for lingering unlimited DEX & bridge approvals.`
          : 'Connect or scan an EVM wallet above, pick a chain, and check for stale unlimited ERC-20 allowances.'
      )
    );
    host.replaceChildren(frag);
    return;
  }

  frag.appendChild(
    el(
      'div',
      'ptool-meta-line mono',
      `${scan.chainName || scan.chain} · ${shortAddr(scan.walletAddress)} · checked ${Number(scan.scannedPairs || 0)} pairs`
    )
  );

  if (allFindings.length === 0) {
    frag.appendChild(
      el(
        'div',
        'ptool-alert is-success',
        `No active stale approvals found on ${scan.chainName || scan.chain} across known spenders.`
      )
    );
    host.replaceChildren(frag);
    return;
  }

  if (!connectedEvm && activeFindings.length > 0) {
    frag.appendChild(
      el(
        'div',
        'ptool-alert is-info',
        'Read-only scan — connect your EVM wallet to sign approve(spender, 0) revocations.'
      )
    );
  }

  const list = el('div', 'ptool-list');
  for (let i = 0; i < allFindings.length; i += 1) {
    const f = allFindings[i];
    const key = findingKey(f);
    const isRevoked = state.revokedKeys.has(key);
    const isBusy = state.revokingKey === key || state.revokingKey === 'all';

    const row = el('div', `ptool-list-row${isRevoked ? ' is-revoked' : ''}`);
    const main = el('div', 'ptool-list-main');

    const titleLine = el('div', 'ptool-finding-title-row');
    titleLine.appendChild(el('strong', 'ptool-list-primary mono', String(f.tokenSymbol || 'ERC20')));
    titleLine.appendChild(
      el(
        'span',
        `ptool-pill mono ${
          f.severity === 'critical' || f.severity === 'high' ? 'is-danger' : 'is-warn'
        }`,
        f.isUnlimited ? 'UNLIMITED' : String(f.allowanceFormatted || 'Active')
      )
    );
    main.appendChild(titleLine);

    main.appendChild(el('span', 'ptool-list-sub', String(f.spenderLabel || shortAddr(f.spender))));
    if (f.riskReason) {
      main.appendChild(el('span', 'ptool-list-note', String(f.riskReason)));
    }
    row.appendChild(main);

    const rowBtn = el(
      'button',
      `btn-row-exec ptool-row-btn${isRevoked ? ' is-done' : ''}`
    );
    if (isRevoked) {
      rowBtn.innerHTML = `${uiIconSvg('check', 12)}<span>Revoked</span>`;
    } else {
      rowBtn.textContent = isBusy ? 'Signing…' : 'Revoke';
    }
    rowBtn.type = 'button';
    rowBtn.setAttribute('data-revoke-approval-idx', String(i));
    rowBtn.disabled = isRevoked || Boolean(state.revokingKey) || state.approvalLoading;
    rowBtn.addEventListener('click', () => handleRevokeFindings([f], key));
    row.appendChild(rowBtn);

    list.appendChild(row);
  }
  frag.appendChild(list);

  if (activeFindings.length > 0) {
    const revokeAllBtn = el(
      'button',
      'btn-pill-dark btn-sm ptool-primary-btn',
      state.revokingKey === 'all'
        ? 'Confirm Revoke Batch…'
        : connectedEvm
        ? `1-Click Revoke All (${activeFindings.length})`
        : `Connect EVM to Revoke All (${activeFindings.length})`
    );
    revokeAllBtn.type = 'button';
    revokeAllBtn.id = 'revokeAllApprovalsBtn';
    revokeAllBtn.disabled = Boolean(state.revokingKey) || state.approvalLoading;
    revokeAllBtn.addEventListener('click', () => handleRevokeFindings(activeFindings, 'all'));
    frag.appendChild(revokeAllBtn);
  }

  host.replaceChildren(frag);
}

// =========================================================================
// 4. SOLANA SPL DUST SWEEPER (1-CLICK SWEEP TO USDC/SOL + ATOMIC ATA RENT)
// =========================================================================

function createLucideSvgNode(iconName, size = 16) {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  if (iconName === 'sparkles') {
    const p1 = document.createElementNS(SVG_NS, 'path');
    p1.setAttribute(
      'd',
      'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z'
    );
    const p2 = document.createElementNS(SVG_NS, 'path');
    p2.setAttribute('d', 'M20 3v4');
    const p3 = document.createElementNS(SVG_NS, 'path');
    p3.setAttribute('d', 'M22 5h-4');
    svg.append(p1, p2, p3);
  } else if (iconName === 'check') {
    const poly = document.createElementNS(SVG_NS, 'polyline');
    poly.setAttribute('points', '20 6 9 17 4 12');
    svg.appendChild(poly);
  } else {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', 'M12 2L2 7l10 5 10-5-10-5z');
    svg.appendChild(p);
  }
  return svg;
}

function ensureSplDustCard() {
  const grid = document.getElementById('preservationToolsGrid');
  if (!grid || document.getElementById('splDustCard')) return;

  // Add summary chip inside .ptools-summary-chips if not present
  const chipsRow = document.querySelector('#preservationToolsSection .ptools-summary-chips');
  if (chipsRow && !document.getElementById('toolsSummaryDustBadge')) {
    const chip = el('span', 'ptools-chip', 'SPL Dust Sweep');
    chip.id = 'toolsSummaryDustBadge';
    chipsRow.appendChild(chip);
  }

  const card = el('article', 'ptool-card');
  card.id = 'splDustCard';

  const head = el('div', 'ptool-card-head');
  const titleWrap = document.createElement('div');
  const titleRow = el('div', 'ptool-card-title-row');
  const iconWrap = el('span', 'ptool-card-icon');
  iconWrap.appendChild(createLucideSvgNode('sparkles', 16));
  titleRow.appendChild(iconWrap);
  titleRow.appendChild(el('h3', '', 'Sweep Solana SPL Dust'));
  titleWrap.appendChild(titleRow);
  titleWrap.appendChild(
    el('p', 'ptool-card-sub', 'Convert small SPL tokens into USDC or SOL & reclaim ATA rent')
  );
  head.appendChild(titleWrap);

  const badge = el('span', 'ptool-badge mono', 'Max $50 / token');
  badge.id = 'splDustCountBadge';
  head.appendChild(badge);
  card.appendChild(head);

  const controls = el('div', 'ptool-dust-controls');

  const targetField = el('label', 'ptool-field');
  targetField.appendChild(el('span', 'ptool-label', 'Convert into'));
  const targetSelect = el('select', 'ptool-select');
  targetSelect.id = 'splDustTargetSelect';
  targetSelect.setAttribute('aria-label', 'Target asset for Solana SPL dust sweep');
  const optUsdc = document.createElement('option');
  optUsdc.value = 'usdc';
  optUsdc.textContent = 'USDC (SPL)';
  optUsdc.selected = state.dustTargetAsset === 'usdc';
  const optSol = document.createElement('option');
  optSol.value = 'sol';
  optSol.textContent = 'SOL (Native)';
  optSol.selected = state.dustTargetAsset === 'sol';
  targetSelect.append(optUsdc, optSol);
  targetField.appendChild(targetSelect);
  controls.appendChild(targetField);

  const maxField = el('label', 'ptool-field');
  maxField.appendChild(el('span', 'ptool-label', 'Max USD'));
  const maxInput = el('input', 'ptool-input mono');
  maxInput.id = 'splDustMaxUsdInput';
  maxInput.type = 'number';
  maxInput.min = '1';
  maxInput.max = '5000';
  maxInput.step = '5';
  maxInput.value = String(state.dustMaxUsd);
  maxInput.setAttribute('aria-label', 'Maximum USD value per Solana SPL dust token');
  maxField.appendChild(maxInput);
  controls.appendChild(maxField);

  const scanBtn = el('button', 'btn-outline-sm ptool-inline-btn', 'Scan Dust');
  scanBtn.type = 'button';
  scanBtn.id = 'scanSplDustBtn';
  controls.appendChild(scanBtn);

  card.appendChild(controls);

  const body = el('div', 'ptool-card-body');
  body.id = 'splDustBody';
  body.setAttribute('aria-live', 'polite');
  card.appendChild(body);

  const rentCard = document.getElementById('rentVacuumCard');
  if (rentCard && rentCard.parentElement === grid) {
    rentCard.insertAdjacentElement('afterend', card);
  } else {
    grid.appendChild(card);
  }

  targetSelect.addEventListener('change', (ev) => {
    const val = String(ev.target?.value || 'usdc');
    state.dustTargetAsset = val === 'sol' ? 'sol' : 'usdc';
    state.dustError = null;
    renderSplDustCard();
  });

  maxInput.addEventListener('change', (ev) => {
    const val = Number(ev.target?.value);
    if (Number.isFinite(val) && val >= 0.01 && val <= 5000) {
      state.dustMaxUsd = Number(val.toFixed(2));
      state.dustScan = null;
      state.sweptDustAccounts.clear();
      state.dustError = null;
      renderSplDustCard();
      updateSectionSummaryBadges();
    }
  });

  scanBtn.addEventListener('click', () => {
    runSolanaSplDustScan({ silent: false });
  });
}

async function runSolanaSplDustScan({ silent = false, forceOwnerAddress = null } = {}) {
  const ownerAddress = forceOwnerAddress || resolveSolanaAddress();
  if (!ownerAddress) {
    if (!silent) {
      state.dustError =
        'Connect a Solana wallet or enter a Solana address to scan sweepable SPL dust.';
      renderSplDustCard();
      document.getElementById('rentOwnerInput')?.focus();
    }
    return null;
  }

  const maxInput = document.getElementById('splDustMaxUsdInput');
  const parsedMax = Number(maxInput?.value ?? state.dustMaxUsd);
  const maxDustUsd =
    Number.isFinite(parsedMax) && parsedMax >= 0.01 && parsedMax <= 5000
      ? Number(parsedMax.toFixed(2))
      : 50;
  state.dustMaxUsd = maxDustUsd;

  const seq = ++state.dustSeq;
  state.dustLoading = true;
  state.dustError = null;
  state.dustLastResult = null;
  renderSplDustCard();

  try {
    const data = await apiJson('/api/solana/dust-scan', {
      method: 'POST',
      body: JSON.stringify({
        ownerAddress,
        maxDustUsd,
      }),
    });
    if (seq !== state.dustSeq) return null;
    state.dustScan = data;
    state.sweptDustAccounts.clear();
    return data;
  } catch (err) {
    if (seq !== state.dustSeq) return null;
    if (!silent) {
      state.dustError = err instanceof Error ? err.message : 'Failed to scan Solana SPL dust.';
    }
    return null;
  } finally {
    if (seq === state.dustSeq) {
      state.dustLoading = false;
      renderSplDustCard();
      updateSectionSummaryBadges();
    }
  }
}

async function handleSweepSplDust(accountsToSweep, keyLabel) {
  const connectedSol = getConnectedSolanaAddress();
  if (!connectedSol) {
    showToast('Connect your Solana wallet (Phantom, Backpack, or Solflare) to sweep SPL dust.');
    document.getElementById('connectSolBtn')?.click();
    return;
  }

  let scan = state.dustScan;
  if (!scan || scan.ownerAddress !== connectedSol) {
    scan = await runSolanaSplDustScan({ silent: false, forceOwnerAddress: connectedSol });
    if (!scan) return;
    accountsToSweep = scan.dustAccounts || [];
  }

  const activeAccounts = (accountsToSweep || []).filter(
    (a) => a && a.tokenAccount && !state.sweptDustAccounts.has(a.tokenAccount)
  );
  if (!activeAccounts.length) {
    showToast('No remaining SPL dust accounts to sweep.');
    return;
  }

  const seq = ++state.dustSeq;
  state.dustSweepingKey = keyLabel;
  state.dustError = null;
  renderSplDustCard();

  let sweptCount = 0;
  let totalOutputUi = 0;
  let totalReclaimedSol = 0;
  const signatures = [];
  let firstExplorerUrl = null;
  let targetSymbol = state.dustTargetAsset === 'sol' ? 'SOL' : 'USDC';

  try {
    const plan = await apiJson('/api/solana/dust-sweep', {
      method: 'POST',
      body: JSON.stringify({
        ownerAddress: connectedSol,
        targetAsset: state.dustTargetAsset,
        maxDustUsd: state.dustMaxUsd,
        closeAccounts: true,
        buildTransactions: true,
        tokens: activeAccounts.slice(0, 10).map((a) => ({
          tokenAccount: a.tokenAccount,
          mint: a.mint,
          amount: a.amount,
          decimals: a.decimals,
          uiAmount: a.uiAmount,
          symbol: a.symbol,
          usdValue: a.usdValue,
          rentLamports: a.rentLamports,
        })),
      }),
    });
    if (seq !== state.dustSeq) return;
    targetSymbol = plan?.targetSymbol || targetSymbol;

    const items = Array.isArray(plan?.items) ? plan.items : [];
    if (items.length === 0) {
      const skipReason = plan?.skipped?.[0]?.reason;
      state.dustError =
        skipReason || 'No routable SPL dust swaps available within safe 5% price impact cap.';
      return;
    }

    for (const item of items) {
      if (getConnectedSolanaAddress() !== connectedSol) {
        throw new Error('Connected Solana wallet changed during sweep. Please retry.');
      }
      const txB64 = item?.transaction?.swapTransactionBase64;
      if (!txB64) continue;
      const res = await signAndSendSolanaVersionedTx(txB64, {
        expectedFeePayer: connectedSol,
        flow: 'jupiter_yield',
        autoConnect: false,
      });
      if (seq !== state.dustSeq) return;
      state.sweptDustAccounts.add(item.tokenAccount);
      sweptCount += 1;
      totalOutputUi += Number(item?.quote?.estimatedOutputUi || 0);
      if (item?.rentReclaim?.atomicCloseAppended) {
        totalReclaimedSol += Number(item?.rentReclaim?.rentSol || 0.00203928);
      }
      if (res?.signature) signatures.push(res.signature);
      if (!firstExplorerUrl && res?.explorerUrl) firstExplorerUrl = res.explorerUrl;
    }

    if (sweptCount > 0) {
      state.dustLastResult = {
        count: sweptCount,
        targetSymbol,
        outputUi: Number(totalOutputUi.toFixed(targetSymbol === 'SOL' ? 5 : 2)),
        reclaimedSol: Number(totalReclaimedSol.toFixed(8)),
        signatures,
        explorerUrl: firstExplorerUrl,
      };
      showToast(
        `Swept ${sweptCount} SPL dust token(s) into ${targetSymbol}${totalReclaimedSol > 0 ? ` + reclaimed ${fmtSol(totalReclaimedSol)} SOL rent` : ''}!`
      );
    }
  } catch (err) {
    if (seq !== state.dustSeq) return;
    if (sweptCount > 0) {
      state.dustLastResult = {
        count: sweptCount,
        targetSymbol,
        outputUi: Number(totalOutputUi.toFixed(targetSymbol === 'SOL' ? 5 : 2)),
        reclaimedSol: Number(totalReclaimedSol.toFixed(8)),
        signatures,
        explorerUrl: firstExplorerUrl,
      };
    }
    state.dustError = isUserRejectedError(err)
      ? sweptCount > 0
        ? `Swept ${sweptCount} token(s) before signature was rejected in Solana wallet.`
        : 'Signature rejected in Solana wallet. No SPL dust was swept.'
      : err instanceof Error
      ? err.message
      : 'Failed to sweep Solana SPL dust.';
  } finally {
    if (seq === state.dustSeq) {
      state.dustSweepingKey = null;
      renderSplDustCard();
      updateSectionSummaryBadges();
    }
  }
}

function renderSplDustCard() {
  const host = document.getElementById('splDustBody');
  const badge = document.getElementById('splDustCountBadge');
  const scanBtn = document.getElementById('scanSplDustBtn');
  const targetSelect = document.getElementById('splDustTargetSelect');
  if (!host) return;

  if (targetSelect && targetSelect.value !== state.dustTargetAsset) {
    targetSelect.value = state.dustTargetAsset;
  }
  if (scanBtn) {
    scanBtn.disabled = state.dustLoading || Boolean(state.dustSweepingKey);
    scanBtn.textContent = state.dustLoading ? 'Scanning…' : 'Scan Dust';
  }

  const connectedSol = getConnectedSolanaAddress();
  const activeSol = resolveSolanaAddress();
  const scan = state.dustScan;
  const allDust = Array.isArray(scan?.dustAccounts) ? scan.dustAccounts : [];
  const activeDust = allDust.filter((a) => !state.sweptDustAccounts.has(a.tokenAccount));
  const targetLabel = state.dustTargetAsset === 'sol' ? 'SOL' : 'USDC';

  if (badge) {
    if (!scan) {
      badge.textContent = `Max $${state.dustMaxUsd} / token`;
      badge.className = 'ptool-badge mono';
    } else if (activeDust.length === 0) {
      badge.textContent = '0 dust left';
      badge.className = 'ptool-badge is-emerald mono';
    } else {
      badge.textContent = `${activeDust.length} dust · +${fmtSol(
        activeDust.reduce((s, a) => s + (Number(a.rentSol) || 0.00203928), 0)
      )} SOL`;
      badge.className = 'ptool-badge is-emerald mono';
    }
  }

  const frag = document.createDocumentFragment();

  if (state.dustError) {
    frag.appendChild(el('div', 'ptool-alert is-error', state.dustError));
  }

  if (state.dustLastResult) {
    const r = state.dustLastResult;
    const okBox = el('div', 'ptool-alert is-success');
    const rentSuffix =
      r.reclaimedSol > 0 ? ` + ${fmtSol(r.reclaimedSol)} SOL rent reclaimed` : '';
    okBox.appendChild(
      el(
        'span',
        '',
        `Swept ${r.count} SPL token(s) → ~${r.outputUi} ${r.targetSymbol}${rentSuffix} · `
      )
    );
    const linkHref = safeHttpsUrl(r.explorerUrl, SOLSCAN_ALLOWED_HOSTS);
    if (linkHref && r.signatures?.length) {
      const a = el('a', 'ptool-link mono', `${shortAddr(r.signatures[0])} ↗`);
      a.href = linkHref;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      okBox.appendChild(a);
    }
    frag.appendChild(okBox);
  }

  if (!scan) {
    frag.appendChild(
      el(
        'p',
        'ptool-empty',
        activeSol
          ? `Ready to scan ${shortAddr(activeSol)} for SPL dust under $${state.dustMaxUsd}. Automatically protects SOL, USDC, JupSOL, jlUSDC, frozen accounts, and large positions.`
          : 'Connect Solana or enter a Solana address to convert small SPL dust into USDC or SOL and reclaim 0.00203928 SOL ATA rent per token.'
      )
    );
    host.replaceChildren(frag);
    return;
  }

  const remainingDustUsd = activeDust.reduce((s, a) => s + (Number(a.usdValue) || 0), 0);
  const remainingRentSol = activeDust.reduce(
    (s, a) => s + (Number(a.rentSol) || 0.00203928),
    0
  );

  const metrics = el('div', 'ptool-kpi-grid');
  const k1 = el('div', 'ptool-kpi');
  k1.appendChild(el('span', 'ptool-kpi-label', 'Dust Tokens'));
  k1.appendChild(el('strong', 'ptool-kpi-val mono', String(activeDust.length)));
  metrics.appendChild(k1);

  const k2 = el('div', 'ptool-kpi');
  k2.appendChild(el('span', 'ptool-kpi-label', 'Est. Dust Value'));
  k2.appendChild(el('strong', 'ptool-kpi-val mono', fmtUsd(remainingDustUsd)));
  metrics.appendChild(k2);

  const k3 = el('div', 'ptool-kpi');
  k3.appendChild(el('span', 'ptool-kpi-label', 'ATA Rent Reclaim'));
  k3.appendChild(
    el('strong', 'ptool-kpi-val mono is-emerald', `+${fmtSol(remainingRentSol)} SOL`)
  );
  metrics.appendChild(k3);
  frag.appendChild(metrics);

  frag.appendChild(
    el(
      'div',
      'ptool-meta-line mono',
      `Scanned ${Number(scan.totalTokenAccountsScanned || 0)} SPL accounts · skips SOL/USDC/JupSOL/jlUSDC & >$${Number(scan.maxDustUsd || state.dustMaxUsd)}`
    )
  );

  if (allDust.length === 0) {
    frag.appendChild(
      el(
        'div',
        'ptool-alert is-success',
        `Clean wallet — 0 sweepable SPL dust tokens under $${Number(scan.maxDustUsd || state.dustMaxUsd)}.`
      )
    );
    host.replaceChildren(frag);
    return;
  }

  if (!connectedSol && activeDust.length > 0) {
    frag.appendChild(
      el(
        'div',
        'ptool-alert is-info',
        'Read-only scan — connect Phantom, Backpack, or Solflare to sign Jupiter dust swaps & atomic CloseAccount.'
      )
    );
  }

  const list = el('div', 'ptool-list');
  const visible = allDust.slice(0, 5);
  for (const acc of visible) {
    const isSwept = state.sweptDustAccounts.has(acc.tokenAccount);
    const isBusy =
      state.dustSweepingKey === acc.tokenAccount || state.dustSweepingKey === 'all';
    const row = el('div', `ptool-list-row${isSwept ? ' is-revoked' : ''}`);
    const main = el('div', 'ptool-list-main');
    const titleLine = el('div', 'ptool-finding-title-row');
    titleLine.appendChild(
      el('strong', 'ptool-list-primary mono', String(acc.symbol || shortAddr(acc.mint)))
    );
    titleLine.appendChild(
      el(
        'span',
        'ptool-pill is-emerald mono',
        `+${Number(acc.rentSol || 0.00203928).toFixed(5)} SOL`
      )
    );
    main.appendChild(titleLine);

    const valLabel =
      acc.usdValue !== null && acc.usdValue !== undefined
        ? fmtUsd(acc.usdValue)
        : 'Unpriced (quoted on sweep)';
    main.appendChild(
      el(
        'span',
        'ptool-list-sub mono',
        `${Number(acc.uiAmount || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} · ${valLabel}`
      )
    );
    row.appendChild(main);

    const rowBtn = el('button', `btn-row-exec ptool-row-btn${isSwept ? ' is-done' : ''}`);
    rowBtn.type = 'button';
    if (isSwept) {
      rowBtn.appendChild(createLucideSvgNode('check', 12));
      rowBtn.appendChild(el('span', '', 'Swept'));
    } else {
      rowBtn.textContent = isBusy ? 'Signing…' : 'Sweep';
    }
    rowBtn.disabled = isSwept || Boolean(state.dustSweepingKey) || state.dustLoading;
    rowBtn.addEventListener('click', () => handleSweepSplDust([acc], acc.tokenAccount));
    row.appendChild(rowBtn);
    list.appendChild(row);
  }
  if (allDust.length > visible.length) {
    list.appendChild(
      el(
        'div',
        'ptool-meta-line mono',
        `+${allDust.length - visible.length} more SPL dust token(s) ready to sweep`
      )
    );
  }
  frag.appendChild(list);

  if (activeDust.length > 0) {
    const sweepAllBtn = el(
      'button',
      'btn-pill-dark btn-sm ptool-primary-btn',
      state.dustSweepingKey === 'all'
        ? 'Confirm in Solana Wallet…'
        : connectedSol
        ? `1-Click Sweep ${activeDust.length} Dust → ${targetLabel}`
        : `Connect Solana to Sweep Dust → ${targetLabel}`
    );
    sweepAllBtn.type = 'button';
    sweepAllBtn.id = 'sweepAllSplDustBtn';
    sweepAllBtn.disabled = Boolean(state.dustSweepingKey) || state.dustLoading;
    sweepAllBtn.addEventListener('click', () => handleSweepSplDust(activeDust, 'all'));
    frag.appendChild(sweepAllBtn);
  }

  host.replaceChildren(frag);
}

// =========================================================================
// LIFECYCLE & EVENT SYNC
// =========================================================================

function pickBestApprovalChainFromScan(scanReport) {
  if (!scanReport || !Array.isArray(scanReport.chains)) return null;
  const supportedIds = new Set(SUPPORTED_APPROVAL_CHAINS.map((c) => c.id));
  let best = null;
  for (const ch of scanReport.chains) {
    if (!supportedIds.has(ch.chain)) continue;
    const score = (Number(ch.assetCount) || 0) * 1000 + (Number(ch.totalUsd) || 0);
    if (!best || score > best.score) {
      best = { chain: ch.chain, score };
    }
  }
  return best?.chain || null;
}

function bindEvents() {
  const toggleBtn = document.getElementById('togglePreservationToolsBtn');
  const grid = document.getElementById('preservationToolsGrid');
  if (toggleBtn && grid) {
    toggleBtn.addEventListener('click', () => {
      const collapsed = grid.classList.toggle('hidden');
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
      toggleBtn.textContent = collapsed ? 'Show Tools' : 'Hide Tools';
    });
  }

  document.getElementById('rentOwnerInput')?.addEventListener('input', (ev) => {
    const val = String(ev.target?.value || '').trim();
    state.userEditedRentOwner = Boolean(val);
  });

  document.getElementById('rentScanForm')?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    runSolanaRentScan({ silent: false });
  });

  document.getElementById('yieldStrategySelect')?.addEventListener('change', (ev) => {
    state.selectedStrategyId = String(ev.target.value || 'jupsol');
    state.yieldPlan = null;
    state.yieldError = null;
    renderYieldParkCard();
    updateSectionSummaryBadges();
  });

  document.getElementById('yieldAmountInput')?.addEventListener('input', (ev) => {
    const val = Number(ev.target.value);
    state.userEditedYieldAmount = true;
    if (Number.isFinite(val) && val >= 0) {
      state.yieldAmountUsdc = val;
      state.yieldPlan = null;
      renderYieldParkCard();
    }
  });

  document.getElementById('previewYieldBtn')?.addEventListener('click', () => {
    runYieldParkRequest({ buildTransaction: false });
  });

  document.getElementById('approvalChainSelect')?.addEventListener('change', (ev) => {
    state.selectedApprovalChain = String(ev.target.value || 'ethereum');
    state.approvalScan = null;
    state.approvalError = null;
    state.revokedKeys.clear();
    renderApprovalRevokerCard();
    updateSectionSummaryBadges();
  });

  document.getElementById('scanApprovalsBtn')?.addEventListener('click', () => {
    runApprovalScan({ silent: false });
  });

  // Strict wallet-switch / disconnect state isolation
  window.addEventListener('turgalium:wallet-changed', (ev) => {
    const detail = ev?.detail;
    if (!detail) return;
    if (detail.family === 'evm') {
      state.approvalSeq += 1;
      state.approvalScan = null;
      state.revokedKeys.clear();
      state.approvalLastResult = null;
      state.approvalError = null;
      state.approvalLoading = false;
      if (detail.action === 'disconnect' || !detail.address) {
        state.latestScanReport = null;
      }
      renderApprovalRevokerCard();
      updateSectionSummaryBadges();
    } else if (detail.family === 'solana') {
      state.rentSeq += 1;
      state.yieldSeq += 1;
      state.dustSeq += 1;
      state.rentScan = null;
      state.rentLastTx = null;
      state.rentError = null;
      state.rentLoading = false;
      state.yieldPlan = null;
      state.yieldLastTx = null;
      state.yieldError = null;
      state.yieldLoading = false;
      state.dustScan = null;
      state.dustLastResult = null;
      state.dustError = null;
      state.dustLoading = false;
      state.dustSweepingKey = null;
      state.sweptDustAccounts.clear();
      if (detail.action === 'disconnect' || !detail.address) {
        state.yieldAmountUsdc = 100;
        state.userEditedYieldAmount = false;
        if (!state.userEditedRentOwner) {
          const rentIn = document.getElementById('rentOwnerInput');
          if (rentIn) rentIn.value = '';
        }
      } else if (!state.userEditedRentOwner) {
        const rentIn = document.getElementById('rentOwnerInput');
        if (rentIn) rentIn.value = detail.address;
      }
      renderRentVacuumCard();
      renderSplDustCard();
      renderYieldParkCard();
      updateSectionSummaryBadges();
    }
  });

  window.addEventListener('turgalium:scan-cleared', () => {
    state.latestScanReport = null;
    renderApprovalRevokerCard();
    updateSectionSummaryBadges();
  });

  // Sync with Turgalium app balance / wallet updates
  window.addEventListener('turgalium:balance-updated', (ev) => {
    const detail = ev?.detail || {};
    state.balanceDetail = detail;
    if (!state.userEditedYieldAmount) {
      const solUsdc = Number(detail.solanaUsdc) || 0;
      const projUsdc = Number(detail.projectedSweepUsdc) || 0;
      if (solUsdc > 0) {
        state.yieldAmountUsdc = Number(solUsdc.toFixed(2));
      } else if (projUsdc > 0) {
        state.yieldAmountUsdc = Number(projUsdc.toFixed(2));
      }
    }
    renderRentVacuumCard();
    renderSplDustCard();
    renderYieldParkCard();
    renderApprovalRevokerCard();
    updateSectionSummaryBadges();
  });

  window.addEventListener('turgalium:scan-updated', (ev) => {
    const scanReport = ev?.detail?.scanReport || ev?.detail?.scan;
    if (!scanReport) return;
    state.latestScanReport = scanReport;
    const bestChain = pickBestApprovalChainFromScan(scanReport);
    if (bestChain) {
      state.selectedApprovalChain = bestChain;
    }
    renderApprovalRevokerCard();
    updateSectionSummaryBadges();
  });

  // Hydrate SPL dust + live yield strategies in 1 request from POST /api/solana/overview or /api/workspace/hydrate
  window.addEventListener('turgalium:solana-overview', (ev) => {
    const overview = ev?.detail;
    if (!overview || typeof overview !== 'object') return;
    if (Array.isArray(overview.yieldStrategies) && overview.yieldStrategies.length > 0) {
      state.strategies = overview.yieldStrategies;
      state.strategiesLoaded = true;
      populateYieldStrategySelect();
    }
    if (overview.dust && typeof overview.dust === 'object') {
      state.dustSeq += 1;
      state.dustScan = overview.dust;
      state.dustError = null;
      state.dustLoading = false;
      state.sweptDustAccounts.clear();
    }
    if (
      overview.balances &&
      !state.userEditedYieldAmount &&
      Number(overview.balances.usdcBalance) > 0
    ) {
      state.yieldAmountUsdc = Number(Number(overview.balances.usdcBalance).toFixed(2));
    }
    renderRentVacuumCard();
    renderSplDustCard();
    renderYieldParkCard();
    updateSectionSummaryBadges();
  });

  ensureSplDustCard();
  renderRentVacuumCard();
  renderSplDustCard();
  renderYieldParkCard();
  renderApprovalRevokerCard();
  updateSectionSummaryBadges();
  if (!state.strategiesLoaded) {
    loadSolanaYieldStrategies();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindEvents);
} else {
  bindEvents();
}

window.__turgaliumPreservationTools = {
  getState: () => ({
    rentScan: state.rentScan,
    dustScan: state.dustScan,
    yieldPlan: state.yieldPlan,
    approvalScan: state.approvalScan,
    strategies: state.strategies,
    selectedApprovalChain: state.selectedApprovalChain,
  }),
  runSolanaRentScan,
  runSolanaSplDustScan,
  runYieldParkRequest,
  runApprovalScan,
};
