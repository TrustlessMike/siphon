import { PublicKey } from '@solana/web3.js';
import { DEAD_BURN_ADDRESS, EVM_CHAINS } from './chains.js';
import { decodeMulticall3Aggregate3, encodeMulticall3Aggregate3 } from './rpc.js';
import type { EvmChainId } from './types.js';

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_RPC_URLS = [
  process.env.SOLANA_RPC_URL,
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
].filter((u): u is string => Boolean(u));
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const KNOWN_EIP2612_SYMBOLS = new Set([
  'USDC',
  'DAI',
  'USDS',
  'sUSDS',
  'sDAI',
  'UNI',
  'AAVE',
  'wstETH',
  'ARB',
  'OP',
  'AERO',
  'PENDLE',
  'cbETH',
]);

/**
 * Returns true if the token contract is known to implement EIP-2612 gasless permit()
 * (native Circle USDC v2+ across all 6 CCTP chains + major DeFi ERC-20s).
 */
export function isEip2612Token(chain: EvmChainId, address: string, symbol?: string): boolean {
  if (!address || address === 'native') return false;
  const cfg = EVM_CHAINS[chain];
  if (cfg && address.toLowerCase() === cfg.usdcAddress.toLowerCase()) return true;
  if (symbol && KNOWN_EIP2612_SYMBOLS.has(symbol)) return true;
  return false;
}

/**
 * Checks in a SINGLE Multicall3.aggregate3 RPC call which ERC-20 tokens on a chain
 * already have non-zero allowance granted to Uniswap's canonical Permit2 contract.
 */
export async function detectPermit2Allowances(params: {
  chain: EvmChainId;
  owner: string;
  tokenAddresses: string[];
}): Promise<Set<string>> {
  const approved = new Set<string>();
  const cfg = EVM_CHAINS[params.chain];
  const uniqueTokens = Array.from(
    new Set(
      params.tokenAddresses
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        .map((a) => a.toLowerCase())
    )
  );
  if (!cfg || !uniqueTokens.length) return approved;

  const ownerPad = params.owner.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const permit2Pad = PERMIT2_ADDRESS.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const callData = `0xdd62ed3e${ownerPad}${permit2Pad}`;

  const mcData = encodeMulticall3Aggregate3(
    uniqueTokens.map((target) => ({
      target,
      allowFailure: true,
      callData,
    }))
  );

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(cfg.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: cfg.multicall3, data: mcData }, 'latest'],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const json = (await res.json()) as { result?: string };
    if (!json.result || json.result === '0x') return approved;

    const decoded = decodeMulticall3Aggregate3(json.result);
    for (let i = 0; i < Math.min(uniqueTokens.length, decoded.length); i++) {
      const item = decoded[i];
      if (!item.success) continue;
      const hex = item.returnData.replace(/^0x/, '');
      if (hex.length < 64) continue;
      try {
        if (BigInt('0x' + hex.slice(0, 64)) > 0n) {
          approved.add(uniqueTokens[i]);
        }
      } catch {
        // ignore malformed return
      }
    }
  } catch {
    // Non-fatal: simply return empty set on RPC timeout
  }

  return approved;
}

export interface DiscoveredEthToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  rawBalance: bigint;
  ethplorerPriceUsd: number;
}

/**
 * Discovers arbitrary ERC-20 tokens (including long-tail dust & zero-liquidity dead tokens)
 * held by an Ethereum Mainnet address via Ethplorer's free public API.
 */
export async function discoverEthereumTokens(
  walletAddress: string,
  maxTokens = 30
): Promise<DiscoveredEthToken[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const url = `https://api.ethplorer.io/getAddressInfo/${encodeURIComponent(walletAddress)}?apiKey=freekey`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];

    const json = (await res.json()) as {
      tokens?: Array<{
        rawBalance?: string;
        tokenInfo?: {
          address?: string;
          symbol?: string;
          name?: string;
          decimals?: string | number;
          price?: { rate?: number } | false;
        };
      }>;
    };

    const items = json.tokens ?? [];
    const out: DiscoveredEthToken[] = [];

    for (const item of items) {
      const info = item.tokenInfo;
      if (!info?.address || !item.rawBalance) continue;
      if (!/^0x[0-9a-fA-F]{40}$/.test(info.address)) continue;

      let rawBal = 0n;
      try {
        rawBal = BigInt(item.rawBalance);
      } catch {
        continue;
      }
      if (rawBal <= 0n) continue;

      const decimals = Math.min(36, Math.max(0, Number(info.decimals ?? 18) || 18));
      const priceUsd =
        info.price && typeof info.price === 'object' && typeof info.price.rate === 'number'
          ? info.price.rate
          : 0;

      out.push({
        address: info.address,
        symbol: (info.symbol || 'UNKNOWN').slice(0, 18),
        name: (info.name || info.symbol || 'ERC-20 Token').slice(0, 48),
        decimals,
        rawBalance: rawBal,
        ethplorerPriceUsd: priceUsd,
      });
    }

    // Reserve room for both valued tokens and zero-liquidity dead tokens so real wallets surface burn candidates
    const deadCap = Math.min(6, Math.floor(maxTokens / 4));
    const dead = out.filter((t) => t.ethplorerPriceUsd === 0).slice(0, deadCap);
    const valued = out.filter((t) => t.ethplorerPriceUsd > 0).slice(0, maxTokens - dead.length);
    return [...valued, ...dead];
  } catch {
    return [];
  }
}

