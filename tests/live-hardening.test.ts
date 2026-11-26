import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { COSMOS_CHAINS, cosmosAdapter } from '../src/adapters/cosmos.js';
import { aptosAdapter } from '../src/adapters/aptos.js';
import { btcAdapter } from '../src/adapters/btc.js';
import { suiAdapter } from '../src/adapters/sui.js';
import { tonAdapter } from '../src/adapters/ton.js';
import { tronAdapter } from '../src/adapters/tron.js';
import { createTurgaliumServer } from '../src/server/app.js';
import { BackgroundJobStore } from '../src/server/jobs.js';
import { FileStateStore } from '../src/storage/state-store.js';

const EVM_WALLET = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const COSMOS_WALLET = 'cosmos1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5lzv7xu';
const SOL_DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function rawHttpRequest(port: number, rawRequest: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let raw = '';
    socket.on('connect', () => {
      socket.write(rawRequest);
    });
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8');
    });
    socket.on('end', () => {
      const [head = '', ...rest] = raw.split('\r\n\r\n');
      const lines = head.split('\r\n');
      const statusMatch = /^HTTP\/1\.\d\s+(\d{3})/.exec(lines[0] ?? '');
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const headers: Record<string, string> = {};
      for (const line of lines.slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
          headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
      }
      resolve({ status, headers, body: rest.join('\r\n\r\n') });
    });
    socket.on('error', reject);
  });
}

