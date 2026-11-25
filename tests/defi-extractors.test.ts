import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUniswapV3NftExitCalldata,
  computeAaveSafePartialWithdrawal,
  computeCompoundV2UnderlyingRaw,
  computeUniswapV2UnderlyingAmounts,
  decodeUniswapV2Reserves,
  decodeUniswapV3Position,
  DEFI_SELECTORS,
  encodeErc4626ConvertToAssets,
  encodeErc4626MaxRedeem,
  encodeErc4626PreviewRedeem,
  encodeErc4626Redeem,
  isLiquidReceiptToken,
  MAX_UINT128,
  resolveDefiExitPlan,
} from '../src/defi/extractors.js';
import { translateDefiRevertToPlainEnglish } from '../src/defi/preflight.js';
import {
  prepareChainBatchExecution,
  prepareRealExecution,
  type FollowUpQuoteFn,
  type PreparedExecution,
} from '../src/execution/tx-builder.js';
import type { ScannedAsset } from '../src/scanner/types.js';
import { createSiphonServer } from '../src/server/app.js';

const USER = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const SAMPLE_SOLANA_WALLET = 'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n';
const WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const SUSDE_ETH = '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497';
const USDE_ETH = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3';
const SDAI_ETH = '0x83F20F44975D03b1b09e64809B757c47f942BEeA';
const DAI_ETH = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

