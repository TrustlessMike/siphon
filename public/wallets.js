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

const discoveredEvmProviders = [];
let activeEvmProvider = null;
let connectedEvmAddress = null;
let connectedSolanaAddress = null;

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

export function getConnectedSolanaAddress() {
  return connectedSolanaAddress;
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

  activeEvmProvider.on?.('accountsChanged', (nextAccounts) => {
    connectedEvmAddress = nextAccounts?.[0] ?? null;
    onAccountsChanged?.(connectedEvmAddress);
  });

  return { address: connectedEvmAddress, walletName: chosen.name };
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
