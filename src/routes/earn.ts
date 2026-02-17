import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../middleware/auth.js';
import {
  getStakingProducts,
  getUserPositions,
  getEarnSummary,
  stakeAsset,
  unstakeAsset,
  getOptimizeSuggestions,
} from '../services/earn.js';

const stakeSchema = z.object({
  productId: z.string().uuid(),
  allocationPercent: z.number().int().min(1).max(100),
});

const bulkStakeSchema = z.object({
  stakes: z.array(z.object({
    productId: z.string().uuid(),
    allocationPercent: z.number().int().min(1).max(100),
  })).min(1).max(10),
});

const unstakeSchema = z.object({
  positionId: z.string().uuid(),
});

export async function earnRoutes(app: FastifyInstance) {
  // ─── Get Staking Products ────────────────────────────────────────────
  app.get('/api/earn/products', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { term?: string };
    const validTerms = ['flexible', 'short', 'medium', 'long'];
    const term = query.term && validTerms.includes(query.term) ? query.term : undefined;
    const products = await getStakingProducts(term);
    return { products };
  });

  // ─── Get Earn Summary (for Earn tab header) ──────────────────────────
  app.get('/api/earn/summary', { preHandler: [authGuard] }, async (request) => {
    return getEarnSummary(request.userId);
  });

  // ─── Get My Positions ────────────────────────────────────────────────
  app.get('/api/earn/positions', { preHandler: [authGuard] }, async (request) => {
    const positions = await getUserPositions(request.userId);
    return { positions };
  });

  // ─── Stake Asset ─────────────────────────────────────────────────────
  app.post('/api/earn/stake', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = stakeSchema.parse(request.body);
    const result = await stakeAsset(request.userId, body.productId, body.allocationPercent);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }
    return reply.status(201).send({
      success: true,
      positionId: result.positionId,
      message: 'Staking started successfully.',
    });
  });

  // ─── Bulk Stake (from Optimize screen) ───────────────────────────────
  app.post('/api/earn/stake/bulk', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = bulkStakeSchema.parse(request.body);
    const results = [];

    for (const stake of body.stakes) {
      const result = await stakeAsset(request.userId, stake.productId, stake.allocationPercent);
      results.push({
        productId: stake.productId,
        success: result.success,
        positionId: result.positionId,
        error: result.error,
      });
    }

    const successCount = results.filter((r) => r.success).length;
    return reply.status(201).send({
      results,
      message: `${successCount}/${body.stakes.length} staking positions created.`,
    });
  });

  // ─── Unstake ─────────────────────────────────────────────────────────
  app.post('/api/earn/unstake', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = unstakeSchema.parse(request.body);
    const result = await unstakeAsset(request.userId, body.positionId);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }
    return { success: true, message: 'Unstaking completed. Funds returned to your available balance.' };
  });

  // ─── Get Optimize Suggestions ────────────────────────────────────────
  app.get('/api/earn/optimize', { preHandler: [authGuard] }, async (request) => {
    return getOptimizeSuggestions(request.userId);
  });
}
