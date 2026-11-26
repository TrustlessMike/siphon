export const LLAMA_PRICE_BATCH_SIZE = 25;

export const FALLBACK_PRICES: Record<string, number> = {
  'coingecko:ethereum': 1680,
  'coingecko:solana': 70,
  'coingecko:usd-coin': 1.0,
  'coingecko:polygon-ecosystem-token': 0.24,
  'coingecko:avalanche-2': 18.5,
  'coingecko:binancecoin': 590,
  'coingecko:sonic-3': 0.52,
  'coingecko:mantle': 0.78,
  'coingecko:cosmos': 4.8,
  'coingecko:osmosis': 0.36,
  'coingecko:celestia': 3.4,
  'coingecko:injective-protocol': 13.5,
  'coingecko:neutron-3': 0.22,
  'coingecko:sui': 2.45,
  'coingecko:aptos': 6.1,
  'coingecko:the-open-network': 3.8,
  'coingecko:tron': 0.24,
  'coingecko:bitcoin': 86000,
  'coingecko:tether': 1.0,
  'coingecko:notcoin': 0.0032,
  'coingecko:dogs-2': 0.00028,
  'coingecko:just': 0.032,
  'coingecko:deep': 0.14,
  'coingecko:walrus-2': 0.45,
  'coingecko:worldcoin-wld': 1.2,
  'coingecko:hyperliquid': 22.0,
  'coingecko:berachain-bera': 0.85,
  'coingecko:zksync': 0.08,
  'coingecko:xdai': 1.0,
  'coingecko:gnosis': 125.0,
  'coingecko:wrapped-bitcoin': 68500,
  'coingecko:wrapped-steth': 1985,
  'coingecko:usdt0': 1.0,
  // Ethereum
  'ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 1.0,
  'ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7': 1.0,
  'ethereum:0x6B175474E89094C44Da98b954EedeAC495271d0F': 1.0,
  'ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': 1680,
  'ethereum:0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84': 1678,
  'ethereum:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0': 1985,
  'ethereum:0x83F20F44975D03b1b09e64809B757c47f942BEeA': 1.12,
  'ethereum:0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD': 1.05, // Sky sUSDS
  'ethereum:0x9D39A5DE30e57443BfF2A8307A4256c8797A3497': 1.15, // Ethena sUSDe
  'ethereum:0x514910771AF9Ca656af840dff83E8264EcF986CA': 12.4,
  'ethereum:0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984': 6.2,
  'ethereum:0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9': 162,
  'ethereum:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': 68500,
  // Base
  'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 1.0,
  'base:0x4200000000000000000000000000000000000006': 1680,
  'base:0x940181a94A35A4569E4529A3CDfB74e38FD98631': 0.58,
  'base:0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed': 0.0042,
  'base:0x532f27101965dd16442E59d40670FaF5eBB142E4': 0.038,
  // Arbitrum
  'arbitrum:0xaf88d065e77c8cC2239327C5EDb3A432268e5831': 1.0,
  'arbitrum:0x912CE59144191C1204E64559FE8253a0e49E6548': 0.34,
  'arbitrum:0x82aF49447D8a07e3bd95BD0d56f35241523fBab1': 1680,
  'arbitrum:0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a': 18.2,
  'arbitrum:0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8': 2.85,
  // Optimism
  'optimism:0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85': 1.0,
  'optimism:0x94b008aA00579c1307B0EF2c499aD98a8ce58e58': 1.0, // Optimism USDT
  'optimism:0x4200000000000000000000000000000000000042': 0.76,
  'optimism:0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb': 1985, // Optimism wstETH
  // Polygon
  'polygon:0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': 1.0,
  'polygon:0xc2132D05D31c914a87C6611C10748AEb04B58e8F': 1.0, // Polygon USDT
  'polygon:0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619': 1680,
  'polygon:0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6': 68500, // Polygon WBTC
  // Avalanche
  'avax:0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E': 1.0,
  'avax:0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7': 1.0, // Avalanche USDT
  'avax:0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd': 0.22,
  // BNB Chain
  'bsc:0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d': 1.0, // BNB USDC
  'bsc:0x55d398326f99059fF775485246999027B3197955': 1.0, // BNB USDT
  'bsc:0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82': 2.1, // BNB CAKE
  // Linea, Scroll, Mantle, Blast
  'linea:0x176211869cA2b568f2A7D4EE941E073a821EE1ff': 1.0, // Linea USDC
  'scroll:0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4': 1.0, // Scroll USDC
  'mantle:0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9': 1.0, // Mantle USDC
  'blast:0x4300000000000000000000000000000000000003': 1.0, // Blast USDB
  // HyperEVM (999)
  'hyperliquid:0xb88339CB7199b77E23DB6E890353E22632Ba630f': 1.0, // HyperEVM native USDC
  'hyperliquid:0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb': 1.0, // HyperEVM USDT0
  'hyperliquid:0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463': 68500, // HyperEVM UBTC
  'hyperliquid:0xBe6727B535545C67d5cAa73dEa54865B92CF7907': 1680, // HyperEVM UETH
  // Berachain (80094)
  'berachain:0x549943e04f40284185054145c6E4e9568C1D3241': 1.0, // Berachain USDC.e
  'berachain:0xFCBD14DC51f0A4d49d5E53C2E0950e0bC26d0Dce': 1.0, // Berachain HONEY
  // zkSync Era (324)
  'era:0x1d17CBcF0D6D143135aE902365D2E5e2A16538D4': 1.0, // zkSync native USDC
  'era:0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4': 1.0, // zkSync USDC.e
  'era:0x5A7d6b2F92C77FAD6CCaBd7EE0624E64907Eaf3E': 0.08, // zkSync ZK
  // Ink (57073)
  'ink:0x2D270e6886d130D724215A266106e6832161EAEd': 1.0, // Ink native USDC
  'ink:0xF1815bd50389c46847f0Bda824eC8da914045D14': 1.0, // Ink USDC.e
  'ink:0x0200C29006150606B650577BBE7B6248F58470c1': 1.0, // Ink USDT0
  // Gnosis (100)
  'xdai:0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d': 1.0, // Gnosis WXDAI
  'xdai:0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0': 1.0, // Gnosis USDC.e
  'xdai:0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83': 1.0, // Gnosis USDC
  'xdai:0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb': 125.0, // Gnosis GNO
  'xdai:0xaf204776c7245bF4147c2612BF6e5972Ee483701': 1.18, // Gnosis sDAI
};

