import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  buildAaveRepayPreSteps,
  encodeAaveV3RepayCalldata,
  AAVE_V3_UNWIND_SELECTORS,
  type AavePoolDebtInspection,
} from '../src/defi/aave-unwind.js';
import {
  identifyProtocolExtractorId,
  isAllowedAaveV3Pool,
} from '../src/defi/extractors.js';
import { prepareRealExecution } from '../src/execution/tx-builder.js';
import { EVM_CHAINS, TOKEN_REGISTRY } from '../src/scanner/chains.js';
import type { ScannedAsset } from '../src/scanner/types.js';
import { createTurgaliumServer } from '../src/server/app.js';

const USER_ADDR = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const SOL_DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const NEVERLAND_POOL = '0x80F00661b13CC5F6ccd3885bE7b4C9c67545D585';
const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const MONAD_WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
const NEVERLAND_NWMON = '0xd0fd2cf7f6ceff4f96b1161f5e995d5843326154';

const NEVERLAND_DEFI_ASSET: ScannedAsset = {
  id: 'monad:neverland-nwmon',
  chain: 'monad',
  chainName: 'Monad',
  address: NEVERLAND_NWMON,
  symbol: 'nWMON',
  name: 'Neverland Monad WMON',
  decimals: 18,
  kind: 'defi_position',
  protocol: 'Neverland',
  protocolAddress: NEVERLAND_POOL,
  underlyingSymbol: 'WMON',
  underlyingAddress: MONAD_WMON,
  rawBalance: '500000000000000000000', // 500 WMON
  uiBalance: 500,
  priceUsd: 0.5,
  grossUsd: 250,
  liquidityUsd: 10_000_000,
  action: 'WITHDRAW_AND_BRIDGE',
  actionReason: 'Withdraw from Neverland on Monad',
  selectedByDefault: true,
  estimatedGasUsd: 0.01,
  batchedGasUsd: 0.01,
  estimatedSlippageUsd: 0.1,
  netUsdcSingle: 249.5,
  netUsdcBatched: 249.5,
  honeypotSafe: true,
};

test('Wave 25: Monad Mainnet (143) & all 14 Neverland reserves + cross-chain Aave V3 forks are registered and trusted', () => {
  assert.equal(EVM_CHAINS.monad.chainId, 143);
  assert.equal(EVM_CHAINS.monad.nativeSymbol, 'MON');
  assert.equal(EVM_CHAINS.monad.aaveV3Pool, NEVERLAND_POOL);

  const neverlandTokens = TOKEN_REGISTRY.filter(
    (t) => t.chain === 'monad' && t.kind === 'defi_position' && t.protocol === 'Neverland'
  );
  assert.equal(neverlandTokens.length, 14, 'All 14 live Neverland reserves must be registered');

  assert.equal(identifyProtocolExtractorId(NEVERLAND_DEFI_ASSET), 'aave_v3');
  assert.equal(isAllowedAaveV3Pool('monad', NEVERLAND_POOL), true);
  assert.equal(isAllowedAaveV3Pool('ethereum', '0xC13e21B648A5Ee794902342038FF3aDAB66BE987'), true); // SparkLend
  assert.equal(isAllowedAaveV3Pool('base', '0x8F44Fd754285aa6A2b8B9B97739B79746e0475a7'), true); // Seamless
  assert.equal(isAllowedAaveV3Pool('mantle', '0xCFa5aE7c2CE8Fadc6426C1ff872cA45378Fb7cF3'), true); // Lendle
  assert.equal(isAllowedAaveV3Pool('gnosis', '0x2Dae5307c5E3FD1CF5A72Cb6F698f915860607e0'), true); // SparkLend Gnosis
  assert.equal(isAllowedAaveV3Pool('hyperevm', '0x00A89d7a5A02160f20150EbEA7a2b5E4879A1A8b'), true); // Hyperlend
  assert.equal(isAllowedAaveV3Pool('monad', '0x1111111111111111111111111111111111111111'), false); // Spoofed rejected
});

