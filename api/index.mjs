import { createTurgaliumServer } from '../dist/src/server/app.js';

function collectVercelHosts() {
  const hosts = new Set(['turgalium.vercel.app']);
  const candidates = [
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_BRANCH_URL,
    ...(process.env.TURGALIUM_ALLOWED_HOSTS
      ? process.env.TURGALIUM_ALLOWED_HOSTS.split(',')
      : []),
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const clean = raw
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .toLowerCase();
    if (clean) hosts.add(clean);
  }
  return Array.from(hosts);
}

function collectVercelOrigins(hosts) {
  const origins = new Set();
  for (const h of hosts) {
    origins.add(`https://${h}`);
  }
  if (process.env.TURGALIUM_ALLOWED_ORIGIN) {
    for (const raw of process.env.TURGALIUM_ALLOWED_ORIGIN.split(',')) {
      const clean = raw.trim();
      if (clean) origins.add(clean);
    }
  }
  return Array.from(origins);
}

const allowedHosts = collectVercelHosts();
const allowedOrigins = collectVercelOrigins(allowedHosts);
const primaryHost =
  process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'turgalium.vercel.app';
const publicBaseUrl =
  process.env.TURGALIUM_PUBLIC_BASE_URL?.trim() ||
  `https://${primaryHost.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')}`;

const instance = createTurgaliumServer({
  allowedHosts,
  allowedOrigins,
  allowLoopbackOrigins: false,
  allowLoopbackHosts: false,
  publicBaseUrl,
  trustProxy: true,
  enableBackgroundPollers: false,
  dataDir: null,
});

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  try {
    await instance.requestHandler(req, res);
  } catch (err) {
    console.error('[turgalium-vercel] handler error:', err);
    if (!res.headersSent) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}
