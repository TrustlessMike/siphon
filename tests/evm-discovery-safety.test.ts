import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAIN_LIST,
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  isCuratedRegistryToken,
  TOKEN_REGISTRY,
} from '../src/scanner/chains.js';
import {
  clearPriceCache,
  FALLBACK_PRICES,
  fetchLiveUsdPricesWithStatus,
  LLAMA_PRICE_BATCH_SIZE,
} from '../src/scanner/prices.js';
import {
  discoverRoutescanTokens,
  fetchDexLiquidityBatchWithStatus,
  probeDefiReceiptContracts,
} from '../src/scanner/discovery.js';
import { scanLiveWallet } from '../src/scanner/classifier.js';
import {
  decodeAaveV2ReserveData,
  decodeAaveV3ReserveData,
  DEFI_SELECTORS,
  pad32Hex,
  padUint256,
  probeExpandedDefiContracts,
  resolveDefiExitPlan,
} from '../src/defi/extractors.js';
import { preflightDefiAsset } from '../src/defi/preflight.js';
import {
  prepareChainBatchExecution,
  prepareRealExecution,
} from '../src/execution/tx-builder.js';
import type { ScannedAsset } from '../src/scanner/types.js';

const USER = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_DEST = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const ATTACKER = '0x133700000000000000000000000000000000dEaD';

const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AAVE_V3_ETH = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const AAVE_V2_ETH = '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9';
const A_ETH_USDC = '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c';
const STABLE_DEBT_ETH_USDC = '0x102633152313c81cd80419b6ecf66d14ad68949a';
const VARIABLE_DEBT_ETH_USDC = '0x72E95b8931767C79bA4EeE721354d6E99a61D004';
const A_V2_USDC = '0xBcca60bB61934080951369a648Fb03DF4F96263C';
const V2_VAR_DEBT_USDC = '0x619beb58998ed2278e08620f97007e1116d5d25b';
const STEAK_USDC_BASE = '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183';
const SPOOF_AAVE_TOKEN = '0x5555555555555555555555555555555555555555';
const SPOOF_POOL_TOKEN = '0x6666666666666666666666666666666666666666';
const SPOOF_ERC4626_VAULT = '0x7777777777777777777777777777777777777777';
const REAL_SMALL_ERC4626 = '0x8888888888888888888888888888888888888888';

/**
 * ABI-encodes Multicall3.aggregate3 return value: `(bool success, bytes returnData)[]`.
 */
function encodeMulticall3Return(items: Array<{ success: boolean; returnData: string }>): string {
  const n = items.length;
  const header = padUint256(0x20n) + padUint256(BigInt(n));
  const encodedElements = items.map((item) => {
    const clean = item.returnData.replace(/^0x/i, '').toLowerCase();
    const byteLen = clean.length / 2;
    const padded = clean.padEnd(Math.ceil(clean.length / 64) * 64, '0');
    return (
      padUint256(item.success ? 1n : 0n) +
      padUint256(0x40n) +
      padUint256(BigInt(byteLen)) +
      padded
    );
  });
  const offsets: string[] = [];
  let runningBytes = n * 32;
  for (const el of encodedElements) {
    offsets.push(padUint256(BigInt(runningBytes)));
    runningBytes += el.length / 2;
  }
  return '0x' + header + offsets.join('') + encodedElements.join('');
}

/**
 * Decodes Multicall3.aggregate3 input calldata into `(target, callData)` tuples for mock RPC routing.
 */
function decodeMulticall3InputCalls(calldata: string): Array<{ target: string; callData: string }> {
  const clean = calldata.replace(/^0x/i, '').toLowerCase();
  if (!clean.startsWith('82ad56cb')) return [];
  const body = clean.slice(8);
  const arrOffset = Number(BigInt('0x' + body.slice(0, 64))) * 2;
  const count = Number(BigInt('0x' + body.slice(arrOffset, arrOffset + 64)));
  const tableStart = arrOffset + 64;
  const out: Array<{ target: string; callData: string }> = [];
  for (let i = 0; i < count; i++) {
    const rel = Number(BigInt('0x' + body.slice(tableStart + i * 64, tableStart + (i + 1) * 64))) * 2;
    const itemStart = tableStart + rel;
    const target = '0x' + body.slice(itemStart + 24, itemStart + 64);
    const dataRel = Number(BigInt('0x' + body.slice(itemStart + 128, itemStart + 192))) * 2;
    const dataStart = itemStart + dataRel;
    const byteLen = Number(BigInt('0x' + body.slice(dataStart, dataStart + 64)));
    const callData = '0x' + body.slice(dataStart + 64, dataStart + 64 + byteLen * 2);
    out.push({ target, callData });
  }
  return out;
}

function buildAaveV3ReserveDataHex(params: {
  aToken: string;
  stableDebt: string;
  variableDebt: string;
}): string {
  const words = Array.from({ length: 15 }, () => padUint256(0n));
  words[8] = pad32Hex(params.aToken);
  words[9] = pad32Hex(params.stableDebt);
  words[10] = pad32Hex(params.variableDebt);
  return '0x' + words.join('');
}

function buildAaveV2ReserveDataHex(params: {
  aToken: string;
  stableDebt: string;
  variableDebt: string;
}): string {
  const words = Array.from({ length: 12 }, () => padUint256(0n));
  words[7] = pad32Hex(params.aToken);
  words[8] = pad32Hex(params.stableDebt);
  words[9] = pad32Hex(params.variableDebt);
  return '0x' + words.join('');
}

