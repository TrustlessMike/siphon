/**
 * Real Browser Wallet Connectors for Siphon:
 *  - EVM: EIP-6963 multi-wallet discovery + window.ethereum (MetaMask, Rabby, Phantom EVM, Coinbase Wallet)
 *  - Solana: Phantom (window.phantom.solana), Backpack (window.backpack), Solflare (window.solflare), window.solana
 */

const CHAIN_ADD_PARAMS = {
  1: {
    chainId: '0x1',
    chainName: 'Ethereum Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://ethereum-rpc.publicnode.com'],
    blockExplorerUrls: ['https://etherscan.io'],
  },
  8453: {
    chainId: '0x2105',
    chainName: 'Base',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://base-rpc.publicnode.com'],
    blockExplorerUrls: ['https://basescan.org'],
  },
  42161: {
    chainId: '0xa4b1',
    chainName: 'Arbitrum One',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://arbitrum-one-rpc.publicnode.com'],
    blockExplorerUrls: ['https://arbiscan.io'],
  },
  10: {
    chainId: '0xa',
    chainName: 'OP Mainnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://optimism-rpc.publicnode.com'],
    blockExplorerUrls: ['https://optimistic.etherscan.io'],
  },
  137: {
    chainId: '0x89',
    chainName: 'Polygon PoS',
    nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
    rpcUrls: ['https://1rpc.io/matic'],
    blockExplorerUrls: ['https://polygonscan.com'],
  },
  43114: {
    chainId: '0xa86a',
    chainName: 'Avalanche C-Chain',
    nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
    rpcUrls: ['https://avalanche-c-chain-rpc.publicnode.com'],
    blockExplorerUrls: ['https://snowtrace.io'],
  },
};

const SUPPORTED_CHAIN_IDS = [1, 8453, 42161, 10, 137, 43114];

const discoveredEvmProviders = [];
const discoveredSolanaStandardWallets = [];
const discoveryListeners = new Set();
let activeEvmProvider = null;

function notifyWalletDiscovery() {
  for (const fn of discoveryListeners) {
    try {
      fn();
    } catch {
      // ignore listener errors
    }
  }
}

export function subscribeWalletDiscovery(listener) {
  if (typeof listener !== 'function') return () => {};
  discoveryListeners.add(listener);
  return () => discoveryListeners.delete(listener);
}
let connectedEvmAddress = null;
let connectedWalletName = null;
let connectedSolanaAddress = null;
let connectedSolanaWalletName = null;
let cachedBatchCapabilities = {
  probed: false,
  anySupported: false,
  anyPaymaster: false,
  supportedChains: [],
  details: {},
  modeLabel: 'EIP-5792 Ready (connect MetaMask, Rabby, Coinbase, or Phantom)',
};
let walletSdkConfig = {
  coinbaseSmartWalletEnabled: true,
  walletConnectProjectId: null,
};
let cachedSdkModule = null;

async function loadWalletSdkBundle() {
  if (cachedSdkModule) return cachedSdkModule;
  cachedSdkModule = await import('/vendor/wallet-sdks.js');
  return cachedSdkModule;
}

export async function loadWalletConnectorConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      walletSdkConfig = await res.json();
    }
  } catch {
    // keep defaults
  }
  return walletSdkConfig;
}

export function getWalletConnectorConfig() {
  return walletSdkConfig;
}

function registerStandardWallet(wallet) {
  if (!wallet || typeof wallet !== 'object') return;
  const chains = Array.isArray(wallet.chains) ? wallet.chains : [];
  const isSolana = chains.some((c) => String(c).startsWith('solana:'));
  const hasConnect = Boolean(wallet.features?.['standard:connect']?.connect);
  if (!isSolana || !hasConnect) return;
  const key = wallet.name || 'Solana Wallet';
  if (!discoveredSolanaStandardWallets.some((w) => w.name === key)) {
    discoveredSolanaStandardWallets.push({
      id: `std:${key.toLowerCase().replace(/\s+/g, '-')}`,
      name: key,
      icon: wallet.icon || null,
      standard: true,
      wallet,
    });
    notifyWalletDiscovery();
  }
}

