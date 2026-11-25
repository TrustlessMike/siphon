import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { deriveSolanaUsdcAta, solanaOwnerToUsdcAtaBytes32 } from '../bridge/cctp.js';
import { EVM_CHAINS, getProtocolFeeConfig } from '../scanner/chains.js';
import { isEip2612Token } from '../scanner/discovery.js';
import { computeRelayerBreakEven, RELAYER_BREAK_EVEN_MULTIPLIER } from '../scanner/roi.js';
import type { EvmChainId, ScannedAsset } from '../scanner/types.js';

export const CANONICAL_PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// EIP-2 secp256k1 half-order (matches SiphonSweepDelegate.SECP256K1N_HALF)
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

// Exact EIP-712 type strings matching contracts/SiphonRouter.sol and contracts/SiphonSweepDelegate.sol
export const PERMIT2_DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,uint256 chainId,address verifyingContract)';
export const DELEGATE_DOMAIN_TYPE_STRING =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';
export const TOKEN_PERMISSIONS_TYPE_STRING = 'TokenPermissions(address token,uint256 amount)';
export const SIPHON_WITNESS_TYPE_STRING =
  'SiphonSweepWitness(bytes32 solanaRecipient,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint16 feeBps,address feeRecipient,bytes32 swapsHash)';
export const PERMIT_BATCH_WITNESS_TYPE_STRING =
  'PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline,SiphonSweepWitness witness)' +
  SIPHON_WITNESS_TYPE_STRING +
  TOKEN_PERMISSIONS_TYPE_STRING;
export const SWEEP_INTENT_TYPE_STRING =
  'SweepIntent(bytes32 solanaRecipient,address usdc,address cctpMessenger,address feeRecipient,uint16 feeBps,uint256 directUsdcAmount,uint256 minNetUsdcOut,uint256 maxGasReimbursementUsdc,uint256 nonce,uint256 deadline,bytes32 callsHash)';

const MAX_ISSUED_INTENTS = 2000;

interface TrackedGaslessIntent {
  intentId: string;
  mode: 'permit2_batch' | 'eip7702_delegate';
  chain: EvmChainId;
  chainId: number;
  userAddress: string;
  deadline: number;
  eligible: boolean;
  rejectionReason?: string;
  routerConfigured: boolean;
  previewOnly: boolean;
  eip712Digest: string | null;
  consumed: boolean;
  createdAt: number;
}

const issuedIntents = new Map<string, TrackedGaslessIntent>();

function keccakHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(keccak_256(bytes)).toString('hex');
}

function keccakUtf8(text: string): Uint8Array {
  return keccak_256(new TextEncoder().encode(text));
}

function encodeWordUint(value: bigint | number | string): Uint8Array {
  const big = typeof value === 'bigint' ? value : BigInt(value);
  if (big < 0n) throw new Error('ABI uint word cannot be negative');
  return Buffer.from(big.toString(16).padStart(64, '0'), 'hex');
}

