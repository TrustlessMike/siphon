import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { PublicKey, Transaction } from '@solana/web3.js';
import { aptosAdapter } from '../src/adapters/aptos.js';
import { btcAdapter } from '../src/adapters/btc.js';
import { cosmosAdapter } from '../src/adapters/cosmos.js';
import { suiAdapter } from '../src/adapters/sui.js';
import { tonAdapter } from '../src/adapters/ton.js';
import { tronAdapter } from '../src/adapters/tron.js';
import {
  deriveSolanaUsdcAta,
  SOLANA_CCTP_PROGRAMS,
  SOLANA_CCTP_PROGRAMS_V2,
  SOLANA_USDC_MINT_PUBKEY,
  solanaAddressToBytes32,
  solanaOwnerToUsdcAtaBytes32,
} from '../src/bridge/cctp.js';
import {
  buildSolanaCctpClaimInstructionPlan,
  decodeCctpMessage,
  deriveSolanaCctpClaimPdas,
} from '../src/bridge/solana-claim.js';
import { SOLANA_CCTP_DOMAIN } from '../src/scanner/chains.js';
import type { ScannedAsset } from '../src/scanner/types.js';
import { createSiphonServer } from '../src/server/app.js';

const SOL_USER_A = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SOL_USER_B = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const SAMPLE_BLOCKHASH = '11111111111111111111111111111111';
const VALID_BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const SAMPLE_ATTESTATION = '0x' + 'ab'.repeat(65);
const BASE_USDC_BYTES32 = '0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ZERO_BYTES32 = '0x' + '00'.repeat(32);

function mkAsset(overrides: Partial<ScannedAsset>): ScannedAsset {
  return {
    id: 'test:asset',
    family: 'cosmos',
    chain: 'cosmoshub',
    chainName: 'Cosmos Hub',
    address: 'uatom',
    symbol: 'ATOM',
    name: 'Cosmos ATOM',
    decimals: 6,
    kind: 'native',
    rawBalance: '10000000',
    uiBalance: 10,
    priceUsd: 5,
    grossUsd: 50,
    liquidityUsd: 10_000_000,
    estimatedGasUsd: 0.04,
    batchedGasUsd: 0.02,
    estimatedSlippageUsd: 0.2,
    netUsdcSingle: 49.76,
    netUsdcBatched: 49.78,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Test',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

function buildCctpV1MessageHex(opts: {
  sourceDomain?: number;
  destinationDomain?: number;
  nonce?: bigint;
  senderBytes32?: string;
  recipientBytes32?: string;
  destinationCallerBytes32?: string;
  burnTokenBytes32?: string;
  mintRecipientBytes32: string;
  amountRaw?: bigint;
  messageSenderBytes32?: string;
}): string {
  const header = Buffer.alloc(116);
  header.writeUInt32BE(0, 0); // version 0 = V1
  header.writeUInt32BE(opts.sourceDomain ?? 6, 4); // Base domain 6
  header.writeUInt32BE(opts.destinationDomain ?? SOLANA_CCTP_DOMAIN, 8);
  header.writeBigUInt64BE(opts.nonce ?? 6401n, 12);
  Buffer.from((opts.senderBytes32 ?? '0x' + '11'.repeat(32)).slice(2), 'hex').copy(header, 20);
  const defaultRecipient = solanaAddressToBytes32(SOLANA_CCTP_PROGRAMS.tokenMessengerMinter);
  Buffer.from((opts.recipientBytes32 ?? defaultRecipient).slice(2), 'hex').copy(header, 52);
  Buffer.from((opts.destinationCallerBytes32 ?? ZERO_BYTES32).slice(2), 'hex').copy(header, 84);

  const body = Buffer.alloc(132);
  body.writeUInt32BE(0, 0); // burnVersion = 0
  Buffer.from((opts.burnTokenBytes32 ?? BASE_USDC_BYTES32).slice(2), 'hex').copy(body, 4);
  Buffer.from(opts.mintRecipientBytes32.slice(2), 'hex').copy(body, 36);
  const amtHex = (opts.amountRaw ?? 42_500_000n).toString(16).padStart(64, '0');
  Buffer.from(amtHex, 'hex').copy(body, 68);
  Buffer.from((opts.messageSenderBytes32 ?? '0x' + '22'.repeat(32)).slice(2), 'hex').copy(body, 100);

  return '0x' + Buffer.concat([header, body]).toString('hex');
}

function buildCctpV2MessageHex(opts: {
  sourceDomain?: number;
  destinationDomain?: number;
  nonceBytes32?: string;
  destinationCallerBytes32?: string;
  burnTokenBytes32?: string;
  mintRecipientBytes32: string;
  amountRaw?: bigint;
}): string {
  const header = Buffer.alloc(148);
  header.writeUInt32BE(1, 0); // version 1 = V2
  header.writeUInt32BE(opts.sourceDomain ?? 10, 4); // Unichain domain 10
  header.writeUInt32BE(opts.destinationDomain ?? SOLANA_CCTP_DOMAIN, 8);
  Buffer.from((opts.nonceBytes32 ?? '0x' + '99'.repeat(32)).slice(2), 'hex').copy(header, 12);
  Buffer.from('11'.repeat(32), 'hex').copy(header, 44);
  const v2Recipient = solanaAddressToBytes32(SOLANA_CCTP_PROGRAMS_V2.tokenMessengerMinter);
  Buffer.from(v2Recipient.slice(2), 'hex').copy(header, 76);
  Buffer.from((opts.destinationCallerBytes32 ?? ZERO_BYTES32).slice(2), 'hex').copy(header, 108);
  header.writeUInt32BE(2000, 140);
  header.writeUInt32BE(2000, 144);

  const body = Buffer.alloc(228);
  body.writeUInt32BE(1, 0); // burnVersion = 1
  Buffer.from((opts.burnTokenBytes32 ?? BASE_USDC_BYTES32).slice(2), 'hex').copy(body, 4);
  Buffer.from(opts.mintRecipientBytes32.slice(2), 'hex').copy(body, 36);
  const amtHex = (opts.amountRaw ?? 125_000_000n).toString(16).padStart(64, '0');
  Buffer.from(amtHex, 'hex').copy(body, 68);
  Buffer.from('22'.repeat(32), 'hex').copy(body, 100);
  Buffer.from('00'.repeat(32), 'hex').copy(body, 132); // maxFee
  Buffer.from('00'.repeat(32), 'hex').copy(body, 164); // feeExecuted
  Buffer.from('00'.repeat(32), 'hex').copy(body, 196); // expirationBlock

  return '0x' + Buffer.concat([header, body]).toString('hex');
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withMockFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: () => Promise<T>
): Promise<T> {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = origFetch;
  }
}

function defaultSolanaRpcResponse(bodyRaw: string | undefined, hasUsdcAta = true): Response | null {
  if (!bodyRaw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyRaw);
  } catch {
    return null;
  }
  const makeOne = (req: { id?: number; method?: string }) => {
    if (req.method === 'getBalance') {
      return { jsonrpc: '2.0', id: req.id ?? 1, result: { context: { slot: 310_000_000 }, value: 250_000_000 } };
    }
    if (req.method === 'getTokenAccountsByOwner') {
      return {
        jsonrpc: '2.0',
        id: req.id ?? 2,
        result: {
          context: { slot: 310_000_000 },
          value: hasUsdcAta
            ? [
                {
                  account: {
                    data: {
                      parsed: {
                        info: {
                          tokenAmount: { uiAmount: 50, uiAmountString: '50' },
                        },
                      },
                    },
                  },
                },
              ]
            : [],
        },
      };
    }
    if (req.method === 'getLatestBlockhash') {
      return {
        jsonrpc: '2.0',
        id: req.id ?? 1,
        result: { context: { slot: 310_000_000 }, value: { blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 320_000_000 } },
      };
    }
    return null;
  };
  if (Array.isArray(parsed)) {
    const out = parsed.map((item) => makeOne(item as { id?: number; method?: string })).filter(Boolean);
    return out.length ? jsonResponse(out) : null;
  }
  if (parsed && typeof parsed === 'object') {
    const single = makeOne(parsed as { id?: number; method?: string });
    return single ? jsonResponse(single) : null;
  }
  return null;
}

