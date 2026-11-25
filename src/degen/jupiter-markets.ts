import { solanaAddressToBytes32 } from '../bridge/cctp.js';
import { BoundedTtlCache } from '../server/cache.js';

export const JUPITER_PREDICTION_API_BASE = 'https://api.jup.ag/prediction/v1';
export const JUPITER_PREDICTION_WEB_BASE = 'https://jup.ag/prediction';
export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const MICRO_USD_SCALE = 1_000_000;
export const MIN_JUPITER_ORDER_USD = 5;
export const DEFAULT_PRESERVED_YIELD_APY_PCT = 7;
export const DEFAULT_YIELD_FUNDED_HORIZON_DAYS = 30;
export const DEFAULT_JUPITER_TIMEOUT_MS = 4_500;
export const DEFAULT_JUPITER_CACHE_TTL_MS = 30_000;
export const DEFAULT_JUPITER_CACHE_MAX_ENTRIES = 64;
export const MAX_DEGEN_RISK_PCT = 50;
export const DEFAULT_DEGEN_RISK_PCT = 10;
export const HIGH_RISK_WARNING_THRESHOLD_PCT = 25;
export const DEGEN_RISK_PRESETS_PCT = [5, 10, 15, 25] as const;

export type DegenSidePocketMode = 'percent' | 'yield_funded';

export const ALLOWED_JUPITER_CATEGORIES = [
  'all',
  'crypto',
  'sports',
  'politics',
  'esports',
  'culture',
  'economics',
  'tech',
] as const;
export type JupiterCategory = (typeof ALLOWED_JUPITER_CATEGORIES)[number];

export const ALLOWED_JUPITER_FILTERS = ['trending', 'live', 'new', 'upcoming'] as const;
export type JupiterFilter = (typeof ALLOWED_JUPITER_FILTERS)[number];

export type BinarySide = 'yes' | 'no';

export interface JupiterGameMode {
  id: 'arcade' | 'degen' | 'sports' | 'combos' | 'perps';
  name: string;
  shortTitle: string;
  cadence: string;
  badge: string;
  description: string;
  url: string;
  riskTag: string;
}

export const JUPITER_GAME_MODES: readonly JupiterGameMode[] = Object.freeze([
  {
    id: 'arcade',
    name: 'Jupiter Arcade',
    shortTitle: 'Arcade',
    cadence: '1m rounds',
    badge: 'Up / Down',
    description: '1-min BTC & SOL Up/Down rolling pool rounds.',
    url: 'https://jup.ag/prediction/arcade',
    riskTag: 'High variance · Binary',
  },
  {
    id: 'degen',
    name: 'Jupiter Degen',
    shortTitle: 'Degen',
    cadence: '5m / 15m',
    badge: 'Fast Crypto',
    description: '5-min & 15-min fast crypto Up/Down binary contracts.',
    url: 'https://jup.ag/prediction/degen',
    riskTag: 'High variance · Binary',
  },
  {
    id: 'sports',
    name: 'Jupiter Sports',
    shortTitle: 'Sports',
    cadence: 'Live lines',
    badge: 'No-fee Tickets',
    description: 'Live moneylines, spreads, totals & no-fee game tickets.',
    url: 'https://jup.ag/prediction/sports',
    riskTag: 'Event settlement',
  },
  {
    id: 'combos',
    name: 'Jupiter Combos',
    shortTitle: 'Combos',
    cadence: '2–50 legs',
    badge: 'Parlays',
    description: '2–50 leg sports & esports parlays settled on Solana.',
    url: 'https://jup.ag/prediction/combos',
    riskTag: 'Multi-leg · High variance',
  },
  {
    id: 'perps',
    name: 'Jupiter Perps',
    shortTitle: 'Perps',
    cadence: 'Up to 100x',
    badge: 'Perpetuals',
    description: 'SOL / BTC / ETH perpetuals up to 100x leverage.',
    url: 'https://jup.ag/perps',
    riskTag: 'Liquidation risk',
  },
]);

export interface SidePricingQuote {
  priceUsd: number;
  cents: number;
  impliedProbPct: number;
  payoutMultiplier: number;
  sellPriceUsd: number | null;
}

export interface ProjectedPayout {
  stakeUsd: number;
  priceUsd: number;
  shares: number;
  projectedPayoutUsd: number;
  projectedProfitUsd: number;
  payoutMultiplier: number;
  roiPct: number;
  breakevenProbPct: number;
  maxLossUsd: number;
}

export interface NormalizedDegenMarket {
  marketId: string;
  provider: string;
  status: string;
  title: string;
  closeTime: string | null;
  volumeUsd: number;
  outcomes: string[];
  sportsMarketType: string | null;
  comboStatus: string | null;
  yes: SidePricingQuote | null;
  no: SidePricingQuote | null;
}

export interface NormalizedDegenEvent {
  eventId: string;
  slug: string | null;
  jupiterUrl: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
  category: string;
  subcategory: string;
  series: string;
  tags: string[];
  isActive: boolean;
  isLive: boolean;
  closeTime: string | null;
  volumeUsd: number;
  volume24hrUsd: number;
  marketsCount: number;
  markets: NormalizedDegenMarket[];
}

export interface DegenSidePocketInput {
  availableUsdc: number;
  riskPct?: number;
  mode?: DegenSidePocketMode;
  yieldApyPct?: number;
  yieldHorizonDays?: number;
}

export interface DegenSidePocketResult {
  mode: DegenSidePocketMode;
  availableUsdc: number;
  requestedRiskPct: number;
  effectiveRiskPct: number;
  wasClamped: boolean;
  maxRiskPct: number;
  preservedPct: number;
  preservedUsdc: number;
  maxDegenBudgetUsd: number;
  yieldApyPct: number;
  yieldHorizonDays: number;
  projectedAnnualYieldUsd: number;
  projected30dYieldUsd: number;
  highRiskWarning: string | null;
  presetsPct: readonly number[];
}

export interface JupiterFeedResult {
  ok: boolean;
  live: boolean;
  source: 'jupiter-prediction-v1';
  fetchedAt: string;
  cached: boolean;
  cacheTtlMs: number;
  category: JupiterCategory;
  filter: JupiterFilter;
  query?: string;
  events: NormalizedDegenEvent[];
  totalReturned: number;
  gameModes: readonly JupiterGameMode[];
  apiKeyConfigured: boolean;
  geoBlocked?: boolean;
  error?: string;
}

export interface DegenOrderPreviewInput {
  marketId: string;
  side: BinarySide;
  stakeUsd: number;
  availableUsdc: number;
  riskPct?: number;
  sidePocketMode?: DegenSidePocketMode;
  yieldApyPct?: number;
  priceUsd?: number;
  eventSlug?: string | null;
  eventTitle?: string | null;
  marketTitle?: string | null;
  walletAddress?: string | null;
  requestLiveTx?: boolean;
}

export interface DegenLiveOrderResult {
  attempted: boolean;
  available: boolean;
  depositMint?: string;
  geoBlocked?: boolean;
  apiKeyRequired?: boolean;
  statusCode?: number;
  reason?: string;
  orderId?: string | null;
  transactionBase64?: string | null;
  expiresAt?: string | null;
}

export interface DegenOrderPreviewResult {
  ok: true;
  marketId: string;
  eventSlug: string | null;
  eventTitle: string;
  marketTitle: string;
  side: BinarySide;
  jupiterUrl: string;
  sidePocket: DegenSidePocketResult;
  payout: ProjectedPayout;
  remainingSidePocketUsd: number;
  riskNotice: string;
  liveOrder: DegenLiveOrderResult;
}

