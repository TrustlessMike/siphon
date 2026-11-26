import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cosmosAdapter } from '../src/adapters/cosmos.js';
import { TurgaliumAgentEngine } from '../src/agent/mandate-engine.js';
import { buildMigrationPlan } from '../src/bridge/cctp.js';
import { createStdioMcpDispatcher, TURGALIUM_MCP_TOOLS } from '../src/mcp/server.js';
import { planDustConversion } from '../src/scanner/dust.js';
import { applyTwoLevelRoiToReport, evaluatePortfolioRoi } from '../src/scanner/roi.js';
import type { ScannedAsset, ScanReport } from '../src/scanner/types.js';
import {
  normalizeWalletAddressForKey,
  normalizeWalletDedupKey,
  scanUnifiedWallets,
} from '../src/scanner/unify.js';
import { createTurgaliumServer } from '../src/server/app.js';
import { BoundedTtlCache } from '../src/server/cache.js';
import { BackgroundJobStore } from '../src/server/jobs.js';

const SAMPLE_SOLANA_WALLET = 'AK9CKqppArTVRrmd4rQKzvjcmNUHnx5LBFx1HXoYaz2n';
const SAMPLE_EVM_WALLET_A = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const SAMPLE_EVM_WALLET_B = '0x2222222222222222222222222222222222222222';

function makeAsset(overrides: Partial<ScannedAsset>): ScannedAsset {
  return {
    id: 'base:tok',
    family: 'evm',
    chain: 'base',
    chainName: 'Base',
    address: '0x0000000000000000000000000000000000000001',
    symbol: 'DUST',
    name: 'Dust Token',
    decimals: 18,
    kind: 'erc20',
    rawBalance: '1000000000000000000',
    uiBalance: 1,
    priceUsd: 2.0,
    grossUsd: 2.0,
    liquidityUsd: 200_000,
    estimatedGasUsd: 0.04,
    batchedGasUsd: 0.015,
    estimatedSlippageUsd: 0.005,
    netUsdcSingle: 1.81,
    netUsdcBatched: 1.84,
    action: 'SELL_AND_BRIDGE',
    actionReason: 'Test',
    selectedByDefault: true,
    honeypotSafe: true,
    ...overrides,
  };
}

function makeReport(assets: ScannedAsset[], overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    scanId: 'scan_test_1',
    family: 'evm',
    mode: 'preset',
    walletAddress: SAMPLE_EVM_WALLET_A,
    walletLabel: 'Test Wallet',
    scannedAt: new Date().toISOString(),
    scanDurationMs: 5,
    chainsScanned: 1,
    chains: [
      {
        family: 'evm',
        chain: 'base',
        chainName: 'Base',
        chainId: 8453,
        cctpDomain: 6,
        rpcStatus: 'preset',
        blockNumber: 1,
        gasPriceGwei: 0.05,
        nativeBalance: 0.1,
        nativeSymbol: 'ETH',
        nativePriceUsd: 2600,
        assetCount: assets.length,
        defiCount: 0,
        liquidCount: assets.length,
        burnCount: 0,
        skippedCount: 0,
        grossUsd: assets.reduce((s, a) => s + a.grossUsd, 0),
        netUsdcBridged: assets.reduce((s, a) => s + a.grossUsd, 0),
        totalGasUsd: 0.05,
        gasSavedByBatchUsd: 0.02,
        cctpAttestationSec: 12,
        needsGasSponsorship: false,
      },
    ],
    assets,
    totals: {
      grossUsd: assets.reduce((s, a) => s + a.grossUsd, 0),
      defiGrossUsd: 0,
      liquidGrossUsd: assets.reduce((s, a) => s + a.grossUsd, 0),
      protocolFeeBps: 700,
      protocolFeeUsd: 0,
      singleTxGasUsd: 0.1,
      batchedGasUsd: 0.05,
      gasSavedUsd: 0.05,
      estimatedSlippageUsd: 0.01,
      netSolanaUsdc: 0,
      solEquivalent: 0,
      solPriceUsd: 70,
      defiPositionCount: 0,
      liquidDustCount: assets.length,
      burnCandidateCount: 0,
      honeypotSkippedCount: 0,
      gasNegativeCount: 0,
    },
    warnings: [],
    ...overrides,
  };
}

