import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { SiphonAgentEngine, type AgentActionType } from '../agent/mandate-engine.js';
import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import {
  scanReclaimableSolanaRent,
  SOLANA_EMPTY_ATA_RENT_SOL,
} from '../bridge/solana-rent.js';
import {
  readLiveUnlockQueues,
  type ReadLiveUnlockQueuesOptions,
} from '../defi/unlock-readers.js';
import {
  ALLOWED_JUPITER_CATEGORIES,
  ALLOWED_JUPITER_FILTERS,
  JupiterMarketsClient,
  type JupiterCategory,
  type JupiterFilter,
} from '../degen/jupiter-markets.js';
import {
  buildUnlockSchedule,
  evaluatePreservationPlan,
  extractScanWalletAddresses,
  mergeUnlockSchedule,
  type AttestedCctpLegInput,
  type UnlockScheduleItem,
} from '../execution/preservation-optimizer.js';
import {
  detectAddress,
  validateCosmosAddress,
  validateEvmHexAddress,
} from '../scanner/address.js';
import { DEAD_BURN_ADDRESS } from '../scanner/chains.js';
import { planDustConversion } from '../scanner/dust.js';
import { sanitizeFreeText, sanitizeTokenName, sanitizeTokenSymbol } from '../scanner/sanitize.js';
import { scanUnifiedWallets } from '../scanner/unify.js';
import type { AnyChainId, ChainFamily, EvmChainId, ScanReport } from '../scanner/types.js';
import { BoundedTtlCache } from '../server/cache.js';
import {
  buildSolanaYieldParkPlan,
  calculateYieldPreservationSplit,
  DEFAULT_PRESERVE_PCT,
  MAX_PRESERVE_PCT,
  MAX_TOTAL_USDC_AMOUNT,
  MIN_PRESERVE_PCT,
  SOLANA_YIELD_STRATEGIES,
  type SolanaYieldStrategyId,
} from '../solana/yield-park.js';

export interface ScanCacheLike {
  get(key: string): ScanReport | undefined;
  set(key: string, value: ScanReport): unknown;
  values(): IterableIterator<ScanReport>;
}

