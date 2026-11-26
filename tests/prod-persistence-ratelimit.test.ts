import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { Keypair } from '@solana/web3.js';
import { TurgaliumAgentEngine } from '../src/agent/mandate-engine.js';
import {
  broadcastSignedRelayerTx,
  deriveEvmAddressFromPrivateKey,
  rlpEncode,
  signEip1559Transaction,
} from '../src/relayer/broadcaster.js';
import {
  buildGaslessSweepIntent,
  clearTrackedGaslessIntentsForTest,
  configureGaslessIntentStore,
  encodePermit2SweepCalldata,
  isGaslessDigestConsumed,
  submitAndBroadcastSignedGaslessIntent,
  submitSignedGaslessIntent,
} from '../src/relayer/sponsor.js';
import { EVM_CHAINS } from '../src/scanner/chains.js';
import {
  configureRpcCircuitBreaker,
  evmJsonRpcBatch,
  evmJsonRpcCall,
  getRpcCircuitBreakerMetrics,
  isRpcEndpointInCooldown,
  resetRpcCircuitBreaker,
} from '../src/scanner/rpc.js';
import type { ScannedAsset } from '../src/scanner/types.js';
import { createTurgaliumServer } from '../src/server/app.js';
import { assertSafeStartupConfig, isLoopbackBindHost } from '../src/server/index.js';
import { BackgroundJobStore } from '../src/server/jobs.js';
import { SlidingWindowRateLimiter } from '../src/server/rate-limit.js';
import {
  createStateStore,
  FileStateStore,
  MemoryStateStore,
} from '../src/storage/state-store.js';

