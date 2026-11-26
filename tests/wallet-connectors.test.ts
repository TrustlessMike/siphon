import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

interface WalletSession {
  family: string;
  address: string;
  addressesByChain?: Record<string, string> | null;
  walletName: string;
  walletId: string;
  provider: unknown;
  kind?: string;
  enabledChains?: string[];
  failedChains?: string[];
  suggestedChains?: string[];
}

interface WalletsModule {
  COSMOS_CONNECT_CHAINS: Array<{
    key: string;
    chainId: string;
    chainName: string;
    cosmostationNames: string[];
    suggestInfo: Record<string, unknown>;
  }>;
  FAMILY_WALLET_CATALOG: Record<string, { name: string; installUrl: string }>;
  isBitcoinMainnetAddress: (addr: string) => boolean;
  listAvailableSolanaWallets: () => Array<{ id: string; name: string; kind: string }>;
  listAvailableFamilyWallets: (family: string) => Array<{ id: string; name: string; kind?: string; standard?: string }>;
  connectEvmWallet: (opts?: Record<string, unknown>) => Promise<{ address: string; walletName: string }>;
  disconnectEvmWallet: () => void;
  getConnectedEvmAddress: () => string | null;
  connectSolanaWallet: (opts?: Record<string, unknown>) => Promise<{ address: string; walletName: string }>;
  disconnectSolanaWallet: () => void;
  getConnectedSolanaAddress: () => string | null;
  getConnectedSolanaWalletName: () => string | null;
  signAndSendSolanaVersionedTx: (
    base64Tx: string,
    opts?: Record<string, unknown>
  ) => Promise<{ signature: string; walletName: string; mode: string; explorerUrl: string }>;
  sendEvmRevokeCalls: (params: Record<string, unknown>) => Promise<{
    mode: string;
    batchId: string | null;
    txHashes: string[];
    revokedCount: number;
    revokedIndices?: number[];
  }>;
  isUserRejectedError: (err: unknown) => boolean;
  normalizePaymasterUrl: (raw: unknown) => string | null;
  connectFamilyWallet: (family: string, opts?: Record<string, unknown>) => Promise<WalletSession>;
  disconnectFamilyWallet: (family: string) => void;
  getConnectedFamilyWallet: (family: string) => WalletSession | null;
  executeNonEvmDirectBatch: (
    family: string,
    batch: Record<string, unknown>,
    opts?: Record<string, unknown>
  ) => Promise<{ txHashes: string[]; mode: string }>;
  COSMOS_PROTO_TO_AMINO_TYPE: Record<string, string>;
  convertCosmosProtoMsgToAmino: (msg: Record<string, unknown>) => { type: string; value: Record<string, unknown> };
  extractCosmosAccountFromLcdResponse: (json: unknown) => { accountNumber: string; sequence: string } | null;
  parsePsbtInputCount: (psbtInput: string | Uint8Array) => number | null;
  extractFinalizedTxFromPsbt: (psbtInput: string | Uint8Array) => string | null;
  refreshInstalledWallets: () => void;
}

class MockWindow extends EventTarget {
  location = { origin: 'http://127.0.0.1:3456' };
  localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  [key: string]: unknown;
}

const mockWindow = new MockWindow();
(globalThis as unknown as { window: MockWindow }).window = mockWindow;

const walletsModuleUrl = pathToFileURL(path.resolve('public/wallets.js')).href;
const wallets = (await import(walletsModuleUrl)) as WalletsModule;

const SOL_ADDR_A = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SOL_ADDR_B = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const SOL_ADDR_MANUAL = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

const TRON_MAINNET_A = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';
const TRON_MAINNET_B = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const BTC_MAINNET_A = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const BTC_MAINNET_B = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97';
const BTC_TESTNET = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

const SUI_ADDR_A = '0x0000000000000000000000000000000000000000000000000000000000000006';
const SUI_ADDR_B = '0x0000000000000000000000000000000000000000000000000000000000000007';

const APTOS_ADDR_A = '0x0000000000000000000000000000000000000000000000000000000000000001';
const APTOS_ADDR_B = '0x0000000000000000000000000000000000000000000000000000000000000002';

const TON_ADDR_A = '0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8';
const TON_ADDR_B = 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N';

function resetMockWalletGlobals() {
  for (const fam of ['cosmos', 'sui', 'aptos', 'ton', 'tron', 'btc']) {
    wallets.disconnectFamilyWallet(fam);
  }
  wallets.disconnectSolanaWallet();
  const keysToClear = [
    'keplr',
    'leap',
    'cosmostation',
    'okxwallet',
    'ctrl',
    'xfi',
    'frontier',
    'phantom',
    'backpack',
    'solflare',
    'coinbaseSolana',
    'glow',
    'solana',
    'suiWallet',
    'aptos',
    'tonkeeper',
    'ton',
    'openmask',
    'tronLink',
    'tronWeb',
    'unisat',
    'XverseProviders',
    'BitcoinProvider',
  ];
  for (const key of keysToClear) {
    delete mockWindow[key];
  }
}

function registerStandardWalletMock(walletObj: Record<string, unknown>) {
  mockWindow.dispatchEvent(
    new CustomEvent('wallet-standard:register-wallet', {
      detail: (api: { register: (...w: unknown[]) => void }) => api.register(walletObj),
    })
  );
}

// =========================================================================
// 1. COSMOS WALLET CONNECTOR BACKTESTS
// =========================================================================

