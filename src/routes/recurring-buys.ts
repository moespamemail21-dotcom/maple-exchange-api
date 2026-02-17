import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../middleware/auth.js';
import { createRecurringBuy, getAllUserRecurringBuys, pauseRecurringBuy, resumeRecurringBuy, cancelRecurringBuy } from '../services/recurring-buy.js';

const SUPPORTED_ASSETS = ['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK'] as const;

const createSchema = z.object({
  asset: z.enum(SUPPORTED_ASSETS),
  amountCad: z.number().min(10).max(10000),
  frequency: z.enum(['daily', 'weekly', 'biweekly', 'monthly']),
});

const uuidParamSchema = z.object({ id: z.string().uuid() });

export async function recurringBuyRoutes(app: FastifyInstance) {
  app.get('/api/recurring-buys', { preHandler: [authGuard] }, async (request) => {
    const allBuys = await getAllUserRecurringBuys(request.userId);
    // Cap at 50 recurring buys per response
    const buys = allBuys.slice(0, 50);
    return {
      recurringBuys: buys.map(b => ({
        id: b.id,
        asset: b.asset,
        amountCad: b.amountCad,
        frequency: b.frequency,
        status: b.status,
        nextRunAt: b.nextRunAt.toISOString(),
        lastRunAt: b.lastRunAt?.toISOString() ?? null,
        totalBought: b.totalBought,
        totalSpent: b.totalSpent,
        executionCount: b.executionCount,
        consecutiveFailures: b.consecutiveFailures,
        createdAt: b.createdAt.toISOString(),
      })),
    };
  });

  app.post('/api/recurring-buys', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const buy = await createRecurringBuy(request.userId, body.asset, body.amountCad, body.frequency);
    return reply.status(201).send({
      recurringBuy: {
        id: buy.id,
        asset: buy.asset,
        amountCad: buy.amountCad,
        frequency: buy.frequency,
        status: buy.status,
        nextRunAt: buy.nextRunAt.toISOString(),
        createdAt: buy.createdAt.toISOString(),
      },
    });
  });

  app.post('/api/recurring-buys/:id/pause', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const ok = await pauseRecurringBuy(request.userId, id);
    if (!ok) return reply.status(404).send({ error: 'Recurring buy not found or not active' });
    return { success: true };
  });

  app.post('/api/recurring-buys/:id/resume', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const ok = await resumeRecurringBuy(request.userId, id);
    if (!ok) return reply.status(404).send({ error: 'Recurring buy not found or not paused' });
    return { success: true };
  });

  app.delete('/api/recurring-buys/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const ok = await cancelRecurringBuy(request.userId, id);
    if (!ok) return reply.status(404).send({ error: 'Recurring buy not found' });
    return { success: true };
  });
}
