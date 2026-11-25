import assert from 'node:assert/strict';
import test from 'node:test';
import { aptosAdapter } from '../src/adapters/aptos.js';
import { btcAdapter, classifyBtcUtxos } from '../src/adapters/btc.js';
import { cosmosAdapter } from '../src/adapters/cosmos.js';
import { detectAddressFamily, listAllFamilyMetas } from '../src/adapters/registry.js';
import { suiAdapter } from '../src/adapters/sui.js';
import { tonAdapter } from '../src/adapters/ton.js';
import { tronAdapter } from '../src/adapters/tron.js';
import {
  buildMigrationPlan,
  CCTP_MESSAGE_SENT_TOPIC,
  encodeCctpDepositForBurn,
  extractCctpMessageFromLogs,
  solanaAddressToBytes32,
} from '../src/bridge/cctp.js';
import { prepareChainBatchExecution, prepareRealExecution } from '../src/execution/tx-builder.js';
import { CHAIN_LIST, EVM_CHAINS, getProtocolFeeConfig, resolveProtocolFeeBps } from '../src/scanner/chains.js';
import { scanPresetWallet } from '../src/scanner/classifier.js';
import { decodeAaveAccountData } from '../src/scanner/discovery.js';
import {
  computeRelayerBreakEven,
  evaluateAssetRoi,
  evaluateChainBatchRoi,
  evaluatePortfolioRoi,
  pruneNegativeRoiAssets,
} from '../src/scanner/roi.js';
import {
  decodeMulticall3Aggregate3,
  encodeMulticall3Aggregate3,
  formatUnits,
} from '../src/scanner/rpc.js';
import type { ScannedAsset } from '../src/scanner/types.js';
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
  assert.equal(report.chainsScanned, 14);
  assert.ok(report.totals.defiPositionCount >= 5);
  assert.ok(report.totals.liquidDustCount >= 7);
  assert.ok(report.totals.burnCandidateCount >= 4);
  assert.equal(report.totals.honeypotSkippedCount, 1);
  assert.ok(report.totals.netSolanaUsdc > 1000);
  assert.ok(report.totals.gasSavedUsd > 0);

  // By default, $0 dead-token burns are opt-in (NOT auto-selected) to prevent wasted gas & spam popups
  const defaultPlan = buildMigrationPlan({
    scan: report,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    usePermit2Batch: true,
    includeBurns: true,
  });
  assert.ok(defaultPlan.legs.length >= 5);
  assert.equal(defaultPlan.totals.tokensBurnedCount, 0);

  // When user explicitly selects all assets including dead burns, burn manifest reconciles cleanly
  const plan = buildMigrationPlan({
    scan: report,
    selectedAssetIds: report.assets.filter((a) => a.action !== 'SKIP_HONEYPOT').map((a) => a.id),
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

    // Real executable Aave v3 withdrawal calldata preparation
    const aaveAsset = scan.assets.find((a: { protocol?: string }) => a.protocol === 'Aave v3');
    assert.ok(aaveAsset);
    const aavePrep = await fetch(`${base}/api/tx/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: aaveAsset,
        userAddress: scan.walletAddress,
        solanaDestination: SAMPLE_SOLANA_WALLET,
      }),
    }).then((r) => r.json());
    assert.equal(aavePrep.provider, 'aave_v3');
    assert.ok(aavePrep.transactions[0].data.startsWith('0x69328dec'));

    // Real direct Circle CCTP USDC calldata preparation
    const opUsdc = scan.assets.find(
      (a: { chain: string; symbol: string }) => a.chain === 'optimism' && a.symbol === 'USDC'
    );
    assert.ok(opUsdc);
    const cctpPrep = await fetch(`${base}/api/tx/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset: opUsdc,
        userAddress: scan.walletAddress,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        bridgePreference: 'cctp',
      }),
    }).then((r) => r.json());
    assert.equal(cctpPrep.provider, 'circle_cctp');
    assert.ok(
      cctpPrep.transactions.some((tx: { data: string }) => tx.data.startsWith('0x6fd3504e'))
    );

    // EIP-5792 1-click-per-chain batch preparation: bundles DeFi withdraw + CCTP + burn + dedupes approvals
    const polygonAssets = scan.assets.filter(
      (a: { chain: string }) => a.chain === 'polygon'
    );
    const polyBatch = await fetch(`${base}/api/tx/prepare-chain-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'polygon',
        assets: polygonAssets,
        userAddress: scan.walletAddress,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        bridgePreference: 'cctp',
        bundleDefiCctp: true,
      }),
    }).then((r) => r.json());
    assert.equal(polyBatch.chain, 'polygon');
    assert.equal(polyBatch.savings.walletPopupsEip5792, 1);
    assert.equal(polyBatch.calls.length, 3); // Aave withdraw + USDC approve + CCTP depositForBurn in 1 click!
    assert.equal(polyBatch.savings.popupsSaved, 2);
    assert.ok(polyBatch.calls[0].data.startsWith('0x69328dec')); // Aave withdraw
    assert.ok(polyBatch.calls[1].data.startsWith('0x095ea7b3')); // USDC approve
    assert.ok(polyBatch.calls[2].data.startsWith('0x6fd3504e')); // Circle CCTP depositForBurn
    assert.equal(polyBatch.skippedAssets.length, 1); // Polygon honeypot safely skipped

    // Approval deduplication test: 2 CCTP USDC ops on Optimism merge their USDC->TokenMessenger approvals into 1!
    const opBatch = await fetch(`${base}/api/tx/prepare-chain-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'optimism',
        assets: [opUsdc, { ...opUsdc, id: 'op_usdc_dup_2' }],
        userAddress: scan.walletAddress,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        bridgePreference: 'cctp',
      }),
    }).then((r) => r.json());
    assert.equal(opBatch.savings.dedupedApprovals, 1);
    assert.equal(
      opBatch.calls.filter((c: { data: string }) => c.data.startsWith('0x095ea7b3')).length,
      1
    );
    assert.equal(
      opBatch.calls.filter((c: { data: string }) => c.data.startsWith('0x6fd3504e')).length,
      2
    );
    assert.equal(opBatch.savings.walletPopupsEip5792, 1);
    assert.ok(opBatch.savings.eip2612Count >= 2);

    // Explicit empty selection must return 0 legs (Clear button regression check)
    const emptyPlan = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scanId: scan.scanId,
        selectedAssetIds: [],
        solanaDestination: SAMPLE_SOLANA_WALLET,
      }),
    }).then((r) => r.json());
    assert.equal(emptyPlan.legs.length, 0);
    assert.equal(emptyPlan.totals.netSolanaUsdc, 0);

    // Invalid EVM address & malformed JSON must return 400 (not 500)
    const badScanAddr = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: '0xinvalid' }),
    });
    assert.equal(badScanAddr.status, 400);

    const badJson = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-json',
    });
    assert.equal(badJson.status, 400);

    // Oversized JSON body (>1 MiB) returns 413
    const hugeBody = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'a'.repeat(1_100_000) }),
    });
    assert.equal(hugeBody.status, 413);

    // HEAD / returns 200 with Cross-Origin-Opener-Policy for Coinbase Smart Wallet SDK
    const headRoot = await fetch(`${base}/`, { method: 'HEAD' });
    assert.equal(headRoot.status, 200);
    assert.equal(headRoot.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');

    // /api/config & /vendor/wallet-sdks.js
    const cfg = await fetch(`${base}/api/config`).then((r) => r.json());
    assert.equal(typeof cfg.coinbaseSmartWalletEnabled, 'boolean');
    assert.ok(['sim', 'alchemy', 'moralis', 'none'].includes(cfg.l2IndexerProvider));

    // /api/cctp/attestation validation (invalid hash -> 400)
    const badAtt = await fetch(`${base}/api/cctp/attestation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain: 'base', txHash: '0x123' }),
    });
    assert.equal(badAtt.status, 400);

    // SiphonRouter.sol security invariants
    assert.ok(contract.source.includes('library SafeERC20Lite'));
    assert.ok(contract.source.includes('exitStep.receiptToken.safeTransferFrom'));
    assert.ok(contract.source.includes('function acceptOwnership()'));
    assert.ok(contract.source.includes('forceApprove'));
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Aave v3 debt safety guard decodes getUserAccountData and blocks MAX withdraw when debt > 0', async () => {
  const word = (n: bigint) => n.toString(16).padStart(64, '0');
  // 5000 USD collateral (8 dec), 1200 USD debt (8 dec), HF = 1.45 (18 dec)
  const debtHex =
    '0x' +
    word(5000n * 10n ** 8n) +
    word(1200n * 10n ** 8n) +
    word(2000n * 10n ** 8n) +
    word(8250n) +
    word(8000n) +
    word(145n * 10n ** 16n);
  const decodedDebt = decodeAaveAccountData(debtHex);
  assert.equal(decodedDebt.checked, true);
  assert.equal(decodedDebt.hasActiveDebt, true);
  assert.equal(decodedDebt.totalDebtUsd, 1200);
  assert.equal(decodedDebt.healthFactor, 1.45);
  assert.equal(decodedDebt.safeForMaxWithdraw, false);

  // Zero-debt account is safe for MAX withdraw
  const zeroDebtHex =
    '0x' +
    word(5000n * 10n ** 8n) +
    word(0n) +
    word(4000n * 10n ** 8n) +
    word(8250n) +
    word(8000n) +
    word((1n << 256n) - 1n);
  const decodedSafe = decodeAaveAccountData(zeroDebtHex);
  assert.equal(decodedSafe.hasActiveDebt, false);
  assert.equal(decodedSafe.safeForMaxWithdraw, true);

  // prepareRealExecution MUST reject an Aave asset flagged with active debt
  const scan = await scanPresetWallet('veteran_defi');
  const aaveAsset = scan.assets.find((a) => a.protocol === 'Aave v3');
  assert.ok(aaveAsset);
  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: { ...aaveAsset, aaveDebtUsd: 1200, aaveHealthFactor: 1.45 },
        userAddress: scan.walletAddress,
        solanaDestination: SAMPLE_SOLANA_WALLET,
      }),
    /Aave v3 safety guard/
  );
});

test('Circle CCTP MessageSent log ABI extractor produces valid message bytes and keccak256 hash', () => {
  const payload = Buffer.from('siphon-cctp-domain5-test-message', 'utf8');
  const word = (n: number) => n.toString(16).padStart(64, '0');
  const paddedPayload = payload.toString('hex').padEnd(Math.ceil(payload.length / 32) * 64, '0');
  const encodedData = '0x' + word(0x20) + word(payload.length) + paddedPayload;

  const extracted = extractCctpMessageFromLogs([
    { topics: ['0x' + '00'.repeat(32)], data: '0x' },
    { topics: [CCTP_MESSAGE_SENT_TOPIC], data: encodedData },
  ]);
  assert.ok(extracted);
  assert.equal(extracted.messageBytesHex, '0x' + payload.toString('hex'));
  assert.match(extracted.messageHash, /^0x[0-9a-f]{64}$/);
});

test('Protocol fee (5-10%) clamps cleanly, reconciles plan, splits onchain transfers, and exposes SiphonFeeVault.sol', async () => {
  // Clamping: below 5% -> 500 bps, above 10% -> 1000 bps, default -> 700 bps (7%)
  assert.equal(resolveProtocolFeeBps(undefined), 700);
  assert.equal(resolveProtocolFeeBps(100), 500);
  assert.equal(resolveProtocolFeeBps(750), 750);
  assert.equal(resolveProtocolFeeBps(2500), 1000);

  const treasury = '0x1111111111111111111111111111111111111111';
  const cfg10 = getProtocolFeeConfig({ feeBps: 1000, feeRecipientEvm: treasury });
  assert.equal(cfg10.feeBps, 1000);
  assert.equal(cfg10.feePercent, 10);
  assert.equal(cfg10.feeRecipientEvm, treasury);
  assert.equal(cfg10.treasuryConfigured, true);

  // Plan uses requested 8% (800 bps) fee and reconciles net USDC cleanly
  const report = await scanPresetWallet('veteran_defi');
  const plan8 = buildMigrationPlan({
    scan: report,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    protocolFeeBps: 800,
    feeRecipientEvm: treasury,
  });
  assert.equal(plan8.protocolFeeBps, 800);
  assert.equal(plan8.protocolFeePercent, 8);
  assert.equal(plan8.feeRecipientEvm, treasury);
  assert.ok(plan8.totals.protocolFeeUsd > 100);
  assert.ok(
    Math.abs(plan8.totals.protocolFeeUsd - (plan8.totals.grossUsd * 800) / 10_000) < 5,
    `Expected ~8% fee on $${plan8.totals.grossUsd}, got $${plan8.totals.protocolFeeUsd}`
  );
  assert.ok(plan8.legs.every((l) => l.steps.some((s) => s.step.includes('Protocol Fee (8%)'))));

  // Direct Circle CCTP preparation with 10% fee splits exact 10% ERC-20 transfer to treasury + bridges 90%
  const opUsdc = report.assets.find((a) => a.chain === 'optimism' && a.symbol === 'USDC');
  assert.ok(opUsdc);
  const cctp10 = await prepareRealExecution({
    asset: opUsdc,
    userAddress: report.walletAddress,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    bridgePreference: 'cctp',
    protocolFeeBps: 1000,
    feeRecipientEvm: treasury,
  });
  assert.equal(cctp10.feeBreakdown?.collectionMethod, 'onchain_split');
  assert.equal(cctp10.feeBreakdown?.feeBps, 1000);
  const feeTx = cctp10.transactions.find((t) => t.stepId === 'protocol_fee_transfer');
  assert.ok(feeTx, 'Expected onchain protocol_fee_transfer tx');
  assert.ok(feeTx.data.startsWith('0xa9059cbb'));
  assert.ok(feeTx.data.toLowerCase().includes(treasury.slice(2).toLowerCase()));

  // Atomic EIP-5792 DeFi USDC withdraw + 7% protocol fee + CCTP batch on Polygon
  const polyAssets = report.assets.filter((a) => a.chain === 'polygon');
  const polyBatch = await prepareChainBatchExecution({
    chain: 'polygon',
    assets: polyAssets,
    userAddress: report.walletAddress,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    bridgePreference: 'cctp',
    bundleDefiCctp: true,
    protocolFeeBps: 700,
    feeRecipientEvm: treasury,
  });
  assert.equal(polyBatch.feeBreakdown.feeBps, 700);
  assert.equal(polyBatch.feeBreakdown.collectionMethod, 'onchain_split');
  assert.ok(polyBatch.calls.some((c) => c.stepId === 'protocol_fee_transfer_after_defi'));
  assert.equal(polyBatch.calls.length, 4); // Aave withdraw + 7% fee transfer + approve + CCTP burn

  // HTTP /api/contract serves both SiphonRouter.sol (500-1000 bps) & SiphonFeeVault.sol
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  try {
    const c = await fetch(`http://127.0.0.1:${addr.port}/api/contract`).then((r) => r.json());
    assert.ok(c.source.includes('MIN_FEE_BPS = 500'));
    assert.ok(c.source.includes('MAX_FEE_BPS = 1000'));
    assert.ok(c.source.includes('permitWitnessTransferFrom'));
    assert.ok(c.feeVaultSource.includes('contract SiphonFeeVault'));
    assert.ok(c.delegateSource.includes('contract SiphonSweepDelegate'));
    assert.ok(c.delegateSource.includes('struct ApprovalRevoke'));
    assert.equal(c.contracts.length, 3);

    // Witness-bound Gasless 1-Signature Permit2 / EIP-7702 intent preparation & signature verification
    const opAssets = report.assets.filter((a) => a.chain === 'optimism');
    const intent = await fetch(`http://127.0.0.1:${addr.port}/api/relayer/prepare-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'optimism',
        assets: opAssets,
        userAddress: report.walletAddress,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        protocolFeeBps: 700,
        feeRecipientEvm: treasury,
      }),
    }).then((r) => r.json());
    assert.equal(intent.userGasCostUsd, 0);
    assert.equal(intent.mode, 'permit2_batch');
    assert.equal(intent.typedData.primaryType, 'PermitBatchWitnessTransferFrom');
    assert.ok(intent.typedData.message.witness.solanaRecipient.startsWith('0x'));
    assert.equal(intent.typedData.message.witness.feeBps, 700);
    assert.match(intent.intentDigestSha256, /^0x[0-9a-f]{64}$/);

    const sigReceipt = await fetch(`http://127.0.0.1:${addr.port}/api/relayer/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intentId: intent.intentId,
        chain: 'optimism',
        userAddress: report.walletAddress,
        signature: '0x' + 'ab'.repeat(65),
        deadline: intent.deadline,
      }),
    }).then((r) => r.json());
    assert.equal(sigReceipt.accepted, true);
    assert.equal(sigReceipt.signatureValid, true);

    // Real-time Pre-Sign Simulation Proof (POST /api/tx/simulate-proof)
    const simProofRes = await fetch(`http://127.0.0.1:${addr.port}/api/tx/simulate-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'optimism',
        assets: [opUsdc],
        userAddress: report.walletAddress,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        bridgePreference: 'cctp',
        protocolFeeBps: 700,
        feeRecipientEvm: treasury,
      }),
    }).then((r) => r.json());
    assert.equal(simProofRes.proof.mintRecipientVerified, true);
    assert.match(simProofRes.proof.proofDigestSha256, /^0x[0-9a-f]{64}$/);
    assert.equal(simProofRes.proof.protocolFee.feeBps, 700);
    assert.ok(simProofRes.proof.checks.length >= 2);

    // Background job lifecycle: POST /api/jobs -> POST /api/jobs/:id/leg -> GET /api/jobs
    const job = await fetch(`http://127.0.0.1:${addr.port}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceWallet: report.walletAddress,
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
        bridgePreference: 'auto',
        protocolFeeBps: 700,
        feeRecipientEvm: treasury,
        legs: [{ chain: 'base', assetCount: 4, estimatedNetUsd: 1200, estimatedFeeUsd: 90 }],
      }),
    }).then((r) => r.json());
    assert.ok(job.jobId.startsWith('job_'));
    assert.equal(job.status, 'active');

    const updated = await fetch(`http://127.0.0.1:${addr.port}/api/jobs/${job.jobId}/leg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'base',
        status: 'landed',
        statusText: 'Landed on Solana',
        evmTxHash: '0x' + 'a'.repeat(64),
      }),
    }).then((r) => r.json());
    assert.equal(updated.status, 'completed');
    assert.equal(updated.settledNetUsd, 1200);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Multi-chain expansion: 14 EVMs + 7 families registry + auto address detection', () => {
  assert.equal(CHAIN_LIST.length, 14);
  for (const id of ['bnb', 'sonic', 'unichain', 'linea', 'scroll', 'mantle', 'blast', 'worldchain'] as const) {
    assert.ok(EVM_CHAINS[id], `Missing extended EVM chain ${id}`);
    assert.ok(EVM_CHAINS[id].rpcUrls.length >= 2);
    assert.match(EVM_CHAINS[id].usdcAddress, /^0x[0-9a-fA-F]{40}$/);
  }
  assert.equal(EVM_CHAINS.unichain.cctpDomain, 10);
  assert.equal(EVM_CHAINS.linea.cctpDomain, 11);
  assert.equal(EVM_CHAINS.sonic.cctpDomain, 13);
  assert.equal(EVM_CHAINS.worldchain.cctpDomain, 14);
  assert.equal(EVM_CHAINS.bnb.cctpDomain, null);

  const metas = listAllFamilyMetas();
  assert.equal(metas.length, 7);
  assert.equal(
    metas.reduce((s, m) => s + m.chains.length, 0),
    25 // 14 EVMs + 6 Cosmos + Sui + Aptos + TON + Tron + Bitcoin
  );

  // Address auto-detection across all 7 families
  assert.equal(detectAddressFamily('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'), 'evm');
  assert.equal(detectAddressFamily('vitalik.eth'), 'evm');
  assert.equal(detectAddressFamily('cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh'), 'cosmos');
  assert.equal(detectAddressFamily('osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh'), 'cosmos');
  assert.equal(detectAddressFamily('noble1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh'), 'cosmos');
  assert.equal(detectAddressFamily('celestia1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh'), 'cosmos');
  assert.equal(detectAddressFamily('inj1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh'), 'cosmos');
  assert.equal(detectAddressFamily('neutron1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh'), 'cosmos');
  assert.equal(
    detectAddressFamily('0x0000000000000000000000000000000000000000000000000000000000000006'),
    'sui'
  );
  assert.equal(
    detectAddressFamily('0x0000000000000000000000000000000000000000000000000000000000000001', 'aptos'),
    'aptos'
  );
  assert.equal(detectAddressFamily('EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2'), 'ton');
  assert.equal(detectAddressFamily('TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL'), 'tron');
  assert.equal(
    detectAddressFamily('bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97'),
    'btc'
  );
  assert.equal(detectAddressFamily('not-a-wallet-at-all'), null);
});

test('Wave 1-3 adapters build 1-sig gasless intents, pre-sign proofs, and Bitcoin UTXO dust skipping', async () => {
  const mkAsset = (overrides: Partial<ScannedAsset>): ScannedAsset => ({
    id: 'test:asset',
    chain: 'cosmoshub',
    chainName: 'Cosmos Hub',
    address: 'uatom',
    symbol: 'ATOM',
    name: 'Cosmos ATOM',
    decimals: 6,
    kind: 'native',
    rawBalance: '50000000',
    uiBalance: 50,
    priceUsd: 5,
    grossUsd: 250,
    liquidityUsd: 10_000_000,
    estimatedGasUsd: 0.04,
    batchedGasUsd: 0.02,
    estimatedSlippageUsd: 0.5,
    netUsdcSingle: 249.46,
    netUsdcBatched: 249.48,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Test',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  });

  // 1. Cosmos / IBC: 1-sig atomic multi-msg TxBody with x/feegrant + Noble CCTP Domain 4 -> 5
  const cosmosIntent = await cosmosAdapter.buildGaslessIntent({
    chain: 'cosmoshub',
    assets: [
      mkAsset({ id: 'cosmoshub:uatom:bank' }),
      mkAsset({
        id: 'cosmoshub:uatom:rewards',
        address: 'rewards:uatom',
        kind: 'defi_position',
        action: 'WITHDRAW_AND_BRIDGE',
        grossUsd: 25,
      }),
      mkAsset({
        id: 'cosmoshub:uatom:staked',
        address: 'staking:uatom',
        kind: 'defi_position',
        action: 'WITHDRAW_AND_BRIDGE',
        stakedExitMode: 'instant_liquid_stake',
        grossUsd: 500,
      }),
    ],
    userAddress: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
    solanaDestination: SAMPLE_SOLANA_WALLET,
    protocolFeeBps: 700,
  });
  assert.equal(cosmosIntent.family, 'cosmos');
  assert.equal(cosmosIntent.userGasCostUsd, 0);
  assert.ok(cosmosIntent.gasSponsorshipMechanism.includes('x/feegrant'));
  assert.match(cosmosIntent.intentDigestSha256, /^0x[0-9a-f]{64}$/);
  const cosmosMsgs = (cosmosIntent.signPayload.txBody as { messages: Array<{ typeUrl: string }> }).messages;
  assert.ok(cosmosMsgs.some((m) => m.typeUrl.includes('MsgWithdrawDelegatorReward')));
  assert.ok(cosmosMsgs.some((m) => m.typeUrl.includes('MsgTokenizeShares')));
  assert.ok(cosmosMsgs.some((m) => m.typeUrl.includes('MsgTransfer')));
  assert.ok(cosmosMsgs.some((m) => m.typeUrl.includes('MsgSend')));
  assert.ok(cosmosMsgs.some((m) => m.typeUrl.includes('MsgDepositForBurn')));

  // 2. Sui: 1-sig Sponsored PTB (gasData.owner = Siphon Relayer) + Circle CCTP Domain 8 -> 5
  const suiIntent = await suiAdapter.buildGaslessIntent({
    chain: 'sui',
    assets: [mkAsset({ chain: 'sui', chainName: 'Sui', symbol: 'SUI', address: '0x2::sui::SUI' })],
    userAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
    solanaDestination: SAMPLE_SOLANA_WALLET,
    protocolFeeBps: 700,
  });
  assert.equal(suiIntent.family, 'sui');
  assert.equal(suiIntent.userGasCostUsd, 0);
  assert.equal((suiIntent.signPayload.gasData as { sponsored: boolean }).sponsored, true);

  // 3. Aptos: 1-sig Move FeePayerRawTransaction
  const aptosIntent = await aptosAdapter.buildGaslessIntent({
    chain: 'aptos',
    assets: [mkAsset({ chain: 'aptos', chainName: 'Aptos', symbol: 'APT', address: '0x1::aptos_coin::AptosCoin' })],
    userAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  assert.equal(aptosIntent.family, 'aptos');
  assert.equal(aptosIntent.signPayload.transactionType, 'FeePayerRawTransaction');
  assert.equal(aptosIntent.userGasCostUsd, 0);

  // 4. TON: Wallet W5 Gasless batch (up to 255 msgs)
  const tonIntent = await tonAdapter.buildGaslessIntent({
    chain: 'ton',
    assets: [mkAsset({ chain: 'ton', chainName: 'TON', symbol: 'USDT', address: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' })],
    userAddress: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2',
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  assert.equal(tonIntent.family, 'ton');
  assert.equal(tonIntent.signPayload.walletVersion, 'wallet_v5r1_gasless');
  assert.equal(tonIntent.signPayload.maxBatchMessages, 255);

  // 5. Tron: TIP-712 + DelegateResourceContract Energy Delegation ($0 TRX)
  const tronIntent = await tronAdapter.buildGaslessIntent({
    chain: 'tron',
    assets: [mkAsset({ chain: 'tron', chainName: 'Tron', symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' })],
    userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  assert.equal(tronIntent.family, 'tron');
  assert.equal(
    (tronIntent.signPayload.relayerPreStep as { contractType: string }).contractType,
    'DelegateResourceContract'
  );
  assert.equal(tronIntent.userGasCostUsd, 0);

  // 6. Bitcoin: UTXO dust classification + single PSBT with Chainflip/THORChain OP_RETURN memo
  const utxoClassified = classifyBtcUtxos({
    address: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97',
    satPerVbyte: 20,
    btcPriceUsd: 86_000,
    utxos: [
      { txid: 'a'.repeat(64), vout: 0, value: 1200 }, // sub-fee dust (68*20 + 546 = 1906 sats)
      { txid: 'b'.repeat(64), vout: 1, value: 500_000 }, // spendable 0.005 BTC
    ],
  });
  assert.equal(utxoClassified.dust.length, 1);
  assert.equal(utxoClassified.spendable.length, 1);

  const btcIntent = await btcAdapter.buildGaslessIntent({
    chain: 'btc',
    assets: [
      mkAsset({
        chain: 'btc',
        chainName: 'Bitcoin',
        symbol: 'BTC',
        address: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97',
        rawBalance: '500000',
        uiBalance: 0.005,
        grossUsd: 430,
      }),
      mkAsset({
        id: 'btc:dust_utxos',
        chain: 'btc',
        chainName: 'Bitcoin',
        symbol: 'BTC Dust',
        rawBalance: '1200',
        uiBalance: 0.000012,
        grossUsd: 1.03,
        action: 'SKIP_GAS_NEGATIVE',
        selectedByDefault: false,
      }),
    ],
    userAddress: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97',
    solanaDestination: SAMPLE_SOLANA_WALLET,
    protocolFeeBps: 750,
  });
  assert.equal(btcIntent.family, 'btc');
  assert.equal(btcIntent.coveredAssets.length, 1); // dust excluded!
  const outputs = btcIntent.signPayload.outputs as Array<{ type: string; memo?: string }>;
  const memoOut = outputs.find((o) => o.type === 'op_return_memo');
  assert.ok(memoOut?.memo?.includes(SAMPLE_SOLANA_WALLET));
  assert.ok(memoOut?.memo?.includes(':siphon:750'));

  // HTTP /api/families & non-EVM /api/relayer/prepare-intent + /api/tx/simulate-proof
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    const fams = await fetch(`${base}/api/families`).then((r) => r.json());
    assert.equal(fams.totalFamilies, 7);
    assert.equal(fams.totalChains, 25);

    const httpBtcProof = await fetch(`${base}/api/tx/simulate-proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'btc',
        assets: [
          mkAsset({
            chain: 'btc',
            chainName: 'Bitcoin',
            symbol: 'BTC',
            rawBalance: '500000',
            uiBalance: 0.005,
            grossUsd: 430,
          }),
        ],
        userAddress: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97',
        solanaDestination: SAMPLE_SOLANA_WALLET,
        protocolFeeBps: 700,
      }),
    }).then((r) => r.json());
    assert.equal(httpBtcProof.proof.family, 'btc');
    assert.equal(httpBtcProof.proof.mintRecipientVerified, true);
    assert.match(httpBtcProof.proof.proofDigestSha256, /^0x[0-9a-f]{64}$/);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Two-Level Signed Negative-ROI Engine & Relayer Break-Even math prunes negative dust cleanly', async () => {
  const mk = (overrides: Partial<ScannedAsset>): ScannedAsset => ({
    id: 'eth:tok',
    chain: 'ethereum',
    chainName: 'Ethereum',
    address: '0x0000000000000000000000000000000000000001',
    symbol: 'TOK',
    name: 'Token',
    decimals: 18,
    kind: 'erc20',
    rawBalance: '1000',
    uiBalance: 1,
    priceUsd: 1,
    grossUsd: 1,
    liquidityUsd: 100_000,
    estimatedGasUsd: 4.5,
    batchedGasUsd: 1.5,
    estimatedSlippageUsd: 0.05,
    netUsdcSingle: 0,
    netUsdcBatched: 0,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Test',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  });

  // Level 1: signed negative solo AND batched -> pruned
  const badDust = mk({ id: 'eth:dust', symbol: 'DUST', grossUsd: 0.8, estimatedGasUsd: 4.0, batchedGasUsd: 1.5 });
  const badEval = evaluateAssetRoi(badDust, { protocolFeeBps: 700 });
  assert.equal(badEval.verdict, 'negative_roi_skip');
  assert.ok(badEval.signedSoloNetUsd < 0, 'Must preserve signed negative solo net USD');
  assert.ok(badEval.signedBatchedNetUsd < 0, 'Must preserve signed negative batched net USD');
  assert.equal(badEval.shouldIncludeByDefault, false);

  // Level 1: negative solo, positive batched -> profitable_batched_only
  const marginal = mk({ id: 'eth:marg', symbol: 'MARG', grossUsd: 3.0, estimatedGasUsd: 4.0, batchedGasUsd: 1.2 });
  const margEval = evaluateAssetRoi(marginal, { protocolFeeBps: 700 });
  assert.equal(margEval.verdict, 'profitable_batched_only');
  assert.ok(margEval.signedSoloNetUsd < 0);
  assert.ok(margEval.signedBatchedNetUsd > 0);

  // Relayer break-even math: at 7% fee (700 bps), $0.70 gas + $0.02 overhead = $0.72 -> break-even = $10.29 gross
  const beLow = computeRelayerBreakEven({ sponsoredGasUsd: 0.7, protocolFeeBps: 700, grossUsd: 5.0 });
  assert.equal(beLow.isRelayerProfitable, false);
  assert.ok(beLow.relayerNetMarginUsd < 0);
  assert.ok(beLow.breakEvenGrossUsd > 10 && beLow.breakEvenGrossUsd < 10.5);
  assert.ok(beLow.shortfallToBreakEvenUsd > 5);

  const beHigh = computeRelayerBreakEven({ sponsoredGasUsd: 0.7, protocolFeeBps: 700, grossUsd: 100.0 });
  assert.equal(beHigh.isRelayerProfitable, true);
  assert.ok(beHigh.relayerNetMarginUsd > 6);
  assert.equal(beHigh.shortfallToBreakEvenUsd, 0);

  // Level 2: pruning prevents bad dust from dragging down a profitable Ethereum bundle
  const whale = mk({ id: 'eth:usdc', symbol: 'USDC', grossUsd: 200, estimatedGasUsd: 3.0, batchedGasUsd: 1.2, estimatedSlippageUsd: 0 });
  const buckets = pruneNegativeRoiAssets([whale, marginal, badDust], { protocolFeeBps: 700 });
  assert.equal(buckets.kept.length, 2);
  assert.equal(buckets.prunedNegativeRoi.length, 1);

  const chainRoi = evaluateChainBatchRoi({
    chain: 'ethereum',
    assets: [whale, marginal, badDust],
    protocolFeeBps: 700,
    gasSponsored: true,
  });
  assert.equal(chainRoi.prunedNegativeRoiCount, 1);
  assert.ok(chainRoi.negativeBleedPreventedUsd > 0);
  assert.equal(chainRoi.recommendedExecution, 'sponsored_gasless');
  assert.equal(chainRoi.relayerBreakEven.isRelayerProfitable, true);

  // Portfolio rollup on preset wallet
  const report = await scanPresetWallet('veteran_defi');
  const portfolioRoi = evaluatePortfolioRoi(report, { protocolFeeBps: 700 });
  assert.equal(portfolioRoi.overallRelayerProfitable, true);
  assert.ok(portfolioRoi.totalRelayerNetMarginUsd > 0);
});
