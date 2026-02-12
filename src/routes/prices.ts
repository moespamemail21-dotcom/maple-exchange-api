import { FastifyInstance } from 'fastify';
import axios from 'axios';
import { getAllPricesCached, getPrice } from '../services/price.js';
import { redis, KEYS } from '../services/redis.js';
import { env } from '../config/env.js';

const SYMBOL_TO_COINGECKO: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', LTC: 'litecoin',
  XRP: 'ripple', SOL: 'solana', LINK: 'chainlink', USDT: 'tether',
};

const RANGE_TO_DAYS: Record<string, number> = {
  '24h': 1, '1w': 7, '1m': 30, '3m': 90, '6m': 180, '1y': 365, all: 1825,
};

export async function priceRoutes(app: FastifyInstance) {
  // ─── Get All Prices ───────────────────────────────────────────────────
  app.get('/api/prices', async () => {
    const prices = await getAllPricesCached();
    return { prices };
  });

  // ─── Get Single Asset Price ───────────────────────────────────────────
  app.get('/api/prices/:symbol', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const price = await getPrice(symbol.toUpperCase());

    if (!price) {
      return reply.status(404).send({ error: `Price not available for ${symbol}` });
    }
    return price;
  });

  // ─── Get Price Chart (Historical) ─────────────────────────────────────
  app.get('/api/prices/:symbol/chart', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const { range = '24h' } = request.query as { range?: string };

    const coinId = SYMBOL_TO_COINGECKO[symbol.toUpperCase()];
    if (!coinId) {
      return reply.status(404).send({ error: `Unknown symbol: ${symbol}` });
    }

    const days = RANGE_TO_DAYS[range] ?? 1;
    const cacheKey = `chart:${symbol.toUpperCase()}:${days}`;

    // Check Redis cache (5 min TTL for charts)
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    try {
      const { data } = await axios.get(
        `${env.COINGECKO_API_URL}/coins/${coinId}/market_chart`,
        { params: { vs_currency: 'cad', days }, timeout: 8000 },
      );

      // data.prices is [[timestamp, price], ...]
      const points: { timestamp: string; value: number }[] = (data.prices ?? []).map(
        ([ts, price]: [number, number]) => ({
          timestamp: new Date(ts).toISOString(),
          value: price,
        }),
      );

      const result = { symbol: symbol.toUpperCase(), range, points };

      // Cache for 5 minutes
      await redis.set(cacheKey, JSON.stringify(result), 'EX', 300);

      return result;
    } catch (err) {
      console.error('Chart fetch error:', err instanceof Error ? err.message : err);
      return reply.status(502).send({ error: 'Unable to fetch chart data' });
    }
  });
}
