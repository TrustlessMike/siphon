import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { SOLANA_CCTP_DOMAIN } from '../scanner/chains.js';
import {
  deriveSolanaUsdcAta,
  getSolanaCctpPrograms,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
  SOLANA_TOKEN_PROGRAM_ID,
  SOLANA_USDC_MINT_PUBKEY,
  solanaAddressToBytes32,
  solanaOwnerToUsdcAtaBytes32,
} from './cctp.js';

const ZERO_BYTES32 = '0x' + '00'.repeat(32);
const CCTP_V1_NONCES_PER_ACCOUNT = 6400n;

// Anchor discriminator: sha256("global:receive_message")[0..8]
const RECEIVE_MESSAGE_DISCRIMINATOR = crypto
  .createHash('sha256')
  .update('global:receive_message')
  .digest()
  .subarray(0, 8);

const SOLANA_RPC_URLS = [
  process.env.SOLANA_RPC_URL?.trim(),
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
].filter((u): u is string => Boolean(u));

export interface DecodedCctpBurnMessage {
  version: number;
  burnTokenBytes32: string;
  mintRecipientBytes32: string;
  amountRaw: string;
  amountUsdc: number;
  messageSenderBytes32: string;
  maxFeeRaw?: string;
  feeExecutedRaw?: string;
  expirationBlock?: string;
}

export interface DecodedCctpMessage {
  cctpVersion: 1 | 2;
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: string;
  nonceBytes32Hex?: string;
  senderBytes32: string;
  recipientBytes32: string;
  destinationCallerBytes32: string;
  minFinalityThreshold?: number;
  finalityThresholdExecuted?: number;
  messageBodyHex: string;
  burnMessage: DecodedCctpBurnMessage;
  messageHash: string;
  messageBytesHex: string;
}

export interface SolanaCctpClaimPdas {
  messageTransmitter: string;
  tokenMessenger: string;
  remoteTokenMessenger: string;
  tokenMinter: string;
  localToken: string;
  tokenPair: string;
  custodyTokenAccount: string;
  usedNonces: string;
  authorityPda: string;
  messageTransmitterEventAuthority: string;
  tokenMessengerEventAuthority: string;
  recipientUsdcAta: string;
}

