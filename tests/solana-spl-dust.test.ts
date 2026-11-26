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
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { SOLANA_TOKEN_PROGRAM_ID } from '../src/bridge/cctp.js';
import {
  SOLANA_EMPTY_ATA_RENT_LAMPORTS,
  SOLANA_EMPTY_ATA_RENT_SOL,
} from '../src/bridge/solana-rent.js';
import {
  appendAtomicCloseAccountToVersionedTx,
  buildAtomicSplCloseInstruction,
  buildSolanaSplDustSweepPlan,
  DEFAULT_MAX_DUST_USD,
  isProtectedSolanaMint,
  MAX_JUPITER_PRICE_IMPACT_PCT,
  scanSolanaSplDust,
  SOLANA_JUPITER_LEND_JLUSDC_MINT,
  SOLANA_JUPSOL_MINT,
  SOLANA_USDC_MINT,
  SOLANA_WSOL_MINT,
} from '../src/solana/spl-dust.js';
import { JUPITER_SWAP_LITE_BASE, JUPITER_SWAP_PRO_BASE } from '../src/solana/yield-park.js';
import { createTurgaliumServer } from '../src/server/app.js';

const SOL_USER_A = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const SOL_USER_B = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const VALID_BLOCKHASH = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi';
const ZERO_PUBKEY = '11111111111111111111111111111111';

