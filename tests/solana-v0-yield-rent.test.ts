import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  deriveSolanaUsdcAta,
  SOLANA_CCTP_PROGRAMS,
  SOLANA_CCTP_PROGRAMS_V2,
  SOLANA_TOKEN_PROGRAM_ID,
  solanaAddressToBytes32,
  solanaOwnerToUsdcAtaBytes32,
} from '../src/bridge/cctp.js';
import {
  buildSolanaCctpClaimInstructionPlan,
  fetchDynamicSolanaPriorityFeeMicroLamports,
  MAX_PRIORITY_FEE_MICRO_LAMPORTS,
  MIN_PRIORITY_FEE_MICRO_LAMPORTS,
} from '../src/bridge/solana-claim.js';
import {
  buildCloseEmptyAtasVersionedTx,
  MAX_CLOSE_ACCOUNTS_PER_TX,
  scanReclaimableSolanaRent,
  SOLANA_EMPTY_ATA_RENT_LAMPORTS,
  SOLANA_EMPTY_ATA_RENT_SOL,
  SOLANA_TOKEN_2022_PROGRAM_ID,
  type ReclaimableSolanaTokenAccount,
} from '../src/bridge/solana-rent.js';
import {
  buildSolanaYieldParkPlan,
  calculateYieldPreservationSplit,
  JUPITER_SWAP_LITE_BASE,
  JUPITER_SWAP_PRO_BASE,
  listSolanaYieldStrategies,
  SOLANA_JUPSOL_MINT,
  SOLANA_USDC_MINT,
} from '../src/solana/yield-park.js';
import { SOLANA_CCTP_DOMAIN } from '../src/scanner/chains.js';
import { createSiphonServer } from '../src/server/app.js';

const SOL_USER_A = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SOL_USER_B = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const VALID_BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const ZERO_PUBKEY = '11111111111111111111111111111111';
const SAMPLE_ATTESTATION = '0x' + 'ab'.repeat(65);
const BASE_USDC_BYTES32 = '0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ZERO_BYTES32 = '0x' + '00'.repeat(32);

function deterministicPubkey(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest();
  return Keypair.fromSeed(hash).publicKey.toBase58();
}

function buildCctpV1MessageHex(opts: {
  sourceDomain?: number;
  destinationDomain?: number;
  nonce?: bigint;
  mintRecipientBytes32: string;
  amountRaw?: bigint;
}): string {
  const header = Buffer.alloc(116);
  header.writeUInt32BE(0, 0);
  header.writeUInt32BE(opts.sourceDomain ?? 6, 4);
  header.writeUInt32BE(opts.destinationDomain ?? SOLANA_CCTP_DOMAIN, 8);
  header.writeBigUInt64BE(opts.nonce ?? 6401n, 12);
  Buffer.from('11'.repeat(32), 'hex').copy(header, 20);
  const defaultRecipient = solanaAddressToBytes32(SOLANA_CCTP_PROGRAMS.tokenMessengerMinter);
  Buffer.from(defaultRecipient.slice(2), 'hex').copy(header, 52);
  Buffer.from(ZERO_BYTES32.slice(2), 'hex').copy(header, 84);

  const body = Buffer.alloc(132);
  body.writeUInt32BE(0, 0);
  Buffer.from(BASE_USDC_BYTES32.slice(2), 'hex').copy(body, 4);
  Buffer.from(opts.mintRecipientBytes32.slice(2), 'hex').copy(body, 36);
  const amtHex = (opts.amountRaw ?? 150_000_000n).toString(16).padStart(64, '0');
  Buffer.from(amtHex, 'hex').copy(body, 68);
  Buffer.from('22'.repeat(32), 'hex').copy(body, 100);

  return '0x' + Buffer.concat([header, body]).toString('hex');
}

function buildCctpV2MessageHex(opts: {
  sourceDomain?: number;
  mintRecipientBytes32: string;
  amountRaw?: bigint;
}): string {
  const header = Buffer.alloc(148);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(opts.sourceDomain ?? 10, 4);
  header.writeUInt32BE(SOLANA_CCTP_DOMAIN, 8);
  Buffer.from('88'.repeat(32), 'hex').copy(header, 12);
  Buffer.from('11'.repeat(32), 'hex').copy(header, 44);
  const v2Recipient = solanaAddressToBytes32(SOLANA_CCTP_PROGRAMS_V2.tokenMessengerMinter);
  Buffer.from(v2Recipient.slice(2), 'hex').copy(header, 76);
  Buffer.from(ZERO_BYTES32.slice(2), 'hex').copy(header, 108);
  header.writeUInt32BE(1000, 140);
  header.writeUInt32BE(1000, 144);

  const body = Buffer.alloc(228);
  body.writeUInt32BE(1, 0);
  Buffer.from(BASE_USDC_BYTES32.slice(2), 'hex').copy(body, 4);
  Buffer.from(opts.mintRecipientBytes32.slice(2), 'hex').copy(body, 36);
  const amtHex = (opts.amountRaw ?? 500_000_000n).toString(16).padStart(64, '0');
  Buffer.from(amtHex, 'hex').copy(body, 68);
  Buffer.from('22'.repeat(32), 'hex').copy(body, 100);
  Buffer.from('00'.repeat(32), 'hex').copy(body, 132);
  Buffer.from('00'.repeat(32), 'hex').copy(body, 164);
  Buffer.from('00'.repeat(32), 'hex').copy(body, 196);

  return '0x' + Buffer.concat([header, body]).toString('hex');
}

