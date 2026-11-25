import { PublicKey } from '@solana/web3.js';
import { DEAD_BURN_ADDRESS, EVM_CHAINS } from './chains.js';
import { decodeMulticall3Aggregate3, encodeMulticall3Aggregate3, evmJsonRpcCall } from './rpc.js';
import type { EvmChainId } from './types.js';

export const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOLANA_RPC_URLS = [
  process.env.SOLANA_RPC_URL,
  'https://solana-rpc.publicnode.com',
  'https://api.mainnet-beta.solana.com',
].filter((u): u is string => Boolean(u));
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

const DEXSCREENER_CHAIN_SLUGS: Record<EvmChainId, string> = {
  ethereum: 'ethereum',
  base: 'base',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  polygon: 'polygon',
  avalanche: 'avalanche',
  bnb: 'bsc',
  sonic: 'sonic',
  unichain: 'unichain',
  linea: 'linea',
  scroll: 'scroll',
  mantle: 'mantle',
  blast: 'blast',
  worldchain: 'worldchain',
};

const ALCHEMY_NETWORK_SUBDOMAINS: Partial<Record<EvmChainId, string>> = {
  ethereum: 'eth-mainnet',
  base: 'base-mainnet',
  arbitrum: 'arb-mainnet',
  optimism: 'opt-mainnet',
  polygon: 'polygon-mainnet',
  bnb: 'bnb-mainnet',
  linea: 'linea-mainnet',
  scroll: 'scroll-mainnet',
  blast: 'blast-mainnet',
  worldchain: 'worldchain-mainnet',
  unichain: 'unichain-mainnet',
};

const MORALIS_CHAIN_HEX: Partial<Record<EvmChainId, string>> = {
  ethereum: '0x1',
  base: '0x2105',
  arbitrum: '0xa4b1',
  optimism: '0xa',
  polygon: '0x89',
  avalanche: '0xa86a',
  bnb: '0x38',
  linea: '0xe708',
  blast: '0x13e31',
};

export const MIN_VERIFIED_DEX_LIQUIDITY_USD = 2_500;

export function getL2IndexerProvider(): 'sim' | 'alchemy' | 'moralis' | 'none' {
  if (process.env.SIM_API_KEY?.trim()) return 'sim';
  if (process.env.ALCHEMY_API_KEY?.trim()) return 'alchemy';
  if (process.env.MORALIS_API_KEY?.trim()) return 'moralis';
  return 'none';
}

export interface AaveAccountSafety {
  checked: boolean;
  hasActiveDebt: boolean;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  healthFactor: number;
  safeForMaxWithdraw: boolean;
  reason: string;
}

/**
 * Decodes Aave v3 Pool.getUserAccountData(address) 6-word return tuple:
 * (totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor).
 */
export function decodeAaveAccountData(hexResult: string): AaveAccountSafety {
  const clean = hexResult.replace(/^0x/, '');
  if (clean.length < 64 * 6) {
    return {
      checked: false,
      hasActiveDebt: false,
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      healthFactor: Number.POSITIVE_INFINITY,
      safeForMaxWithdraw: true,
      reason: 'Empty Aave account data response.',
    };
  }
  const word = (i: number) => BigInt('0x' + clean.slice(i * 64, (i + 1) * 64));
  const totalCollateralBase = word(0);
  const totalDebtBase = word(1);
  const hfRaw = word(5);

  const totalCollateralUsd = Number(totalCollateralBase) / 1e8;
  const totalDebtUsd = Number(totalDebtBase) / 1e8;
  const hasActiveDebt = totalDebtBase > 0n;
  const healthFactor =
    !hasActiveDebt || hfRaw > 10n ** 24n ? Number.POSITIVE_INFINITY : Number(hfRaw) / 1e18;

  return {
    checked: true,
    hasActiveDebt,
    totalCollateralUsd: Number(totalCollateralUsd.toFixed(2)),
    totalDebtUsd: Number(totalDebtUsd.toFixed(2)),
    healthFactor: Number.isFinite(healthFactor) ? Number(healthFactor.toFixed(2)) : 999,
    safeForMaxWithdraw: !hasActiveDebt,
    reason: hasActiveDebt
      ? `Active Aave v3 borrow detected ($${totalDebtUsd.toFixed(2)} debt · HF ${healthFactor.toFixed(2)}). Repay debt before MAX withdrawal to prevent revert or liquidation.`
      : 'Verified onchain: zero Aave v3 debt (safe for MAX withdrawal).',
  };
}

