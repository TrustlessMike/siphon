import type { ChainConfig, TokenDescriptor } from './types.js';

const BALANCE_OF_SELECTOR = '70a08231'; // balanceOf(address)
const AGGREGATE3_SELECTOR = '82ad56cb'; // aggregate3((address,bool,bytes)[])

function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function pad32(hex: string): string {
  return strip0x(hex).toLowerCase().padStart(64, '0');
}

export function isValidEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr.trim());
}

export function formatUnits(raw: bigint, decimals: number): number {
  if (raw === 0n) return 0;
  const s = raw.toString().padStart(decimals + 1, '0');
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals).slice(0, 8);
  return Number(`${intPart}.${fracPart}`);
}

/**
 * Encodes Multicall3.aggregate3((address target, bool allowFailure, bytes callData)[])
 * purely in TypeScript with zero heavy web3 dependencies.
 */
export function encodeMulticall3Aggregate3(
  calls: Array<{ target: string; allowFailure: boolean; callData: string }>
): string {
  const n = calls.length;
  const headerChunks: string[] = [
    pad32('20'), // offset to array
    pad32(n.toString(16)), // array length
  ];

  // Build encoded tuple elements
  const encodedElements: string[] = calls.map((c) => {
    const dataHex = strip0x(c.callData);
    const dataByteLen = dataHex.length / 2;
    const paddedData = dataHex.padEnd(Math.ceil(dataHex.length / 64) * 64, '0');
    return (
      pad32(c.target) +
      pad32(c.allowFailure ? '1' : '0') +
      pad32('60') + // offset to bytes inside tuple (3 words = 0x60)
      pad32(dataByteLen.toString(16)) +
      paddedData
    );
  });

  // Offsets for each tuple relative to start of tuple offset table
  const offsets: string[] = [];
  let runningBytes = n * 32;
  for (const el of encodedElements) {
    offsets.push(pad32(runningBytes.toString(16)));
    runningBytes += el.length / 2;
  }

  return '0x' + AGGREGATE3_SELECTOR + headerChunks.join('') + offsets.join('') + encodedElements.join('');
}

/**
 * Decodes Multicall3.aggregate3 return bytes: (bool success, bytes returnData)[]
 */
export function decodeMulticall3Aggregate3(
  hexResult: string
): Array<{ success: boolean; returnData: string }> {
  const raw = strip0x(hexResult);
  if (raw.length < 128) return [];

  const arrayOffset = Number(BigInt('0x' + raw.slice(0, 64))) * 2;
  const count = Number(BigInt('0x' + raw.slice(arrayOffset, arrayOffset + 64)));
  const tableStart = arrayOffset + 64;
  const out: Array<{ success: boolean; returnData: string }> = [];

  for (let i = 0; i < count; i++) {
    const relOffset = Number(BigInt('0x' + raw.slice(tableStart + i * 64, tableStart + (i + 1) * 64))) * 2;
    const itemStart = tableStart + relOffset;
    const success = BigInt('0x' + raw.slice(itemStart, itemStart + 64)) === 1n;
    const bytesRel = Number(BigInt('0x' + raw.slice(itemStart + 64, itemStart + 128))) * 2;
    const bytesStart = itemStart + bytesRel;
    const byteLen = Number(BigInt('0x' + raw.slice(bytesStart, bytesStart + 64)));
    const dataHex = raw.slice(bytesStart + 64, bytesStart + 64 + byteLen * 2);
    out.push({ success, returnData: '0x' + dataHex });
  }
  return out;
}

export async function evmJsonRpcBatch(
  rpcUrls: string[],
  requests: Array<{ id: number; method: string; params: unknown[] }>,
  timeoutMs = 4500
): Promise<Array<{ id: number; result?: string; error?: { message: string; code?: number } }>> {
  let lastErr: unknown;
  for (const rpcUrl of rpcUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requests.map((r) => ({ jsonrpc: '2.0', ...r }))),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`RPC HTTP ${res.status} (${rpcUrl})`);
        continue;
      }
      const parsed = await res.json();
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      if (!arr.length || (arr.length === 1 && !arr[0]?.result && arr[0]?.error && requests.length > 1)) {
        // Some public RPCs disable JSON-RPC batch arrays — fall back to parallel single calls on this endpoint
        try {
          const singles = await Promise.all(
            requests.map(async (r) => {
              const c2 = new AbortController();
              const t2 = setTimeout(() => c2.abort(), timeoutMs);
              try {
                const sRes = await fetch(rpcUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', ...r }),
                  signal: c2.signal,
                });
                clearTimeout(t2);
                if (!sRes.ok) return { id: r.id, error: { message: `HTTP ${sRes.status}` } };
                return (await sRes.json()) as { id: number; result?: string; error?: { message: string; code?: number } };
              } catch (e2) {
                clearTimeout(t2);
                return { id: r.id, error: { message: e2 instanceof Error ? e2.message : String(e2) } };
              }
            })
          );
          if (singles.some((s) => s.result !== undefined)) {
            return singles;
          }
        } catch {
          // continue to next RPC
        }
        lastErr = new Error(arr[0]?.error?.message ?? 'Empty batch response');
        continue;
      }
      return arr;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'All RPC endpoints failed'));
}

