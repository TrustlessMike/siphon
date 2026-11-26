import type { ScannedAsset, ScanReport } from '../scanner/types.js';

export type TaxExportFormat = 'koinly' | 'cointracker' | 'awaken';

export type TaxSweepEventKind =
  | 'defi_withdraw'
  | 'swap'
  | 'bridge'
  | 'burn_loss_harvest'
  | 'reclaim_rent'
  | 'transfer';

export const VALID_TAX_EXPORT_FORMATS = new Set<TaxExportFormat>(['koinly', 'cointracker', 'awaken']);
export const MAX_TAX_EXPORT_EVENTS = 1_000;
const MAX_FIELD_LEN = 320;

export interface TaxSweepEvent {
  /** ISO-8601 string or Unix epoch milliseconds (defaults to current UTC timestamp if omitted) */
  timestamp?: string | number;
  kind: TaxSweepEventKind;
  chain?: string;
  protocol?: string;
  sentAmount?: number | string;
  sentCurrency?: string;
  sentFiatUsd?: number;
  receivedAmount?: number | string;
  receivedCurrency?: string;
  receivedFiatUsd?: number;
  feeAmount?: number | string;
  feeCurrency?: string;
  feeUsd?: number;
  /** Optional net worth / fair market value in USD for Koinly Net Worth column */
  netWorthUsd?: number;
  txHash?: string;
  description?: string;
  status?: 'completed' | 'planned';
}

export interface TaxCsvExportInput {
  format: TaxExportFormat;
  events?: TaxSweepEvent[];
  scan?: Pick<ScanReport, 'scannedAt' | 'assets'>;
  assets?: ScannedAsset[];
  outputAsset?: 'USDC' | 'SOL';
  /** Optional timestamp override for deterministic filenames / planned events */
  generatedAt?: string | number;
}

export interface TaxCsvExportSummary {
  totalEvents: number;
  defiWithdrawals: number;
  swaps: number;
  bridges: number;
  burnsHarvested: number;
  totalProceedsUsd: number;
  totalFeesUsd: number;
  estimatedTaxLossBurnUsd: number;
}

export interface TaxCsvExportResult {
  format: TaxExportFormat;
  filename: string;
  contentType: 'text/csv; charset=utf-8';
  rowCount: number;
  summary: TaxCsvExportSummary;
  csv: string;
}

const VALID_EVENT_KINDS = new Set<TaxSweepEventKind>([
  'defi_withdraw',
  'swap',
  'bridge',
  'burn_loss_harvest',
  'reclaim_rent',
  'transfer',
]);

/**
 * Neutralizes CSV spreadsheet formula injection (CWE-1236 / OWASP CSV Injection).
 * Any cell beginning with `=`, `+`, `-`, `@`, `\t`, or `\r` (or leading spaces before `=`, `+`, `-`, `@`)
 * is prefixed with a single quote `'` so Excel, Google Sheets, and LibreOffice treat it strictly as text.
 */
export function neutralizeCsvFormula(raw: string): string {
  if (!raw) return '';
  if (/^[=+\-@\t\r]/.test(raw) || /^[ ]+[=+\-@]/.test(raw)) {
    return `'${raw}`;
  }
  return raw;
}

/**
 * Neutralizes formula-injection payloads and encodes a cell per RFC 4180 CSV rules.
 */
export function escapeCsvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const raw = String(value);
  const safe = neutralizeCsvFormula(raw);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function encodeCsvRow(cells: Array<unknown>): string {
  return cells.map((cell) => escapeCsvCell(cell)).join(',');
}

