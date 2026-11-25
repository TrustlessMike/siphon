import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHAIN_LIST, EVM_CHAINS, TOKEN_REGISTRY } from '../src/scanner/chains.js';
import {
  BURN_RECEIPT_CSV_HEADER,
  formatBurnReceiptCsv,
  sanitizeCsvCell,
} from '../src/scanner/sanitize.js';
import type { EvmChainId } from '../src/scanner/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function loadFrontendCsvCell(): (val: unknown) => string {
  const appJs = fs.readFileSync(path.join(REPO_ROOT, 'public/app.js'), 'utf8');
  const match = appJs.match(/function csvCell\(val\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, 'Expected function csvCell(val) in public/app.js');
  // Execute the pure helper function in isolation to verify exact parity with sanitizeCsvCell
  return new Function(`${match[0]}; return csvCell;`)() as (val: unknown) => string;
}

test('CSV formula injection payloads and CR/LF control characters are neutralized (backend + frontend parity)', () => {
  const frontendCsvCell = loadFrontendCsvCell();

  const formulaPayloads: Array<{ input: string; desc: string }> = [
    { input: "=CMD|' /C calc'!A0", desc: 'Excel DDE =CMD payload' },
    { input: '+SUM(A1:A2)', desc: 'Leading + formula' },
    { input: '@HYPERLINK("http://evil.example","Click")', desc: 'Leading @ formula with quotes' },
    { input: '-1+1', desc: 'Leading - formula' },
    { input: '\t=1+1', desc: 'Leading tab formula' },
    { input: '\r=1+1', desc: 'Leading CR formula' },
    { input: '\n=CMD|calc', desc: 'Leading LF formula' },
    { input: '  =IMPORTXML("http://evil.example","//a")', desc: 'Leading spaces + formula' },
    { input: '\r\n+2+3', desc: 'Leading CRLF + formula' },
  ];

  for (const { input, desc } of formulaPayloads) {
    const serverOut = sanitizeCsvCell(input);
    const clientOut = frontendCsvCell(input);

    assert.equal(clientOut, serverOut, `Frontend/backend csvCell parity mismatch for ${desc}`);
    assert.ok(
      serverOut.startsWith('"\''),
      `Expected leading single-quote neutralization for ${desc}, got: ${serverOut}`
    );
    assert.ok(serverOut.endsWith('"'), `Expected RFC-4180 closing quote for ${desc}, got: ${serverOut}`);
    assert.ok(!serverOut.includes('\r'), `Expected no raw CR in ${desc}, got: ${JSON.stringify(serverOut)}`);
    assert.ok(!serverOut.includes('\n'), `Expected no raw LF in ${desc}, got: ${JSON.stringify(serverOut)}`);
  }

  // Internal CR/LF and NUL control characters must be stripped without splitting CSV rows
  const multiline = 'SafeToken\r\n=CMD|calc\u0000\nNextRow';
  const cleaned = sanitizeCsvCell(multiline);
  assert.equal(frontendCsvCell(multiline), cleaned);
  assert.ok(!cleaned.includes('\r') && !cleaned.includes('\n') && !cleaned.includes('\u0000'));
  assert.equal(cleaned, '"SafeToken =CMD|calc NextRow"');

  // RFC-4180 quote doubling & safe values untouched
  assert.equal(sanitizeCsvCell('Token "Quoted", v2'), '"Token ""Quoted"", v2"');
  assert.equal(frontendCsvCell('Token "Quoted", v2'), '"Token ""Quoted"", v2"');
  assert.equal(sanitizeCsvCell('BURN_READY'), '"BURN_READY"');
  assert.equal(sanitizeCsvCell(null), '""');
  assert.equal(sanitizeCsvCell(undefined), '""');
});

test('formatBurnReceiptCsv produces exact row count with neutralized malicious burn manifest entries', () => {
  const rows = [
    {
      chain: 'polygon',
      symbol: "=CMD|' /C calc'!A0",
      tokenAddress: '0x1111111111111111111111111111111111111111',
      amount: '1000',
      status: 'BURN_READY',
      burnSink: '0x000000000000000000000000000000000000dEaD',
      reason: '+SUM(A1:A2)\r\n=EVIL',
    },
    {
      chain: 'base',
      symbol: '@HYPERLINK("http://evil.example","x")',
      tokenAddress: '0x2222222222222222222222222222222222222222',
      amount: '50',
      status: 'SKIPPED_HONEYPOT',
      burnSink: '0x000000000000000000000000000000000000dEaD',
      reason: '-1+1',
    },
  ];

  const csv = formatBurnReceiptCsv(rows);
  assert.ok(!csv.includes('\r'), 'CSV output must not contain CR characters');
  const lines = csv.split('\n');
  assert.equal(lines.length, 3, `Expected 1 header + 2 data rows, got ${lines.length}`);
  assert.equal(lines[0], BURN_RECEIPT_CSV_HEADER);
  assert.ok(lines[1].includes('"\'=CMD|\' /C calc\'!A0"'), lines[1]);
  assert.ok(lines[1].includes('"\'+SUM(A1:A2) =EVIL"'), lines[1]);
  assert.ok(lines[2].includes('"\'@HYPERLINK(""http://evil.example"",""x"")"'), lines[2]);
  assert.ok(lines[2].includes('"\'-1+1"'), lines[2]);
});

