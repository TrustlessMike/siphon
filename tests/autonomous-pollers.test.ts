import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PreservationAgentStore,
  type GasWatchEvaluationResult,
  type GasWatchTrigger,
} from '../src/agent/preservation-agents.js';
import {
  MAX_UNLOCK_WATCHES,
  UnlockHarvesterStore,
  type UnlockHarvestAlert,
} from '../src/agent/unlock-harvester.js';
import type { LiveUnlockQueuesReport, LiveUnlockScheduleItem } from '../src/defi/unlock-readers.js';
import { createTurgaliumServer } from '../src/server/app.js';
import { parsePollersEnabled } from '../src/server/index.js';
import { FileStateStore } from '../src/storage/state-store.js';

const EVM_WALLET = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const EVM_WALLET_2 = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const COSMOS_WALLET = 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu';
const SOL_DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeUnlockItem(overrides: Partial<LiveUnlockScheduleItem> = {}): LiveUnlockScheduleItem {
  return {
    id: 'lido:ethereum:42001',
    kind: 'lido_withdrawal',
    chain: 'ethereum',
    chainName: 'Ethereum',
    symbol: 'stETH',
    protocol: 'Lido Withdrawal Queue',
    estimatedUsd: 3750,
    unlockAtMs: Date.now() - 1000,
    unlockAtIso: new Date(Date.now() - 1000).toISOString(),
    secondsRemaining: 0,
    status: 'ready_to_claim',
    actionLabel: 'Claim 1.5 ETH from Lido NFT #42001',
    source: 'lido_withdrawal_queue',
    uiAmount: 1.5,
    rawAmount: '1500000000000000000',
    requestId: '42001',
    contractAddress: '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1',
    claimMethod: 'claimWithdrawal(uint256)',
    ...overrides,
  };
}

