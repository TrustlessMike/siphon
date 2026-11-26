/**
 * Turgalium Public TypeScript SDK (`turgalium-migrator`)
 *
 * Zero-fee, MIT-licensed 30-chain portfolio scanner, parallel route auction,
 * Circle CCTP V2 Fast Transfer builder, Solana rent/yield tools, and
 * HTTP / Claude MCP server factories.
 */

// --- Core Scanner Types & Unified Multi-Chain Scanner ---
export type * from '../scanner/types.js';

export {
  scanUnifiedWallets,
  normalizeWalletAddressForKey,
  normalizeWalletDedupKey,
  type UnifiedWalletInput,
} from '../scanner/unify.js';

export {
  detectAddress,
  detectAddressFamilyStrict,
  validateEvmHexAddress,
  validateEvmAddressOrEns,
  isValidEnsName,
  resolveEnsName,
  resolveEnsNameOrThrow,
  toChecksumEvmAddress,
  validateCosmosAddress,
  validateCosmosAddressList,
  validateBitcoinAddress,
  validateTronAddress,
  validateTonAddress,
  validateMoveAddress,
  EnsResolutionError,
  type DetectedAddress,
  type AddressValidationResult,
  type ResolveEnsOptions,
} from '../scanner/address.js';

export {
  planDustConversion,
  type DustExecutionLane,
  type DustChainPlan,
  type DustConversionPlan,
} from '../scanner/dust.js';

export {
  evaluatePortfolioRoi,
  isCanonicalDirectUsdc,
  estimateL1DataFeeUsd,
  estimateBridgeFixedFeeUsd,
  SOLANA_USDC_ATA_RENT_SOL,
  WORTH_IT_MIN_NET_USD,
  WORTH_IT_MAX_COST_PCT,
  NEGATIVE_ROI_COST_PCT,
  DEFAULT_LIVE_QUOTE_HAIRCUT_CAP_PCT,
  RELAYER_BREAK_EVEN_MULTIPLIER,
  type AssetRoiVerdict,
  type AssetRoiEvaluation,
  type RelayerBreakEvenResult,
  type PrunedAssetBuckets,
  type RouteComparison,
  type ChainBatchRoiReport,
  type PortfolioRoiReport,
  type LiveQuoteHaircutResult,
} from '../scanner/roi.js';

export {
  scanStaleErc20Approvals,
  getKnownApprovalSpenders,
  encodeErc20AllowanceCalldata,
  encodeErc20RevokeCalldata,
  decodeErc20ApproveCalldata,
  type StaleApprovalFinding,
  type StaleApprovalScanResult,
  type ScanApprovalsOptions,
  type ApprovalRpcCallFn,
} from '../scanner/approvals.js';

// --- Chain Registry, Adapter Registry & Zero-Fee Protocol Config ---
export {
  EVM_CHAINS,
  CHAIN_LIST,
  TOKEN_REGISTRY,
  MULTICALL3_ADDRESS,
  ZKSYNC_MULTICALL3_ADDRESS,
  DEAD_BURN_ADDRESS,
  SOLANA_CCTP_DOMAIN,
  CCTP_V2_TOKEN_MESSENGER,
  CCTP_V2_MESSAGE_TRANSMITTER,
  MIN_PROTOCOL_FEE_BPS,
  MAX_PROTOCOL_FEE_BPS,
  DEFAULT_PROTOCOL_FEE_BPS,
  PROTOCOL_FEE_BPS,
  MIN_PRESERVATION_FEE_BPS,
  DEFAULT_PRESERVATION_FEE_CAP_USD,
  PRESERVATION_FEE_TIERS,
  getProtocolFeeConfig,
  resolveProtocolFeeBps,
  resolvePreservationFeeBps,
  computePreservationFee,
  getChainUsdcDecimals,
  resolveUnderlyingDecimals,
  isCuratedRegistryToken,
  isValidFeeRecipientEvm,
  type ProtocolFeeConfig,
  type PreservationFeeMode,
  type PreservationFeeTierId,
  type PreservationFeeTier,
  type PreservationFeeOptions,
  type PreservationFeeResult,
} from '../scanner/chains.js';

