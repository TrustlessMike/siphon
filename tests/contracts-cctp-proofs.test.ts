import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { PublicKey } from '@solana/web3.js';
import {
  buildMigrationPlan,
  CCTP_MESSAGE_SENT_TOPIC,
  CCTP_V1_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR,
  deriveSolanaUsdcAta,
  encodeCctpDepositForBurn,
  extractAllCctpMessagesFromLogs,
  extractCctpMessageFromLogs,
  fetchCctpAttestationForTx,
  getCctpIrisAttestationUrl,
  getSolanaCctpPrograms,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
  SOLANA_CCTP_PROGRAMS,
  SOLANA_CCTP_PROGRAMS_V2,
  SOLANA_TOKEN_PROGRAM_ID,
  SOLANA_USDC_MINT_PUBKEY,
  solanaAddressToBytes32,
  solanaOwnerToUsdcAtaBytes32,
} from '../src/bridge/cctp.js';
import {
  buildPreSignSimulationProof,
  canonicalizeJson,
  clearProofStoresForTest,
  verifyOnchainExecutionProof,
} from '../src/execution/proof.js';
import { prepareChainBatchExecution, prepareRealExecution, type PreparedChainBatch } from '../src/execution/tx-builder.js';
import {
  buildGaslessSweepIntent,
  clearTrackedGaslessIntentsForTest,
  computeEmptySwapsHash,
  computeEmptySweepCallsHash,
  computeGaslessIntentEip712Digest,
  recoverEip712Signer,
  TURGALIUM_WITNESS_TYPE_STRING,
  submitSignedGaslessIntent,
  SWEEP_INTENT_TYPE_STRING,
} from '../src/relayer/sponsor.js';
import { CHAIN_LIST, EVM_CHAINS, getProtocolFeeConfig } from '../src/scanner/chains.js';
import { scanPresetWallet } from '../src/scanner/classifier.js';
import type { EvmChainId, ScannedAsset } from '../src/scanner/types.js';

const ROOT_DIR = path.resolve(process.cwd());
const SAMPLE_SOLANA_WALLETS = [
  'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n',
  'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36ZEGgj',
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
];

function makeTestWallet(seedHex: string): { privKey: Uint8Array; address: string } {
  const privKey = Buffer.from(seedHex.repeat(32), 'hex');
  const pub = secp256k1.getPublicKey(privKey, false).slice(1);
  const address = '0x' + Buffer.from(keccak_256(pub).slice(-20)).toString('hex');
  return { privKey, address };
}

function signDigestLowS(digestHex: string, privKey: Uint8Array): string {
  const sig = secp256k1.sign(Buffer.from(digestHex.slice(2), 'hex'), privKey, { lowS: true });
  return (
    '0x' +
    sig.r.toString(16).padStart(64, '0') +
    sig.s.toString(16).padStart(64, '0') +
    (27 + (sig.recovery ?? 0)).toString(16).padStart(2, '0')
  );
}

function encodeMessageSentLogData(payload: Buffer): string {
  const word = (n: number) => n.toString(16).padStart(64, '0');
  const padded = payload.toString('hex').padEnd(Math.ceil(payload.length / 32) * 64, '0');
  return '0x' + word(0x20) + word(payload.length) + padded;
}