test('HIGH-1: GET /api/chains strips rpcUrl and rpcUrls while retaining safe chain metadata', async () => {
  const { server } = createTurgaliumServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const res = await fetch(`${base}/api/chains`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      chains: Array<Record<string, unknown>>;
      families: unknown[];
      solanaCctpDomain: number;
    };
    assert.ok(data.chains.length >= 19, 'Expected >= 19 EVM chains');
    for (const chain of data.chains) {
      assert.equal('rpcUrl' in chain, false, `rpcUrl leaked on ${String(chain.id)}`);
      assert.equal('rpcUrls' in chain, false, `rpcUrls leaked on ${String(chain.id)}`);
      assert.equal(typeof chain.id, 'string');
      assert.equal(typeof chain.name, 'string');
      assert.equal(typeof chain.chainId, 'number');
      assert.equal(typeof chain.nativeSymbol, 'string');
      assert.equal(typeof chain.explorerUrl, 'string');
      assert.ok('cctpDomain' in chain);
    }
    assert.equal(data.solanaCctpDomain, 5);
    assert.ok(Array.isArray(data.families) && data.families.length >= 6);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('HIGH-2: Production/Vercel deployments reject loopback Origins and loopback Host headers while local dev still works', async () => {
  const prevVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  const { server } = createTurgaliumServer({
    allowedHosts: ['turgalium.vercel.app'],
    allowedOrigins: ['https://turgalium.vercel.app'],
    publicBaseUrl: 'https://turgalium.vercel.app',
    adminSessionToken: 'prod_admin_token_001',
    enableBackgroundPollers: false,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');

  try {
    // 1. Loopback Host header rejected with 403 on production/Vercel
    const badHost = await rawHttpRequest(
      addr.port,
      'GET /api/health HTTP/1.1\r\nHost: localhost:3000\r\nConnection: close\r\n\r\n'
    );
    assert.equal(badHost.status, 403);

    const badLoopbackIpHost = await rawHttpRequest(
      addr.port,
      `GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:${addr.port}\r\nConnection: close\r\n\r\n`
    );
    assert.equal(badLoopbackIpHost.status, 403);

    // 2. Allowed production Host succeeds
    const goodHost = await rawHttpRequest(
      addr.port,
      'GET /api/health HTTP/1.1\r\nHost: turgalium.vercel.app\r\nConnection: close\r\n\r\n'
    );
    assert.equal(goodHost.status, 200);

    // 3. Loopback Origin rejected with 403 and no ACAO header on privileged GET, POST, and OPTIONS /mcp
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:4420', 'http://[::1]:5173']) {
      const getMandates = await rawHttpRequest(
        addr.port,
        `GET /api/agents/mandates HTTP/1.1\r\nHost: turgalium.vercel.app\r\nOrigin: ${origin}\r\nX-Turgalium-Admin-Session: prod_admin_token_001\r\nConnection: close\r\n\r\n`
      );
      assert.equal(getMandates.status, 403, `Expected 403 for Origin ${origin}`);
      assert.equal(getMandates.headers['access-control-allow-origin'], undefined);

      const optionsMcp = await rawHttpRequest(
        addr.port,
        `OPTIONS /mcp HTTP/1.1\r\nHost: turgalium.vercel.app\r\nOrigin: ${origin}\r\nConnection: close\r\n\r\n`
      );
      assert.equal(optionsMcp.status, 403, `Expected 403 on OPTIONS /mcp for Origin ${origin}`);
      assert.equal(optionsMcp.headers['access-control-allow-origin'], undefined);
    }

    // 4. Configured production Origin succeeds and is reflected
    const prodMandates = await rawHttpRequest(
      addr.port,
      'GET /api/agents/mandates HTTP/1.1\r\nHost: turgalium.vercel.app\r\nOrigin: https://turgalium.vercel.app\r\nX-Turgalium-Admin-Session: prod_admin_token_001\r\nConnection: close\r\n\r\n'
    );
    assert.equal(prodMandates.status, 200);
    assert.equal(prodMandates.headers['access-control-allow-origin'], 'https://turgalium.vercel.app');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
  }

  // 5. Local dev server still accepts 127.0.0.1 Host and loopback Origin cleanly
  const local = createTurgaliumServer();
  await new Promise<void>((resolve) => local.server.listen(0, '127.0.0.1', () => resolve()));
  const localAddr = local.server.address();
  assert.ok(localAddr && typeof localAddr !== 'string');
  try {
    const localRes = await fetch(`http://127.0.0.1:${localAddr.port}/api/agents/mandates`, {
      headers: { Origin: `http://127.0.0.1:${localAddr.port}` },
    });
    assert.equal(localRes.status, 200);
    assert.equal(
      localRes.headers.get('access-control-allow-origin'),
      `http://127.0.0.1:${localAddr.port}`
    );
  } finally {
    await new Promise<void>((resolve) => local.server.close(() => resolve()));
  }
});

test('HIGH-3: X-RateLimit-* headers emitted on 2xx API responses, /api/health exposes persistence, and Vercel ephemeral relayer fails closed', async () => {
  const prevVercel = process.env.VERCEL;
  const prevRelayerKey = process.env.TURGALIUM_RELAYER_PRIVATE_KEY;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turgalium-health-persist-'));

  try {
    // 1. Ephemeral memory server reports persistence: 'ephemeral-memory' and emits X-RateLimit-* on 2xx
    const mem = createTurgaliumServer({
      rateLimit: { maxRequests: 10, windowMs: 60_000 },
    });
    await new Promise<void>((resolve) => mem.server.listen(0, '127.0.0.1', () => resolve()));
    const memAddr = mem.server.address();
    assert.ok(memAddr && typeof memAddr !== 'string');
    const memBase = `http://127.0.0.1:${memAddr.port}`;

    try {
      const healthRes = await fetch(`${memBase}/api/health`);
      assert.equal(healthRes.status, 200);
      const health = (await healthRes.json()) as { persistence: string };
      assert.equal(health.persistence, 'ephemeral-memory');

      const r1 = await fetch(`${memBase}/api/chains`);
      assert.equal(r1.status, 200);
      assert.equal(r1.headers.get('x-ratelimit-limit'), '10');
      assert.equal(r1.headers.get('x-ratelimit-remaining'), '9');
      assert.ok(Number(r1.headers.get('x-ratelimit-reset')) > 0);
      await r1.text();

      const r2 = await fetch(`${memBase}/api/config`);
      assert.equal(r2.status, 200);
      assert.equal(r2.headers.get('x-ratelimit-limit'), '10');
      assert.equal(r2.headers.get('x-ratelimit-remaining'), '8');
      await r2.text();
    } finally {
      await new Promise<void>((resolve) => mem.server.close(() => resolve()));
    }

    // 2. File-backed server reports persistence: 'file'
    const fileSrv = createTurgaliumServer({ stateStore: new FileStateStore(tmpDir) });
    await new Promise<void>((resolve) => fileSrv.server.listen(0, '127.0.0.1', () => resolve()));
    const fileAddr = fileSrv.server.address();
    assert.ok(fileAddr && typeof fileAddr !== 'string');
    try {
      const health = (await fetch(`http://127.0.0.1:${fileAddr.port}/api/health`).then((r) =>
        r.json()
      )) as { persistence: string };
      assert.equal(health.persistence, 'file');
    } finally {
      await new Promise<void>((resolve) => fileSrv.server.close(() => resolve()));
    }

    // 3. On Vercel without durable persistence, live relayer broadcast fails closed with 503
    process.env.VERCEL = '1';
    process.env.TURGALIUM_RELAYER_PRIVATE_KEY =
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const vercelSrv = createTurgaliumServer({
      allowedHosts: ['turgalium.vercel.app'],
      allowedOrigins: ['https://turgalium.vercel.app'],
      allowLoopbackHosts: true,
      allowLoopbackOrigins: true,
      enableBackgroundPollers: false,
      dataDir: null,
    });
    await new Promise<void>((resolve) => vercelSrv.server.listen(0, '127.0.0.1', () => resolve()));
    const vAddr = vercelSrv.server.address();
    assert.ok(vAddr && typeof vAddr !== 'string');
    const vBase = `http://127.0.0.1:${vAddr.port}`;
    try {
      const cfg = (await fetch(`${vBase}/api/config`).then((r) => r.json())) as {
        gaslessRelayerConfigured: boolean;
      };
      assert.equal(cfg.gaslessRelayerConfigured, false);

      const submitRes = await fetch(`${vBase}/api/relayer/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId: 'int_fake_ephemeral',
          chain: 'base',
          userAddress: EVM_WALLET,
          signature: '0x' + '11'.repeat(65),
          deadline: Math.floor(Date.now() / 1000) + 600,
          txCalldata: '0x12345678',
        }),
      });
      assert.equal(submitRes.status, 503);
      const body = (await submitRes.json()) as {
        accepted: boolean;
        broadcasted: boolean;
        settlementStatus: string;
        error: string;
      };
      assert.equal(body.accepted, false);
      assert.equal(body.broadcasted, false);
      assert.equal(body.settlementStatus, 'blocked_ephemeral_persistence');
      assert.match(body.error, /durable/i);
    } finally {
      await new Promise<void>((resolve) => vercelSrv.server.close(() => resolve()));
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevRelayerKey === undefined) delete process.env.TURGALIUM_RELAYER_PRIVATE_KEY;
    else process.env.TURGALIUM_RELAYER_PRIVATE_KEY = prevRelayerKey;
  }
});

test('MEDIUM-4: Non-EVM POST /api/relayer/submit and adapter.relayAndProve fail closed (HTTP 501, accepted: false)', async () => {
  const { server } = createTurgaliumServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    const nonEvmCases = [
      { chain: 'btc', userAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', adapter: btcAdapter },
      { chain: 'cosmoshub', userAddress: COSMOS_WALLET, adapter: cosmosAdapter },
      { chain: 'sui', userAddress: '0x' + '12'.repeat(32), adapter: suiAdapter },
      { chain: 'aptos', userAddress: '0x' + '34'.repeat(32), adapter: aptosAdapter },
      { chain: 'ton', userAddress: 'EQD__________________________________________0vo', adapter: tonAdapter },
      { chain: 'tron', userAddress: 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL', adapter: tronAdapter },
    ] as const;

    for (const tc of nonEvmCases) {
      const res = await fetch(`${base}/api/relayer/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intentId: 'fake_audit_check',
          chain: tc.chain,
          userAddress: tc.userAddress,
          signature: 'not_a_real_sig',
          deadline: Math.floor(Date.now() / 1000) + 600,
        }),
      });
      assert.equal(res.status, 501, `Expected HTTP 501 for non-EVM chain ${tc.chain}`);
      const json = (await res.json()) as {
        accepted: boolean;
        broadcasted: boolean;
        mode: string;
        nextStep: string;
        error: string;
      };
      assert.equal(json.accepted, false, `${tc.chain} must fail closed with accepted: false`);
      assert.equal(json.broadcasted, false);
      assert.equal(json.mode, 'unsupported_non_evm_relayer');
      assert.doesNotMatch(json.nextStep, /verified \(0x/i);
      assert.match(json.error, /direct mode/i);

      // Direct adapter check too
      const direct = await tc.adapter.relayAndProve({
        chain: tc.chain,
        intentId: 'fake_audit_check',
        userAddress: tc.userAddress,
        solanaDestination: SOL_DEST,
        signature: 'not_a_real_sig',
        deadline: Math.floor(Date.now() / 1000) + 600,
      });
      assert.equal(direct.submitted?.accepted, false);
      assert.equal(direct.submitted?.broadcasted, false);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('MEDIUM-7: BackgroundJobStore skips spawning setInterval pollers when enableBackgroundPollers is false', async () => {
  let checkerCalls = 0;
  const store = new BackgroundJobStore({
    enableBackgroundPollers: false,
    pollIntervalMs: 15,
    statusChecker: async () => {
      checkerCalls += 1;
      return {
        chain: 'base',
        evmConfirmed: true,
        evmFailed: false,
        bridgeStatus: 'success',
      };
    },
  });

  try {
    assert.equal(store.backgroundPollersEnabled, false);
    const job = store.createJob({
      sourceWallet: EVM_WALLET,
      solanaDestination: SOL_DEST,
      outputAsset: 'USDC',
      bridgePreference: 'relay',
      protocolFeeBps: 700,
      feeRecipientEvm: null,
      legs: [{ chain: 'base', assetCount: 1, estimatedNetUsd: 100 }],
    });

    store.updateLeg(job.jobId, 'base', {
      status: 'confirming',
      evmTxHash: '0x' + 'aa'.repeat(32),
      requestId: 'req_123',
      provider: 'relay',
    });

    assert.equal(store.activePollerCount, 0);
    assert.equal(store.resumeActivePollers(), 0);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(checkerCalls, 0);
  } finally {
    store.dispose();
  }

  // Also verify propagation through createTurgaliumServer({ enableBackgroundPollers: false })
  const srv = createTurgaliumServer({ enableBackgroundPollers: false });
  assert.equal(srv.jobStore.backgroundPollersEnabled, false);
  const job = srv.jobStore.createJob({
    sourceWallet: EVM_WALLET,
    solanaDestination: SOL_DEST,
    outputAsset: 'USDC',
    bridgePreference: 'auto',
    protocolFeeBps: 700,
    feeRecipientEvm: null,
    legs: [{ chain: 'arbitrum', assetCount: 1, estimatedNetUsd: 250 }],
  });
  srv.jobStore.updateLeg(job.jobId, 'arbitrum', {
    status: 'relaying',
    evmTxHash: '0x' + 'bb'.repeat(32),
  });
  assert.equal(srv.jobStore.activePollerCount, 0);
  srv.jobStore.dispose();
});

test('LOW-8: Security headers enforce CORP same-origin, API/404 CSP default-src none, and safe /logos/* cross-origin', async () => {
  const { server } = createTurgaliumServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Static HTML & JS & CSS: CORP same-origin, no wildcard ACAO
    for (const staticPath of ['/', '/app.js', '/styles.css', '/vendor/three.module.js']) {
      const res = await fetch(`${base}${staticPath}`);
      assert.equal(res.status, 200, `Expected 200 for ${staticPath}`);
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      await res.text();
    }

    // 2. Public logo SVG: CORP cross-origin + CSP sandbox
    const logoRes = await fetch(`${base}/logos/solana.svg`);
    assert.equal(logoRes.status, 200);
    assert.equal(logoRes.headers.get('cross-origin-resource-policy'), 'cross-origin');
    assert.equal(logoRes.headers.get('content-security-policy'), 'sandbox');
    await logoRes.text();

    // 3. JSON API 2xx & 404 responses: strict CSP default-src 'none'; frame-ancestors 'none' + CORP same-origin
    const apiRes = await fetch(`${base}/api/chains`);
    assert.equal(apiRes.status, 200);
    assert.equal(
      apiRes.headers.get('content-security-policy'),
      "default-src 'none'; frame-ancestors 'none'"
    );
    assert.equal(apiRes.headers.get('cross-origin-resource-policy'), 'same-origin');
    await apiRes.text();

    const notFoundRes = await fetch(`${base}/does-not-exist-audit-404`);
    assert.equal(notFoundRes.status, 404);
    assert.equal(
      notFoundRes.headers.get('content-security-policy'),
      "default-src 'none'; frame-ancestors 'none'"
    );
    assert.equal(notFoundRes.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(notFoundRes.headers.get('access-control-allow-origin'), null);
    await notFoundRes.text();

    // 4. vercel.json contains CORP headers and no wildcard Access-Control-Allow-Origin: *
    const vercelJsonPath = path.resolve(process.cwd(), 'vercel.json');
    const vercelCfg = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8')) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const rootRule = vercelCfg.headers.find((h) => h.source === '/(.*)');
    assert.ok(
      rootRule?.headers.some(
        (h) => h.key === 'Cross-Origin-Resource-Policy' && h.value === 'same-origin'
      )
    );
    const logosRule = vercelCfg.headers.find((h) => h.source === '/logos/(.*)');
    assert.ok(
      logosRule?.headers.some(
        (h) => h.key === 'Cross-Origin-Resource-Policy' && h.value === 'cross-origin'
      )
    );
    for (const rule of vercelCfg.headers) {
      for (const h of rule.headers) {
        if (h.key.toLowerCase() === 'access-control-allow-origin') {
          assert.notEqual(h.value, '*', 'vercel.json must not emit wildcard ACAO: *');
        }
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('LOW-10 & LOW-11: POST /api/optimize/unlock-schedule is mounted with strict validation, zero OpenAPI 404s, and prototype-safe gas overrides', async () => {
  const fixedNow = Date.parse('2026-11-26T12:00:00.000Z');
  const { server } = createTurgaliumServer({
    nowMs: () => fixedNow,
    liveGasFetcher: async () => 12,
    unlockQueuesReader: async ({ evmAddresses, cosmosAddresses }) => ({
      readAt: new Date(fixedNow).toISOString(),
      lido: [],
      ethena: [],
      cosmos: [],
      warnings: [],
      items: [
        ...(evmAddresses?.length
          ? [
              {
                id: 'lido:ethereum:9001',
                kind: 'lido_withdrawal' as const,
                chain: 'ethereum' as const,
                chainName: 'Ethereum',
                symbol: 'stETH',
                protocol: 'Lido Withdrawal Queue',
                estimatedUsd: 2500,
                unlockAtMs: fixedNow,
                unlockAtIso: new Date(fixedNow).toISOString(),
                secondsRemaining: 0,
                status: 'ready_to_claim' as const,
                actionLabel: 'Claim 1.0 ETH from Lido NFT #9001',
                source: 'lido_withdrawal_queue' as const,
              },
            ]
          : []),
        ...(cosmosAddresses?.length
          ? [
              {
                id: 'cosmos:cosmoshub:1',
                kind: 'cosmos_unbonding' as const,
                chain: 'cosmoshub' as const,
                chainName: 'Cosmos Hub',
                symbol: 'ATOM',
                protocol: 'Cosmos Staking',
                estimatedUsd: 400,
                unlockAtMs: fixedNow + 86_400_000,
                unlockAtIso: new Date(fixedNow + 86_400_000).toISOString(),
                secondsRemaining: 86_400,
                status: 'locked_waiting' as const,
                actionLabel: 'Unbonds in 1d',
                source: 'cosmos_staking' as const,
              },
            ]
          : []),
      ],
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Valid POST /api/optimize/unlock-schedule returns 200 with soonest-first merged items
    const res = await fetch(`${base}/api/optimize/unlock-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evmAddress: EVM_WALLET,
        cosmosAddresses: [COSMOS_WALLET],
        attestedCctpLegs: [
          {
            chain: 'base',
            amountUsdc: 500,
            attestationStatus: 'complete',
          },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      readOnly: boolean;
      totalItems: number;
      readyToClaimCount: number;
      lockedWaitingCount: number;
      unlockSchedule: Array<{ id: string; unlockAtMs: number }>;
    };
    assert.equal(data.readOnly, true);
    assert.equal(data.totalItems, 3);
    assert.equal(data.readyToClaimCount, 2);
    assert.equal(data.lockedWaitingCount, 1);
    assert.ok(data.unlockSchedule[0].unlockAtMs <= data.unlockSchedule[2].unlockAtMs);

    // 2. Strict validation rejects bad inputs with 400
    const emptyRes = await fetch(`${base}/api/optimize/unlock-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(emptyRes.status, 400);

    const zeroAddrRes = await fetch(`${base}/api/optimize/unlock-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evmAddress: '0x0000000000000000000000000000000000000000' }),
    });
    assert.equal(zeroAddrRes.status, 400);

    const badCosmosRes = await fetch(`${base}/api/optimize/unlock-schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cosmosAddresses: ['not_a_cosmos_addr'] }),
    });
    assert.equal(badCosmosRes.status, 400);

    // 3. Every path in /openapi.json is mounted (zero 404 routes)
    const openapi = (await fetch(`${base}/openapi.json`).then((r) => r.json())) as {
      paths: Record<string, Record<string, unknown>>;
    };
    for (const [routePath, methods] of Object.entries(openapi.paths)) {
      for (const method of Object.keys(methods)) {
        const m = method.toUpperCase();
        const probe = await fetch(`${base}${routePath}`, {
          method: m,
          headers: m === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
          body: m === 'POST' ? JSON.stringify({}) : undefined,
        });
        assert.notEqual(
          probe.status,
          404,
          `OpenAPI route ${m} ${routePath} returned 404 Not Found!`
        );
        await probe.text();
      }
    }

    // 4. LOW-11: POST /api/optimize/preservation ignores prototype/unknown keys in liveGasGweiByChain
    const scan = (await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId: 'veteran_defi' }),
    }).then((r) => r.json())) as { scanId: string };

    const presRes = await fetch(`${base}/api/optimize/preservation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:
        `{"scanId":"${scan.scanId}","liveGasGweiByChain":{"__proto__":99,"constructor":50,"unknownChain":42,"ethereum":25}}`,
    });
    assert.equal(presRes.status, 200);
    const pres = (await presRes.json()) as { gasTiming: { primary: { currentGwei: number } } };
    assert.equal(pres.gasTiming.primary.currentGwei, 25);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('MEDIUM-12: Neutron LCD fallback replaces dead neutron-rest.publicnode.com with live Polkachu LCD', () => {
  const urls = COSMOS_CHAINS.neutron.lcdUrls;
  assert.ok(urls.length >= 2);
  assert.equal(
    urls.some((u) => u.includes('neutron-rest.publicnode.com')),
    false,
    'Dead neutron-rest.publicnode.com must be removed'
  );
  assert.ok(
    urls.includes('https://neutron-api.polkachu.com'),
    'Live Polkachu Neutron LCD fallback must be configured'
  );
});
