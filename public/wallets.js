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
  56: {
    chainId: '0x38',
    chainName: 'BNB Smart Chain',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: ['https://bsc-rpc.publicnode.com'],
    blockExplorerUrls: ['https://bscscan.com'],
  },
  146: {
    chainId: '0x92',
    chainName: 'Sonic',
    nativeCurrency: { name: 'Sonic', symbol: 'S', decimals: 18 },
    rpcUrls: ['https://rpc.soniclabs.com'],
    blockExplorerUrls: ['https://sonicscan.org'],
  },
  130: {
    chainId: '0x82',
    chainName: 'Unichain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.unichain.org'],
    blockExplorerUrls: ['https://uniscan.xyz'],
  },
  59144: {
    chainId: '0xe708',
    chainName: 'Linea',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.linea.build'],
    blockExplorerUrls: ['https://lineascan.build'],
  },
  534352: {
    chainId: '0x82750',
    chainName: 'Scroll',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.scroll.io'],
    blockExplorerUrls: ['https://scrollscan.com'],
  },
  5000: {
    chainId: '0x1388',
    chainName: 'Mantle',
    nativeCurrency: { name: 'Mantle', symbol: 'MNT', decimals: 18 },
    rpcUrls: ['https://rpc.mantle.xyz'],
    blockExplorerUrls: ['https://mantlescan.xyz'],
  },
  81457: {
    chainId: '0x13e31',
    chainName: 'Blast',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc.blast.io'],
    blockExplorerUrls: ['https://blastscan.io'],
  },
  480: {
    chainId: '0x1e0',
    chainName: 'World Chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://worldchain-mainnet.g.alchemy.com/public'],
    blockExplorerUrls: ['https://worldscan.org'],
  },
};

const SUPPORTED_CHAIN_IDS = [
  1, 8453, 42161, 10, 137, 43114, 56, 146, 130, 59144, 534352, 5000, 81457, 480,
];

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map(Array.from(BASE58_ALPHABET).map((ch, i) => [ch, BigInt(i)]));
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_EVM_ADDR = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32 = '0x' + '00'.repeat(32);

export function solanaBase58ToBytes32Hex(addr) {
  const s = String(addr || '').trim();
  if (!s || s.length < 32 || s.length > 44) {
    throw new Error('Invalid Solana base58 destination address.');
  }
  let value = 0n;
  for (let i = 0; i < s.length; i++) {
    const digit = BASE58_MAP.get(s[i]);
    if (digit === undefined) {
      throw new Error('Invalid Solana base58 character in destination address.');
    }
    value = value * 58n + digit;
  }
  const bytes = [];
  while (value > 0n) {
    bytes.push(Number(value & 0xffn));
    value >>= 8n;
  }
  bytes.reverse();
  let leadingZeros = 0;
  while (leadingZeros < s.length && s[leadingZeros] === '1') leadingZeros++;
  const full = new Uint8Array(leadingZeros + bytes.length);
  full.set(bytes, leadingZeros);
  if (full.length !== 32) {
    throw new Error('Invalid Solana public key length (expected 32 bytes).');
  }
  const hex =
    '0x' +
    Array.from(full)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  return hex;
}

export function isValidSolanaBase58(addr) {
  try {
    const hex = solanaBase58ToBytes32Hex(addr);
    return hex !== ZERO_BYTES32;
  } catch {
    return false;
  }
}

export function isUserRejectedError(err) {
  const code = err?.code ?? err?.cause?.code ?? err?.data?.originalError?.code;
  if (code === 4001 || code === 'ACTION_REJECTED') return true;
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected the request') ||
    msg.includes('action_rejected')
  );
}

function withTimeout(promise, ms, timeoutMessage = 'RPC request timed out') {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function assertValidEvmAddress(addr, label = 'address') {
  const s = String(addr || '').trim();
  if (!EVM_ADDR_RE.test(s) || s.toLowerCase() === ZERO_EVM_ADDR) {
    throw new Error(`Pre-sign check failed: invalid ${label} (${s || 'empty'}).`);
  }
  return s;
}

function assertFromMatchesConnected(expectedFrom) {
  if (!connectedEvmAddress) {
    throw new Error('Connect your EVM wallet before signing.');
  }
  if (expectedFrom && String(expectedFrom).toLowerCase() !== connectedEvmAddress.toLowerCase()) {
    throw new Error(
      `Pre-sign check failed: signer mismatch (${expectedFrom} !== connected ${connectedEvmAddress}).`
    );
  }
}

const solanaAtaBytes32Cache = new Map();

async function resolveExpectedSolanaUsdcAtaBytes32Hex(ownerBase58) {
  const trimmed = String(ownerBase58 || '').trim();
  if (!trimmed) return null;
  if (solanaAtaBytes32Cache.has(trimmed)) return solanaAtaBytes32Cache.get(trimmed);
  try {
    const mod = await loadWalletSdkBundle();
    if (typeof mod?.deriveSolanaUsdcAtaBytes32Hex === 'function') {
      const ataHex = mod.deriveSolanaUsdcAtaBytes32Hex(trimmed).toLowerCase();
      solanaAtaBytes32Cache.set(trimmed, ataHex);
      return ataHex;
    }
  } catch {
    // Fallback to null if SDK bundle is unavailable in non-browser harness
  }
  return null;
}

function assertValidCallForSign(call, expectedSolanaDestination, expectedSolanaAtaBytes32 = null) {
  assertValidEvmAddress(call?.to, 'target contract');
  if (call?.data !== undefined && call?.data !== null && call?.data !== '') {
    if (typeof call.data !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(call.data)) {
      throw new Error('Pre-sign check failed: malformed transaction calldata.');
    }
  }
  if (
    expectedSolanaDestination &&
    call?.solanaDestination &&
    String(call.solanaDestination).trim() !== String(expectedSolanaDestination).trim()
  ) {
    throw new Error('Pre-sign check failed: call Solana destination does not match UI destination.');
  }
  if (
    expectedSolanaDestination &&
    typeof call?.data === 'string' &&
    (call.data.toLowerCase().startsWith('0x6fd3504e') || call.data.toLowerCase().startsWith('0x05285a08')) &&
    call.data.length >= 10 + 256
  ) {
    const expectedOwnerBytes32 = solanaBase58ToBytes32Hex(expectedSolanaDestination).toLowerCase();
    const encodedRecipient = '0x' + call.data.slice(10 + 128, 10 + 192).toLowerCase();
    const expectedTarget = expectedSolanaAtaBytes32 || expectedOwnerBytes32;
    if (encodedRecipient !== expectedTarget) {
      throw new Error(
        'Pre-sign check failed: CCTP depositForBurn mintRecipient does not match your Solana USDC ATA.'
      );
    }
  }
}

function assertSolanaRecipientMatch(recipientValue, expectedSolanaDestination, expectedSolanaAtaBytes32 = null) {
  if (!expectedSolanaDestination || recipientValue === undefined || recipientValue === null) return;
  const expectedTrim = String(expectedSolanaDestination).trim();
  const expectedOwnerBytes32 = solanaBase58ToBytes32Hex(expectedTrim).toLowerCase();
  const raw = String(recipientValue).trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    const lower = raw.toLowerCase();
    const matched = expectedSolanaAtaBytes32
      ? lower === expectedSolanaAtaBytes32 || lower === expectedOwnerBytes32
      : lower === expectedOwnerBytes32;
    if (!matched) {
      throw new Error(
        'Pre-sign check failed: typed-data solanaRecipient bytes32 does not match your Solana destination.'
      );
    }
    return;
  }
  if (raw !== expectedTrim) {
    throw new Error(
      'Pre-sign check failed: typed-data solanaRecipient does not match your Solana destination.'
    );
  }
}