if (typeof window !== 'undefined') {
  // EVM EIP-6963 multi-wallet discovery
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = event.detail;
    if (detail?.provider && !discoveredEvmProviders.some((p) => p.info?.uuid === detail.info?.uuid)) {
      discoveredEvmProviders.push(detail);
      notifyWalletDiscovery();
    }
  });
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch {
    // non-browser context
  }

  // Solana W3C Wallet Standard discovery (Phantom, Backpack, Solflare, Jupiter, Glow, Ledger, OKX, Coinbase)
  window.addEventListener('wallet-standard:register-wallet', (event) => {
    const registerCb = event.detail;
    if (typeof registerCb === 'function') {
      try {
        registerCb({ register: (...wallets) => wallets.forEach(registerStandardWallet) });
      } catch {
        // ignore malformed wallet registration
      }
    }
  });
  try {
    window.dispatchEvent(
      new CustomEvent('wallet-standard:app-ready', {
        detail: { register: (...wallets) => wallets.forEach(registerStandardWallet) },
      })
    );
  } catch {
    // non-browser context
  }
}

export function getConnectedEvmAddress() {
  return connectedEvmAddress;
}

export function getConnectedWalletName() {
  return connectedWalletName;
}

export function getConnectedSolanaAddress() {
  return connectedSolanaAddress;
}

export function getConnectedSolanaWalletName() {
  return connectedSolanaWalletName;
}

export function disconnectEvmWallet() {
  activeEvmProvider = null;
  connectedEvmAddress = null;
  connectedWalletName = null;
  cachedBatchCapabilities = {
    probed: false,
    anySupported: false,
    anyPaymaster: false,
    supportedChains: [],
    details: {},
    modeLabel: 'EIP-5792 Ready (connect MetaMask, Rabby, Coinbase, or Phantom)',
  };
}

export function disconnectSolanaWallet() {
  connectedSolanaAddress = null;
  connectedSolanaWalletName = null;
}

export function getWalletBatchCapabilities() {
  return cachedBatchCapabilities;
}

export function isChainBatchSupported(chainId) {
  const entry = cachedBatchCapabilities.details[Number(chainId)];
  return entry || { supported: false, status: 'unknown', paymaster: false };
}

function parseCapabilitiesResponse(raw, chainIds) {
  const details = {};
  const supportedChains = [];
  let anyPaymaster = false;

  if (raw && typeof raw === 'object') {
    const wildcard = raw['0x0'] || raw['0x00'];
    for (const id of chainIds) {
      const hex = '0x' + Number(id).toString(16);
      const entry = raw[hex] || raw[hex.toLowerCase()] || raw[String(id)] || wildcard || null;
      const atomicStatus = entry?.atomic?.status;
      const supported =
        atomicStatus === 'supported' ||
        atomicStatus === 'ready' ||
        entry?.atomicBatch?.supported === true;
      const paymaster = Boolean(entry?.paymasterService?.supported);
      if (supported) supportedChains.push(id);
      if (paymaster) anyPaymaster = true;
      details[id] = {
        supported,
        status: atomicStatus || (supported ? 'supported' : 'unsupported'),
        paymaster,
      };
    }
  }

  const anySupported = supportedChains.length > 0;
  return {
    probed: true,
    anySupported,
    anyPaymaster,
    supportedChains,
    details,
    modeLabel: anySupported
      ? `EIP-5792 Atomic Batch Armed (${supportedChains.length}/${chainIds.length} chains · 1 Click / Chain${anyPaymaster ? ' + Paymaster' : ''})`
      : 'Legacy Sequential Fallback (wallet does not advertise EIP-5792)',
  };
}

/**
 * Probes the connected EVM wallet for EIP-5792 / EIP-7702 atomic batch capabilities
 * via `wallet_getCapabilities`. Gracefully handles wallets that do not implement it.
 */
