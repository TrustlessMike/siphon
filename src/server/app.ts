import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildMigrationPlan, solanaAddressToBytes32 } from '../bridge/cctp.js';
import { checkLiveExecutionStatus, prepareRealExecution } from '../execution/tx-builder.js';
import { CHAIN_LIST, DEAD_BURN_ADDRESS, PROTOCOL_FEE_BPS, SOLANA_CCTP_DOMAIN } from '../scanner/chains.js';
import { scanLiveWallet, scanPresetWallet, WALLET_PRESETS } from '../scanner/classifier.js';
import { fetchSolanaWalletBalances } from '../scanner/discovery.js';
import type { EvmChainId, ScannedAsset, ScanReport } from '../scanner/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.resolve(ROOT_DIR, 'public');
const CONTRACTS_DIR = path.resolve(ROOT_DIR, 'contracts');
const THREE_BUILD_DIR = path.resolve(ROOT_DIR, 'node_modules/three/build');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {} as T;
  return JSON.parse(raw) as T;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function serveStaticFile(res: ServerResponse, reqPath: string): boolean {
  if (reqPath === '/vendor/three.module.js' || reqPath === '/vendor/three.core.js') {
    const fileName = path.basename(reqPath);
    const threeFile = path.join(THREE_BUILD_DIR, fileName);
    if (fs.existsSync(threeFile)) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(threeFile).pipe(res);
      return true;
    }
    return false;
  }

  const safePath = reqPath === '/' ? '/index.html' : reqPath;
  const fullPath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!fullPath.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return false;

  const ext = path.extname(fullPath);
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
  fs.createReadStream(fullPath).pipe(res);
  return true;
}

export function createSiphonServer() {
  const scanCache = new Map<string, ScanReport>();

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    try {
      if (method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, {
          status: 'ok',
          service: 'siphon-migrator',
          chains: CHAIN_LIST.length,
          solanaCctpDomain: SOLANA_CCTP_DOMAIN,
          protocolFeeBps: PROTOCOL_FEE_BPS,
        });
      }

      if (method === 'GET' && pathname === '/api/chains') {
        return sendJson(res, 200, {
          solanaCctpDomain: SOLANA_CCTP_DOMAIN,
          burnSink: DEAD_BURN_ADDRESS,
          protocolFeeBps: PROTOCOL_FEE_BPS,
          chains: CHAIN_LIST,
          presets: WALLET_PRESETS,
        });
      }

      if (method === 'GET' && pathname === '/api/contract') {
        const routerPath = path.join(CONTRACTS_DIR, 'SiphonRouter.sol');
        const source = fs.existsSync(routerPath) ? fs.readFileSync(routerPath, 'utf8') : '';
        return sendJson(res, 200, {
          name: 'SiphonRouter.sol',
          solidityVersion: '0.8.24',
          protocolFeeBps: PROTOCOL_FEE_BPS,
          burnSink: DEAD_BURN_ADDRESS,
          solanaCctpDomain: SOLANA_CCTP_DOMAIN,
          source,
          chains: CHAIN_LIST.map((c) => ({
            chain: c.name,
            chainId: c.chainId,
            cctpDomain: c.cctpDomain,
            usdc: c.usdcAddress,
            tokenMessenger: c.cctpTokenMessenger,
          })),
        });
      }

      if (method === 'POST' && pathname === '/api/scan') {
        const body = await readJsonBody<{
          address?: string;
          presetId?: string;
          mode?: 'live' | 'preset';
        }>(req);

        let report: ScanReport;
        if (body.presetId) {
          report = await scanPresetWallet(body.presetId);
        } else if (body.address) {
          report = await scanLiveWallet(body.address);
        } else {
          report = await scanPresetWallet('veteran_defi');
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
        });

        return sendJson(res, 200, plan);
      }

      if (method === 'GET' && pathname === '/api/solana/balance') {
        const address = url.searchParams.get('address')?.trim();
        if (!address) return sendJson(res, 400, { error: 'address query parameter is required' });
        try {
          const balances = await fetchSolanaWalletBalances(address);
          return sendJson(res, 200, balances);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Invalid Solana address',
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
          });
          return sendJson(res, 200, prepared);
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'Could not prepare real transaction',
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

      if (method === 'GET' && serveStaticFile(res, pathname)) {
        return;
      }

      return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      return sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Internal server error',
      });
    }
  });

  return { server };
}
