import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';
import {
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  PROTOCOL_FEE_BPS,
  SOLANA_CCTP_DOMAIN,
} from '../scanner/chains.js';
import { fetchSolanaWalletBalances } from '../scanner/discovery.js';
import { evmJsonRpcCall } from '../scanner/rpc.js';
import type { CctpBridgeLeg, EvmChainId, MigrationPlan, ScanReport } from '../scanner/types.js';

// Circle CCTP TokenMessenger.depositForBurn(uint256,uint32,bytes32,address)
const DEPOSIT_FOR_BURN_SELECTOR = '6fd3504e';
// Circle CCTP MessageTransmitter event: MessageSent(bytes message)
export const CCTP_MESSAGE_SENT_TOPIC =
  '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036';
export const SOLANA_CCTP_PROGRAMS = {
  messageTransmitter: 'CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd',
  tokenMessengerMinter: 'CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3',
} as const;

function round2(n: number): number {
  return Number(n.toFixed(2));
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * Validates a Solana base58 public key and converts its exact 32 raw bytes
 * into a 0x-prefixed EVM bytes32 value for Circle CCTP `mintRecipient`.
 */
export function solanaAddressToBytes32(solanaAddress: string): string {
  const pubkey = new PublicKey(solanaAddress.trim());
  return '0x' + Buffer.from(pubkey.toBytes()).toString('hex');
}

/**
 * Encodes Circle CCTP TokenMessenger.depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken).
 */
export function encodeCctpDepositForBurn(params: {
  rawUsdcAmount: bigint;
  destinationDomain: number;
  solanaMintRecipientBytes32: string;
  usdcAddress: string;
}): string {
  const amtHex = params.rawUsdcAmount.toString(16).padStart(64, '0');
  const domHex = params.destinationDomain.toString(16).padStart(64, '0');
  const recHex = params.solanaMintRecipientBytes32.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const tokHex = params.usdcAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return `0x${DEPOSIT_FOR_BURN_SELECTOR}${amtHex}${domHex}${recHex}${tokHex}`;
}

/**
 * Extracts Circle CCTP `MessageSent(bytes)` raw message bytes and its `keccak256` message hash
 * from EVM transaction receipt logs.
 */
export function extractCctpMessageFromLogs(
  logs: Array<{ topics?: string[]; data?: string }>
): { messageBytesHex: string; messageHash: string } | null {
  for (const log of logs) {
    const topic0 = log.topics?.[0]?.toLowerCase();
    if (topic0 !== CCTP_MESSAGE_SENT_TOPIC || !log.data) continue;
    const raw = log.data.replace(/^0x/, '');
    if (raw.length < 128) continue;
    const offsetBytes = Number(BigInt('0x' + raw.slice(0, 64)));
    const lenStart = offsetBytes * 2;
    if (raw.length < lenStart + 64) continue;
    const msgByteLen = Number(BigInt('0x' + raw.slice(lenStart, lenStart + 64)));
    const msgHex = raw.slice(lenStart + 64, lenStart + 64 + msgByteLen * 2);
    if (msgHex.length !== msgByteLen * 2 || msgByteLen === 0) continue;

    const msgBytes = Buffer.from(msgHex, 'hex');
    const hashBytes = keccak_256(msgBytes);
    const messageHash = '0x' + Buffer.from(hashBytes).toString('hex');
    return {
      messageBytesHex: '0x' + msgHex,
      messageHash,
    };
  }
  return null;
}

export interface CctpAttestationResult {
  found: boolean;
  chain: EvmChainId;
  txHash: string;
  messageHash?: string;
  messageBytesHex?: string;
  attestationStatus: 'not_found' | 'pending_confirmations' | 'complete' | 'error';
  attestation?: string;
  solanaProgramIds: typeof SOLANA_CCTP_PROGRAMS;
  solanaDestinationReady?: {
    address: string;
    hasUsdcAta: boolean;
    solBalance: number;
    warning?: string;
  };
  nextStep: string;
}

/**
 * Fetches an EVM transaction receipt, extracts the Circle CCTP `MessageSent` log,
 * polls Circle's live Iris Attestation API, and checks whether the Solana recipient
 * already has a USDC Associated Token Account (ATA) + SOL for `receiveMessage`.
 */
export async function fetchCctpAttestationForTx(params: {
  chain: EvmChainId;
  txHash: string;
  solanaDestination?: string;
}): Promise<CctpAttestationResult> {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) throw new Error(`Unsupported chain: ${params.chain}`);

  const receiptRes = await evmJsonRpcCall<{
    status?: string;
    logs?: Array<{ topics?: string[]; data?: string }>;
  } | null>(cfg.rpcUrls, 'eth_getTransactionReceipt', [params.txHash], 4500);

  const receipt = receiptRes.result;
  if (!receipt || !Array.isArray(receipt.logs)) {
    return {
      found: false,
      chain: params.chain,
      txHash: params.txHash,
      attestationStatus: 'not_found',
      solanaProgramIds: SOLANA_CCTP_PROGRAMS,
      nextStep: 'Transaction receipt not yet indexed on EVM RPC. Retry in a few seconds.',
    };
  }

  const extracted = extractCctpMessageFromLogs(receipt.logs);
  if (!extracted) {
    return {
      found: false,
      chain: params.chain,
      txHash: params.txHash,
      attestationStatus: 'not_found',
      solanaProgramIds: SOLANA_CCTP_PROGRAMS,
      nextStep: 'No Circle CCTP MessageSent event found in this transaction.',
    };
  }

  let attestationStatus: CctpAttestationResult['attestationStatus'] = 'pending_confirmations';
  let attestation: string | undefined;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const irisRes = await fetch(
      `https://iris-api.circle.com/v1/attestations/${extracted.messageHash}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (irisRes.ok) {
      const irisJson = (await irisRes.json()) as { status?: string; attestation?: string };
      if (irisJson.status === 'complete' && irisJson.attestation) {
        attestationStatus = 'complete';
        attestation = irisJson.attestation;
      }
    }
  } catch {
    attestationStatus = 'pending_confirmations';
  }

  let solanaDestinationReady: CctpAttestationResult['solanaDestinationReady'];
  if (params.solanaDestination) {
    try {
      const bal = await fetchSolanaWalletBalances(params.solanaDestination);
      const warning = !bal.hasUsdcAta
        ? 'Destination Solana wallet has no USDC ATA yet — create ATA before or during receiveMessage (~0.00204 SOL rent).'
        : bal.solBalance < 0.002
        ? 'Destination Solana wallet has low SOL (< 0.002 SOL) to pay receiveMessage tx fee.'
        : undefined;
      solanaDestinationReady = {
        address: bal.address,
        hasUsdcAta: bal.hasUsdcAta,
        solBalance: bal.solBalance,
        warning,
      };
    } catch {
      // non-fatal
    }
  }

  const nextStep =
    attestationStatus === 'complete'
      ? `Circle Iris attestation is READY. Submit MessageTransmitter.receiveMessage(messageBytes, attestation) on Solana (${SOLANA_CCTP_PROGRAMS.messageTransmitter}) to mint native USDC.`
      : `Waiting for Circle Iris finality on ${cfg.name} (~${cfg.cctpAttestationSec}s). Poll /api/cctp/attestation again until status === "complete".`;

  return {
    found: true,
    chain: params.chain,
    txHash: params.txHash,
    messageHash: extracted.messageHash,
    messageBytesHex: extracted.messageBytesHex,
    attestationStatus,
    attestation,
    solanaProgramIds: SOLANA_CCTP_PROGRAMS,
    solanaDestinationReady,
    nextStep,
  };
}

export interface BuildPlanInput {
  scan: ScanReport;
  selectedAssetIds?: string[];
  solanaDestination: string;
  usePermit2Batch?: boolean;
  includeBurns?: boolean;
  outputAsset?: 'USDC' | 'SOL';
}

export function buildMigrationPlan(input: BuildPlanInput): MigrationPlan {
  const {
    scan,
    selectedAssetIds,
    solanaDestination,
    usePermit2Batch = true,
    includeBurns = true,
    outputAsset = 'USDC',
  } = input;

  const solanaMintRecipientBytes32 = solanaAddressToBytes32(solanaDestination);
  const selectedSet = Array.isArray(selectedAssetIds)
    ? new Set(selectedAssetIds)
    : new Set(scan.assets.filter((a) => a.selectedByDefault).map((a) => a.id));

  const chosen = scan.assets.filter((a) => selectedSet.has(a.id));
  const chainOrder: EvmChainId[] = [
    'base',
    'arbitrum',
    'optimism',
    'avalanche',
    'polygon',
    'ethereum',
  ];

  const legs: CctpBridgeLeg[] = [];
  const burnManifest: MigrationPlan['burnManifest'] = [];

  // Record honeypots safely skipped across the scan
  for (const h of scan.assets.filter((a) => a.action === 'SKIP_HONEYPOT')) {
    burnManifest.push({
      chain: h.chain,
      symbol: h.symbol,
      tokenAddress: h.address,
      amount: `${h.uiBalance.toLocaleString()} ${h.symbol}`,
      burnSink: DEAD_BURN_ADDRESS,
      status: 'SKIPPED_HONEYPOT',
      reason: h.actionReason,
    });
  }

  let totalDefi = 0;
  let totalSwaps = 0;
  let totalBurns = 0;
  let totalGross = 0;
  let totalGas = 0;
  let totalSingleGas = 0;
  let totalFee = 0;
  let totalNetUsdc = 0;

  for (const chainId of chainOrder) {
    const chainAssets = chosen.filter((a) => a.chain === chainId);
    if (!chainAssets.length) continue;

    const cfg = EVM_CHAINS[chainId];
    const chainSummary = scan.chains.find((c) => c.chain === chainId);

    const defiItems = chainAssets.filter((a) => a.action === 'WITHDRAW_AND_BRIDGE');
    const swapItems = chainAssets.filter((a) => a.action === 'SELL_AND_BRIDGE');
    const directUsdcItems = chainAssets.filter((a) => a.action === 'BRIDGE_DIRECT_USDC');
    const burnItems = includeBurns
      ? chainAssets.filter((a) => a.action === 'BURN_ZERO_LIQUIDITY')
      : [];
    const skippedOnChain = scan.assets.filter(
      (a) => a.chain === chainId && a.action === 'SKIP_HONEYPOT'
    ).length;

    const liquidOrDefi = [...defiItems, ...swapItems, ...directUsdcItems];
    if (!liquidOrDefi.length && !burnItems.length) continue;

    const grossUsdc = round2(liquidOrDefi.reduce((s, a) => s + a.grossUsd, 0));
    const slippage = round2(liquidOrDefi.reduce((s, a) => s + a.estimatedSlippageUsd, 0));
    const singleGas = round4(chainAssets.reduce((s, a) => s + a.estimatedGasUsd, 0));
    const activeGas = round4(
      chainAssets.reduce((s, a) => s + (usePermit2Batch ? a.batchedGasUsd : a.estimatedGasUsd), 0)
    );
    const feeUsdc = round2((Math.max(0, grossUsdc - slippage) * PROTOCOL_FEE_BPS) / 10_000);
    const bridgedUsdc = round2(Math.max(0, grossUsdc - slippage - activeGas - feeUsdc));
    const rawUsdcAmount = BigInt(Math.round(bridgedUsdc * 1_000_000));

    const cctpCalldata = encodeCctpDepositForBurn({
      rawUsdcAmount,
      destinationDomain: SOLANA_CCTP_DOMAIN,
      solanaMintRecipientBytes32,
      usdcAddress: cfg.usdcAddress,
    });

    const steps: CctpBridgeLeg['steps'] = [];
    if (usePermit2Batch) {
      steps.push({
        step: 'Permit2 Signature',
        detail: `Single EIP-712 batch approval for ${chainAssets.length} token(s) on ${cfg.name}`,
        target: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      });
    }
    for (const d of defiItems) {
      steps.push({
        step: `Withdraw ${d.protocol}`,
        detail: `Redeem ${d.uiBalance} ${d.symbol} ($${d.grossUsd.toFixed(2)}) → ${d.underlyingSymbol ?? 'USDC'}`,
        target: d.protocolAddress ?? d.address,
      });
    }
    if (swapItems.length > 0) {
      steps.push({
        step: 'Batch Swap → USDC',
        detail: `Sell ${swapItems.map((s) => s.symbol).join(', ')} into native ${cfg.name} USDC`,
        target: cfg.usdcAddress,
      });
    }
    for (const b of burnItems) {
      burnManifest.push({
        chain: b.chain,
        symbol: b.symbol,
        tokenAddress: b.address,
        amount: `${b.uiBalance.toLocaleString()} ${b.symbol}`,
        burnSink: DEAD_BURN_ADDRESS,
        status: 'BURN_READY',
        reason: b.actionReason,
      });
    }
    if (burnItems.length > 0) {
      steps.push({
        step: 'Isolated Safe Burn',
        detail: `Burn ${burnItems.length} zero-liquidity token(s) to 0x…dEaD via try/catch`,
        target: DEAD_BURN_ADDRESS,
      });
    }
    if (bridgedUsdc > 0) {
      steps.push({
        step: 'Circle CCTP Bridge',
        detail: `depositForBurn(${bridgedUsdc.toFixed(2)} USDC, domain=5 → Solana)`,
        target: cfg.cctpTokenMessenger,
      });
    }

    legs.push({
      chain: chainId,
      chainName: cfg.name,
      sourceDomain: cfg.cctpDomain,
      destinationDomain: SOLANA_CCTP_DOMAIN,
      tokenMessenger: cfg.cctpTokenMessenger,
      usdcAddress: cfg.usdcAddress,
      grossUsdc,
      feeUsdc,
      bridgedUsdc,
      rawUsdcAmount: rawUsdcAmount.toString(),
      gasUsd: round2(activeGas),
      estimatedSeconds: cfg.cctpAttestationSec,
      defiExits: defiItems.length,
      swaps: swapItems.length + directUsdcItems.length,
      burns: burnItems.length,
      honeypotsSkipped: skippedOnChain,
      gasSponsored: Boolean(usePermit2Batch && chainSummary?.needsGasSponsorship),
      cctpCalldata,
      steps,
    });

    totalDefi += defiItems.length;
    totalSwaps += swapItems.length + directUsdcItems.length;
    totalBurns += burnItems.length;
    totalGross += grossUsdc;
    totalGas += activeGas;
    totalSingleGas += singleGas;
    totalFee += feeUsdc;
    totalNetUsdc += bridgedUsdc;
  }

  const times = legs.filter((l) => l.bridgedUsdc > 0).map((l) => l.estimatedSeconds);
  const solPrice = scan.totals.solPriceUsd || 70;

  return {
    planId: `plan_${crypto.randomBytes(5).toString('hex')}`,
    createdAt: new Date().toISOString(),
    sourceWallet: scan.walletAddress,
    solanaDestination: solanaDestination.trim(),
    solanaMintRecipientBytes32,
    usePermit2Batch,
    includeBurns,
    outputAsset,
    legs,
    totals: {
      selectedAssets: chosen.length,
      defiWithdrawnCount: totalDefi,
      tokensSoldCount: totalSwaps,
      tokensBurnedCount: totalBurns,
      honeypotsSkippedCount: scan.totals.honeypotSkippedCount,
      grossUsd: round2(totalGross),
      totalGasUsd: round2(totalGas),
      gasSavedUsd: round2(Math.max(0, totalSingleGas - totalGas)),
      protocolFeeUsd: round2(totalFee),
      netSolanaUsdc: round2(totalNetUsdc),
      netSolanaSol: round4(totalNetUsdc / solPrice),
      estimatedFastestSec: times.length ? Math.min(...times) : 0,
      estimatedFullSec: times.length ? Math.max(...times) : 0,
    },
    burnManifest,
  };
}