export async function detectWalletBatchCapabilities(address = connectedEvmAddress, chainIds = SUPPORTED_CHAIN_IDS) {
  if (!activeEvmProvider || !address) {
    cachedBatchCapabilities = {
      probed: false,
      anySupported: false,
      anyPaymaster: false,
      supportedChains: [],
      details: {},
      modeLabel: 'EIP-5792 Ready (connect MetaMask, Rabby, Coinbase, or Phantom)',
    };
    return cachedBatchCapabilities;
  }

  const hexChainIds = chainIds.map((id) => '0x' + Number(id).toString(16));
  try {
    const raw = await activeEvmProvider.request({
      method: 'wallet_getCapabilities',
      params: [address, hexChainIds],
    });
    cachedBatchCapabilities = parseCapabilitiesResponse(raw, chainIds);
    return cachedBatchCapabilities;
  } catch {
    // Fallback to EIP-5792 v1 1-arg form: wallet_getCapabilities([address])
    try {
      const rawV1 = await activeEvmProvider.request({
        method: 'wallet_getCapabilities',
        params: [address],
      });
      cachedBatchCapabilities = parseCapabilitiesResponse(rawV1, chainIds);
      return cachedBatchCapabilities;
    } catch {
      cachedBatchCapabilities = parseCapabilitiesResponse(null, chainIds);
      return cachedBatchCapabilities;
    }
  }
}

export function refreshInstalledWallets() {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(
      new CustomEvent('wallet-standard:app-ready', {
        detail: { register: (...wallets) => wallets.forEach(registerStandardWallet) },
      })
    );
  } catch {
    // ignore
  }
}

function inferInjectedEvmName(prov) {
  if (prov?.isRabby) return 'Rabby Wallet';
  if (prov?.isPhantom) return 'Phantom EVM';
  if (prov?.isCoinbaseWallet) return 'Coinbase Wallet';
  if (prov?.isBraveWallet) return 'Brave Wallet';
  if (prov?.isOkxWallet || prov?.isOKExWallet) return 'OKX Wallet';
  if (prov?.isTrust || prov?.isTrustWallet) return 'Trust Wallet';
  if (prov?.isMetaMask) return 'MetaMask';
  return 'Browser EVM Wallet';
}

export function listAvailableEvmWallets() {
  const list = [];
  const seenProviders = new Set();
  const seenNames = new Set();

  for (let idx = 0; idx < discoveredEvmProviders.length; idx++) {
    const d = discoveredEvmProviders[idx];
    if (!d?.provider || seenProviders.has(d.provider)) continue;
    seenProviders.add(d.provider);
    const name = d.info?.name || 'EVM Wallet';
    seenNames.add(name.toLowerCase());
    list.push({
      id: d.info?.uuid || d.info?.rdns || `eip6963-${idx}`,
      name,
      rdns: d.info?.rdns || 'eip6963',
      icon: d.info?.icon || null,
      standard: 'EIP-6963',
      provider: d.provider,
    });
  }

  if (typeof window !== 'undefined') {
    const injectedCandidates = [];
    if (Array.isArray(window.ethereum?.providers)) {
      for (const p of window.ethereum.providers) injectedCandidates.push({ prov: p, fallbackName: null });
    } else if (window.ethereum) {
      injectedCandidates.push({ prov: window.ethereum, fallbackName: null });
    }
    if (window.phantom?.ethereum) injectedCandidates.push({ prov: window.phantom.ethereum, fallbackName: 'Phantom EVM' });
    if (window.okxwallet) injectedCandidates.push({ prov: window.okxwallet, fallbackName: 'OKX Wallet' });
    if (window.trustwallet) injectedCandidates.push({ prov: window.trustwallet, fallbackName: 'Trust Wallet' });

    injectedCandidates.forEach(({ prov, fallbackName }, idx) => {
      if (!prov || typeof prov.request !== 'function' || seenProviders.has(prov)) return;
      const name = fallbackName || inferInjectedEvmName(prov);
      if (seenNames.has(name.toLowerCase())) return;
      seenProviders.add(prov);
      seenNames.add(name.toLowerCase());
      list.push({
        id: `injected-${idx}-${name.toLowerCase().replace(/\s+/g, '-')}`,
        name,
        rdns: 'injected',
        icon: null,
        standard: 'Extension',
        provider: prov,
      });
    });
  }

  return list;
}

