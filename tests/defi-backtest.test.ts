import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUniswapV3NftExitCalldata,
  checkCompoundAccountSafety,
  computeAaveSafePartialWithdrawal,
  computeCompoundV2UnderlyingRaw,
  computeUniswapV2UnderlyingAmounts,
  decodeMulticallBytes,
  decodeUniswapV2Reserves,
  DEFI_SELECTORS,
  probeErc4626VaultStates,
  probeExpandedDefiContracts,
  resolveDefiExitPlan,
  validateTrustedProtocolTarget,
} from '../src/defi/extractors.js';
import { preflightDefiAsset } from '../src/defi/preflight.js';
import {
  prepareChainBatchExecution,
  prepareRealExecution,
  type AaveSafetyCheckFn,
  type CompoundSafetyCheckFn,
  type FollowUpQuoteFn,
  type PreparedExecution,
} from '../src/execution/tx-builder.js';
import { checkAaveV3AccountSafety } from '../src/scanner/discovery.js';
import type { ScannedAsset } from '../src/scanner/types.js';

const USER = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_DEST = 'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n';
const ATTACKER = '0xBad000000000000000000000000000000000dEaD';

const WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI_ETH = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const SUSDE_ETH = '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497';
const USDE_ETH = '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3';
const SDAI_ETH = '0x83F20F44975D03b1b09e64809B757c47f942BEeA';
const SUSDS_ETH = '0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD';
const STEAK_USDC_BASE = '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183';
const AAVE_V3_ETH = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
const AAVE_V2_ETH = '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9';
const CUSDC_V3_ETH = '0xc3d688B66703497DAA19211EEdff47f25384cdc3';
const CWETH_V3_ETH = '0xA17581A9E3356d9A858b789D68B4d866e593aE94';
const CUSDC_V2_ETH = '0x39AA39c021dfbaE8faC545936693aC917d5E7563';

function mkAsset(overrides: Partial<ScannedAsset>): ScannedAsset {
  return {
    id: 'backtest:asset',
    chain: 'ethereum',
    chainName: 'Ethereum',
    address: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
    symbol: 'aEthUSDC',
    name: 'Aave v3 Ethereum USDC',
    decimals: 6,
    kind: 'defi_position',
    protocol: 'Aave v3',
    protocolAddress: AAVE_V3_ETH,
    underlyingSymbol: 'USDC',
    underlyingAddress: USDC_ETH,
    rawBalance: '10000000000', // 10,000 USDC
    uiBalance: 10_000,
    priceUsd: 1,
    grossUsd: 10_000,
    liquidityUsd: 200_000_000,
    estimatedGasUsd: 3.5,
    batchedGasUsd: 2.0,
    estimatedSlippageUsd: 0.5,
    netUsdcSingle: 9996,
    netUsdcBatched: 9997.5,
    action: 'WITHDRAW_AND_BRIDGE',
    actionReason: 'Withdraw DeFi position',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

const okAaveZeroDebt: AaveSafetyCheckFn = async () => ({
  checked: true,
  hasActiveDebt: false,
  totalCollateralUsd: 10_000,
  totalDebtUsd: 0,
  currentLiquidationThresholdBps: 8250,
  healthFactor: 999,
  safeForMaxWithdraw: true,
  reason: 'Verified onchain: zero debt.',
});

const failedAaveRpc: AaveSafetyCheckFn = async () => ({
  checked: false,
  hasActiveDebt: false,
  totalCollateralUsd: 0,
  totalDebtUsd: 0,
  currentLiquidationThresholdBps: 8000,
  healthFactor: 999,
  safeForMaxWithdraw: false,
  reason: 'Aave account debt check timed out on RPC.',
});

const okCompZeroBorrow: CompoundSafetyCheckFn = async ({ protocolId }) => ({
  checked: true,
  protocolId,
  hasActiveBorrow: false,
  borrowBalanceRaw: 0n,
  isCollateralized: true,
  safeForWithdraw: true,
  reason: 'Verified onchain: zero active borrow.',
});

const activeCompBorrow: CompoundSafetyCheckFn = async ({ protocolId }) => ({
  checked: true,
  protocolId,
  hasActiveBorrow: true,
  borrowBalanceRaw: 250_000_000n,
  isCollateralized: true,
  safeForWithdraw: false,
  reason: 'Active Compound borrow detected on this market. Repay borrow before withdrawing.',
});

const failedCompRpc: CompoundSafetyCheckFn = async ({ protocolId }) => ({
  checked: false,
  protocolId,
  hasActiveBorrow: false,
  borrowBalanceRaw: 0n,
  isCollateralized: false,
  safeForWithdraw: false,
  reason: 'Compound borrow check timed out on RPC — pausing withdrawal for safety.',
});

function makeMockRelayQuote(haircutFraction = 0.008): FollowUpQuoteFn {
  return async (asset, userAddress, _solDest, outputAsset): Promise<PreparedExecution> => {
    const quotedOutUsd = Number((asset.grossUsd * (1 - haircutFraction)).toFixed(2));
    return {
      assetId: asset.id,
      action: asset.action,
      provider: 'relay',
      chain: asset.chain as PreparedExecution['chain'],
      chainId: asset.chain === 'base' ? 8453 : 1,
      chainName: asset.chainName,
      explorerUrl: asset.chain === 'base' ? 'https://basescan.org' : 'https://etherscan.io',
      estimatedOutput: `${quotedOutUsd} ${outputAsset}`,
      estimatedSeconds: 5,
      quotedOutUsd,
      liveNetUsd: Number((quotedOutUsd - 1.5).toFixed(2)),
      liveHaircutPct: Number((haircutFraction * 100).toFixed(2)),
      estimatedGasUsd: 1.5,
      requestId: `req_bt_${asset.symbol.toLowerCase()}`,
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
          description: `Instant cross-chain bridge for ${asset.symbol}`,
          chain: asset.chain as PreparedExecution['chain'],
          chainId: asset.chain === 'base' ? 8453 : 1,
          chainName: asset.chainName,
          explorerUrl: asset.chain === 'base' ? 'https://basescan.org' : 'https://etherscan.io',
          from: userAddress,
          to: '0xf70da97812CB96ACDF810712Aa562db8dfA3dbEF',
          data: `0xabcdef01${BigInt(asset.rawBalance).toString(16).padStart(64, '0')}`,
          value: '0x0',
        },
      ],
      notes: [`Backtest mock Relay quote for ${asset.symbol}`],
    };
  };
}

