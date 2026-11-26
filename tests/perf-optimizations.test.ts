import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTurgaliumServer } from '../src/server/app.js';

test('Wave 14 Performance: split vendor bundles, immutable cache headers, HEAD endpoints, and NDJSON scan stream', async () => {
  const { server } = createTurgaliumServer({
    enableBackgroundPollers: false,
    rateLimit: { enabled: false },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. Split vendor bundles exist on disk and serve with immutable edge caching
    for (const file of [
      'solana-web3.js',
      'coinbase-sdk.js',
      'walletconnect-sdk.js',
      'three.module.js',
      'three.core.js',
    ]) {
      assert.ok(
        fs.existsSync(path.resolve('public/vendor', file)),
        `Expected public/vendor/${file} to be emitted by npm run build:vendor`
      );
      const headRes = await fetch(`${base}/vendor/${file}`, { method: 'HEAD' });
      assert.equal(headRes.status, 200, `/vendor/${file} HEAD must return 200`);
      assert.match(
        headRes.headers.get('cache-control') || '',
        /immutable/i,
        `/vendor/${file} must include immutable Cache-Control`
      );
    }

    // 2. HEAD support on public read endpoints (/api/health, /api/config, /api/chains, /api/families)
    for (const ep of ['/api/health', '/api/config', '/api/chains', '/api/families']) {
      const headRes = await fetch(`${base}${ep}`, { method: 'HEAD' });
      assert.equal(headRes.status, 200, `HEAD ${ep} must return 200`);
      const text = await headRes.text();
      assert.equal(text, '', `HEAD ${ep} must return empty body`);
    }

    // 3. Invalid chains filter returns 400
    const badChainsRes = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        chains: ['not_a_real_chain'],
      }),
    });
    assert.equal(badChainsRes.status, 400);

    // 4. NDJSON streaming scan returns valid newline-delimited JSON ending with type: "done"
    const streamRes = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/x-ndjson, application/json',
      },
      body: JSON.stringify({ presetId: 'veteran_defi' }),
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type') || '', /application\/x-ndjson/i);
    const lines = (await streamRes.text())
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(lines.length >= 1, 'Expected at least 1 NDJSON event');
    const last = lines[lines.length - 1];
    assert.equal(last.type, 'done');
    assert.ok(last.report?.scanId, 'Final NDJSON done event must include report.scanId');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