function makeTestAsset(overrides: Partial<ScannedAsset> = {}): ScannedAsset {
  return {
    id: 'eth:test_asset',
    chain: 'ethereum',
    chainName: 'Ethereum',
    address: A_ETH_USDC,
    symbol: 'aEthUSDC',
    name: 'Aave v3 Ethereum USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: AAVE_V3_ETH,
    underlyingSymbol: 'USDC',
    underlyingAddress: USDC_ETH,
    rawBalance: '1000000000',
    uiBalance: 1000,
    priceUsd: 1,
    grossUsd: 1000,
    liquidityUsd: 50_000_000,
    estimatedGasUsd: 1,
    batchedGasUsd: 0.5,
    estimatedSlippageUsd: 0,
    netUsdcSingle: 999,
    netUsdcBatched: 999.5,
    action: 'WITHDRAW_AND_BRIDGE',
    actionReason: 'Test',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

async function withMockedFetch<T>(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  fn: () => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// =========================================================================
// 1. CRIT-02: Aave v3/v2 Debt Token & Spoofed POOL() Rejection Backtests
// =========================================================================

test('CRIT-02: decodeAaveV3ReserveData / decodeAaveV2ReserveData accurately parse aToken vs debt tokens', () => {
  const v3Hex = buildAaveV3ReserveDataHex({
    aToken: A_ETH_USDC,
    stableDebt: STABLE_DEBT_ETH_USDC,
    variableDebt: VARIABLE_DEBT_ETH_USDC,
  });
  const dec3 = decodeAaveV3ReserveData(v3Hex);
  assert.ok(dec3);
  assert.equal(dec3.aTokenAddress, A_ETH_USDC.toLowerCase());
  assert.equal(dec3.stableDebtTokenAddress, STABLE_DEBT_ETH_USDC.toLowerCase());
  assert.equal(dec3.variableDebtTokenAddress, VARIABLE_DEBT_ETH_USDC.toLowerCase());

  const v2Hex = buildAaveV2ReserveDataHex({
    aToken: A_V2_USDC,
    stableDebt: '0xe4922afab0bbadd8ab2a88e0c79d884ad337fca6',
    variableDebt: V2_VAR_DEBT_USDC,
  });
  const dec2 = decodeAaveV2ReserveData(v2Hex);
  assert.ok(dec2);
  assert.equal(dec2.aTokenAddress, A_V2_USDC.toLowerCase());
  assert.equal(dec2.variableDebtTokenAddress, V2_VAR_DEBT_USDC.toLowerCase());
});

test('CRIT-02: probeDefiReceiptContracts & probeExpandedDefiContracts reject Aave variableDebt/stableDebt, spoofed POOL(), and unbacked ERC-4626 vaults', async () => {
  const aaveV3ReserveUsdc = buildAaveV3ReserveDataHex({
    aToken: A_ETH_USDC,
    stableDebt: STABLE_DEBT_ETH_USDC,
    variableDebt: VARIABLE_DEBT_ETH_USDC,
  });
  const aaveV2ReserveUsdc = buildAaveV2ReserveDataHex({
    aToken: A_V2_USDC,
    stableDebt: '0xe4922afab0bbadd8ab2a88e0c79d884ad337fca6',
    variableDebt: V2_VAR_DEBT_USDC,
  });

  const handleSubcall = (target: string, callData: string): { success: boolean; returnData: string } => {
    const t = target.toLowerCase();
    const d = callData.toLowerCase();

    // Real Aave v3 aEthUSDC
    if (t === A_ETH_USDC.toLowerCase()) {
      if (d === DEFI_SELECTORS.aaveUnderlyingAsset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === DEFI_SELECTORS.aaveV3Pool) return { success: true, returnData: '0x' + pad32Hex(AAVE_V3_ETH) };
    }
    // Real Aave v3 variableDebtEthUSDC (returns REAL underlying + REAL pool!)
    if (t === VARIABLE_DEBT_ETH_USDC.toLowerCase()) {
      if (d === DEFI_SELECTORS.aaveUnderlyingAsset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === DEFI_SELECTORS.aaveV3Pool) return { success: true, returnData: '0x' + pad32Hex(AAVE_V3_ETH) };
      // Even if a malicious debt/hybrid contract implemented asset(), it must NEVER fall through
      if (d === DEFI_SELECTORS.asset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
    }
    // Real Aave v3 stableDebtEthUSDC
    if (t === STABLE_DEBT_ETH_USDC.toLowerCase()) {
      if (d === DEFI_SELECTORS.aaveUnderlyingAsset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === DEFI_SELECTORS.aaveV3Pool) return { success: true, returnData: '0x' + pad32Hex(AAVE_V3_ETH) };
    }
    // Spoofed airdrop pretending to be Aave aToken with attacker POOL() + asset()
    if (t === SPOOF_POOL_TOKEN.toLowerCase()) {
      if (d === DEFI_SELECTORS.aaveUnderlyingAsset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === DEFI_SELECTORS.aaveV3Pool) return { success: true, returnData: '0x' + pad32Hex(ATTACKER) };
      if (d === DEFI_SELECTORS.asset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
    }
    // Spoofed airdrop claiming REAL Aave v3 POOL() + USDC underlying, but not listed in getReserveData
    if (t === SPOOF_AAVE_TOKEN.toLowerCase()) {
      if (d === DEFI_SELECTORS.aaveUnderlyingAsset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === DEFI_SELECTORS.aaveV3Pool) return { success: true, returnData: '0x' + pad32Hex(AAVE_V3_ETH) };
    }
    // Real Aave v2 aUSDC vs variableDebtUSDC
    if (t === A_V2_USDC.toLowerCase()) {
      if (d === DEFI_SELECTORS.aaveUnderlyingAsset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === DEFI_SELECTORS.aaveV2LendingPool) return { success: true, returnData: '0x' + pad32Hex(AAVE_V2_ETH) };
    }
    if (t === V2_VAR_DEBT_USDC.toLowerCase()) {
      if (d === DEFI_SELECTORS.aaveUnderlyingAsset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === DEFI_SELECTORS.aaveV2LendingPool) return { success: true, returnData: '0x' + pad32Hex(AAVE_V2_ETH) };
    }
    // Real Aave v3 Pool.getReserveData(USDC)
    if (t === AAVE_V3_ETH.toLowerCase() && d.startsWith(DEFI_SELECTORS.aaveGetReserveData)) {
      return { success: true, returnData: aaveV3ReserveUsdc };
    }
    // Real Aave v2 LendingPool.getReserveData(USDC)
    if (t === AAVE_V2_ETH.toLowerCase() && d.startsWith(DEFI_SELECTORS.aaveGetReserveData)) {
      return { success: true, returnData: aaveV2ReserveUsdc };
    }
    // Spoofed ERC-4626 vault: lies about asset()=USDC, totalAssets()=1M USDC, convertToAssets()=50k USDC,
    // but holds 0 real USDC!
    if (t === SPOOF_ERC4626_VAULT.toLowerCase()) {
      if (d === DEFI_SELECTORS.asset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === DEFI_SELECTORS.erc4626TotalAssets) return { success: true, returnData: '0x' + padUint256(1_000_000_000_000n) };
      if (d.startsWith(DEFI_SELECTORS.convertToAssets)) return { success: true, returnData: '0x' + padUint256(50_000_000_000n) };
    }
    // Legit small ERC-4626 vault that genuinely holds 5,000 USDC backing 1,000 USDC user shares
    if (t === REAL_SMALL_ERC4626.toLowerCase()) {
      if (d === DEFI_SELECTORS.asset) return { success: true, returnData: '0x' + pad32Hex(USDC_ETH) };
      if (d === DEFI_SELECTORS.erc4626TotalAssets) return { success: true, returnData: '0x' + padUint256(5_000_000_000n) };
      if (d.startsWith(DEFI_SELECTORS.convertToAssets)) return { success: true, returnData: '0x' + padUint256(1_000_000_000n) };
    }
    // Real USDC.balanceOf(vault)
    if (t === USDC_ETH.toLowerCase() && d.startsWith(DEFI_SELECTORS.balanceOf)) {
      const queried = '0x' + d.slice(34, 74);
      if (queried === SPOOF_ERC4626_VAULT.toLowerCase()) {
        return { success: true, returnData: '0x' + padUint256(0n) }; // 0 USDC held!
      }
      if (queried === REAL_SMALL_ERC4626.toLowerCase()) {
        return { success: true, returnData: '0x' + padUint256(5_000_000_000n) }; // 5,000 USDC held
      }
    }

    return { success: false, returnData: '0x' };
  };

  let getReserveDataCalls = 0;

  await withMockedFetch(
    async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        id?: number;
        method?: string;
        params?: Array<{ to?: string; data?: string }>;
      };
      const callData = body.params?.[0]?.data ?? '0x';
      const subcalls = decodeMulticall3InputCalls(callData);
      for (const sc of subcalls) {
        if (sc.callData.toLowerCase().startsWith(DEFI_SELECTORS.aaveGetReserveData)) {
          getReserveDataCalls += 1;
        }
      }
      const encoded = encodeMulticall3Return(subcalls.map((sc) => handleSubcall(sc.target, sc.callData)));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result: encoded }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    async () => {
      const rawBalances = new Map<string, bigint>([
        [SPOOF_ERC4626_VAULT.toLowerCase(), 50_000n * 10n ** 18n],
        [REAL_SMALL_ERC4626.toLowerCase(), 1_000n * 10n ** 18n],
      ]);

      // 1. Test probeDefiReceiptContracts()
      const receipts = await probeDefiReceiptContracts(
        'ethereum',
        [
          A_ETH_USDC,
          VARIABLE_DEBT_ETH_USDC,
          STABLE_DEBT_ETH_USDC,
          SPOOF_POOL_TOKEN,
          SPOOF_AAVE_TOKEN,
          SPOOF_ERC4626_VAULT,
          REAL_SMALL_ERC4626,
        ],
        rawBalances
      );
      assert.ok(getReserveDataCalls >= 1, 'Must call POOL.getReserveData(underlying) (0x35ea6a75)');
      assert.equal(receipts.get(A_ETH_USDC.toLowerCase())?.kind, 'aave_v3');
      assert.equal(receipts.has(VARIABLE_DEBT_ETH_USDC.toLowerCase()), false, 'variableDebtEthUSDC MUST be rejected');
      assert.equal(receipts.has(STABLE_DEBT_ETH_USDC.toLowerCase()), false, 'stableDebtEthUSDC MUST be rejected');
      assert.equal(receipts.has(SPOOF_POOL_TOKEN.toLowerCase()), false, 'Spoofed POOL() token MUST be rejected');
      assert.equal(receipts.has(SPOOF_AAVE_TOKEN.toLowerCase()), false, 'Spoofed Aave airdrop MUST be rejected');
      assert.equal(receipts.has(SPOOF_ERC4626_VAULT.toLowerCase()), false, 'Unbacked spoofed ERC-4626 MUST be rejected');
      assert.equal(receipts.get(REAL_SMALL_ERC4626.toLowerCase())?.kind, 'erc4626');

      // 2. Test probeExpandedDefiContracts()
      const expanded = await probeExpandedDefiContracts({
        chain: 'ethereum',
        tokenAddresses: [
          A_ETH_USDC,
          VARIABLE_DEBT_ETH_USDC,
          STABLE_DEBT_ETH_USDC,
          SPOOF_POOL_TOKEN,
          SPOOF_AAVE_TOKEN,
          A_V2_USDC,
          V2_VAR_DEBT_USDC,
          SPOOF_ERC4626_VAULT,
          REAL_SMALL_ERC4626,
        ],
        rawBalances,
      });
      assert.equal(expanded.get(A_ETH_USDC.toLowerCase())?.protocolId, 'aave_v3');
      assert.equal(expanded.get(A_V2_USDC.toLowerCase())?.protocolId, 'aave_v2');
      assert.equal(expanded.has(VARIABLE_DEBT_ETH_USDC.toLowerCase()), false, 'Expanded probe MUST reject variableDebtEthUSDC');
      assert.equal(expanded.has(STABLE_DEBT_ETH_USDC.toLowerCase()), false, 'Expanded probe MUST reject stableDebtEthUSDC');
      assert.equal(expanded.has(V2_VAR_DEBT_USDC.toLowerCase()), false, 'Expanded probe MUST reject Aave v2 variableDebtUSDC');
      assert.equal(expanded.has(SPOOF_POOL_TOKEN.toLowerCase()), false, 'Expanded probe MUST reject spoofed POOL()');
      assert.equal(expanded.has(SPOOF_AAVE_TOKEN.toLowerCase()), false, 'Expanded probe MUST reject unlisted Aave spoof');
      assert.equal(expanded.has(SPOOF_ERC4626_VAULT.toLowerCase()), false, 'Expanded probe MUST reject unbacked ERC-4626 spoof');
      assert.equal(expanded.get(REAL_SMALL_ERC4626.toLowerCase())?.protocolId, 'erc4626');
    }
  );
});

test('CRIT-02: ERC-4626 / spoofed receipt tokens cannot inject arbitrary calldata or size bundled CCTP transfers from unverified balances', async () => {
  // 1. Spoofed sDAI liquid receipt trying to redirect protocolAddress to ATTACKER
  const spoofedSdai = makeTestAsset({
    id: 'eth:spoof_sdai',
    address: SPOOF_ERC4626_VAULT,
    symbol: 'sDAI',
    protocol: 'Spark ERC-4626',
    protocolAddress: ATTACKER,
    underlyingSymbol: 'DAI',
    underlyingAddress: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    decimals: 18,
    rawBalance: (1000n * 10n ** 18n).toString(),
  });
  const spoofPlan = resolveDefiExitPlan({ asset: spoofedSdai });
  assert.equal(spoofPlan.preflightStatus, 'blocked', 'Spoofed liquid receipt with attacker protocolAddress must block');

  const spoofPre = await preflightDefiAsset({ asset: spoofedSdai, walletAddress: USER, skipRpc: true });
  assert.equal(spoofPre.canExecute1Click, false);

  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: spoofedSdai,
        userAddress: USER,
        solanaDestination: SOL_DEST,
      }),
    /Blocked (spoofed|untrusted)/i
  );

  // 2. Uncurated ERC-4626 vault claiming USDC underlying MUST NOT size bundled CCTP transfer!
  const uncuratedUsdcVault = makeTestAsset({
    id: 'base:uncurated_vault',
    chain: 'base',
    chainName: 'Base',
    address: SPOOF_ERC4626_VAULT,
    symbol: 'fakeUSDCVault',
    protocol: 'ERC-4626 Vault',
    protocolAddress: SPOOF_ERC4626_VAULT,
    underlyingSymbol: 'USDC',
    underlyingAddress: USDC_BASE,
    decimals: 18,
    rawBalance: (50_000n * 10n ** 18n).toString(),
    uiBalance: 50_000,
    priceUsd: 1,
    grossUsd: 50_000,
    defiExitPlan: {
      protocolId: 'erc4626',
      protocolName: 'ERC-4626 Vault',
      routeKind: 'protocol_unwind',
      exitStrategy: 'instant_1click_unwind',
      preflightStatus: 'verified',
      preflightReason: 'Synthetic uncurated plan without live simulation',
      plainEnglishSteps: ['Redeem shares'],
      expectedUnderlyingRaw: '50000000000', // attacker claims 50,000 USDC
      expectedUnderlyingUi: 50_000,
      underlyingSymbol: 'USDC',
      underlyingAddress: USDC_BASE,
      underlyingDecimals: 6,
      shareExchangeRate: 1,
    },
  });

  const uncuratedBatch = await prepareChainBatchExecution({
    chain: 'base',
    assets: [uncuratedUsdcVault],
    userAddress: USER,
    solanaDestination: SOL_DEST,
    bridgePreference: 'cctp',
    bundleDefiCctp: true,
    feeRecipientEvm: '0x2222222222222222222222222222222222222222',
  });
  assert.ok(
    !uncuratedBatch.calls.some((c) => c.stepId.includes('cctp') || c.stepId.includes('protocol_fee_transfer_after_defi')),
    'Uncurated ERC-4626 vault MUST NOT emit bundled CCTP depositForBurn or USDC fee transfer'
  );
  assert.equal(uncuratedBatch.chainedFollowUpPlans?.[0]?.bundledInCurrentBatch, false);

  // 3. Even a curated vault WITHOUT verified expectedUnderlyingRaw MUST NOT size CCTP from 18-dec raw shares!
  const unverifiedSteak = makeTestAsset({
    id: 'base:unverified_steak',
    chain: 'base',
    chainName: 'Base',
    address: STEAK_USDC_BASE,
    symbol: 'steakUSDC',
    protocol: 'Morpho ERC-4626',
    protocolAddress: STEAK_USDC_BASE,
    underlyingSymbol: 'USDC',
    underlyingAddress: USDC_BASE,
    decimals: 18,
    rawBalance: (1000n * 10n ** 18n).toString(),
    uiBalance: 1000,
    priceUsd: 1,
    grossUsd: 1000,
  });
  const unverifiedBatch = await prepareChainBatchExecution({
    chain: 'base',
    assets: [unverifiedSteak],
    userAddress: USER,
    solanaDestination: SOL_DEST,
    bridgePreference: 'cctp',
    bundleDefiCctp: true,
  });
  assert.ok(
    !unverifiedBatch.calls.some((c) => c.stepId.includes('cctp')),
    'Curated ERC-4626 without verified previewRedeem/expectedUnderlyingRaw MUST NOT size CCTP from raw 18-dec shares'
  );

  // 4. Defense-in-depth: Aave variableDebt symbol passed directly to prepareRealExecution must throw
  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: makeTestAsset({
          address: VARIABLE_DEBT_ETH_USDC,
          symbol: 'variableDebtEthUSDC',
          protocol: 'Aave v3',
          protocolAddress: AAVE_V3_ETH,
        }),
        userAddress: USER,
        solanaDestination: SOL_DEST,
      }),
    /debt token/i
  );
});

