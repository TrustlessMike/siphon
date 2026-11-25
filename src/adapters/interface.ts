import type {
  AnyChainId,
  ChainFamily,
  ScannedAsset,
  ScanReport,
} from '../scanner/types.js';

export interface ChainFamilyMeta {
  family: ChainFamily;
  label: string;
  shortLabel: string;
  chains: Array<{
    id: AnyChainId;
    name: string;
    nativeSymbol: string;
    logo: string;
    cctpDomain: number | null;
  }>;
  signingMechanism: string;
  gasSponsorshipMechanism: string;
  preSignProofMechanism: string;
  bridgeProviders: string[];
  wallets: Array<{ id: string; name: string; logo: string; installUrl: string }>;
  sampleAddress: string;
  sampleLabel: string;
  addressHint: string;
}

export interface UniversalGaslessIntent {
  intentId: string;
  family: ChainFamily;
  mode: string;
  chain: AnyChainId;
  chainId: number | string;
  chainName: string;
  userAddress: string;
  solanaDestination: string;
  solanaMintRecipientBytes32: string;
  outputAsset: 'USDC' | 'SOL';
  nonce: string;
  deadline: number;
  userGasCostUsd: 0;
  sponsoredGasEstUsd: number;
  gasSponsorshipMechanism: string;
  protocolFeeBps: number;
  protocolFeePercent: number;
  protocolFeeUsd: number;
  feeRecipient: string | null;
  minNetUsdcOut: string;
  estimatedNetUsd: number;
  coveredAssets: Array<{
    id: string;
    symbol: string;
    address: string;
    rawBalance: string;
    grossUsd: number;
  }>;
  signPayload: Record<string, unknown>;
  /** Kept for EVM eth_signTypedData_v4 backward compatibility */
  typedData?: Record<string, unknown>;
  relayerConfigured: boolean;
  intentDigestSha256: string;
  explanation: string;
}

export interface UniversalPreSignProof {
  proofId: string;
  family: ChainFamily;
  proofDigestSha256: string;
  generatedAt: string;
  chain: AnyChainId;
  chainId: number | string;
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
  simulationEndpoint: string;
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
    roiVerdict: 'worth_it' | 'low_efficiency' | 'negative_roi';
    routeStrategy?: 'local_batch_single_bridge' | 'direct_per_token_bridge';
  };
  haircutDroppedAssets?: Array<{ assetId: string; assetSymbol: string; reason: string }>;
  preSolanaSnapshot?: {
    usdcBalance: number;
    solBalance: number;
    hasUsdcAta: boolean;
    slot: number;
  };
  checks: Array<{
    stepId: string;
    assetSymbol: string;
    actionType: string;
    target: string;
    summary: string;
    preflightStatus: 'verified' | 'dependent_ok' | 'reverted' | 'rpc_skipped';
    preflightDetail: string;
  }>;
  allChecksSafe: boolean;
  warnings: string[];
}

export interface UniversalExecutionProof {
  verified: boolean;
  family: ChainFamily;
  proofDigestSha256: string;
  verifiedAt: string;
  chain: AnyChainId;
  chainName: string;
  txHash: string;
  explorerUrl: string;
  sourceReceipt: {
    found: boolean;
    succeeded: boolean;
    blockOrHeight?: number;
    gasUsed?: string;
    gasCostNative?: number;
    nativeSymbol: string;
  };
  decodedTransfers: Array<{
    tokenAddress: string;
    symbol: string;
    from: string;
    to: string;
    amountUi: number;
    category: 'user_outflow' | 'protocol_fee' | 'burn_dead' | 'cctp_burn' | 'bridge_deposit' | 'other';
  }>;
  bridgeProof: {
    provider: string;
    status: string;
    solanaTxHash?: string;
    cctpMessageHash?: string;
    cctpAttestationStatus?: string;
    ibcPacketAck?: string;
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

export interface ChainFamilyAdapter {
  readonly family: ChainFamily;
  readonly meta: ChainFamilyMeta;
  matchesAddress(address: string): boolean;
  scanWallet(address: string, label?: string): Promise<ScanReport>;
  buildGaslessIntent(params: {
    chain: AnyChainId;
    assets: ScannedAsset[];
    userAddress: string;
    solanaDestination: string;
    outputAsset?: 'USDC' | 'SOL';
    protocolFeeBps?: number;
    feeRecipient?: string | null;
  }): Promise<UniversalGaslessIntent>;
  simulatePreSignProof(params: {
    chain: AnyChainId;
    assets: ScannedAsset[];
    userAddress: string;
    solanaDestination: string;
    outputAsset?: 'USDC' | 'SOL';
    bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
    protocolFeeBps?: number;
    feeRecipient?: string | null;
    nativePriceUsd?: number;
  }): Promise<UniversalPreSignProof>;
  relayAndProve(params: {
    chain: AnyChainId;
    userAddress: string;
    solanaDestination: string;
    txHash?: string;
    intentId?: string;
    signature?: string;
    deadline?: number;
    requestId?: string;
    provider?: string;
    feeRecipient?: string | null;
    preSolanaUsdc?: number;
    preSolanaSol?: number;
  }): Promise<{
    submitted?: {
      accepted: boolean;
      mode: string;
      signatureFingerprint?: string;
      nextStep: string;
    };
    proof?: UniversalExecutionProof;
  }>;
}
