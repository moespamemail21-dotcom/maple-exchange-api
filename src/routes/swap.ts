import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../middleware/auth.js';
import { getSwapQuote, executeSwap, SwapQuoteExpiredError } from '../services/swap.js';
import { logger } from '../config/logger.js';
import Decimal from 'decimal.js';

const SUPPORTED = ['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK'] as const;

const positiveDecimalString = z.string().refine((v) => {
  try {
    const d = new Decimal(v);
    return d.isFinite() && d.gt(0);
  } catch {
    return false;
  }
}, 'Amount must be a positive number');

const swapQuoteSchema = z.object({
  fromAsset: z.enum(SUPPORTED),
  toAsset: z.enum(SUPPORTED),
  amount: positiveDecimalString,
});

const swapExecuteSchema = z.object({
  fromAsset: z.enum(SUPPORTED),
  toAsset: z.enum(SUPPORTED),
  amount: positiveDecimalString,
  minReceive: z.string().optional(),
  quoteId: z.string().uuid().optional(),
});

export async function swapRoutes(app: FastifyInstance) {
  app.post('/api/swap/quote', { preHandler: [authGuard] }, async (request, reply) => {
    const body = swapQuoteSchema.parse(request.body);
    if (body.fromAsset === body.toAsset) {
      return reply.status(400).send({ error: 'Cannot swap an asset to itself' });
    }
    try {
      const quote = await getSwapQuote(request.userId, body.fromAsset, body.toAsset, body.amount);
      return { quote };
    } catch (err: any) {
      logger.error({ err, from: body.fromAsset, to: body.toAsset }, 'swap quote failed');
      return reply.status(400).send({ error: 'Unable to get swap quote. Please try again.' });
    }
  });

  app.post('/api/swap/execute', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = swapExecuteSchema.parse(request.body);
    if (body.fromAsset === body.toAsset) {
      return reply.status(400).send({ error: 'Cannot swap an asset to itself' });
    }
    try {
      const result = await executeSwap(
        request.userId, body.fromAsset, body.toAsset, body.amount, body.minReceive, body.quoteId,
      );
      return { swap: result };
    } catch (err: any) {
      if (err instanceof SwapQuoteExpiredError) {
        return reply.status(410).send({ error: err.message });
      }
      logger.error({ err, userId: request.userId, from: body.fromAsset, to: body.toAsset }, 'swap execute failed');
      const isBalanceError = err.message?.toLowerCase().includes('insufficient');
      return reply.status(400).send({
        error: isBalanceError ? 'Insufficient balance for this swap' : 'Unable to process swap. Please try again.',
      });
    }
  });
}
