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
  sponsorEligible?: boolean;
  sponsorRejectionReason?: string;
  intentDigestSha256: string;
  explanation: string;
}

export type NonEvmExecutionKind =
  | 'cosmos_skip_tx'
  | 'sui_ptb'
  | 'aptos_entry_fn'
  | 'ton_tonconnect_batch'
  | 'tron_tvm_tx'
  | 'btc_psbt';

export interface PreparedNonEvmCall {
  stepId: string;
  assetId: string;
  assetSymbol: string;
  action: ScannedAsset['action'];
  provider: string;
  label: string;
  description: string;
  /** Native wallet-ready payload for the target non-EVM family (PSBT hex, TonConnect messages, TVM contract tx, Skip Go cosmos_tx, Sui PTB commands, Aptos entry function) */
  nativePayload: Record<string, unknown>;
}

export interface PreparedNonEvmBatch {
  family: Exclude<ChainFamily, 'evm'>;
  chain: AnyChainId;
  chainId: number | string;
  chainName: string;
  explorerUrl: string;
  userAddress: string;
  solanaDestination: string;
  solanaUsdcAtaBytes32: string;
  outputAsset: 'USDC' | 'SOL';
  executionKind: NonEvmExecutionKind;
  signingStandard: string;
  /** True when native payloads contain live executable transaction data from a quote/builder (vs preview-only metadata) */
  liveExecutable: boolean;
  calls: PreparedNonEvmCall[];
  bridgeTrackers: Array<{
    assetId: string;
    assetSymbol: string;
    provider: string;
    requestId?: string;
    estimatedOutput: string;
    estimatedSeconds: number;
    requiresSolanaClaim?: boolean;
  }>;
  skippedAssets: Array<{
    assetId: string;
    assetSymbol: string;
    reason: string;
  }>;
  savings: {
    totalCalls: number;
    walletPopupsBatched: number;
    walletPopupsLegacy: number;
    popupsSaved: number;
  };
  feeBreakdown: {
    feeBps: number;
    feePercent: number;
    feeRecipient: string | null;
    collectionMethod: string;
    estimatedFeeUsd: number;
  };
  estimatedSeconds: number;
  gaslessAvailable: boolean;
  gaslessMechanism: string;
  notes: string[];
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
  /** True ONLY when a real chain dry-run / emulation endpoint executed and succeeded on actual tx bytes/payload */
  simulatedLive?: boolean;
  /** Explicit explanation of whether live tx emulation ran or only pre-flight state/recipient/balance checks ran */
  simulationNote?: string;
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
    preflightStatus: 'verified' | 'dependent_ok' | 'reverted' | 'rpc_skipped' | 'unsimulated';
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
  prepareDirectBatch?(params: {
    chain: AnyChainId;
    assets: ScannedAsset[];
    userAddress: string;
    solanaDestination: string;
    outputAsset?: 'USDC' | 'SOL';
    bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
    protocolFeeBps?: number;
    feeRecipient?: string | null;
    allowHighCost?: boolean;
    addressesByChain?: Record<string, string>;
  }): Promise<PreparedNonEvmBatch>;
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
    /** Optional serialized transaction bytes (e.g. Sui BCS base64, Cosmos tx_bytes base64, TON BOC, BTC PSBT hex) for real chain dry-run */
    rawTxBytes?: string;
    /** Optional structured simulation payload (e.g. Aptos UserTransaction, Tron triggerconstantcontract params) for real chain dry-run */
    simulationPayload?: Record<string, unknown>;
  }): Promise<UniversalPreSignProof>;
  relayAndProve(params: {
    chain: AnyChainId;
    userAddress: string;
    solanaDestination: string;
    outputAsset?: 'USDC' | 'SOL';
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
      broadcasted?: boolean;
      settlementStatus?: string;
      txHash?: string;
      signatureFingerprint?: string;
      nextStep: string;
    };
    proof?: UniversalExecutionProof;
  }>;
}
