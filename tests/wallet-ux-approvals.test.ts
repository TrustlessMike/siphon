import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ALLOWANCE_SELECTOR,
  APPROVE_SELECTOR,
  MAX_UINT256,
  UNLIMITED_ALLOWANCE_THRESHOLD,
  decodeErc20ApproveCalldata,
  encodeErc20AllowanceCalldata,
  encodeErc20RevokeCalldata,
  getKnownApprovalSpenders,
  scanStaleErc20Approvals,
  type ApprovalRpcCallFn,
} from '../src/scanner/approvals.js';
import { decodeMulticall3Aggregate3, encodeMulticall3Aggregate3 } from '../src/scanner/rpc.js';
import { createSiphonServer } from '../src/server/app.js';

interface WalletsUxModule {
  DUAL_VM_WALLET_FAMILIES: Set<string>;
  MAX_PARALLEL_PREQUOTE_CONCURRENCY: number;
  listAvailableEvmWallets: () => Array<{ id: string; name: string; rdns: string; provider: unknown }>;
  listAvailableSolanaWallets: () => Array<{ id: string; name: string; kind: string }>;
  findMatchingSolanaWalletForEvm: (evm: unknown) => { id: string; name: string } | null;
  listDualVmWallets: () => Array<{
    family: string;
    name: string;
    evmWallet: { id: string; name: string };
    solanaWallet: { id: string; name: string };
    dualVm: boolean;
  }>;
  connectEvmWallet: (opts?: Record<string, unknown>) => Promise<{ address: string; walletName: string; capabilities: unknown }>;
  connectDualVmWallet: (opts?: Record<string, unknown>) => Promise<{
    address: string;
    walletName: string;
    dualVm: boolean;
    solana: { address: string; walletName: string } | null;
    solanaError: string | null;
  }>;
  connectSolanaWallet: (opts?: Record<string, unknown>) => Promise<{ address: string; walletName: string }>;
  disconnectEvmWallet: () => void;
  disconnectSolanaWallet: () => void;
  getConnectedEvmAddress: () => string | null;
  getConnectedSolanaAddress: () => string | null;
  normalizePaymasterUrl: (raw: unknown) => string | null;
  setWalletPaymasterConfig: (cfg?: { paymasterUrl?: string | null; paymasterUrls?: Record<string, string> | null }) => unknown;
  resolvePaymasterUrl: (chainId: number, explicitUrl?: string | null) => string | null;
  buildEip5792Capabilities: (opts?: Record<string, unknown>) => { paymasterService: { url: string; context?: Record<string, unknown> } } | undefined;
  loadWalletConnectorConfig: () => Promise<Record<string, unknown>>;
  sendEip5792Batch: (opts: Record<string, unknown>) => Promise<{
    mode: string;
    batchId: string;
    version: string;
    atomicRequired: boolean;
    paymasterSponsored: boolean;
    paymasterUrl: string | null;
    paymasterFallbackReason?: string;
  }>;
  isMobileBrowser: (ua?: string) => boolean;
  buildMobileWalletDeepLink: (walletKey: string, targetUrl?: string, refUrl?: string) => string | null;
  getMobileSolanaDeepLinks: (targetUrl?: string, refUrl?: string) => Array<{
    id: string;
    walletKey: string;
    name: string;
    subtitle: string;
    logo: string;
    deepLinkUrl: string;
  }>;
  createChainBatchPrequoter: (
    chains: string[],
    prepareFn: (chain: string) => Promise<unknown>,
    opts?: { maxConcurrency?: number; maxQuoteAgeMs?: number; nowMs?: () => number }
  ) => {
    getBatch: (chain: string) => Promise<unknown>;
    cancel: () => void;
    getStats: () => {
      total: number;
      completed: number;
      failed: number;
      active: number;
      peakActive: number;
      maxConcurrency: number;
      cancelled: boolean;
    };
  };
}

class MockWindow extends EventTarget {
  location = { origin: 'https://siphon.app', href: 'https://siphon.app/?tab=scanner' };
  localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  [key: string]: unknown;
}

const mockWindow = new MockWindow();
(globalThis as unknown as { window: MockWindow }).window = mockWindow;

const walletsUrl = pathToFileURL(path.resolve('public/wallets.js')).href;
const wallets = (await import(walletsUrl)) as WalletsUxModule;