// =========================================================================
// 2. CRIT-08: Fallback Price Coverage, Llama Chunking <= 25 & Burn Safety
// =========================================================================

test('CRIT-08: 100% of TOKEN_REGISTRY and CHAIN_LIST native keys have positive FALLBACK_PRICES coverage', () => {
  const lowerFallbacks = new Map(
    Object.entries(FALLBACK_PRICES).map(([k, v]) => [k.toLowerCase(), v])
  );

  for (const chain of CHAIN_LIST) {
    const price = FALLBACK_PRICES[chain.nativeLlamaId] ?? lowerFallbacks.get(chain.nativeLlamaId.toLowerCase());
    assert.ok(
      typeof price === 'number' && price > 0,
      `Missing native FALLBACK_PRICES entry for chain ${chain.id} (${chain.nativeLlamaId})`
    );
  }

  for (const tok of TOKEN_REGISTRY) {
    assert.ok(tok.llamaKey, `TOKEN_REGISTRY entry ${tok.chain}:${tok.symbol} missing llamaKey`);
    const price = FALLBACK_PRICES[tok.llamaKey!] ?? lowerFallbacks.get(tok.llamaKey!.toLowerCase());
    assert.ok(
      typeof price === 'number' && price > 0,
      `Missing FALLBACK_PRICES entry for TOKEN_REGISTRY ${tok.chain} ${tok.symbol} (${tok.llamaKey})`
    );
  }

  // Explicitly verify all 15 previously missing blue-chip entries
  const required15 = [
    'ethereum:0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD', // sUSDS
    'ethereum:0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', // sUSDe
    'optimism:0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', // Optimism USDT
    'optimism:0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb', // Optimism wstETH
    'polygon:0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // Polygon USDT
    'polygon:0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6', // Polygon WBTC
    'avax:0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', // Avalanche USDT
    'bsc:0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', // BNB USDC
    'bsc:0x55d398326f99059fF775485246999027B3197955', // BNB USDT
    'bsc:0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', // BNB CAKE
    'linea:0x176211869cA2b568f2A7D4EE941E073a821EE1ff', // Linea USDC
    'scroll:0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4', // Scroll USDC
    'mantle:0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9', // Mantle USDC
    'blast:0x4300000000000000000000000000000000000003', // Blast USDB
    'coingecko:worldcoin-wld', // World Chain WLD
  ];
  for (const key of required15) {
    assert.ok(FALLBACK_PRICES[key] > 0, `Expected positive fallback price for ${key}`);
  }
});

