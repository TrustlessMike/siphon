import test from 'node:test';
import assert from 'node:assert/strict';

import { EVM_CHAINS } from '../src/scanner/chains.js';
import {
  evmJsonRpcBatch,
  evmJsonRpcCall,
  isEvmExecutionRevertError,
  isTransientJsonRpcError,
  scanSingleEvmChain,
} from '../src/scanner/rpc.js';
import {
  ALCHEMY_NETWORK_SUBDOMAINS,
  decodeAbiStringOrBytes32,
  discoverChainTokens,
  fetchDexLiquidityBatch,
  fetchDexLiquidityBatchWithStatus,
  simulateBurnTransferOnchain,
} from '../src/scanner/discovery.js';
import { scanLiveWallet } from '../src/scanner/classifier.js';
import { clearPriceCache } from '../src/scanner/prices.js';
import { estimateLiquidityScaledSlippageUsd, evaluateAssetRoi } from '../src/scanner/roi.js';
import { padUint256 } from '../src/defi/extractors.js';
import type { ScannedAsset } from '../src/scanner/types.js';

const USER = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const TOKEN_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const TOKEN_WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
const TOKEN_MKR = '0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2';
const TOKEN_ZERO_DEC = '0x1234567890123456789012345678901234567890';
const TOKEN_HONEYPOT_HIGH_LP = '0xBad0000000000000000000000000000000009999';
const TOKEN_LEGIT_LIQUID = '0x1111111111111111111111111111111111112222';
const TOKEN_QUOTE_SIDE = '0x3333333333333333333333333333333333334444';
const TOKEN_SKEWED_POOL = '0x5555555555555555555555555555555555556666';

function encodeAbiString(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  const hex = bytes.toString('hex');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return '0x' + padUint256(0x20n) + padUint256(BigInt(bytes.length)) + padded;
}

function encodeBytes32String(text: string): string {
  const hex = Buffer.from(text, 'utf8').toString('hex').slice(0, 64).padEnd(64, '0');
  return '0x' + hex;
}

function encodeMulticall3Return(items: Array<{ success: boolean; returnData: string }>): string {
  const n = items.length;
  const header = padUint256(0x20n) + padUint256(BigInt(n));
  const encodedElements = items.map((item) => {
    const clean = item.returnData.replace(/^0x/i, '').toLowerCase();
    const byteLen = clean.length / 2;
    const padded = clean.padEnd(Math.ceil(clean.length / 64) * 64, '0');
    return (
      padUint256(item.success ? 1n : 0n) +
      padUint256(0x40n) +
      padUint256(BigInt(byteLen)) +
      padded
    );
  });
  const offsets: string[] = [];
  let runningBytes = n * 32;
  for (const el of encodedElements) {
    offsets.push(padUint256(BigInt(runningBytes)));
    runningBytes += el.length / 2;
  }
  return '0x' + header + offsets.join('') + encodedElements.join('');
}

function decodeMulticall3InputCalls(calldata: string): Array<{ target: string; callData: string }> {
  const clean = calldata.replace(/^0x/i, '').toLowerCase();
  if (!clean.startsWith('82ad56cb')) return [];
  const body = clean.slice(8);
  const arrOffset = Number(BigInt('0x' + body.slice(0, 64))) * 2;
  const count = Number(BigInt('0x' + body.slice(arrOffset, arrOffset + 64)));
  const tableStart = arrOffset + 64;
  const out: Array<{ target: string; callData: string }> = [];
  for (let i = 0; i < count; i++) {
    const rel = Number(BigInt('0x' + body.slice(tableStart + i * 64, tableStart + (i + 1) * 64))) * 2;
    const itemStart = tableStart + rel;
    const target = '0x' + body.slice(itemStart + 24, itemStart + 64);
    const dataRel = Number(BigInt('0x' + body.slice(itemStart + 128, itemStart + 192))) * 2;
    const dataStart = itemStart + dataRel;
    const byteLen = Number(BigInt('0x' + body.slice(dataStart, dataStart + 64)));
    const callData = '0x' + body.slice(dataStart + 64, dataStart + 64 + byteLen * 2);
    out.push({ target, callData });
  }
  return out;
}