export interface SerializableSolanaAccountMeta {
  name: string;
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface SerializableSolanaInstruction {
  name: string;
  programId: string;
  keys: SerializableSolanaAccountMeta[];
  dataBase64: string;
  dataHex: string;
}

export interface SolanaCctpClaimPlan {
  planVersion: 'siphon-solana-cctp-claim-v1';
  cctpVersion: 1 | 2;
  messageHash: string;
  decodedMessage: DecodedCctpMessage;
  solanaDestination: string;
  payer: string;
  recipientUsdcAta: string;
  expectedMintRecipientBytes32: string;
  mintRecipientVerified: true;
  amountUsdc: number;
  amountRaw: string;
  programs: {
    messageTransmitter: string;
    tokenMessengerMinter: string;
    tokenProgram: string;
    associatedTokenProgram: string;
    systemProgram: string;
    usdcMint: string;
  };
  pdas: SolanaCctpClaimPdas;
  instructions: SerializableSolanaInstruction[];
  recentBlockhash: string | null;
  serializedTransactionBase64: string | null;
  serializedMessageBase64: string | null;
  claimSummary: string;
  fallbackInstructions: string[];
}

export interface BuildSolanaCctpClaimParams {
  messageBytesHex: string;
  attestationHex: string;
  solanaDestination: string;
  payer?: string;
  includeCreateAta?: boolean;
  recentBlockhash?: string | null;
}

function cleanHexBytes(hex: string, label: string): Buffer {
  if (typeof hex !== 'string') {
    throw new Error(`${label} must be a 0x-prefixed hex string.`);
  }
  const trimmed = hex.trim();
  const body = trimmed.startsWith('0x') || trimmed.startsWith('0X') ? trimmed.slice(2) : trimmed;
  if (!body || body.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error(`Invalid ${label}: expected non-empty even-length hex string.`);
  }
  return Buffer.from(body, 'hex');
}

function readUint256BE(buf: Buffer, offset: number): bigint {
  return BigInt('0x' + buf.subarray(offset, offset + 32).toString('hex'));
}

function toBytes32Hex(buf: Buffer, offset: number): string {
  return '0x' + buf.subarray(offset, offset + 32).toString('hex').toLowerCase();
}

function encodeBorshVecU8(bytes: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/**
 * Decodes a Circle CCTP V1 (`version === 0`) or V2 (`version === 1`) `MessageSent` payload
 * including its inner BurnMessage fields (`burnToken`, `mintRecipient`, `amount`, `messageSender`).
 */
export function decodeCctpMessage(messageBytesHex: string): DecodedCctpMessage {
  const buf = cleanHexBytes(messageBytesHex, 'messageBytesHex');
  if (buf.length < 116) {
    throw new Error(`CCTP message too short (${buf.length} bytes; minimum header is 116 bytes).`);
  }

  const version = buf.readUInt32BE(0);
  const sourceDomain = buf.readUInt32BE(4);
  const destinationDomain = buf.readUInt32BE(8);

  const hashBytes = keccak_256(buf);
  const messageHash = '0x' + Buffer.from(hashBytes).toString('hex');
  const normalizedMessageHex = '0x' + buf.toString('hex').toLowerCase();

  if (version === 0) {
    // Circle CCTP V1: 116-byte header + >=132-byte BurnMessage
    if (buf.length < 116 + 132) {
      throw new Error(
        `CCTP V1 message too short (${buf.length} bytes; expected >= 248 bytes including BurnMessage).`
      );
    }
    const nonce = buf.readBigUInt64BE(12).toString();
    const senderBytes32 = toBytes32Hex(buf, 20);
    const recipientBytes32 = toBytes32Hex(buf, 52);
    const destinationCallerBytes32 = toBytes32Hex(buf, 84);
    const body = buf.subarray(116);

    const burnVersion = body.readUInt32BE(0);
    if (burnVersion !== 0) {
      throw new Error(`Unexpected CCTP V1 BurnMessage version: ${burnVersion} (expected 0).`);
    }
    const burnTokenBytes32 = toBytes32Hex(body, 4);
    const mintRecipientBytes32 = toBytes32Hex(body, 36);
    const amountRawBig = readUint256BE(body, 68);
    const messageSenderBytes32 = toBytes32Hex(body, 100);

    return {
      cctpVersion: 1,
      version,
      sourceDomain,
      destinationDomain,
      nonce,
      senderBytes32,
      recipientBytes32,
      destinationCallerBytes32,
      messageBodyHex: '0x' + body.toString('hex').toLowerCase(),
      burnMessage: {
        version: burnVersion,
        burnTokenBytes32,
        mintRecipientBytes32,
        amountRaw: amountRawBig.toString(),
        amountUsdc: Number((Number(amountRawBig) / 1_000_000).toFixed(6)),
        messageSenderBytes32,
      },
      messageHash,
      messageBytesHex: normalizedMessageHex,
    };
  }

  if (version === 1) {
    // Circle CCTP V2: 148-byte header + >=228-byte BurnMessageV2
    if (buf.length < 148 + 228) {
      throw new Error(
        `CCTP V2 message too short (${buf.length} bytes; expected >= 376 bytes including BurnMessageV2).`
      );
    }
    const nonceBytes32Hex = toBytes32Hex(buf, 12);
    const senderBytes32 = toBytes32Hex(buf, 44);
    const recipientBytes32 = toBytes32Hex(buf, 76);
    const destinationCallerBytes32 = toBytes32Hex(buf, 108);
    const minFinalityThreshold = buf.readUInt32BE(140);
    const finalityThresholdExecuted = buf.readUInt32BE(144);
    const body = buf.subarray(148);

    const burnVersion = body.readUInt32BE(0);
    if (burnVersion !== 1) {
      throw new Error(`Unexpected CCTP V2 BurnMessage version: ${burnVersion} (expected 1).`);
    }
    const burnTokenBytes32 = toBytes32Hex(body, 4);
    const mintRecipientBytes32 = toBytes32Hex(body, 36);
    const amountRawBig = readUint256BE(body, 68);
    const messageSenderBytes32 = toBytes32Hex(body, 100);
    const maxFeeRaw = readUint256BE(body, 132).toString();
    const feeExecutedRaw = readUint256BE(body, 164).toString();
    const expirationBlock = readUint256BE(body, 196).toString();

    return {
      cctpVersion: 2,
      version,
      sourceDomain,
      destinationDomain,
      nonce: nonceBytes32Hex,
      nonceBytes32Hex,
      senderBytes32,
      recipientBytes32,
      destinationCallerBytes32,
      minFinalityThreshold,
      finalityThresholdExecuted,
      messageBodyHex: '0x' + body.toString('hex').toLowerCase(),
      burnMessage: {
        version: burnVersion,
        burnTokenBytes32,
        mintRecipientBytes32,
        amountRaw: amountRawBig.toString(),
        amountUsdc: Number((Number(amountRawBig) / 1_000_000).toFixed(6)),
        messageSenderBytes32,
        maxFeeRaw,
        feeExecutedRaw,
        expirationBlock,
      },
      messageHash,
      messageBytesHex: normalizedMessageHex,
    };
  }

  throw new Error(`Unsupported Circle CCTP message version: ${version} (expected 0 for V1 or 1 for V2).`);
}

/**
 * Derives all deterministic Circle CCTP Solana PDAs using `PublicKey.findProgramAddressSync`.
 */
export function deriveSolanaCctpClaimPdas(params: {
  cctpVersion: 1 | 2;
  sourceDomain: number;
  nonce: string;
  nonceBytes32Hex?: string;
  burnTokenBytes32: string;
  solanaDestination: string;
}): SolanaCctpClaimPdas {
  const programs = getSolanaCctpPrograms(params.cctpVersion);
  const messageTransmitterProgramId = new PublicKey(programs.messageTransmitter);
  const tokenMessengerMinterProgramId = new PublicKey(programs.tokenMessengerMinter);
  const sourceDomainBuf = Buffer.from(String(params.sourceDomain), 'utf8');
  const burnTokenBuf = cleanHexBytes(params.burnTokenBytes32, 'burnTokenBytes32');
  if (burnTokenBuf.length !== 32) {
    throw new Error('burnTokenBytes32 must be exactly 32 bytes.');
  }

  const [messageTransmitter] = PublicKey.findProgramAddressSync(
    [Buffer.from('message_transmitter')],
    messageTransmitterProgramId
  );
  const [authorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('message_transmitter_authority'), tokenMessengerMinterProgramId.toBytes()],
    messageTransmitterProgramId
  );
  const [messageTransmitterEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    messageTransmitterProgramId
  );

  let usedNonces: PublicKey;
  if (params.cctpVersion === 2) {
    const nonceBuf = cleanHexBytes(params.nonceBytes32Hex ?? params.nonce, 'nonceBytes32Hex');
    if (nonceBuf.length !== 32) {
      throw new Error('CCTP V2 nonce must be 32 bytes.');
    }
    [usedNonces] = PublicKey.findProgramAddressSync(
      [Buffer.from('used_nonce'), nonceBuf],
      messageTransmitterProgramId
    );
  } else {
    const nonceBig = BigInt(params.nonce);
    const firstNonce =
      nonceBig === 0n ? 0n : ((nonceBig - 1n) / CCTP_V1_NONCES_PER_ACCOUNT) * CCTP_V1_NONCES_PER_ACCOUNT + 1n;
    [usedNonces] = PublicKey.findProgramAddressSync(
      [Buffer.from('used_nonces'), sourceDomainBuf, Buffer.from(firstNonce.toString(), 'utf8')],
      messageTransmitterProgramId
    );
  }

  const [tokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_messenger')],
    tokenMessengerMinterProgramId
  );
  const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from('remote_token_messenger'), sourceDomainBuf],
    tokenMessengerMinterProgramId
  );
  const [tokenMinter] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_minter')],
    tokenMessengerMinterProgramId
  );
  const [localToken] = PublicKey.findProgramAddressSync(
    [Buffer.from('local_token'), SOLANA_USDC_MINT_PUBKEY.toBytes()],
    tokenMessengerMinterProgramId
  );
  const [tokenPair] = PublicKey.findProgramAddressSync(
    [Buffer.from('token_pair'), sourceDomainBuf, burnTokenBuf],
    tokenMessengerMinterProgramId
  );
  const [custodyTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('custody'), SOLANA_USDC_MINT_PUBKEY.toBytes()],
    tokenMessengerMinterProgramId
  );
  const [tokenMessengerEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    tokenMessengerMinterProgramId
  );
  const recipientUsdcAta = deriveSolanaUsdcAta(params.solanaDestination);

  return {
    messageTransmitter: messageTransmitter.toBase58(),
    tokenMessenger: tokenMessenger.toBase58(),
    remoteTokenMessenger: remoteTokenMessenger.toBase58(),
    tokenMinter: tokenMinter.toBase58(),
    localToken: localToken.toBase58(),
    tokenPair: tokenPair.toBase58(),
    custodyTokenAccount: custodyTokenAccount.toBase58(),
    usedNonces: usedNonces.toBase58(),
    authorityPda: authorityPda.toBase58(),
    messageTransmitterEventAuthority: messageTransmitterEventAuthority.toBase58(),
    tokenMessengerEventAuthority: tokenMessengerEventAuthority.toBase58(),
    recipientUsdcAta: recipientUsdcAta.toBase58(),
  };
}