function deterministicPubkey(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest();
  return Keypair.fromSeed(hash).publicKey.toBase58();
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

function buildMockV0SwapTxBase64(payerAddress: string, extraInstructions: TransactionInstruction[] = []): string {
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
      ...extraInstructions,
    ],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

function mkParsedTokenAccount(opts: {
  pubkey: string;
  mint: string;
  owner?: string;
  amount: string;
  decimals?: number;
  uiAmount?: number;
  state?: string;
  closeAuthority?: string | null;
  isNative?: boolean;
  lamports?: number;
}) {
  const decimals = opts.decimals ?? 6;
  const uiAmount =
    opts.uiAmount !== undefined ? opts.uiAmount : Number(opts.amount) / Math.pow(10, decimals);
  return {
    pubkey: opts.pubkey,
    account: {
      lamports: opts.lamports ?? SOLANA_EMPTY_ATA_RENT_LAMPORTS,
      data: {
        parsed: {
          info: {
            mint: opts.mint,
            owner: opts.owner ?? SOL_USER_A,
            state: opts.state ?? 'initialized',
            ...(opts.closeAuthority ? { closeAuthority: opts.closeAuthority } : {}),
            ...(opts.isNative ? { isNative: true } : {}),
            tokenAmount: {
              amount: opts.amount,
              decimals,
              uiAmount,
              uiAmountString: String(uiAmount),
            },
          },
        },
      },
    },
  };
}

// ============================================================================
// 1. SPL DUST SCANNER UNIT TESTS
// ============================================================================

test('scanSolanaSplDust skips SOL/USDC/JupSOL/jlUSDC, frozen, zero-balance, foreign-owner, and >$50 positions while returning accurate dust + ATA rent', async () => {
  const dustAta1 = deterministicPubkey('dust-ata-1');
  const dustMint1 = deterministicPubkey('dust-mint-1');
  const dustAta2 = deterministicPubkey('dust-ata-2');
  const dustMint2 = deterministicPubkey('dust-mint-2');
  const whaleAta = deterministicPubkey('whale-ata');
  const whaleMint = deterministicPubkey('whale-mint');

  const wsolAta = deterministicPubkey('wsol-ata');
  const usdcAta = deterministicPubkey('usdc-ata');
  const jupsolAta = deterministicPubkey('jupsol-ata');
  const jlusdcAta = deterministicPubkey('jlusdc-ata');
  const zeroAta = deterministicPubkey('zero-ata');
  const frozenAta = deterministicPubkey('frozen-ata');
  const foreignAuthAta = deterministicPubkey('foreign-auth-ata');

  await withMockFetch(
    (url, init) => {
      if (url.includes('mock-solana-rpc')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          method?: string;
          params?: unknown[];
        };
        assert.equal(body.method, 'getTokenAccountsByOwner');
        const filter = (body.params?.[1] as { programId?: string }) ?? {};
        assert.equal(filter.programId, SOLANA_TOKEN_PROGRAM_ID.toBase58());
        return jsonResponse({
          jsonrpc: '2.0',
          id: 1,
          result: {
            value: [
              // Valid dust #1: $12.50
              mkParsedTokenAccount({
                pubkey: dustAta1,
                mint: dustMint1,
                amount: '25000000',
                decimals: 6,
                uiAmount: 25,
              }),
              // Valid dust #2: $1.20 (priced via DeFiLlama fallback)
              mkParsedTokenAccount({
                pubkey: dustAta2,
                mint: dustMint2,
                amount: '1200000000',
                decimals: 9,
                uiAmount: 1.2,
              }),
              // Large position ($125 > default $50 maxDustUsd) -> MUST SKIP
              mkParsedTokenAccount({
                pubkey: whaleAta,
                mint: whaleMint,
                amount: '125000000',
                decimals: 6,
                uiAmount: 125,
              }),
              // Protected mints -> MUST SKIP
              mkParsedTokenAccount({
                pubkey: wsolAta,
                mint: SOLANA_WSOL_MINT,
                amount: '50000000',
                decimals: 9,
                uiAmount: 0.05,
                isNative: true,
              }),
              mkParsedTokenAccount({
                pubkey: usdcAta,
                mint: SOLANA_USDC_MINT,
                amount: '10000000',
                decimals: 6,
                uiAmount: 10,
              }),
              mkParsedTokenAccount({
                pubkey: jupsolAta,
                mint: SOLANA_JUPSOL_MINT,
                amount: '50000000',
                decimals: 9,
                uiAmount: 0.05,
              }),
              mkParsedTokenAccount({
                pubkey: jlusdcAta,
                mint: SOLANA_JUPITER_LEND_JLUSDC_MINT,
                amount: '5000000',
                decimals: 6,
                uiAmount: 5,
              }),
              // Zero-balance -> MUST SKIP
              mkParsedTokenAccount({
                pubkey: zeroAta,
                mint: deterministicPubkey('zero-mint'),
                amount: '0',
                decimals: 6,
                uiAmount: 0,
              }),
              // Frozen -> MUST SKIP
              mkParsedTokenAccount({
                pubkey: frozenAta,
                mint: deterministicPubkey('frozen-mint'),
                amount: '5000000',
                decimals: 6,
                uiAmount: 5,
                state: 'frozen',
              }),
              // Foreign closeAuthority -> MUST SKIP
              mkParsedTokenAccount({
                pubkey: foreignAuthAta,
                mint: deterministicPubkey('foreign-mint'),
                amount: '5000000',
                decimals: 6,
                uiAmount: 5,
                closeAuthority: SOL_USER_B,
              }),
            ],
          },
        });
      }
      if (url.includes('/price/v2')) {
        return jsonResponse({
          data: {
            [SOLANA_WSOL_MINT]: { price: '200', mintSymbol: 'SOL' },
            [dustMint1]: { price: '0.5', mintSymbol: 'BONK' },
            [whaleMint]: { price: '1.0', mintSymbol: 'BIG' },
          },
        });
      }
      if (url.includes('coins.llama.fi')) {
        return jsonResponse({
          coins: {
            [`solana:${dustMint2}`]: { price: 1.0, symbol: 'WIF' },
          },
        });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      const res = await scanSolanaSplDust(SOL_USER_A, {
        rpcUrls: ['https://mock-solana-rpc.local'],
      });

      assert.equal(res.ownerAddress, SOL_USER_A);
      assert.equal(res.maxDustUsd, DEFAULT_MAX_DUST_USD);
      assert.equal(res.totalTokenAccountsScanned, 10);
      assert.equal(res.dustCount, 2);
      assert.equal(res.skippedProtectedCount, 4);
      assert.equal(res.skippedZeroBalanceCount, 1);
      assert.equal(res.skippedFrozenCount, 1);
      assert.equal(res.skippedUncloseableCount, 1);
      assert.equal(res.skippedAboveMaxUsdCount, 1);
      assert.equal(res.solPriceUsd, 200);
      assert.equal(res.solPriceSource, 'live');

      assert.deepEqual(
        res.dustAccounts.map((a) => a.tokenAccount),
        [dustAta1, dustAta2]
      );
      assert.equal(res.dustAccounts[0].symbol, 'BONK');
      assert.equal(res.dustAccounts[0].usdValue, 12.5);
      assert.equal(res.dustAccounts[0].priceSource, 'jupiter');
      assert.equal(res.dustAccounts[0].rentSol, SOLANA_EMPTY_ATA_RENT_SOL);

      assert.equal(res.dustAccounts[1].symbol, 'WIF');
      assert.equal(res.dustAccounts[1].usdValue, 1.2);
      assert.equal(res.dustAccounts[1].priceSource, 'defillama');

      assert.equal(res.totalDustUsd, 13.7);
      assert.equal(res.reclaimableRentLamports, 2 * SOLANA_EMPTY_ATA_RENT_LAMPORTS);
      const expectedRentSol = Number((2 * SOLANA_EMPTY_ATA_RENT_SOL).toFixed(8));
      assert.equal(res.reclaimableRentSol, expectedRentSol);
      assert.equal(res.reclaimableRentUsd, Number((expectedRentSol * 200).toFixed(2)));
    }
  );
});

test('scanSolanaSplDust enforces strict Base58, bounds validation, and prototype-pollution guards', async () => {
  assert.equal(isProtectedSolanaMint(SOLANA_USDC_MINT), true);
  assert.equal(isProtectedSolanaMint(SOLANA_WSOL_MINT), true);
  assert.equal(isProtectedSolanaMint(SOLANA_JUPSOL_MINT), true);
  assert.equal(isProtectedSolanaMint(SOLANA_JUPITER_LEND_JLUSDC_MINT), true);
  assert.equal(isProtectedSolanaMint(deterministicPubkey('random-token')), false);

  await assert.rejects(() => scanSolanaSplDust(ZERO_PUBKEY), /all-zero System Program/i);
  await assert.rejects(
    () => scanSolanaSplDust('0x000000000000000000000000000000000000dead'),
    /Invalid Solana ownerAddress/i
  );
  await assert.rejects(
    () => scanSolanaSplDust(SOL_USER_A, { maxDustUsd: 0 }),
    /maxDustUsd must be a finite number/i
  );
  await assert.rejects(
    () => scanSolanaSplDust(SOL_USER_A, { maxDustUsd: 99_999 }),
    /maxDustUsd must be a finite number/i
  );
  await assert.rejects(
    () => scanSolanaSplDust(SOL_USER_A, { maxDustUsd: 20, minDustUsd: 25 }),
    /minDustUsd must be a finite number/i
  );

  // Prototype-pollution payload in priceMapUsd must be ignored safely
  const maliciousPrices = JSON.parse(
    '{"__proto__": 999, "constructor": 999, "toString": 999}'
  ) as Record<string, number>;
  const ata = deterministicPubkey('proto-ata');
  const mint = deterministicPubkey('proto-mint');

  await withMockFetch(
    () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          value: [
            mkParsedTokenAccount({
              pubkey: ata,
              mint,
              amount: '1000000',
              decimals: 6,
            }),
          ],
        },
      }),
    async () => {
      const scan = await scanSolanaSplDust(SOL_USER_A, {
        rpcUrls: ['https://mock-solana-rpc.local'],
        priceMapUsd: maliciousPrices,
        solPriceUsd: 150,
        skipPriceFetch: true,
      });
      assert.equal(scan.dustCount, 1);
      assert.equal(scan.dustAccounts[0].priceUsd, null);
      assert.equal(scan.dustAccounts[0].priceSource, 'unpriced');
    }
  );
});