async function withMockedFetch<T>(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// =========================================================================
// 1. HIGH-06: RPC Failover on JSON-RPC Rate-Limit & Node Errors
// =========================================================================

test('HIGH-06: error classifiers distinguish transient node/rate-limit errors from genuine EVM reverts', () => {
  for (const err of [
    { code: -32005, message: 'limit exceeded' },
    { code: -32603, message: 'Internal JSON-RPC error.' },
    { code: -32016, message: 'over rate limit' },
    { code: 429, message: 'Too Many Requests' },
    { code: -32000, message: 'request timeout reached' },
    { message: 'rate limit exceeded; revert to lower RPS' },
  ]) {
    assert.equal(isTransientJsonRpcError(err), true, `Expected transient: ${JSON.stringify(err)}`);
    assert.equal(isEvmExecutionRevertError(err), false, `Must NOT treat transient error as revert: ${JSON.stringify(err)}`);
  }

  for (const rev of [
    { code: 3, message: 'execution reverted: TransferLocked' },
    { code: -32000, message: 'execution reverted' },
    { message: 'VM Exception while processing transaction: revert Blacklisted' },
  ]) {
    assert.equal(isEvmExecutionRevertError(rev), true, `Expected revert: ${JSON.stringify(rev)}`);
  }

  // Non-revert node errors must NOT short-circuit as reverts
  assert.equal(isEvmExecutionRevertError({ code: -32000, message: 'header not found' }), false);
  assert.equal(isEvmExecutionRevertError({ code: -32000, message: 'out of gas' }), false);
});

test('HIGH-06: evmJsonRpcBatch & scanSingleEvmChain fail over when RPC 1 returns 4-item -32005 / -32603 / -32016 batch errors', async () => {
  const rpc1 = 'https://rpc1.rate-limited.test';
  const rpc2 = 'https://rpc2.internal-err.test';
  const rpc3 = 'https://rpc3.healthy.test';
  const visited: string[] = [];

  const usdcBalance = 2_500_000_000n; // 2,500 USDC
  const nativeWei = 3n * 10n ** 18n; // 3 ETH

  const testChain = {
    ...EVM_CHAINS.ethereum,
    rpcUrl: rpc1,
    rpcUrls: [rpc1, rpc2, rpc3],
  };

  await withMockedFetch(
    async (url, init) => {
      visited.push(url);
      const parsed = JSON.parse(String(init?.body ?? '[]')) as Array<{ id: number; method: string }>;

      if (url === rpc1) {
        // HTTP 200 with 4-item JSON-RPC -32005 rate-limit errors (previously accepted as silent zero balances!)
        return new Response(
          JSON.stringify(
            parsed.map((r) => ({
              jsonrpc: '2.0',
              id: r.id,
              error: { code: -32005, message: 'limit exceeded' },
            }))
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url === rpc2) {
        // Partial failure: eth_blockNumber & eth_gasPrice succeed, but eth_getBalance & Multicall3 fail with -32016 / -32603
        return new Response(
          JSON.stringify(
            parsed.map((r) => {
              if (r.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: r.id, result: '0x1400000' };
              if (r.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: r.id, result: '0x3b9aca00' };
              if (r.method === 'eth_getBalance') {
                return { jsonrpc: '2.0', id: r.id, error: { code: -32016, message: 'over rate limit' } };
              }
              return { jsonrpc: '2.0', id: r.id, error: { code: -32603, message: 'internal error: timeout' } };
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      // Healthy RPC 3
      const mcReturn = encodeMulticall3Return([{ success: true, returnData: '0x' + padUint256(usdcBalance) }]);
      return new Response(
        JSON.stringify(
          parsed.map((r) => {
            if (r.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: r.id, result: '0x1500000' };
            if (r.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: r.id, result: '0x77359400' };
            if (r.method === 'eth_getBalance') {
              return { jsonrpc: '2.0', id: r.id, result: '0x' + nativeWei.toString(16) };
            }
            return { jsonrpc: '2.0', id: r.id, result: mcReturn };
          })
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
    async () => {
      const scan = await scanSingleEvmChain(testChain, USER, [
        {
          chain: 'ethereum',
          address: TOKEN_USDC,
          symbol: 'USDC',
          name: 'USD Coin',
          decimals: 6,
          kind: 'erc20',
        },
      ]);
      assert.deepEqual(visited, [rpc1, rpc2, rpc3], 'Must fail over from rate-limited RPC 1 & partial RPC 2 to healthy RPC 3');
      assert.equal(scan.ok, true);
      assert.equal(scan.blockNumber, 0x1500000);
      assert.equal(scan.nativeBalanceWei, nativeWei);
      assert.equal(scan.tokenBalances.get(TOKEN_USDC.toLowerCase()), usdcBalance);
    }
  );
});

test('HIGH-06: evmJsonRpcBatch single-call fallback rejects partial failures where eth_blockNumber succeeds but eth_getBalance/Multicall3 rate-limit', async () => {
  const rpcNoBatchPartial = 'https://rpc-nobatch-partial.test';
  const rpcHealthy = 'https://rpc-healthy-backup.test';
  const callsByHost = new Map<string, number>();

  const mcOk = encodeMulticall3Return([{ success: true, returnData: '0x' + padUint256(777n) }]);

  await withMockedFetch(
    async (url, init) => {
      callsByHost.set(url, (callsByHost.get(url) ?? 0) + 1);
      const parsed = JSON.parse(String(init?.body ?? '{}'));

      if (url === rpcNoBatchPartial) {
        // Reject batch array with non-transient "batch not supported" to trigger single-call fallback
        if (Array.isArray(parsed)) {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests not supported' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        // Single-call fallback: eth_blockNumber & eth_gasPrice succeed, but eth_getBalance gets HTTP 429 & eth_call gets -32005!
        if (parsed.method === 'eth_blockNumber') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: '0x100' }), { status: 200 });
        }
        if (parsed.method === 'eth_gasPrice') {
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: '0x3b9aca00' }), { status: 200 });
        }
        if (parsed.method === 'eth_getBalance') {
          return new Response('Too Many Requests', { status: 429 });
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32005, message: 'limit exceeded' } }),
          { status: 200 }
        );
      }

      // Healthy backup RPC
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return new Response(
        JSON.stringify(
          arr.map((r: { id: number; method: string }) => {
            if (r.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: r.id, result: '0x200' };
            if (r.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: r.id, result: '0x3b9aca00' };
            if (r.method === 'eth_getBalance') return { jsonrpc: '2.0', id: r.id, result: '0xde0b6b3a7640000' };
            return { jsonrpc: '2.0', id: r.id, result: mcOk };
          })
        ),
        { status: 200 }
      );
    },
    async () => {
      const res = await evmJsonRpcBatch(
        [rpcNoBatchPartial, rpcHealthy],
        [
          { id: 1, method: 'eth_blockNumber', params: [] },
          { id: 2, method: 'eth_gasPrice', params: [] },
          { id: 3, method: 'eth_getBalance', params: [USER, 'latest'] },
          { id: 4, method: 'eth_call', params: [{ to: EVM_CHAINS.ethereum.multicall3, data: '0x82ad56cb00' }, 'latest'] },
        ]
      );
      const byId = new Map(res.map((r) => [r.id, r]));
      assert.equal(callsByHost.get(rpcNoBatchPartial), 5, 'Should attempt 1 batch + 4 single calls on RPC 1');
      assert.equal(callsByHost.get(rpcHealthy), 1, 'Must fail over to healthy RPC 2 after partial single-call failure');
      assert.equal(byId.get(1)?.result, '0x200');
      assert.equal(byId.get(3)?.result, '0xde0b6b3a7640000');
      assert.equal(byId.get(4)?.result, mcOk);
    }
  );
});

test('HIGH-06: evmJsonRpcCall short-circuits ONLY on genuine reverts and fails over on rate-limit errors so simulateBurnTransferOnchain never false-positives SKIP_HONEYPOT', async () => {
  const rpc1 = 'https://rpc1.test';
  const rpc2 = 'https://rpc2.test';

  // Case A: Genuine revert (code 3) short-circuits on RPC 1 without hitting RPC 2
  const revertCalls: string[] = [];
  await withMockedFetch(
    async (url) => {
      revertCalls.push(url);
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted: HoneypotLocked' } }),
        { status: 200 }
      );
    },
    async () => {
      const res = await evmJsonRpcCall<string>([rpc1, rpc2], 'eth_call', [{ to: TOKEN_HONEYPOT_HIGH_LP, data: '0xa9059cbb' }]);
      assert.deepEqual(revertCalls, [rpc1], 'Genuine code 3 revert must short-circuit immediately');
      assert.equal(res.error?.code, 3);
    }
  );

  // Case B: Rate-limit (-32005) on RPC 1 fails over to RPC 2 and returns success
  const failoverCalls: string[] = [];
  await withMockedFetch(
    async (url) => {
      failoverCalls.push(url);
      if (url === rpc1) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + padUint256(1n) }), { status: 200 });
    },
    async () => {
      const res = await evmJsonRpcCall<string>([rpc1, rpc2], 'eth_call', [{ to: TOKEN_LEGIT_LIQUID, data: '0xa9059cbb' }]);
      assert.deepEqual(failoverCalls, [rpc1, rpc2], 'Rate-limit error must fail over to RPC 2');
      assert.equal(res.result, '0x' + padUint256(1n));
      assert.equal(res.error, undefined);
    }
  );

  // Case C: simulateBurnTransferOnchain when first Ethereum RPCs return -32005 and last RPC succeeds
  const ethUrls = EVM_CHAINS.ethereum.rpcUrls;
  let ethAttempt = 0;
  await withMockedFetch(
    async () => {
      ethAttempt += 1;
      if (ethAttempt < ethUrls.length) {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' + padUint256(1n) }), { status: 200 });
    },
    async () => {
      const sim = await simulateBurnTransferOnchain({
        chain: 'ethereum',
        walletAddress: USER,
        tokenAddress: TOKEN_LEGIT_LIQUID,
        rawAmount: 1000n,
      });
      assert.equal(sim.safeToBurn, true, 'Rate-limited RPC failover must NOT mislabel valid token as honeypot');
      assert.equal(ethAttempt, ethUrls.length);
    }
  );

  // Case D: simulateBurnTransferOnchain when EVERY RPC returns -32005 -> isolated, NOT mislabeled as honeypot
  await withMockedFetch(
    async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: '429 limit exceeded' } }),
        { status: 200 }
      ),
    async () => {
      const sim = await simulateBurnTransferOnchain({
        chain: 'ethereum',
        walletAddress: USER,
        tokenAddress: TOKEN_LEGIT_LIQUID,
        rawAmount: 1000n,
      });
      assert.equal(sim.safeToBurn, true, 'Total rate-limit outage must NOT false-positive SKIP_HONEYPOT');
    }
  );
});

