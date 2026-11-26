import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3';
import { DEFI_SELECTORS, pad32Hex } from '../src/defi/extractors.js';
import {
  buildSafeTransactionBatch,
  buildSafeTransactionBatchFromPrepared,
  computeSafeBatchChecksum,
  MAX_SAFE_BATCH_TRANSACTIONS,
  normalizeSafeAddress,
  normalizeSafeCalldata,
  normalizeSafeChainId,
  normalizeSafeValueWei,
  SAFE_TX_BUILDER_VERSION,
} from '../src/execution/safe-batch.js';
import {
  buildTaxEventsFromScannedAssets,
  escapeCsvCell,
  generateTaxCsvExport,
  MAX_TAX_EXPORT_EVENTS,
  neutralizeCsvFormula,
} from '../src/execution/tax-export.js';
import { prepareChainBatchExecution } from '../src/execution/tx-builder.js';
import { EVM_CHAINS } from '../src/scanner/chains.js';
import { scanPresetWallet } from '../src/scanner/classifier.js';
import {
  classifyExpandedDefiProbeResult,
  CONVEX_BOOSTER_CONTRACTS,
  EXPANDED_DEFI_SELECTORS,
  FLUID_LIQUIDITY_SINGLETONS,
  identifyDefiProtocolByMetadata,
  MORPHO_BLUE_SINGLETONS,
  probeExpandedDefiContracts,
} from '../src/scanner/discovery.js';
import { createTurgaliumServer } from '../src/server/app.js';

const USER_EVM = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const SAFE_EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const USER_SOL = 'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n';
const USDC_ETH = EVM_CHAINS.ethereum.usdcAddress;
const ATTACKER = '0x9999999999999999999999999999999999999999';

function padUint256(val: bigint): string {
  return val.toString(16).padStart(64, '0');
}

function decodeMulticall3InputCalls(callData: string): Array<{ target: string; callData: string }> {
  const clean = callData.replace(/^0x/, '').slice(8); // strip 0x82ad56cb
  const arrOffsetBytes = Number(BigInt('0x' + clean.slice(0, 64)));
  const arrStart = arrOffsetBytes * 2;
  const count = Number(BigInt('0x' + clean.slice(arrStart, arrStart + 64)));
  const headsStart = arrStart + 64;
  const out: Array<{ target: string; callData: string }> = [];
  for (let i = 0; i < count; i += 1) {
    const relOff = Number(BigInt('0x' + clean.slice(headsStart + i * 64, headsStart + (i + 1) * 64)));
    const elemStart = headsStart + relOff * 2;
    const target = '0x' + clean.slice(elemStart + 24, elemStart + 64).toLowerCase();
    const bytesRelOff = Number(BigInt('0x' + clean.slice(elemStart + 128, elemStart + 192)));
    const bytesLenPos = elemStart + bytesRelOff * 2;
    const byteLen = Number(BigInt('0x' + clean.slice(bytesLenPos, bytesLenPos + 64)));
    const dataHex = '0x' + clean.slice(bytesLenPos + 64, bytesLenPos + 64 + byteLen * 2);
    out.push({ target, callData: dataHex });
  }
  return out;
}

function encodeMulticall3Return(results: Array<{ success: boolean; returnData: string }>): string {
  const tupleChunks: string[] = [];
  for (const r of results) {
    const raw = r.returnData.replace(/^0x/, '');
    const byteLen = raw.length / 2;
    const padded = raw.padEnd(Math.ceil(raw.length / 64) * 64, '0');
    const chunk =
      padUint256(r.success ? 1n : 0n) +
      padUint256(64n) +
      padUint256(BigInt(byteLen)) +
      padded;
    tupleChunks.push(chunk);
  }
  const heads: string[] = [];
  let runningBytes = results.length * 32;
  for (const ch of tupleChunks) {
    heads.push(padUint256(BigInt(runningBytes)));
    runningBytes += ch.length / 2;
  }
  return '0x' + padUint256(32n) + padUint256(BigInt(results.length)) + heads.join('') + tupleChunks.join('');
}

async function withMockedFetch<T>(
  mockFn: typeof globalThis.fetch,
  run: () => Promise<T>
): Promise<T> {
  const prev = globalThis.fetch;
  globalThis.fetch = mockFn;
  try {
    return await run();
  } finally {
    globalThis.fetch = prev;
  }
}

// ============================================================================
// 1. SAFE TRANSACTION BUILDER JSON v1.0 & SAFE APP MANIFEST
// ============================================================================