export type DegenPositionStatus = 'open' | 'claimable' | 'settled' | 'closed';

export interface NormalizedDegenPosition {
  positionId: string;
  ownerPubkey: string;
  marketId: string;
  eventId: string | null;
  eventSlug: string | null;
  eventTitle: string;
  marketTitle: string;
  jupiterUrl: string;
  side: BinarySide;
  status: DegenPositionStatus;
  shares: number;
  avgEntryPriceUsd: number;
  markPriceUsd: number;
  costBasisUsd: number;
  currentValueUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  claimable: boolean;
  claimablePayoutUsd: number;
  settledPayoutUsd: number;
  canCloseEarly: boolean;
  updatedAt: string | null;
}

export interface DegenPositionsSummary {
  openCount: number;
  claimableCount: number;
  settledCount: number;
  totalCostBasisUsd: number;
  totalCurrentValueUsd: number;
  totalUnrealizedPnlUsd: number;
  totalClaimablePayoutUsd: number;
  totalSettledPayoutUsd: number;
}

export interface JupiterPositionsResult {
  ok: boolean;
  live: boolean;
  ownerPubkey: string;
  fetchedAt: string;
  positions: NormalizedDegenPosition[];
  summary: DegenPositionsSummary;
  apiKeyConfigured: boolean;
  geoBlocked?: boolean;
  error?: string;
}

export interface DegenPositionActionResult {
  ok: boolean;
  action: 'claim' | 'close';
  positionId: string;
  available: boolean;
  transactionBase64: string | null;
  orderId?: string | null;
  expiresAt?: string | null;
  jupiterUrl: string;
  apiKeyConfigured: boolean;
  geoBlocked?: boolean;
  apiKeyRequired?: boolean;
  statusCode?: number;
  reason?: string;
}

export interface JupiterMarketsClientOptions {
  apiBaseUrl?: string;
  apiKey?: string | null;
  timeoutMs?: number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

interface RawJupiterPricing {
  buyYesPriceUsd?: number | string | null;
  sellYesPriceUsd?: number | string | null;
  buyNoPriceUsd?: number | string | null;
  sellNoPriceUsd?: number | string | null;
  volume?: number | string | null;
}

interface RawJupiterMarket {
  provider?: string | null;
  marketId?: string | null;
  status?: string | null;
  title?: string | null;
  closeTime?: number | string | null;
  pricing?: RawJupiterPricing | null;
  outcomes?: unknown;
  sportsMarketType?: string | null;
  comboStatus?: string | null;
}

interface RawJupiterEvent {
  eventId?: string | null;
  isActive?: boolean;
  isLive?: boolean;
  category?: string | null;
  subcategory?: string | null;
  tags?: unknown;
  metadata?: {
    slug?: string | null;
    title?: string | null;
    subtitle?: string | null;
    imageUrl?: string | null;
    closeTime?: number | string | null;
    series?: string | null;
  } | null;
  volumeUsd?: number | string | null;
  volume24hr?: number | string | null;
  markets?: RawJupiterMarket[] | null;
}

// ASCII controls, DEL, C1 controls, zero-width & bidi override characters
const UNSAFE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
const HTML_TAG_RE = /<[^>]*>/g;
const SAFE_SLUG_RE = /^[a-zA-Z0-9_-]{1,160}$/;
const SAFE_MARKET_ID_RE = /^[a-zA-Z0-9._:-]{1,120}$/;
const SAFE_POSITION_ID_RE = /^[a-zA-Z0-9._:-]{1,128}$/;

const GEO_BLOCK_TEXT_RE = /\b(geo|region|country|jurisdiction|restricted|not available in your|unavailable in your|blocked region|sanctioned)\b/i;

const CATEGORY_SET = new Set<string>(ALLOWED_JUPITER_CATEGORIES);
const FILTER_SET = new Set<string>(ALLOWED_JUPITER_FILTERS);

function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

/**
 * Strips control characters, HTML tags, and stray angle brackets so untrusted
 * upstream strings cannot inject markup or bidi spoofing before reaching clients.
 */
export function sanitizeDegenText(raw?: unknown, maxLen = 140, fallback = ''): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(UNSAFE_CONTROL_RE, ' ')
    .replace(HTML_TAG_RE, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

/**
 * Strictly validates a Jupiter event slug against `^[a-zA-Z0-9_-]+$`.
 * Rejects path traversal (`..`), protocols (`javascript:`), slashes, and encodings.
 */
export function sanitizeJupiterSlug(raw?: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || !SAFE_SLUG_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Builds a canonical Jupiter Prediction event URL using strict slug validation.
 */
export function buildJupiterEventUrl(rawSlug?: unknown): string {
  const cleanSlug = sanitizeJupiterSlug(rawSlug);
  if (!cleanSlug) return JUPITER_PREDICTION_WEB_BASE;
  return `${JUPITER_PREDICTION_WEB_BASE}/${encodeURIComponent(cleanSlug)}`;
}

/**
 * Strict HTTPS-only URL sanitizer for upstream event thumbnails / links.
 * Rejects `javascript:`, `data:`, `http:`, credentials, and control characters.
 */
export function sanitizeHttpsUrl(raw?: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 512 || UNSAFE_CONTROL_RE.test(trimmed)) return null;
  if (trimmed.startsWith('//')) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.toString();
}

/**
 * Strictly validates a Jupiter position ID / pubkey against `^[a-zA-Z0-9._:-]{1,128}$`.
 * Rejects XSS payloads, path traversal (`..`), slashes, whitespace, and control characters.
 */
export function sanitizePositionId(raw?: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('..') || !SAFE_POSITION_ID_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Converts Jupiter Prediction API micro-USD (`1e6`) numbers or numeric strings into USD.
 * Fails closed (`null`) on NaN, Infinity, negative values, or non-numeric strings.
 */
export function parseMicroUsd(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'boolean') return null;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(num) || num < 0) return null;
  return num / MICRO_USD_SCALE;
}

/**
 * Converts signed micro-USD (`1e6`) values (such as unrealized P&L) into USD.
 * Fails closed (`null`) on NaN, Infinity, booleans, or non-numeric strings.
 */
export function parseSignedMicroUsd(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'boolean') return null;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(num)) return null;
  return num / MICRO_USD_SCALE;
}

function parseContractPriceUsd(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'boolean') return null;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(num) || num < 0) return null;
  if (num === 0) return 0;
  if (num <= 1) return roundTo(num, 6);
  const scaled = num / MICRO_USD_SCALE;
  return scaled <= 1 ? roundTo(scaled, 6) : null;
}

function parseFiniteNonNegNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'boolean') return null;
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(num) || num < 0) return null;
  return num;
}

/**
 * Normalizes a contract side price (in USD, 0 < price <= 1) into cents, implied probability,
 * and payout multiplier (`1 / price`).
 */
export function buildSidePricingQuote(
  buyPriceUsd: number | null,
  sellPriceUsd: number | null = null
): SidePricingQuote | null {
  if (buyPriceUsd === null || !Number.isFinite(buyPriceUsd) || buyPriceUsd <= 0 || buyPriceUsd > 1) {
    return null;
  }
  const normalizedSell =
    sellPriceUsd !== null && Number.isFinite(sellPriceUsd) && sellPriceUsd >= 0 && sellPriceUsd <= 1
      ? roundTo(sellPriceUsd, 6)
      : null;
  return {
    priceUsd: roundTo(buyPriceUsd, 6),
    cents: roundTo(buyPriceUsd * 100, 1),
    impliedProbPct: roundTo(buyPriceUsd * 100, 1),
    payoutMultiplier: roundTo(1 / buyPriceUsd, 2),
    sellPriceUsd: normalizedSell,
  };
}