test('Backtest 1 — Aave v3 & v2: zero debt MAX, $10k/$500 safe partial (HF >= 1.6), HF 1.05 blocked, and RPC timeout FAIL-CLOSED', async () => {
  // 1a. Zero debt -> MAX_UINT256 withdraw
  const zeroDebtPrep = await prepareRealExecution({
    asset: mkAsset({}),
    userAddress: USER,
    solanaDestination: SOL_DEST,
    aaveSafetyCheckFn: okAaveZeroDebt,
  });
  assert.equal(zeroDebtPrep.provider, 'aave_v3');
  assert.ok(zeroDebtPrep.transactions[0].data.startsWith(DEFI_SELECTORS.aaveWithdraw));
  assert.ok(
    zeroDebtPrep.transactions[0].data.includes('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'),
    'Zero-debt Aave withdraw should encode MAX_UINT256'
  );
  assert.equal(zeroDebtPrep.defiExitPlan?.exitStrategy, 'instant_1click_unwind');

  // 1b. Small debt: $10,000 collateral / $500 debt (LT 82.5%) -> min collateral = (1.6*500)/0.825 = $969.70
  // Safe max withdraw = (10000 - 969.70) * 0.995 = ~$8,985.15 keeping HF >= 1.6!
  const smallDebtCalc = computeAaveSafePartialWithdrawal({
    totalCollateralUsd: 10_000,
    totalDebtUsd: 500,
    liquidationThresholdBps: 8250,
    currentHealthFactor: 16.5,
    positionUsd: 10_000,
    positionRawBalance: 10_000_000_000n,
    positionDecimals: 6,
    positionPriceUsd: 1,
  });
  assert.equal(smallDebtCalc.canWithdrawAny, true);
  assert.equal(smallDebtCalc.canWithdrawFull, false);
  assert.ok(smallDebtCalc.safeMaxWithdrawUsd > 8950 && smallDebtCalc.safeMaxWithdrawUsd < 9020);
  assert.ok(smallDebtCalc.projectedHealthFactor >= 1.6);

  const partialPrep = await prepareRealExecution({
    asset: mkAsset({
      aaveDebtUsd: 500,
      aaveHealthFactor: 16.5,
      aaveTotalCollateralUsd: 10_000,
      aaveLiquidationThresholdBps: 8250,
    }),
    userAddress: USER,
    solanaDestination: SOL_DEST,
  });
  assert.equal(partialPrep.defiExitPlan?.exitStrategy, 'safe_partial_debt_exit');
  const encodedPartialAmt = BigInt('0x' + partialPrep.transactions[0].data.slice(10 + 64, 10 + 128));
  assert.equal(encodedPartialAmt, smallDebtCalc.safeMaxWithdrawRaw);
  assert.ok(encodedPartialAmt < 10_000_000_000n);

  // 1c. Near-liquidation debt (HF 1.05) -> blocked cleanly with plain-English reason (no raw hex!)
  const nearLiqAsset = mkAsset({
    aaveDebtUsd: 7850,
    aaveHealthFactor: 1.05,
    aaveTotalCollateralUsd: 10_000,
    aaveLiquidationThresholdBps: 8250,
  });
  const nearLiqPlan = resolveDefiExitPlan({ asset: nearLiqAsset });
  assert.equal(nearLiqPlan.preflightStatus, 'blocked');
  assert.equal(nearLiqPlan.safeMaxWithdrawUsd, 0);
  assert.ok(nearLiqPlan.preflightReason.toLowerCase().includes('health factor'));
  assert.ok(!/0x[0-9a-f]{8,}/i.test(nearLiqPlan.preflightReason));

  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: nearLiqAsset,
        userAddress: USER,
        solanaDestination: SOL_DEST,
      }),
    /Aave v3 safety guard/
  );

  // 1d. RPC failure on getUserAccountData MUST FAIL CLOSED (never allow unsafe MAX withdraw!)
  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: mkAsset({}),
        userAddress: USER,
        solanaDestination: SOL_DEST,
        aaveSafetyCheckFn: failedAaveRpc,
      }),
    /could not verify onchain debt status/i
  );

  const preflightFailClosed = await preflightDefiAsset({
    asset: mkAsset({}),
    walletAddress: USER,
    aaveSafetyCheckFn: failedAaveRpc,
  });
  assert.equal(preflightFailClosed.canExecute1Click, false);
  assert.equal(preflightFailClosed.defiExitPlan.preflightStatus, 'blocked');
  assert.ok(preflightFailClosed.defiExitPlan.preflightReason.toLowerCase().includes('paused for your safety'));

  // 1e. Aave v2 also fails closed on RPC timeout and succeeds on zero debt
  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: mkAsset({ protocol: 'Aave v2', protocolAddress: AAVE_V2_ETH }),
        userAddress: USER,
        solanaDestination: SOL_DEST,
        aaveSafetyCheckFn: failedAaveRpc,
      }),
    /could not verify onchain debt status/i
  );
  const aaveV2Ok = await prepareRealExecution({
    asset: mkAsset({ protocol: 'Aave v2', protocolAddress: AAVE_V2_ETH }),
    userAddress: USER,
    solanaDestination: SOL_DEST,
    aaveSafetyCheckFn: okAaveZeroDebt,
  });
  assert.equal(aaveV2Ok.provider, 'aave_v2');
  assert.equal(aaveV2Ok.transactions[0].to.toLowerCase(), AAVE_V2_ETH.toLowerCase());
});