const EVM_ADDR = '0x1111111111111111111111111111111111111111';
const SOL_ADDR = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SOL_ADDR_2 = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

function resetMockGlobals() {
  wallets.disconnectEvmWallet();
  wallets.disconnectSolanaWallet();
  wallets.setWalletPaymasterConfig({ paymasterUrl: null, paymasterUrls: null });
  for (const key of [
    'ethereum',
    'phantom',
    'backpack',
    'solflare',
    'okxwallet',
    'coinbaseWalletExtension',
    'coinbaseSolana',
    'solana',
    'trustwallet',
    '__SIPHON_PAYMASTER_URL',
    '__SIPHON_PAYMASTER_URLS',
  ]) {
    delete mockWindow[key];
  }
}

/**
 * Helper to ABI-encode Multicall3.aggregate3 return data: `(bool success, bytes returnData)[]`
 */
function encodeMulticall3Return(items: Array<{ success: boolean; returnData: string }>): string {
  const pad32 = (hex: string) => hex.replace(/^0x/i, '').toLowerCase().padStart(64, '0');
  const n = items.length;
  const encodedTuples = items.map((item) => {
    const dataHex = item.returnData.replace(/^0x/i, '').toLowerCase();
    const byteLen = dataHex.length / 2;
    const padded = dataHex.padEnd(Math.ceil(dataHex.length / 64) * 64, '0');
    return pad32(item.success ? '1' : '0') + pad32('40') + pad32(byteLen.toString(16)) + padded;
  });

  const offsets: string[] = [];
  let runningBytes = n * 32;
  for (const t of encodedTuples) {
    offsets.push(pad32(runningBytes.toString(16)));
    runningBytes += t.length / 2;
  }

  return '0x' + pad32('20') + pad32(n.toString(16)) + offsets.join('') + encodedTuples.join('');
}

function uint256WordHex(val: bigint): string {
  return '0x' + val.toString(16).padStart(64, '0');
}

// =========================================================================
// 1. 1-CLICK UNIFIED DUAL-VM CONNECT (PHANTOM / OKX / COINBASE / BACKPACK)
// =========================================================================

test('Dual-VM Connect: detects Phantom, OKX, Coinbase & Backpack pairs and connects EVM + Solana in 1 flow', async () => {
  resetMockGlobals();

  let evmCalls = 0;
  let solCalls = 0;
  mockWindow.phantom = {
    ethereum: {
      isPhantom: true,
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') {
          evmCalls += 1;
          return [EVM_ADDR];
        }
        if (method === 'wallet_getCapabilities') return {};
        return null;
      },
    },
    solana: {
      isPhantom: true,
      connect: async () => {
        solCalls += 1;
        return { publicKey: { toBase58: () => SOL_ADDR } };
      },
    },
  };
  mockWindow.backpack = {
    ethereum: {
      isBackpack: true,
      request: async ({ method }: { method: string }) =>
        method === 'eth_requestAccounts' ? [EVM_ADDR] : {},
    },
    solana: {
      connect: async () => ({ publicKey: { toBase58: () => SOL_ADDR_2 } }),
    },
  };
  mockWindow.okxwallet = {
    isOkxWallet: true,
    request: async ({ method }: { method: string }) =>
      method === 'eth_requestAccounts' ? [EVM_ADDR] : {},
    solana: {
      connect: async () => ({ publicKey: { toBase58: () => SOL_ADDR } }),
    },
  };
  mockWindow.coinbaseWalletExtension = {
    isCoinbaseWallet: true,
    request: async ({ method }: { method: string }) =>
      method === 'eth_requestAccounts' ? [EVM_ADDR] : {},
  };
  mockWindow.coinbaseSolana = {
    connect: async () => ({ publicKey: { toBase58: () => SOL_ADDR } }),
  };

  const dualPairs = wallets.listDualVmWallets();
  const families = new Set(dualPairs.map((p) => p.family));
  assert.ok(families.has('phantom'), 'Phantom should be detected as dual-VM');
  assert.ok(families.has('backpack'), 'Backpack should be detected as dual-VM');
  assert.ok(families.has('okx'), 'OKX should be detected as dual-VM');
  assert.ok(families.has('coinbase'), 'Coinbase should be detected as dual-VM');

  const phantomPair = dualPairs.find((p) => p.family === 'phantom')!;
  const res = await wallets.connectDualVmWallet({ walletId: phantomPair.evmWallet.id });

  assert.equal(res.address, EVM_ADDR);
  assert.equal(res.dualVm, true);
  assert.equal(res.solana?.address, SOL_ADDR);
  assert.equal(res.solanaError, null);
  assert.equal(wallets.getConnectedEvmAddress(), EVM_ADDR);
  assert.equal(wallets.getConnectedSolanaAddress(), SOL_ADDR);
  assert.equal(evmCalls, 1);
  assert.equal(solCalls, 1);
});