/**
 * Computes exact binary contract shares, payout, profit, ROI %, and breakeven odds
 * for a given stake and contract price (`0 < priceUsd <= 1`).
 */
export function computeProjectedPayout(stakeUsd: number, priceUsd: number): ProjectedPayout {
  if (typeof stakeUsd !== 'number' || !Number.isFinite(stakeUsd) || stakeUsd <= 0) {
    throw new Error('stakeUsd must be a finite positive number.');
  }
  if (typeof priceUsd !== 'number' || !Number.isFinite(priceUsd) || priceUsd <= 0 || priceUsd > 1) {
    throw new Error('priceUsd must be a finite number in (0, 1].');
  }
  const exactShares = stakeUsd / priceUsd;
  const exactPayout = exactShares; // $1.00 payout per winning binary contract share
  const exactProfit = exactPayout - stakeUsd;
  const exactRoiPct = (exactProfit / stakeUsd) * 100;

  return {
    stakeUsd: roundTo(stakeUsd, 2),
    priceUsd: roundTo(priceUsd, 6),
    shares: roundTo(exactShares, 4),
    projectedPayoutUsd: roundTo(exactPayout, 2),
    projectedProfitUsd: roundTo(exactProfit, 2),
    payoutMultiplier: roundTo(1 / priceUsd, 2),
    roiPct: roundTo(exactRoiPct, 2),
    breakevenProbPct: roundTo(priceUsd * 100, 1),
    maxLossUsd: roundTo(stakeUsd, 2),
  };
}

/**
 * Capital-Preservation Side-Pocket Calculator.
 * Keeps migrated Solana USDC principal preserved (90% default) and strictly caps optional
 * Degen allocation (default 10%, hard-clamped <= 50%, explicit warning above 25%).
 * In `yield_funded` mode, 100% of principal stays untouched and Degen stake is strictly
 * capped to projected yield over `yieldHorizonDays` (default 30d at ~7% APY).
 */
export function computeDegenSidePocket(input: DegenSidePocketInput): DegenSidePocketResult {
  if (!input || typeof input !== 'object') {
    throw new Error('Side-pocket input is required.');
  }
  const { availableUsdc } = input;
  if (typeof availableUsdc !== 'number' || !Number.isFinite(availableUsdc) || availableUsdc < 0) {
    throw new Error('availableUsdc must be a finite non-negative number.');
  }

  const mode: DegenSidePocketMode =
    input.mode === 'yield_funded' ? 'yield_funded' : 'percent';

  const yieldApyPct =
    input.yieldApyPct === undefined ? DEFAULT_PRESERVED_YIELD_APY_PCT : input.yieldApyPct;
  if (
    typeof yieldApyPct !== 'number' ||
    !Number.isFinite(yieldApyPct) ||
    yieldApyPct < 0 ||
    yieldApyPct > 100
  ) {
    throw new Error('yieldApyPct must be a finite number between 0 and 100.');
  }

  const yieldHorizonDays =
    input.yieldHorizonDays === undefined
      ? DEFAULT_YIELD_FUNDED_HORIZON_DAYS
      : input.yieldHorizonDays;
  if (
    typeof yieldHorizonDays !== 'number' ||
    !Number.isFinite(yieldHorizonDays) ||
    yieldHorizonDays < 1 ||
    yieldHorizonDays > 365
  ) {
    throw new Error('yieldHorizonDays must be a finite number between 1 and 365.');
  }

  const normalizedBalance = roundTo(availableUsdc, 2);

  if (mode === 'yield_funded') {
    // 100% principal preserved untouched; Degen budget strictly floored to projected yield
    const preservedUsdc = normalizedBalance;
    const projectedAnnualYieldUsd = roundTo(preservedUsdc * (yieldApyPct / 100), 2);
    const projected30dYieldUsd =
      Math.floor(preservedUsdc * (yieldApyPct / 100) * (yieldHorizonDays / 365) * 100 + 1e-9) / 100;
    const maxDegenBudgetUsd = projected30dYieldUsd;
    const effectiveRiskPct =
      normalizedBalance > 0 ? roundTo((maxDegenBudgetUsd / normalizedBalance) * 100, 2) : 0;

    return {
      mode: 'yield_funded',
      availableUsdc: normalizedBalance,
      requestedRiskPct: 0,
      effectiveRiskPct,
      wasClamped: false,
      maxRiskPct: MAX_DEGEN_RISK_PCT,
      preservedPct: 100,
      preservedUsdc,
      maxDegenBudgetUsd,
      yieldApyPct: roundTo(yieldApyPct, 2),
      yieldHorizonDays: Math.round(yieldHorizonDays),
      projectedAnnualYieldUsd,
      projected30dYieldUsd,
      highRiskWarning: null,
      presetsPct: DEGEN_RISK_PRESETS_PCT,
    };
  }

  const requestedRiskPct = input.riskPct === undefined ? DEFAULT_DEGEN_RISK_PCT : input.riskPct;
  if (
    typeof requestedRiskPct !== 'number' ||
    !Number.isFinite(requestedRiskPct) ||
    requestedRiskPct < 0
  ) {
    throw new Error('riskPct must be a finite non-negative number.');
  }

  const wasClamped = requestedRiskPct > MAX_DEGEN_RISK_PCT;
  const effectiveRiskPct = roundTo(Math.min(MAX_DEGEN_RISK_PCT, Math.max(0, requestedRiskPct)), 2);

  // Floor to cents so the usable Degen cap never exceeds the requested percentage
  const maxDegenBudgetUsd = Math.floor(normalizedBalance * (effectiveRiskPct / 100) * 100 + 1e-9) / 100;
  const preservedUsdc = roundTo(Math.max(0, normalizedBalance - maxDegenBudgetUsd), 2);
  const preservedPct = roundTo(100 - effectiveRiskPct, 2);
  const projectedAnnualYieldUsd = roundTo(preservedUsdc * (yieldApyPct / 100), 2);
  const projected30dYieldUsd = roundTo(
    preservedUsdc * (yieldApyPct / 100) * (yieldHorizonDays / 365),
    2
  );

  let highRiskWarning: string | null = null;
  if (wasClamped) {
    highRiskWarning =
      `Requested ${roundTo(requestedRiskPct, 1)}% exceeds Siphon's 50% preservation hard cap and was clamped to 50%. ` +
      'Binary prediction contracts can settle to $0 — keep at least half of your migrated USDC preserved.';
  } else if (effectiveRiskPct > HIGH_RISK_WARNING_THRESHOLD_PCT) {
    highRiskWarning =
      `High-risk side-pocket (${effectiveRiskPct}%): binary prediction markets can expire worthless ($0). ` +
      'Siphon recommends keeping 75%–95% of your Solana USDC preserved.';
  }

  return {
    mode: 'percent',
    availableUsdc: normalizedBalance,
    requestedRiskPct: roundTo(requestedRiskPct, 2),
    effectiveRiskPct,
    wasClamped,
    maxRiskPct: MAX_DEGEN_RISK_PCT,
    preservedPct,
    preservedUsdc,
    maxDegenBudgetUsd,
    yieldApyPct: roundTo(yieldApyPct, 2),
    yieldHorizonDays: Math.round(yieldHorizonDays),
    projectedAnnualYieldUsd,
    projected30dYieldUsd,
    highRiskWarning,
    presetsPct: DEGEN_RISK_PRESETS_PCT,
  };
}