function parseTimestampToDate(raw: string | number | undefined, fallbackDate: Date): Date {
  if (raw === undefined || raw === null || raw === '') return fallbackDate;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error('Invalid numeric timestamp in tax event.');
    }
    const ms = raw < 1e12 ? raw * 1000 : raw;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid numeric timestamp in tax event.');
    return d;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return fallbackDate;
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid ISO timestamp in tax event: "${trimmed.slice(0, 64)}".`);
    }
    return d;
  }
  throw new Error('timestamp must be an ISO string or Unix timestamp.');
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Koinly canonical UTC timestamp: `YYYY-MM-DD HH:mm:ss UTC` */
export function formatKoinlyDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours()
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

/** CoinTracker & Awaken canonical UTC timestamp: `MM/DD/YYYY HH:mm:ss` */
export function formatUsUtcDate(d: Date): string {
  return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${d.getUTCFullYear()} ${pad2(
    d.getUTCHours()
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function parseNonNegativeAmount(raw: number | string | undefined, fieldName: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${fieldName} must be a non-negative finite number.`);
  }
  return num;
}

function formatCryptoAmount(val: number | undefined): string {
  if (val === undefined || val === 0) return '';
  // Avoid scientific notation for small crypto balances while keeping clean precision
  const fixed = val >= 1 ? val.toFixed(8) : val.toFixed(12);
  return fixed.replace(/\.?0+$/, '');
}

function formatFiatUsd(val: number | undefined): string {
  if (val === undefined) return '';
  return val.toFixed(2);
}

function sanitizeText(raw: unknown, maxLen = MAX_FIELD_LEN): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new Error('Text fields in tax export events must be strings.');
  }
  // Preserve leading formula/tab/CR characters so neutralizeCsvFormula handles them explicitly
  // while stripping NUL bytes and bounding length.
  return raw.replace(/\u0000/g, '').slice(0, maxLen);
}

function sanitizeCurrencySymbol(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new Error('Currency symbols in tax export events must be strings.');
  }
  return raw.replace(/\u0000/g, '').slice(0, 48);
}

/**
 * Converts actionable Turgalium `ScannedAsset[]` (DeFi unwinds, swaps, direct USDC bridges,
 * and zero-liquidity burns for tax-loss harvesting) into normalized `TaxSweepEvent[]`.
 */
export function buildTaxEventsFromScannedAssets(params: {
  assets: ScannedAsset[];
  outputAsset?: 'USDC' | 'SOL';
  timestamp?: string | number;
}): TaxSweepEvent[] {
  const outAsset = params.outputAsset === 'SOL' ? 'SOL' : 'USDC';
  const out: TaxSweepEvent[] = [];

  for (const asset of params.assets) {
    if (!asset || typeof asset !== 'object') continue;
    const feeUsd = Number.isFinite(asset.batchedGasUsd) && asset.batchedGasUsd > 0 ? asset.batchedGasUsd : 0;
    const netUsd = Math.max(0, Number.isFinite(asset.netUsdcBatched) ? asset.netUsdcBatched : 0);
    const grossUsd = Math.max(0, Number.isFinite(asset.grossUsd) ? asset.grossUsd : 0);
    const sentAmt = Math.max(0, Number.isFinite(asset.uiBalance) ? asset.uiBalance : 0);

    if (asset.action === 'WITHDRAW_AND_BRIDGE') {
      out.push({
        timestamp: params.timestamp,
        kind: 'defi_withdraw',
        chain: asset.chain,
        protocol: asset.protocol || 'DeFi Protocol',
        sentAmount: sentAmt,
        sentCurrency: asset.symbol,
        sentFiatUsd: grossUsd,
        receivedAmount: outAsset === 'USDC' ? netUsd : undefined,
        receivedCurrency: outAsset === 'USDC' ? 'USDC' : asset.underlyingSymbol || outAsset,
        receivedFiatUsd: netUsd,
        feeAmount: feeUsd > 0 ? feeUsd : undefined,
        feeCurrency: feeUsd > 0 ? 'USD' : undefined,
        feeUsd,
        netWorthUsd: netUsd > 0 ? netUsd : grossUsd,
        description: `Planned DeFi unwind (${asset.protocol || 'DeFi'}) on ${asset.chainName || asset.chain} -> Solana ${outAsset}`,
        status: 'planned',
      });
    } else if (asset.action === 'SELL_AND_BRIDGE') {
      out.push({
        timestamp: params.timestamp,
        kind: 'swap',
        chain: asset.chain,
        sentAmount: sentAmt,
        sentCurrency: asset.symbol,
        sentFiatUsd: grossUsd,
        receivedAmount: outAsset === 'USDC' ? netUsd : undefined,
        receivedCurrency: outAsset,
        receivedFiatUsd: netUsd,
        feeAmount: feeUsd > 0 ? feeUsd : undefined,
        feeCurrency: feeUsd > 0 ? 'USD' : undefined,
        feeUsd,
        netWorthUsd: netUsd > 0 ? netUsd : grossUsd,
        description: `Planned swap & bridge on ${asset.chainName || asset.chain} -> Solana ${outAsset}`,
        status: 'planned',
      });
    } else if (asset.action === 'BRIDGE_DIRECT_USDC') {
      out.push({
        timestamp: params.timestamp,
        kind: 'bridge',
        chain: asset.chain,
        sentAmount: sentAmt,
        sentCurrency: asset.symbol || 'USDC',
        sentFiatUsd: grossUsd,
        receivedAmount: outAsset === 'USDC' ? netUsd : undefined,
        receivedCurrency: outAsset,
        receivedFiatUsd: netUsd,
        feeAmount: feeUsd > 0 ? feeUsd : undefined,
        feeCurrency: feeUsd > 0 ? 'USD' : undefined,
        feeUsd,
        netWorthUsd: netUsd > 0 ? netUsd : grossUsd,
        description: `Planned Circle CCTP / direct USDC bridge from ${asset.chainName || asset.chain} -> Solana ${outAsset}`,
        status: 'planned',
      });
    } else if (asset.action === 'BURN_ZERO_LIQUIDITY') {
      out.push({
        timestamp: params.timestamp,
        kind: 'burn_loss_harvest',
        chain: asset.chain,
        sentAmount: sentAmt,
        sentCurrency: asset.symbol,
        sentFiatUsd: 0,
        receivedAmount: 0,
        receivedCurrency: '',
        receivedFiatUsd: 0,
        feeAmount: feeUsd > 0 ? feeUsd : undefined,
        feeCurrency: feeUsd > 0 ? 'USD' : undefined,
        feeUsd,
        netWorthUsd: 0,
        description: `Zero-liquidity burn to 0x000...dEaD on ${asset.chainName || asset.chain} (realized tax-loss harvesting)`,
        status: 'planned',
      });
    }
  }

  return out;
}