// ============================================================================
// 1. CRIT-05: ALL 6 NON-EVM simulatePreSignProof() HONESTY & FAIL-CLOSED TESTS
// ============================================================================

test('CRIT-05: All 6 non-EVM simulatePreSignProof() methods NEVER fabricate verified or allChecksSafe=true without live tx dry-run', async () => {
  await withMockFetch(
    (url, init) => {
      if (url.includes('solana')) {
        const sol = defaultSolanaRpcResponse(typeof init?.body === 'string' ? init.body : undefined, true);
        if (sol) return sol;
      }
      if (url.includes('coins.llama.fi') || url.includes('coingecko')) {
        return jsonResponse({ coins: {} });
      }
      // Bitcoin mempool.space
      if (url.endsWith('/blocks/tip/height')) return new Response('890123', { status: 200 });
      if (url.endsWith('/v1/fees/recommended')) return jsonResponse({ halfHourFee: 10, fastestFee: 15 });
      if (url.includes('/utxo')) {
        return jsonResponse([{ txid: 'a'.repeat(64), vout: 0, value: 2_000_000, status: { confirmed: true } }]);
      }
      // Cosmos LCD
      if (url.includes('/blocks/latest')) return jsonResponse({ block: { header: { height: '24500123' } } });
      if (url.includes('/spendable_balances/')) {
        return jsonResponse({ balances: [{ denom: 'uatom', amount: '50000000' }] });
      }
      // Sui GraphQL
      if (url.includes('graphql.mainnet.sui.io')) {
        return jsonResponse({
          data: {
            checkpoint: { sequenceNumber: 98765432 },
            address: {
              balances: {
                nodes: [{ coinType: { repr: '0x2::sui::SUI' }, totalBalance: '10000000000' }],
              },
            },
          },
        });
      }
      // Aptos REST
      if (url.endsWith('/v1')) return jsonResponse({ block_height: '250000000', ledger_version: '999999999' });
      if (url.endsWith('/v1/view')) return jsonResponse(['500000000']);
      if (url.includes('/resource/')) return jsonResponse({ data: { coin: { value: '500000000' } } });
      // TON TonAPI
      if (url.includes('/blockchain/masterchain-head')) return jsonResponse({ seqno: 42000111 });
      if (url.includes('tonapi.io/v2/accounts/')) return jsonResponse({ balance: 15_000_000_000, interfaces: ['wallet_v5r1'] });
      // Tron TronGrid
      if (url.includes('/wallet/getnowblock')) return jsonResponse({ block_header: { raw_data: { number: 70000123 } } });
      if (url.includes('/wallet/getaccountresource')) {
        return jsonResponse({ EnergyLimit: 120_000, EnergyUsed: 0, freeNetLimit: 1500, freeNetUsed: 0 });
      }
      if (url.includes('trongrid.io/v1/accounts/')) {
        return jsonResponse({
          data: [{ balance: 50_000_000, trc20: [{ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: '100000000' }] }],
        });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      const proofs = await Promise.all([
        btcAdapter.simulatePreSignProof({
          chain: 'btc',
          assets: [
            mkAsset({
              family: 'btc',
              chain: 'btc',
              chainName: 'Bitcoin',
              address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
              symbol: 'BTC',
              decimals: 8,
              rawBalance: '500000',
              uiBalance: 0.005,
              grossUsd: 430,
            }),
          ],
          userAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          solanaDestination: SOL_USER_A,
        }),
        cosmosAdapter.simulatePreSignProof({
          chain: 'cosmoshub',
          assets: [mkAsset({ chain: 'cosmoshub', address: 'uatom', symbol: 'ATOM', rawBalance: '10000000' })],
          userAddress: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
          solanaDestination: SOL_USER_A,
        }),
        suiAdapter.simulatePreSignProof({
          chain: 'sui',
          assets: [
            mkAsset({
              family: 'sui',
              chain: 'sui',
              chainName: 'Sui',
              address: '0x2::sui::SUI',
              symbol: 'SUI',
              decimals: 9,
              rawBalance: '5000000000',
              uiBalance: 5,
              grossUsd: 15,
            }),
          ],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
          solanaDestination: SOL_USER_A,
        }),
        aptosAdapter.simulatePreSignProof({
          chain: 'aptos',
          assets: [
            mkAsset({
              family: 'aptos',
              chain: 'aptos',
              chainName: 'Aptos',
              address: '0xa',
              symbol: 'APT',
              decimals: 8,
              rawBalance: '100000000',
              uiBalance: 1,
              grossUsd: 6,
            }),
          ],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
          solanaDestination: SOL_USER_A,
        }),
        tonAdapter.simulatePreSignProof({
          chain: 'ton',
          assets: [
            mkAsset({
              family: 'ton',
              chain: 'ton',
              chainName: 'TON',
              address: 'native',
              symbol: 'TON',
              decimals: 9,
              rawBalance: '5000000000',
              uiBalance: 5,
              grossUsd: 19,
            }),
          ],
          userAddress: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2',
          solanaDestination: SOL_USER_A,
        }),
        tronAdapter.simulatePreSignProof({
          chain: 'tron',
          assets: [
            mkAsset({
              family: 'tron',
              chain: 'tron',
              chainName: 'Tron',
              address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
              symbol: 'USDT',
              decimals: 6,
              rawBalance: '50000000',
              uiBalance: 50,
              grossUsd: 50,
              action: 'BRIDGE_DIRECT_USDC',
            }),
          ],
          userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
          solanaDestination: SOL_USER_A,
        }),
      ]);

      for (const proof of proofs) {
        assert.equal(
          proof.simulatedLive,
          false,
          `${proof.family} must report simulatedLive=false when no raw tx bytes/payload are supplied`
        );
        assert.equal(
          proof.allChecksSafe,
          false,
          `${proof.family} must NOT fabricate allChecksSafe=true without real live tx emulation`
        );
        assert.ok(
          typeof proof.simulationNote === 'string' && proof.simulationNote.length > 15,
          `${proof.family} must include a clear simulationNote`
        );
        for (const chk of proof.checks) {
          assert.notEqual(
            chk.preflightStatus,
            'verified',
            `${proof.family} check "${chk.stepId}" must NEVER fabricate preflightStatus='verified' on unsimulated intent`
          );
          assert.equal(
            chk.preflightStatus,
            'unsimulated',
            `${proof.family} check "${chk.stepId}" should honestly report 'unsimulated' when pre-flight passes without live tx dry-run`
          );
        }
      }
    }
  );
});

test('CRIT-05: All 6 non-EVM adapters fail closed on invalid Solana recipients, missing USDC ATA, BTC Ordinals-only UTXOs, and insufficient live balances', async () => {
  // Part A: Invalid Solana recipient (zero pubkey & garbage) across all 6 adapters
  await withMockFetch(
    (url) => {
      if (url.endsWith('/blocks/tip/height')) return new Response('890123', { status: 200 });
      if (url.endsWith('/v1/fees/recommended')) return jsonResponse({ halfHourFee: 10 });
      if (url.includes('/utxo')) return jsonResponse([{ txid: 'a'.repeat(64), vout: 0, value: 2_000_000, status: { confirmed: true } }]);
      if (url.includes('/blocks/latest')) return jsonResponse({ block: { header: { height: '24500123' } } });
      if (url.includes('/spendable_balances/')) return jsonResponse({ balances: [{ denom: 'uatom', amount: '50000000' }] });
      if (url.includes('graphql.mainnet.sui.io')) {
        return jsonResponse({
          data: {
            checkpoint: { sequenceNumber: 98765432 },
            address: { balances: { nodes: [{ coinType: { repr: '0x2::sui::SUI' }, totalBalance: '10000000000' }] } },
          },
        });
      }
      if (url.endsWith('/v1')) return jsonResponse({ block_height: '250000000' });
      if (url.endsWith('/v1/view')) return jsonResponse(['500000000']);
      if (url.includes('/blockchain/masterchain-head')) return jsonResponse({ seqno: 42000111 });
      if (url.includes('tonapi.io/v2/accounts/')) return jsonResponse({ balance: 15_000_000_000 });
      if (url.includes('/wallet/getnowblock')) return jsonResponse({ block_header: { raw_data: { number: 70000123 } } });
      if (url.includes('trongrid.io/v1/accounts/')) return jsonResponse({ data: [{ balance: 50_000_000, trc20: [] }] });
      return jsonResponse({}, 404);
    },
    async () => {
      const badDest = '11111111111111111111111111111111';
      const badProofs = await Promise.all([
        btcAdapter.simulatePreSignProof({
          chain: 'btc',
          assets: [mkAsset({ family: 'btc', chain: 'btc', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', symbol: 'BTC', rawBalance: '500000' })],
          userAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          solanaDestination: badDest,
        }),
        cosmosAdapter.simulatePreSignProof({
          chain: 'cosmoshub',
          assets: [mkAsset({ chain: 'cosmoshub', address: 'uatom', symbol: 'ATOM', rawBalance: '10000000' })],
          userAddress: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
          solanaDestination: 'not-a-solana-address!!!',
        }),
        suiAdapter.simulatePreSignProof({
          chain: 'sui',
          assets: [mkAsset({ family: 'sui', chain: 'sui', address: '0x2::sui::SUI', symbol: 'SUI', rawBalance: '1000000000' })],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
          solanaDestination: badDest,
        }),
        aptosAdapter.simulatePreSignProof({
          chain: 'aptos',
          assets: [mkAsset({ family: 'aptos', chain: 'aptos', address: '0xa', symbol: 'APT', rawBalance: '100000000' })],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
          solanaDestination: 'invalid',
        }),
        tonAdapter.simulatePreSignProof({
          chain: 'ton',
          assets: [mkAsset({ family: 'ton', chain: 'ton', address: 'native', symbol: 'TON', rawBalance: '1000000000' })],
          userAddress: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2',
          solanaDestination: badDest,
        }),
        tronAdapter.simulatePreSignProof({
          chain: 'tron',
          assets: [mkAsset({ family: 'tron', chain: 'tron', address: 'native', symbol: 'TRX', rawBalance: '1000000' })],
          userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
          solanaDestination: '0x0000000000000000000000000000000000000000',
        }),
      ]);

      for (const p of badProofs) {
        assert.equal(p.mintRecipientVerified, false, `${p.family} must reject invalid Solana destination`);
        assert.equal(p.allChecksSafe, false);
        assert.equal(p.simulatedLive, false);
        assert.ok(
          p.checks.some((c) => c.preflightStatus === 'reverted'),
          `${p.family} must mark recipient check reverted on invalid destination`
        );
      }
    }
  );

  // Part B: BTC Taproot Ordinals/Runes-only UTXOs & insufficient live balances across all 6 adapters
  await withMockFetch(
    (url, init) => {
      if (url.includes('solana')) {
        const sol = defaultSolanaRpcResponse(typeof init?.body === 'string' ? init.body : undefined, true);
        if (sol) return sol;
      }
      if (url.endsWith('/blocks/tip/height')) return new Response('890123', { status: 200 });
      if (url.endsWith('/v1/fees/recommended')) return jsonResponse({ halfHourFee: 5 });
      if (url.includes('/utxo')) {
        // ONLY Taproot Ordinals postage UTXOs (<= 10,000 sats) + 1 unconfirmed UTXO -> 0 spendable!
        return jsonResponse([
          { txid: '1'.repeat(64), vout: 0, value: 5_000, status: { confirmed: true } },
          { txid: '2'.repeat(64), vout: 1, value: 80_000, status: { confirmed: false } },
        ]);
      }
      // All other chains return TINY / ZERO live balance (< requested outflow)
      if (url.includes('/blocks/latest')) return jsonResponse({ block: { header: { height: '24500123' } } });
      if (url.includes('/spendable_balances/')) return jsonResponse({ balances: [{ denom: 'uatom', amount: '100' }] });
      if (url.includes('graphql.mainnet.sui.io')) {
        return jsonResponse({
          data: {
            checkpoint: { sequenceNumber: 98765432 },
            address: { balances: { nodes: [{ coinType: { repr: '0x2::sui::SUI' }, totalBalance: '1000' }] } },
          },
        });
      }
      if (url.endsWith('/v1')) return jsonResponse({ block_height: '250000000' });
      if (url.endsWith('/v1/view')) return jsonResponse(['100']);
      if (url.includes('/resource/')) return jsonResponse({ data: { coin: { value: '100' } } });
      if (url.includes('/blockchain/masterchain-head')) return jsonResponse({ seqno: 42000111 });
      if (url.includes('tonapi.io/v2/accounts/')) return jsonResponse({ balance: 100 });
      if (url.includes('/wallet/getnowblock')) return jsonResponse({ block_header: { raw_data: { number: 70000123 } } });
      if (url.includes('/wallet/getaccountresource')) return jsonResponse({ EnergyLimit: 0, EnergyUsed: 0 });
      if (url.includes('trongrid.io/v1/accounts/')) {
        return jsonResponse({ data: [{ balance: 100, trc20: [{ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: '100' }] }] });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      const btcOrd = await btcAdapter.simulatePreSignProof({
        chain: 'btc',
        assets: [
          mkAsset({
            family: 'btc',
            chain: 'btc',
            address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
            symbol: 'BTC',
            rawBalance: '50000',
            uiBalance: 0.0005,
            grossUsd: 43,
          }),
        ],
        userAddress: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
        solanaDestination: SOL_USER_A,
        rawTxBytes: '70736274ff01007502000000010000000000000000', // even with valid PSBT magic, must STILL fail closed!
      });
      assert.equal(btcOrd.allChecksSafe, false);
      assert.equal(btcOrd.simulatedLive, false);
      assert.equal(btcOrd.checks[0].preflightStatus, 'reverted');
      assert.ok(btcOrd.warnings.some((w) => /ordinals|runes/i.test(w)));

      const insufficientProofs = await Promise.all([
        cosmosAdapter.simulatePreSignProof({
          chain: 'cosmoshub',
          assets: [mkAsset({ chain: 'cosmoshub', address: 'uatom', symbol: 'ATOM', rawBalance: '10000000' })],
          userAddress: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
          solanaDestination: SOL_USER_A,
        }),
        suiAdapter.simulatePreSignProof({
          chain: 'sui',
          assets: [mkAsset({ family: 'sui', chain: 'sui', address: '0x2::sui::SUI', symbol: 'SUI', rawBalance: '5000000000' })],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
          solanaDestination: SOL_USER_A,
        }),
        aptosAdapter.simulatePreSignProof({
          chain: 'aptos',
          assets: [mkAsset({ family: 'aptos', chain: 'aptos', address: '0xa', symbol: 'APT', rawBalance: '500000000' })],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
          solanaDestination: SOL_USER_A,
        }),
        tonAdapter.simulatePreSignProof({
          chain: 'ton',
          assets: [mkAsset({ family: 'ton', chain: 'ton', address: 'native', symbol: 'TON', rawBalance: '5000000000' })],
          userAddress: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2',
          solanaDestination: SOL_USER_A,
        }),
        tronAdapter.simulatePreSignProof({
          chain: 'tron',
          assets: [
            mkAsset({
              family: 'tron',
              chain: 'tron',
              address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
              symbol: 'USDT',
              rawBalance: '50000000',
              action: 'BRIDGE_DIRECT_USDC',
            }),
          ],
          userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
          solanaDestination: SOL_USER_A,
        }),
      ]);

      for (const p of insufficientProofs) {
        assert.equal(p.allChecksSafe, false, `${p.family} must fail closed on insufficient live balance`);
        assert.equal(p.simulatedLive, false);
        assert.equal(p.checks[0].preflightStatus, 'reverted', `${p.family} primary check must revert on insufficient balance`);
        assert.ok(p.warnings.some((w) => /insufficient/i.test(w)));
      }
    }
  );

  // Part C: Missing Solana USDC ATA fails closed on USDC output
  await withMockFetch(
    (url, init) => {
      if (url.includes('solana')) {
        const sol = defaultSolanaRpcResponse(typeof init?.body === 'string' ? init.body : undefined, false);
        if (sol) return sol;
      }
      if (url.includes('graphql.mainnet.sui.io')) {
        return jsonResponse({
          data: {
            checkpoint: { sequenceNumber: 98765432 },
            address: { balances: { nodes: [{ coinType: { repr: '0x2::sui::SUI' }, totalBalance: '10000000000' }] } },
          },
        });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      const missingAtaProof = await suiAdapter.simulatePreSignProof({
        chain: 'sui',
        assets: [mkAsset({ family: 'sui', chain: 'sui', address: '0x2::sui::SUI', symbol: 'SUI', rawBalance: '1000000000' })],
        userAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
        solanaDestination: SOL_USER_A,
        outputAsset: 'USDC',
      });
      assert.equal(missingAtaProof.allChecksSafe, false);
      assert.equal(missingAtaProof.checks[1].preflightStatus, 'reverted');
      assert.ok(missingAtaProof.warnings.some((w) => /usdc ata/i.test(w)));
    }
  );
});

test('CRIT-05: All 6 non-EVM adapters execute real chain dry-run endpoints when raw tx bytes/payload are supplied (pass & revert)', async () => {
  let simShouldRevert = false;
  const calledEndpoints = new Set<string>();

  await withMockFetch(
    (url, init) => {
      if (url.includes('solana')) {
        const sol = defaultSolanaRpcResponse(typeof init?.body === 'string' ? init.body : undefined, true);
        if (sol) return sol;
      }
      // Bitcoin
      if (url.endsWith('/blocks/tip/height')) return new Response('890123', { status: 200 });
      if (url.endsWith('/v1/fees/recommended')) return jsonResponse({ halfHourFee: 8 });
      if (url.includes('/utxo')) {
        return jsonResponse([{ txid: 'a'.repeat(64), vout: 0, value: 2_000_000, status: { confirmed: true } }]);
      }
      // Cosmos simulate
      if (url.includes('/cosmos/tx/v1beta1/simulate')) {
        calledEndpoints.add('cosmos_simulate');
        return simShouldRevert
          ? jsonResponse({ code: 5, message: 'insufficient funds' }, 400)
          : jsonResponse({ gas_info: { gas_used: '142000', gas_wanted: '180000' } });
      }
      if (url.includes('/blocks/latest')) return jsonResponse({ block: { header: { height: '24500123' } } });
      if (url.includes('/spendable_balances/')) {
        return jsonResponse({ balances: [{ denom: 'uatom', amount: '50000000' }] });
      }
      // Sui dryRunTransactionBlock
      if (url.includes('mainnet.suiet.app') && typeof init?.body === 'string' && init.body.includes('sui_dryRunTransactionBlock')) {
        calledEndpoints.add('sui_dry_run');
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            effects: {
              status: simShouldRevert ? { status: 'failure', error: 'MoveAbort(0x2, 1)' } : { status: 'success' },
              gasUsed: { computationCost: '1000000' },
            },
          },
        });
      }
      if (url.includes('graphql.mainnet.sui.io')) {
        return jsonResponse({
          data: {
            checkpoint: { sequenceNumber: 98765432 },
            address: { balances: { nodes: [{ coinType: { repr: '0x2::sui::SUI' }, totalBalance: '10000000000' }] } },
          },
        });
      }
      // Aptos simulate
      if (url.includes('/transactions/simulate')) {
        calledEndpoints.add('aptos_simulate');
        return jsonResponse([
          simShouldRevert
            ? { success: false, vm_status: 'Move abort in 0x1::coin: EINSUFFICIENT_BALANCE', gas_used: '200' }
            : { success: true, vm_status: 'Executed successfully', gas_used: '420' },
        ]);
      }
      if (url.endsWith('/v1')) return jsonResponse({ block_height: '250000000' });
      if (url.endsWith('/v1/view')) return jsonResponse(['500000000']);
      if (url.includes('/resource/')) return jsonResponse({ data: { coin: { value: '500000000' } } });
      // TON traces/emulate
      if (url.includes('/traces/emulate')) {
        calledEndpoints.add('ton_emulate');
        return jsonResponse({
          transaction: simShouldRevert
            ? { success: false, aborted: true, total_fees: 9000000 }
            : { success: true, aborted: false, total_fees: 4500000 },
        });
      }
      if (url.includes('/blockchain/masterchain-head')) return jsonResponse({ seqno: 42000111 });
      if (url.includes('tonapi.io/v2/accounts/')) return jsonResponse({ balance: 15_000_000_000 });
      // Tron triggerconstantcontract
      if (url.includes('/wallet/triggerconstantcontract')) {
        calledEndpoints.add('tron_triggerconstant');
        return jsonResponse(
          simShouldRevert
            ? { result: { result: true }, transaction: { ret: [{ contractRet: 'REVERT' }] } }
            : { result: { result: true }, energy_used: 31800, transaction: { ret: [{ contractRet: 'SUCCESS' }] } }
        );
      }
      if (url.includes('/wallet/getnowblock')) return jsonResponse({ block_header: { raw_data: { number: 70000123 } } });
      if (url.includes('/wallet/getaccountresource')) {
        return jsonResponse({ EnergyLimit: 120_000, EnergyUsed: 0, freeNetLimit: 1500, freeNetUsed: 0 });
      }
      if (url.includes('trongrid.io/v1/accounts/')) {
        return jsonResponse({ data: [{ balance: 50_000_000, trc20: [{ TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: '100000000' }] }] });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      // 1. Live simulation PASS across all 6 families
      simShouldRevert = false;
      const passProofs = await Promise.all([
        btcAdapter.simulatePreSignProof({
          chain: 'btc',
          assets: [mkAsset({ family: 'btc', chain: 'btc', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', symbol: 'BTC', rawBalance: '500000', uiBalance: 0.005, grossUsd: 430 })],
          userAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          solanaDestination: SOL_USER_A,
          rawTxBytes: '70736274ff01007502000000010000000000000000',
        }),
        cosmosAdapter.simulatePreSignProof({
          chain: 'cosmoshub',
          assets: [mkAsset({ chain: 'cosmoshub', address: 'uatom', symbol: 'ATOM', rawBalance: '10000000' })],
          userAddress: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
          solanaDestination: SOL_USER_A,
          rawTxBytes: Buffer.from('mock-cosmos-protobuf-tx').toString('base64'),
        }),
        suiAdapter.simulatePreSignProof({
          chain: 'sui',
          assets: [mkAsset({ family: 'sui', chain: 'sui', address: '0x2::sui::SUI', symbol: 'SUI', rawBalance: '1000000000' })],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
          solanaDestination: SOL_USER_A,
          rawTxBytes: Buffer.from('mock-sui-bcs-tx').toString('base64'),
        }),
        aptosAdapter.simulatePreSignProof({
          chain: 'aptos',
          assets: [mkAsset({ family: 'aptos', chain: 'aptos', address: '0xa', symbol: 'APT', rawBalance: '100000000' })],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
          solanaDestination: SOL_USER_A,
          simulationPayload: { sender: '0x1', sequence_number: '0', payload: { type: 'entry_function_payload' } },
        }),
        tonAdapter.simulatePreSignProof({
          chain: 'ton',
          assets: [mkAsset({ family: 'ton', chain: 'ton', address: 'native', symbol: 'TON', rawBalance: '1000000000' })],
          userAddress: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2',
          solanaDestination: SOL_USER_A,
          rawTxBytes: Buffer.from('mock-ton-boc').toString('base64'),
        }),
        tronAdapter.simulatePreSignProof({
          chain: 'tron',
          assets: [mkAsset({ family: 'tron', chain: 'tron', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', rawBalance: '50000000', action: 'BRIDGE_DIRECT_USDC' })],
          userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
          solanaDestination: SOL_USER_A,
          simulationPayload: { contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', function_selector: 'transfer(address,uint256)', parameter: '00' },
        }),
      ]);

      for (const p of passProofs) {
        assert.equal(p.simulatedLive, true, `${p.family} should report simulatedLive=true when live dry-run succeeds`);
        assert.equal(p.allChecksSafe, true, `${p.family} should report allChecksSafe=true when live dry-run succeeds`);
        assert.equal(p.checks[0].preflightStatus, 'verified');
      }
      assert.deepEqual(
        Array.from(calledEndpoints).sort(),
        ['aptos_simulate', 'cosmos_simulate', 'sui_dry_run', 'ton_emulate', 'tron_triggerconstant']
      );

      // 2. Live simulation REVERT fails closed across all 6 families
      simShouldRevert = true;
      const revertProofs = await Promise.all([
        btcAdapter.simulatePreSignProof({
          chain: 'btc',
          assets: [mkAsset({ family: 'btc', chain: 'btc', address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', symbol: 'BTC', rawBalance: '500000' })],
          userAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          solanaDestination: SOL_USER_A,
          rawTxBytes: 'deadbeefdeadbeefdeadbeefdeadbeef', // invalid PSBT magic!
        }),
        cosmosAdapter.simulatePreSignProof({
          chain: 'cosmoshub',
          assets: [mkAsset({ chain: 'cosmoshub', address: 'uatom', symbol: 'ATOM', rawBalance: '10000000' })],
          userAddress: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
          solanaDestination: SOL_USER_A,
          rawTxBytes: Buffer.from('mock-cosmos-protobuf-tx').toString('base64'),
        }),
        suiAdapter.simulatePreSignProof({
          chain: 'sui',
          assets: [mkAsset({ family: 'sui', chain: 'sui', address: '0x2::sui::SUI', symbol: 'SUI', rawBalance: '1000000000' })],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000006',
          solanaDestination: SOL_USER_A,
          rawTxBytes: Buffer.from('mock-sui-bcs-tx').toString('base64'),
        }),
        aptosAdapter.simulatePreSignProof({
          chain: 'aptos',
          assets: [mkAsset({ family: 'aptos', chain: 'aptos', address: '0xa', symbol: 'APT', rawBalance: '100000000' })],
          userAddress: '0x0000000000000000000000000000000000000000000000000000000000000001',
          solanaDestination: SOL_USER_A,
          simulationPayload: { sender: '0x1', payload: { type: 'entry_function_payload' } },
        }),
        tonAdapter.simulatePreSignProof({
          chain: 'ton',
          assets: [mkAsset({ family: 'ton', chain: 'ton', address: 'native', symbol: 'TON', rawBalance: '1000000000' })],
          userAddress: 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2',
          solanaDestination: SOL_USER_A,
          rawTxBytes: Buffer.from('mock-ton-boc').toString('base64'),
        }),
        tronAdapter.simulatePreSignProof({
          chain: 'tron',
          assets: [mkAsset({ family: 'tron', chain: 'tron', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', symbol: 'USDT', rawBalance: '50000000', action: 'BRIDGE_DIRECT_USDC' })],
          userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL',
          solanaDestination: SOL_USER_A,
          simulationPayload: { contract_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', function_selector: 'transfer(address,uint256)', parameter: '00' },
        }),
      ]);

      for (const p of revertProofs) {
        assert.equal(p.simulatedLive, false, `${p.family} must report simulatedLive=false on revert`);
        assert.equal(p.allChecksSafe, false, `${p.family} must fail closed on revert`);
        assert.equal(p.checks[0].preflightStatus, 'reverted');
      }
    }
  );
});

// ============================================================================
// 2. SOLANA CIRCLE CCTP receiveMessage CLAIM PLANNER & API TESTS
// ============================================================================

test('Solana CCTP claim planner decodes V1 & V2 headers, derives exact Circle PDAs, and compiles valid @solana/web3.js Transaction', () => {
  const userAtaBytes32 = solanaOwnerToUsdcAtaBytes32(SOL_USER_A);
  const expectedUsdcAta = deriveSolanaUsdcAta(SOL_USER_A).toBase58();

  // --- CCTP V1 (Base domain 6 -> Solana domain 5, nonce 6401 -> firstNonce bucket 6401) ---
  const v1MsgHex = buildCctpV1MessageHex({
    sourceDomain: 6,
    destinationDomain: SOLANA_CCTP_DOMAIN,
    nonce: 6401n,
    burnTokenBytes32: BASE_USDC_BYTES32,
    mintRecipientBytes32: userAtaBytes32,
    amountRaw: 42_500_000n,
  });
  const decodedV1 = decodeCctpMessage(v1MsgHex);
  assert.equal(decodedV1.cctpVersion, 1);
  assert.equal(decodedV1.sourceDomain, 6);
  assert.equal(decodedV1.destinationDomain, 5);
  assert.equal(decodedV1.nonce, '6401');
  assert.equal(decodedV1.burnMessage.mintRecipientBytes32, userAtaBytes32.toLowerCase());
  assert.equal(decodedV1.burnMessage.amountRaw, '42500000');
  assert.equal(decodedV1.burnMessage.amountUsdc, 42.5);

  const planV1 = buildSolanaCctpClaimInstructionPlan({
    messageBytesHex: v1MsgHex,
    attestationHex: SAMPLE_ATTESTATION,
    solanaDestination: SOL_USER_A,
    recentBlockhash: VALID_BLOCKHASH,
  });

  // Independently verify every Circle CCTP V1 PDA via PublicKey.findProgramAddressSync
  const mtProg = new PublicKey(SOLANA_CCTP_PROGRAMS.messageTransmitter);
  const tmProg = new PublicKey(SOLANA_CCTP_PROGRAMS.tokenMessengerMinter);
  const [expMessageTransmitter] = PublicKey.findProgramAddressSync([Buffer.from('message_transmitter')], mtProg);
  const [expUsedNonces] = PublicKey.findProgramAddressSync(
    [Buffer.from('used_nonces'), Buffer.from('6'), Buffer.from('6401')],
    mtProg
  );
  const [expTokenMessenger] = PublicKey.findProgramAddressSync([Buffer.from('token_messenger')], tmProg);
  const [expRemoteTokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from('remote_token_messenger'), Buffer.from('6')],
    tmProg
  );
  const [expTokenPair] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_pair'), Buffer.from('6'), Buffer.from(BASE_USDC_BYTES32.slice(2), 'hex')],
    tmProg
  );
  const [expCustody] = PublicKey.findProgramAddressSync(
    [Buffer.from('custody'), SOLANA_USDC_MINT_PUBKEY.toBytes()],
    tmProg
  );

  assert.equal(planV1.mintRecipientVerified, true);
  assert.equal(planV1.recipientUsdcAta, expectedUsdcAta);
  assert.equal(planV1.pdas.messageTransmitter, expMessageTransmitter.toBase58());
  assert.equal(planV1.pdas.usedNonces, expUsedNonces.toBase58());
  assert.equal(planV1.pdas.tokenMessenger, expTokenMessenger.toBase58());
  assert.equal(planV1.pdas.remoteTokenMessenger, expRemoteTokenMessenger.toBase58());
  assert.equal(planV1.pdas.tokenPair, expTokenPair.toBase58());
  assert.equal(planV1.pdas.custodyTokenAccount, expCustody.toBase58());
  assert.equal(planV1.pdas.recipientUsdcAta, expectedUsdcAta);

  // Verify V1 firstNonce bucket math for nonce=1 and nonce=6400 share bucket 1
  const pdasNonce1 = deriveSolanaCctpClaimPdas({
    cctpVersion: 1,
    sourceDomain: 6,
    nonce: '1',
    burnTokenBytes32: BASE_USDC_BYTES32,
    solanaDestination: SOL_USER_A,
  });
  const pdasNonce6400 = deriveSolanaCctpClaimPdas({
    cctpVersion: 1,
    sourceDomain: 6,
    nonce: '6400',
    burnTokenBytes32: BASE_USDC_BYTES32,
    solanaDestination: SOL_USER_A,
  });
  assert.equal(pdasNonce1.usedNonces, pdasNonce6400.usedNonces);
  assert.notEqual(pdasNonce1.usedNonces, planV1.pdas.usedNonces);

  // Verify compiled @solana/web3.js Transaction deserializes with exact instructions & Anchor discriminator
  assert.ok(planV1.serializedTransactionBase64);
  const parsedTx = Transaction.from(Buffer.from(planV1.serializedTransactionBase64, 'base64'));
  assert.equal(parsedTx.instructions.length, 2);
  assert.equal(parsedTx.instructions[0].programId.toBase58(), 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  assert.equal(parsedTx.instructions[1].programId.toBase58(), SOLANA_CCTP_PROGRAMS.messageTransmitter);
  const expectedDisc = crypto.createHash('sha256').update('global:receive_message').digest().subarray(0, 8);
  assert.deepEqual(parsedTx.instructions[1].data.subarray(0, 8), expectedDisc);

  // --- CCTP V2 (Unichain domain 10 -> Solana domain 5) ---
  const v2Nonce = '0x' + '77'.repeat(32);
  const v2MsgHex = buildCctpV2MessageHex({
    sourceDomain: 10,
    destinationDomain: SOLANA_CCTP_DOMAIN,
    nonceBytes32: v2Nonce,
    mintRecipientBytes32: userAtaBytes32,
    amountRaw: 125_000_000n,
  });
  const planV2 = buildSolanaCctpClaimInstructionPlan({
    messageBytesHex: v2MsgHex,
    attestationHex: SAMPLE_ATTESTATION,
    solanaDestination: SOL_USER_A,
    includeCreateAta: false,
    recentBlockhash: VALID_BLOCKHASH,
  });
  assert.equal(planV2.cctpVersion, 2);
  assert.equal(planV2.amountUsdc, 125);
  assert.equal(planV2.programs.messageTransmitter, SOLANA_CCTP_PROGRAMS_V2.messageTransmitter);
  assert.equal(planV2.programs.tokenMessengerMinter, SOLANA_CCTP_PROGRAMS_V2.tokenMessengerMinter);
  assert.equal(planV2.instructions.length, 1);
  const [expV2UsedNonce] = PublicKey.findProgramAddressSync(
    [Buffer.from('used_nonce'), Buffer.from(v2Nonce.slice(2), 'hex')],
    new PublicKey(SOLANA_CCTP_PROGRAMS_V2.messageTransmitter)
  );
  assert.equal(planV2.pdas.usedNonces, expV2UsedNonce.toBase58());
});

test('Solana CCTP claim planner FAILS CLOSED on mismatched mintRecipient (raw owner or attacker ATA), wrong domain, destinationCaller lock, and invalid attestation', () => {
  const rawOwnerBytes32 = solanaAddressToBytes32(SOL_USER_A);
  const attackerAtaBytes32 = solanaOwnerToUsdcAtaBytes32(SOL_USER_B);
  const userAtaBytes32 = solanaOwnerToUsdcAtaBytes32(SOL_USER_A);

  // 1. Raw owner pubkey encoded instead of canonical USDC ATA PDA -> MUST REJECT!
  const rawOwnerMsg = buildCctpV1MessageHex({ mintRecipientBytes32: rawOwnerBytes32 });
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: rawOwnerMsg,
        attestationHex: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
      }),
    /raw Solana wallet owner.*canonical Solana USDC ATA PDA/i
  );

  // 2. Different user / attacker USDC ATA PDA -> MUST REJECT!
  const attackerMsg = buildCctpV1MessageHex({ mintRecipientBytes32: attackerAtaBytes32 });
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: attackerMsg,
        attestationHex: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
      }),
    /mintRecipient mismatch/i
  );

  // 3. Wrong destination domain (Ethereum 0 instead of Solana 5) -> MUST REJECT!
  const wrongDomainMsg = buildCctpV1MessageHex({
    destinationDomain: 0,
    mintRecipientBytes32: userAtaBytes32,
  });
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: wrongDomainMsg,
        attestationHex: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
      }),
    /destinationDomain mismatch/i
  );

  // 4. Restricted destinationCaller mismatch -> MUST REJECT!
  const lockedCallerMsg = buildCctpV1MessageHex({
    mintRecipientBytes32: userAtaBytes32,
    destinationCallerBytes32: solanaAddressToBytes32(SOL_USER_B),
  });
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: lockedCallerMsg,
        attestationHex: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
        payer: SOL_USER_A,
      }),
    /destinationCaller mismatch/i
  );

  // 5. Zero burn amount & truncated attestation -> MUST REJECT!
  const zeroAmtMsg = buildCctpV1MessageHex({ mintRecipientBytes32: userAtaBytes32, amountRaw: 0n });
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: zeroAmtMsg,
        attestationHex: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
      }),
    /greater than zero/i
  );

  const validMsg = buildCctpV1MessageHex({ mintRecipientBytes32: userAtaBytes32 });
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: validMsg,
        attestationHex: '0x1234',
        solanaDestination: SOL_USER_A,
      }),
    /attestation length/i
  );
});

