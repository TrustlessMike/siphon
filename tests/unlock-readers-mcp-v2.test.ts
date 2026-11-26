import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3';
import { TurgaliumAgentEngine } from '../src/agent/mandate-engine.js';
import {
  buildChatGptOpenApiSpec,
  buildOpenApiSpec,
} from '../src/agent/plugin-spec.js';
import {
  SOLANA_EMPTY_ATA_RENT_LAMPORTS,
  SOLANA_EMPTY_ATA_RENT_SOL,
  type SolanaRentScanResult,
} from '../src/bridge/solana-rent.js';
import {
  decodeEthenaCooldown,
  decodeLidoWithdrawalRequestIds,
  decodeLidoWithdrawalStatuses,
  encodeEthenaCooldownsCall,
  encodeLidoGetWithdrawalRequestsCall,
  encodeLidoGetWithdrawalStatusCall,
  ETHENA_SUSDE_ADDRESS,
  LIDO_WITHDRAWAL_QUEUE_ADDRESS,
  parseCosmosUnbondingDelegations,
  readCosmosUnbondingDelegations,
  readEthenaSusdeCooldown,
  readLidoWithdrawalQueue,
  readLiveUnlockQueues,
  UNLOCK_READER_SELECTORS,
  type EvmEthCallFn,
} from '../src/defi/unlock-readers.js';
import { JupiterMarketsClient } from '../src/degen/jupiter-markets.js';
import {
  evaluatePreservationPlan,
  mergeUnlockSchedule,
} from '../src/execution/preservation-optimizer.js';
import {
  handleMcpJsonRpc,
  handleMcpRequest,
  TURGALIUM_MCP_TOOLS,
  type McpToolContext,
} from '../src/mcp/server.js';
import { encodeBech32Strict, decodeBech32Strict } from '../src/scanner/address.js';
import { EVM_CHAINS } from '../src/scanner/chains.js';
import type { ScannedAsset, ScanReport } from '../src/scanner/types.js';
import { BoundedTtlCache } from '../src/server/cache.js';

const EVM_WALLET = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const SOL_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const COSMOS_HUB_ADDR = 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh';
const OSMO_ADDR = 'osmo1fl48vsnmsdzcv85q5d2q4z5ajdha8yu3aq6l09';
const FIXED_NOW_MS = Date.UTC(2026, 10, 25, 12, 0, 0);
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

function padWord(val: bigint | string): string {
  if (typeof val === 'bigint') {
    return val.toString(16).padStart(64, '0');
  }
  const clean = val.startsWith('0x') ? val.slice(2) : val;
  return clean.toLowerCase().padStart(64, '0');
}

function encodeUint256ArrayReturn(values: bigint[]): string {
  return (
    '0x' +
    padWord(0x20n) +
    padWord(BigInt(values.length)) +
    values.map((v) => padWord(v)).join('')
  );
}

function encodeLidoStatusArrayReturn(
  statuses: Array<{
    amountOfStETH: bigint;
    amountOfShares: bigint;
    owner: string;
    timestamp: bigint;
    isFinalized: boolean;
    isClaimed: boolean;
  }>
): string {
  const tuples = statuses
    .map(
      (s) =>
        padWord(s.amountOfStETH) +
        padWord(s.amountOfShares) +
        padWord(s.owner) +
        padWord(s.timestamp) +
        padWord(s.isFinalized ? 1n : 0n) +
        padWord(s.isClaimed ? 1n : 0n)
    )
    .join('');
  return '0x' + padWord(0x20n) + padWord(BigInt(statuses.length)) + tuples;
}

function encodeEthenaCooldownReturn(cooldownEndSec: bigint, underlyingAmount: bigint): string {
  return '0x' + padWord(cooldownEndSec) + padWord(underlyingAmount);
}

function deriveValidCosmosAddressForHrp(hrp: string): string {
  const decoded = decodeBech32Strict(COSMOS_HUB_ADDR);
  assert.ok(decoded, 'base cosmos address must decode');
  return encodeBech32Strict(hrp, decoded.words, 'bech32');
}