test('CORS, CSRF, Admin Session, Bearer Auth, and strict body limits harden localhost API', async () => {
  const { server } = createTurgaliumServer({
    allowedOrigins: ['https://trusted.turgalium.example'],
    adminSessionToken: 'admin_secret_xyz_789',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Privileged routes require auth when adminSessionToken is set and MUST NEVER send ACAO: *
    const mandatesUnauth = await fetch(`${base}/api/agents/mandates`);
    assert.equal(mandatesUnauth.status, 401);
    assert.equal(mandatesUnauth.headers.get('access-control-allow-origin'), null);

    const mandatesNoOrigin = await fetch(`${base}/api/agents/mandates`, {
      headers: { 'X-Turgalium-Admin-Session': 'admin_secret_xyz_789' },
    });
    assert.equal(mandatesNoOrigin.status, 200);
    assert.equal(mandatesNoOrigin.headers.get('access-control-allow-origin'), null);

    // 2. Untrusted cross-origin preflight and POSTs are blocked with 403 and no ACAO header
    const evilPreflight = await fetch(`${base}/api/plugin/tokens`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.attacker.com' },
    });
    assert.equal(evilPreflight.status, 403);
    assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null);

    const evilTokenMint = await fetch(`${base}/api/plugin/tokens`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.attacker.com',
        'Content-Type': 'application/json',
        'X-Turgalium-Admin-Session': 'admin_secret_xyz_789',
      },
      body: JSON.stringify({ label: 'Evil', client: 'claude_mcp' }),
    });
    assert.equal(evilTokenMint.status, 403);
    assert.equal(evilTokenMint.headers.get('access-control-allow-origin'), null);

    // Spoofed localhost prefix origin must also be rejected
    const spoofedLocalhost = await fetch(`${base}/api/agents/mandates`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost.evil.com',
        'Content-Type': 'application/json',
        'X-Turgalium-Admin-Session': 'admin_secret_xyz_789',
      },
      body: JSON.stringify({ ownerAddress: SAMPLE_EVM_WALLET_A, lockedSolanaRecipient: SAMPLE_SOLANA_WALLET }),
    });
    assert.equal(spoofedLocalhost.status, 403);

    // Cross-site browser Sec-Fetch-Site header blocked even without Origin
    const crossSiteCsrf = await fetch(`${base}/api/plugin/tokens`, {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
        'X-Turgalium-Admin-Session': 'admin_secret_xyz_789',
      },
      body: JSON.stringify({ label: 'CSRF', client: 'claude_mcp' }),
    });
    assert.equal(crossSiteCsrf.status, 403);

    // Simple text/plain browser CSRF from loopback without application/json rejected with 415
    const textPlainCsrf = await fetch(`${base}/api/plugin/tokens`, {
      method: 'POST',
      headers: {
        Origin: base,
        'Content-Type': 'text/plain',
        'X-Turgalium-Admin-Session': 'admin_secret_xyz_789',
      },
      body: JSON.stringify({ label: 'Plain', client: 'claude_mcp' }),
    });
    assert.equal(textPlainCsrf.status, 415);

    // 3. Explicit loopback and configured TURGALIUM_ALLOWED_ORIGIN are reflected properly
    const loopbackAllowed = await fetch(`${base}/api/agents/mandates`, {
      headers: {
        Origin: 'http://localhost:5173',
        'X-Turgalium-Admin-Session': 'admin_secret_xyz_789',
      },
    });
    assert.equal(loopbackAllowed.status, 200);
    assert.equal(loopbackAllowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(loopbackAllowed.headers.get('vary'), 'Origin');

    const configuredAllowed = await fetch(`${base}/api/agents/mandates`, {
      headers: {
        Origin: 'https://trusted.turgalium.example',
        'X-Turgalium-Admin-Session': 'admin_secret_xyz_789',
      },
    });
    assert.equal(configuredAllowed.status, 200);
    assert.equal(
      configuredAllowed.headers.get('access-control-allow-origin'),
      'https://trusted.turgalium.example'
    );

    // 4. Admin session header required when configured
    const missingAdmin = await fetch(`${base}/api/plugin/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'No Admin', client: 'claude_mcp' }),
    });
    assert.equal(missingAdmin.status, 401);

    const wrongAdmin = await fetch(`${base}/api/plugin/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Turgalium-Admin-Session': 'wrong_token' },
      body: JSON.stringify({ label: 'Wrong Admin', client: 'claude_mcp' }),
    });
    assert.equal(wrongAdmin.status, 401);

    // Valid admin session mints a Claude MCP token
    const issuedRes = await fetch(`${base}/api/plugin/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Turgalium-Admin-Session': 'admin_secret_xyz_789' },
      body: JSON.stringify({ label: 'Claude Desktop', client: 'claude_mcp' }),
    });
    assert.equal(issuedRes.status, 200);
    const issued = await issuedRes.json();
    assert.ok(issued.token.startsWith('turgalium_mcp_'));

    // 5. Missing Bearer token on /mcp is REJECTED with 401
    const noAuthMcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(noAuthMcp.status, 401);

    // Missing Bearer token on external plugin /api/agents/approvals is REJECTED with 401
    const noAuthExternalApproval = await fetch(`${base}/api/agents/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: 'chatgpt_action',
        actionType: 'bridge_solana',
        summary: 'Unauthorized external request',
        sourceWallets: [SAMPLE_EVM_WALLET_A],
        chains: ['base'],
        solanaDestination: SAMPLE_SOLANA_WALLET,
        grossUsd: 20,
        estimatedNetUsdc: 18,
      }),
    });
    assert.equal(noAuthExternalApproval.status, 401);

    // 6. Strict 64 KiB JSON body limit on privileged routes (/mcp) returns 413
    const hugeMcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${issued.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'ping',
        params: { junk: 'x'.repeat(70_000) },
      }),
    });
    assert.equal(hugeMcp.status, 413);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('BoundedTtlCache and BackgroundJobStore enforce LRU capacity and TTL eviction', () => {
  let now = 1_000_000;
  const cache = new BoundedTtlCache<string, number>({
    maxEntries: 2,
    ttlMs: 10_000,
    nowMs: () => now,
  });

  cache.set('a', 1);
  cache.set('b', 2);
  // Touch 'a' so 'b' becomes least-recently-used
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);

  // Advance past TTL -> entries expire
  now += 15_000;
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.size, 0);

  // BackgroundJobStore LRU + TTL
  const jobs = new BackgroundJobStore({ maxJobs: 2, ttlMs: 5_000, nowMs: () => now });
  const j1 = jobs.createJob({
    sourceWallet: SAMPLE_EVM_WALLET_A,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    bridgePreference: 'auto',
    protocolFeeBps: 700,
    feeRecipientEvm: null,
    legs: [{ chain: 'base', assetCount: 1, estimatedNetUsd: 10 }],
  });
  const j2 = jobs.createJob({
    sourceWallet: SAMPLE_EVM_WALLET_A,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    bridgePreference: 'auto',
    protocolFeeBps: 700,
    feeRecipientEvm: null,
    legs: [{ chain: 'arbitrum', assetCount: 1, estimatedNetUsd: 20 }],
  });
  // Access j1 so j2 becomes LRU
  assert.ok(jobs.getJob(j1.jobId));
  const j3 = jobs.createJob({
    sourceWallet: SAMPLE_EVM_WALLET_A,
    solanaDestination: SAMPLE_SOLANA_WALLET,
    outputAsset: 'USDC',
    bridgePreference: 'auto',
    protocolFeeBps: 700,
    feeRecipientEvm: null,
    legs: [{ chain: 'optimism', assetCount: 1, estimatedNetUsd: 30 }],
  });
  assert.equal(jobs.getJob(j2.jobId), null);
  assert.ok(jobs.getJob(j1.jobId));
  assert.ok(jobs.getJob(j3.jobId));

  now += 6_000;
  assert.equal(jobs.getJob(j1.jobId), null);
  assert.equal(jobs.listJobs().length, 0);
  jobs.dispose();
});

