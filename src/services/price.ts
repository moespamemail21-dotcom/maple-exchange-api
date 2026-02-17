import { logger } from '../config/logger.js';
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
  high24h?: number;
  low24h?: number;
  volume24h?: number;
  sparkline?: number[];
  lastUpdated: string;
}

const SYMBOL_TO_MEXC: Record<string, string> = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', LTC: 'LTCUSDT',
  XRP: 'XRPUSDT', SOL: 'SOLUSDT', LINK: 'LINKUSDT',
};

let priceCache: Map<string, PriceData> = new Map();
let sparklineCache: Map<string, number[]> = new Map();
let sparklineLastFetch: Date | null = null;
const SPARKLINE_REFRESH_MS = 5 * 60 * 1000; // refresh every 5 min
let lastSuccessfulFetch: Date | null = null;
const MAX_STALENESS_MS = 5 * 60 * 1000; // 5 minutes

export function getPriceAge(): number {
  if (!lastSuccessfulFetch) return Infinity;
  return Date.now() - lastSuccessfulFetch.getTime();
}

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

    lastSuccessfulFetch = new Date();
    return prices;
  } catch (err) {
    logger.error({ err }, 'Price fetch failed');
    const staleness = getPriceAge();
    if (staleness > MAX_STALENESS_MS) {
      logger.warn({ stalenessMs: staleness }, 'Serving stale prices — last successful fetch was over 5 minutes ago');
    }
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
 * Fetch 1h klines from MEXC REST API for all symbols.
 * Cached in memory, refreshed every 5 minutes.
 */
async function refreshSparklines(): Promise<void> {
  if (sparklineLastFetch && Date.now() - sparklineLastFetch.getTime() < SPARKLINE_REFRESH_MS) {
    return; // still fresh
  }

  // Fetch CAD rate from Redis or default
  let cadRate = 1.36;
  try {
    const usdtPrice = await redis.get(KEYS.price('USDT'));
    if (usdtPrice) {
      const parsed = JSON.parse(usdtPrice);
      if (parsed.cadPrice > 0) cadRate = parsed.cadPrice;
    }
  } catch {}

  const symbols = Object.keys(SYMBOL_TO_MEXC);
  await Promise.all(symbols.map(async (symbol) => {
    const pair = SYMBOL_TO_MEXC[symbol];
    if (!pair) return;
    try {
      const { data } = await axios.get('https://api.mexc.com/api/v3/klines', {
        params: { symbol: pair, interval: '60m', limit: 48 },
        timeout: 8000,
      });
      if (!Array.isArray(data) || data.length === 0) return;
      // Each kline: [openTime, open, high, low, close, volume, closeTime, quoteVolume]
      const points = data.map((c: any[]) => parseFloat(c[4]) * cadRate);
      sparklineCache.set(symbol, points);
    } catch {
      // Keep old data on failure
    }
  }));

  sparklineLastFetch = new Date();
  logger.debug({ symbols: sparklineCache.size }, 'Sparkline cache refreshed from MEXC');
}

/**
 * Return all cached prices without hitting external APIs.
 * Attaches sparkline data from MEXC kline cache.
 * Used by GET /api/prices so user requests never trigger CoinGecko calls.
 */
export async function getAllPricesCached(): Promise<PriceData[]> {
  const allSymbols = Object.values(ASSET_SYMBOLS);
  const priceKeys = allSymbols.map((s) => KEYS.price(s));
  const priceValues = await redis.mget(...priceKeys);

  // Refresh sparklines in background (non-blocking after first call)
  await refreshSparklines();

  const results: PriceData[] = [];
  for (let i = 0; i < allSymbols.length; i++) {
    let priceData: PriceData | null = null;

    if (priceValues[i]) {
      priceData = JSON.parse(priceValues[i]!);
    } else {
      const assetId = Object.entries(ASSET_SYMBOLS).find(([_, s]) => s === allSymbols[i])?.[0];
      if (assetId) {
        priceData = priceCache.get(assetId) ?? null;
      }
    }

    if (!priceData) continue;

    // Attach sparkline from MEXC kline cache
    const sparkline = sparklineCache.get(allSymbols[i]);
    if (sparkline && sparkline.length > 0) {
      priceData.sparkline = sparkline;
    }

    results.push(priceData);
  }
  return results;
}

export function startPriceFeed(intervalMs = 30_000): NodeJS.Timeout {
  // Fetch immediately on start
  fetchPrices();
  // Then at the configured interval
  return setInterval(fetchPrices, intervalMs);
}

/**
 * Get cached 1-minute candles for a symbol (populated by MEXC feed).
 */
export async function getCandles(symbol: string, interval = '1m'): Promise<Array<{ timestamp: string; usdPrice: number; cadPrice: number }> | null> {
  const cached = await redis.get(KEYS.candles(symbol, interval));
  if (!cached) return null;
  return JSON.parse(cached);
}