test('CRIT-08: coins.llama.fi requests chunk at <= 25 keys and track errors on 429/timeout without losing fallback prices', async () => {
  clearPriceCache();
  assert.ok(LLAMA_PRICE_BATCH_SIZE <= 25);

  const manyKeys = Array.from({ length: 62 }, (_, i) => `ethereum:0x${(i + 1).toString(16).padStart(40, '0')}`);
  const chunkSizes: number[] = [];

  await withMockedFetch(
    async (url) => {
      assert.ok(url.startsWith('https://coins.llama.fi/prices/current/'));
      const encodedPart = url.slice('https://coins.llama.fi/prices/current/'.length);
      const decodedKeys = decodeURIComponent(encodedPart).split(',');
      chunkSizes.push(decodedKeys.length);
      assert.ok(decodedKeys.length <= 25, `Chunk size ${decodedKeys.length} exceeded 25 keys!`);
      const coins: Record<string, { price: number }> = {};
      for (const k of decodedKeys) coins[k] = { price: 1.23 };
      return new Response(JSON.stringify({ coins }), { status: 200 });
    },
    async () => {
      const res = await fetchLiveUsdPricesWithStatus(manyKeys);
      assert.equal(res.hadError, false);
      assert.equal(res.prices.size, 62);
      assert.deepEqual(chunkSizes.sort((a, b) => b - a), [25, 25, 12]);
    }
  );

  // Now simulate DeFiLlama 429 rate-limit outage on TOKEN_REGISTRY keys
  clearPriceCache();
  const registryKeys = Array.from(new Set(TOKEN_REGISTRY.map((t) => t.llamaKey!).filter(Boolean)));
  await withMockedFetch(
    async () => new Response('Too Many Requests', { status: 429 }),
    async () => {
      const res = await fetchLiveUsdPricesWithStatus(registryKeys);
      assert.equal(res.hadError, true);
      assert.equal(res.failedKeys.size, registryKeys.length);
      for (const k of registryKeys) {
        const p = res.prices.get(k);
        assert.ok(typeof p === 'number' && p > 0, `429 outage dropped fallback price for ${k}`);
      }
    }
  );
});