test('Dual-VM Connect: preserves EVM session if secondary Solana prompt is cancelled, and ignores non-dual-VM wallets', async () => {
  resetMockGlobals();

  mockWindow.phantom = {
    ethereum: {
      isPhantom: true,
      request: async ({ method }: { method: string }) =>
        method === 'eth_requestAccounts' ? [EVM_ADDR] : {},
    },
    solana: {
      isPhantom: true,
      connect: async () => {
        const err = new Error('User rejected the request.') as Error & { code?: number };
        err.code = 4001;
        throw err;
      },
    },
  };

  const phantomEvm = wallets.listAvailableEvmWallets().find((w) => w.name.toLowerCase().includes('phantom'))!;
  const res = await wallets.connectDualVmWallet({ walletId: phantomEvm.id });
  assert.equal(res.address, EVM_ADDR);
  assert.equal(res.dualVm, true);
  assert.equal(res.solana, null);
  assert.match(String(res.solanaError), /rejected/i);
  assert.equal(wallets.getConnectedEvmAddress(), EVM_ADDR);
  assert.equal(wallets.getConnectedSolanaAddress(), null);

  // Non-dual-VM wallet (Rabby) must not match any Solana provider
  resetMockGlobals();
  mockWindow.ethereum = {
    isRabby: true,
    request: async ({ method }: { method: string }) =>
      method === 'eth_requestAccounts' ? [EVM_ADDR] : {},
  };
  mockWindow.phantom = {
    solana: {
      isPhantom: true,
      connect: async () => ({ publicKey: { toBase58: () => SOL_ADDR } }),
    },
  };
  const rabby = wallets.listAvailableEvmWallets()[0]!;
  assert.equal(wallets.findMatchingSolanaWalletForEvm(rabby), null);
  const rabbyRes = await wallets.connectDualVmWallet({ walletId: rabby.id });
  assert.equal(rabbyRes.dualVm, false);
  assert.equal(rabbyRes.solana, null);
  assert.equal(wallets.getConnectedSolanaAddress(), null);
});

// =========================================================================
// 2. ERC-7677 PAYMASTER CAPABILITIES IN sendEip5792Batch
// =========================================================================

