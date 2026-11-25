import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  buildMigrationPlan,
  CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_V2_FALLBACK_FAST_FEE_BPS,
  CCTP_V2_FAST_FINALITY_THRESHOLD,
  CCTP_V2_IRIS_FEES_BASE_URL,
  CCTP_V2_MAX_FEE_BPS_SAFETY_CAP,
  CCTP_V2_STANDARD_FINALITY_THRESHOLD,
  computeCctpV2MaxFeeRaw,
  encodeCctpDepositForBurn,
  fetchCctpV2BurnFee,
  solanaOwnerToUsdcAtaBytes32,
} from '../src/bridge/cctp.js';
import { deriveSolanaUsdcAtaBytes32Hex } from '../src/client/wallet-sdks.js';
import {
  CCTP_V2_MESSAGE_TRANSMITTER,
  CCTP_V2_TOKEN_MESSENGER,
  computePreservationFee,
  DEFAULT_PRESERVATION_FEE_CAP_USD,
  EVM_CHAINS,
  MIN_PRESERVATION_FEE_BPS,
  PRESERVATION_FEE_TIERS,
  resolvePreservationFeeBps,
  resolveProtocolFeeBps,
  SOLANA_CCTP_DOMAIN,
} from '../src/scanner/chains.js';
import { scanPresetWallet } from '../src/scanner/classifier.js';
import {
  computePreservationFee as computePreservationFeeFromRoi,
  evaluateAssetRoi,
  evaluateChainBatchRoi,
  evaluatePortfolioRoi,
} from '../src/scanner/roi.js';
import type { EvmChainId, ScannedAsset, ScanReport } from '../src/scanner/types.js';

const USER_SOL = 'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n';
const ATTACKER_SOL = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const USER_EVM = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';

const MAJOR_EVM_V2_CHAINS: EvmChainId[] = [
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'avalanche',
];

function decodeCctpV2Words(calldata: string) {
  assert.ok(calldata.startsWith(`0x${CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR}`), `Expected V2 selector 0x8e0250ee, got ${calldata.slice(0, 10)}`);
  assert.equal(calldata.length, 10 + 64 * 7, 'CCTP V2 depositForBurn must encode exactly 7 32-byte ABI words');
  const word = (idx: number) => calldata.slice(10 + idx * 64, 10 + (idx + 1) * 64);
  return {
    selector: calldata.slice(0, 10).toLowerCase(),
    amount: BigInt('0x' + word(0)),
    destinationDomain: Number(BigInt('0x' + word(1))),
    mintRecipient: '0x' + word(2).toLowerCase(),
    burnToken: '0x' + word(3).slice(24).toLowerCase(),
    destinationCaller: '0x' + word(4).toLowerCase(),
    maxFee: BigInt('0x' + word(5)),
    minFinalityThreshold: Number(BigInt('0x' + word(6))),
  };
}

function makeUsdcAsset(chain: EvmChainId, grossUsd: number): ScannedAsset {
  const cfg = EVM_CHAINS[chain];
  return {
    id: `${chain}:usdc:${grossUsd}`,
    family: 'evm',
    chain,
    chainName: cfg.name,
    address: cfg.usdcAddress,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    kind: 'erc20',
    rawBalance: BigInt(Math.round(grossUsd * 1_000_000)).toString(),
    uiBalance: grossUsd,
    priceUsd: 1,
    grossUsd,
    liquidityUsd: 100_000_000,
    estimatedGasUsd: chain === 'ethereum' ? 3.5 : 0.05,
    batchedGasUsd: chain === 'ethereum' ? 2.2 : 0.03,
    estimatedSlippageUsd: 0,
    netUsdcSingle: grossUsd,
    netUsdcBatched: grossUsd,
    action: 'BRIDGE_DIRECT_USDC',
    actionReason: 'Direct native USDC bridge',
    selectedByDefault: true,
    honeypotSafe: true,
  };
}

// ============================================================================
// 1. P0 BROWSER PRE-SIGN SECURITY BUG FIX (public/wallets.js:238)
// ============================================================================

