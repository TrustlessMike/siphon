export type ChainFamily =
  | 'evm'
  | 'cosmos'
  | 'sui'
  | 'aptos'
  | 'ton'
  | 'tron'
  | 'btc';

export type EvmChainId =
  | 'ethereum'
  | 'base'
  | 'arbitrum'
  | 'optimism'
  | 'polygon'
  | 'avalanche'
  | 'bnb'
  | 'sonic'
  | 'unichain'
  | 'linea'
  | 'scroll'
  | 'mantle'
  | 'blast'
  | 'worldchain';

export type CosmosChainId =
  | 'cosmoshub'
  | 'osmosis'
  | 'noble'
  | 'celestia'
  | 'injective'
  | 'neutron';

export type NonEvmChainId =
  | CosmosChainId
  | 'sui'
  | 'aptos'
  | 'ton'
  | 'tron'
  | 'btc';

export type AnyChainId = EvmChainId | NonEvmChainId;

export type RoiVerdict = 'worth_it' | 'low_efficiency' | 'negative_roi';
export type ChainRouteStrategy = 'local_batch_single_bridge' | 'direct_per_token_bridge';

export type AssetAction =
  | 'WITHDRAW_AND_BRIDGE'
  | 'SELL_AND_BRIDGE'
  | 'BRIDGE_DIRECT_USDC'
  | 'BURN_ZERO_LIQUIDITY'
  | 'SKIP_GAS_NEGATIVE'
  | 'SKIP_NEGATIVE_ROI'
  | 'SKIP_HONEYPOT';

export interface RoiCostBreakdown {
  gasUsd: number;
  l1DataFeeUsd: number;
  slippageUsd: number;
  bridgeFeeUsd: number;
  protocolFeeUsd: number;
  solanaAtaRentUsd: number;
  totalCostUsd: number;
}

export type AssetKind = 'native' | 'erc20' | 'defi_position' | 'dead_token';

export interface ChainConfig {
  id: EvmChainId;
  name: string;
  chainId: number;
  nativeSymbol: string;
  nativeLlamaId: string;
  rpcUrl: string;
  rpcUrls: string[];
  explorerUrl: string;
  multicall3: string;
  usdcAddress: string;
  cctpDomain: number | null; // null when chain relies on Relay/LI.FI instead of native Circle CCTP
  cctpTokenMessenger: string | null;
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
  family?: ChainFamily;
  sourceWallet?: string;
  sourceWalletLabel?: string;
  chain: AnyChainId;
  chainName: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: AssetKind;
  protocol?: string;
  protocolAddress?: string;
  underlyingSymbol?: string;
  underlyingAddress?: string;
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
  /** Signed marginal net ROI in USD (negative when costs exceed gross value) */
  netRoiUsd?: number;
  /** Total estimated cost (gas + L1 data + slippage + bridge + protocol fee) as % of gross */
  effectiveCostPct?: number;
  roiVerdict?: RoiVerdict;
  roiCostBreakdown?: RoiCostBreakdown;
  action: AssetAction;
  actionReason: string;
  selectedByDefault: boolean;
  honeypotSafe: boolean;
  eip2612Supported?: boolean;
  permit2Approved?: boolean;
  aaveDebtUsd?: number;
  aaveHealthFactor?: number;
  dexLiquidityVerified?: boolean;
  stakedExitMode?: 'instant_liquid_stake' | 'scheduled_authz_autosweep' | 'native_unstake';
  calldataPreview?: string;
}

export interface ChainScanSummary {
  family?: ChainFamily;
  chain: AnyChainId;
  chainName: string;
  chainId: number | string;
  cctpDomain: number | null;
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
  sponsorshipMechanism?: string;
  /** Level 2 signed chain-leg total net USD (can be negative) */
  chainLegNetUsd?: number;
  chainLegCostPct?: number;
  roiVerdict?: RoiVerdict;
  skipChainNegativeRoi?: boolean;
  routeStrategy?: ChainRouteStrategy;
  breakEvenHint?: string;
  solanaAtaRentUsd?: number;
}

export interface UnifiedWalletSummary {
  address: string;
  label: string;
  family: ChainFamily;
  chainsWithAssets: number;
  assetCount: number;
  grossUsd: number;
  scanDurationMs: number;
  error?: string;
}

export interface ScanReport {
  scanId: string;
  family?: ChainFamily;
  unifiedWallets?: UnifiedWalletSummary[];
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
  family?: ChainFamily;
  chain: AnyChainId;
  chainName: string;
  sourceDomain: number | null;
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
  sponsorshipMechanism?: string;
  chainLegNetUsd?: number;
  effectiveCostPct?: number;
  roiVerdict?: RoiVerdict;
  routeStrategy?: ChainRouteStrategy;
  breakEvenHint?: string;
  skippedNegativeRoi?: boolean;
  solanaAtaRentUsd?: number;
  cctpCalldata: string;
  steps: Array<{
    step: string;
    detail: string;
    target: string;
  }>;
}

export interface MigrationPlan {
  planId: string;
  family?: ChainFamily;
  createdAt: string;
  sourceWallet: string;
  solanaDestination: string;
  solanaMintRecipientBytes32: string;
  usePermit2Batch: boolean;
  includeBurns: boolean;
  outputAsset: 'USDC' | 'SOL';
  bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
  activeBridgeLabel?: string;
  protocolFeeBps: number;
  protocolFeePercent: number;
  feeRecipientEvm: string | null;
  feeDestinationType: 'contract' | 'wallet';
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
    chain: AnyChainId;
    symbol: string;
    tokenAddress: string;
    amount: string;
    burnSink: string;
    status: 'BURN_READY' | 'SKIPPED_HONEYPOT';
    reason: string;
  }>;
}