function normalizeIsoCloseTime(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n > 0) {
        const ms = n > 1e12 ? n : n * 1000;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      }
    }
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function normalizeJupiterMarket(raw: RawJupiterMarket): NormalizedDegenMarket | null {
  if (!raw || typeof raw !== 'object') return null;
  const marketId = typeof raw.marketId === 'string' ? raw.marketId.trim() : '';
  if (!marketId || !SAFE_MARKET_ID_RE.test(marketId)) return null;

  const pricing = raw.pricing ?? null;
  const buyYes = parseMicroUsd(pricing?.buyYesPriceUsd);
  const sellYes = parseMicroUsd(pricing?.sellYesPriceUsd);
  const buyNo = parseMicroUsd(pricing?.buyNoPriceUsd);
  const sellNo = parseMicroUsd(pricing?.sellNoPriceUsd);

  const yes = buildSidePricingQuote(buyYes, sellYes);
  const no = buildSidePricingQuote(buyNo, sellNo);

  const rawVol = pricing?.volume;
  const volNum =
    typeof rawVol === 'number'
      ? rawVol
      : typeof rawVol === 'string'
        ? Number(rawVol.trim())
        : 0;
  const volumeUsd = Number.isFinite(volNum) && volNum >= 0 ? roundTo(volNum, 2) : 0;

  const outcomes = Array.isArray(raw.outcomes)
    ? raw.outcomes
        .map((o) => sanitizeDegenText(o, 40))
        .filter(Boolean)
        .slice(0, 6)
    : ['Yes', 'No'];

  return {
    marketId,
    provider: sanitizeDegenText(raw.provider, 32, 'jupiter'),
    status: sanitizeDegenText(raw.status, 24, 'open').toLowerCase(),
    title: sanitizeDegenText(raw.title, 120, 'Outcome'),
    closeTime: normalizeIsoCloseTime(raw.closeTime),
    volumeUsd,
    outcomes: outcomes.length ? outcomes : ['Yes', 'No'],
    sportsMarketType: raw.sportsMarketType ? sanitizeDegenText(raw.sportsMarketType, 40) || null : null,
    comboStatus: raw.comboStatus ? sanitizeDegenText(raw.comboStatus, 24) || null : null,
    yes,
    no,
  };
}

export function normalizeJupiterEvent(raw: RawJupiterEvent): NormalizedDegenEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const eventId = typeof raw.eventId === 'string' ? raw.eventId.trim() : '';
  if (!eventId || !SAFE_MARKET_ID_RE.test(eventId)) return null;

  const meta = raw.metadata ?? {};
  const slug = sanitizeJupiterSlug(meta.slug);
  const jupiterUrl = buildJupiterEventUrl(slug);
  const title = sanitizeDegenText(meta.title, 160, 'Prediction Event');
  const subtitle = sanitizeDegenText(meta.subtitle, 180, '');
  const imageUrl = sanitizeHttpsUrl(meta.imageUrl);
  const category = sanitizeDegenText(raw.category, 32, 'general').toLowerCase();
  const subcategory = sanitizeDegenText(raw.subcategory, 32, '').toLowerCase();
  const series = sanitizeDegenText(meta.series, 40, '');

  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .map((t) => sanitizeDegenText(t, 28).toLowerCase())
        .filter(Boolean)
        .slice(0, 8)
    : [];

  const volumeUsd = roundTo(parseMicroUsd(raw.volumeUsd) ?? 0, 2);
  const volume24hrUsd = roundTo(parseMicroUsd(raw.volume24hr) ?? 0, 2);

  const normalizedMarkets = (Array.isArray(raw.markets) ? raw.markets : [])
    .map(normalizeJupiterMarket)
    .filter((m): m is NormalizedDegenMarket => m !== null);

  // Prioritize open markets with valid YES/NO pricing while preserving Jupiter's curated leading-outcome order
  normalizedMarkets.sort((a, b) => {
    const aOpen = a.status === 'open' ? 1 : 0;
    const bOpen = b.status === 'open' ? 1 : 0;
    if (aOpen !== bOpen) return bOpen - aOpen;
    const aPriced = a.yes || a.no ? 1 : 0;
    const bPriced = b.yes || b.no ? 1 : 0;
    if (aPriced !== bPriced) return bPriced - aPriced;
    return 0;
  });

  return {
    eventId,
    slug,
    jupiterUrl,
    title,
    subtitle,
    imageUrl,
    category,
    subcategory,
    series,
    tags,
    isActive: Boolean(raw.isActive ?? true),
    isLive: Boolean(raw.isLive ?? false),
    closeTime: normalizeIsoCloseTime(meta.closeTime),
    volumeUsd,
    volume24hrUsd,
    marketsCount: normalizedMarkets.length,
    markets: normalizedMarkets.slice(0, 8),
  };
}