export async function connectEvmWallet(optionsOrCallback) {
  const opts =
    typeof optionsOrCallback === 'function'
      ? { onAccountsChanged: optionsOrCallback }
      : optionsOrCallback || {};
  const wallets = listAvailableEvmWallets();
  if (!wallets.length) {
    throw new Error(
      'No EVM browser wallet detected. Install MetaMask, Rabby, Coinbase Wallet, or Phantom (EVM) to sign live batches.'
    );
  }
  const chosen =
    (opts.walletId ? wallets.find((w) => w.id === opts.walletId) : null) || wallets[0];
  activeEvmProvider = chosen.provider;
  const accounts = await activeEvmProvider.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts[0]) {
    throw new Error('Wallet connection was cancelled.');
  }
  connectedEvmAddress = accounts[0];
  connectedWalletName = chosen.name;

  const capabilities = await detectWalletBatchCapabilities(connectedEvmAddress);

  activeEvmProvider.on?.('accountsChanged', async (nextAccounts) => {
    connectedEvmAddress = nextAccounts?.[0] ?? null;
    await detectWalletBatchCapabilities(connectedEvmAddress);
    opts.onAccountsChanged?.(connectedEvmAddress);
  });

  activeEvmProvider.on?.('chainChanged', async () => {
    if (connectedEvmAddress) {
      await detectWalletBatchCapabilities(connectedEvmAddress);
      opts.onChainChanged?.();
    }
  });

  return { address: connectedEvmAddress, walletName: chosen.name, capabilities };
}

/**
 * Connects via Coinbase Smart Wallet (keys.coinbase.com passkey / popup) —
 * works in ANY browser with zero extension installed and native EIP-5792 batching.
 */
export async function connectCoinbaseSmartWallet(callbacks = {}) {
  const { createCoinbaseWalletSDK } = await loadWalletSdkBundle();
  const sdk = createCoinbaseWalletSDK({
    appName: 'Siphon',
    appChainIds: SUPPORTED_CHAIN_IDS,
    preference: { options: 'all' },
  });
  const provider = sdk.getProvider();
  activeEvmProvider = provider;
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts[0]) {
    throw new Error('Coinbase Wallet connection was cancelled.');
  }
  connectedEvmAddress = accounts[0];
  connectedWalletName = 'Coinbase Wallet';
  const capabilities = await detectWalletBatchCapabilities(connectedEvmAddress);

  provider.on?.('accountsChanged', async (nextAccounts) => {
    connectedEvmAddress = nextAccounts?.[0] ?? null;
    await detectWalletBatchCapabilities(connectedEvmAddress);
    callbacks.onAccountsChanged?.(connectedEvmAddress);
  });
  provider.on?.('chainChanged', async () => {
    if (connectedEvmAddress) {
      await detectWalletBatchCapabilities(connectedEvmAddress);
      callbacks.onChainChanged?.();
    }
  });

  return { address: connectedEvmAddress, walletName: 'Coinbase Wallet', capabilities };
}

/**
 * Connects mobile or hardware wallets via WalletConnect v2 QR modal
 * when WALLETCONNECT_PROJECT_ID is configured on the server.
 */
export async function connectWalletConnect(callbacks = {}) {
  const cfg = walletSdkConfig.walletConnectProjectId
    ? walletSdkConfig
    : await loadWalletConnectorConfig();
  const projectId = callbacks.projectId?.trim() || cfg.walletConnectProjectId;
  if (!projectId) {
    throw new Error(
      'WalletConnect QR requires WALLETCONNECT_PROJECT_ID on the server (free at cloud.reown.com).'
    );
  }
  const { EthereumProvider } = await loadWalletSdkBundle();
  const provider = await EthereumProvider.init({
    projectId,
    chains: [1],
    optionalChains: [8453, 42161, 10, 137, 43114],
    showQrModal: true,
    metadata: {
      name: 'Siphon',
      description: 'Move fragmented EVM positions and tokens to Solana.',
      url: window.location.origin,
      icons: [],
    },
  });
  await provider.connect();
  activeEvmProvider = provider;
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts[0]) {
    throw new Error('WalletConnect session cancelled.');
  }
  connectedEvmAddress = accounts[0];
  connectedWalletName = 'WalletConnect';
  const capabilities = await detectWalletBatchCapabilities(connectedEvmAddress);

  provider.on?.('accountsChanged', async (nextAccounts) => {
    connectedEvmAddress = nextAccounts?.[0] ?? null;
    await detectWalletBatchCapabilities(connectedEvmAddress);
    callbacks.onAccountsChanged?.(connectedEvmAddress);
  });
  provider.on?.('disconnect', () => {
    disconnectEvmWallet();
    callbacks.onAccountsChanged?.(null);
  });

  return { address: connectedEvmAddress, walletName: 'WalletConnect', capabilities };
}

