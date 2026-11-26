import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { PreservationAgentStore } from '../src/agent/preservation-agents.js';
import {
  scanReclaimableSolanaRent,
  SOLANA_TOKEN_2022_PROGRAM_ID,
} from '../src/bridge/solana-rent.js';
import { SOLANA_TOKEN_PROGRAM_ID } from '../src/bridge/cctp.js';
import {
  decodeEthenaCooldown,
  decodeLidoWithdrawalRequestIds,
  decodeLidoWithdrawalStatuses,
} from '../src/defi/unlock-readers.js';
import {
  JupiterMarketsClient,
  verifyJupiterTransactionBase64,
} from '../src/degen/jupiter-markets.js';
import { buildUnlockSchedule } from '../src/execution/preservation-optimizer.js';
import {
  fetchMayanSwiftQuote,
  runLiveParallelRouteAuction,
} from '../src/execution/route-auction.js';
import {
  broadcastSignedRelayerTx,
  deriveEvmAddressFromPrivateKey,
  getChainRelayerCaps,
  resetRelayerNonceTrackerForTest,
  signEip1559Transaction,
} from '../src/relayer/broadcaster.js';
import {
  buildGaslessSweepIntent,
  clearTrackedGaslessIntentsForTest,
  computeGaslessIntentEip712Digest,
  configureGaslessIntentStore,
  encodePermit2SweepCalldata,
  isGaslessDigestConsumed,
  submitAndBroadcastSignedGaslessIntent,
} from '../src/relayer/sponsor.js';
import { scanStaleErc20Approvals } from '../src/scanner/approvals.js';
import {
  computePreservationFee,
  EVM_CHAINS,
  getProtocolFeeConfig,
} from '../src/scanner/chains.js';
import {
  configureRpcCircuitBreaker,
  decodeMulticall3Aggregate3,
  evmJsonRpcBatch,
  evmJsonRpcCall,
  getRpcCircuitBreakerMetrics,
  redactRpcUrl,
  resetRpcCircuitBreaker,
} from '../src/scanner/rpc.js';
import type { ScannedAsset, ScanReport } from '../src/scanner/types.js';
import { createTurgaliumServer } from '../src/server/app.js';
import { parseServerPort } from '../src/server/index.js';
import { extractRateLimitKey, SlidingWindowRateLimiter } from '../src/server/rate-limit.js';
import {
  buildSolanaYieldParkPlan,
  SOLANA_JUPSOL_MINT,
  SOLANA_USDC_MINT,
} from '../src/solana/yield-park.js';
import { FileStateStore, MemoryStateStore } from '../src/storage/state-store.js';

const SOL_USER_A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const SOL_USER_B = Keypair.generate().publicKey.toBase58();
const VALID_BLOCKHASH = '11111111111111111111111111111111';
const SAMPLE_EVM = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';

function makeTestEvmWallet(seedByte: number): { privKeyHex: string; address: string } {
  const privBytes = new Uint8Array(32).fill(seedByte);
  const privKeyHex = '0x' + Buffer.from(privBytes).toString('hex');
  const address = deriveEvmAddressFromPrivateKey(privKeyHex);
  return { privKeyHex, address };
}

function signDigestLowS(digestHex: string, privKeyHex: string): string {
  const digestBytes = Buffer.from(digestHex.replace(/^0x/, ''), 'hex');
  const privBytes = Buffer.from(privKeyHex.replace(/^0x/, ''), 'hex');
  const sig = secp256k1.sign(digestBytes, privBytes, { lowS: true });
  const r = sig.r.toString(16).padStart(64, '0');
  const s = sig.s.toString(16).padStart(64, '0');
  const v = (27 + sig.recovery).toString(16).padStart(2, '0');
  return `0x${r}${s}${v}`;
}

function makeUsdcAsset(overrides: Partial<ScannedAsset> = {}): ScannedAsset {
  return {
    id: 'base:usdc',
    chain: 'base',
    chainName: 'Base',
    address: EVM_CHAINS.base.usdcAddress,
    symbol: 'USDC',
    name: 'USD Coin',
    kind: 'erc20',
    decimals: 6,
    rawBalance: '500000000',
    uiBalance: 500,
    priceUsd: 1,
    grossUsd: 500,
    liquidityUsd: 10_000_000,
    estimatedGasUsd: 0.2,
    batchedGasUsd: 0.12,
    estimatedSlippageUsd: 0,
    netUsdcSingle: 464.8,
    netUsdcBatched: 464.88,
    action: 'BRIDGE_DIRECT_USDC',
    actionReason: 'Direct USDC bridge',
    selectedByDefault: true,
    honeypotSafe: true,
    permit2Approved: true,
    eip2612Supported: true,
    ...overrides,
  };
}

function makeMinimalScanReport(assets: ScannedAsset[] = [makeUsdcAsset()]): ScanReport {
  return {
    scanId: 'scan_hardening_test',
    mode: 'live_rpc',
    walletAddress: SAMPLE_EVM,
    scannedAt: new Date().toISOString(),
    scanDurationMs: 10,
    chainsScanned: 1,
    chains: [
      {
        chain: 'base',
        chainName: 'Base',
        chainId: 8453,
        cctpDomain: 6,
        rpcStatus: 'live',
        blockNumber: 1,
        gasPriceGwei: 0.05,
        nativeSymbol: 'ETH',
        nativeBalance: 0.1,
        nativePriceUsd: 2500,
        assetCount: assets.length,
        defiCount: 0,
        liquidCount: assets.length,
        burnCount: 0,
        skippedCount: 0,
        grossUsd: assets.reduce((s, a) => s + a.grossUsd, 0),
        netUsdcBridged: assets.reduce((s, a) => s + a.netUsdcBatched, 0),
        totalGasUsd: 0.12,
        gasSavedByBatchUsd: 0.08,
        cctpAttestationSec: 15,
        needsGasSponsorship: false,
      },
    ],
    assets,
    totals: {
      grossUsd: 500,
      defiGrossUsd: 0,
      liquidGrossUsd: 500,
      protocolFeeBps: 700,
      protocolFeeUsd: 35,
      singleTxGasUsd: 0.2,
      batchedGasUsd: 0.12,
      gasSavedUsd: 0.08,
      estimatedSlippageUsd: 0,
      netSolanaUsdc: 464.88,
      solEquivalent: 3.1,
      solPriceUsd: 150,
      defiPositionCount: 0,
      liquidDustCount: 0,
      burnCandidateCount: 0,
      honeypotSkippedCount: 0,
      gasNegativeCount: 0,
    },
    warnings: [],
  };
}