test('CRIT-08: DeFiLlama 429/timeout and DexScreener timeout NEVER classify TOKEN_REGISTRY blue-chips or unpriced ERC-20s as BURN_ZERO_LIQUIDITY', async () => {
  clearPriceCache();

  const discoveredUnpricedAddr = '0x9999999999999999999999999999999999999999';
  const opUsdt = '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58';
  const polyWbtc = '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6';
  const bnbCake = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
  const blastUsdb = '0x4300000000000000000000000000000000000003';
  const worldWld = '0x2cFc85d8E48F8EAB294be644d9E25C3030863003';

  const balanceByToken = new Map<string, bigint>([
    [opUsdt.toLowerCase(), 250_000_000n], // 250 USDT (6 dec)
    [polyWbtc.toLowerCase(), 10_000_000n], // 0.1 WBTC (8 dec)
    [bnbCake.toLowerCase(), 100n * 10n ** 18n], // 100 CAKE
    [blastUsdb.toLowerCase(), 500n * 10n ** 18n], // 500 USDB
    [worldWld.toLowerCase(), 200n * 10n ** 18n], // 200 WLD
  ]);

  const dexStatus = await withMockedFetch(
    async () => {
      throw new Error('AbortError: DexScreener timeout');
    },
    () => fetchDexLiquidityBatchWithStatus('optimism', [discoveredUnpricedAddr])
  );
  assert.equal(dexStatus.ok, false);
  assert.equal(dexStatus.liquidity.size, 0);

  // Full live scan under simultaneous DeFiLlama 429 + DexScreener timeout outage
  await withMockedFetch(
    async (url, init) => {
      // DeFiLlama returns 429
      if (url.includes('coins.llama.fi')) {
        return new Response('Rate limited', { status: 429 });
      }
      // DexScreener times out / 503
      if (url.includes('api.dexscreener.com')) {
        throw new Error('AbortError: DexScreener timed out');
      }
      // Rabby protocol indexer empty
      if (url.includes('api.rabby.io')) {
        return new Response('[]', { status: 200 });
      }
      // Blockscout on Optimism returns a discovered arbitrary ERC-20
      if (url.includes('optimism.blockscout.com')) {
        return new Response(
          JSON.stringify([
            {
              value: (1000n * 10n ** 18n).toString(),
              token: {
                address_hash: discoveredUnpricedAddr,
                symbol: 'MYSTERY',
                name: 'Mystery Token',
                decimals: '18',
                type: 'ERC-20',
                exchange_rate: null,
              },
            },
          ]),
          { status: 200 }
        );
      }
      // Other explorers return empty
      if (url.includes('blockscout.com') || url.includes('ethplorer.io') || url.includes('routescan.io') || url.includes('explorer.alchemy.com')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      // EVM JSON-RPC calls (batch or single)
      const parsed = JSON.parse(String(init?.body ?? '{}'));
      const respondOne = (req: { id: number; method: string; params?: unknown[] }) => {
        if (req.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: req.id, result: '0x100000' };
        if (req.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: req.id, result: '0x3b9aca00' };
        if (req.method === 'eth_getBalance') return { jsonrpc: '2.0', id: req.id, result: '0x0' };
        if (req.method === 'eth_call') {
          const callObj = (req.params?.[0] ?? {}) as { to?: string; data?: string };
          const data = String(callObj.data ?? '0x').toLowerCase();
          if (data.startsWith('0x82ad56cb')) {
            const subcalls = decodeMulticall3InputCalls(data);
            const resItems = subcalls.map((sc) => {
              if (sc.callData.toLowerCase().startsWith(DEFI_SELECTORS.balanceOf)) {
                const bal = balanceByToken.get(sc.target.toLowerCase()) ?? 0n;
                return { success: true, returnData: '0x' + padUint256(bal) };
              }
              return { success: false, returnData: '0x' };
            });
            return { jsonrpc: '2.0', id: req.id, result: encodeMulticall3Return(resItems) };
          }
          return { jsonrpc: '2.0', id: req.id, result: '0x' + padUint256(0n) };
        }
        return { jsonrpc: '2.0', id: req.id, result: '0x0' };
      };

      const payload = Array.isArray(parsed) ? parsed.map(respondOne) : respondOne(parsed);
      return new Response(JSON.stringify(payload), { status: 200 });
    },
    async () => {
      const report = await scanLiveWallet(USER, 'Outage Stress Test');

      // ZERO tokens may be classified as BURN_ZERO_LIQUIDITY during an API outage!
      const burns = report.assets.filter((a) => a.action === 'BURN_ZERO_LIQUIDITY');
      assert.equal(burns.length, 0, `Expected 0 BURN_ZERO_LIQUIDITY during outage, got: ${burns.map((b) => `${b.chain}:${b.symbol}`).join(', ')}`);

      // ZERO tokens may have burn calldata targeting 0x...dEaD
      const deadHex = DEAD_BURN_ADDRESS.slice(2).toLowerCase();
      for (const a of report.assets) {
        assert.ok(
          !(a.calldataPreview ?? '').toLowerCase().includes(deadHex),
          `Asset ${a.chain}:${a.symbol} unexpectedly generated burn calldata during outage`
        );
      }

      // All 5 blue-chip registry tokens MUST be priced positively from FALLBACK_PRICES (NOT burned!)
      for (const sym of ['USDT', 'WBTC', 'CAKE', 'USDB', 'WLD']) {
        const found = report.assets.find((a) => a.symbol === sym);
        assert.ok(found, `Expected registry token ${sym} in scan report`);
        assert.ok(found.priceUsd > 0, `Expected fallback price > 0 for ${sym}`);
        assert.notEqual(found.action, 'BURN_ZERO_LIQUIDITY');
      }

      // Discovered unpriced token during DexScreener timeout MUST fail closed to SKIP_UNPRICED!
      const mystery = report.assets.find((a) => a.address.toLowerCase() === discoveredUnpricedAddr.toLowerCase());
      assert.ok(mystery, 'Discovered token should still appear transparently in scan report');
      assert.equal(mystery.action, 'SKIP_UNPRICED');
      assert.equal(mystery.selectedByDefault, false);

      // Execution guards: SKIP_UNPRICED rejected in prepareRealExecution & skipped in prepareChainBatchExecution
      await assert.rejects(
        () =>
          prepareRealExecution({
            asset: mystery,
            userAddress: USER,
            solanaDestination: SOL_DEST,
          }),
        /safely skipped|price|outage/i
      );

      const batch = await prepareChainBatchExecution({
        chain: 'optimism',
        assets: [mystery],
        userAddress: USER,
        solanaDestination: SOL_DEST,
      });
      assert.equal(batch.calls.length, 0);
      assert.equal(batch.skippedAssets.length, 1);
      assert.equal(batch.skippedAssets[0].assetId, mystery.id);
    }
  );

  // Defense-in-depth: prepareRealExecution hard-forbids burning any curated TOKEN_REGISTRY token even if forced!
  assert.equal(isCuratedRegistryToken('optimism', opUsdt), true);
  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: makeTestAsset({
          chain: 'optimism',
          chainName: 'Optimism',
          address: opUsdt,
          symbol: 'USDT',
          kind: 'erc20',
          action: 'BURN_ZERO_LIQUIDITY',
          rawBalance: '1000000',
        }),
        userAddress: USER,
        solanaDestination: SOL_DEST,
      }),
    /Blocked burn on curated blue-chip registry token/i
  );
});