export {
  ALL_FAMILY_ADAPTERS,
  ADAPTER_BY_FAMILY,
  isEvmChain,
  getFamilyForChain,
  getAdapterForFamily,
  getAdapterForChain,
  listAllFamilyMetas,
  detectAddressFamily,
} from '../adapters/registry.js';

// --- Live Parallel Route Auction & Preservation Optimizer ---
export {
  runLiveParallelRouteAuction,
  fetchMayanSwiftQuote,
  fetchDeBridgeDlnQuote,
  validateRouterCallTarget,
  validateQuoteTransactions,
  computeTierScaledSlippageBps,
  computeDynamicGasReserveWei,
  computeDynamicGasReserveSummary,
  SOLANA_NATIVE_MINT,
  MAYAN_FORWARDER_CONTRACT,
  MAYAN_SOLANA_PROGRAM_ID,
  DEBRIDGE_SOLANA_CHAIN_ID,
  DEFAULT_AUCTION_TIMEOUT_MS,
  type AuctionBridgeProvider,
  type RouteAuctionFetcher,
  type RouteAuctionAllowanceCheckFn,
  type AuctionExecutableTx,
  type AuctionProviderQuote,
  type AuctionProviderFn,
  type RouteAuctionCandidateSummary,
  type RouteAuctionMetadata,
  type RouteAuctionResult,
  type RouterTargetValidationResult,
  type TierScaledSlippageResult,
  type DynamicGasReserveOptions,
  type RunLiveParallelRouteAuctionParams,
} from '../execution/route-auction.js';

export {
  evaluatePreservationPlan,
  buildUnlockSchedule,
  mergeUnlockSchedule,
  extractScanWalletAddresses,
  fetchLiveChainGasGwei,
  type PreservationRouteId,
  type RouteCandidateQuote,
  type ChainPreservationAudit,
  type ChainGasTimingRecommendation,
  type UnlockScheduleItem,
  type AttestedCctpLegInput,
  type PreservationPlanOptions,
  type PreservationPlanReport,
} from '../execution/preservation-optimizer.js';

// --- Circle CCTP V2 Builder & Solana Attestation Claim ---
export {
  CCTP_V1_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_V2_DEPOSIT_FOR_BURN_SELECTOR,
  CCTP_V2_FAST_FINALITY_THRESHOLD,
  CCTP_V2_STANDARD_FINALITY_THRESHOLD,
  CCTP_V2_IRIS_FEES_BASE_URL,
  CCTP_V2_MAX_FEE_BPS_SAFETY_CAP,
  SOLANA_TOKEN_PROGRAM_ID,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
  SOLANA_USDC_MINT_PUBKEY,
  SOLANA_CCTP_PROGRAMS,
  SOLANA_CCTP_PROGRAMS_V2,
  getSolanaCctpPrograms,
  getCctpEstimatedSeconds,
  getCctpIrisAttestationUrl,
  solanaAddressToBytes32,
  deriveSolanaUsdcAta,
  solanaOwnerToUsdcAtaBytes32,
  computeCctpV2MaxFeeRaw,
  fetchCctpV2BurnFee,
  encodeCctpDepositForBurn,
  extractAllCctpMessagesFromLogs,
  extractCctpMessageFromLogs,
  fetchCctpAttestationForTx,
  buildMigrationPlan,
  type CctpTransferMode,
  type CctpV2FeeTier,
  type CctpV2BurnFeeQuote,
  type SolanaCctpPrograms,
  type ExtractedCctpMessage,
  type CctpAttestationResult,
  type BuildPlanInput,
} from '../bridge/cctp.js';

export {
  buildSolanaCctpClaimInstructionPlan,
  fetchLatestSolanaBlockhash,
} from '../bridge/solana-claim.js';

