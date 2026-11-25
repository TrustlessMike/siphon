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
  const dataLower = typeof call?.data === 'string' ? call.data.toLowerCase() : '';
  const isCctpV1 = dataLower.startsWith('0x6fd3504e');
  const isCctpV2 = dataLower.startsWith('0x8e0250ee');
  if (expectedSolanaDestination && (isCctpV1 || isCctpV2)) {
    const minCalldataLen = isCctpV2 ? 10 + 448 : 10 + 256;
    if (dataLower.length < minCalldataLen) {
      throw new Error(
        'Pre-sign check failed: truncated CCTP depositForBurn calldata.'
      );
    }
    const expectedOwnerBytes32 = solanaBase58ToBytes32Hex(expectedSolanaDestination).toLowerCase();
    const encodedRecipient = '0x' + dataLower.slice(10 + 128, 10 + 192);
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
let solanaSessionSeq = 0;
const familyWalletCleanups = {};

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
  activeSolanaSession.active = false;
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

function pickSolanaStandardAccount(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) return null;
  return (
    accounts.find(
      (a) =>
        a?.address &&
        (!Array.isArray(a.chains) ||
          a.chains.length === 0 ||
          a.chains.some((c) => String(c).startsWith('solana:')))
    ) ||
    accounts.find((a) => a?.address) ||
    null
  );
}

function extractSolanaPubkeyString(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') return raw.trim() || null;
  if (typeof raw.toBase58 === 'function') return String(raw.toBase58()).trim() || null;
  if (typeof raw.toString === 'function') {
    const s = String(raw.toString()).trim();
    if (s && s !== '[object Object]') return s;
  }
  return null;
}

function removeProviderEventListener(provider, eventName, handler) {
  if (!provider || !handler) return;
  try {
    if (typeof provider.removeListener === 'function') {
      provider.removeListener(eventName, handler);
    } else if (typeof provider.off === 'function') {
      provider.off(eventName, handler);
    }
  } catch {
    // ignore listener removal errors
  }
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

  const attemptSeq = ++solanaSessionSeq;
  detachSolanaListeners();

  let pubkey = null;
  if (chosen.kind === 'standard') {
    const res = await chosen.wallet.features['standard:connect'].connect();
    const account = pickSolanaStandardAccount(res?.accounts) || pickSolanaStandardAccount(chosen.wallet.accounts);
    pubkey = extractSolanaPubkeyString(account?.address);
  } else {
    const res = await chosen.provider.connect();
    pubkey =
      extractSolanaPubkeyString(res?.publicKey) ||
      extractSolanaPubkeyString(chosen.provider.publicKey) ||
      null;
  }

  if (!pubkey) throw new Error('Solana wallet connection cancelled.');
  // Guard against an older async connect resolving after a newer connect or disconnect
  if (attemptSeq !== solanaSessionSeq) {
    throw new Error('Solana wallet connection was superseded by a newer request.');
  }

  connectedSolanaAddress = pubkey;
  connectedSolanaWalletName = chosen.name;

  const session = {
    id: attemptSeq,
    active: true,
    kind: chosen.kind,
    wallet: chosen.wallet || null,
    provider: chosen.provider || null,
    cleanup: null,
  };
  activeSolanaSession = session;

  const emitAccountUpdate = (nextStr, reason) => {
    if (!session.active || activeSolanaSession !== session) return;
    const previousAddress = connectedSolanaAddress;
    if (!nextStr) {
      detachSolanaListeners();
      connectedSolanaAddress = null;
      connectedSolanaWalletName = null;
      options.onAccountChanged?.(null, {
        previousAddress,
        reason: reason || 'disconnect',
        walletName: chosen.name,
      });
      return;
    }
    if (nextStr === previousAddress) return;
    connectedSolanaAddress = nextStr;
    options.onAccountChanged?.(nextStr, {
      previousAddress,
      reason: reason || 'accountChanged',
      walletName: chosen.name,
    });
  };

  let cleanup = null;
  if (chosen.kind === 'standard' && typeof chosen.wallet.features?.['standard:events']?.on === 'function') {
    try {
      const off = chosen.wallet.features['standard:events'].on('change', (props) => {
        if (!session.active || activeSolanaSession !== session) return;
        if (!props || !Array.isArray(props.accounts)) return;
        const account = pickSolanaStandardAccount(props.accounts);
        const nextStr = extractSolanaPubkeyString(account?.address);
        emitAccountUpdate(nextStr, nextStr ? 'accountChanged' : 'disconnect');
      });
      if (typeof off === 'function') {
        cleanup = () => {
          try {
            off();
          } catch {
            // ignore standard unsubscribe errors
          }
        };
      }
    } catch {
      // ignore optional event errors
    }
  } else if (chosen.kind === 'legacy' && typeof chosen.provider?.on === 'function') {
    try {
      const onAccountChanged = (nextPubkey) => {
        if (!session.active || activeSolanaSession !== session) return;
        const nextStr = extractSolanaPubkeyString(nextPubkey);
        emitAccountUpdate(nextStr, nextStr ? 'accountChanged' : 'disconnect');
      };
      const onDisconnect = () => {
        if (!session.active || activeSolanaSession !== session) return;
        emitAccountUpdate(null, 'disconnect');
      };
      chosen.provider.on('accountChanged', onAccountChanged);
      chosen.provider.on('disconnect', onDisconnect);
      cleanup = () => {
        removeProviderEventListener(chosen.provider, 'accountChanged', onAccountChanged);
        removeProviderEventListener(chosen.provider, 'disconnect', onDisconnect);
      };
    } catch {
      // ignore optional listener errors
    }
  }
  session.cleanup = cleanup;

  return { address: pubkey, walletName: chosen.name };
}