function getKoinlyLabel(kind: TaxSweepEventKind): string {
  switch (kind) {
    case 'burn_loss_harvest':
      return 'lost';
    case 'defi_withdraw':
      return 'unstake';
    case 'swap':
      return 'swap';
    case 'bridge':
      return 'transfer';
    case 'reclaim_rent':
      return 'reward';
    case 'transfer':
      return 'transfer';
  }
}

function getCoinTrackerTag(kind: TaxSweepEventKind): string {
  switch (kind) {
    case 'burn_loss_harvest':
      return 'lost';
    case 'defi_withdraw':
      return 'unstake';
    case 'reclaim_rent':
      return 'reward';
    case 'swap':
    case 'bridge':
    case 'transfer':
      return '';
  }
}

function getAwakenTag(kind: TaxSweepEventKind): string {
  switch (kind) {
    case 'burn_loss_harvest':
      return 'lost';
    case 'defi_withdraw':
      return 'withdraw';
    case 'swap':
      return 'swap';
    case 'bridge':
      return 'bridge';
    case 'reclaim_rent':
      return 'claim_rewards';
    case 'transfer':
      return 'transfer';
  }
}

function buildDefaultDescription(ev: TaxSweepEvent): string {
  const statusTag = ev.status === 'planned' ? 'Planned' : 'Completed';
  const chainSuffix = ev.chain ? ` on ${ev.chain}` : '';
  const protoSuffix = ev.protocol ? ` (${ev.protocol})` : '';
  switch (ev.kind) {
    case 'defi_withdraw':
      return `${statusTag} DeFi withdrawal${protoSuffix}${chainSuffix}`;
    case 'swap':
      return `${statusTag} swap${chainSuffix}`;
    case 'bridge':
      return `${statusTag} bridge to Solana${chainSuffix}`;
    case 'burn_loss_harvest':
      return `${statusTag} zero-liquidity burn for realized tax-loss harvesting${chainSuffix}`;
    case 'reclaim_rent':
      return `${statusTag} Solana rent reclaim${chainSuffix}`;
    case 'transfer':
      return `${statusTag} transfer${chainSuffix}`;
  }
}

