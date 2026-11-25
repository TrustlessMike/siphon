import { EVM_CHAINS, CHAIN_LIST, getProtocolFeeConfig } from '../scanner/chains.js';
import { scanLiveWallet } from '../scanner/classifier.js';
import type { AnyChainId, EvmChainId, ScannedAsset, ScanReport } from '../scanner/types.js';
import { buildPreSignSimulationProof, verifyOnchainExecutionProof } from '../execution/proof.js';
import { prepareChainBatchExecution } from '../execution/tx-builder.js';
import { buildGaslessSweepIntent, submitSignedGaslessIntent } from '../relayer/sponsor.js';
import type {
  ChainFamilyAdapter,
  ChainFamilyMeta,
  UniversalExecutionProof,
  UniversalGaslessIntent,
  UniversalPreSignProof,
} from './interface.js';

export const EVM_FAMILY_META: ChainFamilyMeta = {
  family: 'evm',
  label: 'EVM (14 Chains)',
  shortLabel: 'EVM',
  chains: CHAIN_LIST.map((c) => ({
    id: c.id,
    name: c.name,
    nativeSymbol: c.nativeSymbol,
    logo: `/logos/${c.id}.svg`,
    cctpDomain: c.cctpDomain,
  })),
  signingMechanism: '1-Signature Witness-Bound Permit2 / EIP-7702 Delegate or EIP-5792 Batch',
  gasSponsorshipMechanism: 'Siphon Relayer sponsors $0 user gas (reimbursed from 5–10% protocol fee)',
  preSignProofMechanism: 'Live EVM RPC eth_call preflight + Circle CCTP bytes32 match + Solana snapshot',
  bridgeProviders: ['Relay', 'LI.FI', 'Circle CCTP'],
  wallets: [
    { id: 'rabby', name: 'Rabby Wallet', logo: '/logos/rabby.svg', installUrl: 'https://rabby.io' },
    { id: 'metamask', name: 'MetaMask', logo: '/logos/metamask.svg', installUrl: 'https://metamask.io' },
    { id: 'phantom', name: 'Phantom EVM', logo: '/logos/phantom.svg', installUrl: 'https://phantom.app' },
    { id: 'coinbase', name: 'Coinbase Wallet', logo: '/logos/coinbase.svg', installUrl: 'https://wallet.coinbase.com' },
  ],
  sampleAddress: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  sampleLabel: 'vitalik.eth',
  addressHint: '0x… EVM address or .eth',
};

function assertEvmChain(chain: AnyChainId): EvmChainId {
  if (!(chain in EVM_CHAINS)) {
    throw new Error(`Chain "${chain}" is not an EVM chain.`);
  }
  return chain as EvmChainId;
}