const discoveredEvmProviders = [];
const discoveredSolanaStandardWallets = [];
const discoveredSuiStandardWallets = [];
const familyWalletSessions = {};
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
  protocolFee: {
    feeBps: 700,
    feePercent: 7,
    minFeeBps: 500,
    maxFeeBps: 1000,
    feeRecipientEvm: null,
    feeDestinationType: 'contract',
    treasuryConfigured: false,
  },
};
let cachedSdkModule = null;
let sdkPreloadPromise = null;
let cachedCoinbaseProvider = null;
let activeEvmListeners = null;
let activeSolanaSession = null;

const WC_STORAGE_KEY = 'siphon_wc_project_id';

export function getSavedWalletConnectProjectId() {
  try {
    return window.localStorage?.getItem(WC_STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function setSavedWalletConnectProjectId(projectId) {
  try {
    const clean = String(projectId || '').trim();
    if (clean) window.localStorage?.setItem(WC_STORAGE_KEY, clean);
    else window.localStorage?.removeItem(WC_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function getEffectiveWalletConnectProjectId() {
  return walletSdkConfig.walletConnectProjectId || getSavedWalletConnectProjectId();
}

async function loadWalletSdkBundle({ initCoinbase = false } = {}) {
  if (cachedSdkModule) {
    if (initCoinbase && !cachedCoinbaseProvider && typeof cachedSdkModule.createCoinbaseWalletSDK === 'function') {
      try {
        const sdk = cachedSdkModule.createCoinbaseWalletSDK({
          appName: 'Siphon',
          appLogoUrl: `${window.location.origin}/logos/siphon.svg`,
          appChainIds: SUPPORTED_CHAIN_IDS,
          preference: { options: 'all' },
        });
        cachedCoinbaseProvider = sdk.getProvider();
      } catch {
        // instantiate on demand
      }
    }
    return cachedSdkModule;
  }
  if (!sdkPreloadPromise) {
    sdkPreloadPromise = import('/vendor/wallet-sdks.js')
      .then((mod) => {
        cachedSdkModule = mod;
        return mod;
      })
      .catch((err) => {
        sdkPreloadPromise = null;
        throw err;
      });
  }
  const mod = await sdkPreloadPromise;
  if (initCoinbase && !cachedCoinbaseProvider && typeof mod.createCoinbaseWalletSDK === 'function') {
    try {
      const sdk = mod.createCoinbaseWalletSDK({
        appName: 'Siphon',
        appLogoUrl: `${window.location.origin}/logos/siphon.svg`,
        appChainIds: SUPPORTED_CHAIN_IDS,
        preference: { options: 'all' },
      });
      cachedCoinbaseProvider = sdk.getProvider();
    } catch {
      // instantiate on demand
    }
  }
  return mod;
}

export function preloadWalletSdks() {
  if (typeof window === 'undefined') return;
  loadWalletSdkBundle({ initCoinbase: false }).catch(() => {});
}

export async function loadWalletConnectorConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') {
        walletSdkConfig = {
          ...walletSdkConfig,
          ...data,
          protocolFee: {
            ...walletSdkConfig.protocolFee,
            ...(data.protocolFee && typeof data.protocolFee === 'object' ? data.protocolFee : {}),
          },
        };
      }
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
  const hasConnect = Boolean(wallet.features?.['standard:connect']?.connect);
  if (!hasConnect) return;
  const key = wallet.name || 'Wallet';
  if (chains.some((c) => String(c).startsWith('solana:'))) {
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
  if (chains.some((c) => String(c).startsWith('sui:'))) {
    if (!discoveredSuiStandardWallets.some((w) => w.name === key)) {
      discoveredSuiStandardWallets.push({
        id: `sui-std:${key.toLowerCase().replace(/\s+/g, '-')}`,
        name: key,
        icon: wallet.icon || null,
        standard: 'Sui Wallet Standard',
        wallet,
      });
      notifyWalletDiscovery();
    }
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
  // Re-notify when late-injecting extensions (Keplr, Leap, Cosmostation, TronLink) finish mounting
  window.addEventListener('load', () => notifyWalletDiscovery());
  window.addEventListener('keplr_keystorechange', () => notifyWalletDiscovery());
  window.addEventListener('leap_keystorechange', () => notifyWalletDiscovery());
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

function detachEvmListeners() {
  if (!activeEvmListeners) return;
  const { provider, onAccounts, onChain, onDisconnect } = activeEvmListeners;
  try {
    provider.removeListener?.('accountsChanged', onAccounts);
    provider.removeListener?.('chainChanged', onChain);
    if (onDisconnect) provider.removeListener?.('disconnect', onDisconnect);
  } catch {
    // ignore provider cleanup errors
  }
  activeEvmListeners = null;
}

function attachEvmListeners(provider, callbacks = {}) {
  detachEvmListeners();
  const onAccounts = async (nextAccounts) => {
    const next = nextAccounts?.[0] ?? null;
    if (!next) {
      disconnectEvmWallet();
      callbacks.onAccountsChanged?.(null);
      return;
    }
    connectedEvmAddress = next;
    await detectWalletBatchCapabilities(connectedEvmAddress);
    callbacks.onAccountsChanged?.(connectedEvmAddress);
  };
  const onChain = async () => {
    if (connectedEvmAddress) {
      await detectWalletBatchCapabilities(connectedEvmAddress);
      callbacks.onChainChanged?.();
    }
  };
  const onDisconnect = () => {
    disconnectEvmWallet();
    callbacks.onDisconnect?.();
    callbacks.onAccountsChanged?.(null);
  };
  provider.on?.('accountsChanged', onAccounts);
  provider.on?.('chainChanged', onChain);
  provider.on?.('disconnect', onDisconnect);
  activeEvmListeners = { provider, onAccounts, onChain, onDisconnect };
}

export function disconnectEvmWallet() {
  const prevProvider = activeEvmProvider;
  detachEvmListeners();
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
  if (typeof prevProvider?.disconnect === 'function') {
    try {
      Promise.resolve(prevProvider.disconnect()).catch(() => {});
    } catch {
      // ignore provider disconnect errors
    }
  }
}

function detachSolanaListeners() {
  if (!activeSolanaSession) return;
  try {
    activeSolanaSession.cleanup?.();
  } catch {
    // ignore cleanup errors
  }
  activeSolanaSession = null;
}

export function disconnectSolanaWallet() {
  const prev = activeSolanaSession;
  detachSolanaListeners();
  connectedSolanaAddress = null;
  connectedSolanaWalletName = null;
  if (prev?.kind === 'standard' && typeof prev.wallet?.features?.['standard:disconnect']?.disconnect === 'function') {
    try {
      Promise.resolve(prev.wallet.features['standard:disconnect'].disconnect()).catch(() => {});
    } catch {
      // ignore
    }
  } else if (prev?.kind === 'legacy' && typeof prev.provider?.disconnect === 'function') {
    try {
      Promise.resolve(prev.provider.disconnect()).catch(() => {});
    } catch {
      // ignore
    }
  }
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
    const raw = await withTimeout(
      activeEvmProvider.request({
        method: 'wallet_getCapabilities',
        params: [address, hexChainIds],
      }),
      2500,
      'wallet_getCapabilities timed out'
    );
    cachedBatchCapabilities = parseCapabilitiesResponse(raw, chainIds);
    return cachedBatchCapabilities;
  } catch {
    // Fallback to EIP-5792 v1 1-arg form: wallet_getCapabilities([address])
    try {
      const rawV1 = await withTimeout(
        activeEvmProvider.request({
          method: 'wallet_getCapabilities',
          params: [address],
        }),
        2500,
        'wallet_getCapabilities v1 timed out'
      );
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

function canonicalWalletFamily(name, rdns = '') {
  const s = `${name || ''} ${rdns || ''}`.toLowerCase();
  if (s.includes('rabby')) return 'rabby';
  if (s.includes('metamask')) return 'metamask';
  if (s.includes('phantom')) return 'phantom';
  if (s.includes('coinbase')) return 'coinbase';
  if (s.includes('okx') || s.includes('okex')) return 'okx';
  if (s.includes('trust')) return 'trust';
  if (s.includes('brave')) return 'brave';
  if (s.includes('rainbow')) return 'rainbow';
  if (s.includes('backpack')) return 'backpack';
  if (s.includes('solflare')) return 'solflare';
  if (s.includes('ledger')) return 'ledger';
  return String(name || '').trim().toLowerCase();
}

export function listAvailableEvmWallets() {
  const list = [];
  const seenProviders = new Set();
  const seenFamilies = new Set();

  for (let idx = 0; idx < discoveredEvmProviders.length; idx++) {
    const d = discoveredEvmProviders[idx];
    if (!d?.provider || seenProviders.has(d.provider)) continue;
    const name = d.info?.name || 'EVM Wallet';
    const family = canonicalWalletFamily(name, d.info?.rdns);
    if (seenFamilies.has(family)) continue;
    seenProviders.add(d.provider);
    seenFamilies.add(family);
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
    if (window.coinbaseWalletExtension) {
      injectedCandidates.push({ prov: window.coinbaseWalletExtension, fallbackName: 'Coinbase Wallet' });
    }
    if (window.okxwallet) injectedCandidates.push({ prov: window.okxwallet, fallbackName: 'OKX Wallet' });
    if (window.trustwallet) injectedCandidates.push({ prov: window.trustwallet, fallbackName: 'Trust Wallet' });

    injectedCandidates.forEach(({ prov, fallbackName }, idx) => {
      if (!prov || typeof prov.request !== 'function' || seenProviders.has(prov)) return;
      const name = fallbackName || inferInjectedEvmName(prov);
      const family = canonicalWalletFamily(name);
      if (seenFamilies.has(family)) return;
      seenProviders.add(prov);
      seenFamilies.add(family);
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
  let chosen = wallets[0];
  if (opts.walletId) {
    const match = wallets.find((w) => w.id === opts.walletId);
    if (!match) {
      throw new Error('Selected EVM wallet is no longer available. Please refresh or choose another wallet.');
    }
    chosen = match;
  }
  const provider = chosen.provider;
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts[0]) {
    throw new Error('Wallet connection was cancelled.');
  }
  activeEvmProvider = provider;
  connectedEvmAddress = accounts[0];
  connectedWalletName = chosen.name;

  const capabilities = await detectWalletBatchCapabilities(connectedEvmAddress);
  attachEvmListeners(provider, opts);

  return { address: connectedEvmAddress, walletName: chosen.name, capabilities };
}

/**
 * Connects via Coinbase Smart Wallet (keys.coinbase.com passkey / popup) —
 * works in ANY browser with zero extension installed and native EIP-5792 batching.
 * Uses pre-initialized provider when available so eth_requestAccounts fires synchronously
 * inside the user click gesture (avoiding browser popup blockers).
 */
export async function connectCoinbaseSmartWallet(callbacks = {}) {
  let provider = cachedCoinbaseProvider;
  if (!provider) {
    const { createCoinbaseWalletSDK } = await loadWalletSdkBundle({ initCoinbase: true });
    if (cachedCoinbaseProvider) {
      provider = cachedCoinbaseProvider;
    } else {
      const sdk = createCoinbaseWalletSDK({
        appName: 'Siphon',
        appLogoUrl: `${window.location.origin}/logos/siphon.svg`,
        appChainIds: SUPPORTED_CHAIN_IDS,
        preference: { options: 'all' },
      });
      provider = sdk.getProvider();
      cachedCoinbaseProvider = provider;
    }
  }
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts[0]) {
    throw new Error('Coinbase Wallet connection was cancelled.');
  }
  activeEvmProvider = provider;
  connectedEvmAddress = accounts[0];
  connectedWalletName = 'Coinbase Wallet';
  const capabilities = await detectWalletBatchCapabilities(connectedEvmAddress);
  attachEvmListeners(provider, callbacks);

  return { address: connectedEvmAddress, walletName: 'Coinbase Wallet', capabilities };
}

/**
 * Connects mobile or hardware wallets via WalletConnect v2 QR modal
 * using server WALLETCONNECT_PROJECT_ID or a user-saved Reown Project ID.
 */
export async function connectWalletConnect(callbacks = {}) {
  const cfg = walletSdkConfig.walletConnectProjectId
    ? walletSdkConfig
    : await loadWalletConnectorConfig();
  const projectId =
    callbacks.projectId?.trim() || cfg.walletConnectProjectId || getSavedWalletConnectProjectId();
  if (!projectId) {
    throw new Error(
      'Enter a free Reown / WalletConnect Project ID (cloud.reown.com) to launch the mobile QR modal.'
    );
  }
  const { EthereumProvider } = await loadWalletSdkBundle();
  const provider = await EthereumProvider.init({
    projectId,
    optionalChains: SUPPORTED_CHAIN_IDS,
    showQrModal: true,
    metadata: {
      name: 'Siphon',
      description: 'Move fragmented EVM positions and tokens to Solana.',
      url: window.location.origin,
      icons: [`${window.location.origin}/logos/siphon.svg`],
    },
  });
  await provider.connect();
  const accounts =
    Array.isArray(provider.accounts) && provider.accounts.length
      ? provider.accounts
      : await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts || !accounts[0]) {
    throw new Error('WalletConnect session cancelled.');
  }
  activeEvmProvider = provider;
  connectedEvmAddress = accounts[0];
  connectedWalletName = 'WalletConnect';
  const capabilities = await detectWalletBatchCapabilities(connectedEvmAddress);
  attachEvmListeners(provider, {
    ...callbacks,
    onDisconnect: () => callbacks.onAccountsChanged?.(null),
  });

  return { address: connectedEvmAddress, walletName: 'WalletConnect', capabilities };
}

export async function ensureEvmChain(chainId) {
  if (!activeEvmProvider) {
    throw new Error('Connect an EVM wallet first.');
  }
  const numericChainId = Number(chainId);
  if (!Number.isInteger(numericChainId) || numericChainId <= 0) {
    throw new Error(`Invalid target EVM chainId: ${chainId}`);
  }
  const hexChainId = '0x' + numericChainId.toString(16);
  const currentHex = await activeEvmProvider.request({ method: 'eth_chainId' });
  if (String(currentHex).toLowerCase() === hexChainId.toLowerCase()) return;

  try {
    await activeEvmProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    });
  } catch (err) {
    const nestedCode = err?.code ?? err?.data?.originalError?.code ?? err?.cause?.code;
    if (nestedCode === 4902 && CHAIN_ADD_PARAMS[numericChainId]) {
      await activeEvmProvider.request({
        method: 'wallet_addEthereumChain',
        params: [CHAIN_ADD_PARAMS[numericChainId]],
      });
      // EIP-3085 does not guarantee an automatic switch on all wallets
      const afterAddHex = await activeEvmProvider.request({ method: 'eth_chainId' });
      if (String(afterAddHex).toLowerCase() !== hexChainId.toLowerCase()) {
        await activeEvmProvider.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: hexChainId }],
        });
      }
    } else {
      throw err;
    }
  }

  const verifiedHex = await activeEvmProvider.request({ method: 'eth_chainId' });
  if (String(verifiedHex).toLowerCase() !== hexChainId.toLowerCase()) {
    throw new Error(
      `Wallet failed to switch to target chain ${hexChainId} (still on ${verifiedHex || 'unknown'}). Transaction aborted to prevent wrong-chain broadcast.`
    );
  }
}

export async function sendRealEvmTransaction(tx, opts = {}) {
  if (!activeEvmProvider || !connectedEvmAddress) {
    throw new Error('Connect your EVM wallet before signing live transactions.');
  }
  assertFromMatchesConnected(tx?.from || opts?.expectedFrom);
  const expectedAtaBytes32 = opts?.expectedSolanaDestination
    ? await resolveExpectedSolanaUsdcAtaBytes32Hex(opts.expectedSolanaDestination)
    : null;
  assertValidCallForSign(tx, opts?.expectedSolanaDestination, expectedAtaBytes32);
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
 * Signs a gasless off-chain EIP-712 typed-data payload (Permit2 PermitBatchTransferFrom or
 * EIP-7702 SweepIntent) with ZERO native ETH/POL/AVAX gas required in the user's wallet.
 */
export async function signGaslessTypedData(typedData, chainId, opts = {}) {
  if (!activeEvmProvider || !connectedEvmAddress) {
    throw new Error('Connect your EVM wallet to sign the gasless sweep intent.');
  }
  assertFromMatchesConnected(opts?.expectedFrom);

  const parsed = typeof typedData === 'string' ? JSON.parse(typedData) : typedData;
  const domainChainId = parsed?.domain?.chainId;
  if (chainId !== undefined && chainId !== null) {
    const targetId = Number(chainId);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      throw new Error(`Pre-sign check failed: invalid target chainId (${chainId}).`);
    }
    if (domainChainId !== undefined && domainChainId !== null && Number(domainChainId) !== targetId) {
      throw new Error(
        `Pre-sign check failed: EIP-712 domain.chainId (${domainChainId}) !== target chainId (${targetId}).`
      );
    }
    await ensureEvmChain(targetId);
  }

  const witnessRecipient =
    parsed?.message?.witness?.solanaRecipient ?? parsed?.message?.solanaRecipient;
  if (opts?.expectedSolanaDestination) {
    if (witnessRecipient === undefined || witnessRecipient === null) {
      throw new Error(
        'Pre-sign check failed: gasless typed-data payload is missing solanaRecipient commitment.'
      );
    }
    const expectedAtaBytes32 = await resolveExpectedSolanaUsdcAtaBytes32Hex(opts.expectedSolanaDestination);
    assertSolanaRecipientMatch(witnessRecipient, opts.expectedSolanaDestination, expectedAtaBytes32);
  }

  const payload = typeof typedData === 'string' ? typedData : JSON.stringify(typedData);
  const signature = await activeEvmProvider.request({
    method: 'eth_signTypedData_v4',
    params: [connectedEvmAddress, payload],
  });
  if (!signature || typeof signature !== 'string') {
    throw new Error('Gasless signature was cancelled.');
  }
  return signature;
}

/**
 * Submits ALL calls on a single EVM chain in ONE wallet confirmation popup via EIP-5792 `wallet_sendCalls`.
 * Enforces `atomicRequired: true` whenever the batch includes protocol fee steps so a failed swap/bridge
 * cannot leave a standalone fee transfer executed onchain.
 * Throws an Error with `err.unsupportedEip5792 = true` if the wallet lacks EIP-5792 so callers can fall back seamlessly.
 */
export async function sendEip5792Batch({
  chainId,
  calls,
  atomicRequired,
  expectedFrom,
  expectedSolanaDestination,
}) {
  if (!activeEvmProvider || !connectedEvmAddress) {
    throw new Error('Connect your EVM wallet before signing live batches.');
  }
  if (!Array.isArray(calls) || !calls.length) {
    throw new Error('No calls prepared for this chain batch.');
  }
  assertFromMatchesConnected(expectedFrom);
  const expectedAtaBytes32 = expectedSolanaDestination
    ? await resolveExpectedSolanaUsdcAtaBytes32Hex(expectedSolanaDestination)
    : null;
  for (const c of calls) {
    assertValidCallForSign(c, expectedSolanaDestination, expectedAtaBytes32);
  }

  await ensureEvmChain(chainId);
  const hexChainId = '0x' + Number(chainId).toString(16);
  const hasProtocolFeeStep = calls.some(
    (c) =>
      c?.isProtocolFee === true ||
      String(c?.stepId || '').toLowerCase().startsWith('protocol_fee')
  );
  const mustBeAtomic = Boolean(atomicRequired ?? hasProtocolFeeStep);
  const formattedCalls = calls.map((c) => ({
    to: c.to,
    data: c.data,
    value: c.value || '0x0',
  }));

  const isUnsupportedErr = (err) => {
    const code = err?.code ?? err?.cause?.code;
    const msg = String(err?.message || '').toLowerCase();
    return (
      code === -32601 ||
      code === 4200 ||
      msg.includes('method not found') ||
      msg.includes('does not exist') ||
      msg.includes('unsupported method') ||
      msg.includes('not supported')
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
          atomicRequired: mustBeAtomic,
          calls: formattedCalls,
        },
      ],
    });
    const batchId = typeof res === 'string' ? res : res?.id;
    if (!batchId) throw new Error('Wallet returned empty EIP-5792 batch ID.');
    return { mode: 'eip5792', batchId, version: '2.0.0', atomicRequired: mustBeAtomic };
  } catch (err) {
    if (isUserRejectedError(err)) throw err;
    if (isUnsupportedErr(err)) {
      const wrapped = new Error('Connected wallet does not support EIP-5792 wallet_sendCalls.');
      wrapped.unsupportedEip5792 = true;
      throw wrapped;
    }

    // Do NOT silently downgrade fee-bundled batches to non-atomic EIP-5792 v1
    if (mustBeAtomic) {
      throw err;
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
      return { mode: 'eip5792', batchId, version: '1.0', atomicRequired: false };
    } catch (errV1) {
      if (isUserRejectedError(errV1)) throw errV1;
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
  let lastObservedTxHashes = [];

  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (!activeEvmProvider) {
      return { confirmed: false, failed: true, status: 'DISCONNECTED', txHashes: lastObservedTxHashes };
    }
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
      if (txHashes.length) lastObservedTxHashes = txHashes;

      onUpdate?.({ status, txHashes: lastObservedTxHashes, raw: res });

      // EIP-5792 v2 numeric codes (200 = confirmed, >= 400 = failed) + v1 strings
      const isConfirmed = status === 200 || status === 'CONFIRMED';
      const isFailed =
        (typeof status === 'number' && status >= 400) ||
        status === 'FAILED' ||
        status === 'REVERTED';

      if (isConfirmed) {
        const anySubRevert = receipts.some(
          (r) => r?.status === '0x0' || r?.status === 0 || r?.status === '0' || r?.status === false
        );
        if (anySubRevert) {
          return { confirmed: false, failed: true, status: 'REVERTED', txHashes: lastObservedTxHashes, raw: res };
        }
        return { confirmed: true, failed: false, status, txHashes: lastObservedTxHashes, raw: res };
      }
      if (isFailed) {
        return { confirmed: false, failed: true, status, txHashes: lastObservedTxHashes, raw: res };
      }
    } catch (err) {
      if (err?.code === -32601 || err?.code === -32602) {
        return { confirmed: false, failed: true, status: 'UNSUPPORTED', txHashes: lastObservedTxHashes };
      }
      // Keep polling briefly while wallet indexes bundle
    }
  }

  return { confirmed: false, failed: false, status: 'TIMEOUT', txHashes: lastObservedTxHashes };
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

  let chosen = wallets[0];
  if (options.walletId) {
    const match = wallets.find((w) => w.id === options.walletId);
    if (!match) {
      throw new Error('Selected Solana wallet is not available. Please choose another wallet.');
    }
    chosen = match;
  }

  detachSolanaListeners();

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

  let cleanup = null;
  if (chosen.kind === 'standard' && typeof chosen.wallet.features?.['standard:events']?.on === 'function') {
    try {
      const off = chosen.wallet.features['standard:events'].on('change', ({ accounts }) => {
        if (!Array.isArray(accounts)) return;
        const nextStr = accounts[0]?.address || null;
        connectedSolanaAddress = nextStr;
        if (!nextStr) connectedSolanaWalletName = null;
        options.onAccountChanged?.(nextStr);
      });
      if (typeof off === 'function') cleanup = off;
    } catch {
      // ignore optional event errors
    }
  } else if (chosen.kind === 'legacy' && chosen.provider?.on) {
    try {
      const onAccountChanged = (nextPubkey) => {
        const nextStr = nextPubkey?.toString?.() || null;
        connectedSolanaAddress = nextStr;
        if (!nextStr) connectedSolanaWalletName = null;
        options.onAccountChanged?.(nextStr);
      };
      const onDisconnect = () => {
        detachSolanaListeners();
        connectedSolanaAddress = null;
        connectedSolanaWalletName = null;
        options.onAccountChanged?.(null);
      };
      chosen.provider.on('accountChanged', onAccountChanged);
      chosen.provider.on('disconnect', onDisconnect);
      cleanup = () => {
        chosen.provider.removeListener?.('accountChanged', onAccountChanged);
        chosen.provider.off?.('accountChanged', onAccountChanged);
        chosen.provider.removeListener?.('disconnect', onDisconnect);
        chosen.provider.off?.('disconnect', onDisconnect);
      };
    } catch {
      // ignore optional listener errors
    }
  }
  activeSolanaSession = {
    kind: chosen.kind,
    wallet: chosen.wallet || null,
    provider: chosen.provider || null,
    cleanup,
  };

  return { address: pubkey, walletName: chosen.name };
}

