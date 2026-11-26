import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { buildAgentReviewLink } from '../src/agent/review-link.js';
import { handleMcpJsonRpc, TURGALIUM_MCP_TOOLS } from '../src/mcp/server.js';
import { TurgaliumAgentEngine } from '../src/agent/mandate-engine.js';
import { BoundedTtlCache } from '../src/server/cache.js';
import { createTurgaliumServer } from '../src/server/app.js';
import type { ScanReport } from '../src/scanner/types.js';

const VALID_EVM = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const VALID_SOL = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';

test('Wave 21 buildAgentReviewLink: constructs non-custodial review URLs and blocks private keys', () => {
  const res = buildAgentReviewLink({
    baseUrl: 'https://turgalium.vercel.app',
    wallet: VALID_EVM,
    solanaDestination: VALID_SOL,
    outputAsset: 'SOL',
    chains: ['base', 'arbitrum', 'not_a_chain'],
    agentName: 'ChatGPT',
    note: 'Sweep Base + Arbitrum DeFi & dust',
  });

  assert.equal(res.nonCustodial, true);
  assert.equal(res.privateKeyRequired, false);
  assert.equal(res.family, 'evm');
  assert.equal(res.outputAsset, 'SOL');
  assert.deepEqual(res.chains, ['base', 'arbitrum']);
  const parsed = new URL(res.reviewUrl);
  assert.equal(parsed.origin, 'https://turgalium.vercel.app');
  assert.equal(parsed.searchParams.get('wallet'), VALID_EVM);
  assert.equal(parsed.searchParams.get('dest'), VALID_SOL);
  assert.equal(parsed.searchParams.get('output'), 'SOL');
  assert.equal(parsed.searchParams.get('chains'), 'base,arbitrum');
  assert.equal(parsed.searchParams.get('agent'), 'ChatGPT');

  // Fail closed when someone passes a 64-hex private key instead of a public address
  assert.throws(
    () =>
      buildAgentReviewLink({
        baseUrl: 'https://turgalium.vercel.app',
        wallet: '0x' + 'ab'.repeat(32),
      }),
    /private key|64-hex/i
  );

  // Reject invalid Solana destination
  assert.throws(
    () =>
      buildAgentReviewLink({
        baseUrl: 'https://turgalium.vercel.app',
        wallet: VALID_EVM,
        solanaDestination: 'not-a-solana-key',
      }),
    /solanaDestination/i
  );
});

test('Wave 21 HTTP POST /api/agent/review-link, OpenAPI spec, and MCP turgalium_build_review_link', async () => {
  const { server } = createTurgaliumServer({
    enableBackgroundPollers: false,
    rateLimit: { enabled: false },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 1. OpenAPI spec advertises /api/agent/review-link
    const specRes = await fetch(`${base}/openapi.json`);
    assert.equal(specRes.status, 200);
    const spec = (await specRes.json()) as { paths?: Record<string, unknown> };
    assert.ok(spec.paths?.['/api/agent/review-link'], 'OpenAPI spec must include /api/agent/review-link');

    // 2. Public POST /api/agent/review-link succeeds with zero auth
    const okRes = await fetch(`${base}/api/agent/review-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: VALID_EVM,
        solanaDestination: VALID_SOL,
        outputAsset: 'USDC',
        agentName: 'Claude',
      }),
    });
    assert.equal(okRes.status, 200);
    const okData = (await okRes.json()) as { reviewUrl: string; privateKeyRequired: boolean };
    assert.equal(okData.privateKeyRequired, false);
    assert.ok(okData.reviewUrl.includes(`wallet=${VALID_EVM}`));
    assert.ok(okData.reviewUrl.includes(`dest=${VALID_SOL}`));

    // 3. Rejects 64-hex private key with HTTP 400
    const badRes = await fetch(`${base}/api/agent/review-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: '0x' + '11'.repeat(32) }),
    });
    assert.equal(badRes.status, 400);

    // 4. MCP tool registered and callable with scan:read scope
    assert.ok(
      TURGALIUM_MCP_TOOLS.some((t) => t.name === 'turgalium_build_review_link'),
      'TURGALIUM_MCP_TOOLS must include turgalium_build_review_link'
    );
    const mcpResp = (await handleMcpJsonRpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'turgalium_build_review_link',
          arguments: {
            wallet: VALID_EVM,
            solanaDestination: VALID_SOL,
            agentName: 'Claude Desktop',
          },
        },
      },
      {
        agentEngine: new TurgaliumAgentEngine(),
        scanCache: new BoundedTtlCache<string, ScanReport>({ maxEntries: 8, ttlMs: 60_000 }),
        tokenScopes: ['scan:read'],
        publicBaseUrl: 'https://turgalium.vercel.app',
      }
    )) as { result?: { structuredContent?: { reviewUrl?: string; nonCustodial?: boolean } } };
    assert.equal(mcpResp.result?.structuredContent?.nonCustodial, true);
    assert.ok(
      mcpResp.result?.structuredContent?.reviewUrl?.startsWith('https://turgalium.vercel.app/?'),
      'MCP tool must return reviewUrl'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