test('ERC-7677 Paymaster: attaches capabilities.paymasterService.url when wallet advertises support AND URL is configured', async () => {
  resetMockGlobals();

  // Reject unsafe URL schemes
  assert.equal(wallets.normalizePaymasterUrl('javascript:alert(1)'), null);
  assert.equal(wallets.normalizePaymasterUrl('http://insecure-public.example.com/pm'), null);
  assert.equal(
    wallets.normalizePaymasterUrl('https://api.developer.coinbase.com/rpc/v1/base/paymaster'),
    'https://api.developer.coinbase.com/rpc/v1/base/paymaster'
  );
  assert.equal(
    wallets.normalizePaymasterUrl('http://127.0.0.1:4337/paymaster'),
    'http://127.0.0.1:4337/paymaster'
  );

  const sentPayloads: Array<Record<string, unknown>> = [];
  mockWindow.ethereum = {
    isCoinbaseWallet: true,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_requestAccounts') return [EVM_ADDR];
      if (method === 'eth_chainId') return '0x2105'; // Base (8453)
      if (method === 'wallet_getCapabilities') {
        return {
          '0x2105': {
            atomic: { status: 'supported' },
            paymasterService: { supported: true },
          },
          '0x1': {
            atomic: { status: 'supported' },
            paymasterService: { supported: false },
          },
        };
      }
      if (method === 'wallet_sendCalls') {
        sentPayloads.push((params?.[0] ?? {}) as Record<string, unknown>);
        return { id: '0xbatch_paymaster_1' };
      }
      return null;
    },
  };

  await wallets.connectEvmWallet();

  // Case A: No paymaster URL configured -> graceful fallback with NO capabilities field
  const resNoPm = await wallets.sendEip5792Batch({
    chainId: 8453,
    calls: [{ to: USDC_ETH, data: '0x', value: '0x0' }],
    expectedFrom: EVM_ADDR,
  });
  assert.equal(resNoPm.paymasterSponsored, false);
  assert.equal(resNoPm.paymasterUrl, null);
  assert.equal('capabilities' in sentPayloads[0], false);

  // Case B: window.__SIPHON_PAYMASTER_URL configured + Base supports paymaster -> attaches ERC-7677 capability
  mockWindow.__SIPHON_PAYMASTER_URL = 'https://paymaster.siphon.example/v1/base';
  const resWithPm = await wallets.sendEip5792Batch({
    chainId: 8453,
    calls: [{ to: USDC_ETH, data: '0x', value: '0x0' }],
    expectedFrom: EVM_ADDR,
  });
  assert.equal(resWithPm.paymasterSponsored, true);
  assert.equal(resWithPm.paymasterUrl, 'https://paymaster.siphon.example/v1/base');
  assert.deepEqual(sentPayloads[1].capabilities, {
    paymasterService: { url: 'https://paymaster.siphon.example/v1/base' },
  });

  // Case C: Ethereum (chainId 1) advertises paymasterService.supported === false -> MUST NOT attach capabilities
  const ethCaps = wallets.buildEip5792Capabilities({ chainId: 1 });
  assert.equal(ethCaps, undefined);
});