// =====================================================================
// MULTI-FAMILY WALLET CONNECTORS (Cosmos, Sui, Aptos, TON, Tron, Bitcoin)
// =====================================================================

export function getConnectedFamilyWallet(family) {
  if (family === 'evm') {
    const address = getConnectedEvmAddress();
    return address ? { family: 'evm', address, walletName: getConnectedWalletName() } : null;
  }
  return familyWalletSessions[family] || null;
}

export function disconnectFamilyWallet(family) {
  if (family === 'evm') {
    disconnectEvmWallet();
    return;
  }
  delete familyWalletSessions[family];
}

export function listAvailableFamilyWallets(family) {
  if (typeof window === 'undefined') return [];
  if (family === 'evm') return listAvailableEvmWallets();

  if (family === 'cosmos') {
    const out = [];
    const seen = new Set();
    const addCosmos = (id, name, icon, provider, standard = 'Cosmos Extension') => {
      if (!provider || seen.has(id)) return;
      seen.add(id);
      out.push({ id, name, standard, icon, provider });
    };
    if (window.keplr) addCosmos('keplr', 'Keplr', '/logos/keplr.svg', window.keplr);
    if (window.leap) addCosmos('leap', 'Leap Wallet', '/logos/leap.svg', window.leap);
    if (window.cosmostation?.providers?.keplr) {
      addCosmos('cosmostation', 'Cosmostation', '/logos/cosmos.svg', window.cosmostation.providers.keplr);
    } else if (window.cosmostation?.cosmos) {
      addCosmos('cosmostation', 'Cosmostation', '/logos/cosmos.svg', window.cosmostation.cosmos, 'Cosmostation API');
    }
    if (window.okxwallet?.keplr) {
      addCosmos('okx-cosmos', 'OKX Wallet (Cosmos)', '/logos/okx.svg', window.okxwallet.keplr);
    }
    if (window.ctrl?.keplr || window.xfi?.keplr) {
      addCosmos('ctrl', 'Ctrl / XDEFI', '/logos/cosmos.svg', window.ctrl?.keplr || window.xfi?.keplr);
    }
    if (window.frontier?.keplr) {
      addCosmos('frontier', 'Frontier', '/logos/cosmos.svg', window.frontier.keplr);
    }
    return out;
  }

  if (family === 'sui') {
    const out = [];
    const seen = new Set();
    for (const w of discoveredSuiStandardWallets) {
      seen.add(w.name.toLowerCase());
      out.push({
        id: w.id,
        name: w.name,
        standard: w.standard,
        icon: w.icon || '/logos/slush.svg',
        kind: 'standard',
        wallet: w.wallet,
      });
    }
    if (window.suiWallet && !seen.has('sui wallet')) {
      out.push({ id: 'sui-wallet', name: 'Slush / Sui Wallet', standard: 'Extension', icon: '/logos/slush.svg', kind: 'legacy', provider: window.suiWallet });
    }
    if (window.phantom?.sui && !seen.has('phantom')) {
      out.push({ id: 'phantom-sui', name: 'Phantom (Sui)', standard: 'Extension', icon: '/logos/phantom.svg', kind: 'legacy', provider: window.phantom.sui });
    }
    return out;
  }

  if (family === 'aptos') {
    const out = [];
    if (window.aptos) {
      out.push({ id: 'petra', name: 'Petra Wallet', standard: 'Aptos Extension', icon: '/logos/petra.svg', provider: window.aptos });
    }
    if (window.phantom?.aptos) {
      out.push({ id: 'phantom-aptos', name: 'Phantom (Aptos)', standard: 'Aptos Extension', icon: '/logos/phantom.svg', provider: window.phantom.aptos });
    }
    return out;
  }

  if (family === 'ton') {
    const out = [];
    const tk = window.tonkeeper?.tonconnect || window.tonkeeper || window.ton;
    if (tk) {
      out.push({ id: 'tonkeeper', name: 'Tonkeeper', standard: 'TonConnect / Extension', icon: '/logos/tonkeeper.svg', provider: tk });
    }
    if (window.openmask) {
      out.push({ id: 'openmask', name: 'OpenMask', standard: 'TON Extension', icon: '/logos/ton.svg', provider: window.openmask });
    }
    return out;
  }

  if (family === 'tron') {
    const out = [];
    if (window.tronLink || window.tronWeb) {
      out.push({
        id: 'tronlink',
        name: 'TronLink',
        standard: 'Tron Extension',
        icon: '/logos/tronlink.svg',
        provider: window.tronLink || window.tronWeb,
      });
    }
    return out;
  }

  if (family === 'btc') {
    const out = [];
    if (window.unisat) {
      out.push({ id: 'unisat', name: 'UniSat Wallet', standard: 'Bitcoin PSBT', icon: '/logos/unisat.svg', provider: window.unisat });
    }
    if (window.XverseProviders?.BitcoinProvider || window.BitcoinProvider) {
      out.push({
        id: 'xverse',
        name: 'Xverse',
        standard: 'Bitcoin PSBT',
        icon: '/logos/xverse.svg',
        provider: window.XverseProviders?.BitcoinProvider || window.BitcoinProvider,
      });
    }
    if (window.phantom?.bitcoin) {
      out.push({ id: 'phantom-btc', name: 'Phantom (Bitcoin)', standard: 'Bitcoin PSBT', icon: '/logos/phantom.svg', provider: window.phantom.bitcoin });
    }
    return out;
  }

  return [];
}