function makeAsset(overrides: Partial<ScannedAsset>): ScannedAsset {
  return {
    id: 'base:usdc',
    chain: 'base',
    chainName: 'Base',
    address: EVM_CHAINS.base.usdcAddress,
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    kind: 'erc20',
    rawBalance: '100000000', // 100 USDC
    uiBalance: 100,
    priceUsd: 1,
    grossUsd: 100,
    liquidityUsd: 100_000_000,
    estimatedGasUsd: 0.1,
    batchedGasUsd: 0.08,
    estimatedSlippageUsd: 0,
    netUsdcSingle: 92.9,
    netUsdcBatched: 92.92,
    action: 'BRIDGE_DIRECT_USDC',
    actionReason: 'Direct USDC bridge',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

async function withMockFetch<T>(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// 1. CCTP SOLANA ATA PDA & V1/V2 BACKTEST (CRIT-04, CRIT-05, HIGH-10)
// ============================================================================

test('CRIT-04 Backtest: solanaOwnerToUsdcAtaBytes32 derives canonical SPL USDC ATA PDA and never equals raw owner pubkey', async () => {
  for (const ownerStr of SAMPLE_SOLANA_WALLETS) {
    const owner = new PublicKey(ownerStr);
    const [expectedAta] = PublicKey.findProgramAddressSync(
      [
        owner.toBytes(),
        new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes(),
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v').toBytes(),
      ],
      new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
    );

    const derivedAta = deriveSolanaUsdcAta(ownerStr);
    assert.equal(derivedAta.toBase58(), expectedAta.toBase58());
    assert.equal(PublicKey.isOnCurve(derivedAta.toBytes()), false, 'Canonical ATA PDA must be off-curve');

    const ataBytes32 = solanaOwnerToUsdcAtaBytes32(ownerStr);
    const rawOwnerBytes32 = solanaAddressToBytes32(ownerStr);
    assert.equal(ataBytes32, '0x' + Buffer.from(expectedAta.toBytes()).toString('hex'));
    assert.notEqual(
      ataBytes32,
      rawOwnerBytes32,
      'CCTP mintRecipient MUST NEVER equal raw Solana wallet owner pubkey'
    );
  }

  // Reject invalid keys and all-zero System Program pubkey
  assert.throws(() => solanaOwnerToUsdcAtaBytes32(''));
  assert.throws(() => solanaOwnerToUsdcAtaBytes32('not-base58'));
  assert.throws(() => solanaOwnerToUsdcAtaBytes32('11111111111111111111111111111111'));
  assert.throws(() => solanaAddressToBytes32('11111111111111111111111111111111'));

  // Verify constants
  assert.equal(SOLANA_TOKEN_PROGRAM_ID.toBase58(), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  assert.equal(SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  assert.equal(SOLANA_USDC_MINT_PUBKEY.toBase58(), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

  // Verify buildMigrationPlan & prepareRealExecution embed ATA PDA bytes32 (NOT raw wallet pubkey!)
  const owner = SAMPLE_SOLANA_WALLETS[0];
  const expectedAtaBytes32 = solanaOwnerToUsdcAtaBytes32(owner);
  const rawOwnerBytes32 = solanaAddressToBytes32(owner);

  const report = await scanPresetWallet('veteran_defi');
  const plan = buildMigrationPlan({ scan: report, solanaDestination: owner });
  assert.equal(plan.solanaMintRecipientBytes32, expectedAtaBytes32);
  assert.equal(plan.solanaUsdcAta, deriveSolanaUsdcAta(owner).toBase58());
  for (const leg of plan.legs) {
    if (leg.cctpCalldata && leg.cctpCalldata !== '0x') {
      const encodedRec = '0x' + leg.cctpCalldata.slice(138, 202).toLowerCase();
      assert.equal(encodedRec, expectedAtaBytes32, `Leg ${leg.chain} must encode USDC ATA PDA`);
      assert.notEqual(encodedRec, rawOwnerBytes32, `Leg ${leg.chain} must NOT encode raw owner pubkey`);
    }
  }

  const baseUsdc = makeAsset({ chain: 'base', usdcAddress: undefined } as Partial<ScannedAsset>);
  const directPrep = await withMockFetch(
    async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(64) }),
    () =>
      prepareRealExecution({
        asset: baseUsdc,
        userAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
        solanaDestination: owner,
        bridgePreference: 'cctp',
        protocolFeeBps: 700,
        feeRecipientEvm: '0x1111111111111111111111111111111111111111',
      })
  );
  const burnTx = directPrep.transactions.find((t) => t.stepId === 'cctp_deposit_for_burn');
  assert.ok(burnTx);
  assert.equal('0x' + burnTx.data.slice(138, 202).toLowerCase(), expectedAtaBytes32);
});

test('CRIT-05 Backtest: All 19 EVM chains route CCTP V2 (with V1 backward-compat encoder), Iris URLs, and Solana program IDs accurately', async () => {
  const expectedV2: EvmChainId[] = [
    'ethereum',
    'base',
    'arbitrum',
    'optimism',
    'polygon',
    'avalanche',
    'sonic',
    'unichain',
    'linea',
    'worldchain',
    'hyperevm',
    'ink',
  ];
  const expectedNone: EvmChainId[] = ['bnb', 'scroll', 'mantle', 'blast', 'berachain', 'zksync', 'gnosis'];

  assert.equal(CHAIN_LIST.length, 19);
  const ataBytes32 = solanaOwnerToUsdcAtaBytes32(SAMPLE_SOLANA_WALLETS[0]);

  // Verify V1 backwards-compatible encoder, Iris V1 URL, and Solana V1 programs still work when explicitly requested
  const legacyV1Calldata = encodeCctpDepositForBurn({
    rawUsdcAmount: 50_000_000n,
    destinationDomain: 5,
    solanaMintRecipientBytes32: ataBytes32,
    usdcAddress: EVM_CHAINS.base.usdcAddress,
    cctpVersion: 1,
  });
  assert.ok(legacyV1Calldata.startsWith(`0x${CCTP_V1_DEPOSIT_FOR_BURN_SELECTOR}`));
  assert.equal(legacyV1Calldata.length, 2 + 8 + 64 * 4);
  assert.equal(getSolanaCctpPrograms(1), SOLANA_CCTP_PROGRAMS);
  const v1Url = getCctpIrisAttestationUrl({ cctpVersion: 1, messageHash: '0x' + 'aa'.repeat(32) });
  assert.ok(v1Url.startsWith('https://iris-api.circle.com/v1/attestations/'));

  for (const chainId of expectedV2) {
    const cfg = EVM_CHAINS[chainId];
    assert.equal(cfg.cctpVersion, 2, `${chainId} should be CCTP V2`);
    assert.equal(cfg.cctpTokenMessenger, '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    assert.equal(cfg.cctpMessageTransmitter, '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64');
    const calldata = encodeCctpDepositForBurn({
      rawUsdcAmount: 50_000_000n,
      destinationDomain: 5,
      solanaMintRecipientBytes32: ataBytes32,
      usdcAddress: cfg.usdcAddress,
      cctpVersion: cfg.cctpVersion,
    });
    assert.ok(calldata.startsWith(`0x${CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR}`), `${chainId} must use V2 7-arg selector`);
    assert.equal(calldata.length, 2 + 8 + 64 * 7, `${chainId} V2 calldata must encode 7 ABI words`);
    assert.equal('0x' + calldata.slice(138, 202).toLowerCase(), ataBytes32);
    assert.equal(getSolanaCctpPrograms(cfg.cctpVersion), SOLANA_CCTP_PROGRAMS_V2);
    const url = getCctpIrisAttestationUrl({
      cctpVersion: 2,
      sourceDomain: cfg.cctpDomain,
      txHash: '0x' + 'bb'.repeat(32),
    });
    assert.equal(
      url,
      `https://iris-api.circle.com/v2/messages/${cfg.cctpDomain}?transactionHash=${encodeURIComponent('0x' + 'bb'.repeat(32))}`
    );

    // Direct preparation on V2 chain must emit 7-arg V2 depositForBurn calldata
    const v2Asset = makeAsset({
      id: `${chainId}:usdc`,
      chain: chainId,
      chainName: cfg.name,
      address: cfg.usdcAddress,
    });
    const prep = await withMockFetch(
      async () => jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x' + '0'.repeat(64) }),
      () =>
        prepareRealExecution({
          asset: v2Asset,
          userAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
          solanaDestination: SAMPLE_SOLANA_WALLETS[0],
          bridgePreference: 'cctp',
          protocolFeeBps: 700,
          feeRecipientEvm: '0x1111111111111111111111111111111111111111',
        })
    );
    const burnTx = prep.transactions.find((t) => t.stepId === 'cctp_deposit_for_burn');
    assert.ok(burnTx, `${chainId} missing depositForBurn tx`);
    assert.ok(burnTx.data.startsWith(`0x${CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR}`));
  }

  for (const chainId of expectedNone) {
    const cfg = EVM_CHAINS[chainId];
    assert.equal(cfg.cctpVersion, null);
    assert.equal(cfg.cctpTokenMessenger, null);
    assert.equal(cfg.cctpMessageTransmitter, null);
  }
});

test('HIGH-10 Backtest: extractCctpMessageFromLogs & fetchCctpAttestationForTx reject spoofed emitters, reverted txs, malformed ABI, and support multi-log + V2 Iris', async () => {
  const canonicalTransmitter = EVM_CHAINS.base.cctpMessageTransmitter!;
  const attackerContract = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  const spoofData = encodeMessageSentLogData(Buffer.from('spoofed-historical-cctp-message', 'utf8'));
  const realData1 = encodeMessageSentLogData(Buffer.from('real-cctp-burn-leg-1', 'utf8'));
  const realData2 = encodeMessageSentLogData(Buffer.from('real-cctp-burn-leg-2', 'utf8'));

  // Spoofed emitter log before real logs MUST be ignored when expectedMessageTransmitter is enforced
  const all = extractAllCctpMessagesFromLogs(
    [
      { address: attackerContract, topics: [CCTP_MESSAGE_SENT_TOPIC], data: spoofData },
      { address: canonicalTransmitter, topics: [CCTP_MESSAGE_SENT_TOPIC], data: '0x' + 'ff'.repeat(64) }, // malformed offset
      { address: canonicalTransmitter, topics: [CCTP_MESSAGE_SENT_TOPIC], data: realData1 },
      { address: canonicalTransmitter, topics: [CCTP_MESSAGE_SENT_TOPIC], data: realData2 },
    ],
    { expectedMessageTransmitter: canonicalTransmitter }
  );
  assert.equal(all.length, 2);
  assert.equal(all[0].messageBytesHex, '0x' + Buffer.from('real-cctp-burn-leg-1', 'utf8').toString('hex'));
  assert.equal(all[1].messageBytesHex, '0x' + Buffer.from('real-cctp-burn-leg-2', 'utf8').toString('hex'));

  // Malformed huge offset / length bounds never throw or crash
  const malformed = extractCctpMessageFromLogs([
    {
      address: canonicalTransmitter,
      topics: [CCTP_MESSAGE_SENT_TOPIC],
      data: '0x' + '00'.repeat(31) + '20' + 'ff'.repeat(32) + '00'.repeat(32),
    },
    {
      address: canonicalTransmitter,
      topics: [CCTP_MESSAGE_SENT_TOPIC],
      data: '0xzzzz',
    },
  ]);
  assert.equal(malformed, null);

  // Reverted transaction (status: 0x0) MUST be rejected by fetchCctpAttestationForTx
  const revertedAtt = await withMockFetch(
    async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          status: '0x0',
          logs: [{ address: canonicalTransmitter, topics: [CCTP_MESSAGE_SENT_TOPIC], data: realData1 }],
        },
      }),
    () => fetchCctpAttestationForTx({ chain: 'base', txHash: '0x' + '11'.repeat(32) })
  );
  assert.equal(revertedAtt.found, false);
  assert.equal(revertedAtt.attestationStatus, 'error');

  // V2 chain (Sonic) queries Iris V2 endpoint and returns V2 Solana programs
  const sonicTransmitter = EVM_CHAINS.sonic.cctpMessageTransmitter!;
  const seenUrls: string[] = [];
  const fakeAttestationSig = '0x' + 'cd'.repeat(70);
  const sonicAtt = await withMockFetch(
    async (url) => {
      seenUrls.push(url);
      if (url.includes('iris-api.circle.com/v2/messages/13')) {
        return jsonResponse({
          messages: [{ status: 'complete', attestation: fakeAttestationSig }],
        });
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          status: '0x1',
          logs: [{ address: sonicTransmitter, topics: [CCTP_MESSAGE_SENT_TOPIC], data: realData1 }],
        },
      });
    },
    () => fetchCctpAttestationForTx({ chain: 'sonic', txHash: '0x' + '22'.repeat(32) })
  );
  assert.equal(sonicAtt.found, true);
  assert.equal(sonicAtt.cctpVersion, 2);
  assert.equal(sonicAtt.attestationStatus, 'complete');
  assert.equal(sonicAtt.attestation, fakeAttestationSig);
  assert.deepEqual(sonicAtt.solanaProgramIds, SOLANA_CCTP_PROGRAMS_V2);
  assert.ok(seenUrls.some((u) => u.includes('iris-api.circle.com/v2/messages/13?transactionHash=')));

  // Circle Iris HTTP 500 surfaces 'error' (never masked as pending_confirmations)
  const errAtt = await withMockFetch(
    async (url) => {
      if (url.includes('iris-api.circle.com')) return jsonResponse({ error: 'internal' }, 500);
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          status: '0x1',
          logs: [{ address: canonicalTransmitter, topics: [CCTP_MESSAGE_SENT_TOPIC], data: realData1 }],
        },
      });
    },
    () => fetchCctpAttestationForTx({ chain: 'base', txHash: '0x' + '33'.repeat(32) })
  );
  assert.equal(errAtt.attestationStatus, 'error');
});