function buildMockSolanaV0TxBase64(payerAddress: string): string {
  const payer = new PublicKey(payerAddress);
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: VALID_BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: payer,
        lamports: 0,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

async function withMockedFetch<T>(
  impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await impl(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = orig;
  }
}

// ============================================================================
// 1. RELAYER CALLDATA BINDING, NON-PREMATURE CONSUMPTION, NONCE LOCK & EIP-1559 CAPS
// ============================================================================

test('Relayer rejects arbitrary/mismatched txCalldata, preserves intent on transient RPC error, and enforces encodeWordUint 256-bit cap', async () => {
  const relayer = makeTestEvmWallet(0x71);
  const user = makeTestEvmWallet(0x72);
  const router = '0x4444444444444444444444444444444444444444';
  const prevKey = process.env.TURGALIUM_RELAYER_PRIVATE_KEY;
  const prevRouter = process.env.TURGALIUM_ROUTER_BASE;
  const prevFee = process.env.TURGALIUM_FEE_RECIPIENT_EVM;

  process.env.TURGALIUM_RELAYER_PRIVATE_KEY = relayer.privKeyHex;
  process.env.TURGALIUM_ROUTER_BASE = router;
  process.env.TURGALIUM_FEE_RECIPIENT_EVM = '0x5555555555555555555555555555555555555555';
  configureGaslessIntentStore(new MemoryStateStore());
  resetRelayerNonceTrackerForTest();

  try {
    const plan = buildGaslessSweepIntent({
      chain: 'base',
      assets: [makeUsdcAsset()],
      userAddress: user.address,
      solanaDestination: SOL_USER_A,
      preferredMode: 'permit2_batch',
    });
    assert.ok(plan.eip712Digest);
    const sig = signDigestLowS(plan.eip712Digest, user.privKeyHex);

    // 1. Arbitrary calldata (wrong selector 0xdeadbeef) is rejected fail-closed AND does NOT burn intent!
    await assert.rejects(
      () =>
        submitAndBroadcastSignedGaslessIntent({
          intentId: plan.intentId,
          chain: 'base',
          userAddress: user.address,
          signature: sig,
          deadline: plan.deadline,
          txCalldata: '0xdeadbeef' + '00'.repeat(32),
        }),
      /Invalid relayer txCalldata/i
    );
    assert.equal(isGaslessDigestConsumed(plan.eip712Digest), false);

    // 2. HTTP /api/relayer/submit returns 400 for arbitrary calldata and keeps intent reusable
    const { server } = createTurgaliumServer({ rateLimit: { enabled: false } });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const badHttp = await fetch(`${base}/api/relayer/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId: plan.intentId,
          chain: 'base',
          userAddress: user.address,
          signature: sig,
          deadline: plan.deadline,
          txCalldata: '0xdeadbeef00000000',
        }),
      });
      assert.equal(badHttp.status, 400);
      assert.equal(isGaslessDigestConsumed(plan.eip712Digest), false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 3. Valid bound calldata with transient RPC error rolls back in-flight guard without burning intent
    const validCalldata = encodePermit2SweepCalldata({
      plan,
      signature: sig,
      gasReimbursementUsdc: 0n,
    });
    const transientFail = await submitAndBroadcastSignedGaslessIntent({
      intentId: plan.intentId,
      chain: 'base',
      userAddress: user.address,
      signature: sig,
      deadline: plan.deadline,
      txCalldata: validCalldata,
      nonce: 1,
      gasLimit: 250_000n,
      maxFeePerGasWei: 2_000_000_000n,
      maxPriorityFeePerGasWei: 100_000_000n,
      sendRawTransaction: async () => {
        throw new Error('upstream RPC 503 temporary outage');
      },
    });
    assert.equal(transientFail.broadcasted, false);
    assert.equal(
      isGaslessDigestConsumed(plan.eip712Digest),
      false,
      'Transient RPC failure must NOT permanently burn valid user intent'
    );

    // 4. Retry succeeds and marks intent consumed
    const success = await submitAndBroadcastSignedGaslessIntent({
      intentId: plan.intentId,
      chain: 'base',
      userAddress: user.address,
      signature: sig,
      deadline: plan.deadline,
      txCalldata: validCalldata,
      nonce: 1,
      gasLimit: 250_000n,
      maxFeePerGasWei: 2_000_000_000n,
      maxPriorityFeePerGasWei: 100_000_000n,
      sendRawTransaction: async (ctx) => ctx.computedTxHash,
    });
    assert.equal(success.broadcasted, true);
    assert.equal(isGaslessDigestConsumed(plan.eip712Digest), true);

    // 5. encodeWordUint rejects >= 2^256 overflow
    assert.throws(
      () =>
        computeGaslessIntentEip712Digest({
          primaryType: 'PermitBatchWitnessTransferFrom',
          domain: {
            name: 'Permit2',
            chainId: 8453,
            verifyingContract: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
          },
          message: {
            permitted: [{ token: EVM_CHAINS.base.usdcAddress, amount: (1n << 256n).toString() }],
            spender: router,
            nonce: '1',
            deadline: '1999999999',
            witness: {
              solanaRecipient: plan.solanaMintRecipientBytes32,
              minNetUsdcOut: '1000',
              maxGasReimbursementUsdc: '100',
              feeBps: 700,
              feeRecipient: '0x5555555555555555555555555555555555555555',
              swapsHash: plan.swapsHash,
            },
          },
        }),
      /exceeds uint256 max/i
    );
  } finally {
    configureGaslessIntentStore(null);
    clearTrackedGaslessIntentsForTest();
    resetRelayerNonceTrackerForTest();
    if (prevKey === undefined) delete process.env.TURGALIUM_RELAYER_PRIVATE_KEY;
    else process.env.TURGALIUM_RELAYER_PRIVATE_KEY = prevKey;
    if (prevRouter === undefined) delete process.env.TURGALIUM_ROUTER_BASE;
    else process.env.TURGALIUM_ROUTER_BASE = prevRouter;
    if (prevFee === undefined) delete process.env.TURGALIUM_FEE_RECIPIENT_EVM;
    else process.env.TURGALIUM_FEE_RECIPIENT_EVM = prevFee;
  }
});

test('Relayer broadcaster serializes concurrent nonces per (chain, relayer) and enforces EIP-1559 fee/gas caps', async () => {
  const relayer = makeTestEvmWallet(0x73);
  const router = '0x4444444444444444444444444444444444444444';
  const calldata = '0xdeadbeef00000000000000000000000000000000000000000000000000000001';
  resetRelayerNonceTrackerForTest();

  // 1. Strict EIP-1559 signing invariants
  assert.throws(
    () =>
      signEip1559Transaction(
        {
          chainId: 0,
          nonce: 0,
          maxPriorityFeePerGasWei: 1n,
          maxFeePerGasWei: 2n,
          gasLimit: 21_000n,
          to: router,
          data: calldata,
        },
        relayer.privKeyHex
      ),
    /chainId/i
  );
  assert.throws(
    () =>
      signEip1559Transaction(
        {
          chainId: 8453,
          nonce: 0,
          maxPriorityFeePerGasWei: 10n,
          maxFeePerGasWei: 5n,
          gasLimit: 21_000n,
          to: router,
          data: calldata,
        },
        relayer.privKeyHex
      ),
    /maxPriorityFeePerGasWei cannot exceed maxFeePerGasWei/i
  );
  assert.throws(
    () =>
      signEip1559Transaction(
        {
          chainId: 8453,
          nonce: 0,
          maxPriorityFeePerGasWei: 1n,
          maxFeePerGasWei: 5n,
          gasLimit: 21_000n,
          valueWei: -1n,
          to: router,
          data: calldata,
        },
        relayer.privKeyHex
      ),
    /valueWei cannot be negative/i
  );

  // 2. Broadcaster rejects excessive maxFeePerGasWei and gasLimit
  const caps = getChainRelayerCaps('base');
  const overFeeCap = await broadcastSignedRelayerTx({
    chain: 'base',
    to: router,
    data: calldata,
    privateKeyHex: relayer.privKeyHex,
    nonce: 0,
    gasLimit: 100_000n,
    maxPriorityFeePerGasWei: 1_000_000_000n,
    maxFeePerGasWei: caps.maxFeeCapWei + 1n,
  });
  assert.equal(overFeeCap.broadcasted, false);
  assert.equal(overFeeCap.reasonCode, 'invalid_tx_params');

  const overGasCap = await broadcastSignedRelayerTx({
    chain: 'base',
    to: router,
    data: calldata,
    privateKeyHex: relayer.privKeyHex,
    nonce: 0,
    gasLimit: caps.maxGasLimit + 1n,
    maxPriorityFeePerGasWei: 100_000_000n,
    maxFeePerGasWei: 1_000_000_000n,
  });
  assert.equal(overGasCap.broadcasted, false);
  assert.equal(overGasCap.reasonCode, 'invalid_tx_params');

  // 3. RPC priority fee exceeding explicit maxFeePerGasWei is safely clamped
  const clamped = await broadcastSignedRelayerTx({
    chain: 'base',
    to: router,
    data: calldata,
    privateKeyHex: relayer.privKeyHex,
    nonce: 10,
    gasLimit: 100_000n,
    maxFeePerGasWei: 1_000_000_000n,
    rpcCall: (async (_urls, method) => {
      if (method === 'eth_gasPrice') return { result: '0x3b9aca00' };
      if (method === 'eth_maxPriorityFeePerGas') return { result: '0x2540be400' }; // 10 gwei > 1 gwei maxFee
      throw new Error(`Unexpected ${method}`);
    }) as typeof evmJsonRpcCall,
    sendRawTransaction: async (ctx) => {
      assert.equal(ctx.maxPriorityFeePerGasWei, 1_000_000_000n);
      assert.equal(ctx.maxFeePerGasWei, 1_000_000_000n);
      return ctx.computedTxHash;
    },
  });
  assert.equal(clamped.broadcasted, true);

  // 4. Concurrent broadcasts on the same (chain, relayer) serialize & get strictly distinct nonces (5, 6, 7)
  resetRelayerNonceTrackerForTest();
  const observedNonces: number[] = [];
  const staleNonceRpc = (async (_urls: string[], method: string) => {
    // RPC always returns stale pending nonce 5 (simulating lagging node mempool)
    if (method === 'eth_getTransactionCount') {
      await new Promise((r) => setTimeout(r, 10));
      return { result: '0x5' };
    }
    if (method === 'eth_gasPrice') return { result: '0x3b9aca00' };
    if (method === 'eth_maxPriorityFeePerGas') return { result: '0x5f5e100' };
    if (method === 'eth_estimateGas') return { result: '0x186a0' };
    throw new Error(`Unexpected ${method}`);
  }) as typeof evmJsonRpcCall;

  const results = await Promise.all(
    [0, 1, 2].map(() =>
      broadcastSignedRelayerTx({
        chain: 'base',
        to: router,
        data: calldata,
        privateKeyHex: relayer.privKeyHex,
        rpcCall: staleNonceRpc,
        sendRawTransaction: async (ctx) => {
          observedNonces.push(ctx.nonce);
          return ctx.computedTxHash;
        },
      })
    )
  );
  assert.ok(results.every((r) => r.broadcasted));
  assert.deepEqual(observedNonces, [5, 6, 7]);
  resetRelayerNonceTrackerForTest();
});

// ============================================================================
// 2. ADMIN AUTH GUARD ON /api/agents/approvals & MCP BEARER SCOPE ENFORCEMENT
// ============================================================================

test('POST /api/agents/approvals enforces admin session or agent:propose Bearer scope; MCP enforces per-tool scopes', async () => {
  const adminSecret = 'backtest-admin-secret-0123456789';
  const { server, agentEngine } = createTurgaliumServer({
    adminSessionToken: adminSecret,
    rateLimit: { enabled: false },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const payload = {
      client: 'ui',
      actionType: 'bridge_solana',
      summary: 'Test approval',
      sourceWallets: [SAMPLE_EVM],
      chains: ['base'],
      solanaDestination: SOL_USER_A,
      grossUsd: 50,
      estimatedNetUsdc: 46,
    };

    // Unauthenticated client='ui' and client='smart_contract_agent' MUST be rejected with 401 when adminSessionToken is set!
    const unauthUi = await fetch(`${base}/api/agents/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(unauthUi.status, 401);

    const unauthAgent = await fetch(`${base}/api/agents/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, client: 'smart_contract_agent' }),
    });
    assert.equal(unauthAgent.status, 401);

    // Bearer token lacking 'agent:propose' scope -> 403
    const readOnlyTok = agentEngine.issuePluginToken({
      label: 'Read-only MCP',
      client: 'claude_mcp',
      scopes: ['scan:read'],
    });
    const wrongScopeRes = await fetch(`${base}/api/agents/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${readOnlyTok.token}`,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(wrongScopeRes.status, 403);

    // Valid X-Turgalium-Admin-Session succeeds
    const adminOk = await fetch(`${base}/api/agents/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Turgalium-Admin-Session': adminSecret,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(adminOk.status, 200);

    // Bearer token WITH 'agent:propose' succeeds
    const proposeTok = agentEngine.issuePluginToken({
      label: 'Propose Only',
      client: 'claude_mcp',
      scopes: ['agent:propose'],
    });
    const proposeOk = await fetch(`${base}/api/agents/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${proposeTok.token}`,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(proposeOk.status, 200);

    // MCP scope enforcement: read-only token allowed on turgalium_list_agent_mandates, blocked (-32003) on turgalium_request_sweep_permission & turgalium_plan_dust_conversion
    const mcpReadOk = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${readOnlyTok.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'turgalium_list_agent_mandates', arguments: {} },
      }),
    }).then((r) => r.json());
    assert.ok(mcpReadOk.result && !mcpReadOk.error);

    const mcpProposeDenied = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${readOnlyTok.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'turgalium_request_sweep_permission',
          arguments: {
            actionType: 'bridge_solana',
            summary: 'Should be blocked',
            sourceWallets: [SAMPLE_EVM],
            chains: ['base'],
            solanaDestination: SOL_USER_A,
            grossUsd: 50,
            estimatedNetUsdc: 45,
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(mcpProposeDenied.error?.code, -32003);

    const mcpDustDenied = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${readOnlyTok.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'turgalium_plan_dust_conversion', arguments: { scanId: 'scan_1' } },
      }),
    }).then((r) => r.json());
    assert.equal(mcpDustDenied.error?.code, -32003);

    // propose-only token denied on scan:read tools
    const mcpReadDenied = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${proposeTok.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'turgalium_list_agent_mandates', arguments: {} },
      }),
    }).then((r) => r.json());
    assert.equal(mcpReadDenied.error?.code, -32003);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ============================================================================