export function normalizeJupiterPosition(
  raw: unknown,
  fallbackOwnerPubkey: string
): NormalizedDegenPosition | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const positionId = sanitizePositionId(obj.pubkey ?? obj.positionPubkey ?? obj.positionId ?? obj.id);
  if (!positionId) return null;

  const marketObj =
    obj.market && typeof obj.market === 'object' ? (obj.market as Record<string, unknown>) : null;
  const eventObj =
    obj.event && typeof obj.event === 'object' ? (obj.event as Record<string, unknown>) : null;
  const eventMeta =
    eventObj?.metadata && typeof eventObj.metadata === 'object'
      ? (eventObj.metadata as Record<string, unknown>)
      : obj.metadata && typeof obj.metadata === 'object'
        ? (obj.metadata as Record<string, unknown>)
        : null;

  const rawMarketId =
    typeof obj.marketId === 'string'
      ? obj.marketId.trim()
      : typeof marketObj?.marketId === 'string'
        ? marketObj.marketId.trim()
        : '';
  const marketId = rawMarketId && SAFE_MARKET_ID_RE.test(rawMarketId) ? rawMarketId : positionId;

  const rawEventId =
    typeof obj.eventId === 'string'
      ? obj.eventId.trim()
      : typeof eventObj?.eventId === 'string'
        ? eventObj.eventId.trim()
        : '';
  const eventId = rawEventId && SAFE_MARKET_ID_RE.test(rawEventId) ? rawEventId : null;

  const eventSlug = sanitizeJupiterSlug(
    obj.eventSlug ?? eventObj?.slug ?? eventMeta?.slug ?? marketObj?.eventSlug
  );
  const jupiterUrl = buildJupiterEventUrl(eventSlug);

  const eventTitle = sanitizeDegenText(
    obj.eventTitle ?? eventObj?.title ?? eventMeta?.title,
    160,
    'Jupiter Prediction Position'
  );
  const marketTitle = sanitizeDegenText(
    obj.marketTitle ?? marketObj?.title ?? obj.title,
    120,
    marketId
  );

  const side: BinarySide =
    obj.isYes === false || String(obj.side ?? '').toLowerCase() === 'no' ? 'no' : 'yes';

  const rawStatus = sanitizeDegenText(obj.status, 24, '').toLowerCase();
  const isSettledFlag = Boolean(obj.settled ?? obj.isSettled ?? obj.claimed ?? obj.isClaimed);
  const isClaimableFlag = Boolean(obj.claimable ?? obj.isClaimable ?? obj.canClaim);

  const rawAvgPrice = parseContractPriceUsd(
    obj.avgPriceUsd ?? obj.avgEntryPriceUsd ?? obj.entryPriceUsd ?? obj.priceUsd
  );
  const rawMarkPrice = parseContractPriceUsd(
    obj.markPriceUsd ??
      obj.currentPriceUsd ??
      (side === 'yes'
        ? (marketObj?.pricing as Record<string, unknown> | undefined)?.sellYesPriceUsd ??
          (marketObj?.pricing as Record<string, unknown> | undefined)?.buyYesPriceUsd
        : (marketObj?.pricing as Record<string, unknown> | undefined)?.sellNoPriceUsd ??
          (marketObj?.pricing as Record<string, unknown> | undefined)?.buyNoPriceUsd)
  );

  let shares =
    parseFiniteNonNegNumber(obj.contracts ?? obj.shares ?? obj.quantity ?? obj.size) ?? 0;
  let costBasisUsd =
    parseMicroUsd(obj.totalCostUsd ?? obj.costBasisUsd ?? obj.sizeUsd ?? obj.depositAmountUsd) ??
    null;

  const avgEntryPriceUsd = rawAvgPrice ?? (costBasisUsd !== null && shares > 0 ? roundTo(Math.min(1, costBasisUsd / shares), 6) : 0);
  if (shares <= 0 && costBasisUsd !== null && avgEntryPriceUsd > 0) {
    shares = costBasisUsd / avgEntryPriceUsd;
  }
  if (costBasisUsd === null) {
    costBasisUsd = shares * avgEntryPriceUsd;
  }
  shares = roundTo(shares, 4);
  costBasisUsd = roundTo(costBasisUsd, 2);

  let status: DegenPositionStatus = 'open';
  if (isClaimableFlag || rawStatus === 'claimable' || rawStatus === 'won') {
    status = 'claimable';
  } else if (isSettledFlag || rawStatus === 'settled' || rawStatus === 'claimed') {
    status = 'settled';
  } else if (rawStatus === 'closed' || rawStatus === 'lost' || rawStatus === 'expired') {
    status = 'closed';
  }

  const claimable = status === 'claimable';
  const markPriceUsd =
    rawMarkPrice !== null
      ? rawMarkPrice
      : claimable
        ? 1
        : status === 'closed'
          ? 0
          : avgEntryPriceUsd;

  const explicitCurrentVal = parseMicroUsd(obj.currentValueUsd ?? obj.valueUsd ?? obj.markValueUsd);
  const claimablePayoutUsd = claimable
    ? roundTo(parseMicroUsd(obj.claimablePayoutUsd ?? obj.payoutUsd) ?? shares, 2)
    : 0;
  const settledPayoutUsd =
    status === 'settled'
      ? roundTo(
          parseMicroUsd(obj.settledPayoutUsd ?? obj.claimedPayoutUsd ?? obj.payoutUsd) ?? 0,
          2
        )
      : 0;

  const currentValueUsd =
    explicitCurrentVal !== null
      ? roundTo(explicitCurrentVal, 2)
      : claimable
        ? claimablePayoutUsd
        : status === 'settled'
          ? settledPayoutUsd
          : roundTo(shares * markPriceUsd, 2);

  const explicitPnl = parseSignedMicroUsd(obj.unrealizedPnlUsd ?? obj.pnlUsd);
  const unrealizedPnlUsd =
    explicitPnl !== null
      ? roundTo(explicitPnl, 2)
      : roundTo(currentValueUsd - costBasisUsd, 2);
  const unrealizedPnlPct =
    costBasisUsd > 0 ? roundTo((unrealizedPnlUsd / costBasisUsd) * 100, 2) : 0;

  const ownerCandidate = typeof obj.ownerPubkey === 'string' ? obj.ownerPubkey.trim() : '';
  const ownerPubkey = ownerCandidate || fallbackOwnerPubkey;

  return {
    positionId,
    ownerPubkey,
    marketId,
    eventId,
    eventSlug,
    eventTitle,
    marketTitle,
    jupiterUrl,
    side,
    status,
    shares,
    avgEntryPriceUsd: roundTo(avgEntryPriceUsd, 6),
    markPriceUsd: roundTo(markPriceUsd, 6),
    costBasisUsd,
    currentValueUsd,
    unrealizedPnlUsd,
    unrealizedPnlPct,
    claimable,
    claimablePayoutUsd,
    settledPayoutUsd,
    canCloseEarly: status === 'open' && !claimable && shares > 0,
    updatedAt: normalizeIsoCloseTime(obj.updatedAt ?? obj.createdAt),
  };
}

export function summarizeDegenPositions(positions: NormalizedDegenPosition[]): DegenPositionsSummary {
  let openCount = 0;
  let claimableCount = 0;
  let settledCount = 0;
  let totalCostBasisUsd = 0;
  let totalCurrentValueUsd = 0;
  let totalUnrealizedPnlUsd = 0;
  let totalClaimablePayoutUsd = 0;
  let totalSettledPayoutUsd = 0;

  for (const pos of positions) {
    if (pos.status === 'open') openCount += 1;
    if (pos.claimable || pos.status === 'claimable') {
      claimableCount += 1;
      totalClaimablePayoutUsd += pos.claimablePayoutUsd;
    }
    if (pos.status === 'settled') {
      settledCount += 1;
      totalSettledPayoutUsd += pos.settledPayoutUsd;
    }
    if (pos.status === 'open' || pos.claimable) {
      totalCostBasisUsd += pos.costBasisUsd;
      totalCurrentValueUsd += pos.currentValueUsd;
      totalUnrealizedPnlUsd += pos.unrealizedPnlUsd;
    }
  }

  return {
    openCount,
    claimableCount,
    settledCount,
    totalCostBasisUsd: roundTo(totalCostBasisUsd, 2),
    totalCurrentValueUsd: roundTo(totalCurrentValueUsd, 2),
    totalUnrealizedPnlUsd: roundTo(totalUnrealizedPnlUsd, 2),
    totalClaimablePayoutUsd: roundTo(totalClaimablePayoutUsd, 2),
    totalSettledPayoutUsd: roundTo(totalSettledPayoutUsd, 2),
  };
}

export function normalizeJupiterCategoryAndFilter(rawCategory?: string | null, rawFilter?: string | null): {
  category: JupiterCategory;
  filter: JupiterFilter;
} {
  const catLower = typeof rawCategory === 'string' ? rawCategory.trim().toLowerCase() : '';
  const filterLower = typeof rawFilter === 'string' ? rawFilter.trim().toLowerCase() : '';

  // Support ergonomic calls like ?category=trending or ?category=live
  if (!filterLower && FILTER_SET.has(catLower)) {
    return {
      category: 'all',
      filter: catLower as JupiterFilter,
    };
  }

  const category: JupiterCategory = CATEGORY_SET.has(catLower)
    ? (catLower as JupiterCategory)
    : 'all';
  const filter: JupiterFilter = FILTER_SET.has(filterLower)
    ? (filterLower as JupiterFilter)
    : 'trending';

  return { category, filter };
}

interface CachedMarketSnapshot {
  eventSlug: string | null;
  eventTitle: string;
  market: NormalizedDegenMarket;
}

export class JupiterMarketsClient {
  private readonly apiBaseUrl: string;
  private readonly apiKey: string | null;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nowMs: () => number;
  private readonly feedCache: BoundedTtlCache<string, Omit<JupiterFeedResult, 'cached'>>;
  private readonly marketIndex: BoundedTtlCache<string, CachedMarketSnapshot>;

