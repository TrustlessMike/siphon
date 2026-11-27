/* =====================================================================
   TURGALIUM — LIGHTWEIGHT PWA SERVICE WORKER
   - Network-first for app shell (HTML, CSS, JS, manifest)
   - Cache-first for immutable /vendor/*, /logos/*, and /icons/*
   - NEVER intercepts or caches /api/*, /mcp, or non-GET requests
   ===================================================================== */

const SHELL_CACHE = 'turgalium-shell-v4';
const STATIC_CACHE = 'turgalium-static-v4';
const ACTIVE_CACHES = new Set([SHELL_CACHE, STATIC_CACHE]);

const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/logos/turgalium.svg?v=3',
  '/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_URLS.map((url) =>
            fetch(url, { cache: 'no-cache' }).then((res) => {
              if (res && res.ok) return cache.put(url, res);
              return null;
            })
          )
        )
      )
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (!ACTIVE_CACHES.has(key)) return caches.delete(key);
            return null;
          })
        )
      )
      .catch(() => {})
      .then(() => self.clients.claim())
  );
});

function isBypassPath(pathname) {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/mcp' ||
    pathname.startsWith('/mcp/') ||
    pathname === '/openapi.json' ||
    pathname.startsWith('/.well-known/')
  );
}

function isImmutableStaticPath(pathname) {
  return (
    pathname.startsWith('/vendor/') ||
    pathname.startsWith('/logos/') ||
    pathname.startsWith('/icons/')
  );
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && response.ok && response.type === 'basic') {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok && response.type === 'basic') {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shellFallback = await cache.match('/');
      if (shellFallback) return shellFallback;
    }
    return new Response('Offline — please reconnect to load Turgalium.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (isBypassPath(url.pathname)) return;

  if (isImmutableStaticPath(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  event.respondWith(networkFirst(request, SHELL_CACHE));
});