test('P0 Security Fix: public/wallets.js catches spoofed mintRecipient & truncated calldata on 0x8e0250ee CCTP V2 burns', async () => {
  const walletsSource = fs.readFileSync(path.resolve('public/wallets.js'), 'utf8');
  assert.ok(
    walletsSource.includes("startsWith('0x8e0250ee')"),
    'public/wallets.js MUST check exact CCTP V2 selector 0x8e0250ee'
  );
  assert.ok(
    !walletsSource.includes('0x05285a08'),
    'Buggy legacy selector 0x05285a08 MUST be removed from public/wallets.js'
  );

  // Verify browser wallet-sdks ATA derivation matches server-side cctp.ts ATA PDA byte-for-byte
  const userAtaBytes32 = solanaOwnerToUsdcAtaBytes32(USER_SOL);
  const browserAtaBytes32 = deriveSolanaUsdcAtaBytes32Hex(USER_SOL);
  assert.equal(browserAtaBytes32.toLowerCase(), userAtaBytes32.toLowerCase());

  // Set up minimal browser window mock to execute real public/wallets.js exports
  class MockWindow extends EventTarget {
    location = { origin: 'http://127.0.0.1:3456' };
    localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    [key: string]: unknown;
  }
  const prevWindow = (globalThis as { window?: unknown }).window;
  const mockWindow = new MockWindow();
  (globalThis as { window?: unknown }).window = mockWindow;

  const rpcCalls: Array<{ method: string; params: unknown }> = [];
  const mockEvmProvider = {
    isMetaMask: true,
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      rpcCalls.push({ method, params });
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [USER_EVM];
      if (method === 'eth_chainId') return '0x2105'; // Base (8453)
      if (method === 'wallet_getCapabilities') return { '0x2105': { atomic: { status: 'supported' } } };
      if (method === 'eth_sendTransaction') return '0x' + '11'.repeat(32);
      if (method === 'wallet_sendCalls') return { id: 'batch_ok' };
      return null;
    },
    on: () => {},
    removeListener: () => {},
  };
  mockWindow.ethereum = mockEvmProvider;

  try {
    const walletsUrl = `${pathToFileURL(path.resolve('public/wallets.js')).href}?v2check=1`;
    const wallets = (await import(walletsUrl)) as {
      connectEvmWallet: (opts?: Record<string, unknown>) => Promise<{ address: string }>;
      disconnectEvmWallet: () => void;
      sendRealEvmTransaction: (tx: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<string>;
      sendEip5792Batch: (params: Record<string, unknown>) => Promise<{ batchId: string }>;
    };

    const conn = await wallets.connectEvmWallet();
    assert.equal(conn.address.toLowerCase(), USER_EVM.toLowerCase());

    const attackerAtaBytes32 = solanaOwnerToUsdcAtaBytes32(ATTACKER_SOL);
    const spoofedV2Calldata = encodeCctpDepositForBurn({
      rawUsdcAmount: 10_000_000_000n, // $10,000 USDC
      destinationDomain: SOLANA_CCTP_DOMAIN,
      solanaMintRecipientBytes32: attackerAtaBytes32,
      usdcAddress: EVM_CHAINS.base.usdcAddress,
      cctpVersion: 2,
      transferMode: 'fast',
      fastFeeBps: 1.3,
    });
    assert.ok(spoofedV2Calldata.startsWith('0x8e0250ee'));

    rpcCalls.length = 0;

    // 1. Legacy eth_sendTransaction path MUST block spoofed 0x8e0250ee mintRecipient before touching wallet!
    await assert.rejects(
      () =>
        wallets.sendRealEvmTransaction(
          {
            from: USER_EVM,
            to: CCTP_V2_TOKEN_MESSENGER,
            data: spoofedV2Calldata,
            value: '0x0',
            chainId: 8453,
          },
          { expectedFrom: USER_EVM, expectedSolanaDestination: USER_SOL }
        ),
      /Pre-sign check failed: CCTP depositForBurn mintRecipient does not match your Solana USDC ATA/
    );
    assert.equal(
      rpcCalls.some((c) => c.method === 'eth_sendTransaction'),
      false,
      'Spoofed CCTP V2 tx must NEVER reach eth_sendTransaction'
    );

    // 2. EIP-5792 wallet_sendCalls batch path MUST block spoofed 0x8e0250ee mintRecipient before signing!
    await assert.rejects(
      () =>
        wallets.sendEip5792Batch({
          chainId: 8453,
          expectedFrom: USER_EVM,
          expectedSolanaDestination: USER_SOL,
          calls: [
            {
              to: CCTP_V2_TOKEN_MESSENGER,
              data: spoofedV2Calldata,
              value: '0x0',
            },
          ],
        }),
      /Pre-sign check failed: CCTP depositForBurn mintRecipient does not match your Solana USDC ATA/
    );
    assert.equal(
      rpcCalls.some((c) => c.method === 'wallet_sendCalls'),
      false,
      'Spoofed CCTP V2 batch must NEVER reach wallet_sendCalls'
    );

    // 3. Truncated 0x8e0250ee V2 calldata (only 4 words instead of 7) MUST be rejected!
    const truncatedV2Calldata = spoofedV2Calldata.slice(0, 10 + 64 * 4);
    await assert.rejects(
      () =>
        wallets.sendRealEvmTransaction(
          {
            from: USER_EVM,
            to: CCTP_V2_TOKEN_MESSENGER,
            data: truncatedV2Calldata,
            value: '0x0',
            chainId: 8453,
          },
          { expectedFrom: USER_EVM, expectedSolanaDestination: USER_SOL }
        ),
      /truncated CCTP depositForBurn calldata/
    );

    wallets.disconnectEvmWallet();
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  }
});