/**
 * Fetches a fresh finalized Solana blockhash for compiling a ready-to-sign claim transaction.
 * Returns null if public RPCs are temporarily unreachable (the instruction plan remains usable).
 */
export async function fetchLatestSolanaBlockhash(timeoutMs = 4200): Promise<string | null> {
  for (const rpcUrl of SOLANA_RPC_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getLatestBlockhash',
          params: [{ commitment: 'finalized' }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = (await res.json()) as {
        result?: { value?: { blockhash?: string } };
      };
      const blockhash = json.result?.value?.blockhash?.trim();
      if (blockhash) return blockhash;
    } catch {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Parses a Circle CCTP `MessageSent` payload + Iris attestation hex, derives every required
 * Solana CCTP PDA via `PublicKey.findProgramAddressSync`, validates fail-closed that the
 * message's `mintRecipient` equals the user's canonical Solana USDC ATA PDA, and returns a
 * structured, serializable claim transaction plan (plus compiled transaction bytes when a
 * recentBlockhash is provided).
 */
export function buildSolanaCctpClaimInstructionPlan(
  params: BuildSolanaCctpClaimParams
): SolanaCctpClaimPlan {
  const solDestClean = params.solanaDestination?.trim() ?? '';
  if (!solDestClean) {
    throw new Error('solanaDestination is required.');
  }
  // Validates base58 and rejects all-zero System Program pubkey
  const ownerBytes32 = solanaAddressToBytes32(solDestClean);
  const ownerPubkey = new PublicKey(solDestClean);
  const expectedUsdcAtaPubkey = deriveSolanaUsdcAta(solDestClean);
  const expectedMintRecipientBytes32 = solanaOwnerToUsdcAtaBytes32(solDestClean);

  const payerClean = params.payer?.trim() || solDestClean;
  const payerBytes32 = solanaAddressToBytes32(payerClean);
  const payerPubkey = new PublicKey(payerClean);

  const messageBuf = cleanHexBytes(params.messageBytesHex, 'messageBytesHex');
  const attestationBuf = cleanHexBytes(params.attestationHex, 'attestationHex');
  if (attestationBuf.length < 65) {
    throw new Error(
      `Invalid Circle Iris attestation length (${attestationBuf.length} bytes; expected >= 65 bytes ECDSA signature).`
    );
  }

  const decoded = decodeCctpMessage(params.messageBytesHex);

  // Fail closed: destinationDomain MUST be Solana (domain 5)
  if (decoded.destinationDomain !== SOLANA_CCTP_DOMAIN) {
    throw new Error(
      `CCTP destinationDomain mismatch: message targets domain ${decoded.destinationDomain}, expected Solana domain ${SOLANA_CCTP_DOMAIN}.`
    );
  }

  // Fail closed: BurnMessage amount must be strictly positive
  if (BigInt(decoded.burnMessage.amountRaw) <= 0n) {
    throw new Error('CCTP BurnMessage amount must be greater than zero.');
  }

  // Fail closed: mintRecipient MUST match the user's canonical Solana USDC ATA PDA!
  if (
    decoded.burnMessage.mintRecipientBytes32.toLowerCase() !==
    expectedMintRecipientBytes32.toLowerCase()
  ) {
    const looksLikeRawOwner =
      decoded.burnMessage.mintRecipientBytes32.toLowerCase() === ownerBytes32.toLowerCase();
    throw new Error(
      looksLikeRawOwner
        ? `CCTP mintRecipient mismatch: message encodes raw Solana wallet owner (${ownerBytes32}) instead of canonical Solana USDC ATA PDA (${expectedMintRecipientBytes32}).`
        : `CCTP mintRecipient mismatch: message encodes ${decoded.burnMessage.mintRecipientBytes32}, expected canonical Solana USDC ATA PDA ${expectedMintRecipientBytes32} for ${solDestClean}.`
    );
  }

  // Fail closed: if destinationCaller is locked (non-zero), payer must match destinationCaller
  if (
    decoded.destinationCallerBytes32 !== ZERO_BYTES32 &&
    decoded.destinationCallerBytes32.toLowerCase() !== payerBytes32.toLowerCase()
  ) {
    throw new Error(
      `CCTP destinationCaller mismatch: message is restricted to ${decoded.destinationCallerBytes32}, which does not match payer ${payerClean}.`
    );
  }

  const programs = getSolanaCctpPrograms(decoded.cctpVersion);
  const pdas = deriveSolanaCctpClaimPdas({
    cctpVersion: decoded.cctpVersion,
    sourceDomain: decoded.sourceDomain,
    nonce: decoded.nonce,
    nonceBytes32Hex: decoded.nonceBytes32Hex,
    burnTokenBytes32: decoded.burnMessage.burnTokenBytes32,
    solanaDestination: solDestClean,
  });

  const includeCreateAta = params.includeCreateAta !== false;
  const serializableInstructions: SerializableSolanaInstruction[] = [];
  const web3Instructions: TransactionInstruction[] = [];

  if (includeCreateAta) {
    // SPL Associated Token Account Program: instruction index 1 = CreateIdempotent
    const createAtaData = Buffer.from([1]);
    const createAtaKeys: SerializableSolanaAccountMeta[] = [
      { name: 'payer', pubkey: payerPubkey.toBase58(), isSigner: true, isWritable: true },
      { name: 'associatedToken', pubkey: expectedUsdcAtaPubkey.toBase58(), isSigner: false, isWritable: true },
      { name: 'owner', pubkey: ownerPubkey.toBase58(), isSigner: false, isWritable: false },
      { name: 'mint', pubkey: SOLANA_USDC_MINT_PUBKEY.toBase58(), isSigner: false, isWritable: false },
      { name: 'systemProgram', pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
      { name: 'tokenProgram', pubkey: SOLANA_TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
    ];
    serializableInstructions.push({
      name: 'createAssociatedTokenAccountIdempotent',
      programId: SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      keys: createAtaKeys,
      dataBase64: createAtaData.toString('base64'),
      dataHex: '0x' + createAtaData.toString('hex'),
    });
    web3Instructions.push(
      new TransactionInstruction({
        programId: SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
        keys: createAtaKeys.map((k) => ({
          pubkey: new PublicKey(k.pubkey),
          isSigner: k.isSigner,
          isWritable: k.isWritable,
        })),
        data: createAtaData,
      })
    );
  }

  // Anchor instruction data: 8-byte discriminator + Borsh ReceiveMessageParams { message: Vec<u8>, attestation: Vec<u8> }
  const receiveMessageData = Buffer.concat([
    RECEIVE_MESSAGE_DISCRIMINATOR,
    encodeBorshVecU8(messageBuf),
    encodeBorshVecU8(attestationBuf),
  ]);

  const receiveMessageKeys: SerializableSolanaAccountMeta[] = [
    { name: 'payer', pubkey: payerPubkey.toBase58(), isSigner: true, isWritable: true },
    { name: 'caller', pubkey: payerPubkey.toBase58(), isSigner: true, isWritable: false },
    { name: 'authorityPda', pubkey: pdas.authorityPda, isSigner: false, isWritable: false },
    { name: 'messageTransmitter', pubkey: pdas.messageTransmitter, isSigner: false, isWritable: false },
    { name: 'usedNonces', pubkey: pdas.usedNonces, isSigner: false, isWritable: true },
    { name: 'receiver', pubkey: programs.tokenMessengerMinter, isSigner: false, isWritable: false },
    { name: 'systemProgram', pubkey: SystemProgram.programId.toBase58(), isSigner: false, isWritable: false },
    {
      name: 'messageTransmitterEventAuthority',
      pubkey: pdas.messageTransmitterEventAuthority,
      isSigner: false,
      isWritable: false,
    },
    { name: 'messageTransmitterProgram', pubkey: programs.messageTransmitter, isSigner: false, isWritable: false },
    // Remaining accounts passed via CPI to TokenMessengerMinter.handle_receive_message
    { name: 'tokenMessenger', pubkey: pdas.tokenMessenger, isSigner: false, isWritable: false },
    { name: 'remoteTokenMessenger', pubkey: pdas.remoteTokenMessenger, isSigner: false, isWritable: false },
    { name: 'tokenMinter', pubkey: pdas.tokenMinter, isSigner: false, isWritable: false },
    { name: 'localToken', pubkey: pdas.localToken, isSigner: false, isWritable: true },
    { name: 'tokenPair', pubkey: pdas.tokenPair, isSigner: false, isWritable: false },
    { name: 'recipientTokenAccount', pubkey: pdas.recipientUsdcAta, isSigner: false, isWritable: true },
    { name: 'custodyTokenAccount', pubkey: pdas.custodyTokenAccount, isSigner: false, isWritable: true },
    { name: 'tokenProgram', pubkey: SOLANA_TOKEN_PROGRAM_ID.toBase58(), isSigner: false, isWritable: false },
    {
      name: 'tokenMessengerEventAuthority',
      pubkey: pdas.tokenMessengerEventAuthority,
      isSigner: false,
      isWritable: false,
    },
    { name: 'tokenMessengerMinterProgram', pubkey: programs.tokenMessengerMinter, isSigner: false, isWritable: false },
  ];

  serializableInstructions.push({
    name: 'receiveMessage',
    programId: programs.messageTransmitter,
    keys: receiveMessageKeys,
    dataBase64: receiveMessageData.toString('base64'),
    dataHex: '0x' + receiveMessageData.toString('hex'),
  });
  web3Instructions.push(
    new TransactionInstruction({
      programId: new PublicKey(programs.messageTransmitter),
      keys: receiveMessageKeys.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: receiveMessageData,
    })
  );

  let recentBlockhash: string | null = params.recentBlockhash?.trim() || null;
  let serializedTransactionBase64: string | null = null;
  let serializedMessageBase64: string | null = null;

  if (recentBlockhash) {
    const tx = new Transaction({
      feePayer: payerPubkey,
      recentBlockhash,
    });
    for (const ix of web3Instructions) tx.add(ix);
    serializedTransactionBase64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
    serializedMessageBase64 = tx.serializeMessage().toString('base64');
  } else {
    recentBlockhash = null;
  }

  const claimSummary = `Claim ${decoded.burnMessage.amountUsdc.toFixed(2)} native USDC on Solana (CCTP V${decoded.cctpVersion}, domain ${decoded.sourceDomain} → 5) into ATA ${pdas.recipientUsdcAta}`;

  const fallbackInstructions = [
    `Ensure your Solana wallet (${payerClean}) holds at least 0.003 SOL for transaction fees and USDC ATA rent.`,
    `Connect Phantom, Backpack, or Solflare to sign and send MessageTransmitter.receiveMessage on program ${programs.messageTransmitter}.`,
    `If your wallet does not expose signAndSendTransaction, submit the derived receive_message instruction using messageHash ${decoded.messageHash} and recipient USDC ATA ${pdas.recipientUsdcAta}.`,
  ];

  return {
    planVersion: 'siphon-solana-cctp-claim-v1',
    cctpVersion: decoded.cctpVersion,
    messageHash: decoded.messageHash,
    decodedMessage: decoded,
    solanaDestination: solDestClean,
    payer: payerClean,
    recipientUsdcAta: pdas.recipientUsdcAta,
    expectedMintRecipientBytes32,
    mintRecipientVerified: true,
    amountUsdc: decoded.burnMessage.amountUsdc,
    amountRaw: decoded.burnMessage.amountRaw,
    programs: {
      messageTransmitter: programs.messageTransmitter,
      tokenMessengerMinter: programs.tokenMessengerMinter,
      tokenProgram: SOLANA_TOKEN_PROGRAM_ID.toBase58(),
      associatedTokenProgram: SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      systemProgram: SystemProgram.programId.toBase58(),
      usdcMint: SOLANA_USDC_MINT_PUBKEY.toBase58(),
    },
    pdas,
    instructions: serializableInstructions,
    recentBlockhash,
    serializedTransactionBase64,
    serializedMessageBase64,
    claimSummary,
    fallbackInstructions,
  };
}
