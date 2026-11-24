const FALLBACK_PRICES: Record<string, number> = {
  'coingecko:ethereum': 1680,
  'coingecko:solana': 70,
  'coingecko:usd-coin': 1.0,
  'coingecko:polygon-ecosystem-token': 0.24,
  'coingecko:avalanche-2': 18.5,
  'ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48': 1.0,
  'ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7': 1.0,
  'ethereum:0x6B175474E89094C44Da98b954EedeAC495271d0F': 1.0,
  'ethereum:0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2': 1680,
  'ethereum:0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84': 1678,
  'ethereum:0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0': 1985,
  'ethereum:0x83F20F44975D03b1b09e64809B757c47f942BEeA': 1.12,
  'ethereum:0x514910771AF9Ca656af840dff83E8264EcF986CA': 12.4,
  'ethereum:0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984': 6.2,
  'ethereum:0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9': 162,
  'ethereum:0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599': 68500,
  'base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 1.0,
  'base:0x4200000000000000000000000000000000000006': 1680,
  'base:0x940181a94A35A4569E4529A3CDfB74e38FD98631': 0.58,
  'base:0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed': 0.0042,
  'base:0x532f27101965dd16442E59d40670FaF5eBB142E4': 0.038,
  'arbitrum:0xaf88d065e77c8cC2239327C5EDb3A432268e5831': 1.0,
  'arbitrum:0x912CE59144191C1204E64559FE8253a0e49E6548': 0.34,
  'arbitrum:0x82aF49447D8a07e3bd95BD0d56f35241523fBab1': 1680,
  'arbitrum:0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a': 18.2,
  'arbitrum:0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8': 2.85,
  'optimism:0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85': 1.0,
  'optimism:0x4200000000000000000000000000000000000042': 0.76,
  'polygon:0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359': 1.0,
  'polygon:0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619': 1680,
  'avax:0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E': 1.0,
  'avax:0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd': 0.22,
};

interface CacheEntry {
  price: number;
  ts: number;
}

const priceCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export async function fetchLiveUsdPrices(keys: string[]): Promise<Map<string, number>> {
  const unique = Array.from(new Set(keys.filter(Boolean)));
  const now = Date.now();
  const result = new Map<string, number>();
  const toFetch: string[] = [];

  for (const k of unique) {
    const cached = priceCache.get(k);
    if (cached && now - cached.ts < CACHE_TTL_MS) {
      result.set(k, cached.price);
    } else {
      toFetch.push(k);
    }
  }

  if (toFetch.length > 0) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const url = `https://coins.llama.fi/prices/current/${encodeURIComponent(toFetch.join(','))}`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as {
          coins?: Record<string, { price?: number; confidence?: number }>;
        };
        const coins = json.coins ?? {};
        for (const k of toFetch) {
          const entry = coins[k];
          if (entry && typeof entry.price === 'number' && entry.price > 0) {
            result.set(k, entry.price);
            priceCache.set(k, { price: entry.price, ts: now });
          }
        }
      }
    } catch {
      // Fallback handled below
    }
  }

  for (const k of unique) {
    if (!result.has(k) && FALLBACK_PRICES[k] !== undefined) {
      result.set(k, FALLBACK_PRICES[k]);
    }
  }

  return result;
}