test('Backtest 2 — Compound v3 & v2: active borrow guard, RPC fail-closed, cWETHv3, cUSDCv3 & cToken.redeem(uint256)', async () => {
  const cWethAsset = mkAsset({
    id: 'eth:cwethv3_bt',
    address: CWETH_V3_ETH,
    symbol: 'cWETHv3',
    decimals: 18,
    protocol: 'Compound v3',
    protocolAddress: CWETH_V3_ETH,
    underlyingSymbol: 'WETH',
    underlyingAddress: WETH_ETH,
    rawBalance: (2n * 10n ** 18n).toString(),
    uiBalance: 2,
    priceUsd: 2600,
    grossUsd: 5200,
  });

  // 2a. Compound v3 active borrow MUST block withdrawal
  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: cWethAsset,
        userAddress: USER,
        solanaDestination: SOL_DEST,
        compoundSafetyCheckFn: activeCompBorrow,
      }),
    /Compound safety guard/
  );

  // 2b. Compound v3 RPC timeout MUST FAIL CLOSED
  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: cWethAsset,
        userAddress: USER,
        solanaDestination: SOL_DEST,
        compoundSafetyCheckFn: failedCompRpc,
      }),
    /Compound safety guard.*could not verify onchain borrow/i
  );

  // 2c. Clean zero-borrow cWETHv3 & cUSDCv3 build valid Comet.withdraw calldata
  const cWethOk = await prepareRealExecution({
    asset: cWethAsset,
    userAddress: USER,
    solanaDestination: SOL_DEST,
    compoundSafetyCheckFn: okCompZeroBorrow,
  });
  assert.equal(cWethOk.provider, 'compound_v3');
  assert.ok(cWethOk.transactions[0].data.startsWith(DEFI_SELECTORS.compoundV3Withdraw));
  assert.ok(cWethOk.transactions[0].data.toLowerCase().includes(WETH_ETH.slice(2).toLowerCase()));

  // 2d. Compound v2 cToken.redeem(uint256) + exchangeRateStored + borrow guard
  const cBal = 40_000n * 10n ** 8n; // 40,000 cUSDC (8 dec)
  const rate = 253_233_129_693_876n; // ~0.02532 USDC/cUSDC -> ~1,012.93 USDC (6 dec)
  const expectedUsdcRaw = computeCompoundV2UnderlyingRaw(cBal, rate);
  assert.ok(expectedUsdcRaw > 1_012_000_000n && expectedUsdcRaw < 1_014_000_000n);

  const cV2Asset = mkAsset({
    id: 'eth:cusdc_v2_bt',
    address: CUSDC_V2_ETH,
    symbol: 'cUSDC',
    decimals: 8,
    protocol: 'Compound v2',
    protocolAddress: CUSDC_V2_ETH,
    underlyingSymbol: 'USDC',
    underlyingAddress: USDC_ETH,
    rawBalance: cBal.toString(),
    uiBalance: 40_000,
    priceUsd: 0.02532,
    grossUsd: 1012.93,
  });

  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: { ...cV2Asset, compoundDebtUsd: 400 },
        userAddress: USER,
        solanaDestination: SOL_DEST,
        compoundSafetyCheckFn: okCompZeroBorrow,
      }),
    /Compound safety guard/
  );

  const cV2Ok = await prepareRealExecution({
    asset: cV2Asset,
    userAddress: USER,
    solanaDestination: SOL_DEST,
    compoundSafetyCheckFn: okCompZeroBorrow,
  });
  assert.equal(cV2Ok.provider, 'compound_v2');
  assert.ok(cV2Ok.transactions[0].data.startsWith(DEFI_SELECTORS.compoundV2Redeem));
});