function mkEmptyAta(
  seed: string,
  overrides: Partial<ReclaimableSolanaTokenAccount> = {}
): ReclaimableSolanaTokenAccount {
  return {
    tokenAccount: deterministicPubkey(`ata:${seed}`),
    mint: deterministicPubkey(`mint:${seed}`),
    owner: SOL_USER_A,
    programId: SOLANA_TOKEN_PROGRAM_ID.toBase58(),
    programKind: 'spl-token',
    amount: '0',
    uiAmount: 0,
    decimals: 6,
    state: 'initialized',
    frozen: false,
    closeable: true,
    closeAuthority: null,
    rentLamports: SOLANA_EMPTY_ATA_RENT_LAMPORTS,
    rentSol: SOLANA_EMPTY_ATA_RENT_SOL,
    ...overrides,
  };
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
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return await handler(url, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = origFetch;
  }
}

function buildMockV0SwapTxBase64(payerAddress: string): string {
  const payer = new PublicKey(payerAddress);
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: VALID_BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 15_000 }),
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: payer,
        lamports: 0,
      }),
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

// ============================================================================
// 1. SOLANA V0 CLAIM TRANSACTION + COMPUTE BUDGET + CLOSE ATA BUNDLING
// ============================================================================

test('Solana CCTP claim compiles VersionedTransaction (MessageV0) with ComputeBudget + receiveMessage + optional closeAccount bundling and preserves legacy Transaction', () => {
  const userAtaBytes32 = solanaOwnerToUsdcAtaBytes32(SOL_USER_A);
  const v1MsgHex = buildCctpV1MessageHex({
    mintRecipientBytes32: userAtaBytes32,
    amountRaw: 250_000_000n,
  });

  const emptyAta1 = mkEmptyAta('bundle-1');
  const emptyAta2 = mkEmptyAta('bundle-2');
  const emptyAta2022 = mkEmptyAta('bundle-2022', {
    programId: SOLANA_TOKEN_2022_PROGRAM_ID.toBase58(),
    programKind: 'token-2022',
  });

  // Without an ALT, 2 SPL empty ATAs fit cleanly within Solana's 1232-byte packet limit
  const plan = buildSolanaCctpClaimInstructionPlan({
    messageBytesHex: v1MsgHex,
    attestationHex: SAMPLE_ATTESTATION,
    solanaDestination: SOL_USER_A,
    recentBlockhash: VALID_BLOCKHASH,
    computeUnitLimit: 320_000,
    computeUnitPriceMicroLamports: 40_000,
    closeEmptyAtas: [emptyAta1, emptyAta2],
  });

  assert.equal(plan.transactionVersion, 0);
  assert.equal(plan.mintRecipientVerified, true);
  assert.equal(plan.priorityFee.computeUnitLimit, 320_000);
  assert.equal(plan.priorityFee.computeUnitPriceMicroLamports, 40_000);
  assert.equal(plan.priorityFee.source, 'explicit');
  assert.equal(plan.bundledCloseAtaCount, 2);
  assert.equal(plan.bundledReclaimedSol, Number((2 * SOLANA_EMPTY_ATA_RENT_SOL).toFixed(8)));
  assert.ok(plan.serializedVersionedTransactionBase64);
  assert.ok(plan.serializedVersionedMessageBase64);
  assert.ok(plan.v0SerializedByteLength !== null && plan.v0SerializedByteLength <= 1232);

  // Deserialize V0 transaction and inspect every compiled instruction
  const v0Tx = VersionedTransaction.deserialize(
    Buffer.from(plan.serializedVersionedTransactionBase64, 'base64')
  );
  assert.equal(v0Tx.version, 0);
  const keys = v0Tx.message.staticAccountKeys;
  const compiledIxs = v0Tx.message.compiledInstructions;
  // setComputeUnitLimit + setComputeUnitPrice + createAta + receiveMessage + 2 closeAccount = 6
  assert.equal(compiledIxs.length, 6);
  assert.equal(
    keys[compiledIxs[0].programIdIndex].toBase58(),
    ComputeBudgetProgram.programId.toBase58()
  );
  assert.equal(
    keys[compiledIxs[1].programIdIndex].toBase58(),
    ComputeBudgetProgram.programId.toBase58()
  );
  assert.equal(
    keys[compiledIxs[2].programIdIndex].toBase58(),
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
  );
  assert.equal(
    keys[compiledIxs[3].programIdIndex].toBase58(),
    SOLANA_CCTP_PROGRAMS.messageTransmitter
  );
  // Check Anchor receive_message discriminator
  const expectedDisc = crypto
    .createHash('sha256')
    .update('global:receive_message')
    .digest()
    .subarray(0, 8);
  assert.deepEqual(Buffer.from(compiledIxs[3].data).subarray(0, 8), expectedDisc);

  // Check bundled closeAccount instructions (SPL Token opcode 9, dest === auth === owner)
  assert.equal(keys[compiledIxs[4].programIdIndex].toBase58(), SOLANA_TOKEN_PROGRAM_ID.toBase58());
  assert.deepEqual(Buffer.from(compiledIxs[4].data), Buffer.from([9]));
  assert.equal(keys[compiledIxs[4].accountKeyIndexes[0]].toBase58(), emptyAta1.tokenAccount);
  assert.equal(keys[compiledIxs[4].accountKeyIndexes[1]].toBase58(), SOL_USER_A);
  assert.equal(keys[compiledIxs[4].accountKeyIndexes[2]].toBase58(), SOL_USER_A);

  assert.equal(keys[compiledIxs[5].programIdIndex].toBase58(), SOLANA_TOKEN_PROGRAM_ID.toBase58());
  assert.deepEqual(Buffer.from(compiledIxs[5].data), Buffer.from([9]));
  assert.equal(keys[compiledIxs[5].accountKeyIndexes[0]].toBase58(), emptyAta2.tokenAccount);
  assert.equal(keys[compiledIxs[5].accountKeyIndexes[1]].toBase58(), SOL_USER_A);
  assert.equal(keys[compiledIxs[5].accountKeyIndexes[2]].toBase58(), SOL_USER_A);

  // Exceeding 1232-byte packet limit without ALT fails closed, while ALT compresses cleanly
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: v1MsgHex,
        attestationHex: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
        recentBlockhash: VALID_BLOCKHASH,
        closeEmptyAtas: [emptyAta1, emptyAta2022],
      }),
    /exceeds Solana's 1232-byte packet limit/i
  );

  const v1Alt = new AddressLookupTableAccount({
    key: new PublicKey(deterministicPubkey('alt-cctp-v1')),
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 300_000_000,
      lastExtendedSlotStartIndex: 0,
      authority: new PublicKey(SOL_USER_A),
      addresses: [
        new PublicKey(SOLANA_CCTP_PROGRAMS.messageTransmitter),
        new PublicKey(SOLANA_CCTP_PROGRAMS.tokenMessengerMinter),
        SOLANA_TOKEN_PROGRAM_ID,
        SOLANA_TOKEN_2022_PROGRAM_ID,
        SystemProgram.programId,
      ],
    },
  });
  const planWithAltAnd2022 = buildSolanaCctpClaimInstructionPlan({
    messageBytesHex: v1MsgHex,
    attestationHex: SAMPLE_ATTESTATION,
    solanaDestination: SOL_USER_A,
    recentBlockhash: VALID_BLOCKHASH,
    closeEmptyAtas: [emptyAta1, emptyAta2022],
    addressLookupTableAccounts: [v1Alt],
  });
  assert.ok(planWithAltAnd2022.serializedVersionedTransactionBase64);
  assert.ok(
    planWithAltAnd2022.v0SerializedByteLength !== null &&
      planWithAltAnd2022.v0SerializedByteLength <= 1232
  );

  // Backwards-compatible legacy Transaction still deserializes cleanly
  assert.ok(plan.serializedTransactionBase64);
  const legacyTx = Transaction.from(Buffer.from(plan.serializedTransactionBase64, 'base64'));
  assert.equal(legacyTx.instructions.length, 2);
});