// --- Solana Rent Reclaim & Post-Arrival Yield Park ---
export {
  SOLANA_TOKEN_2022_PROGRAM_ID,
  ALLOWED_SOLANA_TOKEN_PROGRAM_IDS,
  SOLANA_EMPTY_ATA_RENT_LAMPORTS,
  SOLANA_EMPTY_ATA_RENT_SOL,
  MAX_CLOSE_ACCOUNTS_PER_TX,
  assertAccountSafeToClose,
  buildCloseTokenAccountInstruction,
  buildCloseEmptyAtasVersionedTx,
  scanReclaimableSolanaRent,
  type SolanaTokenProgramKind,
  type ReclaimableSolanaTokenAccount,
  type SerializableCloseInstruction,
  type CloseEmptyAtasTxResult,
  type BuildCloseEmptyAtasOptions,
  type ScanReclaimableSolanaRentOptions,
  type SolanaRentScanResult,
} from '../bridge/solana-rent.js';

export {
  SOLANA_YIELD_STRATEGIES,
  DEFAULT_PRESERVE_PCT,
  MIN_PRESERVE_PCT,
  MAX_PRESERVE_PCT,
  MAX_TOTAL_USDC_AMOUNT,
  listSolanaYieldStrategies,
  calculateYieldPreservationSplit,
  buildSolanaYieldParkPlan,
  type SolanaYieldStrategyId,
  type SolanaYieldStrategyMeta,
  type YieldPreservationSplit,
  type JupiterSwapQuoteSummary,
  type YieldParkTransactionPayload,
  type BuildSolanaYieldParkParams,
  type SolanaYieldParkPlan,
} from '../solana/yield-park.js';

// --- DeFi Protocol Extractors & Live Unlock-Queue Readers ---
export {
  PROTOCOL_EXTRACTOR_REGISTRY,
  identifyProtocolExtractorId,
  resolveDefiExitPlan,
  computeAaveSafePartialWithdrawal,
  checkCompoundAccountSafety,
  type ResolveDefiExitPlanInput,
  type BuiltDefiExtractionTx,
  type DefiExtractorBuildResult,
  type ProtocolExtractor,
  type AaveSafePartialWithdrawalResult,
  type CompoundAccountSafety,
} from '../defi/extractors.js';

export {
  LIDO_WITHDRAWAL_QUEUE_ADDRESS,
  ETHENA_SUSDE_ADDRESS,
  readLidoWithdrawalQueue,
  readEthenaSusdeCooldown,
  readCosmosUnbondingDelegations,
  readLiveUnlockQueues,
  type LiveUnlockScheduleItem,
  type LidoWithdrawalRequest,
  type LidoWithdrawalQueueResult,
  type EthenaCooldownStatus,
  type EthenaCooldownReaderResult,
  type CosmosUnbondingEntry,
  type CosmosUnbondingReaderResult,
  type ReadLiveUnlockQueuesOptions,
  type LiveUnlockQueuesReport,
} from '../defi/unlock-readers.js';

// --- Server, Agent Mandate Engine & Claude MCP Factories ---
export {
  createTurgaliumServer,
  type TurgaliumServerOptions,
} from '../server/app.js';

export {
  startTurgaliumProcess,
  assertSafeStartupConfig,
  isLoopbackBindHost,
  parseServerPort,
  parsePollersEnabled,
  type StartupSecurityConfig,
} from '../server/index.js';

export {
  TURGALIUM_MCP_TOOLS,
  handleMcpJsonRpc,
  handleMcpRequest,
  proxyMcpJsonRpcToHttp,
  createStdioMcpDispatcher,
  type ScanCacheLike,
  type McpToolContext,
  type JsonRpcRequest,
} from '../mcp/server.js';

export {
  TurgaliumAgentEngine,
  computeActionsMask,
  resolveAssetsFromScans,
  type AgentActionType,
  type PluginClientKind,
  type AgentMandateRecord,
  type PermissionRequestRecord,
  type PluginApiTokenRecord,
  type TurgaliumAgentEngineOptions,
} from '../agent/mandate-engine.js';
