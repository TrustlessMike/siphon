import crypto from 'node:crypto';
import {
  CCTP_V1_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR,
  deriveSolanaUsdcAta,
  fetchCctpAttestationForTx,
  SOLANA_USDC_MINT_PUBKEY,
  solanaOwnerToUsdcAtaBytes32,
} from '../bridge/cctp.js';
import { DEAD_BURN_ADDRESS, EVM_CHAINS, TOKEN_REGISTRY } from '../scanner/chains.js';
import { fetchSolanaWalletBalances } from '../scanner/discovery.js';
import {
  classifyRoiVerdict,
  estimateBridgeFixedFeeUsd,
  estimateSolanaAtaRentUsd,
} from '../scanner/roi.js';
import { evmJsonRpcCall, formatUnits } from '../scanner/rpc.js';
import type { EvmChainId, RoiVerdict, ScannedAsset } from '../scanner/types.js';
import { checkLiveExecutionStatus, type PreparedChainBatch } from './tx-builder.js';

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SOLANA_RPC_URLS = [
  process.env.SOLANA_RPC_URL?.trim(),
  'https://api.mainnet-beta.solana.com',
  'https://solana.publicnode.com',
].filter((u): u is string => Boolean(u));

const MAX_STORED_PROOFS = 2000;

interface StoredPreSignProof {
  proofId: string;
  chain: EvmChainId;
  chainId: number;
  blockNumber: number;
  userAddress: string;
  solanaDestination: string;
  solanaUsdcAta: string;
  outputAsset: 'USDC' | 'SOL';
  expectedMinNetUsd: number;
  preSolanaSnapshot?: {
    usdcBalance: number;
    solBalance: number;
    hasUsdcAta: boolean;
    slot: number;
  };
  createdAt: number;
}

interface VerifiedTxRecord {
  txHash: string;
  chain: EvmChainId;
  userAddress: string | null;
  solanaDestination: string;
  proofDigestSha256: string;
}

const preSignProofStore = new Map<string, StoredPreSignProof>();
const verifiedEvmTxStore = new Map<string, VerifiedTxRecord>();

export function clearProofStoresForTest(): void {
  preSignProofStore.clear();
  verifiedEvmTxStore.clear();
}