test('CRIT-08: Genuine DexScreener HTTP 200 with 0 pairs still surfaces non-registry zero-liquidity token as opt-in BURN_ZERO_LIQUIDITY', async () => {
  clearPriceCache();
  const spamAddr = '0xDead000000000000000000000000000000005555';

  await withMockedFetch(
    async (url, init) => {
      if (url.includes('coins.llama.fi')) {
        return new Response(JSON.stringify({ coins: { 'coingecko:ethereum': { price: 2500 }, 'coingecko:solana': { price: 150 } } }), { status: 200 });
      }
      if (url.includes('api.dexscreener.com')) {
        // Genuine HTTP 200 with 0 pairs!
        return new Response('[]', { status: 200 });
      }
      if (url.includes('api.rabby.io')) {
        return new Response('[]', { status: 200 });
      }
      if (url.includes('base.blockscout.com')) {
        return new Response(
          JSON.stringify([
            {
              value: (5000n * 10n ** 18n).toString(),
              token: {
                address_hash: spamAddr,
                symbol: 'RUGCOIN',
                name: 'Rugged Coin',
                decimals: '18',
                type: 'ERC-20',
                exchange_rate: null,
              },
            },
          ]),
          { status: 200 }
        );
      }
      if (url.includes('blockscout.com') || url.includes('ethplorer.io') || url.includes('routescan.io') || url.includes('explorer.alchemy.com')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      const parsed = JSON.parse(String(init?.body ?? '{}'));
      const respondOne = (req: { id: number; method: string; params?: unknown[] }) => {
        if (req.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: req.id, result: '0x100000' };
        if (req.method === 'eth_gasPrice') return { jsonrpc: '2.0', id: req.id, result: '0x3b9aca00' };
        if (req.method === 'eth_getBalance') return { jsonrpc: '2.0', id: req.id, result: '0x0' };
        if (req.method === 'eth_call') {
          const callObj = (req.params?.[0] ?? {}) as { to?: string; data?: string };
          const data = String(callObj.data ?? '0x').toLowerCase();
          if (data.startsWith('0x82ad56cb')) {
            const subcalls = decodeMulticall3InputCalls(data);
            return {
              jsonrpc: '2.0',
              id: req.id,
              result: encodeMulticall3Return(subcalls.map(() => ({ success: false, returnData: '0x' }))),
            };
          }
          // transfer(0x...dEaD, amount) simulation returns true (0x...01)
          if (data.startsWith('0xa9059cbb')) {
            return { jsonrpc: '2.0', id: req.id, result: '0x' + padUint256(1n) };
          }
          return { jsonrpc: '2.0', id: req.id, result: '0x' + padUint256(0n) };
        }
        return { jsonrpc: '2.0', id: req.id, result: '0x0' };
      };
      const payload = Array.isArray(parsed) ? parsed.map(respondOne) : respondOne(parsed);
      return new Response(JSON.stringify(payload), { status: 200 });
    },
    async () => {
      const report = await scanLiveWallet(USER, 'Genuine Zero Liq');
      const rug = report.assets.find((a) => a.address.toLowerCase() === spamAddr.toLowerCase());
      assert.ok(rug, 'Expected genuinely zero-liquidity non-registry spam token');
      assert.equal(rug.action, 'BURN_ZERO_LIQUIDITY');
      assert.equal(rug.selectedByDefault, false);
    }
  );
});

// =========================================================================
// 3. HIGH-01: Routescan v2 URL & Parser Verification
// =========================================================================

test('HIGH-01: discoverRoutescanTokens hits api.routescan.io/v2/network/mainnet/evm/... and parses both nested and flat holdings', async () => {
  const seenUrls: string[] = [];

  await withMockedFetch(
    async (url) => {
      seenUrls.push(url);
      return new Response(
        JSON.stringify({
          items: [
            // Nested Routescan v2 shape (holderBalance + token.*)
            {
              tokenAddress: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
              holderBalance: '125000000',
              token: {
                symbol: 'USDC',
                name: 'USD Coin',
                decimals: 6,
                price: '1.0001',
              },
            },
            // Flat Routescan v2 shape (tokenQuantity + tokenSymbol/tokenName/tokenDecimals/tokenPrice)
            {
              tokenAddress: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
              tokenQuantity: '2002129',
              tokenSymbol: 'USDt',
              tokenName: 'TetherToken',
              tokenDecimals: 6,
              tokenPrice: '0.999071',
            },
            // Zero balance entry must be skipped
            {
              tokenAddress: '0x1111111111111111111111111111111111111111',
              holderBalance: '0',
              token: { symbol: 'ZERO', decimals: 18 },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
    async () => {
      for (const chain of ['avalanche', 'base', 'optimism', 'arbitrum'] as const) {
        const items = await discoverRoutescanTokens(chain, VITALIK, 12);
        const expectedUrl = `https://api.routescan.io/v2/network/mainnet/evm/${EVM_CHAINS[chain].chainId}/address/${encodeURIComponent(VITALIK)}/erc20-holdings?limit=12`;
        assert.ok(seenUrls.includes(expectedUrl), `Expected Routescan v2 URL ${expectedUrl}`);
        assert.equal(items.length, 2);
        assert.equal(items[0].symbol, 'USDC');
        assert.equal(items[0].rawBalance, 125_000_000n);
        assert.equal(items[0].decimals, 6);
        assert.ok(items[0].ethplorerPriceUsd > 0.99);
        assert.equal(items[1].symbol, 'USDt');
        assert.equal(items[1].rawBalance, 2_002_129n);
      }
      assert.ok(seenUrls.every((u) => !u.includes('cdn.routescan.io')), 'Must NEVER hit broken cdn.routescan.io');
    }
  );
});

// =========================================================================
// 4. Live Mainnet Read-Only Verification (graceful when offline)
// =========================================================================

test('Live Mainnet Backtest — real variableDebtEthUSDC rejected, real aEthUSDC accepted, and live Routescan v2 Avalanche holdings parsed', async () => {
  const [liveReceipts, liveExpanded, liveAvaxHoldings] = await Promise.all([
    probeDefiReceiptContracts('ethereum', [A_ETH_USDC, VARIABLE_DEBT_ETH_USDC, STABLE_DEBT_ETH_USDC]),
    probeExpandedDefiContracts({
      chain: 'ethereum',
      tokenAddresses: [A_ETH_USDC, VARIABLE_DEBT_ETH_USDC, STABLE_DEBT_ETH_USDC],
    }),
    discoverRoutescanTokens('avalanche', VITALIK, 5),
  ]);

  // If Ethereum RPC responded, real aEthUSDC is verified AND real debt tokens are strictly rejected!
  if (liveReceipts.size > 0) {
    assert.equal(liveReceipts.get(A_ETH_USDC.toLowerCase())?.kind, 'aave_v3');
    assert.equal(liveReceipts.has(VARIABLE_DEBT_ETH_USDC.toLowerCase()), false);
    assert.equal(liveReceipts.has(STABLE_DEBT_ETH_USDC.toLowerCase()), false);
  }
  if (liveExpanded.size > 0) {
    assert.equal(liveExpanded.get(A_ETH_USDC.toLowerCase())?.protocolId, 'aave_v3');
    assert.equal(liveExpanded.has(VARIABLE_DEBT_ETH_USDC.toLowerCase()), false);
    assert.equal(liveExpanded.has(STABLE_DEBT_ETH_USDC.toLowerCase()), false);
  }

  // If Routescan v2 API is reachable, verify Avalanche holdings parsed cleanly
  if (liveAvaxHoldings.length > 0) {
    assert.ok(liveAvaxHoldings.every((h) => /^0x[0-9a-fA-F]{40}$/.test(h.address) && h.rawBalance > 0n));
  }
});
