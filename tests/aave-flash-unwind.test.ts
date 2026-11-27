import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  buildAaveFlashUnwindPlan,
  CANONICAL_FLASH_SWAP_ROUTERS,
  encodeFlashUnwindMultiCalldata,
  encodeFlashUnwindSimpleCalldata,
  FLASH_UNWIND_SELECTORS,
  isTrustedFlashSwapRouter,
  type AavePoolFullPosition,
  type FlashSwapQuote,
} from '../src/defi/flash-unwind.js';
import { prepareRealExecution } from '../src/execution/tx-builder.js';
import type { ScannedAsset } from '../src/scanner/types.js';
import { createTurgaliumServer } from '../src/server/app.js';

const USER = '0xb7b570Dc117b4946925bc39166418516FB011CbB';
const SOL_DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const NEVERLAND_POOL = '0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585';
const MONAD_WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
const MONAD_SMON = '0xA3227C5969757783154C60bF0bC1944180ed81B9';
const MONAD_GMON = '0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081';
const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const NEVERLAND_NSMON = '0xa24e9a194a01655c13726c3102652936b87791b8';
const NEVERLAND_NGMON = '0x0f0f499403e40748b4739a07042f4722762a2d4e';
const NEVERLAND_NWMON = '0xd0fd2cf7f6ceff4f96b1161f5e995d5843326154';
const NEVERLAND_VDEBT_WMON = '0x3acA285b9F57832fF55f1e6835966890845c1526';
const DEPLOYED_FLASH_CONTRACT = '0x5555555555555555555555555555555555555555';

const MAX_UINT256 = (1n << 256n) - 1n;

const MOCK_NEVERLAND_POSITION: AavePoolFullPosition = {
  checked: true,
  chain: 'monad',
  poolAddress: NEVERLAND_POOL,
  userAddress: USER,
  reservesCount: 14,
  flashLoanPremiumBps: 50, // live Neverland 0.50% flash fee
  canRepayAllFromWallet: false,
  collaterals: [
    {
      asset: MONAD_SMON,
      symbol: 'sMON',
      decimals: 18,
      aTokenAddress: NEVERLAND_NSMON,
      aTokenBalanceRaw: 75_000n * 10n ** 18n,
      aTokenBalanceUi: 75_000,
      aTokenAllowanceRaw: 0n,
    },
    {
      asset: MONAD_GMON,
      symbol: 'gMON',
      decimals: 18,
      aTokenAddress: NEVERLAND_NGMON,
      aTokenBalanceRaw: 15_000n * 10n ** 18n,
      aTokenBalanceUi: 15_000,
      aTokenAllowanceRaw: 0n,
    },
  ],
  activeDebts: [
    {
      asset: MONAD_WMON,
      symbol: 'WMON',
      decimals: 18,
      aTokenAddress: NEVERLAND_NWMON,
      variableDebtToken: NEVERLAND_VDEBT_WMON,
      debtRaw: 82_453n * 10n ** 18n,
      debtUi: 82_453,
      walletBalanceRaw: 0n,
      walletBalanceUi: 0,
      allowanceRaw: 0n,
      canRepayFull: false,
      shortfallRaw: 82_660n * 10n ** 18n,
      shortfallUi: 82_660,
      repayCallAmountRaw: 0n,
      repayApproveAmountRaw: 0n,
      flashLiquidityRaw: 9_979_305n * 10n ** 18n,
      flashLiquidityUi: 9_979_305,
      flashPremiumBps: 50,
      flashPremiumRaw: 413n * 10n ** 18n,
      flashPremiumUi: 413,
      totalFlashRepayRaw: 82_866n * 10n ** 18n,
      totalFlashRepayUi: 82_866,
      hasSufficientFlashLiquidity: true,
    },
  ],
};