/**
 * Deterministic canonical JSON serialization (RFC 8785 key-sorted style, preserving explicit nulls).
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') {
    return Number.isFinite(value as number) || typeof value === 'boolean'
      ? JSON.stringify(value)
      : 'null';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalizeJson(item)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      '{' +
      keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(',') +
      '}'
    );
  }
  return 'null';
}

export interface DecodedCallCheck {
  stepId: string;
  assetSymbol: string;
  actionType: string;
  target: string;
  summary: string;
  preflightStatus: 'verified' | 'dependent_ok' | 'reverted' | 'rpc_skipped';
  preflightDetail: string;
}

export interface PreSignSimulationProof {
  proofId: string;
  proofDigestSha256: string;
  proofDigestAlgorithm: 'sha256-canonical-json-v1';
  generatedAt: string;
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  blockNumber: number;
  userAddress: string;
  solanaDestination: string;
  solanaUsdcAta: string;
  solanaMintRecipientBytes32: string;
  mintRecipientVerified: boolean;
  hasEnoughNativeGas: boolean;
  nativeBalanceUi: number;
  nativeSymbol: string;
  nativeBalanceUsd: number;
  estimatedGasUsd: number;
  recommendedMode: 'sponsored_gasless' | 'eip5792_batch' | 'sequential';
  outflows: Array<{ symbol: string; amount: number; usd: number; action: string }>;
  protocolFee: {
    feeBps: number;
    feePercent: number;
    estimatedFeeUsd: number;
    feeRecipientEvm: string | null;
    collectionMethod: string;
  };
  guaranteedMinNetUsd: number;
  estimatedNetUsd: number;
  outputAsset: 'USDC' | 'SOL';
  quotedCostBreakdown?: {
    grossUsd: number;
    estimatedGasUsd: number;
    bridgeAndSlippageUsd: number;
    protocolFeeUsd: number;
    solanaAtaRentUsd: number;
    liveNetUsd: number;
    effectiveCostPct: number;
    roiVerdict: RoiVerdict;
    routeStrategy?: 'local_batch_single_bridge' | 'direct_per_token_bridge';
  };
  haircutDroppedAssets?: Array<{ assetId: string; assetSymbol: string; reason: string }>;
  preSolanaSnapshot?: {
    usdcBalance: number;
    solBalance: number;
    hasUsdcAta: boolean;
    slot: number;
  };
  checks: DecodedCallCheck[];
  allChecksSafe: boolean;
  warnings: string[];
}

export interface DecodedTransferLog {
  tokenAddress: string;
  symbol: string;
  from: string;
  to: string;
  amountUi: number;
  category: 'user_outflow' | 'protocol_fee' | 'burn_dead' | 'cctp_burn' | 'other';
}

export interface OnchainExecutionProof {
  verified: boolean;
  settlementStage:
    | 'unconfirmed'
    | 'reverted'
    | 'rejected_mismatch'
    | 'evm_confirmed_awaiting_bridge'
    | 'cctp_attested_awaiting_solana_mint'
    | 'solana_settled';
  proofDigestSha256: string;
  proofDigestAlgorithm: 'sha256-canonical-json-v1';
  proofDigestNote: string;
  verifiedAt: string;
  chain: EvmChainId;
  chainName: string;
  txHash: string;
  explorerUrl: string;
  evmReceipt: {
    found: boolean;
    succeeded: boolean;
    from?: string;
    senderVerified?: boolean;
    blockNumber?: number;
    gasUsed?: string;
    gasCostNative?: number;
    nativeSymbol: string;
  };
  decodedTransfers: DecodedTransferLog[];
  bridgeProof: {
    provider: string;
    status: string;
    relayBoundToTx?: boolean;
    solanaTxHash?: string;
    solanaTxFinalized?: boolean;
    cctpMessageHash?: string;
    cctpAttestationStatus?: string;
  };
  solanaDeltaProof?: {
    address: string;
    usdcAta: string;
    trustedPreStateSource: 'server_presign_proof' | 'none';
    clientPreStateIgnored?: boolean;
    preUsdc?: number;
    postUsdc: number;
    deltaUsdc?: number;
    preSol?: number;
    postSol: number;
    deltaSol?: number;
    verifiedAtSlot: number;
  };
  rejectionReasons?: string[];
  summary: string;
}

function decodeCallSummary(to: string, data: string, value: string): { actionType: string; summary: string } {
  const clean = (data || '0x').toLowerCase();
  if (clean === '0x' && value && value !== '0x0') {
    return { actionType: 'native_transfer', summary: `Native transfer to ${to.slice(0, 6)}…${to.slice(-4)}` };
  }
  const sel = clean.slice(0, 10);
  if (sel === '0x095ea7b3' && clean.length >= 138) {
    const spender = '0x' + clean.slice(34, 74);
    return { actionType: 'erc20_approve', summary: `Exact ERC-20 approve for ${spender.slice(0, 6)}…${spender.slice(-4)}` };
  }
  if (sel === '0xa9059cbb' && clean.length >= 138) {
    const recipient = '0x' + clean.slice(34, 74);
    const isDead = recipient.toLowerCase() === DEAD_BURN_ADDRESS.toLowerCase();
    return {
      actionType: isDead ? 'burn_dead' : 'erc20_transfer',
      summary: isDead
        ? 'Burn transfer to 0x000…dEaD'
        : `ERC-20 transfer to ${recipient.slice(0, 6)}…${recipient.slice(-4)}`,
    };
  }
  if (sel === `0x${CCTP_V1_DEPOSIT_FOR_BURN_SELECTOR}` && clean.length >= 266) {
    const amt = Number(BigInt('0x' + clean.slice(10, 74))) / 1_000_000;
    const domain = Number(BigInt('0x' + clean.slice(74, 138)));
    return {
      actionType: 'cctp_deposit_for_burn',
      summary: `Circle CCTP V1 depositForBurn(${amt.toFixed(2)} USDC → Domain ${domain} Solana)`,
    };
  }
  if (sel === `0x${CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR}` && clean.length >= 458) {
    const amt = Number(BigInt('0x' + clean.slice(10, 74))) / 1_000_000;
    const domain = Number(BigInt('0x' + clean.slice(74, 138)));
    return {
      actionType: 'cctp_deposit_for_burn',
      summary: `Circle CCTP V2 depositForBurn(${amt.toFixed(2)} USDC → Domain ${domain} Solana)`,
    };
  }
  if (sel === '0x69328dec') return { actionType: 'aave_v3_withdraw', summary: 'Aave Pool.withdraw to user' };
  if (sel === '0xf3fef3a3') return { actionType: 'compound_v3_withdraw', summary: 'Compound v3 Comet.withdraw' };
  if (sel === '0xdb006a75') return { actionType: 'compound_v2_redeem', summary: 'Compound v2 / Venus / Benqi cToken.redeem' };
  if (sel === '0xba087652') return { actionType: 'erc4626_redeem', summary: 'ERC-4626 vault redeem' };
  if (sel === '0xbaa2abde' || sel === '0x0dede6c4') {
    return { actionType: 'uniswap_v2_remove_liquidity', summary: 'DEX v2 LP removeLiquidity' };
  }
  if (sel === '0xac9650d8') {
    return { actionType: 'uniswap_v3_nft_multicall', summary: 'Uniswap v3 / Aerodrome CL NFT multicall exit' };
  }
  return { actionType: 'bridge_or_swap', summary: `Bridge / swap router call to ${to.slice(0, 6)}…${to.slice(-4)}` };
}

function isFalseErc20BoolReturn(resultHex: string | undefined): boolean {
  if (!resultHex) return false;
  const clean = resultHex.trim().toLowerCase();
  return /^0x0{64}$/.test(clean);
}

/**
 * Verifies a finalized Solana settlement transaction via `getTransaction` (commitment: finalized)
 * and computes exact USDC (canonical ATA) and SOL credits to the expected recipient.
 */