export async function ensureEvmChain(chainId) {
  if (!activeEvmProvider) {
    throw new Error('Connect an EVM wallet first.');
  }
  const hexChainId = '0x' + Number(chainId).toString(16);
  const currentHex = await activeEvmProvider.request({ method: 'eth_chainId' });
  if (String(currentHex).toLowerCase() === hexChainId.toLowerCase()) return;

  try {
    await activeEvmProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    });
  } catch (err) {
    if (err?.code === 4902 && CHAIN_ADD_PARAMS[chainId]) {
      await activeEvmProvider.request({
        method: 'wallet_addEthereumChain',
        params: [CHAIN_ADD_PARAMS[chainId]],
      });
    } else {
      throw err;
    }
  }
}

export async function sendRealEvmTransaction(tx) {
  if (!activeEvmProvider || !connectedEvmAddress) {
    throw new Error('Connect your EVM wallet before signing live transactions.');
  }
  await ensureEvmChain(tx.chainId);

  const txParams = {
    from: connectedEvmAddress,
    to: tx.to,
    data: tx.data,
    value: tx.value || '0x0',
  };
  if (tx.gas) txParams.gas = tx.gas;

  const txHash = await activeEvmProvider.request({
    method: 'eth_sendTransaction',
    params: [txParams],
  });
  return txHash;
}

/**
 * Submits ALL calls on a single EVM chain in ONE wallet confirmation popup via EIP-5792 `wallet_sendCalls`.
 * Supports both EIP-5792 v2 (`version: "2.0.0"`, `atomicRequired: false`) and v1 (`version: "1.0"`).
 * Throws an Error with `err.unsupportedEip5792 = true` if the wallet lacks EIP-5792 so callers can fall back seamlessly.
 */
export async function sendEip5792Batch({ chainId, calls }) {
  if (!activeEvmProvider || !connectedEvmAddress) {
    throw new Error('Connect your EVM wallet before signing live batches.');
  }
  if (!Array.isArray(calls) || !calls.length) {
    throw new Error('No calls prepared for this chain batch.');
  }

  await ensureEvmChain(chainId);
  const hexChainId = '0x' + Number(chainId).toString(16);
  const formattedCalls = calls.map((c) => ({
    to: c.to,
    data: c.data,
    value: c.value || '0x0',
  }));

  const isUnsupportedErr = (err) => {
    const code = err?.code;
    const msg = String(err?.message || '').toLowerCase();
    return (
      code === -32601 ||
      code === 4200 ||
      msg.includes('method not found') ||
      msg.includes('does not exist') ||
      msg.includes('unsupported method') ||
      msg.includes('wallet_sendcalls')
    );
  };

  try {
    const res = await activeEvmProvider.request({
      method: 'wallet_sendCalls',
      params: [
        {
          version: '2.0.0',
          chainId: hexChainId,
          from: connectedEvmAddress,
          atomicRequired: false,
          calls: formattedCalls,
        },
      ],
    });
    const batchId = typeof res === 'string' ? res : res?.id;
    if (!batchId) throw new Error('Wallet returned empty EIP-5792 batch ID.');
    return { mode: 'eip5792', batchId, version: '2.0.0' };
  } catch (err) {
    if (err?.code === 4001) throw err; // User rejected
    if (isUnsupportedErr(err)) {
      const wrapped = new Error('Connected wallet does not support EIP-5792 wallet_sendCalls.');
      wrapped.unsupportedEip5792 = true;
      throw wrapped;
    }

    // Retry once with EIP-5792 v1 schema (`version: '1.0'`, no `atomicRequired`)
    try {
      const resV1 = await activeEvmProvider.request({
        method: 'wallet_sendCalls',
        params: [
          {
            version: '1.0',
            chainId: hexChainId,
            from: connectedEvmAddress,
            calls: formattedCalls,
          },
        ],
      });
      const batchId = typeof resV1 === 'string' ? resV1 : resV1?.id;
      if (!batchId) throw new Error('Wallet returned empty EIP-5792 batch ID.');
      return { mode: 'eip5792', batchId, version: '1.0' };
    } catch (errV1) {
      if (errV1?.code === 4001) throw errV1;
      if (isUnsupportedErr(errV1)) {
        const wrapped = new Error('Connected wallet does not support EIP-5792 wallet_sendCalls.');
        wrapped.unsupportedEip5792 = true;
        throw wrapped;
      }
      throw errV1;
    }
  }
}

