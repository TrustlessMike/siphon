/**
 * Real Browser Wallet Connectors for Turgalium:
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
  999: {
    chainId: '0x3e7',
    chainName: 'HyperEVM',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: ['https://rpc.hyperliquid.xyz/evm'],
    blockExplorerUrls: ['https://hyperevmscan.io'],
  },
  80094: {
    chainId: '0x138de',
    chainName: 'Berachain',
    nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    rpcUrls: ['https://rpc.berachain.com'],
    blockExplorerUrls: ['https://berascan.com'],
  },
  324: {
    chainId: '0x144',
    chainName: 'zkSync Era',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://mainnet.era.zksync.io'],
    blockExplorerUrls: ['https://explorer.zksync.io'],
  },
  57073: {
    chainId: '0xdef1',
    chainName: 'Ink',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: ['https://rpc-gel.inkonchain.com'],
    blockExplorerUrls: ['https://explorer.inkonchain.com'],
  },
  100: {
    chainId: '0x64',
    chainName: 'Gnosis',
    nativeCurrency: { name: 'xDAI', symbol: 'xDAI', decimals: 18 },
    rpcUrls: ['https://gnosis-rpc.publicnode.com'],
    blockExplorerUrls: ['https://gnosisscan.io'],
  },
};

const SUPPORTED_CHAIN_IDS = [
  1, 8453, 42161, 10, 137, 43114, 56, 146, 130, 59144, 534352, 5000, 81457, 480, 999, 80094, 324, 57073, 100,
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
  const msg = String(err?.message ?? (typeof err === 'string' ? err : '')).toLowerCase();
  return (
    msg.includes('user rejected') ||
    msg.includes('user denied') ||
    msg.includes('rejected the request') ||
    msg.includes('action_rejected') ||
    /user cancel|transaction cancel|rejected by user/i.test(msg)
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
const SOLANA_USDC_MINT_STR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_TOKEN_PROGRAM_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOLANA_TOKEN_2022_PROGRAM_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const SOLANA_ATA_PROGRAM_STR = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SOLANA_COMPUTE_BUDGET_PROGRAM_STR = 'ComputeBudget111111111111111111111111111111';
const SOLANA_SYSTEM_PROGRAM_STR = '11111111111111111111111111111111';

const RENT_RECLAIM_ALLOWED_PROGRAMS = new Set([
  SOLANA_COMPUTE_BUDGET_PROGRAM_STR,
  SOLANA_TOKEN_PROGRAM_STR,
  SOLANA_TOKEN_2022_PROGRAM_STR,
]);

const CCTP_MESSAGE_TRANSMITTER_PROGRAMS = new Set([
  'CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd', // Circle CCTP V1 MessageTransmitter
  'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC', // Circle CCTP V2 MessageTransmitter
]);

const CCTP_CLAIM_ALLOWED_PROGRAMS = new Set([
  SOLANA_COMPUTE_BUDGET_PROGRAM_STR,
  SOLANA_ATA_PROGRAM_STR,
  SOLANA_TOKEN_PROGRAM_STR,
  SOLANA_TOKEN_2022_PROGRAM_STR,
  'CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd',
  'CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3',
  'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC',
  'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe',
]);

const SOLANA_MEMO_V1_PROGRAM_STR = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
const SOLANA_MEMO_V2_PROGRAM_STR = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const JUPITER_KNOWN_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter Aggregator v6
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB', // Jupiter Aggregator v4
  'JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph', // Jupiter Aggregator v3
  'jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu', // Jupiter Limit Order v2
  'DCA265Vj8a9CEuX1eb1LWRnDT7uK6q1xMipnNyatn23M', // Jupiter DCA
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu', // Jupiter Perpetuals
  'jup3YeL8QhtSx1e253b2FDvsMNC87fDrgQZivbrndc9', // Jupiter Lend / Earn
  'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', // Kamino Lending
  '5ocnV1qiCgaQR8Jb8xWnVbApfaygJ8tNoZfgPwsgx9kx', // Sanctum S Controller (JupSOL)
  'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhZ', // Sanctum Stake Pool
]);

const JUPITER_FLOW_ALLOWED_PROGRAMS = new Set([
  ...JUPITER_KNOWN_PROGRAMS,
  SOLANA_COMPUTE_BUDGET_PROGRAM_STR,
  SOLANA_SYSTEM_PROGRAM_STR,
  SOLANA_TOKEN_PROGRAM_STR,
  SOLANA_TOKEN_2022_PROGRAM_STR,
  SOLANA_ATA_PROGRAM_STR,
  SOLANA_MEMO_V1_PROGRAM_STR,
  SOLANA_MEMO_V2_PROGRAM_STR,
]);

let cachedNodeSolanaWeb3 = null;

async function loadSolanaWeb3Primitives() {
  try {
    const mod = await loadSolanaWeb3Sdk();
    if (mod?.VersionedTransaction?.deserialize) {
      return {
        VersionedTransaction: mod.VersionedTransaction,
        Transaction: mod.Transaction || null,
        PublicKey: mod.PublicKey || null,
        deriveSolanaUsdcAtaBytes32Hex: mod.deriveSolanaUsdcAtaBytes32Hex || null,
      };
    }
  } catch {
    // Fallback below when running in Node.js test harness where /vendor/solana-web3.js is an HTTP route
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    if (!cachedNodeSolanaWeb3) {
      cachedNodeSolanaWeb3 = await import('@solana/web3.js');
    }
    if (cachedNodeSolanaWeb3?.VersionedTransaction?.deserialize) {
      return {
        VersionedTransaction: cachedNodeSolanaWeb3.VersionedTransaction,
        Transaction: cachedNodeSolanaWeb3.Transaction || null,
        PublicKey: cachedNodeSolanaWeb3.PublicKey || null,
        deriveSolanaUsdcAtaBytes32Hex: null,
      };
    }
  }
  return null;
}

function bytes32HexToBase58(hex) {
  const clean = String(hex || '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytesToBase58(bytes);
}

async function resolveExpectedSolanaUsdcAtaBytes32Hex(ownerBase58) {
  const trimmed = String(ownerBase58 || '').trim();
  if (!trimmed) return null;
  if (solanaAtaBytes32Cache.has(trimmed)) return solanaAtaBytes32Cache.get(trimmed);
  try {
    const prims = await loadSolanaWeb3Primitives();
    if (typeof prims?.deriveSolanaUsdcAtaBytes32Hex === 'function') {
      const ataHex = prims.deriveSolanaUsdcAtaBytes32Hex(trimmed).toLowerCase();
      solanaAtaBytes32Cache.set(trimmed, ataHex);
      return ataHex;
    }
    if (prims?.PublicKey?.findProgramAddressSync) {
      const ownerPk = new prims.PublicKey(trimmed);
      const tokenProg = new prims.PublicKey(SOLANA_TOKEN_PROGRAM_STR);
      const usdcMint = new prims.PublicKey(SOLANA_USDC_MINT_STR);
      const ataProg = new prims.PublicKey(SOLANA_ATA_PROGRAM_STR);
      const [ata] = prims.PublicKey.findProgramAddressSync(
        [ownerPk.toBytes(), tokenProg.toBytes(), usdcMint.toBytes()],
        ataProg
      );
      const ataHex =
        '0x' +
        Array.from(ata.toBytes())
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      solanaAtaBytes32Cache.set(trimmed, ataHex);
      return ataHex;
    }
  } catch {
    // Fallback to null if SDK bundle is unavailable
  }
  return null;
}

async function resolveExpectedSolanaUsdcAtaBase58(ownerBase58) {
  const hex = await resolveExpectedSolanaUsdcAtaBytes32Hex(ownerBase58);
  return hex ? bytes32HexToBase58(hex) : null;
}

function dispatchWalletChangedEvent(detail) {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
  try {
    const ev =
      typeof CustomEvent === 'function'
        ? new CustomEvent('turgalium:wallet-changed', { detail })
        : Object.assign(new Event('turgalium:wallet-changed'), { detail });
    window.dispatchEvent(ev);
  } catch {
    // ignore non-browser dispatch errors
  }
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
  // keccak256("depositForBurnWithHook(uint256,uint32,bytes32,address,bytes32,uint256,uint32,bytes)")[0..4] = 0x779b432d
  const isCctpV2Hook = dataLower.startsWith('0x779b432d');
  if (expectedSolanaDestination && (isCctpV1 || isCctpV2 || isCctpV2Hook)) {
    const minCalldataLen = isCctpV2Hook ? 10 + 576 : isCctpV2 ? 10 + 448 : 10 + 256;
    if (dataLower.length < minCalldataLen) {
      throw new Error(
        'Pre-sign check failed: truncated CCTP depositForBurn calldata.'
      );
    }
    // Fail closed if canonical Solana USDC ATA derivation failed — never fall back to raw owner pubkey bytes32.
    if (!expectedSolanaAtaBytes32 || !/^0x[0-9a-f]{64}$/i.test(String(expectedSolanaAtaBytes32))) {
      throw new Error(
        'Pre-sign check failed: unable to derive canonical Solana USDC ATA for CCTP depositForBurn verification.'
      );
    }
    const encodedRecipient = '0x' + dataLower.slice(10 + 128, 10 + 192);
    const expectedTarget = String(expectedSolanaAtaBytes32).toLowerCase();
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
  paymasterUrl: null,
  paymasterUrls: null,
  protocolFee: {
    feeBps: 0,
    feePercent: 0,
    minFeeBps: 0,
    maxFeeBps: 1000,
    feeRecipientEvm: null,
    feeDestinationType: 'contract',
    treasuryConfigured: false,
  },
};
let cachedSolanaSdkModule = null;
let solanaSdkPromise = null;
let cachedCoinbaseSdkModule = null;
let coinbaseSdkPromise = null;
let cachedWalletConnectSdkModule = null;
let walletConnectSdkPromise = null;
let cachedCoinbaseProvider = null;
let activeEvmListeners = null;
let activeSolanaSession = null;
let solanaSessionSeq = 0;
const familyWalletCleanups = {};

const WC_STORAGE_KEY = 'turgalium_wc_project_id';

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

async function loadSolanaWeb3Sdk() {
  if (cachedSolanaSdkModule) return cachedSolanaSdkModule;
  if (!solanaSdkPromise) {
    solanaSdkPromise = import('/vendor/solana-web3.js')
      .then((mod) => {
        cachedSolanaSdkModule = mod;
        return mod;
      })
      .catch((err) => {
        solanaSdkPromise = null;
        throw err;
      });
  }
  return solanaSdkPromise;
}

async function loadCoinbaseSdk({ initCoinbase = false } = {}) {
  if (!cachedCoinbaseSdkModule) {
    if (!coinbaseSdkPromise) {
      coinbaseSdkPromise = import('/vendor/coinbase-sdk.js')
        .then((mod) => {
          cachedCoinbaseSdkModule = mod;
          return mod;
        })
        .catch((err) => {
          coinbaseSdkPromise = null;
          throw err;
        });
    }
    await coinbaseSdkPromise;
  }
  const mod = cachedCoinbaseSdkModule;
  if (initCoinbase && !cachedCoinbaseProvider && typeof mod?.createCoinbaseWalletSDK === 'function') {
    try {
      const sdk = mod.createCoinbaseWalletSDK({
        appName: 'Turgalium',
        appLogoUrl: `${window.location.origin}/logos/turgalium.svg`,
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

async function loadWalletConnectSdk() {
  if (cachedWalletConnectSdkModule) return cachedWalletConnectSdkModule;
  if (!walletConnectSdkPromise) {
    walletConnectSdkPromise = import('/vendor/walletconnect-sdk.js')
      .then((mod) => {
        cachedWalletConnectSdkModule = mod;
        return mod;
      })
      .catch((err) => {
        walletConnectSdkPromise = null;
        throw err;
      });
  }
  return walletConnectSdkPromise;
}

export function preloadWalletSdks() {
  if (typeof window === 'undefined') return;
  if (walletSdkConfig.coinbaseSmartWalletEnabled) {
    loadCoinbaseSdk({ initCoinbase: false }).catch(() => {});
  }
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
  if (!walletSdkConfig.paymasterUrl && !walletSdkConfig.paymasterUrls) {
    try {
      const healthRes = await fetch('/api/health');
      if (healthRes.ok) {
        const healthData = await healthRes.json();
        if (healthData && typeof healthData === 'object') {
          if (typeof healthData.paymasterUrl === 'string' && healthData.paymasterUrl.trim()) {
            walletSdkConfig = { ...walletSdkConfig, paymasterUrl: healthData.paymasterUrl.trim() };
          }
          if (healthData.paymasterUrls && typeof healthData.paymasterUrls === 'object') {
            walletSdkConfig = { ...walletSdkConfig, paymasterUrls: healthData.paymasterUrls };
          }
        }
      }
    } catch {
      // optional paymaster metadata on /api/health
    }
  }
  return walletSdkConfig;
}

export function getWalletConnectorConfig() {
  return walletSdkConfig;
}

export function setWalletPaymasterConfig({ paymasterUrl = null, paymasterUrls = null } = {}) {
  walletSdkConfig = {
    ...walletSdkConfig,
    paymasterUrl: normalizePaymasterUrl(paymasterUrl),
    paymasterUrls: paymasterUrls && typeof paymasterUrls === 'object' ? { ...paymasterUrls } : null,
  };
  return walletSdkConfig;
}

export function normalizePaymasterUrl(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) return null;
    if (parsed.protocol === 'https:') {
      return parsed.toString();
    }
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
    if (parsed.protocol === 'http:' && isLoopback) {
      const winHost =
        typeof window !== 'undefined' && typeof window.location?.hostname === 'string'
          ? window.location.hostname.toLowerCase()
          : null;
      const isLocalOrigin =
        winHost === null ||
        winHost === '127.0.0.1' ||
        winHost === 'localhost' ||
        winHost === '[::1]' ||
        winHost === '::1';
      if (isLocalOrigin) {
        return parsed.toString();
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function resolvePaymasterUrl(chainId, explicitUrl = null) {
  const explicit = normalizePaymasterUrl(explicitUrl);
  if (explicit) return explicit;

  const numId = Number(chainId);
  const decKey = Number.isInteger(numId) && numId > 0 ? String(numId) : null;
  const hexKey = Number.isInteger(numId) && numId > 0 ? '0x' + numId.toString(16) : null;

  const lookupMap = (mapObj) => {
    if (!mapObj || typeof mapObj !== 'object') return null;
    const raw =
      (decKey && mapObj[decKey]) ||
      (hexKey && (mapObj[hexKey] || mapObj[hexKey.toLowerCase()])) ||
      mapObj['*'] ||
      mapObj.default ||
      null;
    return normalizePaymasterUrl(raw);
  };

  if (typeof window !== 'undefined') {
    const winPerChain = lookupMap(window.__TURGALIUM_PAYMASTER_URLS);
    if (winPerChain) return winPerChain;
    const winGlobal = normalizePaymasterUrl(window.__TURGALIUM_PAYMASTER_URL);
    if (winGlobal) return winGlobal;
  }

  const cfgPerChain = lookupMap(walletSdkConfig.paymasterUrls);
  if (cfgPerChain) return cfgPerChain;
  return normalizePaymasterUrl(walletSdkConfig.paymasterUrl);
}

/**
 * Builds ERC-7677 `capabilities` object for EIP-5792 `wallet_sendCalls` ONLY when:
 *   1. The connected wallet advertises `paymasterService.supported === true` on `chainId`, AND
 *   2. A valid paymaster URL is configured (explicitly, via `window.__TURGALIUM_PAYMASTER_URL`, or server config).
 * Returns `undefined` when unavailable so callers cleanly fall back to self-funded batches.
 */
