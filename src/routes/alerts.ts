import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../middleware/auth.js';
import { createAlert, getUserAlerts, deleteAlert } from '../services/price-alert.js';

const SUPPORTED_ASSETS = ['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK'] as const;

const createAlertSchema = z.object({
  asset: z.enum(SUPPORTED_ASSETS),
  targetPrice: z.number().positive().min(0.00000001).max(999_999_999.99),
  direction: z.enum(['above', 'below']),
});

const uuidParamSchema = z.object({ id: z.string().uuid() });

export async function alertRoutes(app: FastifyInstance) {
  app.get('/api/alerts', { preHandler: [authGuard] }, async (request) => {
    const allAlerts = await getUserAlerts(request.userId);
    // Cap at 100 alerts per response
    const alerts = allAlerts.slice(0, 100);
    return {
      alerts: alerts.map(a => ({
        id: a.id,
        asset: a.asset,
        targetPrice: a.targetPrice,
        direction: a.direction,
        triggered: a.triggered,
        triggeredAt: a.triggeredAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  });

  app.post('/api/alerts', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = createAlertSchema.parse(request.body);
    const alert = await createAlert(request.userId, body.asset, body.targetPrice, body.direction);
    return reply.status(201).send({
      alert: {
        id: alert.id,
        asset: alert.asset,
        targetPrice: alert.targetPrice,
        direction: alert.direction,
        triggered: alert.triggered,
        createdAt: alert.createdAt.toISOString(),
      },
    });
  });

  app.delete('/api/alerts/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const deleted = await deleteAlert(request.userId, id);
    if (!deleted) return reply.status(404).send({ error: 'Alert not found' });
    return { success: true };
  });
}