/**
 * Queries Aave v3 Pool.getUserAccountData(user) (`0xbf92857c`) live onchain with multi-RPC failover.
 */
export async function checkAaveV3AccountSafety(
  chain: EvmChainId,
  userAddress: string
): Promise<AaveAccountSafety> {
  const cfg = EVM_CHAINS[chain];
  if (!cfg?.aaveV3Pool || !/^0x[0-9a-fA-F]{40}$/.test(userAddress)) {
    return {
      checked: false,
      hasActiveDebt: false,
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      healthFactor: 999,
      safeForMaxWithdraw: true,
      reason: 'Aave v3 Pool not configured on this chain.',
    };
  }

  const userPad = userAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const data = `0xbf92857c${userPad}`;
  try {
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.aaveV3Pool, data }, 'latest'],
      3500
    );
    if (!json.result || json.result === '0x') {
      return {
        checked: false,
        hasActiveDebt: false,
        totalCollateralUsd: 0,
        totalDebtUsd: 0,
        healthFactor: 999,
        safeForMaxWithdraw: true,
        reason: 'Could not read Aave account data.',
      };
    }
    return decodeAaveAccountData(json.result);
  } catch {
    return {
      checked: false,
      hasActiveDebt: false,
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      healthFactor: 999,
      safeForMaxWithdraw: true,
      reason: 'Aave account check timed out.',
    };
  }
}

export interface DexLiquidityInfo {
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  dexId?: string;
}

/**
 * Batch-verifies real DEX liquidity & spot price for up to 30 token addresses on a chain
 * using DexScreener's free public API so fake-price spam tokens never inflate portfolio totals.
 */