test('Flash-Unwind ABI encoders produce verified selectors & valid 32-byte-aligned calldata', () => {
  const simpleData = encodeFlashUnwindSimpleCalldata({
    pool: NEVERLAND_POOL,
    debtAsset: MONAD_WMON,
    debtAmount: MAX_UINT256,
    interestRateMode: 2n,
    collaterals: [
      { asset: MONAD_SMON, aTokenAmount: MAX_UINT256, minRemainingOut: 0n },
      { asset: MONAD_GMON, aTokenAmount: MAX_UINT256, minRemainingOut: 14_925n * 10n ** 18n },
    ],
    swaps: [
      {
        router: CANONICAL_FLASH_SWAP_ROUTERS.kyberswapV2,
        tokenIn: MONAD_SMON,
        tokenOut: MONAD_WMON,
        amountIn: 75_000n * 10n ** 18n,
        minAmountOut: 83_696n * 10n ** 18n,
        callData: '0xe21fd0e9deadbeef',
      },
    ],
    recipient: USER,
    minDebtSurplus: 0n,
    deadline: 1_900_000_000n,
  });

  assert.ok(simpleData.startsWith(FLASH_UNWIND_SELECTORS.unwindSimple));
  assert.equal((simpleData.length - 10) % 64, 0, 'simple calldata must be 32-byte word aligned');

  const multiData = encodeFlashUnwindMultiCalldata({
    pool: NEVERLAND_POOL,
    debtAssets: [MONAD_WMON, MONAD_USDC],
    debtAmounts: [MAX_UINT256, MAX_UINT256],
    interestRateModes: [2n, 2n],
    collaterals: [{ asset: MONAD_SMON, aTokenAmount: MAX_UINT256, minRemainingOut: 0n }],
    swaps: [],
    recipient: USER,
    minDebtSurpluses: [0n, 0n],
    deadline: 1_900_000_000n,
  });

  assert.ok(multiData.startsWith(FLASH_UNWIND_SELECTORS.unwindMulti));
  assert.equal((multiData.length - 10) % 64, 0, 'multi calldata must be 32-byte word aligned');

  assert.equal(isTrustedFlashSwapRouter('monad', CANONICAL_FLASH_SWAP_ROUTERS.kyberswapV2), true);
  assert.equal(isTrustedFlashSwapRouter('monad', CANONICAL_FLASH_SWAP_ROUTERS.lifiDiamondMonad), true);
  assert.equal(isTrustedFlashSwapRouter('ethereum', CANONICAL_FLASH_SWAP_ROUTERS.lifiDiamond), true);
  assert.equal(isTrustedFlashSwapRouter('monad', '0x1111111111111111111111111111111111111111'), false);
});

