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
let activeEvmProvider = null;
let connectedEvmAddress = null;
let connectedWalletName = null;
let connectedSolanaAddress = null;
let cachedBatchCapabilities = {
  probed: false,
  anySupported: false,
  anyPaymaster: false,
  supportedChains: [],
  details: {},
  modeLabel: 'EIP-5792 Ready (connect MetaMask, Rabby, Coinbase, or Phantom)',
};

if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (event) => {
    const detail = event.detail;
    if (detail?.provider && !discoveredEvmProviders.some((p) => p.info?.uuid === detail.info?.uuid)) {
      discoveredEvmProviders.push(detail);
    }
  });
  try {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
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

export function listAvailableEvmWallets() {
  const list = discoveredEvmProviders.map((d) => ({
    name: d.info?.name || 'EVM Wallet',
    provider: d.provider,
  }));
  if (!list.length && typeof window !== 'undefined' && window.ethereum) {
    const name = window.ethereum.isRabby
      ? 'Rabby'
      : window.ethereum.isPhantom
      ? 'Phantom EVM'
      : window.ethereum.isCoinbaseWallet
      ? 'Coinbase Wallet'
      : window.ethereum.isMetaMask
      ? 'MetaMask'
      : 'Injected EVM Wallet';
    list.push({ name, provider: window.ethereum });
  }
  return list;
}

export async function connectEvmWallet(onAccountsChanged) {
  const wallets = listAvailableEvmWallets();
  if (!wallets.length) {
    throw new Error(
      'No EVM browser wallet detected. Install MetaMask, Rabby, or Phantom (EVM) to sign live transactions.'
    );
  }
  const chosen = wallets[0];
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
    onAccountsChanged?.(connectedEvmAddress);
  });

  return { address: connectedEvmAddress, walletName: chosen.name, capabilities };
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

export async function connectSolanaWallet() {
  if (typeof window === 'undefined') {
    throw new Error('Solana browser wallet is unavailable in this environment.');
  }
  const provider =
    window.phantom?.solana ||
    window.backpack?.solana ||
    window.solflare ||
    (window.solana?.isPhantom || window.solana?.connect ? window.solana : null);

  if (!provider) {
    throw new Error(
      'No Solana wallet extension found (Phantom, Backpack, or Solflare). You can still paste any Solana address manually.'
    );
  }

  const res = await provider.connect();
  const pubkey = res?.publicKey?.toString?.() || provider.publicKey?.toString?.();
  if (!pubkey) throw new Error('Solana wallet connection cancelled.');
  connectedSolanaAddress = pubkey;
  const walletName = window.phantom?.solana
    ? 'Phantom'
    : window.backpack
    ? 'Backpack'
    : window.solflare
    ? 'Solflare'
    : 'Solana Wallet';
  return { address: pubkey, walletName };
}
