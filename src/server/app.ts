import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  detectAddressFamily,
  getAdapterForChain,
  getAdapterForFamily,
  isEvmChain,
  listAllFamilyMetas,
} from '../adapters/registry.js';
import {
  buildMigrationPlan,
  fetchCctpAttestationForTx,
  solanaAddressToBytes32,
} from '../bridge/cctp.js';
import { buildPreSignSimulationProof, verifyOnchainExecutionProof } from '../execution/proof.js';
import {
  checkLiveExecutionStatus,
  prepareChainBatchExecution,
  prepareRealExecution,
} from '../execution/tx-builder.js';
import {
  buildGaslessSweepIntent,
  isSponsorRelayerConfigured,
  submitSignedGaslessIntent,
} from '../relayer/sponsor.js';
import {
  CHAIN_LIST,
  DEAD_BURN_ADDRESS,
  getProtocolFeeConfig,
  PROTOCOL_FEE_BPS,
  SOLANA_CCTP_DOMAIN,
} from '../scanner/chains.js';
import { scanLiveWallet, scanPresetWallet, WALLET_PRESETS } from '../scanner/classifier.js';
import { fetchSolanaWalletBalances, getL2IndexerProvider } from '../scanner/discovery.js';
import {
  SiphonAgentEngine,
  type AgentActionType,
  type PluginClientKind,
} from '../agent/mandate-engine.js';
import {
  buildAiPluginManifest,
  buildOpenApiSpec,
  buildPluginSetupGuide,
} from '../agent/plugin-spec.js';
import { handleMcpJsonRpc } from '../mcp/server.js';
import { planDustConversion } from '../scanner/dust.js';
import { scanUnifiedWallets, type UnifiedWalletInput } from '../scanner/unify.js';
import { evaluatePortfolioRoi } from '../scanner/roi.js';
import type { AnyChainId, ChainFamily, EvmChainId, ScannedAsset, ScanReport } from '../scanner/types.js';
import { BackgroundJobStore, type JobLegStatus } from './jobs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Works from both src/server (tsx) and dist/src/server (node): walk up to the package root.
function findPackageRoot(start: string): string {
  let dir = start;
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start, '../..');
    dir = parent;
  }
  return dir;
}
const ROOT_DIR = findPackageRoot(__dirname);
const PUBLIC_DIR = path.resolve(ROOT_DIR, 'public');
const CONTRACTS_DIR = path.resolve(ROOT_DIR, 'contracts');
const THREE_BUILD_DIR = path.resolve(ROOT_DIR, 'node_modules/three/build');
const DIST_VENDOR_DIR = path.resolve(ROOT_DIR, 'dist/vendor');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const MAX_JSON_BODY_BYTES = 1_048_576; // 1 MiB safety cap

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, 'Request payload exceeds 1 MiB limit.');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Malformed JSON request body.');
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

function serveStaticFile(res: ServerResponse, reqPath: string, isHead = false): boolean {
  if (reqPath === '/vendor/wallet-sdks.js') {
    const bundleFile = path.join(DIST_VENDOR_DIR, 'wallet-sdks.js');
    if (fs.existsSync(bundleFile)) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      if (isHead) res.end();
      else fs.createReadStream(bundleFile).pipe(res);
      return true;
    }
    return false;
  }

  if (reqPath === '/vendor/three.module.js' || reqPath === '/vendor/three.core.js') {
    const fileName = path.basename(reqPath);
    const threeFile = path.join(THREE_BUILD_DIR, fileName);
    if (fs.existsSync(threeFile)) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      if (isHead) res.end();
      else fs.createReadStream(threeFile).pipe(res);
      return true;
    }
    return false;
  }

  const safePath = reqPath === '/' ? '/index.html' : reqPath;
  const fullPath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!fullPath.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return false;

  const ext = path.extname(fullPath);
  const headers: Record<string, string> = {
    'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
  };
  if (ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css') {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    headers['Pragma'] = 'no-cache';
  }
  // Required by Coinbase Smart Wallet SDK popup communication
  if (ext === '.html') {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin-allow-popups';
  }
  res.writeHead(200, headers);
  if (isHead) res.end();
  else fs.createReadStream(fullPath).pipe(res);
  return true;
}