test('Solana CCTP V2 claim compiles VersionedTransaction with Address Lookup Table and rejects mismatched mintRecipient or unsafe bundled ATA', () => {
  const userAtaBytes32 = solanaOwnerToUsdcAtaBytes32(SOL_USER_A);
  const attackerAtaBytes32 = solanaOwnerToUsdcAtaBytes32(SOL_USER_B);

  const v2MsgHex = buildCctpV2MessageHex({ mintRecipientBytes32: userAtaBytes32 });

  // Build an ALT containing CCTP V2 program & PDA addresses to verify MessageV0 ALT compression
  const altKey = new PublicKey(deterministicPubkey('alt-cctp-v2'));
  const altAccount = new AddressLookupTableAccount({
    key: altKey,
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 300_000_000,
      lastExtendedSlotStartIndex: 0,
      authority: new PublicKey(SOL_USER_A),
      addresses: [
        new PublicKey(SOLANA_CCTP_PROGRAMS_V2.messageTransmitter),
        new PublicKey(SOLANA_CCTP_PROGRAMS_V2.tokenMessengerMinter),
        SOLANA_TOKEN_PROGRAM_ID,
        SystemProgram.programId,
      ],
    },
  });

  const planWithAlt = buildSolanaCctpClaimInstructionPlan({
    messageBytesHex: v2MsgHex,
    attestationHex: SAMPLE_ATTESTATION,
    solanaDestination: SOL_USER_A,
    recentBlockhash: VALID_BLOCKHASH,
    addressLookupTableAccounts: [altAccount],
  });
  assert.deepEqual(planWithAlt.addressLookupTables, [altKey.toBase58()]);
  assert.ok(planWithAlt.serializedVersionedTransactionBase64);
  const v0WithAlt = VersionedTransaction.deserialize(
    Buffer.from(planWithAlt.serializedVersionedTransactionBase64, 'base64')
  );
  assert.equal(v0WithAlt.version, 0);
  assert.equal(v0WithAlt.message.addressTableLookups.length, 1);

  // Reject mismatched mintRecipient fail-closed
  const badMsgHex = buildCctpV2MessageHex({ mintRecipientBytes32: attackerAtaBytes32 });
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: badMsgHex,
        attestationHex: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
        recentBlockhash: VALID_BLOCKHASH,
      }),
    /mintRecipient mismatch/i
  );

  // Reject bundling the destination USDC ATA itself
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: v2MsgHex,
        attestationHex: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
        recentBlockhash: VALID_BLOCKHASH,
        closeEmptyAtas: [
          mkEmptyAta('usdc-ata', {
            tokenAccount: deriveSolanaUsdcAta(SOL_USER_A).toBase58(),
          }),
        ],
      }),
    /Refusing to bundle closeAccount for destination USDC ATA/i
  );

  // Reject bundling a non-zero ATA inside claim tx
  assert.throws(
    () =>
      buildSolanaCctpClaimInstructionPlan({
        messageBytesHex: v2MsgHex,
        attestationHex: SAMPLE_ATTESTATION,
        solanaDestination: SOL_USER_A,
        recentBlockhash: VALID_BLOCKHASH,
        closeEmptyAtas: [mkEmptyAta('nonzero', { amount: '1', uiAmount: 0.000001 })],
      }),
    /non-empty token account/i
  );
});