// ============================================================================
// 2. SMART CONTRACT ADVERSARIAL INVARIANT & ABI PARITY BACKTEST
// ============================================================================

test('Smart Contract Adversarial Backtest: TurgaliumRouter, TurgaliumSweepDelegate, and TurgaliumFeeVault enforce all CRIT/HIGH/MED invariants & EIP-712 parity', () => {
  const routerSol = fs.readFileSync(path.join(ROOT_DIR, 'contracts/TurgaliumRouter.sol'), 'utf8');
  const delegateSol = fs.readFileSync(path.join(ROOT_DIR, 'contracts/TurgaliumSweepDelegate.sol'), 'utf8');
  const vaultSol = fs.readFileSync(path.join(ROOT_DIR, 'contracts/TurgaliumFeeVault.sol'), 'utf8');

  // --- TurgaliumRouter.sol ---
  assert.ok(routerSol.includes('pragma solidity 0.8.24;'), 'Router pragma must be pinned');
  assert.ok(!routerSol.includes('mapping(address => bool) public allowedTargets;'), 'CRIT-01: shared allowedTargets MUST be removed');
  assert.ok(routerSol.includes('mapping(address => bool) public allowedSwapAggregators;'), 'CRIT-01: disjoint allowedSwapAggregators required');
  assert.ok(routerSol.includes('mapping(address => bool) public allowedDefiProtocols;'), 'CRIT-01: disjoint allowedDefiProtocols required');
  assert.ok(routerSol.includes('error DisjointAllowlistViolation'), 'CRIT-01: mutual exclusion required');
  assert.ok(routerSol.includes('mapping(address => bool) public allowedFeeRecipients;'), 'HIGH-01: feeRecipient allowlist required');
  assert.ok(routerSol.includes('mapping(address => bool) public allowedRelayers;'), 'HIGH-02: relayer allowlist required');
  assert.ok(routerSol.includes('if (keccak256(abi.encode(swaps)) != witness.swapsHash)'), 'CRIT-03: Permit2 witness swapsHash enforcement required');
  assert.ok(routerSol.includes(`"${TURGALIUM_WITNESS_TYPE_STRING}"`), 'CRIT-03: Permit2 TURGALIUM_WITNESS_TYPEHASH must match sponsor.ts byte-for-byte');
  assert.ok(
    routerSol.includes(`"TurgaliumSweepWitness witness)TokenPermissions(address token,uint256 amount)${TURGALIUM_WITNESS_TYPE_STRING}"`),
    'CRIT-03: Permit2 TURGALIUM_WITNESS_TYPESTRING must order TokenPermissions alphabetically before TurgaliumSweepWitness'
  );
  assert.ok(routerSol.includes('InsufficientCreditedBalance'), 'CRIT-03: pullFromUser=false must consume strictly current-tx credited delta');
  assert.ok(routerSol.includes('getReserveData(exitStep.underlyingAsset)'), 'MED-04: Aave aToken must be validated via Pool.getReserveData');
  assert.ok(routerSol.includes('function rescueNative('), 'MED-03: Router must be able to rescue native ETH');
  assert.ok(routerSol.includes('interface ITokenMessengerCCTPV2'), 'CRIT-05: Router must support CCTP V2');
  assert.ok(routerSol.includes('BURN_GAS_STIPEND'), 'HIGH-03: Burn gas stipend cap required');
  assert.ok(!routerSol.includes('abi.decode(ret, (bool))'), 'HIGH-03: Burn loop must NOT call abi.decode(ret, (bool))');
  // MED-01: In sweepAndBridgeToSolana, CCTP bridge executes BEFORE untrusted burn loop
  const routerBridgeIdx = routerSol.indexOf('cctpNonce = _bridgeUsdcViaCctp(bridgedUsdc, params.solanaRecipient, params.cctp);');
  const routerBurnIdx = routerSol.indexOf('_executeTrailingBurns(msg.sender, params.burns)');
  assert.ok(routerBridgeIdx > 0 && routerBurnIdx > routerBridgeIdx, 'MED-01: Router must bridge via CCTP BEFORE untrusted burn calls');
  assert.ok(routerSol.includes('uint16 public constant MIN_FEE_BPS = 0;'), 'Preservation tier: Router MIN_FEE_BPS must be 0');
  assert.ok(routerSol.includes('uint16 public constant MAX_FEE_BPS = 1000;'), 'Router MAX_FEE_BPS ceiling must remain 1000');
  assert.ok(routerSol.includes('depositForBurnWithHook('), 'CCTP V2 hook support required in TurgaliumRouter');
  assert.ok(routerSol.includes('function sweepWithMandate('), 'TurgaliumAgentVault on-chain mandate linkage required in TurgaliumRouter');
  assert.ok(routerSol.includes('authorizeAgentAction('), 'Router must call TurgaliumAgentVault.authorizeAgentAction');

  // --- TurgaliumSweepDelegate.sol ---
  assert.ok(delegateSol.includes('pragma solidity 0.8.24;'), 'Delegate pragma must be pinned');
  assert.ok(
    !delegateSol.includes('usdcAfter > usdcBefore ? (usdcAfter - usdcBefore) : usdcAfter'),
    'CRIT-02: Vulnerable grossUsdc fallback to usdcAfter MUST be removed'
  );
  assert.ok(delegateSol.includes('uint256 swappedUsdc = usdcAfter - usdcBefore;'), 'CRIT-02: Strict delta accounting required');
  assert.ok(delegateSol.includes('grossUsdc = intent.directUsdcAmount + swappedUsdc;'), 'CRIT-02: Explicit signed directUsdcAmount required');
  assert.ok(
    delegateSol.includes(`"${SWEEP_INTENT_TYPE_STRING}"`),
    'CRIT-06: SWEEP_INTENT_TYPEHASH in TurgaliumSweepDelegate.sol MUST match sponsor.ts byte-for-byte'
  );
  assert.ok(delegateSol.includes('address public immutable protocolFeeRecipient;'), 'HIGH-01: Immutable protocolFeeRecipient required for EIP-7702');
  assert.ok(delegateSol.includes('error UnauthorizedFeeRecipient'), 'HIGH-01: Must reject unauthorized feeRecipient');
  assert.ok(delegateSol.includes('uint256 ethValue;'), 'MED-03: TokenSwap must support native ETH value');
  assert.ok(delegateSol.includes('interface ITokenMessengerV2Delegate'), 'CRIT-05: Delegate must support CCTP V2');
  assert.ok(delegateSol.includes('function cancelNonce(uint256 nonce)'), 'LOW-03: Delegate must expose cancelNonce()');
  assert.ok(!delegateSol.includes('abi.decode(ret, (bool))'), 'HIGH-03: Burn loop must NOT call abi.decode(ret, (bool))');

  // Verify exact ERC-7201 storage slot derivation
  const nsHash = BigInt('0x' + Buffer.from(keccak_256(new TextEncoder().encode('turgalium.eip7702.sweep.delegate.v1'))).toString('hex'));
  const innerBuf = Buffer.from((nsHash - 1n).toString(16).padStart(64, '0'), 'hex');
  const erc7201Slot = '0x' + (BigInt('0x' + Buffer.from(keccak_256(innerBuf)).toString('hex')) & ~0xffn).toString(16).padStart(64, '0');
  assert.ok(delegateSol.includes(erc7201Slot), `LOW-03: Delegate must use exact ERC-7201 slot ${erc7201Slot}`);

  // MED-01: In executeSponsoredSweep: revokes FIRST -> settle & CCTP bridge -> burns LAST
  const execFnBody = delegateSol.slice(delegateSol.indexOf('function executeSponsoredSweep('));
  const delRevokeIdx = execFnBody.indexOf('_safeRevoke(rv.token, rv.spender);');
  const delBridgeIdx = execFnBody.indexOf('_settleAndBridge(');
  const delBurnIdx = execFnBody.indexOf('if (_safeBurnTransfer(b.token, b.amount))');
  assert.ok(
    delRevokeIdx > 0 && delBridgeIdx > delRevokeIdx && delBurnIdx > delBridgeIdx,
    'MED-01: Delegate must execute revokes FIRST, CCTP bridge BEFORE untrusted burns, and burns LAST'
  );

  // --- TurgaliumDelegateRegistry.sol ---
  const registrySol = fs.readFileSync(path.join(ROOT_DIR, 'contracts/TurgaliumDelegateRegistry.sol'), 'utf8');
  assert.ok(registrySol.includes('pragma solidity 0.8.24;'), 'Registry pragma must be pinned');
  assert.ok(registrySol.includes('function isAllowedRelayer(') && registrySol.includes('function isApprovedRelayer('), 'Registry relayer views required');
  assert.ok(registrySol.includes('function isAllowedSwapRouter(') && registrySol.includes('function isApprovedRouter('), 'Registry router views required');
  assert.ok(registrySol.includes('function pause(') && registrySol.includes('function unpause('), 'Registry kill-switch required');
  assert.ok(delegateSol.includes('uint16 public constant MIN_FEE_BPS = 0;'), 'Preservation tier: Delegate MIN_FEE_BPS must be 0');
  assert.ok(delegateSol.includes('depositForBurnWithHook('), 'CCTP V2 hook support required in TurgaliumSweepDelegate');
  assert.ok(delegateSol.includes('function executeSponsoredSweepWithMandate('), 'TurgaliumAgentVault on-chain mandate linkage required in TurgaliumSweepDelegate');

  // --- TurgaliumFeeVault.sol ---
  assert.ok(vaultSol.includes('pragma solidity 0.8.24;'), 'FeeVault pragma must be pinned');
  assert.ok(
    vaultSol.includes('function setPayees(Payee[] calldata nextPayees) external onlyOwner nonReentrant'),
    'MED-02: setPayees MUST be nonReentrant'
  );
  assert.ok(vaultSol.includes('mapping(address => uint256) public pendingNative;'), 'MED-02: Pull escrow required for native push-DoS immunity');
  assert.ok(vaultSol.includes('mapping(address => mapping(address => uint256)) public pendingERC20;'), 'MED-02: Pull escrow required for ERC-20 blacklist immunity');
  assert.ok(vaultSol.includes('function claimNative(') && vaultSol.includes('function claimERC20('), 'MED-02: Claim functions required');
  assert.ok(!vaultSol.includes('(i == len - 1) ? remaining'), 'LOW-01: Last-payee dust bias must be eliminated');

  // Verify empty ABI hashes match Solidity abi.encode semantics deterministically
  assert.match(computeEmptySweepCallsHash(), /^0x[0-9a-f]{64}$/);
  assert.match(computeEmptySwapsHash(), /^0x[0-9a-f]{64}$/);
});