test('MCP disables turgalium_create_agent_mandate and stdio MCP proxies to running HTTP server (no split-brain)', async () => {
  // 1. Tool list MUST NOT expose turgalium_create_agent_mandate
  assert.equal(
    TURGALIUM_MCP_TOOLS.some((t) => t.name === 'turgalium_create_agent_mandate'),
    false,
    'turgalium_create_agent_mandate must be removed from TURGALIUM_MCP_TOOLS'
  );

  const { server } = createTurgaliumServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    // Owner creates mandate and MCP token on the HTTP server
    const mandate = await fetch(`${base}/api/agents/mandates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Owner Mandate',
        ownerAddress: SAMPLE_EVM_WALLET_A,
        lockedSolanaRecipient: SAMPLE_SOLANA_WALLET,
        maxPerTxUsd: 200,
        dailyCapUsd: 500,
        autoApproveUnderUsd: 50,
      }),
    }).then((r) => r.json());

    const tok = await fetch(`${base}/api/plugin/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Claude Stdio Proxy', client: 'claude_mcp' }),
    }).then((r) => r.json());

    // 2. Direct attempt to call turgalium_create_agent_mandate over /mcp returns isError: true
    const mintAttempt = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tok.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'turgalium_create_agent_mandate',
          arguments: {
            ownerAddress: SAMPLE_EVM_WALLET_A,
            lockedSolanaRecipient: SAMPLE_SOLANA_WALLET,
            autoApproveUnderUsd: 100000,
          },
        },
      }),
    }).then((r) => r.json());
    assert.equal(mintAttempt.result.isError, true);
    assert.match(mintAttempt.result.content[0].text, /disabled via MCP/i);

    // 3. Stdio MCP dispatcher with TURGALIUM_API_URL proxies cleanly to HTTP server
    const stdioDispatch = createStdioMcpDispatcher({
      apiUrl: base,
      apiToken: tok.token,
    });

    const listResp = (await stdioDispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'turgalium_list_agent_mandates', arguments: {} },
    })) as { result: { structuredContent: { mandates: Array<{ mandateId: string }> } } };
    assert.ok(
      listResp.result.structuredContent.mandates.some((m) => m.mandateId === mandate.mandateId),
      'Stdio proxy must see mandates created in the running HTTP server'
    );

    const proposeResp = (await stdioDispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'turgalium_request_sweep_permission',
        arguments: {
          actionType: 'bridge_solana',
          summary: 'Stdio proxy sweep request',
          sourceWallets: [SAMPLE_EVM_WALLET_A],
          chains: ['base'],
          solanaDestination: SAMPLE_SOLANA_WALLET,
          grossUsd: 120,
          estimatedNetUsdc: 110,
        },
      },
    })) as { result: { structuredContent: { approvalId: string; status: string } } };
    assert.equal(proposeResp.result.structuredContent.status, 'pending_approval');

    // Confirm the approval is visible in the HTTP server's /api/agents/approvals (zero split-brain!)
    const httpApprovals = await fetch(`${base}/api/agents/approvals`).then((r) => r.json());
    assert.ok(
      httpApprovals.approvals.some(
        (a: { approvalId: string }) => a.approvalId === proposeResp.result.structuredContent.approvalId
      ),
      'Approval proposed over stdio proxy must appear in HTTP server UI state'
    );

    // 3b. End-to-end MCP spoofed grossUsd against live scanCache is rejected
    const scanResp = (await stdioDispatch({
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: {
        name: 'turgalium_scan_wallets',
        arguments: { wallets: [{ presetId: 'veteran_defi', label: 'Vault' }] },
      },
    })) as {
      result: {
        structuredContent: {
          topAssets: Array<{ id: string; grossUsd: number; chain: string }>;
        };
      };
    };
    const highValueAsset = scanResp.result.structuredContent.topAssets.find((a) => a.grossUsd > 100);
    assert.ok(highValueAsset, 'Expected high-value asset in veteran_defi scan');

    const spoofMcpResp = (await stdioDispatch({
      jsonrpc: '2.0',
      id: 21,
      method: 'tools/call',
      params: {
        name: 'turgalium_request_sweep_permission',
        arguments: {
          mandateId: mandate.mandateId,
          actionType: 'bridge_solana',
          summary: 'Prompt-injected $1 spoof on high-value scanned asset',
          sourceWallets: [SAMPLE_EVM_WALLET_A],
          chains: [highValueAsset.chain],
          solanaDestination: SAMPLE_SOLANA_WALLET,
          grossUsd: 1,
          estimatedNetUsdc: 0.93,
          assetIds: [highValueAsset.id],
        },
      },
    })) as {
      result: {
        structuredContent: {
          status: string;
          policyChecks: Array<{ check: string; passed: boolean }>;
        };
      };
    };
    assert.equal(spoofMcpResp.result.structuredContent.status, 'rejected');
    assert.ok(
      spoofMcpResp.result.structuredContent.policyChecks.some(
        (c) => c.check === 'Scan Asset Valuation Match' && !c.passed
      )
    );

    // 4. Verify unauthenticated stdio proxy gets JSON-RPC -32001 error
    const unauthProxy = createStdioMcpDispatcher({ apiUrl: base });
    const unauthResp = (await unauthProxy({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })) as { error?: { code: number } };
    assert.equal(unauthResp.error?.code, -32001);

    // 5. Real child-process stdio integration check with TURGALIUM_API_URL & TURGALIUM_API_TOKEN
    const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
    const mcpEntry = path.resolve(process.cwd(), 'src/mcp/server.ts');
    const childResp = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(tsxBin, [mcpEntry], {
        env: { ...process.env, TURGALIUM_API_URL: base, TURGALIUM_API_TOKEN: tok.token },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let errOut = '';
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
        if (out.includes('\n')) {
          const firstLine = out.split('\n')[0].trim();
          child.kill();
          try {
            resolve(JSON.parse(firstLine) as Record<string, unknown>);
          } catch (e) {
            reject(e);
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        errOut += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!out.includes('\n')) {
          reject(new Error(`stdio MCP exited (${code}) without output: ${errOut}`));
        }
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 99,
          method: 'tools/call',
          params: { name: 'turgalium_list_agent_mandates', arguments: {} },
        }) + '\n'
      );
    });
    const childMandates = (
      childResp.result as { structuredContent: { mandates: Array<{ mandateId: string }> } }
    ).structuredContent.mandates;
    assert.ok(childMandates.some((m) => m.mandateId === mandate.mandateId));
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Mandate engine resets spentTodayUsd after rolling 24h window and rejects spoofed grossUsd/estimatedNetUsdc', () => {
  let now = Date.parse('2026-11-25T00:00:00.000Z');
  const engine = new TurgaliumAgentEngine({ nowMs: () => now });

  const mandate = engine.createMandate({
    name: 'Rolling Cap Test',
    ownerAddress: SAMPLE_EVM_WALLET_A,
    lockedSolanaRecipient: SAMPLE_SOLANA_WALLET,
    maxPerTxUsd: 50,
    dailyCapUsd: 80,
    autoApproveUnderUsd: 50,
    durationDays: 10,
    allowedActions: ['dust_convert', 'bridge_solana'],
  });

  // Spend $40 + $40 = $80 daily cap
  const r1 = engine.requestPermission({
    client: 'smart_contract_agent',
    mandateId: mandate.mandateId,
    actionType: 'dust_convert',
    summary: 'Batch 1',
    sourceWallets: [SAMPLE_EVM_WALLET_A],
    chains: ['base'],
    solanaDestination: SAMPLE_SOLANA_WALLET,
    grossUsd: 40,
    estimatedNetUsdc: 36,
  });
  assert.equal(r1.status, 'auto_approved_by_mandate');

  const r2 = engine.requestPermission({
    client: 'smart_contract_agent',
    mandateId: mandate.mandateId,
    actionType: 'dust_convert',
    summary: 'Batch 2',
    sourceWallets: [SAMPLE_EVM_WALLET_A],
    chains: ['base'],
    solanaDestination: SAMPLE_SOLANA_WALLET,
    grossUsd: 40,
    estimatedNetUsdc: 36,
  });
  assert.equal(r2.status, 'auto_approved_by_mandate');
  assert.equal(engine.getMandate(mandate.mandateId)?.spentTodayUsd, 80);
  assert.equal(engine.getMandate(mandate.mandateId)?.remainingDailyUsd, 0);

  // Within the same 24h window -> exceeds daily cap -> hard mandate violation immediately rejected (HIGH-3)
  now += 12 * 3600 * 1000;
  const r3 = engine.requestPermission({
    client: 'smart_contract_agent',
    mandateId: mandate.mandateId,
    actionType: 'dust_convert',
    summary: 'Batch 3 same day',
    sourceWallets: [SAMPLE_EVM_WALLET_A],
    chains: ['base'],
    solanaDestination: SAMPLE_SOLANA_WALLET,
    grossUsd: 25,
    estimatedNetUsdc: 22,
  });
  assert.equal(r3.status, 'rejected');

  // Advance past 24h window -> spentTodayUsd resets cleanly matching TurgaliumAgentVault.sol!
  now += 12 * 3600 * 1000 + 1000;
  const refreshed = engine.getMandate(mandate.mandateId);
  assert.equal(refreshed?.spentTodayUsd, 0);
  assert.equal(refreshed?.remainingDailyUsd, 80);

  const r4 = engine.requestPermission({
    client: 'smart_contract_agent',
    mandateId: mandate.mandateId,
    actionType: 'dust_convert',
    summary: 'Batch 4 next day',
    sourceWallets: [SAMPLE_EVM_WALLET_A],
    chains: ['base'],
    solanaDestination: SAMPLE_SOLANA_WALLET,
    grossUsd: 30,
    estimatedNetUsdc: 27,
  });
  assert.equal(r4.status, 'auto_approved_by_mandate');
  assert.equal(engine.getMandate(mandate.mandateId)?.spentTodayUsd, 30);

  // Spoofed grossUsd attack: real scanned asset is $5,000, attacker claims $1 to sneak under $50 auto tier!
  const whaleAsset = makeAsset({
    id: 'w0_eth:usdc_5000',
    chain: 'ethereum',
    chainName: 'Ethereum',
    symbol: 'USDC',
    grossUsd: 5000,
    netRoiUsd: 4645,
    netUsdcBatched: 4645,
  });
  const badDustAsset = makeAsset({
    id: 'w0_eth:neg_dust',
    chain: 'ethereum',
    chainName: 'Ethereum',
    symbol: 'TINY',
    grossUsd: 2,
    netRoiUsd: -1.5,
    netUsdcBatched: -1.5,
  });
  const scanReport = makeReport([whaleAsset, badDustAsset]);

  const spoofAttempt = engine.requestPermission({
    client: 'claude_mcp',
    mandateId: mandate.mandateId,
    actionType: 'bridge_solana',
    summary: 'Prompt-injected spoofed $1 claim on $5,000 USDC',
    sourceWallets: [SAMPLE_EVM_WALLET_A],
    chains: ['ethereum'],
    solanaDestination: SAMPLE_SOLANA_WALLET,
    grossUsd: 1,
    estimatedNetUsdc: 0.93,
    assetIds: ['w0_eth:usdc_5000'],
    scanCache: [scanReport],
  });
  assert.equal(spoofAttempt.status, 'rejected');
  assert.ok(
    spoofAttempt.policyChecks.some((c) => c.check === 'Scan Asset Valuation Match' && !c.passed)
  );
  // Mandate budget must NOT be consumed by rejected spoof attempt
  assert.equal(engine.getMandate(mandate.mandateId)?.spentTodayUsd, 30);

  // Spoofed positive ROI on a negative-ROI asset must also be rejected
  const spoofRoiAttempt = engine.requestPermission({
    client: 'claude_mcp',
    mandateId: mandate.mandateId,
    actionType: 'dust_convert',
    summary: 'Spoofed positive net on negative ROI asset',
    sourceWallets: [SAMPLE_EVM_WALLET_A],
    chains: ['ethereum'],
    solanaDestination: SAMPLE_SOLANA_WALLET,
    grossUsd: 2,
    estimatedNetUsdc: 1.8,
    assetIds: ['w0_eth:neg_dust'],
    scanCache: [scanReport],
  });
  assert.equal(spoofRoiAttempt.status, 'rejected');

  // Unverified/fabricated assetIds must NEVER auto-approve
  const unverifiedAttempt = engine.requestPermission({
    client: 'claude_mcp',
    mandateId: mandate.mandateId,
    actionType: 'dust_convert',
    summary: 'Unknown assetId',
    sourceWallets: [SAMPLE_EVM_WALLET_A],
    chains: ['base'],
    solanaDestination: SAMPLE_SOLANA_WALLET,
    grossUsd: 10,
    estimatedNetUsdc: 9,
    assetIds: ['fabricated_asset_id'],
    scanCache: [scanReport],
  });
  assert.equal(unverifiedAttempt.status, 'pending_approval');

  // Constant-time token verification checks strict Bearer prefix and revocation
  const issued = engine.issuePluginToken({ label: 'ConstTime', client: 'claude_mcp' });
  assert.ok(engine.verifyPluginToken(`Bearer ${issued.token}`));
  assert.equal(engine.verifyPluginToken(issued.token), null); // missing Bearer prefix
  assert.equal(engine.verifyPluginToken(`Bearer ${issued.token}x`), null);
  engine.revokePluginToken(issued.record.tokenId);
  assert.equal(engine.verifyPluginToken(`Bearer ${issued.token}`), null);
});