async function verifyFinalizedSolanaSettlementTx(params: {
  solanaTxHash: string;
  solanaDestination: string;
}): Promise<{
  found: boolean;
  finalizedSuccess: boolean;
  creditedUsdc: number;
  creditedSol: number;
  slot?: number;
}> {
  const usdcMint = SOLANA_USDC_MINT_PUBKEY.toBase58();
  const owner = params.solanaDestination.trim();

  for (const rpcUrl of SOLANA_RPC_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [
            params.solanaTxHash,
            { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;

      const json = (await res.json()) as {
        result?: {
          slot?: number;
          meta?: {
            err: unknown;
            preBalances?: number[];
            postBalances?: number[];
            preTokenBalances?: Array<{
              accountIndex: number;
              mint?: string;
              owner?: string;
              uiTokenAmount?: { uiAmount?: number | null };
            }>;
            postTokenBalances?: Array<{
              accountIndex: number;
              mint?: string;
              owner?: string;
              uiTokenAmount?: { uiAmount?: number | null };
            }>;
          };
          transaction?: {
            message?: {
              accountKeys?: Array<string | { pubkey?: string }>;
            };
          };
        } | null;
      };

      if (!json.result) {
        return { found: false, finalizedSuccess: false, creditedUsdc: 0, creditedSol: 0 };
      }
      const meta = json.result.meta;
      if (!meta || meta.err !== null) {
        return {
          found: true,
          finalizedSuccess: false,
          creditedUsdc: 0,
          creditedSol: 0,
          slot: json.result.slot,
        };
      }

      // Compute exact SPL USDC credit to owner
      const preByIdx = new Map<number, number>();
      for (const b of meta.preTokenBalances ?? []) {
        if (b.mint === usdcMint && b.owner === owner) {
          preByIdx.set(b.accountIndex, Number(b.uiTokenAmount?.uiAmount ?? 0));
        }
      }
      let creditedUsdc = 0;
      for (const b of meta.postTokenBalances ?? []) {
        if (b.mint === usdcMint && b.owner === owner) {
          const postAmt = Number(b.uiTokenAmount?.uiAmount ?? 0);
          const preAmt = preByIdx.get(b.accountIndex) ?? 0;
          if (postAmt > preAmt) creditedUsdc += postAmt - preAmt;
        }
      }

      // Compute exact native SOL credit to owner account
      let creditedSol = 0;
      const keys = (json.result.transaction?.message?.accountKeys ?? []).map((k) =>
        typeof k === 'string' ? k : k.pubkey ?? ''
      );
      const ownerIdx = keys.findIndex((k) => k === owner);
      if (
        ownerIdx >= 0 &&
        Array.isArray(meta.preBalances) &&
        Array.isArray(meta.postBalances) &&
        meta.postBalances[ownerIdx] > meta.preBalances[ownerIdx]
      ) {
        creditedSol = (meta.postBalances[ownerIdx] - meta.preBalances[ownerIdx]) / 1e9;
      }

      return {
        found: true,
        finalizedSuccess: true,
        creditedUsdc: Number(creditedUsdc.toFixed(6)),
        creditedSol: Number(creditedSol.toFixed(9)),
        slot: json.result.slot,
      };
    } catch {
      clearTimeout(timer);
    }
  }

  return { found: false, finalizedSuccess: false, creditedUsdc: 0, creditedSol: 0 };
}

/**
 * Generates a real-time verifiable Pre-Sign Proof BEFORE the user signs:
 *  - Decodes every call & verifies Circle CCTP bytes32 matches the canonical Solana USDC ATA PDA
 *  - Runs live EVM RPC `eth_call` preflight and inspects BOTH `simRes.error` AND `simRes.result`
 *  - Snapshots live Solana Mainnet balance server-side for tamper-resistant post-execution delta proofs
 *  - Emits a deterministic canonical SHA-256 proof digest
 */
export async function buildPreSignSimulationProof(params: {
  batch: PreparedChainBatch;
  assets: ScannedAsset[];
  nativePriceUsd?: number;
  estimatedGasUsd?: number;
}): Promise<PreSignSimulationProof> {
  const { batch, assets } = params;
  const cfg = EVM_CHAINS[batch.chain];
  // CRIT-04: Circle CCTP mintRecipient MUST be the canonical 32-byte Solana USDC ATA PDA
  const solanaUsdcAta = deriveSolanaUsdcAta(batch.solanaDestination).toBase58();
  const expectedBytes32 = solanaOwnerToUsdcAtaBytes32(batch.solanaDestination);

  // Parallel live RPC checks: blockNumber, user native balance, Solana pre-sweep balance snapshot
  const [blockRes, balRes, solSnap] = await Promise.all([
    evmJsonRpcCall<string>(cfg.rpcUrls, 'eth_blockNumber', [], 4000).catch(() => ({ result: '0x0' })),
    evmJsonRpcCall<string>(cfg.rpcUrls, 'eth_getBalance', [batch.userAddress, 'latest'], 4000).catch(
      () => ({ result: '0x0' })
    ),
    fetchSolanaWalletBalances(batch.solanaDestination).catch(() => null),
  ]);

  const blockNumber = blockRes.result ? Number(BigInt(blockRes.result)) : 0;
  const nativeBalanceWei = balRes.result ? BigInt(balRes.result) : 0n;
  const nativeBalanceUi = Number(formatUnits(nativeBalanceWei, 18).toFixed(5));
  const fallbackNativePrice =
    cfg.nativeSymbol === 'ETH'
      ? 2000
      : cfg.nativeSymbol === 'BNB'
      ? 600
      : cfg.nativeSymbol === 'AVAX'
      ? 25
      : 0.4;
  const nativePrice = params.nativePriceUsd ?? fallbackNativePrice;
  const nativeBalanceUsd = Number((nativeBalanceUi * nativePrice).toFixed(2));
  const estimatedGasUsd = Number(
    (
      params.estimatedGasUsd ??
      assets.reduce((s, a) => s + (a.batchedGasUsd || a.estimatedGasUsd || 0), 0)
    ).toFixed(2)
  );
  const hasEnoughNativeGas = nativeBalanceUsd >= Math.max(0.15, estimatedGasUsd * 1.35);

  let mintRecipientVerified = true;
  const warnings: string[] = [];
  if (!hasEnoughNativeGas) {
    warnings.push(
      `Wallet has ${nativeBalanceUi} ${cfg.nativeSymbol} (~$${nativeBalanceUsd.toFixed(2)}) on ${cfg.name}, below safe gas threshold (~$${(estimatedGasUsd * 1.35).toFixed(2)}). Use 1-Signature Sponsored Gasless Sweep.`
    );
  }

  // Track mutating calls per asset/target instead of a single global flag (MED-10)
  const mutatedAssets = new Set<string>();
  let probesRun = 0;
  const checks: DecodedCallCheck[] = [];

  for (const call of batch.calls) {
    const decoded = decodeCallSummary(call.to, call.data, call.value);

    // CRIT-04 / CRIT-05: Verify Circle CCTP V1 & V2 mintRecipient bytes32 matches canonical Solana USDC ATA PDA!
    if (decoded.actionType === 'cctp_deposit_for_burn' && call.data.length >= 202) {
      const encodedRecipient = '0x' + call.data.slice(138, 202).toLowerCase();
      if (encodedRecipient !== expectedBytes32.toLowerCase()) {
        mintRecipientVerified = false;
        warnings.push(
          'CRITICAL: CCTP mintRecipient bytes32 does not match canonical Solana USDC ATA PDA!'
        );
      }
    }

    const assetMutated = mutatedAssets.has(call.assetId);
    const isDependent =
      assetMutated &&
      (decoded.actionType === 'bridge_or_swap' ||
        decoded.actionType === 'cctp_deposit_for_burn' ||
        call.stepId.includes('after_defi'));

    let preflightStatus: DecodedCallCheck['preflightStatus'] = 'dependent_ok';
    let preflightDetail = 'Sequenced after prior approval/withdrawal for this asset in atomic bundle';

    if (!isDependent && probesRun < 12 && call.data && call.data !== '0x') {
      probesRun += 1;
      try {
        // CRIT-10: NEVER discard evmJsonRpcCall return value! Inspect simRes.error AND simRes.result.
        const simRes = await evmJsonRpcCall<string>(
          cfg.rpcUrls,
          'eth_call',
          [{ from: batch.userAddress, to: call.to, data: call.data, value: call.value || '0x0' }, 'latest'],
          3500
        );

        if (simRes.error) {
          const errMsg = simRes.error.message || `JSON-RPC error code ${simRes.error.code ?? 'unknown'}`;
          preflightStatus = 'reverted';
          preflightDetail = `Reverted in eth_call: ${errMsg.slice(0, 120)}`;
          warnings.push(`${call.assetSymbol}: ${preflightDetail}`);
        } else if (simRes.result === undefined) {
          preflightStatus = 'rpc_skipped';
          preflightDetail = 'RPC returned empty eth_call result';
        } else if (
          (decoded.actionType === 'erc20_approve' ||
            decoded.actionType === 'erc20_transfer' ||
            decoded.actionType === 'burn_dead') &&
          isFalseErc20BoolReturn(simRes.result)
        ) {
          preflightStatus = 'reverted';
          preflightDetail = 'ERC-20 call returned false in eth_call simulation';
          warnings.push(`${call.assetSymbol}: ${preflightDetail}`);
        } else {
          preflightStatus = 'verified';
          preflightDetail =
            blockNumber > 0
              ? `eth_call passed at block #${blockNumber.toLocaleString()}`
              : 'eth_call simulation passed';
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'simulation reverted';
        if (msg.toLowerCase().includes('revert') || msg.toLowerCase().includes('execution reverted')) {
          preflightStatus = 'reverted';
          preflightDetail = `Reverted in eth_call: ${msg.slice(0, 120)}`;
          warnings.push(`${call.assetSymbol}: ${preflightDetail}`);
        } else {
          preflightStatus = 'rpc_skipped';
          preflightDetail = 'RPC state check skipped (node unreachable)';
        }
      }
    } else if (!isDependent && call.data === '0x') {
      let sendWei = 0n;
      try {
        sendWei = BigInt(call.value || '0x0');
      } catch {
        sendWei = 0n;
      }
      if (sendWei > nativeBalanceWei) {
        preflightStatus = 'reverted';
        preflightDetail = 'Insufficient native balance for value transfer';
        warnings.push(`${call.assetSymbol}: ${preflightDetail}`);
      } else {
        preflightStatus = 'verified';
        preflightDetail = 'Native transfer value verified against live balance';
      }
    } else if (!isDependent) {
      preflightStatus = 'rpc_skipped';
      preflightDetail = 'Skipped preflight probe (probe budget reached)';
    }

    if (
      decoded.actionType === 'erc20_approve' ||
      decoded.actionType === 'aave_v3_withdraw' ||
      decoded.actionType === 'compound_v3_withdraw' ||
      decoded.actionType === 'compound_v2_redeem' ||
      decoded.actionType === 'erc4626_redeem' ||
      decoded.actionType === 'uniswap_v2_remove_liquidity' ||
      decoded.actionType === 'uniswap_v3_nft_multicall'
    ) {
      mutatedAssets.add(call.assetId);
    }

    checks.push({
      stepId: call.stepId,
      assetSymbol: call.assetSymbol,
      actionType: decoded.actionType,
      target: call.to,
      summary: decoded.summary,
      preflightStatus,
      preflightDetail,
    });
  }

  const grossUsd = Number(
    assets
      .filter(
        (a) =>
          a.action !== 'BURN_ZERO_LIQUIDITY' &&
          a.action !== 'SKIP_HONEYPOT' &&
          a.action !== 'SKIP_UNPRICED'
      )
      .reduce((s, a) => s + a.grossUsd, 0)
      .toFixed(2)
  );
  const feeUsd = batch.feeBreakdown.estimatedFeeUsd;
  const solanaAtaRentUsd = solSnap
    ? estimateSolanaAtaRentUsd({ hasUsdcAta: solSnap.hasUsdcAta, solPriceUsd: 70 })
    : 0;
  const bridgeAndSlippageUsd = Number(
    (
      estimateBridgeFixedFeeUsd(batch.chain) +
      assets
        .filter(
          (a) =>
            a.action !== 'BURN_ZERO_LIQUIDITY' &&
            a.action !== 'SKIP_HONEYPOT' &&
            a.action !== 'SKIP_UNPRICED'
        )
        .reduce((s, a) => s + (a.estimatedSlippageUsd || 0), 0)
    ).toFixed(2)
  );
  const liveNetUsd = Number(
    (grossUsd - feeUsd - estimatedGasUsd - bridgeAndSlippageUsd - solanaAtaRentUsd).toFixed(2)
  );
  const estimatedNetUsd = Number(Math.max(0, liveNetUsd).toFixed(2));
  const guaranteedMinNetUsd = Number((estimatedNetUsd * 0.985).toFixed(2));
  const effectiveCostPct =
    grossUsd > 0 ? Number((((grossUsd - liveNetUsd) / grossUsd) * 100).toFixed(2)) : 100;
  const roiVerdict = classifyRoiVerdict(liveNetUsd, effectiveCostPct);
  const haircutDroppedAssets = batch.skippedAssets.filter((s) =>
    s.reason.toLowerCase().includes('haircut')
  );
  if (haircutDroppedAssets.length > 0) {
    warnings.push(
      `Live Quote Haircut Gate dropped ${haircutDroppedAssets.length} asset(s) exceeding 50% cost cap.`
    );
  }

  const allChecksSafe =
    mintRecipientVerified && !checks.some((c) => c.preflightStatus === 'reverted');

  const proofId = `prf_${crypto.randomBytes(6).toString('hex')}`;
  const preSolanaSnapshot = solSnap
    ? {
        usdcBalance: solSnap.usdcBalance,
        solBalance: solSnap.solBalance,
        hasUsdcAta: solSnap.hasUsdcAta,
        slot: solSnap.slot,
      }
    : undefined;

  const quotedCostBreakdown = {
    grossUsd,
    estimatedGasUsd,
    bridgeAndSlippageUsd,
    protocolFeeUsd: feeUsd,
    solanaAtaRentUsd,
    liveNetUsd,
    effectiveCostPct,
    roiVerdict,
    routeStrategy: (assets.length > 1 ? 'local_batch_single_bridge' : 'direct_per_token_bridge') as
      | 'local_batch_single_bridge'
      | 'direct_per_token_bridge',
  };

  const proofPayload = {
    schemaVersion: 'turgalium-presign-proof-v1',
    proofId,
    chainId: cfg.chainId,
    blockNumber,
    userAddress: batch.userAddress.toLowerCase(),
    solanaDestination: batch.solanaDestination,
    solanaUsdcAta,
    solanaMintRecipientBytes32: expectedBytes32,
    mintRecipientVerified,
    allChecksSafe,
    outputAsset: batch.outputAsset,
    calls: batch.calls.map((c) => ({ to: c.to.toLowerCase(), data: c.data, value: c.value })),
    checks,
    feeBreakdown: batch.feeBreakdown,
    quotedCostBreakdown,
    preSolanaSnapshot: preSolanaSnapshot ?? null,
    guaranteedMinNetUsd,
  };
  const proofDigestSha256 =
    '0x' + crypto.createHash('sha256').update(canonicalizeJson(proofPayload)).digest('hex');

  // Persist server-side pre-sign snapshot so verifyOnchainExecutionProof never trusts client-forged pre-state (CRIT-11)
  preSignProofStore.set(proofId, {
    proofId,
    chain: batch.chain,
    chainId: cfg.chainId,
    blockNumber,
    userAddress: batch.userAddress.toLowerCase(),
    solanaDestination: batch.solanaDestination.trim(),
    solanaUsdcAta,
    outputAsset: batch.outputAsset,
    expectedMinNetUsd: guaranteedMinNetUsd,
    preSolanaSnapshot,
    createdAt: Date.now(),
  });
  if (preSignProofStore.size > MAX_STORED_PROOFS) {
    const oldest = preSignProofStore.keys().next().value;
    if (oldest) preSignProofStore.delete(oldest);
  }

  return {
    proofId,
    proofDigestSha256,
    proofDigestAlgorithm: 'sha256-canonical-json-v1',
    generatedAt: new Date().toISOString(),
    chain: batch.chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    blockNumber,
    userAddress: batch.userAddress,
    solanaDestination: batch.solanaDestination,
    solanaUsdcAta,
    solanaMintRecipientBytes32: expectedBytes32,
    mintRecipientVerified,
    hasEnoughNativeGas,
    nativeBalanceUi,
    nativeSymbol: cfg.nativeSymbol,
    nativeBalanceUsd,
    estimatedGasUsd,
    recommendedMode: !hasEnoughNativeGas
      ? 'sponsored_gasless'
      : batch.calls.length > 1
      ? 'eip5792_batch'
      : 'sequential',
    outflows: assets
      .filter((a) => a.action !== 'SKIP_HONEYPOT' && a.action !== 'SKIP_UNPRICED')
      .map((a) => ({
        symbol: a.symbol,
        amount: a.uiBalance,
        usd: a.grossUsd,
        action: a.action,
      })),
    protocolFee: {
      feeBps: batch.feeBreakdown.feeBps,
      feePercent: batch.feeBreakdown.feePercent,
      estimatedFeeUsd: feeUsd,
      feeRecipientEvm: batch.feeBreakdown.feeRecipientEvm,
      collectionMethod: batch.feeBreakdown.collectionMethod,
    },
    guaranteedMinNetUsd,
    estimatedNetUsd,
    outputAsset: batch.outputAsset,
    quotedCostBreakdown,
    haircutDroppedAssets: haircutDroppedAssets.length ? haircutDroppedAssets : undefined,
    preSolanaSnapshot,
    checks,
    allChecksSafe,
    warnings,
  };
}

/**
 * Decodes real onchain ERC-20 Transfer logs from an EVM receipt and verifies
 * exact post-execution settlement across EVM + Bridge (Relay/CCTP) + finalized Solana settlement.
 *
 * Hardening (CRIT-11, MED-11):
 *  - Rejects forged client preSolanaUsdc/preSolanaSol (never uses untrusted client pre-state to certify delivery)
 *  - Validates EVM receipt `from`, chain, block >= preSignBlock, status === '0x1', and single-use txHash replay guard
 *  - Binds Relay `requestId` strictly to `params.txHash` and `params.solanaDestination`
 *  - Separates `cctp_attested_awaiting_solana_mint` from `solana_settled` (requires finalized Solana tx verification)
 *  - Preserves 18-decimal USDC/USDB metadata on BNB Chain / Blast and filters out 4-topic ERC-721 Transfer logs
 *  - Computes deterministic canonical JSON SHA-256 content digest across all binding fields
 */
export async function verifyOnchainExecutionProof(params: {
  chain: EvmChainId;
  txHash: string;
  userAddress?: string;
  solanaDestination: string;
  requestId?: string;
  provider?: string;
  feeRecipientEvm?: string | null;
  preSolanaUsdc?: number;
  preSolanaSol?: number;
  proofId?: string;
  solanaTxHash?: string;
  expectedMinNetOut?: number;
}): Promise<OnchainExecutionProof> {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) throw new Error(`Unsupported chain: ${params.chain}`);
  const cleanTxHash = params.txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(cleanTxHash)) {
    throw new Error(`Invalid EVM txHash: ${params.txHash}`);
  }
  const solanaUsdcAta = deriveSolanaUsdcAta(params.solanaDestination).toBase58();
  const boundPreSign = params.proofId ? preSignProofStore.get(params.proofId) ?? null : null;
  const rejectionReasons: string[] = [];

  if (params.proofId && !boundPreSign) {
    rejectionReasons.push(`Unknown or expired pre-sign proofId (${params.proofId}).`);
  }
  if (boundPreSign) {
    if (boundPreSign.chain !== params.chain) {
      rejectionReasons.push(`Chain mismatch with pre-sign proof (${boundPreSign.chain} != ${params.chain}).`);
    }
    if (boundPreSign.solanaDestination !== params.solanaDestination.trim()) {
      rejectionReasons.push('Solana destination mismatch with pre-sign proof.');
    }
    if (
      params.userAddress &&
      boundPreSign.userAddress !== params.userAddress.trim().toLowerCase()
    ) {
      rejectionReasons.push('User address mismatch with pre-sign proof.');
    }
  }

  // Single-use EVM txHash replay guard across distinct users / destinations
  const txReplayKey = `${params.chain}:${cleanTxHash}`;
  const priorVerified = verifiedEvmTxStore.get(txReplayKey);
  if (priorVerified) {
    const reqUser = (boundPreSign?.userAddress ?? params.userAddress?.trim().toLowerCase()) || null;
    if (
      priorVerified.solanaDestination !== params.solanaDestination.trim() ||
      (reqUser && priorVerified.userAddress && priorVerified.userAddress !== reqUser)
    ) {
      rejectionReasons.push(
        `EVM txHash ${cleanTxHash} was already bound to another verified execution proof (replay rejected).`
      );
    }
  }

  const [receiptRes, liveStatus, postSol] = await Promise.all([
    evmJsonRpcCall<{
      status?: string;
      from?: string;
      to?: string;
      blockNumber?: string;
      gasUsed?: string;
      effectiveGasPrice?: string;
      logs?: Array<{ address?: string; topics?: string[]; data?: string }>;
    } | null>(cfg.rpcUrls, 'eth_getTransactionReceipt', [cleanTxHash], 5000).catch(() => ({
      result: null,
    })),
    checkLiveExecutionStatus({
      chain: params.chain,
      txHash: cleanTxHash,
      requestId: params.requestId,
      provider: params.provider,
    }).catch(() => ({
      evmConfirmed: false,
      evmFailed: false,
      bridgeStatus: 'pending',
      solanaTxHash: undefined as string | undefined,
      relayBoundToTx: false,
      relayDestinationRecipient: undefined as string | undefined,
    })),
    fetchSolanaWalletBalances(params.solanaDestination).catch(() => null),
  ]);

  const receipt = receiptRes.result;
  const found = Boolean(receipt);
  const succeeded = receipt?.status === '0x1';
  const receiptFrom = receipt?.from?.toLowerCase();
  const blockNumber = receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : undefined;
  const gasUsedBig = receipt?.gasUsed ? BigInt(receipt.gasUsed) : 0n;
  const gasPriceBig = receipt?.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice) : 0n;
  const gasCostNative =
    gasUsedBig > 0n && gasPriceBig > 0n
      ? Number(formatUnits(gasUsedBig * gasPriceBig, 18).toFixed(6))
      : undefined;

  // Validate EVM receipt sender (`from`) against expected userAddress / preSignProof
  const expectedUserLower = (boundPreSign?.userAddress ?? params.userAddress?.trim().toLowerCase()) || undefined;
  let senderVerified: boolean | undefined;
  if (found && expectedUserLower) {
    senderVerified = Boolean(receiptFrom && receiptFrom === expectedUserLower);
    if (!senderVerified) {
      rejectionReasons.push(
        `EVM receipt sender (${receiptFrom ?? 'missing'}) does not match expected userAddress (${expectedUserLower}).`
      );
    }
  }

  // Validate blockNumber >= preSignBlock when bound to a pre-sign proof (blocks historical tx replay)
  if (boundPreSign && blockNumber !== undefined && boundPreSign.blockNumber > 0) {
    if (blockNumber < boundPreSign.blockNumber) {
      rejectionReasons.push(
        `Historical EVM tx replay rejected: tx block #${blockNumber} precedes pre-sign proof block #${boundPreSign.blockNumber}.`
      );
    }
  }

  // MED-11: Preserve 18-decimal USDC/USDB entries from TOKEN_REGISTRY (e.g. BNB Chain & Blast) before applying 6-decimal fallback
  const tokenMap = new Map<string, { symbol: string; decimals: number }>();
  for (const t of TOKEN_REGISTRY) {
    if (t.chain === params.chain) {
      tokenMap.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
    }
  }
  if (!tokenMap.has(cfg.usdcAddress.toLowerCase())) {
    tokenMap.set(cfg.usdcAddress.toLowerCase(), { symbol: 'USDC', decimals: 6 });
  }

  const feeLower = params.feeRecipientEvm?.toLowerCase();
  const decodedTransfers: DecodedTransferLog[] = [];

  for (const log of receipt?.logs ?? []) {
    // MED-11: Strictly 3 topics for ERC-20 Transfer (excludes 4-topic ERC-721 Transfer) and 32-byte hex data
    if (
      log.topics?.[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC ||
      log.topics?.length !== 3 ||
      !log.address ||
      !log.data ||
      !/^0x[0-9a-fA-F]{64}$/.test(log.data)
    ) {
      continue;
    }
    const tokenAddr = log.address.toLowerCase();
    const from = '0x' + log.topics[1].slice(-40).toLowerCase();
    const to = '0x' + log.topics[2].slice(-40).toLowerCase();
    const rawVal = BigInt(log.data);
    const meta = tokenMap.get(tokenAddr) ?? { symbol: `${tokenAddr.slice(0, 6)}…`, decimals: 18 };
    const amountUi = Number(formatUnits(rawVal, meta.decimals).toFixed(6));

    let category: DecodedTransferLog['category'] = 'other';
    if (to === DEAD_BURN_ADDRESS.toLowerCase()) category = 'burn_dead';
    else if (to === '0x0000000000000000000000000000000000000000' && tokenAddr === cfg.usdcAddress.toLowerCase()) {
      category = 'cctp_burn';
    } else if (feeLower && to === feeLower) category = 'protocol_fee';
    else if (expectedUserLower && from === expectedUserLower) category = 'user_outflow';

    decodedTransfers.push({
      tokenAddress: log.address,
      symbol: meta.symbol,
      from,
      to,
      amountUi,
      category,
    });
  }

  let cctpMessageHash: string | undefined;
  let cctpAttestationStatus: string | undefined;
  if (succeeded && (params.provider === 'circle_cctp' || decodedTransfers.some((t) => t.category === 'cctp_burn'))) {
    const att = await fetchCctpAttestationForTx({
      chain: params.chain,
      txHash: cleanTxHash,
      solanaDestination: params.solanaDestination,
    }).catch(() => null);
    if (att?.found) {
      cctpMessageHash = att.messageHash;
      cctpAttestationStatus = att.attestationStatus;
    }
  }

  // CRIT-11: Validate Relay requestId binding to params.txHash and params.solanaDestination
  let relayVerified = false;
  if (params.provider === 'relay' && params.requestId) {
    const recipientMatches =
      !liveStatus.relayDestinationRecipient ||
      liveStatus.relayDestinationRecipient.trim() === params.solanaDestination.trim();
    if (liveStatus.bridgeStatus === 'success') {
      if (!liveStatus.relayBoundToTx) {
        rejectionReasons.push(
          `Relay requestId (${params.requestId}) is not cryptographically bound to EVM txHash ${cleanTxHash}.`
        );
      } else if (!recipientMatches) {
        rejectionReasons.push(
          `Relay requestId destination (${liveStatus.relayDestinationRecipient}) does not match solanaDestination.`
        );
      } else {
        relayVerified = true;
      }
    }
  }

  // CRIT-11: Verify finalized Solana settlement transaction when a Solana tx signature is available
  const candidateSolanaTxHash = params.solanaTxHash?.trim() || liveStatus.solanaTxHash;
  let solanaTxFinalized = false;
  let solanaTxCreditedEnough = false;
  const minExpectedOut =
    params.expectedMinNetOut ?? (boundPreSign ? boundPreSign.expectedMinNetUsd : 0);

  if (candidateSolanaTxHash && succeeded && rejectionReasons.length === 0) {
    const solTx = await verifyFinalizedSolanaSettlementTx({
      solanaTxHash: candidateSolanaTxHash,
      solanaDestination: params.solanaDestination,
    });
    solanaTxFinalized = solTx.finalizedSuccess;
    if (solTx.finalizedSuccess) {
      const creditedPrimary =
        boundPreSign?.outputAsset === 'SOL' ? solTx.creditedSol : solTx.creditedUsdc;
      const anyMeaningfulCredit = solTx.creditedUsdc > 0 || solTx.creditedSol > 0;
      solanaTxCreditedEnough =
        minExpectedOut > 0 && boundPreSign?.outputAsset !== 'SOL'
          ? creditedPrimary >= minExpectedOut
          : anyMeaningfulCredit;
      if (!solanaTxCreditedEnough) {
        rejectionReasons.push(
          `Finalized Solana settlement tx ${candidateSolanaTxHash} credited insufficient output (USDC=${solTx.creditedUsdc}, SOL=${solTx.creditedSol}, minExpected=${minExpectedOut}).`
        );
      }
    }
  }

  // CRIT-11: NEVER trust forged client preSolanaUsdc/preSolanaSol! Only use server-captured preSignProof snapshot.
  const clientProvidedPreState =
    typeof params.preSolanaUsdc === 'number' || typeof params.preSolanaSol === 'number';
  const trustedPreSnap = boundPreSign?.preSolanaSnapshot;
  const solanaDeltaProof = postSol
    ? {
        address: postSol.address,
        usdcAta: solanaUsdcAta,
        trustedPreStateSource: (trustedPreSnap ? 'server_presign_proof' : 'none') as
          | 'server_presign_proof'
          | 'none',
        clientPreStateIgnored: !trustedPreSnap && clientProvidedPreState ? true : undefined,
        preUsdc: trustedPreSnap?.usdcBalance,
        postUsdc: postSol.usdcBalance,
        deltaUsdc:
          trustedPreSnap !== undefined
            ? Number((postSol.usdcBalance - trustedPreSnap.usdcBalance).toFixed(4))
            : undefined,
        preSol: trustedPreSnap?.solBalance,
        postSol: postSol.solBalance,
        deltaSol:
          trustedPreSnap !== undefined
            ? Number((postSol.solBalance - trustedPreSnap.solBalance).toFixed(6))
            : undefined,
        verifiedAtSlot: postSol.slot,
      }
    : undefined;

  if (!trustedPreSnap && clientProvidedPreState) {
    rejectionReasons.push(
      'Client-supplied preSolanaUsdc/preSolanaSol ignored: bind to a server-issued pre-sign proofId for trusted delta verification.'
    );
  }

  // CRIT-11: Strict settlement stage & verification logic:
  //   - Never certify `verified = true` on forged client pre-state, unrelated 1-lamport deposits,
  //     sender/block mismatches, unbound Relay requestIds, or Circle CCTP Iris attestation alone!
  const hasBlockingRejection = rejectionReasons.some(
    (r) => !r.startsWith('Client-supplied preSolanaUsdc/preSolanaSol ignored')
  );

  let settlementStage: OnchainExecutionProof['settlementStage'];
  let verified = false;

  if (!found) {
    settlementStage = 'unconfirmed';
  } else if (!succeeded) {
    settlementStage = 'reverted';
  } else if (hasBlockingRejection) {
    settlementStage = 'rejected_mismatch';
  } else if ((solanaTxFinalized && solanaTxCreditedEnough) || (relayVerified && Boolean(liveStatus.solanaTxHash) && solanaTxFinalized)) {
    settlementStage = 'solana_settled';
    verified = true;
  } else if (cctpAttestationStatus === 'complete') {
    // CCTP Iris attestation ready does NOT mean USDC has minted on Solana yet!
    settlementStage = 'cctp_attested_awaiting_solana_mint';
    verified = false;
  } else {
    settlementStage = 'evm_confirmed_awaiting_bridge';
    verified = false;
  }

  const canonicalProofObject = {
    schemaVersion: 'turgalium-execution-proof-v1',
    chain: params.chain,
    chainId: cfg.chainId,
    txHash: cleanTxHash,
    userAddress: expectedUserLower ?? null,
    receiptFrom: receiptFrom ?? null,
    senderVerified: senderVerified ?? null,
    solanaDestination: params.solanaDestination.trim(),
    solanaUsdcAta,
    blockNumber: blockNumber ?? null,
    succeeded,
    settlementStage,
    verified,
    transfers: decodedTransfers,
    relayBoundToTx: liveStatus.relayBoundToTx ?? false,
    solanaTxHash: candidateSolanaTxHash ?? null,
    solanaTxFinalized,
    cctpMessageHash: cctpMessageHash ?? null,
    cctpAttestationStatus: cctpAttestationStatus ?? null,
    solanaDeltaProof: solanaDeltaProof ?? null,
  };
  const proofDigestSha256 =
    '0x' + crypto.createHash('sha256').update(canonicalizeJson(canonicalProofObject)).digest('hex');

  if (verified) {
    verifiedEvmTxStore.set(txReplayKey, {
      txHash: cleanTxHash,
      chain: params.chain,
      userAddress: expectedUserLower ?? receiptFrom ?? null,
      solanaDestination: params.solanaDestination.trim(),
      proofDigestSha256,
    });
    if (verifiedEvmTxStore.size > MAX_STORED_PROOFS) {
      const oldest = verifiedEvmTxStore.keys().next().value;
      if (oldest) verifiedEvmTxStore.delete(oldest);
    }
  }

  const summary = !found
    ? 'Transaction receipt not yet indexed on EVM RPC.'
    : !succeeded
    ? 'EVM transaction reverted onchain.'
    : hasBlockingRejection
    ? `Execution proof rejected: ${rejectionReasons.filter((r) => !r.startsWith('Client-supplied')).join(' ')}`
    : verified
    ? `Verified on ${cfg.name} block #${blockNumber?.toLocaleString() ?? '—'} + finalized Solana settlement proven.`
    : settlementStage === 'cctp_attested_awaiting_solana_mint'
    ? `Confirmed on ${cfg.name} block #${blockNumber?.toLocaleString() ?? '—'} · Circle CCTP Iris attestation complete; awaiting finalized Solana receiveMessage mint.`
    : `Confirmed on ${cfg.name} block #${blockNumber?.toLocaleString() ?? '—'} (${decodedTransfers.length} ERC-20 transfer logs decoded) · awaiting finalized Solana settlement.`;

  return {
    verified,
    settlementStage,
    proofDigestSha256,
    proofDigestAlgorithm: 'sha256-canonical-json-v1',
    proofDigestNote:
      'Deterministic RFC-8785-style canonical JSON SHA-256 content digest over EVM receipt, decoded transfers, and settlement state (unsigned content hash).',
    verifiedAt: new Date().toISOString(),
    chain: params.chain,
    chainName: cfg.name,
    txHash: cleanTxHash,
    explorerUrl: `${cfg.explorerUrl}/tx/${cleanTxHash}`,
    evmReceipt: {
      found,
      succeeded,
      from: receiptFrom,
      senderVerified,
      blockNumber,
      gasUsed: gasUsedBig > 0n ? gasUsedBig.toString() : undefined,
      gasCostNative,
      nativeSymbol: cfg.nativeSymbol,
    },
    decodedTransfers,
    bridgeProof: {
      provider: params.provider || 'evm',
      status: liveStatus.bridgeStatus,
      relayBoundToTx: liveStatus.relayBoundToTx,
      solanaTxHash: candidateSolanaTxHash,
      solanaTxFinalized,
      cctpMessageHash,
      cctpAttestationStatus,
    },
    solanaDeltaProof,
    rejectionReasons: rejectionReasons.length ? rejectionReasons : undefined,
    summary,
  };
}