test('Cosmos: cosmostation.cosmos resolves chain-registry names instead of failing on chainId mismatch', async () => {
  resetMockWalletGlobals();
  const registryAddresses: Record<string, string> = {
    cosmos: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
    osmosis: 'osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
    noble: 'noble1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
    celestia: 'celestia1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
    injective: 'inj1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
    neutron: 'neutron1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
  };
  const requestedChainNames: string[] = [];

  mockWindow.cosmostation = {
    cosmos: {
      request: async ({ method, params }: { method: string; params?: { chainName?: string } }) => {
        if (method === 'cos_supportedChainNames') {
          return { official: Object.keys(registryAddresses), unofficial: [] };
        }
        if (method === 'cos_account') {
          const name = String(params?.chainName || '');
          requestedChainNames.push(name);
          if (name.includes('-')) {
            throw new Error(`Unsupported chainName: ${name}`);
          }
          if (registryAddresses[name]) {
            return { address: registryAddresses[name] };
          }
          throw new Error(`Unknown chainName: ${name}`);
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    },
  };

  const session = await wallets.connectFamilyWallet('cosmos', { walletId: 'cosmostation' });
  assert.equal(session.walletId, 'cosmostation');
  assert.equal(session.address, registryAddresses.cosmos);
  assert.equal(Object.keys(session.addressesByChain || {}).length, 6);
  assert.equal(session.addressesByChain?.cosmoshub, registryAddresses.cosmos);
  assert.equal(session.addressesByChain?.osmosis, registryAddresses.osmosis);
  assert.equal(session.addressesByChain?.noble, registryAddresses.noble);
  assert.equal(session.addressesByChain?.celestia, registryAddresses.celestia);
  assert.equal(session.addressesByChain?.injective, registryAddresses.injective);
  assert.equal(session.addressesByChain?.neutron, registryAddresses.neutron);
  assert.ok(
    requestedChainNames.every((n) => !n.includes('-')),
    `Expected registry names without chainId suffixes, got ${JSON.stringify(requestedChainNames)}`
  );

  // Also test fallback when a Cosmostation provider expects 'cosmoshub' (not 'cosmos') without cos_supportedChainNames
  resetMockWalletGlobals();
  mockWindow.cosmostation = {
    cosmos: {
      request: async ({ method, params }: { method: string; params?: { chainName?: string } }) => {
        if (method === 'cos_supportedChainNames') throw new Error('unsupported');
        if (method === 'cos_account') {
          const name = String(params?.chainName || '');
          if (name === 'cosmoshub') return { address: 'cosmos1cosmoshubregistryaddr000000000000000' };
          if (name === 'osmosis') return { address: 'osmo1osmosisregistryaddr00000000000000000' };
          throw new Error(`Unknown chain ${name}`);
        }
        throw new Error('unsupported');
      },
    },
  };

  const fallbackSession = await wallets.connectFamilyWallet('cosmos', { walletId: 'cosmostation' });
  assert.equal(fallbackSession.address, 'cosmos1cosmoshubregistryaddr000000000000000');
  assert.equal(fallbackSession.addressesByChain?.cosmoshub, 'cosmos1cosmoshubregistryaddr000000000000000');
  assert.equal(fallbackSession.addressesByChain?.osmosis, 'osmo1osmosisregistryaddr00000000000000000');
});

test('Cosmos: keplr_keystorechange and leap_keystorechange refresh all 6 chain addresses and clean up on disconnect', async () => {
  resetMockWalletGlobals();
  let activeAccount: Record<string, string> = {
    'cosmoshub-4': 'cosmos1accounta000000000000000000000000000',
    'osmosis-1': 'osmo1accounta0000000000000000000000000000',
    'noble-1': 'noble1accounta000000000000000000000000000',
    celestia: 'celestia1accounta000000000000000000000000',
    'injective-1': 'inj1accounta00000000000000000000000000000',
    'neutron-1': 'neutron1accounta0000000000000000000000000',
  };
  const accountB: Record<string, string> = {
    'cosmoshub-4': 'cosmos1accountb000000000000000000000000000',
    'osmosis-1': 'osmo1accountb0000000000000000000000000000',
    'noble-1': 'noble1accountb000000000000000000000000000',
    celestia: 'celestia1accountb000000000000000000000000',
    'injective-1': 'inj1accountb00000000000000000000000000000',
    'neutron-1': 'neutron1accountb0000000000000000000000000',
  };

  mockWindow.keplr = {
    enable: async () => true,
    getKey: async (chainId: string) => ({ bech32Address: activeAccount[chainId] }),
  };

  const events: Array<{ address?: string; addressesByChain?: Record<string, string> } | null> = [];
  const session = await wallets.connectFamilyWallet('cosmos', {
    walletId: 'keplr',
    onAccountChanged: (next: { address?: string; addressesByChain?: Record<string, string> } | null) => {
      events.push(next);
    },
  });
  assert.equal(session.address, activeAccount['cosmoshub-4']);
  assert.equal(Object.keys(session.addressesByChain || {}).length, 6);

  // Switch Keplr account and dispatch keplr_keystorechange
  activeAccount = accountB;
  mockWindow.dispatchEvent(new Event('keplr_keystorechange'));
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(events.length, 1);
  assert.equal(events[0]?.address, accountB['cosmoshub-4']);
  assert.equal(Object.keys(events[0]?.addressesByChain || {}).length, 6);
  assert.equal(events[0]?.addressesByChain?.neutron, accountB['neutron-1']);
  assert.equal(wallets.getConnectedFamilyWallet('cosmos')?.address, accountB['cosmoshub-4']);
  assert.equal(wallets.getConnectedFamilyWallet('cosmos')?.addressesByChain?.injective, accountB['injective-1']);

  // Disconnect Keplr and verify listener is removed (no further events)
  wallets.disconnectFamilyWallet('cosmos');
  mockWindow.dispatchEvent(new Event('keplr_keystorechange'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.length, 1);

  // Leap keystorechange test
  resetMockWalletGlobals();
  let leapAddrSuffix = '111111111111111111111111111111';
  mockWindow.leap = {
    enable: async () => true,
    getKey: async (chainId: string) => {
      const prefix = chainId.split('-')[0].replace('cosmoshub', 'cosmos').replace('osmosis', 'osmo').replace('injective', 'inj');
      return { bech32Address: `${prefix}1${leapAddrSuffix}` };
    },
  };
  const leapEvents: Array<{ address?: string; addressesByChain?: Record<string, string> } | null> = [];
  await wallets.connectFamilyWallet('cosmos', {
    walletId: 'leap',
    onAccountChanged: (next: { address?: string; addressesByChain?: Record<string, string> } | null) => {
      leapEvents.push(next);
    },
  });
  leapAddrSuffix = '222222222222222222222222222222';
  mockWindow.dispatchEvent(new Event('leap_keystorechange'));
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(leapEvents.length, 1);
  assert.equal(leapEvents[0]?.address, 'cosmos1222222222222222222222222222222');
  assert.equal(Object.keys(leapEvents[0]?.addressesByChain || {}).length, 6);
});

test('Cosmos: 6-chain enable falls back to experimentalSuggestChain and partial chain enablement, with actionable errors', async () => {
  // Scenario A: neutron-1 is not suggested yet -> experimentalSuggestChain recovers all 6 chains
  resetMockWalletGlobals();
  const suggested = new Set<string>();
  mockWindow.keplr = {
    enable: async (arg: string | string[]) => {
      const ids = Array.isArray(arg) ? arg : [arg];
      if (ids.includes('neutron-1') && !suggested.has('neutron-1')) {
        throw new Error('There is no chain info for neutron-1');
      }
      return true;
    },
    experimentalSuggestChain: async (info: { chainId: string }) => {
      suggested.add(info.chainId);
    },
    getKey: async (chainId: string) => ({ bech32Address: `${chainId.split('-')[0]}1suggestedok000000000000000000` }),
  };

  const recovered = await wallets.connectFamilyWallet('cosmos', { walletId: 'keplr' });
  assert.equal(suggested.has('neutron-1'), true);
  assert.deepEqual(recovered.suggestedChains, ['neutron-1']);
  assert.deepEqual(recovered.failedChains, []);
  assert.equal(Object.keys(recovered.addressesByChain || {}).length, 6);

  // Scenario B: injective-1 fails both enable and experimentalSuggestChain -> partial 5-chain connect succeeds
  resetMockWalletGlobals();
  mockWindow.keplr = {
    enable: async (arg: string | string[]) => {
      const ids = Array.isArray(arg) ? arg : [arg];
      if (ids.includes('injective-1')) throw new Error('Chain injective-1 unsupported');
      return true;
    },
    experimentalSuggestChain: async (info: { chainId: string }) => {
      if (info.chainId === 'injective-1') throw new Error('Suggest rejected');
    },
    getKey: async (chainId: string) => ({ bech32Address: `${chainId.split('-')[0]}1partialok00000000000000000000` }),
  };

  const partial = await wallets.connectFamilyWallet('cosmos', { walletId: 'keplr' });
  assert.deepEqual(partial.failedChains, ['injective-1']);
  assert.equal(partial.enabledChains?.length, 5);
  assert.equal(Object.keys(partial.addressesByChain || {}).length, 5);
  assert.equal(partial.addressesByChain?.injective, undefined);

  // Scenario C: User explicitly rejects batch enable -> immediate error with 127.0.0.1 guidance, no 6-popup loop
  resetMockWalletGlobals();
  let enableCalls = 0;
  mockWindow.keplr = {
    enable: async () => {
      enableCalls += 1;
      const err = new Error('Request rejected') as Error & { code?: number };
      err.code = 4001;
      throw err;
    },
    getKey: async () => ({ bech32Address: 'cosmos1never' }),
  };
  await assert.rejects(
    () => wallets.connectFamilyWallet('cosmos', { walletId: 'keplr' }),
    (err: Error) => {
      assert.match(err.message, /127\.0\.0\.1/);
      assert.match(err.message, /rejected/i);
      return true;
    }
  );
  assert.equal(enableCalls, 1, 'User rejection must NOT trigger 6 sequential per-chain popups');
});

test('Cosmos: clicking an uninstalled wallet row NEVER falls back to wallets[0] and surfaces installUrl', async () => {
  resetMockWalletGlobals();
  let keplrEnableCalls = 0;
  mockWindow.keplr = {
    enable: async () => {
      keplrEnableCalls += 1;
      return true;
    },
    getKey: async () => ({ bech32Address: 'cosmos1keplrshouldnotbeused000000000000' }),
  };

  // Leap is NOT installed; Keplr IS installed -> requesting leap must reject with WALLET_NOT_INSTALLED
  await assert.rejects(
    () => wallets.connectFamilyWallet('cosmos', { walletId: 'leap' }),
    (err: Error & { code?: string; installUrl?: string; walletName?: string }) => {
      assert.equal(err.code, 'WALLET_NOT_INSTALLED');
      assert.equal(err.walletName, 'Leap Wallet');
      assert.equal(err.installUrl, 'https://www.leapwallet.io');
      assert.match(err.message, /127\.0\.0\.1/);
      return true;
    }
  );
  assert.equal(keplrEnableCalls, 0, 'Must never fall back to wallets[0] (Keplr) when Leap is not installed');
  assert.equal(wallets.getConnectedFamilyWallet('cosmos'), null);
});

// =========================================================================
// 2. SOLANA WALLET CONNECTION & LISTENER HYGIENE BACKTESTS
// =========================================================================

test('Solana: standard:events wires cleanly, legacy listener switches never leak, and manual destination is preserved', async () => {
  resetMockWalletGlobals();

  // Register a Wallet Standard Solana wallet
  const stdHolder: { cb: ((props?: Record<string, unknown>) => void) | null } = { cb: null };
  let stdUnsubscribed = false;
  registerStandardWalletMock({
    name: 'TestStdSolWallet',
    chains: ['solana:mainnet'],
    accounts: [{ address: SOL_ADDR_A, chains: ['solana:mainnet'] }],
    features: {
      'standard:connect': {
        connect: async () => ({ accounts: [{ address: SOL_ADDR_A, chains: ['solana:mainnet'] }] }),
      },
      'standard:events': {
        on: (event: string, cb: (props?: Record<string, unknown>) => void) => {
          if (event === 'change') stdHolder.cb = cb;
          return () => {
            stdUnsubscribed = true;
          };
        },
      },
    },
  });

  const stdEvents: Array<{ next: string | null; prev: string | null | undefined }> = [];
  const res = await wallets.connectSolanaWallet({
    walletId: 'std:teststdsolwallet',
    onAccountChanged: (next: string | null, meta?: { previousAddress?: string | null }) => {
      stdEvents.push({ next, prev: meta?.previousAddress });
    },
  });
  assert.equal(res.address, SOL_ADDR_A);
  assert.ok(stdHolder.cb, 'standard:events change listener should be wired');

  // Malformed/non-account change event must not throw
  stdHolder.cb(undefined);
  stdHolder.cb({ features: {} });
  assert.equal(stdEvents.length, 0);

  // Account switch via Wallet Standard standard:events
  stdHolder.cb({ accounts: [{ address: SOL_ADDR_B, chains: ['solana:mainnet'] }] });
  assert.equal(wallets.getConnectedSolanaAddress(), SOL_ADDR_B);
  assert.deepEqual(stdEvents[0], { next: SOL_ADDR_B, prev: SOL_ADDR_A });

  // Simulate manual edit guard contract: user edits #solanaDestInput to SOL_ADDR_MANUAL
  let simulatedDestInput = SOL_ADDR_MANUAL;
  const applyAppGuard = (nextAddr: string | null, prevAddr: string | null | undefined) => {
    const followsWallet = !simulatedDestInput || (Boolean(prevAddr) && simulatedDestInput === prevAddr);
    if (followsWallet) {
      simulatedDestInput = nextAddr || '';
    }
  };
  stdHolder.cb({ accounts: [{ address: SOL_ADDR_A, chains: ['solana:mainnet'] }] });
  applyAppGuard(stdEvents[1].next, stdEvents[1].prev);
  assert.equal(simulatedDestInput, SOL_ADDR_MANUAL, 'Manual destination input must NOT be clobbered by accountChanged');

  // Verify public/app.js implements the exact same followsConnectedWallet guard
  const appJsSource = fs.readFileSync(path.resolve('public/app.js'), 'utf8');
  assert.match(appJsSource, /followsConnectedWallet\s*=\s*!currentVal\s*\|\|\s*\(prevAddr\s*&&\s*currentVal\s*===\s*prevAddr\)/);

  // Now switch from Wallet Standard -> Legacy Phantom (with working removeListener) -> Legacy Solflare (with NO-OP removeListener)
  const phantomListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const phantomRemoved: string[] = [];
  mockWindow.phantom = {
    solana: {
      connect: async () => ({ publicKey: { toBase58: () => SOL_ADDR_A } }),
      on: (ev: string, fn: (...args: unknown[]) => void) => {
        phantomListeners[ev] = phantomListeners[ev] || [];
        phantomListeners[ev].push(fn);
      },
      removeListener: (ev: string, fn: (...args: unknown[]) => void) => {
        phantomRemoved.push(ev);
        phantomListeners[ev] = (phantomListeners[ev] || []).filter((f) => f !== fn);
      },
    },
  };

  const solflareListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  mockWindow.solflare = {
    connect: async () => ({ publicKey: { toString: () => SOL_ADDR_B } }),
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      solflareListeners[ev] = solflareListeners[ev] || [];
      solflareListeners[ev].push(fn);
    },
    // Intentionally broken/no-op removeListener (simulates real extension bug)
    removeListener: () => {},
  };

  const phantomEvents: Array<string | null> = [];
  await wallets.connectSolanaWallet({
    walletId: 'legacy-phantom',
    onAccountChanged: (next: string | null) => phantomEvents.push(next),
  });
  assert.equal(stdUnsubscribed, true, 'Switching away from standard wallet must invoke unsubscribe');

  // Switch to Solflare -> Phantom listeners must be removed
  const solflareEvents: Array<string | null> = [];
  await wallets.connectSolanaWallet({
    walletId: 'legacy-solflare',
    onAccountChanged: (next: string | null) => solflareEvents.push(next),
  });
  assert.ok(phantomRemoved.includes('accountChanged'));
  assert.ok(phantomRemoved.includes('disconnect'));

  // Switch back to Standard wallet -> even though Solflare's removeListener is a no-op,
  // firing stale Solflare listeners must be completely ignored!
  const finalEvents: Array<string | null> = [];
  await wallets.connectSolanaWallet({
    walletId: 'std:teststdsolwallet',
    onAccountChanged: (next: string | null) => finalEvents.push(next),
  });
  for (const fn of solflareListeners.accountChanged || []) fn(SOL_ADDR_MANUAL);
  for (const fn of solflareListeners.disconnect || []) fn();

  assert.equal(solflareEvents.length, 0, 'Stale Solflare listeners must never fire after wallet switch');
  assert.equal(finalEvents.length, 0, 'Stale Solflare events must never affect newly connected wallet');
  assert.equal(wallets.getConnectedSolanaAddress(), SOL_ADDR_A);
});

// =========================================================================
// 3. TON, TRON, SUI, APTOS & BITCOIN BACKTESTS
// =========================================================================

test('TON: TonConnect 2 JS Bridge uses connect(2, ...) instead of send("ton_requestAccounts"), rejects testnet, and handles errors cleanly', async () => {
  resetMockWalletGlobals();
  const tonState: {
    sendCalledWith: unknown;
    connectArgs: unknown[] | null;
    listenCb: ((ev: { event: string }) => void) | null;
    listenUnsubbed: boolean;
  } = {
    sendCalledWith: null,
    connectArgs: null,
    listenCb: null,
    listenUnsubbed: false,
  };

  mockWindow.tonkeeper = {
    tonconnect: {
      protocolVersion: 2,
      connect: async (version: number, req: Record<string, unknown>) => {
        tonState.connectArgs = [version, req];
        return {
          event: 'connect',
          payload: {
            items: [{ name: 'ton_addr', address: TON_ADDR_A, network: '-239' }],
          },
        };
      },
      send: async (req: unknown) => {
        tonState.sendCalledWith = req;
        return { result: 'ton_boc_hash_123' };
      },
      listen: (cb: (ev: { event: string }) => void) => {
        tonState.listenCb = cb;
        return () => {
          tonState.listenUnsubbed = true;
        };
      },
    },
  };

  const tonEvents: Array<unknown> = [];
  const session = await wallets.connectFamilyWallet('ton', {
    walletId: 'tonkeeper',
    onAccountChanged: (next: unknown) => tonEvents.push(next),
  });
  assert.equal(session.address, TON_ADDR_A);
  assert.equal(session.kind, 'tonconnect2');
  assert.equal(tonState.sendCalledWith, null, 'Must NOT call tonconnect.send("ton_requestAccounts") during connect');
  assert.equal(tonState.connectArgs?.[0], 2);

  // Verify TonConnect 2 direct batch uses structured AppRequest object
  const batchRes = await wallets.executeNonEvmDirectBatch('ton', {
    calls: [{ label: 'TON swap', nativePayload: { messages: [{ address: TON_ADDR_B, amount: '1000000000' }] } }],
  });
  assert.equal(batchRes.txHashes[0], 'ton_boc_hash_123');
  assert.equal((tonState.sendCalledWith as { method?: string } | null)?.method, 'sendTransaction');

  // Disconnect event via listen()
  assert.ok(tonState.listenCb);
  tonState.listenCb({ event: 'disconnect' });
  assert.equal(wallets.getConnectedFamilyWallet('ton'), null);
  assert.equal(tonState.listenUnsubbed, true);
  assert.equal(tonEvents[0], null);

  // TonConnect 2 connect_error (code 300 user declined) -> clean error
  (mockWindow.tonkeeper as { tonconnect: { connect: unknown } }).tonconnect.connect = async () => ({
    event: 'connect_error',
    payload: { code: 300, message: 'User declined the connection' },
  });
  await assert.rejects(() => wallets.connectFamilyWallet('ton', { walletId: 'tonkeeper' }), /rejected by the user/i);

  // TonConnect 2 testnet (-3) -> rejected fail-closed
  (mockWindow.tonkeeper as { tonconnect: { connect: unknown } }).tonconnect.connect = async () => ({
    event: 'connect',
    payload: { items: [{ name: 'ton_addr', address: TON_ADDR_A, network: '-3' }] },
  });
  await assert.rejects(() => wallets.connectFamilyWallet('ton', { walletId: 'tonkeeper' }), /TON Testnet/i);

  // OpenMask legacy provider (ton_requestAccounts + testnet guard)
  resetMockWalletGlobals();
  mockWindow.openmask = {
    isOpenMask: true,
    send: async (method: string) => {
      if (method === 'ton_requestAccounts') return [TON_ADDR_B];
      if (method === 'ton_getChain') return '-3';
      return null;
    },
  };
  await assert.rejects(() => wallets.connectFamilyWallet('ton', { walletId: 'openmask' }), /TON Testnet/i);
});

test('Tron: handles locked "" / false address, waits for async tronWeb.ready race, and rejects Shasta/Nile testnets', async () => {
  // 1. Locked TronLink returns "" and base58 is false/""
  resetMockWalletGlobals();
  mockWindow.tronLink = {
    request: async () => '',
    tronWeb: { ready: false, defaultAddress: { base58: false } },
  };
  mockWindow.tronWeb = { ready: false, defaultAddress: { base58: '' } };

  await assert.rejects(
    () => wallets.connectFamilyWallet('tron', { walletId: 'tronlink', tronReadyTimeoutMs: 30, tronPollIntervalMs: 10 }),
    /locked/i
  );

  // 2. Async tronWeb.ready race: becomes ready 35ms after tron_requestAccounts resolves { code: 200 }
  resetMockWalletGlobals();
  const tronWebObj: Record<string, unknown> = {
    ready: false,
    defaultAddress: { base58: '' },
    fullNode: { host: 'https://api.trongrid.io' },
  };
  mockWindow.tronLink = {
    request: async () => {
      setTimeout(() => {
        tronWebObj.ready = true;
        tronWebObj.defaultAddress = { base58: TRON_MAINNET_A };
      }, 35);
      return { code: 200, message: 'ok' };
    },
    tronWeb: tronWebObj,
  };
  mockWindow.tronWeb = tronWebObj;

  const tronEvents: Array<{ next: unknown; reason?: string }> = [];
  const session = await wallets.connectFamilyWallet('tron', {
    walletId: 'tronlink',
    tronReadyTimeoutMs: 500,
    tronPollIntervalMs: 10,
    onAccountChanged: (next: unknown, meta?: { reason?: string }) => {
      tronEvents.push({ next, reason: meta?.reason });
    },
  });
  assert.equal(session.address, TRON_MAINNET_A);

  // Cross-origin or foreign-source postMessage MUST be ignored (M-5)
  mockWindow.dispatchEvent(
    Object.assign(new Event('message'), {
      source: {},
      origin: 'https://evil.example',
      data: { message: { action: 'accountsChanged', data: { address: TRON_MAINNET_B } } },
    })
  );
  mockWindow.dispatchEvent(
    Object.assign(new Event('message'), {
      source: mockWindow,
      origin: 'https://evil.example',
      data: { message: { action: 'disconnect' } },
    })
  );
  assert.equal(
    wallets.getConnectedFamilyWallet('tron')?.address,
    TRON_MAINNET_A,
    'Cross-origin / foreign-source Tron postMessage must be ignored'
  );

  // Same-origin window post-connect accountsChanged message updates address
  mockWindow.dispatchEvent(
    Object.assign(new Event('message'), {
      source: mockWindow,
      origin: mockWindow.location.origin,
      data: { message: { action: 'accountsChanged', data: { address: TRON_MAINNET_B } } },
    })
  );
  assert.equal(wallets.getConnectedFamilyWallet('tron')?.address, TRON_MAINNET_B);

  // Same-origin window post-connect setNode switching to Nile testnet disconnects fail-closed
  mockWindow.dispatchEvent(
    Object.assign(new Event('message'), {
      source: mockWindow,
      origin: mockWindow.location.origin,
      data: { message: { action: 'setNode', data: { node: { fullNode: 'https://nile.trongrid.io' } } } },
    })
  );
  assert.equal(wallets.getConnectedFamilyWallet('tron'), null);
  assert.equal(tronEvents[tronEvents.length - 1]?.reason, 'testnet_rejected');

  // 3. Reject Shasta testnet on connect
  resetMockWalletGlobals();
  mockWindow.tronLink = {
    request: async () => ({ code: 200 }),
    tronWeb: {
      ready: true,
      defaultAddress: { base58: TRON_MAINNET_A },
      fullNode: { host: 'https://api.shasta.trongrid.io' },
    },
  };
  await assert.rejects(() => wallets.connectFamilyWallet('tron', { walletId: 'tronlink' }), /Shasta\/Nile/i);
});

test('Sui: enforces sui:mainnet chain guard and wires standard:events account & chain changes', async () => {
  resetMockWalletGlobals();

  // Register a testnet-only Sui wallet -> must be rejected fail-closed
  registerStandardWalletMock({
    name: 'TestSuiTestnetWallet',
    chains: ['sui:testnet'],
    accounts: [{ address: SUI_ADDR_A, chains: ['sui:testnet'] }],
    features: {
      'standard:connect': {
        connect: async () => ({ accounts: [{ address: SUI_ADDR_A, chains: ['sui:testnet'] }] }),
      },
    },
  });
  await assert.rejects(
    () => wallets.connectFamilyWallet('sui', { walletId: 'sui-std:testsuitestnetwallet' }),
    /sui:mainnet/i
  );

  // Register a Sui Mainnet Wallet Standard wallet with standard:events
  const suiHolder: { cb: ((props: Record<string, unknown>) => void) | null } = { cb: null };
  let suiUnsubbed = false;
  registerStandardWalletMock({
    name: 'TestSuiMainnetWallet',
    chains: ['sui:mainnet', 'sui:testnet'],
    accounts: [{ address: SUI_ADDR_A, chains: ['sui:mainnet'] }],
    features: {
      'standard:connect': {
        connect: async () => ({ accounts: [{ address: SUI_ADDR_A, chains: ['sui:mainnet'] }] }),
      },
      'standard:events': {
        on: (ev: string, cb: (props: Record<string, unknown>) => void) => {
          if (ev === 'change') suiHolder.cb = cb;
          return () => {
            suiUnsubbed = true;
          };
        },
      },
    },
  });

  const suiEvents: Array<{ next: unknown; reason?: string }> = [];
  const suiNetEvents: Array<{ isMainnet: boolean }> = [];
  const session = await wallets.connectFamilyWallet('sui', {
    walletId: 'sui-std:testsuimainnetwallet',
    onAccountChanged: (next: unknown, meta?: { reason?: string }) => {
      suiEvents.push({ next, reason: meta?.reason });
    },
    onNetworkChanged: (info: { isMainnet: boolean }) => {
      suiNetEvents.push(info);
    },
  });
  assert.equal(session.address, SUI_ADDR_A);
  assert.ok(suiHolder.cb);

  // Account switch on sui:mainnet
  suiHolder.cb({ accounts: [{ address: SUI_ADDR_B, chains: ['sui:mainnet'] }] });
  assert.equal(wallets.getConnectedFamilyWallet('sui')?.address, SUI_ADDR_B);
  assert.equal((suiEvents[0]?.next as { address?: string })?.address, SUI_ADDR_B);

  // Network switch to sui:testnet -> disconnects fail-closed and unsubscribes
  suiHolder.cb({ accounts: [{ address: SUI_ADDR_B, chains: ['sui:testnet'] }] });
  assert.equal(wallets.getConnectedFamilyWallet('sui'), null);
  assert.equal(suiUnsubbed, true);
  assert.equal(suiNetEvents[0]?.isMainnet, false);
  assert.equal(suiEvents[1]?.reason, 'testnet_rejected');
});

test('Aptos: enforces Aptos Mainnet and wires onAccountChange / onNetworkChange with cleanup', async () => {
  // 1. Testnet rejected fail-closed
  resetMockWalletGlobals();
  mockWindow.aptos = {
    connect: async () => ({ address: APTOS_ADDR_A }),
    network: async () => 'Testnet',
  };
  await assert.rejects(() => wallets.connectFamilyWallet('aptos', { walletId: 'petra' }), /Aptos Mainnet/i);

  // 2. Mainnet connects and wires onAccountChange + onNetworkChange
  resetMockWalletGlobals();
  const aptosHolder: {
    accCb: ((acc: { address: string } | null) => void) | null;
    netCb: ((net: unknown) => void) | null;
  } = { accCb: null, netCb: null };
  let accUnsub = false;
  let netUnsub = false;

  mockWindow.aptos = {
    connect: async () => ({ address: APTOS_ADDR_A }),
    network: async () => ({ name: 'Mainnet', chainId: '1' }),
    onAccountChange: (cb: (acc: { address: string } | null) => void) => {
      aptosHolder.accCb = cb;
      return () => {
        accUnsub = true;
      };
    },
    onNetworkChange: (cb: (net: unknown) => void) => {
      aptosHolder.netCb = cb;
      return () => {
        netUnsub = true;
      };
    },
  };

  const aptosEvents: Array<{ next: unknown; reason?: string }> = [];
  const aptosNets: Array<{ isMainnet: boolean }> = [];
  const session = await wallets.connectFamilyWallet('aptos', {
    walletId: 'petra',
    onAccountChanged: (next: unknown, meta?: { reason?: string }) => {
      aptosEvents.push({ next, reason: meta?.reason });
    },
    onNetworkChanged: (info: { isMainnet: boolean }) => aptosNets.push(info),
  });
  assert.equal(session.address, APTOS_ADDR_A);
  assert.ok(aptosHolder.accCb && aptosHolder.netCb);

  // Switch account
  aptosHolder.accCb({ address: APTOS_ADDR_B });
  assert.equal(wallets.getConnectedFamilyWallet('aptos')?.address, APTOS_ADDR_B);
  assert.equal((aptosEvents[0]?.next as { address?: string })?.address, APTOS_ADDR_B);

  // Switch network to Devnet -> disconnects fail-closed and cleans up listeners
  aptosHolder.netCb({ name: 'Devnet', chainId: '2' });
  assert.equal(wallets.getConnectedFamilyWallet('aptos'), null);
  assert.equal(aptosNets[0]?.isMainnet, false);
  assert.equal(aptosEvents[1]?.reason, 'testnet_rejected');
  assert.equal(accUnsub, true);
  assert.equal(netUnsub, true);
});

test('Bitcoin: wires UniSat accountsChanged / networkChanged and rejects testnet / signet fail-closed', async () => {
  // Address helper assertions
  assert.equal(wallets.isBitcoinMainnetAddress(BTC_MAINNET_A), true);
  assert.equal(wallets.isBitcoinMainnetAddress(BTC_TESTNET), false);
  assert.equal(wallets.isBitcoinMainnetAddress('2N3oefVeg6stiTb5Kh3ozCSkaqmx91FDbsm'), false);
  assert.equal(wallets.isBitcoinMainnetAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'), false);

  // 1. UniSat on testnet rejected fail-closed
  resetMockWalletGlobals();
  mockWindow.unisat = {
    requestAccounts: async () => [BTC_TESTNET],
    getNetwork: async () => 'testnet',
  };
  await assert.rejects(() => wallets.connectFamilyWallet('btc', { walletId: 'unisat' }), /Bitcoin Mainnet/i);

  // 2. UniSat on signet via getChain() rejected fail-closed even if getNetwork returns livenet
  resetMockWalletGlobals();
  mockWindow.unisat = {
    requestAccounts: async () => [BTC_MAINNET_A],
    getChain: async () => ({ enum: 'BITCOIN_SIGNET', network: 'testnet' }),
    getNetwork: async () => 'livenet',
  };
  await assert.rejects(() => wallets.connectFamilyWallet('btc', { walletId: 'unisat' }), /BITCOIN_SIGNET/i);

  // 3. UniSat on mainnet wires accountsChanged & networkChanged, rejects live switch to signet, cleans up
  resetMockWalletGlobals();
  const unisatListeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const removedEvents: string[] = [];
  mockWindow.unisat = {
    requestAccounts: async () => [BTC_MAINNET_A],
    getChain: async () => ({ enum: 'BITCOIN_MAINNET', network: 'livenet' }),
    getNetwork: async () => 'livenet',
    on: (ev: string, fn: (...args: unknown[]) => void) => {
      unisatListeners[ev] = unisatListeners[ev] || [];
      unisatListeners[ev].push(fn);
    },
    removeListener: (ev: string, fn: (...args: unknown[]) => void) => {
      removedEvents.push(ev);
      unisatListeners[ev] = (unisatListeners[ev] || []).filter((f) => f !== fn);
    },
  };

  const btcEvents: Array<{ next: unknown; reason?: string }> = [];
  const btcNets: Array<{ isMainnet: boolean }> = [];
  const session = await wallets.connectFamilyWallet('btc', {
    walletId: 'unisat',
    onAccountChanged: (next: unknown, meta?: { reason?: string }) => {
      btcEvents.push({ next, reason: meta?.reason });
    },
    onNetworkChanged: (info: { isMainnet: boolean }) => btcNets.push(info),
  });
  assert.equal(session.address, BTC_MAINNET_A);

  // Mainnet account change updates session
  for (const fn of unisatListeners.accountsChanged || []) fn([BTC_MAINNET_B]);
  assert.equal(wallets.getConnectedFamilyWallet('btc')?.address, BTC_MAINNET_B);
  assert.equal((btcEvents[0]?.next as { address?: string })?.address, BTC_MAINNET_B);

  // Network switch to signet -> disconnects fail-closed and removes all listeners
  for (const fn of unisatListeners.networkChanged || []) fn('signet');
  assert.equal(wallets.getConnectedFamilyWallet('btc'), null);
  assert.equal(btcNets[0]?.isMainnet, false);
  assert.equal(btcEvents[1]?.reason, 'testnet_rejected');
  assert.ok(removedEvents.includes('accountsChanged'));
  assert.ok(removedEvents.includes('networkChanged'));
  assert.ok(removedEvents.includes('chainChanged'));

  // 4. Xverse returning testnet payment address -> rejected fail-closed
  resetMockWalletGlobals();
  mockWindow.XverseProviders = {
    BitcoinProvider: {
      request: async () => ({ result: [{ purpose: 'payment', address: BTC_TESTNET }] }),
    },
  };
  await assert.rejects(() => wallets.connectFamilyWallet('btc', { walletId: 'xverse' }), /non-mainnet Bitcoin address/i);
});

// =========================================================================
// 4. WAVE 7A: REAL COSMOS SIGNING & BROADCAST BACKTESTS
// =========================================================================

test('Cosmos executeNonEvmDirectBatch: fetches live account_number/sequence, maps Amino types, broadcasts on-chain, and never fabricates hashes', async () => {
  resetMockWalletGlobals();
  const cosmosAddr = 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh';
  const nobleAddr = 'noble1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh';

  // Verify Amino message mapping for all 4 core Protobuf URLs
  assert.equal(
    wallets.convertCosmosProtoMsgToAmino({
      msg_type_url: '/ibc.applications.transfer.v1.MsgTransfer',
      msg: JSON.stringify({ sender: cosmosAddr, receiver: nobleAddr }),
    }).type,
    'cosmos-sdk/MsgTransfer'
  );
  assert.equal(
    wallets.convertCosmosProtoMsgToAmino({
      msg_type_url: '/cosmos.bank.v1beta1.MsgSend',
      msg: JSON.stringify({ from_address: cosmosAddr, to_address: nobleAddr, amount: [] }),
    }).type,
    'cosmos-sdk/MsgSend'
  );
  assert.equal(
    wallets.convertCosmosProtoMsgToAmino({
      msg_type_url: '/cosmwasm.wasm.v1.MsgExecuteContract',
      msg: JSON.stringify({ sender: cosmosAddr, contract: 'osmo1contract', msg: '{"swap":{}}' }),
    }).type,
    'wasm/MsgExecuteContract'
  );
  assert.equal(
    wallets.convertCosmosProtoMsgToAmino({
      msg_type_url: '/circle.cctp.v1.MsgDepositForBurn',
      msg: JSON.stringify({ from: nobleAddr, amount: '5000000', destination_domain: 5, burn_token: 'uusdc' }),
    }).type,
    'cctp/MsgDepositForBurn'
  );

  // Connect Keplr mock that records signAmino calls (NO sendTx -> forces LCD POST /cosmos/tx/v1beta1/txs)
  const capturedSignDocs: Array<Record<string, unknown>> = [];
  mockWindow.keplr = {
    enable: async () => true,
    getKey: async (chainId: string) => ({
      bech32Address: chainId === 'noble-1' ? nobleAddr : cosmosAddr,
    }),
    signAmino: async (_chainId: string, _signer: string, signDoc: Record<string, unknown>) => {
      capturedSignDocs.push(signDoc);
      return {
        signed: signDoc,
        signature: {
          pub_key: { type: 'tendermint/PubKeySecp256k1', value: Buffer.alloc(33, 2).toString('base64') },
          signature: Buffer.alloc(64, 7).toString('base64'),
        },
      };
    },
  };

  await wallets.connectFamilyWallet('cosmos', { walletId: 'keplr' });

  const realTxHash1 = 'A1B2C3D4E5F60718293A4B5C6D7E8F9011223344556677889900AABBCCDDEEFF';
  const realTxHash2 = 'F0E1D2C3B4A5968778695A4B3C2D1E0F00112233445566778899AABBCCDDEEFF';
  const lcdBroadcastPayloads: Array<Record<string, unknown>> = [];

  const mockFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/cosmos/auth/v1beta1/accounts/')) {
      // Return ContinuousVestingAccount wrapper to test nested unwrapping
      return new Response(
        JSON.stringify({
          account: {
            '@type': '/cosmos.vesting.v1beta1.ContinuousVestingAccount',
            base_vesting_account: {
              base_account: {
                account_number: '77441',
                sequence: '42',
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/cosmos/tx/v1beta1/txs') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
      lcdBroadcastPayloads.push(body);
      const txhash = lcdBroadcastPayloads.length === 1 ? realTxHash1 : realTxHash2;
      return new Response(
        JSON.stringify({ tx_response: { code: 0, txhash, raw_log: '' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  const result = await wallets.executeNonEvmDirectBatch(
    'cosmos',
    {
      chain: 'cosmoshub',
      chainId: 'cosmoshub-4',
      solanaDestination: SOL_ADDR_A,
      calls: [
        {
          label: 'IBC Transfer to Noble',
          provider: 'skip_go',
          nativePayload: {
            signerAddress: cosmosAddr,
            lcdUrls: ['https://mock-cosmos-lcd.example'],
            feeDenom: 'uatom',
            gasPrice: 0.025,
            cosmosTx: {
              chain_id: 'cosmoshub-4',
              msgs: [
                {
                  msg_type_url: '/ibc.applications.transfer.v1.MsgTransfer',
                  msg: JSON.stringify({
                    source_port: 'transfer',
                    source_channel: 'channel-536',
                    token: { denom: 'uatom', amount: '1000000' },
                    sender: cosmosAddr,
                    receiver: nobleAddr,
                  }),
                },
              ],
            },
          },
        },
        {
          label: 'Bank Send Fee',
          provider: 'skip_go',
          nativePayload: {
            signerAddress: cosmosAddr,
            lcdUrls: ['https://mock-cosmos-lcd.example'],
            feeDenom: 'uatom',
            gasPrice: 0.025,
            msgs: [
              {
                msg_type_url: '/cosmos.bank.v1beta1.MsgSend',
                msg: JSON.stringify({
                  from_address: cosmosAddr,
                  to_address: nobleAddr,
                  amount: [{ denom: 'uatom', amount: '10000' }],
                }),
              },
            ],
          },
        },
      ],
    },
    { expectedSolanaDestination: SOL_ADDR_A, fetchFn: mockFetch }
  );

  // Verify live account_number/sequence used and sequence incremented between steps
  assert.equal(capturedSignDocs.length, 2);
  assert.equal(capturedSignDocs[0].account_number, '77441');
  assert.equal(capturedSignDocs[0].sequence, '42');
  assert.equal(capturedSignDocs[1].account_number, '77441');
  assert.equal(capturedSignDocs[1].sequence, '43');
  assert.equal((capturedSignDocs[0].msgs as Array<{ type: string }>)[0].type, 'cosmos-sdk/MsgTransfer');
  assert.equal((capturedSignDocs[1].msgs as Array<{ type: string }>)[0].type, 'cosmos-sdk/MsgSend');

  // Verify real broadcast occurred via LCD POST /cosmos/tx/v1beta1/txs with BROADCAST_MODE_SYNC
  assert.equal(lcdBroadcastPayloads.length, 2);
  assert.equal(lcdBroadcastPayloads[0].mode, 'BROADCAST_MODE_SYNC');
  assert.ok(typeof lcdBroadcastPayloads[0].tx_bytes === 'string' && lcdBroadcastPayloads[0].tx_bytes.length > 20);
  assert.deepEqual(result.txHashes, [realTxHash1, realTxHash2]);
  assert.ok(!result.txHashes.some((h) => h.startsWith('cosmos_signed_')));

  // Adversarial A: LCD unreachable when account_number/sequence missing -> fails closed (never '0'/'0'!)
  await assert.rejects(
    () =>
      wallets.executeNonEvmDirectBatch(
        'cosmos',
        {
          chain: 'cosmoshub',
          chainId: 'cosmoshub-4',
          calls: [
            {
              label: 'Should Fail Closed',
              nativePayload: {
                signerAddress: cosmosAddr,
                lcdUrls: ['https://unreachable-lcd.example'],
                msgs: [{ msg_type_url: '/cosmos.bank.v1beta1.MsgSend', msg: '{}' }],
              },
            },
          ],
        },
        { fetchFn: async () => new Response('down', { status: 503 }) }
      ),
    /0\/0|Failed to fetch live Cosmos account_number\/sequence/i
  );

  // Adversarial B: Broadcast CheckTx returns non-zero code -> rejects honestly!
  await assert.rejects(
    () =>
      wallets.executeNonEvmDirectBatch(
        'cosmos',
        {
          chain: 'cosmoshub',
          chainId: 'cosmoshub-4',
          calls: [
            {
              label: 'Rejected CheckTx',
              nativePayload: {
                signerAddress: cosmosAddr,
                lcdUrls: ['https://mock-cosmos-lcd.example'],
                accountNumber: '77441',
                sequence: '44',
                msgs: [{ msg_type_url: '/cosmos.bank.v1beta1.MsgSend', msg: '{}' }],
              },
            },
          ],
        },
        {
          fetchFn: async () =>
            new Response(
              JSON.stringify({ tx_response: { code: 5, txhash: 'BADHASH', raw_log: 'insufficient funds' } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            ),
        }
      ),
    /code 5.*insufficient funds/i
  );

  // Path C: signDirect + prov.sendTx(chainId, txBytes, 'sync') returns real on-chain hex hash
  let sendTxCalled = false;
  let signDirectCalled = false;
  (mockWindow.keplr as Record<string, unknown>).signDirect = async (
    _chainId: string,
    _signer: string,
    doc: { bodyBytes: Uint8Array; authInfoBytes: Uint8Array; accountNumber: bigint }
  ) => {
    signDirectCalled = true;
    assert.equal(doc.accountNumber, 77441n);
    return {
      signed: doc,
      signature: { signature: Buffer.alloc(64, 9).toString('base64') },
    };
  };
  (mockWindow.keplr as Record<string, unknown>).sendTx = async (
    _chainId: string,
    txBytes: Uint8Array,
    mode: string
  ) => {
    sendTxCalled = true;
    assert.equal(mode, 'sync');
    assert.ok(txBytes instanceof Uint8Array && txBytes.length > 64);
    return Uint8Array.from(Buffer.from(realTxHash1, 'hex'));
  };

  const directRes = await wallets.executeNonEvmDirectBatch('cosmos', {
    chain: 'noble',
    chainId: 'noble-1',
    calls: [
      {
        label: 'Direct Protobuf Noble CCTP',
        nativePayload: {
          signerAddress: nobleAddr,
          accountNumber: '77441',
          sequence: '45',
          bodyBytes: Buffer.from([0x0a, 0x04, 0x01, 0x02, 0x03, 0x04]).toString('base64'),
          authInfoBytes: Buffer.from([0x12, 0x04, 0x05, 0x06, 0x07, 0x08]).toString('base64'),
        },
      },
    ],
  });
  assert.equal(signDirectCalled, true);
  assert.equal(sendTxCalled, true);
  assert.equal(directRes.txHashes[0], realTxHash1);
});

// =========================================================================
// 5. WAVE 7A: PHANTOM BITCOIN PSBT inputsToSign & BROADCAST BACKTESTS
// =========================================================================

function buildTestPsbt(inputCount: number, finalized: boolean): Uint8Array {
  const txParts: number[] = [0x02, 0x00, 0x00, 0x00, inputCount];
  for (let i = 0; i < inputCount; i += 1) {
    for (let b = 0; b < 32; b += 1) txParts.push((i + 10) & 0xff);
    txParts.push(i, 0, 0, 0); // vout
    txParts.push(0x00); // empty scriptSig
    txParts.push(0xfd, 0xff, 0xff, 0xff); // sequence
  }
  txParts.push(0x01); // 1 output
  txParts.push(0x10, 0x27, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00); // 10,000 sats
  txParts.push(0x16, 0x00, 0x14, ...new Array(20).fill(0xcd)); // P2WPKH output
  txParts.push(0x00, 0x00, 0x00, 0x00); // lockTime

  const txBytes = Buffer.from(txParts);
  const chunks: Buffer[] = [
    Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]), // magic
    Buffer.from([0x01, 0x00]), // PSBT_GLOBAL_UNSIGNED_TX
    txBytes.length < 0xfd
      ? Buffer.from([txBytes.length])
      : Buffer.from([0xfd, txBytes.length & 0xff, (txBytes.length >> 8) & 0xff]),
    txBytes,
    Buffer.from([0x00]), // end global map
  ];

  // Input maps
  for (let i = 0; i < inputCount; i += 1) {
    if (finalized) {
      // PSBT_IN_FINAL_SCRIPTWITNESS (keyType 0x08): 2 stack items (fake sig + 33-byte pubkey)
      const witnessStack = Buffer.concat([
        Buffer.from([0x02]), // 2 items
        Buffer.from([0x47]),
        Buffer.alloc(0x47, 0x30),
        Buffer.from([0x21]),
        Buffer.alloc(0x21, 0x02),
      ]);
      chunks.push(Buffer.from([0x01, 0x08]));
      chunks.push(Buffer.from([witnessStack.length]));
      chunks.push(witnessStack);
    }
    chunks.push(Buffer.from([0x00])); // end input map
  }
  chunks.push(Buffer.from([0x00])); // end output 0 map
  return Uint8Array.from(Buffer.concat(chunks));
}

test('Bitcoin Phantom executeNonEvmDirectBatch: passes non-empty inputsToSign, extracts finalized tx, broadcasts to mempool.space, and rejects unfinalized PSBT', async () => {
  resetMockWalletGlobals();
  const unsigned2In = buildTestPsbt(2, false);
  const finalized2In = buildTestPsbt(2, true);
  const unsigned2InHex = Buffer.from(unsigned2In).toString('hex');

  assert.equal(wallets.parsePsbtInputCount(unsigned2In), 2);
  assert.equal(wallets.extractFinalizedTxFromPsbt(unsigned2In), null);
  const extractedHex = wallets.extractFinalizedTxFromPsbt(finalized2In);
  assert.ok(extractedHex && extractedHex.startsWith('02000000000102'), 'Expected valid BIP-141 SegWit raw tx hex');

  // Connect Phantom BTC mock
  let capturedSignPsbtOpts: Record<string, unknown> | null = null;
  let phantomReturnPayload: unknown = finalized2In;
  mockWindow.phantom = {
    bitcoin: {
      requestAccounts: async () => [{ purpose: 'payment', address: BTC_MAINNET_A }],
      signPSBT: async (_psbtBytes: Uint8Array, opts: Record<string, unknown>) => {
        capturedSignPsbtOpts = opts;
        return phantomReturnPayload;
      },
    },
  };

  const session = await wallets.connectFamilyWallet('btc', { walletId: 'phantom-btc' });
  assert.equal(session.walletId, 'phantom-btc');
  assert.equal(session.address, BTC_MAINNET_A);

  const realBtcTxid = 'b'.repeat(64);
  let broadcastedBody = '';
  const mockMempoolFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    assert.equal(url, 'https://mempool.space/api/tx');
    assert.equal(init?.method, 'POST');
    broadcastedBody = String(init?.body || '');
    return new Response(realBtcTxid, { status: 200 });
  };

  // Even without nativePayload.inputsToSign, wallets.js parses the 2-input PSBT and passes signingIndexes: [0, 1]!
  const res = await wallets.executeNonEvmDirectBatch(
    'btc',
    {
      solanaDestination: SOL_ADDR_A,
      calls: [
        {
          label: 'Relay 2-input BTC PSBT',
          nativePayload: { psbtHex: unsigned2InHex },
        },
      ],
    },
    { expectedSolanaDestination: SOL_ADDR_A, fetchFn: mockMempoolFetch }
  );

  assert.deepEqual(capturedSignPsbtOpts, {
    inputsToSign: [{ address: BTC_MAINNET_A, signingIndexes: [0, 1] }],
  });
  assert.equal(broadcastedBody, extractedHex);
  assert.deepEqual(res.txHashes, [realBtcTxid]);

  // Adversarial: Phantom returns an UNFINALIZED PSBT -> fails honestly instead of pretending it broadcast!
  phantomReturnPayload = unsigned2In;
  await assert.rejects(
    () =>
      wallets.executeNonEvmDirectBatch(
        'btc',
        {
          solanaDestination: SOL_ADDR_A,
          calls: [{ label: 'Unfinalized Phantom PSBT', nativePayload: { psbtHex: unsigned2InHex } }],
        },
        { expectedSolanaDestination: SOL_ADDR_A, fetchFn: mockMempoolFetch }
      ),
    /unfinalized PSBT/i
  );

  // Verify Xverse receives signInputs alongside psbt & broadcast:true and enforces expectedSolanaDestination
  resetMockWalletGlobals();
  const xverseCapture: { params: Record<string, unknown> | null } = { params: null };
  mockWindow.XverseProviders = {
    BitcoinProvider: {
      request: async (method: string, params?: Record<string, unknown>) => {
        if (method === 'getAccounts') {
          return { result: [{ purpose: 'payment', address: BTC_MAINNET_A }] };
        }
        if (method === 'signPsbt') {
          xverseCapture.params = params || null;
          return { result: { txid: 'c'.repeat(64) } };
        }
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  await wallets.connectFamilyWallet('btc', { walletId: 'xverse' });
  const xverseRes = await wallets.executeNonEvmDirectBatch(
    'btc',
    {
      solanaDestination: SOL_ADDR_A,
      calls: [{ label: 'Xverse PSBT', nativePayload: { psbtHex: unsigned2InHex } }],
    },
    { expectedSolanaDestination: SOL_ADDR_A }
  );
  assert.deepEqual(xverseRes.txHashes, ['c'.repeat(64)]);
  assert.deepEqual(xverseCapture.params?.signInputs, { [BTC_MAINNET_A]: [0, 1] });
  assert.equal(xverseCapture.params?.broadcast, true);

  // Destination mismatch guard still rejects fail-closed
  await assert.rejects(
    () =>
      wallets.executeNonEvmDirectBatch(
        'btc',
        {
          solanaDestination: SOL_ADDR_B,
          calls: [{ label: 'Xverse PSBT', nativePayload: { psbtHex: unsigned2InHex } }],
        },
        { expectedSolanaDestination: SOL_ADDR_A }
      ),
    /Pre-sign check failed/i
  );
});

// =========================================================================
// 6. WAVE 8C: FRONTEND PRE-SIGN VERIFICATION & HARDENING BACKTESTS
// =========================================================================

const SPL_TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const JUPITER_V6_PROGRAM = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
const TEST_SOL_BLOCKHASH = '11111111111111111111111111111111';

function buildSignedReadyV0Base64(payerBase58: string, instructions: TransactionInstruction[]): string {
  const msg = new TransactionMessage({
    payerKey: new PublicKey(payerBase58),
    recentBlockhash: TEST_SOL_BLOCKHASH,
    instructions,
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

test('Wave 8C [C-1]: signAndSendSolanaVersionedTx deserializes fail-closed, verifies fee payer, rent_reclaim CloseAccount, jupiter flows, and Wallet Standard account match', async () => {
  resetMockWalletGlobals();
  let signCalls = 0;

  mockWindow.phantom = {
    solana: {
      isPhantom: true,
      connect: async () => ({ publicKey: { toBase58: () => SOL_ADDR_A } }),
      signAndSendTransaction: async (tx: VersionedTransaction) => {
        signCalls += 1;
        assert.ok(typeof tx?.serialize === 'function', 'Provider should receive deserialized VersionedTransaction');
        return { signature: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' };
      },
    },
  };
  await wallets.connectSolanaWallet({ walletId: 'legacy-phantom' });

  // 1. Unparseable / corrupted bytes -> MUST fail closed (never submit raw bytes!)
  const garbageB64 = Buffer.from('not-a-valid-solana-versioned-transaction-payload-12345').toString('base64');
  await assert.rejects(
    () => wallets.signAndSendSolanaVersionedTx(garbageB64, { flow: 'rent_reclaim', autoConnect: false }),
    /failed to deserialize Solana VersionedTransaction/i
  );
  assert.equal(signCalls, 0);

  // 2. Valid VersionedTransaction with WRONG fee payer (SOL_ADDR_B !== connected SOL_ADDR_A) -> rejected!
  const ownerA = new PublicKey(SOL_ADDR_A);
  const ownerB = new PublicKey(SOL_ADDR_B);
  const dummyAta = new PublicKey(SOL_ADDR_MANUAL);

  const wrongFeePayerB64 = buildSignedReadyV0Base64(SOL_ADDR_B, [
    new TransactionInstruction({
      programId: SPL_TOKEN_PROGRAM,
      keys: [
        { pubkey: dummyAta, isSigner: false, isWritable: true },
        { pubkey: ownerB, isSigner: false, isWritable: true },
        { pubkey: ownerB, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    }),
  ]);
  await assert.rejects(
    () => wallets.signAndSendSolanaVersionedTx(wrongFeePayerB64, { flow: 'rent_reclaim', autoConnect: false }),
    /fee payer.*does not match connected Solana wallet/i
  );
  assert.equal(signCalls, 0);

  // 3. rent_reclaim with non-CloseAccount Token opcode (3 = Transfer) -> rejected!
  const tokenTransferB64 = buildSignedReadyV0Base64(SOL_ADDR_A, [
    new TransactionInstruction({
      programId: SPL_TOKEN_PROGRAM,
      keys: [
        { pubkey: dummyAta, isSigner: false, isWritable: true },
        { pubkey: ownerA, isSigner: false, isWritable: true },
        { pubkey: ownerA, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
    }),
  ]);
  await assert.rejects(
    () => wallets.signAndSendSolanaVersionedTx(tokenTransferB64, { flow: 'rent_reclaim', autoConnect: false }),
    /CloseAccount opcode \(9\)/i
  );
  assert.equal(signCalls, 0);

  // 4. rent_reclaim with CloseAccount redirecting rent destination to foreign wallet SOL_ADDR_B -> rejected!
  const foreignDestCloseB64 = buildSignedReadyV0Base64(SOL_ADDR_A, [
    new TransactionInstruction({
      programId: SPL_TOKEN_PROGRAM,
      keys: [
        { pubkey: dummyAta, isSigner: false, isWritable: true },
        { pubkey: ownerB, isSigner: false, isWritable: true }, // attacker destination!
        { pubkey: ownerA, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    }),
  ]);
  await assert.rejects(
    () => wallets.signAndSendSolanaVersionedTx(foreignDestCloseB64, { flow: 'rent_reclaim', autoConnect: false }),
    /CloseAccount rent destination.*does not match connected Solana wallet/i
  );
  assert.equal(signCalls, 0);

  // 5. rent_reclaim with disallowed SystemProgram.transfer -> rejected!
  const drainerInRentB64 = buildSignedReadyV0Base64(SOL_ADDR_A, [
    SystemProgram.transfer({ fromPubkey: ownerA, toPubkey: ownerB, lamports: 1_000_000 }),
  ]);
  await assert.rejects(
    () => wallets.signAndSendSolanaVersionedTx(drainerInRentB64, { flow: 'rent_reclaim', autoConnect: false }),
    /disallowed program/i
  );
  assert.equal(signCalls, 0);

  // 6. jupiter_yield / jupiter_predict blocking raw SystemProgram.transfer drainer without Jupiter program!
  await assert.rejects(
    () => wallets.signAndSendSolanaVersionedTx(drainerInRentB64, { flow: 'jupiter_yield', autoConnect: false }),
    /blocked raw SystemProgram\.transfer/i
  );
  await assert.rejects(
    () => wallets.signAndSendSolanaVersionedTx(drainerInRentB64, { flow: 'jupiter_predict', autoConnect: false }),
    /blocked raw SystemProgram\.transfer/i
  );
  assert.equal(signCalls, 0);

  // 7. Valid rent_reclaim VersionedTransaction (ComputeBudget + CloseAccount to ownerA) -> SUCCEEDS!
  const validRentB64 = buildSignedReadyV0Base64(SOL_ADDR_A, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
    new TransactionInstruction({
      programId: SPL_TOKEN_PROGRAM,
      keys: [
        { pubkey: dummyAta, isSigner: false, isWritable: true },
        { pubkey: ownerA, isSigner: false, isWritable: true },
        { pubkey: ownerA, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    }),
  ]);
  const rentRes = await wallets.signAndSendSolanaVersionedTx(validRentB64, {
    expectedFeePayer: SOL_ADDR_A,
    flow: 'rent_reclaim',
    autoConnect: false,
  });
  assert.equal(rentRes.signature, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  assert.equal(signCalls, 1);

  // 8. Valid jupiter_yield VersionedTransaction -> SUCCEEDS!
  const validJupB64 = buildSignedReadyV0Base64(SOL_ADDR_A, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    new TransactionInstruction({
      programId: JUPITER_V6_PROGRAM,
      keys: [{ pubkey: ownerA, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3, 4]),
    }),
  ]);
  const jupRes = await wallets.signAndSendSolanaVersionedTx(validJupB64, {
    expectedFeePayer: SOL_ADDR_A,
    flow: 'jupiter_yield',
    autoConnect: false,
  });
  assert.equal(jupRes.signature, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
  assert.equal(signCalls, 2);

  // 9. Wallet Standard account mismatch -> MUST fail closed (never fall back to accounts[0]!)
  wallets.disconnectSolanaWallet();
  const stdAccounts = [{ address: SOL_ADDR_A, chains: ['solana:mainnet'] }];
  registerStandardWalletMock({
    name: 'StrictMatchSolWallet',
    chains: ['solana:mainnet'],
    accounts: stdAccounts,
    features: {
      'standard:connect': {
        connect: async () => ({ accounts: [{ address: SOL_ADDR_A, chains: ['solana:mainnet'] }] }),
      },
      'solana:signAndSendTransaction': {
        signAndSendTransaction: async () => [{ signature: new Uint8Array(64).fill(5) }],
      },
    },
  });
  await wallets.connectSolanaWallet({ walletId: 'std:strictmatchsolwallet' });
  // Mutate wallet.accounts so connected SOL_ADDR_A is replaced by foreign SOL_ADDR_B
  stdAccounts[0] = { address: SOL_ADDR_B, chains: ['solana:mainnet'] };
  await assert.rejects(
    () => wallets.signAndSendSolanaVersionedTx(validRentB64, { flow: 'rent_reclaim', autoConnect: false }),
    /does not match any active Wallet Standard account/i
  );
  wallets.disconnectSolanaWallet();
});

test('Wave 8C [L-3, M-4, L-4, H-2]: sendEvmRevokeCalls rejects zero spender & mixed chainId, verifies EIP-5792 status, tracks partial sequential failures, and dispatches turgalium:wallet-changed', async () => {
  resetMockWalletGlobals();
  wallets.disconnectEvmWallet();

  const EVM_USER = '0x1111111111111111111111111111111111111111';
  const TOKEN_A = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const TOKEN_B = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const GOOD_SPENDER_HEX = '6b7a87899490ece95443e979ca9485cbe7e71522';
  const ZERO_SPENDER_HEX = '0'.repeat(40);
  const validRevokeData = '0x095ea7b3' + '0'.repeat(24) + GOOD_SPENDER_HEX + '0'.repeat(64);
  const zeroSpenderRevokeData = '0x095ea7b3' + '0'.repeat(24) + ZERO_SPENDER_HEX + '0'.repeat(64);

  const walletEvents: Array<Record<string, unknown>> = [];
  const onWalletChanged = (ev: Event) => {
    walletEvents.push(((ev as CustomEvent).detail || {}) as Record<string, unknown>);
  };
  mockWindow.addEventListener('turgalium:wallet-changed', onWalletChanged);

  let sendTxCount = 0;
  let rejectSecondSequential = false;
  mockWindow.ethereum = {
    isMetaMask: true,
    on: () => {},
    removeListener: () => {},
    request: async ({ method }: { method: string }) => {
      if (method === 'eth_requestAccounts') return [EVM_USER];
      if (method === 'eth_chainId') return '0x1';
      if (method === 'wallet_getCapabilities') return {};
      if (method === 'wallet_sendCalls') {
        const e = new Error('Method not supported') as Error & { code?: number };
        e.code = -32601;
        throw e;
      }
      if (method === 'eth_sendTransaction') {
        sendTxCount += 1;
        if (rejectSecondSequential && sendTxCount === 2) {
          const e = new Error('User cancelled signing') as Error & { code?: number };
          e.code = 4001;
          throw e;
        }
        return '0x' + String(sendTxCount).padStart(64, 'a');
      }
      return null;
    },
  };

  try {
    await wallets.connectEvmWallet();
    assert.ok(
      walletEvents.some((d) => d.family === 'evm' && d.action === 'connect' && d.address === EVM_USER),
      'Expected turgalium:wallet-changed connect event for EVM'
    );

    // 1. Reject zero spender (L-3)
    await assert.rejects(
      () =>
        wallets.sendEvmRevokeCalls({
          chainId: 1,
          expectedFrom: EVM_USER,
          calls: [{ to: TOKEN_A, data: zeroSpenderRevokeData, value: '0x0', chainId: 1 }],
        }),
      /spender cannot be the zero address/i
    );

    // 2. Reject mixed chainId (L-3)
    await assert.rejects(
      () =>
        wallets.sendEvmRevokeCalls({
          chainId: 1,
          expectedFrom: EVM_USER,
          calls: [
            { to: TOKEN_A, data: validRevokeData, value: '0x0', chainId: 1 },
            { to: TOKEN_B, data: validRevokeData, value: '0x0', chainId: 8453 },
          ],
        }),
      /mixed chainId/i
    );
    assert.equal(sendTxCount, 0);

    // 3. Partial sequential failure attaches already-submitted revokedIndices & txHashes (M-4)
    rejectSecondSequential = true;
    await assert.rejects(
      () =>
        wallets.sendEvmRevokeCalls({
          chainId: 1,
          expectedFrom: EVM_USER,
          calls: [
            { to: TOKEN_A, data: validRevokeData, value: '0x0', chainId: 1 },
            { to: TOKEN_B, data: validRevokeData, value: '0x0', chainId: 1 },
          ],
        }),
      (err: Error & { revokedIndices?: number[]; txHashes?: string[]; code?: number }) => {
        assert.deepEqual(err.revokedIndices, [0]);
        assert.equal(err.txHashes?.length, 1);
        assert.equal(wallets.isUserRejectedError(err), true);
        return true;
      }
    );

    // 4. isUserRejectedError covers user cancel / transaction cancel / rejected by user & plain { code: 4001 }
    assert.equal(wallets.isUserRejectedError({ code: 4001 }), true);
    assert.equal(wallets.isUserRejectedError(new Error('Transaction canceled in wallet')), true);
    assert.equal(wallets.isUserRejectedError(new Error('Rejected by user')), true);
    assert.equal(wallets.isUserRejectedError(new Error('User cancel')), true);

    // 5. normalizePaymasterUrl rejects credentials and rejects http://127.0.0.1 on non-local browser origin (L-4)
    assert.equal(wallets.normalizePaymasterUrl('https://user:pass@paymaster.example.com/v1'), null);
    const prevLocation = mockWindow.location;
    mockWindow.location = { origin: 'https://turgalium.app', hostname: 'turgalium.app' } as typeof mockWindow.location;
    try {
      assert.equal(wallets.normalizePaymasterUrl('http://127.0.0.1:4337/pm'), null);
      assert.equal(wallets.normalizePaymasterUrl('http://localhost:4337/pm'), null);
      assert.equal(
        wallets.normalizePaymasterUrl('https://paymaster.turgalium.app/v1'),
        'https://paymaster.turgalium.app/v1'
      );
    } finally {
      mockWindow.location = prevLocation;
    }

    wallets.disconnectEvmWallet();
    assert.ok(
      walletEvents.some((d) => d.family === 'evm' && d.action === 'disconnect' && d.address === null),
      'Expected turgalium:wallet-changed disconnect event for EVM'
    );
  } finally {
    mockWindow.removeEventListener('turgalium:wallet-changed', onWalletChanged);
    delete mockWindow.ethereum;
    wallets.disconnectEvmWallet();
  }
});