export function buildEip5792Capabilities({
  chainId,
  paymasterUrl = null,
  paymasterContext = null,
  batchCapabilities = cachedBatchCapabilities,
} = {}) {
  const numId = Number(chainId);
  const chainCap = batchCapabilities?.details?.[numId];
  if (!chainCap?.paymaster) return undefined;

  const resolvedUrl = resolvePaymasterUrl(numId, paymasterUrl);
  if (!resolvedUrl) return undefined;

  const paymasterService = { url: resolvedUrl };
  if (paymasterContext && typeof paymasterContext === 'object' && !Array.isArray(paymasterContext)) {
    paymasterService.context = paymasterContext;
  }
  return { paymasterService };
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
    const previousAddress = connectedEvmAddress;
    connectedEvmAddress = next;
    await detectWalletBatchCapabilities(connectedEvmAddress);
    if (String(previousAddress || '').toLowerCase() !== String(connectedEvmAddress).toLowerCase()) {
      dispatchWalletChangedEvent({
        family: 'evm',
        action: 'accountChanged',
        address: connectedEvmAddress,
        previousAddress,
        walletName: connectedWalletName,
      });
    }
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
  const prevAddress = connectedEvmAddress;
  const prevWalletName = connectedWalletName;
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
  if (prevAddress || prevProvider) {
    dispatchWalletChangedEvent({
      family: 'evm',
      action: 'disconnect',
      address: null,
      previousAddress: prevAddress,
      walletName: prevWalletName,
    });
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
  const prevAddress = connectedSolanaAddress;
  const prevWalletName = connectedSolanaWalletName;
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
  if (prevAddress || prev) {
    dispatchWalletChangedEvent({
      family: 'solana',
      action: 'disconnect',
      address: null,
      previousAddress: prevAddress,
      walletName: prevWalletName,
    });
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
  if (prov?.isBackpack) return 'Backpack EVM';
  if (prov?.isCoinbaseWallet) return 'Coinbase Wallet';
  if (prov?.isBraveWallet) return 'Brave Wallet';
  if (prov?.isOkxWallet || prov?.isOKExWallet) return 'OKX Wallet';
  if (prov?.isTrust || prov?.isTrustWallet) return 'Trust Wallet';
  if (prov?.isMetaMask) return 'MetaMask';
  return 'Browser EVM Wallet';
}

export const DUAL_VM_WALLET_FAMILIES = new Set(['phantom', 'okx', 'coinbase', 'backpack']);

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
    if (window.backpack?.ethereum) injectedCandidates.push({ prov: window.backpack.ethereum, fallbackName: 'Backpack EVM' });
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
  const previousAddress = connectedEvmAddress;
  activeEvmProvider = provider;
  connectedEvmAddress = accounts[0];
  connectedWalletName = chosen.name;

  const capabilities = await detectWalletBatchCapabilities(connectedEvmAddress);
  attachEvmListeners(provider, opts);
  dispatchWalletChangedEvent({
    family: 'evm',
    action: 'connect',
    address: connectedEvmAddress,
    previousAddress,
    walletName: chosen.name,
  });

  return { address: connectedEvmAddress, walletName: chosen.name, capabilities };
}

/**
 * Finds the matching Solana provider for a dual-VM EVM wallet (Phantom, OKX, Coinbase, Backpack).
 */
export function findMatchingSolanaWalletForEvm(evmWalletOrName) {
  if (!evmWalletOrName) return null;
  const name = typeof evmWalletOrName === 'string' ? evmWalletOrName : evmWalletOrName.name;
  const rdns = typeof evmWalletOrName === 'object' ? evmWalletOrName.rdns || '' : '';
  const family = canonicalWalletFamily(name, rdns);
  if (!DUAL_VM_WALLET_FAMILIES.has(family)) return null;
  const solWallets = listAvailableSolanaWallets();
  return solWallets.find((sw) => canonicalWalletFamily(sw.name) === family) || null;
}

/**
 * Lists all detected dual-VM wallets exposing both EVM and Solana providers in this browser.
 */
export function listDualVmWallets() {
  const evmWallets = listAvailableEvmWallets();
  const pairs = [];
  for (const evmWallet of evmWallets) {
    const solanaWallet = findMatchingSolanaWalletForEvm(evmWallet);
    if (!solanaWallet) continue;
    pairs.push({
      family: canonicalWalletFamily(evmWallet.name, evmWallet.rdns),
      name: evmWallet.name,
      evmWallet,
      solanaWallet,
      dualVm: true,
    });
  }
  return pairs;
}

/**
 * 1-Click Unified Dual-VM Connect: connects the selected EVM wallet and, when a matching
 * dual-VM Solana provider (Phantom, OKX, Coinbase, Backpack) is available, automatically
 * connects the Solana destination in the same flow without requiring a second modal pass.
 * Never breaks the EVM connection if the secondary Solana prompt is cancelled or fails.
 */
export async function connectDualVmWallet(options = {}) {
  const evmWallets = listAvailableEvmWallets();
  const preChosenEvm = options.walletId
    ? evmWallets.find((w) => w.id === options.walletId) || null
    : evmWallets[0] || null;

  const evmRes = await connectEvmWallet({
    walletId: options.walletId,
    onAccountsChanged: options.onAccountsChanged,
    onChainChanged: options.onChainChanged,
    onDisconnect: options.onDisconnect,
  });

  const matchedSolana =
    (options.solanaWalletId
      ? listAvailableSolanaWallets().find((w) => w.id === options.solanaWalletId) || null
      : null) ||
    findMatchingSolanaWalletForEvm(preChosenEvm || { name: evmRes.walletName });

  const shouldConnectSolana =
    options.autoConnectSolana !== false &&
    Boolean(matchedSolana) &&
    !(options.skipSolanaIfConnected && getConnectedSolanaAddress());

  if (!shouldConnectSolana) {
    return {
      ...evmRes,
      dualVm: Boolean(matchedSolana),
      solana: null,
      solanaError: null,
    };
  }

  try {
    const solRes = await connectSolanaWallet({
      walletId: matchedSolana.id,
      onAccountChanged: options.onSolanaAccountChanged,
    });
    return {
      ...evmRes,
      dualVm: true,
      solana: solRes,
      solanaError: null,
    };
  } catch (err) {
    return {
      ...evmRes,
      dualVm: true,
      solana: null,
      solanaError: err?.message || 'Solana wallet connection skipped.',
    };
  }
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
    const { createCoinbaseWalletSDK } = await loadCoinbaseSdk({ initCoinbase: true });
    if (cachedCoinbaseProvider) {
      provider = cachedCoinbaseProvider;
    } else {
      const sdk = createCoinbaseWalletSDK({
        appName: 'Turgalium',
        appLogoUrl: `${window.location.origin}/logos/turgalium.svg`,
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
  const previousAddress = connectedEvmAddress;
  activeEvmProvider = provider;
  connectedEvmAddress = accounts[0];
  connectedWalletName = 'Coinbase Wallet';
  const capabilities = await detectWalletBatchCapabilities(connectedEvmAddress);
  attachEvmListeners(provider, callbacks);
  dispatchWalletChangedEvent({
    family: 'evm',
    action: 'connect',
    address: connectedEvmAddress,
    previousAddress,
    walletName: 'Coinbase Wallet',
  });

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
  const { EthereumProvider } = await loadWalletConnectSdk();
  const provider = await EthereumProvider.init({
    projectId,
    optionalChains: SUPPORTED_CHAIN_IDS,
    showQrModal: true,
    metadata: {
      name: 'Turgalium',
      description: 'Move fragmented EVM positions and tokens to Solana.',
      url: window.location.origin,
      icons: [`${window.location.origin}/logos/turgalium.svg`],
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
  const previousAddress = connectedEvmAddress;
  activeEvmProvider = provider;
  connectedEvmAddress = accounts[0];
  connectedWalletName = 'WalletConnect';
  const capabilities = await detectWalletBatchCapabilities(connectedEvmAddress);
  attachEvmListeners(provider, {
    ...callbacks,
    onDisconnect: () => callbacks.onAccountsChanged?.(null),
  });
  dispatchWalletChangedEvent({
    family: 'evm',
    action: 'connect',
    address: connectedEvmAddress,
    previousAddress,
    walletName: 'WalletConnect',
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
  paymasterUrl,
  paymasterContext,
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

  const capabilities = buildEip5792Capabilities({
    chainId,
    paymasterUrl,
    paymasterContext,
    batchCapabilities: cachedBatchCapabilities,
  });

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

  const isPaymasterCapabilityErr = (err) => {
    const code = err?.code ?? err?.cause?.code;
    const msg = String(err?.message || '').toLowerCase();
    return (
      code === 5740 ||
      code === 5750 ||
      code === 5760 ||
      msg.includes('paymaster') ||
      msg.includes('sponsor') ||
      msg.includes('capability') ||
      msg.includes('capabilities')
    );
  };

  try {
    const v2Params = {
      version: '2.0.0',
      chainId: hexChainId,
      from: connectedEvmAddress,
      atomicRequired: mustBeAtomic,
      calls: formattedCalls,
      ...(capabilities ? { capabilities } : {}),
    };
    const res = await activeEvmProvider.request({
      method: 'wallet_sendCalls',
      params: [v2Params],
    });
    const batchId = typeof res === 'string' ? res : res?.id;
    if (!batchId) throw new Error('Wallet returned empty EIP-5792 batch ID.');
    return {
      mode: 'eip5792',
      batchId,
      version: '2.0.0',
      atomicRequired: mustBeAtomic,
      paymasterSponsored: Boolean(capabilities),
      paymasterUrl: capabilities?.paymasterService?.url || null,
    };
  } catch (err) {
    if (isUserRejectedError(err)) throw err;

    // Graceful fallback when paymaster endpoint rejects/errors: retry self-funded v2 batch without capabilities
    if (capabilities && isPaymasterCapabilityErr(err)) {
      const resNoPm = await activeEvmProvider.request({
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
      const batchId = typeof resNoPm === 'string' ? resNoPm : resNoPm?.id;
      if (!batchId) throw new Error('Wallet returned empty EIP-5792 batch ID.');
      return {
        mode: 'eip5792',
        batchId,
        version: '2.0.0',
        atomicRequired: mustBeAtomic,
        paymasterSponsored: false,
        paymasterUrl: null,
        paymasterFallbackReason: err?.message || 'Paymaster unavailable',
      };
    }

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
      const v1Params = {
        version: '1.0',
        chainId: hexChainId,
        from: connectedEvmAddress,
        calls: formattedCalls,
        ...(capabilities ? { capabilities } : {}),
      };
      const resV1 = await activeEvmProvider.request({
        method: 'wallet_sendCalls',
        params: [v1Params],
      });
      const batchId = typeof resV1 === 'string' ? resV1 : resV1?.id;
      if (!batchId) throw new Error('Wallet returned empty EIP-5792 batch ID.');
      return {
        mode: 'eip5792',
        batchId,
        version: '1.0',
        atomicRequired: false,
        paymasterSponsored: Boolean(capabilities),
        paymasterUrl: capabilities?.paymasterService?.url || null,
      };
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

export function isMobileBrowser(userAgent) {
  const ua =
    typeof userAgent === 'string'
      ? userAgent
      : typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
      ? navigator.userAgent
      : '';
  return /android|iphone|ipad|ipod|mobile|iemobile|opera mini|blackberry|webos/i.test(ua);
}

function resolveDeepLinkTarget(targetUrl, refUrl) {
  const fallbackHref =
    typeof window !== 'undefined' && window.location?.href ? window.location.href : 'https://turgalium.app/';
  const candidate = typeof targetUrl === 'string' && targetUrl.trim() ? targetUrl.trim() : fallbackHref;
  let parsedTarget;
  try {
    parsedTarget = new URL(candidate);
    if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
      parsedTarget = new URL('https://turgalium.app/');
    }
  } catch {
    parsedTarget = new URL('https://turgalium.app/');
  }

  let cleanRef = parsedTarget.origin;
  if (typeof refUrl === 'string' && refUrl.trim()) {
    try {
      const parsedRef = new URL(refUrl.trim());
      if (parsedRef.protocol === 'http:' || parsedRef.protocol === 'https:') {
        cleanRef = parsedRef.origin;
      }
    } catch {
      // keep target origin
    }
  }
  return { cleanTarget: parsedTarget.toString(), cleanRef };
}

/**
 * Builds official mobile universal deep-links for Phantom and Solflare in-app browsers
 * so mobile Safari/Chrome users without injected providers can connect in 1 tap.
 */
export function buildMobileWalletDeepLink(walletKey, targetUrl, refUrl) {
  const key = String(walletKey || '').trim().toLowerCase();
  const { cleanTarget, cleanRef } = resolveDeepLinkTarget(targetUrl, refUrl);
  const encodedUrl = encodeURIComponent(cleanTarget);
  const encodedRef = encodeURIComponent(cleanRef);
  if (key === 'phantom') {
    return `https://phantom.app/ul/browse/${encodedUrl}?ref=${encodedRef}`;
  }
  if (key === 'solflare') {
    return `https://solflare.com/ul/v1/browse/${encodedUrl}?ref=${encodedRef}`;
  }
  if (key === 'metamask') {
    const stripped = cleanTarget.replace(/^https?:\/\//i, '');
    return `https://metamask.app.link/dapp/${stripped}`;
  }
  if (key === 'coinbase') {
    return `https://go.cb-w.com/dapp?cb_url=${encodedUrl}`;
  }
  return null;
}

export function getMobileEvmDeepLinks(targetUrl, refUrl) {
  return [
    {
      id: 'mobile-phantom-evm',
      walletKey: 'phantom',
      name: 'Open in Phantom Mobile',
      subtitle: 'Universal Link · EVM + Solana',
      logo: '/logos/phantom.svg',
      deepLinkUrl: buildMobileWalletDeepLink('phantom', targetUrl, refUrl),
    },
    {
      id: 'mobile-metamask-evm',
      walletKey: 'metamask',
      name: 'Open in MetaMask Mobile',
      subtitle: 'Universal Link · 19 EVM Chains',
      logo: '/logos/metamask.svg',
      deepLinkUrl: buildMobileWalletDeepLink('metamask', targetUrl, refUrl),
    },
    {
      id: 'mobile-coinbase-evm',
      walletKey: 'coinbase',
      name: 'Open in Coinbase Wallet',
      subtitle: 'Universal Link · Base + EVM',
      logo: '/logos/coinbase.svg',
      deepLinkUrl: buildMobileWalletDeepLink('coinbase', targetUrl, refUrl),
    },
  ].filter((item) => Boolean(item.deepLinkUrl));
}

export function getMobileSolanaDeepLinks(targetUrl, refUrl) {
  return [
    {
      id: 'mobile-phantom',
      walletKey: 'phantom',
      name: 'Open in Phantom',
      subtitle: 'Mobile Universal Link · EVM + Solana',
      logo: '/logos/phantom.svg',
      deepLinkUrl: buildMobileWalletDeepLink('phantom', targetUrl, refUrl),
    },
    {
      id: 'mobile-solflare',
      walletKey: 'solflare',
      name: 'Open in Solflare',
      subtitle: 'Mobile Universal Link · Solana',
      logo: '/logos/solflare.svg',
      deepLinkUrl: buildMobileWalletDeepLink('solflare', targetUrl, refUrl),
    },
  ];
}

export const MAX_PARALLEL_PREQUOTE_CONCURRENCY = 3;

/**
 * Bounded-concurrency parallel chain batch pre-quoter (concurrency strictly <= 3).
 * Starts preparing remaining chains in the background immediately so multi-chain queues
 * never stall sequentially between wallet signatures, with TTL staleness protection.
 */
export function createChainBatchPrequoter(
  chains,
  prepareChainFn,
  { maxConcurrency = MAX_PARALLEL_PREQUOTE_CONCURRENCY, maxQuoteAgeMs = 45_000, nowMs = () => Date.now() } = {}
) {
  const orderedChains = Array.from(new Set(Array.isArray(chains) ? chains.filter(Boolean) : []));
  const concurrency = Math.max(
    1,
    Math.min(MAX_PARALLEL_PREQUOTE_CONCURRENCY, Math.trunc(Number(maxConcurrency) || MAX_PARALLEL_PREQUOTE_CONCURRENCY))
  );

  let nextIdx = 0;
  let active = 0;
  let peakActive = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = false;

  const entries = new Map();
  for (const chain of orderedChains) {
    let resolveFn;
    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });
    entries.set(chain, {
      promise,
      resolve: resolveFn,
      settled: false,
      result: null,
      error: null,
      quotedAtMs: 0,
    });
  }

  const pump = () => {
    while (!cancelled && active < concurrency && nextIdx < orderedChains.length) {
      const chain = orderedChains[nextIdx++];
      const entry = entries.get(chain);
      if (!entry || entry.settled) continue;
      active += 1;
      if (active > peakActive) peakActive = active;

      Promise.resolve()
        .then(() => prepareChainFn(chain))
        .then((res) => {
          entry.result = res ?? null;
          entry.quotedAtMs = nowMs();
          entry.settled = true;
          completed += 1;
          entry.resolve(entry);
        })
        .catch((err) => {
          entry.error = err;
          entry.result = null;
          entry.settled = true;
          failed += 1;
          entry.resolve(entry);
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  pump();

  return {
    async getBatch(chain) {
      const entry = entries.get(chain);
      if (!entry) return null;
      const done = await entry.promise;
      if (!done || done.error || !done.result) return null;
      if (maxQuoteAgeMs > 0 && nowMs() - done.quotedAtMs > maxQuoteAgeMs) {
        return null;
      }
      return done.result;
    },
    cancel() {
      cancelled = true;
      for (const entry of entries.values()) {
        if (!entry.settled) {
          entry.settled = true;
          entry.result = null;
          entry.resolve(entry);
        }
      }
    },
    getStats() {
      return {
        total: orderedChains.length,
        completed,
        failed,
        active,
        peakActive,
        maxConcurrency: concurrency,
        cancelled,
      };
    },
  };
}

export async function connectSolanaWallet(options = {}) {
  if (typeof window === 'undefined') {
    throw new Error('Solana browser wallet is unavailable in this environment.');
  }
  const wallets = listAvailableSolanaWallets();
  if (!wallets.length) {
    if (isMobileBrowser(options.userAgent)) {
      const deepLinks = getMobileSolanaDeepLinks(options.targetUrl, options.refUrl);
      const mobileErr = new Error(
        'Open Turgalium inside Phantom or Solflare mobile browser to connect your Solana wallet, or paste any Solana address manually.'
      );
      mobileErr.code = 'MOBILE_DEEP_LINK_REQUIRED';
      mobileErr.isMobile = true;
      mobileErr.deepLinks = deepLinks;
      throw mobileErr;
    }
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

  const previousConnectedAddress = connectedSolanaAddress;
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
      dispatchWalletChangedEvent({
        family: 'solana',
        action: 'disconnect',
        address: null,
        previousAddress,
        walletName: chosen.name,
      });
      options.onAccountChanged?.(null, {
        previousAddress,
        reason: reason || 'disconnect',
        walletName: chosen.name,
      });
      return;
    }
    if (nextStr === previousAddress) return;
    connectedSolanaAddress = nextStr;
    dispatchWalletChangedEvent({
      family: 'solana',
      action: 'accountChanged',
      address: nextStr,
      previousAddress,
      walletName: chosen.name,
    });
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
  dispatchWalletChangedEvent({
    family: 'solana',
    action: 'connect',
    address: pubkey,
    previousAddress: previousConnectedAddress,
    walletName: chosen.name,
  });

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

function findMatchingSolanaStandardAccount(accounts, expectedAddress, walletName = 'Solana Wallet') {
  if (!Array.isArray(accounts) || !accounts.length || !expectedAddress) {
    throw new Error(
      `Pre-sign check failed: connected Solana account (${String(expectedAddress || '').slice(0, 6)}…) is not exposed by ${walletName}.`
    );
  }
  const match = accounts.find((a) => extractSolanaPubkeyString(a?.address) === expectedAddress);
  if (!match) {
    throw new Error(
      `Pre-sign check failed: connected Solana account (${expectedAddress.slice(0, 6)}…) does not match any active Wallet Standard account in ${walletName}.`
    );
  }
  return match;
}

async function deserializeAndInspectSolanaTx(txBytes, { allowLegacyFallback = false } = {}) {
  const prims = await loadSolanaWeb3Primitives();
  if (!prims?.VersionedTransaction?.deserialize) {
    throw new Error('Pre-sign check failed: Solana VersionedTransaction deserializer is unavailable.');
  }

  let versionedTx = null;
  let legacyTx = null;
  try {
    versionedTx = prims.VersionedTransaction.deserialize(txBytes);
  } catch (vErr) {
    if (allowLegacyFallback && typeof prims.Transaction?.from === 'function') {
      try {
        legacyTx = prims.Transaction.from(txBytes);
      } catch (lErr) {
        throw new Error(
          `Pre-sign check failed: invalid Solana transaction bytes (${lErr instanceof Error ? lErr.message : String(lErr)}).`
        );
      }
    } else {
      throw new Error(
        `Pre-sign check failed: failed to deserialize Solana VersionedTransaction (${vErr instanceof Error ? vErr.message : String(vErr)}).`
      );
    }
  }

  if (versionedTx) {
    const msg = versionedTx.message;
    const staticKeys = Array.isArray(msg?.staticAccountKeys)
      ? msg.staticAccountKeys.map((k) => extractSolanaPubkeyString(k))
      : [];
    const addressTableLookups = Array.isArray(msg?.addressTableLookups) ? msg.addressTableLookups : [];
    const compiledInstructions = Array.isArray(msg?.compiledInstructions)
      ? msg.compiledInstructions.map((ix) => {
          const programIdIndex = Number(ix?.programIdIndex);
          const programId =
            Number.isInteger(programIdIndex) && programIdIndex >= 0 && programIdIndex < staticKeys.length
              ? staticKeys[programIdIndex]
              : null;
          const accountKeyIndexes = Array.isArray(ix?.accountKeyIndexes)
            ? ix.accountKeyIndexes.map((idx) => Number(idx))
            : [];
          const data = ix?.data instanceof Uint8Array ? ix.data : new Uint8Array(ix?.data || []);
          return { programIdIndex, programId, accountKeyIndexes, data };
        })
      : [];
    return {
      txObject: versionedTx,
      serialized: versionedTx.serialize(),
      isLegacy: false,
      feePayer: staticKeys[0] || null,
      staticKeys,
      addressTableLookups,
      compiledInstructions,
    };
  }

  // Legacy Transaction fallback (only when explicitly allowed)
  const feePayer = extractSolanaPubkeyString(legacyTx?.feePayer);
  const staticKeys = [];
  const keyIndexMap = new Map();
  const addKey = (kStr) => {
    if (!kStr) return -1;
    if (keyIndexMap.has(kStr)) return keyIndexMap.get(kStr);
    const idx = staticKeys.length;
    staticKeys.push(kStr);
    keyIndexMap.set(kStr, idx);
    return idx;
  };
  if (feePayer) addKey(feePayer);
  const compiledInstructions = (Array.isArray(legacyTx?.instructions) ? legacyTx.instructions : []).map((ix) => {
    const programId = extractSolanaPubkeyString(ix?.programId);
    const programIdIndex = addKey(programId);
    const accountKeyIndexes = (Array.isArray(ix?.keys) ? ix.keys : []).map((meta) =>
      addKey(extractSolanaPubkeyString(meta?.pubkey))
    );
    const data = ix?.data instanceof Uint8Array ? ix.data : new Uint8Array(ix?.data || []);
    return { programIdIndex, programId, accountKeyIndexes, data };
  });
  return {
    txObject: legacyTx,
    serialized: txBytes,
    isLegacy: true,
    feePayer,
    staticKeys,
    addressTableLookups: [],
    compiledInstructions,
  };
}

function validateDeserializedSolanaTx(
  inspected,
  { connectedAddress, expectedFeePayer = null, flow = null, allowedProgramIds = null, expectedRecipientAta = null } = {}
) {
  if (!inspected?.feePayer) {
    throw new Error('Pre-sign check failed: deserialized Solana transaction is missing a fee payer.');
  }
  if (!connectedAddress || inspected.feePayer !== connectedAddress) {
    throw new Error(
      `Pre-sign check failed: deserialized transaction fee payer (${inspected.feePayer.slice(0, 6)}…) does not match connected Solana wallet (${String(connectedAddress || '').slice(0, 6)}…).`
    );
  }
  if (expectedFeePayer && inspected.feePayer !== String(expectedFeePayer).trim()) {
    throw new Error(
      `Pre-sign check failed: deserialized transaction fee payer (${inspected.feePayer.slice(0, 6)}…) does not match expected fee payer (${String(expectedFeePayer).slice(0, 6)}…).`
    );
  }
  if (!Array.isArray(inspected.compiledInstructions) || inspected.compiledInstructions.length === 0) {
    throw new Error('Pre-sign check failed: deserialized Solana transaction contains no instructions.');
  }

  for (const ix of inspected.compiledInstructions) {
    if (!ix.programId) {
      throw new Error('Pre-sign check failed: Solana instruction references an unresolved program ID.');
    }
  }

  if (allowedProgramIds) {
    const allowedSet = allowedProgramIds instanceof Set ? allowedProgramIds : new Set(allowedProgramIds);
    for (const ix of inspected.compiledInstructions) {
      if (!allowedSet.has(ix.programId)) {
        throw new Error(
          `Pre-sign check failed: Solana instruction invokes disallowed program ${ix.programId}.`
        );
      }
    }
  }

  if (flow === 'rent_reclaim') {
    if (inspected.addressTableLookups.length !== 0) {
      throw new Error(
        'Pre-sign check failed: rent reclaim transaction must not use Address Lookup Tables (ALTs).'
      );
    }
    let closeInstructionCount = 0;
    for (const ix of inspected.compiledInstructions) {
      if (!RENT_RECLAIM_ALLOWED_PROGRAMS.has(ix.programId)) {
        throw new Error(
          `Pre-sign check failed: rent reclaim transaction invokes disallowed program ${ix.programId}.`
        );
      }
      if (ix.programId === SOLANA_TOKEN_PROGRAM_STR || ix.programId === SOLANA_TOKEN_2022_PROGRAM_STR) {
        if (!ix.data || ix.data.length < 1 || ix.data[0] !== 9) {
          throw new Error(
            `Pre-sign check failed: rent reclaim Token instruction must use CloseAccount opcode (9), got ${ix.data?.[0] ?? 'empty'}.`
          );
        }
        if (ix.accountKeyIndexes.length < 3) {
          throw new Error(
            'Pre-sign check failed: rent reclaim CloseAccount instruction is missing required account keys.'
          );
        }
        const destinationKey = inspected.staticKeys[ix.accountKeyIndexes[1]];
        const ownerKey = inspected.staticKeys[ix.accountKeyIndexes[2]];
        if (destinationKey !== connectedAddress) {
          throw new Error(
            `Pre-sign check failed: CloseAccount rent destination (${String(destinationKey || 'missing').slice(0, 6)}…) does not match connected Solana wallet.`
          );
        }
        if (ownerKey !== connectedAddress) {
          throw new Error(
            `Pre-sign check failed: CloseAccount authority (${String(ownerKey || 'missing').slice(0, 6)}…) does not match connected Solana wallet.`
          );
        }
        closeInstructionCount += 1;
      }
    }
    if (closeInstructionCount === 0) {
      throw new Error(
        'Pre-sign check failed: rent reclaim transaction contains no SPL CloseAccount instructions.'
      );
    }
  } else if (flow === 'cctp_claim') {
    let hasMessageTransmitter = false;
    for (const ix of inspected.compiledInstructions) {
      if (!CCTP_CLAIM_ALLOWED_PROGRAMS.has(ix.programId)) {
        throw new Error(
          `Pre-sign check failed: CCTP claim transaction invokes disallowed program ${ix.programId}.`
        );
      }
      if (CCTP_MESSAGE_TRANSMITTER_PROGRAMS.has(ix.programId)) {
        hasMessageTransmitter = true;
      }
      if (ix.programId === SOLANA_TOKEN_PROGRAM_STR || ix.programId === SOLANA_TOKEN_2022_PROGRAM_STR) {
        if (!ix.data || ix.data.length < 1 || ix.data[0] !== 9) {
          throw new Error(
            'Pre-sign check failed: bundled Token instruction in CCTP claim must be CloseAccount (opcode 9).'
          );
        }
        const destKey = inspected.staticKeys[ix.accountKeyIndexes[1]];
        const ownerKey = inspected.staticKeys[ix.accountKeyIndexes[2]];
        if (destKey !== connectedAddress || ownerKey !== connectedAddress) {
          throw new Error(
            'Pre-sign check failed: bundled CloseAccount in CCTP claim must target connected Solana wallet.'
          );
        }
      }
    }
    if (!hasMessageTransmitter) {
      throw new Error(
        'Pre-sign check failed: CCTP claim transaction is missing Circle MessageTransmitter instruction.'
      );
    }
    if (!expectedRecipientAta || !inspected.staticKeys.includes(expectedRecipientAta)) {
      throw new Error(
        'Pre-sign check failed: CCTP claim transaction staticAccountKeys do not include canonical recipient USDC ATA.'
      );
    }
  } else if (flow === 'jupiter_yield' || flow === 'jupiter_predict') {
    let hasAllowedExecutionProgram = false;

    for (const ix of inspected.compiledInstructions) {
      if (!JUPITER_FLOW_ALLOWED_PROGRAMS.has(ix.programId)) {
        throw new Error(
          `Pre-sign check failed: ${flow} transaction invokes disallowed program ${ix.programId}.`
        );
      }

      if (JUPITER_KNOWN_PROGRAMS.has(ix.programId)) {
        hasAllowedExecutionProgram = true;
      }

      // Unconditionally audit ALL SystemProgram instructions (never bypass when Jupiter is present).
      if (ix.programId === SOLANA_SYSTEM_PROGRAM_STR) {
        if (!ix.data || ix.data.length < 4) {
          throw new Error(
            `Pre-sign check failed: malformed SystemProgram instruction in ${flow} transaction.`
          );
        }
        const sysOpcode =
          (ix.data[0] | (ix.data[1] << 8) | (ix.data[2] << 16) | (ix.data[3] << 24)) >>> 0;
        if (sysOpcode === 2) {
          // Transfer (2): destination (accountKeyIndexes[1]) MUST be the connected wallet (e.g. self-wrap).
          const destKey = inspected.staticKeys[ix.accountKeyIndexes[1]];
          if (destKey !== connectedAddress) {
            throw new Error(
              `Pre-sign check failed: blocked raw SystemProgram.transfer to external destination in ${flow} transaction.`
            );
          }
        } else if (sysOpcode === 11) {
          // Reject SystemProgram.TransferWithSeed (11) outright: recipient is accountKeyIndexes[2] and
          // Jupiter/yield/predict flows never require seed-derived SOL transfers.
          throw new Error(
            `Pre-sign check failed: blocked SystemProgram.transferWithSeed (opcode 11) in ${flow} transaction.`
          );
        } else if (sysOpcode === 0 || sysOpcode === 3) {
          // CreateAccount (0) / CreateAccountWithSeed (3): allow only temp SPL Token / Token-2022 accounts.
          // CreateAccount layout: u32 opcode (4) + u64 lamports (8) + u64 space (8) + pubkey owner (32) = 52 bytes.
          if (sysOpcode === 0) {
            if (ix.data.length < 52) {
              throw new Error(
                `Pre-sign check failed: truncated SystemProgram.createAccount instruction in ${flow} transaction.`
              );
            }
            const ownerPubkey = bytesToBase58(ix.data.slice(20, 52));
            if (
              ownerPubkey !== SOLANA_TOKEN_PROGRAM_STR &&
              ownerPubkey !== SOLANA_TOKEN_2022_PROGRAM_STR
            ) {
              throw new Error(
                `Pre-sign check failed: blocked SystemProgram.createAccount assigned to disallowed program ${ownerPubkey}.`
              );
            }
          } else {
            // CreateAccountWithSeed: trailing 32 bytes are owner pubkey.
            if (ix.data.length < 32) {
              throw new Error(
                `Pre-sign check failed: truncated SystemProgram.createAccountWithSeed instruction in ${flow} transaction.`
              );
            }
            const ownerPubkey = bytesToBase58(ix.data.slice(ix.data.length - 32));
            if (
              ownerPubkey !== SOLANA_TOKEN_PROGRAM_STR &&
              ownerPubkey !== SOLANA_TOKEN_2022_PROGRAM_STR
            ) {
              throw new Error(
                `Pre-sign check failed: blocked SystemProgram.createAccountWithSeed assigned to disallowed program ${ownerPubkey}.`
              );
            }
          }
        } else {
          throw new Error(
            `Pre-sign check failed: blocked unsafe SystemProgram instruction (opcode ${sysOpcode}) in ${flow} transaction.`
          );
        }
      }

      // Unconditionally audit ALL SPL Token / Token-2022 instructions (block raw Transfer/Approve/SetAuthority/Burn).
      if (ix.programId === SOLANA_TOKEN_PROGRAM_STR || ix.programId === SOLANA_TOKEN_2022_PROGRAM_STR) {
        if (!ix.data || ix.data.length < 1) {
          throw new Error(
            `Pre-sign check failed: malformed SPL Token instruction in ${flow} transaction.`
          );
        }
        const tokenOp = ix.data[0];
        if (tokenOp === 17) {
          // SyncNative (17) is safe for WSOL wrapping.
        } else if (tokenOp === 9) {
          // CloseAccount (9): destination AND authority MUST match connected wallet.
          if (ix.accountKeyIndexes.length < 3) {
            throw new Error(
              `Pre-sign check failed: SPL CloseAccount instruction in ${flow} is missing required accounts.`
            );
          }
          const destKey = inspected.staticKeys[ix.accountKeyIndexes[1]];
          const ownerKey = inspected.staticKeys[ix.accountKeyIndexes[2]];
          if (destKey !== connectedAddress || ownerKey !== connectedAddress) {
            throw new Error(
              `Pre-sign check failed: SPL CloseAccount in ${flow} must target connected Solana wallet.`
            );
          }
        } else if (tokenOp === 1) {
          // InitializeAccount (1): owner account (index 2) MUST be connected wallet.
          const ownerKey = inspected.staticKeys[ix.accountKeyIndexes[2]];
          if (ownerKey !== connectedAddress) {
            throw new Error(
              `Pre-sign check failed: SPL InitializeAccount in ${flow} must be owned by connected Solana wallet.`
            );
          }
        } else if (tokenOp === 16 || tokenOp === 18) {
          // InitializeAccount2 (16) / InitializeAccount3 (18): 32-byte owner pubkey starts at data[1..33].
          if (ix.data.length < 33) {
            throw new Error(
              `Pre-sign check failed: truncated SPL InitializeAccount instruction in ${flow} transaction.`
            );
          }
          const ownerKey = bytesToBase58(ix.data.slice(1, 33));
          if (ownerKey !== connectedAddress) {
            throw new Error(
              `Pre-sign check failed: SPL InitializeAccount in ${flow} must be owned by connected Solana wallet.`
            );
          }
        } else {
          throw new Error(
            `Pre-sign check failed: blocked disallowed SPL Token instruction (opcode ${tokenOp}) in ${flow} transaction.`
          );
        }
      }
    }

    if (!hasAllowedExecutionProgram) {
      throw new Error(
        `Pre-sign check failed: ${flow} transaction contains no allowlisted Jupiter or protocol execution instruction.`
      );
    }
  }
}

/**
 * Signs and submits a server-built Circle CCTP Solana `receiveMessage` claim transaction plan
 * using Phantom, Backpack, or Solflare (Wallet Standard `solana:signAndSendTransaction` or legacy
 * `provider.signAndSendTransaction` / `provider.request`).
 * Fails closed on deserialization error, fee-payer mismatch, disallowed program IDs, or recipient/ATA mismatch.
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

  // Verify canonical USDC ATA bytes32 & base58
  const derivedAtaHex = await resolveExpectedSolanaUsdcAtaBytes32Hex(claimPlan.solanaDestination);
  if (
    claimPlan.expectedMintRecipientBytes32 &&
    derivedAtaHex &&
    derivedAtaHex.toLowerCase() !== String(claimPlan.expectedMintRecipientBytes32).toLowerCase()
  ) {
    throw new Error(
      'Pre-sign check failed: CCTP claim mintRecipient does not match canonical Solana USDC ATA PDA.'
    );
  }
  const derivedAtaBase58 = derivedAtaHex ? bytes32HexToBase58(derivedAtaHex) : null;
  if (derivedAtaBase58 && String(claimPlan.recipientUsdcAta).trim() !== derivedAtaBase58) {
    throw new Error(
      'Pre-sign check failed: CCTP claim recipientUsdcAta does not match canonical Solana USDC ATA PDA.'
    );
  }
  const canonicalRecipientAta = derivedAtaBase58 || String(claimPlan.recipientUsdcAta).trim();

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

  // Real client-side deserialization & fail-closed pre-sign verification of CCTP claim tx
  const inspected = await deserializeAndInspectSolanaTx(txBytes, { allowLegacyFallback: false });
  validateDeserializedSolanaTx(inspected, {
    connectedAddress: connectedSolanaAddress,
    expectedFeePayer: options.expectedFeePayer || connectedSolanaAddress,
    flow: 'cctp_claim',
    allowedProgramIds: options.allowedProgramIds || null,
    expectedRecipientAta: canonicalRecipientAta,
  });

  const walletName = connectedSolanaWalletName || 'Solana Wallet';
  const serialized = inspected.serialized;

  // 1. Wallet Standard (`solana:signAndSendTransaction`) — Phantom, Backpack, Solflare modern standard
  if (activeSolanaSession?.kind === 'standard') {
    const stdFeature = activeSolanaSession.wallet?.features?.['solana:signAndSendTransaction'];
    if (typeof stdFeature?.signAndSendTransaction === 'function') {
      const account = findMatchingSolanaStandardAccount(
        activeSolanaSession.wallet.accounts,
        connectedSolanaAddress,
        walletName
      );
      const res = await stdFeature.signAndSendTransaction({
        transaction: serialized,
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
        explorerUrl: `https://solscan.io/tx/${encodeURIComponent(signature)}`,
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
    try {
      const res = await provider.signAndSendTransaction(inspected.txObject, {
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
        explorerUrl: `https://solscan.io/tx/${encodeURIComponent(signature)}`,
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
            explorerUrl: `https://solscan.io/tx/${encodeURIComponent(signature)}`,
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
      explorerUrl: `https://solscan.io/tx/${encodeURIComponent(signature)}`,
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

/**
 * Signs and submits a server-built Solana VersionedTransaction (base64),
 * such as Empty-ATA Rent Reclaim, Jupiter Swap Yield Park, or Jupiter Prediction Order.
 * ALWAYS deserializes and verifies fee payer, Wallet Standard account match, and
 * flow-specific program/instruction constraints before touching the wallet.
 */
export async function signAndSendSolanaVersionedTx(base64Tx, options = {}) {
  const cleanB64 = String(base64Tx || '').trim();
  const txBytes = base64ToUint8Array(cleanB64);
  if (!txBytes || txBytes.length < 16) {
    throw new Error('Invalid or empty Solana VersionedTransaction payload.');
  }

  if (!activeSolanaSession || !connectedSolanaAddress) {
    if (options.autoConnect === false) {
      throw new Error('Connect your Solana wallet (Phantom, Backpack, or Solflare) before signing.');
    }
    await connectSolanaWallet({ walletId: options.walletId });
  }

  if (
    options.expectedFeePayer &&
    connectedSolanaAddress &&
    String(options.expectedFeePayer).trim() !== String(connectedSolanaAddress).trim()
  ) {
    throw new Error(
      `Pre-sign check failed: connected Solana wallet (${connectedSolanaAddress.slice(0, 6)}…) does not match transaction fee payer (${String(options.expectedFeePayer).slice(0, 6)}…).`
    );
  }

  const inspected = await deserializeAndInspectSolanaTx(txBytes, {
    allowLegacyFallback: Boolean(options.allowLegacyFallback),
  });

  let expectedRecipientAta = options.expectedRecipientAta || null;
  if (options.flow === 'cctp_claim' && !expectedRecipientAta) {
    expectedRecipientAta = await resolveExpectedSolanaUsdcAtaBase58(
      options.expectedSolanaDestination || connectedSolanaAddress
    );
  }

  validateDeserializedSolanaTx(inspected, {
    connectedAddress: connectedSolanaAddress,
    expectedFeePayer: options.expectedFeePayer || null,
    flow: options.flow || null,
    allowedProgramIds: options.allowedProgramIds || null,
    expectedRecipientAta,
  });

  const walletName = connectedSolanaWalletName || 'Solana Wallet';
  const serialized = inspected.serialized;

  // 1. Wallet Standard (`solana:signAndSendTransaction`)
  if (activeSolanaSession?.kind === 'standard') {
    const stdFeature = activeSolanaSession.wallet?.features?.['solana:signAndSendTransaction'];
    if (typeof stdFeature?.signAndSendTransaction === 'function') {
      const account = findMatchingSolanaStandardAccount(
        activeSolanaSession.wallet.accounts,
        connectedSolanaAddress,
        walletName
      );
      const res = await stdFeature.signAndSendTransaction({
        transaction: serialized,
        account,
        chain: 'solana:mainnet',
      });
      const signature = extractSolanaSignature(res);
      if (!signature) {
        throw new Error(`${walletName} did not return a Solana transaction signature.`);
      }
      return {
        signature,
        walletName,
        mode: 'wallet_standard_sign_and_send',
        explorerUrl: `https://solscan.io/tx/${encodeURIComponent(signature)}`,
      };
    }
  }

  // 2. Legacy injected provider (`signAndSendTransaction` / `request`)
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
    try {
      const res = await provider.signAndSendTransaction(inspected.txObject, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      const signature = extractSolanaSignature(res);
      if (!signature) {
        throw new Error(`${walletName} did not return a Solana transaction signature.`);
      }
      return {
        signature,
        walletName,
        mode: 'legacy_sign_and_send',
        explorerUrl: `https://solscan.io/tx/${encodeURIComponent(signature)}`,
      };
    } catch (err) {
      if (isUserRejectedError(err)) throw err;
      if (typeof provider.request === 'function') {
        const rpcRes = await provider.request({
          method: 'signAndSendTransaction',
          params: { message: bytesToBase58(serialized) },
        });
        const signature = extractSolanaSignature(rpcRes);
        if (signature) {
          return {
            signature,
            walletName,
            mode: 'provider_request_sign_and_send',
            explorerUrl: `https://solscan.io/tx/${encodeURIComponent(signature)}`,
          };
        }
      }
      throw err;
    }
  }

  if (provider && typeof provider.request === 'function') {
    const rpcRes = await provider.request({
      method: 'signAndSendTransaction',
      params: { message: bytesToBase58(serialized) },
    });
    const signature = extractSolanaSignature(rpcRes);
    if (!signature) {
      throw new Error(`${walletName} did not return a Solana transaction signature.`);
    }
    return {
      signature,
      walletName,
      mode: 'provider_request_sign_and_send',
      explorerUrl: `https://solscan.io/tx/${encodeURIComponent(signature)}`,
    };
  }

  throw new Error(
    `${walletName} does not expose signAndSendTransaction. Connect Phantom, Backpack, or Solflare to sign.`
  );
}

/**
 * Validates and submits one or more ERC-20 `approve(spender, 0)` revoke calls on an EVM chain.
 * Uses EIP-5792 `wallet_sendCalls` batching when available (verifying confirmation via
 * `waitForEip5792Batch`), and cleanly falls back to sequential `eth_sendTransaction` if the
 * wallet does not support EIP-5792 (never falling back on 4001 rejection).
 */
export async function sendEvmRevokeCalls({ chainId, calls, expectedFrom } = {}) {
  if (!activeEvmProvider || !connectedEvmAddress) {
    throw new Error('Connect your EVM wallet before signing approval revocations.');
  }
  if (!Array.isArray(calls) || !calls.length) {
    throw new Error('No revoke calls provided.');
  }
  assertFromMatchesConnected(expectedFrom);

  const targetChainId = Number(chainId ?? calls[0]?.chainId);
  if (!Number.isInteger(targetChainId) || targetChainId <= 0) {
    throw new Error(`Pre-sign check failed: invalid target chainId (${chainId}).`);
  }

  const normalizedCalls = calls.map((raw) => {
    const to = String(raw?.to || '').trim();
    const data = String(raw?.data || '').trim();
    const value = String(raw?.value || '0x0').trim().toLowerCase();
    assertValidEvmAddress(to, 'ERC-20 token contract');
    if (value !== '0x0' && value !== '0x00') {
      throw new Error('Pre-sign check failed: ERC-20 revoke call must have value 0x0.');
    }
    if (raw?.chainId !== undefined && raw?.chainId !== null && Number(raw.chainId) !== targetChainId) {
      throw new Error(
        `Pre-sign check failed: mixed chainId in revoke batch (call chainId ${raw.chainId} !== target ${targetChainId}).`
      );
    }
    const cleanHex = data.toLowerCase();
    // Must be strict approve(address,uint256(0)): 0x095ea7b3 + 24 zero nibbles + 40 addr nibbles + 64 zero nibbles
    if (
      cleanHex.length !== 138 ||
      !cleanHex.startsWith('0x095ea7b3' + '0'.repeat(24)) ||
      !cleanHex.endsWith('0'.repeat(64)) ||
      !/^0x[0-9a-f]{136}$/.test(cleanHex)
    ) {
      throw new Error(
        'Pre-sign check failed: calldata is not a strict ERC-20 approve(spender, 0) revocation.'
      );
    }
    const spenderAddr = '0x' + cleanHex.slice(10 + 24, 10 + 64);
    if (spenderAddr === ZERO_EVM_ADDR) {
      throw new Error('Pre-sign check failed: ERC-20 revoke spender cannot be the zero address.');
    }
    return {
      to,
      data: cleanHex,
      value: '0x0',
      chainId: targetChainId,
    };
  });

  await ensureEvmChain(targetChainId);

  // Use EIP-5792 batch when revoking multiple approvals and wallet supports it
  if (normalizedCalls.length > 1) {
    try {
      const batchRes = await sendEip5792Batch({
        chainId: targetChainId,
        calls: normalizedCalls,
        atomicRequired: false,
        expectedFrom: expectedFrom || connectedEvmAddress,
      });
      const settled = await waitForEip5792Batch(batchRes.batchId);
      if (settled.failed) {
        throw new Error(
          `EIP-5792 revoke batch failed or reverted onchain (status: ${settled.status}).`
        );
      }
      if (!settled.confirmed) {
        throw new Error(
          `EIP-5792 revoke batch did not confirm (${settled.status}) — check your wallet before retrying.`
        );
      }
      return {
        mode: 'eip5792',
        batchId: batchRes.batchId,
        txHashes: settled.txHashes || [],
        revokedCount: normalizedCalls.length,
        revokedIndices: normalizedCalls.map((_, idx) => idx),
      };
    } catch (err) {
      if (isUserRejectedError(err) || !err?.unsupportedEip5792) {
        throw err;
      }
      // Fall through cleanly to sequential eth_sendTransaction
    }
  }

  const txHashes = [];
  const revokedIndices = [];
  for (let i = 0; i < normalizedCalls.length; i += 1) {
    const call = normalizedCalls[i];
    try {
      const hash = await sendRealEvmTransaction(
        { ...call, chainId: targetChainId },
        { expectedFrom: expectedFrom || connectedEvmAddress }
      );
      if (hash) txHashes.push(String(hash));
      revokedIndices.push(i);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err?.message || err || 'Revoke transaction failed.'));
      if (err && typeof err === 'object' && 'code' in err && wrapped.code === undefined) {
        wrapped.code = err.code;
      }
      wrapped.revokedIndices = revokedIndices;
      wrapped.txHashes = txHashes;
      wrapped.partialSuccess = revokedIndices.length > 0;
      throw wrapped;
    }
  }
  return {
    mode: 'sequential',
    batchId: null,
    txHashes,
    revokedCount: revokedIndices.length,
    revokedIndices,
  };
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
      addCosmos('cosmostation', 'Cosmostation', '/logos/cosmostation.svg', window.cosmostation.providers.keplr);
    } else if (window.cosmostation?.cosmos) {
      addCosmos('cosmostation', 'Cosmostation', '/logos/cosmostation.svg', window.cosmostation.cosmos, 'Cosmostation API');
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
      const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : 'https://turgalium.app';
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
      if (event.source !== window || event.origin !== window.location.origin) return;
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

// =========================================================================
// BITCOIN BIP-174 PSBT PARSER, FINALIZED TX EXTRACTOR & BROADCAST HELPERS
// =========================================================================

function hexToUint8(hex) {
  const clean = String(hex || '').trim().toLowerCase().replace(/^0x/, '');
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function uint8ToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function uint8ToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToUint8(b64) {
  const clean = String(b64 || '').trim();
  if (!clean) return null;
  try {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

function toPsbtBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const asHex = hexToUint8(trimmed);
    if (asHex) return asHex;
    const asB64 = base64ToUint8(trimmed);
    if (asB64) return asB64;
  }
  return null;
}

function hasPsbtMagic(bytes) {
  return (
    bytes &&
    bytes.length >= 5 &&
    bytes[0] === 0x70 &&
    bytes[1] === 0x73 &&
    bytes[2] === 0x62 &&
    bytes[3] === 0x74 &&
    bytes[4] === 0xff
  );
}

function readBtcCompactSize(bytes, offset) {
  if (!bytes || offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first < 0xfd) return { value: first, bytesRead: 1 };
  if (first === 0xfd) {
    if (offset + 3 > bytes.length) return null;
    return { value: bytes[offset + 1] | (bytes[offset + 2] << 8), bytesRead: 3 };
  }
  if (first === 0xfe) {
    if (offset + 5 > bytes.length) return null;
    return {
      value:
        (bytes[offset + 1] |
          (bytes[offset + 2] << 8) |
          (bytes[offset + 3] << 16) |
          (bytes[offset + 4] << 24)) >>>
        0,
      bytesRead: 5,
    };
  }
  if (offset + 9 > bytes.length) return null;
  let val = 0n;
  for (let i = 0; i < 8; i += 1) {
    val |= BigInt(bytes[offset + 1 + i]) << BigInt(i * 8);
  }
  if (val > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { value: Number(val), bytesRead: 9 };
}

function writeBtcCompactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, (n >> 8) & 0xff);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
}

function concatUint8(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

/**
 * Lightweight zero-dependency BIP-174 / BIP-370 PSBT input counter.
 * Parses `PSBT_GLOBAL_UNSIGNED_TX` (0x00) or `PSBT_GLOBAL_INPUT_COUNT` (0x04).
 */
export function parsePsbtInputCount(psbtInput) {
  const bytes = toPsbtBytes(psbtInput);
  if (!hasPsbtMagic(bytes)) return null;
  let offset = 5;
  let found = null;
  while (offset < bytes.length) {
    const keyLen = readBtcCompactSize(bytes, offset);
    if (!keyLen) return null;
    offset += keyLen.bytesRead;
    if (keyLen.value === 0) break;
    if (offset + keyLen.value > bytes.length) return null;
    const keyType = bytes[offset];
    offset += keyLen.value;

    const valLen = readBtcCompactSize(bytes, offset);
    if (!valLen) return null;
    offset += valLen.bytesRead;
    if (offset + valLen.value > bytes.length) return null;
    const valStart = offset;
    offset += valLen.value;

    if (keyType === 0x00 && keyLen.value === 1) {
      if (valLen.value < 6) return null;
      const inCount = readBtcCompactSize(bytes, valStart + 4);
      if (!inCount || inCount.value <= 0) return null;
      found = inCount.value;
    } else if (keyType === 0x04 && keyLen.value === 1) {
      const inCount = readBtcCompactSize(bytes, valStart);
      if (!inCount || inCount.value <= 0) return null;
      found = inCount.value;
    }
  }
  return found;
}

/**
 * Extracts a finalized raw Bitcoin transaction hex from a finalized BIP-174 PSBT.
 * Returns `null` if ANY input lacks both `PSBT_IN_FINAL_SCRIPTSIG` (0x07) and
 * `PSBT_IN_FINAL_SCRIPTWITNESS` (0x08) — i.e. the PSBT is unfinalized.
 */
export function extractFinalizedTxFromPsbt(psbtInput) {
  const bytes = toPsbtBytes(psbtInput);
  if (!hasPsbtMagic(bytes)) return null;

  let offset = 5;
  let unsignedTx = null;
  while (offset < bytes.length) {
    const keyLen = readBtcCompactSize(bytes, offset);
    if (!keyLen) return null;
    offset += keyLen.bytesRead;
    if (keyLen.value === 0) break;
    if (offset + keyLen.value > bytes.length) return null;
    const keyType = bytes[offset];
    offset += keyLen.value;

    const valLen = readBtcCompactSize(bytes, offset);
    if (!valLen) return null;
    offset += valLen.bytesRead;
    if (offset + valLen.value > bytes.length) return null;
    if (keyType === 0x00 && keyLen.value === 1) {
      unsignedTx = bytes.subarray(offset, offset + valLen.value);
    }
    offset += valLen.value;
  }
  if (!unsignedTx || unsignedTx.length < 10) return null;

  // Parse non-witness unsigned Bitcoin transaction
  let txOff = 0;
  const version = unsignedTx.subarray(0, 4);
  txOff = 4;
  const inCountRes = readBtcCompactSize(unsignedTx, txOff);
  if (!inCountRes || inCountRes.value <= 0) return null;
  txOff += inCountRes.bytesRead;
  const inCount = inCountRes.value;

  const inputs = [];
  for (let i = 0; i < inCount; i += 1) {
    if (txOff + 36 > unsignedTx.length) return null;
    const prevOut = unsignedTx.subarray(txOff, txOff + 36);
    txOff += 36;
    const scriptLenRes = readBtcCompactSize(unsignedTx, txOff);
    if (!scriptLenRes) return null;
    txOff += scriptLenRes.bytesRead + scriptLenRes.value;
    if (txOff + 4 > unsignedTx.length) return null;
    const sequence = unsignedTx.subarray(txOff, txOff + 4);
    txOff += 4;
    inputs.push({ prevOut, sequence });
  }

  const outputsStart = txOff;
  const outCountRes = readBtcCompactSize(unsignedTx, txOff);
  if (!outCountRes) return null;
  txOff += outCountRes.bytesRead;
  for (let o = 0; o < outCountRes.value; o += 1) {
    if (txOff + 8 > unsignedTx.length) return null;
    txOff += 8;
    const pkLenRes = readBtcCompactSize(unsignedTx, txOff);
    if (!pkLenRes) return null;
    txOff += pkLenRes.bytesRead + pkLenRes.value;
  }
  if (txOff + 4 !== unsignedTx.length) return null;
  const outputsSection = unsignedTx.subarray(outputsStart, txOff);
  const lockTime = unsignedTx.subarray(txOff, txOff + 4);

  // Walk each PSBT input map for finalScriptSig (0x07) and finalScriptWitness (0x08)
  const finalInputs = [];
  let hasWitness = false;
  for (let i = 0; i < inCount; i += 1) {
    let finalScriptSig = null;
    let finalScriptWitness = null;
    while (offset < bytes.length) {
      const keyLen = readBtcCompactSize(bytes, offset);
      if (!keyLen) return null;
      offset += keyLen.bytesRead;
      if (keyLen.value === 0) break;
      if (offset + keyLen.value > bytes.length) return null;
      const keyType = bytes[offset];
      offset += keyLen.value;

      const valLen = readBtcCompactSize(bytes, offset);
      if (!valLen) return null;
      offset += valLen.bytesRead;
      if (offset + valLen.value > bytes.length) return null;
      if (keyType === 0x07 && keyLen.value === 1) {
        finalScriptSig = bytes.subarray(offset, offset + valLen.value);
      } else if (keyType === 0x08 && keyLen.value === 1) {
        finalScriptWitness = bytes.subarray(offset, offset + valLen.value);
        hasWitness = true;
      }
      offset += valLen.value;
    }
    if (!finalScriptSig && !finalScriptWitness) {
      return null; // Unfinalized input!
    }
    finalInputs.push({
      scriptSig: finalScriptSig || new Uint8Array(0),
      witness: finalScriptWitness,
    });
  }

  const parts = [version];
  if (hasWitness) parts.push(Uint8Array.of(0x00, 0x01));
  parts.push(writeBtcCompactSize(inCount));
  for (let i = 0; i < inCount; i += 1) {
    parts.push(inputs[i].prevOut);
    parts.push(writeBtcCompactSize(finalInputs[i].scriptSig.length));
    if (finalInputs[i].scriptSig.length > 0) parts.push(finalInputs[i].scriptSig);
    parts.push(inputs[i].sequence);
  }
  parts.push(outputsSection);
  if (hasWitness) {
    for (let i = 0; i < inCount; i += 1) {
      parts.push(finalInputs[i].witness || Uint8Array.of(0x00));
    }
  }
  parts.push(lockTime);
  return uint8ToHex(concatUint8(parts));
}

async function broadcastBtcRawTxHex(rawTxHex, fetchFn = fetch) {
  const clean = String(rawTxHex || '').trim().toLowerCase().replace(/^0x/, '');
  if (!clean || clean.length < 120 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    throw new Error('Cannot broadcast Bitcoin transaction: invalid or truncated raw transaction hex.');
  }
  if (clean.startsWith('70736274ff')) {
    throw new Error('Cannot broadcast unfinalized BIP-174 PSBT directly to mempool.space.');
  }
  const res = await fetchFn('https://mempool.space/api/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: clean,
  });
  const text = (await res.text()).trim();
  if (!res.ok) {
    throw new Error(`Bitcoin broadcast via mempool.space failed (HTTP ${res.status}): ${text || 'rejected'}`);
  }
  if (!/^[0-9a-f]{64}$/i.test(text)) {
    throw new Error(`Bitcoin broadcast returned unexpected response instead of 64-hex txid: ${text.slice(0, 80)}`);
  }
  return text;
}

// =========================================================================
// COSMOS AMINO MAPPING, LIVE ACCOUNT LOOKUP, PROTOBUF TXRAW & BROADCAST
// =========================================================================

export const COSMOS_PROTO_TO_AMINO_TYPE = {
  '/ibc.applications.transfer.v1.MsgTransfer': 'cosmos-sdk/MsgTransfer',
  '/cosmos.bank.v1beta1.MsgSend': 'cosmos-sdk/MsgSend',
  '/cosmwasm.wasm.v1.MsgExecuteContract': 'wasm/MsgExecuteContract',
  '/circle.cctp.v1.MsgDepositForBurn': 'cctp/MsgDepositForBurn',
  '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward': 'cosmos-sdk/MsgWithdrawDelegationReward',
  '/cosmos.staking.v1beta1.MsgDelegate': 'cosmos-sdk/MsgDelegate',
  '/cosmos.staking.v1beta1.MsgUndelegate': 'cosmos-sdk/MsgUndelegate',
};

export function convertCosmosProtoMsgToAmino(msg) {
  const rawType = String(msg?.msg_type_url || msg?.typeUrl || msg?.type || '').trim();
  if (!rawType) {
    throw new Error('Cosmos message is missing msg_type_url / type.');
  }
  const parsedVal =
    typeof msg?.msg === 'string'
      ? JSON.parse(msg.msg)
      : msg?.msg && typeof msg.msg === 'object'
      ? { ...msg.msg }
      : msg?.value && typeof msg.value === 'object'
      ? { ...msg.value }
      : {};

  if (!rawType.startsWith('/')) {
    return { type: rawType, value: parsedVal };
  }

  const aminoType = COSMOS_PROTO_TO_AMINO_TYPE[rawType];
  if (!aminoType) {
    throw new Error(
      `Unsupported Cosmos protobuf message "${rawType}" for Amino signing. Provide protobuf bodyBytes/authInfoBytes for signDirect.`
    );
  }

  // Amino wasm/MsgExecuteContract expects `msg` as a parsed JSON object (not string/base64)
  if (rawType === '/cosmwasm.wasm.v1.MsgExecuteContract' && typeof parsedVal.msg === 'string') {
    try {
      parsedVal.msg = JSON.parse(parsedVal.msg);
    } catch {
      try {
        const decoded = new TextDecoder().decode(base64ToUint8(parsedVal.msg) || new Uint8Array());
        parsedVal.msg = JSON.parse(decoded);
      } catch {
        // leave as string if already raw
      }
    }
  }

  return { type: aminoType, value: parsedVal };
}

export function extractCosmosAccountFromLcdResponse(json) {
  if (!json || typeof json !== 'object') return null;
  const account = json.account && typeof json.account === 'object' ? json.account : json;
  const candidates = [account];
  if (account.base_account && typeof account.base_account === 'object') {
    candidates.push(account.base_account);
  }
  if (account.base_vesting_account && typeof account.base_vesting_account === 'object') {
    candidates.push(account.base_vesting_account);
    if (account.base_vesting_account.base_account && typeof account.base_vesting_account.base_account === 'object') {
      candidates.push(account.base_vesting_account.base_account);
    }
  }
  for (const c of candidates) {
    if (c?.account_number !== undefined && c?.account_number !== null && c?.sequence !== undefined && c?.sequence !== null) {
      const accountNumber = String(c.account_number).trim();
      const sequence = String(c.sequence).trim();
      if (/^\d+$/.test(accountNumber) && /^\d+$/.test(sequence)) {
        return { accountNumber, sequence };
      }
    }
  }
  return null;
}

export async function fetchCosmosAccountFromLcds(lcdUrls, signerAddr, fetchFn = fetch) {
  const urls = (Array.isArray(lcdUrls) ? lcdUrls : []).map((u) => String(u || '').trim()).filter(Boolean);
  if (!urls.length) {
    throw new Error(
      `Cannot fetch live Cosmos account_number/sequence for ${signerAddr}: no LCD endpoints configured (refusing to sign with fake 0/0).`
    );
  }
  let lastErr = '';
  for (const base of urls) {
    try {
      const res = await fetchFn(
        `${base.replace(/\/$/, '')}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(signerAddr)}`,
        { headers: { Accept: 'application/json' } }
      );
      if (!res.ok) {
        lastErr = `${base} returned HTTP ${res.status}`;
        continue;
      }
      const json = await res.json();
      const parsed = extractCosmosAccountFromLcdResponse(json);
      if (parsed) {
        return { ...parsed, lcdUrl: base };
      }
      lastErr = `${base} returned unrecognized account schema`;
    } catch (err) {
      lastErr = err?.message || String(err);
    }
  }
  throw new Error(
    `Failed to fetch live Cosmos account_number/sequence for ${signerAddr} from chain LCD (${lastErr || 'unreachable'}). Verify the account is funded on-chain and retry — Turgalium refuses to sign with placeholder 0/0.`
  );
}

// Minimal zero-dependency Cosmos Protobuf wire encoder for TxRaw / TxBody / AuthInfo / core messages
function pbVarint(val) {
  let n = typeof val === 'bigint' ? val : BigInt(val);
  if (n < 0n) n = 0n;
  const out = [];
  while (n >= 0x80n) {
    out.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  out.push(Number(n));
  return new Uint8Array(out);
}

function pbTag(fieldNumber, wireType) {
  return pbVarint((fieldNumber << 3) | wireType);
}

function pbBytes(fieldNumber, bytes) {
  if (!bytes || !bytes.length) return new Uint8Array(0);
  return concatUint8([pbTag(fieldNumber, 2), pbVarint(bytes.length), bytes]);
}

function pbString(fieldNumber, str) {
  if (!str) return new Uint8Array(0);
  return pbBytes(fieldNumber, new TextEncoder().encode(String(str)));
}

function pbUint64(fieldNumber, val) {
  const n = typeof val === 'bigint' ? val : BigInt(val || 0);
  if (n === 0n) return new Uint8Array(0);
  return concatUint8([pbTag(fieldNumber, 0), pbVarint(n)]);
}

function encodeCosmosCoinProto(coin) {
  if (!coin) return new Uint8Array(0);
  return concatUint8([pbString(1, coin.denom || ''), pbString(2, String(coin.amount || '0'))]);
}

function encodeCosmosAnyProto(typeUrl, valueBytes) {
  return concatUint8([pbString(1, typeUrl), pbBytes(2, valueBytes)]);
}

function encodeCosmosMsgToProtoAny(rawMsg) {
  const typeUrl = String(rawMsg?.msg_type_url || rawMsg?.typeUrl || '').trim();
  const val =
    typeof rawMsg?.msg === 'string'
      ? JSON.parse(rawMsg.msg)
      : rawMsg?.msg && typeof rawMsg.msg === 'object'
      ? rawMsg.msg
      : rawMsg?.value || {};

  if (typeUrl === '/cosmos.bank.v1beta1.MsgSend') {
    const coins = Array.isArray(val.amount) ? val.amount : [];
    const body = concatUint8([
      pbString(1, val.from_address || val.fromAddress || ''),
      pbString(2, val.to_address || val.toAddress || ''),
      ...coins.map((c) => pbBytes(3, encodeCosmosCoinProto(c))),
    ]);
    return encodeCosmosAnyProto(typeUrl, body);
  }

  if (typeUrl === '/ibc.applications.transfer.v1.MsgTransfer') {
    const th = val.timeout_height || val.timeoutHeight;
    const thBytes =
      th && (th.revision_number || th.revision_height || th.revisionNumber || th.revisionHeight)
        ? concatUint8([
            pbUint64(1, th.revision_number || th.revisionNumber || 0),
            pbUint64(2, th.revision_height || th.revisionHeight || 0),
          ])
        : new Uint8Array(0);
    const body = concatUint8([
      pbString(1, val.source_port || val.sourcePort || 'transfer'),
      pbString(2, val.source_channel || val.sourceChannel || ''),
      val.token ? pbBytes(3, encodeCosmosCoinProto(val.token)) : new Uint8Array(0),
      pbString(4, val.sender || ''),
      pbString(5, val.receiver || ''),
      thBytes.length ? pbBytes(6, thBytes) : new Uint8Array(0),
      pbUint64(7, val.timeout_timestamp || val.timeoutTimestamp || 0),
      pbString(8, val.memo || ''),
    ]);
    return encodeCosmosAnyProto(typeUrl, body);
  }

  if (typeUrl === '/cosmwasm.wasm.v1.MsgExecuteContract') {
    const msgJsonBytes =
      typeof val.msg === 'string'
        ? new TextEncoder().encode(val.msg)
        : new TextEncoder().encode(JSON.stringify(val.msg || {}));
    const funds = Array.isArray(val.funds) ? val.funds : [];
    const body = concatUint8([
      pbString(1, val.sender || ''),
      pbString(2, val.contract || ''),
      pbBytes(3, msgJsonBytes),
      ...funds.map((c) => pbBytes(5, encodeCosmosCoinProto(c))),
    ]);
    return encodeCosmosAnyProto(typeUrl, body);
  }

  if (typeUrl === '/circle.cctp.v1.MsgDepositForBurn') {
    const mintRecipient = val.mint_recipient || val.mintRecipient || '';
    const recipientBytes =
      typeof mintRecipient === 'string' && /^0x?[0-9a-f]{64}$/i.test(mintRecipient)
        ? hexToUint8(mintRecipient)
        : base64ToUint8(mintRecipient) || new Uint8Array(0);
    const body = concatUint8([
      pbString(1, val.from || ''),
      pbString(2, String(val.amount || '0')),
      pbUint64(3, val.destination_domain ?? val.destinationDomain ?? 5),
      pbBytes(4, recipientBytes),
      pbString(5, val.burn_token || val.burnToken || 'uusdc'),
    ]);
    return encodeCosmosAnyProto(typeUrl, body);
  }

  if (typeUrl === '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward') {
    const body = concatUint8([
      pbString(1, val.delegator_address || val.delegatorAddress || ''),
      pbString(2, val.validator_address || val.validatorAddress || ''),
    ]);
    return encodeCosmosAnyProto(typeUrl, body);
  }

  // Generic UTF-8 JSON fallback value bytes for any other typeUrl
  return encodeCosmosAnyProto(typeUrl, new TextEncoder().encode(JSON.stringify(val)));
}

export function encodeCosmosTxRaw({ bodyBytes, authInfoBytes, signatureBytes }) {
  return concatUint8([
    pbBytes(1, bodyBytes),
    pbBytes(2, authInfoBytes),
    pbBytes(3, signatureBytes),
  ]);
}

export function encodeCosmosAminoSignedTxRaw({ msgs, signedSignDoc, signatureObj }) {
  const sigBytes = base64ToUint8(signatureObj?.signature || '');
  if (!sigBytes || !sigBytes.length) {
    throw new Error('Cosmos wallet returned an empty or invalid signature.');
  }

  // 1. TxBody
  const encodedMsgs = msgs.map((m) => pbBytes(1, encodeCosmosMsgToProtoAny(m)));
  const bodyBytes = concatUint8([
    ...encodedMsgs,
    pbString(2, signedSignDoc?.memo || ''),
  ]);

  // 2. AuthInfo (SIGN_MODE_LEGACY_AMINO_JSON = 127)
  const pubKeyTypeRaw = String(signatureObj?.pub_key?.type || 'tendermint/PubKeySecp256k1');
  const pubKeyProtoUrl = pubKeyTypeRaw.toLowerCase().includes('ethsecp256k1')
    ? '/injective.crypto.v1beta1.ethsecp256k1.PubKey'
    : '/cosmos.crypto.secp256k1.PubKey';
  const pubKeyRawBytes = base64ToUint8(signatureObj?.pub_key?.value || '') || new Uint8Array(0);
  const pubKeyAny = pubKeyRawBytes.length
    ? encodeCosmosAnyProto(pubKeyProtoUrl, pbBytes(1, pubKeyRawBytes))
    : new Uint8Array(0);

  const singleMode = pbUint64(1, 127); // SIGN_MODE_LEGACY_AMINO_JSON
  const modeInfo = pbBytes(1, singleMode);
  const signerInfo = concatUint8([
    pubKeyAny.length ? pbBytes(1, pubKeyAny) : new Uint8Array(0),
    pbBytes(2, modeInfo),
    pbUint64(3, signedSignDoc?.sequence || '0'),
  ]);

  const feeCoins = Array.isArray(signedSignDoc?.fee?.amount) ? signedSignDoc.fee.amount : [];
  const feeProto = concatUint8([
    ...feeCoins.map((c) => pbBytes(1, encodeCosmosCoinProto(c))),
    pbUint64(2, signedSignDoc?.fee?.gas || '250000'),
  ]);

  const authInfoBytes = concatUint8([
    pbBytes(1, signerInfo),
    pbBytes(2, feeProto),
  ]);

  return encodeCosmosTxRaw({ bodyBytes, authInfoBytes, signatureBytes: sigBytes });
}

async function broadcastCosmosTxRaw({ prov, chainId, txRawBytes, lcdUrls, fetchFn = fetch }) {
  // 1. Prefer Keplr/Leap native sendTx(chainId, txBytes, 'sync') when exposed
  if (typeof prov?.sendTx === 'function') {
    const sent = await prov.sendTx(chainId, txRawBytes, 'sync');
    if (sent instanceof Uint8Array && sent.length > 0) {
      return uint8ToHex(sent).toUpperCase();
    }
    if (typeof sent === 'string' && /^[0-9a-fA-F]{64}$/.test(sent.trim())) {
      return sent.trim().toUpperCase();
    }
  }

  // 2. Broadcast signed Protobuf TxRaw via chain LCD POST /cosmos/tx/v1beta1/txs
  const urls = (Array.isArray(lcdUrls) ? lcdUrls : []).map((u) => String(u || '').trim()).filter(Boolean);
  if (!urls.length) {
    throw new Error(
      `Cosmos transaction was signed on ${chainId}, but neither wallet.sendTx nor chain LCD URLs were available to broadcast it on-chain.`
    );
  }

  const txBytesBase64 = uint8ToBase64(txRawBytes);
  let lastErr = '';
  for (const base of urls) {
    let res;
    try {
      res = await fetchFn(`${base.replace(/\/$/, '')}/cosmos/tx/v1beta1/txs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          tx_bytes: txBytesBase64,
          mode: 'BROADCAST_MODE_SYNC',
        }),
      });
    } catch (err) {
      lastErr = err?.message || String(err);
      continue;
    }

    const json = await res.json().catch(() => null);
    const txResp = json?.tx_response;
    if (txResp) {
      const code = Number(txResp.code ?? 0);
      if (code !== 0) {
        throw new Error(
          `Cosmos on-chain broadcast rejected on ${chainId} (code ${code}): ${txResp.raw_log || 'CheckTx failed'}`
        );
      }
      if (typeof txResp.txhash === 'string' && txResp.txhash.trim().length > 0) {
        return txResp.txhash.trim();
      }
    }
    lastErr = json?.message || `${base} returned HTTP ${res.status}`;
  }

  throw new Error(
    `Cosmos transaction was signed on ${chainId}, but broadcast failed across all LCD endpoints (${lastErr || 'unreachable'}). Transaction was NOT submitted on-chain.`
  );
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
  const fetchFn = typeof opts?.fetchFn === 'function' ? opts.fetchFn : fetch;

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
      const psbtBytes = hexToUint8(psbtHex);
      if (!psbtBytes || !hasPsbtMagic(psbtBytes)) {
        throw new Error(`Bitcoin step "${call.label}" contains an invalid BIP-174 PSBT hex payload.`);
      }

      // Resolve non-empty inputsToSign from prepared metadata or binary PSBT parser
      const payloadInputsToSign = Array.isArray(call.nativePayload?.inputsToSign)
        ? call.nativePayload.inputsToSign
            .filter((entry) => entry && Array.isArray(entry.signingIndexes) && entry.signingIndexes.length > 0)
            .map((entry) => ({
              address: String(entry.address || session.address),
              signingIndexes: entry.signingIndexes.map((idx) => Number(idx)),
            }))
        : [];
      const derivedInputCount =
        Number(call.nativePayload?.inputCount) > 0
          ? Number(call.nativePayload.inputCount)
          : parsePsbtInputCount(psbtBytes);
      const inputsToSign =
        payloadInputsToSign.length > 0
          ? payloadInputsToSign
          : derivedInputCount && derivedInputCount > 0
          ? [
              {
                address: session.address,
                signingIndexes: Array.from({ length: derivedInputCount }, (_, idx) => idx),
              },
            ]
          : [];

      if (session.walletId === 'unisat' && typeof session.provider.signPsbt === 'function') {
        const signedPsbt = await session.provider.signPsbt(psbtHex, { autoFinalized: true });
        if (typeof session.provider.pushPsbt === 'function') {
          const txid = await session.provider.pushPsbt(signedPsbt);
          if (!txid) {
            throw new Error(`UniSat pushPsbt did not return a Bitcoin txid for "${call.label}".`);
          }
          txHashes.push(String(txid));
        } else {
          const rawTxHex = extractFinalizedTxFromPsbt(signedPsbt);
          if (!rawTxHex) {
            throw new Error(
              `UniSat signed the PSBT for "${call.label}" but does not expose pushPsbt and returned an unfinalized PSBT.`
            );
          }
          const txid = await broadcastBtcRawTxHex(rawTxHex, fetchFn);
          txHashes.push(txid);
        }
        continue;
      }
      if (session.walletId === 'xverse' && typeof session.provider.request === 'function') {
        const psbtBase64 = uint8ToBase64(psbtBytes);
        const signInputs = {};
        for (const entry of inputsToSign) {
          signInputs[entry.address] = entry.signingIndexes;
        }
        const res = await session.provider.request('signPsbt', {
          psbt: psbtBase64,
          ...(Object.keys(signInputs).length ? { signInputs } : {}),
          broadcast: true,
        });
        const txid = res?.result?.txid || res?.txid;
        if (!txid) {
          throw new Error(`Xverse signPsbt did not return a broadcast Bitcoin txid for "${call.label}".`);
        }
        txHashes.push(String(txid));
        continue;
      }
      if (session.walletId === 'phantom-btc' && typeof session.provider.signPSBT === 'function') {
        if (!inputsToSign.length) {
          throw new Error(
            `Cannot sign Bitcoin PSBT with Phantom for "${call.label}": unable to determine PSBT input indexes (refusing to pass empty inputsToSign).`
          );
        }
        const signed = await session.provider.signPSBT(psbtBytes, { inputsToSign });
        if (!signed) {
          throw new Error(`Phantom Bitcoin signPSBT returned an empty response for "${call.label}".`);
        }

        // Case 1: Wallet already returned a broadcast 64-hex txid
        if (typeof signed === 'object' && !(signed instanceof Uint8Array) && typeof signed.txid === 'string') {
          const txid = signed.txid.trim();
          if (!/^[0-9a-f]{64}$/i.test(txid)) {
            throw new Error(`Phantom Bitcoin returned an invalid txid: ${txid}`);
          }
          txHashes.push(txid);
          continue;
        }

        // Case 2: Wallet returned finalized raw tx hex or signed PSBT bytes/hex/base64
        const rawPayload =
          typeof signed === 'object' && !(signed instanceof Uint8Array)
            ? signed.txHex || signed.rawTx || signed.psbt || signed.signedPsbt
            : signed;

        if (typeof rawPayload === 'string' && /^[0-9a-f]{64}$/i.test(rawPayload.trim())) {
          txHashes.push(rawPayload.trim());
          continue;
        }

        const signedBytes = toPsbtBytes(rawPayload);
        if (!signedBytes || signedBytes.length === 0) {
          throw new Error(`Phantom Bitcoin returned an unrecognized signed PSBT payload for "${call.label}".`);
        }

        let rawTxHex = null;
        if (hasPsbtMagic(signedBytes)) {
          rawTxHex = extractFinalizedTxFromPsbt(signedBytes);
          if (!rawTxHex) {
            throw new Error(
              `Phantom Bitcoin signed PSBT for "${call.label}" but returned an unfinalized PSBT without broadcast support. Transaction was NOT broadcast — use UniSat or Xverse for automatic PSBT finalization & broadcast.`
            );
          }
        } else {
          rawTxHex = uint8ToHex(signedBytes);
        }

        const txid = await broadcastBtcRawTxHex(rawTxHex, fetchFn);
        txHashes.push(txid);
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

    const defaultRestUrl = COSMOS_CONNECT_CHAINS.find((c) => c.chainId === chainId)?.suggestInfo?.rest;
    let cachedAccountNumber = null;
    let cachedSequence = null;

    for (let i = 0; i < batch.calls.length; i += 1) {
      const call = batch.calls[i];
      onStep(i, batch.calls.length, call);
      const np = call.nativePayload || {};
      const cosmosTx = np.cosmosTx;
      const msgs = cosmosTx?.msgs || np.msgs;
      const hasDirectBytes = Boolean(np.bodyBytes && np.authInfoBytes);
      if (!hasDirectBytes && (!Array.isArray(msgs) || !msgs.length)) {
        throw new Error(`Cosmos step "${call.label}" did not receive executable Cosmos messages.`);
      }
      const signerAddr =
        np.signerAddress ||
        session.addressesByChain?.[batch.chain] ||
        session.address;
      const lcdUrls = Array.isArray(np.lcdUrls) && np.lcdUrls.length
        ? np.lcdUrls
        : [np.lcdUrl, defaultRestUrl].filter(Boolean);

      // Resolve live account_number & sequence (never silently default to '0'/'0'!)
      let accountNumber = cachedAccountNumber;
      let sequence = cachedSequence;
      if (accountNumber === null || sequence === null) {
        const hasPayloadNums =
          np.accountNumber !== undefined &&
          np.accountNumber !== null &&
          /^\d+$/.test(String(np.accountNumber).trim()) &&
          np.sequence !== undefined &&
          np.sequence !== null &&
          /^\d+$/.test(String(np.sequence).trim());
        if (hasPayloadNums) {
          accountNumber = String(np.accountNumber).trim();
          sequence = String(np.sequence).trim();
        } else {
          const liveAcct = await fetchCosmosAccountFromLcds(lcdUrls, signerAddr, fetchFn);
          accountNumber = liveAcct.accountNumber;
          sequence = liveAcct.sequence;
        }
        cachedAccountNumber = accountNumber;
        cachedSequence = sequence;
      }

      let txRawBytes = null;

      // Path A: signDirect when Protobuf bodyBytes & authInfoBytes are supplied
      if (hasDirectBytes && typeof prov.signDirect === 'function') {
        const bodyBytes = toPsbtBytes(np.bodyBytes);
        const authInfoBytes = toPsbtBytes(np.authInfoBytes);
        if (!bodyBytes || !authInfoBytes) {
          throw new Error(`Cosmos step "${call.label}" provided invalid bodyBytes/authInfoBytes for signDirect.`);
        }
        const directRes = await prov.signDirect(chainId, signerAddr, {
          bodyBytes,
          authInfoBytes,
          chainId,
          accountNumber: BigInt(accountNumber),
        });
        const sigBytes = base64ToUint8(directRes?.signature?.signature || '');
        if (!sigBytes || !sigBytes.length) {
          throw new Error(`Cosmos wallet signDirect returned an empty signature for "${call.label}".`);
        }
        const signedBody = toPsbtBytes(directRes?.signed?.bodyBytes) || bodyBytes;
        const signedAuthInfo = toPsbtBytes(directRes?.signed?.authInfoBytes) || authInfoBytes;
        txRawBytes = encodeCosmosTxRaw({
          bodyBytes: signedBody,
          authInfoBytes: signedAuthInfo,
          signatureBytes: sigBytes,
        });
      } else if (typeof prov.signAmino === 'function') {
        // Path B: Proper Cosmos Amino-mapped message conversion + live accountNumber/sequence
        const aminoMsgs = msgs.map((m) => convertCosmosProtoMsgToAmino(m));
        const feeDenom = np.feeDenom || 'uatom';
        const gasLimit = 250_000 + aminoMsgs.length * 80_000;
        const gasPrice = Number(np.gasPrice);
        const feeAmount =
          Number.isFinite(gasPrice) && gasPrice > 0
            ? String(Math.max(1, Math.ceil(gasLimit * gasPrice)))
            : feeDenom === 'inj'
            ? String(Math.ceil(gasLimit * 500_000_000))
            : '5000';
        const signDoc = {
          chain_id: chainId,
          account_number: accountNumber,
          sequence,
          fee: {
            amount: [{ denom: feeDenom, amount: feeAmount }],
            gas: String(gasLimit),
          },
          msgs: aminoMsgs,
          memo: call.provider === 'noble_cctp' ? 'Turgalium Noble CCTP → Solana' : 'Turgalium Skip Go → Solana',
        };
        const signed = await prov.signAmino(chainId, signerAddr, signDoc);
        if (!signed?.signature?.signature) {
          throw new Error(`Cosmos wallet signAmino returned an empty signature for "${call.label}".`);
        }
        txRawBytes = encodeCosmosAminoSignedTxRaw({
          msgs,
          signedSignDoc: signed.signed || signDoc,
          signatureObj: signed.signature,
        });
      } else {
        throw new Error(
          `${session.walletName} does not expose Cosmos transaction signing (signAmino / signDirect).`
        );
      }

      // Broadcast signed TxRaw on-chain via prov.sendTx OR chain LCD POST /cosmos/tx/v1beta1/txs
      const txHash = await broadcastCosmosTxRaw({
        prov,
        chainId,
        txRawBytes,
        lcdUrls,
        fetchFn,
      });
      txHashes.push(txHash);

      // Increment local sequence for subsequent calls in the same batch
      cachedSequence = String(BigInt(sequence) + 1n);
    }
    return { txHashes, mode: 'cosmos_skip_tx' };
  }

  throw new Error(`Unsupported direct execution family: ${family}`);
}
