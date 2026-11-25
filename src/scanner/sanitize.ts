/**
 * Strict sanitization & truncation for untrusted on-chain token metadata and free-text fields
 * before they enter ScanReports, UI, or LLM/MCP tool contexts (mitigates indirect prompt injection).
 */

// ASCII control chars, DEL, C1 controls, and Unicode bidirectional/zero-width override chars
const UNSAFE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

export function sanitizeTokenSymbol(raw?: string | null, fallback = 'UNKNOWN'): string {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.replace(/USD₮/g, 'USDT').replace(UNSAFE_CONTROL_RE, '').trim();
  const cleaned = normalized.replace(/[^A-Za-z0-9.$_-]/g, '').slice(0, 16);
  return cleaned || fallback;
}

export function sanitizeTokenName(raw?: string | null, fallback = 'Token'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(UNSAFE_CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return cleaned || fallback;
}

export function sanitizeFreeText(raw?: string | null, maxLen = 200, fallback = ''): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(UNSAFE_CONTROL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
  return cleaned || fallback;
}

const CSV_FORMULA_TRIGGER_RE = /^[=+\-@\t\r]/;
const CSV_LEADING_WS_FORMULA_RE = /^\s+[=+\-@]/;

/**
 * Neutralize spreadsheet formula injection (OWASP CSV Injection) and strip CR/LF control chars
 * before RFC-4180 quoting so untrusted on-chain symbols/names/reasons cannot execute formulas
 * or split rows in Excel, Google Sheets, or LibreOffice Calc.
 */
export function sanitizeCsvCell(val: unknown): string {
  const raw = String(val ?? '');
  const hadLeadingTrigger = CSV_FORMULA_TRIGGER_RE.test(raw);
  // Strip CR/LF and NUL control characters so no cell can break CSV row boundaries
  let cleaned = raw
    .replace(/^[\r\n]+/, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\u0000/g, '');
  if (
    hadLeadingTrigger ||
    CSV_FORMULA_TRIGGER_RE.test(cleaned) ||
    CSV_LEADING_WS_FORMULA_RE.test(cleaned)
  ) {
    cleaned = `'${cleaned}`;
  }
  return `"${cleaned.replaceAll('"', '""')}"`;
}

export interface BurnReceiptCsvRow {
  chain: string;
  symbol: string;
  tokenAddress: string;
  amount: string;
  status: string;
  burnSink: string;
  reason: string;
}

export const BURN_RECEIPT_CSV_HEADER = 'chain,symbol,token_address,amount,status,burn_sink,reason';

export function formatBurnReceiptCsv(rows: readonly BurnReceiptCsvRow[]): string {
  const lines = rows.map((b) =>
    [b.chain, b.symbol, b.tokenAddress, b.amount, b.status, b.burnSink, b.reason]
      .map(sanitizeCsvCell)
      .join(',')
  );
  return [BURN_RECEIPT_CSV_HEADER, ...lines].join('\n');
}
