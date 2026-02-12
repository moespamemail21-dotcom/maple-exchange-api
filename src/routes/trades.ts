import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { trades } from '../db/schema.js';
import { eq, and, or, desc } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { transitionTrade, openDispute } from '../services/trade.js';
import { autoAdvancePlatformTrade, isPlatformUser } from '../services/platform.js';
import { env } from '../config/env.js';

// ─── Status Mapping: Internal → User-Facing ────────────────────────────────

function mapStatus(internal: string): string {
  switch (internal) {
    case 'pending':
    case 'escrow_funded':
      return 'pending';
    case 'payment_sent':
    case 'payment_confirmed':
    case 'crypto_released':
      return 'processing';
    case 'completed':
      return 'completed';
    case 'expired':
    case 'cancelled':
      return 'cancelled';
    case 'disputed':
    case 'resolved_buyer':
    case 'resolved_seller':
      return 'under_review';
    default:
      return 'pending';
  }
}

const disputeSchema = z.object({
  reason: z.string().min(10).max(2000),
  evidenceUrls: z.array(z.string().url()).optional(),
});

export async function tradeRoutes(app: FastifyInstance) {
  // ─── Get My Trades (Sanitized) ──────────────────────────────────────
  app.get('/api/trades', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { status?: string };

    const conditions = [
      or(
        eq(trades.buyerId, request.userId),
        eq(trades.sellerId, request.userId),
      ),
    ];
    if (query.status) conditions.push(eq(trades.status, query.status));

    const myTrades = await db
      .select()
      .from(trades)
      .where(and(...conditions))
      .orderBy(desc(trades.createdAt));

    // Sanitize: no counterparty IDs, mapped statuses
    const sanitized = myTrades.map((t) => ({
      id: t.id,
      type: t.buyerId === request.userId ? 'buy' as const : 'sell' as const,
      cryptoAsset: t.cryptoAsset,
      amountCrypto: t.amountCrypto,
      amountFiat: t.amountFiat,
      pricePerUnit: t.pricePerUnit,
      fee: t.feeAmount,
      status: mapStatus(t.status),
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      expiresAt: t.expiresAt,
    }));

    return { trades: sanitized };
  });

  // ─── Get Trade Detail (Sanitized) ───────────────────────────────────
  app.get('/api/trades/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [trade] = await db
      .select()
      .from(trades)
      .where(eq(trades.id, id));

    if (!trade) return reply.status(404).send({ error: 'Trade not found' });

    // Only trade participants can view details
    if (trade.buyerId !== request.userId && trade.sellerId !== request.userId) {
      return reply.status(403).send({ error: 'Access denied' });
    }

    const isBuyer = trade.buyerId === request.userId;
    const userFacingStatus = mapStatus(trade.status);

    // Payment instructions: only for buyers in pending status
    let paymentInstructions: object | null = null;
    if (isBuyer && trade.status === 'escrow_funded') {
      paymentInstructions = {
        method: 'interac_etransfer',
        recipientEmail: env.PLATFORM_INTERAC_EMAIL,
        amount: trade.amountFiat,
        reference: trade.id.slice(0, 8).toUpperCase(),
      };
    }

    return {
      id: trade.id,
      type: isBuyer ? 'buy' : 'sell',
      cryptoAsset: trade.cryptoAsset,
      amountCrypto: trade.amountCrypto,
      amountFiat: trade.amountFiat,
      pricePerUnit: trade.pricePerUnit,
      fee: trade.feeAmount,
      status: userFacingStatus,
      createdAt: trade.createdAt,
      completedAt: trade.completedAt,
      expiresAt: trade.expiresAt,
      paymentInstructions,
    };
  });

  // ─── Mark Payment Sent (Buyer action) ─────────────────────────────────
  app.post('/api/trades/:id/payment-sent', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await transitionTrade(id, 'payment_sent', request.userId);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    // If the seller is the platform, auto-advance (sets hold period)
    const [trade] = await db.select().from(trades).where(eq(trades.id, id));
    if (trade && isPlatformUser(trade.sellerId)) {
      await autoAdvancePlatformTrade(id);
      return { success: true, message: 'Payment received. Your crypto is being processed.' };
    }

    return { success: true, message: 'Payment sent. Processing your order.' };
  });

  // ─── Cancel Trade (Before payment sent) ──────────────────────────────
  app.post('/api/trades/:id/cancel', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await transitionTrade(id, 'cancelled', request.userId);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }
    return { success: true, message: 'Order cancelled.' };
  });

  // ─── Open Dispute ─────────────────────────────────────────────────────
  app.post('/api/trades/:id/dispute', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = disputeSchema.parse(request.body);

    const result = await openDispute(id, request.userId, body.reason, body.evidenceUrls);
    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }
    return { success: true, message: 'Your issue has been submitted. Our team will review it shortly.' };
  });
}