function makeAsset(overrides: Partial<ScannedAsset>): ScannedAsset {
  return {
    id: 'ethereum:usdc',
    family: 'evm',
    chain: 'ethereum',
    chainName: 'Ethereum',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    kind: 'erc20',
    rawBalance: '10000000000',
    uiBalance: 10_000,
    priceUsd: 1,
    grossUsd: 10_000,
    liquidityUsd: 500_000_000,
    estimatedGasUsd: 8,
    batchedGasUsd: 5,
    estimatedSlippageUsd: 0,
    netUsdcSingle: 9_980,
    netUsdcBatched: 9_990,
    action: 'BRIDGE_DIRECT_USDC',
    actionReason: 'Direct canonical USDC',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

function makeScanReport(assets: ScannedAsset[], extra?: Partial<ScanReport>): ScanReport {
  const uniqueChains = Array.from(new Set(assets.map((a) => a.chain)));
  const chains = uniqueChains.map((chain) => {
    const cfg = EVM_CHAINS[chain as keyof typeof EVM_CHAINS];
    const chainAssets = assets.filter((a) => a.chain === chain);
    return {
      family: 'evm' as const,
      chain,
      chainName: cfg?.name ?? chain,
      chainId: cfg?.chainId ?? 1,
      cctpDomain: cfg?.cctpDomain ?? null,
      rpcStatus: 'preset' as const,
      blockNumber: 21_000_000,
      gasPriceGwei: chain === 'ethereum' ? 32 : 0.05,
      nativeBalance: 2,
      nativeSymbol: cfg?.nativeSymbol ?? 'ETH',
      nativePriceUsd: 3000,
      assetCount: chainAssets.length,
      defiCount: chainAssets.filter((a) => a.kind === 'defi_position').length,
      liquidCount: chainAssets.filter((a) => a.kind !== 'defi_position').length,
      burnCount: 0,
      skippedCount: 0,
      grossUsd: Number(chainAssets.reduce((s, a) => s + a.grossUsd, 0).toFixed(2)),
      netUsdcBridged: Number(chainAssets.reduce((s, a) => s + a.grossUsd, 0).toFixed(2)),
      totalGasUsd: 5,
      gasSavedByBatchUsd: 3,
      cctpAttestationSec: cfg?.cctpAttestationSec ?? 20,
      needsGasSponsorship: false,
    };
  });

  const grossUsd = Number(assets.reduce((s, a) => s + a.grossUsd, 0).toFixed(2));
  return {
    scanId: 'scan_unlock_mcp_v2_test',
    family: 'evm',
    mode: 'preset',
    walletAddress: EVM_WALLET,
    walletLabel: 'Unlock & MCP v2 Wallet',
    scannedAt: new Date(FIXED_NOW_MS).toISOString(),
    scanDurationMs: 25,
    chainsScanned: chains.length,
    chains,
    assets,
    totals: {
      grossUsd,
      defiGrossUsd: 0,
      liquidGrossUsd: grossUsd,
      protocolFeeBps: 10,
      protocolFeeUsd: 10,
      singleTxGasUsd: 12,
      batchedGasUsd: 5,
      gasSavedUsd: 7,
      estimatedSlippageUsd: 0,
      netSolanaUsdc: grossUsd - 15,
      solEquivalent: Number(((grossUsd - 15) / 150).toFixed(4)),
      solPriceUsd: 150,
      defiPositionCount: assets.filter((a) => a.kind === 'defi_position').length,
      liquidDustCount: assets.length,
      burnCandidateCount: 0,
      honeypotSkippedCount: 0,
      gasNegativeCount: 0,
    },
    warnings: [],
    ...extra,
  };
}

function makeMcpContext(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    agentEngine: new TurgaliumAgentEngine(),
    scanCache: new BoundedTtlCache<string, ScanReport>({ maxEntries: 20, ttlMs: 60_000 }),
    nowMs: () => FIXED_NOW_MS,
    ...overrides,
  };
}

// ============================================================================
// 1. CRYPTOGRAPHIC ABI SELECTORS & ADDRESS BOUNDS
// ============================================================================

test('Unlock-queue ABI selectors match exact keccak256 hashes and canonical mainnet contracts', () => {
  const expected: Array<[string, string]> = [
    ['getWithdrawalRequests(address)', UNLOCK_READER_SELECTORS.lidoGetWithdrawalRequests],
    ['getWithdrawalStatus(uint256[])', UNLOCK_READER_SELECTORS.lidoGetWithdrawalStatus],
    ['cooldowns(address)', UNLOCK_READER_SELECTORS.ethenaCooldowns],
    ['unstake(address)', UNLOCK_READER_SELECTORS.ethenaUnstake],
    ['claimWithdrawal(uint256)', UNLOCK_READER_SELECTORS.lidoClaimWithdrawal],
    ['claimWithdrawals(uint256[],uint256[])', UNLOCK_READER_SELECTORS.lidoClaimWithdrawals],
  ];

  for (const [sig, actual] of expected) {
    const hash =
      '0x' +
      Buffer.from(keccak_256(new TextEncoder().encode(sig)))
        .toString('hex')
        .slice(0, 8);
    assert.equal(actual, hash, `Selector mismatch for ${sig}`);
  }

  assert.equal(LIDO_WITHDRAWAL_QUEUE_ADDRESS, '0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1');
  assert.equal(ETHENA_SUSDE_ADDRESS, '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497');

  assert.throws(() => encodeLidoGetWithdrawalRequestsCall('0x0000000000000000000000000000000000000000'));
  assert.throws(() => encodeLidoGetWithdrawalRequestsCall('0x000000000000000000000000000000000000dEaD'));
  assert.throws(() => encodeEthenaCooldownsCall('not-an-address'));
});

// ============================================================================
// 2. LIDO WITHDRAWAL QUEUE READER & DECODER
// ============================================================================

test('Lido Withdrawal Queue reader decodes finalized claimable, pending, and claimed NFTs and fails safely on timeout', async () => {
  const reqIdsHex = encodeUint256ArrayReturn([101n, 102n, 103n]);
  const statusesHex = encodeLidoStatusArrayReturn([
    {
      amountOfStETH: 2_500_000_000_000_000_000n, // 2.5 stETH (finalized, claimable!)
      amountOfShares: 2_100_000_000_000_000_000n,
      owner: EVM_WALLET,
      timestamp: BigInt(FIXED_NOW_SEC - 4 * 86_400),
      isFinalized: true,
      isClaimed: false,
    },
    {
      amountOfStETH: 1_250_000_000_000_000_000n, // 1.25 stETH (still pending)
      amountOfShares: 1_050_000_000_000_000_000n,
      owner: EVM_WALLET,
      timestamp: BigInt(FIXED_NOW_SEC - 86_400), // requested 1 day ago -> ~2 days left
      isFinalized: false,
      isClaimed: false,
    },
    {
      amountOfStETH: 4_000_000_000_000_000_000n, // 4.0 stETH (already claimed -> excluded from active items)
      amountOfShares: 3_400_000_000_000_000_000n,
      owner: EVM_WALLET,
      timestamp: BigInt(FIXED_NOW_SEC - 10 * 86_400),
      isFinalized: true,
      isClaimed: true,
    },
  ]);

  const seenCalls: Array<{ to: string; data: string }> = [];
  const ethCall: EvmEthCallFn = async ({ to, data }) => {
    seenCalls.push({ to, data });
    if (data.startsWith(UNLOCK_READER_SELECTORS.lidoGetWithdrawalRequests)) {
      return reqIdsHex;
    }
    if (data.startsWith(UNLOCK_READER_SELECTORS.lidoGetWithdrawalStatus)) {
      assert.equal(data, encodeLidoGetWithdrawalStatusCall([101n, 102n, 103n]));
      return statusesHex;
    }
    return null;
  };

  const res = await readLidoWithdrawalQueue(EVM_WALLET, {
    ethCall,
    nowMs: FIXED_NOW_MS,
    ethPriceUsd: 3000,
  });

  assert.equal(res.ok, true);
  assert.equal(seenCalls.length, 2);
  assert.equal(seenCalls[0].to, LIDO_WITHDRAWAL_QUEUE_ADDRESS);
  assert.equal(res.requests.length, 3);
  assert.equal(res.activeRequests.length, 2);
  assert.equal(res.claimableCount, 1);
  assert.equal(res.pendingCount, 1);
  assert.equal(res.totalActiveStETH, 3.75);
  assert.equal(res.totalActiveUsd, 11_250);

  // Item 0: NFT #101 finalized & claimable immediately
  const claimableItem = res.items.find((i) => i.requestId === '101');
  assert.ok(claimableItem);
  assert.equal(claimableItem.kind, 'lido_withdrawal');
  assert.equal(claimableItem.status, 'ready_to_claim');
  assert.equal(claimableItem.secondsRemaining, 0);
  assert.equal(claimableItem.uiAmount, 2.5);
  assert.equal(claimableItem.estimatedUsd, 7_500);
  assert.equal(claimableItem.source, 'lido_withdrawal_queue');

  // Item 1: NFT #102 still finalizing (~2 days left)
  const pendingItem = res.items.find((i) => i.requestId === '102');
  assert.ok(pendingItem);
  assert.equal(pendingItem.status, 'locked_waiting');
  assert.equal(pendingItem.secondsRemaining, 2 * 86_400);
  assert.equal(pendingItem.uiAmount, 1.25);
  assert.equal(pendingItem.estimatedUsd, 3_750);

  // Claimed NFT #103 is excluded from active schedule items
  assert.equal(res.items.some((i) => i.requestId === '103'), false);

  // Malformed / truncated hex fails safely without throwing
  assert.deepEqual(decodeLidoWithdrawalRequestIds('0x'), []);
  assert.deepEqual(decodeLidoWithdrawalRequestIds('0xdeadbeef'), []);
  assert.deepEqual(decodeLidoWithdrawalStatuses('0x00', [1n]), []);

  // RPC Timeout fails gracefully without throwing
  const timedOut = await readLidoWithdrawalQueue(EVM_WALLET, {
    ethCall: () => new Promise(() => {}),
    timeoutMs: 25,
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.items.length, 0);
  assert.match(timedOut.error ?? '', /timed out/i);
});

// ============================================================================
// 3. ETHENA sUSDe COOLDOWNS READER & DECODER
// ============================================================================

test('Ethena sUSDe cooldowns(address) decoder parses locked vs ready-to-unstake state and fails safely on timeout', async () => {
  // Case A: Active locked cooldown (3 days remaining, 12,500.5 USDe)
  const lockedEndSec = BigInt(FIXED_NOW_SEC + 3 * 86_400);
  const lockedAmountRaw = 12_500_500_000_000_000_000_000n; // 12,500.5 * 1e18
  const lockedHex = encodeEthenaCooldownReturn(lockedEndSec, lockedAmountRaw);

  const lockedRes = await readEthenaSusdeCooldown(EVM_WALLET, {
    ethCall: async ({ to, data }) => {
      assert.equal(to, ETHENA_SUSDE_ADDRESS);
      assert.equal(data, encodeEthenaCooldownsCall(EVM_WALLET));
      return lockedHex;
    },
    nowMs: FIXED_NOW_MS,
    usdePriceUsd: 1,
  });

  assert.equal(lockedRes.ok, true);
  assert.ok(lockedRes.cooldown);
  assert.equal(lockedRes.cooldown.active, true);
  assert.equal(lockedRes.cooldown.readyToUnstake, false);
  assert.equal(lockedRes.cooldown.underlyingAmountUsde, 12_500.5);
  assert.equal(lockedRes.cooldown.secondsRemaining, 3 * 86_400);
  assert.equal(lockedRes.items.length, 1);
  assert.equal(lockedRes.items[0].kind, 'ethena_cooldown');
  assert.equal(lockedRes.items[0].status, 'locked_waiting');
  assert.equal(lockedRes.items[0].estimatedUsd, 12_500.5);
  assert.equal(lockedRes.items[0].claimMethod, 'unstake(address)');

  // Case B: Matured cooldown ready for unstake(address)
  const readyEndSec = BigInt(FIXED_NOW_SEC - 600);
  const readyAmountRaw = 5_000_000_000_000_000_000_000n; // 5,000 USDe
  const readyHex = encodeEthenaCooldownReturn(readyEndSec, readyAmountRaw);

  const readyRes = await readEthenaSusdeCooldown(EVM_WALLET, {
    ethCall: async () => readyHex,
    nowMs: FIXED_NOW_MS,
    usdePriceUsd: 1,
  });

  assert.equal(readyRes.ok, true);
  assert.equal(readyRes.cooldown?.readyToUnstake, true);
  assert.equal(readyRes.cooldown?.secondsRemaining, 0);
  assert.equal(readyRes.items.length, 1);
  assert.equal(readyRes.items[0].status, 'ready_to_claim');
  assert.equal(readyRes.items[0].secondsRemaining, 0);
  assert.match(readyRes.items[0].actionLabel, /unstake\(address\)/i);

  // Case C: Inactive zero cooldown
  const emptyRes = await readEthenaSusdeCooldown(EVM_WALLET, {
    ethCall: async () => encodeEthenaCooldownReturn(0n, 0n),
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(emptyRes.ok, true);
  assert.equal(emptyRes.cooldown?.active, false);
  assert.equal(emptyRes.items.length, 0);

  // Case D: Overflow uint104 / truncated hex returns null cleanly
  assert.equal(decodeEthenaCooldown('0x1234', EVM_WALLET), null);
  assert.equal(
    decodeEthenaCooldown(encodeEthenaCooldownReturn(1n << 120n, 1000n), EVM_WALLET),
    null
  );

  // Case E: Timeout fail-safety
  const timedOut = await readEthenaSusdeCooldown(EVM_WALLET, {
    ethCall: () => new Promise(() => {}),
    timeoutMs: 25,
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.items.length, 0);
});

// ============================================================================
// 4. COSMOS UNBONDING DELEGATIONS READER & PARSER
// ============================================================================

test('Cosmos unbonding_delegations parser & reader handle multi-chain decimals, LCD failover, and timeouts', async () => {
  const readyTimeIso = new Date(FIXED_NOW_MS - 3600_000).toISOString();
  const futureTimeIso = new Date(FIXED_NOW_MS + 14 * 86_400_000).toISOString();

  const cosmosPayload = {
    unbonding_responses: [
      {
        delegator_address: COSMOS_HUB_ADDR,
        validator_address: 'cosmosvaloper1validatorA',
        entries: [
          {
            creation_height: '22000100',
            completion_time: futureTimeIso,
            initial_balance: '150000000', // 150 ATOM (6 decimals)
            balance: '150000000',
            unbonding_id: '77',
          },
          {
            creation_height: '21500000',
            completion_time: readyTimeIso,
            initial_balance: '25500000', // 25.5 ATOM (ready)
            balance: '25500000',
            unbonding_id: '76',
          },
          {
            // Zero balance & bad timestamp should be ignored safely
            creation_height: '21000000',
            completion_time: 'not-a-date',
            balance: '0',
          },
        ],
      },
    ],
  };

  let attempt = 0;
  const failoverFetch = (async (input: string | URL) => {
    attempt += 1;
    const url = String(input);
    assert.ok(url.includes(`/cosmos/staking/v1beta1/delegators/${COSMOS_HUB_ADDR}/unbonding_delegations`));
    if (attempt === 1) {
      return new Response('rate limited', { status: 503 });
    }
    return new Response(JSON.stringify(cosmosPayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const cosmosRes = await readCosmosUnbondingDelegations(COSMOS_HUB_ADDR, {
    fetchImpl: failoverFetch,
    lcdUrls: ['https://lcd-primary.invalid', 'https://lcd-backup.invalid'],
    nowMs: FIXED_NOW_MS,
    tokenPriceUsd: 5,
  });

  assert.equal(attempt, 2, 'must fail over from 503 primary LCD to backup LCD');
  assert.equal(cosmosRes.ok, true);
  assert.equal(cosmosRes.chain, 'cosmoshub');
  assert.equal(cosmosRes.entries.length, 2);
  assert.equal(cosmosRes.totalUiAmount, 175.5);
  assert.equal(cosmosRes.totalEstimatedUsd, 877.5);
  // Sorted soonest-first: ready entry (25.5 ATOM) before 14d entry (150 ATOM)
  assert.equal(cosmosRes.items[0].status, 'ready_to_claim');
  assert.equal(cosmosRes.items[0].uiAmount, 25.5);
  assert.equal(cosmosRes.items[0].secondsRemaining, 0);
  assert.equal(cosmosRes.items[1].status, 'locked_waiting');
  assert.equal(cosmosRes.items[1].uiAmount, 150);
  assert.equal(cosmosRes.items[1].secondsRemaining, 14 * 86_400);

  // Verify 18-decimal Injective parsing
  const injAddr = deriveValidCosmosAddressForHrp('inj');
  const injEntries = parseCosmosUnbondingDelegations(
    {
      unbonding_responses: [
        {
          delegator_address: injAddr,
          validator_address: 'injvaloper1test',
          entries: [
            {
              creation_height: '90000000',
              completion_time: futureTimeIso,
              balance: '10500000000000000000', // 10.5 INJ
              unbonding_id: '9',
            },
          ],
        },
      ],
    },
    'injective',
    injAddr,
    { nowMs: FIXED_NOW_MS, tokenPriceUsd: 20 }
  );
  assert.equal(injEntries.length, 1);
  assert.equal(injEntries[0].uiAmount, 10.5);
  assert.equal(injEntries[0].estimatedUsd, 210);

  // Invalid Bech32 address fails closed without invoking fetch
  let fetchCalledOnBadAddr = false;
  const badRes = await readCosmosUnbondingDelegations('cosmos1invalidchecksumzzzzzzzzzzzzzzzzzz', {
    fetchImpl: (async () => {
      fetchCalledOnBadAddr = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });
  assert.equal(badRes.ok, false);
  assert.equal(fetchCalledOnBadAddr, false);

  // LCD timeout fails gracefully
  const timedOut = await readCosmosUnbondingDelegations(OSMO_ADDR, {
    fetchImpl: (() => new Promise(() => {})) as unknown as typeof fetch,
    lcdUrls: ['https://slow-lcd.invalid'],
    timeoutMs: 25,
    nowMs: FIXED_NOW_MS,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.items.length, 0);
});

// ============================================================================
// 5. PRESERVATION PLAN UNLOCK SCHEDULE MERGE, DEDUPE & SOONEST-FIRST SORT
// ============================================================================

test('evaluatePreservationPlan merges live Lido/Ethena/Cosmos unlocks with scan DeFi locks & CCTP legs, deduplicated and sorted soonest-first', async () => {
  const ethenaUnlockSec = FIXED_NOW_SEC + 2 * 86_400; // 2d from now
  const veAeroUnlockSec = FIXED_NOW_SEC + 5 * 86_400; // 5d from now
  const cosmosUnlockIso = new Date(FIXED_NOW_MS + 10 * 86_400_000).toISOString(); // 10d from now

  const scan = makeScanReport(
    [
      makeAsset({ id: 'ethereum:usdc', grossUsd: 10_000 }),
      // Heuristic Ethena sUSDe cooldown (should be superseded by live on-chain Ethena reader!)
      makeAsset({
        id: 'ethereum:susde',
        symbol: 'sUSDe',
        name: 'Staked USDe',
        kind: 'defi_position',
        protocol: 'Ethena',
        grossUsd: 8_000,
        defiExitPlan: {
          protocolId: 'erc4626',
          protocolName: 'Ethena sUSDe',
          routeKind: 'unbonding_required',
          exitStrategy: 'cooldown_blocked',
          preflightStatus: 'warning',
          preflightReason: 'Cooldown active',
          plainEnglishSteps: ['Wait for cooldown'],
          cooldownDetected: true,
        },
      }),
      // Protocol-indexed veAERO lock on Base
      makeAsset({
        id: 'base:veaero',
        chain: 'base',
        chainName: 'Base',
        symbol: 'veAERO',
        name: 'Locked AERO',
        kind: 'defi_position',
        protocol: 'Aerodrome',
        grossUsd: 4_000,
        defiUnlockAt: veAeroUnlockSec,
      }),
    ],
    {
      unifiedWallets: [
        {
          address: EVM_WALLET,
          label: 'Main EVM',
          family: 'evm',
          chainsWithAssets: 2,
          assetCount: 3,
          grossUsd: 22_000,
          scanDurationMs: 10,
        },
        {
          address: COSMOS_HUB_ADDR,
          label: 'Keplr Hub',
          family: 'cosmos',
          chainsWithAssets: 1,
          assetCount: 1,
          grossUsd: 500,
          scanDurationMs: 10,
        },
      ],
    }
  );

  const ethCall: EvmEthCallFn = async ({ to, data }) => {
    if (to === LIDO_WITHDRAWAL_QUEUE_ADDRESS && data.startsWith(UNLOCK_READER_SELECTORS.lidoGetWithdrawalRequests)) {
      return encodeUint256ArrayReturn([555n]);
    }
    if (to === LIDO_WITHDRAWAL_QUEUE_ADDRESS && data.startsWith(UNLOCK_READER_SELECTORS.lidoGetWithdrawalStatus)) {
      return encodeLidoStatusArrayReturn([
        {
          amountOfStETH: 2_000_000_000_000_000_000n, // 2 ETH finalized now
          amountOfShares: 1_700_000_000_000_000_000n,
          owner: EVM_WALLET,
          timestamp: BigInt(FIXED_NOW_SEC - 5 * 86_400),
          isFinalized: true,
          isClaimed: false,
        },
      ]);
    }
    if (to === ETHENA_SUSDE_ADDRESS && data.startsWith(UNLOCK_READER_SELECTORS.ethenaCooldowns)) {
      return encodeEthenaCooldownReturn(BigInt(ethenaUnlockSec), 8_000_000_000_000_000_000_000n);
    }
    return null;
  };

  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        unbonding_responses: [
          {
            delegator_address: COSMOS_HUB_ADDR,
            validator_address: 'cosmosvaloper1alpha',
            entries: [
              {
                creation_height: '22000001',
                completion_time: cosmosUnlockIso,
                balance: '100000000', // 100 ATOM
                unbonding_id: '901',
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as unknown as typeof fetch;

  const plan = await evaluatePreservationPlan(scan, {
    nowMs: FIXED_NOW_MS,
    protocolFeeBps: 10,
    fetchLiveUnlockQueues: true,
    liveUnlockReaderOptions: {
      ethCall,
      fetchImpl,
      ethPriceUsd: 3000,
      usdePriceUsd: 1,
      cosmosPricesUsd: { cosmoshub: 6 },
    },
    attestedCctpLegs: [
      {
        chain: 'base',
        amountUsdc: 2500,
        txHash: '0xcctp_pending',
        attestationStatus: 'pending_confirmations',
        estimatedReadyAt: FIXED_NOW_MS + 30_000, // 30s from now
      },
    ],
  });

  // Expected merged items (5 total; heuristic sUSDe cooldown deduplicated by live on-chain Ethena reader):
  // 1. Lido NFT #555 (now, ready_to_claim)
  // 2. CCTP Base leg (+30s, attestation_pending)
  // 3. Ethena sUSDe live cooldown (+2d, locked_waiting)
  // 4. Aerodrome veAERO scan lock (+5d, locked_waiting)
  // 5. Cosmos Hub ATOM unbonding (+10d, locked_waiting)
  assert.equal(plan.unlockSchedule.length, 5);
  assert.equal(plan.unlockSchedule[0].kind, 'lido_withdrawal');
  assert.equal(plan.unlockSchedule[0].status, 'ready_to_claim');
  assert.equal(plan.unlockSchedule[1].kind, 'cctp_claim');
  assert.equal(plan.unlockSchedule[2].kind, 'ethena_cooldown');
  assert.equal(plan.unlockSchedule[2].source, 'ethena_susde');
  assert.equal(plan.unlockSchedule[3].kind, 'defi_unlock');
  assert.equal(plan.unlockSchedule[3].symbol, 'veAERO');
  assert.equal(plan.unlockSchedule[4].kind, 'cosmos_unbonding');
  assert.equal(plan.unlockSchedule[4].symbol, 'ATOM');
  assert.equal(plan.unlockSchedule[4].estimatedUsd, 600);

  // Confirm strictly non-decreasing unlockAtMs ordering
  for (let i = 1; i < plan.unlockSchedule.length; i += 1) {
    assert.ok(plan.unlockSchedule[i].unlockAtMs >= plan.unlockSchedule[i - 1].unlockAtMs);
  }

  // Confirm duplicate IDs are deduplicated by mergeUnlockSchedule
  const deduped = mergeUnlockSchedule([...plan.unlockSchedule, ...plan.unlockSchedule]);
  assert.equal(deduped.length, plan.unlockSchedule.length);
});

// ============================================================================
// 6. MCP v2 TOOLS & CHATGPT OPENAPI 3.1 SCHEMA TESTS
// ============================================================================

test('MCP tools/list and ChatGPT OpenAPI 3.1 spec expose all 5 v2 read-only tools and block turgalium_create_agent_mandate', async () => {
  const ctx = makeMcpContext();

  // Verify handleMcpRequest alias matches handleMcpJsonRpc
  assert.equal(handleMcpRequest, handleMcpJsonRpc);
  assert.equal(buildChatGptOpenApiSpec, buildOpenApiSpec);

  const listResp = (await handleMcpRequest(
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ctx
  )) as { result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }> } };

  const toolNames = listResp.result.tools.map((t) => t.name);
  const requiredV2Tools = [
    'turgalium_preservation_audit',
    'turgalium_list_unlock_schedule',
    'turgalium_solana_rent_scan',
    'turgalium_solana_yield_preview',
    'turgalium_degen_markets',
  ];

  for (const name of requiredV2Tools) {
    assert.ok(toolNames.includes(name), `MCP tools/list missing ${name}`);
    const tool = listResp.result.tools.find((t) => t.name === name);
    assert.equal(tool?.annotations.readOnlyHint, true, `${name} must be readOnlyHint: true`);
    assert.equal(tool?.annotations.destructiveHint, false, `${name} must be destructiveHint: false`);
  }

  // Security invariant: turgalium_create_agent_mandate MUST NEVER be exposed in tools/list
  assert.equal(toolNames.includes('turgalium_create_agent_mandate'), false);
  assert.equal(TURGALIUM_MCP_TOOLS.some((t) => t.name === 'turgalium_create_agent_mandate'), false);

  // Direct call to turgalium_create_agent_mandate MUST stay blocked with isError: true
  const blockedResp = (await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'turgalium_create_agent_mandate',
        arguments: {
          ownerAddress: EVM_WALLET,
          lockedSolanaRecipient: SOL_WALLET,
          autoApproveUnderUsd: 999999,
        },
      },
    },
    ctx
  )) as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(blockedResp.result.isError, true);
  assert.match(blockedResp.result.content[0].text, /disabled via MCP/i);

  // Verify ChatGPT OpenAPI 3.1 spec exposes all 5 new v2 operations as non-consequential (read-only)
  const spec = buildChatGptOpenApiSpec('https://turgalium.example/');
  assert.equal(spec.openapi, '3.1.0');
  assert.equal(spec.info.version, '2.0.0');

  const ops: Array<{ path: string; method: string; operationId: string; isConsequential: boolean }> = [];
  for (const [p, methods] of Object.entries(spec.paths)) {
    for (const [m, def] of Object.entries(methods as Record<string, Record<string, unknown>>)) {
      ops.push({
        path: p,
        method: m,
        operationId: String(def.operationId ?? ''),
        isConsequential: Boolean(def['x-openai-isConsequential']),
      });
    }
  }

  for (const opId of requiredV2Tools) {
    const found = ops.find((o) => o.operationId === opId);
    assert.ok(found, `OpenAPI 3.1 spec missing operationId ${opId}`);
    assert.equal(found.isConsequential, false, `${opId} must have x-openai-isConsequential: false`);
  }

  // Existing consequential guard on POST /api/agents/approvals stays intact
  const sweepOp = ops.find((o) => o.path === '/api/agents/approvals' && o.method === 'post');
  assert.equal(sweepOp?.isConsequential, true);
  // No mandate-creation POST route exposed in OpenAPI
  assert.equal(ops.some((o) => o.path === '/api/agents/mandates' && o.method === 'post'), false);
});

test('All 5 new MCP v2 tools execute cleanly end-to-end through handleMcpRequest', async () => {
  const scan = makeScanReport([
    makeAsset({ id: 'ethereum:usdc', chain: 'ethereum', chainName: 'Ethereum', grossUsd: 25_000 }),
    makeAsset({
      id: 'base:aero',
      chain: 'base',
      chainName: 'Base',
      address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
      symbol: 'AERO',
      name: 'Aerodrome',
      grossUsd: 600,
      action: 'SELL_AND_BRIDGE',
      liquidityUsd: 5_000_000,
      estimatedSlippageUsd: 1.2,
    }),
  ]);

  const lidoFinalizedEthCall: EvmEthCallFn = async ({ to, data }) => {
    if (to === LIDO_WITHDRAWAL_QUEUE_ADDRESS && data.startsWith(UNLOCK_READER_SELECTORS.lidoGetWithdrawalRequests)) {
      return encodeUint256ArrayReturn([888n]);
    }
    if (to === LIDO_WITHDRAWAL_QUEUE_ADDRESS && data.startsWith(UNLOCK_READER_SELECTORS.lidoGetWithdrawalStatus)) {
      return encodeLidoStatusArrayReturn([
        {
          amountOfStETH: 1_500_000_000_000_000_000n,
          amountOfShares: 1_300_000_000_000_000_000n,
          owner: EVM_WALLET,
          timestamp: BigInt(FIXED_NOW_SEC - 4 * 86_400),
          isFinalized: true,
          isClaimed: false,
        },
      ]);
    }
    if (to === ETHENA_SUSDE_ADDRESS && data.startsWith(UNLOCK_READER_SELECTORS.ethenaCooldowns)) {
      return encodeEthenaCooldownReturn(
        BigInt(FIXED_NOW_SEC + 86_400),
        4_200_000_000_000_000_000_000n
      );
    }
    return null;
  };

  const mockCosmosFetch = (async () =>
    new Response(
      JSON.stringify({
        unbonding_responses: [
          {
            delegator_address: COSMOS_HUB_ADDR,
            validator_address: 'cosmosvaloper1hub',
            entries: [
              {
                creation_height: '22000500',
                completion_time: new Date(FIXED_NOW_MS + 3 * 86_400_000).toISOString(),
                balance: '50000000', // 50 ATOM
                unbonding_id: '12',
              },
            ],
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as unknown as typeof fetch;

  const mockRentScanner = async (ownerAddress: string): Promise<SolanaRentScanResult> => ({
    ownerAddress,
    scannedPrograms: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
    totalTokenAccountsScanned: 18,
    reclaimableCount: 5,
    skippedNonZeroCount: 12,
    skippedFrozenCount: 1,
    skippedUncloseableCount: 0,
    rentPerEmptyAccountSol: SOLANA_EMPTY_ATA_RENT_SOL,
    reclaimableLamports: 5 * SOLANA_EMPTY_ATA_RENT_LAMPORTS,
    reclaimableSol: Number((5 * SOLANA_EMPTY_ATA_RENT_SOL).toFixed(8)),
    solPriceUsd: 160,
    solPriceSource: 'explicit',
    reclaimableUsd: Number((5 * SOLANA_EMPTY_ATA_RENT_SOL * 160).toFixed(2)),
    maxAccountsPerTx: 20,
    batchesRequired: 1,
    reclaimableAccounts: [],
    unsignedCloseTx: null,
    txBuildWarning: null,
  });

  const mockJupiterClient = new JupiterMarketsClient({
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              eventId: 'evt-sol-ath',
              slug: 'sol-new-ath-2026',
              category: 'crypto',
              isActive: true,
              isLive: true,
              volumeUsd: '2500000000000',
              volume24hr: '350000000000',
              metadata: {
                title: 'Will SOL hit $300?\u0007\u202E<ignore>',
                subtitle: 'Spot price by Dec 31\u0000',
              },
              markets: [
                {
                  marketId: 'mkt-sol-300',
                  status: 'open',
                  metadata: { title: 'SOL >= $300' },
                  pricing: {
                    buyYesPriceUsd: 420000,
                    buyNoPriceUsd: 590000,
                    volume: '1200000000000',
                  },
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch,
  });

  const ctx = makeMcpContext({
    gasPriceFetcher: async () => 34,
    unlockReaderOptions: {
      ethCall: lidoFinalizedEthCall,
      fetchImpl: mockCosmosFetch,
      ethPriceUsd: 3000,
      usdePriceUsd: 1,
      cosmosPricesUsd: { cosmoshub: 5 },
    },
    solanaRentScanner: mockRentScanner,
    jupiterMarketsClient: mockJupiterClient,
  });
  ctx.scanCache.set(scan.scanId, scan);

  // 1. turgalium_preservation_audit (by scanId AND by walletAddress)
  const auditResp = (await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: {
        name: 'turgalium_preservation_audit',
        arguments: {
          scanId: scan.scanId,
          outputAsset: 'USDC',
          protocolFeeBps: 10,
          maxBaseFeeGwei: 15,
          fetchLiveGas: true,
        },
      },
    },
    ctx
  )) as { result: { structuredContent: Record<string, unknown> } };
  const audit = auditResp.result.structuredContent as {
    readOnly: boolean;
    totals: { grossSweepableUsd: number; totalDollarsPreservedUsd: number; optimizedNetUsd: number };
    chains: Array<{ chain: string; bestRoute: string }>;
    gasTiming: { primary: { currentGwei: number; shouldWait: boolean } };
  };
  assert.equal(audit.readOnly, true);
  assert.equal(audit.totals.grossSweepableUsd, 25_600);
  assert.ok(audit.totals.totalDollarsPreservedUsd > 0);
  assert.equal(audit.chains.find((c) => c.chain === 'ethereum')?.bestRoute, 'circle_cctp');
  assert.equal(audit.gasTiming.primary.currentGwei, 34);
  assert.equal(audit.gasTiming.primary.shouldWait, true);

  // Also test lookup by walletAddress
  const auditByWalletResp = (await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: {
        name: 'turgalium_preservation_audit',
        arguments: { walletAddress: EVM_WALLET.toLowerCase() },
      },
    },
    ctx
  )) as { result: { structuredContent: { scanId: string } } };
  assert.equal(auditByWalletResp.result.structuredContent.scanId, scan.scanId);

  // 2. turgalium_list_unlock_schedule
  const unlockResp = (await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 103,
      method: 'tools/call',
      params: {
        name: 'turgalium_list_unlock_schedule',
        arguments: {
          evmAddress: EVM_WALLET,
          cosmosAddresses: [COSMOS_HUB_ADDR],
          attestedCctpLegs: [
            {
              chain: 'ethereum',
              amountUsdc: 1200,
              txHash: '0xabc123',
              attestationStatus: 'complete',
            },
          ],
        },
      },
    },
    ctx
  )) as {
    result: {
      structuredContent: {
        readOnly: boolean;
        totalItems: number;
        readyToClaimCount: number;
        unlockSchedule: Array<{ kind: string; status: string; unlockAtMs: number }>;
      };
    };
  };
  const unlockData = unlockResp.result.structuredContent;
  assert.equal(unlockData.readOnly, true);
  assert.equal(unlockData.totalItems, 4); // Lido + CCTP + Ethena + Cosmos
  assert.equal(unlockData.readyToClaimCount, 2); // Lido finalized + CCTP complete
  assert.deepEqual(
    unlockData.unlockSchedule.map((i) => i.kind),
    ['lido_withdrawal', 'cctp_claim', 'ethena_cooldown', 'cosmos_unbonding']
  );

  // 3. turgalium_solana_rent_scan
  const rentResp = (await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 104,
      method: 'tools/call',
      params: {
        name: 'turgalium_solana_rent_scan',
        arguments: { ownerAddress: SOL_WALLET, solPriceUsd: 160 },
      },
    },
    ctx
  )) as {
    result: {
      structuredContent: {
        readOnly: boolean;
        reclaimableCount: number;
        rentPerEmptyAccountSol: number;
        reclaimableSol: number;
        reclaimableUsd: number;
      };
    };
  };
  const rent = rentResp.result.structuredContent;
  assert.equal(rent.readOnly, true);
  assert.equal(rent.reclaimableCount, 5);
  assert.equal(rent.rentPerEmptyAccountSol, 0.00203928);
  assert.equal(rent.reclaimableSol, 0.0101964);
  assert.equal(rent.reclaimableUsd, 1.63);

  // 4. turgalium_solana_yield_preview (90% Preserved Yield + 10% Degen Side-Pocket)
  const yieldResp = (await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 105,
      method: 'tools/call',
      params: {
        name: 'turgalium_solana_yield_preview',
        arguments: {
          ownerAddress: SOL_WALLET,
          totalUsdcAmount: 10_000,
          preservePct: 90,
          strategy: 'jupiter_lend_usdc',
        },
      },
    },
    ctx
  )) as {
    result: {
      structuredContent: {
        readOnly: boolean;
        autonomousExecutionAllowed: boolean;
        transaction: unknown;
        strategy: { id: string; symbol: string };
        split: { yieldUsdc: number; degenSidePocketUsdc: number; yieldUsdcRaw: string; degenSidePocketRaw: string; totalUsdcRaw: string };
        projections: { projectedAnnualYieldUsd: number };
      };
    };
  };
  const yieldData = yieldResp.result.structuredContent;
  assert.equal(yieldData.readOnly, true);
  assert.equal(yieldData.autonomousExecutionAllowed, false);
  assert.equal(yieldData.transaction, null);
  assert.equal(yieldData.strategy.id, 'jupiter_lend_usdc');
  assert.equal(yieldData.strategy.symbol, 'jlUSDC');
  assert.equal(yieldData.split.yieldUsdc, 9_000);
  assert.equal(yieldData.split.degenSidePocketUsdc, 1_000);
  assert.equal(
    BigInt(yieldData.split.yieldUsdcRaw) + BigInt(yieldData.split.degenSidePocketRaw),
    BigInt(yieldData.split.totalUsdcRaw)
  );
  assert.ok(yieldData.projections.projectedAnnualYieldUsd > 0);

  // 5. turgalium_degen_markets (strictly read-only + sanitized)
  const degenResp = (await handleMcpRequest(
    {
      jsonrpc: '2.0',
      id: 106,
      method: 'tools/call',
      params: {
        name: 'turgalium_degen_markets',
        arguments: { category: 'crypto', filter: 'trending', limit: 5 },
      },
    },
    ctx
  )) as {
    result: {
      structuredContent: {
        readOnly: boolean;
        autonomousBettingAllowed: boolean;
        safetyNotice: string;
        events: Array<{
          eventId: string;
          title: string;
          subtitle: string;
          markets: Array<{ marketId: string; yes: { cents: number; payoutMultiplier: number } }>;
        }>;
      };
    };
  };
  const degen = degenResp.result.structuredContent;
  assert.equal(degen.readOnly, true);
  assert.equal(degen.autonomousBettingAllowed, false);
  assert.match(degen.safetyNotice, /never places bets autonomously/i);
  assert.equal(degen.events.length, 1);
  assert.equal(degen.events[0].eventId, 'evt-sol-ath');
  // Verify control / bidi override chars stripped from untrusted market title & subtitle
  assert.equal(/[\u0000-\u001F\u202E]/.test(degen.events[0].title), false);
  assert.equal(/[\u0000-\u001F]/.test(degen.events[0].subtitle), false);
  assert.equal(degen.events[0].markets[0].yes.cents, 42);
  assert.equal(degen.events[0].markets[0].yes.payoutMultiplier, 2.38);
});

// ============================================================================
// 7. ADVERSARIAL & FAIL-CLOSED INPUT SANITIZATION TESTS
// ============================================================================

test('All 5 new MCP v2 tools reject malformed addresses, out-of-range numbers, and injection payloads fail-closed (-32602)', async () => {
  const ctx = makeMcpContext();

  const invalidCalls: Array<{ label: string; name: string; args: Record<string, unknown> }> = [
    // turgalium_preservation_audit
    { label: 'audit missing scanId and wallet', name: 'turgalium_preservation_audit', args: {} },
    {
      label: 'audit malformed walletAddress',
      name: 'turgalium_preservation_audit',
      args: { walletAddress: '0xNOT_A_VALID_WALLET<script>' },
    },
    {
      label: 'audit zero EVM walletAddress',
      name: 'turgalium_preservation_audit',
      args: { walletAddress: '0x0000000000000000000000000000000000000000' },
    },
    {
      label: 'audit out-of-bounds protocolFeeBps',
      name: 'turgalium_preservation_audit',
      args: { scanId: 'scan_1', protocolFeeBps: 1500 },
    },
    {
      label: 'audit invalid outputAsset',
      name: 'turgalium_preservation_audit',
      args: { scanId: 'scan_1', outputAsset: 'ETH' },
    },
    // turgalium_list_unlock_schedule
    { label: 'unlock missing all inputs', name: 'turgalium_list_unlock_schedule', args: {} },
    {
      label: 'unlock malformed evmAddress',
      name: 'turgalium_list_unlock_schedule',
      args: { evmAddress: '0x1234' },
    },
    {
      label: 'unlock dead burn evmAddress',
      name: 'turgalium_list_unlock_schedule',
      args: { evmAddress: '0x000000000000000000000000000000000000dEaD' },
    },
    {
      label: 'unlock invalid Cosmos Bech32 checksum',
      name: 'turgalium_list_unlock_schedule',
      args: { cosmosAddresses: ['cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0ea'] },
    },
    {
      label: 'unlock unsupported Cosmos HRP',
      name: 'turgalium_list_unlock_schedule',
      args: { cosmosAddresses: [deriveValidCosmosAddressForHrp('juno')] },
    },
    {
      label: 'unlock negative CCTP amountUsdc',
      name: 'turgalium_list_unlock_schedule',
      args: {
        attestedCctpLegs: [
          { chain: 'ethereum', amountUsdc: -50, attestationStatus: 'complete' },
        ],
      },
    },
    // turgalium_solana_rent_scan
    {
      label: 'rent scan malformed Solana pubkey',
      name: 'turgalium_solana_rent_scan',
      args: { ownerAddress: 'not-a-solana-address' },
    },
    {
      label: 'rent scan EVM address passed to Solana tool',
      name: 'turgalium_solana_rent_scan',
      args: { ownerAddress: EVM_WALLET },
    },
    {
      label: 'rent scan all-zero System Program pubkey',
      name: 'turgalium_solana_rent_scan',
      args: { ownerAddress: '11111111111111111111111111111111' },
    },
    {
      label: 'rent scan boolean coerced solPriceUsd',
      name: 'turgalium_solana_rent_scan',
      args: { ownerAddress: SOL_WALLET, solPriceUsd: true },
    },
    // turgalium_solana_yield_preview
    {
      label: 'yield preview violates 50% preservation floor',
      name: 'turgalium_solana_yield_preview',
      args: { totalUsdcAmount: 1000, preservePct: 40 },
    },
    {
      label: 'yield preview preservePct > 100',
      name: 'turgalium_solana_yield_preview',
      args: { totalUsdcAmount: 1000, preservePct: 105 },
    },
    {
      label: 'yield preview negative totalUsdcAmount',
      name: 'turgalium_solana_yield_preview',
      args: { totalUsdcAmount: -500 },
    },
    {
      label: 'yield preview boolean totalUsdcAmount',
      name: 'turgalium_solana_yield_preview',
      args: { totalUsdcAmount: true },
    },
    {
      label: 'yield preview invalid strategy',
      name: 'turgalium_solana_yield_preview',
      args: { totalUsdcAmount: 1000, strategy: '100x_leverage_rug' },
    },
    {
      label: 'yield preview malformed ownerAddress',
      name: 'turgalium_solana_yield_preview',
      args: { totalUsdcAmount: 1000, ownerAddress: '0xbad_solana' },
    },
    // turgalium_degen_markets
    {
      label: 'degen markets invalid category',
      name: 'turgalium_degen_markets',
      args: { category: 'place_bet_now' },
    },
    {
      label: 'degen markets invalid filter',
      name: 'turgalium_degen_markets',
      args: { filter: 'execute_order' },
    },
    {
      label: 'degen markets limit out of bounds',
      name: 'turgalium_degen_markets',
      args: { limit: 100 },
    },
    {
      label: 'degen markets control char in query',
      name: 'turgalium_degen_markets',
      args: { query: 'SOL\u0000\u0007' },
    },
  ];

  for (const tc of invalidCalls) {
    const resp = (await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: tc.label,
        method: 'tools/call',
        params: { name: tc.name, arguments: tc.args },
      },
      ctx
    )) as { error?: { code: number; message: string } };

    assert.equal(
      resp.error?.code,
      -32602,
      `Expected JSON-RPC -32602 for adversarial case "${tc.label}", got ${JSON.stringify(resp)}`
    );
  }
});

test('readLiveUnlockQueues handles mixed RPC timeouts and healthy chains gracefully without throwing', async () => {
  const report = await readLiveUnlockQueues({
    evmAddresses: [EVM_WALLET],
    cosmosAddresses: [COSMOS_HUB_ADDR],
    ethCall: () => new Promise(() => {}), // hangs -> times out
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          unbonding_responses: [
            {
              delegator_address: COSMOS_HUB_ADDR,
              validator_address: 'cosmosvaloper1alive',
              entries: [
                {
                  creation_height: '22000999',
                  completion_time: new Date(FIXED_NOW_MS + 86_400_000).toISOString(),
                  balance: '10000000', // 10 ATOM
                  unbonding_id: '321',
                },
              ],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )) as unknown as typeof fetch,
    timeoutMs: 25,
    nowMs: FIXED_NOW_MS,
    cosmosPricesUsd: { cosmoshub: 5 },
  });

  // Lido & Ethena timed out cleanly, Cosmos succeeded and is still returned
  assert.equal(report.lido[0].ok, false);
  assert.equal(report.lido[0].timedOut, true);
  assert.equal(report.ethena[0].ok, false);
  assert.equal(report.ethena[0].timedOut, true);
  assert.equal(report.cosmos[0].ok, true);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].kind, 'cosmos_unbonding');
  assert.equal(report.items[0].estimatedUsd, 50);
  assert.equal(report.warnings.length, 2);
});
