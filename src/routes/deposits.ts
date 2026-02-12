import { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { deposits } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';

export async function depositRoutes(app: FastifyInstance) {
  // ─── List Deposits ──────────────────────────────────────────────────
  app.get('/api/deposits', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { status?: string; limit?: string; offset?: string };

    const conditions = [eq(deposits.userId, request.userId)];
    if (query.status) conditions.push(eq(deposits.status, query.status));

    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Number(query.offset) || 0;

    const rows = await db
      .select({
        id: deposits.id,
        asset: deposits.asset,
        chain: deposits.chain,
        amount: deposits.amount,
        txHash: deposits.txHash,
        fromAddress: deposits.fromAddress,
        confirmations: deposits.confirmations,
        requiredConfirmations: deposits.requiredConfirmations,
        status: deposits.status,
        detectedAt: deposits.detectedAt,
        confirmedAt: deposits.confirmedAt,
        creditedAt: deposits.creditedAt,
      })
      .from(deposits)
      .where(and(...conditions))
      .orderBy(desc(deposits.detectedAt))
      .limit(limit)
      .offset(offset);

    return { deposits: rows };
  });

  // ─── Get Single Deposit ─────────────────────────────────────────────
  app.get('/api/deposits/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [deposit] = await db
      .select()
      .from(deposits)
      .where(and(eq(deposits.id, id), eq(deposits.userId, request.userId)));

    if (!deposit) {
      return reply.status(404).send({ error: 'Deposit not found' });
    }

    return deposit;
  });
}
