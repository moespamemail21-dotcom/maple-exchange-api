import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { trades, orders } from '../db/schema.js';
import { eq, and, or, desc, count, gte, lte, sql } from 'drizzle-orm';
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
      return 'unknown';
  }
}

const uuidParamSchema = z.object({ id: z.string().uuid() });

const disputeSchema = z.object({
  reason: z.string().min(10).max(2000),
  evidenceUrls: z.array(z.string().url()).optional(),
});

export async function tradeRoutes(app: FastifyInstance) {
  // ─── Get My Trades (Sanitized) ──────────────────────────────────────
  app.get('/api/trades', { preHandler: [authGuard] }, async (request, reply) => {
    const query = request.query as { status?: string; limit?: string; offset?: string; from?: string; to?: string; asset?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.min(Math.max(Number(query.offset) || 0, 0), 10_000);

    // Validate status if provided
    const VALID_STATUSES = ['pending', 'escrow_funded', 'payment_sent', 'payment_confirmed', 'crypto_released', 'completed', 'expired', 'cancelled', 'disputed', 'resolved_buyer', 'resolved_seller'];
    if (query.status && !VALID_STATUSES.includes(query.status)) {
      return reply.status(400).send({ error: `Invalid status. Allowed: ${VALID_STATUSES.join(', ')}` });
    }

    const conditions = [
      or(
        eq(trades.buyerId, request.userId),
        eq(trades.sellerId, request.userId),
      ),
    ];
    if (query.status) conditions.push(eq(trades.status, query.status));
    if (query.asset) conditions.push(eq(trades.cryptoAsset, query.asset.toUpperCase()));
    if (query.from) {
      const fromDate = new Date(query.from);
      if (!isNaN(fromDate.getTime())) conditions.push(gte(trades.createdAt, fromDate));
    }
    if (query.to) {
      const toDate = new Date(query.to);
      if (!isNaN(toDate.getTime())) conditions.push(lte(trades.createdAt, toDate));
    }

    const myTrades = await db
      .select()
      .from(trades)
      .where(and(...conditions))
      .orderBy(desc(trades.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(trades)
      .where(and(...conditions));

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
      escrowFundedAt: t.escrowFundedAt,
      paymentSentAt: t.paymentSentAt,
      paymentConfirmedAt: t.paymentConfirmedAt,
      cryptoReleasedAt: t.cryptoReleasedAt,
      completedAt: t.completedAt,
      expiresAt: t.expiresAt,
    }));

    return { trades: sanitized, total, limit, offset };
  });

  // ─── Get Trade Detail (Sanitized) ───────────────────────────────────
  app.get('/api/trades/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

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
      escrowFundedAt: trade.escrowFundedAt,
      paymentSentAt: trade.paymentSentAt,
      paymentConfirmedAt: trade.paymentConfirmedAt,
      cryptoReleasedAt: trade.cryptoReleasedAt,
      completedAt: trade.completedAt,
      expiresAt: trade.expiresAt,
      paymentInstructions,
    };
  });

  // ─── Mark Payment Sent (Buyer action) ─────────────────────────────────
  app.post('/api/trades/:id/payment-sent', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
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
    const { id } = uuidParamSchema.parse(request.params);
    const result = await transitionTrade(id, 'cancelled', request.userId);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }
    return { success: true, message: 'Order cancelled.' };
  });

  // ─── Open Dispute ─────────────────────────────────────────────────────
  app.post('/api/trades/:id/dispute', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const body = disputeSchema.parse(request.body);

    const result = await openDispute(id, request.userId, body.reason, body.evidenceUrls);
    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }
    return { success: true, message: 'Your issue has been submitted. Our team will review it shortly.' };
  });

  // ─── Order-Level: Get All Trades for an Order ───────────────────────
  app.get('/api/orders/:id/trades', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    // Verify the order belongs to this user
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    if (!order) return reply.status(404).send({ error: 'Order not found' });
    if (order.userId !== request.userId) return reply.status(403).send({ error: 'Access denied' });

    // Fetch all child trades
    const orderTrades = await db.select().from(trades)
      .where(eq(trades.orderId, id))
      .orderBy(desc(trades.createdAt));

    const isBuyer = order.type === 'buy';

    const sanitized = orderTrades.map((t) => ({
      id: t.id,
      type: isBuyer ? 'buy' as const : 'sell' as const,
      cryptoAsset: t.cryptoAsset,
      amountCrypto: t.amountCrypto,
      amountFiat: t.amountFiat,
      pricePerUnit: t.pricePerUnit,
      fee: t.feeAmount,
      status: mapStatus(t.status),
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      completedAt: t.completedAt,
    }));

    const totalFiat = orderTrades.reduce((sum, t) => sum + Number(t.amountFiat), 0);
    const completedCount = orderTrades.filter((t) => t.status === 'completed').length;
    const allCompleted = completedCount === orderTrades.length && orderTrades.length > 0;

    return {
      orderId: id,
      orderStatus: order.status,
      trades: sanitized,
      summary: {
        totalFiat: totalFiat.toFixed(2),
        tradeCount: orderTrades.length,
        completedCount,
        allCompleted,
      },
    };
  });

  // ─── Order-Level: Mark Payment Sent for All Trades ──────────────────
  app.post('/api/orders/:id/payment-sent', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    // Verify the order belongs to this user and is a buy order
    const [order] = await db.select().from(orders).where(eq(orders.id, id));
    if (!order) return reply.status(404).send({ error: 'Order not found' });
    if (order.userId !== request.userId) return reply.status(403).send({ error: 'Access denied' });

    // Find all child trades at escrow_funded that this user is the buyer
    const pendingTrades = await db.select().from(trades)
      .where(and(
        eq(trades.orderId, id),
        eq(trades.buyerId, request.userId),
        eq(trades.status, 'escrow_funded'),
      ));

    if (pendingTrades.length === 0) {
      return reply.status(400).send({ error: 'No trades awaiting payment for this order' });
    }

    // Advance all child trades to payment_sent
    let advanced = 0;
    for (const trade of pendingTrades) {
      const result = await transitionTrade(trade.id, 'payment_sent', request.userId);
      if (result.success) {
        advanced++;
        // Auto-advance platform trades (sets hold period then completes)
        if (isPlatformUser(trade.sellerId)) {
          await autoAdvancePlatformTrade(trade.id);
        }
      }
    }

    return {
      success: true,
      tradesAdvanced: advanced,
      totalTrades: pendingTrades.length,
      message: 'Payment received. Your crypto is being processed.',
    };
  });
}
