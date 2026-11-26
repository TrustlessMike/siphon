import assert from 'node:assert/strict';
import test from 'node:test';
import { aptosAdapter } from '../src/adapters/aptos.js';
import { btcAdapter, classifyBtcUtxos, estimateInputVbytes } from '../src/adapters/btc.js';
import { cosmosAdapter } from '../src/adapters/cosmos.js';
import { suiAdapter } from '../src/adapters/sui.js';
import { tonAdapter } from '../src/adapters/ton.js';
import { tronAdapter } from '../src/adapters/tron.js';
import { solanaAddressToBytes32, solanaOwnerToUsdcAtaBytes32 } from '../src/bridge/cctp.js';
import {
  convertBech32Prefix,
  decodeBech32,
  encodeBech32,
  normalizeMoveCoinType,
} from '../src/execution/non-evm-converter.js';
import type { ScannedAsset } from '../src/scanner/types.js';
import { createSiphonServer } from '../src/server/app.js';

const SAMPLE_SOLANA_WALLET = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

function mkAsset(overrides: Partial<ScannedAsset>): ScannedAsset {
  return {
    id: 'test:asset',
    family: 'cosmos',
    chain: 'cosmoshub',
    chainName: 'Cosmos Hub',
    address: 'uatom',
    symbol: 'ATOM',
    name: 'Cosmos ATOM',
    decimals: 6,
    kind: 'native',
    rawBalance: '10000000',
    uiBalance: 10,
    priceUsd: 5,
    grossUsd: 50,
    liquidityUsd: 10_000_000,
    estimatedGasUsd: 0.04,
    batchedGasUsd: 0.02,
    estimatedSlippageUsd: 0.2,
    netUsdcSingle: 49.76,
    netUsdcBatched: 49.78,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Test',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

test('Bech32/Bech32m codec validates checksums, derives coinType-118 sibling HRPs, and normalizes Move coin types', () => {
  const cosmosAddr = 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh';
  const decoded = decodeBech32(cosmosAddr);
  assert.ok(decoded);
  assert.equal(decoded.hrp, 'cosmos');
  assert.equal(encodeBech32(decoded.hrp, decoded.words, decoded.encoding), cosmosAddr);

  const osmoDerived = convertBech32Prefix(cosmosAddr, 'osmo');
  assert.ok(osmoDerived && osmoDerived.startsWith('osmo1'));
  assert.ok(decodeBech32(osmoDerived), 'Derived osmo1 address must have valid Bech32 checksum');
  assert.notEqual(
    osmoDerived,
    'osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
    'Checksum must be recomputed, not naively prefix-swapped'
  );

  // Corrupted checksum & mixed case rejected
  assert.equal(decodeBech32('cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0ea'), null);
  assert.equal(decodeBech32('Cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh'), null);

  // Move coin type normalization (Sui GraphQL 64-hex -> canonical short 0x2)
  assert.equal(
    normalizeMoveCoinType('0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'),
    '0x2::sui::SUI'
  );
  assert.equal(
    normalizeMoveCoinType('0xDBA34672E30CB065B1F93E3AB55318768FD6FEF66C15942C9F7CB846E2F900E7::usdc::USDC'),
    '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
  );
});

test('Non-EVM CCTP adapters (Cosmos, Sui, Aptos) target canonical Solana USDC ATA PDA, never raw owner pubkey', async () => {
  const expectedAta = solanaOwnerToUsdcAtaBytes32(SAMPLE_SOLANA_WALLET);
  const rawOwner = solanaAddressToBytes32(SAMPLE_SOLANA_WALLET);
  assert.notEqual(expectedAta, rawOwner);

  const [cosmosIntent, suiIntent, aptosIntent] = await Promise.all([
    cosmosAdapter.buildGaslessIntent({
      chain: 'noble',
      assets: [mkAsset({ chain: 'noble', chainName: 'Noble', address: 'uusdc', symbol: 'USDC', rawBalance: '50000000', uiBalance: 50, priceUsd: 1, grossUsd: 50, action: 'BRIDGE_DIRECT_USDC' })],
      userAddress: 'noble1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
      solanaDestination: SAMPLE_SOLANA_WALLET,
    }),
    suiAdapter.buildGaslessIntent({
      chain: 'sui',
      assets: [mkAsset({ family: 'sui', chain: 'sui', chainName: 'Sui', address: '0x2::sui::SUI', symbol: 'SUI', grossUsd: 80 })],
      userAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
      solanaDestination: SAMPLE_SOLANA_WALLET,
    }),
    aptosAdapter.buildGaslessIntent({
      chain: 'aptos',
      assets: [mkAsset({ family: 'aptos', chain: 'aptos', chainName: 'Aptos', address: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b', symbol: 'USDC', grossUsd: 80, action: 'BRIDGE_DIRECT_USDC' })],
      userAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
      solanaDestination: SAMPLE_SOLANA_WALLET,
    }),
  ]);

  assert.equal(cosmosIntent.solanaMintRecipientBytes32, expectedAta);
  assert.equal(suiIntent.solanaMintRecipientBytes32, expectedAta);
  assert.equal(aptosIntent.solanaMintRecipientBytes32, expectedAta);
});

test('Bitcoin Ordinals/Runes guard, P2WSH vBytes, TON address validation, and Tron dual-resource delegation', async () => {
  // P2WPKH (42-char) = 68 vB vs P2WSH (62-char) = 105 vB vs Taproot = 58 vB
  assert.equal(estimateInputVbytes('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), 68);
  assert.equal(estimateInputVbytes('bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97'), 105);
  assert.equal(estimateInputVbytes('bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr'), 58);

  // Taproot address protects <= 10,000 sat postage UTXOs (Ordinals/Runes) & excludes unconfirmed UTXOs
  const taprootClassified = classifyBtcUtxos({
    address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
    satPerVbyte: 5,
    btcPriceUsd: 86_000,
    utxos: [
      { txid: '1'.repeat(64), vout: 0, value: 1_000, status: { confirmed: true } }, // Ordinals postage
      { txid: '2'.repeat(64), vout: 0, value: 50_000, status: { confirmed: false } }, // unconfirmed
      { txid: '3'.repeat(64), vout: 1, value: 250_000, status: { confirmed: true } }, // confirmed spendable
    ],
  });
  assert.equal(taprootClassified.protectedUtxos.length, 1);
  assert.equal(taprootClassified.unconfirmed.length, 1);
  assert.equal(taprootClassified.spendable.length, 1);
  assert.equal(taprootClassified.spendableSats, 250_000);

  // Multi-UTXO fee scaling in buildGaslessIntent (no N× undercount!)
  const btcMultiIntent = await btcAdapter.buildGaslessIntent({
    chain: 'btc',
    assets: [
      mkAsset({
        family: 'btc',
        chain: 'btc',
        chainName: 'Bitcoin',
        symbol: 'BTC',
        address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        rawBalance: '5000000',
        uiBalance: 0.05,
        grossUsd: 4300,
        defiPositionType: 'utxos:10',
      }),
    ],
    userAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  assert.equal(btcMultiIntent.signPayload.inputUtxoCount, 10);
  assert.equal(btcMultiIntent.signPayload.estimatedVbytes, 135 + 10 * 68);

  // TON address validation accepts mainnet -1: masterchain and rejects -0: / testnet kQ
  assert.equal(tonAdapter.matchesAddress(`-1:${'a'.repeat(64)}`), true);
  assert.equal(tonAdapter.matchesAddress(`0:${'b'.repeat(64)}`), true);
  assert.equal(tonAdapter.matchesAddress(`-0:${'a'.repeat(64)}`), false);
  assert.equal(tonAdapter.matchesAddress('kQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2'), false);

  // Tron gasless intent includes BOTH ENERGY and BANDWIDTH delegation
  const tronIntent = await tronAdapter.buildGaslessIntent({
    chain: 'tron',
    assets: [mkAsset({ family: 'tron', chain: 'tron', chainName: 'Tron', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', grossUsd: 100 })],
    userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  const preStep = tronIntent.signPayload.relayerPreStep as { resources: string[]; bandwidthAmount: number };
  assert.deepEqual(preStep.resources, ['ENERGY', 'BANDWIDTH']);
  assert.ok(preStep.bandwidthAmount >= 500);
});

test('Unified POST /api/tx/prepare-chain-batch executes real non-EVM direct conversion routing across all 6 families', async () => {
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Bitcoin -> Live Relay BIP-174 PSBT
    const btcBatch = await fetch(`${base}/api/tx/prepare-chain-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'btc',
        assets: [
          mkAsset({
            family: 'btc',
            chain: 'btc',
            chainName: 'Bitcoin',
            address: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97',
            symbol: 'BTC',
            decimals: 8,
            rawBalance: '1000000',
            uiBalance: 0.01,
            priceUsd: 60000,
            grossUsd: 600,
          }),
        ],
        userAddress: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97',
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
      }),
    }).then((r) => r.json());
    assert.equal(btcBatch.family, 'btc');
    assert.equal(btcBatch.executionKind, 'btc_psbt');
    assert.ok(Array.isArray(btcBatch.calls) && btcBatch.calls.length >= 1);
    assert.equal(btcBatch.liveExecutable, true);
    assert.ok(String(btcBatch.calls[0].nativePayload.psbtHex || '').startsWith('70736274ff'));

    // 2. Tron -> Live Relay TVM TriggerSmartContract steps
    const tronBatch = await fetch(`${base}/api/tx/prepare-chain-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'tron',
        assets: [
          mkAsset({
            family: 'tron',
            chain: 'tron',
            chainName: 'Tron',
            address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
            symbol: 'USDT',
            decimals: 6,
            rawBalance: '50000000',
            uiBalance: 50,
            priceUsd: 1,
            grossUsd: 50,
            action: 'BRIDGE_DIRECT_USDC',
          }),
        ],
        userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
      }),
    }).then((r) => r.json());
    assert.equal(tronBatch.family, 'tron');
    assert.equal(tronBatch.executionKind, 'tron_tvm_tx');
    assert.ok(tronBatch.calls.length >= 1);
    assert.equal(tronBatch.liveExecutable, true);

    // 3. TON -> Live Relay TonConnect 2 structured messages
    const tonBatch = await fetch(`${base}/api/tx/prepare-chain-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'ton',
        assets: [
          mkAsset({
            family: 'ton',
            chain: 'ton',
            chainName: 'TON',
            address: 'native',
            symbol: 'TON',
            decimals: 9,
            rawBalance: '5000000000',
            uiBalance: 5,
            priceUsd: 0.95,
            grossUsd: 4.75,
          }),
        ],
        userAddress: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2',
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
      }),
    }).then((r) => r.json());
    assert.equal(tonBatch.family, 'ton');
    assert.equal(tonBatch.executionKind, 'ton_tonconnect_batch');
    assert.ok(tonBatch.calls.length >= 1);
    assert.equal(tonBatch.liveExecutable, true);
    assert.ok(Array.isArray(tonBatch.calls[0].nativePayload.messages));

    // 4. Cosmos -> Live Skip Go route + executable cosmosTx msgs
    const cosmosBatch = await fetch(`${base}/api/tx/prepare-chain-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'cosmoshub',
        assets: [
          mkAsset({
            family: 'cosmos',
            chain: 'cosmoshub',
            chainName: 'Cosmos Hub',
            address: 'uatom',
            symbol: 'ATOM',
            decimals: 6,
            rawBalance: '10000000',
            uiBalance: 10,
            priceUsd: 1.5,
            grossUsd: 15,
          }),
        ],
        userAddress: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
      }),
    }).then((r) => r.json());
    assert.equal(cosmosBatch.family, 'cosmos');
    assert.equal(cosmosBatch.executionKind, 'cosmos_skip_tx');
    if (cosmosBatch.calls.length >= 1) {
      assert.equal(cosmosBatch.liveExecutable, true);
      assert.ok(cosmosBatch.calls[0].nativePayload.cosmosTx.msgs.length >= 1);
    } else {
      // Transient Skip Go API rate-limit/timeout on shared CI runners must fail closed with clear skippedAssets diagnostics
      assert.equal(cosmosBatch.liveExecutable, false);
      assert.ok(
        Array.isArray(cosmosBatch.skippedAssets) && cosmosBatch.skippedAssets.length >= 1,
        'When Skip Go is transiently unavailable, Cosmos batch must fail closed with skippedAssets reason'
      );
    }

    // 5. Aptos -> Real Move entry_function_payload Circle CCTP Domain 9 targeting Solana USDC ATA PDA
    const aptosBatch = await fetch(`${base}/api/tx/prepare-chain-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'aptos',
        assets: [
          mkAsset({
            family: 'aptos',
            chain: 'aptos',
            chainName: 'Aptos',
            address: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
            symbol: 'USDC',
            decimals: 6,
            rawBalance: '25000000',
            uiBalance: 25,
            priceUsd: 1,
            grossUsd: 25,
            action: 'BRIDGE_DIRECT_USDC',
          }),
        ],
        userAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
        solanaDestination: SAMPLE_SOLANA_WALLET,
        outputAsset: 'USDC',
      }),
    }).then((r) => r.json());
    assert.equal(aptosBatch.family, 'aptos');
    assert.equal(aptosBatch.executionKind, 'aptos_entry_fn');
    assert.equal(aptosBatch.liveExecutable, true);
    assert.equal(aptosBatch.solanaUsdcAtaBytes32, solanaOwnerToUsdcAtaBytes32(SAMPLE_SOLANA_WALLET));
    assert.ok(String(aptosBatch.calls[0].nativePayload.function).includes('deposit_for_burn'));

    // 6. Sui -> Live GraphQL scan (no longer dead!) + direct batch route
    const suiScan = await suiAdapter.scanWallet(
      '0x0000000000000000000000000000000000000000000000000000000000000006'
    );
    assert.equal(suiScan.chains[0].rpcStatus, 'live');
    assert.ok(suiScan.chains[0].blockNumber > 0, 'Sui GraphQL must return a live checkpoint > 0');

    const suiBatch = await fetch(`${base}/api/tx/prepare-chain-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'sui',
        assets: [
          mkAsset({
            family: 'sui',
            chain: 'sui',
            chainName: 'Sui',
            address: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
            symbol: 'USDC',
            decimals: 6,
            rawBalance: '30000000',
            uiBalance: 30,
            priceUsd: 1,
            grossUsd: 30,
            action: 'BRIDGE_DIRECT_USDC',
          }),
        ],
        userAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
        solanaDestination: SAMPLE_SOLANA_WALLET,
        bridgePreference: 'cctp',
        outputAsset: 'USDC',
      }),
    }).then((r) => r.json());
    assert.equal(suiBatch.family, 'sui');
    assert.equal(suiBatch.executionKind, 'sui_ptb');
    assert.equal(suiBatch.solanaUsdcAtaBytes32, solanaOwnerToUsdcAtaBytes32(SAMPLE_SOLANA_WALLET));
    assert.ok(suiBatch.calls.length >= 1);

    // 7. Non-EVM break-even guard rejects $0.01 dust on /api/relayer/prepare-intent (HTTP 400)
    const dustIntentRes = await fetch(`${base}/api/relayer/prepare-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'tron',
        assets: [
          mkAsset({
            family: 'tron',
            chain: 'tron',
            chainName: 'Tron',
            address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
            symbol: 'USDT',
            rawBalance: '10000',
            uiBalance: 0.01,
            priceUsd: 1,
            grossUsd: 0.01,
          }),
        ],
        userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
        solanaDestination: SAMPLE_SOLANA_WALLET,
      }),
    });
    assert.equal(dustIntentRes.status, 400);

    // 8. Non-EVM /api/tx/status succeeds cleanly (Relay status check)
    const statusRes = await fetch(`${base}/api/tx/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'btc',
        provider: 'relay',
        requestId: btcBatch.bridgeTrackers[0]?.requestId,
      }),
    });
    assert.equal(statusRes.status, 200);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
