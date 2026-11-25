import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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
  connectSolanaWallet: (opts?: Record<string, unknown>) => Promise<{ address: string; walletName: string }>;
  disconnectSolanaWallet: () => void;
  getConnectedSolanaAddress: () => string | null;
  getConnectedSolanaWalletName: () => string | null;
  connectFamilyWallet: (family: string, opts?: Record<string, unknown>) => Promise<WalletSession>;
  disconnectFamilyWallet: (family: string) => void;
  getConnectedFamilyWallet: (family: string) => WalletSession | null;
  executeNonEvmDirectBatch: (
    family: string,
    batch: Record<string, unknown>,
    opts?: Record<string, unknown>
  ) => Promise<{ txHashes: string[]; mode: string }>;
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

  // Post-connect accountsChanged message updates address
  mockWindow.dispatchEvent(
    Object.assign(new Event('message'), {
      data: { message: { action: 'accountsChanged', data: { address: TRON_MAINNET_B } } },
    })
  );
  assert.equal(wallets.getConnectedFamilyWallet('tron')?.address, TRON_MAINNET_B);

  // Post-connect setNode switching to Nile testnet disconnects fail-closed
  mockWindow.dispatchEvent(
    Object.assign(new Event('message'), {
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