// =========================================================================
// 2. HIGH-05: Alchemy Token Discovery Metadata, Pagination & Network Slugs
// =========================================================================

test('HIGH-05: ALCHEMY_NETWORK_SUBDOMAINS covers all supported chains including avalanche and mantle', () => {
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.avalanche, 'avax-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.mantle, 'mantle-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.bnb, 'bnb-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.linea, 'linea-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.scroll, 'scroll-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.blast, 'blast-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.unichain, 'unichain-mainnet');
  assert.equal(ALCHEMY_NETWORK_SUBDOMAINS.worldchain, 'worldchain-mainnet');
});

test('HIGH-05: decodeAbiStringOrBytes32 decodes standard ABI strings and MKR-style bytes32', () => {
  assert.equal(decodeAbiStringOrBytes32(encodeAbiString('USDC')), 'USDC');
  assert.equal(decodeAbiStringOrBytes32(encodeAbiString('Wrapped BTC')), 'Wrapped BTC');
  assert.equal(decodeAbiStringOrBytes32(encodeBytes32String('MKR')), 'MKR');
  assert.equal(decodeAbiStringOrBytes32('0x' + '0'.repeat(64)), null);
});

test('HIGH-05: discoverChainTokens paginates Alchemy pageKey and resolves real ERC-20 decimals/symbol/name via Multicall3 and alchemy_getTokenMetadata fallback', async () => {
  const seenUrls: string[] = [];
  const seenPageKeys: Array<string | undefined> = [];
  let metadataBatchCalls = 0;

  await withEnv(
    { SIM_API_KEY: undefined, MORALIS_API_KEY: undefined, ALCHEMY_API_KEY: 'test-alchemy-key' },
    async () => {
      await withMockedFetch(
        async (url, init) => {
          seenUrls.push(url);
          const body = JSON.parse(String(init?.body ?? '{}'));

          // Batch alchemy_getTokenMetadata fallback (for TOKEN_ZERO_DEC whose Multicall3 subcalls failed)
          if (Array.isArray(body) && body[0]?.method === 'alchemy_getTokenMetadata') {
            metadataBatchCalls += 1;
            return new Response(
              JSON.stringify(
                body.map((req: { id: number; params: string[] }) => {
                  const addr = req.params[0].toLowerCase();
                  if (addr === TOKEN_ZERO_DEC.toLowerCase()) {
                    return {
                      jsonrpc: '2.0',
                      id: req.id,
                      result: { decimals: 0, symbol: 'WHOLE', name: 'Zero Decimal Token' },
                    };
                  }
                  return { jsonrpc: '2.0', id: req.id, result: {} };
                })
              ),
              { status: 200 }
            );
          }

          if (body.method === 'alchemy_getTokenBalances') {
            const pk = body.params?.[2]?.pageKey as string | undefined;
            seenPageKeys.push(pk);

            if (!pk) {
              // Page 1: USDC (6 dec) + zero-balance skipped + WBTC (8 dec) + pageKey -> page-2
              return new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  result: {
                    tokenBalances: [
                      { contractAddress: TOKEN_USDC, tokenBalance: '0x' + (500_000_000n).toString(16) },
                      { contractAddress: '0x0000000000000000000000000000000000000001', tokenBalance: '0x0' },
                      { contractAddress: TOKEN_WBTC, tokenBalance: '0x' + (15_000_000n).toString(16) },
                    ],
                    pageKey: 'page-2',
                  },
                }),
                { status: 200 }
              );
            }

            if (pk === 'page-2') {
              // Page 2: duplicate USDC (deduped) + MKR (bytes32 symbol/name) + TOKEN_ZERO_DEC (Multicall3 miss -> alchemy_getTokenMetadata fallback)
              return new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  result: {
                    tokenBalances: [
                      { contractAddress: TOKEN_USDC, tokenBalance: '0x' + (500_000_000n).toString(16) },
                      { contractAddress: TOKEN_MKR, tokenBalance: '0x' + (2n * 10n ** 18n).toString(16) },
                      { contractAddress: TOKEN_ZERO_DEC, tokenBalance: '0x' + (42n).toString(16) },
                    ],
                  },
                }),
                { status: 200 }
              );
            }
          }

          // Multicall3 metadata probe: decimals() 0x313ce567, symbol() 0x95d89b41, name() 0x06fdde03
          if (body.method === 'eth_call') {
            const callData = String(body.params?.[0]?.data ?? '0x');
            const subcalls = decodeMulticall3InputCalls(callData);
            const results = subcalls.map((sc) => {
              const t = sc.target.toLowerCase();
              const sel = sc.callData.toLowerCase();
              if (t === TOKEN_USDC.toLowerCase()) {
                if (sel === '0x313ce567') return { success: true, returnData: '0x' + padUint256(6n) };
                if (sel === '0x95d89b41') return { success: true, returnData: encodeAbiString('USDC') };
                if (sel === '0x06fdde03') return { success: true, returnData: encodeAbiString('USD Coin') };
              }
              if (t === TOKEN_WBTC.toLowerCase()) {
                if (sel === '0x313ce567') return { success: true, returnData: '0x' + padUint256(8n) };
                if (sel === '0x95d89b41') return { success: true, returnData: encodeAbiString('WBTC') };
                if (sel === '0x06fdde03') return { success: true, returnData: encodeAbiString('Wrapped BTC') };
              }
              if (t === TOKEN_MKR.toLowerCase()) {
                if (sel === '0x313ce567') return { success: true, returnData: '0x' + padUint256(18n) };
                if (sel === '0x95d89b41') return { success: true, returnData: encodeBytes32String('MKR') };
                if (sel === '0x06fdde03') return { success: true, returnData: encodeBytes32String('Maker') };
              }
              return { success: false, returnData: '0x' };
            });
            return new Response(
              JSON.stringify({ jsonrpc: '2.0', id: body.id, result: encodeMulticall3Return(results) }),
              { status: 200 }
            );
          }

          return new Response(JSON.stringify({ error: { code: -32601, message: 'not found' } }), { status: 404 });
        },
        async () => {
          const avaxTokens = await discoverChainTokens('avalanche', USER, 24);
          assert.ok(
            seenUrls.some((u) => u.startsWith('https://avax-mainnet.g.alchemy.com/v2/')),
            'Avalanche must query avax-mainnet Alchemy endpoint'
          );
          assert.deepEqual(seenPageKeys, [undefined, 'page-2'], 'Must paginate via Alchemy pageKey');
          assert.equal(metadataBatchCalls, 1, 'Must fall back to alchemy_getTokenMetadata for Multicall3 misses');
          assert.equal(avaxTokens.length, 4);

          const byAddr = new Map(avaxTokens.map((t) => [t.address.toLowerCase(), t]));
          assert.equal(byAddr.get(TOKEN_USDC.toLowerCase())?.decimals, 6);
          assert.equal(byAddr.get(TOKEN_USDC.toLowerCase())?.symbol, 'USDC');
          assert.equal(byAddr.get(TOKEN_USDC.toLowerCase())?.name, 'USD Coin');

          assert.equal(byAddr.get(TOKEN_WBTC.toLowerCase())?.decimals, 8);
          assert.equal(byAddr.get(TOKEN_WBTC.toLowerCase())?.symbol, 'WBTC');
          assert.equal(byAddr.get(TOKEN_WBTC.toLowerCase())?.name, 'Wrapped BTC');

          assert.equal(byAddr.get(TOKEN_MKR.toLowerCase())?.decimals, 18);
          assert.equal(byAddr.get(TOKEN_MKR.toLowerCase())?.symbol, 'MKR');
          assert.equal(byAddr.get(TOKEN_MKR.toLowerCase())?.name, 'Maker');

          assert.equal(byAddr.get(TOKEN_ZERO_DEC.toLowerCase())?.decimals, 0);
          assert.equal(byAddr.get(TOKEN_ZERO_DEC.toLowerCase())?.symbol, 'WHOLE');
          assert.equal(byAddr.get(TOKEN_ZERO_DEC.toLowerCase())?.name, 'Zero Decimal Token');

          // Ensure ZERO fake 0xABCD symbols exist
          for (const t of avaxTokens) {
            assert.ok(!/^0X[0-9A-F]{4}$/.test(t.symbol), `Found fake address-prefix symbol ${t.symbol}`);
          }
        }
      );
    }
  );
});