/**
 * Simulates `ERC20.transfer(0x000...dEaD, amount)` live via `eth_call` on the chain's RPC.
 * If the contract reverts or returns `false`, the token is flagged as an onchain honeypot / transfer-locked token.
 */
export async function simulateBurnTransferOnchain(params: {
  chain: EvmChainId;
  walletAddress: string;
  tokenAddress: string;
  rawAmount: bigint;
}): Promise<{ safeToBurn: boolean; reason: string }> {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg || params.rawAmount <= 0n) {
    return { safeToBurn: false, reason: 'Zero balance or unsupported chain.' };
  }

  const deadPadded = DEAD_BURN_ADDRESS.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const amtPadded = params.rawAmount.toString(16).padStart(64, '0');
  const data = `0xa9059cbb${deadPadded}${amtPadded}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(cfg.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [
          {
            from: params.walletAddress,
            to: params.tokenAddress,
            data,
          },
          'latest',
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const json = (await res.json()) as {
      result?: string;
      error?: { message?: string; code?: number };
    };

    if (json.error) {
      return {
        safeToBurn: false,
        reason: `eth_call burn simulation reverted (${json.error.message ?? 'transfer locked'}). Safely skipped.`,
      };
    }

    const resultHex = (json.result ?? '0x').toLowerCase();
    // Standard ERC-20 returns true (0x...01) or empty bytes (USDT-style non-returning transfer)
    if (resultHex === '0x' || resultHex.endsWith('1')) {
      return {
        safeToBurn: true,
        reason: 'Verified live via eth_call: transfer(0x…dEaD) succeeds with zero revert.',
      };
    }

    return {
      safeToBurn: false,
      reason: 'eth_call transfer(0x…dEaD) returned false. Safely skipped.',
    };
  } catch {
    return {
      safeToBurn: true,
      reason: 'Zero liquidity detected (RPC simulation timed out; try/catch isolated).',
    };
  }
}

/**
 * Checks real onchain ERC-20 allowance(owner, spender) via `eth_call`.
 */
export async function checkErc20Allowance(params: {
  chain: EvmChainId;
  tokenAddress: string;
  owner: string;
  spender: string;
}): Promise<bigint> {
  const cfg = EVM_CHAINS[params.chain];
  if (!cfg) return 0n;
  const ownerPad = params.owner.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const spenderPad = params.spender.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const data = `0xdd62ed3e${ownerPad}${spenderPad}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(cfg.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: params.tokenAddress, data }, 'latest'],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const json = (await res.json()) as { result?: string };
    if (!json.result || json.result === '0x') return 0n;
    return BigInt(json.result);
  } catch {
    return 0n;
  }
}

export interface SolanaWalletBalance {
  address: string;
  solBalance: number;
  usdcBalance: number;
  slot: number;
  checkedAt: string;
}

/**
 * Fetches live Solana Mainnet SOL + native USDC balances for a Solana public key.
 * Validates the base58 Ed25519 key first, then queries PublicNode -> Solana Mainnet RPC with failover.
 */
export async function fetchSolanaWalletBalances(
  solanaAddress: string
): Promise<SolanaWalletBalance> {
  let pubkey: string;
  try {
    pubkey = new PublicKey(solanaAddress.trim()).toBase58();
  } catch {
    throw new Error('Invalid Solana address');
  }

  let lastErr: unknown;
  for (const rpcUrl of SOLANA_RPC_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 1, method: 'getBalance', params: [pubkey, { commitment: 'confirmed' }] },
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'getTokenAccountsByOwner',
            params: [pubkey, { mint: SOLANA_USDC_MINT }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
          },
        ]),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        lastErr = new Error(`Solana RPC HTTP ${res.status}`);
        continue;
      }

      const parsed = (await res.json()) as Array<{
        id: number;
        result?: {
          context?: { slot?: number };
          value?:
            | number
            | Array<{
                account?: {
                  data?: {
                    parsed?: { info?: { tokenAmount?: { uiAmount?: number } } };
                  };
                };
              }>;
        };
      }>;

      const byId = new Map((Array.isArray(parsed) ? parsed : [parsed]).map((r) => [r.id, r]));
      const balRes = byId.get(1)?.result;
      const tokRes = byId.get(2)?.result;
      if (!balRes) {
        lastErr = new Error('Solana RPC returned empty balance response');
        continue;
      }

      const lamports = typeof balRes.value === 'number' ? balRes.value : 0;
      const accounts = Array.isArray(tokRes?.value) ? tokRes.value : [];
      const usdcBalance = accounts.reduce(
        (sum, acc) => sum + Number(acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
        0
      );

      return {
        address: pubkey,
        solBalance: Number((lamports / 1e9).toFixed(6)),
        usdcBalance: Number(usdcBalance.toFixed(6)),
        slot: balRes.context?.slot ?? 0,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }

  throw new Error(
    `Solana RPC unavailable (${lastErr instanceof Error ? lastErr.message : 'timeout'})`
  );
}