test('Flash-Unwind planner swaps ONLY sMON to clear 82,453 WMON debt & preserves 100% gMON + WMON surplus', async () => {
  const mockQuoter = async (p: { tokenIn: string; tokenOut: string; amountInRaw: bigint }): Promise<FlashSwapQuote | null> => {
    if (p.tokenIn.toLowerCase() === MONAD_SMON.toLowerCase()) {
      return {
        provider: 'kyberswap',
        router: CANONICAL_FLASH_SWAP_ROUTERS.kyberswapV2,
        tokenIn: MONAD_SMON,
        tokenInSymbol: 'sMON',
        tokenOut: MONAD_WMON,
        tokenOutSymbol: 'WMON',
        amountInRaw: p.amountInRaw,
        amountInUi: 75_000,
        expectedOutRaw: 84_542n * 10n ** 18n,
        expectedOutUi: 84_542,
        minAmountOutRaw: 83_696n * 10n ** 18n,
        minAmountOutUi: 83_696,
        callData: '0xe21fd0e900000001',
      };
    }
    return null;
  };

  const plan = await buildAaveFlashUnwindPlan({
    chain: 'monad',
    poolAddress: NEVERLAND_POOL,
    userAddress: USER,
    flashUnwindContractOverride: DEPLOYED_FLASH_CONTRACT,
    positionInspectorFn: async () => MOCK_NEVERLAND_POSITION,
    swapQuoterFn: mockQuoter,
    nowUnixSec: 1_800_000_000,
  });

  assert.equal(plan.checked, true);
  assert.equal(plan.supported, true);
  assert.equal(plan.mode, 'flash_universal');
  assert.equal(plan.previewOnly, false);
  assert.equal(plan.flashLoanPremiumBps, 50);
  // Only sMON is swapped; gMON stays 100% untouched!
  assert.equal(plan.swaps.length, 1);
  assert.equal(plan.swaps[0].tokenInSymbol, 'sMON');
  assert.equal(plan.collaterals.find((c) => c.symbol === 'sMON')?.willSwap, true);
  assert.equal(plan.collaterals.find((c) => c.symbol === 'gMON')?.willSwap, false);
  assert.equal(plan.collaterals.find((c) => c.symbol === 'gMON')?.estimatedRemainingUi, 15_000);
  // Net equity returned: ~1,676 WMON surplus + 15,000 gMON
  const wmonSurplus = plan.estimatedNetSurplus.find((s) => s.symbol === 'WMON');
  const gmonSurplus = plan.estimatedNetSurplus.find((s) => s.symbol === 'gMON');
  assert.ok(wmonSurplus && wmonSurplus.amountUi > 1_600);
  assert.equal(gmonSurplus?.amountUi, 15_000);
  // Emits 2 aToken approves + 1 atomic unwindUniversal tx
  assert.equal(plan.transactions.length, 3);
  assert.equal(plan.transactions[0].stepId, 'approve_atoken_smon');
  assert.equal(plan.transactions[1].stepId, 'approve_atoken_gmon');
  assert.equal(plan.transactions[2].stepId, 'aave_flash_unwind_universal');
  assert.equal(plan.transactions[2].to, DEPLOYED_FLASH_CONTRACT);
  assert.ok(plan.transactions[2].data.startsWith(FLASH_UNWIND_SELECTORS.unwindUniversal));
});

test('Flash-Unwind same-asset collateral + debt requires 0 DEX swaps and works across chains', async () => {
  const sameAssetPos: AavePoolFullPosition = {
    ...MOCK_NEVERLAND_POSITION,
    chain: 'base',
    poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    flashLoanPremiumBps: 5,
    collaterals: [
      {
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        symbol: 'USDC',
        decimals: 6,
        aTokenAddress: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
        aTokenBalanceRaw: 1_000_000_000n, // 1000 USDC
        aTokenBalanceUi: 1000,
        aTokenAllowanceRaw: MAX_UINT256, // already approved!
      },
    ],
    activeDebts: [
      {
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        symbol: 'USDC',
        decimals: 6,
        aTokenAddress: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
        variableDebtToken: '0x59dca05b6c26dbd64b5381374aAaC5CD05644C28',
        debtRaw: 800_000_000n,
        debtUi: 800,
        walletBalanceRaw: 0n,
        walletBalanceUi: 0,
        allowanceRaw: 0n,
        canRepayFull: false,
        shortfallRaw: 802_000_000n,
        shortfallUi: 802,
        repayCallAmountRaw: 0n,
        repayApproveAmountRaw: 0n,
        flashLiquidityRaw: 50_000_000_000_000n,
        flashLiquidityUi: 50_000_000,
        flashPremiumBps: 5,
        flashPremiumRaw: 400_001n,
        flashPremiumUi: 0.400001,
        totalFlashRepayRaw: 800_401_000n,
        totalFlashRepayUi: 800.401,
        hasSufficientFlashLiquidity: true,
      },
    ],
  };

  const plan = await buildAaveFlashUnwindPlan({
    chain: 'base',
    poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    userAddress: USER,
    flashUnwindContractOverride: DEPLOYED_FLASH_CONTRACT,
    positionInspectorFn: async () => sameAssetPos,
    swapQuoterFn: async () => {
      throw new Error('Should not call DEX quoter for same-asset collateral + debt');
    },
  });

  assert.equal(plan.supported, true);
  assert.equal(plan.mode, 'flash_universal');
  assert.equal(plan.swaps.length, 0);
  // Already approved -> literally 1 single tx!
  assert.equal(plan.transactions.length, 1);
  assert.equal(plan.transactions[0].stepId, 'aave_flash_unwind_universal');
  assert.ok(plan.estimatedNetSurplus[0].amountUi > 199);
});

