import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  SOLANA_TOKEN_PROGRAM_ID,
  solanaAddressToBytes32,
} from './cctp.js';
import { redactRpcUrl } from '../scanner/rpc.js';

export const SOLANA_TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);

export const ALLOWED_SOLANA_TOKEN_PROGRAM_IDS = new Set<string>([
  SOLANA_TOKEN_PROGRAM_ID.toBase58(),
  SOLANA_TOKEN_2022_PROGRAM_ID.toBase58(),
]);

// Canonical rent-exempt minimum for a standard 165-byte SPL Token Account
export const SOLANA_EMPTY_ATA_RENT_LAMPORTS = 2_039_280;
export const SOLANA_EMPTY_ATA_RENT_SOL = 0.00203928;
export const MAX_CLOSE_ACCOUNTS_PER_TX = 20;
export const DEFAULT_CLOSE_ATA_PRIORITY_FEE_MICRO_LAMPORTS = 5_000;
export const SOLANA_MAX_PACKET_BYTES = 1_232;
export const DEFAULT_FALLBACK_SOL_PRICE_USD = 150;

// SPL Token & Token-2022 CloseAccount instruction index = 9
const SPL_CLOSE_ACCOUNT_INSTRUCTION_INDEX = 9;

const DEFAULT_SOLANA_RPC_URLS = [
  process.env.SOLANA_RPC_URL?.trim(),
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
].filter((u): u is string => Boolean(u));

export type SolanaTokenProgramKind = 'spl-token' | 'token-2022';

export interface ReclaimableSolanaTokenAccount {
  tokenAccount: string;
  mint: string;
  owner: string;
  programId: string;
  programKind: SolanaTokenProgramKind;
  amount: string;
  uiAmount: number;
  decimals: number;
  state: string;
  frozen: boolean;
  closeable: boolean;
  closeAuthority: string | null;
  rentLamports: number;
  rentSol: number;
}

