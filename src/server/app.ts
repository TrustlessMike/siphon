import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
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
import {
  buildSolanaCctpClaimInstructionPlan,
  fetchLatestSolanaBlockhash,
} from '../bridge/solana-claim.js';
import { runDefiPreflightBatch } from '../defi/preflight.js';
import {
  buildAaveRepayPreSteps,
  inspectAavePoolActiveDebts,
} from '../defi/aave-unwind.js';
import {
  buildAaveFlashUnwindPlan,
  getDefaultLendingMarket,
  isAllowedLendingMarket,
  type FlashUnwindProtocolFamily,
} from '../defi/flash-unwind.js';
import { isAllowedAaveV3Pool } from '../defi/extractors.js';
import { buildPreSignSimulationProof, verifyOnchainExecutionProof } from '../execution/proof.js';
import {
  buildSafeTransactionBatch,
  type SafeBatchBuildInput,
} from '../execution/safe-batch.js';
import {
  generateTaxCsvExport,
  type TaxExportFormat,
  type TaxSweepEvent,
} from '../execution/tax-export.js';
import {
  checkLiveExecutionStatus,
  prepareChainBatchExecution,
  prepareRealExecution,
} from '../execution/tx-builder.js';
import { buildGasRefuelQuote } from '../execution/gas-refuel.js';
import {
  buildGaslessSweepIntent,
  configureGaslessIntentStore,
  isSponsorRelayerConfigured,
  submitAndBroadcastSignedGaslessIntent,
} from '../relayer/sponsor.js';
import { getRpcCircuitBreakerMetrics } from '../scanner/rpc.js';
import { createStateStore, type TurgaliumStateStore } from '../storage/state-store.js';
import {
  buildRateLimitHeaders,
  SlidingWindowRateLimiter,
  type RateLimiterOptions,
} from './rate-limit.js';
import {
  detectAddress,
  EnsResolutionError,
  isValidEnsName,
  resolveEnsNameOrThrow,
} from '../scanner/address.js';
import {
  CHAIN_LIST,
  DEAD_BURN_ADDRESS,
  getProtocolFeeConfig,
  PROTOCOL_FEE_BPS,
  SOLANA_CCTP_DOMAIN,
} from '../scanner/chains.js';
import { scanPresetWallet, WALLET_PRESETS } from '../scanner/classifier.js';
import { scanEvmWalletWithOptions } from '../adapters/evm.js';
import {
  fetchSolanaWalletBalances,
  getL2IndexerProvider,
  type SolanaWalletBalance,
} from '../scanner/discovery.js';
import {
  TurgaliumAgentEngine,
  type AgentActionType,
  type PluginClientKind,
} from '../agent/mandate-engine.js';
import {
  PreservationAgentStore,
  type GasWatchEvaluationResult,
  type GasWatchTrigger,
} from '../agent/preservation-agents.js';
import {
  UnlockHarvesterStore,
  type UnlockHarvestAlert,
  type UnlockQueuesReaderFn,
  type UnlockWatchEntry,
} from '../agent/unlock-harvester.js';
import {
  buildAiPluginManifest,
  buildOpenApiSpec,
  buildPluginSetupGuide,
} from '../agent/plugin-spec.js';
import { buildAgentHandoffKit, buildAgentReviewLink } from '../agent/review-link.js';
import { pollBridgeStatusesBatch } from '../execution/bridge-status-batch.js';
import {
  prepareBatchExecutions,
  type PrepareBatchResponse,
} from '../execution/prepare-batch.js';
import { evaluatePreservationPlan } from '../execution/preservation-optimizer.js';
import { handleMcpJsonRpc } from '../mcp/server.js';
import { planDustConversion } from '../scanner/dust.js';
import { scanUnifiedWallets, type UnifiedWalletInput } from '../scanner/unify.js';
import { evaluatePortfolioRoi } from '../scanner/roi.js';
import type { AnyChainId, ChainFamily, EvmChainId, ScannedAsset, ScanReport } from '../scanner/types.js';
import { fetchSolanaOverview, type SolanaOverviewResult } from '../solana/overview.js';
import { BoundedTtlCache, InFlightCoalescer } from './cache.js';
import { BackgroundJobStore, type JobLegStatus } from './jobs.js';
import { handlePreservationRoute } from './preservation-routes.js';
import { handleSolanaRoutes } from './solana-routes.js';
import { handleApprovalRoutes } from './approval-routes.js';

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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const MAX_JSON_BODY_BYTES = 1_048_576; // 1 MiB safety cap for scan/tx payloads
const MAX_EXPORT_JSON_BODY_BYTES = 524_288; // 512 KiB strict cap for Safe batch / tax CSV export payloads
const MAX_PRIVILEGED_JSON_BODY_BYTES = 65_536; // 64 KiB strict cap for agent/plugin/MCP/job endpoints
const DEFAULT_SCAN_CACHE_MAX = 40;
const DEFAULT_SCAN_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_JOB_LEGS = 50;

export interface TurgaliumServerOptions {
  allowedOrigins?: string[];
  allowedHosts?: string[];
  allowLoopbackOrigins?: boolean;
  allowLoopbackHosts?: boolean;
  publicBaseUrl?: string;
  requirePluginAuth?: boolean;
  adminSessionToken?: string;
  scanCacheMaxEntries?: number;
  scanCacheTtlMs?: number;
  jobStoreMaxJobs?: number;
  jobStoreTtlMs?: number;
  nowMs?: () => number;
  liveGasFetcher?: (chain: EvmChainId) => Promise<number | null>;
  unlockQueuesReader?: UnlockQueuesReaderFn;
  enableBackgroundPollers?: boolean;
  gasPollIntervalMs?: number;
  unlockPollIntervalMs?: number;
  onGasWindowTriggered?: (
    trigger: GasWatchTrigger,
    evalResult: GasWatchEvaluationResult
  ) => void | Promise<void>;
  onUnlockReady?: (alert: UnlockHarvestAlert, watch: UnlockWatchEntry) => void | Promise<void>;
  stateStore?: TurgaliumStateStore;
  dataDir?: string | null;
  rateLimit?: RateLimiterOptions;
  trustProxy?: boolean;
}

const VALID_JOB_LEG_STATUSES = new Set<JobLegStatus>([
  'queued',
  'preparing',
  'signing',
  'confirming',
  'relaying',
  'attested',
  'landed',
  'failed',
  'skipped',
]);

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === '127.0.0.1' || lower === 'localhost' || lower === '[::1]' || lower === '::1';
}

function parseConfiguredAllowedHosts(
  explicit?: string[],
  extraOrigins?: Set<string>,
  publicBaseUrl?: string,
  allowLoopbackHosts = true
): Set<string> {
  const set = new Set<string>(allowLoopbackHosts ? ['127.0.0.1', 'localhost', '[::1]', '::1'] : []);
  const envHosts = process.env.TURGALIUM_ALLOWED_HOSTS
    ? process.env.TURGALIUM_ALLOWED_HOSTS.split(',')
    : [];
  for (const h of [...(explicit ?? []), ...envHosts]) {
    const clean = h.trim().toLowerCase().replace(/:\d+$/, '');
    if (clean) set.add(clean);
  }
  if (extraOrigins) {
    for (const orig of extraOrigins) {
      try {
        set.add(new URL(orig).hostname.toLowerCase());
      } catch {
        // ignore
      }
    }
  }
  if (publicBaseUrl) {
    try {
      set.add(new URL(publicBaseUrl).hostname.toLowerCase());
    } catch {
      // ignore
    }
  }
  return set;
}

/**
 * Validates HTTP `Host` header syntax (preventing `new URL()` crashes) and enforces
 * a strict hostname allowlist to defeat localhost DNS-rebinding attacks (`HIGH-5` & `CRIT-3`).
 */
function validateHostHeader(
  rawHost: string | undefined,
  allowedHostnames: Set<string>,
  allowLoopbackHosts = true
): { ok: true; host: string; hostname: string } | { ok: false; status: 400 | 403; error: string } {
  if (!rawHost || typeof rawHost !== 'string') {
    if (!allowLoopbackHosts) {
      return { ok: false, status: 400, error: 'Missing Host header.' };
    }
    return { ok: true, host: '127.0.0.1', hostname: '127.0.0.1' };
  }
  const trimmed = rawHost.trim();
  if (!trimmed || /[\s/@\\]/.test(trimmed) || /[\u0000-\u001F\u007F]/.test(trimmed)) {
    return { ok: false, status: 400, error: 'Malformed Host header.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(`http://${trimmed}`);
  } catch {
    return { ok: false, status: 400, error: 'Malformed Host header.' };
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== '/') {
    return { ok: false, status: 400, error: 'Malformed Host header.' };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!(allowLoopbackHosts && isLoopbackHostname(hostname)) && !allowedHostnames.has(hostname)) {
    return {
      ok: false,
      status: 403,
      error: 'Disallowed Host header blocked by Turgalium DNS-rebinding protection.',
    };
  }
  return { ok: true, host: parsed.host, hostname };
}

/**
 * Rejects client-supplied `feeRecipientEvm` overrides (`HIGH-7`).
 * Protocol fee treasury must be configured exclusively on the server via `TURGALIUM_FEE_RECIPIENT_EVM`.
 */
function assertNoFeeRecipientOverride(supplied?: string | null): void {
  if (supplied === undefined || supplied === null || supplied === '') return;
  if (typeof supplied !== 'string') {
    throw new HttpError(400, 'Invalid feeRecipientEvm value.');
  }
  const serverRecipient = process.env.TURGALIUM_FEE_RECIPIENT_EVM?.trim();
  if (!serverRecipient || supplied.trim().toLowerCase() !== serverRecipient.toLowerCase()) {
    throw new HttpError(
      400,
      'Client-supplied feeRecipientEvm override is forbidden; protocol fee treasury is server-configured only.'
    );
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function resolveEnsOnScanReport(rawScan: ScanReport): Promise<ScanReport> {
  const ensNames = new Set<string>();
  if (typeof rawScan.walletAddress === 'string' && isValidEnsName(rawScan.walletAddress)) {
    ensNames.add(rawScan.walletAddress.trim().toLowerCase());
  }
  for (const a of rawScan.assets ?? []) {
    if (typeof a.sourceWallet === 'string' && isValidEnsName(a.sourceWallet)) {
      ensNames.add(a.sourceWallet.trim().toLowerCase());
    }
  }
  if (ensNames.size === 0) return rawScan;

  const resolvedMap = new Map<string, string>();
  await Promise.all(
    Array.from(ensNames).map(async (ensName) => {
      resolvedMap.set(ensName, await resolveEnsNameOrThrow(ensName));
    })
  );

  const walletEns = isValidEnsName(rawScan.walletAddress)
    ? rawScan.walletAddress.trim().toLowerCase()
    : null;
  return {
    ...rawScan,
    walletAddress: walletEns
      ? resolvedMap.get(walletEns) ?? rawScan.walletAddress
      : rawScan.walletAddress,
    walletLabel: rawScan.walletLabel || (walletEns ?? undefined),
    assets: (rawScan.assets ?? []).map((a) => {
      if (typeof a.sourceWallet === 'string' && isValidEnsName(a.sourceWallet)) {
        const key = a.sourceWallet.trim().toLowerCase();
        return {
          ...a,
          sourceWallet: resolvedMap.get(key) ?? a.sourceWallet,
          sourceWalletLabel: a.sourceWalletLabel || key,
        };
      }
      return a;
    }),
  };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:') return false;
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

function parseConfiguredAllowedOrigins(explicit?: string[]): Set<string> {
  const rawList =
    explicit ??
    (process.env.TURGALIUM_ALLOWED_ORIGIN
      ? process.env.TURGALIUM_ALLOWED_ORIGIN.split(',')
      : []);
  const set = new Set<string>();
  for (const item of rawList) {
    const norm = normalizeOrigin(item);
    if (norm) set.add(norm);
  }
  return set;
}

function isPublicOpenCorsPath(pathname: string): boolean {
  return (
    pathname === '/api/health' ||
    pathname === '/api/config' ||
    pathname === '/api/chains' ||
    pathname === '/api/families' ||
    pathname === '/api/contract' ||
    pathname === '/openapi.json' ||
    pathname === '/.well-known/ai-plugin.json' ||
    pathname.startsWith('/api/solana/') ||
    pathname.startsWith('/api/approvals/')
  );
}

function isRestrictedCorsRoute(pathname: string, method: string): boolean {
  if (
    pathname === '/mcp' ||
    pathname === '/api/metrics' ||
    pathname.startsWith('/api/agents/') ||
    pathname === '/api/agents' ||
    pathname.startsWith('/api/plugin/') ||
    pathname === '/api/plugin' ||
    pathname.startsWith('/api/jobs/') ||
    pathname === '/api/jobs'
  ) {
    return true;
  }
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    return true;
  }
  return !isPublicOpenCorsPath(pathname);
}

function isAdminMutationRoute(pathname: string, method: string): boolean {
  if (method === 'GET' && (pathname === '/api/plugin/setup' || pathname === '/api/jobs' || pathname.startsWith('/api/jobs/'))) {
    return true;
  }
  if (method === 'DELETE') {
    return pathname.startsWith('/api/agents/unlock-watch/');
  }
  if (method !== 'POST') return false;
  return (
    pathname === '/api/agents/mandates' ||
    (pathname.startsWith('/api/agents/mandates/') && pathname.endsWith('/revoke')) ||
    (pathname.startsWith('/api/agents/approvals/') && pathname.endsWith('/decide')) ||
    pathname === '/api/agents/gas-watch' ||
    (pathname.startsWith('/api/agents/gas-watch/') && pathname.endsWith('/cancel')) ||
    pathname === '/api/agents/unlock-watch' ||
    pathname === '/api/agents/unlock-watch/check' ||
    pathname === '/api/plugin/tokens' ||
    (pathname.startsWith('/api/plugin/tokens/') && pathname.endsWith('/revoke')) ||
    pathname === '/api/jobs' ||
    (pathname.startsWith('/api/jobs/') && pathname.endsWith('/leg'))
  );
}

function isAgentReadRoute(pathname: string, method: string): boolean {
  return (
    method === 'GET' &&
    (pathname === '/api/agents/mandates' ||
      pathname === '/api/agents/approvals' ||
      pathname === '/api/agents/gas-watch' ||
      pathname === '/api/agents/unlock-watch')
  );
}

function isPrivilegedCrossOriginProtectedRoute(pathname: string, method = 'GET'): boolean {
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    return true;
  }
  return (
    pathname === '/mcp' ||
    pathname.startsWith('/api/agents/') ||
    pathname.startsWith('/api/plugin/') ||
    pathname === '/api/jobs' ||
    pathname.startsWith('/api/jobs/')
  );
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<T> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const ct = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!ct.includes('application/json')) {
      throw new HttpError(415, 'Content-Type must be application/json.');
    }
  }
  const contentLengthHeader = req.headers['content-length'];
  if (contentLengthHeader) {
    const declared = Number(Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpError(413, `Request payload exceeds ${maxBytes} byte limit.`);
    }
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, `Request payload exceeds ${maxBytes} byte limit.`);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Malformed JSON request body.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'JSON request body must be a JSON object.');
  }
  return parsed as T;
}