function makeUnlockReport(items: LiveUnlockScheduleItem[], warnings: string[] = []): LiveUnlockQueuesReport {
  return {
    readAt: new Date().toISOString(),
    items,
    lido: [],
    ethena: [],
    cosmos: [],
    warnings,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('Gas-Window Watchdog poller skips RPC when idle, fires when gas drops, guards overlapping ticks, and persists across FileStateStore restart', async () => {
  const dir = makeTempDir('turgalium-gas-poller-');
  try {
    const fileStore = new FileStateStore(dir);
    let fakeNow = Date.parse('2026-11-26T00:00:00.000Z');
    let rpcCalls = 0;
    let currentGas = 32;
    const triggeredEvents: Array<{ trigger: GasWatchTrigger; evalResult: GasWatchEvaluationResult }> = [];

    const store = new PreservationAgentStore({
      nowMs: () => fakeNow,
      stateStore: fileStore,
    });

    // 1. Zero idle cost: running poller ticks with 0 armed triggers MUST NOT call fetchGasGwei
    const idleRes = await store.runPollerTick({
      fetchGasGwei: async () => {
        rpcCalls += 1;
        return currentGas;
      },
    });
    assert.equal(idleRes, null);
    assert.equal(rpcCalls, 0);
    assert.equal(store.getPollerStatus().skippedIdleTicks, 1);
    assert.equal(store.getPollerMetrics().rpcFetchCount, 0);

    // 2. Arm a trigger; while gas is 32 > 15, it stays watching
    const trigger = store.createTrigger({
      sourceWallet: EVM_WALLET,
      solanaDestination: SOL_DEST,
      chain: 'ethereum',
      maxBaseFeeGwei: 15,
      estimatedSavingsUsd: 22.5,
    });
    assert.equal(trigger.status, 'watching');

    // 3. Test overlapping tick lock: start a slow tick and ensure concurrent tick is dropped
    let releaseSlowRpc!: () => void;
    const slowRpcGate = new Promise<void>((resolve) => {
      releaseSlowRpc = resolve;
    });
    let concurrentRpcCalls = 0;
    const firstTickPromise = store.runPollerTick({
      fetchGasGwei: async () => {
        concurrentRpcCalls += 1;
        await slowRpcGate;
        return 32;
      },
    });
    assert.equal(store.getPollerStatus().tickInFlight, true);
    const droppedTick = await store.runPollerTick({
      fetchGasGwei: async () => {
        concurrentRpcCalls += 1;
        return 10;
      },
    });
    assert.equal(droppedTick, null);
    assert.equal(concurrentRpcCalls, 1);
    releaseSlowRpc();
    const firstRes = await firstTickPromise;
    assert.ok(firstRes);
    assert.equal(store.getPollerStatus().tickInFlight, false);
    assert.equal(store.getTrigger(trigger.id)?.status, 'watching');

    // 4. Start real `.unref()` interval poller; drop gas below threshold and verify transition + callback resilience
    currentGas = 11.4;
    let callbackAttempts = 0;
    store.startPoller({
      intervalMs: 30,
      fetchGasGwei: async () => {
        rpcCalls += 1;
        return currentGas;
      },
      onTriggered: async (tr, ev) => {
        callbackAttempts += 1;
        triggeredEvents.push({ trigger: tr, evalResult: ev });
        // Throw inside callback to confirm poller catches and does not crash
        throw new Error('simulated notification webhook error');
      },
    });
    assert.equal(store.getPollerStatus().running, true);

    // Wait up to 500ms for interval tick to fire
    for (let i = 0; i < 20 && triggeredEvents.length === 0; i += 1) {
      await sleep(25);
    }

    assert.equal(triggeredEvents.length, 1);
    assert.equal(callbackAttempts, 1);
    assert.equal(triggeredEvents[0].trigger.id, trigger.id);
    assert.equal(triggeredEvents[0].trigger.status, 'ready');
    assert.equal(triggeredEvents[0].trigger.autoExecuteAllowed, false); // fail-closed without mandate
    assert.ok(rpcCalls >= 1);

    // After trigger moved to 'ready', armedCount === 0 so subsequent ticks MUST skip RPC!
    const rpcCallsAfterTrigger = rpcCalls;
    await sleep(90);
    assert.equal(rpcCalls, rpcCallsAfterTrigger);
    assert.ok(store.getPollerStatus().skippedIdleTicks >= 2);
    assert.equal(store.getPollerStatus().errorCount, 1); // captured callback error cleanly

    // 5. Stop poller cleanly
    store.stopPoller();
    assert.equal(store.getPollerStatus().running, false);

    // 6. Restart persistence check: reload from FileStateStore on disk
    const reloadedStore = new PreservationAgentStore({
      nowMs: () => fakeNow,
      stateStore: new FileStateStore(dir),
    });
    const persisted = reloadedStore.getTrigger(trigger.id);
    assert.ok(persisted);
    assert.equal(persisted.status, 'ready');
    assert.equal(persisted.lastObservedGwei, 11.4);
    assert.equal(persisted.autoExecuteAllowed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Unlock Harvester validates addresses, detects matured Lido/Ethena/Cosmos unlocks, deduplicates alerts, caps at 50, and persists across restart', async () => {
  const dir = makeTempDir('turgalium-unlock-harvester-');
  try {
    const fileStore = new FileStateStore(dir);
    let rpcCalls = 0;
    const readyAlertsReceived: UnlockHarvestAlert[] = [];

    const harvester = new UnlockHarvesterStore({
      stateStore: fileStore,
    });

    // 1. Strict address validation rejects malformed / non-string / zero addresses
    assert.throws(() => harvester.createWatch({ walletAddress: 12345 as unknown as string }));
    assert.throws(() => harvester.createWatch({ walletAddress: 'not-a-wallet' }));
    assert.throws(() =>
      harvester.createWatch({ walletAddress: '0x0000000000000000000000000000000000000000' })
    );
    assert.throws(() => harvester.createWatch({ evmAddresses: [42 as unknown as string] }));
    assert.throws(() => harvester.createWatch({ cosmosAddresses: ['invalid_cosmos'] }));
    assert.throws(() =>
      harvester.createWatch({
        walletAddress: EVM_WALLET,
        solanaDestination: 'bad-sol-dest!',
      })
    );
    assert.throws(() => harvester.createWatch({}));

    // 2. Zero idle cost when 0 active watches
    const idleTick = await harvester.runPollerTick({
      readUnlockQueues: async () => {
        rpcCalls += 1;
        return makeUnlockReport([]);
      },
    });
    assert.equal(idleTick, null);
    assert.equal(rpcCalls, 0);
    assert.equal(harvester.getPollerStatus().skippedIdleTicks, 1);

    // 3. Register multi-chain watch (EVM + Cosmos + Solana destination)
    const watch = harvester.createWatch({
      walletAddress: EVM_WALLET,
      cosmosAddresses: [COSMOS_WALLET],
      solanaDestination: SOL_DEST,
      label: 'Primary Vault Unlocks',
    });
    assert.equal(watch.status, 'watching');
    assert.equal(watch.evmAddresses.length, 1);
    assert.equal(watch.cosmosAddresses.length, 1);

    // 4. First check detects matured Lido NFT + Ethena cooldown + Cosmos unbonding, plus 1 pending unlock
    const lidoReady = makeUnlockItem({
      id: 'lido:ethereum:9001',
      kind: 'lido_withdrawal',
      requestId: '9001',
      status: 'ready_to_claim',
    });
    const ethenaReady = makeUnlockItem({
      id: `ethena:ethereum:susde:${EVM_WALLET.toLowerCase()}`,
      kind: 'ethena_cooldown',
      symbol: 'sUSDe',
      protocol: 'Ethena sUSDe',
      estimatedUsd: 1200,
      status: 'ready_to_claim',
      actionLabel: 'Unstake 1200 USDe via Ethena unstake(address)',
      requestId: undefined,
    });
    const cosmosReady = makeUnlockItem({
      id: 'cosmos:cosmoshub:cosmosvaloper1abc:77',
      kind: 'cosmos_unbonding',
      chain: 'cosmoshub',
      chainName: 'Cosmos Hub',
      symbol: 'ATOM',
      protocol: 'Cosmos Hub Staking Unbonding',
      estimatedUsd: 900,
      status: 'ready_to_claim',
      actionLabel: 'Unbonded 200 ATOM — ready to bridge to Solana',
      validatorAddress: 'cosmosvaloper1abc',
      requestId: undefined,
    });
    const lidoPending = makeUnlockItem({
      id: 'lido:ethereum:9002',
      kind: 'lido_withdrawal',
      requestId: '9002',
      status: 'locked_waiting',
      secondsRemaining: 86400,
      actionLabel: 'Lido NFT #9002 finalizing (~1d)',
    });

    const mockReader = async () => {
      rpcCalls += 1;
      return makeUnlockReport([lidoReady, ethenaReady, cosmosReady, lidoPending]);
    };

    const firstCheck = await harvester.checkAllWatches({
      readUnlockQueues: mockReader,
      onReadyUnlock: (alert) => {
        readyAlertsReceived.push(alert);
      },
    });
    assert.equal(firstCheck.checkedWatches, 1);
    assert.equal(firstCheck.readyWatches, 1);
    assert.equal(firstCheck.totalReadyUnlocks, 3);
    assert.equal(firstCheck.totalPendingUnlocks, 1);
    assert.equal(firstCheck.newAlerts.length, 3);
    assert.equal(readyAlertsReceived.length, 3);
    assert.ok(readyAlertsReceived.every((a) => a.requiresHumanApproval === true));

    // 5. Repeat check MUST deduplicate already-notified Lido/Ethena/Cosmos unlocks (0 new alerts!)
    const secondCheck = await harvester.checkAllWatches({
      readUnlockQueues: mockReader,
      onReadyUnlock: (alert) => {
        readyAlertsReceived.push(alert);
      },
    });
    assert.equal(secondCheck.totalReadyUnlocks, 3);
    assert.equal(secondCheck.newAlerts.length, 0);
    assert.equal(readyAlertsReceived.length, 3);

    // 6. Restart persistence: reload from FileStateStore and verify notifiedKeys prevent duplicate alerts after restart
    const reloaded = new UnlockHarvesterStore({
      stateStore: new FileStateStore(dir),
    });
    const reloadedWatch = reloaded.getWatch(watch.id);
    assert.ok(reloadedWatch);
    assert.equal(reloadedWatch.status, 'ready_to_claim');
    assert.equal(reloadedWatch.readyUnlocks.length, 3);
    assert.equal(reloadedWatch.pendingUnlocksCount, 1);
    assert.equal(reloadedWatch.notifiedKeys.length, 3);
    assert.equal(reloaded.listAlerts(watch.id).length, 3);

    const postRestartCheck = await reloaded.checkAllWatches({ readUnlockQueues: mockReader });
    assert.equal(postRestartCheck.newAlerts.length, 0);

    // 7. Enforce MAX_UNLOCK_WATCHES (50) bounded LRU cap
    const capStore = new UnlockHarvesterStore();
    const createdIds: string[] = [];
    for (let i = 0; i < MAX_UNLOCK_WATCHES + 5; i += 1) {
      const w = capStore.createWatch({
        walletAddress: i % 2 === 0 ? EVM_WALLET : EVM_WALLET_2,
        label: `Watch #${i}`,
      });
      createdIds.push(w.id);
    }
    assert.equal(capStore.size, MAX_UNLOCK_WATCHES);
    assert.equal(capStore.getWatch(createdIds[0]), null);
    assert.equal(capStore.getWatch(createdIds[4]), null);
    assert.ok(capStore.getWatch(createdIds[5]));
    assert.ok(capStore.getWatch(createdIds[MAX_UNLOCK_WATCHES + 4]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP /api/agents/unlock-watch CRUD, adminSessionToken auth guard, /api/metrics pollers telemetry, and clean shutdown on server.close()', async () => {
  const adminToken = 'super-secret-admin-session-token-9b';
  let mockEthGwei = 25;
  let unlockCheckCalls = 0;
  let readyItems: LiveUnlockScheduleItem[] = [];

  const { server, preservationAgents, unlockHarvester } = createTurgaliumServer({
    adminSessionToken: adminToken,
    enableBackgroundPollers: true,
    gasPollIntervalMs: 35,
    unlockPollIntervalMs: 35,
    liveGasFetcher: async () => mockEthGwei,
    unlockQueuesReader: async () => {
      unlockCheckCalls += 1;
      return makeUnlockReport(readyItems);
    },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const adminHeaders = {
    'Content-Type': 'application/json',
    'X-Turgalium-Admin-Session': adminToken,
  };

  try {
    // 1. Both pollers are running on startup when enableBackgroundPollers: true
    assert.equal(preservationAgents.getPollerStatus().running, true);
    assert.equal(unlockHarvester.getPollerStatus().running, true);

    // 2. Unauthenticated requests to unlock-watch endpoints & /api/metrics return 401 when adminSessionToken is set
    const unauthGet = await fetch(`${baseUrl}/api/agents/unlock-watch`);
    assert.equal(unauthGet.status, 401);

    const unauthPost = await fetch(`${baseUrl}/api/agents/unlock-watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress: EVM_WALLET }),
    });
    assert.equal(unauthPost.status, 401);

    const unauthCheck = await fetch(`${baseUrl}/api/agents/unlock-watch/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(unauthCheck.status, 401);

    const unauthDelete = await fetch(`${baseUrl}/api/agents/unlock-watch/uw_fake`, {
      method: 'DELETE',
    });
    assert.equal(unauthDelete.status, 401);

    // 3. Cross-origin CSRF blocked with 403 even with admin header
    const csrfRes = await fetch(`${baseUrl}/api/agents/unlock-watch`, {
      method: 'POST',
      headers: {
        ...adminHeaders,
        Origin: 'https://evil-attacker.example',
      },
      body: JSON.stringify({ walletAddress: EVM_WALLET }),
    });
    assert.equal(csrfRes.status, 403);

    // 4. Malformed / non-string addresses return HTTP 400
    const badTypeRes = await fetch(`${baseUrl}/api/agents/unlock-watch`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ walletAddress: { nested: true } }),
    });
    assert.equal(badTypeRes.status, 400);

    const badAddrRes = await fetch(`${baseUrl}/api/agents/unlock-watch`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ evmAddresses: ['0x1234'] }),
    });
    assert.equal(badAddrRes.status, 400);

    // 5. Register unlock watch via POST /api/agents/unlock-watch
    const createRes = await fetch(`${baseUrl}/api/agents/unlock-watch`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        walletAddress: EVM_WALLET,
        cosmosAddresses: [COSMOS_WALLET],
        solanaDestination: SOL_DEST,
      }),
    });
    assert.equal(createRes.status, 200);
    const created = (await createRes.json()) as { id: string; status: string };
    assert.ok(created.id.startsWith('uw_'));
    assert.equal(created.status, 'watching');

    // 6. Trigger immediate unlock check via POST /api/agents/unlock-watch/check
    readyItems = [makeUnlockItem({ id: 'lido:ethereum:555', requestId: '555' })];
    const checkRes = await fetch(`${baseUrl}/api/agents/unlock-watch/check`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(checkRes.status, 200);
    const checkData = (await checkRes.json()) as {
      checkedWatches: number;
      readyWatches: number;
      totalReadyUnlocks: number;
      newAlerts: UnlockHarvestAlert[];
    };
    assert.equal(checkData.checkedWatches, 1);
    assert.equal(checkData.readyWatches, 1);
    assert.equal(checkData.totalReadyUnlocks, 1);
    assert.ok(unlockCheckCalls >= 1);

    // 7. GET /api/agents/unlock-watch returns watches, summary, and poller status
    const listRes = await fetch(`${baseUrl}/api/agents/unlock-watch`, {
      headers: { 'X-Turgalium-Admin-Session': adminToken },
    });
    assert.equal(listRes.status, 200);
    const listData = (await listRes.json()) as {
      watches: Array<{ id: string; status: string }>;
      alerts: UnlockHarvestAlert[];
      summary: { activeWatches: number; readyWatches: number; totalReadyUnlocks: number };
      poller: { running: boolean };
    };
    assert.equal(listData.watches.length, 1);
    assert.equal(listData.watches[0].status, 'ready_to_claim');
    assert.equal(listData.summary.readyWatches, 1);
    assert.equal(listData.alerts.length, 1);
    assert.equal(listData.poller.running, true);

    // 8. GET /api/agents/gas-watch exposes poller status & autonomous gas trigger fires human-permissioned approval
    const armRes = await fetch(`${baseUrl}/api/agents/gas-watch`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        sourceWallet: EVM_WALLET,
        solanaDestination: SOL_DEST,
        chain: 'ethereum',
        maxBaseFeeGwei: 15,
        estimatedSavingsUsd: 18,
      }),
    });
    assert.equal(armRes.status, 200);
    mockEthGwei = 10;
    for (let i = 0; i < 20; i += 1) {
      if (preservationAgents.getPollerStatus().triggeredCount >= 1) break;
      await sleep(25);
    }
    assert.ok(preservationAgents.getPollerStatus().triggeredCount >= 1);

    const gasWatchRes = await fetch(`${baseUrl}/api/agents/gas-watch`, {
      headers: { 'X-Turgalium-Admin-Session': adminToken },
    });
    assert.equal(gasWatchRes.status, 200);
    const gasWatchData = (await gasWatchRes.json()) as {
      poller: { running: boolean; triggeredCount: number };
    };
    assert.equal(gasWatchData.poller.running, true);
    assert.ok(gasWatchData.poller.triggeredCount >= 1);

    // 9. GET /api/metrics exposes live pollers telemetry
    const metricsRes = await fetch(`${baseUrl}/api/metrics`, {
      headers: { 'X-Turgalium-Admin-Session': adminToken },
    });
    assert.equal(metricsRes.status, 200);
    const metrics = (await metricsRes.json()) as {
      stores: { gasWatchTriggersTotal: number; unlockWatchesTotal: number };
      pollers: {
        gasWatch: { running: boolean; triggeredCount: number };
        unlockHarvester: { running: boolean; activeWatches: number; alertsCount: number };
      };
    };
    assert.equal(metrics.stores.gasWatchTriggersTotal, 1);
    assert.equal(metrics.stores.unlockWatchesTotal, 1);
    assert.equal(metrics.pollers.gasWatch.running, true);
    assert.equal(metrics.pollers.unlockHarvester.running, true);
    assert.equal(metrics.pollers.unlockHarvester.activeWatches, 1);
    assert.equal(metrics.pollers.unlockHarvester.alertsCount, 1);

    // 10. DELETE /api/agents/unlock-watch/:id cancels & removes cleanly; second DELETE returns 404
    const delRes = await fetch(`${baseUrl}/api/agents/unlock-watch/${created.id}`, {
      method: 'DELETE',
      headers: { 'X-Turgalium-Admin-Session': adminToken },
    });
    assert.equal(delRes.status, 200);
    const delData = (await delRes.json()) as { id: string; status: string; deleted: boolean };
    assert.equal(delData.id, created.id);
    assert.equal(delData.status, 'cancelled');
    assert.equal(delData.deleted, true);

    const delAgainRes = await fetch(`${baseUrl}/api/agents/unlock-watch/${created.id}`, {
      method: 'DELETE',
      headers: { 'X-Turgalium-Admin-Session': adminToken },
    });
    assert.equal(delAgainRes.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // 11. Both pollers MUST be stopped cleanly on server.close()
  assert.equal(preservationAgents.getPollerStatus().running, false);
  assert.equal(unlockHarvester.getPollerStatus().running, false);
});

test('TURGALIUM_ENABLE_POLLERS defaults to true in process entrypoint and createTurgaliumServer defaults pollers off in tests', () => {
  assert.equal(parsePollersEnabled(undefined), true);
  assert.equal(parsePollersEnabled(''), true);
  assert.equal(parsePollersEnabled('true'), true);
  assert.equal(parsePollersEnabled('1'), true);
  assert.equal(parsePollersEnabled('false'), false);
  assert.equal(parsePollersEnabled('0'), false);
  assert.equal(parsePollersEnabled('off'), false);

  const { preservationAgents, unlockHarvester } = createTurgaliumServer();
  assert.equal(preservationAgents.getPollerStatus().running, false);
  assert.equal(unlockHarvester.getPollerStatus().running, false);
});
