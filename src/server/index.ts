import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSiphonServer } from './app.js';

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
 * unless `SIPHON_ADMIN_SESSION_TOKEN` is explicitly configured.
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
        `Fail-closed startup guard: refusing to bind non-loopback HOST="${host}" without SIPHON_ADMIN_SESSION_TOKEN set. ` +
          `Configure SIPHON_ADMIN_SESSION_TOKEN (and SIPHON_ALLOWED_HOSTS / SIPHON_ALLOWED_ORIGIN) before exposing Siphon beyond localhost.`
      );
    }
    if (token.length < 16) {
      warnings.push(
        'SIPHON_ADMIN_SESSION_TOKEN is shorter than 16 characters; use a high-entropy random secret in production.'
      );
    }
    if (
      !config.allowedHosts?.trim() &&
      !config.allowedOrigin?.trim() &&
      !config.publicBaseUrl?.trim()
    ) {
      warnings.push(
        'Binding non-loopback host without SIPHON_ALLOWED_HOSTS, SIPHON_ALLOWED_ORIGIN, or SIPHON_PUBLIC_BASE_URL; non-loopback Host headers will be rejected by DNS-rebinding protection.'
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
    service: 'siphon-migrator',
    event,
    ...meta,
  });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

export function startSiphonProcess(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? 4420);
  const host = env.HOST?.trim() || '127.0.0.1';

  const check = assertSafeStartupConfig({
    host,
    adminSessionToken: env.SIPHON_ADMIN_SESSION_TOKEN,
    allowedHosts: env.SIPHON_ALLOWED_HOSTS,
    allowedOrigin: env.SIPHON_ALLOWED_ORIGIN,
    publicBaseUrl: env.SIPHON_PUBLIC_BASE_URL,
  });
  for (const warning of check.warnings) {
    logJson('warn', 'startup_warning', { host, warning });
  }

  const instance = createSiphonServer();
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
    startSiphonProcess();
  } catch (err) {
    logJson('error', 'startup_blocked', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}
