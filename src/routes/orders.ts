import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { orders, users, trades } from '../db/schema.js';
import { eq, and, desc, gte, lte, count } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { matchOrder, executeMatches, type MatchableOrder } from '../services/matching.js';
import { getPrice } from '../services/price.js';
import { getUserBalance, SUPPORTED_ASSETS } from '../services/balance.js';
import { createPlatformFill, createPlatformBuyFill } from '../services/platform.js';
import { env } from '../config/env.js';
import { redis } from '../services/redis.js';
import Decimal from 'decimal.js';

const createOrderSchema = z.object({
  type: z.enum(['buy', 'sell']),
  cryptoAsset: z.enum(['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK']),
  amountFiat: z.number().min(20, 'Minimum order is $20 CAD').max(100_000),
  idempotencyKey: z.string().uuid().optional(),
});

const uuidParamSchema = z.object({ id: z.string().uuid() });

export async function orderRoutes(app: FastifyInstance) {
  // ─── Trading Config (public) ────────────────────────────────────────
  app.get('/api/config/trading', async () => {
    return {
      feePercent: env.TAKER_FEE_PERCENT,
      spreadPercent: env.PLATFORM_SPREAD_PERCENT,
      paymentWindowMinutes: env.PAYMENT_WINDOW_MINUTES,
      newUserTradeLimit: env.NEW_USER_TRADE_LIMIT,
      maxTradeLimit: env.MAX_TRADE_LIMIT,
      swapSpreadPercent: env.PLATFORM_SPREAD_PERCENT,
      withdrawalFees: {
        BTC:  { chain: 'Bitcoin',       fee: '0.00005' },
        ETH:  { chain: 'Ethereum',      fee: '0.001' },
        LTC:  { chain: 'Litecoin',      fee: '0.001' },
        XRP:  { chain: 'XRP Ledger',    fee: '0.1' },
        SOL:  { chain: 'Solana',        fee: '0.005' },
        LINK: { chain: 'Ethereum',      fee: '0.5' },
      },
    };
  });

  // ─── User's Own Orders ──────────────────────────────────────────────
  app.get('/api/orders', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { status?: string; limit?: string; offset?: string; asset?: string; from?: string; to?: string };
    const limit = Math.min(Number(query.limit) || 20, 50);
    const offset = Math.min(Math.max(Number(query.offset) || 0, 0), 10_000);

    const validStatuses = ['active', 'paused', 'filled', 'cancelled'] as const;
    const conditions = [eq(orders.userId, request.userId)];
    if (query.status && validStatuses.includes(query.status as any)) {
      conditions.push(eq(orders.status, query.status));
    }
    if (query.asset && SUPPORTED_ASSETS.includes(query.asset.toUpperCase() as any)) {
      conditions.push(eq(orders.cryptoAsset, query.asset.toUpperCase()));
    }
    if (query.from) {
      const fromDate = new Date(query.from);
      if (!isNaN(fromDate.getTime())) conditions.push(gte(orders.createdAt, fromDate));
    }
    if (query.to) {
      const toDate = new Date(query.to);
      if (!isNaN(toDate.getTime())) conditions.push(lte(orders.createdAt, toDate));
    }

    const condition = and(...conditions);

    const userOrders = await db
      .select()
      .from(orders)
      .where(condition)
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(orders)
      .where(condition);

    return { orders: userOrders, total, limit, offset };
  });

  // ─── Price Quote (Replaces public order book) ───────────────────────
  app.get('/api/prices/quote', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const query = request.query as { asset?: string; side?: string; amountFiat?: string };

    if (!query.asset || !query.side) {
      return reply.status(400).send({ error: 'asset and side are required' });
    }

    const asset = query.asset.toUpperCase();
    const side = query.side.toLowerCase();
    const amountFiat = Math.min(Math.max(Number(query.amountFiat) || 500, 1), 1_000_000);

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

    const spreadDec = new Decimal(env.PLATFORM_SPREAD_PERCENT).dividedBy(100);
    const feePercent = env.TAKER_FEE_PERCENT;

    // Buy price = market + spread, Sell price = market - spread (using Decimal.js for precision)
    const pricePerUnit = side === 'buy'
      ? new Decimal(priceData.cadPrice).times(new Decimal(1).plus(spreadDec)).toNumber()
      : new Decimal(priceData.cadPrice).times(new Decimal(1).minus(spreadDec)).toNumber();

    const amountCrypto = new Decimal(amountFiat).dividedBy(pricePerUnit);
    const feePerSide = amountCrypto.times(feePercent).dividedBy(100);
    const totalFee = feePerSide.times(2); // both buyer and seller side — must match actual trade execution
    const youReceive = side === 'buy'
      ? amountCrypto.minus(totalFee)
      : new Decimal(amountFiat); // seller receives CAD

    return {
      asset,
      side,
      pricePerUnit: Number(pricePerUnit.toFixed(2)),
      amountFiat,
      amountCrypto: amountCrypto.toFixed(8),
      fee: totalFee.toFixed(8),
      feePerSide: feePerSide.toFixed(8),
      youReceive: side === 'buy' ? youReceive.toFixed(8) : youReceive.toFixed(2),
      currency: side === 'buy' ? asset : 'CAD',
    };
  });

  // ─── Create Order ─────────────────────────────────────────────────────
  app.post('/api/orders', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = createOrderSchema.parse(request.body);

    // Idempotency: if the client sends a key we've seen, return the cached result
    if (body.idempotencyKey) {
      const cached = await redis.get(`order:idempotency:${body.idempotencyKey}`);
      if (cached) {
        const result = JSON.parse(cached);
        return reply.status(result._status ?? 201).send(result.body);
      }
    }

    // Validate user exists
    const [user] = await db.select().from(users).where(eq(users.id, request.userId));
    if (!user) return reply.status(404).send({ error: 'User not found' });

    // Buyers must be KYC verified
    if (body.type === 'buy') {
      if (user.kycStatus !== 'verified') {
        return reply.status(403).send({ error: 'Identity verification required before buying crypto' });
      }
    }

    // Sellers must be KYC verified and have autodeposit enabled
    if (body.type === 'sell') {
      if (user.kycStatus !== 'verified') {
        return reply.status(403).send({
          error: 'Identity verification required before selling crypto',
        });
      }
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

    const spreadDec = new Decimal(env.PLATFORM_SPREAD_PERCENT).dividedBy(100);
    const effectivePrice = body.type === 'buy'
      ? new Decimal(priceData.cadPrice).times(new Decimal(1).plus(spreadDec)).toNumber()
      : new Decimal(priceData.cadPrice).times(new Decimal(1).minus(spreadDec)).toNumber();

    // Sell orders: validate that the net amount after fees is meaningful
    if (body.type === 'sell') {
      const feePercent = env.TAKER_FEE_PERCENT;
      const grossCrypto = new Decimal(body.amountFiat).dividedBy(effectivePrice);
      const totalFee = grossCrypto.times(feePercent).dividedBy(100).times(2);
      const netFiat = new Decimal(body.amountFiat).minus(
        totalFee.times(effectivePrice),
      );
      if (netFiat.lt(20)) {
        return reply.status(400).send({
          error: 'After fees, the net proceeds are below the $20 CAD minimum. Increase your sell amount.',
        });
      }
    }

    // Create order atomically — for sell orders, balance check + order creation
    // happen inside a transaction to prevent TOCTOU double-spend.
    const requiredCrypto = body.type === 'sell'
      ? new Decimal(body.amountFiat).dividedBy(effectivePrice)
      : null;

    const [order] = await db.transaction(async (tx) => {
      // Sellers must have sufficient available balance (checked inside tx)
      if (body.type === 'sell' && requiredCrypto) {
        const balance = await getUserBalance(request.userId, body.cryptoAsset, tx);

        if (!balance || new Decimal(balance.available).lt(requiredCrypto)) {
          throw new Error(`Insufficient ${body.cryptoAsset} balance`);
        }
      }

      return tx
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
          minTrade: '20',                       // $20 CAD minimum per match — enables partial fills
          maxTrade: String(body.amountFiat),    // Up to full order size per match
        })
        .returning();
    }).catch((err: unknown) => {
      // Re-throw as a 400 for balance errors
      const msg = err instanceof Error ? err.message : '';
      if (msg.startsWith('Insufficient')) {
        return reply.status(400).send({ error: 'Insufficient balance for this order' }) as never;
      }
      throw err;
    });

    // Attempt P2P matching first (invisible to user)
    const matchable: MatchableOrder = {
      id: order.id,
      userId: request.userId,
      type: body.type,
      cryptoAsset: body.cryptoAsset,
      effectivePrice,
      remainingFiat: body.amountFiat,
      minTrade: 20,          // $20 minimum per match — enables partial fills
      maxTrade: body.amountFiat,
      createdAt: order.createdAt,
    };

    // Helper to cache idempotent results (5-minute TTL)
    const cacheResult = async (status: number, responseBody: Record<string, unknown>) => {
      if (body.idempotencyKey) {
        await redis.set(
          `order:idempotency:${body.idempotencyKey}`,
          JSON.stringify({ _status: status, body: responseBody }),
          'EX', 300,
        );
      }
    };

    // ─── P2P Matching + Platform Gap-Fill ───────────────────────────────
    //
    // 1. Try P2P matching (may partially fill via multiple counterparties)
    // 2. If remaining after P2P: platform fills the gap
    // 3. Every order is always 100% filled — P2P where possible, platform for the rest

    const allTradeIds: string[] = [];

    const matches = await matchOrder(matchable);
    if (matches.length > 0) {
      const p2pTradeIds = await executeMatches(order.id, matches, body.cryptoAsset);
      allTradeIds.push(...p2pTradeIds);
    }

    // Reload order to check remaining after P2P matching
    const [updatedOrder] = await db.select({ remainingFiat: orders.remainingFiat, status: orders.status })
      .from(orders).where(eq(orders.id, order.id));
    const remainingFiat = Number(updatedOrder?.remainingFiat ?? body.amountFiat);

    // Platform gap-fill: fill whatever P2P couldn't match
    if (remainingFiat > 0 && updatedOrder?.status === 'active') {
      const gapFillFn = body.type === 'buy' ? createPlatformFill : createPlatformBuyFill;
      const platformTradeId = await gapFillFn(
        order.id,
        request.userId,
        body.cryptoAsset,
        remainingFiat,
        effectivePrice,
      );

      if (platformTradeId) {
        allTradeIds.push(platformTradeId);
        await db.update(orders)
          .set({ status: 'filled', remainingFiat: '0', updatedAt: new Date() })
          .where(eq(orders.id, order.id));
      } else if (allTradeIds.length === 0) {
        // No P2P matches AND platform fill failed — cancel the ghost order
        await db.update(orders)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(orders.id, order.id));
        return reply.status(500).send({ error: 'Unable to process order. Please try again.' });
      }
      // else: partial P2P fill succeeded but platform gap-fill failed
      // Order stays active with remaining amount — background re-matching will retry
    }

    if (allTradeIds.length === 0) {
      // Shouldn't happen (platform fill is always attempted), but defensive
      await db.update(orders)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(orders.id, order.id));
      return reply.status(500).send({ error: 'Unable to process order. Please try again.' });
    }

    // Compute total fiat across all matched trades
    const filledTrades = await db.select({ amountFiat: trades.amountFiat })
      .from(trades).where(eq(trades.orderId, order.id));
    const totalFilledFiat = filledTrades.reduce((sum, t) => sum + Number(t.amountFiat), 0);

    const result = {
      orderId: order.id,
      tradeId: allTradeIds[0],        // backward compat — first trade ID
      tradeIds: allTradeIds,
      tradeCount: allTradeIds.length,
      totalFiat: String(totalFilledFiat),
      status: 'processing',
      message: 'Order placed successfully.',
    };
    await cacheResult(201, result);
    return reply.status(201).send(result);
  });

  // ─── Cancel Order ─────────────────────────────────────────────────────
  app.delete('/api/orders/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [order] = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.userId, request.userId)));

    if (!order) return reply.status(404).send({ error: 'Order not found' });
    if (order.status !== 'active' && order.status !== 'paused') {
      return reply.status(400).send({ error: 'Cannot cancel this order' });
    }

    // Cancel the order. Note: crypto is only locked per-trade (during matching/escrow),
    // NOT per-order, so no balance refund is needed. Any in-flight trades from partial
    // fills continue with their own escrow lifecycle.
    await db
      .update(orders)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(orders.id, id));

    return { success: true, message: 'Order cancelled' };
  });
}