test('prepareRealExecution seamlessly promotes blocked Aave V3 debt position to atomic Flash-Loan Self-Unwind', async () => {
  const nsmonAsset: ScannedAsset = {
    id: 'monad:neverland-nsmon',
    chain: 'monad',
    chainName: 'Monad',
    address: NEVERLAND_NSMON,
    symbol: 'nsMON',
    name: 'Neverland Monad sMON',
    decimals: 18,
    kind: 'defi_position',
    protocol: 'Neverland',
    protocolAddress: NEVERLAND_POOL,
    underlyingSymbol: 'sMON',
    underlyingAddress: MONAD_SMON,
    rawBalance: (75_000n * 10n ** 18n).toString(),
    uiBalance: 75_000,
    priceUsd: 0.0113,
    grossUsd: 852.26,
    liquidityUsd: 10_000_000,
    action: 'WITHDRAW_AND_BRIDGE',
    actionReason: 'Withdraw from Neverland on Monad',
    selectedByDefault: false,
    estimatedGasUsd: 0.01,
    batchedGasUsd: 0.01,
    estimatedSlippageUsd: 0.1,
    netUsdcSingle: 850,
    netUsdcBatched: 850,
    honeypotSafe: true,
  };

  const prepared = await prepareRealExecution({
    asset: nsmonAsset,
    userAddress: USER,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    aaveSafetyCheckFn: async () => ({
      checked: true,
      hasActiveDebt: true,
      safeForMaxWithdraw: false,
      totalCollateralUsd: 1020.58,
      totalDebtUsd: 857.05,
      availableBorrowsUsd: 0,
      currentLiquidationThresholdBps: 9000,
      healthFactor: 1.08,
      reason: 'Active debt on Neverland',
    }),
    aaveDebtInspectorFn: async () => ({
      checked: true,
      chain: 'monad',
      poolAddress: NEVERLAND_POOL,
      userAddress: USER,
      reservesCount: 14,
      canRepayAllFromWallet: false,
      activeDebts: MOCK_NEVERLAND_POSITION.activeDebts,
    }),
    aaveFlashUnwindPlannerFn: async (p) =>
      buildAaveFlashUnwindPlan({
        ...p,
        flashUnwindContractOverride: DEPLOYED_FLASH_CONTRACT,
        positionInspectorFn: async () => MOCK_NEVERLAND_POSITION,
        swapQuoterFn: async () => ({
          provider: 'kyberswap',
          router: CANONICAL_FLASH_SWAP_ROUTERS.kyberswapV2,
          tokenIn: MONAD_SMON,
          tokenInSymbol: 'sMON',
          tokenOut: MONAD_WMON,
          tokenOutSymbol: 'WMON',
          amountInRaw: 75_000n * 10n ** 18n,
          amountInUi: 75_000,
          expectedOutRaw: 84_542n * 10n ** 18n,
          expectedOutUi: 84_542,
          minAmountOutRaw: 83_696n * 10n ** 18n,
          minAmountOutUi: 83_696,
          callData: '0xe21fd0e900000001',
        }),
      }),
  });

  assert.equal(prepared.provider, 'aave_flash_unwind');
  assert.equal(prepared.transactions.length, 3);
  assert.equal(prepared.transactions[2].stepId, 'aave_flash_unwind_universal');
  assert.match(prepared.notes[0] ?? '', /Atomic Flash-Loan Self-Unwind/i);
});