function encodeWordAddress(addr: string): Uint8Array {
  const clean = addr.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM address for EIP-712 encoding: ${addr}`);
  }
  return Buffer.from(clean.padStart(64, '0'), 'hex');
}

function encodeWordBytes32(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error(`Invalid bytes32 for EIP-712 encoding: ${hex}`);
  }
  return Buffer.from(clean, 'hex');
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * Computes Solidity-identical `keccak256(abi.encode(defiExits, swaps, burns, revokes))`
 * matching `SiphonSweepDelegate.computeCallsHash` for empty call arrays (or custom pre-encoded calls).
 */
export function computeEmptySweepCallsHash(): string {
  // abi.encode(empty[], empty[], empty[], empty[]):
  // 4 head offsets (0x80, 0xa0, 0xc0, 0xe0) followed by 4 zero lengths (0, 0, 0, 0)
  const encoded = concatBytes([
    encodeWordUint(0x80n),
    encodeWordUint(0xa0n),
    encodeWordUint(0xc0n),
    encodeWordUint(0xe0n),
    encodeWordUint(0n),
    encodeWordUint(0n),
    encodeWordUint(0n),
    encodeWordUint(0n),
  ]);
  return keccakHex(encoded);
}

/**
 * Computes Solidity-identical `keccak256(abi.encode(swaps))` for an empty `SwapStep[]` array,
 * matching `SiphonRouter.sweepWithPermit2Batch` witness `swapsHash`.
 */
export function computeEmptySwapsHash(): string {
  // abi.encode(empty[]): head offset 0x20 + zero length 0
  const encoded = concatBytes([encodeWordUint(0x20n), encodeWordUint(0n)]);
  return keccakHex(encoded);
}

/**
 * Computes the exact EIP-712 signing digest (`\x19\x01 || domainSeparator || structHash`)
 * for Siphon's `PermitBatchWitnessTransferFrom` or `SweepIntent` typed data.
 */
export function computeGaslessIntentEip712Digest(typedData: Record<string, unknown>): string {
  const primaryType = typedData.primaryType as string;
  const domain = typedData.domain as Record<string, unknown>;
  const message = typedData.message as Record<string, unknown>;

  if (primaryType === 'PermitBatchWitnessTransferFrom') {
    const domainTypeHash = keccakUtf8(PERMIT2_DOMAIN_TYPE_STRING);
    const domainSeparator = keccak_256(
      concatBytes([
        domainTypeHash,
        keccakUtf8(String(domain.name)),
        encodeWordUint(Number(domain.chainId)),
        encodeWordAddress(String(domain.verifyingContract)),
      ])
    );

    const tokenPermTypeHash = keccakUtf8(TOKEN_PERMISSIONS_TYPE_STRING);
    const permitted = (message.permitted as Array<{ token: string; amount: string }>) ?? [];
    const permHashes = permitted.map((p) =>
      keccak_256(concatBytes([tokenPermTypeHash, encodeWordAddress(p.token), encodeWordUint(p.amount)]))
    );
    const permittedHash = keccak_256(concatBytes(permHashes));

    const witness = message.witness as Record<string, unknown>;
    const witnessTypeHash = keccakUtf8(SIPHON_WITNESS_TYPE_STRING);
    const witnessHash = keccak_256(
      concatBytes([
        witnessTypeHash,
        encodeWordBytes32(String(witness.solanaRecipient)),
        encodeWordUint(String(witness.minNetUsdcOut)),
        encodeWordUint(String(witness.maxGasReimbursementUsdc)),
        encodeWordUint(Number(witness.feeBps)),
        encodeWordAddress(String(witness.feeRecipient)),
        encodeWordBytes32(String(witness.swapsHash)),
      ])
    );

    const permitTypeHash = keccakUtf8(PERMIT_BATCH_WITNESS_TYPE_STRING);
    const structHash = keccak_256(
      concatBytes([
        permitTypeHash,
        permittedHash,
        encodeWordAddress(String(message.spender)),
        encodeWordUint(String(message.nonce)),
        encodeWordUint(String(message.deadline)),
        witnessHash,
      ])
    );

    return keccakHex(concatBytes([new Uint8Array([0x19, 0x01]), domainSeparator, structHash]));
  }

  if (primaryType === 'SweepIntent') {
    const domainTypeHash = keccakUtf8(DELEGATE_DOMAIN_TYPE_STRING);
    const domainSeparator = keccak_256(
      concatBytes([
        domainTypeHash,
        keccakUtf8(String(domain.name)),
        keccakUtf8(String(domain.version)),
        encodeWordUint(Number(domain.chainId)),
        encodeWordAddress(String(domain.verifyingContract)),
      ])
    );

    const intentTypeHash = keccakUtf8(SWEEP_INTENT_TYPE_STRING);
    const structHash = keccak_256(
      concatBytes([
        intentTypeHash,
        encodeWordBytes32(String(message.solanaRecipient)),
        encodeWordAddress(String(message.usdc)),
        encodeWordAddress(String(message.cctpMessenger)),
        encodeWordAddress(String(message.feeRecipient)),
        encodeWordUint(Number(message.feeBps)),
        encodeWordUint(String(message.directUsdcAmount)),
        encodeWordUint(String(message.minNetUsdcOut)),
        encodeWordUint(String(message.maxGasReimbursementUsdc)),
        encodeWordUint(String(message.nonce)),
        encodeWordUint(String(message.deadline)),
        encodeWordBytes32(String(message.callsHash)),
      ])
    );

    return keccakHex(concatBytes([new Uint8Array([0x19, 0x01]), domainSeparator, structHash]));
  }

  throw new Error(`Unsupported EIP-712 primaryType: ${primaryType}`);
}

/**
 * Recovers the EVM signer address from a 32-byte EIP-712 digest and 65-byte ECDSA signature
 * with strict EIP-2 low-`s` malleability protection.
 */
export function recoverEip712Signer(digestHex: string, signatureHex: string): string {
  const cleanDigest = digestHex.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(cleanDigest)) {
    throw new Error('Invalid 32-byte EIP-712 digest');
  }
  const cleanSig = signatureHex.trim();
  if (!/^0x[0-9a-fA-F]{130}$/.test(cleanSig)) {
    throw new Error('Invalid EIP-712 signature (expected 65-byte 0x hex signature).');
  }

  const r = BigInt('0x' + cleanSig.slice(2, 66));
  const s = BigInt('0x' + cleanSig.slice(66, 130));
  const rawV = parseInt(cleanSig.slice(130, 132), 16);

  if (r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_HALF_N) {
    throw new Error('Invalid ECDSA signature scalar (r out of range or high-s malleability rejected).');
  }
  if (rawV !== 27 && rawV !== 28) {
    throw new Error(`Invalid ECDSA recovery id v=${rawV} (expected 27 or 28).`);
  }

  const recoveryBit = rawV - 27;
  const sigObj = new secp256k1.Signature(r, s, recoveryBit);
  const digestBytes = Buffer.from(cleanDigest.slice(2), 'hex');
  const pubPoint = sigObj.recoverPublicKey(digestBytes);
  const uncompressed = pubPoint.toRawBytes(false); // 65 bytes: 0x04 || X(32) || Y(32)
  const addrBytes = keccak_256(uncompressed.slice(1)).slice(-20);
  return '0x' + Buffer.from(addrBytes).toString('hex');
}

export interface GaslessSweepIntentPlan {
  intentId: string;
  mode: 'permit2_batch' | 'eip7702_delegate';
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  userAddress: string;
  solanaDestination: string;
  solanaUsdcAta: string;
  solanaMintRecipientBytes32: string;
  outputAsset: 'USDC' | 'SOL';
  nonce: string;
  deadline: number;
  userGasCostUsd: 0;
  sponsoredGasEstUsd: number;
  maxGasReimbursementUsdc: string; // 6 decimals raw string
  protocolFeeBps: number;
  protocolFeePercent: number;
  protocolFeeUsd: number;
  feeRecipientEvm: string | null;
  minNetUsdcOut: string; // 6 decimals raw string
  directUsdcAmount?: string; // 6 decimals raw string (EIP-7702 SweepIntent)
  callsHash?: string; // bytes32 (EIP-7702 SweepIntent)
  swapsHash?: string; // bytes32 (Permit2 SiphonSweepWitness)
  estimatedNetUsd: number;
  sponsorEligible: boolean;
  sponsorRejectionReason?: string;
  relayerRequiredCoverageUsd: number;
  relayerExpectedCoverageUsd: number;
  coveredAssets: Array<{ id: string; symbol: string; address: string; rawBalance: string; grossUsd: number }>;
  uncoveredNativeAssets: Array<{ id: string; symbol: string; reason: string }>;
  instantSingleSigBreakdown: {
    permit2ApprovedIds: string[];
    eip2612SupportedIds: string[];
    instantEligibleIds: string[];
    requiresOnchainApprovalIds: string[];
    zeroPopupReadyCount: number;
    requiresApprovalCount: number;
  };
  routerConfigured: boolean;
  previewOnly: boolean;
  relayerConfigured: boolean;
  routerAddress: string | null;
  typedData: Record<string, unknown> | null;
  eip712Digest: string | null;
  intentDigestSha256: string;
  explanation: string;
}

export interface SignedIntentReceipt {
  accepted: boolean;
  broadcasted: boolean;
  settlementStatus: 'unbroadcast_awaiting_deployment' | 'queued_pending_broadcast' | 'broadcast';
  mode: 'relayer_submitted' | 'intent_verified_awaiting_deployment';
  intentId: string;
  chain: EvmChainId;
  chainName: string;
  userAddress: string;
  recoveredSigner: string;
  signatureValid: boolean;
  signatureFingerprint: string;
  txHash?: string;
  nextStep: string;
}

function getChainRouterAddress(chain: EvmChainId): string | null {
  const envKey = `SIPHON_ROUTER_${chain.toUpperCase()}`;
  const val = process.env[envKey]?.trim();
  if (!val || !/^0x[0-9a-fA-F]{40}$/.test(val)) return null;
  const lower = val.toLowerCase();
  if (
    lower === '0x0000000000000000000000000000000000000000' ||
    lower === '0x00000000000000000000000000000000000051f0'
  ) {
    return null;
  }
  return val;
}

function getChainDelegateAddress(chain: EvmChainId): string | null {
  const envKey = `SIPHON_DELEGATE_${chain.toUpperCase()}`;
  const val = process.env[envKey]?.trim();
  if (val && /^0x[0-9a-fA-F]{40}$/.test(val)) {
    const lower = val.toLowerCase();
    if (
      lower !== '0x0000000000000000000000000000000000000000' &&
      lower !== '0x00000000000000000000000000000000000051f0'
    ) {
      return val;
    }
  }
  return getChainRouterAddress(chain);
}

export function isSponsorRelayerConfigured(chain?: EvmChainId): boolean {
  const hasKey = Boolean(process.env.SIPHON_RELAYER_PRIVATE_KEY?.trim());
  if (!hasKey) return false;
  if (!chain) return true;
  return Boolean(getChainRouterAddress(chain));
}

/**
 * Clears in-memory tracked intents (for deterministic testing).
 */
export function clearTrackedGaslessIntentsForTest(): void {
  issuedIntents.clear();
}

/**
 * Builds a single off-chain EIP-712 gasless signature payload solving BOTH:
 *   1. Zero per-tx popups (1 eth_signTypedData_v4 covers ALL tokens on the chain)
 *   2. Zero native gas needed by the user (Siphon Relayer sponsors gas, reimbursed from 5-10% fee/proceeds)
 *
 * Security hardening:
 *   - Uses canonical 32-byte Solana USDC ATA PDA (`solanaOwnerToUsdcAtaBytes32`) for CCTP `mintRecipient`
 *   - Never emits live mainnet Permit2/EIP-7702 typed data with placeholder `0x...51F0` addresses
 *   - Matches Solidity EIP-712 structs exactly (`swapsHash` on Permit2 witness; `directUsdcAmount` + `callsHash` on SweepIntent)
 *   - Evaluates relayer break-even honestly at 1.0x sponsored gas (eliminating the circular 2.5x bypass)
 */
export function buildGaslessSweepIntent(params: {
  chain: EvmChainId;
  assets: ScannedAsset[];
  userAddress: string;
  solanaDestination: string;
  outputAsset?: 'USDC' | 'SOL';
  protocolFeeBps?: number;
  feeRecipientEvm?: string | null;
  preferredMode?: 'permit2_batch' | 'eip7702_delegate';
  filterToInstantSingleSig?: boolean;
  callsHash?: string;
  swapsHash?: string;
}): GaslessSweepIntentPlan {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) throw new Error(`Unsupported chain: ${params.chain}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.userAddress.trim())) {
    throw new Error(`Invalid EVM userAddress: ${params.userAddress}`);
  }

  // CRIT-04: Derive canonical Solana USDC Associated Token Account (ATA) PDA
  const solanaUsdcAta = deriveSolanaUsdcAta(params.solanaDestination).toBase58();
  const solanaMintRecipientBytes32 = solanaOwnerToUsdcAtaBytes32(params.solanaDestination);

  const feeConfig = getProtocolFeeConfig({
    feeBps: params.protocolFeeBps,
    feeRecipientEvm: params.feeRecipientEvm,
  });

  const chainAssets = params.assets.filter(
    (a) =>
      a.chain === params.chain &&
      a.action !== 'SKIP_HONEYPOT' &&
      a.action !== 'SKIP_GAS_NEGATIVE' &&
      a.action !== 'SKIP_NEGATIVE_ROI'
  );
  // MED-05: Permit2 batch strictly covers liquid swappable/bridgeable ERC-20s (never dead burns or DeFi receipts)
  const allLiquidErc20Assets = chainAssets.filter(
    (a) =>
      a.address !== 'native' &&
      a.kind !== 'defi_position' &&
      (a.action === 'SELL_AND_BRIDGE' || a.action === 'BRIDGE_DIRECT_USDC')
  );
  const permit2ApprovedIds: string[] = [];
  const eip2612SupportedIds: string[] = [];
  const instantEligibleIds: string[] = [];
  const requiresOnchainApprovalIds: string[] = [];
  for (const asset of allLiquidErc20Assets) {
    const hasPermit2 = Boolean(asset.permit2Approved);
    const hasEip2612 = Boolean(
      asset.eip2612Supported ?? isEip2612Token(params.chain, asset.address, asset.symbol)
    );
    if (hasPermit2) permit2ApprovedIds.push(asset.id);
    if (hasEip2612) eip2612SupportedIds.push(asset.id);
    if (hasPermit2 || hasEip2612) {
      instantEligibleIds.push(asset.id);
    } else {
      requiresOnchainApprovalIds.push(asset.id);
    }
  }
  const instantEligibleSet = new Set(instantEligibleIds);
  const permit2Erc20Assets = params.filterToInstantSingleSig
    ? allLiquidErc20Assets.filter((a) => instantEligibleSet.has(a.id))
    : allLiquidErc20Assets;
  const nativeAssets = chainAssets.filter((a) => a.address === 'native');

  const mode: 'permit2_batch' | 'eip7702_delegate' =
    params.preferredMode ?? (permit2Erc20Assets.length > 0 ? 'permit2_batch' : 'eip7702_delegate');

  // MED-03: In eip7702_delegate mode, include both ERC-20/DeFi assets and native gas coins
  const coveredForEconomics =
    mode === 'eip7702_delegate'
      ? chainAssets.filter((a) => a.action !== 'BURN_ZERO_LIQUIDITY')
      : permit2Erc20Assets;

  const nonce = BigInt('0x' + crypto.randomBytes(12).toString('hex')).toString();
  const deadline = Math.floor(Date.now() / 1000) + 1800; // 30 minutes
  const routerAddress =
    mode === 'eip7702_delegate'
      ? getChainDelegateAddress(params.chain)
      : getChainRouterAddress(params.chain);
  const routerConfigured = Boolean(routerAddress);

  const grossUsd = Number(
    coveredForEconomics.reduce((s, a) => s + a.grossUsd, 0).toFixed(2)
  );
  const estimatedSlippageUsd = Number(
    coveredForEconomics.reduce((s, a) => s + (a.estimatedSlippageUsd || 0), 0).toFixed(2)
  );
  const sponsoredGasEstUsd = Number(
    Math.max(
      0.04,
      coveredForEconomics.reduce((s, a) => s + (a.batchedGasUsd || a.estimatedGasUsd || 0), 0)
    ).toFixed(2)
  );
  const protocolFeeUsd = Number(((grossUsd * feeConfig.feeBps) / 10_000).toFixed(2));

  // HIGH-04: Honest break-even check aligned with onchain invariant:
  // Onchain requires: feeUsdc + gasReimbursementUsdc >= 1.5 * gasReimbursementUsdc  <=>  feeUsdc >= 0.5 * gasReimbursementUsdc.
  // Therefore evaluate offchain break-even at 1.0x sponsoredGasEstUsd (NEVER inflated 2.5x maxGasReimbursementUsd!).
  const relayerRequiredCoverageUsd = Number(
    (sponsoredGasEstUsd * RELAYER_BREAK_EVEN_MULTIPLIER).toFixed(2)
  );
  const relayerExpectedCoverageUsd = Number((protocolFeeUsd + sponsoredGasEstUsd).toFixed(2));
  const relayerCheck = computeRelayerBreakEven({
    sponsoredGasUsd: sponsoredGasEstUsd,
    protocolFeeBps: feeConfig.feeBps,
    grossUsd,
    maxGasReimbursementUsd: sponsoredGasEstUsd,
  });

  // Cap maxGasReimbursementUsd by BOTH onchain break-even ceiling (2 * protocolFeeUsd) and affordable proceeds
  const affordableReimbursementUsd = Number(
    Math.max(0, grossUsd - protocolFeeUsd - estimatedSlippageUsd - 0.01).toFixed(2)
  );
  const onchainMaxReimbursementCapUsd = Number((protocolFeeUsd * 2).toFixed(2));
  const maxGasReimbursementUsd = Number(
    Math.min(
      Math.max(sponsoredGasEstUsd * 1.5, Math.min(0.25, onchainMaxReimbursementCapUsd)),
      onchainMaxReimbursementCapUsd,
      affordableReimbursementUsd
    ).toFixed(2)
  );

  const estimatedNetUsd = Number(
    (grossUsd - protocolFeeUsd - estimatedSlippageUsd - sponsoredGasEstUsd).toFixed(2)
  );
  // MED-05: Keep minNetUsdcOut consistent with slippage and reimbursement headroom
  const minNetUsd = Number(
    Math.max(
      0,
      Math.min(
        estimatedNetUsd * 0.985,
        grossUsd - protocolFeeUsd - estimatedSlippageUsd - maxGasReimbursementUsd
      )
    ).toFixed(2)
  );

  const maxGasReimbursementUsdc = BigInt(Math.round(Math.max(0, maxGasReimbursementUsd) * 1_000_000)).toString();
  const minNetUsdcOut = BigInt(Math.round(Math.max(0, minNetUsd) * 1_000_000)).toString();

  // CRIT-02: Compute explicit directUsdcAmount for EIP-7702 SweepIntent (0 for non-USDC swaps!)
  const directUsdcRaw = coveredForEconomics
    .filter(
      (a) =>
        a.action === 'BRIDGE_DIRECT_USDC' &&
        a.address.toLowerCase() === cfg.usdcAddress.toLowerCase()
    )
    .reduce((sum, a) => sum + BigInt(a.rawBalance || '0'), 0n);
  const directUsdcAmount = directUsdcRaw.toString();

  const callsHash =
    params.callsHash && /^0x[0-9a-fA-F]{64}$/.test(params.callsHash)
      ? params.callsHash.toLowerCase()
      : computeEmptySweepCallsHash();
  const swapsHash =
    params.swapsHash && /^0x[0-9a-fA-F]{64}$/.test(params.swapsHash)
      ? params.swapsHash.toLowerCase()
      : computeEmptySwapsHash();

  const userMinNetPositive = BigInt(minNetUsdcOut) > 0n;
  const onchainFeeCoversGasMargin = protocolFeeUsd + 1e-9 >= sponsoredGasEstUsd * 0.5;
  const sponsorEligible =
    relayerExpectedCoverageUsd >= relayerRequiredCoverageUsd &&
    onchainFeeCoversGasMargin &&
    userMinNetPositive &&
    relayerCheck.isRelayerProfitable;
  const sponsorRejectionReason = !sponsorEligible
    ? !userMinNetPositive
      ? `Below gasless sponsorship break-even: user minNetUsdcOut is $0.00 on $${grossUsd.toFixed(2)} gross vs $${sponsoredGasEstUsd.toFixed(2)} sponsored gas.`
      : `Below gasless sponsorship break-even: protocol fee + 1.0x sponsored gas ($${relayerExpectedCoverageUsd.toFixed(2)}) < 1.5x sponsored gas ($${relayerRequiredCoverageUsd.toFixed(2)}) (protocol fee $${protocolFeeUsd.toFixed(2)} must be >= 0.5x gas $${(sponsoredGasEstUsd * 0.5).toFixed(2)}).`
    : undefined;

  // MED-05 / CRIT-06: NEVER emit live mainnet Permit2/EIP-7702 typed data with unowned placeholder 0x...51F0!
  const effectiveFeeRecipient = feeConfig.feeRecipientEvm;
  const canEmitLiveTypedData =
    routerConfigured &&
    Boolean(routerAddress) &&
    Boolean(effectiveFeeRecipient) &&
    (mode === 'permit2_batch' || Boolean(cfg.cctpTokenMessenger));
  const previewOnly = !canEmitLiveTypedData;

  let typedData: Record<string, unknown> | null = null;
  let eip712Digest: string | null = null;

  if (canEmitLiveTypedData && routerAddress && effectiveFeeRecipient) {
    typedData =
      mode === 'permit2_batch'
        ? {
            types: {
              EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'chainId', type: 'uint256' },
                { name: 'verifyingContract', type: 'address' },
              ],
              PermitBatchWitnessTransferFrom: [
                { name: 'permitted', type: 'TokenPermissions[]' },
                { name: 'spender', type: 'address' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'witness', type: 'SiphonSweepWitness' },
              ],
              TokenPermissions: [
                { name: 'token', type: 'address' },
                { name: 'amount', type: 'uint256' },
              ],
              SiphonSweepWitness: [
                { name: 'solanaRecipient', type: 'bytes32' },
                { name: 'minNetUsdcOut', type: 'uint256' },
                { name: 'maxGasReimbursementUsdc', type: 'uint256' },
                { name: 'feeBps', type: 'uint16' },
                { name: 'feeRecipient', type: 'address' },
                { name: 'swapsHash', type: 'bytes32' },
              ],
            },
            primaryType: 'PermitBatchWitnessTransferFrom',
            domain: {
              name: 'Permit2',
              chainId: cfg.chainId,
              verifyingContract: CANONICAL_PERMIT2_ADDRESS,
            },
            message: {
              permitted: permit2Erc20Assets.map((a) => ({
                token: a.address,
                amount: a.rawBalance,
              })),
              spender: routerAddress,
              nonce,
              deadline: String(deadline),
              witness: {
                solanaRecipient: solanaMintRecipientBytes32,
                minNetUsdcOut,
                maxGasReimbursementUsdc,
                feeBps: feeConfig.feeBps,
                feeRecipient: effectiveFeeRecipient,
                swapsHash,
              },
            },
          }
        : {
            types: {
              EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'version', type: 'string' },
                { name: 'chainId', type: 'uint256' },
                { name: 'verifyingContract', type: 'address' },
              ],
              SweepIntent: [
                { name: 'solanaRecipient', type: 'bytes32' },
                { name: 'usdc', type: 'address' },
                { name: 'cctpMessenger', type: 'address' },
                { name: 'feeRecipient', type: 'address' },
                { name: 'feeBps', type: 'uint16' },
                { name: 'directUsdcAmount', type: 'uint256' },
                { name: 'minNetUsdcOut', type: 'uint256' },
                { name: 'maxGasReimbursementUsdc', type: 'uint256' },
                { name: 'nonce', type: 'uint256' },
                { name: 'deadline', type: 'uint256' },
                { name: 'callsHash', type: 'bytes32' },
              ],
            },
            primaryType: 'SweepIntent',
            domain: {
              name: 'SiphonSweepDelegate',
              version: '1',
              chainId: cfg.chainId,
              verifyingContract: params.userAddress,
            },
            message: {
              solanaRecipient: solanaMintRecipientBytes32,
              usdc: cfg.usdcAddress,
              cctpMessenger: cfg.cctpTokenMessenger!,
              feeRecipient: effectiveFeeRecipient,
              feeBps: feeConfig.feeBps,
              directUsdcAmount,
              minNetUsdcOut,
              maxGasReimbursementUsdc,
              nonce,
              deadline: String(deadline),
              callsHash,
            },
          };

    eip712Digest = computeGaslessIntentEip712Digest(typedData);
  }

  const intentDigestSha256 =
    '0x' +
    crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          mode,
          chainId: cfg.chainId,
          user: params.userAddress.toLowerCase(),
          routerConfigured,
          previewOnly,
          solanaMintRecipientBytes32,
          eip712Digest,
          typedData,
        })
      )
      .digest('hex');

  const intentId = `int_${crypto.randomBytes(6).toString('hex')}`;
  issuedIntents.set(intentId, {
    intentId,
    mode,
    chain: params.chain,
    chainId: cfg.chainId,
    userAddress: params.userAddress.toLowerCase(),
    deadline,
    eligible: sponsorEligible,
    rejectionReason: sponsorRejectionReason,
    routerConfigured,
    previewOnly,
    eip712Digest,
    consumed: false,
    createdAt: Date.now(),
  });
  if (issuedIntents.size > MAX_ISSUED_INTENTS) {
    const oldest = issuedIntents.keys().next().value;
    if (oldest) issuedIntents.delete(oldest);
  }

  return {
    intentId,
    mode,
    chain: params.chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    userAddress: params.userAddress,
    solanaDestination: params.solanaDestination,
    solanaUsdcAta,
    solanaMintRecipientBytes32,
    outputAsset: params.outputAsset ?? 'USDC',
    nonce,
    deadline,
    userGasCostUsd: 0,
    sponsoredGasEstUsd,
    maxGasReimbursementUsdc,
    protocolFeeBps: feeConfig.feeBps,
    protocolFeePercent: feeConfig.feePercent,
    protocolFeeUsd,
    feeRecipientEvm: effectiveFeeRecipient,
    minNetUsdcOut,
    ...(mode === 'eip7702_delegate' ? { directUsdcAmount, callsHash } : { swapsHash }),
    estimatedNetUsd,
    sponsorEligible,
    sponsorRejectionReason,
    relayerRequiredCoverageUsd,
    relayerExpectedCoverageUsd,
    coveredAssets: coveredForEconomics.map((a) => ({
      id: a.id,
      symbol: a.symbol,
      address: a.address,
      rawBalance: a.rawBalance,
      grossUsd: a.grossUsd,
    })),
    uncoveredNativeAssets:
      mode === 'permit2_batch'
        ? nativeAssets.map((a) => ({
            id: a.id,
            symbol: a.symbol,
            reason: `Native ${a.symbol} requires EIP-7702 delegate execution (Permit2 covers liquid ERC-20s).`,
          }))
        : [],
    instantSingleSigBreakdown: {
      permit2ApprovedIds,
      eip2612SupportedIds,
      instantEligibleIds,
      requiresOnchainApprovalIds,
      zeroPopupReadyCount: instantEligibleIds.length,
      requiresApprovalCount: requiresOnchainApprovalIds.length,
    },
    routerConfigured,
    previewOnly,
    relayerConfigured: isSponsorRelayerConfigured(params.chain),
    routerAddress,
    typedData,
    eip712Digest,
    intentDigestSha256,
    explanation: previewOnly
      ? `Preview mode only on ${cfg.name}: deploy SiphonRouter/SiphonSweepDelegate and configure SIPHON_ROUTER_${params.chain.toUpperCase()} + SIPHON_FEE_RECIPIENT_EVM before signing live EIP-712 payloads.`
      : mode === 'permit2_batch'
      ? `1 gasless Permit2 signature covers ${permit2Erc20Assets.length} liquid ERC-20 token(s) on ${cfg.name}. User pays $0.00 gas; Siphon Relayer sponsors gas & deducts ${feeConfig.feePercent}% fee onchain.`
      : `1 gasless EIP-7702 SweepIntent covers ${coveredForEconomics.length} position(s) on ${cfg.name} with $0.00 user gas, explicit directUsdcAmount, and onchain minNetUsdcOut floor.`,
  };
}