test('Backtest 3 — ERC-4626 appreciating shares (1.18x), paused/maxRedeem=0, Ethena sUSDe bypass, and spoofed protocolAddress defense', async () => {
  const shares = 1000n * 10n ** 18n;
  const underlying118 = 1180n * 10n ** 18n;

  // 3a. Appreciating ERC-4626 vault (1 share = 1.18 DAI)
  const yearnDai = mkAsset({
    id: 'eth:yv_dai_118',
    address: '0x3333333333333333333333333333333333333333',
    symbol: 'yvDAI',
    decimals: 18,
    protocol: 'Yearn v3 ERC-4626',
    protocolAddress: '0x3333333333333333333333333333333333333333',
    underlyingSymbol: 'DAI',
    underlyingAddress: DAI_ETH,
    rawBalance: shares.toString(),
    uiBalance: 1000,
    priceUsd: 1.18,
    grossUsd: 1180,
  });

  const yearnPlan = resolveDefiExitPlan({
    asset: yearnDai,
    vaultState: {
      vaultAddress: yearnDai.address,
      underlyingAddress: DAI_ETH,
      sharesRaw: shares,
      onchainBalanceRaw: shares,
      convertToAssetsRaw: underlying118,
      previewRedeemRaw: underlying118,
      expectedUnderlyingRaw: underlying118,
      maxRedeemRaw: shares,
      cooldownDurationSec: null,
      cooldownDetected: false,
      shareExchangeRate: 1.18,
    },
  });
  assert.equal(yearnPlan.shareExchangeRate, 1.18);
  assert.equal(yearnPlan.expectedUnderlyingRaw, underlying118.toString());
  assert.equal(yearnPlan.expectedUnderlyingUi, 1180);

  // 3b. Paused / maxRedeem == 0 illiquid vault -> blocked cleanly
  const pausedPlan = resolveDefiExitPlan({
    asset: { ...yearnDai, liquidityUsd: 0 },
    vaultState: {
      vaultAddress: yearnDai.address,
      underlyingAddress: DAI_ETH,
      sharesRaw: shares,
      onchainBalanceRaw: shares,
      convertToAssetsRaw: underlying118,
      previewRedeemRaw: null,
      expectedUnderlyingRaw: underlying118,
      maxRedeemRaw: 0n,
      cooldownDurationSec: 0,
      cooldownDetected: true,
      shareExchangeRate: 1.18,
    },
  });
  assert.equal(pausedPlan.exitStrategy, 'cooldown_blocked');
  assert.equal(pausedPlan.preflightStatus, 'blocked');

  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: { ...yearnDai, liquidityUsd: 0, defiExitPlan: pausedPlan },
        userAddress: USER,
        solanaDestination: SOL_DEST,
      }),
    /cooldown lock/i
  );

  // 3c. Ethena sUSDe cooldown -> MUST route to direct_swap_bypass_cooldown, NEVER ERC-4626 redeem()
  const susdeAsset = mkAsset({
    id: 'eth:susde_bt',
    address: SUSDE_ETH,
    symbol: 'sUSDe',
    decimals: 18,
    protocol: 'Ethena ERC-4626',
    protocolAddress: SUSDE_ETH,
    underlyingSymbol: 'USDe',
    underlyingAddress: USDE_ETH,
    rawBalance: (500n * 10n ** 18n).toString(),
    uiBalance: 500,
    priceUsd: 1.26,
    grossUsd: 630,
    liquidityUsd: 55_000_000,
  });
  const susdeExec = await prepareRealExecution({
    asset: susdeAsset,
    userAddress: USER,
    solanaDestination: SOL_DEST,
    followUpQuoteFn: makeMockRelayQuote(0.005),
  });
  assert.equal(susdeExec.provider, 'relay');
  assert.equal(susdeExec.defiExitPlan?.exitStrategy, 'direct_swap_bypass_cooldown');
  assert.ok(!susdeExec.transactions.some((t) => t.data.startsWith(DEFI_SELECTORS.redeem4626)));

  // 3d. SPOOFED / MALICIOUS RECEIPT TOKEN DEFENSE: arbitrary protocolAddress MUST be rejected everywhere!
  const spoofCases: Array<{ label: string; asset: ScannedAsset }> = [
    {
      label: 'Spoofed Aave v3 POOL() returning attacker',
      asset: mkAsset({ protocol: 'Aave v3', protocolAddress: ATTACKER }),
    },
    {
      label: 'Spoofed Compound v3 Comet returning attacker',
      asset: mkAsset({ protocol: 'Compound v3', protocolAddress: ATTACKER }),
    },
    {
      label: 'Spoofed ERC-4626 vault redirecting redeem() to attacker contract',
      asset: { ...yearnDai, protocolAddress: ATTACKER },
    },
    {
      label: 'Spoofed Uniswap v2 LP redirecting removeLiquidity to attacker router',
      asset: mkAsset({
        protocol: 'Uniswap v2 LP',
        address: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
        protocolAddress: ATTACKER,
        lpRouterAddress: ATTACKER,
        lpToken0Address: WETH_ETH,
        lpToken1Address: USDC_ETH,
      }),
    },
    {
      label: 'Spoofed Uniswap v3 NFT manager returning attacker',
      asset: mkAsset({
        protocol: 'Uniswap v3',
        protocolAddress: ATTACKER,
        nftManagerAddress: ATTACKER,
        nftTokenId: '999',
      }),
    },
  ];

  for (const sc of spoofCases) {
    const plan = resolveDefiExitPlan({ asset: sc.asset });
    assert.equal(plan.preflightStatus, 'blocked', `${sc.label} must be blocked in resolveDefiExitPlan`);

    const pre = await preflightDefiAsset({ asset: sc.asset, walletAddress: USER, skipRpc: true });
    assert.equal(pre.canExecute1Click, false, `${sc.label} must be blocked in preflightDefiAsset`);

    await assert.rejects(
      () =>
        prepareRealExecution({
          asset: sc.asset,
          userAddress: USER,
          solanaDestination: SOL_DEST,
          aaveSafetyCheckFn: okAaveZeroDebt,
          compoundSafetyCheckFn: okCompZeroBorrow,
        }),
      /Blocked (untrusted|spoofed)/i,
      `${sc.label} must throw in prepareRealExecution`
    );
  }

  // Verify direct validator accepts canonical Aave v3 and rejects attacker
  assert.equal(
    validateTrustedProtocolTarget({
      chain: 'ethereum',
      protocolId: 'aave_v3',
      assetAddress: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
      protocolAddress: AAVE_V3_ETH,
    }).trusted,
    true
  );
  assert.equal(
    validateTrustedProtocolTarget({
      chain: 'ethereum',
      protocolId: 'aave_v3',
      assetAddress: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
      protocolAddress: ATTACKER,
    }).trusted,
    false
  );
});

