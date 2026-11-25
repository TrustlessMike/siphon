import readline from 'node:readline';
import { SiphonAgentEngine, type AgentActionType } from '../agent/mandate-engine.js';
import { planDustConversion } from '../scanner/dust.js';
import { scanUnifiedWallets } from '../scanner/unify.js';
import type { AnyChainId, ChainFamily, ScanReport } from '../scanner/types.js';

export interface McpToolContext {
  agentEngine: SiphonAgentEngine;
  scanCache: Map<string, ScanReport>;
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
      'Analyze small/dust token balances across all scanned chains and compute exact batch-rescue ROI savings vs individual swaps.',
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
      'Inspect active SiphonAgentVault policy-bounded smart-contract agent mandates, locked Solana destinations, and remaining daily USD caps.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'siphon_create_agent_mandate',
    description:
      'Configure a policy-bounded SiphonAgentVault mandate with an immutable locked Solana recipient, per-tx USD cap, daily USD cap, and auto-approve tier.',
    inputSchema: {
      type: 'object',
      required: ['ownerAddress', 'lockedSolanaRecipient'],
      properties: {
        name: { type: 'string' },
        ownerAddress: { type: 'string' },
        lockedSolanaRecipient: { type: 'string' },
        maxPerTxUsd: { type: 'number', default: 250 },
        dailyCapUsd: { type: 'number', default: 1000 },
        autoApproveUnderUsd: { type: 'number', default: 50 },
        allowedActions: {
          type: 'array',
          items: { type: 'string', enum: ['dust_convert', 'defi_withdraw', 'bridge_solana', 'burn_zero_liq'] },
        },
      },
    },
  },
  {
    name: 'siphon_request_sweep_permission',
    description:
      'Propose a dust conversion, DeFi withdrawal, or multi-chain sweep to Solana. Enforces human-in-the-loop permission approval (or active SiphonAgentVault mandate auto-approval under cap).',
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
  body: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> },
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
          walletLabel: report.walletLabel,
          chainsScanned: report.chainsScanned,
          unifiedWallets: report.unifiedWallets,
          totals: report.totals,
          topAssets: report.assets.slice(0, 25).map((a) => ({
            id: a.id,
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
        result = ctx.agentEngine.createMandate({
          name: args.name ? String(args.name) : undefined,
          ownerAddress: String(args.ownerAddress ?? ''),
          lockedSolanaRecipient: String(args.lockedSolanaRecipient ?? ''),
          maxPerTxUsd: args.maxPerTxUsd !== undefined ? Number(args.maxPerTxUsd) : undefined,
          dailyCapUsd: args.dailyCapUsd !== undefined ? Number(args.dailyCapUsd) : undefined,
          autoApproveUnderUsd:
            args.autoApproveUnderUsd !== undefined ? Number(args.autoApproveUnderUsd) : undefined,
          allowedActions: Array.isArray(args.allowedActions)
            ? (args.allowedActions as AgentActionType[])
            : undefined,
        });
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

// Stdio MCP entrypoint for Claude Desktop & Claude Code (`node dist/src/mcp/server.js`)
const isDirectRun =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('/mcp/server.js') || process.argv[1].endsWith('/mcp/server.ts'));

if (isDirectRun) {
  const ctx: McpToolContext = {
    agentEngine: new SiphonAgentEngine(),
    scanCache: new Map<string, ScanReport>(),
  };
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const req = JSON.parse(trimmed) as {
        jsonrpc?: string;
        id?: string | number | null;
        method?: string;
        params?: Record<string, unknown>;
      };
      const resp = await handleMcpJsonRpc(req, ctx);
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