test('fetchDynamicSolanaPriorityFeeMicroLamports computes clamped p75 priority fee from RPC and falls back cleanly', async () => {
  await withMockFetch(
    () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: [
          { slot: 1, prioritizationFee: 0 },
          { slot: 2, prioritizationFee: 10_000 },
          { slot: 3, prioritizationFee: 20_000 },
          { slot: 4, prioritizationFee: 50_000 },
          { slot: 5, prioritizationFee: 80_000 },
        ],
      }),
    async () => {
      const fee = await fetchDynamicSolanaPriorityFeeMicroLamports({
        rpcUrls: ['https://mock-solana-rpc.local'],
      });
      assert.equal(fee.source, 'rpc_p75');
      assert.ok(
        fee.microLamports >= MIN_PRIORITY_FEE_MICRO_LAMPORTS &&
          fee.microLamports <= MAX_PRIORITY_FEE_MICRO_LAMPORTS
      );
      assert.equal(fee.microLamports, 50_000);
    }
  );

  // Spike clamped to MAX_PRIORITY_FEE_MICRO_LAMPORTS
  await withMockFetch(
    () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: [{ slot: 1, prioritizationFee: 99_999_999 }],
      }),
    async () => {
      const fee = await fetchDynamicSolanaPriorityFeeMicroLamports({
        rpcUrls: ['https://mock-solana-rpc.local'],
      });
      assert.equal(fee.microLamports, MAX_PRIORITY_FEE_MICRO_LAMPORTS);
    }
  );
});

// ============================================================================
// 2. EMPTY-ATA RENT SCANNER & SAFE V0 CLOSE TRANSACTION TESTS
// ============================================================================