test('Backtest 4 — Uniswap v2/v3 & Aerodrome LP calldata round-trip decoding + zero-liquidity/closed NFT edge case', () => {
  // 4a. Uniswap v2 LP share valuation from reserves
  const word = (n: bigint) => n.toString(16).padStart(64, '0');
  const resHex = '0x' + word(200n * 10n ** 18n) + word(520_000n * 10n ** 6n) + word(1730000000n);
  const reserves = decodeUniswapV2Reserves(resHex);
  assert.ok(reserves);
  const share = computeUniswapV2UnderlyingAmounts({
    lpBalance: 5n * 10n ** 17n, // 0.5% of 100 LP supply
    totalSupply: 100n * 10n ** 18n,
    reserve0: reserves.reserve0,
    reserve1: reserves.reserve1,
  });
  assert.equal(share.amount0, 10n ** 18n); // 1.0 WETH
  assert.equal(share.amount1, 2_600n * 10n ** 6n); // 2,600 USDC

  // 4b. Active Uniswap v3 NFT multicall round-trip decoding -> [decreaseLiquidity, collect, burn]
  const activeMc = buildUniswapV3NftExitCalldata({
    tokenId: 88888n,
    liquidity: 555_000_000n,
    recipient: USER,
    deadline: 1800000000n,
  });
  const decodedActive = decodeMulticallBytes(activeMc.data);
  assert.equal(decodedActive.length, 3);
  assert.ok(decodedActive[0].startsWith(DEFI_SELECTORS.decreaseLiquidity));
  assert.ok(decodedActive[1].startsWith(DEFI_SELECTORS.collect));
  assert.ok(decodedActive[2].startsWith(DEFI_SELECTORS.burnNft));
  assert.equal(BigInt('0x' + decodedActive[0].slice(10, 74)), 88888n); // tokenId
  assert.equal(BigInt('0x' + decodedActive[0].slice(74, 138)), 555_000_000n); // liquidity
  assert.equal(BigInt('0x' + decodedActive[2].slice(10, 74)), 88888n); // burn tokenId

  // 4c. Zero-liquidity / closed NFT position edge case -> omits decreaseLiquidity, builds [collect, burn]
  const closedMc = buildUniswapV3NftExitCalldata({
    tokenId: 99999n,
    liquidity: 0n,
    recipient: USER,
    deadline: 1800000000n,
  });
  const decodedClosed = decodeMulticallBytes(closedMc.data);
  assert.equal(decodedClosed.length, 2);
  assert.ok(decodedClosed[0].startsWith(DEFI_SELECTORS.collect));
  assert.ok(decodedClosed[1].startsWith(DEFI_SELECTORS.burnNft));

  const closedPlan = resolveDefiExitPlan({
    asset: mkAsset({
      protocol: 'Uniswap v3',
      protocolAddress: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      nftManagerAddress: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      nftTokenId: '99999',
      nftLiquidity: '0',
      rawBalance: '0',
      grossUsd: 0,
    }),
  });
  assert.equal(closedPlan.preflightStatus, 'warning');
  assert.ok(closedPlan.preflightReason.toLowerCase().includes('zero active liquidity'));
});