/**
 * Polls EIP-5792 `wallet_getCallsStatus` until the atomic batch confirms or fails,
 * returning all onchain `receipts[].transactionHash` entries.
 */
export async function waitForEip5792Batch(batchId, onUpdate) {
  if (!activeEvmProvider) throw new Error('Wallet disconnected.');

  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await activeEvmProvider.request({
        method: 'wallet_getCallsStatus',
        params: [batchId],
      });
      const status = res?.status;
      const receipts = Array.isArray(res?.receipts) ? res.receipts : [];
      const txHashes = Array.from(
        new Set(receipts.map((r) => r?.transactionHash).filter(Boolean))
      );

      onUpdate?.({ status, txHashes, raw: res });

      // EIP-5792 v2 numeric codes (200 = confirmed, >= 400 = failed) + v1 strings
      const isConfirmed = status === 200 || status === 'CONFIRMED';
      const isFailed =
        (typeof status === 'number' && status >= 400) ||
        status === 'FAILED' ||
        status === 'REVERTED';

      if (isConfirmed) {
        return { confirmed: true, failed: false, status, txHashes, raw: res };
      }
      if (isFailed) {
        return { confirmed: false, failed: true, status, txHashes, raw: res };
      }
    } catch {
      // Keep polling briefly while wallet indexes bundle
    }
  }

  return { confirmed: false, failed: false, status: 'TIMEOUT', txHashes: [] };
}

export function listAvailableSolanaWallets() {
  const list = [];
  const seen = new Set();

  for (const w of discoveredSolanaStandardWallets) {
    seen.add(w.name.toLowerCase());
    list.push({
      id: w.id,
      name: w.name,
      icon: w.icon,
      standard: 'Wallet Standard',
      kind: 'standard',
      wallet: w.wallet,
    });
  }

  if (typeof window !== 'undefined') {
    const legacyCandidates = [
      { id: 'legacy-phantom', name: 'Phantom', provider: window.phantom?.solana },
      { id: 'legacy-backpack', name: 'Backpack', provider: window.backpack?.solana || window.backpack },
      { id: 'legacy-solflare', name: 'Solflare', provider: window.solflare },
      { id: 'legacy-okx', name: 'OKX Solana', provider: window.okxwallet?.solana },
      { id: 'legacy-coinbase', name: 'Coinbase Solana', provider: window.coinbaseSolana },
      { id: 'legacy-glow', name: 'Glow', provider: window.glow },
    ];
    for (const c of legacyCandidates) {
      if (c.provider && typeof c.provider.connect === 'function' && !seen.has(c.name.toLowerCase())) {
        seen.add(c.name.toLowerCase());
        list.push({
          id: c.id,
          name: c.name,
          icon: null,
          standard: 'Extension',
          kind: 'legacy',
          provider: c.provider,
        });
      }
    }
    if (!list.length && (window.solana?.isPhantom || window.solana?.connect)) {
      list.push({
        id: 'legacy-solana',
        name: window.solana.isPhantom ? 'Phantom' : 'Solana Wallet',
        icon: null,
        standard: 'Injected',
        kind: 'legacy',
        provider: window.solana,
      });
    }
  }

  return list;
}

export async function connectSolanaWallet(options = {}) {
  if (typeof window === 'undefined') {
    throw new Error('Solana browser wallet is unavailable in this environment.');
  }
  const wallets = listAvailableSolanaWallets();
  if (!wallets.length) {
    throw new Error(
      'No Solana wallet extension found (Phantom, Backpack, or Solflare). You can still paste any Solana address manually.'
    );
  }

  const chosen =
    (options.walletId ? wallets.find((w) => w.id === options.walletId) : null) || wallets[0];

  let pubkey = null;
  if (chosen.kind === 'standard') {
    const res = await chosen.wallet.features['standard:connect'].connect();
    const account = res?.accounts?.[0] || chosen.wallet.accounts?.[0];
    pubkey = account?.address || null;
  } else {
    const res = await chosen.provider.connect();
    pubkey = res?.publicKey?.toString?.() || chosen.provider.publicKey?.toString?.() || null;
  }

  if (!pubkey) throw new Error('Solana wallet connection cancelled.');
  connectedSolanaAddress = pubkey;
  connectedSolanaWalletName = chosen.name;
  return { address: pubkey, walletName: chosen.name };
}