function base64ToUint8Array(b64) {
  const clean = String(b64 || '').trim();
  if (!clean) return null;
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToBase58(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return '';
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  let value = 0n;
  for (let i = 0; i < bytes.length; i += 1) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  const chars = [];
  while (value > 0n) {
    const rem = Number(value % 58n);
    chars.push(BASE58_ALPHABET[rem]);
    value /= 58n;
  }
  chars.reverse();
  return '1'.repeat(leadingZeros) + chars.join('');
}

function extractSolanaSignature(res) {
  if (!res) return null;
  if (typeof res === 'string') return res.trim() || null;
  if (res instanceof Uint8Array) return bytesToBase58(res) || null;
  if (Array.isArray(res) && res[0]) return extractSolanaSignature(res[0]);
  if (res.signature instanceof Uint8Array) return bytesToBase58(res.signature) || null;
  if (typeof res.signature === 'string') return res.signature.trim() || null;
  if (typeof res.txid === 'string') return res.txid.trim() || null;
  return null;
}

/**
 * Signs and submits a server-built Circle CCTP Solana `receiveMessage` claim transaction plan
 * using Phantom, Backpack, or Solflare (Wallet Standard `solana:signAndSendTransaction` or legacy
 * `provider.signAndSendTransaction` / `provider.request`).
 * Fails closed on recipient/ATA mismatch and surfaces clean fallback instructions if the wallet
 * does not expose `signAndSendTransaction`.
 */
export async function claimCctpOnSolana(claimPlan, options = {}) {
  if (!claimPlan || typeof claimPlan !== 'object') {
    throw new Error('Missing Solana CCTP claim transaction plan.');
  }
  if (claimPlan.mintRecipientVerified !== true || !claimPlan.recipientUsdcAta) {
    throw new Error('Pre-sign check failed: CCTP claim plan is missing verified Solana USDC ATA recipient.');
  }
  if (!isValidSolanaBase58(claimPlan.solanaDestination)) {
    throw new Error('Pre-sign check failed: invalid Solana destination address in claim plan.');
  }
  if (
    options.expectedSolanaDestination &&
    String(claimPlan.solanaDestination).trim() !== String(options.expectedSolanaDestination).trim()
  ) {
    throw new Error(
      'Pre-sign check failed: CCTP claim destination does not match your job Solana destination.'
    );
  }
  if (!Array.isArray(claimPlan.instructions) || !claimPlan.instructions.length) {
    throw new Error('Solana CCTP claim plan contains no executable instructions.');
  }

  // Verify canonical USDC ATA bytes32 when browser SDK bundle is available
  if (claimPlan.expectedMintRecipientBytes32) {
    const derivedAtaHex = await resolveExpectedSolanaUsdcAtaBytes32Hex(claimPlan.solanaDestination);
    if (
      derivedAtaHex &&
      derivedAtaHex.toLowerCase() !== String(claimPlan.expectedMintRecipientBytes32).toLowerCase()
    ) {
      throw new Error(
        'Pre-sign check failed: CCTP claim mintRecipient does not match canonical Solana USDC ATA PDA.'
      );
    }
  }

  // Ensure a Solana wallet session is connected
  if (!activeSolanaSession || !connectedSolanaAddress) {
    if (options.autoConnect === false) {
      throw new Error('Connect your Solana wallet (Phantom, Backpack, or Solflare) before claiming USDC.');
    }
    await connectSolanaWallet({ walletId: options.walletId });
  }

  // Enforce destinationCaller lock if the Circle message specifies a non-zero destinationCaller
  const destCaller = String(claimPlan.decodedMessage?.destinationCallerBytes32 || '').toLowerCase();
  if (destCaller && destCaller !== ZERO_BYTES32 && connectedSolanaAddress) {
    const connectedBytes32 = solanaBase58ToBytes32Hex(connectedSolanaAddress).toLowerCase();
    if (connectedBytes32 !== destCaller) {
      throw new Error(
        'Pre-sign check failed: this CCTP message restricts destinationCaller to a different Solana signer.'
      );
    }
  }

  const fallbackInstructions =
    Array.isArray(claimPlan.fallbackInstructions) && claimPlan.fallbackInstructions.length
      ? claimPlan.fallbackInstructions
      : [
          `Connect Phantom, Backpack, or Solflare and call MessageTransmitter.receiveMessage (${claimPlan.programs?.messageTransmitter || 'CCTP'}) for messageHash ${claimPlan.messageHash || 'unknown'}.`,
        ];

  const txBytes = base64ToUint8Array(claimPlan.serializedTransactionBase64);
  const msgBytes = base64ToUint8Array(claimPlan.serializedMessageBase64);
  if (!txBytes) {
    const err = new Error(
      'Solana claim transaction could not be serialized (missing recentBlockhash from RPC). Retry or submit manually.'
    );
    err.code = 'SOLANA_BLOCKHASH_UNAVAILABLE';
    err.fallbackInstructions = fallbackInstructions;
    throw err;
  }

  const walletName = connectedSolanaWalletName || 'Solana Wallet';

  // 1. Wallet Standard (`solana:signAndSendTransaction`) — Phantom, Backpack, Solflare modern standard
  if (activeSolanaSession?.kind === 'standard') {
    const stdFeature = activeSolanaSession.wallet?.features?.['solana:signAndSendTransaction'];
    if (typeof stdFeature?.signAndSendTransaction === 'function') {
      const account = pickSolanaStandardAccount(activeSolanaSession.wallet.accounts);
      if (!account) {
        throw new Error(`No active Solana account exposed by ${walletName}.`);
      }
      const res = await stdFeature.signAndSendTransaction({
        transaction: txBytes,
        account,
        chain: 'solana:mainnet',
      });
      const signature = extractSolanaSignature(res);
      if (!signature) {
        throw new Error(`${walletName} did not return a Solana transaction signature.`);
      }
      return {
        claimed: true,
        signature,
        walletName,
        mode: 'wallet_standard_sign_and_send',
        explorerUrl: `https://solscan.io/tx/${signature}`,
        recipientUsdcAta: claimPlan.recipientUsdcAta,
        amountUsdc: claimPlan.amountUsdc,
      };
    }
  }

  // 2. Legacy injected provider (`signAndSendTransaction` / `request`) — Phantom, Backpack, Solflare
  const provider =
    activeSolanaSession?.provider ||
    (typeof window !== 'undefined'
      ? window.phantom?.solana ||
        window.backpack?.solana ||
        window.backpack ||
        window.solflare ||
        window.solana
      : null);

  if (provider && typeof provider.signAndSendTransaction === 'function') {
    const txLike = {
      serialize: () => txBytes,
      serializeMessage: () => msgBytes || txBytes,
      recentBlockhash: claimPlan.recentBlockhash,
      feePayer: claimPlan.payer || connectedSolanaAddress,
      instructions: claimPlan.instructions,
      serializedTransactionBase64: claimPlan.serializedTransactionBase64,
      serializedMessageBase64: claimPlan.serializedMessageBase64,
    };
    try {
      const res = await provider.signAndSendTransaction(txLike, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      const signature = extractSolanaSignature(res);
      if (!signature) {
        throw new Error(`${walletName} did not return a Solana transaction signature.`);
      }
      return {
        claimed: true,
        signature,
        walletName,
        mode: 'legacy_sign_and_send',
        explorerUrl: `https://solscan.io/tx/${signature}`,
        recipientUsdcAta: claimPlan.recipientUsdcAta,
        amountUsdc: claimPlan.amountUsdc,
      };
    } catch (err) {
      if (isUserRejectedError(err)) throw err;
      // Fallback to Phantom/Solflare native JSON-RPC `request({ method: 'signAndSendTransaction', params: { message } })`
      if (typeof provider.request === 'function' && msgBytes) {
        const rpcRes = await provider.request({
          method: 'signAndSendTransaction',
          params: { message: bytesToBase58(msgBytes) },
        });
        const signature = extractSolanaSignature(rpcRes);
        if (signature) {
          return {
            claimed: true,
            signature,
            walletName,
            mode: 'provider_request_sign_and_send',
            explorerUrl: `https://solscan.io/tx/${signature}`,
            recipientUsdcAta: claimPlan.recipientUsdcAta,
            amountUsdc: claimPlan.amountUsdc,
          };
        }
      }
      throw err;
    }
  }

  if (provider && typeof provider.request === 'function' && msgBytes) {
    const rpcRes = await provider.request({
      method: 'signAndSendTransaction',
      params: { message: bytesToBase58(msgBytes) },
    });
    const signature = extractSolanaSignature(rpcRes);
    if (!signature) {
      throw new Error(`${walletName} did not return a Solana transaction signature.`);
    }
    return {
      claimed: true,
      signature,
      walletName,
      mode: 'provider_request_sign_and_send',
      explorerUrl: `https://solscan.io/tx/${signature}`,
      recipientUsdcAta: claimPlan.recipientUsdcAta,
      amountUsdc: claimPlan.amountUsdc,
    };
  }

  // 3. Clean fallback error when active Solana wallet does not expose signAndSendTransaction
  const unsupportedErr = new Error(
    `${walletName} does not expose signAndSendTransaction. Connect Phantom, Backpack, or Solflare, or follow the fallback instructions to claim manually.`
  );
  unsupportedErr.code = 'SOLANA_SIGN_AND_SEND_UNSUPPORTED';
  unsupportedErr.fallbackInstructions = fallbackInstructions;
  unsupportedErr.claimPlanSummary = {
    messageHash: claimPlan.messageHash,
    messageTransmitter: claimPlan.programs?.messageTransmitter,
    recipientUsdcAta: claimPlan.recipientUsdcAta,
    amountUsdc: claimPlan.amountUsdc,
  };
  throw unsupportedErr;
}

// =====================================================================
// MULTI-FAMILY WALLET CONNECTORS (Cosmos, Sui, Aptos, TON, Tron, Bitcoin)
// =====================================================================

export const FAMILY_WALLET_CATALOG = {
  keplr: { name: 'Keplr', installUrl: 'https://www.keplr.app' },
  leap: { name: 'Leap Wallet', installUrl: 'https://www.leapwallet.io' },
  cosmostation: { name: 'Cosmostation', installUrl: 'https://www.cosmostation.io/wallet' },
  'okx-cosmos': { name: 'OKX Wallet (Cosmos)', installUrl: 'https://www.okx.com/web3' },
  ctrl: { name: 'Ctrl / XDEFI', installUrl: 'https://ctrl.xyz' },
  frontier: { name: 'Frontier', installUrl: 'https://www.frontier.xyz' },
  'sui-wallet': { name: 'Slush / Sui Wallet', installUrl: 'https://slush.app' },
  'phantom-sui': { name: 'Phantom (Sui)', installUrl: 'https://phantom.app' },
  petra: { name: 'Petra Wallet', installUrl: 'https://petra.app' },
  'phantom-aptos': { name: 'Phantom (Aptos)', installUrl: 'https://phantom.app' },
  tonkeeper: { name: 'Tonkeeper', installUrl: 'https://tonkeeper.com' },
  openmask: { name: 'OpenMask', installUrl: 'https://www.openmask.app' },
  tronlink: { name: 'TronLink', installUrl: 'https://www.tronlink.org' },
  unisat: { name: 'UniSat Wallet', installUrl: 'https://unisat.io' },
  xverse: { name: 'Xverse', installUrl: 'https://www.xverse.app' },
  'phantom-btc': { name: 'Phantom (Bitcoin)', installUrl: 'https://phantom.app' },
};

function detachFamilyListeners(family) {
  const entry = familyWalletCleanups[family];
  if (!entry) return;
  entry.active = false;
  try {
    entry.cleanup?.();
  } catch {
    // ignore cleanup errors
  }
  delete familyWalletCleanups[family];
}

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
  detachFamilyListeners(family);
  delete familyWalletSessions[family];
}

function isTonConnect2Bridge(prov) {
  return Boolean(
    prov &&
      typeof prov.connect === 'function' &&
      (Number(prov.protocolVersion) >= 2 ||
        typeof prov.restoreConnection === 'function' ||
        typeof prov.listen === 'function')
  );
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
    if (window.tonkeeper?.tonconnect) {
      out.push({
        id: 'tonkeeper',
        name: 'Tonkeeper',
        standard: 'TonConnect 2',
        icon: '/logos/tonkeeper.svg',
        kind: 'tonconnect2',
        provider: window.tonkeeper.tonconnect,
      });
    } else if (window.tonkeeper) {
      const isTc2 = isTonConnect2Bridge(window.tonkeeper);
      out.push({
        id: 'tonkeeper',
        name: 'Tonkeeper',
        standard: isTc2 ? 'TonConnect 2' : 'TON Extension',
        icon: '/logos/tonkeeper.svg',
        kind: isTc2 ? 'tonconnect2' : 'legacy-ton',
        provider: window.tonkeeper,
      });
    } else if (window.ton && !window.ton.isOpenMask) {
      const isTc2 = isTonConnect2Bridge(window.ton);
      out.push({
        id: 'tonkeeper',
        name: 'Tonkeeper',
        standard: isTc2 ? 'TonConnect 2' : 'TON Extension',
        icon: '/logos/tonkeeper.svg',
        kind: isTc2 ? 'tonconnect2' : 'legacy-ton',
        provider: window.ton,
      });
    }
    if (window.openmask?.tonconnect) {
      out.push({
        id: 'openmask',
        name: 'OpenMask',
        standard: 'TonConnect 2',
        icon: '/logos/ton.svg',
        kind: 'tonconnect2',
        provider: window.openmask.tonconnect,
      });
    } else if (window.openmask) {
      const isTc2 = isTonConnect2Bridge(window.openmask);
      out.push({
        id: 'openmask',
        name: 'OpenMask',
        standard: isTc2 ? 'TonConnect 2' : 'TON Extension',
        icon: '/logos/ton.svg',
        kind: isTc2 ? 'tonconnect2' : 'legacy-ton',
        provider: window.openmask,
      });
    } else if (window.ton?.isOpenMask) {
      out.push({
        id: 'openmask',
        name: 'OpenMask',
        standard: 'TON Extension',
        icon: '/logos/ton.svg',
        kind: 'legacy-ton',
        provider: window.ton,
      });
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

function makeCosmosBech32Config(prefix) {
  return {
    bech32PrefixAccAddr: prefix,
    bech32PrefixAccPub: `${prefix}pub`,
    bech32PrefixValAddr: `${prefix}valoper`,
    bech32PrefixValPub: `${prefix}valoperpub`,
    bech32PrefixConsAddr: `${prefix}valcons`,
    bech32PrefixConsPub: `${prefix}valconspub`,
  };
}

export const COSMOS_CONNECT_CHAINS = [
  {
    key: 'cosmoshub',
    chainId: 'cosmoshub-4',
    chainName: 'Cosmos Hub',
    cosmostationNames: ['cosmos', 'cosmoshub', 'Cosmos Hub', 'cosmoshub-4'],
    suggestInfo: {
      chainId: 'cosmoshub-4',
      chainName: 'Cosmos Hub',
      rpc: 'https://rpc.cosmos.directory/cosmoshub',
      rest: 'https://rest.cosmos.directory/cosmoshub',
      bip44: { coinType: 118 },
      bech32Config: makeCosmosBech32Config('cosmos'),
      currencies: [{ coinDenom: 'ATOM', coinMinimalDenom: 'uatom', coinDecimals: 6 }],
      feeCurrencies: [{ coinDenom: 'ATOM', coinMinimalDenom: 'uatom', coinDecimals: 6 }],
      stakeCurrency: { coinDenom: 'ATOM', coinMinimalDenom: 'uatom', coinDecimals: 6 },
      features: ['ibc-transfer', 'ibc-go'],
    },
  },
  {
    key: 'osmosis',
    chainId: 'osmosis-1',
    chainName: 'Osmosis',
    cosmostationNames: ['osmosis', 'Osmosis', 'osmosis-1'],
    suggestInfo: {
      chainId: 'osmosis-1',
      chainName: 'Osmosis',
      rpc: 'https://rpc.cosmos.directory/osmosis',
      rest: 'https://rest.cosmos.directory/osmosis',
      bip44: { coinType: 118 },
      bech32Config: makeCosmosBech32Config('osmo'),
      currencies: [{ coinDenom: 'OSMO', coinMinimalDenom: 'uosmo', coinDecimals: 6 }],
      feeCurrencies: [{ coinDenom: 'OSMO', coinMinimalDenom: 'uosmo', coinDecimals: 6 }],
      stakeCurrency: { coinDenom: 'OSMO', coinMinimalDenom: 'uosmo', coinDecimals: 6 },
      features: ['ibc-transfer', 'ibc-go'],
    },
  },
  {
    key: 'noble',
    chainId: 'noble-1',
    chainName: 'Noble',
    cosmostationNames: ['noble', 'Noble', 'noble-1'],
    suggestInfo: {
      chainId: 'noble-1',
      chainName: 'Noble',
      rpc: 'https://rpc.cosmos.directory/noble',
      rest: 'https://rest.cosmos.directory/noble',
      bip44: { coinType: 118 },
      bech32Config: makeCosmosBech32Config('noble'),
      currencies: [{ coinDenom: 'USDC', coinMinimalDenom: 'uusdc', coinDecimals: 6 }],
      feeCurrencies: [{ coinDenom: 'USDC', coinMinimalDenom: 'uusdc', coinDecimals: 6 }],
      stakeCurrency: { coinDenom: 'STAKE', coinMinimalDenom: 'ustake', coinDecimals: 6 },
      features: ['ibc-transfer', 'ibc-go'],
    },
  },
  {
    key: 'celestia',
    chainId: 'celestia',
    chainName: 'Celestia',
    cosmostationNames: ['celestia', 'Celestia'],
    suggestInfo: {
      chainId: 'celestia',
      chainName: 'Celestia',
      rpc: 'https://rpc.cosmos.directory/celestia',
      rest: 'https://rest.cosmos.directory/celestia',
      bip44: { coinType: 118 },
      bech32Config: makeCosmosBech32Config('celestia'),
      currencies: [{ coinDenom: 'TIA', coinMinimalDenom: 'utia', coinDecimals: 6 }],
      feeCurrencies: [{ coinDenom: 'TIA', coinMinimalDenom: 'utia', coinDecimals: 6 }],
      stakeCurrency: { coinDenom: 'TIA', coinMinimalDenom: 'utia', coinDecimals: 6 },
      features: ['ibc-transfer', 'ibc-go'],
    },
  },
  {
    key: 'injective',
    chainId: 'injective-1',
    chainName: 'Injective',
    cosmostationNames: ['injective', 'Injective', 'injective-1'],
    suggestInfo: {
      chainId: 'injective-1',
      chainName: 'Injective',
      rpc: 'https://rpc.cosmos.directory/injective',
      rest: 'https://rest.cosmos.directory/injective',
      bip44: { coinType: 60 },
      bech32Config: makeCosmosBech32Config('inj'),
      currencies: [{ coinDenom: 'INJ', coinMinimalDenom: 'inj', coinDecimals: 18 }],
      feeCurrencies: [{ coinDenom: 'INJ', coinMinimalDenom: 'inj', coinDecimals: 18 }],
      stakeCurrency: { coinDenom: 'INJ', coinMinimalDenom: 'inj', coinDecimals: 18 },
      features: ['eth-address-gen', 'eth-key-sign', 'ibc-transfer', 'ibc-go'],
    },
  },
  {
    key: 'neutron',
    chainId: 'neutron-1',
    chainName: 'Neutron',
    cosmostationNames: ['neutron', 'Neutron', 'neutron-1'],
    suggestInfo: {
      chainId: 'neutron-1',
      chainName: 'Neutron',
      rpc: 'https://rpc.cosmos.directory/neutron',
      rest: 'https://rest.cosmos.directory/neutron',
      bip44: { coinType: 118 },
      bech32Config: makeCosmosBech32Config('neutron'),
      currencies: [{ coinDenom: 'NTRN', coinMinimalDenom: 'untrn', coinDecimals: 6 }],
      feeCurrencies: [{ coinDenom: 'NTRN', coinMinimalDenom: 'untrn', coinDecimals: 6 }],
      stakeCurrency: { coinDenom: 'NTRN', coinMinimalDenom: 'untrn', coinDecimals: 6 },
      features: ['ibc-transfer', 'ibc-go'],
    },
  },
];

function getCosmostationCandidateNames(chainEntry, supportedNames = null) {
  const base = [];
  if (Array.isArray(chainEntry?.cosmostationNames)) base.push(...chainEntry.cosmostationNames);
  if (chainEntry?.key) base.push(chainEntry.key);
  if (chainEntry?.chainName) base.push(chainEntry.chainName);
  if (chainEntry?.chainId) base.push(chainEntry.chainId);
  const deduped = Array.from(new Set(base.filter(Boolean)));
  if (Array.isArray(supportedNames) && supportedNames.length) {
    const lowerMap = new Map(supportedNames.map((n) => [String(n).toLowerCase(), String(n)]));
    const matched = [];
    for (const candidate of deduped) {
      const exact = lowerMap.get(String(candidate).toLowerCase());
      if (exact && !matched.includes(exact)) matched.push(exact);
    }
    if (matched.length) {
      return [...matched, ...deduped.filter((n) => !matched.includes(n))];
    }
  }
  return deduped;
}

async function queryCosmostationSupportedChainNames(provider) {
  if (typeof provider?.request !== 'function') return null;
  try {
    const res = await provider.request({ method: 'cos_supportedChainNames' });
    const all = [
      ...(Array.isArray(res?.official) ? res.official : []),
      ...(Array.isArray(res?.unofficial) ? res.unofficial : []),
    ];
    return all.length ? all : null;
  } catch {
    return null;
  }
}

async function readCosmosChainAddress(provider, chainOrId, cosmostationSupportedNames = null) {
  const chainEntry =
    typeof chainOrId === 'string'
      ? COSMOS_CONNECT_CHAINS.find((c) => c.chainId === chainOrId || c.key === chainOrId) || {
          key: chainOrId,
          chainId: chainOrId,
        }
      : chainOrId;
  const chainId = chainEntry.chainId;

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
    const candidates = getCosmostationCandidateNames(chainEntry, cosmostationSupportedNames);
    for (const method of ['cos_account', 'cos_requestAccount']) {
      for (const chainName of candidates) {
        try {
          const acc = await provider.request({ method, params: { chainName } });
          if (acc?.address) return acc.address;
        } catch (err) {
          if (isUserRejectedError(err)) throw err;
          // Try next registry chain-name candidate (e.g. 'cosmos' -> 'cosmoshub' -> 'cosmoshub-4')
        }
      }
    }
  }
  return null;
}

async function readAllCosmosAddresses(provider, chains, cosmostationSupportedNames = null) {
  const foundMap = {};
  const settled = await Promise.allSettled(
    chains.map(async (c) => [c.key, await readCosmosChainAddress(provider, c, cosmostationSupportedNames)])
  );
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value?.[1]) {
      foundMap[r.value[0]] = r.value[1];
    }
  }
  const primary =
    foundMap.cosmoshub ||
    foundMap.osmosis ||
    foundMap.noble ||
    Object.values(foundMap)[0] ||
    null;
  return { foundMap, primary };
}