export interface SerializableCloseInstruction {
  name: string;
  programId: string;
  keys: Array<{
    name: string;
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  dataBase64: string;
  dataHex: string;
}

export interface CloseEmptyAtasTxResult {
  version: 0;
  ownerAddress: string;
  destination: string;
  authority: string;
  recentBlockhash: string;
  accountCount: number;
  closedAccounts: string[];
  reclaimedLamports: number;
  reclaimedSol: number;
  computeUnitLimit: number | null;
  computeUnitPriceMicroLamports: number | null;
  serializedByteLength: number;
  instructions: SerializableCloseInstruction[];
  serializedTransactionBase64: string;
  serializedMessageBase64: string;
}

export interface BuildCloseEmptyAtasOptions {
  includeComputeBudget?: boolean;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
  maxAccountsPerTx?: number;
  addressLookupTableAccounts?: AddressLookupTableAccount[];
}

export interface ScanReclaimableSolanaRentOptions {
  rpcUrls?: string[];
  timeoutMs?: number;
  solPriceUsd?: number;
  skipPriceFetch?: boolean;
  includeUnsignedTx?: boolean;
  recentBlockhash?: string | null;
  computeUnitPriceMicroLamports?: number;
  maxAccountsPerTx?: number;
}

export interface SolanaRentScanResult {
  ownerAddress: string;
  scannedPrograms: string[];
  totalTokenAccountsScanned: number;
  reclaimableCount: number;
  skippedNonZeroCount: number;
  skippedFrozenCount: number;
  skippedUncloseableCount: number;
  rentPerEmptyAccountSol: number;
  reclaimableLamports: number;
  reclaimableSol: number;
  solPriceUsd: number;
  solPriceSource: 'explicit' | 'live' | 'fallback';
  reclaimableUsd: number;
  maxAccountsPerTx: number;
  batchesRequired: number;
  reclaimableAccounts: ReclaimableSolanaTokenAccount[];
  unsignedCloseTx: CloseEmptyAtasTxResult | null;
  txBuildWarning: string | null;
}

interface RawParsedTokenAccountEntry {
  pubkey?: string;
  account?: {
    lamports?: number;
    owner?: string;
    data?: {
      program?: string;
      parsed?: {
        type?: string;
        info?: {
          mint?: string;
          owner?: string;
          state?: string;
          closeAuthority?: string | null;
          isNative?: boolean;
          tokenAmount?: {
            amount?: string;
            decimals?: number;
            uiAmount?: number | null;
            uiAmountString?: string;
          };
          extensions?: Array<{
            extension?: string;
            state?: Record<string, unknown>;
          }>;
        };
      };
    };
  };
}

function round8(val: number): number {
  return Number(val.toFixed(8));
}

function round2(val: number): number {
  return Number(val.toFixed(2));
}

function validateSolanaOwner(ownerAddress: string, label = 'ownerAddress'): PublicKey {
  const clean = typeof ownerAddress === 'string' ? ownerAddress.trim() : '';
  if (!clean) {
    throw new Error(`${label} is required.`);
  }
  try {
    solanaAddressToBytes32(clean);
    return new PublicKey(clean);
  } catch (err) {
    throw new Error(
      `Invalid Solana ${label}: ${err instanceof Error ? err.message : 'expected valid base58 public key'}.`
    );
  }
}

function validateSolanaBlockhash(recentBlockhash: string): string {
  const clean = typeof recentBlockhash === 'string' ? recentBlockhash.trim() : '';
  if (!clean) {
    throw new Error('recentBlockhash is required to compile a Solana VersionedTransaction.');
  }
  try {
    // Solana blockhashes are 32-byte base58 hashes
    const parsed = new PublicKey(clean);
    if (parsed.toBytes().length !== 32) {
      throw new Error('Invalid blockhash byte length');
    }
  } catch {
    throw new Error(`Invalid Solana recentBlockhash: "${clean}".`);
  }
  return clean;
}

/**
 * Strictly validates that a token account is zero-balance, non-frozen, owner-controlled,
 * and uses either SPL Token or Token-2022 before allowing a `closeAccount` instruction.
 */
export function assertAccountSafeToClose(
  account: ReclaimableSolanaTokenAccount,
  ownerAddress: string
): {
  tokenAccountPubkey: PublicKey;
  programIdPubkey: PublicKey;
  rentLamports: number;
} {
  const ownerPubkey = validateSolanaOwner(ownerAddress, 'ownerAddress');
  const ownerClean = ownerPubkey.toBase58();

  if (!account || typeof account !== 'object') {
    throw new Error('Invalid token account entry.');
  }

  const tokenAccountClean = typeof account.tokenAccount === 'string' ? account.tokenAccount.trim() : '';
  if (!tokenAccountClean) {
    throw new Error('Token account pubkey is required.');
  }
  solanaAddressToBytes32(tokenAccountClean);
  const tokenAccountPubkey = new PublicKey(tokenAccountClean);
  if (tokenAccountPubkey.equals(ownerPubkey)) {
    throw new Error(`Refusing to close owner wallet address ${ownerClean} as a token account.`);
  }

  const programIdClean = typeof account.programId === 'string' ? account.programId.trim() : '';
  if (!ALLOWED_SOLANA_TOKEN_PROGRAM_IDS.has(programIdClean)) {
    throw new Error(
      `Unsupported token programId "${programIdClean}" for account ${tokenAccountClean}; only SPL Token and Token-2022 are allowed.`
    );
  }
  const programIdPubkey = new PublicKey(programIdClean);

  // Fail closed on owner mismatch
  if (typeof account.owner === 'string' && account.owner.trim() !== '' && account.owner.trim() !== ownerClean) {
    throw new Error(
      `Token account ${tokenAccountClean} owner (${account.owner}) does not match signer ${ownerClean}.`
    );
  }

  // Fail closed on foreign closeAuthority
  if (account.closeAuthority && account.closeAuthority.trim() !== ownerClean) {
    throw new Error(
      `Token account ${tokenAccountClean} has closeAuthority ${account.closeAuthority} != ${ownerClean}.`
    );
  }

  // Fail closed on frozen account
  const normalizedState = typeof account.state === 'string' ? account.state.trim().toLowerCase() : 'initialized';
  if (account.frozen === true || normalizedState === 'frozen') {
    throw new Error(`Refusing to close frozen token account ${tokenAccountClean}.`);
  }

  // Fail closed on explicit closeable=false flag
  if (account.closeable === false) {
    throw new Error(`Refusing to close non-closeable token account ${tokenAccountClean}.`);
  }

  // Fail closed on non-zero balance (check raw string, BigInt, AND uiAmount)
  const amountStr = typeof account.amount === 'string' ? account.amount.trim() : '';
  if (!/^\d+$/.test(amountStr)) {
    throw new Error(
      `Refusing to close token account ${tokenAccountClean}: invalid raw amount "${String(account.amount)}".`
    );
  }
  if (BigInt(amountStr) !== 0n) {
    throw new Error(
      `Refusing to close non-empty token account ${tokenAccountClean}: balance is ${amountStr} (must be strictly "0").`
    );
  }
  if (typeof account.uiAmount === 'number' && (!Number.isFinite(account.uiAmount) || account.uiAmount !== 0)) {
    throw new Error(
      `Refusing to close non-empty token account ${tokenAccountClean}: uiAmount is ${account.uiAmount} (must be 0).`
    );
  }

  const rentLamports =
    typeof account.rentLamports === 'number' &&
    Number.isInteger(account.rentLamports) &&
    account.rentLamports > 0
      ? account.rentLamports
      : SOLANA_EMPTY_ATA_RENT_LAMPORTS;

  return { tokenAccountPubkey, programIdPubkey, rentLamports };
}

/**
 * Builds a single verified SPL Token / Token-2022 `CloseAccount` instruction where
 * both `destination` and `authority` are locked strictly to `ownerAddress`.
 */
export function buildCloseTokenAccountInstruction(
  ownerAddress: string,
  account: ReclaimableSolanaTokenAccount
): {
  instruction: TransactionInstruction;
  serializable: SerializableCloseInstruction;
  rentLamports: number;
} {
  const ownerPubkey = validateSolanaOwner(ownerAddress, 'ownerAddress');
  const { tokenAccountPubkey, programIdPubkey, rentLamports } = assertAccountSafeToClose(
    account,
    ownerPubkey.toBase58()
  );

  const data = Buffer.from([SPL_CLOSE_ACCOUNT_INSTRUCTION_INDEX]);
  const keys = [
    { name: 'account', pubkey: tokenAccountPubkey.toBase58(), isSigner: false, isWritable: true },
    { name: 'destination', pubkey: ownerPubkey.toBase58(), isSigner: false, isWritable: true },
    { name: 'authority', pubkey: ownerPubkey.toBase58(), isSigner: true, isWritable: false },
  ];

  const instruction = new TransactionInstruction({
    programId: programIdPubkey,
    keys: [
      { pubkey: tokenAccountPubkey, isSigner: false, isWritable: true },
      { pubkey: ownerPubkey, isSigner: false, isWritable: true },
      { pubkey: ownerPubkey, isSigner: true, isWritable: false },
    ],
    data,
  });

  const serializable: SerializableCloseInstruction = {
    name: 'closeAccount',
    programId: programIdPubkey.toBase58(),
    keys,
    dataBase64: data.toString('base64'),
    dataHex: '0x' + data.toString('hex'),
  };

  return { instruction, serializable, rentLamports };
}

/**
 * Builds a safe Solana `VersionedTransaction` (`MessageV0`) containing ONLY verified
 * `closeAccount` instructions (`destination === owner`, `authority === owner`, max 20 closes per tx,
 * fail-closed rejection if any account has `amount > 0` or is frozen) plus optional `ComputeBudget`
 * instructions.
 */
export function buildCloseEmptyAtasVersionedTx(
  ownerAddress: string,
  accountsToClose: ReclaimableSolanaTokenAccount[],
  recentBlockhash: string,
  opts: BuildCloseEmptyAtasOptions = {}
): CloseEmptyAtasTxResult {
  const ownerPubkey = validateSolanaOwner(ownerAddress, 'ownerAddress');
  const ownerClean = ownerPubkey.toBase58();
  const blockhashClean = validateSolanaBlockhash(recentBlockhash);

  if (!Array.isArray(accountsToClose) || accountsToClose.length === 0) {
    throw new Error('At least one empty token account is required to build a close transaction.');
  }

  const maxPerTx = opts.maxAccountsPerTx ?? MAX_CLOSE_ACCOUNTS_PER_TX;
  if (!Number.isInteger(maxPerTx) || maxPerTx < 1 || maxPerTx > MAX_CLOSE_ACCOUNTS_PER_TX) {
    throw new Error(
      `maxAccountsPerTx must be an integer between 1 and ${MAX_CLOSE_ACCOUNTS_PER_TX}.`
    );
  }
  if (accountsToClose.length > maxPerTx) {
    throw new Error(
      `Cannot close ${accountsToClose.length} accounts in a single transaction (max ${maxPerTx} per tx).`
    );
  }

  const includeComputeBudget = opts.includeComputeBudget !== false;
  const computeUnitLimit = includeComputeBudget
    ? opts.computeUnitLimit ?? Math.min(200_000, 15_000 + accountsToClose.length * 8_000)
    : null;
  const computeUnitPriceMicroLamports = includeComputeBudget
    ? opts.computeUnitPriceMicroLamports ?? DEFAULT_CLOSE_ATA_PRIORITY_FEE_MICRO_LAMPORTS
    : null;

  if (
    computeUnitLimit !== null &&
    (!Number.isInteger(computeUnitLimit) || computeUnitLimit < 1_000 || computeUnitLimit > 1_400_000)
  ) {
    throw new Error('computeUnitLimit must be an integer between 1,000 and 1,400,000.');
  }
  if (
    computeUnitPriceMicroLamports !== null &&
    (!Number.isInteger(computeUnitPriceMicroLamports) ||
      computeUnitPriceMicroLamports < 0 ||
      computeUnitPriceMicroLamports > 10_000_000)
  ) {
    throw new Error('computeUnitPriceMicroLamports must be an integer between 0 and 10,000,000.');
  }

  const seenAccounts = new Set<string>();
  const web3Instructions: TransactionInstruction[] = [];
  const serializableInstructions: SerializableCloseInstruction[] = [];

  if (includeComputeBudget && computeUnitLimit !== null && computeUnitPriceMicroLamports !== null) {
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit });
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: computeUnitPriceMicroLamports,
    });
    web3Instructions.push(cuLimitIx, cuPriceIx);
    serializableInstructions.push(
      {
        name: 'setComputeUnitLimit',
        programId: ComputeBudgetProgram.programId.toBase58(),
        keys: [],
        dataBase64: Buffer.from(cuLimitIx.data).toString('base64'),
        dataHex: '0x' + Buffer.from(cuLimitIx.data).toString('hex'),
      },
      {
        name: 'setComputeUnitPrice',
        programId: ComputeBudgetProgram.programId.toBase58(),
        keys: [],
        dataBase64: Buffer.from(cuPriceIx.data).toString('base64'),
        dataHex: '0x' + Buffer.from(cuPriceIx.data).toString('hex'),
      }
    );
  }

  let reclaimedLamports = 0;
  const closedAccounts: string[] = [];

  for (const account of accountsToClose) {
    const { instruction, serializable, rentLamports } = buildCloseTokenAccountInstruction(
      ownerClean,
      account
    );
    const keyStr = account.tokenAccount.trim();
    if (seenAccounts.has(keyStr)) {
      throw new Error(`Duplicate token account in close batch: ${keyStr}.`);
    }
    seenAccounts.add(keyStr);
    closedAccounts.push(keyStr);
    reclaimedLamports += rentLamports;
    web3Instructions.push(instruction);
    serializableInstructions.push(serializable);
  }

  const messageV0 = new TransactionMessage({
    payerKey: ownerPubkey,
    recentBlockhash: blockhashClean,
    instructions: web3Instructions,
  }).compileToV0Message(opts.addressLookupTableAccounts ?? []);

  const versionedTx = new VersionedTransaction(messageV0);
  const serializedTxBytes = Buffer.from(versionedTx.serialize());
  if (serializedTxBytes.length > SOLANA_MAX_PACKET_BYTES) {
    throw new Error(
      `Compiled V0 close transaction exceeds Solana's ${SOLANA_MAX_PACKET_BYTES}-byte packet limit (${serializedTxBytes.length} bytes). Reduce accounts per batch or supply an Address Lookup Table.`
    );
  }

  const serializedMessageBytes = Buffer.from(messageV0.serialize());

  return {
    version: 0,
    ownerAddress: ownerClean,
    destination: ownerClean,
    authority: ownerClean,
    recentBlockhash: blockhashClean,
    accountCount: closedAccounts.length,
    closedAccounts,
    reclaimedLamports,
    reclaimedSol: round8(reclaimedLamports / 1_000_000_000),
    computeUnitLimit,
    computeUnitPriceMicroLamports,
    serializedByteLength: serializedTxBytes.length,
    instructions: serializableInstructions,
    serializedTransactionBase64: serializedTxBytes.toString('base64'),
    serializedMessageBase64: serializedMessageBytes.toString('base64'),
  };
}