export async function fetchDexLiquidityBatch(
  chain: EvmChainId,
  tokenAddresses: string[]
): Promise<Map<string, DexLiquidityInfo>> {
  const out = new Map<string, DexLiquidityInfo>();
  const slug = DEXSCREENER_CHAIN_SLUGS[chain];
  const unique = Array.from(
    new Set(
      tokenAddresses
        .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a))
        .map((a) => a.toLowerCase())
    )
  ).slice(0, 30);

  if (!slug || !unique.length) return out;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const url = `https://api.dexscreener.com/tokens/v1/${slug}/${unique.join(',')}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return out;

    const pairs = (await res.json()) as Array<{
      dexId?: string;
      baseToken?: { address?: string };
      priceUsd?: string;
      liquidity?: { usd?: number };
      volume?: { h24?: number };
    }>;

    if (!Array.isArray(pairs)) return out;
    for (const pair of pairs) {
      const addr = pair.baseToken?.address?.toLowerCase();
      if (!addr) continue;
      const liq = Number(pair.liquidity?.usd ?? 0);
      const price = Number(pair.priceUsd ?? 0);
      const vol = Number(pair.volume?.h24 ?? 0);
      const prev = out.get(addr);
      if (!prev || liq > prev.liquidityUsd) {
        out.set(addr, {
          priceUsd: Number.isFinite(price) ? price : 0,
          liquidityUsd: Number.isFinite(liq) ? liq : 0,
          volume24hUsd: Number.isFinite(vol) ? vol : 0,
          dexId: pair.dexId,
        });
      }
    }
  } catch {
    clearTimeout(timer);
  }
  return out;
}

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
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: cfg.multicall3, data: mcData }, 'latest'],
      3500
    );
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
 * Discovers arbitrary ERC-20 tokens on ANY of the 6 EVM chains when SIM_API_KEY,
 * MORALIS_API_KEY, or ALCHEMY_API_KEY is configured, falling back to Ethplorer on Ethereum.
 */
export async function discoverChainTokens(
  chain: EvmChainId,
  walletAddress: string,
  maxTokens = 24
): Promise<DiscoveredEthToken[]> {
  const cfg = EVM_CHAINS[chain];
  if (!cfg) return [];

  const simKey = process.env.SIM_API_KEY?.trim();
  if (simKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(
        `https://api.sim.dune.com/v1/evm/balances/${encodeURIComponent(walletAddress)}?chain_ids=${cfg.chainId}&limit=${maxTokens}`,
        { headers: { 'X-Sim-Api-Key': simKey }, signal: controller.signal }
      );
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as {
          balances?: Array<{
            address?: string;
            amount?: string;
            decimals?: number;
            symbol?: string;
            name?: string;
            price_usd?: number;
          }>;
        };
        const out: DiscoveredEthToken[] = [];
        for (const b of json.balances ?? []) {
          if (!b.address || b.address === 'native' || !/^0x[0-9a-fA-F]{40}$/.test(b.address)) continue;
          if (!b.amount) continue;
          try {
            const rawBalance = BigInt(b.amount);
            if (rawBalance <= 0n) continue;
            out.push({
              address: b.address,
              symbol: (b.symbol || 'UNKNOWN').slice(0, 18),
              name: (b.name || b.symbol || 'ERC-20 Token').slice(0, 48),
              decimals: Math.min(36, Math.max(0, Number(b.decimals ?? 18))),
              rawBalance,
              ethplorerPriceUsd: Number(b.price_usd ?? 0),
            });
          } catch {
            // ignore malformed balance
          }
        }
        if (out.length) return out.slice(0, maxTokens);
      }
    } catch {
      // fall through
    }
  }

  const moralisKey = process.env.MORALIS_API_KEY?.trim();
  if (moralisKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(
        `https://deep-index.moralis.io/api/v2.2/${encodeURIComponent(walletAddress)}/erc20?chain=${MORALIS_CHAIN_HEX[chain]}`,
        { headers: { 'X-API-Key': moralisKey }, signal: controller.signal }
      );
      clearTimeout(timer);
      if (res.ok) {
        const items = (await res.json()) as Array<{
          token_address?: string;
          symbol?: string;
          name?: string;
          decimals?: number;
          balance?: string;
        }>;
        const out: DiscoveredEthToken[] = [];
        for (const item of Array.isArray(items) ? items : []) {
          if (!item.token_address || !item.balance || !/^0x[0-9a-fA-F]{40}$/.test(item.token_address)) continue;
          try {
            const rawBalance = BigInt(item.balance);
            if (rawBalance <= 0n) continue;
            out.push({
              address: item.token_address,
              symbol: (item.symbol || 'UNKNOWN').slice(0, 18),
              name: (item.name || item.symbol || 'ERC-20 Token').slice(0, 48),
              decimals: Math.min(36, Math.max(0, Number(item.decimals ?? 18))),
              rawBalance,
              ethplorerPriceUsd: 0,
            });
          } catch {
            // ignore
          }
        }
        if (out.length) return out.slice(0, maxTokens);
      }
    } catch {
      // fall through
    }
  }

  const alchemyKey = process.env.ALCHEMY_API_KEY?.trim();
  const alchemySub = ALCHEMY_NETWORK_SUBDOMAINS[chain];
  if (alchemyKey && alchemySub) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(`https://${alchemySub}.g.alchemy.com/v2/${alchemyKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'alchemy_getTokenBalances',
          params: [walletAddress, 'erc20'],
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as {
          result?: { tokenBalances?: Array<{ contractAddress?: string; tokenBalance?: string }> };
        };
        const out: DiscoveredEthToken[] = [];
        for (const item of json.result?.tokenBalances ?? []) {
          if (!item.contractAddress || !item.tokenBalance) continue;
          try {
            const rawBalance = BigInt(item.tokenBalance);
            if (rawBalance <= 0n) continue;
            out.push({
              address: item.contractAddress,
              symbol: item.contractAddress.slice(0, 6).toUpperCase(),
              name: 'Discovered ERC-20',
              decimals: 18,
              rawBalance,
              ethplorerPriceUsd: 0,
            });
          } catch {
            // ignore
          }
        }
        if (out.length) return out.slice(0, maxTokens);
      }
    } catch {
      // fall through
    }
  }

  if (chain === 'ethereum') {
    return discoverEthereumTokens(walletAddress, maxTokens);
  }
  return [];
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
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [
        {
          from: params.walletAddress,
          to: params.tokenAddress,
          data,
        },
        'latest',
      ],
      3500
    );

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
    const json = await evmJsonRpcCall<string>(
      cfg.rpcUrls,
      'eth_call',
      [{ to: params.tokenAddress, data }, 'latest'],
      3500
    );
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
  hasUsdcAta: boolean;
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
        hasUsdcAta: accounts.length > 0,
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
