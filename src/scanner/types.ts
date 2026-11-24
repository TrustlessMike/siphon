export type EvmChainId =
  | 'ethereum'
  | 'base'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'avalanche';

export type AssetAction =
  | 'WITHDRAW_AND_BRIDGE'
  | 'SELL_AND_BRIDGE'
  | 'BRIDGE_DIRECT_USDC'
  | 'BURN_ZERO_LIQUIDITY'
  | 'SKIP_GAS_NEGATIVE'
  | 'SKIP_HONEYPOT';

export type AssetKind = 'native' | 'erc20' | 'defi_position' | 'dead_token';

export interface ChainConfig {
  id: EvmChainId;
  name: string;
  chainId: number;
  nativeSymbol: string;
  nativeLlamaId: string;
  rpcUrl: string;
  explorerUrl: string;
  multicall3: string;
  usdcAddress: string;
  cctpDomain: number;
  cctpTokenMessenger: string;
  cctpAttestationSec: number;
  swapGasUnits: number;
  defiWithdrawGasUnits: number;
  burnGasUnits: number;
  bridgeGasUnits: number;
  aaveV3Pool?: string;
  compoundV3Comet?: string;
}

export interface TokenDescriptor {
  chain: EvmChainId;
  address: string; // 'native' for native coin
  symbol: string;
  name: string;
  decimals: number;
  kind: AssetKind;
  protocol?: string; // e.g. 'Aave v3', 'Compound v3', 'Lido', 'Spark'
  underlyingSymbol?: string;
  underlyingAddress?: string;
  protocolAddress?: string;
  llamaKey?: string;
  isDeadMock?: boolean;
  isHoneypotMock?: boolean;
}

export interface ScannedAsset {
  id: string;
  chain: EvmChainId;
  chainName: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: AssetKind;
  protocol?: string;
  protocolAddress?: string;
  underlyingSymbol?: string;
  rawBalance: string;
  uiBalance: number;
  priceUsd: number;
  grossUsd: number;
  liquidityUsd: number;
  estimatedGasUsd: number;
  batchedGasUsd: number;
  estimatedSlippageUsd: number;
  netUsdcSingle: number;
  netUsdcBatched: number;
  action: AssetAction;
  actionReason: string;
  selectedByDefault: boolean;
  honeypotSafe: boolean;
  calldataPreview?: string;
}

export interface ChainScanSummary {
  chain: EvmChainId;
  chainName: string;
  chainId: number;
  cctpDomain: number;
  rpcStatus: 'live' | 'preset';
  blockNumber: number;
  gasPriceGwei: number;
  nativeBalance: number;
  nativeSymbol: string;
  nativePriceUsd: number;
  assetCount: number;
  defiCount: number;
  liquidCount: number;
  burnCount: number;
  skippedCount: number;
  grossUsd: number;
  netUsdcBridged: number;
  totalGasUsd: number;
  gasSavedByBatchUsd: number;
  cctpAttestationSec: number;
  needsGasSponsorship: boolean;
}

export interface ScanReport {
  scanId: string;
  mode: 'live_rpc' | 'preset';
  walletAddress: string;
  walletLabel?: string;
  scannedAt: string;
  scanDurationMs: number;
  chainsScanned: number;
  chains: ChainScanSummary[];
  assets: ScannedAsset[];
  totals: {
    grossUsd: number;
    defiGrossUsd: number;
    liquidGrossUsd: number;
    protocolFeeBps: number;
    protocolFeeUsd: number;
    singleTxGasUsd: number;
    batchedGasUsd: number;
    gasSavedUsd: number;
    estimatedSlippageUsd: number;
    netSolanaUsdc: number;
    solEquivalent: number;
    solPriceUsd: number;
    defiPositionCount: number;
    liquidDustCount: number;
    burnCandidateCount: number;
    honeypotSkippedCount: number;
    gasNegativeCount: number;
  };
  warnings: string[];
}

export interface CctpBridgeLeg {
  chain: EvmChainId;
  chainName: string;
  sourceDomain: number;
  destinationDomain: number; // 5 = Solana
  tokenMessenger: string;
  usdcAddress: string;
  grossUsdc: number;
  feeUsdc: number;
  bridgedUsdc: number;
  rawUsdcAmount: string;
  gasUsd: number;
  estimatedSeconds: number;
  defiExits: number;
  swaps: number;
  burns: number;
  honeypotsSkipped: number;
  gasSponsored: boolean;
  cctpCalldata: string;
  steps: Array<{
    step: string;
    detail: string;
    target: string;
  }>;
}

export interface MigrationPlan {
  planId: string;
  createdAt: string;
  sourceWallet: string;
  solanaDestination: string;
  solanaMintRecipientBytes32: string;
  usePermit2Batch: boolean;
  includeBurns: boolean;
  outputAsset: 'USDC' | 'SOL';
  legs: CctpBridgeLeg[];
  totals: {
    selectedAssets: number;
    defiWithdrawnCount: number;
    tokensSoldCount: number;
    tokensBurnedCount: number;
    honeypotsSkippedCount: number;
    grossUsd: number;
    totalGasUsd: number;
    gasSavedUsd: number;
    protocolFeeUsd: number;
    netSolanaUsdc: number;
    netSolanaSol: number;
    estimatedFastestSec: number;
    estimatedFullSec: number;
  };
  burnManifest: Array<{
    chain: EvmChainId;
    symbol: string;
    tokenAddress: string;
    amount: string;
    burnSink: string;
    status: 'BURN_READY' | 'SKIPPED_HONEYPOT';
    reason: string;
  }>;
}