function hasBlockingToken2022Extension(
  extensions: Array<{ extension?: string; state?: Record<string, unknown> }> | undefined
): boolean {
  if (!Array.isArray(extensions) || extensions.length === 0) return false;
  for (const ext of extensions) {
    if (!ext || typeof ext !== 'object') continue;
    const extName = String(ext.extension ?? '').toLowerCase();
    // TransferFeeAmount with non-zero withheldAmount cannot be closed until harvested
    if (extName === 'transferfeeamount') {
      const withheld = ext.state?.withheldAmount;
      if (withheld !== undefined && withheld !== null) {
        try {
          if (BigInt(String(withheld)) > 0n) return true;
        } catch {
          return true;
        }
      }
    }
    // ConfidentialTransferAccount / ConfidentialTransferFeeAmount cannot be closed blindly
    if (extName === 'confidentialtransferaccount' || extName === 'confidentialtransferfeeamount') {
      return true;
    }
  }
  return false;
}

async function fetchSolanaRpc<T>(
  method: string,
  params: unknown[],
  rpcUrls: string[],
  timeoutMs: number
): Promise<T> {
  let lastError: Error | null = null;
  for (const rpcUrl of rpcUrls) {
    const safeUrl = redactRpcUrl(rpcUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastError = new Error(`Solana RPC HTTP ${res.status} from ${safeUrl}`);
        continue;
      }
      const json = (await res.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };
      if (json.error) {
        const msg = json.error.message
          ? json.error.message.split(rpcUrl).join(safeUrl)
          : `Solana RPC error ${json.error.code ?? ''}`;
        lastError = new Error(msg);
        continue;
      }
      if (json.result !== undefined) {
        return json.result;
      }
      lastError = new Error(`Solana RPC returned empty result for ${method}`);
    } catch (err) {
      clearTimeout(timer);
      const rawMsg = err instanceof Error ? err.message : String(err);
      lastError = new Error(rawMsg.split(rpcUrl).join(safeUrl));
    }
  }
  throw lastError ?? new Error(`All Solana RPC endpoints failed for ${method}.`);
}