/**
 * Generates tax-ready CSV exports in `koinly`, `cointracker`, or `awaken` format with
 * strict OWASP CSV formula-injection neutralization across every cell.
 */
export function generateTaxCsvExport(input: TaxCsvExportInput): TaxCsvExportResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Tax export payload must be a JSON object.');
  }
  const rawFormat = typeof input.format === 'string' ? input.format.trim().toLowerCase() : '';
  if (!VALID_TAX_EXPORT_FORMATS.has(rawFormat as TaxExportFormat)) {
    throw new Error('format must be one of: "koinly", "cointracker", "awaken".');
  }
  const format = rawFormat as TaxExportFormat;

  const fallbackDate = parseTimestampToDate(input.generatedAt, new Date());

  let events: TaxSweepEvent[];
  if (Array.isArray(input.events)) {
    events = input.events;
  } else if (Array.isArray(input.assets)) {
    events = buildTaxEventsFromScannedAssets({
      assets: input.assets,
      outputAsset: input.outputAsset,
      timestamp: fallbackDate.toISOString(),
    });
  } else if (input.scan && Array.isArray(input.scan.assets)) {
    events = buildTaxEventsFromScannedAssets({
      assets: input.scan.assets,
      outputAsset: input.outputAsset,
      timestamp: input.scan.scannedAt || fallbackDate.toISOString(),
    });
  } else {
    throw new Error('Provide a non-empty events[], assets[], or scan payload for tax CSV export.');
  }

  if (events.length === 0) {
    throw new Error('No taxable or sweep events available to export.');
  }
  if (events.length > MAX_TAX_EXPORT_EVENTS) {
    throw new Error(`Tax export exceeds maximum of ${MAX_TAX_EXPORT_EVENTS} events per request.`);
  }

  const summary: TaxCsvExportSummary = {
    totalEvents: 0,
    defiWithdrawals: 0,
    swaps: 0,
    bridges: 0,
    burnsHarvested: 0,
    totalProceedsUsd: 0,
    totalFeesUsd: 0,
    estimatedTaxLossBurnUsd: 0,
  };

  const lines: string[] = [];
  if (format === 'koinly') {
    lines.push(
      'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash'
    );
  } else if (format === 'cointracker') {
    lines.push(
      'Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag'
    );
  } else {
    lines.push(
      'Date,Received Quantity,Received Currency,Received Fiat,Sent Quantity,Sent Currency,Sent Fiat,Fee Amount,Fee Currency,Transaction Hash,Notes,Tag'
    );
  }

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      throw new Error(`events[${i}] must be an object.`);
    }
    if (typeof ev.kind !== 'string' || !VALID_EVENT_KINDS.has(ev.kind as TaxSweepEventKind)) {
      throw new Error(
        `events[${i}].kind must be one of: ${Array.from(VALID_EVENT_KINDS).join(', ')}.`
      );
    }

    const evDate = parseTimestampToDate(ev.timestamp, fallbackDate);
    const sentAmt = parseNonNegativeAmount(ev.sentAmount, `events[${i}].sentAmount`);
    const recvAmt = parseNonNegativeAmount(ev.receivedAmount, `events[${i}].receivedAmount`);
    const feeAmt = parseNonNegativeAmount(ev.feeAmount, `events[${i}].feeAmount`);
    const sentFiat = parseNonNegativeAmount(ev.sentFiatUsd, `events[${i}].sentFiatUsd`);
    const recvFiat = parseNonNegativeAmount(ev.receivedFiatUsd, `events[${i}].receivedFiatUsd`);
    const feeUsd = parseNonNegativeAmount(ev.feeUsd, `events[${i}].feeUsd`);
    const netWorthUsd = parseNonNegativeAmount(ev.netWorthUsd, `events[${i}].netWorthUsd`);

    const sentCurrency = sanitizeCurrencySymbol(ev.sentCurrency);
    const recvCurrency = sanitizeCurrencySymbol(ev.receivedCurrency);
    const feeCurrency = sanitizeCurrencySymbol(ev.feeCurrency);
    const txHash = sanitizeText(ev.txHash, 128);
    const description = sanitizeText(ev.description) || buildDefaultDescription(ev);

    // For zero-liquidity burns, realized proceeds are explicitly $0.00
    const effectiveNetWorthUsd =
      ev.kind === 'burn_loss_harvest'
        ? 0
        : netWorthUsd ?? recvFiat ?? sentFiat;

    summary.totalEvents += 1;
    if (ev.kind === 'defi_withdraw') summary.defiWithdrawals += 1;
    else if (ev.kind === 'swap') summary.swaps += 1;
    else if (ev.kind === 'bridge') summary.bridges += 1;
    else if (ev.kind === 'burn_loss_harvest') {
      summary.burnsHarvested += 1;
      summary.estimatedTaxLossBurnUsd += sentFiat ?? 0;
    }

    if (ev.kind !== 'burn_loss_harvest') {
      summary.totalProceedsUsd += recvFiat ?? netWorthUsd ?? 0;
    }
    summary.totalFeesUsd += feeUsd ?? (feeCurrency.toUpperCase() === 'USD' ? feeAmt ?? 0 : 0);

    const sentAmtStr = formatCryptoAmount(sentAmt);
    const recvAmtStr = ev.kind === 'burn_loss_harvest' ? '' : formatCryptoAmount(recvAmt);
    const recvCurOut = ev.kind === 'burn_loss_harvest' ? '' : recvCurrency;
    const feeAmtStr = formatCryptoAmount(feeAmt);

    if (format === 'koinly') {
      lines.push(
        encodeCsvRow([
          formatKoinlyDate(evDate),
          sentAmtStr,
          sentCurrency,
          recvAmtStr,
          recvCurOut,
          feeAmtStr,
          feeCurrency,
          effectiveNetWorthUsd !== undefined ? formatFiatUsd(effectiveNetWorthUsd) : '',
          effectiveNetWorthUsd !== undefined ? 'USD' : '',
          getKoinlyLabel(ev.kind),
          description,
          txHash,
        ])
      );
    } else if (format === 'cointracker') {
      lines.push(
        encodeCsvRow([
          formatUsUtcDate(evDate),
          recvAmtStr,
          recvCurOut,
          sentAmtStr,
          sentCurrency,
          feeAmtStr,
          feeCurrency,
          getCoinTrackerTag(ev.kind),
        ])
      );
    } else {
      lines.push(
        encodeCsvRow([
          formatUsUtcDate(evDate),
          recvAmtStr,
          recvCurOut,
          ev.kind === 'burn_loss_harvest'
            ? '0.00'
            : recvFiat !== undefined
              ? formatFiatUsd(recvFiat)
              : '',
          sentAmtStr,
          sentCurrency,
          sentFiat !== undefined ? formatFiatUsd(sentFiat) : '',
          feeAmtStr,
          feeCurrency,
          txHash,
          description,
          getAwakenTag(ev.kind),
        ])
      );
    }
  }

  summary.totalProceedsUsd = Number(summary.totalProceedsUsd.toFixed(2));
  summary.totalFeesUsd = Number(summary.totalFeesUsd.toFixed(2));
  summary.estimatedTaxLossBurnUsd = Number(summary.estimatedTaxLossBurnUsd.toFixed(2));

  const dateStamp = `${fallbackDate.getUTCFullYear()}-${pad2(
    fallbackDate.getUTCMonth() + 1
  )}-${pad2(fallbackDate.getUTCDate())}`;
  const filename = `turgalium-${format}-${dateStamp}.csv`;

  return {
    format,
    filename,
    contentType: 'text/csv; charset=utf-8',
    rowCount: summary.totalEvents,
    summary,
    csv: `${lines.join('\r\n')}\r\n`,
  };
}