function makeTempDir(prefix = 'turgalium-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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
    rawBalance: '500000000', // 500 USDC
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

async function withMockedFetch<T>(
  impl: (url: string, init?: RequestInit) => Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return impl(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('FileStateStore: atomic writes, namespace validation, and createStateStore defaults', () => {
  // Default with no TURGALIUM_DATA_DIR -> in-memory store
  const prevDataDir = process.env.TURGALIUM_DATA_DIR;
  delete process.env.TURGALIUM_DATA_DIR;
  try {
    const mem = createStateStore();
    assert.equal(mem.kind, 'memory');
    assert.equal(mem.persistent, false);
    mem.save('jobs', [{ id: 1 }]);
    assert.deepEqual(mem.load('jobs', []), [{ id: 1 }]);
  } finally {
    if (prevDataDir !== undefined) process.env.TURGALIUM_DATA_DIR = prevDataDir;
  }

  const tmpDir = makeTempDir();
  try {
    const store = createStateStore({ dataDir: tmpDir });
    assert.equal(store.kind, 'file');
    assert.equal(store.persistent, true);

    store.save('mandates', [{ id: 'm1', spent: 42.5 }]);
    assert.deepEqual(store.load('mandates', []), [{ id: 'm1', spent: 42.5 }]);

    // Verify atomic rename left zero .tmp files behind
    const files = fs.readdirSync(tmpDir);
    assert.deepEqual(files, ['mandates.json']);

    // Reject path-traversal namespaces
    assert.throws(() => store.save('../escape', { bad: true }), /Invalid state store namespace/i);
    assert.throws(() => store.load('sub/dir', null), /Invalid state store namespace/i);

    // Reload from a fresh FileStateStore instance
    const reloaded = new FileStateStore(tmpDir);
    assert.deepEqual(reloaded.load('mandates', []), [{ id: 'm1', spent: 42.5 }]);
    assert.deepEqual(reloaded.listNamespaces(), ['mandates']);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Persistence across restart: TurgaliumAgentEngine preserves mandates, 24h rolling spentTodayUsd, approvals, and plugin tokens', () => {
  const tmpDir = makeTempDir();
  const solDest = Keypair.generate().publicKey.toBase58();
  const owner = '0x1111111111111111111111111111111111111111';
  let now = Date.UTC(2026, 5, 1, 12, 0, 0);

  try {
    // --- Boot 1 ---
    const store1 = new FileStateStore(tmpDir);
    const engine1 = new TurgaliumAgentEngine({ stateStore: store1, nowMs: () => now });

    const mandate = engine1.createMandate({
      name: 'Daily Cap Guard Agent',
      ownerAddress: owner,
      lockedSolanaRecipient: solDest,
      maxPerTxUsd: 100,
      dailyCapUsd: 120,
      autoApproveUnderUsd: 80,
      maxFeeBps: 700,
      minNetOutBps: 8000,
    });

    // Auto-approve $75 (consumes $75 of $120 daily cap, leaving $45)
    const autoReq = engine1.requestPermission({
      client: 'claude_mcp',
      mandateId: mandate.mandateId,
      actionType: 'dust_convert',
      summary: 'First sweep $75',
      sourceWallets: [owner],
      chains: ['base'],
      solanaDestination: solDest,
      grossUsd: 75,
      estimatedNetUsdc: 68,
      protocolFeeBps: 700,
    });
    assert.equal(autoReq.status, 'auto_approved_by_mandate');

    // Pending approval request (above $80 auto-approve tier, within $100 per-tx)
    const pendingReq = engine1.requestPermission({
      client: 'claude_mcp',
      mandateId: mandate.mandateId,
      actionType: 'dust_convert',
      summary: 'Pending sweep $40',
      sourceWallets: [owner],
      chains: ['base'],
      solanaDestination: solDest,
      grossUsd: 85,
      estimatedNetUsdc: 76,
      protocolFeeBps: 700,
    });
    // Note: $75 + $85 = $160 > $120 daily cap -> hard mandate rejection!
    assert.equal(pendingReq.status, 'rejected');

    // Issue two plugin tokens and revoke one
    const activeToken = engine1.issuePluginToken({
      label: 'Claude Desktop Prod',
      client: 'claude_mcp',
    });
    const revokedToken = engine1.issuePluginToken({
      label: 'Revoked Token',
      client: 'chatgpt_action',
    });
    engine1.revokePluginToken(revokedToken.record.tokenId);

    // Ensure plaintext token secret is NEVER written to disk
    const rawTokensFile = fs.readFileSync(path.join(tmpDir, 'plugin_tokens.json'), 'utf8');
    assert.ok(!rawTokensFile.includes(activeToken.token), 'Plaintext Bearer token must NEVER be persisted on disk');

    // --- Simulate process restart 2 hours later (still inside same 24h rolling window) ---
    now += 2 * 60 * 60 * 1000;
    const store2 = new FileStateStore(tmpDir);
    const engine2 = new TurgaliumAgentEngine({ stateStore: store2, nowMs: () => now });

    const reloadedMandate = engine2.getMandate(mandate.mandateId);
    assert.ok(reloadedMandate, 'Mandate must survive restart');
    assert.equal(reloadedMandate.spentTodayUsd, 75, 'spentTodayUsd MUST NOT reset on restart');
    assert.equal(reloadedMandate.remainingDailyUsd, 45, 'remainingDailyUsd MUST persist across restart');
    assert.equal(reloadedMandate.dayWindowStart, mandate.dayWindowStart);
    assert.equal(reloadedMandate.executionsCount, 1);

    // Attempt to bypass daily cap after restart by spending $60 ($75 + $60 = $135 > $120) -> MUST BE REJECTED!
    const bypassAttempt = engine2.requestPermission({
      client: 'claude_mcp',
      mandateId: mandate.mandateId,
      actionType: 'dust_convert',
      summary: 'Post-restart cap bypass attempt',
      sourceWallets: [owner],
      chains: ['base'],
      solanaDestination: solDest,
      grossUsd: 60,
      estimatedNetUsdc: 54,
      protocolFeeBps: 700,
    });
    assert.equal(bypassAttempt.status, 'rejected', 'Restart must NEVER allow bypassing 24h daily spend cap');
    assert.match(bypassAttempt.decisionReason ?? '', /exceeds remaining daily cap/i);

    // Spending $40 within remaining $45 succeeds and brings spentTodayUsd to $115
    const validAfterRestart = engine2.requestPermission({
      client: 'claude_mcp',
      mandateId: mandate.mandateId,
      actionType: 'dust_convert',
      summary: 'Valid $40 sweep after restart',
      sourceWallets: [owner],
      chains: ['base'],
      solanaDestination: solDest,
      grossUsd: 40,
      estimatedNetUsdc: 36,
      protocolFeeBps: 700,
    });
    assert.equal(validAfterRestart.status, 'auto_approved_by_mandate');
    assert.equal(engine2.getMandate(mandate.mandateId)?.spentTodayUsd, 115);

    // Plugin token verification works after restart; revoked token stays revoked
    const verifiedActive = engine2.verifyPluginToken(`Bearer ${activeToken.token}`);
    assert.equal(verifiedActive?.tokenId, activeToken.record.tokenId);
    assert.equal(engine2.verifyPluginToken(`Bearer ${revokedToken.token}`), null);

    // Approvals history persisted across restart
    assert.ok(engine2.getApproval(autoReq.approvalId));
    assert.ok(engine2.getApproval(pendingReq.approvalId));

    // --- Advance clock 25 hours from initial dayWindowStart -> rolling 24h window resets cleanly ---
    now += 23 * 60 * 60 * 1000;
    const engine3 = new TurgaliumAgentEngine({ stateStore: new FileStateStore(tmpDir), nowMs: () => now });
    const resetMandate = engine3.getMandate(mandate.mandateId);
    assert.equal(resetMandate?.spentTodayUsd, 0);
    assert.equal(resetMandate?.remainingDailyUsd, 120);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Persistence across restart: BackgroundJobStore preserves active & completed jobs and leg states', () => {
  const tmpDir = makeTempDir();
  const solDest = Keypair.generate().publicKey.toBase58();
  let now = Date.UTC(2026, 5, 1, 15, 0, 0);

  try {
    const store1 = new FileStateStore(tmpDir);
    const jobs1 = new BackgroundJobStore({ stateStore: store1, nowMs: () => now, ttlMs: 3_600_000 });

    const job = jobs1.createJob({
      sourceWallet: '0x2222222222222222222222222222222222222222',
      solanaDestination: solDest,
      outputAsset: 'USDC',
      bridgePreference: 'cctp',
      protocolFeeBps: 700,
      feeRecipientEvm: '0x3333333333333333333333333333333333333333',
      legs: [
        { chain: 'ethereum', assetCount: 2, estimatedNetUsd: 420.5, estimatedFeeUsd: 10 },
        { chain: 'base', assetCount: 3, estimatedNetUsd: 180.25, estimatedFeeUsd: 5 },
      ],
    });

    jobs1.updateLeg(job.jobId, 'base', {
      status: 'landed',
      statusText: 'Landed on Solana (USDC)',
      evmTxHash: '0x' + 'aa'.repeat(32),
      solanaTxHash: '5MockSolanaSig1111111111111111111111111111111',
    });
    jobs1.updateLeg(job.jobId, 'ethereum', {
      status: 'attested',
      statusText: 'Circle CCTP attested · ready to claim on Solana',
      evmTxHash: '0x' + 'bb'.repeat(32),
      requiresSolanaClaim: true,
      attestationStatus: 'complete',
    });
    jobs1.dispose();

    // Restart against same FileStateStore
    now += 60_000;
    const jobs2 = new BackgroundJobStore({
      stateStore: new FileStateStore(tmpDir),
      nowMs: () => now,
      ttlMs: 3_600_000,
    });
    const reloaded = jobs2.getJob(job.jobId);
    assert.ok(reloaded, 'Active job must survive restart');
    assert.equal(reloaded.status, 'active');
    assert.equal(reloaded.settledNetUsd, 180.25);
    assert.equal(reloaded.attestedNetUsd, 420.5);
    assert.equal(reloaded.legs.find((l) => l.chain === 'base')?.status, 'landed');
    assert.equal(reloaded.legs.find((l) => l.chain === 'ethereum')?.status, 'attested');
    jobs2.dispose();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Persistence across restart: gasless intent consumed EIP-712 digests remain replay-protected', () => {
  const tmpDir = makeTempDir();
  const wallet = makeTestEvmWallet(0x19);
  const solDest = Keypair.generate().publicKey.toBase58();
  const prevRouter = process.env.TURGALIUM_ROUTER_BASE;
  const prevFee = process.env.TURGALIUM_FEE_RECIPIENT_EVM;
  const prevKey = process.env.TURGALIUM_RELAYER_PRIVATE_KEY;

  try {
    process.env.TURGALIUM_ROUTER_BASE = '0x4444444444444444444444444444444444444444';
    process.env.TURGALIUM_FEE_RECIPIENT_EVM = '0x5555555555555555555555555555555555555555';
    delete process.env.TURGALIUM_RELAYER_PRIVATE_KEY;

    configureGaslessIntentStore(new FileStateStore(tmpDir));

    const intent = buildGaslessSweepIntent({
      chain: 'base',
      assets: [makeUsdcAsset()],
      userAddress: wallet.address,
      solanaDestination: solDest,
      preferredMode: 'permit2_batch',
    });
    assert.ok(intent.eip712Digest);
    const sig = signDigestLowS(intent.eip712Digest, wallet.privKeyHex);

    const receipt = submitSignedGaslessIntent({
      intentId: intent.intentId,
      chain: 'base',
      userAddress: wallet.address,
      signature: sig,
      deadline: intent.deadline,
    });
    assert.equal(receipt.signatureValid, true);
    assert.equal(receipt.broadcasted, false);
    assert.equal(isGaslessDigestConsumed(intent.eip712Digest), true);

    // Simulate full process crash / memory wipe, then re-attach FileStateStore
    clearTrackedGaslessIntentsForTest();
    assert.equal(isGaslessDigestConsumed(intent.eip712Digest), false);
    configureGaslessIntentStore(new FileStateStore(tmpDir));

    assert.equal(isGaslessDigestConsumed(intent.eip712Digest), true, 'Consumed digest must reload from disk');
    assert.throws(
      () =>
        submitSignedGaslessIntent({
          intentId: intent.intentId,
          chain: 'base',
          userAddress: wallet.address,
          signature: sig,
          deadline: intent.deadline,
        }),
      /already been consumed/i
    );
  } finally {
    configureGaslessIntentStore(null);
    clearTrackedGaslessIntentsForTest();
    if (prevRouter === undefined) delete process.env.TURGALIUM_ROUTER_BASE;
    else process.env.TURGALIUM_ROUTER_BASE = prevRouter;
    if (prevFee === undefined) delete process.env.TURGALIUM_FEE_RECIPIENT_EVM;
    else process.env.TURGALIUM_FEE_RECIPIENT_EVM = prevFee;
    if (prevKey === undefined) delete process.env.TURGALIUM_RELAYER_PRIVATE_KEY;
    else process.env.TURGALIUM_RELAYER_PRIVATE_KEY = prevKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Relayer Broadcaster: real EIP-1559 signing, custom & RPC broadcast, and honest fail-closed diagnostics', async () => {
  const relayer = makeTestEvmWallet(0x42);
  const user = makeTestEvmWallet(0x24);
  const solDest = Keypair.generate().publicKey.toBase58();
  const router = '0x4444444444444444444444444444444444444444';
  const calldata = '0xdeadbeef00000000000000000000000000000000000000000000000000000001';

  // 1. Verify RLP & EIP-1559 signing produces deterministic Type-2 payload + txHash
  assert.deepEqual(Array.from(rlpEncode(new Uint8Array([0x7f]))), [0x7f]);
  assert.deepEqual(Array.from(rlpEncode([])), [0xc0]);
  const signed = signEip1559Transaction(
    {
      chainId: 8453,
      nonce: 7,
      maxPriorityFeePerGasWei: 1_000_000_000n,
      maxFeePerGasWei: 5_000_000_000n,
      gasLimit: 250_000n,
      to: router,
      valueWei: 0n,
      data: calldata,
    },
    relayer.privKeyHex
  );
  assert.ok(signed.rawTransaction.startsWith('0x02'), 'Must produce EIP-1559 Type-2 transaction');
  assert.equal(signed.from, relayer.address);
  const expectedHash = '0x' + Buffer.from(keccak_256(Buffer.from(signed.rawTransaction.slice(2), 'hex'))).toString('hex');
  assert.equal(signed.txHash, expectedHash);

  // 2. Fail closed when key is missing (NEVER fabricates txHash)
  const prevKey = process.env.TURGALIUM_RELAYER_PRIVATE_KEY;
  const prevRouter = process.env.TURGALIUM_ROUTER_BASE;
  const prevFee = process.env.TURGALIUM_FEE_RECIPIENT_EVM;
  delete process.env.TURGALIUM_RELAYER_PRIVATE_KEY;
  try {
    const missingKey = await broadcastSignedRelayerTx({ chain: 'base', to: router, data: calldata });
    assert.equal(missingKey.broadcasted, false);
    assert.equal(missingKey.txHash, undefined);
    assert.equal(missingKey.reasonCode, 'relayer_key_missing');

    // Fail closed on placeholder router 0x...51F0
    const placeholderRouter = await broadcastSignedRelayerTx({
      chain: 'base',
      to: '0x00000000000000000000000000000000000051f0',
      data: calldata,
      privateKeyHex: relayer.privKeyHex,
    });
    assert.equal(placeholderRouter.broadcasted, false);
    assert.equal(placeholderRouter.txHash, undefined);
    assert.equal(placeholderRouter.reasonCode, 'router_unconfigured');

    // 3. Successful broadcast via eth_sendRawTransaction JSON-RPC transport
    const seenMethods: string[] = [];
    const mockRpcCall = (async (_urls: string[], method: string, params: unknown[]) => {
      seenMethods.push(method);
      if (method === 'eth_getTransactionCount') return { result: '0x5' };
      if (method === 'eth_gasPrice') return { result: '0x3b9aca00' }; // 1 gwei
      if (method === 'eth_maxPriorityFeePerGas') return { result: '0x5f5e100' }; // 0.1 gwei
      if (method === 'eth_estimateGas') return { result: '0x30d40' }; // 200,000
      if (method === 'eth_sendRawTransaction') {
        const raw = String(params[0] ?? '');
        assert.ok(raw.startsWith('0x02'));
        const hash = '0x' + Buffer.from(keccak_256(Buffer.from(raw.slice(2), 'hex'))).toString('hex');
        return { result: hash };
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    }) as typeof evmJsonRpcCall;

    const rpcResult = await broadcastSignedRelayerTx({
      chain: 'base',
      to: router,
      data: calldata,
      privateKeyHex: relayer.privKeyHex,
      rpcCall: mockRpcCall,
    });
    assert.equal(rpcResult.broadcasted, true);
    assert.equal(rpcResult.reasonCode, 'broadcasted');
    assert.equal(rpcResult.relayerAddress, relayer.address);
    assert.equal(rpcResult.nonce, 5);
    assert.equal(rpcResult.gasLimit, '250000'); // 200,000 * 1.25
    assert.match(rpcResult.txHash ?? '', /^0x[0-9a-f]{64}$/);
    assert.deepEqual(seenMethods, [
      'eth_getTransactionCount',
      'eth_gasPrice',
      'eth_maxPriorityFeePerGas',
      'eth_estimateGas',
      'eth_sendRawTransaction',
    ]);

    // 4. Reject invalid txHash returned by misbehaving custom broadcaster hook
    const badHashResult = await broadcastSignedRelayerTx({
      chain: 'base',
      to: router,
      data: calldata,
      nonce: 1,
      gasLimit: 200_000n,
      maxFeePerGasWei: 2_000_000_000n,
      maxPriorityFeePerGasWei: 1_000_000_000n,
      privateKeyHex: relayer.privKeyHex,
      sendRawTransaction: async () => 'not-a-real-hash',
    });
    assert.equal(badHashResult.broadcasted, false);
    assert.equal(badHashResult.txHash, undefined);
    assert.equal(badHashResult.reasonCode, 'invalid_tx_hash');

    // 5. End-to-end submitAndBroadcastSignedGaslessIntent with configured env + custom broadcaster hook
    process.env.TURGALIUM_RELAYER_PRIVATE_KEY = relayer.privKeyHex;
    process.env.TURGALIUM_ROUTER_BASE = router;
    process.env.TURGALIUM_FEE_RECIPIENT_EVM = '0x5555555555555555555555555555555555555555';
    configureGaslessIntentStore(new MemoryStateStore());

    const intent = buildGaslessSweepIntent({
      chain: 'base',
      assets: [makeUsdcAsset()],
      userAddress: user.address,
      solanaDestination: solDest,
      preferredMode: 'permit2_batch',
    });
    assert.ok(intent.eip712Digest);
    const sig = signDigestLowS(intent.eip712Digest, user.privKeyHex);
    const boundCalldata = encodePermit2SweepCalldata({
      plan: intent,
      signature: sig,
      gasReimbursementUsdc: 0n,
    });

    let capturedRawTx = '';
    const broadcastReceipt = await submitAndBroadcastSignedGaslessIntent({
      intentId: intent.intentId,
      chain: 'base',
      userAddress: user.address,
      signature: sig,
      deadline: intent.deadline,
      txCalldata: boundCalldata,
      nonce: 9,
      gasLimit: 300_000n,
      maxFeePerGasWei: 3_000_000_000n,
      maxPriorityFeePerGasWei: 500_000_000n,
      sendRawTransaction: async (ctx) => {
        capturedRawTx = ctx.rawTransaction;
        assert.equal(ctx.from, relayer.address);
        assert.equal(ctx.to, router);
        assert.equal(ctx.chainId, 8453);
        return ctx.computedTxHash;
      },
    });
    assert.equal(broadcastReceipt.accepted, true);
    assert.equal(broadcastReceipt.broadcasted, true);
    assert.equal(broadcastReceipt.settlementStatus, 'broadcast');
    assert.match(broadcastReceipt.txHash ?? '', /^0x[0-9a-f]{64}$/);
    assert.ok(capturedRawTx.startsWith('0x02'));

    // Without txCalldata, fails closed honestly (broadcasted: false, no fabricated txHash)
    const intent2 = buildGaslessSweepIntent({
      chain: 'base',
      assets: [makeUsdcAsset()],
      userAddress: user.address,
      solanaDestination: solDest,
      preferredMode: 'permit2_batch',
    });
    const sig2 = signDigestLowS(intent2.eip712Digest!, user.privKeyHex);
    const noCalldataReceipt = await submitAndBroadcastSignedGaslessIntent({
      intentId: intent2.intentId,
      chain: 'base',
      userAddress: user.address,
      signature: sig2,
      deadline: intent2.deadline,
    });
    assert.equal(noCalldataReceipt.accepted, true);
    assert.equal(noCalldataReceipt.broadcasted, false);
    assert.equal(noCalldataReceipt.txHash, undefined);
    assert.equal(noCalldataReceipt.settlementStatus, 'queued_pending_broadcast');
  } finally {
    configureGaslessIntentStore(null);
    clearTrackedGaslessIntentsForTest();
    if (prevKey === undefined) delete process.env.TURGALIUM_RELAYER_PRIVATE_KEY;
    else process.env.TURGALIUM_RELAYER_PRIVATE_KEY = prevKey;
    if (prevRouter === undefined) delete process.env.TURGALIUM_ROUTER_BASE;
    else process.env.TURGALIUM_ROUTER_BASE = prevRouter;
    if (prevFee === undefined) delete process.env.TURGALIUM_FEE_RECIPIENT_EVM;
    else process.env.TURGALIUM_FEE_RECIPIENT_EVM = prevFee;
  }
});

test('Rate limiter: sliding-window unit checks & HTTP 429 with Retry-After header', async () => {
  // 1. Sliding-window unit verification with injectable clock
  let now = 1_000_000;
  const limiter = new SlidingWindowRateLimiter({
    maxRequests: 3,
    windowMs: 10_000,
    nowMs: () => now,
  });

  assert.equal(limiter.consume('ip:1.2.3.4').allowed, true);
  now += 2_000;
  assert.equal(limiter.consume('ip:1.2.3.4').allowed, true);
  now += 2_000;
  assert.equal(limiter.consume('ip:1.2.3.4').allowed, true);
  const blocked = limiter.consume('ip:1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSec, 6); // oldest at 1_000_000, now=1_004_000 -> 6s left

  // Independent key is unaffected
  assert.equal(limiter.consume('token:abc123').allowed, true);

  // Advance past oldest timestamp -> window slides open
  now = 1_010_001;
  assert.equal(limiter.consume('ip:1.2.3.4').allowed, true);

  // 2. Live HTTP server returns 429 + Retry-After when limit exceeded, while /api/health remains exempt
  const { server, agentEngine } = createTurgaliumServer({
    rateLimit: { maxRequests: 3, windowMs: 30_000 },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${baseUrl}/api/config`);
      assert.equal(r.status, 200);
    }

    const r4 = await fetch(`${baseUrl}/api/config`);
    assert.equal(r4.status, 429, '4th request must return HTTP 429');
    const retryAfter = Number(r4.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, 'Retry-After header must be a positive integer');
    assert.equal(r4.headers.get('x-ratelimit-limit'), '3');
    assert.equal(r4.headers.get('x-ratelimit-remaining'), '0');
    const body = (await r4.json()) as { error: string; retryAfterSec: number };
    assert.match(body.error, /rate limit exceeded/i);
    assert.ok(body.retryAfterSec >= 1);

    // /api/health must stay reachable for container/Fly healthchecks even when rate-limited
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);

    // Unverified random Bearer token CANNOT bypass IP rate limit!
    const fakeTokenRes = await fetch(`${baseUrl}/api/config`, {
      headers: { Authorization: 'Bearer turgalium_mcp_unverified_random_token' },
    });
    assert.equal(fakeTokenRes.status, 429);

    // Verified plugin Bearer token gets its own isolated quota bucket
    const issued = agentEngine.issuePluginToken({
      label: 'RateLimit Isolated Bucket Test',
      client: 'claude_mcp',
    });
    const withToken = await fetch(`${baseUrl}/api/config`, {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    assert.equal(withToken.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('RPC Circuit Breaker: skips 429 primary RPC for 60s cooldown and resumes after cooldown expires', async () => {
  let now = 5_000_000;
  const primary = 'https://primary-429.rpc.test';
  const backup = 'https://backup-healthy.rpc.test';
  let primaryHealthy = false;
  const hits: string[] = [];

  resetRpcCircuitBreaker();
  configureRpcCircuitBreaker({
    circuitBreakerCooldownMs: 60_000,
    rateLimitErrorThreshold: 2,
    nowMs: () => now,
  });

  try {
    await withMockedFetch(
      async (url, init) => {
        hits.push(url);
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (url === primary && !primaryHealthy) {
          return new Response('Too Many Requests', { status: 429 });
        }
        if (Array.isArray(body)) {
          return new Response(
            JSON.stringify(body.map((r: { id: number }) => ({ jsonrpc: '2.0', id: r.id, result: '0x100' }))),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1234' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
      async () => {
        // Call 1 at t=0: hits primary (429 -> opens circuit for 60s), fails over to backup
        const r1 = await evmJsonRpcCall<string>([primary, backup], 'eth_blockNumber', []);
        assert.equal(r1.result, '0x1234');
        assert.deepEqual(hits, [primary, backup]);
        assert.equal(isRpcEndpointInCooldown(primary, now), true);

        // Call 2 at t=+15s: primary MUST BE SKIPPED completely -> goes straight to backup!
        hits.length = 0;
        now += 15_000;
        const r2 = await evmJsonRpcCall<string>([primary, backup], 'eth_blockNumber', []);
        assert.equal(r2.result, '0x1234');
        assert.deepEqual(hits, [backup], '429 primary RPC must be skipped during 60s cooldown');

        // Call 3 (batch) at t=+59s: primary STILL skipped in evmJsonRpcBatch too!
        hits.length = 0;
        now += 44_000; // total +59s
        const b1 = await evmJsonRpcBatch(
          [primary, backup],
          [{ id: 1, method: 'eth_blockNumber', params: [] }]
        );
        assert.equal(b1[0]?.result, '0x100');
        assert.deepEqual(hits, [backup], '429 primary RPC must remain skipped at 59s');

        const metricsMid = getRpcCircuitBreakerMetrics(now);
        assert.equal(metricsMid.circuitBreakerTrips, 1);
        assert.equal(metricsMid.circuitBreakerSkips, 2);
        assert.equal(metricsMid.openEndpoints.length, 1);
        assert.equal(metricsMid.openEndpoints[0].url, primary);

        // Advance past 60s cooldown (t=+60_001ms) and recover primary -> primary MUST be resumed!
        hits.length = 0;
        now += 1_001;
        primaryHealthy = true;
        assert.equal(isRpcEndpointInCooldown(primary, now), false);
        const r3 = await evmJsonRpcCall<string>([primary, backup], 'eth_blockNumber', []);
        assert.equal(r3.result, '0x1234');
        assert.deepEqual(hits, [primary], 'Primary RPC must resume immediately after 60s cooldown');
      }
    );

    // Also verify repeated JSON-RPC -32005 rate-limit errors trip cooldown after threshold (2)
    const rlPrimary = 'https://rl-jsonrpc.rpc.test';
    const rlHits: string[] = [];
    await withMockedFetch(
      async (url) => {
        rlHits.push(url);
        if (url === rlPrimary) {
          return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'limit exceeded' } }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xabc' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
      async () => {
        await evmJsonRpcCall<string>([rlPrimary, backup], 'eth_blockNumber', []);
        assert.equal(isRpcEndpointInCooldown(rlPrimary, now), false, '1st JSON-RPC -32005 should not open circuit yet');
        await evmJsonRpcCall<string>([rlPrimary, backup], 'eth_blockNumber', []);
        assert.equal(isRpcEndpointInCooldown(rlPrimary, now), true, '2nd consecutive JSON-RPC -32005 must open circuit');
        rlHits.length = 0;
        await evmJsonRpcCall<string>([rlPrimary, backup], 'eth_blockNumber', []);
        assert.deepEqual(rlHits, [backup], 'Repeatedly rate-limited RPC must be skipped during cooldown');
      }
    );
  } finally {
    resetRpcCircuitBreaker();
  }
});

test('Non-loopback startup guard fails closed without TURGALIUM_ADMIN_SESSION_TOKEN', () => {
  // Loopback hosts allowed without admin token
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
    assert.equal(isLoopbackBindHost(host), true);
    const res = assertSafeStartupConfig({ host, adminSessionToken: undefined });
    assert.equal(res.loopback, true);
  }

  // Non-loopback hosts MUST throw fail-closed without TURGALIUM_ADMIN_SESSION_TOKEN
  for (const host of ['0.0.0.0', '::', '192.168.1.50', '10.0.0.8', 'turgalium.example.com']) {
    assert.equal(isLoopbackBindHost(host), false);
    assert.throws(
      () => assertSafeStartupConfig({ host, adminSessionToken: '' }),
      /TURGALIUM_ADMIN_SESSION_TOKEN/i
    );
    assert.throws(
      () => assertSafeStartupConfig({ host, adminSessionToken: '   ' }),
      /TURGALIUM_ADMIN_SESSION_TOKEN/i
    );
  }

  // Non-loopback host WITH strong token + allowedHosts passes cleanly with zero warnings
  const safe = assertSafeStartupConfig({
    host: '0.0.0.0',
    adminSessionToken: 'a'.repeat(32),
    allowedHosts: 'turgalium.example.com',
  });
  assert.equal(safe.loopback, false);
  assert.equal(safe.warnings.length, 0);
});

test('GET /api/metrics returns structured runtime counters and full HTTP server restart preserves state', async () => {
  const tmpDir = makeTempDir();
  const solDest = Keypair.generate().publicKey.toBase58();
  const adminToken = 'test-prod-admin-session-token-0123456789';

  try {
    // --- Server Instance 1 backed by FileStateStore ---
    const s1 = createTurgaliumServer({
      dataDir: tmpDir,
      adminSessionToken: adminToken,
      rateLimit: { maxRequests: 100, windowMs: 60_000 },
    });
    await new Promise<void>((resolve) => s1.server.listen(0, '127.0.0.1', resolve));
    const addr1 = s1.server.address();
    assert.ok(addr1 && typeof addr1 === 'object');
    const url1 = `http://127.0.0.1:${addr1.port}`;

    // /api/metrics requires admin session when adminSessionToken is set
    const unauthMetrics = await fetch(`${url1}/api/metrics`);
    assert.equal(unauthMetrics.status, 401);

    // Create mandate, issue token, create job via HTTP
    const mandateRes = await fetch(`${url1}/api/agents/mandates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Turgalium-Admin-Session': adminToken,
      },
      body: JSON.stringify({
        name: 'HTTP Restart Mandate',
        ownerAddress: '0x1111111111111111111111111111111111111111',
        lockedSolanaRecipient: solDest,
        maxPerTxUsd: 100,
        dailyCapUsd: 150,
        autoApproveUnderUsd: 90,
      }),
    });
    assert.equal(mandateRes.status, 200);
    const createdMandate = (await mandateRes.json()) as { mandateId: string };

    const tokRes = await fetch(`${url1}/api/plugin/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Turgalium-Admin-Session': adminToken,
      },
      body: JSON.stringify({ label: 'Persist Test MCP', client: 'claude_mcp' }),
    });
    assert.equal(tokRes.status, 200);
    const issuedTok = (await tokRes.json()) as { token: string };

    // Spend $60 against mandate via plugin token
    const aprRes = await fetch(`${url1}/api/agents/approvals`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issuedTok.token}`,
      },
      body: JSON.stringify({
        client: 'claude_mcp',
        mandateId: createdMandate.mandateId,
        actionType: 'dust_convert',
        summary: 'HTTP persisted spend $60',
        sourceWallets: ['0x1111111111111111111111111111111111111111'],
        chains: ['base'],
        solanaDestination: solDest,
        grossUsd: 60,
        estimatedNetUsdc: 54,
        protocolFeeBps: 700,
      }),
    });
    assert.equal(aprRes.status, 200);

    const jobRes = await fetch(`${url1}/api/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Turgalium-Admin-Session': adminToken,
      },
      body: JSON.stringify({
        sourceWallet: '0x1111111111111111111111111111111111111111',
        solanaDestination: solDest,
        outputAsset: 'USDC',
        bridgePreference: 'auto',
        legs: [{ chain: 'base', assetCount: 1, estimatedNetUsd: 54 }],
      }),
    });
    assert.equal(jobRes.status, 200);
    const createdJob = (await jobRes.json()) as { jobId: string };

    // Verify GET /api/metrics structure on instance 1
    const metricsRes = await fetch(`${url1}/api/metrics`, {
      headers: { 'X-Turgalium-Admin-Session': adminToken },
    });
    assert.equal(metricsRes.status, 200);
    const metrics = (await metricsRes.json()) as {
      service: string;
      uptimeSec: number;
      requests: { total?: number; requestsTotal: number; apiRequestsTotal: number; status2xx: number };
      rateLimit: { enabled: boolean; maxRequests: number; allowedTotal: number };
      rpc: { circuitBreakerCooldownMs: number; openEndpoints: unknown[] };
      persistence: { kind: string; persistent: boolean; namespaces: string[] };
      stores: { jobsTotal: number; activeJobs: number; mandatesTotal: number; pluginTokensTotal: number };
    };
    assert.equal(metrics.service, 'turgalium-migrator');
    assert.equal(typeof metrics.uptimeSec, 'number');
    assert.ok(metrics.requests.requestsTotal >= 5);
    assert.ok(metrics.requests.apiRequestsTotal >= 5);
    assert.equal(metrics.rateLimit.enabled, true);
    assert.equal(metrics.rateLimit.maxRequests, 100);
    assert.equal(metrics.rpc.circuitBreakerCooldownMs, 60_000);
    assert.equal(metrics.persistence.kind, 'file');
    assert.equal(metrics.persistence.persistent, true);
    assert.equal(metrics.stores.jobsTotal, 1);
    assert.equal(metrics.stores.activeJobs, 1);
    assert.equal(metrics.stores.mandatesTotal, 1);
    assert.equal(metrics.stores.pluginTokensTotal, 1);

    await new Promise<void>((resolve) => s1.server.close(() => resolve()));

    // --- Server Instance 2 (Simulated Restart) against same dataDir ---
    const s2 = createTurgaliumServer({
      dataDir: tmpDir,
      adminSessionToken: adminToken,
      rateLimit: { enabled: false },
    });
    await new Promise<void>((resolve) => s2.server.listen(0, '127.0.0.1', resolve));
    const addr2 = s2.server.address();
    assert.ok(addr2 && typeof addr2 === 'object');
    const url2 = `http://127.0.0.1:${addr2.port}`;

    try {
      // Old Bearer token still authenticates GET /api/agents/mandates after restart
      const reloadedMandatesRes = await fetch(`${url2}/api/agents/mandates`, {
        headers: { Authorization: `Bearer ${issuedTok.token}` },
      });
      assert.equal(reloadedMandatesRes.status, 200);
      const { mandates } = (await reloadedMandatesRes.json()) as {
        mandates: Array<{ mandateId: string; spentTodayUsd: number; remainingDailyUsd: number }>;
      };
      const foundMandate = mandates.find((m) => m.mandateId === createdMandate.mandateId);
      assert.ok(foundMandate);
      assert.equal(foundMandate.spentTodayUsd, 60);
      assert.equal(foundMandate.remainingDailyUsd, 90);

      // Active job survived restart
      const reloadedJobRes = await fetch(`${url2}/api/jobs/${createdJob.jobId}`, {
        headers: { 'X-Turgalium-Admin-Session': adminToken },
      });
      assert.equal(reloadedJobRes.status, 200);
      const reloadedJob = (await reloadedJobRes.json()) as { jobId: string; status: string };
      assert.equal(reloadedJob.jobId, createdJob.jobId);
      assert.equal(reloadedJob.status, 'active');
    } finally {
      await new Promise<void>((resolve) => s2.server.close(() => resolve()));
    }
  } finally {
    configureGaslessIntentStore(null);
    clearTrackedGaslessIntentsForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Production deployment artifacts (Dockerfile, fly.toml, .env.example) are hardened and secret-free', () => {
  const rootDir = path.resolve(import.meta.dirname, '..');
  const dockerfile = fs.readFileSync(path.join(rootDir, 'Dockerfile'), 'utf8');
  const flyToml = fs.readFileSync(path.join(rootDir, 'fly.toml'), 'utf8');
  const envExample = fs.readFileSync(path.join(rootDir, '.env.example'), 'utf8');

  assert.match(dockerfile, /FROM node:22-slim AS builder/);
  assert.match(dockerfile, /FROM node:22-slim AS runner/);
  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /USER turgalium/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /TURGALIUM_DATA_DIR=\/data/);

  assert.match(flyToml, /\[\[mounts\]\]/);
  assert.match(flyToml, /destination = "\/data"/);
  assert.match(flyToml, /TURGALIUM_DATA_DIR = "\/data"/);
  assert.match(flyToml, /path = "\/api\/health"/);

  for (const key of [
    'TURGALIUM_DATA_DIR=',
    'TURGALIUM_ADMIN_SESSION_TOKEN=',
    'TURGALIUM_RELAYER_PRIVATE_KEY=',
    'TURGALIUM_RATE_LIMIT_MAX=',
    'TURGALIUM_RPC_COOLDOWN_MS=',
    'TURGALIUM_ALLOWED_HOSTS=',
    'TURGALIUM_ALLOWED_ORIGIN=',
    'ETH_RPC_URL=',
    'SOLANA_RPC_URL=',
  ]) {
    assert.ok(envExample.includes(key), `.env.example must document ${key}`);
  }

  // Ensure zero leaked secrets or local absolute paths
  for (const [name, content] of [
    ['Dockerfile', dockerfile],
    ['fly.toml', flyToml],
    ['.env.example', envExample],
  ]) {
    assert.ok(!content.includes('/Users/'), `${name} must not contain local /Users/ paths`);
    assert.ok(!/0x[0-9a-fA-F]{64}/.test(content), `${name} must not contain 64-hex private keys`);
  }
});