// ============================================================================
// 2. JUPITER SWAP + ATOMIC CLOSE ACCOUNT RENT RECLAIM TESTS
// ============================================================================

test('buildSolanaSplDustSweepPlan swaps dust into USDC and SOL with atomic SPL CloseAccount rent reclaim (0.00203928 SOL/ATA)', async () => {
  const dustAta = deterministicPubkey('sweep-ata-1');
  const dustMint = deterministicPubkey('sweep-mint-1');
  const mockSwapTx = buildMockV0SwapTxBase64(SOL_USER_A);

  let seenQuoteUrl = '';
  let seenApiKey = '';

  await withMockFetch(
    (url, init) => {
      if (url.includes('/swap/v1/quote')) {
        seenQuoteUrl = url;
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        if (hdrs['x-api-key']) seenApiKey = hdrs['x-api-key'];
        const u = new URL(url);
        const outMint = u.searchParams.get('outputMint') ?? SOLANA_USDC_MINT;
        return jsonResponse({
          inputMint: u.searchParams.get('inputMint'),
          outputMint: outMint,
          inAmount: u.searchParams.get('amount'),
          outAmount: outMint === SOLANA_USDC_MINT ? '8500000' : '42500000',
          otherAmountThreshold: outMint === SOLANA_USDC_MINT ? '8415000' : '42075000',
          priceImpactPct: '0.0035',
          routePlan: [{ swapInfo: { label: 'Raydium CLMM' } }],
        });
      }
      if (url.includes('/swap/v1/swap')) {
        return jsonResponse({
          swapTransaction: mockSwapTx,
          lastValidBlockHeight: 330_000_000,
          prioritizationFeeLamports: 10_000,
        });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      // 1. Target USDC (default lite-api) + atomic CloseAccount
      const usdcPlan = await buildSolanaSplDustSweepPlan({
        ownerAddress: SOL_USER_A,
        targetAsset: 'usdc',
        solPriceUsd: 200,
        skipPriceFetch: true,
        tokens: [
          {
            tokenAccount: dustAta,
            mint: dustMint,
            amount: '5000000',
            decimals: 6,
            symbol: 'BONK',
          },
        ],
      });

      assert.ok(seenQuoteUrl.startsWith(JUPITER_SWAP_LITE_BASE));
      assert.equal(usdcPlan.targetAsset, 'usdc');
      assert.equal(usdcPlan.targetMint, SOLANA_USDC_MINT);
      assert.equal(usdcPlan.sweptCount, 1);
      assert.equal(usdcPlan.skippedCount, 0);
      assert.equal(usdcPlan.estimatedTotalOutputUi, 8.5);
      assert.equal(usdcPlan.estimatedTotalOutputUsd, 8.5);
      assert.equal(usdcPlan.totalReclaimableRentSol, SOLANA_EMPTY_ATA_RENT_SOL);
      assert.equal(usdcPlan.items.length, 1);

      const item = usdcPlan.items[0];
      assert.equal(item.quote.priceImpactPct, 0.35);
      assert.deepEqual(item.quote.routeLabels, ['Raydium CLMM']);
      assert.equal(item.rentReclaim.enabled, true);
      assert.equal(item.rentReclaim.atomicCloseAppended, true);
      assert.equal(item.rentReclaim.destination, SOL_USER_A);
      assert.equal(item.rentReclaim.authority, SOL_USER_A);
      assert.ok(item.transaction);
      assert.equal(item.transaction.version, 0);
      assert.equal(item.transaction.feePayer, SOL_USER_A);
      assert.equal(item.transaction.atomicCloseAppended, true);
      assert.ok(item.transaction.serializedByteLength <= 1232);

      // Deserialize V0 tx and verify the final compiled instruction is SPL CloseAccount opcode 9
      const v0Tx = VersionedTransaction.deserialize(
        Buffer.from(item.transaction.swapTransactionBase64, 'base64')
      );
      assert.equal(v0Tx.version, 0);
      const keys = v0Tx.message.staticAccountKeys;
      assert.equal(keys[0].toBase58(), SOL_USER_A);
      const lastIx = v0Tx.message.compiledInstructions[v0Tx.message.compiledInstructions.length - 1];
      assert.equal(keys[lastIx.programIdIndex].toBase58(), SOLANA_TOKEN_PROGRAM_ID.toBase58());
      assert.deepEqual(Buffer.from(lastIx.data), Buffer.from([9]));
      assert.equal(keys[lastIx.accountKeyIndexes[0]].toBase58(), dustAta);
      assert.equal(keys[lastIx.accountKeyIndexes[1]].toBase58(), SOL_USER_A);
      assert.equal(keys[lastIx.accountKeyIndexes[2]].toBase58(), SOL_USER_A);

      // 2. Target SOL with Pro API key + closeAccounts: false
      const solPlan = await buildSolanaSplDustSweepPlan({
        ownerAddress: SOL_USER_A,
        targetAsset: 'sol',
        solPriceUsd: 200,
        skipPriceFetch: true,
        closeAccounts: false,
        jupiterApiKey: 'test-pro-key',
        tokens: [
          {
            tokenAccount: dustAta,
            mint: dustMint,
            amount: '5000000',
            decimals: 6,
            symbol: 'BONK',
          },
        ],
      });

      assert.ok(seenQuoteUrl.startsWith(JUPITER_SWAP_PRO_BASE));
      assert.equal(seenApiKey, 'test-pro-key');
      assert.equal(solPlan.targetAsset, 'sol');
      assert.equal(solPlan.targetMint, SOLANA_WSOL_MINT);
      assert.equal(solPlan.estimatedTotalOutputUi, 0.0425);
      assert.equal(solPlan.estimatedTotalOutputUsd, 8.5);
      assert.equal(solPlan.totalReclaimableRentLamports, 0);
      assert.equal(solPlan.items[0].rentReclaim.enabled, false);
      assert.equal(solPlan.items[0].transaction?.atomicCloseAppended, false);
    }
  );
});

test('appendAtomicCloseAccountToVersionedTx supports V0 transactions with Address Lookup Tables (fast static path) and rejects feePayer mismatch', async () => {
  const dustAta = deterministicPubkey('alt-dust-ata');
  const dummyExternal = deterministicPubkey('alt-external-acct');
  const payer = new PublicKey(SOL_USER_A);

  const alt = new AddressLookupTableAccount({
    key: new PublicKey(deterministicPubkey('alt-table-key')),
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 300_000_000,
      lastExtendedSlotStartIndex: 0,
      authority: payer,
      addresses: [new PublicKey(dummyExternal)],
    },
  });

  // Swap instruction that uses dustAta (writable static) + SPL Token Program (static) + ALT key
  const fakeSwapIx = new TransactionInstruction({
    programId: SOLANA_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: new PublicKey(dustAta), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(dummyExternal), isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
  });

  const altMsg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: VALID_BLOCKHASH,
    instructions: [fakeSwapIx],
  }).compileToV0Message([alt]);
  const altTxB64 = Buffer.from(new VersionedTransaction(altMsg).serialize()).toString('base64');

  const res = await appendAtomicCloseAccountToVersionedTx(altTxB64, SOL_USER_A, dustAta);
  assert.equal(res.atomicCloseAppended, true);
  assert.equal(res.feePayer, SOL_USER_A);
  const parsed = VersionedTransaction.deserialize(Buffer.from(res.swapTransactionBase64, 'base64'));
  assert.equal(parsed.version, 0);
  assert.equal(parsed.message.addressTableLookups.length, 1);
  assert.equal(parsed.message.compiledInstructions.length, 2);
  const closeIx = parsed.message.compiledInstructions[1];
  assert.deepEqual(Buffer.from(closeIx.data), Buffer.from([9]));
  assert.equal(parsed.message.staticAccountKeys[closeIx.accountKeyIndexes[0]].toBase58(), dustAta);
  assert.equal(parsed.message.staticAccountKeys[closeIx.accountKeyIndexes[1]].toBase58(), SOL_USER_A);
  assert.equal(parsed.message.staticAccountKeys[closeIx.accountKeyIndexes[2]].toBase58(), SOL_USER_A);

  // Reject attacker feePayer
  const attackerTx = buildMockV0SwapTxBase64(SOL_USER_B);
  await assert.rejects(
    () => appendAtomicCloseAccountToVersionedTx(attackerTx, SOL_USER_A, dustAta),
    /feePayer mismatch/i
  );

  // Reject legacy tx
  const legacyTx = new Transaction({
    feePayer: payer,
    recentBlockhash: VALID_BLOCKHASH,
  }).add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 0 }));
  const legacyB64 = Buffer.from(
    legacyTx.serialize({ requireAllSignatures: false, verifySignatures: false })
  ).toString('base64');
  await assert.rejects(
    () => appendAtomicCloseAccountToVersionedTx(legacyB64, SOL_USER_A, dustAta),
    /Expected VersionedTransaction v0/i
  );

  // Reject closing owner wallet itself
  assert.throws(
    () => buildAtomicSplCloseInstruction(SOL_USER_A, SOL_USER_A),
    /Refusing to close owner wallet/i
  );
});