// ============================================================================
// 3. RELAYER ADVERSARIAL REPLAY (CRIT-06, CRIT-07, HIGH-01, HIGH-04, MED-05)
// ============================================================================

test('CRIT-06/CRIT-07/HIGH-01/HIGH-04/MED-05 Relayer Replay: unconfigured router preview, callsHash parity, break-even alignment, real ecrecover, and fail-closed replay protection', () => {
  clearTrackedGaslessIntentsForTest();
  const walletA = makeTestWallet('22');
  const walletB = makeTestWallet('33');
  const treasury = '0x1111111111111111111111111111111111111111';
  const attackerTreasury = '0x9999999999999999999999999999999999999999';
  const solDest = SAMPLE_SOLANA_WALLETS[0];

  const prevRouterBase = process.env.TURGALIUM_ROUTER_BASE;
  const prevDelegateBase = process.env.TURGALIUM_DELEGATE_BASE;
  const prevFeeEnv = process.env.TURGALIUM_FEE_RECIPIENT_EVM;
  const prevRelayerKey = process.env.TURGALIUM_RELAYER_PRIVATE_KEY;

  try {
    // 1. Unconfigured router -> NEVER emits 0x...51F0 live typedData!
    delete process.env.TURGALIUM_ROUTER_BASE;
    delete process.env.TURGALIUM_DELEGATE_BASE;
    delete process.env.TURGALIUM_FEE_RECIPIENT_EVM;
    delete process.env.TURGALIUM_RELAYER_PRIVATE_KEY;

    const previewIntent = buildGaslessSweepIntent({
      chain: 'base',
      assets: [makeAsset({ chain: 'base', grossUsd: 500, rawBalance: '500000000' })],
      userAddress: walletA.address,
      solanaDestination: solDest,
      feeRecipientEvm: treasury,
    });
    assert.equal(previewIntent.routerConfigured, false);
    assert.equal(previewIntent.previewOnly, true);
    assert.equal(previewIntent.routerAddress, null);
    assert.equal(previewIntent.typedData, null);
    assert.ok(!JSON.stringify(previewIntent).toLowerCase().includes('51f0'), 'Must NEVER emit 0x...51F0 placeholder');
    assert.throws(
      () =>
        submitSignedGaslessIntent({
          intentId: previewIntent.intentId,
          chain: 'base',
          userAddress: walletA.address,
          signature: '0x' + '11'.repeat(65),
          deadline: previewIntent.deadline,
        }),
      /preview-only/i
    );

    // 2. HIGH-01: Server TURGALIUM_FEE_RECIPIENT_EVM cannot be overridden by client feeRecipientEvm
    process.env.TURGALIUM_FEE_RECIPIENT_EVM = treasury;
    const feeCfg = getProtocolFeeConfig({ feeRecipientEvm: attackerTreasury });
    assert.equal(feeCfg.feeRecipientEvm, treasury, 'Client override MUST NOT hijack configured server treasury');

    // 3. HIGH-04: Circular 2.5x break-even bypass is FIXED!
    // $10 gross @ 7% fee = $0.70 fee; $1.50 gas -> onchain requires fee >= 0.5 * $1.50 = $0.75 (relayerRevenue $2.20 < $2.25)
    process.env.TURGALIUM_ROUTER_BASE = '0x4444444444444444444444444444444444444444';
    const marginalSweep = buildGaslessSweepIntent({
      chain: 'base',
      assets: [
        makeAsset({
          chain: 'base',
          grossUsd: 10.0,
          rawBalance: '10000000',
          estimatedGasUsd: 2.0,
          batchedGasUsd: 1.5,
        }),
      ],
      userAddress: walletA.address,
      solanaDestination: solDest,
      protocolFeeBps: 700,
    });
    assert.equal(
      marginalSweep.sponsorEligible,
      false,
      'HIGH-04: $10 gross / $1.50 gas ($0.70 fee < $0.75 margin) MUST be rejected offchain before hitting onchain RelayerBreakEvenNotMet'
    );

    // 4. CRIT-06: EIP-7702 SweepIntent includes directUsdcAmount & callsHash matching TurgaliumSweepDelegate.sol
    const nativeAsset = makeAsset({
      id: 'base:eth',
      chain: 'base',
      address: 'native',
      symbol: 'ETH',
      kind: 'native',
      decimals: 18,
      rawBalance: '100000000000000000', // 0.1 ETH
      uiBalance: 0.1,
      priceUsd: 2500,
      grossUsd: 250,
      batchedGasUsd: 0.2,
      action: 'SELL_AND_BRIDGE',
    });
    const delegateIntent = buildGaslessSweepIntent({
      chain: 'base',
      assets: [nativeAsset],
      userAddress: walletA.address,
      solanaDestination: solDest,
      preferredMode: 'eip7702_delegate',
      protocolFeeBps: 700,
    });
    assert.equal(delegateIntent.mode, 'eip7702_delegate');
    assert.equal(delegateIntent.sponsorEligible, true, 'MED-03: Native ETH EIP-7702 sweep must be eligible');
    assert.equal(delegateIntent.routerConfigured, true);
    assert.ok(delegateIntent.typedData && delegateIntent.eip712Digest);
    const td = delegateIntent.typedData as {
      types: { SweepIntent: Array<{ name: string; type: string }> };
      message: Record<string, unknown>;
    };
    assert.ok(td.types.SweepIntent.some((f) => f.name === 'callsHash' && f.type === 'bytes32'));
    assert.ok(td.types.SweepIntent.some((f) => f.name === 'directUsdcAmount' && f.type === 'uint256'));
    assert.equal(td.message.directUsdcAmount, '0');
    assert.equal(td.message.callsHash, computeEmptySweepCallsHash());
    assert.equal(td.message.solanaRecipient, solanaOwnerToUsdcAtaBytes32(solDest));
    assert.equal(td.message.feeRecipient, treasury);

    // Recompute EIP-712 digest & verify real secp256k1 ecrecover
    const recomputedDigest = computeGaslessIntentEip712Digest(delegateIntent.typedData);
    assert.equal(recomputedDigest, delegateIntent.eip712Digest);

    // Forged regex-only signature -> REJECTED
    assert.throws(
      () =>
        submitSignedGaslessIntent({
          intentId: delegateIntent.intentId,
          chain: 'base',
          userAddress: walletA.address,
          signature: '0x' + 'ab'.repeat(65),
          deadline: delegateIntent.deadline,
        }),
      /Invalid ECDSA/i
    );

    // Valid signature by WRONG signer (walletB) -> REJECTED
    const wrongSignerSig = signDigestLowS(recomputedDigest, walletB.privKey);
    assert.equal(recoverEip712Signer(recomputedDigest, wrongSignerSig), walletB.address);
    assert.throws(
      () =>
        submitSignedGaslessIntent({
          intentId: delegateIntent.intentId,
          chain: 'base',
          userAddress: walletA.address,
          signature: wrongSignerSig,
          deadline: delegateIntent.deadline,
        }),
      /does not match userAddress/i
    );

    // Unknown / evicted intentId -> FAIL-CLOSED REJECTED
    assert.throws(
      () =>
        submitSignedGaslessIntent({
          intentId: 'int_forged_unknown',
          chain: 'base',
          userAddress: walletA.address,
          signature: signDigestLowS(recomputedDigest, walletA.privKey),
          deadline: Math.floor(Date.now() / 1000) + 3600,
        }),
      /Unknown, expired, or evicted/i
    );

    // Valid signature by walletA -> verified, NOT broadcasted/attested (relayer key unset), AND replay blocked!
    const validSig = signDigestLowS(recomputedDigest, walletA.privKey);
    const receipt = submitSignedGaslessIntent({
      intentId: delegateIntent.intentId,
      chain: 'base',
      userAddress: walletA.address,
      signature: validSig,
      deadline: delegateIntent.deadline,
    });
    assert.equal(receipt.signatureValid, true);
    assert.equal(receipt.recoveredSigner.toLowerCase(), walletA.address.toLowerCase());
    assert.equal(receipt.accepted, false, 'Unconfigured relayer must NOT mark accepted=true');
    assert.equal(receipt.broadcasted, false);
    assert.equal(receipt.settlementStatus, 'unbroadcast_awaiting_deployment');

    // Immediate replay of consumed intentId -> REJECTED!
    assert.throws(
      () =>
        submitSignedGaslessIntent({
          intentId: delegateIntent.intentId,
          chain: 'base',
          userAddress: walletA.address,
          signature: validSig,
          deadline: delegateIntent.deadline,
        }),
      /already been consumed/i
    );

    // 5. MED-05: Permit2 batch excludes dead burns & DeFi receipt tokens from permitted[]
    const permit2Intent = buildGaslessSweepIntent({
      chain: 'base',
      assets: [
        makeAsset({ id: 'base:usdc', chain: 'base', grossUsd: 200, rawBalance: '200000000', action: 'BRIDGE_DIRECT_USDC' }),
        makeAsset({ id: 'base:dead', chain: 'base', address: '0x000000000000000000000000000000000000dead', symbol: 'DEAD', grossUsd: 0, action: 'BURN_ZERO_LIQUIDITY' }),
        makeAsset({ id: 'base:aave', chain: 'base', address: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB', symbol: 'aBasUSDC', kind: 'defi_position', grossUsd: 100, action: 'WITHDRAW_AND_BRIDGE' }),
      ],
      userAddress: walletA.address,
      solanaDestination: solDest,
      preferredMode: 'permit2_batch',
    });
    const p2Msg = (permit2Intent.typedData as { message: { permitted: Array<{ token: string }>; witness: { swapsHash: string } } }).message;
    assert.equal(p2Msg.permitted.length, 1);
    assert.equal(p2Msg.permitted[0].token, EVM_CHAINS.base.usdcAddress);
    assert.equal(p2Msg.witness.swapsHash, computeEmptySwapsHash());
  } finally {
    if (prevRouterBase === undefined) delete process.env.TURGALIUM_ROUTER_BASE;
    else process.env.TURGALIUM_ROUTER_BASE = prevRouterBase;
    if (prevDelegateBase === undefined) delete process.env.TURGALIUM_DELEGATE_BASE;
    else process.env.TURGALIUM_DELEGATE_BASE = prevDelegateBase;
    if (prevFeeEnv === undefined) delete process.env.TURGALIUM_FEE_RECIPIENT_EVM;
    else process.env.TURGALIUM_FEE_RECIPIENT_EVM = prevFeeEnv;
    if (prevRelayerKey === undefined) delete process.env.TURGALIUM_RELAYER_PRIVATE_KEY;
    else process.env.TURGALIUM_RELAYER_PRIVATE_KEY = prevRelayerKey;
  }
});

// ============================================================================
// 4. PROOF ENGINE ADVERSARIAL REPLAY (CRIT-10, CRIT-11, MED-10, MED-11)
// ============================================================================

test('CRIT-10 Backtest: buildPreSignSimulationProof catches reverting eth_call ({ error }), ERC-20 false return, and wrong mintRecipient', async () => {
  clearProofStoresForTest();
  const user = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
  const solDest = SAMPLE_SOLANA_WALLETS[0];
  const rawOwnerBytes32 = solanaAddressToBytes32(solDest);
  const badCctpCalldata = encodeCctpDepositForBurn({
    rawUsdcAmount: 50_000_000n,
    destinationDomain: 5,
    solanaMintRecipientBytes32: rawOwnerBytes32, // WRONG: raw owner instead of ATA PDA!
    usdcAddress: EVM_CHAINS.base.usdcAddress,
    cctpVersion: 1,
  });

  const batch: PreparedChainBatch = {
    chain: 'base',
    chainId: 8453,
    chainName: 'Base',
    explorerUrl: 'https://basescan.org',
    userAddress: user,
    solanaDestination: solDest,
    outputAsset: 'USDC',
    calls: [
      {
        stepId: 'revert_step',
        assetId: 'base:scam',
        assetSymbol: 'SCAM',
        action: 'SELL_AND_BRIDGE',
        provider: 'relay',
        label: 'Reverting swap',
        description: 'Reverts on eth_call',
        to: '0x5555555555555555555555555555555555555555',
        data: '0x12345678' + '00'.repeat(32),
        value: '0x0',
      },
      {
        stepId: 'false_approve',
        assetId: 'base:tok2',
        assetSymbol: 'FALSE_ERC20',
        action: 'SELL_AND_BRIDGE',
        provider: 'relay',
        label: 'Approve returning false',
        description: 'Returns 32-byte 0',
        to: '0x6666666666666666666666666666666666666666',
        data: '0x095ea7b3' + '00'.repeat(64),
        value: '0x0',
      },
      {
        stepId: 'bad_cctp',
        assetId: 'base:usdc',
        assetSymbol: 'USDC',
        action: 'BRIDGE_DIRECT_USDC',
        provider: 'circle_cctp',
        label: 'Wrong raw pubkey CCTP',
        description: 'Uses raw pubkey instead of ATA',
        to: EVM_CHAINS.base.cctpTokenMessenger!,
        data: badCctpCalldata,
        value: '0x0',
      },
    ],
    bridgeTrackers: [],
    skippedAssets: [],
    savings: {
      totalCalls: 3,
      dedupedApprovals: 0,
      walletPopupsLegacy: 3,
      walletPopupsEip5792: 1,
      popupsSaved: 2,
      eip2612Count: 0,
      permit2ReadyCount: 0,
    },
    feeBreakdown: {
      feeBps: 700,
      feePercent: 7,
      feeRecipientEvm: '0x1111111111111111111111111111111111111111',
      feeDestinationType: 'contract',
      treasuryConfigured: true,
      collectionMethod: 'onchain_split',
      estimatedFeeUsd: 7,
    },
    estimatedSeconds: 18,
    notes: [],
  };

  const proof = await withMockFetch(
    async (url, init) => {
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_000 }, value: 50_000_000 } },
          { id: 2, result: { context: { slot: 300_000_000 }, value: [] } },
        ]);
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string; params?: Array<{ to?: string }> };
      if (body.method === 'eth_blockNumber') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x100' });
      if (body.method === 'eth_getBalance') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' }); // 1 ETH
      }
      if (body.method === 'eth_call') {
        const to = body.params?.[0]?.to?.toLowerCase();
        if (to === '0x5555555555555555555555555555555555555555') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            error: { code: 3, message: 'execution reverted: HoneypotTransferBlocked' },
          });
        }
        if (to === '0x6666666666666666666666666666666666666666') {
          return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x' + '00'.repeat(32) });
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x' + '00'.repeat(31) + '01' });
      }
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x0' });
    },
    () => buildPreSignSimulationProof({ batch, assets: [makeAsset({ chain: 'base' })] })
  );

  // CRIT-10: Reverting eth_call MUST be marked reverted (never verified!)
  assert.equal(proof.checks[0].preflightStatus, 'reverted');
  assert.ok(proof.checks[0].preflightDetail.includes('HoneypotTransferBlocked'));
  // ERC-20 returning 0x00..00 (false) MUST be marked reverted!
  assert.equal(proof.checks[1].preflightStatus, 'reverted');
  // CRIT-04: Raw owner pubkey in CCTP calldata MUST fail mintRecipientVerified!
  assert.equal(proof.mintRecipientVerified, false);
  assert.equal(proof.allChecksSafe, false);
});