test('POST /api/cctp/solana-claim-tx serves serializable claim transaction plan and rejects mismatched mintRecipient fail-closed', async () => {
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const userAtaBytes32 = solanaOwnerToUsdcAtaBytes32(SOL_USER_A);
    const attackerAtaBytes32 = solanaOwnerToUsdcAtaBytes32(SOL_USER_B);
    const validMsg = buildCctpV1MessageHex({
      sourceDomain: 6,
      nonce: 9001n,
      mintRecipientBytes32: userAtaBytes32,
      amountRaw: 88_000_000n,
    });

    // Valid claim request
    const okRes = await fetch(`${base}/api/cctp/solana-claim-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageBytesHex: validMsg,
        attestation: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
        recentBlockhash: VALID_BLOCKHASH,
      }),
    });
    assert.equal(okRes.status, 200);
    const plan = (await okRes.json()) as Record<string, unknown>;
    assert.equal(plan.planVersion, 'siphon-solana-cctp-claim-v1');
    assert.equal(plan.mintRecipientVerified, true);
    assert.equal(plan.amountUsdc, 88);
    assert.equal(plan.recipientUsdcAta, deriveSolanaUsdcAta(SOL_USER_A).toBase58());
    assert.ok(typeof plan.serializedTransactionBase64 === 'string' && plan.serializedTransactionBase64.length > 50);

    // Mismatched mintRecipient -> HTTP 400 fail-closed
    const badMsg = buildCctpV1MessageHex({ mintRecipientBytes32: attackerAtaBytes32 });
    const badRes = await fetch(`${base}/api/cctp/solana-claim-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageBytesHex: badMsg,
        attestation: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
        recentBlockhash: VALID_BLOCKHASH,
      }),
    });
    assert.equal(badRes.status, 400);
    const badJson = (await badRes.json()) as { error?: string };
    assert.match(String(badJson.error || ''), /mintRecipient mismatch/i);

    // Invalid Solana destination -> HTTP 400
    const badDestRes = await fetch(`${base}/api/cctp/solana-claim-tx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageBytesHex: validMsg,
        attestation: SAMPLE_ATTESTATION,
        solanaDestination: SAMPLE_BLOCKHASH,
        skipBlockhashFetch: true,
      }),
    });
    assert.equal(badDestRes.status, 400);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ============================================================================
// 3. FRONTEND wallets.js claimCctpOnSolana() SIGN & FALLBACK TESTS
// ============================================================================

test('wallets.js claimCctpOnSolana() supports Phantom/Solflare legacy signAndSendTransaction, Wallet Standard, and clean fallback when unsupported', async () => {
  class MockWindow extends EventTarget {
    location = { origin: 'http://127.0.0.1:3456' };
    localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    [key: string]: unknown;
  }
  const mockWindow = new MockWindow();
  const prevWindow = (globalThis as unknown as { window?: unknown }).window;
  (globalThis as unknown as { window: MockWindow }).window = mockWindow;

  try {
    const walletsModUrl = pathToFileURL(path.resolve('public/wallets.js')).href + `?t=${Date.now()}`;
    const wallets = (await import(walletsModUrl)) as {
      connectSolanaWallet: (opts?: Record<string, unknown>) => Promise<{ address: string; walletName: string }>;
      disconnectSolanaWallet: () => void;
      claimCctpOnSolana: (
        plan: Record<string, unknown>,
        opts?: Record<string, unknown>
      ) => Promise<{ claimed: boolean; signature: string; mode: string; explorerUrl: string }>;
    };

    const userAtaBytes32 = solanaOwnerToUsdcAtaBytes32(SOL_USER_A);
    const claimPlan = buildSolanaCctpClaimInstructionPlan({
      messageBytesHex: buildCctpV1MessageHex({ mintRecipientBytes32: userAtaBytes32, amountRaw: 25_000_000n }),
      attestationHex: SAMPLE_ATTESTATION,
      solanaDestination: SOL_USER_A,
      recentBlockhash: VALID_BLOCKHASH,
    }) as unknown as Record<string, unknown>;

    // 1. Phantom legacy signAndSendTransaction
    let serializedLen = 0;
    mockWindow.phantom = {
      solana: {
        isPhantom: true,
        connect: async () => ({ publicKey: { toBase58: () => SOL_USER_A } }),
        signAndSendTransaction: async (tx: { serialize: () => Uint8Array }) => {
          serializedLen = tx.serialize().length;
          return { signature: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' };
        },
      },
    };
    await wallets.connectSolanaWallet();
    const phantomRes = await wallets.claimCctpOnSolana(claimPlan, { expectedSolanaDestination: SOL_USER_A });
    assert.equal(phantomRes.claimed, true);
    assert.equal(phantomRes.mode, 'legacy_sign_and_send');
    assert.equal(phantomRes.signature, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
    assert.ok(serializedLen > 100);
    assert.ok(phantomRes.explorerUrl.includes('solscan.io/tx/'));

    // 2. Fails closed on expectedSolanaDestination mismatch
    await assert.rejects(
      () => wallets.claimCctpOnSolana(claimPlan, { expectedSolanaDestination: SOL_USER_B }),
      /does not match your job Solana destination/i
    );

    // 3. Clean fallback error + fallbackInstructions when wallet lacks signAndSendTransaction
    wallets.disconnectSolanaWallet();
    delete mockWindow.phantom;
    mockWindow.solflare = {
      connect: async () => ({ publicKey: { toBase58: () => SOL_USER_A } }),
      // intentionally NO signAndSendTransaction and NO request
    };
    await wallets.connectSolanaWallet();
    await assert.rejects(
      () => wallets.claimCctpOnSolana(claimPlan, { expectedSolanaDestination: SOL_USER_A }),
      (err: Error & { code?: string; fallbackInstructions?: string[] }) => {
        assert.equal(err.code, 'SOLANA_SIGN_AND_SEND_UNSUPPORTED');
        assert.ok(Array.isArray(err.fallbackInstructions) && err.fallbackInstructions.length >= 1);
        return true;
      }
    );

    // 4. Wallet Standard `solana:signAndSendTransaction` encodes Uint8Array signature to base58
    wallets.disconnectSolanaWallet();
    delete mockWindow.solflare;
    mockWindow.dispatchEvent(
      new CustomEvent('wallet-standard:register-wallet', {
        detail: (api: { register: (...w: unknown[]) => void }) =>
          api.register({
            name: 'Backpack',
            chains: ['solana:mainnet'],
            accounts: [{ address: SOL_USER_A, chains: ['solana:mainnet'] }],
            features: {
              'standard:connect': {
                connect: async () => ({ accounts: [{ address: SOL_USER_A, chains: ['solana:mainnet'] }] }),
              },
              'solana:signAndSendTransaction': {
                signAndSendTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
                  assert.ok(transaction instanceof Uint8Array && transaction.length > 100);
                  return [{ signature: new Uint8Array(64).fill(7) }];
                },
              },
            },
          }),
      })
    );
    await wallets.connectSolanaWallet();
    const stdRes = await wallets.claimCctpOnSolana(claimPlan, { expectedSolanaDestination: SOL_USER_A });
    assert.equal(stdRes.claimed, true);
    assert.equal(stdRes.mode, 'wallet_standard_sign_and_send');
    assert.ok(stdRes.signature.length >= 64);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as unknown as { window?: unknown }).window;
    } else {
      (globalThis as unknown as { window?: unknown }).window = prevWindow;
    }
  }
});