test('All-forks registry validates Aave V3 forks, Aave V2, Compound V3, Compound V2 forks, and Morpho Blue', async () => {
  const { isAllowedLendingMarket } = await import('../src/defi/flash-unwind.js');
  // Aave V3 forks
  assert.equal(isAllowedLendingMarket('monad', 'aave_v3', NEVERLAND_POOL), true);
  assert.equal(isAllowedLendingMarket('hyperevm', 'aave_v3', '0xceCcE0EB9DD2Ef7996e01e25DD70e461F918A14b'), true); // HypurrFi
  assert.equal(isAllowedLendingMarket('bnb', 'aave_v3', '0xcB0620b181140e57D1C0D8b724cde623cA963c8C'), true); // Kinza
  assert.equal(isAllowedLendingMarket('linea', 'aave_v3', '0x2f9bB73a8e98793e26Cb2F6C4ad037BDf1C6B269'), true); // ZeroLend Linea
  assert.equal(isAllowedLendingMarket('zksync', 'aave_v3', '0x4d9429246EA989C9CeE203B43F6d1C7D83e3B8F8'), true); // ZeroLend zkSync
  // Aave V2
  assert.equal(isAllowedLendingMarket('ethereum', 'aave_v2', '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9'), true);
  assert.equal(isAllowedLendingMarket('polygon', 'aave_v2', '0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf'), true);
  // Compound V3
  assert.equal(isAllowedLendingMarket('base', 'compound_v3', '0xb125E6687d4313864e53df431d5425969c15Eb2F'), true);
  // Compound V2 forks (Moonwell, Venus, Benqi, Mendi)
  assert.equal(isAllowedLendingMarket('base', 'compound_v2', '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C'), true); // Moonwell Base
  assert.equal(isAllowedLendingMarket('optimism', 'compound_v2', '0xCa889f40aae37FFf165BccF69aeF1E82b5C511B9'), true); // Moonwell OP
  assert.equal(isAllowedLendingMarket('bnb', 'compound_v2', '0xfD36E2c2a6789Db23113685031d7F16329158384'), true); // Venus BNB
  assert.equal(isAllowedLendingMarket('avalanche', 'compound_v2', '0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4'), true); // Benqi
  assert.equal(isAllowedLendingMarket('linea', 'compound_v2', '0x1b4d3b0421dDc1eB216D230Bc01527422Fb93103'), true); // Mendi
  // Morpho Blue (0% flash loans + Morpho market unwinding)
  assert.equal(isAllowedLendingMarket('monad', 'morpho_blue', '0xD5D960E8C380B724a48AC59E2DfF1b2CB4a1eAee'), true);
  assert.equal(isAllowedLendingMarket('ethereum', 'morpho_blue', '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'), true);
  // Spoofed rejected across all families
  assert.equal(isAllowedLendingMarket('monad', 'aave_v3', '0x1111111111111111111111111111111111111111'), false);
  assert.equal(isAllowedLendingMarket('base', 'compound_v2', '0x1111111111111111111111111111111111111111'), false);
});

test('HTTP POST /api/defi/aave-flash-unwind-plan rejects spoofed pools fail-closed (400)', async () => {
  const app = createTurgaliumServer({ enableBackgroundPollers: false });
  const srv = app.server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/defi/aave-flash-unwind-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'monad',
        poolAddress: '0x1111111111111111111111111111111111111111',
        userAddress: USER,
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /No audited/i);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});

