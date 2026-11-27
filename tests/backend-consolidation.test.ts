import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { pollBridgeStatusesBatch, MAX_BRIDGE_STATUS_BATCH } from '../src/execution/bridge-status-batch.js';
import { computeDefiDisplayMetadata } from '../src/scanner/defi-display.js';
import { buildAgentHandoffKit } from '../src/agent/review-link.js';
import { createTurgaliumServer } from '../src/server/app.js';

const VALID_EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const VALID_SOL = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

test('Wave 22 pollBridgeStatusesBatch: polls CCTP V2 attestation and Relay settlement in parallel', async () => {
  const res = await pollBridgeStatusesBatch(
    [
      {
        id: 'leg-cctp',
        chain: 'base',
        chainName: 'Base',
        txHash: '0x' + 'aa'.repeat(32),
        provider: 'Circle CCTP V2 Fast',
        solanaDestination: VALID_SOL,
        status: 'relaying',
      },
      {
        id: 'leg-relay',
        chain: 'arbitrum',
        chainName: 'Arbitrum',
        txHash: '0x' + 'bb'.repeat(32),
        provider: 'Relay',
        status: 'confirming',
      },
    ],
    {
      fetchCctpAttestation: async () =>
        ({
          attestationStatus: 'complete',
          nextStep: 'Attested by Circle Iris — ready to claim on Solana',
        }) as Awaited<ReturnType<typeof import('../src/bridge/cctp.js').fetchCctpAttestationForTx>>,
      checkExecutionStatus: async () => ({
        evmConfirmed: true,
        evmFailed: false,
        bridgeStatus: 'completed',
        solanaTxHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        details: 'Settled on Solana in 4s',
      }),
    }
  );

  assert.equal(res.count, 2);
  assert.equal(res.anyLanded, true);
  const cctp = res.results.find((r) => r.id === 'leg-cctp')!;
  assert.equal(cctp.status, 'attested');
  assert.equal(cctp.requiresSolanaClaim, true);
  const relay = res.results.find((r) => r.id === 'leg-relay')!;
  assert.equal(relay.status, 'landed');
  assert.equal(relay.solanaTxHash, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');

  // Enforces max batch size
  await assert.rejects(
    () =>
      pollBridgeStatusesBatch(
        Array.from({ length: MAX_BRIDGE_STATUS_BATCH + 1 }, (_, i) => ({
          id: `b-${i}`,
          chain: 'base',
          txHash: '0x' + '11'.repeat(32),
        }))
      ),
    /Maximum/i
  );
});

test('Wave 22 computeDefiDisplayMetadata & buildAgentHandoffKit: canonical backend metadata', () => {
  const lido = computeDefiDisplayMetadata({
    chain: 'ethereum',
    family: 'evm',
    symbol: 'wstETH',
    name: 'Wrapped Lido Staked ETH',
    uiBalance: 1.5,
    protocol: 'Lido',
    underlyingSymbol: 'ETH',
  });
  assert.equal(lido.category, 'instant_swap');
  assert.equal(lido.protocolGroup, 'Lido');
  assert.match(lido.badgeText, /Instant Swap/i);

  const aaveDebt = computeDefiDisplayMetadata({
    chain: 'arbitrum',
    family: 'evm',
    symbol: 'aArbUSDC',
    name: 'Aave v3 USDC',
    uiBalance: 2500,
    protocol: 'Aave v3',
    underlyingSymbol: 'USDC',
    aaveDebtUsd: 400,
  });
  assert.equal(aaveDebt.category, 'debt_guard');
  assert.match(aaveDebt.badgeText, /Debt Guard/i);

  const kit = buildAgentHandoffKit({
    baseUrl: 'https://turgalium.vercel.app',
    wallet: VALID_EVM,
    solanaDestination: VALID_SOL,
    outputAsset: 'SOL',
    agentName: 'Claude',
  });
  assert.equal(kit.nonCustodial, true);
  assert.equal(kit.privateKeyRequired, false);
  assert.ok(kit.reviewUrl?.includes(`wallet=${VALID_EVM}`));
  assert.ok(kit.chatgptUrl.startsWith('https://chatgpt.com/?q='));
  assert.ok(kit.claudeUrl.startsWith('https://claude.ai/new?q='));
  assert.ok(kit.prompt.includes('NEVER ask me for a private key'));
  assert.equal(kit.endpoints.workspaceHydrateApi, 'https://turgalium.vercel.app/api/workspace/hydrate');
});

test('Wave 22 HTTP endpoints: /api/workspace/hydrate, /api/bridge/status-batch, /api/agent/handoff', async () => {
  const { server } = createTurgaliumServer({
    enableBackgroundPollers: false,
    rateLimit: { enabled: false },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Single-round-trip workspace hydrate (preset scan + plan + preservation in 1 POST)
    const hydRes = await fetch(`${base}/api/workspace/hydrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        presetId: 'veteran_defi',
        outputAsset: 'USDC',
      }),
    });
    assert.equal(hydRes.status, 200);
    const hyd = (await hydRes.json()) as {
      scan: { scanId: string; assets: Array<{ kind: string; defiDisplay?: { protocolGroup: string } }> };
      plan: { totals: { protocolFeeUsd: number } };
      preservation: Record<string, unknown> | null;
    };
    assert.ok(hyd.scan.scanId);
    assert.equal(hyd.plan.totals.protocolFeeUsd, 0);
    const defiAssets = hyd.scan.assets.filter((a) => a.kind === 'defi_position');
    assert.ok(defiAssets.length > 0, 'Preset must contain DeFi positions');
    assert.ok(
      defiAssets.every((a) => Boolean(a.defiDisplay?.protocolGroup)),
      'Every DeFi asset must include backend-computed defiDisplay'
    );

    // 2. /api/agent/handoff
    const handoffRes = await fetch(`${base}/api/agent/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: VALID_EVM,
        solanaDestination: VALID_SOL,
        agentName: 'ChatGPT',
      }),
    });
    assert.equal(handoffRes.status, 200);
    const handoff = (await handoffRes.json()) as { reviewUrl: string; prompt: string };
    assert.ok(handoff.reviewUrl.includes(`wallet=${VALID_EVM}`));
    assert.ok(handoff.prompt.includes('/api/workspace/hydrate'));

    // 3. /api/bridge/status-batch rejects > 12 entries with 400, accepts empty array with 200
    const emptyBatchRes = await fetch(`${base}/api/bridge/status-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridges: [] }),
    });
    assert.equal(emptyBatchRes.status, 200);
    const emptyBatch = (await emptyBatchRes.json()) as { count: number; results: unknown[] };
    assert.equal(emptyBatch.count, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