test('All 14 EVM chains define safe positive gasReserveNative reserves (including Polygon spike safety)', () => {
  const expectedChains: EvmChainId[] = [
    'ethereum',
    'base',
    'arbitrum',
    'optimism',
    'polygon',
    'avalanche',
    'bnb',
    'sonic',
    'unichain',
    'linea',
    'scroll',
    'mantle',
    'blast',
    'worldchain',
  ];

  assert.equal(CHAIN_LIST.length, 14, `Expected 14 EVM chains, got ${CHAIN_LIST.length}`);
  assert.deepEqual(
    new Set(CHAIN_LIST.map((c) => c.id)),
    new Set(expectedChains),
    'EVM_CHAINS keys must match all 14 supported EVM chains'
  );

  for (const chain of CHAIN_LIST) {
    assert.equal(typeof chain.gasReserveNative, 'number', `${chain.id} missing numeric gasReserveNative`);
    assert.ok(
      Number.isFinite(chain.gasReserveNative) && chain.gasReserveNative > 0,
      `${chain.id} gasReserveNative must be finite and > 0 (got ${chain.gasReserveNative})`
    );
  }

  // Polygon specifically must NOT use the stranding 0.0005 POL reserve
  assert.ok(
    EVM_CHAINS.polygon.gasReserveNative >= 0.05,
    `Polygon gasReserveNative too low (${EVM_CHAINS.polygon.gasReserveNative} POL); expected >= 0.05 POL`
  );

  // Non-ETH native gas chains require adequate reserves for mainnet gas & spikes
  assert.ok(EVM_CHAINS.avalanche.gasReserveNative >= 0.02, 'Avalanche reserve too low');
  assert.ok(EVM_CHAINS.bnb.gasReserveNative >= 0.003, 'BNB Chain reserve too low');
  assert.ok(EVM_CHAINS.sonic.gasReserveNative >= 0.05, 'Sonic reserve too low');
  assert.ok(EVM_CHAINS.mantle.gasReserveNative >= 0.05, 'Mantle reserve too low');

  // ETH-denominated chains
  assert.ok(EVM_CHAINS.ethereum.gasReserveNative >= 0.002, 'Ethereum L1 reserve too low');
  assert.ok(EVM_CHAINS.linea.gasReserveNative >= 0.0008, 'Linea reserve too low');
  assert.ok(EVM_CHAINS.scroll.gasReserveNative >= 0.0008, 'Scroll reserve too low');
  for (const l2 of ['base', 'arbitrum', 'optimism', 'unichain', 'blast', 'worldchain'] as const) {
    assert.ok(EVM_CHAINS[l2].gasReserveNative >= 0.0005, `${l2} reserve too low`);
  }
});

test('Curated BNB Chain Aave v3 DeFi entries are canonical, well-formed, and registry has no duplicate addresses', () => {
  const bnbPool = EVM_CHAINS.bnb.aaveV3Pool;
  assert.equal(bnbPool, '0x6807dc923806fE8Fd134338EABCA509979a7e0cB');

  const expectedBnbAave = [
    {
      symbol: 'aBnbUSDC',
      address: '0x00901a076785e0906d1028c7d6372d247bec7d61',
      underlyingSymbol: 'USDC',
      underlyingAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      decimals: 18,
    },
    {
      symbol: 'aBnbUSDT',
      address: '0xa9251ca9DE909CB71783723713B21E4233fbf1B1',
      underlyingSymbol: 'USDT',
      underlyingAddress: '0x55d398326f99059fF775485246999027B3197955',
      decimals: 18,
    },
    {
      symbol: 'aBnbWBNB',
      address: '0x9B00a09492a626678E5A3009982191586C444Df9',
      underlyingSymbol: 'WBNB',
      underlyingAddress: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
      decimals: 18,
    },
  ];

  for (const exp of expectedBnbAave) {
    const entry = TOKEN_REGISTRY.find((t) => t.chain === 'bnb' && t.symbol === exp.symbol);
    assert.ok(entry, `Missing curated BNB Aave v3 entry: ${exp.symbol}`);
    assert.equal(entry.kind, 'defi_position');
    assert.equal(entry.protocol, 'Aave v3');
    assert.equal(entry.protocolAddress, bnbPool);
    assert.equal(entry.address, exp.address);
    assert.equal(entry.underlyingSymbol, exp.underlyingSymbol);
    assert.equal(entry.underlyingAddress, exp.underlyingAddress);
    assert.equal(entry.decimals, exp.decimals);
    assert.match(entry.address, /^0x[0-9a-fA-F]{40}$/);
  }

  // Registry hygiene: no duplicate (chain, address) entries
  const seen = new Set<string>();
  for (const tok of TOKEN_REGISTRY) {
    const key = `${tok.chain}:${tok.address.toLowerCase()}`;
    assert.ok(!seen.has(key), `Duplicate TOKEN_REGISTRY entry detected: ${key} (${tok.symbol})`);
    seen.add(key);
  }
});