export interface McpToolContext {
  agentEngine: SiphonAgentEngine;
  scanCache: ScanCacheLike;
  /** Optional injectable clients/hooks for deterministic unit tests and custom RPC routing */
  jupiterMarketsClient?: JupiterMarketsClient;
  unlockReaderOptions?: Omit<ReadLiveUnlockQueuesOptions, 'evmAddresses' | 'cosmosAddresses'>;
  gasPriceFetcher?: (chain: EvmChainId) => Promise<number | null>;
  solanaRentScanner?: typeof scanReclaimableSolanaRent;
  solanaYieldPlanner?: typeof buildSolanaYieldParkPlan;
  nowMs?: () => number;
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const MCP_PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const MAX_STDIO_LINE_BYTES = 65_536;
const ZERO_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';
const VALID_FAMILIES = new Set<string>(['evm', 'cosmos', 'sui', 'aptos', 'ton', 'tron', 'btc']);
const VALID_ACTIONS = new Set<string>(['dust_convert', 'defi_withdraw', 'bridge_solana', 'burn_zero_liq']);
const VALID_YIELD_STRATEGIES = new Set<string>(Object.keys(SOLANA_YIELD_STRATEGIES));
const VALID_JUPITER_CATEGORIES = new Set<string>(ALLOWED_JUPITER_CATEGORIES);
const VALID_JUPITER_FILTERS = new Set<string>(ALLOWED_JUPITER_FILTERS);
const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;

const defaultMcpJupiterClient = new JupiterMarketsClient();

export const SIPHON_MCP_TOOLS = [
  {
    name: 'siphon_scan_wallets',
    description:
      'Scan and unify one or more wallets across 25 chains (14 EVMs, 6 Cosmos/IBC, Sui, Aptos, TON, Tron, Bitcoin) with live DeFi detection and signed Two-Level ROI verdicts. Returned token symbols/names are sanitized untrusted on-chain data.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['wallets'],
      properties: {
        wallets: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              address: {
                type: 'string',
                minLength: 3,
                maxLength: 160,
                description: 'Wallet address (0x…, cosmos1…, bc1…, EQ…, T…)',
              },
              label: { type: 'string', maxLength: 64 },
              family: { type: 'string', enum: ['evm', 'cosmos', 'sui', 'aptos', 'ton', 'tron', 'btc'] },
              presetId: { type: 'string', maxLength: 64 },
            },
          },
        },
      },
    },
  },
  {
    name: 'siphon_plan_dust_conversion',
    description:
      'Analyze small/dust token balances across all scanned chains and compute exact per-(wallet, chain) batch-rescue ROI savings vs individual swaps.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['scanId'],
      properties: {
        scanId: { type: 'string', minLength: 1, maxLength: 128 },
        maxDustThresholdUsd: { type: 'number', minimum: 1, maximum: 250, default: 25 },
        protocolFeeBps: { type: 'integer', minimum: 500, maximum: 1000, default: 700 },
      },
    },
  },
  {
    name: 'siphon_list_agent_mandates',
    description:
      'Inspect active SiphonAgentVault policy-bounded smart-contract agent mandates, locked Solana destinations, and remaining daily USD caps. Mandates are owner-created only in the Siphon UI or on-chain.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'siphon_request_sweep_permission',
    description:
      'Propose a dust conversion, DeFi withdrawal, or multi-chain sweep to Solana. Enforces human-in-the-loop permission approval (or active SiphonAgentVault mandate auto-approval under cap) and verifies assetIds against scanCache.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['actionType', 'summary', 'sourceWallets', 'chains', 'solanaDestination', 'grossUsd', 'estimatedNetUsdc'],
      properties: {
        mandateId: { type: 'string', minLength: 1, maxLength: 64 },
        actionType: { type: 'string', enum: ['dust_convert', 'defi_withdraw', 'bridge_solana', 'burn_zero_liq'] },
        summary: { type: 'string', minLength: 1, maxLength: 240 },
        sourceWallets: {
          type: 'array',
          maxItems: 20,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        chains: {
          type: 'array',
          maxItems: 25,
          items: { type: 'string', minLength: 1, maxLength: 32 },
        },
        solanaDestination: { type: 'string', minLength: 32, maxLength: 64 },
        grossUsd: { type: 'number', exclusiveMinimum: 0, maximum: 10_000_000 },
        estimatedNetUsdc: { type: 'number', minimum: -1_000_000, maximum: 10_000_000 },
        protocolFeeBps: { type: 'integer', minimum: 500, maximum: 1000, default: 700 },
        assetIds: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
    },
  },
  {
    name: 'siphon_list_pending_approvals',
    description: 'Check pending, approved, or rejected AI permission requests in the Siphon Permission Gate.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'siphon_preservation_audit',
    description:
      'Run Siphon Capital-Preservation Route Auction (evaluatePreservationPlan) for a cached scanId or walletAddress, returning exact dollars saved (gas batching, Permit2/EIP-2612 approvals, negative-ROI pruning, route auction), best bridge route per chain, and Ethereum L1 gas-timing advice. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scanId: { type: 'string', minLength: 1, maxLength: 128 },
        walletAddress: {
          type: 'string',
          minLength: 3,
          maxLength: 160,
          description: 'Previously scanned wallet address (0x…, cosmos1…, bc1…, EQ…, T…)',
        },
        outputAsset: { type: 'string', enum: ['USDC', 'SOL'], default: 'USDC' },
        protocolFeeBps: { type: 'integer', minimum: 0, maximum: 1000 },
        maxBaseFeeGwei: { type: 'number', exclusiveMinimum: 0, maximum: 500, default: 15 },
        hasSolanaUsdcAta: { type: 'boolean' },
        fetchLiveGas: { type: 'boolean', default: false },
        includeLiveUnlocks: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'siphon_list_unlock_schedule',
    description:
      'Return live pending on-chain unlocks across Ethereum Lido Withdrawal Queue (stETH NFTs), Ethena sUSDe cooldowns, Cosmos staking unbonding delegations, scan-indexed DeFi locks, and attested Circle CCTP claims, deduplicated and sorted soonest-first. Read-only.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scanId: { type: 'string', minLength: 1, maxLength: 128 },
        evmAddress: {
          type: 'string',
          minLength: 42,
          maxLength: 42,
          description: '20-byte Ethereum 0x wallet address for live Lido Withdrawal Queue & Ethena sUSDe cooldown queries',
        },
        cosmosAddresses: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: {
            type: 'string',
            minLength: 39,
            maxLength: 90,
            description: 'Valid Bech32 Cosmos address (cosmos1…, osmo1…, celestia1…, inj1…)',
          },
        },
        includeLiveOnChain: { type: 'boolean', default: true },
        attestedCctpLegs: {
          type: 'array',
          maxItems: 25,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['chain', 'amountUsdc', 'attestationStatus'],
            properties: {
              chain: { type: 'string', minLength: 2, maxLength: 32 },
              chainName: { type: 'string', maxLength: 48 },
              amountUsdc: { type: 'number', exclusiveMinimum: 0, maximum: 100_000_000 },
              txHash: { type: 'string', maxLength: 128 },
              attestationStatus: { type: 'string', enum: ['pending_confirmations', 'complete'] },
              estimatedReadyAt: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    },
  },
  {
    name: 'siphon_solana_rent_scan',
    description:
      'Scan a Solana wallet across SPL Token and Token-2022 programs for zero-balance non-frozen empty Associated Token Accounts (ATAs) eligible for free SOL rent recovery (0.00203928 SOL per empty account). Read-only; never signs or submits transactions.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ownerAddress'],
      properties: {
        ownerAddress: {
          type: 'string',
          minLength: 32,
          maxLength: 64,
          description: 'Valid non-zero Solana base58 public key',
        },
        solPriceUsd: { type: 'number', exclusiveMinimum: 0, maximum: 100_000 },
        maxAccountsPerTx: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
      },
    },
  },
  {
    name: 'siphon_solana_yield_preview',
    description:
      'Compute Siphon Preservation-First Solana post-arrival split: default 90% Preserved Yield (JupSOL, Jupiter Lend jlUSDC, or Kamino USDC) + 10% Degen Side-Pocket with exact micro-USDC accounting and projected APY. Read-only preview; never signs or swaps autonomously.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['totalUsdcAmount'],
      properties: {
        ownerAddress: {
          type: 'string',
          minLength: 32,
          maxLength: 64,
          description: 'Optional Solana base58 public key for live Jupiter quote preview',
        },
        totalUsdcAmount: {
          type: 'number',
          exclusiveMinimum: 0,
          maximum: MAX_TOTAL_USDC_AMOUNT,
        },
        preservePct: {
          type: 'number',
          minimum: MIN_PRESERVE_PCT,
          maximum: MAX_PRESERVE_PCT,
          default: DEFAULT_PRESERVE_PCT,
        },
        strategy: {
          type: 'string',
          enum: ['jupsol', 'jupiter_lend_usdc', 'kamino_usdc'],
          default: 'jupiter_lend_usdc',
        },
        fetchLiveQuote: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'siphon_degen_markets',
    description:
      'List live trending Jupiter Prediction Markets & implied odds for AI-assisted market research. Strictly read-only: NEVER places bets, builds signed orders, or moves funds autonomously without explicit user approval in Siphon.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        category: {
          type: 'string',
          enum: [...ALLOWED_JUPITER_CATEGORIES],
          default: 'all',
        },
        filter: {
          type: 'string',
          enum: [...ALLOWED_JUPITER_FILTERS],
          default: 'trending',
        },
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 120,
          description: 'Optional keyword search across live Jupiter Prediction events',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          default: 10,
        },
      },
    },
  },
];

function jsonRpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
}

function isValidRpcId(id: unknown): id is string | number | null | undefined {
  return id === undefined || id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

function parseStrictFiniteNumber(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function assertValidEvmAddressStrict(raw: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: `Invalid params: ${field} must be a 20-byte 0x EVM address string.` };
  }
  const clean = raw.trim();
  if (!clean || CONTROL_CHAR_RE.test(clean)) {
    return { ok: false, error: `Invalid params: ${field} contains invalid or control characters.` };
  }
  const res = validateEvmHexAddress(clean);
  if (!res.valid || !res.normalized) {
    return { ok: false, error: `Invalid params: ${field} — ${res.reason ?? 'invalid EVM address.'}` };
  }
  const lower = res.normalized.toLowerCase();
  if (lower === ZERO_EVM_ADDRESS || lower === DEAD_BURN_ADDRESS.toLowerCase()) {
    return { ok: false, error: `Invalid params: ${field} cannot be the zero or burn address.` };
  }
  return { ok: true, value: res.normalized };
}

function assertValidSolanaAddressStrict(raw: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: `Invalid params: ${field} must be a valid Solana base58 address string.` };
  }
  const clean = raw.trim();
  if (clean.length < 32 || clean.length > 64 || CONTROL_CHAR_RE.test(clean)) {
    return { ok: false, error: `Invalid params: ${field} must be a valid Solana base58 public key.` };
  }
  try {
    solanaAddressToBytes32(clean);
    return { ok: true, value: clean };
  } catch {
    return { ok: false, error: `Invalid params: ${field} must be a valid non-zero Solana base58 public key.` };
  }
}

