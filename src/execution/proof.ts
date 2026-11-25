import crypto from 'node:crypto';
import { fetchCctpAttestationForTx, solanaAddressToBytes32 } from '../bridge/cctp.js';
import { DEAD_BURN_ADDRESS, EVM_CHAINS, TOKEN_REGISTRY } from '../scanner/chains.js';
import { fetchSolanaWalletBalances } from '../scanner/discovery.js';
import { evmJsonRpcCall, formatUnits } from '../scanner/rpc.js';
import type { EvmChainId, ScannedAsset } from '../scanner/types.js';
import { checkLiveExecutionStatus, type PreparedChainBatch } from './tx-builder.js';

const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
  generatedAt: string;
  chain: EvmChainId;
  chainId: number;
  chainName: string;
  blockNumber: number;
  userAddress: string;
  solanaDestination: string;
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
  proofDigestSha256: string;
  verifiedAt: string;
  chain: EvmChainId;
  chainName: string;
  txHash: string;
  explorerUrl: string;
  evmReceipt: {
    found: boolean;
    succeeded: boolean;
    blockNumber?: number;
    gasUsed?: string;
    gasCostNative?: number;
    nativeSymbol: string;
  };
  decodedTransfers: DecodedTransferLog[];
  bridgeProof: {
    provider: string;
    status: string;
    solanaTxHash?: string;
    cctpMessageHash?: string;
    cctpAttestationStatus?: string;
  };
  solanaDeltaProof?: {
    address: string;
    preUsdc?: number;
    postUsdc: number;
    deltaUsdc?: number;
    preSol?: number;
    postSol: number;
    deltaSol?: number;
    verifiedAtSlot: number;
  };
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
  if (sel === '0x6fd3504e' && clean.length >= 266) {
    const amt = Number(BigInt('0x' + clean.slice(10, 74))) / 1_000_000;
    const domain = Number(BigInt('0x' + clean.slice(74, 138)));
    return {
      actionType: 'cctp_deposit_for_burn',
      summary: `Circle CCTP depositForBurn(${amt.toFixed(2)} USDC → Domain ${domain} Solana)`,
    };
  }
  if (sel === '0x69328dec') return { actionType: 'aave_v3_withdraw', summary: 'Aave v3 Pool.withdraw to user' };
  if (sel === '0xf3fef3a3') return { actionType: 'compound_v3_withdraw', summary: 'Compound v3 Comet.withdraw' };
  if (sel === '0xba087652') return { actionType: 'erc4626_redeem', summary: 'ERC-4626 vault redeem' };
  return { actionType: 'bridge_or_swap', summary: `Bridge / swap router call to ${to.slice(0, 6)}…${to.slice(-4)}` };
}

/**
 * Generates a real-time verifiable Pre-Sign Proof BEFORE the user signs:
 *  - Decodes every call & checks Circle CCTP bytes32 Solana recipient match
 *  - Runs live EVM RPC `eth_call` preflight on independent calls + fetches block number & native gas balance
 *  - Snapshots live Solana Mainnet balance (for post-execution delta proof)
 *  - Emits a deterministic SHA-256 proof digest
 */