function buildCorsHeaders(params: {
  originHeader?: string;
  restricted: boolean;
  isAllowedOrigin: (origin: string) => boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Turgalium-Admin-Session, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
  if (!params.restricted) {
    headers['Access-Control-Allow-Origin'] = '*';
    return headers;
  }
  headers.Vary = 'Origin';
  if (params.originHeader) {
    const norm = normalizeOrigin(params.originHeader);
    if (norm && params.isAllowedOrigin(norm)) {
      headers['Access-Control-Allow-Origin'] = norm;
    }
  }
  return headers;
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  corsHeaders: Record<string, string> = {},
  isHead = false
): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...corsHeaders,
  };
  if (status === 413) {
    headers.Connection = 'close';
  }
  res.writeHead(status, headers);
  res.end(isHead ? undefined : body);
}

function pipeStaticFileSafely(res: ServerResponse, filePath: string): void {
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Static asset read error.' }));
    } else {
      res.destroy();
    }
  });
  res.on('close', () => {
    stream.destroy();
  });
  stream.pipe(res);
}

const REAL_PUBLIC_DIR = fs.existsSync(PUBLIC_DIR) ? fs.realpathSync(PUBLIC_DIR) : PUBLIC_DIR;

function serveStaticFile(res: ServerResponse, reqPath: string, isHead = false): boolean {
  const baseSecurityHeaders: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };

  const ALLOWED_VENDOR_FILES = new Set([
    'solana-web3.js',
    'coinbase-sdk.js',
    'walletconnect-sdk.js',
    'wallet-sdks.js',
    'three.module.js',
    'three.core.js',
  ]);
  if (reqPath.startsWith('/vendor/')) {
    const fileName = reqPath.slice('/vendor/'.length);
    if (!ALLOWED_VENDOR_FILES.has(fileName)) return false;
    const candidates = [
      path.join(PUBLIC_DIR, 'vendor', fileName),
      path.join(DIST_VENDOR_DIR, fileName),
      path.join(THREE_BUILD_DIR, fileName),
    ];
    const targetFile = candidates.find((p) => fs.existsSync(p));
    if (targetFile) {
      res.writeHead(200, {
        ...baseSecurityHeaders,
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      if (isHead) res.end();
      else pipeStaticFileSafely(res, targetFile);
      return true;
    }
    return false;
  }

  const safePath = reqPath === '/' ? '/index.html' : reqPath;
  // Block dotfiles / hidden segments
  const segments = safePath.split('/').filter(Boolean);
  if (segments.some((seg) => seg.startsWith('.'))) return false;

  const fullPath = path.resolve(PUBLIC_DIR, `.${safePath}`);
  if (!fullPath.startsWith(PUBLIC_DIR + path.sep)) return false;
  if (!fs.existsSync(fullPath)) return false;

  let realTarget: string;
  try {
    realTarget = fs.realpathSync(fullPath);
  } catch {
    return false;
  }
  if (!realTarget.startsWith(REAL_PUBLIC_DIR + path.sep)) return false;
  if (fs.statSync(realTarget).isDirectory()) return false;

  const ext = path.extname(realTarget).toLowerCase();
  if (!(ext in MIME_TYPES)) return false;

  const headers: Record<string, string> = {
    ...baseSecurityHeaders,
    'Content-Type': MIME_TYPES[ext],
  };
  if (safePath.startsWith('/logos/')) {
    headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
  }
  if (safePath === '/safe-manifest.json') {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Cross-Origin-Resource-Policy'] = 'cross-origin';
  }
  if (ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css') {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
    headers['Pragma'] = 'no-cache';
  }
  if (ext === '.svg') {
    headers['Content-Security-Policy'] = 'sandbox';
  }
  // Strict HTML Content-Security-Policy & COOP (required by Coinbase Smart Wallet SDK popups)
  if (ext === '.html') {
    headers['Content-Security-Policy'] =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
    headers['Cross-Origin-Opener-Policy'] = 'same-origin-allow-popups';
  }
  res.writeHead(200, headers);
  if (isHead) res.end();
  else pipeStaticFileSafely(res, realTarget);
  return true;
}

export function createTurgaliumServer(opts: TurgaliumServerOptions = {}) {
  const configuredAllowedOrigins = parseConfiguredAllowedOrigins(opts.allowedOrigins);
  const configuredPublicBaseUrl =
    opts.publicBaseUrl?.trim() || process.env.TURGALIUM_PUBLIC_BASE_URL?.trim() || null;
  const normalizedPublicBaseUrl = configuredPublicBaseUrl
    ? normalizeOrigin(configuredPublicBaseUrl)
    : null;
  const isVercelRuntime = process.env.VERCEL === '1';
  const envDisableLoopback = process.env.TURGALIUM_ALLOW_LOOPBACK?.trim().toLowerCase() === 'false';
  const hasExplicitNonLoopbackOrigins =
    Array.isArray(opts.allowedOrigins) &&
    opts.allowedOrigins.length > 0 &&
    !opts.allowedOrigins.some((o) => {
      const norm = normalizeOrigin(o);
      return Boolean(norm && isLoopbackOrigin(norm));
    });
  const hasExplicitNonLoopbackHosts =
    Array.isArray(opts.allowedHosts) &&
    opts.allowedHosts.length > 0 &&
    !opts.allowedHosts.some((h) => isLoopbackHostname(h.trim().replace(/:\d+$/, '')));
  const allowLoopbackOrigins =
    opts.allowLoopbackOrigins ??
    !(isVercelRuntime || envDisableLoopback || (hasExplicitNonLoopbackOrigins && hasExplicitNonLoopbackHosts));
  const allowLoopbackHosts =
    opts.allowLoopbackHosts ??
    !(isVercelRuntime || envDisableLoopback || hasExplicitNonLoopbackHosts);
  const allowedHostnames = parseConfiguredAllowedHosts(
    opts.allowedHosts,
    configuredAllowedOrigins,
    normalizedPublicBaseUrl ?? undefined,
    allowLoopbackHosts
  );
  const isAllowedOrigin = (origin: string): boolean =>
    (allowLoopbackOrigins && isLoopbackOrigin(origin)) || configuredAllowedOrigins.has(origin);

  const envRequirePluginAuthRaw = process.env.TURGALIUM_REQUIRE_PLUGIN_AUTH?.trim().toLowerCase();
  const forcePluginAuth =
    opts.requirePluginAuth === true ||
    envRequirePluginAuthRaw === 'true' ||
    envRequirePluginAuthRaw === '1' ||
    envRequirePluginAuthRaw === 'yes';
  const requirePluginAuth =
    opts.requirePluginAuth ??
    (envRequirePluginAuthRaw !== undefined
      ? !['false', '0', 'no'].includes(envRequirePluginAuthRaw)
      : true);

  const adminSessionToken =
    opts.adminSessionToken?.trim() || process.env.TURGALIUM_ADMIN_SESSION_TOKEN?.trim() || null;

  const stateStore = createStateStore({
    stateStore: opts.stateStore,
    dataDir: opts.dataDir,
  });
  if (stateStore.persistent) {
    configureGaslessIntentStore(stateStore);
  }
  const rateLimiter = new SlidingWindowRateLimiter({
    ...opts.rateLimit,
    trustProxy: opts.rateLimit?.trustProxy ?? opts.trustProxy,
    nowMs: opts.rateLimit?.nowMs ?? opts.nowMs,
  });

  const startedAtMs = (opts.nowMs ?? (() => Date.now()))();
  const runtimeMetrics = {
    requestsTotal: 0,
    apiRequestsTotal: 0,
    mcpRequestsTotal: 0,
    status2xx: 0,
    status4xx: 0,
    status429: 0,
    status5xx: 0,
  };

  const scanCache = new BoundedTtlCache<string, ScanReport>({
    maxEntries: opts.scanCacheMaxEntries ?? DEFAULT_SCAN_CACHE_MAX,
    ttlMs: opts.scanCacheTtlMs ?? DEFAULT_SCAN_CACHE_TTL_MS,
    nowMs: opts.nowMs,
  });
  const liveScanCache = new BoundedTtlCache<string, ScanReport>({
    maxEntries: 64,
    ttlMs: 45_000,
    nowMs: opts.nowMs,
  });
  const liveScanCoalescer = new InFlightCoalescer<string, ScanReport>(liveScanCache);
  const solanaBalanceCache = new BoundedTtlCache<string, SolanaWalletBalance>({
    maxEntries: 128,
    ttlMs: 15_000,
    nowMs: opts.nowMs,
  });
  const solanaBalanceCoalescer = new InFlightCoalescer<string, SolanaWalletBalance>(
    solanaBalanceCache
  );
  const solanaOverviewCache = new BoundedTtlCache<string, SolanaOverviewResult>({
    maxEntries: 64,
    ttlMs: 15_000,
    nowMs: opts.nowMs,
  });
  const solanaOverviewCoalescer = new InFlightCoalescer<string, SolanaOverviewResult>(
    solanaOverviewCache
  );
  const prepareBatchCache = new BoundedTtlCache<string, PrepareBatchResponse>({
    maxEntries: 64,
    ttlMs: 10_000,
    nowMs: opts.nowMs,
  });
  const prepareBatchCoalescer = new InFlightCoalescer<string, PrepareBatchResponse>(
    prepareBatchCache
  );
  const jobPollersEnabled = opts.enableBackgroundPollers ?? !isVercelRuntime;
  const jobStore = new BackgroundJobStore({
    maxJobs: opts.jobStoreMaxJobs,
    ttlMs: opts.jobStoreTtlMs,
    nowMs: opts.nowMs,
    stateStore,
    enableBackgroundPollers: jobPollersEnabled,
    resumePollersOnLoad: jobPollersEnabled && stateStore.persistent,
  });
  const agentEngine = new TurgaliumAgentEngine({ nowMs: opts.nowMs, stateStore });
  const preservationAgents = new PreservationAgentStore({ nowMs: opts.nowMs, stateStore });
  const unlockHarvester = new UnlockHarvesterStore({
    nowMs: opts.nowMs,
    stateStore,
    readUnlockQueues: opts.unlockQueuesReader,
  });

  const nowFn = opts.nowMs ?? (() => Date.now());
  if (opts.enableBackgroundPollers === true) {
    preservationAgents.startPoller({
      intervalMs: opts.gasPollIntervalMs,
      fetchGasGwei: opts.liveGasFetcher,
      mandateValidator: (mandateId, trigger) => {
        const mandate = agentEngine.getMandate(mandateId);
        if (!mandate || !mandate.active) return false;
        if (Date.parse(mandate.expiresAt) <= nowFn()) return false;
        if (mandate.lockedSolanaRecipient !== trigger.solanaDestination) return false;
        return true;
      },
      onTriggered: async (trigger, evalResult) => {
        // Human-permissioned proposal hook: queue a non-custodial approval request when gas window opens
        try {
          const proposalUsd = Math.max(1, trigger.estimatedSavingsUsd || 1);
          agentEngine.requestPermission({
            client: 'smart_contract_agent',
            mandateId: trigger.autoExecuteAllowed ? trigger.mandateId : undefined,
            actionType: 'bridge_solana',
            summary: `Gas window met on ${trigger.chain} (${trigger.lastObservedGwei ?? trigger.maxBaseFeeGwei} <= ${trigger.maxBaseFeeGwei} gwei) for trigger ${trigger.id}`,
            sourceWallets: [trigger.sourceWallet],
            chains: [trigger.chain],
            solanaDestination: trigger.solanaDestination,
            grossUsd: proposalUsd,
            estimatedNetUsdc: Number((proposalUsd * 0.95).toFixed(2)),
          });
        } catch {
          // Proposal queuing is best-effort and must never crash the poller
        }
        if (opts.onGasWindowTriggered) {
          await opts.onGasWindowTriggered(trigger, evalResult);
        }
      },
    });

    unlockHarvester.startPoller({
      intervalMs: opts.unlockPollIntervalMs,
      readUnlockQueues: opts.unlockQueuesReader,
      onReadyUnlock: async (alert, watch) => {
        if (watch.solanaDestination && alert.estimatedUsd > 0) {
          try {
            agentEngine.requestPermission({
              client: 'smart_contract_agent',
              actionType: 'defi_withdraw',
              summary: `Unlock ready to harvest: ${alert.actionLabel}`,
              sourceWallets: [watch.walletAddress],
              chains: [alert.chain],
              solanaDestination: watch.solanaDestination,
              grossUsd: alert.estimatedUsd,
              estimatedNetUsdc: Number((alert.estimatedUsd * 0.97).toFixed(2)),
            });
          } catch {
            // Proposal queuing is best-effort and must never crash the poller
          }
        }
        if (opts.onUnlockReady) {
          await opts.onUnlockReady(alert, watch);
        }
      },
    });
  }

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    runtimeMetrics.requestsTotal += 1;
    res.on('finish', () => {
      const code = res.statusCode;
      if (code >= 200 && code < 300) runtimeMetrics.status2xx += 1;
      else if (code === 429) {
        runtimeMetrics.status4xx += 1;
        runtimeMetrics.status429 += 1;
      } else if (code >= 400 && code < 500) runtimeMetrics.status4xx += 1;
      else if (code >= 500) runtimeMetrics.status5xx += 1;
    });
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const rawUrl = req.url ?? '/';

      // Reject non-origin-form or protocol-relative request targets (HIGH-5 & MED-4)
      if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.includes('\\')) {
        return sendJson(res, 400, { error: 'Invalid request target: origin-form path required.' });
      }

      // Validate Host header syntax & enforce DNS-rebinding allowlist (HIGH-5 & CRIT-3)
      const hostCheck = validateHostHeader(
        typeof req.headers.host === 'string' ? req.headers.host : undefined,
        allowedHostnames,
        allowLoopbackHosts
      );
      if (!hostCheck.ok) {
        return sendJson(res, hostCheck.status, { error: hostCheck.error });
      }

      let url: URL;
      try {
        url = new URL(rawUrl, `http://${hostCheck.host}`);
      } catch {
        return sendJson(res, 400, { error: 'Malformed request URL.' });
      }
      // Double-check WHATWG URL did not override host via crafted request target
      if (url.host !== hostCheck.host) {
        return sendJson(res, 400, { error: 'Invalid request target host override.' });
      }

      const pathname = url.pathname;
      const baseUrl = normalizedPublicBaseUrl ?? `${url.protocol}//${url.host}`;
      const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      const refererHeader = typeof req.headers.referer === 'string' ? req.headers.referer : undefined;
      const secFetchSite =
        typeof req.headers['sec-fetch-site'] === 'string'
          ? req.headers['sec-fetch-site'].trim().toLowerCase()
          : undefined;

      const restrictedCors = isRestrictedCorsRoute(pathname, method);
      const corsHeaders = buildCorsHeaders({
        originHeader,
        restricted: restrictedCors,
        isAllowedOrigin,
      });
      let rateLimitHeaders: Record<string, string> = {};
      const reply = (status: number, payload: unknown) =>
        sendJson(res, status, payload, { ...corsHeaders, ...rateLimitHeaders }, method === 'HEAD');

      const normalizedOrigin = originHeader ? normalizeOrigin(originHeader) : null;
      const originAllowed = !originHeader || (normalizedOrigin !== null && isAllowedOrigin(normalizedOrigin));

      const isSameOriginLocalhostUi = (): boolean => {
        if (!allowLoopbackOrigins) return false;
        if (!normalizedOrigin) return false;
        if (normalizedOrigin !== url.origin) return false;
        if (!isLoopbackOrigin(normalizedOrigin)) return false;
        if (secFetchSite === 'cross-site') return false;
        return true;
      };

      const checkCrossOriginAndCsrf = (requireJsonForBrowser: boolean): { ok: true } | { ok: false; status: number; error: string } => {
        if (originHeader && !originAllowed) {
          return { ok: false, status: 403, error: 'Cross-origin request blocked by Turgalium CORS policy.' };
        }
        if (!originHeader && refererHeader) {
          const refOrigin = normalizeOrigin(refererHeader);
          if (!refOrigin || !isAllowedOrigin(refOrigin)) {
            return { ok: false, status: 403, error: 'Cross-origin Referer blocked by Turgalium CSRF policy.' };
          }
        }
        if (
          secFetchSite === 'cross-site' &&
          (!normalizedOrigin || !configuredAllowedOrigins.has(normalizedOrigin))
        ) {
          return { ok: false, status: 403, error: 'Cross-site browser request blocked by Turgalium CSRF policy.' };
        }
        if (requireJsonForBrowser && method === 'POST' && (originHeader || secFetchSite)) {
          const ct = String(req.headers['content-type'] ?? '').toLowerCase();
          if (!ct.includes('application/json')) {
            return {
              ok: false,
              status: 415,
              error: 'Browser state-mutating requests must use Content-Type: application/json.',
            };
          }
        }
        return { ok: true };
      };

      const hasValidAdminSession = (): boolean => {
        if (!adminSessionToken) return true;
        const supplied = req.headers['x-turgalium-admin-session'];
        const value = Array.isArray(supplied) ? supplied[0] : supplied;
        return Boolean(value && timingSafeStringEqual(value.trim(), adminSessionToken));
      };

      const verifyAdminRequest = (): { ok: true } | { ok: false; status: number; error: string } => {
        const csrf = checkCrossOriginAndCsrf(true);
        if (!csrf.ok) return csrf;
        if (adminSessionToken && !hasValidAdminSession()) {
          return { ok: false, status: 401, error: 'Missing or invalid X-Turgalium-Admin-Session header.' };
        }
        return { ok: true };
      };

      if (method === 'OPTIONS') {
        const preflightRestricted = isPrivilegedCrossOriginProtectedRoute(pathname, 'POST');
        const preflightCors = buildCorsHeaders({
          originHeader,
          restricted: preflightRestricted,
          isAllowedOrigin,
        });
        if (preflightRestricted && originHeader && !originAllowed) {
          sendJson(res, 403, { error: 'Cross-origin preflight blocked by Turgalium CORS policy.' }, preflightCors);
          return;
        }
        res.writeHead(204, preflightCors);
        res.end();
        return;
      }

      if (pathname.startsWith('/api/')) runtimeMetrics.apiRequestsTotal += 1;
      else if (pathname === '/mcp') runtimeMetrics.mcpRequestsTotal += 1;

      if (
        rateLimiter.enabled &&
        ((pathname.startsWith('/api/') && pathname !== '/api/health') || pathname === '/mcp')
      ) {
        const authHeaderForRateLimit = req.headers.authorization;
        const verifiedRateLimitToken = authHeaderForRateLimit
          ? agentEngine.verifyPluginToken(authHeaderForRateLimit)
          : null;
        const rl = rateLimiter.consumeRequest(req, verifiedRateLimitToken?.tokenId ?? null);
        rateLimitHeaders = buildRateLimitHeaders(rl);
        if (!rl.allowed) {
          return sendJson(
            res,
            429,
            {
              error: 'Rate limit exceeded. Please retry later.',
              retryAfterSec: rl.retryAfterSec,
            },
            { ...corsHeaders, ...rateLimitHeaders }
          );
        }
      }

      if (isPrivilegedCrossOriginProtectedRoute(pathname, method)) {
        const originCheck = checkCrossOriginAndCsrf(method === 'POST');
        if (!originCheck.ok) {
          return reply(originCheck.status, { error: originCheck.error });
        }
      }

      if (isAdminMutationRoute(pathname, method)) {
        const adminCheck = verifyAdminRequest();
        if (!adminCheck.ok) {
          return reply(adminCheck.status, { error: adminCheck.error });
        }
      }

      if (isAgentReadRoute(pathname, method) && adminSessionToken) {
        const authHeader = req.headers.authorization;
        const hasPluginToken = Boolean(authHeader && agentEngine.verifyPluginToken(authHeader));
        if (!hasValidAdminSession() && !hasPluginToken) {
          return reply(401, {
            error: 'Authentication required: supply X-Turgalium-Admin-Session or Authorization: Bearer <token>.',
          });
        }
      }

      if ((method === 'GET' || method === 'HEAD') && pathname === '/api/health') {
        const protocolFee = getProtocolFeeConfig();
        return reply(200, {
          status: 'ok',
          service: 'turgalium-migrator',
          chains: CHAIN_LIST.length,
          solanaCctpDomain: SOLANA_CCTP_DOMAIN,
          protocolFeeBps: protocolFee.feeBps,
          protocolFee,
          l2IndexerProvider: getL2IndexerProvider(),
          persistence: stateStore.persistent ? 'file' : 'ephemeral-memory',
        });
      }

      if (method === 'GET' && pathname === '/api/metrics') {
        if (adminSessionToken && !hasValidAdminSession()) {
          return reply(401, { error: 'Missing or invalid X-Turgalium-Admin-Session header.' });
        }
        const now = (opts.nowMs ?? (() => Date.now()))();
        const jobs = jobStore.listJobs();
        return reply(200, {
          service: 'turgalium-migrator',
          timestamp: new Date(now).toISOString(),
          uptimeSec: Math.max(0, Math.floor((now - startedAtMs) / 1000)),
          requests: { ...runtimeMetrics },
          rateLimit: rateLimiter.getStats(),
          rpc: getRpcCircuitBreakerMetrics(now),
          persistence: {
            kind: stateStore.kind,
            persistent: stateStore.persistent,
            namespaces: stateStore.listNamespaces(),
          },
          stores: {
            jobsTotal: jobs.length,
            activeJobs: jobs.filter((j) => j.status === 'active').length,
            mandatesTotal: agentEngine.listMandates().length,
            approvalsTotal: agentEngine.listApprovals().length,
            pluginTokensTotal: agentEngine.listPluginTokens().length,
            scanCacheEntries: scanCache.size,
            gasWatchTriggersTotal: preservationAgents.size,
            unlockWatchesTotal: unlockHarvester.size,
          },
          pollers: {
            gasWatch: preservationAgents.getPollerStatus(),
            unlockHarvester: unlockHarvester.getPollerStatus(),
          },
        });
      }

      if ((method === 'GET' || method === 'HEAD') && pathname === '/api/config') {
        const vercelEphemeralRelayerBlocked =
          process.env.VERCEL === '1' && !stateStore.persistent;
        const hasCoinbaseSdk =
          process.env.VERCEL === '1' ||
          fs.existsSync(path.join(PUBLIC_DIR, 'vendor', 'coinbase-sdk.js')) ||
          fs.existsSync(path.join(DIST_VENDOR_DIR, 'wallet-sdks.js'));
        return reply(200, {
          coinbaseSmartWalletEnabled: hasCoinbaseSdk,
          walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID?.trim() || null,
          l2IndexerProvider: getL2IndexerProvider(),
          protocolFee: getProtocolFeeConfig(),
          gaslessRelayerConfigured:
            isSponsorRelayerConfigured() && !vercelEphemeralRelayerBlocked,
          requirePluginAuth,
          adminSessionRequired: Boolean(adminSessionToken),
        });
      }

      if ((method === 'GET' || method === 'HEAD') && pathname === '/api/chains') {
        return reply(200, {
          solanaCctpDomain: SOLANA_CCTP_DOMAIN,
          burnSink: DEAD_BURN_ADDRESS,
          protocolFeeBps: PROTOCOL_FEE_BPS,
          protocolFee: getProtocolFeeConfig(),
          chains: CHAIN_LIST.map(({ rpcUrl: _rpcUrl, rpcUrls: _rpcUrls, ...publicChain }) => publicChain),
          families: listAllFamilyMetas(),
          presets: WALLET_PRESETS,
        });
      }

      if ((method === 'GET' || method === 'HEAD') && pathname === '/api/families') {
        const families = listAllFamilyMetas();
        const totalChains = families.reduce((s, f) => s + f.chains.length, 0);
        return reply(200, {
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
          return reply(400, { error: 'Valid scan or scanId is required' });
        }
        return reply(
          200,
          evaluatePortfolioRoi(scan, {
            protocolFeeBps: body.protocolFeeBps,
            gasSponsored: body.gasSponsored,
            fixedRelayerOverheadUsd: body.fixedRelayerOverheadUsd,
          })
        );
      }

      if (method === 'GET' && pathname === '/api/contract') {
        const routerPath = path.join(CONTRACTS_DIR, 'TurgaliumRouter.sol');
        const feeVaultPath = path.join(CONTRACTS_DIR, 'TurgaliumFeeVault.sol');
        const delegatePath = path.join(CONTRACTS_DIR, 'TurgaliumSweepDelegate.sol');
        const agentVaultPath = path.join(CONTRACTS_DIR, 'TurgaliumAgentVault.sol');
        const source = fs.existsSync(routerPath) ? fs.readFileSync(routerPath, 'utf8') : '';
        const feeVaultSource = fs.existsSync(feeVaultPath) ? fs.readFileSync(feeVaultPath, 'utf8') : '';
        const delegateSource = fs.existsSync(delegatePath) ? fs.readFileSync(delegatePath, 'utf8') : '';
        const agentVaultSource = fs.existsSync(agentVaultPath) ? fs.readFileSync(agentVaultPath, 'utf8') : '';
        const protocolFee = getProtocolFeeConfig();
        return reply(200, {
          name: 'TurgaliumRouter.sol',
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
            { id: 'router', filename: 'contracts/TurgaliumRouter.sol', title: 'TurgaliumRouter.sol', source },
            { id: 'delegate', filename: 'contracts/TurgaliumSweepDelegate.sol', title: 'TurgaliumSweepDelegate.sol (EIP-7702)', source: delegateSource },
            { id: 'agent', filename: 'contracts/TurgaliumAgentVault.sol', title: 'TurgaliumAgentVault.sol (Agents)', source: agentVaultSource },
            { id: 'vault', filename: 'contracts/TurgaliumFeeVault.sol', title: 'TurgaliumFeeVault.sol', source: feeVaultSource },
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
          return reply(400, { error: 'wallets[] array with at least one wallet is required.' });
        }
        const report = await scanUnifiedWallets({
          wallets: body.wallets,
          hasSolanaUsdcAta: body.hasSolanaUsdcAta,
        });
        scanCache.set(report.scanId, report);
        return reply(200, report);
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
          return reply(400, { error: 'Valid scan or scanId is required' });
        }
        return reply(
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
        return reply(200, { mandates: agentEngine.listMandates() });
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
        }>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);
        if (!body.ownerAddress || !body.lockedSolanaRecipient) {
          return reply(400, { error: 'ownerAddress and lockedSolanaRecipient are required.' });
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
          return reply(200, mandate);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Invalid agent mandate parameters',
          });
        }
      }

      if (method === 'POST' && pathname.startsWith('/api/agents/mandates/') && pathname.endsWith('/revoke')) {
        const mandateId = pathname.slice('/api/agents/mandates/'.length, -'/revoke'.length);
        const revoked = agentEngine.revokeMandate(mandateId);
        if (!revoked) return reply(404, { error: 'Agent mandate not found' });
        return reply(200, revoked);
      }

      if (method === 'GET' && pathname === '/api/agents/approvals') {
        return reply(200, { approvals: agentEngine.listApprovals() });
      }

      if (method === 'POST' && pathname === '/api/agents/approvals') {
        const authHeader = req.headers.authorization;
        const verifiedToken = authHeader ? agentEngine.verifyPluginToken(authHeader) : null;
        if (authHeader && !verifiedToken) {
          return reply(401, { error: 'Invalid or revoked Turgalium AI Plugin Bearer token.' });
        }
        if (verifiedToken && !verifiedToken.scopes.includes('agent:propose')) {
          return reply(403, {
            error: "Insufficient token scope: 'agent:propose' scope is required to create permission requests.",
          });
        }

        const hasAdminAuth = Boolean(adminSessionToken && hasValidAdminSession());

        // When adminSessionToken or explicit TURGALIUM_REQUIRE_PLUGIN_AUTH is enabled, NEVER allow
        // unauthenticated requests (even client: 'ui' or 'smart_contract_agent') to bypass auth.
        if ((adminSessionToken || forcePluginAuth) && !verifiedToken && !hasAdminAuth) {
          return reply(401, {
            error: adminSessionToken
              ? "Authentication required: supply X-Turgalium-Admin-Session or a Bearer token with 'agent:propose' scope."
              : "Bearer token authentication with 'agent:propose' scope is required.",
          });
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
        }>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);

        const resolvedClient: PluginClientKind =
          verifiedToken?.client ?? body.client ?? 'smart_contract_agent';
        const isExternalPluginClient =
          resolvedClient === 'chatgpt_action' || resolvedClient === 'claude_mcp';

        if (isExternalPluginClient && !verifiedToken && !hasAdminAuth) {
          const allowLocalUiSimulation = !forcePluginAuth && !adminSessionToken && isSameOriginLocalhostUi();
          if (!allowLocalUiSimulation) {
            return reply(401, {
              error:
                'Bearer token authentication is required for external plugin permission requests (chatgpt_action / claude_mcp).',
            });
          }
        }

        if (
          typeof body.actionType !== 'string' ||
          !body.actionType.trim() ||
          typeof body.solanaDestination !== 'string' ||
          !body.solanaDestination.trim()
        ) {
          return reply(400, { error: 'actionType and solanaDestination are required.' });
        }
        try {
          const approval = agentEngine.requestPermission({
            client: resolvedClient,
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
            scanCache: scanCache.values(),
          });
          return reply(200, approval);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Could not create permission request',
          });
        }
      }

      if (method === 'POST' && pathname.startsWith('/api/agents/approvals/') && pathname.endsWith('/decide')) {
        const approvalId = pathname.slice('/api/agents/approvals/'.length, -'/decide'.length);
        const body = await readJsonBody<{ decision?: 'approve' | 'reject'; reason?: string }>(
          req,
          MAX_PRIVILEGED_JSON_BODY_BYTES
        );
        if (body.decision !== 'approve' && body.decision !== 'reject') {
          return reply(400, { error: "decision must be 'approve' or 'reject'" });
        }
        try {
          const decided = agentEngine.decideApproval({
            approvalId,
            decision: body.decision,
            reason: body.reason,
          });
          if (!decided) return reply(404, { error: 'Permission request not found' });
          return reply(200, decided);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Approval decision violated mandate policy',
          });
        }
      }

      // ================= CLAUDE MCP & CHATGPT ACTION PLUGIN =================
      if (method === 'GET' && pathname === '/.well-known/ai-plugin.json') {
        return reply(200, buildAiPluginManifest(baseUrl));
      }

      if (method === 'GET' && pathname === '/openapi.json') {
        return reply(200, buildOpenApiSpec(baseUrl));
      }

      if (method === 'GET' && pathname === '/api/plugin/setup') {
        return reply(200, {
          ...buildPluginSetupGuide({ baseUrl, rootDir: ROOT_DIR }),
          tokens: agentEngine.listPluginTokens(),
        });
      }

      if (method === 'POST' && pathname === '/api/plugin/tokens') {
        const body = await readJsonBody<{
          label?: string;
          client?: 'claude_mcp' | 'chatgpt_action';
          scopes?: string[];
        }>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);
        const issued = agentEngine.issuePluginToken({
          label: body.label || 'AI Assistant Token',
          client: body.client === 'chatgpt_action' ? 'chatgpt_action' : 'claude_mcp',
          scopes: body.scopes,
        });
        return reply(200, issued);
      }

      if (method === 'POST' && pathname.startsWith('/api/plugin/tokens/') && pathname.endsWith('/revoke')) {
        const tokenId = pathname.slice('/api/plugin/tokens/'.length, -'/revoke'.length);
        const revoked = agentEngine.revokePluginToken(tokenId);
        if (!revoked) return reply(404, { error: 'Plugin token not found' });
        return reply(200, revoked);
      }

      if ((method === 'GET' || method === 'DELETE') && pathname === '/mcp') {
        res.writeHead(405, {
          Allow: 'POST, OPTIONS',
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
          ...corsHeaders,
          ...rateLimitHeaders,
        });
        res.end(JSON.stringify({ error: 'Method Not Allowed: use POST /mcp with JSON-RPC 2.0.' }));
        return;
      }

      if (method === 'POST' && pathname === '/mcp') {
        const authHeader = req.headers.authorization;
        const verifiedToken = authHeader ? agentEngine.verifyPluginToken(authHeader) : null;
        if (authHeader && !verifiedToken) {
          return reply(401, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: 'Invalid or revoked Turgalium MCP Bearer token.' },
          });
        }
        if (!verifiedToken && (requirePluginAuth || !isSameOriginLocalhostUi())) {
          return reply(401, {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32001,
              message:
                'Missing Turgalium MCP Bearer token. Issue a scoped token in Turgalium and pass Authorization: Bearer <token>.',
            },
          });
        }
        let rpcReq: Record<string, unknown>;
        try {
          rpcReq = await readJsonBody<Record<string, unknown>>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);
        } catch (err) {
          if (err instanceof HttpError && err.status === 400) {
            return reply(400, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: err.message },
            });
          }
          throw err;
        }
        // JSON-RPC 2.0 notification (no `id` property): process and return 202 Accepted with empty body (MED-6)
        const isNotification =
          rpcReq.jsonrpc === '2.0' &&
          typeof rpcReq.method === 'string' &&
          !('id' in rpcReq);
        const rpcRes = await handleMcpJsonRpc(rpcReq, {
          agentEngine,
          scanCache,
          tokenScopes: verifiedToken?.scopes,
          publicBaseUrl: baseUrl,
        });
        if (isNotification) {
          res.writeHead(202, {
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            ...corsHeaders,
            ...rateLimitHeaders,
          });
          res.end();
          return;
        }
        return reply(200, rpcRes);
      }

      if (method === 'POST' && pathname === '/api/scan') {
        const body = await readJsonBody<{
          address?: string;
          family?: ChainFamily;
          presetId?: string;
          mode?: 'live' | 'preset';
          chains?: string[];
          refresh?: boolean;
          stream?: boolean;
        }>(req);

        const acceptHeader = typeof req.headers.accept === 'string' ? req.headers.accept.toLowerCase() : '';
        const wantsStream =
          body.stream === true || acceptHeader.includes('application/x-ndjson');

        let requestedEvmChains: EvmChainId[] | undefined;
        if (Array.isArray(body.chains) && body.chains.length > 0) {
          const validIds = new Set(CHAIN_LIST.map((c) => c.id));
          const filtered = Array.from(
            new Set(
              body.chains
                .filter((c): c is string => typeof c === 'string')
                .map((c) => c.trim().toLowerCase())
                .filter((c): c is EvmChainId => validIds.has(c as EvmChainId))
            )
          );
          if (filtered.length === 0) {
            return reply(400, {
              error: `No valid EVM chain IDs in chains filter. Supported: ${CHAIN_LIST.map((c) => c.id).join(', ')}.`,
            });
          }
          requestedEvmChains = filtered;
        }

        const sendScanResult = (report: ScanReport, cacheHit = false) => {
          scanCache.set(report.scanId, report);
          if (wantsStream && !res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'DENY',
              'Referrer-Policy': 'no-referrer',
              'Cross-Origin-Resource-Policy': 'same-origin',
              'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
              ...(cacheHit ? { 'X-Turgalium-Scan-Cache': 'HIT' } : {}),
              ...corsHeaders,
              ...rateLimitHeaders,
            });
            res.end(`${JSON.stringify({ type: 'done', cached: cacheHit, report })}\n`);
            return;
          }
          if (res.headersSent) {
            res.end(`${JSON.stringify({ type: 'done', cached: cacheHit, report })}\n`);
            return;
          }
          return sendJson(
            res,
            200,
            report,
            {
              ...corsHeaders,
              ...rateLimitHeaders,
              ...(cacheHit ? { 'X-Turgalium-Scan-Cache': 'HIT' } : {}),
            }
          );
        };

        let report: ScanReport;
        if (body.presetId) {
          report = await scanPresetWallet(body.presetId);
          report.family = 'evm';
          return sendScanResult(report, false);
        } else if (body.address) {
          const detected = detectAddress(body.address, body.family);
          if (!detected) {
            return reply(400, {
              error:
                'Invalid wallet address or checksum. Supported: EVM (0x… EIP-55 / .eth), Cosmos Bech32 (cosmos1…/osmo1…/noble1…/celestia1…/inj1…/neutron1…), Sui/Aptos (0x… Move hex), TON (EQ…/UQ…/Ef…/Uf… or -1:/0:), Tron (T… Base58Check / 41… hex), Bitcoin (bc1q…/bc1p…/1…/3…).',
            });
          }

          const cacheKey = `${detected.family}:${detected.normalized.toLowerCase()}:${
            requestedEvmChains ? requestedEvmChains.slice().sort().join(',') : 'all'
          }`;
          if (!body.refresh) {
            const cached = liveScanCache.get(cacheKey);
            if (cached) {
              return sendScanResult(cached, true);
            }
          }

          try {
            if (detected.family === 'evm' && wantsStream) {
              let streamStarted = false;
              const startStreamHeaders = () => {
                if (streamStarted || res.headersSent) return;
                streamStarted = true;
                res.writeHead(200, {
                  'Content-Type': 'application/x-ndjson; charset=utf-8',
                  'Cache-Control': 'no-store',
                  'X-Content-Type-Options': 'nosniff',
                  'X-Frame-Options': 'DENY',
                  'Referrer-Policy': 'no-referrer',
                  'Cross-Origin-Resource-Policy': 'same-origin',
                  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
                  ...corsHeaders,
                  ...rateLimitHeaders,
                });
              };
              report = await scanEvmWalletWithOptions(body.address, undefined, {
                chains: requestedEvmChains,
                onChainProgress: (info) => {
                  if (res.writableEnded) return;
                  startStreamHeaders();
                  res.write(`${JSON.stringify({ type: 'chain', ...info })}\n`);
                },
              });
              report.family = 'evm';
              liveScanCache.set(cacheKey, report);
              return sendScanResult(report, false);
            }

            const scanOutcome = await liveScanCoalescer.run(
              cacheKey,
              async () => {
                if (detected.family === 'evm') {
                  const evmReport = await scanEvmWalletWithOptions(body.address!, undefined, {
                    chains: requestedEvmChains,
                  });
                  evmReport.family = 'evm';
                  return evmReport;
                }
                return getAdapterForFamily(detected.family).scanWallet(detected.normalized);
              },
              { refresh: Boolean(body.refresh) }
            );
            report = scanOutcome.value;
            return sendScanResult(report, scanOutcome.cached);
          } catch (err) {
            if (res.headersSent) {
              const msg = err instanceof Error ? err.message : 'Wallet scan failed';
              res.end(`${JSON.stringify({ type: 'error', error: msg })}\n`);
              return;
            }
            if (err instanceof EnsResolutionError) {
              return reply(err.code === 'RPC_ERROR' ? 503 : 400, { error: err.message });
            }
            const msg = err instanceof Error ? err.message : 'Invalid wallet address';
            if (msg.toLowerCase().includes('invalid')) {
              return reply(400, { error: msg });
            }
            throw err;
          }
        } else {
          report = await scanPresetWallet('veteran_defi');
          report.family = 'evm';
          return sendScanResult(report, false);
        }
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

        const rawScan = body.scan ?? (body.scanId ? scanCache.get(body.scanId) : undefined);
        if (!rawScan) {
          return reply(400, { error: 'Valid scan or scanId is required' });
        }

        let scan: ScanReport;
        try {
          scan = await resolveEnsOnScanReport(rawScan);
        } catch (err) {
          if (err instanceof EnsResolutionError) {
            return reply(err.code === 'RPC_ERROR' ? 503 : 400, { error: err.message });
          }
          throw err;
        }

        if (
          body.solanaDestination !== undefined &&
          body.solanaDestination !== null &&
          typeof body.solanaDestination !== 'string'
        ) {
          return reply(400, { error: 'solanaDestination must be a string.' });
        }
        const solDestRaw = typeof body.solanaDestination === 'string' ? body.solanaDestination.trim() : '';
        const isPreviewPlaceholder =
          solDestRaw === '' || solDestRaw === '11111111111111111111111111111111';
        if (!isPreviewPlaceholder) {
          try {
            solanaAddressToBytes32(solDestRaw);
          } catch {
            return reply(400, { error: 'Invalid Solana destination address (expected base58 public key).' });
          }
        }

        assertNoFeeRecipientOverride(body.feeRecipientEvm);

        const plan = buildMigrationPlan({
          scan,
          selectedAssetIds: body.selectedAssetIds,
          solanaDestination: isPreviewPlaceholder ? '' : solDestRaw,
          usePermit2Batch: body.usePermit2Batch ?? true,
          includeBurns: body.includeBurns ?? true,
          outputAsset: body.outputAsset ?? 'USDC',
          bridgePreference: body.bridgePreference ?? 'auto',
          protocolFeeBps: body.protocolFeeBps,
          feeRecipientEvm: undefined,
          hasSolanaUsdcAta: body.hasSolanaUsdcAta,
        });

        return reply(200, plan);
      }

      if (method === 'GET' && pathname === '/api/solana/balance') {
        const address = url.searchParams.get('address')?.trim();
        if (!address) return reply(400, { error: 'address query parameter is required' });
        try {
          solanaAddressToBytes32(address);
        } catch {
          return reply(400, { error: 'Invalid Solana address' });
        }
        const refreshParam = (url.searchParams.get('refresh') ?? '').trim().toLowerCase();
        const refresh = refreshParam === '1' || refreshParam === 'true';
        try {
          const { value: balances } = await solanaBalanceCoalescer.run(
            address,
            () => fetchSolanaWalletBalances(address),
            { refresh }
          );
          return reply(200, balances);
        } catch (err) {
          return reply(503, {
            rpcUnavailable: true,
            error: err instanceof Error ? err.message : 'Solana RPC temporarily unavailable',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/defi/preflight') {
        const body = await readJsonBody<{
          walletAddress?: string;
          scanId?: string;
          asset?: ScannedAsset;
          assets?: ScannedAsset[];
          outputAsset?: 'USDC' | 'SOL';
          skipRpc?: boolean;
        }>(req);

        if (
          body.walletAddress !== undefined &&
          body.walletAddress !== null &&
          typeof body.walletAddress !== 'string'
        ) {
          return reply(400, { error: 'walletAddress must be a string.' });
        }
        if (body.scanId !== undefined && body.scanId !== null && typeof body.scanId !== 'string') {
          return reply(400, { error: 'scanId must be a string.' });
        }
        if (body.assets !== undefined && !Array.isArray(body.assets)) {
          return reply(400, { error: 'assets must be an array when provided.' });
        }

        const cachedScan = typeof body.scanId === 'string' ? scanCache.get(body.scanId) : undefined;
        const walletAddress =
          (typeof body.walletAddress === 'string' ? body.walletAddress.trim() : '') ||
          cachedScan?.walletAddress;
        const targetAssets = body.assets
          ? body.assets
          : body.asset
          ? [body.asset]
          : cachedScan?.assets ?? [];

        if (!walletAddress || !targetAssets.length) {
          return reply(400, {
            error: 'walletAddress (or valid scanId) and at least one asset are required.',
          });
        }

        const preflight = await runDefiPreflightBatch({
          assets: targetAssets,
          walletAddress,
          outputAsset: body.outputAsset ?? 'USDC',
          skipRpc: Boolean(body.skipRpc),
        });
        return reply(200, preflight);
      }

      if (method === 'POST' && pathname === '/api/defi/aave-unwind-plan') {
        const body = await readJsonBody<{
          chain?: string;
          poolAddress?: string;
          userAddress?: string;
        }>(req);

        const chainRaw = typeof body.chain === 'string' ? body.chain.trim().toLowerCase() : '';
        if (!isEvmChain(chainRaw)) {
          return reply(400, { error: 'Valid EVM chain is required.' });
        }
        const userAddress = typeof body.userAddress === 'string' ? body.userAddress.trim() : '';
        if (!/^0x[0-9a-fA-F]{40}$/.test(userAddress)) {
          return reply(400, { error: 'Valid 0x EVM userAddress is required.' });
        }
        const chainCfg = CHAIN_LIST.find((c) => c.id === chainRaw);
        const poolAddress =
          (typeof body.poolAddress === 'string' && body.poolAddress.trim()) ||
          chainCfg?.aaveV3Pool ||
          '';
        if (!poolAddress || !isAllowedAaveV3Pool(chainRaw, poolAddress)) {
          return reply(400, {
            error: `No audited Aave v3 / fork Pool configured for ${chainRaw}${poolAddress ? ` (${poolAddress})` : ''}.`,
          });
        }

        const inspection = await inspectAavePoolActiveDebts({
          chain: chainRaw,
          poolAddress,
          userAddress,
        });
        const protocolName = chainRaw === 'monad' ? 'Neverland' : `Aave v3 (${chainCfg?.name ?? chainRaw})`;
        const repayTransactions = inspection.canRepayAllFromWallet
          ? buildAaveRepayPreSteps({
              chain: chainRaw,
              poolAddress,
              protocolName,
              userAddress,
              activeDebts: inspection.activeDebts,
            })
          : [];

        return reply(200, {
          checked: inspection.checked,
          chain: chainRaw,
          chainName: chainCfg?.name ?? chainRaw,
          poolAddress,
          protocolName,
          reservesCount: inspection.reservesCount,
          canRepayAllFromWallet: inspection.canRepayAllFromWallet,
          activeDebts: inspection.activeDebts.map((d) => ({
            asset: d.asset,
            symbol: d.symbol,
            decimals: d.decimals,
            aTokenAddress: d.aTokenAddress,
            variableDebtToken: d.variableDebtToken,
            debtRaw: d.debtRaw.toString(),
            debtUi: d.debtUi,
            walletBalanceRaw: d.walletBalanceRaw.toString(),
            walletBalanceUi: d.walletBalanceUi,
            canRepayFull: d.canRepayFull,
            shortfallRaw: d.shortfallRaw.toString(),
            shortfallUi: d.shortfallUi,
          })),
          repayTransactions,
          ...(inspection.reason ? { reason: inspection.reason } : {}),
        });
      }

      if (
        method === 'POST' &&
        (pathname === '/api/defi/aave-flash-unwind-plan' ||
          pathname === '/api/defi/flash-unwind-plan')
      ) {
        const body = await readJsonBody<{
          chain?: string;
          poolAddress?: string;
          marketAddress?: string;
          protocolFamily?: string;
          userAddress?: string;
          recipient?: string;
          slippageBps?: number;
          swapAllCollaterals?: boolean;
        }>(req);

        const chainRaw = typeof body.chain === 'string' ? body.chain.trim().toLowerCase() : '';
        if (!isEvmChain(chainRaw)) {
          return reply(400, { error: 'Valid EVM chain is required.' });
        }
        const userAddress = typeof body.userAddress === 'string' ? body.userAddress.trim() : '';
        if (!/^0x[0-9a-fA-F]{40}$/.test(userAddress)) {
          return reply(400, { error: 'Valid 0x EVM userAddress is required.' });
        }
        const familyRaw =
          typeof body.protocolFamily === 'string' ? body.protocolFamily.trim().toLowerCase() : 'aave_v3';
        const validFamilies: FlashUnwindProtocolFamily[] = [
          'aave_v3',
          'aave_v2',
          'compound_v3',
          'compound_v2',
          'morpho_blue',
        ];
        const lendingFamily: FlashUnwindProtocolFamily = validFamilies.includes(
          familyRaw as FlashUnwindProtocolFamily
        )
          ? (familyRaw as FlashUnwindProtocolFamily)
          : 'aave_v3';

        const poolAddress =
          (typeof body.marketAddress === 'string' && body.marketAddress.trim()) ||
          (typeof body.poolAddress === 'string' && body.poolAddress.trim()) ||
          getDefaultLendingMarket(chainRaw, lendingFamily) ||
          '';
        if (!poolAddress || !isAllowedLendingMarket(chainRaw, lendingFamily, poolAddress)) {
          return reply(400, {
            error: `No audited ${lendingFamily} / Aave v3 lending market configured for ${chainRaw}${poolAddress ? ` (${poolAddress})` : ''}.`,
          });
        }

        const plan = await buildAaveFlashUnwindPlan({
          chain: chainRaw,
          poolAddress,
          lendingFamily,
          userAddress,
          recipient: typeof body.recipient === 'string' ? body.recipient.trim() : undefined,
          slippageBps:
            typeof body.slippageBps === 'number' && Number.isFinite(body.slippageBps)
              ? body.slippageBps
              : undefined,
          swapAllCollaterals: body.swapAllCollaterals === true,
        });

        return reply(200, plan);
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
          return reply(400, {
            error: 'asset, userAddress, and solanaDestination are required',
          });
        }

        assertNoFeeRecipientOverride(body.feeRecipientEvm);

        try {
          const prepared = await prepareRealExecution({
            asset: body.asset,
            userAddress: body.userAddress,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset ?? 'USDC',
            bridgePreference: body.bridgePreference ?? 'auto',
            protocolFeeBps: body.protocolFeeBps,
            feeRecipientEvm: undefined,
          });
          return reply(200, prepared);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Could not prepare real transaction',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/tx/prepare-batch') {
        const body = await readJsonBody<{
          assets?: ScannedAsset[];
          userAddress?: string;
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
          hasSolanaUsdcAta?: boolean;
          includePreflight?: boolean;
          refresh?: boolean;
          feeRecipientEvm?: string | null;
        }>(req);

        if (!Array.isArray(body.assets) || body.assets.length === 0 || !body.userAddress || !body.solanaDestination) {
          return reply(400, {
            error: 'assets[], userAddress, and solanaDestination are required',
          });
        }

        assertNoFeeRecipientOverride(body.feeRecipientEvm);

        const refresh = body.refresh === true;
        const outputAsset = body.outputAsset ?? 'USDC';
        const bridgePreference = body.bridgePreference ?? 'auto';
        const includePreflight = body.includePreflight !== false;
        const batchSig = body.assets
          .slice(0, 12)
          .map((a) => `${a?.chain ?? ''}:${a?.address ?? ''}:${a?.rawBalance ?? ''}:${a?.action ?? ''}`)
          .join('|');
        const cacheKey = `${body.userAddress.trim().toLowerCase()}:${body.solanaDestination.trim()}:${outputAsset}:${bridgePreference}:${String(body.hasSolanaUsdcAta)}:${String(includePreflight)}:${batchSig}`;

        try {
          const { value: result } = await prepareBatchCoalescer.run(
            cacheKey,
            () =>
              prepareBatchExecutions({
                assets: body.assets!,
                userAddress: body.userAddress!,
                solanaDestination: body.solanaDestination!,
                outputAsset,
                bridgePreference,
                hasSolanaUsdcAta: body.hasSolanaUsdcAta,
                includePreflight,
              }),
            {
              refresh,
              cachePredicate: (res) => res.readyCount > 0 && res.failedCount === 0,
            }
          );
          return reply(200, result);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Could not prepare batch transactions',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/gas/refuel-quote') {
        const body = await readJsonBody<{
          fromChain?: string;
          toChain?: string;
          userAddress?: string;
          amountUsd?: number;
        }>(req);

        const fromChain = typeof body.fromChain === 'string' ? body.fromChain.trim().toLowerCase() : '';
        const toChain = typeof body.toChain === 'string' ? body.toChain.trim().toLowerCase() : '';
        if (!isEvmChain(fromChain) || !isEvmChain(toChain)) {
          return reply(400, {
            error: 'Valid EVM fromChain and toChain are required for gas refuel.',
          });
        }
        if (!body.userAddress || typeof body.userAddress !== 'string') {
          return reply(400, { error: 'userAddress is required.' });
        }
        try {
          const quote = await buildGasRefuelQuote({
            fromChain,
            toChain,
            userAddress: body.userAddress,
            amountUsd: typeof body.amountUsd === 'number' ? body.amountUsd : 1.0,
          });
          return reply(200, quote);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Could not build gas refuel quote',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/tx/prepare-chain-batch') {
        const body = await readJsonBody<{
          chain?: AnyChainId;
          assets?: ScannedAsset[];
          userAddress?: string;
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
          bundleDefiCctp?: boolean;
          protocolFeeBps?: number;
          feeRecipientEvm?: string | null;
          allowHighCost?: boolean;
          consolidateMultiInputDust?: boolean;
          addressesByChain?: Record<string, string>;
        }>(req);

        if (!body.chain || !Array.isArray(body.assets) || !body.userAddress || !body.solanaDestination) {
          return reply(400, {
            error: 'chain, assets[], userAddress, and solanaDestination are required',
          });
        }

        assertNoFeeRecipientOverride(body.feeRecipientEvm);

        try {
          if (isEvmChain(body.chain)) {
            const batch = await prepareChainBatchExecution({
              chain: body.chain,
              assets: body.assets,
              userAddress: body.userAddress,
              solanaDestination: body.solanaDestination,
              outputAsset: body.outputAsset ?? 'USDC',
              bridgePreference: body.bridgePreference ?? 'auto',
              bundleDefiCctp: body.bundleDefiCctp ?? true,
              protocolFeeBps: body.protocolFeeBps,
              feeRecipientEvm: undefined,
              allowHighCost: body.allowHighCost ?? false,
              consolidateMultiInputDust: body.consolidateMultiInputDust ?? true,
            });
            return reply(200, batch);
          }

          const adapter = getAdapterForChain(body.chain);
          if (!adapter.prepareDirectBatch) {
            return reply(400, {
              error: `Direct conversion batching is not supported for ${body.chain}.`,
            });
          }
          const nonEvmBatch = await adapter.prepareDirectBatch({
            chain: body.chain,
            assets: body.assets,
            userAddress: body.userAddress,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset ?? 'USDC',
            bridgePreference: body.bridgePreference ?? 'auto',
            protocolFeeBps: body.protocolFeeBps,
            feeRecipient: undefined,
            allowHighCost: body.allowHighCost ?? false,
            addressesByChain: body.addressesByChain,
          });
          return reply(200, nonEvmBatch);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Could not prepare chain conversion batch',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/tx/status') {
        const body = await readJsonBody<{
          chain?: AnyChainId;
          txHash?: string;
          requestId?: string;
          provider?: string;
        }>(req);

        if (!body.chain) return reply(400, { error: 'chain is required' });
        const status = await checkLiveExecutionStatus({
          chain: body.chain,
          txHash: body.txHash,
          requestId: body.requestId,
          provider: body.provider,
        });
        return reply(200, status);
      }

      if (method === 'POST' && pathname === '/api/cctp/attestation') {
        const body = await readJsonBody<{
          chain?: EvmChainId;
          txHash?: string;
          solanaDestination?: string;
        }>(req);

        const txHashClean = typeof body.txHash === 'string' ? body.txHash.trim() : '';
        if (
          typeof body.chain !== 'string' ||
          !body.chain ||
          !txHashClean ||
          !/^0x[0-9a-fA-F]{64}$/.test(txHashClean)
        ) {
          return reply(400, {
            error: 'chain and a valid 32-byte 0x txHash are required',
          });
        }
        if (
          body.solanaDestination !== undefined &&
          body.solanaDestination !== null &&
          typeof body.solanaDestination !== 'string'
        ) {
          return reply(400, { error: 'solanaDestination must be a string.' });
        }

        try {
          const att = await fetchCctpAttestationForTx({
            chain: body.chain,
            txHash: txHashClean,
            solanaDestination:
              typeof body.solanaDestination === 'string' ? body.solanaDestination.trim() : undefined,
          });
          return reply(200, att);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Could not fetch CCTP attestation',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/cctp/solana-claim-tx') {
        const body = await readJsonBody<{
          messageBytesHex?: string;
          attestation?: string;
          attestationHex?: string;
          solanaDestination?: string;
          payer?: string;
          chain?: EvmChainId;
          txHash?: string;
          includeCreateAta?: boolean;
          recentBlockhash?: string;
          skipBlockhashFetch?: boolean;
        }>(req);

        const solanaDestination =
          typeof body.solanaDestination === 'string' ? body.solanaDestination.trim() : '';
        if (!solanaDestination) {
          return reply(400, { error: 'solanaDestination is required.' });
        }
        for (const [field, val] of [
          ['messageBytesHex', body.messageBytesHex],
          ['attestation', body.attestation],
          ['attestationHex', body.attestationHex],
          ['payer', body.payer],
          ['txHash', body.txHash],
          ['recentBlockhash', body.recentBlockhash],
        ] as const) {
          if (val !== undefined && val !== null && typeof val !== 'string') {
            return reply(400, { error: `${field} must be a string.` });
          }
        }

        try {
          let messageBytesHex =
            typeof body.messageBytesHex === 'string' ? body.messageBytesHex.trim() : undefined;
          const rawAtt = body.attestationHex ?? body.attestation;
          let attestationHex = typeof rawAtt === 'string' ? rawAtt.trim() : undefined;

          if ((!messageBytesHex || !attestationHex) && typeof body.chain === 'string' && body.chain && typeof body.txHash === 'string' && body.txHash) {
            if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash.trim())) {
              return reply(400, { error: 'Valid 32-byte 0x txHash is required when resolving attestation.' });
            }
            const att = await fetchCctpAttestationForTx({
              chain: body.chain,
              txHash: body.txHash.trim(),
              solanaDestination,
            });
            if (!att.found || !att.messageBytesHex) {
              return reply(404, { error: att.nextStep || 'CCTP MessageSent event not found for transaction.' });
            }
            if (att.attestationStatus !== 'complete' || !att.attestation) {
              return reply(409, {
                attestationStatus: att.attestationStatus,
                messageHash: att.messageHash,
                error: att.nextStep || 'Circle Iris attestation is not complete yet.',
              });
            }
            messageBytesHex = att.messageBytesHex;
            attestationHex = att.attestation;
          }

          if (!messageBytesHex || !attestationHex) {
            return reply(400, {
              error: 'Provide messageBytesHex + attestation (or chain + txHash) to build a Solana CCTP claim transaction plan.',
            });
          }

          const recentBlockhash =
            (typeof body.recentBlockhash === 'string' ? body.recentBlockhash.trim() : '') ||
            (body.skipBlockhashFetch ? null : await fetchLatestSolanaBlockhash());

          const claimPlan = buildSolanaCctpClaimInstructionPlan({
            messageBytesHex,
            attestationHex,
            solanaDestination,
            payer:
              (typeof body.payer === 'string' ? body.payer.trim() : '') || solanaDestination,
            includeCreateAta: body.includeCreateAta,
            recentBlockhash,
          });
          return reply(200, claimPlan);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Could not build Solana CCTP claim plan.',
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
          rawTxBytes?: string;
          simulationPayload?: Record<string, unknown>;
        }>(req);

        if (!body.chain || !Array.isArray(body.assets) || !body.userAddress || !body.solanaDestination) {
          return reply(400, {
            error: 'chain, assets[], userAddress, and solanaDestination are required',
          });
        }

        assertNoFeeRecipientOverride(body.feeRecipientEvm);

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
              feeRecipientEvm: undefined,
              bundleDefiCctp: body.bundleDefiCctp ?? false,
            });
            const proof = await buildPreSignSimulationProof({
              batch,
              assets: body.assets.filter((a) => a.chain === body.chain),
              nativePriceUsd: body.nativePriceUsd,
            });
            return reply(200, {
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
            feeRecipient: undefined,
            nativePriceUsd: body.nativePriceUsd,
            rawTxBytes: body.rawTxBytes,
            simulationPayload: body.simulationPayload,
          });
          return reply(200, { proof, batch: null });
        } catch (err) {
          return reply(400, {
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
          outputAsset?: 'USDC' | 'SOL';
          requestId?: string;
          provider?: string;
          feeRecipientEvm?: string | null;
          preSolanaUsdc?: number;
          preSolanaSol?: number;
        }>(req);

        const txHashClean = typeof body.txHash === 'string' ? body.txHash.trim() : '';
        const solDestClean =
          typeof body.solanaDestination === 'string' ? body.solanaDestination.trim() : '';
        if (typeof body.chain !== 'string' || !body.chain || !txHashClean || !solDestClean) {
          return reply(400, {
            error: 'chain, txHash, and solanaDestination are required',
          });
        }
        if (
          body.userAddress !== undefined &&
          body.userAddress !== null &&
          typeof body.userAddress !== 'string'
        ) {
          return reply(400, { error: 'userAddress must be a string.' });
        }

        assertNoFeeRecipientOverride(body.feeRecipientEvm);

        try {
          if (isEvmChain(body.chain)) {
            if (!/^0x[0-9a-fA-F]{64}$/.test(txHashClean)) {
              return reply(400, {
                error: 'chain, valid 32-byte txHash, and solanaDestination are required',
              });
            }
            const proof = await verifyOnchainExecutionProof({
              chain: body.chain,
              txHash: txHashClean,
              userAddress: typeof body.userAddress === 'string' ? body.userAddress.trim() : undefined,
              solanaDestination: solDestClean,
              requestId: body.requestId,
              provider: body.provider,
              feeRecipientEvm: undefined,
              preSolanaUsdc: body.preSolanaUsdc,
              preSolanaSol: body.preSolanaSol,
            });
            return reply(200, proof);
          }

          const adapter = getAdapterForChain(body.chain);
          const result = await adapter.relayAndProve({
            chain: body.chain,
            txHash: txHashClean,
            userAddress: typeof body.userAddress === 'string' ? body.userAddress.trim() : '',
            solanaDestination: solDestClean,
            outputAsset: body.outputAsset ?? 'USDC',
            requestId: body.requestId,
            provider: body.provider,
            feeRecipient: undefined,
            preSolanaUsdc: body.preSolanaUsdc,
            preSolanaSol: body.preSolanaSol,
          });
          return reply(200, result.proof);
        } catch (err) {
          return reply(400, {
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
          filterToInstantSingleSig?: boolean;
        }>(req);

        if (!body.chain || !Array.isArray(body.assets) || !body.userAddress || !body.solanaDestination) {
          return reply(400, {
            error: 'chain, assets[], userAddress, and solanaDestination are required',
          });
        }

        assertNoFeeRecipientOverride(body.feeRecipientEvm);

        try {
          if (isEvmChain(body.chain)) {
            const plan = buildGaslessSweepIntent({
              chain: body.chain,
              assets: body.assets,
              userAddress: body.userAddress,
              solanaDestination: body.solanaDestination,
              outputAsset: body.outputAsset ?? 'USDC',
              protocolFeeBps: body.protocolFeeBps,
              feeRecipientEvm: undefined,
              preferredMode: body.preferredMode,
              filterToInstantSingleSig: body.filterToInstantSingleSig,
            });
            if (!plan.sponsorEligible) {
              return reply(400, {
                ...plan,
                family: 'evm',
                error: plan.sponsorRejectionReason || 'Below gasless sponsorship break-even.',
              });
            }
            return reply(200, { ...plan, family: 'evm' });
          }

          const adapter = getAdapterForChain(body.chain);
          const intent = await adapter.buildGaslessIntent({
            chain: body.chain,
            assets: body.assets,
            userAddress: body.userAddress,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset ?? 'USDC',
            protocolFeeBps: body.protocolFeeBps,
            feeRecipient: undefined,
          });
          if (intent.sponsorEligible === false) {
            return reply(400, {
              ...intent,
              error: intent.sponsorRejectionReason || 'Below gasless sponsorship break-even.',
            });
          }
          return reply(200, intent);
        } catch (err) {
          return reply(400, {
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
          txCalldata?: string;
        }>(req);

        const intentIdClean = typeof body.intentId === 'string' ? body.intentId.trim() : '';
        const userAddrClean = typeof body.userAddress === 'string' ? body.userAddress.trim() : '';
        const sigClean = typeof body.signature === 'string' ? body.signature.trim() : '';
        if (
          !intentIdClean ||
          typeof body.chain !== 'string' ||
          !body.chain ||
          !userAddrClean ||
          !sigClean ||
          typeof body.deadline !== 'number' ||
          !Number.isFinite(body.deadline)
        ) {
          return reply(400, {
            error: 'intentId, chain, userAddress, signature, and deadline are required',
          });
        }
        if (
          body.txCalldata !== undefined &&
          body.txCalldata !== null &&
          typeof body.txCalldata !== 'string'
        ) {
          return reply(400, { error: 'txCalldata must be a 0x-prefixed hex string.' });
        }

        try {
          if (isEvmChain(body.chain)) {
            if (
              process.env.VERCEL === '1' &&
              !stateStore.persistent &&
              (isSponsorRelayerConfigured(body.chain) ||
                isSponsorRelayerConfigured() ||
                Boolean(typeof body.txCalldata === 'string' && body.txCalldata.trim()))
            ) {
              return reply(503, {
                accepted: false,
                broadcasted: false,
                settlementStatus: 'blocked_ephemeral_persistence',
                error:
                  'Live sponsored relayer broadcast is disabled on Vercel serverless without durable shared persistence. Configure shared durable storage before enabling live relayer broadcast.',
              });
            }
            const receipt = await submitAndBroadcastSignedGaslessIntent({
              intentId: intentIdClean,
              chain: body.chain,
              userAddress: userAddrClean,
              signature: sigClean,
              deadline: body.deadline,
              txCalldata: typeof body.txCalldata === 'string' ? body.txCalldata : undefined,
            });
            return reply(200, receipt);
          }

          const adapter = getAdapterForChain(body.chain);
          const result = await adapter.relayAndProve({
            chain: body.chain,
            intentId: intentIdClean,
            userAddress: userAddrClean,
            signature: sigClean,
            deadline: body.deadline,
            solanaDestination:
              typeof body.solanaDestination === 'string' ? body.solanaDestination.trim() : '',
          });
          const submitted = result.submitted ?? {
            accepted: false,
            mode: 'unsupported_non_evm_relayer',
            broadcasted: false,
            settlementStatus: 'rejected_unverified',
            nextStep: `Non-EVM sponsored relayer submission on ${body.chain} requires server-issued intent verification and chain-specific cryptographic signature validation. Use Direct Mode wallet broadcast instead.`,
          };
          return reply(501, {
            ...submitted,
            accepted: false,
            broadcasted: false,
            error: submitted.nextStep,
          });
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Could not submit signed gasless intent',
          });
        }
      }

      if (method === 'GET' && pathname === '/api/jobs') {
        return reply(200, { jobs: jobStore.listJobs() });
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
        }>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);

        if (!body.sourceWallet || !body.solanaDestination || !Array.isArray(body.legs)) {
          return reply(400, {
            error: 'sourceWallet, solanaDestination, and legs[] are required',
          });
        }
        if (body.legs.length > MAX_JOB_LEGS) {
          return reply(400, {
            error: `legs[] exceeds maximum of ${MAX_JOB_LEGS} chain legs per job`,
          });
        }

        assertNoFeeRecipientOverride(body.feeRecipientEvm);

        const feeCfg = getProtocolFeeConfig({
          feeBps: body.protocolFeeBps,
          feeRecipientEvm: undefined,
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
          return reply(200, job);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Invalid background job payload',
          });
        }
      }

      if (method === 'GET' && pathname.startsWith('/api/jobs/')) {
        const jobId = pathname.slice('/api/jobs/'.length);
        const job = jobStore.getJob(jobId);
        if (!job) return reply(404, { error: 'Background job not found' });
        return reply(200, job);
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
        }>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);

        if (!body.legId && !body.chain) {
          return reply(400, { error: 'legId or chain is required' });
        }
        if (body.status !== undefined && !VALID_JOB_LEG_STATUSES.has(body.status)) {
          return reply(400, { error: `Invalid job leg status: ${String(body.status)}` });
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
          if (!updated) return reply(404, { error: 'Background job or chain leg not found' });
          return reply(200, updated);
        } catch (err) {
          return reply(400, {
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
        if (!scan) return reply(400, { error: 'Valid scan or scanId is required' });
        const solDest = typeof body.solanaDestination === 'string' ? body.solanaDestination.trim() : '';
        if (!solDest) return reply(400, { error: 'solanaDestination is required' });
        try {
          solanaAddressToBytes32(solDest);
        } catch {
          return reply(400, { error: 'Invalid Solana destination address (expected base58 public key).' });
        }

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

        return reply(200, {
          simulationId: `sim_${crypto.randomBytes(5).toString('hex')}`,
          executedAt: new Date().toISOString(),
          mode: 'dry_run_simulation',
          plan,
          executions,
        });
      }

      if (
        await handlePreservationRoute({
          req,
          method,
          pathname,
          readJsonBody,
          reply,
          scanCache,
          agentEngine,
          preservationAgents,
          unlockHarvester,
          unlockQueuesReader: opts.unlockQueuesReader,
          maxPrivilegedBodyBytes: MAX_PRIVILEGED_JSON_BODY_BYTES,
          nowMs: opts.nowMs,
          liveGasFetcher: opts.liveGasFetcher,
        })
      ) {
        return;
      }

      if (method === 'POST' && pathname === '/api/export/safe-batch') {
        const body = await readJsonBody<SafeBatchBuildInput>(req, MAX_EXPORT_JSON_BODY_BYTES);
        try {
          const safeBatch = buildSafeTransactionBatch(body);
          return reply(200, safeBatch);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Invalid Safe Transaction Builder batch payload.',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/export/tax-csv') {
        const body = await readJsonBody<{
          format?: TaxExportFormat;
          events?: TaxSweepEvent[];
          scanId?: string;
          scan?: ScanReport;
          assets?: ScannedAsset[];
          outputAsset?: 'USDC' | 'SOL';
          generatedAt?: string | number;
          responseMode?: 'csv' | 'json';
        }>(req, MAX_EXPORT_JSON_BODY_BYTES);

        const resolvedScan =
          body.scan ??
          (typeof body.scanId === 'string' && body.scanId.trim()
            ? scanCache.get(body.scanId.trim())
            : undefined);
        if (body.scanId && !resolvedScan && !body.events && !body.assets) {
          return reply(400, { error: 'Unknown or expired scanId for tax CSV export.' });
        }

        try {
          const exported = generateTaxCsvExport({
            format: body.format as TaxExportFormat,
            events: body.events,
            scan: resolvedScan,
            assets: body.assets,
            outputAsset: body.outputAsset,
            generatedAt: body.generatedAt,
          });
          const wantsJson =
            body.responseMode === 'json' || url.searchParams.get('mode') === 'json';
          if (wantsJson) {
            return reply(200, exported);
          }

          const csvBuf = Buffer.from(exported.csv, 'utf8');
          const csvHeaders: Record<string, string> = {
            'Content-Type': exported.contentType,
            'Content-Disposition': `attachment; filename="${exported.filename}"`,
            'Content-Length': String(csvBuf.byteLength),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'no-referrer',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            'X-Turgalium-Tax-Format': exported.format,
            'X-Turgalium-Tax-Rows': String(exported.rowCount),
            ...corsHeaders,
            ...rateLimitHeaders,
          };
          res.writeHead(200, csvHeaders);
          res.end(csvBuf);
          return;
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Invalid tax CSV export payload.',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/bridge/status-batch') {
        const body = await readJsonBody<{
          bridges?: Array<{
            id?: string;
            chain: AnyChainId;
            chainName?: string;
            txHash: string;
            provider?: string;
            requestId?: string;
            solanaDestination?: string;
            status?: string;
          }>;
        }>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);
        try {
          const batch = await pollBridgeStatusesBatch(body.bridges ?? []);
          return reply(200, batch);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Invalid bridge status batch payload.',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/agent/handoff') {
        const body = await readJsonBody<{
          wallet?: string;
          family?: ChainFamily;
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          agentName?: string;
          note?: string;
        }>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);
        try {
          const kit = buildAgentHandoffKit({
            baseUrl,
            wallet: body.wallet,
            family: body.family,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset,
            agentName: body.agentName,
            note: body.note,
          });
          return reply(200, kit);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Invalid agent handoff parameters.',
          });
        }
      }

      if (method === 'POST' && pathname === '/api/workspace/hydrate') {
        const hydrateStart = performance.now();
        const body = await readJsonBody<{
          address?: string;
          family?: ChainFamily;
          presetId?: string;
          chains?: string[];
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          bridgePreference?: 'auto' | 'relay' | 'lifi' | 'cctp';
          usePermit2Batch?: boolean;
          includeBurns?: boolean;
          includePreservation?: boolean;
          includeSolanaOverview?: boolean;
          dustMaxUsd?: number;
          dustOutputAsset?: 'USDC' | 'SOL';
          refresh?: boolean;
        }>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);

        const outputAsset: 'USDC' | 'SOL' = body.outputAsset === 'SOL' ? 'SOL' : 'USDC';
        const solDestClean =
          typeof body.solanaDestination === 'string' && body.solanaDestination.trim()
            ? body.solanaDestination.trim()
            : '';

        let isValidSolDest = false;
        if (solDestClean && solDestClean !== '11111111111111111111111111111111') {
          try {
            solanaAddressToBytes32(solDestClean);
            isValidSolDest = true;
          } catch {
            isValidSolDest = false;
          }
        }

        let requestedEvmChains: EvmChainId[] | undefined;
        if (Array.isArray(body.chains) && body.chains.length > 0) {
          const validIds = new Set(CHAIN_LIST.map((c) => c.id));
          const filtered = Array.from(
            new Set(
              body.chains
                .filter((c): c is string => typeof c === 'string')
                .map((c) => c.trim().toLowerCase())
                .filter((c): c is EvmChainId => validIds.has(c as EvmChainId))
            )
          );
          if (filtered.length === 0) {
            return reply(400, { error: 'No valid EVM chain IDs in chains filter.' });
          }
          requestedEvmChains = filtered;
        }

        const refresh = body.refresh === true;
        const includeSolanaOverview = body.includeSolanaOverview === true;

        // Kick off Solana balance / overview fetch AT t=0 in parallel with wallet scan!
        const solanaStart = performance.now();
        let solanaMs = 0;
        const solanaWorkPromise: Promise<{
          balances: SolanaWalletBalance | null;
          overview: SolanaOverviewResult | null;
        }> = isValidSolDest
          ? includeSolanaOverview
            ? (async () => {
                const dustMaxUsd =
                  typeof body.dustMaxUsd === 'number' && Number.isFinite(body.dustMaxUsd)
                    ? body.dustMaxUsd
                    : undefined;
                const dustOutputAsset: 'USDC' | 'SOL' =
                  body.dustOutputAsset === 'SOL' ? 'SOL' : 'USDC';
                const ovKey = `${solDestClean}:${dustMaxUsd ?? 50}:${dustOutputAsset}`;
                const overview = await solanaOverviewCoalescer
                  .run(
                    ovKey,
                    () =>
                      fetchSolanaOverview({
                        address: solDestClean,
                        dustMaxUsd,
                        dustOutputAsset,
                        refresh,
                      }),
                    { refresh, cachePredicate: (res) => !res.rpcUnavailable }
                  )
                  .then((r) => r.value)
                  .catch(() => null);
                solanaMs = Math.max(0, Math.round(performance.now() - solanaStart));
                return { balances: overview?.balances ?? null, overview };
              })()
            : (async () => {
                const balances = await solanaBalanceCoalescer
                  .run(solDestClean, () => fetchSolanaWalletBalances(solDestClean), { refresh })
                  .then((r) => r.value)
                  .catch(() => null);
                solanaMs = Math.max(0, Math.round(performance.now() - solanaStart));
                return { balances, overview: null };
              })()
          : Promise.resolve({ balances: null, overview: null });

        const scanStart = performance.now();
        let scan: ScanReport;
        let cached = false;
        try {
          if (body.presetId) {
            scan = await scanPresetWallet(body.presetId);
            scan.family = 'evm';
          } else if (body.address) {
            const detected = detectAddress(body.address, body.family);
            if (!detected) {
              return reply(400, {
                error:
                  'Invalid wallet address or checksum. Supported: EVM (0x… / .eth), Cosmos, Sui, Aptos, TON, Tron, Bitcoin.',
              });
            }
            const cacheKey = `${detected.family}:${detected.normalized.toLowerCase()}:${
              requestedEvmChains ? requestedEvmChains.slice().sort().join(',') : 'all'
            }`;
            const outcome = await liveScanCoalescer.run(
              cacheKey,
              async () => {
                if (detected.family === 'evm') {
                  const evmScan = await scanEvmWalletWithOptions(body.address!, undefined, {
                    chains: requestedEvmChains,
                  });
                  evmScan.family = 'evm';
                  return evmScan;
                }
                return getAdapterForFamily(detected.family).scanWallet(detected.normalized);
              },
              { refresh }
            );
            scan = outcome.value;
            cached = outcome.cached;
          } else {
            return reply(400, { error: 'address or presetId is required.' });
          }
        } catch (err) {
          if (err instanceof EnsResolutionError) {
            return reply(err.code === 'RPC_ERROR' ? 503 : 400, { error: err.message });
          }
          const msg = err instanceof Error ? err.message : 'Wallet scan failed';
          return reply(msg.toLowerCase().includes('invalid') ? 400 : 500, { error: msg });
        }
        const scanMs = Math.max(0, Math.round(performance.now() - scanStart));

        scanCache.set(scan.scanId, scan);

        const defaultSelectedIds = scan.assets
          .filter((a) => a.selectedByDefault)
          .map((a) => a.id);

        const planStart = performance.now();
        const [solanaWork, preservation] = await Promise.all([
          solanaWorkPromise,
          body.includePreservation !== false
            ? evaluatePreservationPlan(scan, {
                outputAsset,
              }).catch(() => null)
            : Promise.resolve(null),
        ]);

        const solBalances = solanaWork.balances;
        const plan = buildMigrationPlan({
          scan,
          selectedAssetIds: defaultSelectedIds,
          solanaDestination: solDestClean || '11111111111111111111111111111111',
          usePermit2Batch: body.usePermit2Batch !== false,
          includeBurns: Boolean(body.includeBurns),
          outputAsset,
          bridgePreference: body.bridgePreference ?? 'auto',
          hasSolanaUsdcAta: solBalances ? Boolean(solBalances.hasUsdcAta) : undefined,
        });
        const planMs = Math.max(0, Math.round(performance.now() - planStart));
        const totalMs = Math.max(1, Math.round(performance.now() - hydrateStart));

        return reply(200, {
          cached,
          timingMs: {
            total: totalMs,
            scan: scanMs,
            plan: planMs,
            solana: solanaMs,
          },
          scan,
          plan,
          preservation,
          solanaBalances: solBalances,
          ...(includeSolanaOverview ? { solanaOverview: solanaWork.overview } : {}),
        });
      }

      if (method === 'POST' && pathname === '/api/agent/review-link') {
        const body = await readJsonBody<{
          wallet?: string;
          family?: ChainFamily;
          solanaDestination?: string;
          outputAsset?: 'USDC' | 'SOL';
          chains?: string[];
          agentName?: string;
          note?: string;
        }>(req, MAX_PRIVILEGED_JSON_BODY_BYTES);
        try {
          const result = buildAgentReviewLink({
            baseUrl,
            wallet: typeof body.wallet === 'string' ? body.wallet : '',
            family: body.family,
            solanaDestination: body.solanaDestination,
            outputAsset: body.outputAsset,
            chains: body.chains,
            agentName: body.agentName,
            note: body.note,
          });
          return reply(200, result);
        } catch (err) {
          return reply(400, {
            error: err instanceof Error ? err.message : 'Invalid review-link parameters.',
          });
        }
      }

      if (
        pathname.startsWith('/api/solana/') &&
        (await handleSolanaRoutes({
          method,
          pathname,
          url,
          req,
          reply,
          readJsonBody,
          overviewCoalescer: solanaOverviewCoalescer,
        }))
      ) {
        return;
      }

      if (pathname.startsWith('/api/approvals/') && (await handleApprovalRoutes({ method, pathname, url, req, reply, readJsonBody }))) {
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && serveStaticFile(res, pathname, method === 'HEAD')) {
        return;
      }

      return reply(404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof HttpError) {
        return sendJson(res, err.status, { error: err.message });
      }
      return sendJson(res, 500, {
        error: 'Internal server error',
      });
    }
  };

  const server = http.createServer(requestHandler);

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  server.on('close', () => {
    jobStore.dispose();
    preservationAgents.stopPoller();
    unlockHarvester.stopPoller();
  });

  return {
    server,
    requestHandler,
    scanCache,
    jobStore,
    agentEngine,
    preservationAgents,
    unlockHarvester,
    stateStore,
    rateLimiter,
  };
}