test('scanReclaimableSolanaRent queries SPL Token + Token-2022, excludes non-zero/frozen/uncloseable, and computes exact N * 0.00203928 SOL', async () => {
  const emptySpl1 = deterministicPubkey('rent-spl-1');
  const emptySpl2 = deterministicPubkey('rent-spl-2');
  const empty2022 = deterministicPubkey('rent-2022-1');
  const nonZeroSpl = deterministicPubkey('rent-nonzero');
  const frozenSpl = deterministicPubkey('rent-frozen');
  const foreignCloseAuth = deterministicPubkey('rent-foreign-auth');
  const withheldFee2022 = deterministicPubkey('rent-withheld-2022');

  const queriedPrograms: string[] = [];

  await withMockFetch(
    (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        method?: string;
        params?: unknown[];
      };
      if (body.method === 'getTokenAccountsByOwner') {
        const filter = (body.params?.[1] as { programId?: string }) ?? {};
        const programId = filter.programId ?? '';
        queriedPrograms.push(programId);

        if (programId === SOLANA_TOKEN_PROGRAM_ID.toBase58()) {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [
                {
                  pubkey: emptySpl1,
                  account: {
                    lamports: SOLANA_EMPTY_ATA_RENT_LAMPORTS,
                    data: {
                      parsed: {
                        info: {
                          mint: deterministicPubkey('m1'),
                          owner: SOL_USER_A,
                          state: 'initialized',
                          tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
                        },
                      },
                    },
                  },
                },
                {
                  pubkey: emptySpl2,
                  account: {
                    lamports: SOLANA_EMPTY_ATA_RENT_LAMPORTS,
                    data: {
                      parsed: {
                        info: {
                          mint: deterministicPubkey('m2'),
                          owner: SOL_USER_A,
                          state: 'initialized',
                          tokenAmount: { amount: '0', decimals: 9, uiAmount: 0 },
                        },
                      },
                    },
                  },
                },
                // Non-zero balance -> MUST BE SKIPPED
                {
                  pubkey: nonZeroSpl,
                  account: {
                    lamports: SOLANA_EMPTY_ATA_RENT_LAMPORTS,
                    data: {
                      parsed: {
                        info: {
                          mint: SOLANA_USDC_MINT,
                          owner: SOL_USER_A,
                          state: 'initialized',
                          tokenAmount: { amount: '1', decimals: 6, uiAmount: 0.000001 },
                        },
                      },
                    },
                  },
                },
                // Frozen zero-balance account -> MUST BE SKIPPED
                {
                  pubkey: frozenSpl,
                  account: {
                    lamports: SOLANA_EMPTY_ATA_RENT_LAMPORTS,
                    data: {
                      parsed: {
                        info: {
                          mint: deterministicPubkey('m-frozen'),
                          owner: SOL_USER_A,
                          state: 'frozen',
                          tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
                        },
                      },
                    },
                  },
                },
                // Foreign closeAuthority -> MUST BE SKIPPED
                {
                  pubkey: foreignCloseAuth,
                  account: {
                    lamports: SOLANA_EMPTY_ATA_RENT_LAMPORTS,
                    data: {
                      parsed: {
                        info: {
                          mint: deterministicPubkey('m-foreign'),
                          owner: SOL_USER_A,
                          closeAuthority: SOL_USER_B,
                          state: 'initialized',
                          tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
                        },
                      },
                    },
                  },
                },
              ],
            },
          });
        }

        if (programId === SOLANA_TOKEN_2022_PROGRAM_ID.toBase58()) {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [
                {
                  pubkey: empty2022,
                  account: {
                    lamports: SOLANA_EMPTY_ATA_RENT_LAMPORTS,
                    data: {
                      parsed: {
                        info: {
                          mint: deterministicPubkey('m-2022'),
                          owner: SOL_USER_A,
                          state: 'initialized',
                          tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
                        },
                      },
                    },
                  },
                },
                // Token-2022 with withheld transfer fees -> MUST BE SKIPPED
                {
                  pubkey: withheldFee2022,
                  account: {
                    lamports: SOLANA_EMPTY_ATA_RENT_LAMPORTS,
                    data: {
                      parsed: {
                        info: {
                          mint: deterministicPubkey('m-2022-fee'),
                          owner: SOL_USER_A,
                          state: 'initialized',
                          tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
                          extensions: [
                            { extension: 'transferFeeAmount', state: { withheldAmount: '500' } },
                          ],
                        },
                      },
                    },
                  },
                },
              ],
            },
          });
        }
      }
      return jsonResponse({}, 404);
    },
    async () => {
      const scan = await scanReclaimableSolanaRent(SOL_USER_A, {
        rpcUrls: ['https://mock-solana-rpc.local'],
        solPriceUsd: 200,
        includeUnsignedTx: true,
        recentBlockhash: VALID_BLOCKHASH,
      });

      assert.ok(queriedPrograms.includes(SOLANA_TOKEN_PROGRAM_ID.toBase58()));
      assert.ok(queriedPrograms.includes(SOLANA_TOKEN_2022_PROGRAM_ID.toBase58()));
      assert.equal(scan.totalTokenAccountsScanned, 7);
      assert.equal(scan.reclaimableCount, 3);
      assert.equal(scan.skippedNonZeroCount, 1);
      assert.equal(scan.skippedFrozenCount, 1);
      assert.equal(scan.skippedUncloseableCount, 2);

      const expectedSol = Number((3 * SOLANA_EMPTY_ATA_RENT_SOL).toFixed(8));
      assert.equal(scan.reclaimableSol, expectedSol);
      assert.equal(scan.reclaimableLamports, 3 * SOLANA_EMPTY_ATA_RENT_LAMPORTS);
      assert.equal(scan.reclaimableUsd, Number((expectedSol * 200).toFixed(2)));
      assert.deepEqual(
        scan.reclaimableAccounts.map((a) => a.tokenAccount),
        [emptySpl1, emptySpl2, empty2022]
      );

      // Verify compiled V0 close transaction
      assert.ok(scan.unsignedCloseTx);
      assert.equal(scan.unsignedCloseTx.version, 0);
      assert.equal(scan.unsignedCloseTx.destination, SOL_USER_A);
      assert.equal(scan.unsignedCloseTx.authority, SOL_USER_A);
      assert.equal(scan.unsignedCloseTx.accountCount, 3);

      const parsedTx = VersionedTransaction.deserialize(
        Buffer.from(scan.unsignedCloseTx.serializedTransactionBase64, 'base64')
      );
      assert.equal(parsedTx.version, 0);
      // 2 ComputeBudget + 3 closeAccount = 5 instructions
      assert.equal(parsedTx.message.compiledInstructions.length, 5);
    }
  );
});

