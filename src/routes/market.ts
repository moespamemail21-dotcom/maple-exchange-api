import { FastifyInstance } from 'fastify';
import { getMarketStats } from '../services/market-stats.js';
import { getNewsForCoin } from '../services/news.js';

const VALID_SYMBOLS = new Set(['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK']);

export async function marketRoutes(app: FastifyInstance) {
  // ─── Global Market Stats ─────────────────────────────────────────────
  app.get('/api/market/stats', async (_request, reply) => {
    const stats = await getMarketStats();
    if (!stats) {
      return reply.status(503).send({ error: 'Market stats temporarily unavailable' });
    }
    return stats;
  });

  // ─── Coin-Specific News ──────────────────────────────────────────────
  app.get('/api/news/:symbol', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    const upper = symbol.toUpperCase();

    if (!VALID_SYMBOLS.has(upper)) {
      return reply.status(404).send({ error: `No news available for ${symbol}` });
    }

    const articles = await getNewsForCoin(upper);
    return { symbol: upper, articles };
  });
}
