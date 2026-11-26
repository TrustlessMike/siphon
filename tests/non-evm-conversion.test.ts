import assert from 'node:assert/strict';
import test from 'node:test';
import { aptosAdapter, prepareAptosDirectBatch } from '../src/adapters/aptos.js';
import {
  btcAdapter,
  buildBtcInputsToSign,
  classifyBtcUtxos,
  estimateInputVbytes,
  parsePsbtInputCount,
  prepareBtcDirectBatch,
} from '../src/adapters/btc.js';
import {
  buildNobleCctpBurnMsg,
  cosmosAdapter,
  extractCosmosAccountNumbers,
  prepareCosmosDirectBatch,
} from '../src/adapters/cosmos.js';
import { prepareSuiDirectBatch, suiAdapter } from '../src/adapters/sui.js';
import { tonAdapter } from '../src/adapters/ton.js';
import { tronAdapter } from '../src/adapters/tron.js';
import { solanaAddressToBytes32, solanaOwnerToUsdcAtaBytes32 } from '../src/bridge/cctp.js';
import {
  convertBech32Prefix,
  decodeBech32,
  encodeBech32,
  normalizeMoveCoinType,
  quotePanoraAptosSwap,
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

// =========================================================================
// WAVE 7A: COSMOS ACCOUNT UNWRAPPING + NOBLE CCTP VS SKIP GO AUCTION
// =========================================================================

test('Cosmos: unwraps BaseAccount, Injective EthAccount, and ContinuousVestingAccount cleanly', () => {
  assert.deepEqual(
    extractCosmosAccountNumbers({
      account: {
        '@type': '/cosmos.auth.v1beta1.BaseAccount',
        account_number: '142857',
        sequence: '19',
      },
    }),
    {
      accountNumber: '142857',
      sequence: '19',
      accountType: '/cosmos.auth.v1beta1.BaseAccount',
    }
  );

  assert.deepEqual(
    extractCosmosAccountNumbers({
      account: {
        '@type': '/injective.types.v1beta1.EthAccount',
        base_account: {
          account_number: '99812',
          sequence: '7',
        },
      },
    }),
    {
      accountNumber: '99812',
      sequence: '7',
      accountType: '/injective.types.v1beta1.EthAccount',
    }
  );

  assert.deepEqual(
    extractCosmosAccountNumbers({
      account: {
        '@type': '/cosmos.vesting.v1beta1.ContinuousVestingAccount',
        base_vesting_account: {
          base_account: {
            account_number: '5511',
            sequence: '3',
          },
        },
      },
    }),
    {
      accountNumber: '5511',
      sequence: '3',
      accountType: '/cosmos.vesting.v1beta1.ContinuousVestingAccount',
    }
  );

  assert.equal(extractCosmosAccountNumbers({ account: { '@type': 'unknown' } }), null);
  assert.equal(extractCosmosAccountNumbers(null), null);
});

test('Cosmos Noble Native USDC Parallel Auction: 0 bps Noble CCTP wins on $10k, Skip Go 1-Click wins on small dust, and account metadata is populated', async () => {
  const nobleAddr = 'noble1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh';
  const expectedAtaHex = solanaOwnerToUsdcAtaBytes32(SAMPLE_SOLANA_WALLET);
  const expectedAtaB64 = Buffer.from(expectedAtaHex.slice(2), 'hex').toString('base64');

  // Verify MsgDepositForBurn payload structure
  const burnMsg = buildNobleCctpBurnMsg({
    userAddress: nobleAddr,
    amountRaw: '10000000000',
    solanaUsdcAtaBytes32: expectedAtaHex,
  });
  assert.equal(burnMsg.msg_type_url, '/circle.cctp.v1.MsgDepositForBurn');
  const parsedBurn = JSON.parse(burnMsg.msg);
  assert.equal(parsedBurn.destination_domain, 5);
  assert.equal(parsedBurn.mint_recipient, expectedAtaB64);
  assert.equal(parsedBurn.burn_token, 'uusdc');

  // Scenario A: $10,000 Noble USDC — Skip Go quotes $9,975 (25 bps fee), Noble Direct CCTP (0 bps) wins!
  const mockFetcherLarge = async (url: string): Promise<Response> => {
    if (url.includes('/cosmos/auth/v1beta1/accounts/')) {
      return new Response(
        JSON.stringify({
          account: {
            '@type': '/cosmos.auth.v1beta1.BaseAccount',
            account_number: '8821',
            sequence: '14',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/v2/fungible/route')) {
      return new Response(
        JSON.stringify({
          source_asset_denom: 'uusdc',
          source_asset_chain_id: 'noble-1',
          dest_asset_denom: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          dest_asset_chain_id: 'solana',
          amount_in: '10000000000',
          amount_out: '9975000000',
          usd_amount_out: '9975.00',
          estimated_route_duration_seconds: 25,
          txs_required: 1,
          chain_ids: ['noble-1', 'solana'],
          required_chain_addresses: ['noble-1', 'solana'],
          operations: [{ cctp_transfer: {} }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/v2/fungible/msgs')) {
      return new Response(
        JSON.stringify({
          txs: [
            {
              cosmos_tx: {
                chain_id: 'noble-1',
                signer_address: nobleAddr,
                msgs: [{ msg_type_url: '/circle.cctp.v1.MsgDepositForBurn', msg: burnMsg.msg }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  const largeBatch = await prepareCosmosDirectBatch({
    chain: 'noble',
    assets: [
      mkAsset({
        chain: 'noble',
        chainName: 'Noble',
        address: 'uusdc',
        symbol: 'USDC',
        decimals: 6,
        rawBalance: '10000000000',
        uiBalance: 10000,
        priceUsd: 1,
        grossUsd: 10000,
        action: 'BRIDGE_DIRECT_USDC',
      }),
    ],
    userAddress: nobleAddr,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    fetcher: mockFetcherLarge,
  });

  assert.equal(largeBatch.liveExecutable, true);
  assert.equal(largeBatch.calls.length, 1);
  assert.equal(largeBatch.calls[0].provider, 'noble_cctp');
  assert.equal(largeBatch.calls[0].nativePayload.accountNumber, '8821');
  assert.equal(largeBatch.calls[0].nativePayload.sequence, '14');
  assert.equal(largeBatch.calls[0].nativePayload.feeDenom, 'uusdc');
  assert.ok(Array.isArray(largeBatch.calls[0].nativePayload.lcdUrls));
  assert.ok(Number(largeBatch.calls[0].nativePayload.gasPrice) > 0);
  assert.equal(largeBatch.routeAuction?.winner, 'noble_cctp');
  assert.equal(largeBatch.routeAuction?.runnerUp, 'skip_go');
  assert.ok(
    (largeBatch.routeAuction?.savingsOverRunnerUpUsd ?? 0) > 20,
    `Expected >$20 savings on $10k USDC, got ${largeBatch.routeAuction?.savingsOverRunnerUpUsd}`
  );

  // Scenario B: Small $10 Noble USDC where Skip Go Smart Relay quotes $9.92 (1-click arrival beats ~$0.25 CCTP claim overhead)
  const mockFetcherSmall = async (url: string): Promise<Response> => {
    if (url.includes('/cosmos/auth/v1beta1/accounts/')) {
      return new Response(
        JSON.stringify({ account: { account_number: '8821', sequence: '15' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/v2/fungible/route')) {
      return new Response(
        JSON.stringify({
          source_asset_denom: 'uusdc',
          source_asset_chain_id: 'noble-1',
          dest_asset_denom: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          dest_asset_chain_id: 'solana',
          amount_in: '10000000',
          amount_out: '9920000',
          usd_amount_out: '9.92',
          estimated_route_duration_seconds: 18,
          txs_required: 1,
          chain_ids: ['noble-1', 'solana'],
          required_chain_addresses: ['noble-1', 'solana'],
          operations: [{ cctp_transfer: {} }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('/v2/fungible/msgs')) {
      return new Response(
        JSON.stringify({
          txs: [
            {
              cosmos_tx: {
                chain_id: 'noble-1',
                signer_address: nobleAddr,
                msgs: [{ msg_type_url: '/circle.cctp.v1.MsgDepositForBurn', msg: burnMsg.msg }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  const smallBatch = await prepareCosmosDirectBatch({
    chain: 'noble',
    assets: [
      mkAsset({
        chain: 'noble',
        chainName: 'Noble',
        address: 'uusdc',
        symbol: 'USDC',
        decimals: 6,
        rawBalance: '10000000',
        uiBalance: 10,
        priceUsd: 1,
        grossUsd: 10,
        action: 'BRIDGE_DIRECT_USDC',
      }),
    ],
    userAddress: nobleAddr,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    fetcher: mockFetcherSmall,
  });

  assert.equal(smallBatch.liveExecutable, true);
  assert.equal(smallBatch.calls[0].provider, 'skip_go');
  assert.equal(smallBatch.routeAuction?.winner, 'skip_go');
  assert.equal(smallBatch.routeAuction?.runnerUp, 'noble_cctp');

  // Scenario C: Adversarial — Skip Go fails with HTTP 500 -> Noble Direct CCTP still executes live!
  const mockFetcherSkipDown = async (url: string): Promise<Response> => {
    if (url.includes('/cosmos/auth/v1beta1/accounts/')) {
      return new Response('lcd timeout', { status: 503 });
    }
    return new Response('skip outage', { status: 500 });
  };
  const fallbackBatch = await prepareCosmosDirectBatch({
    chain: 'noble',
    assets: [
      mkAsset({
        chain: 'noble',
        chainName: 'Noble',
        address: 'uusdc',
        symbol: 'USDC',
        decimals: 6,
        rawBalance: '100000000',
        uiBalance: 100,
        priceUsd: 1,
        grossUsd: 100,
        action: 'BRIDGE_DIRECT_USDC',
      }),
    ],
    userAddress: nobleAddr,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    fetcher: mockFetcherSkipDown,
  });
  assert.equal(fallbackBatch.liveExecutable, true);
  assert.equal(fallbackBatch.calls[0].provider, 'noble_cctp');
  assert.equal(fallbackBatch.calls[0].nativePayload.accountNumber, null);
  assert.equal(fallbackBatch.calls[0].nativePayload.accountInfoLive, false);
  assert.equal(fallbackBatch.routeAuction?.winner, 'noble_cctp');
});

// =========================================================================
// WAVE 7A: BITCOIN BIP-174 PSBT INPUT COUNTER + inputsToSign METADATA
// =========================================================================

function buildMockUnsignedPsbtHex(inputCount: number): string {
  // Minimal valid Bitcoin non-witness unsigned tx with `inputCount` inputs + 1 output
  const parts: number[] = [
    0x02, 0x00, 0x00, 0x00, // nVersion = 2
    inputCount, // CompactSize inputCount (< 253)
  ];
  for (let i = 0; i < inputCount; i += 1) {
    for (let b = 0; b < 32; b += 1) parts.push((i + 1) & 0xff); // prevTxid
    parts.push(i & 0xff, 0x00, 0x00, 0x00); // vout
    parts.push(0x00); // empty scriptSig
    parts.push(0xfd, 0xff, 0xff, 0xff); // nSequence
  }
  parts.push(0x01); // 1 output
  parts.push(0x10, 0x27, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00); // 10,000 sats
  parts.push(0x16, 0x00, 0x14, ...new Array(20).fill(0xab)); // P2WPKH scriptPubKey
  parts.push(0x00, 0x00, 0x00, 0x00); // nLockTime

  const txBytes = Buffer.from(parts);
  const magic = Buffer.from([0x70, 0x73, 0x62, 0x74, 0xff]);
  const key = Buffer.from([0x01, 0x00]); // keyLen=1, keyType=0x00 (PSBT_GLOBAL_UNSIGNED_TX)
  const valLen =
    txBytes.length < 0xfd
      ? Buffer.from([txBytes.length])
      : Buffer.from([0xfd, txBytes.length & 0xff, (txBytes.length >> 8) & 0xff]);
  const endGlobal = Buffer.from([0x00]);
  const emptyInputMaps = Buffer.alloc(inputCount, 0x00);
  const emptyOutputMaps = Buffer.from([0x00]);
  return Buffer.concat([magic, key, valLen, txBytes, endGlobal, emptyInputMaps, emptyOutputMaps]).toString('hex');
}

test('Bitcoin: BIP-174 PSBT binary parser extracts exact inputCount & prepareBtcDirectBatch populates inputsToSign', async () => {
  const psbt1 = buildMockUnsignedPsbtHex(1);
  const psbt3 = buildMockUnsignedPsbtHex(3);
  assert.equal(parsePsbtInputCount(psbt1), 1);
  assert.equal(parsePsbtInputCount(psbt3), 3);

  // PSBT v2 (BIP-370) PSBT_GLOBAL_INPUT_COUNT (keyType 0x04) = 2
  const psbtV2 = '70736274ff0104010200';
  assert.equal(parsePsbtInputCount(psbtV2), 2);

  // Malformed / invalid magic / truncated / 0-input PSBTs return null
  assert.equal(parsePsbtInputCount('deadbeef'), null);
  assert.equal(parsePsbtInputCount('70736274ff010006020000000000'), null);
  assert.equal(parsePsbtInputCount('70736274ff'), null);

  const btcAddr = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
  const built = buildBtcInputsToSign(btcAddr, psbt3);
  assert.equal(built.inputCount, 3);
  assert.deepEqual(built.inputsToSign, [{ address: btcAddr, signingIndexes: [0, 1, 2] }]);

  // prepareBtcDirectBatch injects inputCount + inputsToSign into Relay PSBT nativePayload
  const mockRelayFetcher = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        requestId: 'relay_btc_3in',
        details: { currencyOut: { amountFormatted: '598.50', amountUsd: '598.50' }, timeEstimate: 45 },
        fees: { gas: { amountUsd: '1.20' } },
        steps: [
          {
            id: 'deposit',
            action: 'Sign PSBT',
            description: 'Relay 3-input PSBT',
            kind: 'transaction',
            items: [{ data: { psbt: psbt3, depositAddress: 'bc1qdeposit' } }],
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  const batch = await prepareBtcDirectBatch({
    chain: 'btc',
    assets: [
      mkAsset({
        family: 'btc',
        chain: 'btc',
        chainName: 'Bitcoin',
        address: btcAddr,
        symbol: 'BTC',
        decimals: 8,
        rawBalance: '1000000',
        uiBalance: 0.01,
        priceUsd: 60000,
        grossUsd: 600,
      }),
    ],
    userAddress: btcAddr,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    fetcher: mockRelayFetcher,
  });

  assert.equal(batch.liveExecutable, true);
  assert.equal(batch.calls[0].nativePayload.inputCount, 3);
  assert.deepEqual(batch.calls[0].nativePayload.inputsToSign, [
    { address: btcAddr, signingIndexes: [0, 1, 2] },
  ]);
});

// =========================================================================
// WAVE 7A: SUI PARALLEL ROUTE AUCTION (LI.FI + MAYAN SWIFT + CCTP DOMAIN 8)
// =========================================================================

test('Sui Parallel Route Auction: picks highest net executable route, handles timeout & haircut, preserves honest liveExecutable', async () => {
  const suiUser = '0x0000000000000000000000000000000000000000000000000000000000000006';
  const suiUsdc = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

  // Case 1: Both LI.FI and Mayan Swift return live executable PTB bytes; Mayan quotes higher net USD
  const mockAuctionMayanWins = async (url: string): Promise<Response> => {
    if (url.includes('li.quest/v1/quote')) {
      return new Response(
        JSON.stringify({
          id: 'lifi_sui_1',
          tool: 'cetus',
          toolDetails: { name: 'Cetus' },
          estimate: { toAmount: '99100000', toAmountUSD: '99.10', executionDuration: 30, gasCosts: [{ amountUSD: '0.01' }] },
          transactionRequest: { data: 'bGlmaV9wdGJfYnl0ZXM=' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('price-api.mayan.finance/v3/quote')) {
      return new Response(
        JSON.stringify([
          {
            type: 'SWIFT',
            quoteId: 'mayan_sui_1',
            expectedAmountOut: '99.66',
            toTokenPrice: 1,
            clientRelayerFeeSuccess: 0.34,
            etaSeconds: 14,
            transactionRequest: { data: 'bWF5YW5fcHRiX2J5dGVz' },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  const mayanBatch = await prepareSuiDirectBatch({
    chain: 'sui',
    assets: [
      mkAsset({
        family: 'sui',
        chain: 'sui',
        chainName: 'Sui',
        address: suiUsdc,
        symbol: 'USDC',
        decimals: 6,
        rawBalance: '100000000',
        uiBalance: 100,
        priceUsd: 1,
        grossUsd: 100,
        action: 'BRIDGE_DIRECT_USDC',
      }),
    ],
    userAddress: suiUser,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    fetcher: mockAuctionMayanWins,
  });

  assert.equal(mayanBatch.liveExecutable, true);
  assert.equal(mayanBatch.calls[0].provider, 'mayan_swift');
  assert.equal(mayanBatch.routeAuction?.winner, 'mayan_swift');
  assert.equal(mayanBatch.routeAuction?.runnerUp, 'lifi');
  assert.equal(mayanBatch.routeAuction?.candidates.length, 3);
  assert.ok((mayanBatch.routeAuction?.savingsOverRunnerUpUsd ?? 0) >= 0.5);

  // Case 2: Neither LI.FI nor Mayan returns live PTB bytes -> Circle CCTP Domain 8 (0 bps) wins on $5,000 Native USDC with honest liveExecutable=false!
  const mockAuctionQuoteOnly = async (url: string): Promise<Response> => {
    if (url.includes('li.quest/v1/quote')) return new Response('no funds', { status: 400 });
    if (url.includes('li.quest/v1/advanced/routes')) {
      return new Response(
        JSON.stringify({
          routes: [
            {
              id: 'lifi_route_preview',
              toAmount: '4980000000',
              toAmountUSD: '4980.00',
              gasCostUSD: '0.02',
              steps: [{ tool: 'mayan', estimate: { executionDuration: 25 } }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('li.quest/v1/advanced/stepTransaction')) return new Response('unfunded', { status: 400 });
    if (url.includes('price-api.mayan.finance/v3/quote')) {
      return new Response(
        JSON.stringify([
          { type: 'SWIFT', quoteId: 'mayan_q_only', expectedAmountOut: '4990.00', etaSeconds: 15 },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  const cctpPreviewBatch = await prepareSuiDirectBatch({
    chain: 'sui',
    assets: [
      mkAsset({
        family: 'sui',
        chain: 'sui',
        chainName: 'Sui',
        address: suiUsdc,
        symbol: 'USDC',
        decimals: 6,
        rawBalance: '5000000000',
        uiBalance: 5000,
        priceUsd: 1,
        grossUsd: 5000,
        action: 'BRIDGE_DIRECT_USDC',
      }),
    ],
    userAddress: suiUser,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    fetcher: mockAuctionQuoteOnly,
  });

  assert.equal(cctpPreviewBatch.liveExecutable, false, 'Circle CCTP moveCall without BCS PTB bytes must honestly report liveExecutable=false');
  assert.equal(cctpPreviewBatch.calls[0].provider, 'circle_cctp');
  assert.equal(cctpPreviewBatch.routeAuction?.winner, 'circle_cctp');
  assert.ok((cctpPreviewBatch.routeAuction?.savingsOverRunnerUpUsd ?? 0) > 9);

  // Case 3: Mayan Swift times out (> 120ms budget) while LI.FI responds fast with live PTB -> LI.FI wins cleanly!
  const mockMayanTimeout = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('price-api.mayan.finance')) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 400);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return new Response('late', { status: 200 });
    }
    if (url.includes('li.quest/v1/quote')) {
      return new Response(
        JSON.stringify({
          id: 'lifi_fast',
          tool: 'cetus',
          estimate: { toAmount: '99200000', toAmountUSD: '99.20', executionDuration: 20, gasCosts: [{ amountUSD: '0.01' }] },
          transactionRequest: { data: 'ZmFzdF9wdGI=' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('not found', { status: 404 });
  };

  const timeoutBatch = await prepareSuiDirectBatch({
    chain: 'sui',
    assets: [
      mkAsset({
        family: 'sui',
        chain: 'sui',
        chainName: 'Sui',
        address: '0x2::sui::SUI',
        symbol: 'SUI',
        decimals: 9,
        rawBalance: '40000000000',
        uiBalance: 40,
        priceUsd: 2.5,
        grossUsd: 100,
        action: 'SELL_AND_BRIDGE',
      }),
    ],
    userAddress: suiUser,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    auctionTimeoutMs: 120,
    fetcher: mockMayanTimeout,
  });

  assert.equal(timeoutBatch.liveExecutable, true);
  assert.equal(timeoutBatch.calls[0].provider, 'lifi');
  assert.equal(timeoutBatch.routeAuction?.winner, 'lifi');
  const mayanCand = timeoutBatch.routeAuction?.candidates.find((c) => c.provider === 'mayan_swift');
  assert.ok(mayanCand && (mayanCand.status === 'timeout' || mayanCand.status === 'error'));
});

// =========================================================================
// WAVE 7A: APTOS PANORA PRE-SWAP + CHAINED CIRCLE CCTP DOMAIN 9
// =========================================================================

test('Aptos Panora Pre-Swap + Chained Circle CCTP Domain 9: executes 2-step Move flow and fails closed when unkeyed/bad haircut/malformed', async () => {
  const aptosUser = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const aptAsset = mkAsset({
    family: 'aptos',
    chain: 'aptos',
    chainName: 'Aptos',
    address: '0x1::aptos_coin::AptosCoin',
    symbol: 'APT',
    decimals: 8,
    rawBalance: '2000000000', // 20 APT
    uiBalance: 20,
    priceUsd: 5,
    grossUsd: 100,
    action: 'SELL_AND_BRIDGE',
  });

  // 1. Happy path: Panora returns valid Move entry function -> chained directly into Circle CCTP Domain 9 using minToTokenAmount
  let capturedUrl = '';
  let capturedApiKey = '';
  const mockPanoraOk = async (url: string, init?: RequestInit): Promise<Response> => {
    capturedUrl = url;
    capturedApiKey = String((init?.headers as Record<string, string>)?.['x-api-key'] || '');
    return new Response(
      JSON.stringify({
        quotes: [
          {
            toTokenAmount: '99.40',
            minToTokenAmount: '98.90',
            toTokenAmountUSD: '99.40',
            txData: {
              function: '0x1c3206329806286fd2223647c9f9b130e66baeb6d7224a18c1f642ffe48f3b4c::panora_swap::router_entry',
              type_arguments: ['0x1::aptos_coin::AptosCoin'],
              arguments: ['2000000000', '98900000'],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const batchOk = await prepareAptosDirectBatch({
    chain: 'aptos',
    assets: [aptAsset],
    userAddress: aptosUser,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    panoraApiKey: 'test_panora_key_123',
    fetcher: mockPanoraOk,
  });

  assert.match(capturedUrl, /https:\/\/api\.panora\.exchange\/swap/);
  assert.match(capturedUrl, /fromTokenAmount=20/);
  assert.match(capturedUrl, /toTokenAddress=0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b/);
  assert.equal(capturedApiKey, 'test_panora_key_123');
  assert.equal(batchOk.liveExecutable, true);
  assert.equal(batchOk.skippedAssets.length, 0);
  const swapCall = batchOk.calls.find((c) => c.stepId === 'aptos_panora_preswap');
  const cctpCall = batchOk.calls.find((c) => c.stepId === 'aptos_cctp_deposit_for_burn');
  assert.ok(swapCall, 'Expected Step 1 Panora Move pre-swap call');
  assert.ok(cctpCall, 'Expected Step 2 chained Circle CCTP Domain 9 call');
  assert.equal(
    swapCall.nativePayload.function,
    '0x1c3206329806286fd2223647c9f9b130e66baeb6d7224a18c1f642ffe48f3b4c::panora_swap::router_entry'
  );
  assert.equal(cctpCall.nativePayload.chainedFromStep, 'aptos_panora_preswap');
  const cctpArgs = cctpCall.nativePayload.arguments as unknown[];
  assert.equal(cctpArgs[0], '98900000', 'Chained CCTP must burn conservative minOutUsdcRaw so Step 2 never reverts');
  assert.equal(cctpArgs[1], 5);

  // 2. Adversarial: Unkeyed Panora -> fails closed with liveExecutable=false, NEVER fabricates Move payload!
  const prevKey = process.env.PANORA_API_KEY;
  delete process.env.PANORA_API_KEY;
  try {
    const unkeyedRes = await quotePanoraAptosSwap({
      fromTokenAddress: aptAsset.address,
      fromAmountRaw: aptAsset.rawBalance,
      fromDecimals: 8,
      userAddress: aptosUser,
      apiKey: '',
    });
    assert.equal(unkeyedRes.ok, false);

    const unkeyedBatch = await prepareAptosDirectBatch({
      chain: 'aptos',
      assets: [aptAsset],
      userAddress: aptosUser,
      solanaDestination: SAMPLE_SOLANA_WALLET,
      outputAsset: 'USDC',
      panoraApiKey: '',
    });
    assert.equal(unkeyedBatch.liveExecutable, false);
    assert.equal(unkeyedBatch.calls.length, 0);
    assert.equal(unkeyedBatch.skippedAssets.length, 1);
    assert.match(unkeyedBatch.skippedAssets[0].reason, /PANORA_API_KEY/i);
  } finally {
    if (prevKey !== undefined) process.env.PANORA_API_KEY = prevKey;
  }

  // 3. Adversarial: Excessive haircut ($50 out on $100 APT) rejected by live haircut guard!
  const mockPanoraHaircut = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        quotes: [
          {
            toTokenAmount: '50.00',
            minToTokenAmount: '49.50',
            toTokenAmountUSD: '50.00',
            txData: {
              function: '0x1c3206329806286fd2223647c9f9b130e66baeb6d7224a18c1f642ffe48f3b4c::panora_swap::router_entry',
              type_arguments: [],
              arguments: [],
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  const haircutBatch = await prepareAptosDirectBatch({
    chain: 'aptos',
    assets: [aptAsset],
    userAddress: aptosUser,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    panoraApiKey: 'test_panora_key_123',
    fetcher: mockPanoraHaircut,
  });
  assert.equal(haircutBatch.liveExecutable, false);
  assert.equal(haircutBatch.calls.length, 0);
  assert.equal(haircutBatch.skippedAssets.length, 1);

  // 4. Adversarial: Malformed Move function in Panora response rejected fail-closed!
  const mockPanoraBadFn = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        quotes: [
          {
            toTokenAmount: '99.50',
            minToTokenAmount: '99.00',
            txData: { function: 'not_a_valid_move_fn', type_arguments: [], arguments: [] },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  const badFnBatch = await prepareAptosDirectBatch({
    chain: 'aptos',
    assets: [aptAsset],
    userAddress: aptosUser,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    panoraApiKey: 'test_panora_key_123',
    fetcher: mockPanoraBadFn,
  });
  assert.equal(badFnBatch.liveExecutable, false);
  assert.equal(badFnBatch.calls.length, 0);
  assert.equal(badFnBatch.skippedAssets.length, 1);
  assert.match(badFnBatch.skippedAssets[0].reason, /entry_function_payload/i);
});