function selectSuiMainnetAccount(accounts, walletChains = null) {
  const wChains = Array.isArray(walletChains) ? walletChains.map((c) => String(c)) : [];
  const wSuiChains = wChains.filter((c) => c.startsWith('sui:'));
  if (wSuiChains.length && !wSuiChains.includes('sui:mainnet')) {
    return {
      ok: false,
      detectedChain: wSuiChains[0],
      error: `Sui wallet is connected to ${wSuiChains[0]} (non-mainnet). Switch to Sui Mainnet (sui:mainnet) and reconnect.`,
    };
  }
  if (!Array.isArray(accounts) || !accounts.length) {
    return { ok: true, account: null };
  }
  const suiAccounts = accounts.filter(
    (a) =>
      a?.address &&
      (!Array.isArray(a.chains) || a.chains.length === 0 || a.chains.some((c) => String(c).startsWith('sui:')))
  );
  if (!suiAccounts.length) return { ok: true, account: null };

  const accountsWithChains = suiAccounts.filter((a) => Array.isArray(a.chains) && a.chains.length > 0);
  if (accountsWithChains.length) {
    const mainnetAcc = accountsWithChains.find((a) => a.chains.some((c) => String(c) === 'sui:mainnet'));
    if (!mainnetAcc) {
      const detected = accountsWithChains[0].chains.find((c) => String(c).startsWith('sui:')) || accountsWithChains[0].chains[0];
      return {
        ok: false,
        detectedChain: detected,
        error: `Sui wallet account is on ${detected} instead of sui:mainnet. Switch your Sui wallet to Mainnet and reconnect.`,
      };
    }
    return { ok: true, account: mainnetAcc };
  }
  return { ok: true, account: suiAccounts[0] };
}

