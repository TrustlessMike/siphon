/**
 * Siphon Capital-Preservation & Post-Arrival Solana Tools Module:
 *  1. 1-Click Reclaim Free SOL (Empty-ATA Rent Vacuum) -> POST /api/solana/rent-scan
 *  2. 1-Click Post-Arrival Solana Yield Park (90% Safe Compound) -> GET /api/solana/yield-strategies + POST /api/solana/yield-park
 *  3. 1-Click Stale ERC-20 Approval Revoker -> POST /api/approvals/scan + EIP-5792 / sequential revoke
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
} from './wallets.js?v=7';

const SUPPORTED_APPROVAL_CHAINS = [
  { id: 'ethereum', label: 'Ethereum', explorer: 'https://etherscan.io/tx/' },
  { id: 'base', label: 'Base', explorer: 'https://basescan.org/tx/' },
  { id: 'arbitrum', label: 'Arbitrum', explorer: 'https://arbiscan.io/tx/' },
  { id: 'optimism', label: 'Optimism', explorer: 'https://optimistic.etherscan.io/tx/' },
  { id: 'polygon', label: 'Polygon', explorer: 'https://polygonscan.com/tx/' },
  { id: 'avalanche', label: 'Avalanche', explorer: 'https://snowtrace.io/tx/' },
  { id: 'bnb', label: 'BNB Chain', explorer: 'https://bscscan.com/tx/' },
];

const state = {
  // Rent Vacuum
  rentScan: null,
  rentLoading: false,
  rentError: null,
  rentSigning: false,
  rentLastTx: null, // { signature, explorerUrl, count, reclaimedSol }

  // Yield Park
  strategies: [],
  strategiesLoaded: false,
  selectedStrategyId: 'jupsol',
  preservePct: 90,
  yieldAmountUsdc: 100,
  userEditedYieldAmount: false,
  yieldPlan: null,
  yieldLoading: false,
  yieldError: null,
  yieldSigning: false,
  yieldLastTx: null, // { signature, explorerUrl, strategyName, yieldUsdc }

  // Stale Approval Revoker
  selectedApprovalChain: 'ethereum',
  approvalScan: null,
  approvalLoading: false,
  approvalError: null,
  revokingKey: null, // 'all' | findingKey
  revokedKeys: new Set(),
  approvalLastResult: null, // { mode, count, txHashes, batchId }

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

function safeHttpsUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('//')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
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
      yieldBadge.textContent = `${state.preservePct}% Yield · ~${Number(apy).toFixed(1)}% APY`;
      yieldBadge.classList.add('is-active');
    } else {
      yieldBadge.textContent = '90% Safe Compound';
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
}

// =========================================================================
// 1. EMPTY-ATA RENT VACUUM (1-CLICK RECLAIM FREE SOL)
// =========================================================================

async function runSolanaRentScan({ silent = false } = {}) {
  const ownerAddress = resolveSolanaAddress();
  if (!ownerAddress) {
    if (!silent) {
      state.rentError = 'Connect a Solana wallet or enter a Solana address to scan empty ATAs.';
      renderRentVacuumCard();
      document.getElementById('rentOwnerInput')?.focus();
    }
    return;
  }

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
    state.rentScan = data;
    state.rentLastTx = null;
  } catch (err) {
    if (!silent) {
      state.rentError = err instanceof Error ? err.message : 'Failed to scan Solana rent.';
    }
  } finally {
    state.rentLoading = false;
    renderRentVacuumCard();
    updateSectionSummaryBadges();
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
    await runSolanaRentScan({ silent: false });
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
      autoConnect: false,
    });
    const closedCount = Number(scan.unsignedCloseTx?.accountCount || scan.reclaimableCount || 0);
    const reclaimedSol = Number(scan.unsignedCloseTx?.reclaimedSol || scan.reclaimableSol || 0);
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
  const activeSol = resolveSolanaAddress();
  if (inputEl && document.activeElement !== inputEl && activeSol && inputEl.value !== activeSol) {
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
    const linkHref = safeHttpsUrl(state.rentLastTx.explorerUrl);
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
// 2. POST-ARRIVAL SOLANA YIELD PARK (90% SAFE COMPOUND)
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
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    state.yieldError = 'Enter a positive USDC amount to park in yield.';
    renderYieldParkCard();
    return null;
  }
  state.yieldAmountUsdc = parsedAmount;

  if (buildTransaction && !connectedSol) {
    showToast('Connect your Solana wallet to sign & park yield.');
    document.getElementById('connectSolBtn')?.click();
    return null;
  }

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
        preservePct: state.preservePct,
        strategy: state.selectedStrategyId,
        buildTransaction,
      }),
    });
    state.yieldPlan = plan;

    if (buildTransaction) {
      const txB64 = plan?.transaction?.swapTransactionBase64;
      if (txB64) {
        const res = await signAndSendSolanaVersionedTx(txB64, {
          expectedFeePayer: connectedSol,
          autoConnect: false,
        });
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
        const vaultUrl = safeHttpsUrl(plan?.strategy?.appUrl);
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
    state.yieldError = isUserRejectedError(err)
      ? 'Signature rejected in Solana wallet. Yield park cancelled.'
      : err instanceof Error
      ? err.message
      : 'Failed to build Solana yield park plan.';
    return null;
  } finally {
    state.yieldLoading = false;
    state.yieldSigning = false;
    renderYieldParkCard();
    updateSectionSummaryBadges();
  }
}

function renderYieldParkCard() {
  const host = document.getElementById('yieldParkBody');
  const badge = document.getElementById('yieldApyBadge');
  const amountInput = document.getElementById('yieldAmountInput');
  const previewBtn = document.getElementById('previewYieldBtn');
  if (!host) return;

  if (amountInput && document.activeElement !== amountInput) {
    const formatted = Number(state.yieldAmountUsdc.toFixed(2));
    if (Number(amountInput.value) !== formatted) {
      amountInput.value = String(formatted);
    }
  }

  document.querySelectorAll('[data-yield-split]').forEach((btn) => {
    const pct = Number(btn.getAttribute('data-yield-split'));
    btn.classList.toggle('active', pct === state.preservePct);
  });

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
          `Split ready (${fmtUsd(state.yieldLastTx.yieldUsdc)} → ${state.yieldLastTx.strategyName}) · `
        )
      );
      const a = el('a', 'ptool-link mono', 'Open Protocol Vault ↗');
      a.href = state.yieldLastTx.explorerUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      okBox.appendChild(a);
    } else {
      okBox.appendChild(
        el(
          'span',
          '',
          `Parked ${fmtUsd(state.yieldLastTx.yieldUsdc)} in ${state.yieldLastTx.strategyName} · `
        )
      );
      const href = safeHttpsUrl(state.yieldLastTx.explorerUrl);
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

  // Compute live split preview even before server round-trip
  const totalUsdc = Math.max(0, Number(state.yieldAmountUsdc) || 0);
  const yieldUsdc = plan?.split?.yieldUsdc ?? Number(((totalUsdc * state.preservePct) / 100).toFixed(2));
  const degenUsdc =
    plan?.split?.degenSidePocketUsdc ?? Number(Math.max(0, totalUsdc - yieldUsdc).toFixed(2));
  const annualUsd =
    plan?.projections?.projectedAnnualYieldUsd ??
    Number(((yieldUsdc * Number(apyPct)) / 100).toFixed(2));
  const monthlyUsd =
    plan?.projections?.projectedMonthlyYieldUsd ?? Number((annualUsd / 12).toFixed(2));

  const kpis = el('div', 'ptool-kpi-grid');
  const k1 = el('div', 'ptool-kpi');
  k1.appendChild(el('span', 'ptool-kpi-label', `Yield (${state.preservePct}%)`));
  k1.appendChild(el('strong', 'ptool-kpi-val mono is-emerald', fmtUsd(yieldUsdc)));
  kpis.appendChild(k1);

  const k2 = el('div', 'ptool-kpi');
  k2.appendChild(el('span', 'ptool-kpi-label', 'Est. Annual'));
  k2.appendChild(el('strong', 'ptool-kpi-val mono', `+${fmtUsd(annualUsd)}/yr`));
  kpis.appendChild(k2);

  const k3 = el('div', 'ptool-kpi');
  k3.appendChild(el('span', 'ptool-kpi-label', `Side-Pocket (${100 - state.preservePct}%)`));
  k3.appendChild(el('strong', 'ptool-kpi-val mono', fmtUsd(degenUsdc)));
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
    state.approvalScan = data;
    state.revokedKeys.clear();
  } catch (err) {
    if (!silent) {
      state.approvalError =
        err instanceof Error ? err.message : 'Failed to scan stale ERC-20 approvals.';
    }
  } finally {
    state.approvalLoading = false;
    renderApprovalRevokerCard();
    updateSectionSummaryBadges();
  }
}

async function handleRevokeFindings(findingsToRevoke, keyLabel) {
  const connectedEvm = getConnectedEvmAddress();
  if (!connectedEvm) {
    showToast('Read-only scan — connect your EVM wallet to sign ERC-20 revocations.');
    document.getElementById('connectEvmBtn')?.click();
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

    for (const f of valid) {
      state.revokedKeys.add(findingKey(f));
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
    state.approvalError = isUserRejectedError(err)
      ? 'Signature rejected in EVM wallet. No approvals were changed.'
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
      const href = safeHttpsUrl(`${getChainExplorerPrefix(r.chain)}${encodeURIComponent(r.txHashes[0])}`);
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
      `btn-row-exec ptool-row-btn${isRevoked ? ' is-done' : ''}`,
      isRevoked ? 'Revoked ✓' : isBusy ? 'Signing…' : 'Revoke'
    );
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
      toggleBtn.textContent = collapsed ? 'Show Tools ▾' : 'Hide Tools ▴';
    });
  }

  document.getElementById('scanSolanaRentBtn')?.addEventListener('click', () => {
    runSolanaRentScan({ silent: false });
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

  document.querySelectorAll('[data-yield-split]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pct = Number(btn.getAttribute('data-yield-split'));
      if (pct === 90 || pct === 100) {
        state.preservePct = pct;
        state.yieldPlan = null;
        renderYieldParkCard();
        updateSectionSummaryBadges();
      }
    });
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

  // Sync with Siphon app balance / wallet updates
  window.addEventListener('siphon:balance-updated', (ev) => {
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
    renderYieldParkCard();
    renderApprovalRevokerCard();
    updateSectionSummaryBadges();
  });

  window.addEventListener('siphon:scan-updated', (ev) => {
    const scanReport = ev?.detail?.scanReport;
    if (!scanReport) return;
    state.latestScanReport = scanReport;
    const bestChain = pickBestApprovalChainFromScan(scanReport);
    if (bestChain) {
      state.selectedApprovalChain = bestChain;
    }
    renderApprovalRevokerCard();
    updateSectionSummaryBadges();
  });

  renderRentVacuumCard();
  renderYieldParkCard();
  renderApprovalRevokerCard();
  updateSectionSummaryBadges();
  loadSolanaYieldStrategies();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindEvents);
} else {
  bindEvents();
}

window.__siphonPreservationTools = {
  getState: () => ({
    rentScan: state.rentScan,
    yieldPlan: state.yieldPlan,
    approvalScan: state.approvalScan,
    strategies: state.strategies,
    selectedApprovalChain: state.selectedApprovalChain,
  }),
  runSolanaRentScan,
  runYieldParkRequest,
  runApprovalScan,
};