test('buildCloseEmptyAtasVersionedTx FAILS CLOSED on non-zero balance, frozen account, >20 accounts, duplicates, owner mismatch, and invalid owner', () => {
  // 1. Non-zero balance -> REJECT
  assert.throws(
    () =>
      buildCloseEmptyAtasVersionedTx(
        SOL_USER_A,
        [mkEmptyAta('bad-bal', { amount: '1', uiAmount: 0.000001 })],
        VALID_BLOCKHASH
      ),
    /non-empty token account/i
  );

  // 2. Non-zero uiAmount even if amount says "0" -> REJECT
  assert.throws(
    () =>
      buildCloseEmptyAtasVersionedTx(
        SOL_USER_A,
        [mkEmptyAta('bad-ui', { amount: '0', uiAmount: 0.01 })],
        VALID_BLOCKHASH
      ),
    /non-empty token account/i
  );

  // 3. Frozen account -> REJECT
  assert.throws(
    () =>
      buildCloseEmptyAtasVersionedTx(
        SOL_USER_A,
        [mkEmptyAta('bad-frozen', { frozen: true, state: 'frozen' })],
        VALID_BLOCKHASH
      ),
    /frozen token account/i
  );

  // 4. >20 accounts in one tx -> REJECT
  const twentyOne = Array.from({ length: MAX_CLOSE_ACCOUNTS_PER_TX + 1 }, (_, i) =>
    mkEmptyAta(`many-${i}`)
  );
  assert.throws(
    () => buildCloseEmptyAtasVersionedTx(SOL_USER_A, twentyOne, VALID_BLOCKHASH),
    /max 20 per tx/i
  );

  // 5. Exactly 20 accounts succeeds and stays within Solana 1232-byte packet limit!
  const twenty = Array.from({ length: MAX_CLOSE_ACCOUNTS_PER_TX }, (_, i) =>
    mkEmptyAta(`ok-${i}`)
  );
  const tx20 = buildCloseEmptyAtasVersionedTx(SOL_USER_A, twenty, VALID_BLOCKHASH);
  assert.equal(tx20.accountCount, 20);
  assert.equal(tx20.reclaimedSol, Number((20 * SOLANA_EMPTY_ATA_RENT_SOL).toFixed(8)));
  assert.ok(tx20.serializedByteLength <= 1232);

  // 6. Duplicate token account -> REJECT
  const dup = mkEmptyAta('dup-1');
  assert.throws(
    () => buildCloseEmptyAtasVersionedTx(SOL_USER_A, [dup, dup], VALID_BLOCKHASH),
    /Duplicate token account/i
  );

  // 7. Owner mismatch -> REJECT
  assert.throws(
    () =>
      buildCloseEmptyAtasVersionedTx(
        SOL_USER_A,
        [mkEmptyAta('other-owner', { owner: SOL_USER_B })],
        VALID_BLOCKHASH
      ),
    /owner.*does not match/i
  );

  // 8. Zero System Program owner -> REJECT
  assert.throws(
    () => buildCloseEmptyAtasVersionedTx(ZERO_PUBKEY, [mkEmptyAta('zero')], VALID_BLOCKHASH),
    /all-zero System Program/i
  );
});

// ============================================================================
// 3. SOLANA YIELD PARKING (JupSOL + Jupiter Lend jlUSDC + Kamino USDC)
// ============================================================================

test('calculateYieldPreservationSplit enforces exact 90/10 BigInt micro-USDC split and rejects invalid bounds', () => {
  const split90 = calculateYieldPreservationSplit(1000, 90);
  assert.equal(split90.preservePct, 90);
  assert.equal(split90.degenPct, 10);
  assert.equal(split90.yieldUsdc, 900);
  assert.equal(split90.yieldUsdcRaw, '900000000');
  assert.equal(split90.degenSidePocketUsdc, 100);
  assert.equal(split90.degenSidePocketRaw, '100000000');
  assert.equal(
    BigInt(split90.yieldUsdcRaw) + BigInt(split90.degenSidePocketRaw),
    BigInt(split90.totalUsdcRaw)
  );

  // Tricky fractional amount preserves exact micro-USDC conservation
  const splitFractional = calculateYieldPreservationSplit(333.333333, 90);
  assert.equal(
    BigInt(splitFractional.yieldUsdcRaw) + BigInt(splitFractional.degenSidePocketRaw),
    BigInt(splitFractional.totalUsdcRaw)
  );

  // Fail closed on preservePct < 50 or > 100, non-finite or non-positive amounts
  assert.throws(() => calculateYieldPreservationSplit(1000, 49.9), /between 50 and 100/i);
  assert.throws(() => calculateYieldPreservationSplit(1000, 101), /between 50 and 100/i);
  assert.throws(() => calculateYieldPreservationSplit(0, 90), /finite positive/i);
  assert.throws(() => calculateYieldPreservationSplit(-50, 90), /finite positive/i);
  assert.throws(() => calculateYieldPreservationSplit(Number.NaN, 90), /finite positive/i);
  assert.throws(() => calculateYieldPreservationSplit(Number.POSITIVE_INFINITY, 90), /finite positive/i);
});