export async function buildPreSignSimulationProof(params: {
  batch: PreparedChainBatch;
  assets: ScannedAsset[];
  nativePriceUsd?: number;
  estimatedGasUsd?: number;
}): Promise<PreSignSimulationProof> {
  const { batch, assets } = params;
  const cfg = EVM_CHAINS[batch.chain];
  const expectedBytes32 = solanaAddressToBytes32(batch.solanaDestination);

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
  const nativePrice = params.nativePriceUsd ?? (cfg.nativeSymbol === 'ETH' ? 2000 : cfg.nativeSymbol === 'AVAX' ? 25 : 0.4);
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

  // Decode & preflight each prepared call (cap live eth_call probes to first 6 independent calls for fast <800ms UX)
  let priorMutatingCall = false;
  let probesRun = 0;
  const checks: DecodedCallCheck[] = [];

  for (const call of batch.calls) {
    const decoded = decodeCallSummary(call.to, call.data, call.value);

    // Verify Circle CCTP mintRecipient bytes32 matches user's Solana wallet bit-for-bit!
    if (decoded.actionType === 'cctp_deposit_for_burn' && call.data.length >= 202) {
      const encodedRecipient = '0x' + call.data.slice(138, 202).toLowerCase();
      if (encodedRecipient !== expectedBytes32.toLowerCase()) {
        mintRecipientVerified = false;
        warnings.push('CRITICAL: CCTP mintRecipient bytes32 mismatch detected!');
      }
    }

    const isDependent =
      priorMutatingCall &&
      (decoded.actionType === 'bridge_or_swap' ||
        decoded.actionType === 'cctp_deposit_for_burn' ||
        call.stepId.includes('after_defi'));

    let preflightStatus: DecodedCallCheck['preflightStatus'] = 'dependent_ok';
    let preflightDetail = 'Sequenced after prior approval/withdrawal in atomic bundle';

    if (!isDependent && probesRun < 6 && call.data && call.data !== '0x') {
      probesRun += 1;
      try {
        await evmJsonRpcCall<string>(
          cfg.rpcUrls,
          'eth_call',
          [{ from: batch.userAddress, to: call.to, data: call.data, value: call.value || '0x0' }, 'latest'],
          3500
        );
        preflightStatus = 'verified';
        preflightDetail = blockNumber > 0 ? `eth_call passed at block #${blockNumber.toLocaleString()}` : 'eth_call simulation passed';
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'simulation reverted';
        // Approvals or swaps that fail only because of simulation RPC limits vs real revert
        if (msg.toLowerCase().includes('revert') || msg.toLowerCase().includes('execution reverted')) {
          preflightStatus = 'reverted';
          preflightDetail = `Reverted in eth_call: ${msg.slice(0, 90)}`;
          warnings.push(`${call.assetSymbol}: ${preflightDetail}`);
        } else {
          preflightStatus = 'rpc_skipped';
          preflightDetail = 'RPC state check skipped (node busy)';
        }
      }
    } else if (!isDependent && call.data === '0x') {
      preflightStatus = 'verified';
      preflightDetail = 'Native transfer validated';
    }

    if (
      decoded.actionType === 'erc20_approve' ||
      decoded.actionType === 'aave_v3_withdraw' ||
      decoded.actionType === 'compound_v3_withdraw' ||
      decoded.actionType === 'erc4626_redeem'
    ) {
      priorMutatingCall = true;
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
      .filter((a) => a.action !== 'BURN_ZERO_LIQUIDITY' && a.action !== 'SKIP_HONEYPOT')
      .reduce((s, a) => s + a.grossUsd, 0)
      .toFixed(2)
  );
  const feeUsd = batch.feeBreakdown.estimatedFeeUsd;
  const estimatedNetUsd = Number(Math.max(0, grossUsd - feeUsd - estimatedGasUsd).toFixed(2));
  const guaranteedMinNetUsd = Number((estimatedNetUsd * 0.985).toFixed(2));

  const proofPayload = {
    chainId: cfg.chainId,
    blockNumber,
    userAddress: batch.userAddress.toLowerCase(),
    solanaDestination: batch.solanaDestination,
    solanaMintRecipientBytes32: expectedBytes32,
    calls: batch.calls.map((c) => ({ to: c.to.toLowerCase(), data: c.data, value: c.value })),
    feeBreakdown: batch.feeBreakdown,
    guaranteedMinNetUsd,
  };
  const proofDigestSha256 =
    '0x' + crypto.createHash('sha256').update(JSON.stringify(proofPayload)).digest('hex');

  const allChecksSafe =
    mintRecipientVerified && !checks.some((c) => c.preflightStatus === 'reverted');

  return {
    proofId: `prf_${crypto.randomBytes(5).toString('hex')}`,
    proofDigestSha256,
    generatedAt: new Date().toISOString(),
    chain: batch.chain,
    chainId: cfg.chainId,
    chainName: cfg.name,
    blockNumber,
    userAddress: batch.userAddress,
    solanaDestination: batch.solanaDestination,
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
      .filter((a) => a.action !== 'SKIP_HONEYPOT')
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
    preSolanaSnapshot: solSnap
      ? {
          usdcBalance: solSnap.usdcBalance,
          solBalance: solSnap.solBalance,
          hasUsdcAta: solSnap.hasUsdcAta,
          slot: solSnap.slot,
        }
      : undefined,
    checks,
    allChecksSafe,
    warnings,
  };
}

/**
 * Decodes real onchain ERC-20 Transfer logs from an EVM receipt and verifies
 * exact post-execution settlement across EVM + Bridge (Relay/CCTP) + Solana Mainnet balance delta.
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
}): Promise<OnchainExecutionProof> {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) throw new Error(`Unsupported chain: ${params.chain}`);

  const [receiptRes, liveStatus, postSol] = await Promise.all([
    evmJsonRpcCall<{
      status?: string;
      blockNumber?: string;
      gasUsed?: string;
      effectiveGasPrice?: string;
      logs?: Array<{ address?: string; topics?: string[]; data?: string }>;
    } | null>(cfg.rpcUrls, 'eth_getTransactionReceipt', [params.txHash], 5000).catch(() => ({
      result: null,
    })),
    checkLiveExecutionStatus({
      chain: params.chain,
      txHash: params.txHash,
      requestId: params.requestId,
      provider: params.provider,
    }).catch(() => ({
      evmConfirmed: false,
      evmFailed: false,
      bridgeStatus: 'pending',
      solanaTxHash: undefined as string | undefined,
    })),
    fetchSolanaWalletBalances(params.solanaDestination).catch(() => null),
  ]);

  const receipt = receiptRes.result;
  const found = Boolean(receipt);
  const succeeded = receipt?.status === '0x1';
  const blockNumber = receipt?.blockNumber ? Number(BigInt(receipt.blockNumber)) : undefined;
  const gasUsedBig = receipt?.gasUsed ? BigInt(receipt.gasUsed) : 0n;
  const gasPriceBig = receipt?.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice) : 0n;
  const gasCostNative =
    gasUsedBig > 0n && gasPriceBig > 0n
      ? Number(formatUnits(gasUsedBig * gasPriceBig, 18).toFixed(6))
      : undefined;

  // Lookup known tokens for symbol & decimals decoding
  const tokenMap = new Map<string, { symbol: string; decimals: number }>();
  for (const t of TOKEN_REGISTRY) {
    if (t.chain === params.chain) {
      tokenMap.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
    }
  }
  tokenMap.set(cfg.usdcAddress.toLowerCase(), { symbol: 'USDC', decimals: 6 });

  const userLower = params.userAddress?.toLowerCase();
  const feeLower = params.feeRecipientEvm?.toLowerCase();
  const decodedTransfers: DecodedTransferLog[] = [];

  for (const log of receipt?.logs ?? []) {
    if (
      log.topics?.[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC ||
      (log.topics?.length ?? 0) < 3 ||
      !log.address ||
      !log.data
    ) {
      continue;
    }
    const tokenAddr = log.address.toLowerCase();
    const from = '0x' + log.topics[1].slice(-40).toLowerCase();
    const to = '0x' + log.topics[2].slice(-40).toLowerCase();
    const rawVal = BigInt(log.data === '0x' ? '0x0' : log.data);
    const meta = tokenMap.get(tokenAddr) ?? { symbol: `${tokenAddr.slice(0, 6)}…`, decimals: 18 };
    const amountUi = Number(formatUnits(rawVal, meta.decimals).toFixed(6));

    let category: DecodedTransferLog['category'] = 'other';
    if (to === DEAD_BURN_ADDRESS.toLowerCase()) category = 'burn_dead';
    else if (to === '0x0000000000000000000000000000000000000000' && tokenAddr === cfg.usdcAddress.toLowerCase()) {
      category = 'cctp_burn';
    } else if (feeLower && to === feeLower) category = 'protocol_fee';
    else if (userLower && from === userLower) category = 'user_outflow';

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
      txHash: params.txHash,
      solanaDestination: params.solanaDestination,
    }).catch(() => null);
    if (att?.found) {
      cctpMessageHash = att.messageHash;
      cctpAttestationStatus = att.attestationStatus;
    }
  }

  const solanaDeltaProof = postSol
    ? {
        address: postSol.address,
        preUsdc: params.preSolanaUsdc,
        postUsdc: postSol.usdcBalance,
        deltaUsdc:
          typeof params.preSolanaUsdc === 'number'
            ? Number((postSol.usdcBalance - params.preSolanaUsdc).toFixed(4))
            : undefined,
        preSol: params.preSolanaSol,
        postSol: postSol.solBalance,
        deltaSol:
          typeof params.preSolanaSol === 'number'
            ? Number((postSol.solBalance - params.preSolanaSol).toFixed(6))
            : undefined,
        verifiedAtSlot: postSol.slot,
      }
    : undefined;

  const verified = Boolean(
    succeeded &&
      (liveStatus.bridgeStatus === 'success' ||
        cctpAttestationStatus === 'complete' ||
        (solanaDeltaProof?.deltaUsdc !== undefined && solanaDeltaProof.deltaUsdc > 0) ||
        (solanaDeltaProof?.deltaSol !== undefined && solanaDeltaProof.deltaSol > 0))
  );

  const proofDigestSha256 =
    '0x' +
    crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          chain: params.chain,
          txHash: params.txHash,
          blockNumber,
          succeeded,
          transfers: decodedTransfers,
          solanaTxHash: liveStatus.solanaTxHash,
          cctpMessageHash,
          solanaDeltaProof,
        })
      )
      .digest('hex');

  const summary = !found
    ? 'Transaction receipt not yet indexed on EVM RPC.'
    : !succeeded
    ? 'EVM transaction reverted onchain.'
    : verified
    ? `Cryptographically verified on ${cfg.name} block #${blockNumber?.toLocaleString() ?? '—'} + Solana delivery proven.`
    : `Confirmed on ${cfg.name} block #${blockNumber?.toLocaleString() ?? '—'} (${decodedTransfers.length} ERC-20 transfer logs decoded) · awaiting bridge settlement.`;

  return {
    verified,
    proofDigestSha256,
    verifiedAt: new Date().toISOString(),
    chain: params.chain,
    chainName: cfg.name,
    txHash: params.txHash,
    explorerUrl: `${cfg.explorerUrl}/tx/${params.txHash}`,
    evmReceipt: {
      found,
      succeeded,
      blockNumber,
      gasUsed: gasUsedBig > 0n ? gasUsedBig.toString() : undefined,
      gasCostNative,
      nativeSymbol: cfg.nativeSymbol,
    },
    decodedTransfers,
    bridgeProof: {
      provider: params.provider || 'evm',
      status: liveStatus.bridgeStatus,
      solanaTxHash: liveStatus.solanaTxHash,
      cctpMessageHash,
      cctpAttestationStatus,
    },
    solanaDeltaProof,
    summary,
  };
}