// ============================================================================
// 2. CIRCLE CCTP V2 UPGRADE + FAST TRANSFER & LIVE FEE FETCHER
// ============================================================================

test('Circle CCTP V2 Upgrade: All 6 major EVM chains use canonical TokenMessengerV2/MessageTransmitterV2 and encode valid Fast vs Standard 7-arg calldata', async () => {
  const userAtaBytes32 = solanaOwnerToUsdcAtaBytes32(USER_SOL);
  const amount10k = 10_000_000_000n; // $10,000 USDC (6 decimals)

  // Ethereum finality upgraded from 780s (13m V1) to ~15s (V2 Fast Transfer)
  assert.ok(EVM_CHAINS.ethereum.cctpAttestationSec <= 20, `Expected ETH V2 fast attestation <= 20s, got ${EVM_CHAINS.ethereum.cctpAttestationSec}`);

  for (const chainId of MAJOR_EVM_V2_CHAINS) {
    const cfg = EVM_CHAINS[chainId];
    assert.equal(cfg.cctpVersion, 2, `${chainId} must be upgraded to CCTP V2`);
    assert.equal(cfg.cctpTokenMessenger, CCTP_V2_TOKEN_MESSENGER, `${chainId} must use canonical TokenMessengerV2`);
    assert.equal(cfg.cctpMessageTransmitter, CCTP_V2_MESSAGE_TRANSMITTER, `${chainId} must use canonical MessageTransmitterV2`);
    assert.ok(cfg.cctpDomain !== null, `${chainId} must have a valid Circle CCTP domain`);

    const fastBps = CCTP_V2_FALLBACK_FAST_FEE_BPS[cfg.cctpDomain];
    assert.ok(fastBps >= 1.0 && fastBps <= 1.5, `${chainId} fast fee bps should be ~1.0–1.4 bps`);

    // Fast Transfer mode (minFinalityThreshold = 1000, bounded maxFee > 0)
    const fastCalldata = encodeCctpDepositForBurn({
      rawUsdcAmount: amount10k,
      destinationDomain: SOLANA_CCTP_DOMAIN,
      solanaMintRecipientBytes32: userAtaBytes32,
      usdcAddress: cfg.usdcAddress,
      cctpVersion: 2,
      transferMode: 'fast',
      fastFeeBps: fastBps,
    });
    const decodedFast = decodeCctpV2Words(fastCalldata);
    assert.equal(decodedFast.amount, amount10k);
    assert.equal(decodedFast.destinationDomain, SOLANA_CCTP_DOMAIN);
    assert.equal(decodedFast.mintRecipient, userAtaBytes32);
    assert.equal(decodedFast.burnToken, cfg.usdcAddress.toLowerCase());
    assert.equal(decodedFast.minFinalityThreshold, CCTP_V2_FAST_FINALITY_THRESHOLD);
    assert.ok(decodedFast.maxFee > 0n && decodedFast.maxFee <= 1_500_000n, `${chainId} fast maxFee should be $1.00–$1.50 on $10k`);
    assert.ok(decodedFast.maxFee < amount10k);

    // Standard Transfer mode (minFinalityThreshold = 2000, maxFee = 0)
    const standardCalldata = encodeCctpDepositForBurn({
      rawUsdcAmount: amount10k,
      destinationDomain: SOLANA_CCTP_DOMAIN,
      solanaMintRecipientBytes32: userAtaBytes32,
      usdcAddress: cfg.usdcAddress,
      cctpVersion: 2,
      transferMode: 'standard',
    });
    const decodedStd = decodeCctpV2Words(standardCalldata);
    assert.equal(decodedStd.amount, amount10k);
    assert.equal(decodedStd.destinationDomain, SOLANA_CCTP_DOMAIN);
    assert.equal(decodedStd.mintRecipient, userAtaBytes32);
    assert.equal(decodedStd.burnToken, cfg.usdcAddress.toLowerCase());
    assert.equal(decodedStd.maxFee, 0n);
    assert.equal(decodedStd.minFinalityThreshold, CCTP_V2_STANDARD_FINALITY_THRESHOLD);
  }

  // Guardrail: reject maxFee >= rawUsdcAmount
  assert.throws(
    () =>
      encodeCctpDepositForBurn({
        rawUsdcAmount: 1_000_000n,
        destinationDomain: SOLANA_CCTP_DOMAIN,
        solanaMintRecipientBytes32: userAtaBytes32,
        usdcAddress: EVM_CHAINS.ethereum.usdcAddress,
        cctpVersion: 2,
        maxFee: 1_000_000n,
        minFinalityThreshold: 1000,
      }),
    /strictly less than rawUsdcAmount/
  );

  // buildMigrationPlan supports Fast Transfer mode on upgraded major chains
  const report = await scanPresetWallet('veteran_defi');
  const fastPlan = buildMigrationPlan({
    scan: report,
    solanaDestination: USER_SOL,
    cctpTransferMode: 'fast',
  });
  const baseLeg = fastPlan.legs.find((l) => l.chain === 'base');
  assert.ok(baseLeg && baseLeg.cctpCalldata !== '0x');
  const decodedBaseLeg = decodeCctpV2Words(baseLeg.cctpCalldata);
  assert.equal(decodedBaseLeg.minFinalityThreshold, 1000);
  assert.ok(decodedBaseLeg.maxFee > 0n);
});