test('Unified gas: buildAaveFlashUnwindPlan reports 0-gas nativeGasStatus & valid EIP-712 sponsoredUnwind; submitSponsoredFlashUnwind verifies signature and fails closed', async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const { deriveEvmAddressFromPrivateKey } = await import('../src/relayer/broadcaster.js');
  const {
    computeSponsoredFlashUnwindDigest,
    FLASH_UNWIND_SELECTORS,
    hashUniversalUnwindParams,
    submitSponsoredFlashUnwind,
  } = await import('../src/defi/flash-unwind.js');

  const userPrivHex = '1111111111111111111111111111111111111111111111111111111111111111';
  const relayerPrivHex = '2222222222222222222222222222222222222222222222222222222222222222';
  const signerUser = deriveEvmAddressFromPrivateKey(userPrivHex);
  const relayerAddr = deriveEvmAddressFromPrivateKey(relayerPrivHex);

  const plan = await buildAaveFlashUnwindPlan({
    chain: 'monad',
    poolAddress: NEVERLAND_POOL,
    userAddress: signerUser,
    flashUnwindContractOverride: DEPLOYED_FLASH_CONTRACT,
    nowUnixSec: 1_800_000_000,
    positionInspectorFn: async () => ({
      ...MOCK_NEVERLAND_POSITION,
      userAddress: signerUser,
      collaterals: MOCK_NEVERLAND_POSITION.collaterals.map((c) => ({
        ...c,
        aTokenAllowanceRaw: (1n << 256n) - 1n, // already approved
      })),
    }),
    swapQuoterFn: async () => ({
      provider: 'kyberswap',
      router: CANONICAL_FLASH_SWAP_ROUTERS.kyberswapV2,
      tokenIn: MONAD_SMON,
      tokenInSymbol: 'sMON',
      tokenOut: MONAD_WMON,
      tokenOutSymbol: 'WMON',
      amountInRaw: 75_000n * 10n ** 18n,
      amountInUi: 75_000,
      expectedOutRaw: 84_542n * 10n ** 18n,
      expectedOutUi: 84_542,
      minAmountOutRaw: 83_696n * 10n ** 18n,
      minAmountOutUi: 83_696,
      callData: '0xe21fd0e900000001',
    }),
    rpcCallFn: async (_urls, method) => {
      if (method === 'eth_getBalance') {
        return { result: '0x0', rpcUrl: 'mock' } as any;
      }
      return { result: '0x', rpcUrl: 'mock' } as any;
    },
  });

  assert.equal(plan.supported, true);
  assert.ok(plan.nativeGasStatus, 'nativeGasStatus must be populated');
  assert.equal(plan.nativeGasStatus.hasEnoughGas, false, '0 MON must report hasEnoughGas=false');
  assert.equal(plan.nativeGasStatus.nativeBalanceWei, '0');
  assert.ok(plan.sponsoredUnwind, 'sponsoredUnwind payload must be generated');
  assert.ok(BigInt(plan.sponsoredUnwind.maxGasReimbursementRaw) > 0n);

  const sp = plan.sponsoredUnwind;
  // Sign EIP-712 digest with userPrivHex (low-s canonical)
  const digestBytes = Buffer.from(sp.eip712Digest.slice(2), 'hex');
  const sigObj = secp256k1.sign(digestBytes, Buffer.from(userPrivHex, 'hex'), { lowS: true });
  const sigHex =
    '0x' +
    sigObj.r.toString(16).padStart(64, '0') +
    sigObj.s.toString(16).padStart(64, '0') +
    (sigObj.recovery + 27).toString(16).padStart(2, '0');

  // Recompute paramsHash matches plan
  const recomputedHash = hashUniversalUnwindParams({
    ...sp.universalParams,
    debtAmount: BigInt(sp.universalParams.debtAmount),
    interestRateMode: BigInt(sp.universalParams.interestRateMode),
    collaterals: sp.universalParams.collaterals.map((c) => ({
      asset: c.asset,
      aTokenAmount: BigInt(c.aTokenAmount),
      minRemainingOut: BigInt(c.minRemainingOut),
    })),
    swaps: sp.universalParams.swaps.map((s) => ({
      router: s.router,
      tokenIn: s.tokenIn,
      tokenOut: s.tokenOut,
      amountIn: BigInt(s.amountIn),
      minAmountOut: BigInt(s.minAmountOut),
      callData: s.callData,
    })),
    minDebtSurplus: BigInt(sp.universalParams.minDebtSurplus),
    deadline: BigInt(sp.universalParams.deadline),
  });
  assert.equal(recomputedHash, sp.paramsHash);
  const recomputedDigest = computeSponsoredFlashUnwindDigest({
    chainId: 143,
    verifyingContract: DEPLOYED_FLASH_CONTRACT,
    user: signerUser,
    recipient: signerUser,
    paramsHash: sp.paramsHash,
    maxGasReimbursement: BigInt(sp.maxGasReimbursementRaw),
    nonce: BigInt(sp.nonce),
    deadline: BigInt(sp.deadline),
  });
  assert.equal(recomputedDigest.digest, sp.eip712Digest);

  let capturedCalldata = '';
  const submitRes = await submitSponsoredFlashUnwind({
    chain: 'monad',
    userAddress: signerUser,
    lendingFamily: 'aave_v3',
    universalParams: sp.universalParams,
    maxGasReimbursementRaw: sp.maxGasReimbursementRaw,
    gasReimbursementRaw: '1000000000000000000',
    nonce: sp.nonce,
    signature: sigHex,
    flashUnwindContractOverride: DEPLOYED_FLASH_CONTRACT,
    relayerPrivateKeyOverride: relayerPrivHex,
    nowUnixSec: 1_800_000_050,
    broadcasterFn: async (b) => {
      capturedCalldata = b.data ?? '';
      return {
        broadcasted: true,
        reasonCode: 'broadcasted',
        diagnostic: 'Mock broadcast succeeded',
        txHash: '0x' + 'ab'.repeat(32),
        relayerAddress: relayerAddr,
        nonce: 0,
        gasLimit: '800000',
        maxFeePerGasWei: '200000000000',
        maxPriorityFeePerGasWei: '2000000000',
      };
    },
  });

  assert.equal(submitRes.ok, true);
  assert.equal(submitRes.relayerAddress, relayerAddr);
  assert.ok(
    capturedCalldata.startsWith(FLASH_UNWIND_SELECTORS.unwindUniversalSponsored),
    `Calldata must start with unwindUniversalSponsored selector ${FLASH_UNWIND_SELECTORS.unwindUniversalSponsored}`
  );

  // Fail-closed: over-cap reimbursement rejected
  await assert.rejects(
    submitSponsoredFlashUnwind({
      chain: 'monad',
      userAddress: signerUser,
      lendingFamily: 'aave_v3',
      universalParams: sp.universalParams,
      maxGasReimbursementRaw: sp.maxGasReimbursementRaw,
      gasReimbursementRaw: (BigInt(sp.maxGasReimbursementRaw) + 1n).toString(),
      nonce: sp.nonce,
      signature: sigHex,
      flashUnwindContractOverride: DEPLOYED_FLASH_CONTRACT,
      relayerPrivateKeyOverride: relayerPrivHex,
      nowUnixSec: 1_800_000_050,
    }),
    /exceeds user-signed maxGasReimbursement/i
  );

  // Fail-closed: tampered recipient breaks signature verification
  await assert.rejects(
    submitSponsoredFlashUnwind({
      chain: 'monad',
      userAddress: signerUser,
      lendingFamily: 'aave_v3',
      universalParams: { ...sp.universalParams, recipient: '0x1111111111111111111111111111111111111111' },
      maxGasReimbursementRaw: sp.maxGasReimbursementRaw,
      nonce: sp.nonce,
      signature: sigHex,
      flashUnwindContractOverride: DEPLOYED_FLASH_CONTRACT,
      relayerPrivateKeyOverride: relayerPrivHex,
      nowUnixSec: 1_800_000_050,
    }),
    /Invalid EIP-712 SponsoredUnwindIntent signature/i
  );
});
