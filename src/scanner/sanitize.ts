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