function isAptosMainnetNetwork(net) {
  if (!net) return false;
  if (typeof net === 'string') {
    return net.trim().toLowerCase() === 'mainnet';
  }
  if (typeof net === 'object') {
    const name = String(net.name || net.network || '').trim().toLowerCase();
    const chainId = net.chainId !== undefined && net.chainId !== null ? String(net.chainId).trim() : '';
    const url = String(net.url || '').trim().toLowerCase();
    if (/testnet|devnet|localnet/.test(name) || /testnet|devnet|localhost|127\.0\.0\.1/.test(url)) {
      return false;
    }
    if (name === 'mainnet') return true;
    if (chainId === '1') return true;
    return false;
  }
  return false;
}

function describeAptosNetwork(net) {
  if (!net) return 'unknown';
  if (typeof net === 'string') return net;
  return net.name || net.network || (net.chainId !== undefined ? `chainId ${net.chainId}` : 'unknown');
}

const TRON_BASE58_ADDR_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

function readReadyTronWeb() {
  const candidates = [window.tronLink?.tronWeb, window.tronWeb].filter(Boolean);
  for (const tw of candidates) {
    const base58 = typeof tw?.defaultAddress?.base58 === 'string' ? tw.defaultAddress.base58.trim() : '';
    if (base58 && TRON_BASE58_ADDR_RE.test(base58) && tw.ready !== false) {
      return { tronWeb: tw, address: base58 };
    }
  }
  return null;
}

async function waitForTronWebReady(timeoutMs = 2500, intervalMs = 50) {
  const immediate = readReadyTronWeb();
  if (immediate) return immediate;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  const step = Math.max(5, Number(intervalMs) || 50);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, step));
    const ready = readReadyTronWeb();
    if (ready) return ready;
  }
  return readReadyTronWeb();
}

function isTronTestnetNode(nodeOrTronWeb) {
  if (!nodeOrTronWeb) return false;
  const values = [];
  if (typeof nodeOrTronWeb === 'string') {
    values.push(nodeOrTronWeb);
  } else if (typeof nodeOrTronWeb === 'object') {
    values.push(
      nodeOrTronWeb.fullNode?.host,
      nodeOrTronWeb.solidityNode?.host,
      nodeOrTronWeb.eventServer?.host,
      nodeOrTronWeb.fullNode?.instance?.defaults?.baseURL,
      nodeOrTronWeb.host,
      nodeOrTronWeb.fullHost,
      nodeOrTronWeb.node?.fullNode,
      nodeOrTronWeb.node?.solidityNode,
      nodeOrTronWeb.node?.eventServer,
      nodeOrTronWeb.node?.chain,
      nodeOrTronWeb.node?.name,
      nodeOrTronWeb.network,
      nodeOrTronWeb.chain,
      nodeOrTronWeb.chainId
    );
  }
  const combined = values
    .filter((v) => typeof v === 'string' && v.trim())
    .join(' ')
    .toLowerCase();
  if (!combined) return false;
  return (
    combined.includes('shasta') ||
    combined.includes('nile') ||
    combined.includes('testnet') ||
    combined.includes('0x94a9059e') ||
    combined.includes('0xcd8690dc')
  );
}