const FALLBACK_PRICES_LOWER = new Map<string, number>(
  Object.entries(FALLBACK_PRICES).map(([k, v]) => [k.toLowerCase(), v])
);

interface CacheEntry {
  price: number;
  ts: number;
}

const priceCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export function clearPriceCache(): void {
  priceCache.clear();
}

export interface LiveUsdPricesResult {
  prices: Map<string, number>;
  hadError: boolean;
  failedKeys: Set<string>;
  usedFallbackKeys: Set<string>;
}

export async function fetchLiveUsdPricesWithStatus(keys: string[]): Promise<LiveUsdPricesResult> {
  const unique = Array.from(new Set(keys.filter(Boolean)));
  const now = Date.now();
  const prices = new Map<string, number>();
  const toFetch: string[] = [];
  const failedKeys = new Set<string>();
  const usedFallbackKeys = new Set<string>();
  let hadError = false;

  for (const k of unique) {
    const cached = priceCache.get(k);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      prices.set(k, cached.price);
    } else {
      toFetch.push(k);
    }
  }

  if (toFetch.length > 0) {
    const chunks: string[][] = [];
    for (let i = 0; i < toFetch.length; i += LLAMA_PRICE_BATCH_SIZE) {
      chunks.push(toFetch.slice(i, i + LLAMA_PRICE_BATCH_SIZE));
    }

    await Promise.all(
      chunks.map(async (chunk) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4500);
        try {
          const url = `https://coins.llama.fi/prices/current/${encodeURIComponent(chunk.join(','))}`;
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) {
            hadError = true;
            for (const k of chunk) failedKeys.add(k);
            return;
          }
          const json = (await res.json()) as {
            coins?: Record<string, { price?: number; confidence?: number }>;
          };
          const coins = json.coins ?? {};
          const coinsLower = new Map<string, { price?: number; confidence?: number }>(
            Object.entries(coins).map(([ck, cv]) => [ck.toLowerCase(), cv])
          );
          for (const k of chunk) {
            const entry = coins[k] ?? coinsLower.get(k.toLowerCase());
            if (entry && typeof entry.price === 'number' && Number.isFinite(entry.price) && entry.price > 0) {
              prices.set(k, entry.price);
              priceCache.set(k, { price: entry.price, ts: now });
            }
          }
        } catch {
          clearTimeout(timer);
          hadError = true;
          for (const k of chunk) failedKeys.add(k);
        }
      })
    );
  }

  for (const k of unique) {
    if (!prices.has(k)) {
      const fb = FALLBACK_PRICES[k] ?? FALLBACK_PRICES_LOWER.get(k.toLowerCase());
      if (fb !== undefined && fb > 0) {
        prices.set(k, fb);
        usedFallbackKeys.add(k);
      }
    }
  }

  return { prices, hadError, failedKeys, usedFallbackKeys };
}

export async function fetchLiveUsdPrices(keys: string[]): Promise<Map<string, number>> {
  const res = await fetchLiveUsdPricesWithStatus(keys);
  return res.prices;
}