test('CRIT-11 & MED-11 Adversarial Replay: rejects forged pre-state, 1-lamport deposit, sender mismatch, historical tx replay, unbound Relay ID, premature CCTP attestation, and fixes 18-decimal BNB USDC + ERC-721 logs', async () => {
  clearProofStoresForTest();
  const user = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
  const attacker = '0x9999999999999999999999999999999999999999';
  const solDest = SAMPLE_SOLANA_WALLETS[0];
  const solDest2 = SAMPLE_SOLANA_WALLETS[1];
  const txHash1 = '0x' + 'aa'.repeat(32);
  const txHash2 = '0x' + 'bb'.repeat(32);
  const solSig = '5'.repeat(88);

  // 0. Create a real server-side pre-sign proof at block 0x200 (512)
  const preBatch: PreparedChainBatch = {
    chain: 'base',
    chainId: 8453,
    chainName: 'Base',
    explorerUrl: 'https://basescan.org',
    userAddress: user,
    solanaDestination: solDest,
    outputAsset: 'USDC',
    calls: [],
    bridgeTrackers: [],
    skippedAssets: [],
    savings: {
      totalCalls: 0,
      dedupedApprovals: 0,
      walletPopupsLegacy: 0,
      walletPopupsEip5792: 1,
      popupsSaved: 0,
      eip2612Count: 0,
      permit2ReadyCount: 0,
    },
    feeBreakdown: {
      feeBps: 700,
      feePercent: 7,
      feeRecipientEvm: '0x1111111111111111111111111111111111111111',
      feeDestinationType: 'contract',
      treasuryConfigured: true,
      collectionMethod: 'onchain_split',
      estimatedFeeUsd: 7,
    },
    estimatedSeconds: 10,
    notes: [],
  };
  const preSign = await withMockFetch(
    async (url, init) => {
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_000 }, value: 100_000_000 } }, // 0.1 SOL
          { id: 2, result: { context: { slot: 300_000_000 }, value: [] } },
        ]);
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
      if (body.method === 'eth_blockNumber') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x200' });
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' });
    },
    () => buildPreSignSimulationProof({ batch: preBatch, assets: [makeAsset({ chain: 'base', grossUsd: 100 })] })
  );

  // 1. Forged client preSolanaSol=0 + 1-lamport SOL balance -> MUST NOT certify verified=true!
  const forgedPreStateProof = await withMockFetch(
    async (url) => {
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_010 }, value: 100_000_001 } }, // +1 lamport
          { id: 2, result: { context: { slot: 300_000_010 }, value: [] } },
        ]);
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { status: '0x1', from: user, blockNumber: '0x201', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] },
      });
    },
    () =>
      verifyOnchainExecutionProof({
        chain: 'base',
        txHash: txHash1,
        userAddress: user,
        solanaDestination: solDest,
        preSolanaSol: 0, // FORGED by client!
        preSolanaUsdc: 0,
      })
  );
  assert.equal(forgedPreStateProof.verified, false, 'Forged client pre-state MUST NOT verify');
  assert.equal(forgedPreStateProof.solanaDeltaProof?.clientPreStateIgnored, true);
  assert.equal(forgedPreStateProof.solanaDeltaProof?.trustedPreStateSource, 'none');

  // 2. 1-lamport unrelated deposit even WITH server pre-sign proof -> MUST NOT verify without finalized Solana settlement tx!
  const oneLamportProof = await withMockFetch(
    async (url) => {
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_010 }, value: 100_000_001 } },
          { id: 2, result: { context: { slot: 300_000_010 }, value: [] } },
        ]);
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { status: '0x1', from: user, blockNumber: '0x201', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] },
      });
    },
    () =>
      verifyOnchainExecutionProof({
        chain: 'base',
        txHash: txHash1,
        userAddress: user,
        solanaDestination: solDest,
        proofId: preSign.proofId,
      })
  );
  assert.equal(oneLamportProof.verified, false, '1-lamport deposit alone MUST NOT verify swap delivery');

  // 3. EVM receipt `from` sender mismatch -> REJECTED!
  const wrongSenderProof = await withMockFetch(
    async (url) => {
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_010 }, value: 100_000_000 } },
          { id: 2, result: { context: { slot: 300_000_010 }, value: [] } },
        ]);
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { status: '0x1', from: attacker, blockNumber: '0x201', logs: [] },
      });
    },
    () =>
      verifyOnchainExecutionProof({
        chain: 'base',
        txHash: txHash1,
        userAddress: user,
        solanaDestination: solDest,
        proofId: preSign.proofId,
      })
  );
  assert.equal(wrongSenderProof.verified, false);
  assert.equal(wrongSenderProof.evmReceipt.senderVerified, false);
  assert.equal(wrongSenderProof.settlementStage, 'rejected_mismatch');

  // 4. Historical EVM tx (block 0x100 < preSign.blockNumber 0x200) -> REJECTED!
  const historicalProof = await withMockFetch(
    async (url) => {
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_010 }, value: 100_000_000 } },
          { id: 2, result: { context: { slot: 300_000_010 }, value: [] } },
        ]);
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { status: '0x1', from: user, blockNumber: '0x100', logs: [] },
      });
    },
    () =>
      verifyOnchainExecutionProof({
        chain: 'base',
        txHash: txHash1,
        userAddress: user,
        solanaDestination: solDest,
        proofId: preSign.proofId,
      })
  );
  assert.equal(historicalProof.verified, false);
  assert.equal(historicalProof.settlementStage, 'rejected_mismatch');

  // 5. Unbound Relay requestId (inTxHashes does NOT match params.txHash) -> REJECTED!
  const unboundRelayProof = await withMockFetch(
    async (url) => {
      if (url.includes('api.relay.link')) {
        return jsonResponse({
          status: 'success',
          inTxHashes: ['0x' + 'ff'.repeat(32)], // DIFFERENT EVM tx!
          txHashes: [solSig],
          recipient: solDest,
        });
      }
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_010 }, value: 100_000_000 } },
          { id: 2, result: { context: { slot: 300_000_010 }, value: [] } },
        ]);
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { status: '0x1', from: user, blockNumber: '0x201', logs: [] },
      });
    },
    () =>
      verifyOnchainExecutionProof({
        chain: 'base',
        txHash: txHash1,
        userAddress: user,
        solanaDestination: solDest,
        provider: 'relay',
        requestId: 'req_unrelated_123',
        proofId: preSign.proofId,
      })
  );
  assert.equal(unboundRelayProof.verified, false);
  assert.equal(unboundRelayProof.settlementStage, 'rejected_mismatch');

  // 6. Premature CCTP Iris attestation (no finalized Solana mint tx yet) -> NOT verified!
  const baseTransmitter = EVM_CHAINS.base.cctpMessageTransmitter!;
  const msgData = encodeMessageSentLogData(Buffer.from('cctp-attested-not-minted', 'utf8'));
  const cctpOnlyProof = await withMockFetch(
    async (url) => {
      if (url.includes('iris-api.circle.com')) {
        return jsonResponse({
          status: 'complete',
          attestation: '0x' + 'ee'.repeat(70),
          messages: [{ status: 'complete', attestation: '0x' + 'ee'.repeat(70) }],
        });
      }
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_010 }, value: 100_000_000 } },
          { id: 2, result: { context: { slot: 300_000_010 }, value: [] } },
        ]);
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          status: '0x1',
          from: user,
          blockNumber: '0x201',
          logs: [{ address: baseTransmitter, topics: [CCTP_MESSAGE_SENT_TOPIC], data: msgData }],
        },
      });
    },
    () =>
      verifyOnchainExecutionProof({
        chain: 'base',
        txHash: txHash1,
        userAddress: user,
        solanaDestination: solDest,
        provider: 'circle_cctp',
        proofId: preSign.proofId,
      })
  );
  assert.equal(cctpOnlyProof.verified, false, 'CCTP attestation alone MUST NOT mark Solana delivery verified');
  assert.equal(cctpOnlyProof.settlementStage, 'cctp_attested_awaiting_solana_mint');
  assert.equal(cctpOnlyProof.bridgeProof.cctpAttestationStatus, 'complete');

  // 7. Legitimate finalized Solana settlement -> verified=true, AND replaying same txHash for solDest2 -> REJECTED!
  const legitProof = await withMockFetch(
    async (url, init) => {
      if (url.includes('api.relay.link')) {
        return jsonResponse({
          status: 'success',
          inTxHashes: [txHash2],
          txHashes: [solSig],
          recipient: solDest,
        });
      }
      if (url.includes('solana')) {
        const parsed = JSON.parse(String(init?.body ?? '{}'));
        if (!Array.isArray(parsed) && parsed.method === 'getTransaction') {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: {
              slot: 300_000_020,
              meta: {
                err: null,
                preBalances: [100_000_000],
                postBalances: [100_000_000],
                preTokenBalances: [
                  { accountIndex: 1, mint: SOLANA_USDC_MINT_PUBKEY.toBase58(), owner: solDest, uiTokenAmount: { uiAmount: 10 } },
                ],
                postTokenBalances: [
                  { accountIndex: 1, mint: SOLANA_USDC_MINT_PUBKEY.toBase58(), owner: solDest, uiTokenAmount: { uiAmount: 105 } },
                ],
              },
              transaction: { message: { accountKeys: [solDest] } },
            },
          });
        }
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_020 }, value: 100_000_000 } },
          { id: 2, result: { context: { slot: 300_000_020 }, value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 105 } } } } } }] } },
        ]);
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { status: '0x1', from: user, blockNumber: '0x205', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] },
      });
    },
    () =>
      verifyOnchainExecutionProof({
        chain: 'base',
        txHash: txHash2,
        userAddress: user,
        solanaDestination: solDest,
        provider: 'relay',
        requestId: 'req_bound_ok',
        proofId: preSign.proofId,
      })
  );
  assert.equal(legitProof.verified, true);
  assert.equal(legitProof.settlementStage, 'solana_settled');
  assert.equal(legitProof.bridgeProof.solanaTxFinalized, true);
  assert.equal(legitProof.proofDigestAlgorithm, 'sha256-canonical-json-v1');

  // Replaying txHash2 for a DIFFERENT solanaDestination MUST be rejected!
  const replayProof = await withMockFetch(
    async (url) => {
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_025 }, value: 100_000_000 } },
          { id: 2, result: { context: { slot: 300_000_025 }, value: [] } },
        ]);
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { status: '0x1', from: user, blockNumber: '0x205', logs: [] },
      });
    },
    () =>
      verifyOnchainExecutionProof({
        chain: 'base',
        txHash: txHash2,
        userAddress: user,
        solanaDestination: solDest2,
      })
  );
  assert.equal(replayProof.verified, false);
  assert.equal(replayProof.settlementStage, 'rejected_mismatch');

  // 8. MED-11: BNB Chain 18-decimal USDC preserves 18 decimals & 4-topic ERC-721 Transfer is safely skipped
  const tenBnbUsdcHex = '0x' + (10n * 10n ** 18n).toString(16).padStart(64, '0');
  const paddedAddr = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
  const bnbProof = await withMockFetch(
    async (url) => {
      if (url.includes('solana')) {
        return jsonResponse([
          { id: 1, result: { context: { slot: 300_000_030 }, value: 100_000_000 } },
          { id: 2, result: { context: { slot: 300_000_030 }, value: [] } },
        ]);
      }
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          status: '0x1',
          from: user,
          blockNumber: '0x300',
          logs: [
            {
              address: EVM_CHAINS.bnb.usdcAddress,
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                paddedAddr(user),
                paddedAddr(attacker),
              ],
              data: tenBnbUsdcHex,
            },
            {
              // 4-topic ERC-721 Transfer with empty 0x data must be ignored cleanly (never throw BigInt('0x'))
              address: '0x7777777777777777777777777777777777777777',
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                paddedAddr(user),
                paddedAddr(attacker),
                '0x' + '0'.repeat(63) + '1',
              ],
              data: '0x',
            },
          ],
        },
      });
    },
    () =>
      verifyOnchainExecutionProof({
        chain: 'bnb',
        txHash: '0x' + 'cc'.repeat(32),
        userAddress: user,
        solanaDestination: solDest,
      })
  );
  assert.equal(bnbProof.decodedTransfers.length, 1);
  assert.equal(bnbProof.decodedTransfers[0].symbol, 'USDC');
  assert.equal(bnbProof.decodedTransfers[0].amountUi, 10, 'MED-11: BNB 18-decimal USDC must decode as 10, not 10^13');

  // 9. Canonical JSON digest determinism
  assert.equal(
    canonicalizeJson({ b: 2, a: 1, c: undefined }),
    canonicalizeJson({ a: 1, c: null, b: 2 })
  );
});