function findCachedScanByWallet(scanCache: ScanCacheLike, walletAddress: string): ScanReport | undefined {
  const needle = walletAddress.trim();
  if (!needle) return undefined;
  const needleLower = needle.toLowerCase();
  const scans = Array.from(scanCache.values()).reverse();
  for (const scan of scans) {
    if (scan.walletAddress) {
      const candidate = scan.walletAddress.trim();
      if (candidate === needle || candidate.toLowerCase() === needleLower) {
        return scan;
      }
    }
    if (Array.isArray(scan.unifiedWallets)) {
      const matchedUnified = scan.unifiedWallets.some(
        (w) => typeof w.address === 'string' && w.address.trim().toLowerCase() === needleLower
      );
      if (matchedUnified) return scan;
    }
  }
  return undefined;
}

export async function handleMcpJsonRpc(
  rawBody: unknown,
  ctx: McpToolContext
): Promise<Record<string, unknown>> {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    return jsonRpcError(null, -32600, 'Invalid Request: expected JSON-RPC 2.0 object.');
  }
  const body = rawBody as JsonRpcRequest;
  if (!isValidRpcId(body.id)) {
    return jsonRpcError(null, -32600, 'Invalid Request: id must be string, number, or null.');
  }
  const id = body.id ?? null;
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string' || !body.method.trim()) {
    return jsonRpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0" and method must be a non-empty string.');
  }
  const method = body.method;

  if (method === 'initialize') {
    const requestedVersion =
      body.params && typeof body.params.protocolVersion === 'string'
        ? body.params.protocolVersion
        : MCP_PROTOCOL_VERSION;
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : MCP_PROTOCOL_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'siphon-migrator-mcp',
          version: '2.0.0',
        },
      },
    };
  }

  if (method === 'notifications/initialized' || method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: SIPHON_MCP_TOOLS },
    };
  }

  if (method === 'tools/call') {
    if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
      return jsonRpcError(id, -32602, 'Invalid params: expected object with tool name and arguments.');
    }
    const toolName = typeof body.params.name === 'string' ? body.params.name : '';
    const rawArgs = body.params.arguments ?? {};
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      return jsonRpcError(id, -32602, 'Invalid params: tool arguments must be a JSON object.');
    }
    const args = rawArgs as Record<string, unknown>;

    if (toolName === 'siphon_create_agent_mandate') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'siphon_create_agent_mandate is disabled via MCP for security: mandates must be created by the wallet owner in the Siphon UI or on-chain in SiphonAgentVault.',
            },
          ],
        },
      };
    }

    const knownTool = SIPHON_MCP_TOOLS.some((t) => t.name === toolName);
    if (!knownTool) {
      return jsonRpcError(id, -32602, `Unknown MCP tool: ${toolName}`);
    }

    try {
      let result: unknown;
      const nowMs = (ctx.nowMs ?? (() => Date.now()))();

      if (toolName === 'siphon_scan_wallets') {
        if (!Array.isArray(args.wallets) || args.wallets.length === 0 || args.wallets.length > 20) {
          return jsonRpcError(id, -32602, 'Invalid params: wallets must be an array of 1 to 20 wallet descriptors.');
        }
        const wallets: Array<{ address?: string; label?: string; family?: ChainFamily; presetId?: string }> = [];
        for (const item of args.wallets) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return jsonRpcError(id, -32602, 'Invalid params: each wallet entry must be an object.');
          }
          const w = item as Record<string, unknown>;
          if (w.address !== undefined && (typeof w.address !== 'string' || w.address.length > 160)) {
            return jsonRpcError(id, -32602, 'Invalid params: wallet address must be a string <= 160 chars.');
          }
          if (w.label !== undefined && (typeof w.label !== 'string' || w.label.length > 64)) {
            return jsonRpcError(id, -32602, 'Invalid params: wallet label must be a string <= 64 chars.');
          }
          if (w.presetId !== undefined && (typeof w.presetId !== 'string' || w.presetId.length > 64)) {
            return jsonRpcError(id, -32602, 'Invalid params: wallet presetId must be a string <= 64 chars.');
          }
          if (w.family !== undefined && (typeof w.family !== 'string' || !VALID_FAMILIES.has(w.family))) {
            return jsonRpcError(id, -32602, `Invalid params: unsupported family '${String(w.family)}'.`);
          }
          wallets.push({
            address: w.address as string | undefined,
            label: w.label ? sanitizeFreeText(w.label as string, 64) : undefined,
            family: w.family as ChainFamily | undefined,
            presetId: w.presetId as string | undefined,
          });
        }
        const report = await scanUnifiedWallets({ wallets });
        ctx.scanCache.set(report.scanId, report);
        result = {
          scanId: report.scanId,
          family: report.family,
          families: report.families,
          walletLabel: sanitizeFreeText(report.walletLabel, 120),
          chainsScanned: report.chainsScanned,
          unifiedWallets: report.unifiedWallets,
          totals: report.totals,
          topAssets: report.assets.slice(0, 25).map((a) => ({
            id: a.id,
            family: a.family,
            chain: a.chain,
            symbol: sanitizeTokenSymbol(a.symbol),
            name: sanitizeTokenName(a.name),
            protocol: a.protocol ? sanitizeFreeText(a.protocol, 48) : undefined,
            sourceWallet: a.sourceWallet,
            grossUsd: a.grossUsd,
            netRoiUsd: a.netRoiUsd,
            roiVerdict: a.roiVerdict,
            action: a.action,
          })),
        };
      } else if (toolName === 'siphon_plan_dust_conversion') {
        if (typeof args.scanId !== 'string' || !args.scanId.trim() || args.scanId.length > 128) {
          return jsonRpcError(id, -32602, 'Invalid params: scanId must be a non-empty string <= 128 chars.');
        }
        const maxDust =
          args.maxDustThresholdUsd !== undefined ? Number(args.maxDustThresholdUsd) : 25;
        const feeBps = args.protocolFeeBps !== undefined ? Number(args.protocolFeeBps) : 700;
        if (!Number.isFinite(maxDust) || maxDust < 1 || maxDust > 250) {
          return jsonRpcError(id, -32602, 'Invalid params: maxDustThresholdUsd must be a finite number in [1, 250].');
        }
        if (!Number.isFinite(feeBps) || feeBps < 500 || feeBps > 1000) {
          return jsonRpcError(id, -32602, 'Invalid params: protocolFeeBps must be a finite number in [500, 1000].');
        }
        const scan = ctx.scanCache.get(args.scanId.trim());
        if (!scan) throw new Error('scanId not found — call siphon_scan_wallets first.');
        result = planDustConversion({
          scan,
          maxDustThresholdUsd: maxDust,
          protocolFeeBps: feeBps,
        });
      } else if (toolName === 'siphon_list_agent_mandates') {
        result = { mandates: ctx.agentEngine.listMandates() };
      } else if (toolName === 'siphon_request_sweep_permission') {
        if (typeof args.actionType !== 'string' || !VALID_ACTIONS.has(args.actionType)) {
          return jsonRpcError(id, -32602, `Invalid params: actionType must be one of ${Array.from(VALID_ACTIONS).join(', ')}.`);
        }
        if (typeof args.solanaDestination !== 'string' || args.solanaDestination.trim().length < 32 || args.solanaDestination.trim().length > 64) {
          return jsonRpcError(id, -32602, 'Invalid params: solanaDestination must be a valid Solana base58 address.');
        }
        if (args.summary !== undefined && (typeof args.summary !== 'string' || args.summary.length > 240)) {
          return jsonRpcError(id, -32602, 'Invalid params: summary must be a string <= 240 chars.');
        }
        const grossUsd = Number(args.grossUsd);
        const estimatedNetUsdc = Number(args.estimatedNetUsdc);
        if (!Number.isFinite(grossUsd) || grossUsd <= 0 || grossUsd > 10_000_000) {
          return jsonRpcError(id, -32602, 'Invalid params: grossUsd must be a finite number in (0, 10000000].');
        }
        if (!Number.isFinite(estimatedNetUsdc) || estimatedNetUsdc < -1_000_000 || estimatedNetUsdc > 10_000_000) {
          return jsonRpcError(id, -32602, 'Invalid params: estimatedNetUsdc must be a finite number.');
        }
        if (args.sourceWallets !== undefined && (!Array.isArray(args.sourceWallets) || args.sourceWallets.length > 20)) {
          return jsonRpcError(id, -32602, 'Invalid params: sourceWallets must be an array of <= 20 items.');
        }
        if (args.chains !== undefined && (!Array.isArray(args.chains) || args.chains.length > 25)) {
          return jsonRpcError(id, -32602, 'Invalid params: chains must be an array of <= 25 items.');
        }
        if (args.assetIds !== undefined && (!Array.isArray(args.assetIds) || args.assetIds.length > 100)) {
          return jsonRpcError(id, -32602, 'Invalid params: assetIds must be an array of <= 100 items.');
        }
        const protocolFeeBps =
          args.protocolFeeBps !== undefined ? Number(args.protocolFeeBps) : 700;
        if (!Number.isFinite(protocolFeeBps)) {
          return jsonRpcError(id, -32602, 'Invalid params: protocolFeeBps must be a finite number.');
        }

        result = ctx.agentEngine.requestPermission({
          client: 'claude_mcp',
          mandateId: typeof args.mandateId === 'string' && args.mandateId.trim() ? args.mandateId.trim() : undefined,
          actionType: args.actionType as AgentActionType,
          summary: sanitizeFreeText(args.summary as string | undefined, 240, 'Sweep request via Claude MCP'),
          sourceWallets: Array.isArray(args.sourceWallets) ? args.sourceWallets.map(String) : [],
          chains: Array.isArray(args.chains) ? (args.chains as AnyChainId[]) : [],
          solanaDestination: args.solanaDestination.trim(),
          grossUsd,
          estimatedNetUsdc,
          protocolFeeBps,
          assetIds: Array.isArray(args.assetIds) ? args.assetIds.map(String) : [],
          scanCache: ctx.scanCache.values(),
        });
      } else if (toolName === 'siphon_list_pending_approvals') {
        result = { approvals: ctx.agentEngine.listApprovals() };
      } else if (toolName === 'siphon_preservation_audit') {
        const hasScanId = args.scanId !== undefined;
        const hasWallet = args.walletAddress !== undefined;
        if (!hasScanId && !hasWallet) {
          return jsonRpcError(id, -32602, 'Invalid params: provide scanId or walletAddress.');
        }

        let scanIdClean: string | undefined;
        if (hasScanId) {
          if (
            typeof args.scanId !== 'string' ||
            !args.scanId.trim() ||
            args.scanId.length > 128 ||
            CONTROL_CHAR_RE.test(args.scanId)
          ) {
            return jsonRpcError(id, -32602, 'Invalid params: scanId must be a non-empty string <= 128 chars.');
          }
          scanIdClean = args.scanId.trim();
        }

        let walletClean: string | undefined;
        if (hasWallet) {
          if (
            typeof args.walletAddress !== 'string' ||
            !args.walletAddress.trim() ||
            args.walletAddress.length > 160 ||
            CONTROL_CHAR_RE.test(args.walletAddress)
          ) {
            return jsonRpcError(id, -32602, 'Invalid params: walletAddress must be a valid wallet address string.');
          }
          const detected = detectAddress(args.walletAddress.trim());
          if (!detected) {
            return jsonRpcError(
              id,
              -32602,
              'Invalid params: walletAddress is not a valid EVM, Cosmos, Sui, Aptos, TON, Tron, or Bitcoin address.'
            );
          }
          const lower = detected.normalized.toLowerCase();
          if (lower === ZERO_EVM_ADDRESS || lower === DEAD_BURN_ADDRESS.toLowerCase()) {
            return jsonRpcError(id, -32602, 'Invalid params: walletAddress cannot be the zero or burn address.');
          }
          walletClean = detected.normalized;
        }

        if (args.outputAsset !== undefined && args.outputAsset !== 'USDC' && args.outputAsset !== 'SOL') {
          return jsonRpcError(id, -32602, "Invalid params: outputAsset must be 'USDC' or 'SOL'.");
        }

        let protocolFeeBps: number | undefined;
        if (args.protocolFeeBps !== undefined) {
          const parsed = parseStrictFiniteNumber(args.protocolFeeBps);
          if (parsed === null || !Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
            return jsonRpcError(id, -32602, 'Invalid params: protocolFeeBps must be an integer in [0, 1000].');
          }
          protocolFeeBps = parsed;
        }

        let maxBaseFeeGwei: number | undefined;
        if (args.maxBaseFeeGwei !== undefined) {
          const parsed = parseStrictFiniteNumber(args.maxBaseFeeGwei);
          if (parsed === null || parsed <= 0 || parsed > 500) {
            return jsonRpcError(id, -32602, 'Invalid params: maxBaseFeeGwei must be a finite number in (0, 500].');
          }
          maxBaseFeeGwei = parsed;
        }

        if (args.hasSolanaUsdcAta !== undefined && typeof args.hasSolanaUsdcAta !== 'boolean') {
          return jsonRpcError(id, -32602, 'Invalid params: hasSolanaUsdcAta must be a boolean.');
        }
        if (args.fetchLiveGas !== undefined && typeof args.fetchLiveGas !== 'boolean') {
          return jsonRpcError(id, -32602, 'Invalid params: fetchLiveGas must be a boolean.');
        }
        if (args.includeLiveUnlocks !== undefined && typeof args.includeLiveUnlocks !== 'boolean') {
          return jsonRpcError(id, -32602, 'Invalid params: includeLiveUnlocks must be a boolean.');
        }

        const scan =
          (scanIdClean ? ctx.scanCache.get(scanIdClean) : undefined) ??
          (walletClean ? findCachedScanByWallet(ctx.scanCache, walletClean) : undefined);
        if (!scan) {
          throw new Error('Cached scan not found — call siphon_scan_wallets first.');
        }

        const plan = await evaluatePreservationPlan(scan, {
          outputAsset: (args.outputAsset as 'USDC' | 'SOL' | undefined) ?? 'USDC',
          protocolFeeBps,
          maxBaseFeeGwei,
          hasSolanaUsdcAta: args.hasSolanaUsdcAta as boolean | undefined,
          fetchLiveGas: Boolean(args.fetchLiveGas),
          gasPriceFetcher: ctx.gasPriceFetcher,
          fetchLiveUnlockQueues: Boolean(args.includeLiveUnlocks),
          liveUnlockReaderOptions:
            args.includeLiveUnlocks || ctx.unlockReaderOptions
              ? ctx.unlockReaderOptions
              : undefined,
          nowMs,
        });

        result = {
          readOnly: true,
          scanId: scan.scanId,
          walletAddress: plan.walletAddress,
          generatedAt: plan.generatedAt,
          outputAsset: plan.outputAsset,
          protocolFeeBps: plan.protocolFeeBps,
          recommendedBridgePreference: plan.recommendedBridgePreference,
          recommendedRouteLabel: plan.recommendedRouteLabel,
          totals: plan.totals,
          chains: plan.chains.map((c) => ({
            chain: c.chain,
            chainName: sanitizeFreeText(c.chainName, 48),
            sweepableAssetCount: c.sweepableAssetCount,
            prunedNegativeRoiCount: c.prunedNegativeRoiCount,
            grossUsd: c.grossUsd,
            bestRoute: c.bestRoute,
            bestRouteLabel: c.bestRouteLabel,
            recommendedBridgePreference: c.recommendedBridgePreference,
            bestNetUsdPreserved: c.bestNetUsdPreserved,
            bestPreservationRatePct: c.bestPreservationRatePct,
            routeAuctionSavingsUsd: c.routeAuctionSavingsUsd,
            gasSavedUsd: c.gasSavedUsd,
            approvalsSavedUsd: c.approvalsSavedUsd,
            negativeRoiPrunedSavedUsd: c.negativeRoiPrunedSavedUsd,
            popupsEliminated: c.popupsEliminated,
            rationale: sanitizeFreeText(c.rationale, 200),
          })),
          gasTiming: plan.gasTiming,
          unlockScheduleCount: plan.unlockSchedule.length,
          unlockSchedule: plan.unlockSchedule,
        };
      } else if (toolName === 'siphon_list_unlock_schedule') {
        const hasScanId = args.scanId !== undefined;
        const hasEvm = args.evmAddress !== undefined;
        const hasCosmos = args.cosmosAddresses !== undefined;
        const hasCctp = args.attestedCctpLegs !== undefined;

        if (!hasScanId && !hasEvm && !hasCosmos && !hasCctp) {
          return jsonRpcError(
            id,
            -32602,
            'Invalid params: provide at least one of scanId, evmAddress, cosmosAddresses, or attestedCctpLegs.'
          );
        }

        let scan: ScanReport | undefined;
        if (hasScanId) {
          if (
            typeof args.scanId !== 'string' ||
            !args.scanId.trim() ||
            args.scanId.length > 128 ||
            CONTROL_CHAR_RE.test(args.scanId)
          ) {
            return jsonRpcError(id, -32602, 'Invalid params: scanId must be a non-empty string <= 128 chars.');
          }
          scan = ctx.scanCache.get(args.scanId.trim());
          if (!scan) {
            throw new Error('scanId not found — call siphon_scan_wallets first.');
          }
        }

        const evmAddresses: string[] = [];
        if (hasEvm) {
          const check = assertValidEvmAddressStrict(args.evmAddress, 'evmAddress');
          if (!check.ok) return jsonRpcError(id, -32602, check.error);
          evmAddresses.push(check.value);
        }

        const cosmosAddresses: string[] = [];
        if (hasCosmos) {
          if (!Array.isArray(args.cosmosAddresses) || args.cosmosAddresses.length === 0 || args.cosmosAddresses.length > 10) {
            return jsonRpcError(id, -32602, 'Invalid params: cosmosAddresses must be an array of 1 to 10 Bech32 Cosmos addresses.');
          }
          for (const rawAddr of args.cosmosAddresses) {
            if (typeof rawAddr !== 'string' || CONTROL_CHAR_RE.test(rawAddr)) {
              return jsonRpcError(id, -32602, 'Invalid params: each cosmosAddress must be a valid Bech32 string.');
            }
            const validated = validateCosmosAddress(rawAddr);
            if (!validated.valid || !validated.normalized) {
              return jsonRpcError(
                id,
                -32602,
                `Invalid params: malformed cosmosAddress — ${validated.reason ?? 'invalid Bech32 address.'}`
              );
            }
            cosmosAddresses.push(validated.normalized);
          }
        }

        if (args.includeLiveOnChain !== undefined && typeof args.includeLiveOnChain !== 'boolean') {
          return jsonRpcError(id, -32602, 'Invalid params: includeLiveOnChain must be a boolean.');
        }
        const includeLiveOnChain = args.includeLiveOnChain !== false;

        const attestedCctpLegs: AttestedCctpLegInput[] = [];
        if (hasCctp) {
          if (!Array.isArray(args.attestedCctpLegs) || args.attestedCctpLegs.length > 25) {
            return jsonRpcError(id, -32602, 'Invalid params: attestedCctpLegs must be an array of <= 25 entries.');
          }
          for (const rawLeg of args.attestedCctpLegs) {
            if (!rawLeg || typeof rawLeg !== 'object' || Array.isArray(rawLeg)) {
              return jsonRpcError(id, -32602, 'Invalid params: each attestedCctpLeg must be an object.');
            }
            const leg = rawLeg as Record<string, unknown>;
            if (typeof leg.chain !== 'string' || !leg.chain.trim() || leg.chain.length > 32 || CONTROL_CHAR_RE.test(leg.chain)) {
              return jsonRpcError(id, -32602, 'Invalid params: attestedCctpLeg.chain must be a valid chain id.');
            }
            const amountUsdc = parseStrictFiniteNumber(leg.amountUsdc);
            if (amountUsdc === null || amountUsdc <= 0 || amountUsdc > 100_000_000) {
              return jsonRpcError(id, -32602, 'Invalid params: attestedCctpLeg.amountUsdc must be a finite positive number.');
            }
            if (leg.attestationStatus !== 'pending_confirmations' && leg.attestationStatus !== 'complete') {
              return jsonRpcError(
                id,
                -32602,
                "Invalid params: attestedCctpLeg.attestationStatus must be 'pending_confirmations' or 'complete'."
              );
            }
            let estimatedReadyAt: number | undefined;
            if (leg.estimatedReadyAt !== undefined) {
              const parsedReady = parseStrictFiniteNumber(leg.estimatedReadyAt);
              if (parsedReady === null || parsedReady < 0) {
                return jsonRpcError(id, -32602, 'Invalid params: attestedCctpLeg.estimatedReadyAt must be a non-negative number.');
              }
              estimatedReadyAt = parsedReady;
            }
            attestedCctpLegs.push({
              chain: leg.chain.trim() as AnyChainId,
              chainName: typeof leg.chainName === 'string' ? sanitizeFreeText(leg.chainName, 48) : undefined,
              amountUsdc,
              txHash: typeof leg.txHash === 'string' ? sanitizeFreeText(leg.txHash, 128) : undefined,
              attestationStatus: leg.attestationStatus,
              estimatedReadyAt,
            });
          }
        }

        // Also pull EVM & Cosmos wallet addresses from cached scan if supplied
        if (scan) {
          const extracted = extractScanWalletAddresses(scan);
          evmAddresses.push(...extracted.evmAddresses);
          cosmosAddresses.push(...extracted.cosmosAddresses);
        }

        const warnings: string[] = [];
        let liveItems: UnlockScheduleItem[] = [];
        if (includeLiveOnChain && (evmAddresses.length > 0 || cosmosAddresses.length > 0)) {
          const liveReport = await readLiveUnlockQueues({
            ...ctx.unlockReaderOptions,
            evmAddresses,
            cosmosAddresses,
            nowMs,
          });
          liveItems = liveReport.items;
          warnings.push(...liveReport.warnings);
        }

        const schedule = scan
          ? buildUnlockSchedule(scan, attestedCctpLegs, nowMs, liveItems)
          : buildUnlockSchedule(
              {
                scanId: 'live_unlock_lookup',
                mode: 'live_rpc',
                walletAddress: evmAddresses[0] ?? cosmosAddresses[0] ?? '',
                scannedAt: new Date(nowMs).toISOString(),
                scanDurationMs: 0,
                chainsScanned: 0,
                chains: [],
                assets: [],
                totals: {
                  grossUsd: 0,
                  defiGrossUsd: 0,
                  liquidGrossUsd: 0,
                  protocolFeeBps: 0,
                  protocolFeeUsd: 0,
                  singleTxGasUsd: 0,
                  batchedGasUsd: 0,
                  gasSavedUsd: 0,
                  estimatedSlippageUsd: 0,
                  netSolanaUsdc: 0,
                  solEquivalent: 0,
                  solPriceUsd: 150,
                  defiPositionCount: 0,
                  liquidDustCount: 0,
                  burnCandidateCount: 0,
                  honeypotSkippedCount: 0,
                  gasNegativeCount: 0,
                },
                warnings: [],
              },
              attestedCctpLegs,
              nowMs,
              liveItems
            );

        const merged = mergeUnlockSchedule(schedule).map((item) => ({
          ...item,
          symbol: sanitizeTokenSymbol(item.symbol),
          protocol: sanitizeFreeText(item.protocol, 64),
          actionLabel: sanitizeFreeText(item.actionLabel, 140),
        }));

        const readyItems = merged.filter((i) => i.status === 'ready_to_claim');
        const lockedItems = merged.filter((i) => i.status !== 'ready_to_claim');
        const totalEstimatedUsd = Number(merged.reduce((s, i) => s + i.estimatedUsd, 0).toFixed(2));
        const readyToClaimUsd = Number(readyItems.reduce((s, i) => s + i.estimatedUsd, 0).toFixed(2));

        result = {
          readOnly: true,
          generatedAt: new Date(nowMs).toISOString(),
          totalItems: merged.length,
          readyToClaimCount: readyItems.length,
          lockedWaitingCount: lockedItems.length,
          totalEstimatedUsd,
          readyToClaimUsd,
          unlockSchedule: merged,
          warnings,
        };
      } else if (toolName === 'siphon_solana_rent_scan') {
        const ownerCheck = assertValidSolanaAddressStrict(args.ownerAddress, 'ownerAddress');
        if (!ownerCheck.ok) {
          return jsonRpcError(id, -32602, ownerCheck.error);
        }

        let solPriceUsd: number | undefined;
        if (args.solPriceUsd !== undefined) {
          const parsed = parseStrictFiniteNumber(args.solPriceUsd);
          if (parsed === null || parsed <= 0 || parsed > 100_000) {
            return jsonRpcError(id, -32602, 'Invalid params: solPriceUsd must be a finite number in (0, 100000].');
          }
          solPriceUsd = parsed;
        }

        let maxAccountsPerTx: number | undefined;
        if (args.maxAccountsPerTx !== undefined) {
          const parsed = parseStrictFiniteNumber(args.maxAccountsPerTx);
          if (parsed === null || !Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
            return jsonRpcError(id, -32602, 'Invalid params: maxAccountsPerTx must be an integer in [1, 20].');
          }
          maxAccountsPerTx = parsed;
        }

        const scanner = ctx.solanaRentScanner ?? scanReclaimableSolanaRent;
        const scanRes = await scanner(ownerCheck.value, {
          includeUnsignedTx: false,
          solPriceUsd,
          skipPriceFetch: solPriceUsd !== undefined,
          maxAccountsPerTx,
        });

        result = {
          readOnly: true,
          ownerAddress: scanRes.ownerAddress,
          rentPerEmptyAccountSol: scanRes.rentPerEmptyAccountSol ?? SOLANA_EMPTY_ATA_RENT_SOL,
          totalTokenAccountsScanned: scanRes.totalTokenAccountsScanned,
          reclaimableCount: scanRes.reclaimableCount,
          skippedNonZeroCount: scanRes.skippedNonZeroCount,
          skippedFrozenCount: scanRes.skippedFrozenCount,
          skippedUncloseableCount: scanRes.skippedUncloseableCount,
          reclaimableLamports: scanRes.reclaimableLamports,
          reclaimableSol: scanRes.reclaimableSol,
          solPriceUsd: scanRes.solPriceUsd,
          reclaimableUsd: scanRes.reclaimableUsd,
          maxAccountsPerTx: scanRes.maxAccountsPerTx,
          batchesRequired: scanRes.batchesRequired,
          reclaimableAccounts: scanRes.reclaimableAccounts.slice(0, 50),
        };
      } else if (toolName === 'siphon_solana_yield_preview') {
        const totalUsdcAmount = parseStrictFiniteNumber(args.totalUsdcAmount);
        if (totalUsdcAmount === null || totalUsdcAmount <= 0 || totalUsdcAmount > MAX_TOTAL_USDC_AMOUNT) {
          return jsonRpcError(
            id,
            -32602,
            `Invalid params: totalUsdcAmount must be a finite number in (0, ${MAX_TOTAL_USDC_AMOUNT}].`
          );
        }

        let preservePct = DEFAULT_PRESERVE_PCT;
        if (args.preservePct !== undefined) {
          const parsed = parseStrictFiniteNumber(args.preservePct);
          if (parsed === null || parsed < MIN_PRESERVE_PCT || parsed > MAX_PRESERVE_PCT) {
            return jsonRpcError(
              id,
              -32602,
              `Invalid params: preservePct must be a finite number in [${MIN_PRESERVE_PCT}, ${MAX_PRESERVE_PCT}] (Preservation-First guard).`
            );
          }
          preservePct = parsed;
        }

        const rawStrategy = args.strategy ?? 'jupiter_lend_usdc';
        if (typeof rawStrategy !== 'string' || !VALID_YIELD_STRATEGIES.has(rawStrategy)) {
          return jsonRpcError(
            id,
            -32602,
            `Invalid params: strategy must be one of ${Array.from(VALID_YIELD_STRATEGIES).join(', ')}.`
          );
        }
        const strategyId = rawStrategy as SolanaYieldStrategyId;

        let ownerAddress: string | undefined;
        if (args.ownerAddress !== undefined) {
          const ownerCheck = assertValidSolanaAddressStrict(args.ownerAddress, 'ownerAddress');
          if (!ownerCheck.ok) {
            return jsonRpcError(id, -32602, ownerCheck.error);
          }
          ownerAddress = ownerCheck.value;
        }

        if (args.fetchLiveQuote !== undefined && typeof args.fetchLiveQuote !== 'boolean') {
          return jsonRpcError(id, -32602, 'Invalid params: fetchLiveQuote must be a boolean.');
        }
        const fetchLiveQuote = Boolean(args.fetchLiveQuote);

        if (ownerAddress && (ctx.solanaYieldPlanner || fetchLiveQuote)) {
          const planner = ctx.solanaYieldPlanner ?? buildSolanaYieldParkPlan;
          const plan = await planner({
            ownerAddress,
            totalUsdcAmount,
            preservePct,
            strategy: strategyId,
            buildTransaction: false,
            fetchLiveApy: fetchLiveQuote,
          });
          result = {
            readOnly: true,
            autonomousExecutionAllowed: false,
            ...plan,
            transaction: null,
          };
        } else {
          const strategy = SOLANA_YIELD_STRATEGIES[strategyId];
          const split = calculateYieldPreservationSplit(totalUsdcAmount, preservePct);
          const estimatedApyPct = strategy.baselineApyPct;
          const projectedAnnualYieldUsd = Number(((split.yieldUsdc * estimatedApyPct) / 100).toFixed(2));
          const projectedMonthlyYieldUsd = Number((projectedAnnualYieldUsd / 12).toFixed(2));
          const projectedDailyYieldUsd = Number((projectedAnnualYieldUsd / 365).toFixed(4));

          result = {
            readOnly: true,
            autonomousExecutionAllowed: false,
            planVersion: 'siphon-solana-yield-park-v1',
            ownerAddress: ownerAddress ?? null,
            strategy,
            split,
            apy: {
              estimatedApyPct,
              source: 'baseline_estimate',
              apyRangePct: strategy.apyRangePct,
            },
            projections: {
              projectedAnnualYieldUsd,
              projectedMonthlyYieldUsd,
              projectedDailyYieldUsd,
              yieldFundedDegenMonthlyBudgetUsd: projectedMonthlyYieldUsd,
            },
            jupiterQuote: null,
            transaction: null,
            warnings: [],
          };
        }
      } else if (toolName === 'siphon_degen_markets') {
        let category: JupiterCategory = 'all';
        if (args.category !== undefined) {
          if (typeof args.category !== 'string' || !VALID_JUPITER_CATEGORIES.has(args.category.trim().toLowerCase())) {
            return jsonRpcError(
              id,
              -32602,
              `Invalid params: category must be one of ${ALLOWED_JUPITER_CATEGORIES.join(', ')}.`
            );
          }
          category = args.category.trim().toLowerCase() as JupiterCategory;
        }

        let filter: JupiterFilter = 'trending';
        if (args.filter !== undefined) {
          if (typeof args.filter !== 'string' || !VALID_JUPITER_FILTERS.has(args.filter.trim().toLowerCase())) {
            return jsonRpcError(
              id,
              -32602,
              `Invalid params: filter must be one of ${ALLOWED_JUPITER_FILTERS.join(', ')}.`
            );
          }
          filter = args.filter.trim().toLowerCase() as JupiterFilter;
        }

        let query: string | undefined;
        if (args.query !== undefined) {
          if (
            typeof args.query !== 'string' ||
            !args.query.trim() ||
            args.query.trim().length > 120 ||
            CONTROL_CHAR_RE.test(args.query)
          ) {
            return jsonRpcError(id, -32602, 'Invalid params: query must be a non-empty string <= 120 chars without control characters.');
          }
          query = sanitizeFreeText(args.query, 120);
          if (!query) {
            return jsonRpcError(id, -32602, 'Invalid params: query cannot be blank.');
          }
        }

        let limit = 10;
        if (args.limit !== undefined) {
          const parsed = parseStrictFiniteNumber(args.limit);
          if (parsed === null || !Number.isInteger(parsed) || parsed < 1 || parsed > 25) {
            return jsonRpcError(id, -32602, 'Invalid params: limit must be an integer in [1, 25].');
          }
          limit = parsed;
        }

        const jupClient = ctx.jupiterMarketsClient ?? defaultMcpJupiterClient;
        const feed = query
          ? await jupClient.searchEvents({ query, limit })
          : await jupClient.fetchEvents({ category, filter, limit });

        result = {
          readOnly: true,
          autonomousBettingAllowed: false,
          safetyNotice:
            'Strictly read-only Jupiter Prediction Market research feed. Never places bets autonomously; user must explicitly review side-pocket caps and sign in the Siphon Degen tab.',
          ok: feed.ok,
          live: feed.live,
          source: feed.source,
          fetchedAt: feed.fetchedAt,
          category: feed.category,
          filter: feed.filter,
          query: feed.query,
          geoBlocked: feed.geoBlocked ?? false,
          totalReturned: feed.events.length,
          events: feed.events.map((ev) => ({
            eventId: ev.eventId,
            slug: ev.slug,
            jupiterUrl: ev.jupiterUrl,
            title: sanitizeFreeText(ev.title, 160),
            subtitle: sanitizeFreeText(ev.subtitle, 160),
            category: ev.category,
            isActive: ev.isActive,
            isLive: ev.isLive,
            closeTime: ev.closeTime,
            volumeUsd: ev.volumeUsd,
            volume24hrUsd: ev.volume24hrUsd,
            markets: ev.markets.slice(0, 6).map((m) => ({
              marketId: m.marketId,
              title: sanitizeFreeText(m.title, 140),
              status: m.status,
              closeTime: m.closeTime,
              volumeUsd: m.volumeUsd,
              yes: m.yes,
              no: m.no,
            })),
          })),
          error: feed.error ? sanitizeFreeText(feed.error, 200) : undefined,
        };
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        },
      };
    }
  }

  return jsonRpcError(id, -32601, `Unsupported MCP method: ${method}`);
}

