import crypto from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3';
import { PublicKey } from '@solana/web3.js';
import {
  DEAD_BURN_ADDRESS,
  EVM_CHAINS,
  getProtocolFeeConfig,
  SOLANA_CCTP_DOMAIN,
} from '../scanner/chains.js';
import { fetchSolanaWalletBalances } from '../scanner/discovery.js';
import { evaluateChainBatchRoi } from '../scanner/roi.js';
import { evmJsonRpcCall } from '../scanner/rpc.js';
import type { AnyChainId, CctpBridgeLeg, EvmChainId, MigrationPlan, ScanReport } from '../scanner/types.js';

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
  bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
  protocolFeeBps?: number;
  feeRecipientEvm?: string | null;
  hasSolanaUsdcAta?: boolean;
}

function getBridgeProviderMeta(
  pref: 'auto' | 'relay' | 'lifi' | 'cctp',
  outputAsset: 'USDC' | 'SOL',
  cctpSec: number
): { label: string; shortLabel: string; etaText: string; stepTitle: string } {
  const effectivePref = outputAsset === 'SOL' && pref === 'cctp' ? 'auto' : pref;
  if (effectivePref === 'relay') {
    return {
      label: 'Relay Instant Bridge (~2s auto-fill)',
      shortLabel: 'Relay Bridge',
      etaText: '~2–10s auto-fill',
      stepTitle: `Relay Bridge → Solana ${outputAsset}`,
    };
  }
  if (effectivePref === 'lifi') {
    return {
      label: 'LI.FI Aggregator (Mayan / deBridge / Relay)',
      shortLabel: 'LI.FI Router',
      etaText: '~15–30s auto-fill',
      stepTitle: `LI.FI Route → Solana ${outputAsset}`,
    };
  }
  if (effectivePref === 'cctp') {
    return {
      label: 'Circle CCTP 1:1 (Domain 5 · Solana Claim)',
      shortLabel: 'Circle CCTP 1:1',
      etaText: `~${cctpSec}s finality`,
      stepTitle: 'Circle CCTP 1:1 Burn',
    };
  }
  return {
    label: 'Auto (Relay → LI.FI → Circle CCTP)',
    shortLabel: 'Relay / LI.FI',
    etaText: '~2–15s auto-fill',
    stepTitle: `Relay / LI.FI → Solana ${outputAsset}`,
  };
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
  const rawPref = input.bridgePreference ?? 'auto';
  const bridgePreference: 'auto' | 'relay' | 'lifi' | 'cctp' =
    outputAsset === 'SOL' && rawPref === 'cctp' ? 'auto' : rawPref;
  const feeConfig = getProtocolFeeConfig({
    feeBps: input.protocolFeeBps,
    feeRecipientEvm: input.feeRecipientEvm,
  });

  const solanaMintRecipientBytes32 = solanaAddressToBytes32(solanaDestination);
  const selectedSet = Array.isArray(selectedAssetIds)
    ? new Set(selectedAssetIds)
    : new Set(scan.assets.filter((a) => a.selectedByDefault).map((a) => a.id));

  const chosen = scan.assets.filter((a) => selectedSet.has(a.id));
  const preferredOrder: AnyChainId[] = [
    'base',
    'arbitrum',
    'optimism',
    'avalanche',
    'polygon',
    'bnb',
    'sonic',
    'unichain',
    'linea',
    'scroll',
    'mantle',
    'blast',
    'worldchain',
    'ethereum',
    'noble',
    'osmosis',
    'cosmoshub',
    'celestia',
    'injective',
    'neutron',
    'sui',
    'aptos',
    'ton',
    'tron',
    'btc',
  ];
  const dynamicChains = Array.from(new Set(chosen.map((a) => a.chain)));
  const chainOrder: AnyChainId[] = [
    ...preferredOrder.filter((id) => dynamicChains.includes(id)),
    ...dynamicChains.filter((id) => !preferredOrder.includes(id)),
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

    const evmCfg = (EVM_CHAINS as Record<string, (typeof EVM_CHAINS)[EvmChainId] | undefined>)[chainId];
    const chainSummary = scan.chains.find((c) => c.chain === chainId);
    const chainName = evmCfg?.name ?? chainSummary?.chainName ?? chainAssets[0]?.chainName ?? chainId;
    const cctpDomain = evmCfg ? evmCfg.cctpDomain : chainSummary?.cctpDomain ?? null;
    const tokenMessenger = evmCfg?.cctpTokenMessenger ?? 'Relayer / Bridge Router';
    const usdcAddress = evmCfg?.usdcAddress ?? 'native_usdc';
    const estSec = evmCfg?.cctpAttestationSec ?? chainSummary?.cctpAttestationSec ?? 20;

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
    const feeUsdc = round2((Math.max(0, grossUsdc - slippage) * feeConfig.feeBps) / 10_000);
    const bridgedUsdc = round2(Math.max(0, grossUsdc - slippage - activeGas - feeUsdc));
    const rawUsdcAmount = BigInt(Math.round(bridgedUsdc * 1_000_000));

    const cctpCalldata =
      evmCfg && evmCfg.cctpTokenMessenger
        ? encodeCctpDepositForBurn({
            rawUsdcAmount,
            destinationDomain: SOLANA_CCTP_DOMAIN,
            solanaMintRecipientBytes32,
            usdcAddress: evmCfg.usdcAddress,
          })
        : '0x';

    const effectiveChainPref =
      bridgePreference === 'cctp' && !evmCfg?.cctpTokenMessenger && cctpDomain === null
        ? 'auto'
        : bridgePreference;
    const providerMeta = getBridgeProviderMeta(effectiveChainPref, outputAsset, estSec);
    const steps: CctpBridgeLeg['steps'] = [];
    if (usePermit2Batch) {
      steps.push({
        step: evmCfg ? 'EIP-5792 / Permit2 Atomic Batch' : chainSummary?.sponsorshipMechanism || '1-Sig Gasless Batch',
        detail: `Bundles ${chainAssets.length} asset(s) into 1 confirmation on ${chainName}`,
        target: evmCfg ? 'wallet_sendCalls' : chainName,
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
        step: `Swap & Bridge → Solana ${outputAsset}`,
        detail: `Route ${swapItems.map((s) => s.symbol).join(', ')} via ${providerMeta.shortLabel} (${providerMeta.etaText})`,
        target: usdcAddress,
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
        detail: `Burn ${burnItems.length} zero-liquidity token(s) to 0x…dEaD (eth_call verified)`,
        target: DEAD_BURN_ADDRESS,
      });
    }
    if (feeUsdc > 0) {
      const destLabel = feeConfig.feeRecipientEvm
        ? `${feeConfig.feeRecipientEvm.slice(0, 6)}…${feeConfig.feeRecipientEvm.slice(-4)} (${feeConfig.feeDestinationType === 'wallet' ? 'Treasury Wallet' : 'SiphonFeeVault'})`
        : 'SiphonFeeVault / Treasury (set recipient)';
      steps.push({
        step: `Protocol Fee (${feeConfig.feePercent}%)`,
        detail: `Routes $${feeUsdc.toFixed(2)} (${feeConfig.feeBps} bps) atomically to ${destLabel}`,
        target: feeConfig.feeRecipientEvm ?? 'SiphonFeeVault',
      });
    }
    if (bridgedUsdc > 0 && (effectiveChainPref === 'cctp' || directUsdcItems.length > 0 || swapItems.length === 0)) {
      steps.push({
        step: providerMeta.stepTitle,
        detail:
          effectiveChainPref === 'cctp' && cctpDomain !== null
            ? `depositForBurn(${bridgedUsdc.toFixed(2)} USDC, Domain ${cctpDomain} → 5 Solana)`
            : `Settles ~$${bridgedUsdc.toFixed(2)} as native Solana ${outputAsset} (${providerMeta.etaText})`,
        target: effectiveChainPref === 'cctp' ? tokenMessenger : providerMeta.shortLabel,
      });
    }

    const chainRoi = evaluateChainBatchRoi({
      chain: chainId,
      chainName,
      assets: chainAssets,
      protocolFeeBps: feeConfig.feeBps,
      gasSponsored: Boolean(usePermit2Batch && chainSummary?.needsGasSponsorship),
      hasSolanaUsdcAta: legs.length === 0 ? input.hasSolanaUsdcAta : true,
      solPriceUsd: scan.totals.solPriceUsd || 70,
      gasPriceGwei: chainSummary?.gasPriceGwei,
    });

    legs.push({
      family: scan.family ?? 'evm',
      chain: chainId,
      chainName,
      sourceDomain: cctpDomain,
      destinationDomain: SOLANA_CCTP_DOMAIN,
      tokenMessenger,
      usdcAddress,
      grossUsdc,
      feeUsdc,
      bridgedUsdc,
      rawUsdcAmount: rawUsdcAmount.toString(),
      gasUsd: round2(activeGas),
      estimatedSeconds: estSec,
      defiExits: defiItems.length,
      swaps: swapItems.length + directUsdcItems.length,
      burns: burnItems.length,
      honeypotsSkipped: skippedOnChain,
      gasSponsored: Boolean(usePermit2Batch && chainSummary?.needsGasSponsorship),
      sponsorshipMechanism: chainSummary?.sponsorshipMechanism,
      chainLegNetUsd: chainRoi.chainLegNetUsd,
      effectiveCostPct: chainRoi.chainLegCostPct,
      roiVerdict: chainRoi.roiVerdict,
      routeStrategy: chainRoi.routeComparison.recommendedStrategy,
      breakEvenHint: chainRoi.breakEvenHint,
      skippedNegativeRoi: chainRoi.skipChainNegativeRoi,
      solanaAtaRentUsd: chainRoi.solanaAtaRentUsd,
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
  const activeBridgeMeta = getBridgeProviderMeta(bridgePreference, outputAsset, 20);

  return {
    planId: `plan_${crypto.randomBytes(5).toString('hex')}`,
    family: scan.family ?? 'evm',
    createdAt: new Date().toISOString(),
    sourceWallet: scan.walletAddress,
    solanaDestination: solanaDestination.trim(),
    solanaMintRecipientBytes32,
    usePermit2Batch,
    includeBurns,
    outputAsset,
    bridgePreference,
    activeBridgeLabel: activeBridgeMeta.label,
    protocolFeeBps: feeConfig.feeBps,
    protocolFeePercent: feeConfig.feePercent,
    feeRecipientEvm: feeConfig.feeRecipientEvm,
    feeDestinationType: feeConfig.feeDestinationType,
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