  constructor(opts: JupiterMarketsClientOptions = {}) {
    this.apiBaseUrl = (opts.apiBaseUrl ?? JUPITER_PREDICTION_API_BASE).replace(/\/+$/, '');
    this.apiKey =
      opts.apiKey !== undefined
        ? opts.apiKey?.trim() || null
        : process.env.JUPITER_API_KEY?.trim() || null;
    this.timeoutMs = Math.max(500, Math.floor(opts.timeoutMs ?? DEFAULT_JUPITER_TIMEOUT_MS));
    this.cacheTtlMs = Math.max(1_000, Math.floor(opts.cacheTtlMs ?? DEFAULT_JUPITER_CACHE_TTL_MS));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.feedCache = new BoundedTtlCache({
      maxEntries: opts.cacheMaxEntries ?? DEFAULT_JUPITER_CACHE_MAX_ENTRIES,
      ttlMs: this.cacheTtlMs,
      nowMs: this.nowMs,
    });
    this.marketIndex = new BoundedTtlCache({
      maxEntries: 512,
      ttlMs: Math.max(this.cacheTtlMs * 4, 120_000),
      nowMs: this.nowMs,
    });
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  clearCache(): void {
    this.feedCache.clear();
    this.marketIndex.clear();
  }

  private buildHeaders(includeJsonContentType = false): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (includeJsonContentType) {
      headers['Content-Type'] = 'application/json';
    }
    if (this.apiKey) {
      headers['x-api-key'] = this.apiKey;
    }
    return headers;
  }