function makeDefiAsset(overrides: Partial<ScannedAsset>): ScannedAsset {
  return {
    id: 'eth:defi:test',
    chain: 'ethereum',
    chainName: 'Ethereum',
    address: '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8',
    symbol: 'aEthWETH',
    name: 'Aave v3 Ethereum WETH',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    underlyingSymbol: 'WETH',
    underlyingAddress: WETH_ETH,
    rawBalance: (125n * 10n ** 16n).toString(), // 1.25 WETH
    uiBalance: 1.25,
    priceUsd: 2600,
    grossUsd: 3250,
    liquidityUsd: 100_000_000,
    estimatedGasUsd: 3.2,
    batchedGasUsd: 2.1,
    estimatedSlippageUsd: 1.5,
    netUsdcSingle: 3245.3,
    netUsdcBatched: 3246.4,
    action: 'WITHDRAW_AND_BRIDGE',
    actionReason: 'Withdraw DeFi position',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

const mockRelayFollowUp: FollowUpQuoteFn = async (
  asset,
  userAddress,
  solanaDestination,
  outputAsset
): Promise<PreparedExecution> => {
  const outUsd = Number((asset.grossUsd * 0.992).toFixed(2));
  return {
    assetId: asset.id,
    action: asset.action,
    provider: 'relay',
    chain: asset.chain as PreparedExecution['chain'],
    chainId: asset.chain === 'base' ? 8453 : 1,
    chainName: asset.chainName,
    explorerUrl: asset.chain === 'base' ? 'https://basescan.org' : 'https://etherscan.io',
    estimatedOutput: `${outUsd} ${outputAsset}`,
    estimatedSeconds: 4,
    quotedOutUsd: outUsd,
    liveNetUsd: Number((outUsd - 1.5).toFixed(2)),
    liveHaircutPct: 1.2,
    estimatedGasUsd: 1.5,
    requestId: `req_mock_${asset.symbol.toLowerCase()}`,
    transactions: [
      {
        stepId: 'approve',
        label: `Approve ${asset.symbol} for Relay`,
        description: `Approve ${asset.uiBalance} ${asset.symbol}`,
        chain: asset.chain as PreparedExecution['chain'],
        chainId: asset.chain === 'base' ? 8453 : 1,
        chainName: asset.chainName,
        explorerUrl: asset.chain === 'base' ? 'https://basescan.org' : 'https://etherscan.io',
        from: userAddress,
        to: asset.address,
        data: `0x095ea7b3${'000000000000000000000000f70da97812cb96acdf810712aa562db8dfa3dbef'}${BigInt(asset.rawBalance).toString(16).padStart(64, '0')}`,
        value: '0x0',
      },
      {
        stepId: 'deposit',
        label: `Relay Swap & Bridge ${asset.symbol} → Solana ${outputAsset}`,
        description: `Instant bridge to ${solanaDestination.slice(0, 6)}…`,
        chain: asset.chain as PreparedExecution['chain'],
        chainId: asset.chain === 'base' ? 8453 : 1,
        chainName: asset.chainName,
        explorerUrl: asset.chain === 'base' ? 'https://basescan.org' : 'https://etherscan.io',
        from: userAddress,
        to: '0xf70da97812CB96ACDF810712Aa562db8dfA3dbEF',
        data: `0x12345678${BigInt(asset.rawBalance).toString(16).padStart(64, '0')}`,
        value: '0x0',
      },
    ],
    notes: [`Mock Relay quote for ${asset.symbol}`],
  };
};

test('ERC-4626 convertToAssets/previewRedeem/maxRedeem encoding, non-1:1 share pricing & cooldown detection', () => {
  const shares = 1000n * 10n ** 18n; // 1,000 shares
  assert.ok(encodeErc4626ConvertToAssets(shares).startsWith(DEFI_SELECTORS.convertToAssets));
  assert.ok(encodeErc4626PreviewRedeem(shares).startsWith(DEFI_SELECTORS.previewRedeem));
  assert.ok(encodeErc4626MaxRedeem(USER).startsWith(DEFI_SELECTORS.maxRedeem));
  assert.ok(encodeErc4626Redeem(shares, USER, USER).startsWith(DEFI_SELECTORS.redeem4626));

  // Morpho Steakhouse USDC vault: 1,000 shares (18 dec) -> 1,124.50 USDC (6 dec) via previewRedeem!
  const morphoAsset = makeDefiAsset({
    id: 'base:steakusdc',
    chain: 'base',
    chainName: 'Base',
    address: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183',
    symbol: 'steakUSDC',
    name: 'Morpho Steakhouse USDC Vault',
    decimals: 18,
    protocol: 'Morpho ERC-4626',
    protocolAddress: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183',
    underlyingSymbol: 'USDC',
    underlyingAddress: USDC_BASE,
    rawBalance: shares.toString(),
    uiBalance: 1000,
    priceUsd: 1.1245,
    grossUsd: 1124.5,
  });

  const morphoPlan = resolveDefiExitPlan({
    asset: morphoAsset,
    vaultState: {
      vaultAddress: morphoAsset.address,
      underlyingAddress: USDC_BASE,
      sharesRaw: shares,
      convertToAssetsRaw: 1_124_500_000n,
      previewRedeemRaw: 1_124_500_000n,
      expectedUnderlyingRaw: 1_124_500_000n,
      maxRedeemRaw: shares,
      cooldownDurationSec: null,
      cooldownDetected: false,
      shareExchangeRate: 1.1245,
    },
  });
  assert.equal(morphoPlan.protocolId, 'erc4626');
  assert.equal(morphoPlan.routeKind, 'protocol_unwind');
  assert.equal(morphoPlan.exitStrategy, 'instant_1click_unwind');
  assert.equal(morphoPlan.expectedUnderlyingRaw, '1124500000');
  assert.equal(morphoPlan.shareExchangeRate, 1.1245);
  assert.equal(morphoPlan.cooldownDetected, false);
  assert.equal(morphoPlan.preflightStatus, 'verified');

  // Illiquid cooldown-locked ERC-4626 vault (maxRedeem == 0) MUST be marked cooldown_blocked
  const lockedVault = makeDefiAsset({
    id: 'eth:locked_vault',
    address: '0x2222222222222222222222222222222222222222',
    symbol: 'lockUSDC',
    protocol: 'Fluid ERC-4626',
    protocolAddress: '0x2222222222222222222222222222222222222222',
    underlyingSymbol: 'USDC',
    underlyingAddress: USDC_ETH,
    liquidityUsd: 0,
  });
  const lockedPlan = resolveDefiExitPlan({
    asset: lockedVault,
    vaultState: {
      vaultAddress: lockedVault.address,
      underlyingAddress: USDC_ETH,
      sharesRaw: shares,
      convertToAssetsRaw: 1_050_000_000n,
      previewRedeemRaw: null,
      expectedUnderlyingRaw: 1_050_000_000n,
      maxRedeemRaw: 0n,
      cooldownDurationSec: 604800,
      cooldownDetected: true,
      shareExchangeRate: 1.05,
    },
  });
  assert.equal(lockedPlan.routeKind, 'unbonding_required');
  assert.equal(lockedPlan.exitStrategy, 'cooldown_blocked');
  assert.equal(lockedPlan.preflightStatus, 'blocked');
  assert.equal(lockedPlan.cooldownDetected, true);
});

test('Smart Exit Router routes Ethena sUSDe & liquid receipts to Direct Swap (bypasses cooldown & redeem revert)', async () => {
  for (const sym of ['wstETH', 'rETH', 'cbETH', 'weETH', 'ezETH', 'sUSDe', 'sDAI', 'sUSDS', 'stETH']) {
    assert.equal(isLiquidReceiptToken(sym), true, `${sym} must be recognized as liquid receipt`);
  }

  // Ethena sUSDe: cooldownDetected=true + maxRedeem=0 -> bypasses redeem() via direct_swap_bypass_cooldown!
  const susdeAsset = makeDefiAsset({
    id: 'eth:susde',
    address: SUSDE_ETH,
    symbol: 'sUSDe',
    name: 'Ethena Staked USDe',
    protocol: 'Ethena ERC-4626',
    protocolAddress: SUSDE_ETH,
    underlyingSymbol: 'USDe',
    underlyingAddress: USDE_ETH,
    rawBalance: (500n * 10n ** 18n).toString(),
    uiBalance: 500,
    priceUsd: 1.14,
    grossUsd: 570,
    liquidityUsd: 45_000_000,
  });

  const susdePlan = resolveDefiExitPlan({
    asset: susdeAsset,
    vaultState: {
      vaultAddress: SUSDE_ETH,
      underlyingAddress: USDE_ETH,
      sharesRaw: 500n * 10n ** 18n,
      convertToAssetsRaw: 570n * 10n ** 18n,
      previewRedeemRaw: null,
      expectedUnderlyingRaw: 570n * 10n ** 18n,
      maxRedeemRaw: 0n,
      cooldownDurationSec: 604800,
      cooldownDetected: true,
      shareExchangeRate: 1.14,
    },
  });
  assert.equal(susdePlan.routeKind, 'direct_swap');
  assert.equal(susdePlan.exitStrategy, 'direct_swap_bypass_cooldown');
  assert.equal(susdePlan.cooldownDetected, true);
  assert.equal(susdePlan.preflightStatus, 'verified');
  assert.ok(susdePlan.preflightReason.toLowerCase().includes('cooldown'));

  // prepareRealExecution on sUSDe MUST route to Relay/DEX swap (NOT ERC-4626 redeem 0xba087652!)
  const susdeExec = await prepareRealExecution({
    asset: { ...susdeAsset, defiExitPlan: susdePlan },
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    followUpQuoteFn: mockRelayFollowUp,
  });
  assert.equal(susdeExec.provider, 'relay');
  assert.equal(susdeExec.defiExitPlan?.exitStrategy, 'direct_swap_bypass_cooldown');
  assert.ok(
    !susdeExec.transactions.some((tx) => tx.data.startsWith('0xba087652')),
    'sUSDe must bypass ERC-4626 redeem() which reverts during cooldown'
  );

  // sDAI also routes via Direct Swap in Smart Exit Router
  const sdaiPlan = resolveDefiExitPlan({
    asset: makeDefiAsset({
      id: 'eth:sdai',
      address: SDAI_ETH,
      symbol: 'sDAI',
      protocol: 'Spark ERC-4626',
      protocolAddress: SDAI_ETH,
      underlyingSymbol: 'DAI',
      underlyingAddress: DAI_ETH,
      grossUsd: 1200,
      liquidityUsd: 80_000_000,
    }),
  });
  assert.equal(sdaiPlan.routeKind, 'direct_swap');
  assert.equal(sdaiPlan.exitStrategy, 'direct_swap_bypass_cooldown');
});

test('Aave v3 & Aave v2 Safe Partial Withdrawal calculator computes exact max withdrawable keeping HF >= 1.6', async () => {
  // Scenario A: $10,000 total collateral, $1,500 active debt, 82.5% LT -> current HF = (10000*0.825)/1500 = 5.5
  // Min collateral to keep HF >= 1.6 = (1.6 * 1500) / 0.825 = $2,909.09
  // Safe max withdrawable = (10000 - 2909.09) * 0.995 = ~$7,055.45 (capped by positionUsd = $5,000 -> can withdraw full $5,000 OR $8,000 position -> partial ~$7,055!)
  const partialBig = computeAaveSafePartialWithdrawal({
    totalCollateralUsd: 10_000,
    totalDebtUsd: 1_500,
    liquidationThresholdBps: 8250,
    currentHealthFactor: 5.5,
    positionUsd: 8_000,
    positionRawBalance: 8_000_000_000n, // 8000 USDC
    positionDecimals: 6,
    positionPriceUsd: 1.0,
  });
  assert.equal(partialBig.canWithdrawAny, true);
  assert.equal(partialBig.canWithdrawFull, false);
  assert.ok(partialBig.safeMaxWithdrawUsd > 7000 && partialBig.safeMaxWithdrawUsd < 7100);
  assert.ok(partialBig.projectedHealthFactor >= 1.6);
  assert.ok(partialBig.safeMaxWithdrawRaw > 7_000_000_000n && partialBig.safeMaxWithdrawRaw < 8_000_000_000n);

  // prepareRealExecution MUST encode exact safeMaxWithdrawRaw (NOT MAX_UINT256!)
  const aaveV3DebtAsset = makeDefiAsset({
    id: 'eth:aave_partial',
    address: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
    symbol: 'aEthUSDC',
    decimals: 6,
    protocol: 'Aave v3',
    protocolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    underlyingSymbol: 'USDC',
    underlyingAddress: USDC_ETH,
    rawBalance: '8000000000',
    uiBalance: 8000,
    priceUsd: 1.0,
    grossUsd: 8000,
    aaveDebtUsd: 1500,
    aaveHealthFactor: 5.5,
    aaveTotalCollateralUsd: 10000,
    aaveLiquidationThresholdBps: 8250,
  });

  const partialPrep = await prepareRealExecution({
    asset: aaveV3DebtAsset,
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  assert.equal(partialPrep.provider, 'aave_v3');
  assert.equal(partialPrep.defiExitPlan?.exitStrategy, 'safe_partial_debt_exit');
  assert.ok((partialPrep.defiExitPlan?.safeMaxWithdrawUsd ?? 0) > 7000);
  assert.ok(partialPrep.transactions[0].data.startsWith('0x69328dec'));
  assert.ok(
    !partialPrep.transactions[0].data.includes('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
    'Safe partial debt exit MUST NOT pass MAX_UINT256'
  );
  const encodedAmtHex = partialPrep.transactions[0].data.slice(10 + 64, 10 + 128);
  assert.equal(BigInt('0x' + encodedAmtHex), partialBig.safeMaxWithdrawRaw);

  // Aave v2 LendingPool withdraw encoding
  const aaveV2Prep = await prepareRealExecution({
    asset: makeDefiAsset({
      id: 'eth:aave_v2_usdc',
      symbol: 'aUSDC',
      decimals: 6,
      protocol: 'Aave v2',
      protocolAddress: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
      underlyingSymbol: 'USDC',
      underlyingAddress: USDC_ETH,
      rawBalance: '500000000',
      uiBalance: 500,
      priceUsd: 1,
      grossUsd: 500,
    }),
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  assert.equal(aaveV2Prep.provider, 'aave_v2');
  assert.equal(aaveV2Prep.transactions[0].to.toLowerCase(), '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9');
  assert.ok(aaveV2Prep.transactions[0].data.startsWith('0x69328dec'));

  // Scenario B: HF already 1.45 (< 1.6) -> blocked!
  const unsafe = computeAaveSafePartialWithdrawal({
    totalCollateralUsd: 2_100,
    totalDebtUsd: 1_200,
    liquidationThresholdBps: 8250,
    currentHealthFactor: 1.45,
    positionUsd: 1_240,
    positionRawBalance: 1_240_000_000n,
    positionDecimals: 6,
    positionPriceUsd: 1.0,
  });
  assert.equal(unsafe.canWithdrawAny, false);
  assert.equal(unsafe.safeMaxWithdrawRaw, 0n);
});

test('Compound v2 / Venus / Benqi cToken.redeem(uint256) & exchangeRateStored underlying math', async () => {
  // 50,000 cUSDC (8 dec = 5_000_000_000_000n), exchangeRateStored = 2.3e14 (represents 0.023 USDC/cUSDC -> 1,150 USDC in 6 dec)
  const cBal = 50_000n * 10n ** 8n;
  const exchangeRate = 230_000_000_000_000n;
  const underlyingRaw = computeCompoundV2UnderlyingRaw(cBal, exchangeRate);
  assert.equal(underlyingRaw, 1_150_000_000n); // exact 1,150.000000 USDC!

  const cUsdcAddr = '0x39AA39c021dfbaE8faC545936693aC917d5E7563';
  const prep = await prepareRealExecution({
    asset: makeDefiAsset({
      id: 'eth:comp_v2_cusdc',
      address: cUsdcAddr,
      symbol: 'cUSDC',
      decimals: 8,
      protocol: 'Compound v2',
      protocolAddress: cUsdcAddr,
      underlyingSymbol: 'USDC',
      underlyingAddress: USDC_ETH,
      rawBalance: cBal.toString(),
      uiBalance: 50_000,
      priceUsd: 0.023,
      grossUsd: 1150,
      defiExitPlan: {
        protocolId: 'compound_v2',
        protocolName: 'Compound v2',
        routeKind: 'protocol_unwind',
        exitStrategy: 'instant_1click_unwind',
        preflightStatus: 'verified',
        preflightReason: 'Compound v2 cUSDC verified.',
        plainEnglishSteps: ['Redeem 50000 cUSDC into 1150 USDC', 'Bridge USDC to Solana'],
        expectedUnderlyingRaw: underlyingRaw.toString(),
        expectedUnderlyingUi: 1150,
        underlyingSymbol: 'USDC',
        underlyingAddress: USDC_ETH,
        underlyingDecimals: 6,
      },
    }),
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });

  assert.equal(prep.provider, 'compound_v2');
  assert.equal(prep.transactions[0].to.toLowerCase(), cUsdcAddr.toLowerCase());
  assert.ok(prep.transactions[0].data.startsWith(DEFI_SELECTORS.compoundV2Redeem)); // 0xdb006a75
  assert.equal(prep.chainedFollowUpPlan?.unlockedAssets[0].expectedRawAmount, '1150000000');
});

test('Uniswap v2 / Aerodrome v2 LP reserves decoding & removeLiquidity calldata + Uniswap v3 NFT multicall', async () => {
  const word = (n: bigint) => n.toString(16).padStart(64, '0');
  // 1. Uniswap v2 reserves decode + pro-rata math
  const reservesHex = '0x' + word(100n * 10n ** 18n) + word(250_000n * 10n ** 6n) + word(1730000000n);
  const decodedRes = decodeUniswapV2Reserves(reservesHex);
  assert.ok(decodedRes);
  assert.equal(decodedRes.reserve0, 100n * 10n ** 18n);
  assert.equal(decodedRes.reserve1, 250_000n * 10n ** 6n);

  // User owns 1% of total supply -> 1 WETH + 2,500 USDC
  const amounts = computeUniswapV2UnderlyingAmounts({
    lpBalance: 10n ** 18n,
    totalSupply: 100n * 10n ** 18n,
    reserve0: decodedRes.reserve0,
    reserve1: decodedRes.reserve1,
  });
  assert.equal(amounts.amount0, 10n ** 18n);
  assert.equal(amounts.amount1, 2_500n * 10n ** 6n);
  assert.equal(amounts.amount0Min, 99n * 10n ** 16n);

  // Standard Uniswap v2 LP extraction builds [LP.approve, Router.removeLiquidity (0xbaa2abde)]
  const uniV2Asset = makeDefiAsset({
    id: 'eth:univ2_weth_usdc',
    address: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
    symbol: 'UNI-V2',
    protocol: 'Uniswap v2 LP',
    protocolAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    lpToken0Address: WETH_ETH,
    lpToken0Symbol: 'WETH',
    lpToken0Decimals: 18,
    lpToken1Address: USDC_ETH,
    lpToken1Symbol: 'USDC',
    lpToken1Decimals: 6,
    lpRouterAddress: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
    rawBalance: (10n ** 18n).toString(),
    uiBalance: 1,
    grossUsd: 5000,
    defiExitPlan: {
      protocolId: 'uniswap_v2_lp',
      protocolName: 'Uniswap v2 LP',
      routeKind: 'protocol_unwind',
      exitStrategy: 'instant_1click_unwind',
      preflightStatus: 'verified',
      preflightReason: 'LP ready to remove.',
      plainEnglishSteps: ['Remove liquidity', 'Bridge WETH + USDC'],
      expectedUnderlyingRaw: amounts.amount0.toString(),
      underlyingSymbol: 'WETH',
      underlyingAddress: WETH_ETH,
      underlyingDecimals: 18,
      expectedSecondaryRaw: amounts.amount1.toString(),
      secondaryUnderlyingSymbol: 'USDC',
      secondaryUnderlyingAddress: USDC_ETH,
      secondaryUnderlyingDecimals: 6,
    },
  });

  const uniV2Prep = await prepareRealExecution({
    asset: uniV2Asset,
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  assert.equal(uniV2Prep.provider, 'uniswap_v2_lp');
  assert.equal(uniV2Prep.transactions.length, 2);
  assert.ok(uniV2Prep.transactions[0].data.startsWith('0x095ea7b3')); // LP approve
  assert.ok(uniV2Prep.transactions[1].data.startsWith(DEFI_SELECTORS.removeLiquidityV2)); // 0xbaa2abde
  assert.equal(uniV2Prep.chainedFollowUpPlan?.unlockedAssets.length, 2);

  // Aerodrome v2 LP on Base uses 0x0dede6c4 (with bool stable parameter!)
  const aeroLpPrep = await prepareRealExecution({
    asset: makeDefiAsset({
      id: 'base:aero_lp',
      chain: 'base',
      chainName: 'Base',
      address: '0xcDAC0d6c6C59727a65F8712361583545920F7056',
      symbol: 'vAMM-WETH/USDC',
      protocol: 'Aerodrome v2 LP',
      protocolAddress: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      lpToken0Address: WETH_BASE,
      lpToken0Symbol: 'WETH',
      lpToken0Decimals: 18,
      lpToken1Address: USDC_BASE,
      lpToken1Symbol: 'USDC',
      lpToken1Decimals: 6,
      lpRouterAddress: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      lpStable: false,
      rawBalance: (5n * 10n ** 17n).toString(),
      uiBalance: 0.5,
      grossUsd: 1200,
    }),
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  assert.equal(aeroLpPrep.provider, 'uniswap_v2_lp');
  assert.ok(aeroLpPrep.transactions[1].data.startsWith(DEFI_SELECTORS.removeLiquidityAero)); // 0x0dede6c4

  // 2. Uniswap v3 NFT position decoding + 1-click multicall([decreaseLiquidity, collect, burn])
  const posHex =
    '0x' +
    word(0n) + // nonce
    word(0n) + // operator
    WETH_ETH.slice(2).toLowerCase().padStart(64, '0') + // token0
    USDC_ETH.slice(2).toLowerCase().padStart(64, '0') + // token1
    word(500n) + // fee 0.05%
    word((1n << 256n) - 1000n) + // tickLower = -1000
    word(2000n) + // tickUpper = +2000
    word(987654321000n) + // liquidity
    word(0n) + // feeGrowthInside0
    word(0n) + // feeGrowthInside1
    word(100_000n) + // tokensOwed0
    word(200_000n); // tokensOwed1

  const decodedPos = decodeUniswapV3Position(774123n, posHex);
  assert.ok(decodedPos);
  assert.equal(decodedPos.tokenId, 774123n);
  assert.equal(decodedPos.token0, WETH_ETH.toLowerCase());
  assert.equal(decodedPos.token1, USDC_ETH.toLowerCase());
  assert.equal(decodedPos.tickLower, -1000);
  assert.equal(decodedPos.tickUpper, 2000);
  assert.equal(decodedPos.liquidity, 987654321000n);

  const nftBuilt = buildUniswapV3NftExitCalldata({
    tokenId: 774123n,
    liquidity: 987654321000n,
    recipient: USER,
    deadline: 1800000000n,
  });
  assert.equal(nftBuilt.innerCalls.length, 3);
  assert.ok(nftBuilt.innerCalls[0].startsWith(DEFI_SELECTORS.decreaseLiquidity)); // 0x0c49ccbe
  assert.ok(nftBuilt.innerCalls[1].startsWith(DEFI_SELECTORS.collect)); // 0xfc6f7865
  assert.ok(nftBuilt.innerCalls[1].includes(MAX_UINT128.toString(16)));
  assert.ok(nftBuilt.innerCalls[2].startsWith(DEFI_SELECTORS.burnNft)); // 0x42966c68
  assert.ok(nftBuilt.data.startsWith(DEFI_SELECTORS.multicall)); // 0xac9650d8

  const nftPrep = await prepareRealExecution({
    asset: makeDefiAsset({
      id: 'eth:univ3_nft_774123',
      address: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      symbol: 'UNI-V3-#774123',
      protocol: 'Uniswap v3',
      protocolAddress: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      lpToken0Address: WETH_ETH,
      lpToken0Symbol: 'WETH',
      lpToken1Address: USDC_ETH,
      lpToken1Symbol: 'USDC',
      nftTokenId: '774123',
      nftLiquidity: '987654321000',
      nftManagerAddress: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      rawBalance: '987654321000',
    }),
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
  });
  assert.equal(nftPrep.provider, 'uniswap_v3_nft');
  assert.equal(nftPrep.transactions.length, 1);
  assert.ok(nftPrep.transactions[0].data.startsWith(DEFI_SELECTORS.multicall));
});

test('1-Click Withdraw -> Swap -> Bridge chaining bundles non-USDC Aave, ERC-4626 previewRedeem USDC & LP removals', async () => {
  // 1. Non-USDC Aave v3 aEthWETH chains Pool.withdraw + Relay WETH->Solana bridge in 1 EIP-5792 batch!
  const aEthWeth = makeDefiAsset({
    id: 'eth:aethweth',
    symbol: 'aEthWETH',
    protocol: 'Aave v3',
    underlyingSymbol: 'WETH',
    underlyingAddress: WETH_ETH,
    rawBalance: (125n * 10n ** 16n).toString(),
    uiBalance: 1.25,
    grossUsd: 3250,
  });

  const wethBatch = await prepareChainBatchExecution({
    chain: 'ethereum',
    assets: [aEthWeth],
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    bundleDefiCctp: true,
    followUpQuoteFn: mockRelayFollowUp,
  });

  assert.equal(wethBatch.calls.length, 3); // Aave withdraw + WETH approve + Relay swap&bridge
  assert.ok(wethBatch.calls[0].data.startsWith('0x69328dec')); // Pool.withdraw(WETH, MAX, user)
  assert.equal(wethBatch.calls[1].stepId, 'approve_after_defi');
  assert.equal(wethBatch.calls[2].stepId, 'deposit_after_defi');
  assert.equal(wethBatch.savings.walletPopupsEip5792, 1);
  assert.equal(wethBatch.chainedFollowUpPlans?.length, 1);
  assert.equal(wethBatch.chainedFollowUpPlans?.[0].bundledInCurrentBatch, true);
  assert.equal(wethBatch.chainedFollowUpPlans?.[0].autoAdvanceAction, 'complete_in_single_batch');
  assert.equal(wethBatch.chainedFollowUpPlans?.[0].bridgeProvider, 'relay');

  // 2. Morpho ERC-4626 steakUSDC (18-dec shares -> 6-dec previewRedeem 1,150 USDC) MUST encode 1,150 USDC (NOT 1e21 shares!) into CCTP depositForBurn!
  const morphoUsdc = makeDefiAsset({
    id: 'base:steakusdc_chain',
    chain: 'base',
    chainName: 'Base',
    address: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183',
    symbol: 'steakUSDC',
    decimals: 18,
    protocol: 'Morpho ERC-4626',
    protocolAddress: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183',
    underlyingSymbol: 'USDC',
    underlyingAddress: USDC_BASE,
    rawBalance: (1000n * 10n ** 18n).toString(), // 1000 shares (18 dec)
    uiBalance: 1000,
    priceUsd: 1.15,
    grossUsd: 1150,
    defiExitPlan: {
      protocolId: 'erc4626',
      protocolName: 'Morpho ERC-4626',
      routeKind: 'protocol_unwind',
      exitStrategy: 'instant_1click_unwind',
      preflightStatus: 'verified',
      preflightReason: 'Morpho vault verified.',
      plainEnglishSteps: ['Redeem 1000 steakUSDC -> 1150 USDC', 'Bridge USDC -> Solana'],
      expectedUnderlyingRaw: '1150000000', // 1,150.000000 USDC (6 dec!)
      expectedUnderlyingUi: 1150,
      underlyingSymbol: 'USDC',
      underlyingAddress: USDC_BASE,
      underlyingDecimals: 6,
      shareExchangeRate: 1.15,
    },
  });

  const morphoBatch = await prepareChainBatchExecution({
    chain: 'base',
    assets: [morphoUsdc],
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    bridgePreference: 'cctp',
    bundleDefiCctp: true,
  });
  assert.equal(morphoBatch.calls.length, 3); // ERC-4626 redeem + USDC approve + CCTP depositForBurn
  assert.ok(morphoBatch.calls[0].data.startsWith('0xba087652'));
  assert.ok(morphoBatch.calls[2].data.startsWith('0x6fd3504e'));
  const cctpAmount = BigInt('0x' + morphoBatch.calls[2].data.slice(10, 74));
  assert.equal(cctpAmount, 1_150_000_000n, 'CCTP must bridge exact previewRedeem 6-decimal USDC output');
  assert.equal(morphoBatch.chainedFollowUpPlans?.[0].bundledInCurrentBatch, true);

  // 3. Legacy wallet mode (bundleDefiCctp: false) returns clean chainedFollowUpPlans for auto-advance without re-scanning
  const legacyBatch = await prepareChainBatchExecution({
    chain: 'ethereum',
    assets: [aEthWeth],
    userAddress: USER,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    bundleDefiCctp: false,
  });
  assert.equal(legacyBatch.calls.length, 1);
  assert.equal(legacyBatch.chainedFollowUpPlans?.length, 1);
  assert.equal(legacyBatch.chainedFollowUpPlans?.[0].bundledInCurrentBatch, false);
  assert.equal(legacyBatch.chainedFollowUpPlans?.[0].autoAdvanceAction, 'auto_quote_and_bridge_unlocked');
  assert.equal(legacyBatch.chainedFollowUpPlans?.[0].unlockedAssets[0].symbol, 'WETH');
});

test('Plain-English revert translator & HTTP API (/api/defi/preflight, /api/scan, /api/plan) expose defiExitPlan cleanly', async () => {
  // Revert translator never leaks raw hex jargon
  const msgCooldown = translateDefiRevertToPlainEnglish({
    rawError: 'execution reverted: OperationNotAllowed()',
    protocolName: 'Ethena',
    symbol: 'sUSDe',
  });
  assert.ok(msgCooldown.toLowerCase().includes('cooldown'));
  assert.ok(!/0x[0-9a-f]{8,}/i.test(msgCooldown));

  const msgAave = translateDefiRevertToPlainEnglish({
    rawError: 'execution reverted: 35',
    protocolName: 'Aave v3',
    symbol: 'aEthUSDC',
  });
  assert.ok(msgAave.toLowerCase().includes('health factor'));

  // HTTP integration test
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. /api/scan attaches defiExitPlan on every DeFi asset
    const scan = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId: 'veteran_defi' }),
    }).then((r) => r.json());

    const defiAssets = scan.assets.filter((a: ScannedAsset) => a.kind === 'defi_position');
    assert.ok(defiAssets.length >= 5);
    for (const d of defiAssets) {
      assert.ok(d.defiExitPlan, `Expected defiExitPlan on ${d.symbol}`);
      assert.ok(Array.isArray(d.defiExitPlan.plainEnglishSteps) && d.defiExitPlan.plainEnglishSteps.length >= 1);
    }
    const wstEth = defiAssets.find((a: ScannedAsset) => a.symbol === 'wstETH');
    assert.equal(wstEth.defiExitPlan.exitStrategy, 'direct_swap_bypass_cooldown');
    assert.equal(wstEth.defiExitPlan.routeKind, 'direct_swap');

    // 2. /api/plan exposes defiExitPlans cleanly without breaking existing shape
    const plan = await fetch(`${base}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scanId: scan.scanId,
        solanaDestination: SAMPLE_SOLANA_WALLET,
      }),
    }).then((r) => r.json());
    assert.ok(Array.isArray(plan.defiExitPlans) && plan.defiExitPlans.length >= 5);
    assert.ok(plan.legs.some((l: { defiExitPlans?: unknown[] }) => (l.defiExitPlans?.length ?? 0) > 0));

    // 3. POST /api/defi/preflight works via scanId AND direct assets[]
    const preflightByScan = await fetch(`${base}/api/defi/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanId: scan.scanId, skipRpc: true }),
    }).then((r) => r.json());
    assert.ok(preflightByScan.results.length >= 5);
    assert.equal(preflightByScan.summary.totalChecked, preflightByScan.results.length);
    assert.ok(preflightByScan.summary.directSwapBypassCount >= 1);

    const preflightDirect = await fetch(`${base}/api/defi/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: USER,
        skipRpc: true,
        assets: [
          makeDefiAsset({
            id: 'eth:susde_api',
            address: SUSDE_ETH,
            symbol: 'sUSDe',
            protocol: 'Ethena ERC-4626',
            protocolAddress: SUSDE_ETH,
            underlyingSymbol: 'USDe',
            underlyingAddress: USDE_ETH,
          }),
          makeDefiAsset({
            id: 'eth:aave_debt_api',
            symbol: 'aEthUSDC',
            decimals: 6,
            underlyingSymbol: 'USDC',
            underlyingAddress: USDC_ETH,
            rawBalance: '8000000000',
            uiBalance: 8000,
            priceUsd: 1,
            grossUsd: 8000,
            aaveDebtUsd: 1500,
            aaveHealthFactor: 5.5,
            aaveTotalCollateralUsd: 10000,
            aaveLiquidationThresholdBps: 8250,
          }),
        ],
      }),
    }).then((r) => r.json());

    assert.equal(preflightDirect.summary.totalChecked, 2);
    assert.equal(preflightDirect.summary.directSwapBypassCount, 1);
    assert.equal(preflightDirect.summary.partialDebtExitCount, 1);

    // 4. Validation: missing walletAddress/assets -> 400
    const badReq = await fetch(`${base}/api/defi/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(badReq.status, 400);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