async function fetchSolPriceUsd(timeoutMs: number): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://coins.llama.fi/prices/current/coingecko:solana', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      coins?: Record<string, { price?: number }>;
    };
    const price = json.coins?.['coingecko:solana']?.price;
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      return price;
    }
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function fetchBlockhashForRent(rpcUrls: string[], timeoutMs: number): Promise<string | null> {
  try {
    const result = await fetchSolanaRpc<{ value?: { blockhash?: string } }>(
      'getLatestBlockhash',
      [{ commitment: 'finalized' }],
      rpcUrls,
      timeoutMs
    );
    const bh = result?.value?.blockhash?.trim();
    return bh || null;
  } catch {
    return null;
  }
}

/**
 * Queries Solana RPC `getTokenAccountsByOwner` for BOTH SPL Token
 * (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) and Token-2022
 * (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), identifies strictly zero-balance
 * (`amount === "0"`), non-frozen, closeable token accounts, and calculates exact
 * reclaimable SOL (`0.00203928 SOL` per standard empty account) + USD value.
 */
export async function scanReclaimableSolanaRent(
  ownerAddress: string,
  opts: ScanReclaimableSolanaRentOptions = {}
): Promise<SolanaRentScanResult> {
  const ownerPubkey = validateSolanaOwner(ownerAddress, 'ownerAddress');
  const ownerClean = ownerPubkey.toBase58();

  const rpcUrls =
    Array.isArray(opts.rpcUrls) && opts.rpcUrls.length > 0
      ? opts.rpcUrls
      : DEFAULT_SOLANA_RPC_URLS;
  const timeoutMs = opts.timeoutMs ?? 4_500;
  const maxAccountsPerTx = opts.maxAccountsPerTx ?? MAX_CLOSE_ACCOUNTS_PER_TX;
  if (!Number.isInteger(maxAccountsPerTx) || maxAccountsPerTx < 1 || maxAccountsPerTx > MAX_CLOSE_ACCOUNTS_PER_TX) {
    throw new Error(
      `maxAccountsPerTx must be an integer between 1 and ${MAX_CLOSE_ACCOUNTS_PER_TX}.`
    );
  }

  // Validate all caller-provided options BEFORE issuing any upstream RPC requests
  if (opts.solPriceUsd !== undefined) {
    if (typeof opts.solPriceUsd !== 'number' || !Number.isFinite(opts.solPriceUsd) || opts.solPriceUsd <= 0) {
      throw new Error('solPriceUsd must be a finite positive number.');
    }
  }
  if (opts.recentBlockhash !== undefined && opts.recentBlockhash !== null && opts.recentBlockhash !== '') {
    validateSolanaBlockhash(opts.recentBlockhash);
  }
  if (opts.computeUnitPriceMicroLamports !== undefined) {
    if (
      typeof opts.computeUnitPriceMicroLamports !== 'number' ||
      !Number.isInteger(opts.computeUnitPriceMicroLamports) ||
      opts.computeUnitPriceMicroLamports < 0 ||
      opts.computeUnitPriceMicroLamports > 10_000_000
    ) {
      throw new Error('computeUnitPriceMicroLamports must be an integer between 0 and 10,000,000.');
    }
  }

  const programsToScan: Array<{ id: string; kind: SolanaTokenProgramKind }> = [
    { id: SOLANA_TOKEN_PROGRAM_ID.toBase58(), kind: 'spl-token' },
    { id: SOLANA_TOKEN_2022_PROGRAM_ID.toBase58(), kind: 'token-2022' },
  ];

  const [splResult, token2022Result, fetchedSolPrice] = await Promise.all([
    fetchSolanaRpc<{ value?: RawParsedTokenAccountEntry[] }>(
      'getTokenAccountsByOwner',
      [ownerClean, { programId: programsToScan[0].id }, { encoding: 'jsonParsed' }],
      rpcUrls,
      timeoutMs
    ),
    fetchSolanaRpc<{ value?: RawParsedTokenAccountEntry[] }>(
      'getTokenAccountsByOwner',
      [ownerClean, { programId: programsToScan[1].id }, { encoding: 'jsonParsed' }],
      rpcUrls,
      timeoutMs
    ).catch(() => ({ value: [] as RawParsedTokenAccountEntry[] })),
    opts.solPriceUsd !== undefined || opts.skipPriceFetch
      ? Promise.resolve<number | null>(null)
      : fetchSolPriceUsd(Math.min(timeoutMs, 2_500)),
  ]);

  let solPriceUsd: number;
  let solPriceSource: 'explicit' | 'live' | 'fallback';
  if (opts.solPriceUsd !== undefined) {
    if (!Number.isFinite(opts.solPriceUsd) || opts.solPriceUsd <= 0) {
      throw new Error('solPriceUsd must be a finite positive number.');
    }
    solPriceUsd = opts.solPriceUsd;
    solPriceSource = 'explicit';
  } else if (fetchedSolPrice !== null) {
    solPriceUsd = fetchedSolPrice;
    solPriceSource = 'live';
  } else {
    solPriceUsd = DEFAULT_FALLBACK_SOL_PRICE_USD;
    solPriceSource = 'fallback';
  }

  const combined: Array<{
    entry: RawParsedTokenAccountEntry;
    programId: string;
    programKind: SolanaTokenProgramKind;
  }> = [
    ...(Array.isArray(splResult?.value) ? splResult.value : []).map((entry) => ({
      entry,
      programId: programsToScan[0].id,
      programKind: programsToScan[0].kind,
    })),
    ...(Array.isArray(token2022Result?.value) ? token2022Result.value : []).map((entry) => ({
      entry,
      programId: programsToScan[1].id,
      programKind: programsToScan[1].kind,
    })),
  ];

  const seen = new Set<string>();
  const reclaimableAccounts: ReclaimableSolanaTokenAccount[] = [];
  let totalTokenAccountsScanned = 0;
  let skippedNonZeroCount = 0;
  let skippedFrozenCount = 0;
  let skippedUncloseableCount = 0;

  for (const { entry, programId, programKind } of combined) {
    const pubkeyStr = typeof entry?.pubkey === 'string' ? entry.pubkey.trim() : '';
    if (!pubkeyStr || seen.has(pubkeyStr)) continue;
    seen.add(pubkeyStr);
    totalTokenAccountsScanned += 1;

    // Verify pubkey is valid non-zero base58 and not owner wallet itself
    try {
      solanaAddressToBytes32(pubkeyStr);
      if (pubkeyStr === ownerClean) {
        skippedUncloseableCount += 1;
        continue;
      }
    } catch {
      skippedUncloseableCount += 1;
      continue;
    }

    const info = entry.account?.data?.parsed?.info;
    const tokenAmount = info?.tokenAmount;
    if (!info || !tokenAmount) {
      skippedUncloseableCount += 1;
      continue;
    }

    const rawAmount = typeof tokenAmount.amount === 'string' ? tokenAmount.amount.trim() : '';
    const uiAmount = typeof tokenAmount.uiAmount === 'number' ? tokenAmount.uiAmount : Number(tokenAmount.uiAmountString ?? '0');
    const decimals = typeof tokenAmount.decimals === 'number' && Number.isInteger(tokenAmount.decimals)
      ? tokenAmount.decimals
      : 0;
    const stateStr = typeof info.state === 'string' ? info.state.trim().toLowerCase() : 'initialized';
    const isFrozen = stateStr === 'frozen';

    // Strictly reject non-zero balances
    if (!/^\d+$/.test(rawAmount) || BigInt(rawAmount) !== 0n || (Number.isFinite(uiAmount) && uiAmount !== 0)) {
      skippedNonZeroCount += 1;
      continue;
    }

    // Strictly reject frozen accounts
    if (isFrozen) {
      skippedFrozenCount += 1;
      continue;
    }

    // Account must be initialized, owned by ownerClean, and without a foreign closeAuthority
    if (stateStr !== 'initialized') {
      skippedUncloseableCount += 1;
      continue;
    }
    const accountOwner = typeof info.owner === 'string' ? info.owner.trim() : '';
    if (!accountOwner || accountOwner !== ownerClean) {
      skippedUncloseableCount += 1;
      continue;
    }
    const closeAuthority =
      typeof info.closeAuthority === 'string' && info.closeAuthority.trim()
        ? info.closeAuthority.trim()
        : null;
    if (closeAuthority && closeAuthority !== ownerClean) {
      skippedUncloseableCount += 1;
      continue;
    }

    // Skip Token-2022 accounts with withheld transfer fees or confidential balances
    if (programKind === 'token-2022' && hasBlockingToken2022Extension(info.extensions)) {
      skippedUncloseableCount += 1;
      continue;
    }

    const rawLamports = entry.account?.lamports;
    const rentLamports =
      typeof rawLamports === 'number' && Number.isInteger(rawLamports) && rawLamports > 0
        ? rawLamports
        : SOLANA_EMPTY_ATA_RENT_LAMPORTS;

    const mint = typeof info.mint === 'string' ? info.mint.trim() : '';
    reclaimableAccounts.push({
      tokenAccount: pubkeyStr,
      mint,
      owner: ownerClean,
      programId,
      programKind,
      amount: '0',
      uiAmount: 0,
      decimals,
      state: 'initialized',
      frozen: false,
      closeable: true,
      closeAuthority,
      rentLamports,
      rentSol: round8(rentLamports / 1_000_000_000),
    });
  }

  const reclaimableLamports = reclaimableAccounts.reduce((sum, acc) => sum + acc.rentLamports, 0);
  const reclaimableSol = round8(reclaimableLamports / 1_000_000_000);
  const reclaimableUsd = round2(reclaimableSol * solPriceUsd);
  const batchesRequired =
    reclaimableAccounts.length > 0 ? Math.ceil(reclaimableAccounts.length / maxAccountsPerTx) : 0;

  let unsignedCloseTx: CloseEmptyAtasTxResult | null = null;
  let txBuildWarning: string | null = null;

  if (opts.includeUnsignedTx && reclaimableAccounts.length > 0) {
    const batch = reclaimableAccounts.slice(0, maxAccountsPerTx);
    const blockhash =
      opts.recentBlockhash?.trim() || (await fetchBlockhashForRent(rpcUrls, timeoutMs));
    if (blockhash) {
      unsignedCloseTx = buildCloseEmptyAtasVersionedTx(ownerClean, batch, blockhash, {
        computeUnitPriceMicroLamports: opts.computeUnitPriceMicroLamports,
        maxAccountsPerTx,
      });
    } else {
      txBuildWarning =
        'Unable to fetch finalized Solana blockhash from RPC; retry with recentBlockhash to compile unsigned close tx.';
    }
  }

  return {
    ownerAddress: ownerClean,
    scannedPrograms: programsToScan.map((p) => p.id),
    totalTokenAccountsScanned,
    reclaimableCount: reclaimableAccounts.length,
    skippedNonZeroCount,
    skippedFrozenCount,
    skippedUncloseableCount,
    rentPerEmptyAccountSol: SOLANA_EMPTY_ATA_RENT_SOL,
    reclaimableLamports,
    reclaimableSol,
    solPriceUsd: round2(solPriceUsd),
    solPriceSource,
    reclaimableUsd,
    maxAccountsPerTx,
    batchesRequired,
    reclaimableAccounts,
    unsignedCloseTx,
    txBuildWarning,
  };
}