test('buildSolanaSplDustSweepPlan enforces priceImpactPct <= 5% cap, whale protection, feePayer/mint tamper rejection, and protected mint guards', async () => {
  const dustAtaSafe = deterministicPubkey('safe-ata');
  const dustMintSafe = deterministicPubkey('safe-mint');
  const dustAtaHighImpact = deterministicPubkey('impact-ata');
  const dustMintHighImpact = deterministicPubkey('impact-mint');
  const dustAtaWhale = deterministicPubkey('unpriced-whale-ata');
  const dustMintWhale = deterministicPubkey('unpriced-whale-mint');

  const safeSwapTx = buildMockV0SwapTxBase64(SOL_USER_A);

  // 1. High price impact (>5%) and unpriced whale (>maxDustUsd) are skipped; safe token succeeds
  await withMockFetch(
    (url) => {
      if (url.includes('/swap/v1/quote')) {
        const u = new URL(url);
        const inputMint = u.searchParams.get('inputMint');
        const amount = u.searchParams.get('amount');
        if (inputMint === dustMintHighImpact) {
          return jsonResponse({
            inputMint,
            outputMint: SOLANA_USDC_MINT,
            inAmount: amount,
            outAmount: '2000000',
            otherAmountThreshold: '1980000',
            priceImpactPct: '0.075', // 7.5% > 5% cap!
          });
        }
        if (inputMint === dustMintWhale) {
          return jsonResponse({
            inputMint,
            outputMint: SOLANA_USDC_MINT,
            inAmount: amount,
            outAmount: '250000000', // $250 USDC > $50 maxDustUsd!
            otherAmountThreshold: '248000000',
            priceImpactPct: '0.001',
          });
        }
        return jsonResponse({
          inputMint,
          outputMint: SOLANA_USDC_MINT,
          inAmount: amount,
          outAmount: '3000000',
          otherAmountThreshold: '2970000',
          priceImpactPct: '0.005', // 0.5%
        });
      }
      if (url.includes('/swap/v1/swap')) {
        return jsonResponse({ swapTransaction: safeSwapTx });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      const plan = await buildSolanaSplDustSweepPlan({
        ownerAddress: SOL_USER_A,
        targetAsset: 'usdc',
        solPriceUsd: 150,
        skipPriceFetch: true,
        tokens: [
          { tokenAccount: dustAtaSafe, mint: dustMintSafe, amount: '1000000', symbol: 'SAFE' },
          {
            tokenAccount: dustAtaHighImpact,
            mint: dustMintHighImpact,
            amount: '1000000',
            symbol: 'ILLIQ',
          },
          { tokenAccount: dustAtaWhale, mint: dustMintWhale, amount: '1000000', symbol: 'WHALE' },
        ],
      });

      assert.equal(plan.sweptCount, 1);
      assert.equal(plan.skippedCount, 2);
      assert.equal(plan.items[0].mint, dustMintSafe);
      assert.ok(plan.items[0].quote.priceImpactPct <= MAX_JUPITER_PRICE_IMPACT_PCT);
      assert.match(plan.skipped[0].reason, /exceeds maximum safe limit \(5%\)/i);
      assert.match(plan.skipped[1].reason, /exceeds maxDustUsd/i);
    }
  );

  // 2. Tampered feePayer in Jupiter /swap MUST fail closed (throw)
  const attackerSwapTx = buildMockV0SwapTxBase64(SOL_USER_B);
  await withMockFetch(
    (url) => {
      if (url.includes('/swap/v1/quote')) {
        return jsonResponse({
          inputMint: dustMintSafe,
          outputMint: SOLANA_USDC_MINT,
          inAmount: '1000000',
          outAmount: '3000000',
          otherAmountThreshold: '2970000',
          priceImpactPct: '0.001',
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
          buildSolanaSplDustSweepPlan({
            ownerAddress: SOL_USER_A,
            targetAsset: 'usdc',
            solPriceUsd: 150,
            skipPriceFetch: true,
            tokens: [{ tokenAccount: dustAtaSafe, mint: dustMintSafe, amount: '1000000' }],
          }),
        /feePayer mismatch/i
      );
    }
  );

  // 3. Tampered outputMint in Jupiter /quote MUST fail closed (throw)
  await withMockFetch(
    (url) => {
      if (url.includes('/swap/v1/quote')) {
        return jsonResponse({
          inputMint: dustMintSafe,
          outputMint: deterministicPubkey('fake-output-mint'),
          inAmount: '1000000',
          outAmount: '3000000',
          priceImpactPct: '0.001',
        });
      }
      return jsonResponse({}, 404);
    },
    async () => {
      await assert.rejects(
        () =>
          buildSolanaSplDustSweepPlan({
            ownerAddress: SOL_USER_A,
            targetAsset: 'usdc',
            solPriceUsd: 150,
            skipPriceFetch: true,
            tokens: [{ tokenAccount: dustAtaSafe, mint: dustMintSafe, amount: '1000000' }],
          }),
        /outputMint mismatch/i
      );
    }
  );

  // 4. Rejects protected mints, duplicate tokenAccounts, prototype-polluted targetAsset
  await assert.rejects(
    () =>
      buildSolanaSplDustSweepPlan({
        ownerAddress: SOL_USER_A,
        targetAsset: 'toString' as unknown as 'usdc',
      }),
    /Unsupported targetAsset/i
  );
  await assert.rejects(
    () =>
      buildSolanaSplDustSweepPlan({
        ownerAddress: SOL_USER_A,
        targetAsset: 'usdc',
        tokens: [{ tokenAccount: dustAtaSafe, mint: SOLANA_JUPSOL_MINT, amount: '1000000' }],
      }),
    /protected Solana mint/i
  );
  await assert.rejects(
    () =>
      buildSolanaSplDustSweepPlan({
        ownerAddress: SOL_USER_A,
        targetAsset: 'usdc',
        tokens: [
          { tokenAccount: dustAtaSafe, mint: dustMintSafe, amount: '1000000' },
          { tokenAccount: dustAtaSafe, mint: dustMintSafe, amount: '1000000' },
        ],
      }),
    /Duplicate tokenAccount/i
  );
});

// ============================================================================
// 3. END-TO-END HTTP INTEGRATION TESTS (/api/solana/dust-scan & dust-sweep)
// ============================================================================

test('HTTP routes POST /api/solana/dust-scan and POST /api/solana/dust-sweep work end-to-end with strict 400 validation and atomic CloseAccount V0 tx', async () => {
  const { server } = createTurgaliumServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  const origFetch = globalThis.fetch;
  const dustAta = deterministicPubkey('http-dust-ata');
  const dustMint = deterministicPubkey('http-dust-mint');
  const mockSwapTx = buildMockV0SwapTxBase64(SOL_USER_A);

  let failJupiter = false;
  let failRpc = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(base)) {
      return origFetch(input, init);
    }
    if (url.includes('solana') || url.includes('publicnode')) {
      if (failRpc) return jsonResponse({ error: { message: 'RPC down' } }, 503);
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          value: [
            mkParsedTokenAccount({
              pubkey: dustAta,
              mint: dustMint,
              amount: '4000000',
              decimals: 6,
              uiAmount: 4,
            }),
            mkParsedTokenAccount({
              pubkey: deterministicPubkey('http-usdc-ata'),
              mint: SOLANA_USDC_MINT,
              amount: '25000000',
              decimals: 6,
              uiAmount: 25,
            }),
          ],
        },
      });
    }
    if (url.includes('/price/v2')) {
      return jsonResponse({
        data: {
          [SOLANA_WSOL_MINT]: { price: '180', mintSymbol: 'SOL' },
          [dustMint]: { price: '2.5', mintSymbol: 'MEW' },
        },
      });
    }
    if (url.includes('/swap/v1/quote')) {
      if (failJupiter) return jsonResponse({ error: 'Upstream 503' }, 503);
      const u = new URL(url);
      const outMint = u.searchParams.get('outputMint') ?? SOLANA_USDC_MINT;
      return jsonResponse({
        inputMint: dustMint,
        outputMint: outMint,
        inAmount: '4000000',
        outAmount: outMint === SOLANA_USDC_MINT ? '10000000' : '55555555',
        otherAmountThreshold: outMint === SOLANA_USDC_MINT ? '9900000' : '55000000',
        priceImpactPct: '0.002',
        routePlan: [{ swapInfo: { label: 'Orca Whirlpool' } }],
      });
    }
    if (url.includes('/swap/v1/swap')) {
      if (failJupiter) return jsonResponse({ error: 'Upstream 503' }, 503);
      return jsonResponse({
        swapTransaction: mockSwapTx,
        lastValidBlockHeight: 335_000_000,
        prioritizationFeeLamports: 11_000,
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  try {
    // 1. POST /api/solana/dust-scan -> 200
    const scanRes = await fetch(`${base}/api/solana/dust-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerAddress: SOL_USER_A, maxDustUsd: 50 }),
    });
    assert.equal(scanRes.status, 200);
    const scanJson = (await scanRes.json()) as {
      dustCount: number;
      skippedProtectedCount: number;
      totalDustUsd: number;
      reclaimableRentSol: number;
      dustAccounts: Array<{ tokenAccount: string; mint: string; symbol: string; usdValue: number }>;
    };
    assert.equal(scanJson.dustCount, 1);
    assert.equal(scanJson.skippedProtectedCount, 1);
    assert.equal(scanJson.totalDustUsd, 10);
    assert.equal(scanJson.reclaimableRentSol, SOLANA_EMPTY_ATA_RENT_SOL);
    assert.equal(scanJson.dustAccounts[0].symbol, 'MEW');

    // 2. POST /api/solana/dust-scan strict 400 validation
    const badScanZero = await fetch(`${base}/api/solana/dust-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerAddress: ZERO_PUBKEY }),
    });
    assert.equal(badScanZero.status, 400);

    const badScanType = await fetch(`${base}/api/solana/dust-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerAddress: SOL_USER_A, maxDustUsd: '50' }),
    });
    assert.equal(badScanType.status, 400);

    // 3. POST /api/solana/dust-sweep (auto-scan + USDC + atomic CloseAccount) -> 200
    const sweepUsdcRes = await fetch(`${base}/api/solana/dust-sweep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress: SOL_USER_A,
        targetAsset: 'usdc',
        closeAccounts: true,
      }),
    });
    assert.equal(sweepUsdcRes.status, 200);
    const sweepUsdc = (await sweepUsdcRes.json()) as {
      sweptCount: number;
      targetSymbol: string;
      estimatedTotalOutputUi: number;
      totalReclaimableRentSol: number;
      items: Array<{
        transaction: {
          version: number;
          feePayer: string;
          atomicCloseAppended: boolean;
          swapTransactionBase64: string;
        } | null;
      }>;
    };
    assert.equal(sweepUsdc.sweptCount, 1);
    assert.equal(sweepUsdc.targetSymbol, 'USDC');
    assert.equal(sweepUsdc.estimatedTotalOutputUi, 10);
    assert.equal(sweepUsdc.totalReclaimableRentSol, SOLANA_EMPTY_ATA_RENT_SOL);
    assert.ok(sweepUsdc.items[0].transaction?.atomicCloseAppended);
    assert.equal(sweepUsdc.items[0].transaction?.feePayer, SOL_USER_A);

    // 4. POST /api/solana/dust-sweep (explicit tokens -> SOL) -> 200
    const sweepSolRes = await fetch(`${base}/api/solana/dust-sweep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress: SOL_USER_A,
        targetAsset: 'sol',
        tokens: [{ tokenAccount: dustAta, mint: dustMint, amount: '4000000', decimals: 6 }],
      }),
    });
    assert.equal(sweepSolRes.status, 200);
    const sweepSol = (await sweepSolRes.json()) as { targetSymbol: string; sweptCount: number };
    assert.equal(sweepSol.targetSymbol, 'SOL');
    assert.equal(sweepSol.sweptCount, 1);

    // 5. POST /api/solana/dust-sweep strict 400 validations
    const badTarget = await fetch(`${base}/api/solana/dust-sweep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerAddress: SOL_USER_A, targetAsset: '__proto__' }),
    });
    assert.equal(badTarget.status, 400);

    const badProtected = await fetch(`${base}/api/solana/dust-sweep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress: SOL_USER_A,
        targetAsset: 'usdc',
        tokens: [{ tokenAccount: dustAta, mint: SOLANA_USDC_MINT, amount: '1000000' }],
      }),
    });
    assert.equal(badProtected.status, 400);

    const badSlippage = await fetch(`${base}/api/solana/dust-sweep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerAddress: SOL_USER_A, slippageBps: 9999 }),
    });
    assert.equal(badSlippage.status, 400);

    // 6. Upstream Jupiter failure -> 502; Solana RPC failure -> 503
    failJupiter = true;
    const jup502 = await fetch(`${base}/api/solana/dust-sweep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress: SOL_USER_A,
        targetAsset: 'usdc',
        tokens: [{ tokenAccount: dustAta, mint: dustMint, amount: '4000000', decimals: 6 }],
      }),
    });
    assert.equal(jup502.status, 502);
    failJupiter = false;

    failRpc = true;
    const rpc503 = await fetch(`${base}/api/solana/dust-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerAddress: SOL_USER_A }),
    });
    assert.equal(rpc503.status, 503);
    const rpc503Json = (await rpc503.json()) as { rpcUnavailable?: boolean };
    assert.equal(rpc503Json.rpcUnavailable, true);
  } finally {
    globalThis.fetch = origFetch;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