test('fetchCctpV2BurnFee queries Circle /v2/burn/USDC/fees/{src}/{dst}, enforces safety ceiling, and falls back gracefully', async () => {
  const seenUrls: string[] = [];
  const liveFetcher: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seenUrls.push(url);
    return new Response(
      JSON.stringify([
        {
          finalityThreshold: 1000,
          minimumFee: 1.3,
          forwardFee: { low: 90, medium: 110, high: 160 },
        },
        {
          finalityThreshold: 2000,
          minimumFee: 0,
          forwardFee: { low: 90, medium: 110, high: 160 },
        },
      ]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  // 1. Live Fast Transfer quote (Base domain 6 -> Solana domain 5)
  const fastQuote = await fetchCctpV2BurnFee({
    sourceDomain: 6,
    destinationDomain: SOLANA_CCTP_DOMAIN,
    mode: 'fast',
    rawUsdcAmount: 10_000_000_000n, // $10,000
    fetcher: liveFetcher,
  });
  assert.equal(seenUrls[0], `${CCTP_V2_IRIS_FEES_BASE_URL}/6/5`);
  assert.equal(fastQuote.source, 'circle_iris_live');
  assert.equal(fastQuote.mode, 'fast');
  assert.equal(fastQuote.minFinalityThreshold, 1000);
  assert.equal(fastQuote.feeBps, 1.3);
  assert.equal(fastQuote.forwardFeeUsdc6, 110);
  assert.equal(fastQuote.maxFeeRaw, 1_300_000n); // Exact $1.30 on $10,000

  // 2. Live Standard Transfer quote (0 bps, threshold 2000)
  const stdQuote = await fetchCctpV2BurnFee({
    sourceDomain: 0,
    destinationDomain: SOLANA_CCTP_DOMAIN,
    mode: 'standard',
    rawUsdcAmount: 100_000_000_000n, // $100,000
    fetcher: liveFetcher,
  });
  assert.equal(stdQuote.source, 'circle_iris_live');
  assert.equal(stdQuote.minFinalityThreshold, 2000);
  assert.equal(stdQuote.feeBps, 0);
  assert.equal(stdQuote.maxFeeRaw, 0n);

  // 3. Adversarial safety cap: spoofed/corrupted upstream 5000 bps (50%) is capped at 50 bps (0.50%)
  const spoofedFetcher: typeof fetch = async () =>
    new Response(JSON.stringify([{ finalityThreshold: 1000, minimumFee: 5000 }]), { status: 200 });
  const cappedQuote = await fetchCctpV2BurnFee({
    sourceDomain: 0,
    mode: 'fast',
    rawUsdcAmount: 10_000_000_000n,
    fetcher: spoofedFetcher,
  });
  assert.equal(cappedQuote.feeBps, CCTP_V2_MAX_FEE_BPS_SAFETY_CAP);
  assert.equal(cappedQuote.maxFeeRaw, 50_000_000n); // Capped at $50 (0.50%), never $5,000!

  // 4. Network error / HTTP 503 graceful fallback (Ethereum domain 0 -> 1.0 bps)
  const failingFetcher: typeof fetch = async () => {
    throw new Error('ECONNRESET');
  };
  const fallbackFast = await fetchCctpV2BurnFee({
    sourceDomain: 0,
    mode: 'fast',
    rawUsdcAmount: 10_000_000_000n,
    fetcher: failingFetcher,
  });
  assert.equal(fallbackFast.source, 'fallback');
  assert.equal(fallbackFast.minFinalityThreshold, 1000);
  assert.equal(fallbackFast.feeBps, 1.0);
  assert.equal(fallbackFast.maxFeeRaw, 1_000_000n); // $1.00 on $10,000

  const fallbackStd = await fetchCctpV2BurnFee({
    sourceDomain: 0,
    mode: 'standard',
    rawUsdcAmount: 10_000_000_000n,
    fetcher: failingFetcher,
  });
  assert.equal(fallbackStd.source, 'fallback');
  assert.equal(fallbackStd.minFinalityThreshold, 2000);
  assert.equal(fallbackStd.feeBps, 0);
  assert.equal(fallbackStd.maxFeeRaw, 0n);

  // 5. computeCctpV2MaxFeeRaw math edge cases
  assert.equal(computeCctpV2MaxFeeRaw(0n, 1.4), 0n);
  assert.equal(computeCctpV2MaxFeeRaw(10_000_000_000n, 0), 0n);
  assert.equal(computeCctpV2MaxFeeRaw(10_000_000_000n, 1.4), 1_400_000n);
  assert.equal(computeCctpV2MaxFeeRaw(10n, 1.4), 1n); // Rounds up safely, stays < rawUsdcAmount
});

// ============================================================================
// 3. PRESERVATION-FIRST TIERED PROTOCOL FEE ENGINE
// ============================================================================

test('Preservation Fee Engine: preserves >= 99.5% on $10k and $100k (saving +$675 to +$6,950 vs flat 7%) and keeps resolveProtocolFeeBps backwards-compatible', () => {
  // Re-export parity between chains.ts and roi.ts
  assert.equal(computePreservationFee, computePreservationFeeFromRoi);
  assert.equal(MIN_PRESERVATION_FEE_BPS, 0);
  assert.equal(DEFAULT_PRESERVATION_FEE_CAP_USD, 50);
  assert.equal(PRESERVATION_FEE_TIERS.length, 4);

  // Tier 1: Micro-dust (<$50) -> 500 bps (5%)
  const dust = computePreservationFee(20);
  assert.equal(dust.tierId, 'dust');
  assert.equal(dust.nominalFeeBps, 500);
  assert.equal(dust.feeUsd, 1.0);
  assert.equal(dust.netAfterFeeUsd, 19.0);
  assert.equal(dust.capitalPreservedPct, 95);

  // Tier 2: Small ($50–$500) -> 100 bps (1%)
  const small = computePreservationFee(250);
  assert.equal(small.tierId, 'small');
  assert.equal(small.nominalFeeBps, 100);
  assert.equal(small.feeUsd, 2.5);
  assert.equal(small.capitalPreservedPct, 99);

  // Tier 3: Mid ($500–$5,000) -> 25 bps (0.25%)
  const mid = computePreservationFee(2_000);
  assert.equal(mid.tierId, 'growth');
  assert.equal(mid.nominalFeeBps, 25);
  assert.equal(mid.feeUsd, 5.0);
  assert.equal(mid.capitalPreservedPct, 99.75);

  // Tier 4a: Principal $10,000 -> 10 bps = $10 (99.9% preserved, +$690 saved vs flat 7% $700)
  const p10k = computePreservationFee(10_000);
  assert.equal(p10k.tierId, 'principal');
  assert.equal(p10k.nominalFeeBps, 10);
  assert.equal(p10k.feeUsd, 10);
  assert.equal(p10k.capApplied, false);
  assert.ok(p10k.capitalPreservedPct >= 99.5, `Expected >= 99.5% preserved on $10k, got ${p10k.capitalPreservedPct}%`);
  assert.equal(p10k.baselineFlatFeeUsd, 700);
  assert.equal(p10k.savingsVsFlat7PctUsd, 690);
  assert.ok(p10k.savingsVsFlat7PctUsd >= 675);

  // Tier 4b: Principal $100,000 -> 10 bps ($100) capped at $50 hard ceiling (99.95% preserved, +$6,950 saved vs flat 7% $7,000!)
  const p100k = computePreservationFee(100_000);
  assert.equal(p100k.tierId, 'principal');
  assert.equal(p100k.nominalFeeBps, 10);
  assert.equal(p100k.capApplied, true);
  assert.equal(p100k.feeCapUsd, 50);
  assert.equal(p100k.feeUsd, 50);
  assert.equal(p100k.effectiveFeeBps, 5);
  assert.equal(p100k.netAfterFeeUsd, 99_950);
  assert.ok(p100k.capitalPreservedPct >= 99.5, `Expected >= 99.5% preserved on $100k, got ${p100k.capitalPreservedPct}%`);
  assert.equal(p100k.baselineFlatFeeUsd, 7_000);
  assert.equal(p100k.savingsVsFlat7PctUsd, 6_950);
  assert.equal(p100k.savingsVsFlat7PctBps, 695);

  // Custom $25 hard ceiling on $100k -> $25 fee, 99.975% preserved, +$6,975 saved
  const p100kCap25 = computePreservationFee(100_000, { maxFeeUsdCap: 25 });
  assert.equal(p100kCap25.capApplied, true);
  assert.equal(p100kCap25.feeUsd, 25);
  assert.equal(p100kCap25.savingsVsFlat7PctUsd, 6_975);
  assert.ok(p100kCap25.capitalPreservedPct >= 99.9);

  // Zero-fee modes: self-custody & partner-subsidized -> 0 bps, 100% preserved
  const selfCustody = computePreservationFee(50_000, { mode: 'self_custody' });
  assert.equal(selfCustody.tierId, 'self_custody_zero');
  assert.equal(selfCustody.effectiveFeeBps, 0);
  assert.equal(selfCustody.feeUsd, 0);
  assert.equal(selfCustody.capitalPreservedPct, 100);
  assert.equal(selfCustody.savingsVsFlat7PctUsd, 3_500);

  const partnerSub = computePreservationFee(10_000, { mode: 'partner_subsidized' });
  assert.equal(partnerSub.tierId, 'partner_subsidized_zero');
  assert.equal(partnerSub.feeUsd, 0);
  assert.equal(partnerSub.capitalPreservedPct, 100);

  // Fail-safe edge cases (0, negative, NaN, Infinity)
  for (const bad of [0, -500, Number.NaN, Number.POSITIVE_INFINITY]) {
    const res = computePreservationFee(bad);
    assert.equal(res.tierId, 'zero');
    assert.equal(res.feeUsd, 0);
    assert.equal(res.netAfterFeeUsd, 0);
  }

  // Backwards compatibility of legacy resolveProtocolFeeBps() (tests/siphon.test.ts invariants!)
  assert.equal(resolveProtocolFeeBps(undefined), 700);
  assert.equal(resolveProtocolFeeBps(100), 500);
  assert.equal(resolveProtocolFeeBps(750), 750);
  assert.equal(resolveProtocolFeeBps(2500), 1000);

  // New resolvePreservationFeeBps() allows 0..1000 bps
  assert.equal(resolvePreservationFeeBps(0), 0);
  assert.equal(resolvePreservationFeeBps(10), 10);
  assert.equal(resolvePreservationFeeBps(-50), 0);
  assert.equal(resolvePreservationFeeBps(2500), 1000);
});

test('ROI Engine integration: feeSchedule "tiered" preserves >= 99.5% net on $10k and $100k chain & portfolio evaluations', () => {
  const usdc10k = makeUsdcAsset('base', 10_000);
  const usdc100k = makeUsdcAsset('ethereum', 100_000);

  // Level 1 asset ROI with tiered fee vs legacy flat 7%
  const flatEv = evaluateAssetRoi(usdc10k, { protocolFeeBps: 700 });
  const tieredEv = evaluateAssetRoi(usdc10k, { feeSchedule: 'tiered' });
  assert.equal(flatEv.protocolFeeUsd, 700);
  assert.equal(tieredEv.protocolFeeUsd, 10);
  assert.ok(tieredEv.netRoiUsd > 9_980, `Expected >$9,980 net on $10k tiered, got $${tieredEv.netRoiUsd}`);
  assert.ok(tieredEv.effectiveCostPct < 0.5, `Expected <0.5% total cost on $10k tiered, got ${tieredEv.effectiveCostPct}%`);

  // Level 2 chain batch ROI on $100k Ethereum USDC with tiered fee (capped at $50)
  const ethBatch = evaluateChainBatchRoi({
    chain: 'ethereum',
    assets: [usdc100k],
    feeSchedule: 'tiered',
    gasSponsored: false,
    hasSolanaUsdcAta: true,
  });
  assert.equal(ethBatch.protocolFeeUsd, 50);
  assert.equal(ethBatch.preservationFee?.capApplied, true);
  assert.equal(ethBatch.preservationFee?.savingsVsFlat7PctUsd, 6_950);
  assert.ok(ethBatch.chainLegNetUsd / ethBatch.keptGrossUsd >= 0.995);

  // Portfolio ROI passthrough with tiered schedule
  const mockReport: ScanReport = {
    scanId: 'scan_tiered_test',
    family: 'evm',
    mode: 'preset',
    walletAddress: USER_EVM,
    scannedAt: new Date().toISOString(),
    scanDurationMs: 1,
    chainsScanned: 2,
    chains: [
      {
        chain: 'base',
        chainName: 'Base',
        chainId: 8453,
        cctpDomain: 6,
        rpcStatus: 'preset',
        blockNumber: 1,
        gasPriceGwei: 0.05,
        nativeBalance: 1,
        nativeSymbol: 'ETH',
        nativePriceUsd: 2500,
        assetCount: 1,
        defiCount: 0,
        liquidCount: 1,
        burnCount: 0,
        skippedCount: 0,
        grossUsd: 10_000,
        netUsdcBridged: 10_000,
        totalGasUsd: 0.03,
        gasSavedByBatchUsd: 0.02,
        cctpAttestationSec: 12,
        needsGasSponsorship: false,
      },
      {
        chain: 'ethereum',
        chainName: 'Ethereum',
        chainId: 1,
        cctpDomain: 0,
        rpcStatus: 'preset',
        blockNumber: 1,
        gasPriceGwei: 12,
        nativeBalance: 1,
        nativeSymbol: 'ETH',
        nativePriceUsd: 2500,
        assetCount: 1,
        defiCount: 0,
        liquidCount: 1,
        burnCount: 0,
        skippedCount: 0,
        grossUsd: 100_000,
        netUsdcBridged: 100_000,
        totalGasUsd: 2.2,
        gasSavedByBatchUsd: 1.3,
        cctpAttestationSec: 15,
        needsGasSponsorship: false,
      },
    ],
    assets: [usdc10k, usdc100k],
    totals: {
      grossUsd: 110_000,
      defiGrossUsd: 0,
      liquidGrossUsd: 110_000,
      protocolFeeBps: 700,
      protocolFeeUsd: 0,
      singleTxGasUsd: 3.55,
      batchedGasUsd: 2.23,
      gasSavedUsd: 1.32,
      estimatedSlippageUsd: 0,
      netSolanaUsdc: 110_000,
      solEquivalent: 733,
      solPriceUsd: 150,
      defiPositionCount: 0,
      liquidDustCount: 2,
      burnCandidateCount: 0,
      honeypotSkippedCount: 0,
      gasNegativeCount: 0,
    },
    warnings: [],
  };

  const portfolio = evaluatePortfolioRoi(mockReport, {
    feeSchedule: 'tiered',
    hasSolanaUsdcAta: true,
  });
  assert.equal(portfolio.totalProtocolFeeUsd, 60); // $10 on $10k Base + $50 capped on $100k ETH
  assert.ok(portfolio.totalSignedUserNetUsd / portfolio.totalGrossUsd >= 0.995);
});
