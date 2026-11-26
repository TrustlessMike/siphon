import type { IncomingMessage } from 'node:http';
import {
  getKnownApprovalSpenders,
  scanStaleErc20Approvals,
  type ApprovalSpenderInput,
  type ApprovalTokenInput,
  type ScanApprovalsOptions,
  type StaleApprovalScanResult,
} from '../scanner/approvals.js';
import { EVM_CHAINS } from '../scanner/chains.js';
import type { EvmChainId } from '../scanner/types.js';

const MAX_APPROVAL_JSON_BODY_BYTES = 65_536; // 64 KiB strict cap for approval scan payloads
const MAX_TOKENS_PER_SCAN = 100;
const MAX_SPENDERS_PER_SCAN = 50;

export interface ApprovalRouteContext {
  method: string;
  pathname: string;
  url: URL;
  req: IncomingMessage;
  reply: (status: number, payload: unknown) => void;
  readJsonBody: <T>(req: IncomingMessage, maxBytes?: number) => Promise<T>;
  scanApprovalsFn?: (
    chain: EvmChainId,
    walletAddress: string,
    tokens?: Array<ApprovalTokenInput | string>,
    spenders?: Array<ApprovalSpenderInput | string>,
    opts?: ScanApprovalsOptions
  ) => Promise<StaleApprovalScanResult>;
}

function isSupportedEvmChain(chain: string): chain is EvmChainId {
  return Object.prototype.hasOwnProperty.call(EVM_CHAINS, chain);
}

/**
 * Modular HTTP routes for ERC-20 Stale Approval Scanning & Revocation:
 *  - GET  /api/approvals/spenders?chain=ethereum
 *  - POST /api/approvals/scan
 */
export async function handleApprovalRoutes(ctx: ApprovalRouteContext): Promise<boolean> {
  const { method, pathname, url, req, reply, readJsonBody } = ctx;
  const runScan = ctx.scanApprovalsFn ?? scanStaleErc20Approvals;

  if (method === 'GET' && pathname === '/api/approvals/spenders') {
    const chainParam = (url.searchParams.get('chain') ?? 'ethereum').trim().toLowerCase();
    if (!isSupportedEvmChain(chainParam)) {
      reply(400, {
        error: `Unsupported EVM chain: ${chainParam}. Supported chains: ${Object.keys(EVM_CHAINS).join(', ')}.`,
      });
      return true;
    }
    reply(200, {
      chain: chainParam,
      chainId: EVM_CHAINS[chainParam].chainId,
      spenders: getKnownApprovalSpenders(chainParam),
    });
    return true;
  }

  if (method === 'POST' && pathname === '/api/approvals/scan') {
    const body = await readJsonBody<{
      chain?: string;
      walletAddress?: string;
      address?: string;
      tokens?: Array<ApprovalTokenInput | string>;
      spenders?: Array<ApprovalSpenderInput | string>;
      customSpenders?: Array<ApprovalSpenderInput | string>;
      includeKnownSpenders?: boolean;
      unlimitedOnly?: boolean;
      multicallChunkSize?: number;
    }>(req, MAX_APPROVAL_JSON_BODY_BYTES);

    const chainRaw = typeof body.chain === 'string' ? body.chain.trim().toLowerCase() : '';
    if (!chainRaw || !isSupportedEvmChain(chainRaw)) {
      reply(400, {
        error: `Valid EVM chain is required. Supported chains: ${Object.keys(EVM_CHAINS).join(', ')}.`,
      });
      return true;
    }

    const walletAddress = (body.walletAddress ?? body.address ?? '').trim();
    if (!walletAddress) {
      reply(400, { error: 'walletAddress is required.' });
      return true;
    }

    if (body.tokens !== undefined && !Array.isArray(body.tokens)) {
      reply(400, { error: 'tokens must be an array when provided.' });
      return true;
    }
    if (body.tokens && body.tokens.length > MAX_TOKENS_PER_SCAN) {
      reply(400, { error: `tokens exceeds maximum of ${MAX_TOKENS_PER_SCAN} per scan.` });
      return true;
    }
    if (body.spenders !== undefined && !Array.isArray(body.spenders)) {
      reply(400, { error: 'spenders must be an array when provided.' });
      return true;
    }
    if (body.customSpenders !== undefined && !Array.isArray(body.customSpenders)) {
      reply(400, { error: 'customSpenders must be an array when provided.' });
      return true;
    }

    const combinedSpenders: Array<ApprovalSpenderInput | string> | undefined =
      body.spenders && body.spenders.length > 0
        ? [...body.spenders, ...(body.customSpenders ?? [])]
        : body.customSpenders && body.customSpenders.length > 0
        ? body.customSpenders
        : undefined;

    if (combinedSpenders && combinedSpenders.length > MAX_SPENDERS_PER_SCAN) {
      reply(400, { error: `spenders exceeds maximum of ${MAX_SPENDERS_PER_SCAN} per scan.` });
      return true;
    }

    // When only customSpenders is passed (no explicit spenders override), default includeKnownSpenders=true
    const includeKnownSpenders =
      body.includeKnownSpenders !== undefined
        ? Boolean(body.includeKnownSpenders)
        : Boolean(!body.spenders?.length && body.customSpenders?.length);

    try {
      const result = await runScan(chainRaw, walletAddress, body.tokens, combinedSpenders, {
        includeKnownSpenders,
        unlimitedOnly: Boolean(body.unlimitedOnly),
        multicallChunkSize: body.multicallChunkSize,
      });
      reply(200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to scan ERC-20 approvals.';
      const isValidationError = /invalid|unsupported|required|expected/i.test(msg);
      reply(isValidationError ? 400 : 503, {
        ...(isValidationError ? {} : { rpcUnavailable: true }),
        error: msg,
      });
    }
    return true;
  }

  return false;
}