const COSMOS_CONNECT_CHAINS = [
  { key: 'cosmoshub', chainId: 'cosmoshub-4' },
  { key: 'osmosis', chainId: 'osmosis-1' },
  { key: 'noble', chainId: 'noble-1' },
  { key: 'celestia', chainId: 'celestia' },
  { key: 'injective', chainId: 'injective-1' },
  { key: 'neutron', chainId: 'neutron-1' },
];

async function readCosmosChainAddress(provider, chainId) {
  if (typeof provider.getKey === 'function') {
    const key = await provider.getKey(chainId);
    if (key?.bech32Address) return key.bech32Address;
  }
  if (typeof provider.getOfflineSignerAuto === 'function') {
    const signer = await provider.getOfflineSignerAuto(chainId);
    const accs = await signer?.getAccounts?.();
    if (accs?.[0]?.address) return accs[0].address;
  }
  if (typeof provider.getOfflineSigner === 'function') {
    const signer = provider.getOfflineSigner(chainId);
    const accs = await signer?.getAccounts?.();
    if (accs?.[0]?.address) return accs[0].address;
  }
  if (typeof provider.request === 'function') {
    const acc = await provider.request({ method: 'cos_account', params: { chainName: chainId } });
    if (acc?.address) return acc.address;
  }
  return null;
}

