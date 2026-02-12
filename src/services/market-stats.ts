import axios from 'axios';
import { redis } from './redis.js';
import { env } from '../config/env.js';

interface MarketStats {
  totalMarketCapCAD: number;
  totalMarketCapUSD: number;
  marketCapChange24h: number;
  btcDominance: number;
  fearGreedIndex: number;
  fearGreedLabel: string;
  lastUpdated: string;
}

const CACHE_KEY = 'market:stats';
const CACHE_TTL = 3600; // 1 hour

let memoryCache: MarketStats | null = null;

export async function fetchMarketStats(): Promise<MarketStats | null> {
  try {
    // Fetch CoinGecko global data (market cap + BTC dominance)
    const [globalResp, fngResp] = await Promise.allSettled([
      axios.get(`${env.COINGECKO_API_URL}/global`, { timeout: 8000 }),
      axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 8000 }),
    ]);

    let totalMarketCapCAD = 0;
    let totalMarketCapUSD = 0;
    let marketCapChange24h = 0;
    let btcDominance = 0;

    if (globalResp.status === 'fulfilled') {
      const g = globalResp.value.data?.data;
      if (g) {
        totalMarketCapCAD = g.total_market_cap?.cad ?? 0;
        totalMarketCapUSD = g.total_market_cap?.usd ?? 0;
        marketCapChange24h = g.market_cap_change_percentage_24h_usd ?? 0;
        btcDominance = g.market_cap_percentage?.btc ?? 0;
      }
    }

    let fearGreedIndex = 0;
    let fearGreedLabel = 'N/A';

    if (fngResp.status === 'fulfilled') {
      const fng = fngResp.value.data?.data?.[0];
      if (fng) {
        fearGreedIndex = parseInt(fng.value, 10) || 0;
        fearGreedLabel = fng.value_classification ?? 'N/A';
      }
    }

    const stats: MarketStats = {
      totalMarketCapCAD,
      totalMarketCapUSD,
      marketCapChange24h,
      btcDominance,
      fearGreedIndex,
      fearGreedLabel,
      lastUpdated: new Date().toISOString(),
    };

    memoryCache = stats;
    await redis.set(CACHE_KEY, JSON.stringify(stats), 'EX', CACHE_TTL);

    return stats;
  } catch (err) {
    console.error('Market stats fetch failed:', err instanceof Error ? err.message : err);
    return memoryCache;
  }
}

export async function getMarketStats(): Promise<MarketStats | null> {
  const cached = await redis.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);
  if (memoryCache) return memoryCache;
  return fetchMarketStats();
}

export function startMarketStatsFeed(intervalMs = 3600_000): NodeJS.Timeout {
  fetchMarketStats();
  return setInterval(fetchMarketStats, intervalMs);
}
