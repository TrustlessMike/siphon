import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTurgaliumServer } from './app.js';

export interface StartupSecurityConfig {
  host: string;
  adminSessionToken?: string | null;
  allowedHosts?: string | null;
  allowedOrigin?: string | null;
  publicBaseUrl?: string | null;
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

/**
 * Fail-closed production startup guard:
 * Refuses to bind a non-loopback network interface (e.g. `0.0.0.0`, `::`, LAN/public IP)
 * unless `TURGALIUM_ADMIN_SESSION_TOKEN` is explicitly configured.
 */
export function assertSafeStartupConfig(config: StartupSecurityConfig): {
  loopback: boolean;
  warnings: string[];
} {
  const host = config.host?.trim() || '127.0.0.1';
  const loopback = isLoopbackBindHost(host);
  const warnings: string[] = [];

  if (!loopback) {
    const token = config.adminSessionToken?.trim() ?? '';
    if (!token) {
      throw new Error(
        `Fail-closed startup guard: refusing to bind non-loopback HOST="${host}" without TURGALIUM_ADMIN_SESSION_TOKEN set. ` +
          `Configure TURGALIUM_ADMIN_SESSION_TOKEN (and TURGALIUM_ALLOWED_HOSTS / TURGALIUM_ALLOWED_ORIGIN) before exposing Turgalium beyond localhost.`
      );
    }
    if (token.length < 16) {
      warnings.push(
        'TURGALIUM_ADMIN_SESSION_TOKEN is shorter than 16 characters; use a high-entropy random secret in production.'
      );
    }
    if (
      !config.allowedHosts?.trim() &&
      !config.allowedOrigin?.trim() &&
      !config.publicBaseUrl?.trim()
    ) {
      warnings.push(
        'Binding non-loopback host without TURGALIUM_ALLOWED_HOSTS, TURGALIUM_ALLOWED_ORIGIN, or TURGALIUM_PUBLIC_BASE_URL; non-loopback Host headers will be rejected by DNS-rebinding protection.'
      );
    }
  }

  return { loopback, warnings };
}

export function logJson(
  level: 'info' | 'warn' | 'error',
  event: string,
  meta: Record<string, unknown> = {}
): void {
  const entry = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: 'turgalium-migrator',
    event,
    ...meta,
  });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

export function parseServerPort(raw?: string): number {
  if (raw === undefined || raw.trim() === '') return 4420;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid PORT "${raw}": expected an integer in [1, 65535].`);
  }
  return parsed;
}

export function startTurgaliumProcess(env: NodeJS.ProcessEnv = process.env) {
  const port = parseServerPort(env.PORT);
  const host = env.HOST?.trim() || '127.0.0.1';

  const check = assertSafeStartupConfig({
    host,
    adminSessionToken: env.TURGALIUM_ADMIN_SESSION_TOKEN,
    allowedHosts: env.TURGALIUM_ALLOWED_HOSTS,
    allowedOrigin: env.TURGALIUM_ALLOWED_ORIGIN,
    publicBaseUrl: env.TURGALIUM_PUBLIC_BASE_URL,
  });
  for (const warning of check.warnings) {
    logJson('warn', 'startup_warning', { host, warning });
  }

  const instance = createTurgaliumServer();
  const { server, jobStore, stateStore, rateLimiter } = instance;

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logJson('info', 'shutdown_started', { signal });

    jobStore.dispose();

    const forceTimer = setTimeout(() => {
      logJson('error', 'shutdown_forced_timeout', { signal, timeoutMs: 10_000 });
      process.exit(1);
    }, 10_000);
    forceTimer.unref?.();

    server.close((err) => {
      clearTimeout(forceTimer);
      if (err) {
        logJson('error', 'shutdown_error', { signal, error: err.message });
        process.exit(1);
      }
      logJson('info', 'shutdown_complete', { signal });
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  server.listen(port, host, () => {
    logJson('info', 'server_listening', {
      host,
      port,
      url: `http://${host}:${port}`,
      persistence: stateStore.kind,
      rateLimitEnabled: rateLimiter.enabled,
      rateLimitMax: rateLimiter.maxRequests,
      rateLimitWindowMs: rateLimiter.windowMs,
    });
  });

  return { ...instance, shutdown };
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  try {
    startTurgaliumProcess();
  } catch (err) {
    logJson('error', 'startup_blocked', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
