import axios from 'axios';
import { redis, KEYS } from './redis.js';
import { env } from '../config/env.js';

const SUPPORTED_ASSETS = ['bitcoin', 'ethereum', 'litecoin', 'ripple', 'solana', 'chainlink', 'tether'] as const;
const ASSET_SYMBOLS: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  litecoin: 'LTC',
  ripple: 'XRP',
  solana: 'SOL',
  chainlink: 'LINK',
  tether: 'USDT',
};

interface PriceData {
  asset: string;
  symbol: string;
  cadPrice: number;
  usdPrice: number;
  change24h: number;
  lastUpdated: string;
}

let priceCache: Map<string, PriceData> = new Map();

export async function fetchPrices(): Promise<PriceData[]> {
  try {
    const ids = SUPPORTED_ASSETS.join(',');
    const { data } = await axios.get(
      `${env.COINGECKO_API_URL}/simple/price`,
      {
        params: {
          ids,
          vs_currencies: 'cad,usd',
          include_24hr_change: true,
        },
        timeout: 5000,
      }
    );

    const prices: PriceData[] = [];

    for (const asset of SUPPORTED_ASSETS) {
      const assetData = data[asset];
      if (!assetData) continue;

      const priceData: PriceData = {
        asset,
        symbol: ASSET_SYMBOLS[asset],
        cadPrice: assetData.cad,
        usdPrice: assetData.usd,
        change24h: assetData.cad_24h_change ?? 0,
        lastUpdated: new Date().toISOString(),
      };

      prices.push(priceData);
      priceCache.set(asset, priceData);

      // Cache in Redis (TTL 60s)
      await redis.set(
        KEYS.price(ASSET_SYMBOLS[asset]),
        JSON.stringify(priceData),
        'EX',
        60
      );
    }

    return prices;
  } catch (err) {
    console.error('Price fetch failed:', err instanceof Error ? err.message : err);
    // Return cached prices on failure
    return Array.from(priceCache.values());
  }
}

export async function getPrice(symbol: string): Promise<PriceData | null> {
  // Try Redis first
  const cached = await redis.get(KEYS.price(symbol));
  if (cached) return JSON.parse(cached);

  // Fallback to memory cache
  const assetId = Object.entries(ASSET_SYMBOLS).find(([_, s]) => s === symbol)?.[0];
  if (assetId) return priceCache.get(assetId) ?? null;

  return null;
}

/**
 * Batch-fetch prices for multiple symbols in a single Redis MGET call.
 * Falls back to memory cache for any misses.
 */
export async function getPrices(symbols: string[]): Promise<Map<string, PriceData>> {
  const result = new Map<string, PriceData>();
  if (symbols.length === 0) return result;

  const unique = [...new Set(symbols)];
  const keys = unique.map((s) => KEYS.price(s));
  const cached = await redis.mget(...keys);

  for (let i = 0; i < unique.length; i++) {
    const val = cached[i];
    if (val) {
      result.set(unique[i], JSON.parse(val));
    } else {
      // Fallback to memory cache
      const assetId = Object.entries(ASSET_SYMBOLS).find(([_, s]) => s === unique[i])?.[0];
      if (assetId) {
        const memCached = priceCache.get(assetId);
        if (memCached) result.set(unique[i], memCached);
      }
    }
  }
  return result;
}

/**
 * Return all cached prices without hitting external APIs.
 * Used by GET /api/prices so user requests never trigger CoinGecko calls.
 */
export async function getAllPricesCached(): Promise<PriceData[]> {
  const allSymbols = Object.values(ASSET_SYMBOLS);
  const keys = allSymbols.map((s) => KEYS.price(s));
  const cached = await redis.mget(...keys);

  const results: PriceData[] = [];
  for (let i = 0; i < allSymbols.length; i++) {
    if (cached[i]) {
      results.push(JSON.parse(cached[i]!));
    } else {
      // Fallback to memory cache
      const assetId = Object.entries(ASSET_SYMBOLS).find(([_, s]) => s === allSymbols[i])?.[0];
      if (assetId) {
        const mem = priceCache.get(assetId);
        if (mem) results.push(mem);
      }
    }
  }
  return results;
}

export function startPriceFeed(intervalMs = 30_000): NodeJS.Timeout {
  // Fetch immediately on start
  fetchPrices();
  // Then every 30 seconds
  return setInterval(fetchPrices, intervalMs);
}