// 3. RATE LIMITER KEY HYGIENE & PROXY TRUST + 4. STRICT HTML CSP HEADER
// ============================================================================

test('Rate limiter ignores unverified Bearer tokens, gates Fly-Client-IP on FLY_APP_NAME, and uses rightmost X-Forwarded-For', () => {
  const mkReq = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    ({
      headers,
      socket: { remoteAddress },
    }) as unknown as IncomingMessage;

  // Unverified Bearer header MUST still bucket by IP (not token)
  const k1 = extractRateLimitKey(mkReq({ authorization: 'Bearer random-attacker-1' }, '10.0.0.1'));
  const k2 = extractRateLimitKey(mkReq({ authorization: 'Bearer random-attacker-2' }, '10.0.0.1'));
  assert.equal(k1, 'ip:10.0.0.1');
  assert.equal(k2, 'ip:10.0.0.1');

  // Verified token ID gets its own hashed token bucket
  const kVerified = extractRateLimitKey(mkReq({}, '10.0.0.1'), false, {
    verifiedTokenId: 'tok_verified_abc',
  });
  assert.ok(kVerified.startsWith('token:'));

  // Under trustProxy without FLY_APP_NAME: Fly-Client-IP is ignored and rightmost X-Forwarded-For is used
  const kXff = extractRateLimitKey(
    mkReq(
      {
        'fly-client-ip': '203.0.113.99',
        'x-forwarded-for': '198.51.100.1, 198.51.100.2, 192.0.2.55',
      },
      '10.0.0.1'
    ),
    true,
    { trustFlyClientIp: false }
  );
  assert.equal(kXff, 'ip:192.0.2.55');

  // When FLY_APP_NAME is set (trustFlyClientIp: true): Fly-Client-IP is honored
  const kFly = extractRateLimitKey(
    mkReq(
      {
        'fly-client-ip': '203.0.113.99',
        'x-forwarded-for': '198.51.100.1, 192.0.2.55',
      },
      '10.0.0.1'
    ),
    true,
    { trustFlyClientIp: true }
  );
  assert.equal(kFly, 'ip:203.0.113.99');

  // Limiter picks up trustFlyClientIp from env.FLY_APP_NAME
  const limiterNoFly = new SlidingWindowRateLimiter({ trustProxy: true }, {});
  assert.equal(limiterNoFly.trustFlyClientIp, false);
  const limiterWithFly = new SlidingWindowRateLimiter({}, { FLY_APP_NAME: 'turgalium-prod' });
  assert.equal(limiterWithFly.trustFlyClientIp, true);
  assert.equal(limiterWithFly.trustProxy, true);
});