test('Case-sensitive address deduplication, per-(wallet, chain) dust/ROI batching, and mixed-ecosystem family preservation', async () => {
  // 1. Case-insensitive ecosystems deduplicate; case-sensitive Base58 / Base64url DO NOT collide!
  assert.equal(
    normalizeWalletDedupKey({ address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F' }),
    normalizeWalletDedupKey({ address: '0x71c7656ec7ab88b098defb751b7401b5f6d8976f' })
  );
  assert.equal(
    normalizeWalletDedupKey({ address: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh' }),
    normalizeWalletDedupKey({ address: 'COSMOS1FL48VSNMSDZCV85Q5D2Q4Z5AJDHA8YU34MF0EH', family: 'cosmos' })
  );
  assert.equal(
    normalizeWalletDedupKey({ address: 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97' }),
    normalizeWalletDedupKey({ address: 'BC1QGDJQV0AV3Q56JVD82TKDJPY7GDP9UT8TLQMGRPMV24SQ90ECNVQQJWVW97', family: 'btc' })
  );

  // Tron Base58: differing case MUST produce distinct keys
  const tronA = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL';
  const tronB = 'TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqel';
  assert.notEqual(
    normalizeWalletDedupKey({ address: tronA, family: 'tron' }),
    normalizeWalletDedupKey({ address: tronB, family: 'tron' })
  );

  // TON Base64url: differing case MUST produce distinct keys
  const tonA = 'EQDtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2';
  const tonB = 'EQdtFpEwcFAEcRe5mLVh2N6C0x-_hJEM7W61_JLnSF74p4q2';
  assert.notEqual(
    normalizeWalletDedupKey({ address: tonA, family: 'ton' }),
    normalizeWalletDedupKey({ address: tonB, family: 'ton' })
  );

  // Bitcoin Base58Check (legacy 1...): differing case MUST produce distinct keys
  const btcLegacyA = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const btcLegacyB = '1a1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  assert.notEqual(
    normalizeWalletAddressForKey(btcLegacyA, 'btc'),
    normalizeWalletAddressForKey(btcLegacyB, 'btc')
  );

  // Solana Base58: differing case MUST preserve case
  const solA = SAMPLE_SOLANA_WALLET;
  const solB = SAMPLE_SOLANA_WALLET.toLowerCase();
  assert.notEqual(normalizeWalletAddressForKey(solA), normalizeWalletAddressForKey(solB));

  // 2. Two separate EOAs on Base MUST be modeled as 2 separate batches in dust.ts & roi.ts!
  const walletADust1 = makeAsset({
    id: 'w0_base:a1',
    sourceWallet: SAMPLE_EVM_WALLET_A,
    sourceWalletLabel: 'EOA Alpha',
    grossUsd: 3.0,
  });
  const walletADust2 = makeAsset({
    id: 'w0_base:a2',
    sourceWallet: SAMPLE_EVM_WALLET_A,
    sourceWalletLabel: 'EOA Alpha',
    grossUsd: 2.5,
  });
  const walletBDust1 = makeAsset({
    id: 'w1_base:b1',
    sourceWallet: SAMPLE_EVM_WALLET_B,
    sourceWalletLabel: 'EOA Beta',
    grossUsd: 3.0,
  });
  const walletBDust2 = makeAsset({
    id: 'w1_base:b2',
    sourceWallet: SAMPLE_EVM_WALLET_B,
    sourceWalletLabel: 'EOA Beta',
    grossUsd: 2.5,
  });

  const multiEoaScan = makeReport([walletADust1, walletADust2, walletBDust1, walletBDust2], {
    walletAddress: `${SAMPLE_EVM_WALLET_A},${SAMPLE_EVM_WALLET_B}`,
    walletLabel: 'Unified (2 wallets · 1 ecosystem)',
  });

  const dustPlan = planDustConversion({ scan: multiEoaScan, maxDustThresholdUsd: 25 });
  const baseDustPlans = dustPlan.chains.filter((c) => c.chain === 'base');
  assert.equal(baseDustPlans.length, 2, 'Two distinct EOAs on Base must produce 2 separate dust batches');
  assert.ok(baseDustPlans.some((c) => c.sourceWallet === SAMPLE_EVM_WALLET_A));
  assert.ok(baseDustPlans.some((c) => c.sourceWallet === SAMPLE_EVM_WALLET_B));
  assert.equal(baseDustPlans[0].dustTokenCount, 2);
  assert.equal(baseDustPlans[1].dustTokenCount, 2);

  // Portfolio ROI also separates by (sourceWallet, chain)
  const portfolioRoi = evaluatePortfolioRoi(multiEoaScan);
  const baseRoiPlans = portfolioRoi.chains.filter((c) => c.chain === 'base');
  assert.equal(baseRoiPlans.length, 2, 'evaluatePortfolioRoi must keep 2 EOAs on Base separate');
  assert.ok(baseRoiPlans.every((c) => c.bridgeFixedFeeUsd === 0.16));

  // Verify a rich EOA cannot falsely rescue an unprofitable EOA on the same chain in applyTwoLevelRoiToReport
  const richWalletA = makeAsset({
    id: 'w0_base:rich',
    sourceWallet: SAMPLE_EVM_WALLET_A,
    sourceWalletLabel: 'Rich EOA',
    grossUsd: 500,
    estimatedGasUsd: 0.04,
    batchedGasUsd: 0.02,
  });
  const tinyWalletB = makeAsset({
    id: 'w1_base:tiny',
    sourceWallet: SAMPLE_EVM_WALLET_B,
    sourceWalletLabel: 'Tiny EOA',
    grossUsd: 0.25,
    estimatedGasUsd: 0.03,
    batchedGasUsd: 0.015,
  });
  const mixedRoiReport = applyTwoLevelRoiToReport(
    makeReport([richWalletA, tinyWalletB], {
      walletAddress: `${SAMPLE_EVM_WALLET_A},${SAMPLE_EVM_WALLET_B}`,
    })
  );
  const resRich = mixedRoiReport.assets.find((a) => a.id === 'w0_base:rich');
  const resTiny = mixedRoiReport.assets.find((a) => a.id === 'w1_base:tiny');
  assert.equal(resRich?.selectedByDefault, true);
  assert.equal(
    resTiny?.selectedByDefault,
    false,
    'Tiny EOA on Base must NOT be falsely rescued by another EOA balance on Base'
  );

  // 3. Mixed-ecosystem unified scan sets report.family = 'mixed' instead of mislabeling as 'evm',
  //    preserves per-asset family, and preserves per-leg family in buildMigrationPlan!
  const origCosmosScan = cosmosAdapter.scanWallet.bind(cosmosAdapter);
  cosmosAdapter.scanWallet = async (address: string): Promise<ScanReport> => ({
    scanId: 'scan_cosmos_mock',
    family: 'cosmos',
    mode: 'live_rpc',
    walletAddress: address,
    walletLabel: 'Keplr Cosmos',
    scannedAt: new Date().toISOString(),
    scanDurationMs: 2,
    chainsScanned: 1,
    chains: [
      {
        family: 'cosmos',
        chain: 'cosmoshub',
        chainName: 'Cosmos Hub',
        chainId: 'cosmoshub-4',
        cctpDomain: 4,
        rpcStatus: 'live',
        blockNumber: 100,
        gasPriceGwei: 0.01,
        nativeBalance: 10,
        nativeSymbol: 'ATOM',
        nativePriceUsd: 5,
        assetCount: 1,
        defiCount: 0,
        liquidCount: 1,
        burnCount: 0,
        skippedCount: 0,
        grossUsd: 50,
        netUsdcBridged: 46,
        totalGasUsd: 0.02,
        gasSavedByBatchUsd: 0.01,
        cctpAttestationSec: 12,
        needsGasSponsorship: true,
      },
    ],
    assets: [
      makeAsset({
        id: 'cosmoshub:uatom',
        family: 'cosmos',
        chain: 'cosmoshub',
        chainName: 'Cosmos Hub',
        address: 'uatom',
        symbol: 'ATOM',
        name: 'Cosmos ATOM',
        decimals: 6,
        kind: 'native',
        grossUsd: 50,
        netUsdcSingle: 46,
        netUsdcBatched: 46,
      }),
    ],
    totals: {
      grossUsd: 50,
      defiGrossUsd: 0,
      liquidGrossUsd: 50,
      protocolFeeBps: 700,
      protocolFeeUsd: 3.5,
      singleTxGasUsd: 0.04,
      batchedGasUsd: 0.02,
      gasSavedUsd: 0.02,
      estimatedSlippageUsd: 0.1,
      netSolanaUsdc: 46.38,
      solEquivalent: 0.66,
      solPriceUsd: 70,
      defiPositionCount: 0,
      liquidDustCount: 1,
      burnCandidateCount: 0,
      honeypotSkippedCount: 0,
      gasNegativeCount: 0,
    },
    warnings: [],
  });
  try {
    const mixedUnified = await scanUnifiedWallets({
      wallets: [
        { presetId: 'veteran_defi', label: 'EVM Main' },
        {
          address: 'cosmos1fl48vsnmsdzcv85q5d2q4z5ajdha8yu34mf0eh',
          label: 'Keplr Cosmos',
          family: 'cosmos',
        },
      ],
    });
    assert.equal(mixedUnified.family, 'mixed', 'Mixed-ecosystem scan must NOT be mislabeled as evm');
    assert.deepEqual(mixedUnified.families?.slice().sort(), ['cosmos', 'evm']);
    assert.ok(mixedUnified.assets.some((a) => a.family === 'evm'));
    assert.ok(mixedUnified.assets.some((a) => a.family === 'cosmos' && a.chain === 'cosmoshub'));

    const mixedPlan = buildMigrationPlan({
      scan: mixedUnified,
      solanaDestination: SAMPLE_SOLANA_WALLET,
    });
    assert.equal(mixedPlan.family, 'mixed');
    const cosmosLeg = mixedPlan.legs.find((l) => l.chain === 'cosmoshub');
    const evmLeg = mixedPlan.legs.find((l) => l.chain === 'base');
    assert.equal(cosmosLeg?.family, 'cosmos');
    assert.equal(evmLeg?.family, 'evm');
  } finally {
    cosmosAdapter.scanWallet = origCosmosScan;
  }
});

test('TurgaliumAgentVault.sol enforces single-bit actionBit validation and authorizedRouter guard', () => {
  const vaultPath = path.resolve(process.cwd(), 'contracts/TurgaliumAgentVault.sol');
  const sol = fs.readFileSync(vaultPath, 'utf8');

  // Single-bit actionBit check
  assert.ok(
    sol.includes('actionBit == 0 || (actionBit & (actionBit - 1)) != 0'),
    'TurgaliumAgentVault must enforce single-bit actionBit validation'
  );
  assert.ok(sol.includes('error InvalidActionBit(uint8 actionBit);'));

  // Explicit authorizedRouter & setRouter / setMandateRouter guard
  assert.ok(sol.includes('address public authorizedRouter;'));
  assert.ok(sol.includes('function setRouter(address newRouter)'));
  assert.ok(sol.includes('function setMandateRouter(bytes32 mandateId, address newRouter)'));
  assert.ok(sol.includes('error UnauthorizedRouter(address caller, address expectedRouter);'));
  assert.ok(sol.includes('if (msg.sender != expectedRouter) revert UnauthorizedRouter(msg.sender, expectedRouter);'));
});