test('buildSolanaYieldParkPlan quotes JupSOL via Jupiter Swap API, builds verified V0 tx, and supports Jupiter Lend / Kamino previews', async () => {
  const mockSwapTx = buildMockV0SwapTxBase64(SOL_USER_A);
  let seenQuoteUrl = '';
  let seenSwapApiKey = '';

  await withMockFetch(
    (url, init) => {
      if (url.includes('/swap/v1/quote')) {
        seenQuoteUrl = url;
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        if (hdrs['x-api-key']) seenSwapApiKey = hdrs['x-api-key'];
        const reqAmount = new URL(url).searchParams.get('amount') ?? '900000000';
        return jsonResponse({
          inputMint: SOLANA_USDC_MINT,
          inAmount: reqAmount,
          outputMint: SOLANA_JUPSOL_MINT,
          outAmount: '5420000000', // 5.42 JupSOL
          otherAmountThreshold: '5392900000',
          swapMode: 'ExactIn',
          slippageBps: 50,
          priceImpactPct: '0.0004',
          routePlan: [{ swapInfo: { label: 'Whirlpool' } }, { swapInfo: { label: 'Sanctum' } }],
        });
      }
      if (url.includes('/swap/v1/swap')) {
        return jsonResponse({
          swapTransaction: mockSwapTx,
          lastValidBlockHeight: 320_000_000,
          prioritizationFeeLamports: 15_000,
        });
      }
      if (url.includes('/lend/v1/earn/tokens')) {
        return jsonResponse([{ symbol: 'jlUSDC', assetAddress: SOLANA_USDC_MINT, totalRate: 815 }]);
      }
      if (url.includes('api.kamino.finance')) {
        return jsonResponse([{ liquidityToken: 'USDC', supplyApy: 0.0725 }]);
      }
      return jsonResponse({}, 404);
    },
    async () => {
      // 1. JupSOL with lite-api + unsigned V0 swap tx
      const jupPlan = await buildSolanaYieldParkPlan({
        ownerAddress: SOL_USER_A,
        totalUsdcAmount: 1000,
        preservePct: 90,
        strategy: 'jupsol',
        buildTransaction: true,
      });

      assert.ok(seenQuoteUrl.startsWith(JUPITER_SWAP_LITE_BASE));
      assert.ok(seenQuoteUrl.includes(`inputMint=${SOLANA_USDC_MINT}`));
      assert.ok(seenQuoteUrl.includes(`outputMint=${SOLANA_JUPSOL_MINT}`));
      assert.ok(seenQuoteUrl.includes('amount=900000000'));
      assert.equal(jupPlan.split.yieldUsdc, 900);
      assert.equal(jupPlan.split.degenSidePocketUsdc, 100);
      assert.ok(jupPlan.jupiterQuote);
      assert.equal(jupPlan.jupiterQuote.estimatedOutputUi, 5.42);
      assert.deepEqual(jupPlan.jupiterQuote.routeLabels, ['Whirlpool', 'Sanctum']);
      assert.ok(jupPlan.transaction);
      assert.equal(jupPlan.transaction.version, 0);
      assert.equal(jupPlan.transaction.feePayer, SOL_USER_A);

      // 2. Pro API endpoint selected when jupiterApiKey is provided
      await buildSolanaYieldParkPlan({
        ownerAddress: SOL_USER_A,
        totalUsdcAmount: 500,
        strategy: 'jupsol',
        jupiterApiKey: 'test-jup-key',
      });
      assert.ok(seenQuoteUrl.startsWith(JUPITER_SWAP_PRO_BASE));
      assert.equal(seenSwapApiKey, 'test-jup-key');

      // 3. Jupiter Lend jlUSDC live APY & 90/10 split
      const jupLendPlan = await buildSolanaYieldParkPlan({
        ownerAddress: SOL_USER_A,
        totalUsdcAmount: 25_000,
        preservePct: 90,
        strategy: 'jupiter_lend_usdc',
      });
      assert.equal(jupLendPlan.split.yieldUsdc, 22_500);
      assert.equal(jupLendPlan.split.degenSidePocketUsdc, 2_500);
      assert.equal(jupLendPlan.apy.source, 'live');
      assert.equal(jupLendPlan.apy.estimatedApyPct, 8.15);
      assert.equal(jupLendPlan.projections.projectedAnnualYieldUsd, 1833.75);

      // 4. Kamino USDC live APY
      const kaminoPlan = await buildSolanaYieldParkPlan({
        ownerAddress: SOL_USER_A,
        totalUsdcAmount: 10_000,
        preservePct: 90,
        strategy: 'kamino_usdc',
      });
      assert.equal(kaminoPlan.apy.source, 'live');
      assert.equal(kaminoPlan.apy.estimatedApyPct, 7.25);
      assert.equal(kaminoPlan.projections.projectedAnnualYieldUsd, 652.5);
    }
  );

  // 5. Fail closed if Jupiter /swap returns a tx whose feePayer is an attacker!
  const attackerSwapTx = buildMockV0SwapTxBase64(SOL_USER_B);
  await withMockFetch(
    (url) => {
      if (url.includes('/swap/v1/quote')) {
        return jsonResponse({
          inputMint: SOLANA_USDC_MINT,
          inAmount: '900000000',
          outputMint: SOLANA_JUPSOL_MINT,
          outAmount: '5420000000',
          otherAmountThreshold: '5392900000',
        });
      }
      if (url.includes('/swap/v1/swap')) {
        return jsonResponse({ swapTransaction: attackerSwapTx });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      await assert.rejects(
        () =>
          buildSolanaYieldParkPlan({
            ownerAddress: SOL_USER_A,
            totalUsdcAmount: 1000,
            strategy: 'jupsol',
            buildTransaction: true,
          }),
        /feePayer mismatch/i
      );
    }
  );

  // 6. Strict Solana address validation & strategy validation
  await assert.rejects(
    () =>
      buildSolanaYieldParkPlan({
        ownerAddress: ZERO_PUBKEY,
        totalUsdcAmount: 100,
      }),
    /all-zero System Program/i
  );
  await assert.rejects(
    () =>
      buildSolanaYieldParkPlan({
        ownerAddress: '0x000000000000000000000000000000000000dead',
        totalUsdcAmount: 100,
      }),
    /Invalid Solana ownerAddress/i
  );
  assert.equal(listSolanaYieldStrategies().length, 3);
});

// ============================================================================
// 4. END-TO-END HTTP ROUTES: /api/solana/rent-scan & /api/solana/yield-park
// ============================================================================

test('HTTP routes POST /api/solana/rent-scan, POST /api/solana/yield-park, and GET /api/solana/yield-strategies work end-to-end and reject bad inputs fail-closed', async () => {
  const { server } = createSiphonServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  const origFetch = globalThis.fetch;
  const mockSwapTx = buildMockV0SwapTxBase64(SOL_USER_A);
  const emptyAta = deterministicPubkey('http-rent-1');

  // Intercept external RPC/Jupiter calls while letting localhost server calls pass through
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(base)) {
      return origFetch(input, init);
    }
    if (url.includes('solana')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        method?: string;
        params?: unknown[];
      };
      if (body.method === 'getTokenAccountsByOwner') {
        const filter = (body.params?.[1] as { programId?: string }) ?? {};
        if (filter.programId === SOLANA_TOKEN_PROGRAM_ID.toBase58()) {
          return jsonResponse({
            jsonrpc: '2.0',
            id: 1,
            result: {
              value: [
                {
                  pubkey: emptyAta,
                  account: {
                    lamports: SOLANA_EMPTY_ATA_RENT_LAMPORTS,
                    data: {
                      parsed: {
                        info: {
                          mint: deterministicPubkey('http-mint-1'),
                          owner: SOL_USER_A,
                          state: 'initialized',
                          tokenAmount: { amount: '0', decimals: 6, uiAmount: 0 },
                        },
                      },
                    },
                  },
                },
              ],
            },
          });
        }
        return jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: [] } });
      }
      if (body.method === 'getLatestBlockhash') {
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: { value: { blockhash: VALID_BLOCKHASH, lastValidBlockHeight: 320_000_000 } },
        });
      }
    }
    if (url.includes('coins.llama.fi')) {
      return jsonResponse({ coins: { 'coingecko:solana': { price: 180 } } });
    }
    if (url.includes('/swap/v1/quote')) {
      return jsonResponse({
        inputMint: SOLANA_USDC_MINT,
        inAmount: '900000000',
        outputMint: SOLANA_JUPSOL_MINT,
        outAmount: '5000000000',
        otherAmountThreshold: '4975000000',
        priceImpactPct: '0.0002',
        routePlan: [{ swapInfo: { label: 'Meteora' } }],
      });
    }
    if (url.includes('/swap/v1/swap')) {
      return jsonResponse({
        swapTransaction: mockSwapTx,
        lastValidBlockHeight: 320_000_000,
        prioritizationFeeLamports: 12_000,
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  try {
    // 1. GET /api/solana/yield-strategies
    const stratRes = await fetch(`${base}/api/solana/yield-strategies`);
    assert.equal(stratRes.status, 200);
    const stratJson = (await stratRes.json()) as { strategies: Array<{ id: string }> };
    assert.deepEqual(
      stratJson.strategies.map((s) => s.id),
      ['jupsol', 'jupiter_lend_usdc', 'kamino_usdc']
    );

    // 2. POST /api/solana/rent-scan with unsigned V0 close tx
    const rentRes = await fetch(`${base}/api/solana/rent-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress: SOL_USER_A,
        includeUnsignedTx: true,
      }),
    });
    assert.equal(rentRes.status, 200);
    const rentJson = (await rentRes.json()) as {
      reclaimableCount: number;
      reclaimableSol: number;
      reclaimableUsd: number;
      unsignedCloseTx: { version: number; serializedTransactionBase64: string } | null;
    };
    assert.equal(rentJson.reclaimableCount, 1);
    assert.equal(rentJson.reclaimableSol, SOLANA_EMPTY_ATA_RENT_SOL);
    assert.equal(rentJson.reclaimableUsd, Number((SOLANA_EMPTY_ATA_RENT_SOL * 180).toFixed(2)));
    assert.ok(rentJson.unsignedCloseTx?.serializedTransactionBase64);
    assert.equal(rentJson.unsignedCloseTx.version, 0);

    // 3. POST /api/solana/rent-scan rejects invalid Solana address with 400
    const badRentRes = await fetch(`${base}/api/solana/rent-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerAddress: ZERO_PUBKEY }),
    });
    assert.equal(badRentRes.status, 400);

    // 4. POST /api/solana/yield-park (JupSOL + unsigned V0 swap tx)
    const parkRes = await fetch(`${base}/api/solana/yield-park`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress: SOL_USER_A,
        totalUsdcAmount: 1000,
        preservePct: 90,
        strategy: 'jupsol',
        buildTransaction: true,
      }),
    });
    assert.equal(parkRes.status, 200);
    const parkJson = (await parkRes.json()) as {
      split: { yieldUsdc: number; degenSidePocketUsdc: number };
      jupiterQuote: { estimatedOutputUi: number } | null;
      transaction: { version: number; feePayer: string; swapTransactionBase64: string } | null;
    };
    assert.equal(parkJson.split.yieldUsdc, 900);
    assert.equal(parkJson.split.degenSidePocketUsdc, 100);
    assert.equal(parkJson.jupiterQuote?.estimatedOutputUi, 5);
    assert.equal(parkJson.transaction?.version, 0);
    assert.equal(parkJson.transaction?.feePayer, SOL_USER_A);

    // 5. POST /api/solana/yield-park rejects preservePct < 50 and invalid amounts with 400
    const badParkRes = await fetch(`${base}/api/solana/yield-park`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress: SOL_USER_A,
        totalUsdcAmount: 1000,
        preservePct: 30,
        strategy: 'jupsol',
      }),
    });
    assert.equal(badParkRes.status, 400);
  } finally {
    globalThis.fetch = origFetch;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
