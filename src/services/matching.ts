import { logger } from '../config/logger.js';
import { db } from '../db/index.js';
import { orders, trades } from '../db/schema.js';
import { eq, and, ne, gt, sql } from 'drizzle-orm';
import { redis, KEYS } from './redis.js';
import { getPrice } from './price.js';
import { env } from '../config/env.js';
import { mutateBalance } from './balance.js';
import Decimal from 'decimal.js';

// ─── Types ──────────────────────────────────────────────────────────────────
export interface MatchableOrder {
  id: string;
  userId: string;
  type: 'buy' | 'sell';
  cryptoAsset: string;
  effectivePrice: number;  // CAD per unit (after premium applied)
  remainingFiat: number;
  minTrade: number;
  maxTrade: number;
  createdAt: Date;
}

export interface TradeMatch {
  orderId: string;
  buyerId: string;
  sellerId: string;
  amountFiat: number;      // includes random cents
  amountCrypto: number;
  pricePerUnit: number;
  feePercent: number;
  feeAmount: number;       // in crypto
}

// ─── Matching Engine ────────────────────────────────────────────────────────

/**
 * Match an incoming order against the order book.
 * Uses Price-Time Priority (FIFO) with partial fill support.
 *
 * For buy orders: matches against lowest-priced sell orders first.
 * For sell orders: matches against highest-priced buy orders first.
 */