/**
 * Verifies a user-signed EIP-712 gasless sweep intent fail-closed:
 *   - Rejects unknown, expired, or evicted `intentId` (never fails open)
 *   - Enforces server-stored eligibility, chain, userAddress, and deadline (ignores client deadline)
 *   - Performs cryptographic EIP-712 secp256k1 ecrecover with EIP-2 low-s validation
 *   - Enforces single-use replay protection (`consumed = true`)
 *   - NEVER marks unverified or non-broadcast intents as `'attested'` or settled
 */
export function submitSignedGaslessIntent(params: {
  intentId: string;
  chain: EvmChainId;
  userAddress: string;
  signature: string;
  deadline: number;
}): SignedIntentReceipt {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) throw new Error(`Unsupported chain: ${params.chain}`);

  // CRIT-07: Fail-closed lookup on server-issued intent store
  const tracked = issuedIntents.get(params.intentId);
  if (!tracked) {
    throw new Error(
      `Unknown, expired, or evicted gasless intentId (${params.intentId}). Prepare a fresh intent before signing.`
    );
  }
  if (!tracked.eligible) {
    throw new Error(tracked.rejectionReason || 'Below gasless sponsorship break-even.');
  }
  if (tracked.consumed) {
    throw new Error(`Gasless sweep intent ${params.intentId} has already been consumed (replay rejected).`);
  }
  if (tracked.previewOnly || !tracked.routerConfigured || !tracked.eip712Digest) {
    throw new Error(
      `Cannot submit preview-only intent on ${cfg.name}: deploy SiphonRouter/SiphonSweepDelegate and set SIPHON_ROUTER_${params.chain.toUpperCase()} + SIPHON_FEE_RECIPIENT_EVM.`
    );
  }
  if (tracked.chain !== params.chain) {
    throw new Error(`Chain mismatch for intent ${params.intentId}: expected ${tracked.chain}, got ${params.chain}.`);
  }
  if (tracked.userAddress !== params.userAddress.trim().toLowerCase()) {
    throw new Error(`User address mismatch for intent ${params.intentId}.`);
  }

  // Enforce server-stored deadline (never trust client-supplied params.deadline)
  if (Math.floor(Date.now() / 1000) > tracked.deadline) {
    throw new Error('Signed gasless sweep intent has expired. Re-sign a fresh intent.');
  }

  // Real cryptographic EIP-712 ecrecover + EIP-2 low-s check
  const sig = params.signature.trim();
  const recoveredSigner = recoverEip712Signer(tracked.eip712Digest, sig);
  if (recoveredSigner.toLowerCase() !== tracked.userAddress) {
    throw new Error(
      `Invalid EIP-712 signature: recovered signer ${recoveredSigner} does not match userAddress ${tracked.userAddress}.`
    );
  }

  // Single-use replay protection: mark consumed immediately after cryptographic verification
  tracked.consumed = true;

  const signatureFingerprint =
    '0x' + crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
  const configured = isSponsorRelayerConfigured(params.chain);

  return {
    accepted: configured,
    broadcasted: false,
    settlementStatus: configured
      ? 'queued_pending_broadcast'
      : 'unbroadcast_awaiting_deployment',
    mode: configured ? 'relayer_submitted' : 'intent_verified_awaiting_deployment',
    intentId: params.intentId,
    chain: params.chain,
    chainName: cfg.name,
    userAddress: params.userAddress,
    recoveredSigner,
    signatureValid: true,
    signatureFingerprint,
    nextStep: configured
      ? `EIP-712 signature cryptographically verified for ${recoveredSigner}. Intent ${params.intentId} queued for sponsored broadcast on ${cfg.name} (not yet attested onchain).`
      : `EIP-712 signature verified (${signatureFingerprint}) for ${recoveredSigner}, NOT broadcast or attested. Configure SIPHON_RELAYER_PRIVATE_KEY to broadcast sponsored sweeps on ${cfg.name}.`,
  };
}