export async function connectFamilyWallet(family, opts = {}) {
  if (family === 'evm') return connectEvmWallet(opts);
  const wallets = listAvailableFamilyWallets(family);
  if (!wallets.length) {
    if (family === 'cosmos') {
      throw new Error(
        'No Cosmos extension detected on this page. Unlock Keplr, Leap, Cosmostation, or OKX Wallet and allow site access on 127.0.0.1, then retry.'
      );
    }
    throw new Error(`No ${family.toUpperCase()} browser wallet detected. Install a supported wallet or paste an address to inspect.`);
  }
  const chosen = (opts.walletId ? wallets.find((w) => w.id === opts.walletId) : null) || wallets[0];
  let address = null;
  let addressesByChain = null;

  if (family === 'cosmos') {
    const prov = chosen.provider;
    const requestedChains = opts.chainId
      ? [{ key: 'custom', chainId: opts.chainId }]
      : COSMOS_CONNECT_CHAINS;
    const chainIds = requestedChains.map((c) => c.chainId);

    // 1. Try batch enable across all 6 Cosmos chains; fall back to individual enable if any single chain isn't supported
    if (typeof prov.enable === 'function') {
      try {
        await prov.enable(chainIds);
      } catch (batchErr) {
        let enabledAny = false;
        for (const cid of chainIds) {
          try {
            await prov.enable(cid);
            enabledAny = true;
          } catch {
            // ignore unsupported optional chain
          }
        }
        if (!enabledAny) {
          throw new Error(
            batchErr?.message || `${chosen.name} rejected chain connection — unlock your wallet and approve access.`
          );
        }
      }
    }

    // 2. Read Bech32 address across every enabled Cosmos chain
    const foundMap = {};
    const settled = await Promise.allSettled(
      requestedChains.map(async (c) => [c.key, await readCosmosChainAddress(prov, c.chainId)])
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value?.[1]) {
        foundMap[r.value[0]] = r.value[1];
      }
    }
    addressesByChain = foundMap;
    address =
      foundMap.cosmoshub ||
      foundMap.osmosis ||
      foundMap.noble ||
      Object.values(foundMap)[0] ||
      null;
  } else if (family === 'sui') {
    if (chosen.kind === 'standard') {
      const res = await chosen.wallet.features['standard:connect'].connect();
      address = res?.accounts?.[0]?.address || chosen.wallet.accounts?.[0]?.address || null;
    } else if (typeof chosen.provider.requestPermissions === 'function') {
      await chosen.provider.requestPermissions();
      const accs = await chosen.provider.getAccounts();
      address = accs?.[0] || null;
    } else if (typeof chosen.provider.connect === 'function') {
      const res = await chosen.provider.connect();
      address = res?.address || res?.accounts?.[0]?.address || null;
    }
  } else if (family === 'aptos') {
    const res = await chosen.provider.connect();
    address = res?.address || (await chosen.provider.account?.())?.address || null;
  } else if (family === 'ton') {
    if (typeof chosen.provider.send === 'function') {
      const accs = await chosen.provider.send('ton_requestAccounts');
      address = Array.isArray(accs) ? accs[0] : accs?.address || null;
    } else if (typeof chosen.provider.connect === 'function') {
      const res = await chosen.provider.connect();
      address = res?.account?.address || res?.address || null;
    }
  } else if (family === 'tron') {
    if (window.tronLink?.request) {
      const res = await window.tronLink.request({ method: 'tron_requestAccounts' });
      if (res && res.code && res.code !== 200) {
        throw new Error(res.message || 'TronLink connection rejected.');
      }
    }
    address = window.tronWeb?.defaultAddress?.base58 || window.tronLink?.tronWeb?.defaultAddress?.base58 || null;
  } else if (family === 'btc') {
    if (chosen.id === 'unisat') {
      const accs = await chosen.provider.requestAccounts();
      address = accs?.[0] || null;
    } else if (chosen.id === 'phantom-btc') {
      const accs = await chosen.provider.requestAccounts();
      const payment = accs?.find((a) => a.purpose === 'payment') || accs?.[0];
      address = payment?.address || (typeof payment === 'string' ? payment : null);
    } else if (typeof chosen.provider.request === 'function') {
      const res = await chosen.provider.request('getAccounts', { purposes: ['payment', 'ordinals'] });
      const accs = res?.result || res || [];
      const payment = Array.isArray(accs)
        ? accs.find((a) => a?.purpose === 'payment') || accs[0]
        : null;
      address = payment?.address || null;
    }
  }

  if (!address) {
    throw new Error(`${chosen.name} connection was cancelled or returned no address.`);
  }

  const session = {
    family,
    address,
    addressesByChain,
    walletName: chosen.name,
    walletId: chosen.id,
    provider: chosen.provider || chosen.wallet,
    kind: chosen.kind || 'extension',
  };
  familyWalletSessions[family] = session;
  return session;
}