export async function matchOrder(incoming: MatchableOrder): Promise<TradeMatch[]> {
  const oppositeType = incoming.type === 'buy' ? 'sell' : 'buy';

  // Asset-specific advisory lock to prevent concurrent double-matching.
  // Use polynomial hash (FNV-1a inspired) to avoid collisions from simple byte-sum.
  const assetLockId = Buffer.from(incoming.cryptoAsset).reduce(
    (hash, b) => ((hash ^ b) * 16777619) | 0, // FNV prime, keep as 32-bit int
    2166136261, // FNV offset basis
  );
  await db.execute(sql`SELECT pg_advisory_lock(${assetLockId})`);

  try {
    return await matchOrderInner(incoming, oppositeType);
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${assetLockId})`);
  }
}

async function matchOrderInner(incoming: MatchableOrder, oppositeType: string): Promise<TradeMatch[]> {
  // Fetch active orders on the opposite side with FOR UPDATE to prevent double-matching
  const candidates = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.status, 'active'),
        eq(orders.type, oppositeType),
        eq(orders.cryptoAsset, incoming.cryptoAsset),
        ne(orders.userId, incoming.userId), // can't self-trade
        gt(orders.createdAt, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)), // exclude stale orders (>90 days)
      )
    );

  // Resolve effective prices for each candidate
  const resolved: MatchableOrder[] = [];
  for (const c of candidates) {
    const effectivePrice = await resolvePrice(c.cryptoAsset, c.priceType, c.pricePremium, c.fixedPrice);
    if (effectivePrice === null) continue;

    resolved.push({
      id: c.id,
      userId: c.userId,
      type: c.type as 'buy' | 'sell',
      cryptoAsset: c.cryptoAsset,
      effectivePrice,
      remainingFiat: Number(c.remainingFiat),
      minTrade: Number(c.minTrade),
      maxTrade: Number(c.maxTrade),
      createdAt: c.createdAt,
    });
  }

  // Sort by best price, then oldest first (FIFO)
  resolved.sort((a, b) => {
    const priceSort = incoming.type === 'buy'
      ? a.effectivePrice - b.effectivePrice    // buy: cheapest sells first
      : b.effectivePrice - a.effectivePrice;   // sell: highest buys first
    if (priceSort !== 0) return priceSort;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });

  const matches: TradeMatch[] = [];
  let remaining = incoming.remainingFiat;

  for (const candidate of resolved) {
    if (remaining <= 0) break;

    // Price compatibility check
    if (incoming.type === 'buy' && candidate.effectivePrice > incoming.effectivePrice) break;
    if (incoming.type === 'sell' && candidate.effectivePrice < incoming.effectivePrice) break;

    // Calculate fill amount (respecting both sides' min/max)
    const fillFiat = Decimal.min(
      remaining,
      candidate.remainingFiat,
      candidate.maxTrade,
      incoming.maxTrade,
    ).toNumber();

    // Skip if below either party's minimum
    if (fillFiat < candidate.minTrade || fillFiat < incoming.minTrade) continue;

    // Add random cents for e-Transfer disambiguation (0.01 - 0.99)
    // Clamp to not exceed either party's maxTrade or remaining amounts
    const randomCents = Math.floor(Math.random() * 99 + 1) / 100;
    const maxAllowed = Math.min(candidate.maxTrade, incoming.maxTrade, candidate.remainingFiat, remaining);
    const rawDisambiguated = new Decimal(fillFiat).plus(randomCents).toDecimalPlaces(2);
    const disambiguatedFiat = Decimal.min(rawDisambiguated, new Decimal(maxAllowed)).toNumber();

    // Calculate crypto amount at the trade price
    const amountCrypto = new Decimal(disambiguatedFiat).dividedBy(candidate.effectivePrice);

    // Fee charged on crypto — 0.2% to EACH side (buyer + seller)
    // Round UP to ensure platform never loses fractional satoshis
    const feePercent = env.TAKER_FEE_PERCENT; // 0.2% per side
    const feePerSide = amountCrypto.times(feePercent).dividedBy(100).toDecimalPlaces(8, Decimal.ROUND_UP);
    const totalFee = feePerSide.times(2).toDecimalPlaces(8, Decimal.ROUND_UP); // total platform revenue per trade

    matches.push({
      orderId: candidate.id,
      buyerId: incoming.type === 'buy' ? incoming.userId : candidate.userId,
      sellerId: incoming.type === 'sell' ? incoming.userId : candidate.userId,
      amountFiat: disambiguatedFiat,
      amountCrypto: amountCrypto.toDecimalPlaces(8).toNumber(), // 8 decimal places (satoshi precision)
      pricePerUnit: candidate.effectivePrice,
      feePercent,
      feeAmount: totalFee.toDecimalPlaces(8).toNumber(), // total fee (both sides combined)
    });

    // Reduce remaining amounts
    remaining = new Decimal(remaining).minus(fillFiat).toNumber();
    candidate.remainingFiat = new Decimal(candidate.remainingFiat).minus(fillFiat).toNumber();
  }

  return matches;
}

/**
 * Execute matched trades: lock seller's balance, create trade records at
 * escrow_funded status, update order remaining amounts, and publish events.
 *
 * Each match runs in its own transaction so a single seller's insufficient
 * balance doesn't block other valid matches. If a seller's balance lock fails
 * (e.g. multiple orders exhausted their crypto), that match is skipped.
 */
export async function executeMatches(
  incomingOrderId: string,
  matches: TradeMatch[],
  cryptoAsset: string,
): Promise<string[]> {
  const tradeIds: string[] = [];
  let totalFilledFiat = 0;

  for (const match of matches) {
    try {
      const tradeId = await db.transaction(async (tx) => {
        const now = new Date();

        // 0. Lock the matched order and verify it's still active (prevents race with cancel)
        await tx.execute(sql`SELECT id FROM orders WHERE id = ${match.orderId} FOR UPDATE`);
        const [matchedOrder] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, match.orderId));
        if (!matchedOrder || matchedOrder.status !== 'active') {
          return null; // Order was cancelled/paused between match and execution
        }

        // 1. Create trade record at escrow_funded (auto-escrow on match)
        const [trade] = await tx
          .insert(trades)
          .values({
            orderId: match.orderId,
            buyerId: match.buyerId,
            sellerId: match.sellerId,
            cryptoAsset,
            amountCrypto: String(match.amountCrypto),
            amountFiat: String(match.amountFiat),
            pricePerUnit: String(match.pricePerUnit),
            feePercent: String(match.feePercent),
            feeAmount: String(match.feeAmount),
            status: 'escrow_funded',
            escrowFundedAt: now,
            expiresAt: new Date(now.getTime() + env.PAYMENT_WINDOW_MINUTES * 60 * 1000),
          })
          .returning({ id: trades.id });

        // 2. Lock seller's crypto: available → locked
        //    If insufficient balance, the transaction rolls back (no orphaned trade).
        await mutateBalance(tx, {
          userId: match.sellerId,
          asset: cryptoAsset,
          field: 'available',
          amount: new Decimal(match.amountCrypto).negated().toFixed(18),
          entryType: 'trade_escrow_lock',
          idempotencyKey: `trade:${trade.id}:escrow_lock:available`,
          tradeId: trade.id,
          note: `Auto-escrow lock on trade match`,
        });
        await mutateBalance(tx, {
          userId: match.sellerId,
          asset: cryptoAsset,
          field: 'locked',
          amount: new Decimal(match.amountCrypto).toFixed(18),
          entryType: 'trade_escrow_lock',
          idempotencyKey: `trade:${trade.id}:escrow_lock:locked`,
          tradeId: trade.id,
          note: `Auto-escrow lock on trade match`,
        });

        // 3. Update the matched order's remaining fiat
        await tx
          .update(orders)
          .set({
            remainingFiat: sql`${orders.remainingFiat} - ${match.amountFiat}`,
            updatedAt: now,
          })
          .where(eq(orders.id, match.orderId));

        // Mark order as filled if nothing remaining
        await tx
          .update(orders)
          .set({ status: 'filled', updatedAt: now })
          .where(and(
            eq(orders.id, match.orderId),
            sql`${orders.remainingFiat} <= 0`,
          ));

        // Auto-cancel dust: remaining > 0 but below minTrade — unmatchable zombie
        await tx
          .update(orders)
          .set({ status: 'cancelled', updatedAt: now })
          .where(and(
            eq(orders.id, match.orderId),
            eq(orders.status, 'active'),
            sql`${orders.remainingFiat} > 0`,
            sql`${orders.remainingFiat} < ${orders.minTrade}`,
          ));

        return trade.id;
      });

      // Transaction returns null if the candidate order was cancelled/paused
      if (!tradeId) {
        logger.info({ orderId: match.orderId }, 'Match skipped — order no longer active');
        continue;
      }

      tradeIds.push(tradeId);
      totalFilledFiat = new Decimal(totalFilledFiat).plus(match.amountFiat).toNumber();

      // Publish trade event (outside transaction — Redis pub/sub)
      // Include buyerId/sellerId for WS routing only (stripped before sending to clients)
      await redis.publish(KEYS.tradeChannel, JSON.stringify({
        type: 'trade_created',
        tradeId,
        buyerId: match.buyerId,
        sellerId: match.sellerId,
        status: 'escrow_funded',
      }));
    } catch (err: any) {
      // Seller likely doesn't have enough balance (multiple orders exhausted it).
      // Skip this match — the order stays on the book for future matching.
      logger.warn(
        { orderId: match.orderId, err: err.message ?? String(err) },
        'Match skipped due to insufficient balance',
      );
      continue;
    }
  }

  // Update the incoming order's remaining fiat (only for successful matches)
  if (totalFilledFiat > 0) {
    await db
      .update(orders)
      .set({
        remainingFiat: sql`${orders.remainingFiat} - ${totalFilledFiat}`,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, incomingOrderId));

    // Mark incoming order as filled if fully matched
    await db
      .update(orders)
      .set({ status: 'filled', updatedAt: new Date() })
      .where(and(
        eq(orders.id, incomingOrderId),
        sql`${orders.remainingFiat} <= 0`,
      ));

    // Auto-cancel incoming if dust remaining (below minTrade — can never match again)
    await db
      .update(orders)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(
        eq(orders.id, incomingOrderId),
        eq(orders.status, 'active'),
        sql`${orders.remainingFiat} > 0`,
        sql`${orders.remainingFiat} < ${orders.minTrade}`,
      ));

    // Publish order book update
    await redis.publish(KEYS.orderBookChannel(cryptoAsset), JSON.stringify({
      type: 'orderbook_update',
      asset: cryptoAsset,
    }));
  }

  return tradeIds;
}

// ─── Background Re-Matching ─────────────────────────────────────────────────

/**
 * Re-attempt matching for active orders that have unfilled remaining amounts.
 * Run periodically (every 60s) alongside processExpiredTrades.
 *
 * Catches cases where a new sell order arrives after a buy was only partially
 * filled, or vice versa.
 */
export async function rematchActiveOrders(): Promise<number> {
  // Find orders that are still active with remaining amounts
  const activeOrders = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.status, 'active'),
        gt(orders.remainingFiat, sql`0`),
        gt(orders.createdAt, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)),
      ),
    );

  let matched = 0;

  for (const order of activeOrders) {
    const effectivePrice = await resolvePrice(
      order.cryptoAsset,
      order.priceType,
      order.pricePremium,
      order.fixedPrice,
    );
    if (!effectivePrice) continue;

    const matchable: MatchableOrder = {
      id: order.id,
      userId: order.userId,
      type: order.type as 'buy' | 'sell',
      cryptoAsset: order.cryptoAsset,
      effectivePrice,
      remainingFiat: Number(order.remainingFiat),
      minTrade: Number(order.minTrade),
      maxTrade: Number(order.maxTrade),
      createdAt: order.createdAt,
    };

    const matches = await matchOrder(matchable);
    if (matches.length > 0) {
      const tradeIds = await executeMatches(order.id, matches, order.cryptoAsset);
      if (tradeIds.length > 0) {
        matched += tradeIds.length;

        // Notify the order owner of new fills via Redis
        await redis.publish(KEYS.tradeChannel, JSON.stringify({
          type: 'order_partially_filled',
          orderId: order.id,
          newTradeIds: tradeIds,
          userId: order.userId,
        }));
      }
    }
  }

  if (matched > 0) {
    logger.info({ matchedTrades: matched }, 'Background re-matching found new fills');
  }
  return matched;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolvePrice(
  cryptoAsset: string,
  priceType: string,
  pricePremium: string | null,
  fixedPrice: string | null,
): Promise<number | null> {
  if (priceType === 'fixed' && fixedPrice) {
    return Number(fixedPrice);
  }

  // Market price + premium
  const priceData = await getPrice(cryptoAsset);
  if (!priceData) return null;

  const premium = new Decimal(pricePremium ?? 0);
  return new Decimal(priceData.cadPrice).times(premium.dividedBy(100).plus(1)).toNumber();
}