/**
 * Ergonomic alias for `handleMcpJsonRpc` used by MCP v2 callers and tests.
 */
export const handleMcpRequest = handleMcpJsonRpc;

/**
 * Proxies stdio MCP JSON-RPC requests to a running Siphon HTTP server (`POST /mcp`)
 * so Claude Desktop / Claude Code stdio sessions share the exact same mandates,
 * pending approvals, and scanCache as the Siphon web UI (preventing split-brain).
 */
export async function proxyMcpJsonRpcToHttp(
  body: JsonRpcRequest,
  opts: {
    apiUrl: string;
    apiToken?: string;
    fetchImpl?: typeof fetch;
  }
): Promise<Record<string, unknown>> {
  const id = body.id ?? null;
  let parsed: URL;
  try {
    parsed = new URL(opts.apiUrl.trim());
  } catch {
    return jsonRpcError(id, -32000, `Invalid SIPHON_API_URL: ${opts.apiUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return jsonRpcError(id, -32000, `Unsupported SIPHON_API_URL protocol: ${parsed.protocol}`);
  }

  const endpoint = parsed.pathname.endsWith('/mcp')
    ? parsed.toString()
    : `${parsed.toString().replace(/\/$/, '')}/mcp`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = opts.apiToken?.trim();
  if (token) {
    headers.Authorization = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
  }

  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (res.status === 202 || res.status === 204) {
      return { jsonrpc: '2.0', id, result: {} };
    }
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }

    if (json && json.jsonrpc === '2.0') {
      return json;
    }

    if (!res.ok) {
      const msg =
        (json && typeof json.error === 'string' && json.error) ||
        `Siphon HTTP MCP proxy error (HTTP ${res.status})`;
      return jsonRpcError(id, res.status === 401 || res.status === 403 ? -32001 : -32000, msg);
    }

    return jsonRpcError(id, -32603, 'Invalid JSON-RPC response from Siphon HTTP server.');
  } catch (err) {
    return jsonRpcError(
      id,
      -32000,
      `Failed to reach Siphon HTTP server at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function createStdioMcpDispatcher(opts?: {
  apiUrl?: string;
  apiToken?: string;
  ctx?: McpToolContext;
  fetchImpl?: typeof fetch;
}): (req: JsonRpcRequest) => Promise<Record<string, unknown>> {
  const apiUrl = (opts?.apiUrl ?? process.env.SIPHON_API_URL ?? '').trim();
  const apiToken = (opts?.apiToken ?? process.env.SIPHON_API_TOKEN ?? '').trim();

  if (apiUrl) {
    return (req: JsonRpcRequest) =>
      proxyMcpJsonRpcToHttp(req, {
        apiUrl,
        apiToken: apiToken || undefined,
        fetchImpl: opts?.fetchImpl,
      });
  }

  const localCtx: McpToolContext = opts?.ctx ?? {
    agentEngine: new SiphonAgentEngine(),
    scanCache: new BoundedTtlCache<string, ScanReport>({
      maxEntries: 40,
      ttlMs: 30 * 60 * 1000,
    }),
  };
  return (req: JsonRpcRequest) => handleMcpJsonRpc(req, localCtx);
}

// Stdio MCP entrypoint for Claude Desktop & Claude Code (`node dist/src/mcp/server.js`)
const isDirectRun =
  typeof process !== 'undefined' &&
  typeof process.argv[1] === 'string' &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  // Never allow stray console.log output to corrupt stdio JSON-RPC stream
  console.log = (...args: unknown[]) => console.error(...args);

  const dispatch = createStdioMcpDispatcher();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let writeChain = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    writeChain = writeChain.then(async () => {
      if (Buffer.byteLength(trimmed, 'utf8') > MAX_STDIO_LINE_BYTES) {
        process.stdout.write(
          JSON.stringify(jsonRpcError(null, -32600, `Request line exceeds ${MAX_STDIO_LINE_BYTES} byte limit.`)) + '\n'
        );
        return;
      }
      let req: unknown;
      try {
        req = JSON.parse(trimmed);
      } catch (err) {
        process.stdout.write(
          JSON.stringify(jsonRpcError(null, -32700, err instanceof Error ? err.message : 'Parse error')) + '\n'
        );
        return;
      }
      try {
        const resp = await dispatch(req as JsonRpcRequest);
        const hasId = Boolean(req && typeof req === 'object' && !Array.isArray(req) && 'id' in req && (req as JsonRpcRequest).id !== undefined);
        if (hasId) {
          process.stdout.write(JSON.stringify(resp) + '\n');
        }
      } catch (err) {
        const id = req && typeof req === 'object' && !Array.isArray(req) ? ((req as JsonRpcRequest).id ?? null) : null;
        process.stdout.write(
          JSON.stringify(jsonRpcError(id, -32603, err instanceof Error ? err.message : 'Internal error')) + '\n'
        );
      }
    });
  });
}