  private async fetchJsonWithTimeout(
    url: string,
    init: RequestInit = {}
  ): Promise<
    | { ok: true; data: unknown }
    | { ok: false; status?: number; geoBlocked?: boolean; apiKeyRequired?: boolean; error: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const resp = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      if (!resp.ok) {
        let upstreamDetail = '';
        try {
          const text = await resp.text();
          if (text) {
            try {
              const parsed = JSON.parse(text) as Record<string, unknown>;
              upstreamDetail = sanitizeDegenText(
                parsed.message ?? parsed.error ?? parsed.code ?? '',
                160
              );
            } catch {
              upstreamDetail = sanitizeDegenText(text, 160);
            }
          }
        } catch {
          // ignore body read error
        }

        const geoBlocked =
          resp.status === 451 ||
          (resp.status === 403 && GEO_BLOCK_TEXT_RE.test(upstreamDetail));
        const apiKeyRequired =
          resp.status === 401 ||
          (resp.status === 403 && !geoBlocked && /api.?key|unauthorized/i.test(upstreamDetail));

        let error = `Jupiter Prediction API returned HTTP ${resp.status}.`;
        if (geoBlocked) {
          error =
            'Jupiter Prediction API is geo-restricted in this region (HTTP ' +
            `${resp.status}). Use "Open on Jupiter ↗" from an eligible jurisdiction.`;
        } else if (apiKeyRequired) {
          error =
            `Jupiter Prediction API rejected API key (HTTP ${resp.status}). ` +
            'Verify JUPITER_API_KEY or use "Open on Jupiter ↗".';
        } else if (upstreamDetail) {
          error = `Jupiter Prediction API returned HTTP ${resp.status}: ${upstreamDetail}`;
        }

        return {
          ok: false,
          status: resp.status,
          geoBlocked,
          apiKeyRequired,
          error,
        };
      }
      const data = (await resp.json()) as unknown;
      return { ok: true, data };
    } catch (err) {
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || err.message.toLowerCase().includes('abort'));
      return {
        ok: false,
        error: isAbort
          ? `Jupiter Prediction API timed out after ${this.timeoutMs}ms.`
          : `Jupiter Prediction API unavailable: ${err instanceof Error ? err.message : 'network error'}.`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private indexEvents(events: NormalizedDegenEvent[]): void {
    for (const ev of events) {
      for (const m of ev.markets) {
        this.marketIndex.set(m.marketId, {
          eventSlug: ev.slug,
          eventTitle: ev.title,
          market: m,
        });
      }
    }
  }

  async fetchEvents(params: {
    category?: string | null;
    filter?: string | null;
    limit?: number;
    start?: number;
  } = {}): Promise<JupiterFeedResult> {
    const { category, filter } = normalizeJupiterCategoryAndFilter(params.category, params.filter);
    const limit = Math.min(36, Math.max(1, Math.floor(Number(params.limit ?? 18) || 18)));
    const start = Math.max(0, Math.floor(Number(params.start ?? 0) || 0));
    const end = start + limit;
    const cacheKey = `events:${category}:${filter}:${start}:${end}`;

    const cached = this.feedCache.get(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    const qs = new URLSearchParams({
      filter,
      includeMarkets: 'true',
      start: String(start),
      end: String(end),
    });
    if (category !== 'all') {
      qs.set('category', category);
    }

    const url = `${this.apiBaseUrl}/events?${qs.toString()}`;
    const fetchedAt = new Date(this.nowMs()).toISOString();
    const res = await this.fetchJsonWithTimeout(url, {
      method: 'GET',
      headers: this.buildHeaders(false),
    });

    if (!res.ok) {
      return {
        ok: false,
        live: false,
        source: 'jupiter-prediction-v1',
        fetchedAt,
        cached: false,
        cacheTtlMs: this.cacheTtlMs,
        category,
        filter,
        events: [],
        totalReturned: 0,
        gameModes: JUPITER_GAME_MODES,
        apiKeyConfigured: this.hasApiKey(),
        geoBlocked: Boolean(res.geoBlocked),
        error: res.error,
      };
    }

    const rawList =
      res.data && typeof res.data === 'object' && Array.isArray((res.data as { data?: unknown }).data)
        ? ((res.data as { data: RawJupiterEvent[] }).data)
        : [];
    const events = rawList
      .map(normalizeJupiterEvent)
      .filter((e): e is NormalizedDegenEvent => e !== null)
      .slice(0, limit);

    this.indexEvents(events);

    const payload: Omit<JupiterFeedResult, 'cached'> = {
      ok: true,
      live: true,
      source: 'jupiter-prediction-v1',
      fetchedAt,
      cacheTtlMs: this.cacheTtlMs,
      category,
      filter,
      events,
      totalReturned: events.length,
      gameModes: JUPITER_GAME_MODES,
      apiKeyConfigured: this.hasApiKey(),
    };
    this.feedCache.set(cacheKey, payload);
    return { ...payload, cached: false };
  }

  async searchEvents(params: { query: string; limit?: number }): Promise<JupiterFeedResult> {
    const cleanQuery = sanitizeDegenText(params.query, 120);
    if (!cleanQuery) {
      throw new Error('Search query q is required.');
    }
    const limit = Math.min(36, Math.max(1, Math.floor(Number(params.limit ?? 18) || 18)));
    const cacheKey = `search:${cleanQuery.toLowerCase()}:${limit}`;

    const cached = this.feedCache.get(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    const qs = new URLSearchParams({
      query: cleanQuery,
      includeMarkets: 'true',
    });
    const url = `${this.apiBaseUrl}/events/search?${qs.toString()}`;
    const fetchedAt = new Date(this.nowMs()).toISOString();
    const res = await this.fetchJsonWithTimeout(url, {
      method: 'GET',
      headers: this.buildHeaders(false),
    });

    if (!res.ok) {
      return {
        ok: false,
        live: false,
        source: 'jupiter-prediction-v1',
        fetchedAt,
        cached: false,
        cacheTtlMs: this.cacheTtlMs,
        category: 'all',
        filter: 'trending',
        query: cleanQuery,
        events: [],
        totalReturned: 0,
        gameModes: JUPITER_GAME_MODES,
        apiKeyConfigured: this.hasApiKey(),
        geoBlocked: Boolean(res.geoBlocked),
        error: res.error,
      };
    }

    const rawList =
      res.data && typeof res.data === 'object' && Array.isArray((res.data as { data?: unknown }).data)
        ? ((res.data as { data: RawJupiterEvent[] }).data)
        : [];
    const events = rawList
      .map(normalizeJupiterEvent)
      .filter((e): e is NormalizedDegenEvent => e !== null)
      .slice(0, limit);

    this.indexEvents(events);

    const payload: Omit<JupiterFeedResult, 'cached'> = {
      ok: true,
      live: true,
      source: 'jupiter-prediction-v1',
      fetchedAt,
      cacheTtlMs: this.cacheTtlMs,
      category: 'all',
      filter: 'trending',
      query: cleanQuery,
      events,
      totalReturned: events.length,
      gameModes: JUPITER_GAME_MODES,
      apiKeyConfigured: this.hasApiKey(),
    };
    this.feedCache.set(cacheKey, payload);
    return { ...payload, cached: false };
  }

  async buildOrderPreview(input: DegenOrderPreviewInput): Promise<DegenOrderPreviewResult> {
    if (!input || typeof input !== 'object') {
      throw new Error('Order preview payload is required.');
    }
    const marketId = typeof input.marketId === 'string' ? input.marketId.trim() : '';
    if (!marketId || !SAFE_MARKET_ID_RE.test(marketId)) {
      throw new Error('Valid marketId is required.');
    }
    if (input.side !== 'yes' && input.side !== 'no') {
      throw new Error("side must be 'yes' or 'no'.");
    }
    if (typeof input.stakeUsd !== 'number' || !Number.isFinite(input.stakeUsd) || input.stakeUsd <= 0) {
      throw new Error('stakeUsd must be a finite positive number.');
    }
    if (input.stakeUsd < MIN_JUPITER_ORDER_USD - 1e-9) {
      throw new Error(
        `Jupiter Prediction enforces a $${MIN_JUPITER_ORDER_USD.toFixed(2)} minimum order size (requested $${roundTo(input.stakeUsd, 2).toFixed(2)}).`
      );
    }

    const sidePocket = computeDegenSidePocket({
      availableUsdc: input.availableUsdc,
      riskPct: input.riskPct,
      mode: input.sidePocketMode,
      yieldApyPct: input.yieldApyPct,
    });

    if (sidePocket.maxDegenBudgetUsd <= 0) {
      throw new Error(
        sidePocket.mode === 'yield_funded'
          ? `Your Yield-Funded Degen budget is $0.00 (30d projected yield on $${sidePocket.preservedUsdc.toFixed(2)} USDC at ${sidePocket.yieldApyPct}% APY). Add Solana USDC or choose the 90/10 split.`
          : `Your capped Degen side-pocket budget is $0.00 (${sidePocket.effectiveRiskPct}% of $${sidePocket.availableUsdc.toFixed(2)} USDC). Add available Solana USDC or select a non-zero side-pocket cap.`
      );
    }
    if (input.stakeUsd > sidePocket.maxDegenBudgetUsd + 1e-9) {
      throw new Error(
        sidePocket.mode === 'yield_funded'
          ? `Stake $${roundTo(input.stakeUsd, 2).toFixed(2)} exceeds your Yield-Funded Degen cap of $${sidePocket.maxDegenBudgetUsd.toFixed(2)} (30d projected yield at ${sidePocket.yieldApyPct}% APY; 100% of your $${sidePocket.preservedUsdc.toFixed(2)} principal remains untouched).`
          : `Stake $${roundTo(input.stakeUsd, 2).toFixed(2)} exceeds your preservation-capped Degen side-pocket budget of $${sidePocket.maxDegenBudgetUsd.toFixed(2)} (${sidePocket.effectiveRiskPct}% of $${sidePocket.availableUsdc.toFixed(2)} USDC; $${sidePocket.preservedUsdc.toFixed(2)} remains preserved safe).`
      );
    }

    const indexed = this.marketIndex.get(marketId);
    const cachedPrice =
      input.side === 'yes' ? indexed?.market.yes?.priceUsd : indexed?.market.no?.priceUsd;
    const effectivePrice =
      input.priceUsd !== undefined ? input.priceUsd : cachedPrice;

    if (
      typeof effectivePrice !== 'number' ||
      !Number.isFinite(effectivePrice) ||
      effectivePrice <= 0 ||
      effectivePrice > 1
    ) {
      throw new Error('Valid contract priceUsd in (0, 1] is required.');
    }

    const payout = computeProjectedPayout(input.stakeUsd, effectivePrice);
    const eventSlug = sanitizeJupiterSlug(input.eventSlug ?? indexed?.eventSlug);
    const jupiterUrl = buildJupiterEventUrl(eventSlug);
    const eventTitle = sanitizeDegenText(
      input.eventTitle ?? indexed?.eventTitle,
      160,
      'Jupiter Prediction Market'
    );
    const marketTitle = sanitizeDegenText(
      input.marketTitle ?? indexed?.market.title,
      120,
      marketId
    );
    const remainingSidePocketUsd = roundTo(
      Math.max(0, sidePocket.maxDegenBudgetUsd - payout.stakeUsd),
      2
    );

    let liveOrder: DegenLiveOrderResult = {
      attempted: false,
      available: false,
      depositMint: SOLANA_USDC_MINT,
      apiKeyRequired: !this.hasApiKey(),
      reason: this.hasApiKey()
        ? 'Direct Jupiter web launch ready. Connect a Solana wallet to sign & place inline.'
        : 'Direct Jupiter web launch ready. Set JUPITER_API_KEY and connect a Solana wallet for 1-click inline signing.',
    };

    const walletAddress = typeof input.walletAddress === 'string' ? input.walletAddress.trim() : '';
    if (input.requestLiveTx) {
      if (!this.hasApiKey()) {
        liveOrder = {
          attempted: false,
          available: false,
          depositMint: SOLANA_USDC_MINT,
          apiKeyRequired: true,
          reason: 'JUPITER_API_KEY is not configured on the server; use "Open on Jupiter ↗" instead.',
        };
      } else if (!walletAddress) {
        liveOrder = {
          attempted: false,
          available: false,
          depositMint: SOLANA_USDC_MINT,
          reason: 'Connect a valid Solana wallet address to build a signable Jupiter order transaction.',
        };
      } else {
        this.assertValidSolanaPubkey(walletAddress, 'walletAddress');

        const orderRes = await this.fetchJsonWithTimeout(`${this.apiBaseUrl}/orders`, {
          method: 'POST',
          headers: this.buildHeaders(true),
          body: JSON.stringify({
            ownerPubkey: walletAddress,
            marketId,
            depositMint: SOLANA_USDC_MINT,
            isYes: input.side === 'yes',
            isBuy: true,
            depositAmount: String(Math.round(payout.stakeUsd * MICRO_USD_SCALE)),
          }),
        });

        if (!orderRes.ok) {
          liveOrder = {
            attempted: true,
            available: false,
            depositMint: SOLANA_USDC_MINT,
            geoBlocked: Boolean(orderRes.geoBlocked),
            apiKeyRequired: Boolean(orderRes.apiKeyRequired),
            statusCode: orderRes.status,
            reason: orderRes.error,
          };
        } else {
          const obj =
            orderRes.data && typeof orderRes.data === 'object'
              ? (orderRes.data as Record<string, unknown>)
              : {};
          const tx =
            typeof obj.transaction === 'string'
              ? obj.transaction
              : typeof obj.tx === 'string'
                ? obj.tx
                : null;
          liveOrder = {
            attempted: true,
            available: Boolean(tx),
            depositMint: SOLANA_USDC_MINT,
            orderId: typeof obj.orderId === 'string' ? sanitizeDegenText(obj.orderId, 80) : null,
            transactionBase64: tx,
            expiresAt: normalizeIsoCloseTime(obj.expiresAt),
            reason: tx
              ? undefined
              : 'Jupiter order endpoint responded without a signable transaction; trade directly on Jupiter.',
          };
        }
      }
    }

    return {
      ok: true,
      marketId,
      eventSlug,
      eventTitle,
      marketTitle,
      side: input.side,
      jupiterUrl,
      sidePocket,
      payout,
      remainingSidePocketUsd,
      riskNotice:
        'Non-custodial preview only. Binary outcome contracts settle to $1.00 if right or $0.00 if wrong. Principal outside your side-pocket stays preserved in Solana USDC.',
      liveOrder,
    };
  }

  private assertValidSolanaPubkey(pubkey: string, fieldName: string): string {
    const clean = typeof pubkey === 'string' ? pubkey.trim() : '';
    if (!clean) {
      throw new Error(`Valid Solana ${fieldName} is required.`);
    }
    try {
      solanaAddressToBytes32(clean);
    } catch {
      throw new Error(`Invalid Solana ${fieldName} (expected base58 public key).`);
    }
    return clean;
  }

  async fetchPositions(ownerPubkey: string): Promise<JupiterPositionsResult> {
    const cleanOwner = this.assertValidSolanaPubkey(ownerPubkey, 'owner');
    const fetchedAt = new Date(this.nowMs()).toISOString();
    const qs = new URLSearchParams({ ownerPubkey: cleanOwner });
    const url = `${this.apiBaseUrl}/positions?${qs.toString()}`;

    const res = await this.fetchJsonWithTimeout(url, {
      method: 'GET',
      headers: this.buildHeaders(false),
    });

    if (!res.ok) {
      return {
        ok: false,
        live: false,
        ownerPubkey: cleanOwner,
        fetchedAt,
        positions: [],
        summary: summarizeDegenPositions([]),
        apiKeyConfigured: this.hasApiKey(),
        geoBlocked: Boolean(res.geoBlocked),
        error: res.error,
      };
    }

    const rawList = Array.isArray(res.data)
      ? res.data
      : res.data && typeof res.data === 'object' && Array.isArray((res.data as { data?: unknown }).data)
        ? (res.data as { data: unknown[] }).data
        : res.data && typeof res.data === 'object' && Array.isArray((res.data as { positions?: unknown }).positions)
          ? (res.data as { positions: unknown[] }).positions
          : [];

    const positions = rawList
      .map((item) => normalizeJupiterPosition(item, cleanOwner))
      .filter((p): p is NormalizedDegenPosition => p !== null);

    // Prioritize claimable winning payouts first, then open active positions, then settled/closed
    const statusOrder: Record<DegenPositionStatus, number> = {
      claimable: 0,
      open: 1,
      settled: 2,
      closed: 3,
    };
    positions.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    return {
      ok: true,
      live: true,
      ownerPubkey: cleanOwner,
      fetchedAt,
      positions,
      summary: summarizeDegenPositions(positions),
      apiKeyConfigured: this.hasApiKey(),
    };
  }

  async claimPosition(
    rawPositionId: string,
    ownerPubkey?: string | null
  ): Promise<DegenPositionActionResult> {
    const positionId = sanitizePositionId(rawPositionId);
    if (!positionId) {
      throw new Error('Invalid positionId.');
    }
    const cleanOwner = ownerPubkey ? this.assertValidSolanaPubkey(ownerPubkey, 'ownerPubkey') : null;
    const fallbackUrl = `${JUPITER_PREDICTION_WEB_BASE}/portfolio`;

    if (!this.hasApiKey()) {
      return {
        ok: true,
        action: 'claim',
        positionId,
        available: false,
        transactionBase64: null,
        jupiterUrl: fallbackUrl,
        apiKeyConfigured: false,
        apiKeyRequired: true,
        reason:
          'JUPITER_API_KEY is not configured on the server; claim your $1.00 winning payout directly on Jupiter.',
      };
    }

    const res = await this.fetchJsonWithTimeout(
      `${this.apiBaseUrl}/positions/${encodeURIComponent(positionId)}/claim`,
      {
        method: 'POST',
        headers: this.buildHeaders(true),
        body: JSON.stringify(cleanOwner ? { ownerPubkey: cleanOwner } : {}),
      }
    );

    if (!res.ok) {
      return {
        ok: false,
        action: 'claim',
        positionId,
        available: false,
        transactionBase64: null,
        jupiterUrl: fallbackUrl,
        apiKeyConfigured: true,
        geoBlocked: Boolean(res.geoBlocked),
        apiKeyRequired: Boolean(res.apiKeyRequired),
        statusCode: res.status,
        reason: res.error,
      };
    }

    const obj =
      res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : {};
    const tx =
      typeof obj.transaction === 'string'
        ? obj.transaction
        : typeof obj.tx === 'string'
          ? obj.tx
          : null;

    return {
      ok: true,
      action: 'claim',
      positionId,
      available: Boolean(tx),
      transactionBase64: tx,
      orderId: typeof obj.orderId === 'string' ? sanitizeDegenText(obj.orderId, 80) : null,
      expiresAt: normalizeIsoCloseTime(obj.expiresAt),
      jupiterUrl: fallbackUrl,
      apiKeyConfigured: true,
      reason: tx
        ? undefined
        : 'Jupiter claim endpoint returned no signable transaction; claim directly on Jupiter.',
    };
  }

  async closePosition(
    rawPositionId: string,
    ownerPubkey?: string | null
  ): Promise<DegenPositionActionResult> {
    const positionId = sanitizePositionId(rawPositionId);
    if (!positionId) {
      throw new Error('Invalid positionId.');
    }
    const cleanOwner = ownerPubkey ? this.assertValidSolanaPubkey(ownerPubkey, 'ownerPubkey') : null;
    const fallbackUrl = `${JUPITER_PREDICTION_WEB_BASE}/portfolio`;

    if (!this.hasApiKey()) {
      return {
        ok: true,
        action: 'close',
        positionId,
        available: false,
        transactionBase64: null,
        jupiterUrl: fallbackUrl,
        apiKeyConfigured: false,
        apiKeyRequired: true,
        reason:
          'JUPITER_API_KEY is not configured on the server; close or sell your position directly on Jupiter.',
      };
    }

    const res = await this.fetchJsonWithTimeout(
      `${this.apiBaseUrl}/positions/${encodeURIComponent(positionId)}`,
      {
        method: 'DELETE',
        headers: this.buildHeaders(true),
        body: JSON.stringify(cleanOwner ? { ownerPubkey: cleanOwner } : {}),
      }
    );

    if (!res.ok) {
      return {
        ok: false,
        action: 'close',
        positionId,
        available: false,
        transactionBase64: null,
        jupiterUrl: fallbackUrl,
        apiKeyConfigured: true,
        geoBlocked: Boolean(res.geoBlocked),
        apiKeyRequired: Boolean(res.apiKeyRequired),
        statusCode: res.status,
        reason: res.error,
      };
    }

    const obj =
      res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : {};
    const tx =
      typeof obj.transaction === 'string'
        ? obj.transaction
        : typeof obj.tx === 'string'
          ? obj.tx
          : null;

    return {
      ok: true,
      action: 'close',
      positionId,
      available: Boolean(tx),
      transactionBase64: tx,
      orderId: typeof obj.orderId === 'string' ? sanitizeDegenText(obj.orderId, 80) : null,
      expiresAt: normalizeIsoCloseTime(obj.expiresAt),
      jupiterUrl: fallbackUrl,
      apiKeyConfigured: true,
      reason: tx
        ? undefined
        : 'Jupiter close endpoint returned no signable transaction; exit directly on Jupiter.',
    };
  }
}