test('ERC-7677 Paymaster: loads paymasterUrl from /api/health fallback & retries cleanly without capabilities if paymaster rejects', async () => {
  resetMockGlobals();

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const urlStr = String(input);
    if (urlStr.endsWith('/api/config')) {
      return new Response(JSON.stringify({ coinbaseSmartWalletEnabled: true }), { status: 200 });
    }
    if (urlStr.endsWith('/api/health')) {
      return new Response(
        JSON.stringify({ status: 'ok', paymasterUrl: 'https://pm.health.example/rpc' }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

  try {
    await wallets.loadWalletConnectorConfig();
    assert.equal(wallets.resolvePaymasterUrl(8453), 'https://pm.health.example/rpc');
  } finally {
    globalThis.fetch = origFetch;
  }

  let sendCount = 0;
  const observed: Array<Record<string, unknown>> = [];
  mockWindow.ethereum = {
    isMetaMask: true,
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_requestAccounts') return [EVM_ADDR];
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'wallet_getCapabilities') {
        return { '0x2105': { atomic: { status: 'supported' }, paymasterService: { supported: true } } };
      }
      if (method === 'wallet_sendCalls') {
        sendCount += 1;
        const payload = (params?.[0] ?? {}) as Record<string, unknown>;
        observed.push(payload);
        if (sendCount === 1 && payload.capabilities) {
          const err = new Error('Paymaster sponsorship policy rejected') as Error & { code?: number };
          err.code = 5750;
          throw err;
        }
        return { id: '0xbatch_self_funded_fallback' };
      }
      return null;
    },
  };

  await wallets.connectEvmWallet();
  const res = await wallets.sendEip5792Batch({
    chainId: 8453,
    calls: [{ to: USDC_ETH, data: '0x', value: '0x0', isProtocolFee: true }],
    expectedFrom: EVM_ADDR,
  });

  assert.equal(sendCount, 2);
  assert.ok(observed[0].capabilities, 'First attempt should include paymaster capabilities');
  assert.equal('capabilities' in observed[1], false, 'Fallback retry must omit paymaster capabilities');
  assert.equal(observed[1].atomicRequired, true, 'Fallback retry must preserve atomicRequired for fee batches');
  assert.equal(res.batchId, '0xbatch_self_funded_fallback');
  assert.equal(res.paymasterSponsored, false);
  assert.match(String(res.paymasterFallbackReason), /paymaster/i);
});

// =========================================================================
// 3. PARALLEL CHAIN PRE-QUOTING (BOUNDED CONCURRENCY <= 3)
// =========================================================================

test('Parallel Chain Pre-Quoter: strictly bounds concurrency <= 3, isolates failures, and expires stale quotes', async () => {
  const chains = ['base', 'arbitrum', 'optimism', 'polygon', 'ethereum', 'avalanche'];
  let active = 0;
  let maxObservedActive = 0;
  let fakeNow = 1_000_000;

  const prequoter = wallets.createChainBatchPrequoter(
    chains,
    async (chain) => {
      active += 1;
      if (active > maxObservedActive) maxObservedActive = active;
      await new Promise((r) => setTimeout(r, 15));
      active -= 1;
      if (chain === 'polygon') {
        throw new Error('Transient route quote error');
      }
      return { chain, calls: [{ to: USDC_ETH, data: '0x' }] };
    },
    // Request concurrency 8 -> must be hard-clamped to <= 3!
    { maxConcurrency: 8, maxQuoteAgeMs: 30_000, nowMs: () => fakeNow }
  );

  const results = await Promise.all(chains.map((c) => prequoter.getBatch(c)));
  const stats = prequoter.getStats();

  assert.equal(stats.maxConcurrency, 3);
  assert.ok(maxObservedActive <= 3, `Peak concurrency ${maxObservedActive} exceeded limit 3`);
  assert.ok(maxObservedActive >= 2, `Expected parallel pre-quoting (>= 2 concurrent), got ${maxObservedActive}`);
  assert.equal(stats.peakActive, maxObservedActive);
  assert.equal(stats.completed, 5);
  assert.equal(stats.failed, 1);

  assert.deepEqual((results[0] as { chain: string }).chain, 'base');
  assert.equal(results[3], null, 'Failed chain pre-quote must return null for live fallback');
  assert.deepEqual((results[5] as { chain: string }).chain, 'avalanche');

  // Advance clock past TTL -> stale quote must return null so live execution re-quotes
  fakeNow += 31_000;
  assert.equal(await prequoter.getBatch('base'), null);
});

// =========================================================================
// 4. MOBILE PHANTOM / SOLFLARE UNIVERSAL DEEP-LINKS
// =========================================================================

test('Mobile Deep-Links: detects mobile UAs, builds exact Phantom/Solflare universal links & surfaces structured error on mobile connect', async () => {
  resetMockGlobals();

  const iphoneUa =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const androidUa =
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  const desktopUa =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

  assert.equal(wallets.isMobileBrowser(iphoneUa), true);
  assert.equal(wallets.isMobileBrowser(androidUa), true);
  assert.equal(wallets.isMobileBrowser(desktopUa), false);

  const appUrl = 'https://siphon.app/app?chain=base';
  const phantomUrl = wallets.buildMobileWalletDeepLink('phantom', appUrl);
  const solflareUrl = wallets.buildMobileWalletDeepLink('solflare', appUrl);

  assert.equal(
    phantomUrl,
    `https://phantom.app/ul/browse/${encodeURIComponent(appUrl)}?ref=${encodeURIComponent('https://siphon.app')}`
  );
  assert.equal(
    solflareUrl,
    `https://solflare.com/ul/v1/browse/${encodeURIComponent(appUrl)}?ref=${encodeURIComponent('https://siphon.app')}`
  );
  assert.equal(wallets.buildMobileWalletDeepLink('unknown', appUrl), null);

  // Unsafe javascript: scheme must fall back safely to https://siphon.app/
  const safeFallback = wallets.buildMobileWalletDeepLink('phantom', 'javascript:alert(1)');
  assert.ok(safeFallback?.startsWith('https://phantom.app/ul/browse/https%3A%2F%2Fsiphon.app%2F'));

  // Mobile connect with no injected wallet throws structured MOBILE_DEEP_LINK_REQUIRED error
  type MobileDeepLinkErr = Error & {
    code?: string;
    isMobile?: boolean;
    deepLinks?: Array<{ walletKey: string; deepLinkUrl: string }>;
  };
  let caught: MobileDeepLinkErr | undefined;
  try {
    await wallets.connectSolanaWallet({ userAgent: iphoneUa, targetUrl: appUrl });
  } catch (err) {
    caught = err as MobileDeepLinkErr;
  }
  assert.ok(caught !== undefined, 'Expected connectSolanaWallet to throw when no wallet injected on mobile');
  const mobileErr: MobileDeepLinkErr = caught;
  assert.equal(mobileErr.code, 'MOBILE_DEEP_LINK_REQUIRED');
  assert.equal(mobileErr.isMobile, true);
  assert.equal(mobileErr.deepLinks?.length, 2);
  assert.equal(mobileErr.deepLinks?.[0].walletKey, 'phantom');
  assert.equal(mobileErr.deepLinks?.[0].deepLinkUrl, phantomUrl);
  assert.equal(mobileErr.deepLinks?.[1].walletKey, 'solflare');
  assert.equal(mobileErr.deepLinks?.[1].deepLinkUrl, solflareUrl);
});

// =========================================================================
// 5. STALE ERC-20 APPROVAL SCANNER + MULTICALL3 + /api/approvals/scan
// =========================================================================

test('Stale Approval Scanner: encodes allowance/revoke calldata, chunks Multicall3, flags unlimited (>=2^255), and generates valid ApprovalRevoke[]', async () => {
  const multichainRouter = '0x6b7a87899490EcE95443e979cA9485CBE7E71522';
  const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  const customSpender = '0x9999999999999999999999999999999999999999';

  // Verify exact ABI selectors and round-trip decode
  const allowanceData = encodeErc20AllowanceCalldata(EVM_ADDR, permit2);
  assert.equal(allowanceData.slice(0, 10), `0x${ALLOWANCE_SELECTOR}`);
  assert.equal(allowanceData.length, 10 + 64 + 64);

  const revokeData = encodeErc20RevokeCalldata(multichainRouter);
  assert.equal(revokeData.slice(0, 10), `0x${APPROVE_SELECTOR}`);
  const decodedRevoke = decodeErc20ApproveCalldata(revokeData);
  assert.ok(decodedRevoke);
  assert.equal(decodedRevoke.selector, `0x${APPROVE_SELECTOR}`);
  assert.equal(decodedRevoke.spender.toLowerCase(), multichainRouter.toLowerCase());
  assert.equal(decodedRevoke.amount, 0n);
  assert.equal(decodedRevoke.isRevoke, true);

  // Known spenders registry includes critical legacy & active spenders
  const knownEth = getKnownApprovalSpenders('ethereum');
  assert.ok(knownEth.length >= 10);
  assert.ok(knownEth.some((s) => s.address.toLowerCase() === multichainRouter.toLowerCase()));
  assert.ok(knownEth.some((s) => s.address.toLowerCase() === permit2.toLowerCase()));

  // Build deterministic allowance matrix for 3 tokens x 3 spenders = 9 pairs, chunked by 4 -> 3 Multicall3 RPC calls
  const tokens = [
    { address: USDC_ETH, symbol: 'USDC', decimals: 6 },
    { address: WETH_ETH, symbol: 'WETH', decimals: 18 },
    { address: USDT_ETH, symbol: 'USDT', decimals: 6 },
  ];
  const spenders = [
    { address: multichainRouter }, // known exploited/high-risk
    { address: permit2 }, // known Permit2
    { address: customSpender, label: 'Custom Legacy Vault', category: 'custom' as const, riskLevel: 'low' as const },
  ];

  // Expected allowance per (token, spender)
  const allowanceMap = new Map<string, { success: boolean; val: bigint }>([
    [`${USDC_ETH.toLowerCase()}:${multichainRouter.toLowerCase()}`, { success: true, val: MAX_UINT256 }], // critical unlimited
    [`${USDC_ETH.toLowerCase()}:${permit2.toLowerCase()}`, { success: true, val: UNLIMITED_ALLOWANCE_THRESHOLD }], // exact 2^255 boundary -> unlimited high
    [`${USDC_ETH.toLowerCase()}:${customSpender.toLowerCase()}`, { success: true, val: 0n }], // zero -> skipped
    [`${WETH_ETH.toLowerCase()}:${multichainRouter.toLowerCase()}`, { success: true, val: 500_000_000_000_000_000n }], // 0.5 WETH on high-risk -> high
    [`${WETH_ETH.toLowerCase()}:${permit2.toLowerCase()}`, { success: false, val: 0n }], // reverted sub-call -> failedPairs
    [`${WETH_ETH.toLowerCase()}:${customSpender.toLowerCase()}`, { success: true, val: 250_000_000_000_000_000n }], // 0.25 WETH on low-risk -> low
    [`${USDT_ETH.toLowerCase()}:${multichainRouter.toLowerCase()}`, { success: true, val: 0n }],
    [`${USDT_ETH.toLowerCase()}:${permit2.toLowerCase()}`, { success: true, val: 100_000_000n }], // 100 USDT on Permit2 -> medium
    [`${USDT_ETH.toLowerCase()}:${customSpender.toLowerCase()}`, { success: true, val: UNLIMITED_ALLOWANCE_THRESHOLD - 1n }], // 2^255 - 1 -> NOT unlimited
  ]);

  let multicallBatches = 0;
  const mockRpcCall: ApprovalRpcCallFn = async (_urls, method, params) => {
    assert.equal(method, 'eth_call');
    multicallBatches += 1;
    const callObj = params[0] as { to: string; data: string };
    assert.equal(callObj.to.toLowerCase(), '0xca11bde05977b3631167028862be2a173976ca11');
    // Verify multicall3 aggregate3 selector (0x82ad56cb)
    assert.ok(callObj.data.toLowerCase().startsWith('0x82ad56cb'));

    // Reconstruct which pairs are in this chunk by reading offsets inside the calldata
    // Simpler & exact: track chunk index deterministically using slice offsets
    const allPairs = tokens.flatMap((t) => spenders.map((s) => ({ t, s })));
    const startIdx = (multicallBatches - 1) * 4;
    const chunkPairs = allPairs.slice(startIdx, startIdx + 4);

    // Verify exact multicall3 payload matches expected encoding
    const expectedMc = encodeMulticall3Aggregate3(
      chunkPairs.map(({ t, s }) => ({
        target: t.address,
        allowFailure: true,
        callData: encodeErc20AllowanceCalldata(EVM_ADDR, s.address),
      }))
    );
    assert.equal(callObj.data.toLowerCase(), expectedMc.toLowerCase());

    const returnItems = chunkPairs.map(({ t, s }) => {
      const entry = allowanceMap.get(`${t.address.toLowerCase()}:${s.address.toLowerCase()}`)!;
      return {
        success: entry.success,
        returnData: entry.success ? uint256WordHex(entry.val) : '0x',
      };
    });
    const encoded = encodeMulticall3Return(returnItems);
    // Sanity check decoder round-trip
    assert.equal(decodeMulticall3Aggregate3(encoded).length, chunkPairs.length);
    return { result: encoded };
  };

  const scan = await scanStaleErc20Approvals('ethereum', EVM_ADDR, tokens, spenders, {
    multicallChunkSize: 4,
    rpcCall: mockRpcCall,
  });

  assert.equal(multicallBatches, 3, 'Expected 9 pairs / chunkSize 4 = 3 Multicall3 batches');
  assert.equal(scan.scannedPairs, 9);
  assert.equal(scan.failedPairs, 1);
  assert.equal(scan.activeApprovalsCount, 6);
  assert.equal(scan.unlimitedCount, 2, 'Only >= 2^255 should be flagged unlimited (not 2^255 - 1)');
  assert.equal(scan.highRiskCount, 3, 'Expected 1 critical + 2 high findings');

  // Verify severity ordering: critical first
  assert.equal(scan.findings[0].severity, 'critical');
  assert.equal(scan.findings[0].tokenSymbol, 'USDC');
  assert.equal(scan.findings[0].spender.toLowerCase(), multichainRouter.toLowerCase());
  assert.equal(scan.findings[0].isUnlimited, true);
  assert.equal(scan.findings[0].isMaxUint256, true);
  assert.equal(scan.findings[0].allowanceFormatted, 'UNLIMITED');

  // Verify exact 2^255 boundary finding
  const permit2Usdc = scan.findings.find(
    (f) => f.tokenSymbol === 'USDC' && f.spender.toLowerCase() === permit2.toLowerCase()
  )!;
  assert.equal(permit2Usdc.isUnlimited, true);
  assert.equal(permit2Usdc.isMaxUint256, false);

  // Verify 2^255 - 1 is NOT flagged unlimited
  const belowBoundary = scan.findings.find(
    (f) => f.tokenSymbol === 'USDT' && f.spender.toLowerCase() === customSpender.toLowerCase()
  )!;
  assert.equal(belowBoundary.isUnlimited, false);

  // Verify every ApprovalRevoke entry has valid approve(spender, 0) calldata targeting the token
  assert.equal(scan.revokes.length, scan.findings.length);
  for (const rev of scan.revokes) {
    assert.equal(rev.to.toLowerCase(), rev.token.toLowerCase());
    assert.equal(rev.value, '0x0');
    assert.equal(rev.chainId, 1);
    const dec = decodeErc20ApproveCalldata(rev.data);
    assert.ok(dec, `Failed to decode revoke calldata ${rev.data}`);
    assert.equal(dec.selector, '0x095ea7b3');
    assert.equal(dec.spender.toLowerCase(), rev.spender.toLowerCase());
    assert.equal(dec.amount, 0n);
    assert.equal(dec.isRevoke, true);
  }

  // Test unlimitedOnly filter
  multicallBatches = 0;
  const unlimitedOnlyScan = await scanStaleErc20Approvals('ethereum', EVM_ADDR, tokens, spenders, {
    multicallChunkSize: 4,
    unlimitedOnly: true,
    rpcCall: mockRpcCall,
  });
  assert.equal(unlimitedOnlyScan.activeApprovalsCount, 2);
  assert.ok(unlimitedOnlyScan.findings.every((f) => f.isUnlimited));
});

test('HTTP API: GET /api/approvals/spenders and POST /api/approvals/scan validate inputs and return ready-to-sign revokes', async () => {
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const realFetch = globalThis.fetch;
  const permit2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

  try {
    // 1. GET /api/approvals/spenders
    const spendersRes = await realFetch(`${baseUrl}/api/approvals/spenders?chain=base`);
    assert.equal(spendersRes.status, 200);
    const spendersJson = (await spendersRes.json()) as {
      chain: string;
      chainId: number;
      spenders: Array<{ address: string; label: string }>;
    };
    assert.equal(spendersJson.chain, 'base');
    assert.equal(spendersJson.chainId, 8453);
    assert.ok(spendersJson.spenders.length >= 6);

    // 2. Validation error on bad chain
    const badChainRes = await realFetch(`${baseUrl}/api/approvals/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: 'solana', walletAddress: EVM_ADDR }),
    });
    assert.equal(badChainRes.status, 400);

    // 3. Validation error on zero address
    const zeroAddrRes = await realFetch(`${baseUrl}/api/approvals/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'ethereum',
        walletAddress: '0x0000000000000000000000000000000000000000',
      }),
    });
    assert.equal(zeroAddrRes.status, 400);

    // 4. Live end-to-end POST /api/approvals/scan with intercepted EVM RPC fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith(baseUrl)) {
        return realFetch(input, init);
      }
      // Return a single unlimited allowance result for (USDC_ETH, permit2)
      const encoded = encodeMulticall3Return([
        { success: true, returnData: uint256WordHex(MAX_UINT256) },
      ]);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: encoded }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const scanRes = await realFetch(`${baseUrl}/api/approvals/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'ethereum',
        walletAddress: EVM_ADDR,
        tokens: [{ address: USDC_ETH, symbol: 'USDC', decimals: 6 }],
        spenders: [permit2],
      }),
    });
    assert.equal(scanRes.status, 200);
    const scanJson = (await scanRes.json()) as {
      chain: string;
      activeApprovalsCount: number;
      unlimitedCount: number;
      revokes: Array<{ token: string; spender: string; data: string }>;
    };
    assert.equal(scanJson.chain, 'ethereum');
    assert.equal(scanJson.activeApprovalsCount, 1);
    assert.equal(scanJson.unlimitedCount, 1);
    assert.equal(scanJson.revokes.length, 1);
    assert.equal(scanJson.revokes[0].token.toLowerCase(), USDC_ETH.toLowerCase());
    assert.equal(scanJson.revokes[0].spender.toLowerCase(), permit2.toLowerCase());
    const dec = decodeErc20ApproveCalldata(scanJson.revokes[0].data);
    assert.ok(dec?.isRevoke);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
