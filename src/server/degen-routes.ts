import type { IncomingMessage } from 'node:http';
import {
  type BinarySide,
  type JupiterMarketsClient,
} from '../degen/jupiter-markets.js';

const MAX_DEGEN_JSON_BODY_BYTES = 32_768; // 32 KiB strict cap for degen order previews

export interface DegenRouteContext {
  method: string;
  pathname: string;
  url: URL;
  req: IncomingMessage;
  reply: (status: number, payload: unknown) => void;
  readJsonBody: <T>(req: IncomingMessage, maxBytes?: number) => Promise<T>;
  client: JupiterMarketsClient;
}

/**
 * Modular HTTP routes for the Siphon Degen tab (live Jupiter Prediction Markets +
 * Preservation-First Side-Pocket cap + Order Preview).
 */
export async function handleDegenRoutes(ctx: DegenRouteContext): Promise<boolean> {
  const { method, pathname, url, req, reply, readJsonBody, client } = ctx;

  if (method === 'GET' && pathname === '/api/degen/markets') {
    const category = url.searchParams.get('category');
    const filter = url.searchParams.get('filter');
    const rawLimit = url.searchParams.get('limit');
    const rawStart = url.searchParams.get('start');

    const limit = rawLimit !== null ? Number(rawLimit) : 18;
    const start = rawStart !== null ? Number(rawStart) : 0;

    if (!Number.isFinite(limit) || limit < 1 || limit > 36) {
      reply(400, { error: 'limit must be a finite number between 1 and 36.' });
      return true;
    }
    if (!Number.isFinite(start) || start < 0 || start > 500) {
      reply(400, { error: 'start must be a finite number between 0 and 500.' });
      return true;
    }

    const feed = await client.fetchEvents({ category, filter, limit, start });
    reply(200, feed);
    return true;
  }

  if (method === 'GET' && pathname === '/api/degen/search') {
    const query = (url.searchParams.get('q') ?? '').trim();
    if (!query) {
      reply(400, { error: 'Query parameter q is required.' });
      return true;
    }
    if (query.length > 120) {
      reply(400, { error: 'Query parameter q exceeds 120 characters.' });
      return true;
    }
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit !== null ? Number(rawLimit) : 18;
    if (!Number.isFinite(limit) || limit < 1 || limit > 36) {
      reply(400, { error: 'limit must be a finite number between 1 and 36.' });
      return true;
    }

    try {
      const feed = await client.searchEvents({ query, limit });
      reply(200, feed);
    } catch (err) {
      reply(400, {
        error: err instanceof Error ? err.message : 'Invalid search query.',
      });
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/degen/order-preview') {
    const body = await readJsonBody<{
      marketId?: string;
      side?: BinarySide;
      stakeUsd?: number;
      availableUsdc?: number;
      riskPct?: number;
      priceUsd?: number;
      eventSlug?: string | null;
      eventTitle?: string | null;
      marketTitle?: string | null;
      walletAddress?: string | null;
      requestLiveTx?: boolean;
    }>(req, MAX_DEGEN_JSON_BODY_BYTES);

    try {
      const preview = await client.buildOrderPreview({
        marketId: body.marketId ?? '',
        side: body.side as BinarySide,
        stakeUsd: body.stakeUsd as number,
        availableUsdc: body.availableUsdc as number,
        riskPct: body.riskPct,
        priceUsd: body.priceUsd,
        eventSlug: body.eventSlug,
        eventTitle: body.eventTitle,
        marketTitle: body.marketTitle,
        walletAddress: body.walletAddress,
        requestLiveTx: Boolean(body.requestLiveTx),
      });
      reply(200, preview);
    } catch (err) {
      reply(400, {
        error: err instanceof Error ? err.message : 'Invalid Degen order preview payload.',
      });
    }
    return true;
  }

  return false;
}