export async function evmJsonRpcCall<T = string>(
  rpcUrls: string[],
  method: string,
  params: unknown[],
  timeoutMs = 3800
): Promise<{ result?: T; error?: { message?: string; code?: number } }> {
  let lastErr: unknown;
  for (const rpcUrl of rpcUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`RPC HTTP ${res.status} (${rpcUrl})`);
        continue;
      }
      const json = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
      if (json.result !== undefined) {
        return json;
      }
      if (json.error !== undefined) {
        // Application-level EVM execution revert is a valid onchain answer;
        // RPC provider errors (usage/rate limits, auth, internal errors) MUST fail over to the next RPC URL!
        const errMsg = (json.error.message ?? '').toLowerCase();
        const isExecutionRevert =
          json.error.code === 3 ||
          errMsg.includes('revert') ||
          errMsg.includes('invalid opcode') ||
          errMsg.includes('out of gas');
        if (isExecutionRevert) {
          return json;
        }
        lastErr = new Error(json.error.message ?? `RPC error ${json.error.code ?? ''}`);
        continue;
      }
      lastErr = new Error('Empty JSON-RPC response');
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'All RPC endpoints failed'));
}

export interface LiveChainScanOutput {
  chain: ChainConfig;
  ok: boolean;
  error?: string;
  blockNumber: number;
  gasPriceWei: bigint;
  nativeBalanceWei: bigint;
  tokenBalances: Map<string, bigint>;
}

/**
 * Queries one EVM chain in a SINGLE HTTP JSON-RPC batch:
 *   1. eth_blockNumber
 *   2. eth_gasPrice
 *   3. eth_getBalance(wallet)
 *   4. eth_call(Multicall3.aggregate3) for all registered ERC-20 & DeFi receipt tokens
 */
export async function scanSingleEvmChain(
  chain: ChainConfig,
  walletAddress: string,
  tokens: TokenDescriptor[]
): Promise<LiveChainScanOutput> {
  const balanceCallData = '0x' + BALANCE_OF_SELECTOR + pad32(walletAddress);
  const multicallData = encodeMulticall3Aggregate3(
    tokens.map((t) => ({
      target: t.address,
      allowFailure: true,
      callData: balanceCallData,
    }))
  );

  try {
    const urls = chain.rpcUrls?.length ? chain.rpcUrls : [chain.rpcUrl];
    const batch = await evmJsonRpcBatch(urls, [
      { id: 1, method: 'eth_blockNumber', params: [] },
      { id: 2, method: 'eth_gasPrice', params: [] },
      { id: 3, method: 'eth_getBalance', params: [walletAddress, 'latest'] },
      {
        id: 4,
        method: 'eth_call',
        params: [{ to: chain.multicall3, data: multicallData }, 'latest'],
      },
    ]);

    const byId = new Map(batch.map((r) => [r.id, r]));
    const blockHex = byId.get(1)?.result ?? '0x0';
    const gasHex = byId.get(2)?.result ?? '0x3b9aca00';
    const balHex = byId.get(3)?.result ?? '0x0';
    const mcHex = byId.get(4)?.result ?? '0x';

    const tokenBalances = new Map<string, bigint>();
    const decoded = decodeMulticall3Aggregate3(mcHex);
    for (let i = 0; i < Math.min(tokens.length, decoded.length); i++) {
      const item = decoded[i];
      if (!item.success) continue;
      const clean = strip0x(item.returnData);
      if (clean.length < 64) continue;
      const val = BigInt('0x' + clean.slice(0, 64));
      if (val > 0n) {
        tokenBalances.set(tokens[i].address.toLowerCase(), val);
      }
    }

    return {
      chain,
      ok: true,
      blockNumber: Number(BigInt(blockHex)),
      gasPriceWei: BigInt(gasHex),
      nativeBalanceWei: BigInt(balHex),
      tokenBalances,
    };
  } catch (err) {
    return {
      chain,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      blockNumber: 0,
      gasPriceWei: 1_000_000_000n,
      nativeBalanceWei: 0n,
      tokenBalances: new Map(),
    };
  }
}
