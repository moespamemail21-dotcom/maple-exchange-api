import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { orders, users } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { matchOrder, executeMatches, type MatchableOrder } from '../services/matching.js';
import { getPrice } from '../services/price.js';
import { getUserBalance, SUPPORTED_ASSETS } from '../services/balance.js';
import { createPlatformFill, createPlatformBuyFill } from '../services/platform.js';
import { env } from '../config/env.js';
import Decimal from 'decimal.js';

const createOrderSchema = z.object({
  type: z.enum(['buy', 'sell']),
  cryptoAsset: z.enum(['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK']),
  amountFiat: z.number().positive(),
});

export async function orderRoutes(app: FastifyInstance) {
  // ─── Trading Config (public) ────────────────────────────────────────
  app.get('/api/config/trading', async () => {
    return {
      feePercent: env.TAKER_FEE_PERCENT,
      spreadPercent: env.PLATFORM_SPREAD_PERCENT,
      paymentWindowMinutes: env.PAYMENT_WINDOW_MINUTES,
      newUserTradeLimit: env.NEW_USER_TRADE_LIMIT,
      maxTradeLimit: env.MAX_TRADE_LIMIT,
    };
  });

  // ─── User's Own Orders ──────────────────────────────────────────────
  app.get('/api/orders', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 20, 50);
    const offset = Number(query.offset) || 0;

    const condition = query.status
      ? and(eq(orders.userId, request.userId), eq(orders.status, query.status))
      : eq(orders.userId, request.userId);

    const userOrders = await db
      .select()
      .from(orders)
      .where(condition)
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);

    return { orders: userOrders };
  });

  // ─── Price Quote (Replaces public order book) ───────────────────────
  app.get('/api/prices/quote', async (request, reply) => {
    const query = request.query as { asset?: string; side?: string; amountFiat?: string };

    if (!query.asset || !query.side) {
      return reply.status(400).send({ error: 'asset and side are required' });
    }

    const asset = query.asset.toUpperCase();
    const side = query.side.toLowerCase();
    const amountFiat = Number(query.amountFiat) || 500;

    if (!SUPPORTED_ASSETS.includes(asset as any)) {
      return reply.status(400).send({ error: `Unsupported asset. Allowed: ${SUPPORTED_ASSETS.join(', ')}` });
    }

    if (!['buy', 'sell'].includes(side)) {
      return reply.status(400).send({ error: 'side must be buy or sell' });
    }

    const priceData = await getPrice(asset);
    if (!priceData) {
      return reply.status(400).send({ error: `Unable to fetch price for ${asset}` });
    }

    const spread = env.PLATFORM_SPREAD_PERCENT / 100;
    const feePercent = env.TAKER_FEE_PERCENT;

    // Buy price = market + spread, Sell price = market - spread
    const pricePerUnit = side === 'buy'
      ? priceData.cadPrice * (1 + spread)
      : priceData.cadPrice * (1 - spread);

    const amountCrypto = new Decimal(amountFiat).dividedBy(pricePerUnit);
    const feePerSide = amountCrypto.times(feePercent).dividedBy(100);
    const youReceive = side === 'buy'
      ? amountCrypto.minus(feePerSide)
      : new Decimal(amountFiat); // seller receives CAD

    return {
      asset,
      side,
      pricePerUnit: Number(pricePerUnit.toFixed(2)),
      amountFiat,
      amountCrypto: amountCrypto.toFixed(8),
      fee: feePerSide.toFixed(8),
      youReceive: side === 'buy' ? youReceive.toFixed(8) : youReceive.toFixed(2),
      currency: side === 'buy' ? asset : 'CAD',
    };
  });

  // ─── Create Order ─────────────────────────────────────────────────────
  app.post('/api/orders', { preHandler: [authGuard] }, async (request, reply) => {
    const body = createOrderSchema.parse(request.body);

    // Validate user exists
    const [user] = await db.select().from(users).where(eq(users.id, request.userId));
    if (!user) return reply.status(404).send({ error: 'User not found' });

    // Buyers must be KYC verified
    if (body.type === 'buy') {
      if (user.kycStatus !== 'verified') {
        return reply.status(403).send({ error: 'Identity verification required before buying crypto' });
      }
    }

    // Sellers must have autodeposit enabled
    if (body.type === 'sell') {
      if (!user.autodepositVerified) {
        return reply.status(400).send({
          error: 'Interac autodeposit must be enabled before selling.',
        });
      }
    }

    // Trade limit check
    const effectiveLimit = body.type === 'sell'
      ? Number(user.maxTradeLimit)
      : Math.max(Number(user.maxTradeLimit), 3000);
    if (body.amountFiat > effectiveLimit) {
      return reply.status(400).send({
        error: `Amount exceeds your current limit of $${effectiveLimit}. Complete more trades to increase your limit.`,
      });
    }

    // Get price with spread
    const priceData = await getPrice(body.cryptoAsset);
    if (!priceData) {
      return reply.status(400).send({ error: `Unable to fetch price for ${body.cryptoAsset}` });
    }

    const spread = env.PLATFORM_SPREAD_PERCENT / 100;
    const effectivePrice = body.type === 'buy'
      ? priceData.cadPrice * (1 + spread)
      : priceData.cadPrice * (1 - spread);

    // Sellers must have sufficient available balance
    if (body.type === 'sell') {
      const requiredCrypto = new Decimal(body.amountFiat).dividedBy(effectivePrice);
      const balance = await getUserBalance(request.userId, body.cryptoAsset);

      if (!balance || new Decimal(balance.available).lt(requiredCrypto)) {
        const available = balance ? balance.available : '0';
        return reply.status(400).send({
          error: `Insufficient ${body.cryptoAsset} balance. Required: ${requiredCrypto.toFixed(8)}, Available: ${new Decimal(available).toFixed(8)}`,
        });
      }
    }

    // Create the order (internal record)
    const [order] = await db
      .insert(orders)
      .values({
        userId: request.userId,
        type: body.type,
        cryptoAsset: body.cryptoAsset,
        amountFiat: String(body.amountFiat),
        remainingFiat: String(body.amountFiat),
        priceType: 'market',
        pricePremium: '0',
        fixedPrice: null,
        minTrade: String(body.amountFiat),
        maxTrade: String(body.amountFiat),
      })
      .returning();

    // Attempt P2P matching first (invisible to user)
    const matchable: MatchableOrder = {
      id: order.id,
      userId: request.userId,
      type: body.type,
      cryptoAsset: body.cryptoAsset,
      effectivePrice,
      remainingFiat: body.amountFiat,
      minTrade: body.amountFiat,
      maxTrade: body.amountFiat,
      createdAt: order.createdAt,
    };

    const matches = await matchOrder(matchable);
    if (matches.length > 0) {
      const tradeIds = await executeMatches(order.id, matches, body.cryptoAsset);

      await db
        .update(orders)
        .set({ status: 'filled', remainingFiat: '0', updatedAt: new Date() })
        .where(eq(orders.id, order.id));

      return reply.status(201).send({
        tradeId: tradeIds[0],
        status: 'processing',
        message: 'Order placed successfully.',
      });
    }

    // ─── No P2P match → Platform fills ──────────────────────────────────

    if (body.type === 'buy') {
      const platformTradeId = await createPlatformFill(
        order.id,
        request.userId,
        body.cryptoAsset,
        body.amountFiat,
        effectivePrice,
      );

      if (platformTradeId) {
        await db
          .update(orders)
          .set({ status: 'filled', remainingFiat: '0', updatedAt: new Date() })
          .where(eq(orders.id, order.id));

        return reply.status(201).send({
          tradeId: platformTradeId,
          status: 'processing',
          message: 'Order placed successfully.',
        });
      }
    }

    if (body.type === 'sell') {
      const platformTradeId = await createPlatformBuyFill(
        order.id,
        request.userId,
        body.cryptoAsset,
        body.amountFiat,
        effectivePrice,
      );

      if (platformTradeId) {
        await db
          .update(orders)
          .set({ status: 'filled', remainingFiat: '0', updatedAt: new Date() })
          .where(eq(orders.id, order.id));

        return reply.status(201).send({
          tradeId: platformTradeId,
          status: 'completed',
          message: 'Sell order completed.',
        });
      }
    }

    // Fallback: order goes on book (should rarely happen)
    return reply.status(201).send({
      tradeId: null,
      status: 'pending',
      message: 'Order placed. Processing may take a moment.',
    });
  });

  // ─── Cancel Order ─────────────────────────────────────────────────────
  app.delete('/api/orders/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.userId, request.userId)));

    if (!order) return reply.status(404).send({ error: 'Order not found' });
    if (order.status !== 'active' && order.status !== 'paused') {
      return reply.status(400).send({ error: 'Cannot cancel this order' });
    }

    await db
      .update(orders)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(orders.id, id));

    return { success: true, message: 'Order cancelled' };
  });
}