test('Backtest 5 — 1-Click Non-USDC Chaining (aWETH, cWETHv3, 1.18x ERC-4626 DAI, LP) & Live-Quote Haircut Gate Protection', async () => {
  const aWeth = mkAsset({
    id: 'eth:bt_aweth',
    address: '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8',
    symbol: 'aEthWETH',
    decimals: 18,
    protocol: 'Aave v3',
    protocolAddress: AAVE_V3_ETH,
    underlyingSymbol: 'WETH',
    underlyingAddress: WETH_ETH,
    rawBalance: (10n ** 18n).toString(),
    uiBalance: 1,
    priceUsd: 2600,
    grossUsd: 2600,
  });

  const cWeth = mkAsset({
    id: 'eth:bt_cweth',
    address: CWETH_V3_ETH,
    symbol: 'cWETHv3',
    decimals: 18,
    protocol: 'Compound v3',
    protocolAddress: CWETH_V3_ETH,
    underlyingSymbol: 'WETH',
    underlyingAddress: WETH_ETH,
    rawBalance: (5n * 10n ** 17n).toString(),
    uiBalance: 0.5,
    priceUsd: 2600,
    grossUsd: 1300,
  });

  const appreciatingDaiVault = mkAsset({
    id: 'eth:bt_yvdai',
    address: '0x4444444444444444444444444444444444444444',
    symbol: 'yvDAI',
    decimals: 18,
    protocol: 'Yearn v3 ERC-4626',
    protocolAddress: '0x4444444444444444444444444444444444444444',
    underlyingSymbol: 'DAI',
    underlyingAddress: DAI_ETH,
    rawBalance: (1000n * 10n ** 18n).toString(),
    uiBalance: 1000,
    priceUsd: 1.18,
    grossUsd: 1180,
    defiExitPlan: {
      protocolId: 'erc4626',
      protocolName: 'Yearn v3 ERC-4626',
      routeKind: 'protocol_unwind',
      exitStrategy: 'instant_1click_unwind',
      preflightStatus: 'verified',
      preflightReason: 'Yearn v3 DAI vault verified at 1.18x share rate.',
      plainEnglishSteps: ['Redeem 1000 yvDAI into 1180 DAI', 'Swap & bridge DAI to Solana USDC'],
      expectedUnderlyingRaw: (1180n * 10n ** 18n).toString(),
      expectedUnderlyingUi: 1180,
      underlyingSymbol: 'DAI',
      underlyingAddress: DAI_ETH,
      underlyingDecimals: 18,
      shareExchangeRate: 1.18,
    },
  });

  // 5a. Healthy batch chains ALL 3 non-USDC DeFi positions into 1 EIP-5792 confirmation & deduplicates WETH->Relay approvals!
  const goodBatch = await prepareChainBatchExecution({
    chain: 'ethereum',
    assets: [aWeth, cWeth, appreciatingDaiVault],
    userAddress: USER,
    solanaDestination: SOL_DEST,
    bundleDefiCctp: true,
    followUpQuoteFn: makeMockRelayQuote(0.008),
    aaveSafetyCheckFn: okAaveZeroDebt,
    compoundSafetyCheckFn: okCompZeroBorrow,
  });

  assert.equal(goodBatch.savings.walletPopupsEip5792, 1);
  assert.equal(goodBatch.chainedFollowUpPlans?.length, 3);
  assert.ok(goodBatch.chainedFollowUpPlans?.every((p) => p.bundledInCurrentBatch === true));
  assert.ok(goodBatch.savings.dedupedApprovals >= 1, 'Duplicate WETH->Relay approvals should deduplicate into 1');
  // Verify appreciating DAI vault chained exact 1,180 DAI (not 1,000 shares!)
  const daiFollowUp = goodBatch.chainedFollowUpPlans?.find((p) => p.sourceAssetId === 'eth:bt_yvdai');
  assert.equal(daiFollowUp?.unlockedAssets[0].expectedRawAmount, (1180n * 10n ** 18n).toString());

  // 5b. Live-Quote Haircut Gate protection: a 65% haircut follow-up quote MUST NEVER be bundled!
  const badHaircutBatch = await prepareChainBatchExecution({
    chain: 'ethereum',
    assets: [aWeth],
    userAddress: USER,
    solanaDestination: SOL_DEST,
    bundleDefiCctp: true,
    allowHighCost: false,
    followUpQuoteFn: makeMockRelayQuote(0.65), // 65% haircut!
    aaveSafetyCheckFn: okAaveZeroDebt,
  });
  assert.equal(badHaircutBatch.calls.length, 1, 'Only Aave withdraw should remain; >50% haircut bridge MUST be rejected');
  assert.equal(badHaircutBatch.chainedFollowUpPlans?.[0].bundledInCurrentBatch, false);
  assert.ok(
    badHaircutBatch.notes.some((n) => n.includes('Live Quote Haircut Gate')),
    'Must record Live Quote Haircut Gate rejection note'
  );
});