test('safe-batch: builds valid Safe Transaction Builder JSON v1.0 with EIP-55 checksums, decimal wei, and deterministic checksum', async () => {
  const built = buildSafeTransactionBatch({
    chain: 'base',
    createdAt: 1_764_180_000_000,
    createdFromSafeAddress: SAFE_EVM.toLowerCase(),
    createdFromOwnerAddress: USER_EVM.toLowerCase(),
    name: 'Base Sweep to Solana',
    description: 'Approve USDC + CCTP V2 Fast Transfer',
    calls: [
      {
        to: EVM_CHAINS.base.usdcAddress.toLowerCase(),
        value: '0x0',
        data: '0x095ea7b3' + pad32Hex(SAFE_EVM) + padUint256(1_000_000n),
      },
      {
        to: USER_EVM.toLowerCase(),
        value: '0xde0b6b3a7640000', // 1 ETH in hex
        data: '0x',
      },
    ],
  });

  assert.equal(built.version, SAFE_TX_BUILDER_VERSION);
  assert.equal(built.chainId, '8453');
  assert.equal(built.createdAt, 1_764_180_000_000);
  assert.equal(built.meta.createdFromSafeAddress, SAFE_EVM);
  assert.equal(built.meta.createdFromOwnerAddress, USER_EVM);
  assert.equal(built.transactions.length, 2);
  assert.equal(built.transactions[0].to, normalizeSafeAddress(EVM_CHAINS.base.usdcAddress, 'to'));
  assert.equal(built.transactions[0].value, '0');
  assert.equal(built.transactions[0].contractMethod, null);
  assert.equal(built.transactions[0].contractInputsValues, null);
  assert.equal(built.transactions[1].to, USER_EVM);
  assert.equal(built.transactions[1].value, '1000000000000000000');
  assert.equal(built.transactions[1].data, '0x');

  const { checksum, ...metaWithoutChecksum } = built.meta;
  assert.match(checksum, /^0x[0-9a-f]{64}$/);
  assert.equal(
    checksum,
    computeSafeBatchChecksum({
      version: built.version,
      chainId: built.chainId,
      createdAt: built.createdAt,
      meta: metaWithoutChecksum,
      transactions: built.transactions,
    })
  );

  // Build directly from a live PreparedChainBatch (CCTP V2 batch)
  const prepared = await prepareChainBatchExecution({
    chain: 'ethereum',
    assets: [
      {
        id: 'eth:usdc',
        family: 'evm',
        chain: 'ethereum',
        chainName: 'Ethereum',
        address: USDC_ETH,
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        kind: 'erc20',
        rawBalance: '500000000',
        uiBalance: 500,
        priceUsd: 1,
        grossUsd: 500,
        liquidityUsd: 100_000_000,
        estimatedGasUsd: 1.2,
        batchedGasUsd: 0.9,
        estimatedSlippageUsd: 0,
        netUsdcSingle: 498.8,
        netUsdcBatched: 499.1,
        action: 'BRIDGE_DIRECT_USDC',
        actionReason: 'Direct native USDC bridge',
        selectedByDefault: true,
        honeypotSafe: true,
      },
    ],
    userAddress: SAFE_EVM,
    solanaDestination: USER_SOL,
    bridgePreference: 'cctp',
    allowanceCheckFn: async () => 10n ** 18n,
    routeAuctionOptions: {
      fetcher: async () =>
        new Response(JSON.stringify([{ finalityThreshold: 1000, minimumFee: 1 }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
  });

  const fromPrepared = buildSafeTransactionBatchFromPrepared(prepared, { createdAt: 1_764_180_000_000 });
  assert.equal(fromPrepared.version, '1.0');
  assert.equal(fromPrepared.chainId, '1');
  assert.equal(fromPrepared.meta.createdFromSafeAddress, SAFE_EVM);
  assert.ok(fromPrepared.transactions.length >= 1);
  assert.equal(fromPrepared.transactions[0].contractMethod, null);
});

test('safe-batch: strictly rejects invalid addresses, bad EIP-55 checksum, zero address, invalid hex, and bad chainId', () => {
  assert.throws(() => normalizeSafeAddress('0x0000000000000000000000000000000000000000', 'to'), /zero address/i);
  assert.throws(() => normalizeSafeAddress('0x71c7656EC7ab88b098defB751B7401B5f6d8976F', 'to'), /checksum/i);
  assert.throws(() => normalizeSafeAddress('not-an-address', 'to'), /Invalid to/i);

  assert.throws(() => normalizeSafeChainId({ chain: 'ethereum', chainId: 8453 }), /Mismatched/);
  assert.throws(() => normalizeSafeChainId({ chainId: 0 }), /positive/i);
  assert.throws(() => normalizeSafeChainId({ chainId: '0x1' }), /decimal integer/i);
  assert.throws(() => normalizeSafeChainId({ chain: 'solana' }), /Unsupported EVM chain/i);

  assert.throws(() => normalizeSafeValueWei('-1', 0), /non-negative/i);
  assert.throws(() => normalizeSafeValueWei(1.5, 0), /non-negative integer/i);
  assert.throws(() => normalizeSafeCalldata('0x123', 0), /even-length/i);
  assert.throws(() => normalizeSafeCalldata('deadbeef', 0), /0x-prefixed/i);

  assert.throws(
    () => buildSafeTransactionBatch({ chain: 'ethereum', calls: [] }),
    /At least one transaction/i
  );
  assert.throws(
    () =>
      buildSafeTransactionBatch({
        chain: 'ethereum',
        calls: Array.from({ length: MAX_SAFE_BATCH_TRANSACTIONS + 1 }, () => ({
          to: USER_EVM,
          value: '0',
          data: '0x',
        })),
      }),
    /exceeds maximum/i
  );
});

test('public/safe-manifest.json is a valid Safe App manifest pointing to an existing Turgalium SVG icon', () => {
  const manifestPath = path.resolve('public/safe-manifest.json');
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    name?: string;
    description?: string;
    iconPath?: string;
  };
  assert.equal(raw.name, 'Turgalium');
  assert.ok(typeof raw.description === 'string' && raw.description.length > 20);
  assert.equal(raw.iconPath, 'logos/turgalium.svg');
  assert.ok(fs.existsSync(path.resolve('public', raw.iconPath)), 'iconPath must resolve inside public/');
});

// ============================================================================
// 2. TAX-READY CSV EXPORTS (KOINLY / COINTRACKER / AWAKEN + FORMULA INJECTION)
// ============================================================================

test('tax-export: generates valid Koinly, CoinTracker, and Awaken CSVs covering DeFi unwinds, swaps, bridges, and tax-loss burns', async () => {
  const events = [
    {
      timestamp: '2026-11-20T14:30:05.000Z',
      kind: 'defi_withdraw' as const,
      chain: 'ethereum',
      protocol: 'Morpho Vault',
      sentAmount: 1000,
      sentCurrency: 'steakUSDC',
      sentFiatUsd: 1025.5,
      receivedAmount: 1025.5,
      receivedCurrency: 'USDC',
      receivedFiatUsd: 1025.5,
      feeAmount: 0.0012,
      feeCurrency: 'ETH',
      feeUsd: 3.6,
      txHash: '0x' + 'a1'.repeat(32),
    },
    {
      timestamp: '2026-11-20T14:32:00.000Z',
      kind: 'swap' as const,
      chain: 'base',
      sentAmount: 250,
      sentCurrency: 'AERO',
      sentFiatUsd: 300,
      receivedAmount: 298.5,
      receivedCurrency: 'USDC',
      receivedFiatUsd: 298.5,
      feeAmount: 0.05,
      feeCurrency: 'USD',
      feeUsd: 0.05,
      txHash: '0x' + 'b2'.repeat(32),
    },
    {
      timestamp: '2026-11-20T14:35:00.000Z',
      kind: 'bridge' as const,
      chain: 'base',
      sentAmount: 298.5,
      sentCurrency: 'USDC',
      sentFiatUsd: 298.5,
      receivedAmount: 298.2,
      receivedCurrency: 'USDC',
      receivedFiatUsd: 298.2,
      feeAmount: 0.3,
      feeCurrency: 'USDC',
      feeUsd: 0.3,
      txHash: '0x' + 'c3'.repeat(32),
    },
    {
      timestamp: '2026-11-20T14:36:10.000Z',
      kind: 'burn_loss_harvest' as const,
      chain: 'ethereum',
      sentAmount: 50_000,
      sentCurrency: 'RUGCOIN',
      sentFiatUsd: 420, // original cost basis / loss tracking metadata
      feeAmount: 0.0005,
      feeCurrency: 'ETH',
      feeUsd: 1.5,
      txHash: '0x' + 'd4'.repeat(32),
    },
  ];

  // Koinly
  const koinly = generateTaxCsvExport({ format: 'koinly', events, generatedAt: '2026-11-26T00:00:00Z' });
  assert.equal(koinly.filename, 'turgalium-koinly-2026-11-26.csv');
  assert.equal(koinly.rowCount, 4);
  assert.equal(koinly.summary.defiWithdrawals, 1);
  assert.equal(koinly.summary.swaps, 1);
  assert.equal(koinly.summary.bridges, 1);
  assert.equal(koinly.summary.burnsHarvested, 1);
  assert.equal(koinly.summary.estimatedTaxLossBurnUsd, 420);
  const kLines = koinly.csv.trim().split('\r\n');
  assert.equal(
    kLines[0],
    'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash'
  );
  assert.ok(kLines[1].startsWith('2026-11-20 14:30:05 UTC,1000,steakUSDC,1025.5,USDC,0.0012,ETH,1025.50,USD,unstake,'));
  assert.ok(kLines[4].includes(',50000,RUGCOIN,,,0.0005,ETH,0.00,USD,lost,'));

  // CoinTracker
  const ct = generateTaxCsvExport({ format: 'cointracker', events, generatedAt: '2026-11-26T00:00:00Z' });
  assert.equal(ct.filename, 'turgalium-cointracker-2026-11-26.csv');
  const ctLines = ct.csv.trim().split('\r\n');
  assert.equal(
    ctLines[0],
    'Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag'
  );
  assert.ok(ctLines[1].startsWith('11/20/2026 14:30:05,1025.5,USDC,1000,steakUSDC,0.0012,ETH,unstake'));
  assert.ok(ctLines[4].startsWith('11/20/2026 14:36:10,,,50000,RUGCOIN,0.0005,ETH,lost'));

  // Awaken
  const awaken = generateTaxCsvExport({ format: 'awaken', events, generatedAt: '2026-11-26T00:00:00Z' });
  assert.equal(awaken.filename, 'turgalium-awaken-2026-11-26.csv');
  const awLines = awaken.csv.trim().split('\r\n');
  assert.equal(
    awLines[0],
    'Date,Received Quantity,Received Currency,Received Fiat,Sent Quantity,Sent Currency,Sent Fiat,Fee Amount,Fee Currency,Transaction Hash,Notes,Tag'
  );
  assert.ok(awLines[1].endsWith(',withdraw'));
  assert.ok(awLines[2].endsWith(',swap'));
  assert.ok(awLines[3].endsWith(',bridge'));
  assert.ok(awLines[4].endsWith(',lost'));

  // Planned sweep directly from preset ScanReport
  const preset = await scanPresetWallet('veteran_defi');
  const derived = buildTaxEventsFromScannedAssets({ assets: preset.assets, outputAsset: 'USDC' });
  assert.ok(derived.length > 0);
  const fromScan = generateTaxCsvExport({ format: 'koinly', scan: preset });
  assert.equal(fromScan.rowCount, derived.length);
});

test('tax-export: strictly neutralizes CSV formula injection for =, +, -, @, \\t, \\r and leading-space formulas', () => {
  assert.equal(neutralizeCsvFormula('=SUM(A1:A10)'), "'=SUM(A1:A10)");
  assert.equal(neutralizeCsvFormula('+cmd| /C calc!A0'), "'+cmd| /C calc!A0");
  assert.equal(neutralizeCsvFormula('-2+3+cmd'), "'-2+3+cmd");
  assert.equal(neutralizeCsvFormula('@SUM(1+1)'), "'@SUM(1+1)");
  assert.equal(neutralizeCsvFormula('\t=1+1'), "'\t=1+1");
  assert.equal(neutralizeCsvFormula('\r=1+1'), "'\r=1+1");
  assert.equal(neutralizeCsvFormula('   =IMPORTXML("http://evil")'), "'   =IMPORTXML(\"http://evil\")");
  assert.equal(neutralizeCsvFormula('USDC'), 'USDC');

  assert.equal(escapeCsvCell('=HYPERLINK("https://evil.test","click")'), `"'=HYPERLINK(""https://evil.test"",""click"")"`);

  const exported = generateTaxCsvExport({
    format: 'awaken',
    generatedAt: '2026-11-26T00:00:00Z',
    events: [
      {
        kind: 'burn_loss_harvest',
        sentAmount: 100,
        sentCurrency: '=SCAM',
        description: '+cmd|\' /C calc\'!A0',
        txHash: '@HYPERLINK("http://x")',
      },
      {
        kind: 'swap',
        sentAmount: 10,
        sentCurrency: '-NEG',
        receivedAmount: 5,
        receivedCurrency: '\tTAB',
        description: '\rCR_INJECT,with,commas',
      },
    ],
  });

  assert.ok(exported.csv.includes("'=SCAM"));
  assert.ok(exported.csv.includes("'+cmd|' /C calc'!A0"));
  assert.ok(exported.csv.includes(`"'@HYPERLINK(""http://x"")"`));
  assert.ok(exported.csv.includes("'-NEG"));
  assert.ok(exported.csv.includes("'\tTAB"));
  assert.ok(exported.csv.includes(`"'\rCR_INJECT,with,commas"`));

  // Validation rejections
  assert.throws(
    () => generateTaxCsvExport({ format: 'turbotax' as 'koinly', events: [{ kind: 'swap' }] }),
    /format must be one of/i
  );
  assert.throws(() => generateTaxCsvExport({ format: 'koinly', events: [] }), /No taxable/i);
  assert.throws(
    () =>
      generateTaxCsvExport({
        format: 'koinly',
        events: [{ kind: 'swap', sentAmount: -5, sentCurrency: 'ETH' }],
      }),
    /non-negative/i
  );
  assert.throws(
    () =>
      generateTaxCsvExport({
        format: 'koinly',
        events: Array.from({ length: MAX_TAX_EXPORT_EVENTS + 1 }, () => ({ kind: 'swap' as const })),
      }),
    /exceeds maximum/i
  );
});

// ============================================================================
// 3. EXPANDED DEFI PROTOCOL DETECTION (MORPHO, FLUID, BEEFY, PENDLE, CURVE/CONVEX)
// ============================================================================

test('discovery: EXPANDED_DEFI_SELECTORS match exact keccak256 ABI signatures', () => {
  const expected: Record<keyof typeof EXPANDED_DEFI_SELECTORS, string> = {
    morphoSingleton: 'MORPHO()',
    morphoCurator: 'curator()',
    fluidLiquidity: 'liquidity()',
    beefyWant: 'want()',
    beefyPricePerFullShare: 'getPricePerFullShare()',
    beefyStrategy: 'strategy()',
    beefyStrategyVault: 'vault()',
    beefyBalance: 'balance()',
    pendleSy: 'SY()',
    pendlePt: 'PT()',
    pendleYt: 'YT()',
    pendleExpiry: 'expiry()',
    pendleYieldToken: 'yieldToken()',
    pendleAssetInfo: 'assetInfo()',
    curveLpToken: 'lp_token()',
    curveWorkingSupply: 'working_supply()',
    convexStakingToken: 'stakingToken()',
    convexOperator: 'operator()',
    convexPid: 'pid()',
    convexRewardToken: 'rewardToken()',
  };
  for (const [key, sig] of Object.entries(expected)) {
    const hash = '0x' + Buffer.from(keccak_256(new TextEncoder().encode(sig)).slice(0, 4)).toString('hex');
    assert.equal(EXPANDED_DEFI_SELECTORS[key as keyof typeof EXPANDED_DEFI_SELECTORS], hash, `Selector mismatch for ${sig}`);
  }
});

test('discovery: probeExpandedDefiContracts detects Morpho, Fluid, Beefy, Pendle SY/PT/YT, Curve & Convex gauges and rejects spoofs fail-closed', async () => {
  const MORPHO_VAULT = '0xbeef01735c132ada46aa9aa4c54623caa92a64cb';
  const SPOOF_MORPHO = '0x1111111111111111111111111111111111111111';
  const FLUID_FUSDC = '0x9fb7b4477576fe5b32be4c1843afb1e55f251b33';
  const BEEFY_MOO = '0x2222222222222222222222222222222222222222';
  const BEEFY_STRAT = '0x2222222222222222222222222222222222222299';
  const SPOOF_BEEFY = '0x2222222222222222222222222222222222222233';
  const PENDLE_SY = '0x3333333333333333333333333333333333333301';
  const PENDLE_PT = '0x3333333333333333333333333333333333333302';
  const PENDLE_YT = '0x3333333333333333333333333333333333333303';
  const SPOOF_PENDLE_PT = '0x3333333333333333333333333333333333333399';
  const CURVE_GAUGE = '0x4444444444444444444444444444444444444401';
  const CURVE_LP = '0x4444444444444444444444444444444444444402';
  const UNBACKED_CURVE_GAUGE = '0x4444444444444444444444444444444444444499';
  const CONVEX_GAUGE = '0x5555555555555555555555555555555555555501';
  const SPOOF_CONVEX = '0x5555555555555555555555555555555555555599';

  const MORPHO_BLUE = MORPHO_BLUE_SINGLETONS.ethereum!.toLowerCase();
  const FLUID_LIQ = FLUID_LIQUIDITY_SINGLETONS.ethereum!.toLowerCase();
  const CONVEX_BOOSTER = CONVEX_BOOSTER_CONTRACTS.ethereum!.toLowerCase();
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

  const handleCall = (target: string, data: string): { success: boolean; returnData: string } => {
    const t = target.toLowerCase();
    const d = data.toLowerCase();

    // Real MetaMorpho vault (vault idle USDC = 0, Morpho Blue singleton holds USDC)
    if (t === MORPHO_VAULT) {
      if (d === DEFI_SELECTORS.asset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === EXPANDED_DEFI_SELECTORS.morphoSingleton) return { success: true, returnData: '0x' + pad32Hex(MORPHO_BLUE) };
      if (d === DEFI_SELECTORS.erc4626TotalAssets) return { success: true, returnData: '0x' + padUint256(50_000_000_000n) };
      if (d.startsWith(DEFI_SELECTORS.convertToAssets)) return { success: true, returnData: '0x' + padUint256(1_000_000_000n) };
    }
    // Spoofed Morpho claiming attacker singleton
    if (t === SPOOF_MORPHO) {
      if (d === DEFI_SELECTORS.asset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === EXPANDED_DEFI_SELECTORS.morphoSingleton) return { success: true, returnData: '0x' + pad32Hex(ATTACKER) };
    }
    // Real Fluid fUSDC
    if (t === FLUID_FUSDC) {
      if (d === DEFI_SELECTORS.asset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === EXPANDED_DEFI_SELECTORS.fluidLiquidity) return { success: true, returnData: '0x' + pad32Hex(FLUID_LIQ) };
      if (d === DEFI_SELECTORS.erc4626TotalAssets) return { success: true, returnData: '0x' + padUint256(25_000_000_000n) };
      if (d.startsWith(DEFI_SELECTORS.convertToAssets)) return { success: true, returnData: '0x' + padUint256(500_000_000n) };
    }
    // Real Beefy mooToken + strategy pointing back to BEEFY_MOO
    if (t === BEEFY_MOO) {
      if (d === EXPANDED_DEFI_SELECTORS.beefyWant) return { success: true, returnData: '0x' + pad32Hex(WETH) };
      if (d === EXPANDED_DEFI_SELECTORS.beefyPricePerFullShare) return { success: true, returnData: '0x' + padUint256(1_050_000_000_000_000_000n) };
      if (d === EXPANDED_DEFI_SELECTORS.beefyStrategy) return { success: true, returnData: '0x' + pad32Hex(BEEFY_STRAT) };
      if (d === EXPANDED_DEFI_SELECTORS.beefyBalance) return { success: true, returnData: '0x' + padUint256(100n * 10n ** 18n) };
    }
    if (t === BEEFY_STRAT && d === EXPANDED_DEFI_SELECTORS.beefyStrategyVault) {
      return { success: true, returnData: '0x' + pad32Hex(BEEFY_MOO) };
    }
    // Spoofed Beefy pointing to BEEFY_STRAT whose vault() !== SPOOF_BEEFY
    if (t === SPOOF_BEEFY) {
      if (d === EXPANDED_DEFI_SELECTORS.beefyWant) return { success: true, returnData: '0x' + pad32Hex(WETH) };
      if (d === EXPANDED_DEFI_SELECTORS.beefyPricePerFullShare) return { success: true, returnData: '0x' + padUint256(1_000_000_000_000_000_000n) };
      if (d === EXPANDED_DEFI_SELECTORS.beefyStrategy) return { success: true, returnData: '0x' + pad32Hex(BEEFY_STRAT) };
      if (d === EXPANDED_DEFI_SELECTORS.beefyBalance) return { success: true, returnData: '0x' + padUint256(50n * 10n ** 18n) };
    }
    // Pendle SY / PT / YT
    if (t === PENDLE_SY) {
      if (d === EXPANDED_DEFI_SELECTORS.pendleYieldToken) return { success: true, returnData: '0x' + pad32Hex(WETH) };
      if (d === DEFI_SELECTORS.totalSupply) return { success: true, returnData: '0x' + padUint256(1_000n * 10n ** 18n) };
    }
    if (t === PENDLE_PT) {
      if (d === EXPANDED_DEFI_SELECTORS.pendleSy) return { success: true, returnData: '0x' + pad32Hex(PENDLE_SY) };
      if (d === EXPANDED_DEFI_SELECTORS.pendleYt) return { success: true, returnData: '0x' + pad32Hex(PENDLE_YT) };
      if (d === EXPANDED_DEFI_SELECTORS.pendleExpiry) return { success: true, returnData: '0x' + padUint256(1_798_761_600n) };
    }
    if (t === PENDLE_YT) {
      if (d === EXPANDED_DEFI_SELECTORS.pendleSy) return { success: true, returnData: '0x' + pad32Hex(PENDLE_SY) };
      if (d === EXPANDED_DEFI_SELECTORS.pendlePt) return { success: true, returnData: '0x' + pad32Hex(PENDLE_PT) };
      if (d === EXPANDED_DEFI_SELECTORS.pendleExpiry) return { success: true, returnData: '0x' + padUint256(1_798_761_600n) };
    }
    if (t === SPOOF_PENDLE_PT) {
      if (d === EXPANDED_DEFI_SELECTORS.pendleSy) return { success: true, returnData: '0x' + pad32Hex(PENDLE_SY) };
      if (d === EXPANDED_DEFI_SELECTORS.pendleYt) return { success: true, returnData: '0x' + pad32Hex(PENDLE_YT) };
      if (d === EXPANDED_DEFI_SELECTORS.pendleExpiry) return { success: true, returnData: '0x' + padUint256(1_798_761_600n) };
    }
    // Curve gauge + unbacked gauge
    if (t === CURVE_GAUGE || t === UNBACKED_CURVE_GAUGE) {
      if (d === EXPANDED_DEFI_SELECTORS.curveLpToken) return { success: true, returnData: '0x' + pad32Hex(CURVE_LP) };
      if (d === EXPANDED_DEFI_SELECTORS.curveWorkingSupply) return { success: true, returnData: '0x' + padUint256(500n * 10n ** 18n) };
    }
    // Convex gauge + spoofed Convex
    if (t === CONVEX_GAUGE) {
      if (d === EXPANDED_DEFI_SELECTORS.convexStakingToken) return { success: true, returnData: '0x' + pad32Hex(CURVE_LP) };
      if (d === EXPANDED_DEFI_SELECTORS.convexOperator) return { success: true, returnData: '0x' + pad32Hex(CONVEX_BOOSTER) };
      if (d === EXPANDED_DEFI_SELECTORS.convexPid) return { success: true, returnData: '0x' + padUint256(42n) };
      if (d === DEFI_SELECTORS.totalSupply) return { success: true, returnData: '0x' + padUint256(900n * 10n ** 18n) };
    }
    if (t === SPOOF_CONVEX) {
      if (d === EXPANDED_DEFI_SELECTORS.convexStakingToken) return { success: true, returnData: '0x' + pad32Hex(CURVE_LP) };
      if (d === EXPANDED_DEFI_SELECTORS.convexOperator) return { success: true, returnData: '0x' + pad32Hex(ATTACKER) };
    }
    // Underlying balanceOf checks
    if (t === USDC_ETH.toLowerCase() && d.startsWith(DEFI_SELECTORS.balanceOf)) {
      const holder = '0x' + d.slice(34, 74);
      if (holder === MORPHO_BLUE) return { success: true, returnData: '0x' + padUint256(100_000_000_000n) };
      if (holder === FLUID_LIQ) return { success: true, returnData: '0x' + padUint256(80_000_000_000n) };
      return { success: true, returnData: '0x' + padUint256(0n) };
    }
    if (t === WETH && d.startsWith(DEFI_SELECTORS.balanceOf)) {
      const holder = '0x' + d.slice(34, 74);
      if (holder === PENDLE_SY) return { success: true, returnData: '0x' + padUint256(500n * 10n ** 18n) };
    }
    if (t === CURVE_LP && d.startsWith(DEFI_SELECTORS.balanceOf)) {
      const holder = '0x' + d.slice(34, 74);
      if (holder === CURVE_GAUGE) return { success: true, returnData: '0x' + padUint256(300n * 10n ** 18n) };
      if (holder === UNBACKED_CURVE_GAUGE) return { success: true, returnData: '0x' + padUint256(0n) };
    }
    return { success: false, returnData: '0x' };
  };

  await withMockedFetch(
    async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        id?: number;
        params?: Array<{ data?: string }>;
      };
      const subcalls = decodeMulticall3InputCalls(body.params?.[0]?.data ?? '0x');
      const encoded = encodeMulticall3Return(subcalls.map((sc) => handleCall(sc.target, sc.callData)));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result: encoded }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    async () => {
      const found = await probeExpandedDefiContracts({
        chain: 'ethereum',
        tokenAddresses: [
          MORPHO_VAULT,
          SPOOF_MORPHO,
          FLUID_FUSDC,
          BEEFY_MOO,
          SPOOF_BEEFY,
          PENDLE_SY,
          PENDLE_PT,
          PENDLE_YT,
          SPOOF_PENDLE_PT,
          CURVE_GAUGE,
          UNBACKED_CURVE_GAUGE,
          CONVEX_GAUGE,
          SPOOF_CONVEX,
        ],
        rawBalances: new Map([
          [MORPHO_VAULT, 1_000n * 10n ** 18n],
          [FLUID_FUSDC, 500n * 10n ** 6n],
        ]),
      });

      assert.equal(found.get(MORPHO_VAULT)?.kind, 'morpho_vault');
      assert.equal(found.get(MORPHO_VAULT)?.erc4626Compatible, true);
      assert.equal(found.get(MORPHO_VAULT)?.underlyingAddress, USDC_ETH.toLowerCase());

      assert.equal(found.get(FLUID_FUSDC)?.kind, 'fluid_ftoken');
      assert.equal(found.get(FLUID_FUSDC)?.erc4626Compatible, true);

      assert.equal(found.get(BEEFY_MOO)?.kind, 'beefy_mootoken');
      assert.equal(found.get(BEEFY_MOO)?.pricePerFullShare, 1_050_000_000_000_000_000n);

      assert.equal(found.get(PENDLE_SY)?.kind, 'pendle_sy');
      assert.equal(found.get(PENDLE_PT)?.kind, 'pendle_pt');
      assert.equal(found.get(PENDLE_PT)?.expiryTimestamp, 1_798_761_600);
      assert.equal(found.get(PENDLE_YT)?.kind, 'pendle_yt');

      assert.equal(found.get(CURVE_GAUGE)?.kind, 'curve_gauge');
      assert.equal(found.get(CONVEX_GAUGE)?.kind, 'convex_gauge');
      assert.equal(found.get(CONVEX_GAUGE)?.poolId, 42);

      // All spoofs & unbacked tokens MUST fail closed
      assert.equal(found.has(SPOOF_MORPHO), false, 'Spoofed Morpho singleton rejected');
      assert.equal(found.has(SPOOF_BEEFY), false, 'Spoofed Beefy strategy mismatch rejected');
      assert.equal(found.has(SPOOF_PENDLE_PT), false, 'Spoofed Pendle PT cross-ref mismatch rejected');
      assert.equal(found.has(UNBACKED_CURVE_GAUGE), false, 'Unbacked Curve gauge rejected');
      assert.equal(found.has(SPOOF_CONVEX), false, 'Spoofed Convex operator rejected');
    }
  );

  // RPC outage must fail closed cleanly
  await withMockedFetch(
    async () => {
      throw new Error('RPC offline');
    },
    async () => {
      const empty = await probeExpandedDefiContracts({ chain: 'ethereum', tokenAddresses: [MORPHO_VAULT] });
      assert.equal(empty.size, 0);
    }
  );

  // Pure unit checks for metadata hints & fail-closed classifier
  assert.equal(identifyDefiProtocolByMetadata({ symbol: 'steakUSDC', name: 'Steakhouse MetaMorpho' })?.kind, 'morpho_vault');
  assert.equal(identifyDefiProtocolByMetadata({ symbol: 'fUSDC', name: 'Fluid USDC' })?.kind, 'fluid_ftoken');
  assert.equal(identifyDefiProtocolByMetadata({ symbol: 'mooAeroWETH-USDC' })?.kind, 'beefy_mootoken');
  assert.equal(identifyDefiProtocolByMetadata({ symbol: 'PT-sUSDe-29MAY2026' })?.kind, 'pendle_pt');
  assert.equal(identifyDefiProtocolByMetadata({ symbol: 'YT-eETH-26JUN2026' })?.kind, 'pendle_yt');
  assert.equal(identifyDefiProtocolByMetadata({ symbol: 'SY-stETH' })?.kind, 'pendle_sy');
  assert.equal(identifyDefiProtocolByMetadata({ symbol: 'cvxcrvUSD-f' })?.kind, 'convex_gauge');
  assert.equal(identifyDefiProtocolByMetadata({ symbol: '3CRV-gauge' })?.kind, 'curve_gauge');
  assert.equal(
    classifyExpandedDefiProbeResult({
      chain: 'ethereum',
      tokenAddress: MORPHO_VAULT,
      erc4626Asset: USDC_ETH,
      morphoSingleton: MORPHO_BLUE,
      totalAssets: 0n, // zero totalAssets -> fail closed
      convertToAssets: 100n,
      controllerUnderlyingBalance: 1000n,
    }),
    null
  );
});

// ============================================================================
// 4. HTTP ROUTES: /api/export/safe-batch, /api/export/tax-csv, /safe-manifest.json
// ============================================================================

test('HTTP routes: POST /api/export/safe-batch, POST /api/export/tax-csv, and GET /safe-manifest.json enforce validation, CORS, rate limits, and CSV headers', async () => {
  const { server } = createTurgaliumServer({
    enableBackgroundPollers: false,
    rateLimit: { enabled: true, maxRequests: 50, windowMs: 60_000 },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. GET /safe-manifest.json serves valid Safe manifest with cross-origin headers
    const manifestRes = await fetch(`${base}/safe-manifest.json`);
    assert.equal(manifestRes.status, 200);
    assert.equal(manifestRes.headers.get('access-control-allow-origin'), '*');
    assert.equal(manifestRes.headers.get('cross-origin-resource-policy'), 'cross-origin');
    const manifest = (await manifestRes.json()) as { name: string; iconPath: string };
    assert.equal(manifest.name, 'Turgalium');
    assert.equal(manifest.iconPath, 'logos/turgalium.svg');

    // 2. POST /api/export/safe-batch valid export
    const safeRes = await fetch(`${base}/api/export/safe-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({
        chain: 'arbitrum',
        createdFromSafeAddress: SAFE_EVM.toLowerCase(),
        calls: [
          {
            to: EVM_CHAINS.arbitrum.usdcAddress.toLowerCase(),
            value: '0x0',
            data: '0x095ea7b3' + pad32Hex(USER_EVM) + padUint256(500_000n),
          },
        ],
      }),
    });
    assert.equal(safeRes.status, 200);
    assert.ok(safeRes.headers.get('x-ratelimit-limit'), 'Rate limit header must be present');
    assert.equal(safeRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(safeRes.headers.get('access-control-allow-origin'), `http://127.0.0.1:${port}`);
    const safeJson = (await safeRes.json()) as {
      version: string;
      chainId: string;
      meta: { createdFromSafeAddress: string };
      transactions: Array<{ to: string; value: string; contractMethod: null }>;
    };
    assert.equal(safeJson.version, '1.0');
    assert.equal(safeJson.chainId, '42161');
    assert.equal(safeJson.meta.createdFromSafeAddress, SAFE_EVM);
    assert.equal(safeJson.transactions[0].value, '0');
    assert.equal(safeJson.transactions[0].contractMethod, null);

    // 3. POST /api/export/safe-batch rejects invalid input with 400
    const badSafeRes = await fetch(`${base}/api/export/safe-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'ethereum',
        calls: [{ to: '0x0000000000000000000000000000000000000000', value: '0', data: '0x' }],
      }),
    });
    assert.equal(badSafeRes.status, 400);

    // 4. POST /api/export/safe-batch blocks foreign cross-origin with 403
    const evilCorsSafe = await fetch(`${base}/api/export/safe-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ chain: 'ethereum', calls: [{ to: USER_EVM, value: '0', data: '0x' }] }),
    });
    assert.equal(evilCorsSafe.status, 403);

    // 5. POST /api/export/tax-csv returns CSV attachment with headers + formula neutralization
    const taxRes = await fetch(`${base}/api/export/tax-csv`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({
        format: 'koinly',
        generatedAt: '2026-11-26T12:00:00Z',
        events: [
          {
            timestamp: '2026-11-26T11:55:00Z',
            kind: 'burn_loss_harvest',
            sentAmount: 1234,
            sentCurrency: '=EVIL()',
            description: '+cmd|calc',
          },
        ],
      }),
    });
    assert.equal(taxRes.status, 200);
    assert.equal(taxRes.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(
      taxRes.headers.get('content-disposition'),
      'attachment; filename="turgalium-koinly-2026-11-26.csv"'
    );
    assert.ok(taxRes.headers.get('x-ratelimit-limit'));
    assert.equal(taxRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(taxRes.headers.get('x-turgalium-tax-rows'), '1');
    const csvText = await taxRes.text();
    assert.ok(csvText.startsWith('Date,Sent Amount,Sent Currency,'));
    assert.ok(csvText.includes("'=EVIL()"));
    assert.ok(csvText.includes("'+cmd|calc"));

    // 6. POST /api/export/tax-csv JSON mode + 400 validation + 413 oversized payload
    const taxJsonRes = await fetch(`${base}/api/export/tax-csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        format: 'awaken',
        responseMode: 'json',
        events: [{ kind: 'bridge', sentAmount: 100, sentCurrency: 'USDC', receivedAmount: 99.9, receivedCurrency: 'USDC' }],
      }),
    });
    assert.equal(taxJsonRes.status, 200);
    const taxJson = (await taxJsonRes.json()) as { format: string; rowCount: number; csv: string };
    assert.equal(taxJson.format, 'awaken');
    assert.equal(taxJson.rowCount, 1);
    assert.ok(taxJson.csv.includes('bridge'));

    const badTaxRes = await fetch(`${base}/api/export/tax-csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format: 'invalid', events: [{ kind: 'swap' }] }),
    });
    assert.equal(badTaxRes.status, 400);

    const evilCorsTax = await fetch(`${base}/api/export/tax-csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ format: 'koinly', events: [{ kind: 'swap' }] }),
    });
    assert.equal(evilCorsTax.status, 403);

    const hugePayload = JSON.stringify({
      format: 'koinly',
      events: [{ kind: 'swap', description: 'A'.repeat(600_000) }],
    });
    const oversizedRes = await fetch(`${base}/api/export/tax-csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: hugePayload,
    });
    assert.equal(oversizedRes.status, 413);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
