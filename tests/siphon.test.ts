import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMigrationPlan,
  encodeCctpDepositForBurn,
  solanaAddressToBytes32,
} from '../src/bridge/cctp.js';
import { scanPresetWallet } from '../src/scanner/classifier.js';
import {
  decodeMulticall3Aggregate3,
  encodeMulticall3Aggregate3,
  formatUnits,
} from '../src/scanner/rpc.js';
import { createSiphonServer } from '../src/server/app.js';

const SAMPLE_SOLANA_WALLET = 'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n';

test('Multicall3 ABI encoder and decoder handle aggregate3 tuples cleanly', () => {
  const encoded = encodeMulticall3Aggregate3([
    {
      target: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      allowFailure: true,
      callData: '0x70a08231000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045',
    },
  ]);
  assert.ok(encoded.startsWith('0x82ad56cb'));
  assert.equal(formatUnits(12_500_000n, 6), 12.5);

  // Synthetic single-item aggregate3 return: [(true, 0x...0000000000000000000000000000000000000000000000000000000000bebc20)]
  const word = (n: number | bigint) => n.toString(16).padStart(64, '0');
  const syntheticReturn =
    '0x' +
    word(0x20) + // offset to array
    word(1) + // length 1
    word(0x20) + // offset to tuple 0
    word(1) + // success = true
    word(0x40) + // offset to bytes
    word(32) + // byte length 32
    word(12_500_000n); // uint256 value
  const decoded = decodeMulticall3Aggregate3(syntheticReturn);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].success, true);
  assert.equal(BigInt(decoded[0].returnData), 12_500_000n);
});

test('Solana base58 pubkey converts to 32-byte Circle CCTP mintRecipient and valid depositForBurn calldata', () => {
  const bytes32 = solanaAddressToBytes32(SAMPLE_SOLANA_WALLET);
  assert.match(bytes32, /^0x[0-9a-f]{64}$/);

  const calldata = encodeCctpDepositForBurn({
    rawUsdcAmount: 1_500_000_000n, // 1500 USDC
    destinationDomain: 5,
    solanaMintRecipientBytes32: bytes32,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  });
  assert.ok(calldata.startsWith('0x6fd3504e'));
  assert.equal(calldata.length, 2 + 8 + 64 * 4);
});

test('Preset multi-chain scan reconciles DeFi withdrawals, liquid dust, zero-liq burns, and honeypot skips', async () => {
  const report = await scanPresetWallet('veteran_defi');
  assert.equal(report.chainsScanned, 6);
  assert.ok(report.totals.defiPositionCount >= 5);
  assert.ok(report.totals.liquidDustCount >= 7);
  assert.ok(report.totals.burnCandidateCount >= 4);
  assert.equal(report.totals.honeypotSkippedCount, 1);
  assert.ok(report.totals.netSolanaUsdc > 1000);
  assert.ok(report.totals.gasSavedUsd > 0);

  const plan = buildMigrationPlan({
    scan: report,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    usePermit2Batch: true,
    includeBurns: true,
  });
  assert.ok(plan.legs.length >= 5);
  assert.equal(plan.totals.tokensBurnedCount, report.totals.burnCandidateCount);
  assert.equal(plan.totals.honeypotsSkippedCount, 1);
  assert.ok(plan.burnManifest.some((b) => b.status === 'SKIPPED_HONEYPOT'));
  assert.ok(plan.burnManifest.some((b) => b.status === 'BURN_READY'));

  // Exact net reconciliation across all legs
  const legSum = Number(plan.legs.reduce((s, l) => s + l.bridgedUsdc, 0).toFixed(2));
  assert.equal(plan.totals.netSolanaUsdc, legSum);
});

test('Siphon HTTP API serves health, chains, scan, plan, simulate, contract, and vendor Three.js', async () => {
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const health = await fetch(`${base}/api/health`).then((r) => r.json());
    assert.equal(health.status, 'ok');
    assert.equal(health.solanaCctpDomain, 5);

    const scan = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId: 'veteran_defi' }),
    }).then((r) => r.json());
    assert.ok(scan.scanId);

    // Invalid Solana destination returns 400
    const badPlan = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId: scan.scanId, solanaDestination: 'not-a-solana-key' }),
    });
    assert.equal(badPlan.status, 400);

    // Valid plan + simulation
    const sim = await fetch(`${base}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scanId: scan.scanId,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        usePermit2Batch: true,
        includeBurns: true,
      }),
    }).then((r) => r.json());
    assert.ok(sim.executions.length >= 5);
    assert.ok(sim.plan.totals.netSolanaUsdc > 0);

    const contract = await fetch(`${base}/api/contract`).then((r) => r.json());
    assert.ok(contract.source.includes('contract SiphonRouter'));
    assert.ok(contract.source.includes('depositForBurn'));

    const threeRes = await fetch(`${base}/vendor/three.module.js`);
    assert.equal(threeRes.status, 200);
    await threeRes.text();
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
