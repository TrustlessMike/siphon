import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { SiphonAgentEngine, type AgentActionType } from '../agent/mandate-engine.js';
import { planDustConversion } from '../scanner/dust.js';
import { sanitizeFreeText, sanitizeTokenName, sanitizeTokenSymbol } from '../scanner/sanitize.js';
import { scanUnifiedWallets } from '../scanner/unify.js';
import type { AnyChainId, ChainFamily, ScanReport } from '../scanner/types.js';
import { BoundedTtlCache } from '../server/cache.js';

export interface ScanCacheLike {
  get(key: string): ScanReport | undefined;
  set(key: string, value: ScanReport): unknown;
  values(): IterableIterator<ScanReport>;
}

export interface McpToolContext {
  agentEngine: SiphonAgentEngine;
  scanCache: ScanCacheLike;
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
const VALID_FAMILIES = new Set<string>(['evm', 'cosmos', 'sui', 'aptos', 'ton', 'tron', 'btc']);
const VALID_ACTIONS = new Set<string>(['dust_convert', 'defi_withdraw', 'bridge_solana', 'burn_zero_liq']);

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
          version: '1.0.0',
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
