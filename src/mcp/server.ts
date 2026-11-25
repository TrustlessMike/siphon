import readline from 'node:readline';
import { SiphonAgentEngine, type AgentActionType } from '../agent/mandate-engine.js';
import { planDustConversion } from '../scanner/dust.js';
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

const MCP_PROTOCOL_VERSION = '2024-11-05';

export const SIPHON_MCP_TOOLS = [
  {
    name: 'siphon_scan_wallets',
    description:
      'Scan and unify one or more wallets across 25 chains (14 EVMs, 6 Cosmos/IBC, Sui, Aptos, TON, Tron, Bitcoin) with live DeFi detection and signed Two-Level ROI verdicts.',
    inputSchema: {
      type: 'object',
      required: ['wallets'],
      properties: {
        wallets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              address: { type: 'string', description: 'Wallet address (0x…, cosmos1…, bc1…, EQ…, T…)' },
              label: { type: 'string' },
              family: { type: 'string', enum: ['evm', 'cosmos', 'sui', 'aptos', 'ton', 'tron', 'btc'] },
              presetId: { type: 'string' },
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
    inputSchema: {
      type: 'object',
      required: ['scanId'],
      properties: {
        scanId: { type: 'string' },
        maxDustThresholdUsd: { type: 'number', default: 25 },
        protocolFeeBps: { type: 'number', default: 700 },
      },
    },
  },
  {
    name: 'siphon_list_agent_mandates',
    description:
      'Inspect active SiphonAgentVault policy-bounded smart-contract agent mandates, locked Solana destinations, and remaining daily USD caps. Mandates are owner-created only in the Siphon UI or on-chain.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'siphon_request_sweep_permission',
    description:
      'Propose a dust conversion, DeFi withdrawal, or multi-chain sweep to Solana. Enforces human-in-the-loop permission approval (or active SiphonAgentVault mandate auto-approval under cap) and verifies assetIds against scanCache.',
    inputSchema: {
      type: 'object',
      required: ['actionType', 'summary', 'sourceWallets', 'chains', 'solanaDestination', 'grossUsd', 'estimatedNetUsdc'],
      properties: {
        mandateId: { type: 'string' },
        actionType: { type: 'string', enum: ['dust_convert', 'defi_withdraw', 'bridge_solana', 'burn_zero_liq'] },
        summary: { type: 'string' },
        sourceWallets: { type: 'array', items: { type: 'string' } },
        chains: { type: 'array', items: { type: 'string' } },
        solanaDestination: { type: 'string' },
        grossUsd: { type: 'number' },
        estimatedNetUsdc: { type: 'number' },
        protocolFeeBps: { type: 'number', default: 700 },
        assetIds: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'siphon_list_pending_approvals',
    description: 'Check pending, approved, or rejected AI permission requests in the Siphon Permission Gate.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function handleMcpJsonRpc(
  body: JsonRpcRequest,
  ctx: McpToolContext
): Promise<Record<string, unknown>> {
  const id = body.id ?? null;
  const method = body.method ?? '';

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
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
    const toolName = String(body.params?.name ?? '');
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      let result: unknown;
      if (toolName === 'siphon_scan_wallets') {
        const wallets = Array.isArray(args.wallets)
          ? (args.wallets as Array<{ address?: string; label?: string; family?: ChainFamily; presetId?: string }>)
          : [];
        const report = await scanUnifiedWallets({ wallets });
        ctx.scanCache.set(report.scanId, report);
        result = {
          scanId: report.scanId,
          family: report.family,
          families: report.families,
          walletLabel: report.walletLabel,
          chainsScanned: report.chainsScanned,
          unifiedWallets: report.unifiedWallets,
          totals: report.totals,
          topAssets: report.assets.slice(0, 25).map((a) => ({
            id: a.id,
            family: a.family,
            chain: a.chain,
            symbol: a.symbol,
            protocol: a.protocol,
            sourceWallet: a.sourceWallet,
            grossUsd: a.grossUsd,
            netRoiUsd: a.netRoiUsd,
            roiVerdict: a.roiVerdict,
            action: a.action,
          })),
        };
      } else if (toolName === 'siphon_plan_dust_conversion') {
        const scan = ctx.scanCache.get(String(args.scanId ?? ''));
        if (!scan) throw new Error('scanId not found — call siphon_scan_wallets first.');
        result = planDustConversion({
          scan,
          maxDustThresholdUsd: Number(args.maxDustThresholdUsd ?? 25),
          protocolFeeBps: Number(args.protocolFeeBps ?? 700),
        });
      } else if (toolName === 'siphon_list_agent_mandates') {
        result = { mandates: ctx.agentEngine.listMandates() };
      } else if (toolName === 'siphon_create_agent_mandate') {
        throw new Error(
          'siphon_create_agent_mandate is disabled via MCP for security: mandates must be created by the wallet owner in the Siphon UI or on-chain in SiphonAgentVault.'
        );
      } else if (toolName === 'siphon_request_sweep_permission') {
        result = ctx.agentEngine.requestPermission({
          client: 'claude_mcp',
          mandateId: args.mandateId ? String(args.mandateId) : undefined,
          actionType: (args.actionType as AgentActionType) || 'bridge_solana',
          summary: String(args.summary ?? 'Sweep request via Claude MCP'),
          sourceWallets: Array.isArray(args.sourceWallets) ? args.sourceWallets.map(String) : [],
          chains: Array.isArray(args.chains) ? (args.chains as AnyChainId[]) : [],
          solanaDestination: String(args.solanaDestination ?? ''),
          grossUsd: Number(args.grossUsd ?? 0),
          estimatedNetUsdc: Number(args.estimatedNetUsdc ?? 0),
          protocolFeeBps: args.protocolFeeBps !== undefined ? Number(args.protocolFeeBps) : 700,
          assetIds: Array.isArray(args.assetIds) ? args.assetIds.map(String) : [],
          scanCache: ctx.scanCache.values(),
        });
      } else if (toolName === 'siphon_list_pending_approvals') {
        result = { approvals: ctx.agentEngine.listApprovals() };
      } else {
        throw new Error(`Unknown MCP tool: ${toolName}`);
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

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unsupported MCP method: ${method}` },
  };
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
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: `Invalid SIPHON_API_URL: ${opts.apiUrl}` },
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: `Unsupported SIPHON_API_URL protocol: ${parsed.protocol}` },
    };
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
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: res.status === 401 || res.status === 403 ? -32001 : -32000,
          message: msg,
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'Invalid JSON-RPC response from Siphon HTTP server.' },
    };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: `Failed to reach Siphon HTTP server at ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
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
  process.argv[1] &&
  (process.argv[1].endsWith('/mcp/server.js') || process.argv[1].endsWith('/mcp/server.ts'));

if (isDirectRun) {
  const dispatch = createStdioMcpDispatcher();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed) as JsonRpcRequest;
      const resp = await dispatch(req);
      if (req.id !== undefined) {
        process.stdout.write(JSON.stringify(resp) + '\n');
      }
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: err instanceof Error ? err.message : 'Parse error' },
        }) + '\n'
      );
    }
  });
}