// =========================================================================
// 3. HIGH-07: Honeypot Simulation, Quote-Side DexScreener & Slippage Cap
// =========================================================================

test('HIGH-07: fetchDexLiquidityBatch matches pair.quoteToken.address with derived USD price and ignores unqueried quote tokens', async () => {
  const unqueriedBase = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const unqueriedQuote = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  await withMockedFetch(
    async () =>
      new Response(
        JSON.stringify([
          // Queried token appears ONLY on the quote side!
          // 1 baseToken = 0.00001 quoteToken = $0.02 => quoteToken = $2,000
          {
            dexId: 'uniswap',
            baseToken: { address: unqueriedBase },
            quoteToken: { address: TOKEN_QUOTE_SIDE },
            priceUsd: '0.02',
            priceNative: '0.00001',
            liquidity: { usd: 450_000 },
            volume: { h24: 120_000 },
          },
          // Another pair where queried token is baseToken, quoteToken is NOT queried
          {
            dexId: 'aerodrome',
            baseToken: { address: TOKEN_LEGIT_LIQUID },
            quoteToken: { address: unqueriedQuote },
            priceUsd: '1.50',
            priceNative: '0.0005',
            liquidity: { usd: 80_000 },
            volume: { h24: 25_000 },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      const status = await fetchDexLiquidityBatchWithStatus('base', [TOKEN_QUOTE_SIDE, TOKEN_LEGIT_LIQUID]);
      assert.equal(status.ok, true);
      const quoteInfo = status.liquidity.get(TOKEN_QUOTE_SIDE.toLowerCase());
      assert.ok(quoteInfo, 'Quote-side token MUST be matched in fetchDexLiquidityBatch');
      assert.equal(quoteInfo.liquidityUsd, 450_000);
      assert.equal(quoteInfo.volume24hUsd, 120_000);
      assert.ok(Math.abs(quoteInfo.priceUsd - 2000) < 0.01, `Expected derived quote price ~$2000, got ${quoteInfo.priceUsd}`);

      const baseInfo = status.liquidity.get(TOKEN_LEGIT_LIQUID.toLowerCase());
      assert.ok(baseInfo);
      assert.equal(baseInfo.priceUsd, 1.5);
      assert.equal(baseInfo.liquidityUsd, 80_000);

      // Unqueried quoteToken must NOT pollute the returned map
      assert.equal(status.liquidity.has(unqueriedQuote.toLowerCase()), false);

      // Wrapper helper matches identical result
      const mapOnly = await fetchDexLiquidityBatch('base', [TOKEN_QUOTE_SIDE]);
      assert.equal(mapOnly.get(TOKEN_QUOTE_SIDE.toLowerCase())?.liquidityUsd, 450_000);
    }
  );
});

test('HIGH-07: estimateLiquidityScaledSlippageUsd & evaluateAssetRoi enforce <= 0.5 * liquidityUsd net cap and penalize $0 24h-volume skewed pools', () => {
  // Core adversarial scenario: $100,000 nominal token on a $2,501 LP pool
  const liq = 2_501;
  const gross = 100_000;
  const maxTheoreticalNet = 0.5 * liq; // $1,250.50

  // 1. Active volume pool: old 40% ceiling would have claimed $60,000 net; new cap MUST keep net <= $1,250.50
  const slipActive = estimateLiquidityScaledSlippageUsd({
    grossUsd: gross,
    liquidityUsd: liq,
    volume24hUsd: 25_000,
  });
  const netActive = gross - slipActive;
  assert.ok(slipActive > gross * 0.98, `Expected >98% slippage on $100k/$2,501 LP, got $${slipActive}`);
  assert.ok(netActive <= maxTheoreticalNet, `Net sellable $${netActive} exceeded 0.5 * LP ($${maxTheoreticalNet})`);

  // 2. $0 24h-volume skewed pool: discounted even harder (<= 0.1 * LP = $250.10)
  const slipZeroVol = estimateLiquidityScaledSlippageUsd({
    grossUsd: gross,
    liquidityUsd: liq,
    volume24hUsd: 0,
  });
  const netZeroVol = gross - slipZeroVol;
  assert.ok(netZeroVol <= 0.1 * liq + 0.01, `Zero-volume skewed pool net $${netZeroVol} exceeded 10% LP cap`);
  assert.ok(netZeroVol < netActive, 'Zero-volume pool must receive harsher slippage haircut than active pool');

  // 3. No volume provided (direct ROI call): still strictly <= 0.5 * liquidityUsd
  const slipNoVol = estimateLiquidityScaledSlippageUsd({
    grossUsd: gross,
    liquidityUsd: liq,
  });
  assert.ok(gross - slipNoVol <= maxTheoreticalNet);

  // 4. Zero liquidity => 100% slippage ($0 sellable)
  assert.equal(estimateLiquidityScaledSlippageUsd({ grossUsd: 5000, liquidityUsd: 0 }), 5000);

  // 5. Broad invariant matrix: net sellable ALWAYS <= 0.5 * liquidityUsd
  for (const [g, l, v] of [
    [100_000, 2_501, 0],
    [100_000, 2_501, 50_000],
    [10_000, 3_000, 10],
    [5_000, 5_000, undefined],
    [500, 100_000, 50_000],
    [50, 1_000, 0],
  ] as Array<[number, number, number | undefined]>) {
    const slip = estimateLiquidityScaledSlippageUsd({ grossUsd: g, liquidityUsd: l, volume24hUsd: v });
    assert.ok(
      g - slip <= 0.5 * l + 0.01,
      `Invariant violated for gross=${g}, liq=${l}, vol=${v}: net=${g - slip} > ${0.5 * l}`
    );
  }

  // 6. evaluateAssetRoi marks $100k token on $2,501 LP as negative_roi (not worth_it!)
  const skewedAsset: ScannedAsset = {
    id: 'base_skewed_0',
    chain: 'base',
    chainName: 'Base',
    address: TOKEN_SKEWED_POOL,
    symbol: 'SKEW',
    name: 'Skewed Illiquid Token',
    decimals: 18,
    kind: 'erc20',
    rawBalance: (100_000n * 10n ** 18n).toString(),
    uiBalance: 100_000,
    priceUsd: 1,
    grossUsd: 100_000,
    liquidityUsd: 2_501,
    estimatedGasUsd: 0.05,
    batchedGasUsd: 0.03,
    estimatedSlippageUsd: 0,
    netUsdcSingle: 100_000,
    netUsdcBatched: 100_000,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Test',
    selectedByDefault: true,
    honeypotSafe: true,
  };
  const roi = evaluateAssetRoi(skewedAsset);
  assert.ok(roi.netRoiUsd <= 0.5 * 2_501, `evaluateAssetRoi net ${roi.netRoiUsd} exceeded 0.5 * LP`);
  assert.equal(roi.roiVerdict, 'negative_roi');
  assert.equal(roi.shouldIncludeByDefault, false);
});

test('HIGH-07: end-to-end scanLiveWallet catches >= $2,500 LP honeypot as SKIP_HONEYPOT, preserves quote-side token, and caps $100k/$2,501 LP skewed valuation', async () => {
  clearPriceCache();

  await withEnv(
    { SIM_API_KEY: undefined, MORALIS_API_KEY: undefined, ALCHEMY_API_KEY: undefined },
    async () => {
      await withMockedFetch(
        async (url, init) => {
          if (url.includes('coins.llama.fi')) {
            return new Response(
              JSON.stringify({
                coins: {
                  'coingecko:ethereum': { price: 2500 },
                  'coingecko:solana': { price: 150 },
                },
              }),
              { status: 200 }
            );
          }

          if (url.includes('api.rabby.io')) {
            return new Response('[]', { status: 200 });
          }

          // Base Blockscout returns 4 novel ERC-20s:
          // 1) TOKEN_HONEYPOT_HIGH_LP: $25,000 locked LP, reverts on transfer()
          // 2) TOKEN_LEGIT_LIQUID: $250,000 LP, transfers cleanly
          // 3) TOKEN_QUOTE_SIDE: $400,000 LP, appears ONLY as quoteToken on DexScreener, transfers cleanly
          // 4) TOKEN_SKEWED_POOL: $100,000 nominal on $2,501 LP with $0 24h volume, transfers cleanly
          if (url.includes('base.blockscout.com')) {
            return new Response(
              JSON.stringify([
                {
                  value: (50_000n * 10n ** 18n).toString(),
                  token: {
                    address_hash: TOKEN_HONEYPOT_HIGH_LP,
                    symbol: 'PHISH',
                    name: 'Transfer-Locked Phish',
                    decimals: '18',
                    type: 'ERC-20',
                    exchange_rate: null,
                  },
                },
                {
                  value: (200n * 10n ** 18n).toString(),
                  token: {
                    address_hash: TOKEN_LEGIT_LIQUID,
                    symbol: 'LEGIT',
                    name: 'Legit Liquid Token',
                    decimals: '18',
                    type: 'ERC-20',
                    exchange_rate: null,
                  },
                },
                {
                  value: (100n * 10n ** 18n).toString(),
                  token: {
                    address_hash: TOKEN_QUOTE_SIDE,
                    symbol: 'QTOK',
                    name: 'Quote Side Token',
                    decimals: '18',
                    type: 'ERC-20',
                    exchange_rate: null,
                  },
                },
                {
                  value: (100_000n * 10n ** 18n).toString(),
                  token: {
                    address_hash: TOKEN_SKEWED_POOL,
                    symbol: 'SKEW100K',
                    name: 'Skewed 100k Pool Token',
                    decimals: '18',
                    type: 'ERC-20',
                    exchange_rate: null,
                  },
                },
              ]),
              { status: 200 }
            );
          }

          if (
            url.includes('blockscout.com') ||
            url.includes('ethplorer.io') ||
            url.includes('routescan.io') ||
            url.includes('explorer.alchemy.com')
          ) {
            return new Response(JSON.stringify({ items: [] }), { status: 200 });
          }

          if (url.includes('api.dexscreener.com/tokens/v1/base/')) {
            return new Response(
              JSON.stringify([
                {
                  dexId: 'uniswap',
                  baseToken: { address: TOKEN_HONEYPOT_HIGH_LP },
                  quoteToken: { address: EVM_CHAINS.base.usdcAddress },
                  priceUsd: '1.00',
                  priceNative: '1.00',
                  liquidity: { usd: 25_000 }, // >= $2,500 locked LP honeypot!
                  volume: { h24: 10_000 },
                },
                {
                  dexId: 'aerodrome',
                  baseToken: { address: TOKEN_LEGIT_LIQUID },
                  quoteToken: { address: EVM_CHAINS.base.usdcAddress },
                  priceUsd: '2.00',
                  priceNative: '2.00',
                  liquidity: { usd: 250_000 },
                  volume: { h24: 90_000 },
                },
                {
                  dexId: 'uniswap',
                  baseToken: { address: '0xcccccccccccccccccccccccccccccccccccccccc' },
                  quoteToken: { address: TOKEN_QUOTE_SIDE },
                  priceUsd: '0.50',
                  priceNative: '0.25', // => quoteToken = $2.00
                  liquidity: { usd: 400_000 },
                  volume: { h24: 150_000 },
                },
                {
                  dexId: 'uniswap',
                  baseToken: { address: TOKEN_SKEWED_POOL },
                  quoteToken: { address: EVM_CHAINS.base.usdcAddress },
                  priceUsd: '1.00',
                  priceNative: '1.00',
                  liquidity: { usd: 2_501 },
                  volume: { h24: 0 }, // $0 24h volume skewed pool!
                },
              ]),
              { status: 200 }
            );
          }

          if (url.includes('api.dexscreener.com')) {
            return new Response('[]', { status: 200 });
          }

          // EVM JSON-RPC handler
          const parsed = JSON.parse(String(init?.body ?? '{}'));
          const respondOne = (req: { id: number; method: string; params?: unknown[] }) => {
            if (req.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: req.id, result: '0x100000' };
            if (req.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: req.id, result: '0x3b9aca00' };
            if (req.method === 'eth_getBalance') return { jsonrpc: '2.0', id: req.id, result: '0x0' };
            if (req.method === 'eth_call') {
              const callObj = (req.params?.[0] ?? {}) as { to?: string; data?: string };
              const to = String(callObj.to ?? '').toLowerCase();
              const data = String(callObj.data ?? '0x').toLowerCase();
              if (data.startsWith('0x82ad56cb')) {
                const subcalls = decodeMulticall3InputCalls(data);
                return {
                  jsonrpc: '2.0',
                  id: req.id,
                  result: encodeMulticall3Return(subcalls.map(() => ({ success: false, returnData: '0x' }))),
                };
              }
              if (data.startsWith('0xa9059cbb')) {
                if (to === TOKEN_HONEYPOT_HIGH_LP.toLowerCase()) {
                  return {
                    jsonrpc: '2.0',
                    id: req.id,
                    error: { code: 3, message: 'execution reverted: TransferLockedByOwner' },
                  };
                }
                return { jsonrpc: '2.0', id: req.id, result: '0x' + padUint256(1n) };
              }
              return { jsonrpc: '2.0', id: req.id, result: '0x' + padUint256(0n) };
            }
            return { jsonrpc: '2.0', id: req.id, result: '0x0' };
          };

          const payload = Array.isArray(parsed) ? parsed.map(respondOne) : respondOne(parsed);
          return new Response(JSON.stringify(payload), { status: 200 });
        },
        async () => {
          const report = await scanLiveWallet(USER, 'HIGH-07 Adversarial Scan');

          // 1. >= $2,500 LP transfer-locked phishing token MUST be caught as SKIP_HONEYPOT
          const phish = report.assets.find((a) => a.address.toLowerCase() === TOKEN_HONEYPOT_HIGH_LP.toLowerCase());
          assert.ok(phish, 'High-LP honeypot should be present in report');
          assert.equal(phish.action, 'SKIP_HONEYPOT');
          assert.equal(phish.honeypotSafe, false);
          assert.equal(phish.selectedByDefault, false);
          assert.equal(report.totals.honeypotSkippedCount, 1);

          // 2. Legit liquid token passes simulation and stays SELL_AND_BRIDGE
          const legit = report.assets.find((a) => a.address.toLowerCase() === TOKEN_LEGIT_LIQUID.toLowerCase());
          assert.ok(legit);
          assert.equal(legit.action, 'SELL_AND_BRIDGE');
          assert.equal(legit.honeypotSafe, true);
          assert.equal(legit.selectedByDefault, true);

          // 3. Legit quote-side token is matched via quoteToken and classified SELL_AND_BRIDGE (NOT BURN_ZERO_LIQUIDITY)
          const quoteTok = report.assets.find((a) => a.address.toLowerCase() === TOKEN_QUOTE_SIDE.toLowerCase());
          assert.ok(quoteTok, 'Quote-side token should appear in report');
          assert.equal(quoteTok.action, 'SELL_AND_BRIDGE');
          assert.equal(quoteTok.liquidityUsd, 400_000);
          assert.ok(Math.abs(quoteTok.priceUsd - 2) < 0.01);
          assert.equal(quoteTok.selectedByDefault, true);

          // 4. $100k token on $2,501 LP ($0 24h volume) MUST NEVER claim net > 0.5 * LP ($1,250.50) and MUST be auto-pruned
          const skewed = report.assets.find((a) => a.address.toLowerCase() === TOKEN_SKEWED_POOL.toLowerCase());
          assert.ok(skewed, 'Skewed pool token should appear in report');
          assert.ok(skewed.netUsdcBatched <= 0.5 * 2_501, `Expected netUsdcBatched <= $1,250.50, got ${skewed.netUsdcBatched}`);
          assert.ok(skewed.netUsdcSingle <= 0.5 * 2_501, `Expected netUsdcSingle <= $1,250.50, got ${skewed.netUsdcSingle}`);
          assert.ok((skewed.netRoiUsd ?? 0) <= 0.1 * 2_501 + 0.01, `Expected $0-volume netRoiUsd <= $250.10, got ${skewed.netRoiUsd}`);
          assert.equal(skewed.roiVerdict, 'negative_roi');
          assert.equal(skewed.selectedByDefault, false);

          // Portfolio totals must ONLY reflect LEGIT ($400) + QTOK ($200) = $600 gross, NOT $50k phish or $100k skewed!
          assert.ok(report.totals.grossUsd < 1000, `Inflated grossUsd detected: ${report.totals.grossUsd}`);
          assert.ok(report.totals.netSolanaUsdc < 1000, `Inflated netSolanaUsdc detected: ${report.totals.netSolanaUsdc}`);
        }
      );
    }
  );
});
