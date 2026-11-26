import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { aptosAdapter } from '../src/adapters/aptos.js';
import { btcAdapter } from '../src/adapters/btc.js';
import { cosmosAdapter, prepareCosmosDirectBatch } from '../src/adapters/cosmos.js';
import { suiAdapter } from '../src/adapters/sui.js';
import { tonAdapter } from '../src/adapters/ton.js';
import { tronAdapter } from '../src/adapters/tron.js';
import { computePreservationFee } from '../src/scanner/chains.js';
import { SOLANA_RPC_URLS } from '../src/scanner/discovery.js';
import type { ScannedAsset } from '../src/scanner/types.js';

const SOL_DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function extractFrontendFeeFn(filePath: string): (grossUsd: number) => {
  grossUsd: number;
  feeBps: number;
  effectiveFeeBps: number;
  feeUsd: number;
  capApplied: boolean;
  savedVs7PctUsd: number;
} {
  const src = fs.readFileSync(filePath, 'utf8');
  const start = src.indexOf('const PRESERVATION_FEE_BRACKETS');
  assert.ok(start >= 0, `PRESERVATION_FEE_BRACKETS not found in ${filePath}`);
  const fnStart = src.indexOf('function computeTieredPreservationFee(', start);
  assert.ok(fnStart >= 0, `computeTieredPreservationFee not found in ${filePath}`);
  // Find matching closing brace for computeTieredPreservationFee
  let depth = 0;
  let started = false;
  let end = -1;
  for (let i = fnStart; i < src.length; i++) {
    if (src[i] === '{') {
      depth++;
      started = true;
    } else if (src[i] === '}') {
      depth--;
      if (started && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > fnStart, `Could not parse computeTieredPreservationFee end in ${filePath}`);
  const snippet = `${src.slice(start, end)}; computeTieredPreservationFee;`;
  return vm.runInNewContext(snippet) as (grossUsd: number) => {
    grossUsd: number;
    feeBps: number;
    effectiveFeeBps: number;
    feeUsd: number;
    capApplied: boolean;
    savedVs7PctUsd: number;
  };
}

function makeAsset(overrides: Partial<ScannedAsset>): ScannedAsset {
  return {
    id: 'test-asset',
    chain: 'noble',
    chainName: 'Noble',
    address: 'uusdc',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    rawBalance: '10000000000',
    uiBalance: 10_000,
    priceUsd: 1,
    liquidityUsd: 1_000_000,
    grossUsd: 10_000,
    kind: 'erc20',
    action: 'BRIDGE_DIRECT_USDC',
    actionReason: 'Direct CCTP USDC',
    selectedByDefault: true,
    estimatedGasUsd: 0.02,
    batchedGasUsd: 0.02,
    estimatedSlippageUsd: 0,
    netUsdcSingle: 9976.73,
    netUsdcBatched: 9976.73,
    honeypotSafe: true,
    ...overrides,
  };
}

describe('Wave 10 Cross-Lane Integration Tie-Ups', () => {
  it('exact zero-fee parity ($0.00 / 0 bps) between backend chains.ts and frontend app.js & preservation.js', () => {
    const appFn = extractFrontendFeeFn(path.resolve('public/app.js'));
    const presFn = extractFrontendFeeFn(path.resolve('public/preservation.js'));

    const checkpoints = [0, 25, 49.99, 50, 100, 499.99, 500, 1000, 4999.99, 5000, 10_000, 36_750, 100_000];
    for (const amount of checkpoints) {
      const backend = computePreservationFee(amount);
      const app = appFn(amount);
      const pres = presFn(amount);

      assert.equal(backend.feeUsd, 0, `backend feeUsd should be 0 at $${amount}`);
      assert.equal(app.feeUsd, backend.feeUsd, `app.js feeUsd mismatch at $${amount}`);
      assert.equal(pres.feeUsd, backend.feeUsd, `preservation.js feeUsd mismatch at $${amount}`);
      assert.equal(app.effectiveFeeBps, 0, `app.js effectiveFeeBps mismatch at $${amount}`);
      assert.equal(pres.effectiveFeeBps, 0, `preservation.js effectiveFeeBps mismatch at $${amount}`);
      assert.equal(app.capApplied, false, `app.js capApplied mismatch at $${amount}`);
      assert.equal(pres.capApplied, false, `preservation.js capApplied mismatch at $${amount}`);
      assert.equal(app.savedVs7PctUsd, backend.savingsVsFlat7PctUsd, `app.js savedVs7PctUsd mismatch at $${amount}`);
      assert.equal(pres.savedVs7PctUsd, backend.savingsVsFlat7PctUsd, `preservation.js savedVs7PctUsd mismatch at $${amount}`);
    }
  });

  it('Noble $10k direct batch and all 6 non-EVM adapters default to 0% open-source zero fee ($0.00) while honoring explicit overrides', async () => {
    const nobleUsdc = makeAsset({ chain: 'noble', grossUsd: 10_000 });
    const mockFetcher = async () =>
      new Response(JSON.stringify({ account: { account_number: '1', sequence: '0' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    const nobleBatch = await prepareCosmosDirectBatch({
      chain: 'noble',
      userAddress: 'noble1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5h568l',
      solanaDestination: SOL_DEST,
      assets: [nobleUsdc],
      outputAsset: 'USDC',
      fetcher: mockFetcher,
    });
    assert.equal(nobleBatch.feeBreakdown.estimatedFeeUsd, 0);
    assert.equal(nobleBatch.feeBreakdown.feeBps, 0);

    // Explicit flat 700 bps override must still be honored
    const nobleFlat = await prepareCosmosDirectBatch({
      chain: 'noble',
      userAddress: 'noble1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5h568l',
      solanaDestination: SOL_DEST,
      assets: [nobleUsdc],
      outputAsset: 'USDC',
      protocolFeeBps: 700,
      fetcher: mockFetcher,
    });
    assert.equal(nobleFlat.feeBreakdown.estimatedFeeUsd, 700);
    assert.equal(nobleFlat.feeBreakdown.feeBps, 700);

    // Verify all 6 non-EVM adapters' buildGaslessIntent default to $0.00 (0 bps) on $10,000
    const cosmosIntent = await cosmosAdapter.buildGaslessIntent({
      chain: 'noble',
      userAddress: 'noble1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq5h568l',
      solanaDestination: SOL_DEST,
      assets: [nobleUsdc],
      outputAsset: 'USDC',
    });
    assert.equal(cosmosIntent.protocolFeeUsd, 0);
    assert.equal(cosmosIntent.protocolFeeBps, 0);

    const suiIntent = await suiAdapter.buildGaslessIntent({
      chain: 'sui',
      userAddress: '0x' + '11'.repeat(32),
      solanaDestination: SOL_DEST,
      assets: [makeAsset({ chain: 'sui', chainName: 'Sui', grossUsd: 10_000 })],
      outputAsset: 'USDC',
    });
    assert.equal(suiIntent.protocolFeeUsd, 0);
    assert.equal(suiIntent.protocolFeeBps, 0);

    const aptosIntent = await aptosAdapter.buildGaslessIntent({
      chain: 'aptos',
      userAddress: '0x' + '22'.repeat(32),
      solanaDestination: SOL_DEST,
      assets: [makeAsset({ chain: 'aptos', chainName: 'Aptos', grossUsd: 10_000 })],
      outputAsset: 'USDC',
    });
    assert.equal(aptosIntent.protocolFeeUsd, 0);
    assert.equal(aptosIntent.protocolFeeBps, 0);

    const btcIntent = await btcAdapter.buildGaslessIntent({
      chain: 'btc',
      userAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      solanaDestination: SOL_DEST,
      assets: [
        makeAsset({
          chain: 'btc',
          chainName: 'Bitcoin',
          address: 'native',
          symbol: 'BTC',
          decimals: 8,
          rawBalance: '11627907',
          uiBalance: 0.11627907,
          grossUsd: 10_000,
          action: 'SELL_AND_BRIDGE',
        }),
      ],
      outputAsset: 'USDC',
    });
    assert.equal(btcIntent.protocolFeeUsd, 0);
    assert.equal(btcIntent.protocolFeeBps, 0);

    const tonIntent = await tonAdapter.buildGaslessIntent({
      chain: 'ton',
      userAddress: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
      solanaDestination: SOL_DEST,
      assets: [
        makeAsset({
          chain: 'ton',
          chainName: 'TON',
          address: 'native',
          symbol: 'TON',
          decimals: 9,
          grossUsd: 10_000,
          action: 'SELL_AND_BRIDGE',
        }),
      ],
      outputAsset: 'USDC',
    });
    assert.equal(tonIntent.protocolFeeUsd, 0);
    assert.equal(tonIntent.protocolFeeBps, 0);

    const tronIntent = await tronAdapter.buildGaslessIntent({
      chain: 'tron',
      userAddress: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
      solanaDestination: SOL_DEST,
      assets: [
        makeAsset({
          chain: 'tron',
          chainName: 'Tron',
          address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
          symbol: 'USDT',
          grossUsd: 10_000,
          action: 'SELL_AND_BRIDGE',
        }),
      ],
      outputAsset: 'USDC',
    });
    assert.equal(tronIntent.protocolFeeUsd, 0);
    assert.equal(tronIntent.protocolFeeBps, 0);
  });

  it('removes dead solana-rpc.publicnode.com from all Solana RPC lists and keeps live endpoints', () => {
    assert.ok(!SOLANA_RPC_URLS.includes('https://solana-rpc.publicnode.com'));
    assert.ok(SOLANA_RPC_URLS.includes('https://api.mainnet-beta.solana.com'));
    assert.ok(SOLANA_RPC_URLS.includes('https://solana.publicnode.com'));

    for (const rel of [
      'src/bridge/solana-claim.ts',
      'src/bridge/solana-rent.ts',
      'src/execution/proof.ts',
      'src/scanner/discovery.ts',
    ]) {
      const content = fs.readFileSync(path.resolve(rel), 'utf8');
      assert.ok(!content.includes('solana-rpc.publicnode.com'), `Dead Solana RPC still present in ${rel}`);
      assert.ok(content.includes('https://api.mainnet-beta.solana.com'), `Missing primary Solana RPC in ${rel}`);
      assert.ok(content.includes('https://solana.publicnode.com'), `Missing fallback Solana RPC in ${rel}`);
    }
  });
});