test('Wave 25: Universal Aave V3 / Neverland 1-Click Repay + Full Withdraw prepends Approve + Pool.repay before Pool.withdraw', async () => {
  const repayCall = encodeAaveV3RepayCalldata({
    asset: MONAD_USDC,
    amount: (1n << 256n) - 1n,
    interestRateMode: 2n,
    onBehalfOf: USER_ADDR,
  });
  assert.ok(repayCall.startsWith(AAVE_V3_UNWIND_SELECTORS.repay));
  assert.equal(repayCall.length, 2 + 8 + 64 * 4);

  const mockInspection: AavePoolDebtInspection = {
    checked: true,
    chain: 'monad',
    poolAddress: NEVERLAND_POOL,
    userAddress: USER_ADDR,
    reservesCount: 14,
    canRepayAllFromWallet: true,
    activeDebts: [
      {
        asset: MONAD_USDC,
        symbol: 'USDC',
        decimals: 6,
        aTokenAddress: '0x38648958836ea88b368b4ac23b86ad44b0fe7508',
        variableDebtToken: '0xb26fb5e35f6527d6f878f7784ea71774595b249c',
        debtRaw: 100_000_000n, // 100 USDC debt
        debtUi: 100,
        walletBalanceRaw: 120_000_000n, // 120 USDC in wallet
        walletBalanceUi: 120,
        allowanceRaw: 0n,
        canRepayFull: true,
        shortfallRaw: 0n,
        shortfallUi: 0,
        repayCallAmountRaw: (1n << 256n) - 1n,
        repayApproveAmountRaw: 100_250_001n,
      },
    ],
  };

  const preSteps = buildAaveRepayPreSteps({
    chain: 'monad',
    poolAddress: NEVERLAND_POOL,
    protocolName: 'Neverland',
    userAddress: USER_ADDR,
    activeDebts: mockInspection.activeDebts,
  });
  assert.equal(preSteps.length, 2);
  assert.equal(preSteps[0].stepId, 'approve_repay_usdc');
  assert.equal(preSteps[1].stepId, 'aave_repay_usdc');
  assert.equal(preSteps[1].to, NEVERLAND_POOL);

  const prepared = await prepareRealExecution({
    asset: NEVERLAND_DEFI_ASSET,
    userAddress: USER_ADDR,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    aaveSafetyCheckFn: async () => ({
      checked: true,
      hasActiveDebt: true,
      safeForMaxWithdraw: false,
      totalCollateralUsd: 250,
      totalDebtUsd: 100,
      availableBorrowsUsd: 50,
      currentLiquidationThresholdBps: 7500,
      healthFactor: 1.4, // Too tight for safe partial withdraw (min 1.6), but wallet holds 120 USDC!
      reason: 'Active debt on Neverland',
    }),
    aaveDebtInspectorFn: async () => mockInspection,
  });

  assert.equal(prepared.chain, 'monad');
  assert.equal(prepared.chainId, 143);
  assert.equal(prepared.transactions.length, 3, 'Should emit Approve -> Repay -> Full Withdraw');
  assert.equal(prepared.transactions[0].stepId, 'approve_repay_usdc');
  assert.equal(prepared.transactions[1].stepId, 'aave_repay_usdc');
  assert.equal(prepared.transactions[2].stepId, 'aave_withdraw');
  assert.match(prepared.notes[0] ?? '', /1-Click Repay \+ Full Withdraw/i);
});

test('Wave 25: When wallet lacks debt token, safety guard blocks liquidation and prints exact shortfall needed', async () => {
  await assert.rejects(
    () =>
      prepareRealExecution({
        asset: NEVERLAND_DEFI_ASSET,
        userAddress: USER_ADDR,
        solanaDestination: SOL_DEST,
        outputAsset: 'USDC',
        aaveSafetyCheckFn: async () => ({
          checked: true,
          hasActiveDebt: true,
          safeForMaxWithdraw: false,
          totalCollateralUsd: 250,
          totalDebtUsd: 150,
          availableBorrowsUsd: 0,
          currentLiquidationThresholdBps: 7500,
          healthFactor: 1.25,
          reason: 'Active debt on Neverland',
        }),
        aaveDebtInspectorFn: async () => ({
          checked: true,
          chain: 'monad',
          poolAddress: NEVERLAND_POOL,
          userAddress: USER_ADDR,
          reservesCount: 14,
          canRepayAllFromWallet: false,
          activeDebts: [
            {
              asset: MONAD_USDC,
              symbol: 'USDC',
              decimals: 6,
              aTokenAddress: '0x38648958836ea88b368b4ac23b86ad44b0fe7508',
              variableDebtToken: '0xb26fb5e35f6527d6f878f7784ea71774595b249c',
              debtRaw: 150_000_000n,
              debtUi: 150,
              walletBalanceRaw: 20_000_000n,
              walletBalanceUi: 20,
              allowanceRaw: 0n,
              canRepayFull: false,
              shortfallRaw: 130_375_001n,
              shortfallUi: 130.375001,
              repayCallAmountRaw: 20_000_000n,
              repayApproveAmountRaw: 20_000_000n,
            },
          ],
        }),
      }),
    /Hold 130\.375001 USDC on Monad to unlock 1-Click Repay \+ Full Withdraw/i
  );
});

test('Wave 25: HTTP POST /api/defi/aave-unwind-plan rejects spoofed pools fail-closed (400)', async () => {
  const app = createTurgaliumServer({ enableBackgroundPollers: false });
  const srv = app.server;
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const badRes = await fetch(`http://127.0.0.1:${port}/api/defi/aave-unwind-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'monad',
        poolAddress: '0x1111111111111111111111111111111111111111',
        userAddress: USER_ADDR,
      }),
    });
    assert.equal(badRes.status, 400);
    const body = (await badRes.json()) as { error: string };
    assert.match(body.error, /No audited Aave v3/i);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
});