test('Served HTML documents include strict Content-Security-Policy header', async () => {
  const { server } = createTurgaliumServer({ rateLimit: { enabled: false } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(csp.includes("base-uri 'self'"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ============================================================================
// 5. MULTICALL3 ABI BOUNDS & multicallChunkSize VALIDATION + 6. RPC URL REDACTION
// ============================================================================

test('decodeMulticall3Aggregate3 enforces strict hex, even length, offset, count <= 1000, and slice bounds', () => {
  assert.deepEqual(decodeMulticall3Aggregate3('0xzzzz' + '00'.repeat(64)), []);
  assert.deepEqual(decodeMulticall3Aggregate3('0x' + '0'.repeat(129)), []); // odd length
  // Huge arrayOffset
  assert.deepEqual(decodeMulticall3Aggregate3('0x' + 'ff'.repeat(32) + '00'.repeat(32)), []);
  // Count = 1001 (> 1000 cap)
  const count1001 = (1001).toString(16).padStart(64, '0');
  assert.deepEqual(
    decodeMulticall3Aggregate3('0x' + '20'.padStart(64, '0') + count1001 + '00'.repeat(64)),
    []
  );
  // Valid offset & count=1, but itemStart out of bounds
  assert.deepEqual(
    decodeMulticall3Aggregate3(
      '0x' +
        '20'.padStart(64, '0') +
        '1'.padStart(64, '0') +
        'ffff'.padStart(64, '0')
    ),
    []
  );
});

test('Approval routes validate multicallChunkSize (400) and scanStaleErc20Approvals guards NaN chunk/timeout', async () => {
  const { server } = createTurgaliumServer({ rateLimit: { enabled: false } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    for (const badChunk of ['NaN', 0, -5, 201, 12.5, null]) {
      const res = await fetch(`${base}/api/approvals/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain: 'base',
          walletAddress: SAMPLE_EVM,
          multicallChunkSize: badChunk,
        }),
      });
      assert.equal(res.status, 400, `Expected 400 for multicallChunkSize=${String(badChunk)}`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Unit call with NaN multicallChunkSize & timeoutMs completes cleanly (no infinite loop!)
  const unitRes = await scanStaleErc20Approvals(
    'base',
    SAMPLE_EVM,
    [EVM_CHAINS.base.usdcAddress],
    ['0x000000000022D473030F116dDEE9F6B43aC78BA3'],
    {
      multicallChunkSize: Number.NaN,
      timeoutMs: Number.NaN,
      rpcCall: async () => ({ result: '0x' }),
    }
  );
  assert.equal(unitRes.scannedPairs, 1);
});

test('redactRpcUrl strips API keys, credentials, paths, and queries in metrics and thrown errors', async () => {
  assert.equal(
    redactRpcUrl('https://user:pass@eth-mainnet.g.alchemy.com:8443/v2/SECRET_KEY_123?api-key=abc#frag'),
    'https://eth-mainnet.g.alchemy.com:8443'
  );
  assert.equal(redactRpcUrl('https://mainnet.helius-rpc.com/?api-key=HELIUS_SECRET'), 'https://mainnet.helius-rpc.com');

  const secretRpc = 'https://eth-mainnet.g.alchemy.com/v2/SUPER_SECRET_ALCHEMY_KEY?token=999';
  resetRpcCircuitBreaker();
  configureRpcCircuitBreaker({ circuitBreakerCooldownMs: 60_000, nowMs: () => 1_000_000 });

  try {
    await withMockedFetch(
      async () => new Response('Rate limited', { status: 429 }),
      async () => {
        await assert.rejects(
          () => evmJsonRpcCall([secretRpc], 'eth_blockNumber', []),
          (err: Error) => {
            assert.ok(!err.message.includes('SUPER_SECRET_ALCHEMY_KEY'));
            assert.ok(!err.message.includes('token=999'));
            assert.ok(err.message.includes('https://eth-mainnet.g.alchemy.com'));
            return true;
          }
        );

        await assert.rejects(
          () => evmJsonRpcBatch([secretRpc], [{ id: 1, method: 'eth_blockNumber', params: [] }]),
          (err: Error) => {
            assert.ok(!err.message.includes('SUPER_SECRET_ALCHEMY_KEY'));
            return true;
          }
        );

        const metrics = getRpcCircuitBreakerMetrics(1_000_000);
        assert.equal(metrics.openEndpoints.length, 1);
        assert.equal(metrics.openEndpoints[0].url, 'https://eth-mainnet.g.alchemy.com');
        assert.ok(!(metrics.openEndpoints[0].lastError ?? '').includes('SUPER_SECRET_ALCHEMY_KEY'));
      }
    );

    const secretSolRpc = 'https://mainnet.helius-rpc.com/?api-key=TOP_SECRET_HELIUS_987';
    await withMockedFetch(
      async () => new Response('Unauthorized', { status: 403 }),
      async () => {
        await assert.rejects(
          () =>
            scanReclaimableSolanaRent(SOL_USER_A, {
              rpcUrls: [secretSolRpc],
              skipPriceFetch: true,
            }),
          (err: Error) => {
            assert.ok(!err.message.includes('TOP_SECRET_HELIUS_987'));
            assert.ok(err.message.includes('https://mainnet.helius-rpc.com'));
            return true;
          }
        );
      }
    );
  } finally {
    resetRpcCircuitBreaker();
  }
});

// ============================================================================
// 7. INPUT VALIDATION, TYPE GUARDS, EDGE CASES & PERSISTENCE
// ============================================================================

test('Non-string address fields return HTTP 400 (never 500) across routes and /api/defi/preflight emits CORS headers', async () => {
  const { server } = createTurgaliumServer({ rateLimit: { enabled: false } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const cases: Array<{ path: string; body: Record<string, unknown> }> = [
      { path: '/api/solana/rent-scan', body: { ownerAddress: 12345 } },
      { path: '/api/solana/yield-park', body: { ownerAddress: { nested: true }, totalUsdcAmount: 100 } },
      { path: '/api/approvals/scan', body: { chain: 'base', walletAddress: ['0x123'] } },
      { path: '/api/plan', body: { scan: makeMinimalScanReport(), solanaDestination: 99999 } },
      { path: '/api/defi/preflight', body: { walletAddress: 12345, assets: [makeUsdcAsset()] } },
      { path: '/api/cctp/attestation', body: { chain: 'base', txHash: 12345 } },
      { path: '/api/cctp/solana-claim-tx', body: { solanaDestination: 12345 } },
      { path: '/api/tx/prove', body: { chain: 'base', txHash: 12345, solanaDestination: SOL_USER_A } },
      { path: '/api/relayer/submit', body: { intentId: 123, chain: 'base', userAddress: 456, signature: 789, deadline: 1 } },
    ];

    for (const c of cases) {
      const res = await fetch(`${base}${c.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(c.body),
      });
      assert.equal(res.status, 400, `Expected HTTP 400 on ${c.path}, got ${res.status}`);
    }

    // Verify /api/defi/preflight returns CORS headers via reply()
    const preflightRes = await fetch(`${base}/api/defi/preflight`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: base,
      },
      body: JSON.stringify({
        walletAddress: SAMPLE_EVM,
        assets: [makeUsdcAsset()],
        skipRpc: true,
      }),
    });
    assert.equal(preflightRes.status, 200);
    assert.equal(preflightRes.headers.get('access-control-allow-origin'), base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Out-of-range timestamps clamp safely and unlock-readers reject odd-length hex', () => {
  const hugeTsAsset = makeUsdcAsset({
    id: 'eth:huge_unlock',
    kind: 'defi_position',
    defiUnlockAt: 1e20,
  });
  const sched = buildUnlockSchedule(
    makeMinimalScanReport([hugeTsAsset]),
    [
      {
        chain: 'base',
        amountUsdc: 100,
        attestationStatus: 'pending_confirmations',
        estimatedReadyAt: 1e25,
      },
    ],
    Date.now()
  );
  assert.equal(sched.length, 2);
  for (const item of sched) {
    assert.ok(item.unlockAtMs >= 0 && item.unlockAtMs <= 8.64e15);
    assert.ok(!Number.isNaN(Date.parse(item.unlockAtIso)));
  }

  // Odd-length hex rejected
  assert.deepEqual(decodeLidoWithdrawalRequestIds('0x' + '0'.repeat(129)), []);
  assert.deepEqual(decodeLidoWithdrawalStatuses('0x' + '0'.repeat(129), [1n]), []);
  assert.equal(decodeEthenaCooldown('0x' + '0'.repeat(129), SAMPLE_EVM), null);

  // Huge uint104 cooldownEnd in Ethena does not throw RangeError on Date.toISOString()
  const hugeCooldownHex =
    '0x' +
    ((1n << 80n).toString(16).padStart(64, '0')) +
    (10n ** 18n).toString(16).padStart(64, '0');
  const decodedEthena = decodeEthenaCooldown(hugeCooldownHex, SAMPLE_EVM);
  assert.ok(decodedEthena);
  assert.ok(decodedEthena.cooldownEndMs <= 8.64e15);
  assert.ok(decodedEthena.cooldownEndIso && !Number.isNaN(Date.parse(decodedEthena.cooldownEndIso)));
});

test('yield-park rejects prototype keys, mismatched Jupiter mints/inAmount, invalid otherAmountThreshold, and >5% priceImpactPct', async () => {
  await assert.rejects(
    () =>
      buildSolanaYieldParkPlan({
        ownerAddress: SOL_USER_A,
        totalUsdcAmount: 100,
        strategy: 'toString' as unknown as 'jupsol',
      }),
    /Unsupported yield strategy/i
  );

  // Mismatched outputMint
  await withMockedFetch(
    async () =>
      new Response(
        JSON.stringify({
          inputMint: SOLANA_USDC_MINT,
          outputMint: 'So11111111111111111111111111111111111111112',
          inAmount: '90000000',
          outAmount: '500000000',
          otherAmountThreshold: '490000000',
          priceImpactPct: '0.001',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      await assert.rejects(
        () => buildSolanaYieldParkPlan({ ownerAddress: SOL_USER_A, totalUsdcAmount: 100, strategy: 'jupsol' }),
        /outputMint mismatch/i
      );
    }
  );

  // Mismatched inAmount
  await withMockedFetch(
    async () =>
      new Response(
        JSON.stringify({
          inputMint: SOLANA_USDC_MINT,
          outputMint: SOLANA_JUPSOL_MINT,
          inAmount: '1000000',
          outAmount: '500000000',
          otherAmountThreshold: '490000000',
          priceImpactPct: '0.001',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      await assert.rejects(
        () => buildSolanaYieldParkPlan({ ownerAddress: SOL_USER_A, totalUsdcAmount: 100, strategy: 'jupsol' }),
        /inAmount mismatch/i
      );
    }
  );

  // Invalid otherAmountThreshold
  await withMockedFetch(
    async () =>
      new Response(
        JSON.stringify({
          inputMint: SOLANA_USDC_MINT,
          outputMint: SOLANA_JUPSOL_MINT,
          inAmount: '90000000',
          outAmount: '500000000',
          otherAmountThreshold: 'not-digits',
          priceImpactPct: '0.001',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      await assert.rejects(
        () => buildSolanaYieldParkPlan({ ownerAddress: SOL_USER_A, totalUsdcAmount: 100, strategy: 'jupsol' }),
        /otherAmountThreshold/i
      );
    }
  );

  // Excessive priceImpactPct (> 5%)
  await withMockedFetch(
    async () =>
      new Response(
        JSON.stringify({
          inputMint: SOLANA_USDC_MINT,
          outputMint: SOLANA_JUPSOL_MINT,
          inAmount: '90000000',
          outAmount: '500000000',
          otherAmountThreshold: '490000000',
          priceImpactPct: '0.08', // 8% > 5% cap
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      await assert.rejects(
        () => buildSolanaYieldParkPlan({ ownerAddress: SOL_USER_A, totalUsdcAmount: 100, strategy: 'jupsol' }),
        /price impact.*exceeds/i
      );
    }
  );
});

test('degen-routes propagates 400/413/415 on claim/close and jupiter-markets verifies feePayer on /orders, /claim, /close', async () => {
  const validTx = buildMockSolanaV0TxBase64(SOL_USER_A);
  const attackerTx = buildMockSolanaV0TxBase64(SOL_USER_B);

  assert.equal(verifyJupiterTransactionBase64(validTx, SOL_USER_A).ok, true);
  assert.equal(verifyJupiterTransactionBase64(attackerTx, SOL_USER_A).ok, false);
  assert.equal(verifyJupiterTransactionBase64('not-valid-tx-bytes', SOL_USER_A).ok, false);

  const mockClient = new JupiterMarketsClient({
    apiKey: 'jup-test-key',
    fetchImpl: async () =>
      new Response(JSON.stringify({ transaction: attackerTx, orderId: 'ord_spoof' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  });

  // Spoofed feePayer fails closed on /orders, /claim, /close
  const orderRes = await mockClient.buildOrderPreview({
    marketId: 'POLY-1',
    side: 'yes',
    stakeUsd: 10,
    availableUsdc: 500,
    riskPct: 10,
    priceUsd: 0.5,
    walletAddress: SOL_USER_A,
    requestLiveTx: true,
  });
  assert.equal(orderRes.liveOrder.available, false);
  assert.equal(orderRes.liveOrder.transactionBase64, null);
  assert.match(orderRes.liveOrder.reason ?? '', /feePayer mismatch/i);

  const claimRes = await mockClient.claimPosition('pos_1', SOL_USER_A);
  assert.equal(claimRes.available, false);
  assert.equal(claimRes.transactionBase64, null);
  assert.match(claimRes.reason ?? '', /feePayer mismatch/i);

  const closeRes = await mockClient.closePosition('pos_1', SOL_USER_A);
  assert.equal(closeRes.available, false);
  assert.equal(closeRes.transactionBase64, null);
  assert.match(closeRes.reason ?? '', /feePayer mismatch/i);

  // HTTP degen-routes: malformed JSON -> 400, oversized >32 KiB -> 413, wrong Content-Type -> 415
  const { server } = createTurgaliumServer({ degenClient: mockClient, rateLimit: { enabled: false } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const badJson = await fetch(`${base}/api/degen/positions/pos_1/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{malformed json',
    });
    assert.equal(badJson.status, 400);

    const oversized = await fetch(`${base}/api/degen/positions/pos_1/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'a'.repeat(40_000) }),
    });
    assert.equal(oversized.status, 413);

    const wrongCt = await fetch(`${base}/api/degen/positions/pos_1/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(wrongCt.status, 415);

    // Genuinely empty POST still works cleanly
    const emptyOk = await fetch(`${base}/api/degen/positions/pos_1/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    assert.equal(emptyOk.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Preservation routes & fee math: validates protocolFeeBps (allowing 0, rejecting NaN/out-of-range), avoids NaN on $0.001, preserves $50 cap on invalid maxFeeUsdCap', async () => {
  // 1. Sub-cent grossUsd rounds to 0 -> returns 'zero' tier (never NaN capitalPreservedPct)
  const tiny = computePreservationFee(0.001);
  assert.equal(tiny.tierId, 'zero');
  assert.equal(tiny.capitalPreservedPct, 100);
  assert.ok(Number.isFinite(tiny.capitalPreservedPct));

  // 2. Invalid maxFeeUsdCap (NaN / negative) in explicit tiered mode falls back to $50 principal cap instead of disabling it
  const nanCap = computePreservationFee(100_000, { mode: 'tiered', maxFeeUsdCap: Number.NaN });
  assert.equal(nanCap.feeCapUsd, 50);
  assert.equal(nanCap.feeUsd, 50);
  assert.equal(nanCap.capApplied, true);

  const negCap = computePreservationFee(100_000, { mode: 'tiered', maxFeeUsdCap: -10 });
  assert.equal(negCap.feeCapUsd, 50);
  assert.equal(negCap.feeUsd, 50);
  assert.equal(negCap.capApplied, true);

  // 3. HTTP POST /api/optimize/preservation validates protocolFeeBps strictly and preserves 0 bps
  const { server } = createTurgaliumServer({ rateLimit: { enabled: false } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const scanReport = makeMinimalScanReport();
    for (const badFee of ['NaN', -1, 1001, 12.5, '', true]) {
      const badRes = await fetch(`${base}/api/optimize/preservation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scanReport, protocolFeeBps: badFee }),
      });
      assert.equal(badRes.status, 400, `Expected 400 for protocolFeeBps=${String(badFee)}`);
    }

    const zeroFeeRes = await fetch(`${base}/api/optimize/preservation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanReport, protocolFeeBps: 0 }),
    });
    assert.equal(zeroFeeRes.status, 200);
    const zeroFeeJson = (await zeroFeeRes.json()) as { protocolFeeBps: number };
    assert.equal(zeroFeeJson.protocolFeeBps, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('route-auction guards non-finite etaSeconds and Mayan expectedAmountOut comparator', async () => {
  const asset = makeUsdcAsset();
  const feeConfig = getProtocolFeeConfig({ feeBps: 700 });

  // Mayan quote list containing NaN expectedAmountOut + NaN etaSeconds selects valid quote cleanly
  const mayanQuote = await fetchMayanSwiftQuote({
    asset,
    userAddress: SAMPLE_EVM,
    solanaDestination: SOL_USER_A,
    outputAsset: 'USDC',
    feeConfig,
    allowanceCheckFn: async () => 1_000_000_000n,
    fetcher: async () =>
      new Response(
        JSON.stringify([
          {
            type: 'SWIFT',
            expectedAmountOut: 'NaN',
            etaSeconds: Number.NaN,
            to: '0x1111111111111111111111111111111111111111',
            data: '0x1234567800',
          },
          {
            type: 'SWIFT',
            quoteId: 'mayan-valid',
            expectedAmountOut: '495.5',
            etaSeconds: Number.NaN,
            to: '0x2222222222222222222222222222222222222222',
            data: '0x1234567800',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
  });
  assert.ok(mayanQuote);
  assert.equal(mayanQuote.requestId, 'mayan-valid');
  assert.ok(Number.isFinite(mayanQuote.estimatedSeconds) && mayanQuote.estimatedSeconds >= 4);

  // Auction handles provider returning NaN estimatedSeconds without producing NaN etaSeconds
  const auction = await runLiveParallelRouteAuction({
    asset,
    userAddress: SAMPLE_EVM,
    solanaDestination: SOL_USER_A,
    outputAsset: 'USDC',
    feeConfig,
    providers: {
      relay: async () => ({
        provider: 'relay',
        estimatedOutput: '496 USDC',
        estimatedSeconds: Number.NaN,
        quotedOutUsd: 496,
        estimatedGasUsd: 0.1,
        transactions: [
          {
            stepId: 'bridge_relay',
            label: 'Relay',
            description: 'Relay',
            chain: 'base',
            chainId: 8453,
            chainName: 'Base',
            explorerUrl: 'https://basescan.org',
            from: SAMPLE_EVM,
            to: '0x3333333333333333333333333333333333333333',
            data: '0x12345678',
            value: '0x0',
          },
        ],
        notes: [],
      }),
      mayan_swift: async () => null,
      debridge_dln: async () => null,
    },
  });
  assert.equal(auction.routeAuction.winnerProvider, 'relay');
  assert.ok(Number.isFinite(auction.routeAuction.candidates[0].etaSeconds));
});

test('solana-rent validates options before RPC, requires non-empty info.owner, and blocks confidentialTransferFeeAmount', async () => {
  let fetchCalls = 0;
  await withMockedFetch(
    async () => {
      fetchCalls += 1;
      throw new Error('RPC should not have been called for invalid options');
    },
    async () => {
      await assert.rejects(
        () => scanReclaimableSolanaRent(SOL_USER_A, { solPriceUsd: -5 }),
        /solPriceUsd/i
      );
      await assert.rejects(
        () => scanReclaimableSolanaRent(SOL_USER_A, { recentBlockhash: 'bad-blockhash' }),
        /recentBlockhash/i
      );
      await assert.rejects(
        () => scanReclaimableSolanaRent(SOL_USER_A, { computeUnitPriceMicroLamports: -1 }),
        /computeUnitPriceMicroLamports/i
      );
    }
  );
  assert.equal(fetchCalls, 0, 'Pre-RPC option validation must fail before making any RPC fetch');

  // Missing info.owner and confidentialTransferFeeAmount extension are skipped safely
  const ataMissingOwner = Keypair.generate().publicKey.toBase58();
  const ataConfFee = Keypair.generate().publicKey.toBase58();
  const ataValid = Keypair.generate().publicKey.toBase58();

  await withMockedFetch(
    async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { params?: unknown[] };
      const filter = (body.params?.[1] as { programId?: string }) ?? {};
      if (filter.programId === SOLANA_TOKEN_PROGRAM_ID.toBase58()) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [
                {
                  pubkey: ataMissingOwner,
                  account: {
                    lamports: 2_039_280,
                    data: {
                      parsed: {
                        info: {
                          mint: SOLANA_USDC_MINT,
                          // owner missing!
                          state: 'initialized',
                          tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
                        },
                      },
                    },
                  },
                },
                {
                  pubkey: ataValid,
                  account: {
                    lamports: 2_039_280,
                    data: {
                      parsed: {
                        info: {
                          mint: SOLANA_USDC_MINT,
                          owner: SOL_USER_A,
                          state: 'initialized',
                          tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (filter.programId === SOLANA_TOKEN_2022_PROGRAM_ID.toBase58()) {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [
                {
                  pubkey: ataConfFee,
                  account: {
                    lamports: 2_039_280,
                    data: {
                      parsed: {
                        info: {
                          mint: SOLANA_USDC_MINT,
                          owner: SOL_USER_A,
                          state: 'initialized',
                          tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
                          extensions: [{ extension: 'confidentialTransferFeeAmount', state: {} }],
                        },
                      },
                    },
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    async () => {
      const scan = await scanReclaimableSolanaRent(SOL_USER_A, {
        rpcUrls: ['https://mock-solana.test'],
        solPriceUsd: 150,
      });
      assert.equal(scan.reclaimableCount, 1);
      assert.equal(scan.reclaimableAccounts[0].tokenAccount, ataValid);
      assert.equal(scan.skippedUncloseableCount, 2);
    }
  );
});

test('FileStateStore quarantines corrupt JSON, PreservationAgentStore persists across restart, and parseServerPort validates bounds', () => {
  // 1. parseServerPort bounds
  assert.equal(parseServerPort(undefined), 4420);
  assert.equal(parseServerPort('8080'), 8080);
  for (const badPort of ['0', '-1', '65536', 'NaN', 'abc', '4420.5']) {
    assert.throws(() => parseServerPort(badPort), /Invalid PORT/i);
  }

  // 2. Corrupt JSON quarantine in FileStateStore.load()
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turgalium-hardening-'));
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '));

  try {
    const store = new FileStateStore(tmpDir);
    const corruptPath = path.join(tmpDir, 'mandates.json');
    fs.writeFileSync(corruptPath, '{corrupt json!!!', 'utf8');

    const loaded = store.load('mandates', ['fallback']);
    assert.deepEqual(loaded, ['fallback']);
    assert.equal(fs.existsSync(corruptPath), false, 'Corrupt original file must be quarantined');
    const files = fs.readdirSync(tmpDir);
    assert.ok(
      files.some((f) => /^mandates\.json\.corrupt\.\d+$/.test(f)),
      `Expected quarantined file, found: ${files.join(', ')}`
    );
    assert.ok(
      warnings.some((w) => w.includes('state_store_corrupt_file_quarantined')),
      'Structured warning log must be emitted on corrupt file quarantine'
    );

    // 3. PreservationAgentStore persists and reloads via 'preservation_agents' namespace
    const pa1 = new PreservationAgentStore({ stateStore: store });
    const trig = pa1.createTrigger({
      sourceWallet: SAMPLE_EVM,
      solanaDestination: SOL_USER_A,
      chain: 'ethereum',
      maxBaseFeeGwei: 12,
    });
    assert.ok(store.listNamespaces().includes('preservation_agents'));

    const pa2 = new PreservationAgentStore({ stateStore: new FileStateStore(tmpDir) });
    const reloaded = pa2.getTrigger(trig.id);
    assert.ok(reloaded, 'Gas-watch trigger must survive restart via stateStore');
    assert.equal(reloaded.maxBaseFeeGwei, 12);
    assert.equal(reloaded.sourceWallet, SAMPLE_EVM);
  } finally {
    console.warn = origWarn;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