export async function signFamilyGaslessIntent(family, intent, opts = {}) {
  if (family === 'evm') {
    return signGaslessTypedData(intent.typedData || intent.signPayload, intent.chainId, opts);
  }
  const session = familyWalletSessions[family];
  if (!session) {
    throw new Error(`Connect your ${family.toUpperCase()} wallet first to sign the 1-sig gasless sweep.`);
  }
  if (
    opts?.expectedSolanaDestination &&
    intent?.solanaDestination &&
    String(intent.solanaDestination).trim() !== String(opts.expectedSolanaDestination).trim()
  ) {
    throw new Error('Pre-sign check failed: intent Solana destination does not match your UI destination.');
  }
  const msgText = JSON.stringify(intent.signPayload || intent);

  if (family === 'cosmos') {
    const chainId = String(intent.chainId || 'cosmoshub-4');
    const chainKey = String(intent.chain || '').toLowerCase();
    const signerAddr = session.addressesByChain?.[chainKey] || session.address;
    if (typeof session.provider.signArbitrary === 'function') {
      const sig = await session.provider.signArbitrary(chainId, signerAddr, msgText);
      return sig?.signature || JSON.stringify(sig);
    }
    throw new Error('Connected Cosmos wallet does not expose signArbitrary.');
  }
  if (family === 'sui') {
    const bytes = new TextEncoder().encode(msgText);
    if (session.kind === 'standard' && session.provider.features?.['sui:signPersonalMessage']) {
      const matchingAccount =
        session.provider.accounts?.find((a) => a.address === session.address) ||
        session.provider.accounts?.[0];
      const res = await session.provider.features['sui:signPersonalMessage'].signPersonalMessage({
        message: bytes,
        account: matchingAccount,
      });
      return res?.signature || JSON.stringify(res);
    }
    if (typeof session.provider.signPersonalMessage === 'function') {
      const res = await session.provider.signPersonalMessage({ message: bytes });
      return res?.signature || JSON.stringify(res);
    }
    throw new Error('Connected Sui wallet does not expose signPersonalMessage.');
  }
  if (family === 'aptos') {
    const res = await session.provider.signMessage({ message: msgText, nonce: String(intent.nonce) });
    return res?.signature || JSON.stringify(res);
  }
  if (family === 'ton') {
    throw new Error(
      'Blind TON raw digest signing (ton_rawSign) is disabled for wallet safety. Use a structured TonConnect 2 sendTransaction wallet flow to review exact transfer messages before approving.'
    );
  }
  if (family === 'tron') {
    const tw = window.tronWeb || window.tronLink?.tronWeb;
    if (tw?.trx?.signMessageV2) {
      return await tw.trx.signMessageV2(msgText);
    }
    throw new Error('TronLink signMessageV2 unavailable.');
  }
  if (family === 'btc') {
    if (session.walletId === 'unisat' && typeof session.provider.signMessage === 'function') {
      return await session.provider.signMessage(msgText);
    }
    if (session.walletId === 'phantom-btc' && typeof session.provider.signMessage === 'function') {
      const res = await session.provider.signMessage(session.address, new TextEncoder().encode(msgText));
      return typeof res === 'string' ? res : res?.signature || JSON.stringify(res);
    }
    if (typeof session.provider.signMessage === 'function') {
      const res = await session.provider.signMessage(session.address, msgText);
      return typeof res === 'string' ? res : res?.signature || JSON.stringify(res);
    }
    throw new Error('Connected Bitcoin wallet does not expose message/PSBT signing.');
  }
  throw new Error(`Unsupported signing family: ${family}`);
}
