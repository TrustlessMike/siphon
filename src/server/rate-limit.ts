import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface RateLimiterOptions {
  enabled?: boolean;
  maxRequests?: number;
  windowMs?: number;
  maxKeys?: number;
  trustProxy?: boolean;
  trustFlyClientIp?: boolean;
  nowMs?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  key: string;
  limit: number;
  remaining: number;
  retryAfterSec: number;
  resetAtMs: number;
}

export interface RateLimiterStats {
  enabled: boolean;
  maxRequests: number;
  windowMs: number;
  activeKeys: number;
  allowedTotal: number;
  blockedTotal: number;
}

const DEFAULT_MAX_REQUESTS = 240;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const norm = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(norm)) return true;
  if (['0', 'false', 'no', 'off'].includes(norm)) return false;
  return undefined;
}

function normalizeClientIp(raw: string | undefined): string {
  if (!raw) return 'unknown';
  const cleaned = raw.trim();
  if (cleaned.startsWith('::ffff:')) {
    return cleaned.slice('::ffff:'.length);
  }
  return cleaned || 'unknown';
}

/**
 * Extracts a stable per-verified-token or per-IP rate-limit bucket key.
 *
 * Security invariants:
 *   - NEVER keys on unverified `Authorization: Bearer <random>` headers (prevents trivial quota bypass).
 *   - Only uses `token:<id>` when the caller supplies an already-verified plugin `verifiedTokenId`.
 *   - Only trusts `Fly-Client-IP` when `trustFlyClientIp` is true (i.e. `FLY_APP_NAME` is set).
 *   - Under `trustProxy: true`, reads the rightmost untrusted IP in `X-Forwarded-For` rather than
 *     the client-spoofable leftmost entry.
 */
export function extractRateLimitKey(
  req: IncomingMessage,
  trustProxy = false,
  opts: { verifiedTokenId?: string | null; trustFlyClientIp?: boolean } = {}
): string {
  const verifiedTokenId =
    typeof opts.verifiedTokenId === 'string' ? opts.verifiedTokenId.trim() : '';
  if (verifiedTokenId) {
    const digest = crypto.createHash('sha256').update(verifiedTokenId).digest('hex').slice(0, 16);
    return `token:${digest}`;
  }

  if (trustProxy) {
    const allowFlyClientIp = opts.trustFlyClientIp ?? Boolean(process.env.FLY_APP_NAME?.trim());
    if (allowFlyClientIp) {
      const flyIp = req.headers['fly-client-ip'];
      const flyIpVal = Array.isArray(flyIp) ? flyIp[0] : flyIp;
      if (typeof flyIpVal === 'string' && flyIpVal.trim()) {
        return `ip:${normalizeClientIp(flyIpVal)}`;
      }
    }
    const xff = req.headers['x-forwarded-for'];
    const xffVal = Array.isArray(xff) ? xff.join(',') : xff;
    if (typeof xffVal === 'string' && xffVal.trim()) {
      const parts = xffVal
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const rightmost = parts[parts.length - 1];
      if (rightmost) return `ip:${normalizeClientIp(rightmost)}`;
    }
  }

  return `ip:${normalizeClientIp(req.socket?.remoteAddress)}`;
}

/**
 * Exact sliding-window rate limiter with bounded key cardinality and injectable clock.
 */
export class SlidingWindowRateLimiter {
  readonly enabled: boolean;
  readonly maxRequests: number;
  readonly windowMs: number;
  readonly trustProxy: boolean;
  readonly trustFlyClientIp: boolean;
  private readonly maxKeys: number;
  private readonly nowMs: () => number;
  private readonly buckets = new Map<string, number[]>();
  private allowedTotal = 0;
  private blockedTotal = 0;

  constructor(opts: RateLimiterOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    const envDisabled = parseBoolEnv(env.SIPHON_RATE_LIMIT_DISABLED);
    this.enabled = opts.enabled ?? (envDisabled === true ? false : true);
    this.maxRequests = Math.max(
      1,
      Math.floor(opts.maxRequests ?? parsePositiveInt(env.SIPHON_RATE_LIMIT_MAX, DEFAULT_MAX_REQUESTS))
    );
    this.windowMs = Math.max(
      100,
      Math.floor(opts.windowMs ?? parsePositiveInt(env.SIPHON_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS))
    );
    this.maxKeys = Math.max(100, Math.floor(opts.maxKeys ?? DEFAULT_MAX_KEYS));
    const envTrustProxy = parseBoolEnv(env.SIPHON_TRUST_PROXY);
    this.trustFlyClientIp = opts.trustFlyClientIp ?? Boolean(env.FLY_APP_NAME?.trim());
    this.trustProxy = opts.trustProxy ?? (envTrustProxy ?? this.trustFlyClientIp);
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  consume(key: string): RateLimitDecision {
    const now = this.nowMs();
    if (!this.enabled) {
      this.allowedTotal += 1;
      return {
        allowed: true,
        key,
        limit: this.maxRequests,
        remaining: this.maxRequests,
        retryAfterSec: 0,
        resetAtMs: now + this.windowMs,
      };
    }

    const cutoff = now - this.windowMs;
    const existing = this.buckets.get(key) ?? [];
    const active = existing.filter((ts) => ts > cutoff);

    if (active.length >= this.maxRequests) {
      // Refresh LRU placement while retaining active timestamps
      this.buckets.delete(key);
      this.buckets.set(key, active);
      this.blockedTotal += 1;
      const oldestTs = active[0] ?? now;
      const resetAtMs = oldestTs + this.windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
      return {
        allowed: false,
        key,
        limit: this.maxRequests,
        remaining: 0,
        retryAfterSec,
        resetAtMs,
      };
    }

    active.push(now);
    this.buckets.delete(key);
    this.buckets.set(key, active);
    this.evictIfNeeded(cutoff);
    this.allowedTotal += 1;

    const resetAtMs = (active[0] ?? now) + this.windowMs;
    return {
      allowed: true,
      key,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - active.length),
      retryAfterSec: 0,
      resetAtMs,
    };
  }

  consumeRequest(req: IncomingMessage, verifiedTokenId?: string | null): RateLimitDecision {
    const key = extractRateLimitKey(req, this.trustProxy, {
      verifiedTokenId,
      trustFlyClientIp: this.trustFlyClientIp,
    });
    return this.consume(key);
  }

  private evictIfNeeded(cutoff: number): void {
    if (this.buckets.size <= this.maxKeys) return;
    // Pass 1: remove stale keys with no active timestamps
    for (const [k, list] of this.buckets.entries()) {
      if (list.length === 0 || list[list.length - 1] <= cutoff) {
        this.buckets.delete(k);
        if (this.buckets.size <= this.maxKeys) return;
      }
    }
    // Pass 2: evict oldest LRU keys
    for (const k of this.buckets.keys()) {
      this.buckets.delete(k);
      if (this.buckets.size <= this.maxKeys) break;
    }
  }

  getStats(): RateLimiterStats {
    return {
      enabled: this.enabled,
      maxRequests: this.maxRequests,
      windowMs: this.windowMs,
      activeKeys: this.buckets.size,
      allowedTotal: this.allowedTotal,
      blockedTotal: this.blockedTotal,
    };
  }

  reset(): void {
    this.buckets.clear();
    this.allowedTotal = 0;
    this.blockedTotal = 0;
  }
}

export function buildRateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Reset': String(Math.ceil(decision.resetAtMs / 1000)),
  };
  if (!decision.allowed) {
    headers['Retry-After'] = String(Math.max(1, decision.retryAfterSec));
  }
  return headers;
}