export function isBitcoinMainnetAddress(addr) {
  const s = String(addr || '').trim();
  if (!s) return false;
  // Explicitly reject testnet/signet/regtest prefixes (tb1, bcrt1, m, n, 2)
  if (/^(tb1|bcrt1|[mn2])/i.test(s)) return false;
  return /^(bc1[ac-hj-np-z02-9]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/i.test(s);
}

function isUniSatMainnetNetwork(network, chain = null) {
  if (chain && typeof chain === 'object') {
    const chainEnum = String(chain.enum || '').trim().toUpperCase();
    const chainNet = String(chain.network || '').trim().toLowerCase();
    if (chainEnum) {
      if (chainEnum !== 'BITCOIN_MAINNET') return false;
    } else if (chainNet && chainNet !== 'livenet' && chainNet !== 'mainnet') {
      return false;
    }
  }
  if (network !== undefined && network !== null) {
    const netStr =
      typeof network === 'string'
        ? network.trim().toLowerCase()
        : String(network.network || network.enum || '').trim().toLowerCase();
    if (netStr !== 'livenet' && netStr !== 'mainnet' && netStr !== 'bitcoin_mainnet') {
      return false;
    }
  }
  return true;
}

function isTonTestnetNetwork(net) {
  if (net === undefined || net === null || net === '') return false;
  const s = String(net).trim().toLowerCase();
  if (s === '-239' || s === 'mainnet') return false;
  return s === '-3' || s.includes('test') || s !== '-239';
}

export async function connectFamilyWallet(family, opts = {}) {
  if (family === 'evm') return connectEvmWallet(opts);
  const wallets = listAvailableFamilyWallets(family);
  const requestedCatalog = opts.walletId ? FAMILY_WALLET_CATALOG[opts.walletId] : null;

  if (opts.walletId) {
    const exactMatch = wallets.find((w) => w.id === opts.walletId);
    if (!exactMatch) {
      const displayName = requestedCatalog?.name || opts.walletId;
      const installHint = requestedCatalog?.installUrl ? ` Install it from ${requestedCatalog.installUrl} or` : '';
      const err = new Error(
        `${displayName} extension is not detected on this page.${installHint} unlock it and allow site access on 127.0.0.1, then retry.`
      );
      err.code = 'WALLET_NOT_INSTALLED';
      err.walletId = opts.walletId;
      err.walletName = displayName;
      err.installUrl = requestedCatalog?.installUrl || null;
      throw err;
    }
  }

  if (!wallets.length) {
    if (family === 'cosmos') {
      throw new Error(
        'No Cosmos extension detected on this page. Unlock Keplr, Leap, Cosmostation, or OKX Wallet and allow site access on 127.0.0.1, then retry.'
      );
    }
    throw new Error(`No ${family.toUpperCase()} browser wallet detected. Install a supported wallet or paste an address to inspect.`);
  }

  const chosen = opts.walletId ? wallets.find((w) => w.id === opts.walletId) : wallets[0];
  let address = null;
  let addressesByChain = null;
  let cosmosEnabledChains = null;
  let cosmosFailedChains = [];
  let cosmosSuggestedChains = [];
  let cosmosSupportedNames = null;
  let cosmosRequestedChains = null;

  if (family === 'cosmos') {
    const prov = chosen.provider;
    cosmosRequestedChains = opts.chainId
      ? [
          COSMOS_CONNECT_CHAINS.find((c) => c.chainId === opts.chainId || c.key === opts.chainId) || {
            key: 'custom',
            chainId: opts.chainId,
            chainName: opts.chainId,
          },
        ]
      : COSMOS_CONNECT_CHAINS;
    const chainIds = cosmosRequestedChains.map((c) => c.chainId);

    // 1. Try batch enable across all 6 Cosmos chains; if a secondary chain fails/isn't suggested,
    // fall back to per-chain enable + experimentalSuggestChain + partial chain enablement.
    if (typeof prov.enable === 'function') {
      try {
        await prov.enable(chainIds);
        cosmosEnabledChains = [...cosmosRequestedChains];
      } catch (batchErr) {
        if (isUserRejectedError(batchErr)) {
          throw new Error(
            `${chosen.name} connection was rejected. Unlock ${chosen.name}, approve access, and ensure extension site access is allowed on 127.0.0.1.`
          );
        }
        const enabled = [];
        for (const c of cosmosRequestedChains) {
          try {
            await prov.enable(c.chainId);
            enabled.push(c);
          } catch (singleErr) {
            if (!isUserRejectedError(singleErr) && typeof prov.experimentalSuggestChain === 'function' && c.suggestInfo) {
              try {
                await prov.experimentalSuggestChain(c.suggestInfo);
                await prov.enable(c.chainId);
                enabled.push(c);
                cosmosSuggestedChains.push(c.chainId);
                continue;
              } catch {
                // fall through to partial chain failure record
              }
            }
            cosmosFailedChains.push(c.chainId);
          }
        }
        if (!enabled.length) {
          const reason = batchErr?.message ? ` (${batchErr.message})` : '';
          throw new Error(
            `${chosen.name} could not enable any Cosmos chain${reason}. Unlock ${chosen.name}, approve access, and ensure extension site access is allowed on 127.0.0.1.`
          );
        }
        cosmosEnabledChains = enabled;
      }
    } else {
      cosmosEnabledChains = [...cosmosRequestedChains];
      cosmosSupportedNames = await queryCosmostationSupportedChainNames(prov);
    }

    // 2. Read Bech32 address across enabled Cosmos chains
    const { foundMap, primary } = await readAllCosmosAddresses(prov, cosmosEnabledChains, cosmosSupportedNames);
    addressesByChain = foundMap;
    address = primary;

    if (!address) {
      throw new Error(
        `${chosen.name} returned no Cosmos account address. Unlock ${chosen.name}, ensure an account is active, and allow site access on 127.0.0.1 before retrying.`
      );
    }
  } else if (family === 'sui') {
    if (chosen.kind === 'standard') {
      const res = await chosen.wallet.features['standard:connect'].connect();
      const rawAccounts = res?.accounts?.length ? res.accounts : chosen.wallet.accounts || [];
      const selected = selectSuiMainnetAccount(rawAccounts, chosen.wallet.chains);
      if (!selected.ok) {
        throw new Error(selected.error);
      }
      address = selected.account?.address || null;
    } else {
      let res = null;
      if (typeof chosen.provider.requestPermissions === 'function') {
        await chosen.provider.requestPermissions();
        const accs = await chosen.provider.getAccounts();
        address = accs?.[0]?.address || accs?.[0] || null;
      } else if (typeof chosen.provider.connect === 'function') {
        res = await chosen.provider.connect();
        address = res?.address || res?.accounts?.[0]?.address || null;
      }
      let legacyChain = res?.chain || res?.network || chosen.provider.network || chosen.provider.chain || null;
      if (!legacyChain && typeof chosen.provider.getChain === 'function') {
        try {
          legacyChain = await chosen.provider.getChain();
        } catch {
          // ignore if wallet doesn't support getChain
        }
      }
      if (legacyChain) {
        const chainStr = String(legacyChain).toLowerCase();
        if (!chainStr.includes('mainnet')) {
          throw new Error(
            `Sui wallet is connected to ${legacyChain} (non-mainnet). Switch to Sui Mainnet (sui:mainnet) and reconnect.`
          );
        }
      }
    }
  } else if (family === 'aptos') {
    const res = await chosen.provider.connect();
    address = res?.address || (await chosen.provider.account?.())?.address || null;
    if (typeof chosen.provider.network === 'function' || typeof chosen.provider.getNetwork === 'function') {
      let net = null;
      try {
        net =
          typeof chosen.provider.network === 'function'
            ? await chosen.provider.network()
            : await chosen.provider.getNetwork();
      } catch (err) {
        throw new Error(
          `Could not verify Aptos network (${err?.message || 'network check failed'}). Switch ${chosen.name} to Aptos Mainnet and reconnect.`
        );
      }
      if (!isAptosMainnetNetwork(net)) {
        throw new Error(
          `${chosen.name} is connected to Aptos ${describeAptosNetwork(net)}. Switch to Aptos Mainnet and reconnect.`
        );
      }
    } else if (res?.network && !isAptosMainnetNetwork(res.network)) {
      throw new Error(
        `${chosen.name} is connected to Aptos ${describeAptosNetwork(res.network)}. Switch to Aptos Mainnet and reconnect.`
      );
    }
  } else if (family === 'ton') {
    const prov = chosen.provider;
    if (chosen.kind === 'tonconnect2' || isTonConnect2Bridge(prov)) {
      const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://siphon.app';
      const manifestUrl = opts.manifestUrl || `${origin}/tonconnect-manifest.json`;
      let res;
      try {
        res = await prov.connect(2, {
          manifestUrl,
          items: [{ name: 'ton_addr' }],
        });
      } catch (err) {
        if (isUserRejectedError(err)) {
          throw new Error(`${chosen.name} connection was rejected by the user.`);
        }
        throw new Error(
          `${chosen.name} TonConnect 2 connection failed: ${err?.message || 'bridge error'}. Ensure ${chosen.name} is unlocked and updated.`
        );
      }
      if (res?.event === 'connect_error') {
        const code = res?.payload?.code;
        const msg = res?.payload?.message || 'connection failed';
        if (code === 300 || /reject|declin|cancel/i.test(msg)) {
          throw new Error(`${chosen.name} connection was rejected by the user.`);
        }
        if (code === 2 || /manifest/i.test(msg)) {
          throw new Error(
            `${chosen.name} could not load TonConnect manifest (${msg}). Ensure /tonconnect-manifest.json is reachable from your wallet.`
          );
        }
        throw new Error(`${chosen.name} TonConnect 2 error${code ? ` (${code})` : ''}: ${msg}`);
      }
      const items = Array.isArray(res?.payload?.items) ? res.payload.items : [];
      const addrItem = items.find((it) => it?.name === 'ton_addr') || items[0] || null;
      if (addrItem?.network !== undefined && isTonTestnetNetwork(addrItem.network)) {
        throw new Error(
          `${chosen.name} is connected to TON Testnet (${addrItem.network}). Switch to TON Mainnet (-239) and reconnect.`
        );
      }
      address = addrItem?.address || res?.account?.address || res?.address || null;
    } else if (typeof prov.send === 'function') {
      const accs = await prov.send('ton_requestAccounts');
      address = Array.isArray(accs) ? accs[0] : accs?.address || null;
      let chain = prov.chainId ?? null;
      if (chain === null) {
        try {
          chain = await prov.send('ton_getChain');
        } catch {
          // optional method on legacy providers
        }
      }
      if (chain !== null && chain !== undefined && isTonTestnetNetwork(chain)) {
        throw new Error(
          `${chosen.name} is connected to TON Testnet (${chain}). Switch to TON Mainnet (-239) and reconnect.`
        );
      }
    } else if (typeof prov.connect === 'function') {
      const res = await prov.connect();
      address = res?.account?.address || res?.address || null;
    } else {
      throw new Error(
        `${chosen.name} does not expose a supported TonConnect 2 JS Bridge or ton_requestAccounts API.`
      );
    }
  } else if (family === 'tron') {
    let lockedHint = false;
    if (typeof window.tronLink?.request === 'function') {
      const res = await window.tronLink.request({ method: 'tron_requestAccounts' });
      if (res === '' || res === undefined || res === false) {
        lockedHint = true;
      } else if (res && typeof res === 'object' && res.code && res.code !== 200) {
        if (res.code === 4000) {
          throw new Error(
            'TronLink connection request is already pending. Open the TronLink extension popup to approve.'
          );
        }
        if (res.code === 4001) {
          throw new Error('TronLink connection was rejected by the user.');
        }
        throw new Error(res.message || `TronLink connection rejected (code ${res.code}).`);
      }
    }
    const readyTimeout = lockedHint
      ? Math.min(250, Number(opts.tronReadyTimeoutMs ?? 250))
      : Number(opts.tronReadyTimeoutMs ?? 2500);
    const readyResult = await waitForTronWebReady(readyTimeout, Number(opts.tronPollIntervalMs ?? 50));
    if (!readyResult?.address) {
      throw new Error(
        lockedHint
          ? 'TronLink is locked. Unlock your TronLink extension and retry.'
          : 'TronLink is locked or tronWeb did not finish initializing. Unlock TronLink, approve site access, and retry.'
      );
    }
    if (isTronTestnetNode(readyResult.tronWeb)) {
      throw new Error(
        'TronLink is connected to a Tron testnet (Shasta/Nile). Switch TronLink to Tron Mainnet and reconnect.'
      );
    }
    address = readyResult.address;
  } else if (family === 'btc') {
    if (chosen.id === 'unisat') {
      const accs = await chosen.provider.requestAccounts();
      address = accs?.[0] || null;
      if (typeof chosen.provider.getChain === 'function') {
        let chainInfo = null;
        try {
          chainInfo = await chosen.provider.getChain();
        } catch (err) {
          throw new Error(
            `Could not verify UniSat Bitcoin network (${err?.message || 'getChain failed'}). Switch UniSat to Bitcoin Mainnet (livenet) and reconnect.`
          );
        }
        if (!chainInfo || !isUniSatMainnetNetwork(chainInfo.network, chainInfo)) {
          throw new Error(
            `UniSat is connected to ${chainInfo?.enum || chainInfo?.network || 'non-mainnet'}. Switch UniSat to Bitcoin Mainnet (livenet) and reconnect.`
          );
        }
      }
      if (typeof chosen.provider.getNetwork === 'function') {
        let net = null;
        try {
          net = await chosen.provider.getNetwork();
        } catch (err) {
          throw new Error(
            `Could not verify UniSat Bitcoin network (${err?.message || 'getNetwork failed'}). Switch UniSat to Bitcoin Mainnet (livenet) and reconnect.`
          );
        }
        if (!net || !isUniSatMainnetNetwork(net, null)) {
          throw new Error(
            `UniSat is connected to Bitcoin ${net || 'non-mainnet'}. Switch UniSat to Bitcoin Mainnet (livenet) and reconnect.`
          );
        }
      }
      if (address && !isBitcoinMainnetAddress(address)) {
        throw new Error(
          `UniSat returned a non-mainnet Bitcoin address (${address}). Switch to Bitcoin Mainnet (livenet) and reconnect.`
        );
      }
    } else if (chosen.id === 'phantom-btc') {
      const accs = await chosen.provider.requestAccounts();
      const payment = accs?.find((a) => a.purpose === 'payment') || accs?.[0];
      address = payment?.address || (typeof payment === 'string' ? payment : null);
      if (address && !isBitcoinMainnetAddress(address)) {
        throw new Error(
          `Phantom Bitcoin returned a non-mainnet address (${address}). Switch to Bitcoin Mainnet and reconnect.`
        );
      }
    } else if (typeof chosen.provider.request === 'function') {
      // Request strictly `payment` accounts (never `ordinals`) to avoid sweeping inscribed Taproot UTXOs
      const res = await chosen.provider.request('getAccounts', { purposes: ['payment'] });
      const accs = res?.result || res || [];
      const payment = Array.isArray(accs)
        ? accs.find((a) => a?.purpose === 'payment') || null
        : null;
      address = payment?.address || null;
      if (address && !isBitcoinMainnetAddress(address)) {
        throw new Error(
          `${chosen.name} returned a non-mainnet Bitcoin address (${address}). Switch to Bitcoin Mainnet and reconnect.`
        );
      }
    }
  }

  if (!address) {
    throw new Error(`${chosen.name} connection was cancelled or returned no address.`);
  }

  detachFamilyListeners(family);

  const session = {
    family,
    address,
    addressesByChain,
    walletName: chosen.name,
    walletId: chosen.id,
    provider: chosen.provider || chosen.wallet,
    kind: chosen.kind || 'extension',
    ...(family === 'cosmos'
      ? {
          enabledChains: (cosmosEnabledChains || []).map((c) => c.chainId),
          failedChains: cosmosFailedChains,
          suggestedChains: cosmosSuggestedChains,
        }
      : {}),
  };
  familyWalletSessions[family] = session;

  // Attach lifecycle listeners with active-session guard & deterministic cleanup
  const listenerState = { active: true, cleanup: null };
  familyWalletCleanups[family] = listenerState;
  const isCurrentSession = () => listenerState.active && familyWalletSessions[family] === session;

  if (family === 'cosmos') {
    const prov = chosen.provider;
    const refreshChains = cosmosRequestedChains || COSMOS_CONNECT_CHAINS;
    const onKeystoreChange = async () => {
      if (!isCurrentSession()) return;
      try {
        const { foundMap, primary } = await readAllCosmosAddresses(prov, refreshChains, cosmosSupportedNames);
        if (!isCurrentSession()) return;
        if (!primary) {
          disconnectFamilyWallet('cosmos');
          opts.onAccountChanged?.(null, { reason: 'disconnect', walletName: chosen.name });
          notifyWalletDiscovery();
          return;
        }
        session.address = primary;
        session.addressesByChain = foundMap;
        opts.onAccountChanged?.({
          address: primary,
          addressesByChain: foundMap,
          session,
          walletName: chosen.name,
        });
        notifyWalletDiscovery();
      } catch {
        // ignore transient keystore read failures
      }
    };
    const eventNames = [];
    if (chosen.id === 'leap') {
      eventNames.push('leap_keystorechange');
    } else if (chosen.id === 'cosmostation') {
      eventNames.push('cosmostation_keystorechange', 'keplr_keystorechange');
    } else {
      eventNames.push('keplr_keystorechange');
    }
    const cleanups = [];
    for (const ev of eventNames) {
      window.addEventListener(ev, onKeystoreChange);
      cleanups.push(() => window.removeEventListener(ev, onKeystoreChange));
    }
    if (typeof prov.on === 'function') {
      try {
        const off = prov.on('accountChanged', onKeystoreChange);
        if (typeof off === 'function') {
          cleanups.push(() => {
            try {
              off();
            } catch {
              // ignore
            }
          });
        } else {
          cleanups.push(() => removeProviderEventListener(prov, 'accountChanged', onKeystoreChange));
        }
      } catch {
        // ignore optional listener errors
      }
    }
    listenerState.cleanup = () => cleanups.forEach((fn) => fn());
  } else if (family === 'sui') {
    if (chosen.kind === 'standard' && typeof chosen.wallet?.features?.['standard:events']?.on === 'function') {
      try {
        const off = chosen.wallet.features['standard:events'].on('change', (props) => {
          if (!isCurrentSession() || !props) return;
          if (Array.isArray(props.chains)) {
            const suiChains = props.chains.map((c) => String(c)).filter((c) => c.startsWith('sui:'));
            if (suiChains.length && !suiChains.includes('sui:mainnet')) {
              const msg = `Sui wallet switched to ${suiChains[0]} (non-mainnet) — disconnected for safety.`;
              disconnectFamilyWallet('sui');
              opts.onNetworkChanged?.({ chain: suiChains[0], isMainnet: false });
              opts.onAccountChanged?.(null, { reason: 'testnet_rejected', message: msg, walletName: chosen.name });
              return;
            }
          }
          if (!Array.isArray(props.accounts)) return;
          const selected = selectSuiMainnetAccount(props.accounts, props.chains || chosen.wallet.chains);
          if (!selected.ok) {
            disconnectFamilyWallet('sui');
            opts.onNetworkChanged?.({ chain: selected.detectedChain, isMainnet: false });
            opts.onAccountChanged?.(null, { reason: 'testnet_rejected', message: selected.error, walletName: chosen.name });
            return;
          }
          const nextAddr = selected.account?.address || null;
          if (!nextAddr) {
            disconnectFamilyWallet('sui');
            opts.onAccountChanged?.(null, { reason: 'disconnect', walletName: chosen.name });
            return;
          }
          if (nextAddr === session.address) return;
          session.address = nextAddr;
          opts.onAccountChanged?.({ address: nextAddr, session, walletName: chosen.name });
        });
        if (typeof off === 'function') {
          listenerState.cleanup = () => {
            try {
              off();
            } catch {
              // ignore
            }
          };
        }
      } catch {
        // ignore optional event errors
      }
    }
  } else if (family === 'aptos') {
    const prov = chosen.provider;
    const cleanups = [];
    if (typeof prov.onAccountChange === 'function') {
      try {
        const unsub = prov.onAccountChange((nextAcc) => {
          if (!isCurrentSession()) return;
          const nextAddr = typeof nextAcc === 'string' ? nextAcc.trim() : nextAcc?.address?.trim?.() || null;
          if (!nextAddr) {
            disconnectFamilyWallet('aptos');
            opts.onAccountChanged?.(null, { reason: 'disconnect', walletName: chosen.name });
            return;
          }
          if (nextAddr === session.address) return;
          session.address = nextAddr;
          opts.onAccountChanged?.({ address: nextAddr, session, walletName: chosen.name });
        });
        if (typeof unsub === 'function') cleanups.push(() => unsub());
      } catch {
        // ignore
      }
    }
    if (typeof prov.onNetworkChange === 'function') {
      try {
        const unsub = prov.onNetworkChange((nextNet) => {
          if (!isCurrentSession()) return;
          const isMainnet = isAptosMainnetNetwork(nextNet);
          opts.onNetworkChanged?.({ network: nextNet, isMainnet });
          if (!isMainnet) {
            const msg = `${chosen.name} switched to Aptos ${describeAptosNetwork(nextNet)} — disconnected for safety.`;
            disconnectFamilyWallet('aptos');
            opts.onAccountChanged?.(null, { reason: 'testnet_rejected', message: msg, walletName: chosen.name });
          }
        });
        if (typeof unsub === 'function') cleanups.push(() => unsub());
      } catch {
        // ignore
      }
    }
    if (typeof prov.onDisconnect === 'function') {
      try {
        const unsub = prov.onDisconnect(() => {
          if (!isCurrentSession()) return;
          disconnectFamilyWallet('aptos');
          opts.onAccountChanged?.(null, { reason: 'disconnect', walletName: chosen.name });
        });
        if (typeof unsub === 'function') cleanups.push(() => unsub());
      } catch {
        // ignore
      }
    }
    listenerState.cleanup = () => {
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          // ignore
        }
      }
    };
  } else if (family === 'ton') {
    const prov = chosen.provider;
    if ((chosen.kind === 'tonconnect2' || isTonConnect2Bridge(prov)) && typeof prov.listen === 'function') {
      try {
        const off = prov.listen((event) => {
          if (!isCurrentSession() || !event) return;
          if (event.event === 'disconnect') {
            disconnectFamilyWallet('ton');
            opts.onAccountChanged?.(null, { reason: 'disconnect', walletName: chosen.name });
          }
        });
        if (typeof off === 'function') {
          listenerState.cleanup = () => {
            try {
              off();
            } catch {
              // ignore
            }
          };
        }
      } catch {
        // ignore
      }
    } else if (typeof prov.on === 'function') {
      const onAccounts = (accs) => {
        if (!isCurrentSession()) return;
        const nextAddr = Array.isArray(accs) ? accs[0] : accs?.address || null;
        if (!nextAddr) {
          disconnectFamilyWallet('ton');
          opts.onAccountChanged?.(null, { reason: 'disconnect', walletName: chosen.name });
          return;
        }
        if (nextAddr === session.address) return;
        session.address = nextAddr;
        opts.onAccountChanged?.({ address: nextAddr, session, walletName: chosen.name });
      };
      const onChain = (nextChain) => {
        if (!isCurrentSession()) return;
        const isTestnet = isTonTestnetNetwork(nextChain);
        opts.onNetworkChanged?.({ chain: nextChain, isMainnet: !isTestnet });
        if (isTestnet) {
          const msg = `${chosen.name} switched to TON Testnet (${nextChain}) — disconnected for safety.`;
          disconnectFamilyWallet('ton');
          opts.onAccountChanged?.(null, { reason: 'testnet_rejected', message: msg, walletName: chosen.name });
        }
      };
      prov.on('accountsChanged', onAccounts);
      prov.on('chainChanged', onChain);
      listenerState.cleanup = () => {
        removeProviderEventListener(prov, 'accountsChanged', onAccounts);
        removeProviderEventListener(prov, 'chainChanged', onChain);
      };
    }
  } else if (family === 'tron') {
    const onTronMessage = (event) => {
      if (!isCurrentSession()) return;
      const msg = event?.data?.message;
      if (!msg || typeof msg !== 'object') return;
      if (msg.action === 'setNode') {
        if (isTronTestnetNode(msg.data)) {
          const reasonMsg = 'TronLink switched to a Tron testnet (Shasta/Nile) — disconnected for safety.';
          disconnectFamilyWallet('tron');
          opts.onNetworkChanged?.({ node: msg.data, isMainnet: false });
          opts.onAccountChanged?.(null, { reason: 'testnet_rejected', message: reasonMsg, walletName: chosen.name });
        } else {
          opts.onNetworkChanged?.({ node: msg.data, isMainnet: true });
        }
      } else if (msg.action === 'accountsChanged' || msg.action === 'setAccount') {
        const nextAddr =
          typeof msg.data?.address === 'string' && TRON_BASE58_ADDR_RE.test(msg.data.address.trim())
            ? msg.data.address.trim()
            : null;
        if (!nextAddr) {
          disconnectFamilyWallet('tron');
          opts.onAccountChanged?.(null, { reason: 'disconnect', walletName: chosen.name });
          return;
        }
        if (nextAddr === session.address) return;
        session.address = nextAddr;
        opts.onAccountChanged?.({ address: nextAddr, session, walletName: chosen.name });
      } else if (msg.action === 'disconnect') {
        disconnectFamilyWallet('tron');
        opts.onAccountChanged?.(null, { reason: 'disconnect', walletName: chosen.name });
      }
    };
    window.addEventListener('message', onTronMessage);
    listenerState.cleanup = () => window.removeEventListener('message', onTronMessage);
  } else if (family === 'btc') {
    const prov = chosen.provider;
    if (chosen.id === 'unisat' && typeof prov.on === 'function') {
      const onAccountsChanged = (accs) => {
        if (!isCurrentSession()) return;
        const nextAddr = Array.isArray(accs) ? accs[0] : typeof accs === 'string' ? accs : null;
        if (!nextAddr) {
          disconnectFamilyWallet('btc');
          opts.onAccountChanged?.(null, { reason: 'disconnect', walletName: chosen.name });
          return;
        }
        if (!isBitcoinMainnetAddress(nextAddr)) {
          const msg = `UniSat switched to a non-mainnet Bitcoin address (${nextAddr}) — disconnected for safety.`;
          disconnectFamilyWallet('btc');
          opts.onAccountChanged?.(null, { reason: 'testnet_rejected', message: msg, walletName: chosen.name });
          return;
        }
        if (nextAddr === session.address) return;
        session.address = nextAddr;
        opts.onAccountChanged?.({ address: nextAddr, session, walletName: chosen.name });
      };
      const onNetworkChanged = (nextNet) => {
        if (!isCurrentSession()) return;
        const isMainnet = isUniSatMainnetNetwork(nextNet, null);
        opts.onNetworkChanged?.({ network: nextNet, isMainnet });
        if (!isMainnet) {
          const msg = `UniSat switched to Bitcoin ${nextNet || 'non-mainnet'} — disconnected for safety.`;
          disconnectFamilyWallet('btc');
          opts.onAccountChanged?.(null, { reason: 'testnet_rejected', message: msg, walletName: chosen.name });
        }
      };
      const onChainChanged = (nextChain) => {
        if (!isCurrentSession()) return;
        const isMainnet = isUniSatMainnetNetwork(nextChain?.network, nextChain);
        opts.onNetworkChanged?.({ chain: nextChain, isMainnet });
        if (!isMainnet) {
          const msg = `UniSat switched to ${nextChain?.enum || nextChain?.network || 'non-mainnet'} — disconnected for safety.`;
          disconnectFamilyWallet('btc');
          opts.onAccountChanged?.(null, { reason: 'testnet_rejected', message: msg, walletName: chosen.name });
        }
      };
      prov.on('accountsChanged', onAccountsChanged);
      prov.on('networkChanged', onNetworkChanged);
      prov.on('chainChanged', onChainChanged);
      listenerState.cleanup = () => {
        removeProviderEventListener(prov, 'accountsChanged', onAccountsChanged);
        removeProviderEventListener(prov, 'networkChanged', onNetworkChanged);
        removeProviderEventListener(prov, 'chainChanged', onChainChanged);
      };
    }
  }

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