test('Backtest 6 — Live Mainnet Read-Only RPC Probe (sDAI, sUSDS, sUSDe, Morpho steakUSDC, Aave v3, Compound v2/v3, UniV2 LP)', async () => {
  // Gracefully handles RPC outages without failing offline CI while thoroughly verifying real mainnet bytecode when reachable!
  const [ethVaults, baseVaults, ethExpanded, baseExpanded, liveAave, liveCompV3] = await Promise.all([
    probeErc4626VaultStates({
      chain: 'ethereum',
      owner: VITALIK,
      vaults: [
        { address: SDAI_ETH, rawBalance: 10n ** 18n, decimals: 18, underlyingDecimals: 18 },
        { address: SUSDS_ETH, rawBalance: 10n ** 18n, decimals: 18, underlyingDecimals: 18 },
        { address: SUSDE_ETH, rawBalance: 10n ** 18n, decimals: 18, underlyingDecimals: 18 },
      ],
    }),
    probeErc4626VaultStates({
      chain: 'base',
      owner: VITALIK,
      vaults: [{ address: STEAK_USDC_BASE, rawBalance: 1000n * 10n ** 18n, decimals: 18, underlyingDecimals: 6 }],
    }),
    probeExpandedDefiContracts({
      chain: 'ethereum',
      tokenAddresses: [
        '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', // aEthUSDC
        CUSDC_V2_ETH, // Compound v2 cUSDC
        '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc', // Uniswap v2 WETH/USDC LP
      ],
    }),
    probeExpandedDefiContracts({
      chain: 'base',
      tokenAddresses: [
        '0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7', // aBasWETH
      ],
    }),
    checkAaveV3AccountSafety('ethereum', VITALIK),
    checkCompoundAccountSafety({
      chain: 'ethereum',
      userAddress: VITALIK,
      protocolId: 'compound_v3',
      targetAddress: CUSDC_V3_ETH,
    }),
  ]);

  // Ethereum ERC-4626 live assertions (when RPC responded)
  const sdai = ethVaults.get(SDAI_ETH.toLowerCase());
  if (sdai?.convertToAssetsRaw) {
    assert.equal(sdai.underlyingAddress, DAI_ETH.toLowerCase());
    assert.ok(sdai.shareExchangeRate > 1.05, `Expected sDAI rate > 1.05, got ${sdai.shareExchangeRate}`);
    assert.equal(sdai.cooldownDetected, false, 'Healthy sDAI must NOT false-positive cooldown for non-holder');
  }

  const susds = ethVaults.get(SUSDS_ETH.toLowerCase());
  if (susds?.convertToAssetsRaw) {
    assert.ok(susds.shareExchangeRate > 1.02, `Expected sUSDS rate > 1.02, got ${susds.shareExchangeRate}`);
    assert.equal(susds.cooldownDetected, false);
  }

  const susde = ethVaults.get(SUSDE_ETH.toLowerCase());
  if (susde?.convertToAssetsRaw) {
    assert.equal(susde.underlyingAddress, USDE_ETH.toLowerCase());
    assert.ok(susde.shareExchangeRate > 1.1, `Expected sUSDe rate > 1.1, got ${susde.shareExchangeRate}`);
    assert.ok((susde.cooldownDurationSec ?? 0) > 0, 'Live Ethena sUSDe must report positive cooldownDuration()');
    assert.equal(susde.cooldownDetected, true);
  }

  // Base Morpho steakUSDC live 18->6 decimal share-to-USDC check
  const steak = baseVaults.get(STEAK_USDC_BASE.toLowerCase());
  if (steak?.convertToAssetsRaw) {
    assert.equal(steak.underlyingAddress, USDC_BASE.toLowerCase());
    assert.ok(steak.convertToAssetsRaw > 1_000_000_000n, '1000 steakUSDC shares must convert to > 1000 USDC (6 dec)');
    assert.ok(steak.shareExchangeRate > 1.0);
    assert.equal(steak.cooldownDetected, false);
  }

  // Ethereum Aave v3, Compound v2 & Uniswap v2 live expanded probe checks
  const aEthUsdc = ethExpanded.get('0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c');
  if (aEthUsdc) {
    assert.equal(aEthUsdc.protocolId, 'aave_v3');
    assert.equal(aEthUsdc.protocolAddress.toLowerCase(), AAVE_V3_ETH.toLowerCase());
    assert.equal(aEthUsdc.underlyingAddress, USDC_ETH.toLowerCase());
  }

  const cUsdcV2 = ethExpanded.get(CUSDC_V2_ETH.toLowerCase());
  if (cUsdcV2) {
    assert.equal(cUsdcV2.protocolId, 'compound_v2');
    assert.equal(cUsdcV2.underlyingAddress, USDC_ETH.toLowerCase());
    assert.ok((cUsdcV2.exchangeRateStored ?? 0n) > 0n);
  }

  const uniV2 = ethExpanded.get('0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc');
  if (uniV2) {
    assert.equal(uniV2.protocolId, 'uniswap_v2_lp');
    assert.ok((uniV2.reserve0 ?? 0n) > 0n && (uniV2.reserve1 ?? 0n) > 0n);
  }

  const aBasWeth = baseExpanded.get('0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7');
  if (aBasWeth) {
    assert.equal(aBasWeth.protocolId, 'aave_v3');
    assert.equal(aBasWeth.underlyingAddress, WETH_BASE.toLowerCase());
  }

  // Live Aave v3 & Compound v3 safety RPCs return structured checked results
  assert.equal(typeof liveAave.checked, 'boolean');
  assert.equal(typeof liveCompV3.checked, 'boolean');
  if (liveCompV3.checked) {
    assert.equal(liveCompV3.hasActiveBorrow, false);
    assert.equal(liveCompV3.safeForWithdraw, true);
  }
});