export const evmAdapter: ChainFamilyAdapter = {
  family: 'evm',
  meta: EVM_FAMILY_META,

  matchesAddress(address: string): boolean {
    const clean = address.trim();
    return /^0x[0-9a-fA-F]{40}$/.test(clean) || /^[a-zA-Z0-9-]+\.eth$/i.test(clean);
  },

  async scanWallet(address: string, label?: string): Promise<ScanReport> {
    const report = await scanLiveWallet(address, label);
    report.family = 'evm';
    for (const c of report.chains) {
      c.family = 'evm';
      c.sponsorshipMechanism = 'Permit2 Witness / EIP-7702 Gasless Relayer ($0 user gas)';
    }
    for (const a of report.assets) {
      a.family = 'evm';
    }
    return report;
  },

  async buildGaslessIntent(params): Promise<UniversalGaslessIntent> {
    const evmChain = assertEvmChain(params.chain);
    const intent = buildGaslessSweepIntent({
      chain: evmChain,
      assets: params.assets,
      userAddress: params.userAddress,
      solanaDestination: params.solanaDestination,
      outputAsset: params.outputAsset ?? 'USDC',
      protocolFeeBps: params.protocolFeeBps,
      feeRecipientEvm: params.feeRecipient,
    });

    return {
      intentId: intent.intentId,
      family: 'evm',
      mode: intent.mode,
      chain: intent.chain,
      chainId: intent.chainId,
      chainName: intent.chainName,
      userAddress: intent.userAddress,
      solanaDestination: intent.solanaDestination,
      solanaMintRecipientBytes32: intent.solanaMintRecipientBytes32,
      outputAsset: intent.outputAsset,
      nonce: intent.nonce,
      deadline: intent.deadline,
      userGasCostUsd: 0,
      sponsoredGasEstUsd: intent.sponsoredGasEstUsd,
      gasSponsorshipMechanism:
        intent.mode === 'permit2_batch'
          ? 'Permit2 PermitBatchWitnessTransferFrom + Siphon Relayer ($0 user gas)'
          : 'EIP-7702 SiphonSweepDelegate + Siphon Relayer ($0 user gas)',
      protocolFeeBps: intent.protocolFeeBps,
      protocolFeePercent: intent.protocolFeePercent,
      protocolFeeUsd: intent.protocolFeeUsd,
      feeRecipient: intent.feeRecipientEvm,
      minNetUsdcOut: intent.minNetUsdcOut,
      estimatedNetUsd: intent.estimatedNetUsd,
      coveredAssets: intent.coveredAssets,
      signPayload: intent.typedData ?? {
        previewOnly: true,
        routerConfigured: intent.routerConfigured,
        mode: intent.mode,
      },
      typedData: intent.typedData ?? undefined,
      relayerConfigured: intent.relayerConfigured,
      intentDigestSha256: intent.intentDigestSha256,
      explanation: intent.explanation,
    };
  },

  async simulatePreSignProof(params): Promise<UniversalPreSignProof> {
    const evmChain = assertEvmChain(params.chain);
    const batch = await prepareChainBatchExecution({
      chain: evmChain,
      assets: params.assets,
      userAddress: params.userAddress,
      solanaDestination: params.solanaDestination,
      outputAsset: params.outputAsset ?? 'USDC',
      bridgePreference: params.bridgePreference ?? 'auto',
      protocolFeeBps: params.protocolFeeBps,
      feeRecipientEvm: params.feeRecipient,
      bundleDefiCctp: false,
    });
    const proof = await buildPreSignSimulationProof({
      batch,
      assets: params.assets.filter((a) => a.chain === evmChain),
      nativePriceUsd: params.nativePriceUsd,
    });
    return {
      ...proof,
      family: 'evm',
      simulationEndpoint: 'eth_call',
    };
  },

  async relayAndProve(params) {
    const evmChain = assertEvmChain(params.chain);
    const out: {
      submitted?: {
        accepted: boolean;
        mode: string;
        signatureFingerprint?: string;
        nextStep: string;
      };
      proof?: UniversalExecutionProof;
    } = {};

    if (params.signature && params.intentId && params.deadline) {
      const receipt = submitSignedGaslessIntent({
        intentId: params.intentId,
        chain: evmChain,
        userAddress: params.userAddress,
        signature: params.signature,
        deadline: params.deadline,
      });
      out.submitted = {
        accepted: receipt.accepted,
        mode: receipt.mode,
        signatureFingerprint: receipt.signatureFingerprint,
        nextStep: receipt.nextStep,
      };
    }

    if (params.txHash) {
      const feeCfg = getProtocolFeeConfig({ feeRecipientEvm: params.feeRecipient });
      const evmProof = await verifyOnchainExecutionProof({
        chain: evmChain,
        txHash: params.txHash,
        userAddress: params.userAddress,
        solanaDestination: params.solanaDestination,
        requestId: params.requestId,
        provider: params.provider,
        feeRecipientEvm: feeCfg.feeRecipientEvm,
        preSolanaUsdc: params.preSolanaUsdc,
        preSolanaSol: params.preSolanaSol,
      });
      out.proof = {
        verified: evmProof.verified,
        family: 'evm',
        proofDigestSha256: evmProof.proofDigestSha256,
        verifiedAt: evmProof.verifiedAt,
        chain: evmProof.chain,
        chainName: evmProof.chainName,
        txHash: evmProof.txHash,
        explorerUrl: evmProof.explorerUrl,
        sourceReceipt: {
          found: evmProof.evmReceipt.found,
          succeeded: evmProof.evmReceipt.succeeded,
          blockOrHeight: evmProof.evmReceipt.blockNumber,
          gasUsed: evmProof.evmReceipt.gasUsed,
          gasCostNative: evmProof.evmReceipt.gasCostNative,
          nativeSymbol: evmProof.evmReceipt.nativeSymbol,
        },
        decodedTransfers: evmProof.decodedTransfers,
        bridgeProof: evmProof.bridgeProof,
        solanaDeltaProof: evmProof.solanaDeltaProof,
        summary: evmProof.summary,
      };
    }

    return out;
  },
};