/**
 * Executes a prepared direct non-EVM conversion batch (`PreparedNonEvmBatch`) using each
 * ecosystem's real native wallet signing & broadcast standard — mirroring EVM/Rabby's
 * direct 1-click / sequential execution flow without arbitrary off-chain text signing.
 */
export async function executeNonEvmDirectBatch(family, batch, opts = {}) {
  const session = familyWalletSessions[family];
  if (!session) {
    throw new Error(`Connect your ${family.toUpperCase()} wallet first to execute conversion.`);
  }
  if (!batch || !Array.isArray(batch.calls) || !batch.calls.length) {
    throw new Error(`No executable conversion steps prepared for ${family.toUpperCase()}.`);
  }
  if (
    opts?.expectedSolanaDestination &&
    batch.solanaDestination &&
    String(batch.solanaDestination).trim() !== String(opts.expectedSolanaDestination).trim()
  ) {
    throw new Error('Pre-sign check failed: batch Solana destination does not match your UI destination.');
  }

  const txHashes = [];
  const onStep = typeof opts?.onStep === 'function' ? opts.onStep : () => {};

  if (family === 'btc') {
    for (let i = 0; i < batch.calls.length; i += 1) {
      const call = batch.calls[i];
      onStep(i, batch.calls.length, call);
      const psbtHex = call.nativePayload?.psbtHex;
      if (!psbtHex) {
        throw new Error(
          `Bitcoin step "${call.label}" does not include a live BIP-174 PSBT payload from Relay.`
        );
      }
      if (session.walletId === 'unisat' && typeof session.provider.signPsbt === 'function') {
        const signedPsbt = await session.provider.signPsbt(psbtHex, { autoFinalized: true });
        if (typeof session.provider.pushPsbt === 'function') {
          const txid = await session.provider.pushPsbt(signedPsbt);
          if (txid) txHashes.push(String(txid));
        } else {
          txHashes.push(String(signedPsbt).slice(0, 64));
        }
        continue;
      }
      if (session.walletId === 'xverse' && typeof session.provider.request === 'function') {
        const psbtBytes = new Uint8Array(psbtHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
        const psbtBase64 = btoa(String.fromCharCode(...psbtBytes));
        const res = await session.provider.request('signPsbt', {
          psbt: psbtBase64,
          broadcast: true,
        });
        const txid = res?.result?.txid || res?.txid;
        if (txid) txHashes.push(String(txid));
        continue;
      }
      if (session.walletId === 'phantom-btc' && typeof session.provider.signPSBT === 'function') {
        const psbtBytes = new Uint8Array(psbtHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
        const signed = await session.provider.signPSBT(psbtBytes, { inputsToSign: [] });
        if (signed) txHashes.push(String(signed).slice(0, 64));
        continue;
      }
      throw new Error(`Connected Bitcoin wallet (${session.walletName}) does not expose BIP-174 signPsbt.`);
    }
    return { txHashes, mode: 'btc_psbt' };
  }

  if (family === 'ton') {
    const allMessages = batch.calls.flatMap((c) =>
      Array.isArray(c.nativePayload?.messages) ? c.nativePayload.messages : []
    );
    if (!allMessages.length) {
      throw new Error('No structured TonConnect 2 transfer messages available in this TON batch.');
    }
    onStep(0, 1, batch.calls[0]);
    const txPayload = {
      validUntil: Math.floor(Date.now() / 1000) + 600,
      messages: allMessages.map((m) => ({
        address: m.address,
        amount: String(m.amount),
        ...(m.payload ? { payload: m.payload } : {}),
      })),
    };
    if (typeof session.provider.sendTransaction === 'function') {
      const res = await session.provider.sendTransaction(txPayload);
      const hash = res?.boc || res?.hash || res?.txHash || 'ton_boc_submitted';
      txHashes.push(String(hash));
      return { txHashes, mode: 'ton_tonconnect_batch' };
    }
    if (
      (session.kind === 'tonconnect2' || isTonConnect2Bridge(session.provider)) &&
      typeof session.provider.send === 'function'
    ) {
      const res = await session.provider.send({
        method: 'sendTransaction',
        params: [JSON.stringify(txPayload)],
        id: String(Date.now()),
      });
      if (res?.error) {
        throw new Error(res.error.message || `TonConnect sendTransaction failed (code ${res.error.code || 'unknown'}).`);
      }
      const hash = res?.result || res?.boc || res?.hash || 'ton_boc_submitted';
      txHashes.push(String(hash));
      return { txHashes, mode: 'ton_tonconnect_batch' };
    }
    if (typeof session.provider.send === 'function') {
      const res = await session.provider.send('ton_sendTransaction', [txPayload]);
      if (res) txHashes.push(String(res?.boc || res?.hash || res));
      return { txHashes, mode: 'ton_tonconnect_batch' };
    }
    throw new Error(
      'Connected TON wallet does not expose structured TonConnect 2 sendTransaction. Update Tonkeeper to approve exact messages safely.'
    );
  }

  if (family === 'tron') {
    const tw = window.tronWeb || window.tronLink?.tronWeb;
    if (!tw?.trx?.sign || !tw?.trx?.sendRawTransaction) {
      throw new Error('TronLink tronWeb signer is unavailable. Unlock TronLink and reconnect.');
    }
    for (let i = 0; i < batch.calls.length; i += 1) {
      const call = batch.calls[i];
      onStep(i, batch.calls.length, call);
      const tvmStep = call.nativePayload?.tvmStep;
      let unsignedTx = null;
      if (tvmStep?.parameter?.contract_address && tvmStep?.parameter?.data) {
        const res = await fetch('https://api.trongrid.io/wallet/triggersmartcontract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner_address: tvmStep.parameter.owner_address,
            contract_address: tvmStep.parameter.contract_address,
            data: tvmStep.parameter.data,
            call_value: Number(tvmStep.parameter.call_value || 0),
            fee_limit: Number(tvmStep.fee_limit || 150_000_000),
          }),
        });
        const built = await res.json();
        unsignedTx = built?.transaction || null;
      } else if (call.nativePayload?.transactionRequest) {
        unsignedTx = call.nativePayload.transactionRequest;
      }
      if (!unsignedTx) {
        throw new Error(`Could not construct Tron TVM transaction for step "${call.label}".`);
      }
      const signed = await tw.trx.sign(unsignedTx);
      const receipt = await tw.trx.sendRawTransaction(signed);
      const txid = receipt?.txid || receipt?.transaction?.txID || signed?.txID;
      if (!txid || receipt?.result === false) {
        throw new Error(receipt?.message || `Tron broadcast failed for "${call.label}".`);
      }
      txHashes.push(String(txid));
    }
    return { txHashes, mode: 'tron_tvm_tx' };
  }

  if (family === 'aptos') {
    if (typeof session.provider.signAndSubmitTransaction !== 'function') {
      throw new Error(`${session.walletName} does not expose signAndSubmitTransaction.`);
    }
    for (let i = 0; i < batch.calls.length; i += 1) {
      const call = batch.calls[i];
      onStep(i, batch.calls.length, call);
      const payload = call.nativePayload;
      if (!payload?.function) {
        throw new Error(`Aptos step "${call.label}" is missing Move entry function payload.`);
      }
      const res = await session.provider.signAndSubmitTransaction(payload);
      const hash = res?.hash || res?.txHash || (typeof res === 'string' ? res : null);
      if (hash) txHashes.push(String(hash));
    }
    return { txHashes, mode: 'aptos_entry_fn' };
  }

  if (family === 'sui') {
    for (let i = 0; i < batch.calls.length; i += 1) {
      const call = batch.calls[i];
      onStep(i, batch.calls.length, call);
      const txReq = call.nativePayload?.transactionRequest;
      const txData = txReq?.data || txReq?.transactionBlock;
      if (!txData) {
        throw new Error(
          `Sui step "${call.label}" requires live PTB bytes from a funded Sui wallet balance.`
        );
      }
      if (session.kind === 'standard' && session.provider.features?.['sui:signAndExecuteTransaction']) {
        const account =
          session.provider.accounts?.find((a) => a.address === session.address) ||
          session.provider.accounts?.[0];
        const res = await session.provider.features['sui:signAndExecuteTransaction'].signAndExecuteTransaction({
          transaction: txData,
          account,
          chain: 'sui:mainnet',
        });
        const digest = res?.digest;
        if (digest) txHashes.push(String(digest));
        continue;
      }
      if (typeof session.provider.signAndExecuteTransactionBlock === 'function') {
        const res = await session.provider.signAndExecuteTransactionBlock({ transactionBlock: txData });
        if (res?.digest) txHashes.push(String(res.digest));
        continue;
      }
      throw new Error(`${session.walletName} does not expose sui:signAndExecuteTransaction.`);
    }
    return { txHashes, mode: 'sui_ptb' };
  }

  if (family === 'cosmos') {
    const prov = session.provider;
    const chainId = String(batch.chainId || 'cosmoshub-4');
    if (typeof prov.enable === 'function') {
      await prov.enable(chainId);
    }
    for (let i = 0; i < batch.calls.length; i += 1) {
      const call = batch.calls[i];
      onStep(i, batch.calls.length, call);
      const cosmosTx = call.nativePayload?.cosmosTx;
      const msgs = cosmosTx?.msgs || call.nativePayload?.msgs;
      if (!Array.isArray(msgs) || !msgs.length) {
        throw new Error(`Cosmos step "${call.label}" did not receive executable Skip Go messages.`);
      }
      const signerAddr =
        call.nativePayload?.signerAddress ||
        session.addressesByChain?.[batch.chain] ||
        session.address;
      if (typeof prov.signAmino === 'function') {
        const aminoMsgs = msgs.map((m) => ({
          type: m.msg_type_url,
          value: typeof m.msg === 'string' ? JSON.parse(m.msg) : m.msg,
        }));
        const feeDenom = call.nativePayload?.feeDenom || 'uatom';
        const signDoc = {
          chain_id: chainId,
          account_number: '0',
          sequence: '0',
          fee: { amount: [{ denom: feeDenom, amount: '5000' }], gas: String(250_000 + aminoMsgs.length * 80_000) },
          msgs: aminoMsgs,
          memo: `Siphon Skip Go → Solana`,
        };
        const signed = await prov.signAmino(chainId, signerAddr, signDoc);
        if (signed?.signature?.signature) {
          txHashes.push(`cosmos_signed_${signed.signature.signature.slice(0, 24)}`);
        }
        continue;
      }
      throw new Error(`${session.walletName} does not expose Cosmos transaction signing (signAmino).`);
    }
    return { txHashes, mode: 'cosmos_skip_tx' };
  }

  throw new Error(`Unsupported direct execution family: ${family}`);
}