export function createSiphonServer() {
  const scanCache = new Map<string, ScanReport>();
  const jobStore = new BackgroundJobStore();
  const agentEngine = new SiphonAgentEngine();

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const baseUrl = `${url.protocol}//${url.host}`;

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end();
      return;
    }

    try {
      if (method === 'GET' && pathname === '/api/health') {
        const protocolFee = getProtocolFeeConfig();
        return sendJson(res, 200, {
          status: 'ok',
          service: 'siphon-migrator',
          chains: CHAIN_LIST.length,
          solanaCctpDomain: SOLANA_CCTP_DOMAIN,
          protocolFeeBps: protocolFee.feeBps,
          protocolFee,
          l2IndexerProvider: getL2IndexerProvider(),
        });
      }

      if (method === 'GET' && pathname === '/api/config') {
        return sendJson(res, 200, {
          coinbaseSmartWalletEnabled: fs.existsSync(path.join(DIST_VENDOR_DIR, 'wallet-sdks.js')),
          walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID?.trim() || null,
          l2IndexerProvider: getL2IndexerProvider(),
          protocolFee: getProtocolFeeConfig(),
          gaslessRelayerConfigured: isSponsorRelayerConfigured(),
        });
      }

      if (method === 'GET' && pathname === '/api/chains') {
        return sendJson(res, 200, {
          solanaCctpDomain: SOLANA_CCTP_DOMAIN,
          burnSink: DEAD_BURN_ADDRESS,
          protocolFeeBps: PROTOCOL_FEE_BPS,
          protocolFee: getProtocolFeeConfig(),
          chains: CHAIN_LIST,
          families: listAllFamilyMetas(),
          presets: WALLET_PRESETS,
        });
      }

      if (method === 'GET' && pathname === '/api/families') {
        const families = listAllFamilyMetas();
        const totalChains = families.reduce((s, f) => s + f.chains.length, 0);
        return sendJson(res, 200, {
          totalFamilies: families.length,
          totalChains,
          families,
        });
      }

      if (method === 'POST' && pathname === '/api/roi/evaluate') {
        const body = await readJsonBody<{
          scanId?: string;
          scan?: ScanReport;
          protocolFeeBps?: number;
          gasSponsored?: boolean;
          fixedRelayerOverheadUsd?: number;
        }>(req);
        const scan = body.scan ?? (body.scanId ? scanCache.get(body.scanId) : undefined);
        if (!scan) {
          return sendJson(res, 400, { error: 'Valid scan or scanId is required' });
        }
        return sendJson(
          res,
          200,
          evaluatePortfolioRoi(scan, {
            protocolFeeBps: body.protocolFeeBps,
            gasSponsored: body.gasSponsored,
            fixedRelayerOverheadUsd: body.fixedRelayerOverheadUsd,
          })
        );
      }

      if (method === 'GET' && pathname === '/api/contract') {
        const routerPath = path.join(CONTRACTS_DIR, 'SiphonRouter.sol');
        const feeVaultPath = path.join(CONTRACTS_DIR, 'SiphonFeeVault.sol');
        const delegatePath = path.join(CONTRACTS_DIR, 'SiphonSweepDelegate.sol');
        const agentVaultPath = path.join(CONTRACTS_DIR, 'SiphonAgentVault.sol');
        const source = fs.existsSync(routerPath) ? fs.readFileSync(routerPath, 'utf8') : '';
        const feeVaultSource = fs.existsSync(feeVaultPath) ? fs.readFileSync(feeVaultPath, 'utf8') : '';
        const delegateSource = fs.existsSync(delegatePath) ? fs.readFileSync(delegatePath, 'utf8') : '';
        const agentVaultSource = fs.existsSync(agentVaultPath) ? fs.readFileSync(agentVaultPath, 'utf8') : '';
        const protocolFee = getProtocolFeeConfig();
        return sendJson(res, 200, {
          name: 'SiphonRouter.sol',
          solidityVersion: '0.8.24',
          protocolFeeBps: protocolFee.feeBps,
          protocolFee,
          burnSink: DEAD_BURN_ADDRESS,
          solanaCctpDomain: SOLANA_CCTP_DOMAIN,
          source,
          feeVaultSource,
          delegateSource,
          agentVaultSource,
          contracts: [
            { id: 'router', filename: 'contracts/SiphonRouter.sol', title: 'SiphonRouter.sol', source },
            { id: 'delegate', filename: 'contracts/SiphonSweepDelegate.sol', title: 'SiphonSweepDelegate.sol (EIP-7702)', source: delegateSource },
            { id: 'agent', filename: 'contracts/SiphonAgentVault.sol', title: 'SiphonAgentVault.sol (Agents)', source: agentVaultSource },
            { id: 'vault', filename: 'contracts/SiphonFeeVault.sol', title: 'SiphonFeeVault.sol', source: feeVaultSource },
          ],
          chains: CHAIN_LIST.map((c) => ({
            chain: c.name,
            chainId: c.chainId,
            cctpDomain: c.cctpDomain,
            usdc: c.usdcAddress,
            tokenMessenger: c.cctpTokenMessenger,
          })),
        });
      }

      if (method === 'POST' && pathname === '/api/scan/unified') {
        const body = await readJsonBody<{
          wallets?: UnifiedWalletInput[];
          hasSolanaUsdcAta?: boolean;
        }>(req);
        if (!Array.isArray(body.wallets) || !body.wallets.length) {
          return sendJson(res, 400, { error: 'wallets[] array with at least one wallet is required.' });
        }
        const report = await scanUnifiedWallets({
          wallets: body.wallets,
          hasSolanaUsdcAta: body.hasSolanaUsdcAta,
        });
        scanCache.set(report.scanId, report);
        if (scanCache.size > 40) {
          const firstKey = scanCache.keys().next().value;
          if (firstKey) scanCache.delete(firstKey);
        }
        return sendJson(res, 200, report);
      }

      if (method === 'POST' && pathname === '/api/dust/plan') {
        const body = await readJsonBody<{
          scanId?: string;
          scan?: ScanReport;
          maxDustThresholdUsd?: number;
          protocolFeeBps?: number;
          hasSolanaUsdcAta?: boolean;
        }>(req);
        const scan = body.scan ?? (body.scanId ? scanCache.get(body.scanId) : undefined);
        if (!scan) {
          return sendJson(res, 400, { error: 'Valid scan or scanId is required' });
        }
        return sendJson(
          res,
          200,
          planDustConversion({
            scan,
            maxDustThresholdUsd: body.maxDustThresholdUsd,
            protocolFeeBps: body.protocolFeeBps,
            hasSolanaUsdcAta: body.hasSolanaUsdcAta,
          })
        );
      }

      // ================= SMART-CONTRACT AGENTS & PERMISSION GATE =================
      if (method === 'GET' && pathname === '/api/agents/mandates') {
        return sendJson(res, 200, { mandates: agentEngine.listMandates() });
      }

      if (method === 'POST' && pathname === '/api/agents/mandates') {
        const body = await readJsonBody<{
          name?: string;
          ownerAddress?: string;
          agentKey?: string;
          lockedSolanaRecipient?: string;
          maxPerTxUsd?: number;
          dailyCapUsd?: number;
          autoApproveUnderUsd?: number;
          durationDays?: number;
          maxFeeBps?: number;
          minNetOutBps?: number;
          allowedActions?: AgentActionType[];
        }>(req);
        if (!body.ownerAddress || !body.lockedSolanaRecipient) {
          return sendJson(res, 400, { error: 'ownerAddress and lockedSolanaRecipient are required.' });
        }
        try {
          const mandate = agentEngine.createMandate({
            name: body.name,
            ownerAddress: body.ownerAddress,
            agentKey: body.agentKey,
            lockedSolanaRecipient: body.lockedSolanaRecipient,
            maxPerTxUsd: body.maxPerTxUsd,
            dailyCapUsd: body.dailyCapUsd,
            autoApproveUnderUsd: body.autoApproveUnderUsd,
            durationDays: body.durationDays,
            maxFeeBps: body.maxFeeBps,
            minNetOutBps: body.minNetOutBps,
            allowedActions: body.allowedActions,
          });
          return sendJson(res, 200, mandate);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Invalid agent mandate parameters',
          });
        }
      }

      if (method === 'POST' && pathname.startsWith('/api/agents/mandates/') && pathname.endsWith('/revoke')) {
        const mandateId = pathname.slice('/api/agents/mandates/'.length, -'/revoke'.length);
        const revoked = agentEngine.revokeMandate(mandateId);
        if (!revoked) return sendJson(res, 404, { error: 'Agent mandate not found' });
        return sendJson(res, 200, revoked);
      }

      if (method === 'GET' && pathname === '/api/agents/approvals') {
        return sendJson(res, 200, { approvals: agentEngine.listApprovals() });
      }

      if (method === 'POST' && pathname === '/api/agents/approvals') {
        const authHeader = req.headers.authorization;
        const verifiedToken = authHeader ? agentEngine.verifyPluginToken(authHeader) : null;
        if (authHeader && !verifiedToken) {
          return sendJson(res, 401, { error: 'Invalid or revoked Siphon AI Plugin Bearer token.' });
        }

        const body = await readJsonBody<{
          client?: PluginClientKind;
          mandateId?: string;
          actionType?: AgentActionType;
          summary?: string;
          sourceWallets?: string[];
          chains?: AnyChainId[];
          solanaDestination?: string;
          grossUsd?: number;
          estimatedNetUsdc?: number;
          protocolFeeBps?: number;
          assetIds?: string[];
        }>(req);

        if (!body.actionType || !body.solanaDestination) {
          return sendJson(res, 400, { error: 'actionType and solanaDestination are required.' });
        }
        try {
          const approval = agentEngine.requestPermission({
            client: verifiedToken?.client ?? body.client ?? 'smart_contract_agent',
            mandateId: body.mandateId,
            actionType: body.actionType,
            summary: body.summary || `Permission request (${body.actionType})`,
            sourceWallets: Array.isArray(body.sourceWallets) ? body.sourceWallets : [],
            chains: Array.isArray(body.chains) ? body.chains : [],
            solanaDestination: body.solanaDestination,
            grossUsd: Number(body.grossUsd ?? 0),
            estimatedNetUsdc: Number(body.estimatedNetUsdc ?? 0),
            protocolFeeBps: body.protocolFeeBps,
            assetIds: body.assetIds,
          });
          return sendJson(res, 200, approval);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Could not create permission request',
          });
        }
      }

      if (method === 'POST' && pathname.startsWith('/api/agents/approvals/') && pathname.endsWith('/decide')) {
        const approvalId = pathname.slice('/api/agents/approvals/'.length, -'/decide'.length);
        const body = await readJsonBody<{ decision?: 'approve' | 'reject'; reason?: string }>(req);
        if (body.decision !== 'approve' && body.decision !== 'reject') {
          return sendJson(res, 400, { error: "decision must be 'approve' or 'reject'" });
        }
        const decided = agentEngine.decideApproval({
          approvalId,
          decision: body.decision,
          reason: body.reason,
        });
        if (!decided) return sendJson(res, 404, { error: 'Permission request not found' });
        return sendJson(res, 200, decided);
      }

      // ================= CLAUDE MCP & CHATGPT ACTION PLUGIN =================
      if (method === 'GET' && pathname === '/.well-known/ai-plugin.json') {
        return sendJson(res, 200, buildAiPluginManifest(baseUrl));
      }

      if (method === 'GET' && pathname === '/openapi.json') {
        return sendJson(res, 200, buildOpenApiSpec(baseUrl));
      }

      if (method === 'GET' && pathname === '/api/plugin/setup') {
        return sendJson(res, 200, {
          ...buildPluginSetupGuide({ baseUrl, rootDir: ROOT_DIR }),
          tokens: agentEngine.listPluginTokens(),
        });
      }

      if (method === 'POST' && pathname === '/api/plugin/tokens') {
        const body = await readJsonBody<{
          label?: string;
          client?: 'claude_mcp' | 'chatgpt_action';
          scopes?: string[];
        }>(req);
        const issued = agentEngine.issuePluginToken({
          label: body.label || 'AI Assistant Token',
          client: body.client === 'chatgpt_action' ? 'chatgpt_action' : 'claude_mcp',
          scopes: body.scopes,
        });
        return sendJson(res, 200, issued);
      }

      if (method === 'POST' && pathname.startsWith('/api/plugin/tokens/') && pathname.endsWith('/revoke')) {
        const tokenId = pathname.slice('/api/plugin/tokens/'.length, -'/revoke'.length);
        const revoked = agentEngine.revokePluginToken(tokenId);
        if (!revoked) return sendJson(res, 404, { error: 'Plugin token not found' });
        return sendJson(res, 200, revoked);
      }

      if (method === 'POST' && pathname === '/mcp') {
        const authHeader = req.headers.authorization;
        if (authHeader && !agentEngine.verifyPluginToken(authHeader)) {
          return sendJson(res, 401, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: 'Invalid or revoked Siphon MCP Bearer token.' },
          });
        }
        const rpcReq = await readJsonBody<{
          jsonrpc?: string;
          id?: string | number | null;
          method?: string;
          params?: Record<string, unknown>;
        }>(req);
        const rpcRes = await handleMcpJsonRpc(rpcReq, { agentEngine, scanCache });
        return sendJson(res, 200, rpcRes);
      }

      if (method === 'POST' && pathname === '/api/scan') {
        const body = await readJsonBody<{
          address?: string;
          family?: ChainFamily;
          presetId?: string;
          mode?: 'live' | 'preset';
        }>(req);

        let report: ScanReport;
        if (body.presetId) {
          report = await scanPresetWallet(body.presetId);
          report.family = 'evm';
        } else if (body.address) {
          const detected = detectAddressFamily(body.address, body.family);
          if (!detected) {
            return sendJson(res, 400, {
              error:
                'Invalid wallet address format. Supported: EVM (0x… / .eth), Cosmos (cosmos1…/osmo1…/noble1…/celestia1…/inj1…/neutron1…), Sui/Aptos (0x… 64-hex), TON (EQ…/UQ…), Tron (T…), Bitcoin (bc1…/1…/3…).',
            });
          }
          try {
            if (detected === 'evm') {
              report = await scanLiveWallet(body.address);
              report.family = 'evm';
            } else {
              report = await getAdapterForFamily(detected).scanWallet(body.address);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Invalid wallet address';
            if (msg.toLowerCase().includes('invalid')) {
              return sendJson(res, 400, { error: msg });
            }
            throw err;
          }
        } else {
          report = await scanPresetWallet('veteran_defi');
          report.family = 'evm';
        }

        scanCache.set(report.scanId, report);
        if (scanCache.size > 40) {
          const firstKey = scanCache.keys().next().value;
          if (firstKey) scanCache.delete(firstKey);
        }

        return sendJson(res, 200, report);
      }

      if (method === 'POST' && pathname === '/api/plan') {
        const body = await readJsonBody<{
          scanId?: string;
          scan?: ScanReport;
          selectedAssetIds?: string[];
          solanaDestination?: string;
          usePermit2Batch?: boolean;
          includeBurns?: boolean;
          outputAsset?: 'USDC' | 'SOL';
          bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
          protocolFeeBps?: number;
          feeRecipientEvm?: string | null;
          hasSolanaUsdcAta?: boolean;
        }>(req);

        const scan = body.scan ?? (body.scanId ? scanCache.get(body.scanId) : undefined);
        if (!scan) {
          return sendJson(res, 400, { error: 'Valid scan or scanId is required' });
        }

        const solDest = body.solanaDestination?.trim();
        if (!solDest) {
          return sendJson(res, 400, { error: 'solanaDestination is required' });
        }

        try {
          solanaAddressToBytes32(solDest);
        } catch {
          return sendJson(res, 400, { error: 'Invalid Solana destination address (expected base58 public key).' });
        }

        const plan = buildMigrationPlan({
          scan,
          selectedAssetIds: body.selectedAssetIds,
          solanaDestination: solDest,
          usePermit2Batch: body.usePermit2Batch ?? true,
          includeBurns: body.includeBurns ?? true,
          outputAsset: body.outputAsset ?? 'USDC',
          bridgePreference: body.bridgePreference ?? 'auto',
          protocolFeeBps: body.protocolFeeBps,
          feeRecipientEvm: body.feeRecipientEvm,
          hasSolanaUsdcAta: body.hasSolanaUsdcAta,
        });

        return sendJson(res, 200, plan);
      }

      if (method === 'GET' && pathname === '/api/solana/balance') {
        const address = url.searchParams.get('address')?.trim();
        if (!address) return sendJson(res, 400, { error: 'address query parameter is required' });
        try {
          solanaAddressToBytes32(address);
        } catch {
          return sendJson(res, 400, { error: 'Invalid Solana address' });
        }
        try {
          const balances = await fetchSolanaWalletBalances(address);
          return sendJson(res, 200, balances);
        } catch (err) {
          return sendJson(res, 503, {
            rpcUnavailable: true,
            error: err instanceof Error ? err.message : 'Solana RPC temporarily unavailable',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/tx/prepare') {
        const body = await readJsonBody<{
          asset?: ScannedAsset;
          userAddress?: string;
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
          protocolFeeBps?: number;
          feeRecipientEvm?: string | null;
          hasSolanaUsdcAta?: boolean;
        }>(req);

        if (!body.asset || !body.userAddress || !body.solanaDestination) {
          return sendJson(res, 400, {
            error: 'asset, userAddress, and solanaDestination are required',
          });
        }

        try {
          const prepared = await prepareRealExecution({
            asset: body.asset,
            userAddress: body.userAddress,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset ?? 'USDC',
            bridgePreference: body.bridgePreference ?? 'auto',
            protocolFeeBps: body.protocolFeeBps,
            feeRecipientEvm: body.feeRecipientEvm,
          });
          return sendJson(res, 200, prepared);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Could not prepare real transaction',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/tx/prepare-chain-batch') {
        const body = await readJsonBody<{
          chain?: EvmChainId;
          assets?: ScannedAsset[];
          userAddress?: string;
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
          bundleDefiCctp?: boolean;
          protocolFeeBps?: number;
          feeRecipientEvm?: string | null;
          allowHighCost?: boolean;
        }>(req);

        if (!body.chain || !Array.isArray(body.assets) || !body.userAddress || !body.solanaDestination) {
          return sendJson(res, 400, {
            error: 'chain, assets[], userAddress, and solanaDestination are required',
          });
        }

        try {
          const batch = await prepareChainBatchExecution({
            chain: body.chain,
            assets: body.assets,
            userAddress: body.userAddress,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset ?? 'USDC',
            bridgePreference: body.bridgePreference ?? 'auto',
            bundleDefiCctp: body.bundleDefiCctp ?? true,
            protocolFeeBps: body.protocolFeeBps,
            feeRecipientEvm: body.feeRecipientEvm,
            allowHighCost: body.allowHighCost ?? false,
          });
          return sendJson(res, 200, batch);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Could not prepare EIP-5792 chain batch',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/tx/status') {
        const body = await readJsonBody<{
          chain?: EvmChainId;
          txHash?: string;
          requestId?: string;
          provider?: string;
        }>(req);

        if (!body.chain) return sendJson(res, 400, { error: 'chain is required' });
        const status = await checkLiveExecutionStatus({
          chain: body.chain,
          txHash: body.txHash,
          requestId: body.requestId,
          provider: body.provider,
        });
        return sendJson(res, 200, status);
      }

      if (method === 'POST' && pathname === '/api/cctp/attestation') {
        const body = await readJsonBody<{
          chain?: EvmChainId;
          txHash?: string;
          solanaDestination?: string;
        }>(req);

        if (!body.chain || !body.txHash || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash.trim())) {
          return sendJson(res, 400, {
            error: 'chain and a valid 32-byte 0x txHash are required',
          });
        }

        try {
          const att = await fetchCctpAttestationForTx({
            chain: body.chain,
            txHash: body.txHash.trim(),
            solanaDestination: body.solanaDestination?.trim(),
          });
          return sendJson(res, 200, att);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Could not fetch CCTP attestation',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/tx/simulate-proof') {
        const body = await readJsonBody<{
          chain?: AnyChainId;
          assets?: ScannedAsset[];
          userAddress?: string;
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
          protocolFeeBps?: number;
          feeRecipientEvm?: string | null;
          bundleDefiCctp?: boolean;
          nativePriceUsd?: number;
        }>(req);

        if (!body.chain || !Array.isArray(body.assets) || !body.userAddress || !body.solanaDestination) {
          return sendJson(res, 400, {
            error: 'chain, assets[], userAddress, and solanaDestination are required',
          });
        }

        try {
          if (isEvmChain(body.chain)) {
            const batch = await prepareChainBatchExecution({
              chain: body.chain,
              assets: body.assets,
              userAddress: body.userAddress,
              solanaDestination: body.solanaDestination,
              outputAsset: body.outputAsset ?? 'USDC',
              bridgePreference: body.bridgePreference ?? 'auto',
              protocolFeeBps: body.protocolFeeBps,
              feeRecipientEvm: body.feeRecipientEvm,
              bundleDefiCctp: body.bundleDefiCctp ?? false,
            });
            const proof = await buildPreSignSimulationProof({
              batch,
              assets: body.assets.filter((a) => a.chain === body.chain),
              nativePriceUsd: body.nativePriceUsd,
            });
            return sendJson(res, 200, {
              proof: { ...proof, family: 'evm', simulationEndpoint: 'eth_call' },
              batch,
            });
          }

          const adapter = getAdapterForChain(body.chain);
          const proof = await adapter.simulatePreSignProof({
            chain: body.chain,
            assets: body.assets.filter((a) => a.chain === body.chain),
            userAddress: body.userAddress,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset ?? 'USDC',
            bridgePreference: body.bridgePreference ?? 'auto',
            protocolFeeBps: body.protocolFeeBps,
            feeRecipient: body.feeRecipientEvm,
            nativePriceUsd: body.nativePriceUsd,
          });
          return sendJson(res, 200, { proof, batch: null });
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Could not build real-time simulation proof',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/tx/prove') {
        const body = await readJsonBody<{
          chain?: AnyChainId;
          txHash?: string;
          userAddress?: string;
          solanaDestination?: string;
          requestId?: string;
          provider?: string;
          feeRecipientEvm?: string | null;
          preSolanaUsdc?: number;
          preSolanaSol?: number;
        }>(req);

        if (!body.chain || !body.txHash?.trim() || !body.solanaDestination) {
          return sendJson(res, 400, {
            error: 'chain, txHash, and solanaDestination are required',
          });
        }

        try {
          if (isEvmChain(body.chain)) {
            if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash.trim())) {
              return sendJson(res, 400, {
                error: 'chain, valid 32-byte txHash, and solanaDestination are required',
              });
            }
            const proof = await verifyOnchainExecutionProof({
              chain: body.chain,
              txHash: body.txHash.trim(),
              userAddress: body.userAddress,
              solanaDestination: body.solanaDestination.trim(),
              requestId: body.requestId,
              provider: body.provider,
              feeRecipientEvm: body.feeRecipientEvm,
              preSolanaUsdc: body.preSolanaUsdc,
              preSolanaSol: body.preSolanaSol,
            });
            return sendJson(res, 200, proof);
          }

          const adapter = getAdapterForChain(body.chain);
          const result = await adapter.relayAndProve({
            chain: body.chain,
            txHash: body.txHash.trim(),
            userAddress: body.userAddress || '',
            solanaDestination: body.solanaDestination.trim(),
            requestId: body.requestId,
            provider: body.provider,
            feeRecipient: body.feeRecipientEvm,
            preSolanaUsdc: body.preSolanaUsdc,
            preSolanaSol: body.preSolanaSol,
          });
          return sendJson(res, 200, result.proof);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Could not verify onchain proof',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/relayer/prepare-intent') {
        const body = await readJsonBody<{
          chain?: AnyChainId;
          assets?: ScannedAsset[];
          userAddress?: string;
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          protocolFeeBps?: number;
          feeRecipientEvm?: string | null;
          preferredMode?: 'permit2_batch' | 'eip7702_delegate';
        }>(req);

        if (!body.chain || !Array.isArray(body.assets) || !body.userAddress || !body.solanaDestination) {
          return sendJson(res, 400, {
            error: 'chain, assets[], userAddress, and solanaDestination are required',
          });
        }

        try {
          if (isEvmChain(body.chain)) {
            const plan = buildGaslessSweepIntent({
              chain: body.chain,
              assets: body.assets,
              userAddress: body.userAddress,
              solanaDestination: body.solanaDestination,
              outputAsset: body.outputAsset ?? 'USDC',
              protocolFeeBps: body.protocolFeeBps,
              feeRecipientEvm: body.feeRecipientEvm,
              preferredMode: body.preferredMode,
            });
            if (!plan.sponsorEligible) {
              return sendJson(res, 400, {
                ...plan,
                family: 'evm',
                error: plan.sponsorRejectionReason || 'Below gasless sponsorship break-even.',
              });
            }
            return sendJson(res, 200, { ...plan, family: 'evm' });
          }

          const adapter = getAdapterForChain(body.chain);
          const intent = await adapter.buildGaslessIntent({
            chain: body.chain,
            assets: body.assets,
            userAddress: body.userAddress,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset ?? 'USDC',
            protocolFeeBps: body.protocolFeeBps,
            feeRecipient: body.feeRecipientEvm,
          });
          return sendJson(res, 200, intent);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Could not prepare gasless sweep intent',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/relayer/submit') {
        const body = await readJsonBody<{
          intentId?: string;
          chain?: AnyChainId;
          userAddress?: string;
          signature?: string;
          deadline?: number;
          solanaDestination?: string;
        }>(req);

        if (!body.intentId || !body.chain || !body.userAddress || !body.signature || !body.deadline) {
          return sendJson(res, 400, {
            error: 'intentId, chain, userAddress, signature, and deadline are required',
          });
        }

        try {
          if (isEvmChain(body.chain)) {
            const receipt = submitSignedGaslessIntent({
              intentId: body.intentId,
              chain: body.chain,
              userAddress: body.userAddress,
              signature: body.signature,
              deadline: body.deadline,
            });
            return sendJson(res, 200, receipt);
          }

          const adapter = getAdapterForChain(body.chain);
          const result = await adapter.relayAndProve({
            chain: body.chain,
            intentId: body.intentId,
            userAddress: body.userAddress,
            signature: body.signature,
            deadline: body.deadline,
            solanaDestination: body.solanaDestination || '',
          });
          return sendJson(res, 200, result.submitted);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Could not submit signed gasless intent',
          });
        }
      }

      if (method === 'GET' && pathname === '/api/jobs') {
        return sendJson(res, 200, { jobs: jobStore.listJobs() });
      }

      if (method === 'POST' && pathname === '/api/jobs') {
        const body = await readJsonBody<{
          sourceWallet?: string;
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
          protocolFeeBps?: number;
          feeRecipientEvm?: string | null;
          legs?: Array<{
            legId?: string;
            sourceWallet?: string;
            walletAddress?: string;
            chain: AnyChainId;
            chainName?: string;
            assetCount: number;
            estimatedNetUsd: number;
            estimatedFeeUsd?: number;
          }>;
        }>(req);

        if (!body.sourceWallet || !body.solanaDestination || !Array.isArray(body.legs)) {
          return sendJson(res, 400, {
            error: 'sourceWallet, solanaDestination, and legs[] are required',
          });
        }

        const feeCfg = getProtocolFeeConfig({
          feeBps: body.protocolFeeBps,
          feeRecipientEvm: body.feeRecipientEvm,
        });
        try {
          const job = jobStore.createJob({
            sourceWallet: body.sourceWallet,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset ?? 'USDC',
            bridgePreference: body.bridgePreference ?? 'auto',
            protocolFeeBps: feeCfg.feeBps,
            feeRecipientEvm: feeCfg.feeRecipientEvm,
            legs: body.legs,
          });
          return sendJson(res, 200, job);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Invalid background job payload',
          });
        }
      }

      if (method === 'GET' && pathname.startsWith('/api/jobs/')) {
        const jobId = pathname.slice('/api/jobs/'.length);
        const job = jobStore.getJob(jobId);
        if (!job) return sendJson(res, 404, { error: 'Background job not found' });
        return sendJson(res, 200, job);
      }

      if (method === 'POST' && pathname.startsWith('/api/jobs/') && pathname.endsWith('/leg')) {
        const jobId = pathname.slice('/api/jobs/'.length, -'/leg'.length);
        const body = await readJsonBody<{
          legId?: string;
          sourceWallet?: string;
          walletAddress?: string;
          chain?: AnyChainId;
          status?: JobLegStatus;
          statusText?: string;
          provider?: string;
          callsBatched?: number;
          popupsSaved?: number;
          evmTxHash?: string;
          solanaTxHash?: string;
          requestId?: string;
          requiresSolanaClaim?: boolean;
          attestationStatus?: string;
        }>(req);

        if (!body.legId && !body.chain) {
          return sendJson(res, 400, { error: 'legId or chain is required' });
        }

        const patch: Partial<{
          status: JobLegStatus;
          statusText: string;
          provider: string;
          callsBatched: number;
          popupsSaved: number;
          evmTxHash: string;
          solanaTxHash: string;
          requestId: string;
          requiresSolanaClaim: boolean;
          attestationStatus: string;
        }> = {};
        if (body.status !== undefined) patch.status = body.status;
        if (body.statusText !== undefined) patch.statusText = body.statusText;
        if (body.provider !== undefined) patch.provider = body.provider;
        if (body.callsBatched !== undefined) patch.callsBatched = body.callsBatched;
        if (body.popupsSaved !== undefined) patch.popupsSaved = body.popupsSaved;
        if (body.evmTxHash !== undefined) patch.evmTxHash = body.evmTxHash;
        if (body.solanaTxHash !== undefined) patch.solanaTxHash = body.solanaTxHash;
        if (body.requestId !== undefined) patch.requestId = body.requestId;
        if (body.requiresSolanaClaim !== undefined) patch.requiresSolanaClaim = body.requiresSolanaClaim;
        if (body.attestationStatus !== undefined) patch.attestationStatus = body.attestationStatus;

        try {
          const updated = jobStore.updateLeg(
            jobId,
            {
              legId: body.legId,
              chain: body.chain,
              sourceWallet: body.sourceWallet,
              walletAddress: body.walletAddress,
            },
            patch
          );
          if (!updated) return sendJson(res, 404, { error: 'Background job or chain leg not found' });
          return sendJson(res, 200, updated);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Invalid leg update payload',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/simulate') {
        const body = await readJsonBody<{
          scanId?: string;
          scan?: ScanReport;
          selectedAssetIds?: string[];
          solanaDestination?: string;
          usePermit2Batch?: boolean;
          includeBurns?: boolean;
          outputAsset?: 'USDC' | 'SOL';
        }>(req);

        const scan = body.scan ?? (body.scanId ? scanCache.get(body.scanId) : undefined);
        if (!scan) return sendJson(res, 400, { error: 'Valid scan or scanId is required' });
        const solDest = body.solanaDestination?.trim();
        if (!solDest) return sendJson(res, 400, { error: 'solanaDestination is required' });

        const plan = buildMigrationPlan({
          scan,
          selectedAssetIds: body.selectedAssetIds,
          solanaDestination: solDest,
          usePermit2Batch: body.usePermit2Batch ?? true,
          includeBurns: body.includeBurns ?? true,
          outputAsset: body.outputAsset ?? 'USDC',
        });

        const executions = plan.legs.map((leg, idx) => ({
          chain: leg.chain,
          chainName: leg.chainName,
          evmTxHash: '0x' + crypto.randomBytes(32).toString('hex'),
          cctpNonce: 1842900 + idx,
          attestationStatus: 'ATTESTED',
          bridgedUsdc: leg.bridgedUsdc,
          gasUsd: leg.gasUsd,
          burnsExecuted: leg.burns,
          honeypotsSkipped: leg.honeypotsSkipped,
          solanaMintSig: crypto.randomBytes(32).toString('base64url').slice(0, 44),
        }));

        return sendJson(res, 200, {
          simulationId: `sim_${crypto.randomBytes(5).toString('hex')}`,
          executedAt: new Date().toISOString(),
          mode: 'dry_run_simulation',
          plan,
          executions,
        });
      }

      if ((method === 'GET' || method === 'HEAD') && serveStaticFile(res, pathname, method === 'HEAD')) {
        return;
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message });
      }
      return sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Internal server error',
      });
    }
  });

  server.on('close', () => {
    jobStore.dispose();
  });

  return { server };
}
