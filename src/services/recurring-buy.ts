import { db } from '../db/index.js';
import { recurringBuys, orders, trades, notifications } from '../db/schema.js';
import { eq, and, lte, desc, inArray, sql } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import { getPrice } from './price.js';
import { createPlatformFill } from './platform.js';
import { env } from '../config/env.js';
import Decimal from 'decimal.js';

const VALID_FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;

function getNextRunDate(frequency: string, from: Date = new Date()): Date {
  if (!VALID_FREQUENCIES.includes(frequency as any)) {
    throw new Error(`Invalid recurring buy frequency: ${frequency}`);
  }
  const next = new Date(from);
  switch (frequency) {
    case 'daily': next.setDate(next.getDate() + 1); break;
    case 'weekly': next.setDate(next.getDate() + 7); break;
    case 'biweekly': next.setDate(next.getDate() + 14); break;
    case 'monthly': {
      // Prevent day overflow (e.g. Jan 31 → Feb 28, not Mar 3)
      const targetMonth = next.getMonth() + 1;
      next.setDate(1); // Reset to 1st to avoid overflow
      next.setMonth(targetMonth);
      // Clamp to last day of target month if original day exceeds it
      const originalDay = from.getDate();
      const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(originalDay, lastDay));
      break;
    }
  }
  return next;
}

export async function createRecurringBuy(userId: string, asset: string, amountCad: number, frequency: string) {
  const nextRunAt = getNextRunDate(frequency);
  const [buy] = await db.insert(recurringBuys).values({
    userId, asset, amountCad: String(amountCad), frequency, nextRunAt,
  }).returning();
  return buy;
}

export async function getUserRecurringBuys(userId: string) {
  return db.select().from(recurringBuys)
    .where(and(eq(recurringBuys.userId, userId), eq(recurringBuys.status, 'active')))
    .orderBy(desc(recurringBuys.createdAt));
}

export async function getAllUserRecurringBuys(userId: string) {
  return db.select().from(recurringBuys)
    .where(eq(recurringBuys.userId, userId))
    .orderBy(desc(recurringBuys.createdAt));
}

export async function pauseRecurringBuy(userId: string, buyId: string): Promise<boolean> {
  const [updated] = await db.update(recurringBuys)
    .set({ status: 'paused', updatedAt: new Date() })
    .where(and(eq(recurringBuys.id, buyId), eq(recurringBuys.userId, userId), eq(recurringBuys.status, 'active')))
    .returning({ id: recurringBuys.id });
  return !!updated;
}

export async function resumeRecurringBuy(userId: string, buyId: string): Promise<boolean> {
  const [row] = await db.select().from(recurringBuys)
    .where(and(eq(recurringBuys.id, buyId), eq(recurringBuys.userId, userId), eq(recurringBuys.status, 'paused')));
  if (!row) return false;

  const [updated] = await db.update(recurringBuys)
    .set({ status: 'active', nextRunAt: getNextRunDate(row.frequency), updatedAt: new Date() })
    .where(eq(recurringBuys.id, buyId))
    .returning({ id: recurringBuys.id });
  return !!updated;
}

export async function cancelRecurringBuy(userId: string, buyId: string): Promise<boolean> {
  // Only cancel active or paused buys — already-cancelled returns false
  const [updated] = await db.update(recurringBuys)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(
      eq(recurringBuys.id, buyId),
      eq(recurringBuys.userId, userId),
      inArray(recurringBuys.status, ['active', 'paused']),
    ))
    .returning({ id: recurringBuys.id });
  return !!updated;
}

/**
 * Process due recurring buys. Called on a timer.
 * Creates a real platform fill order (same as manual buy) and notifies the user.
 */
export async function processDueRecurringBuys(): Promise<number> {
  const now = new Date();
  const dueBuys = await db.select().from(recurringBuys)
    .where(and(eq(recurringBuys.status, 'active'), lte(recurringBuys.nextRunAt, now)));

  let processed = 0;
  for (const buy of dueBuys) {
    try {
      // Optimistic lock: advance schedule only if nextRunAt hasn't changed
      // (prevents double-execution in multi-instance deployments)
      const nextRun = getNextRunDate(buy.frequency, now);
      const [claimed] = await db.update(recurringBuys).set({
        lastRunAt: now,
        nextRunAt: nextRun,
        updatedAt: now,
      }).where(and(
        eq(recurringBuys.id, buy.id),
        eq(recurringBuys.nextRunAt, buy.nextRunAt),
      )).returning({ id: recurringBuys.id });

      if (!claimed) {
        // Another instance already claimed this buy — skip
        continue;
      }

      // Fetch current price
      const priceData = await getPrice(buy.asset);
      if (!priceData) {
        throw new Error(`Unable to fetch price for ${buy.asset}`);
      }

      const spreadDec = new Decimal(env.PLATFORM_SPREAD_PERCENT).dividedBy(100);
      const effectivePrice = new Decimal(priceData.cadPrice).times(new Decimal(1).plus(spreadDec)).toNumber();
      const amountFiat = Number(buy.amountCad);

      // Create order record
      const [order] = await db.insert(orders).values({
        userId: buy.userId,
        type: 'buy',
        cryptoAsset: buy.asset,
        amountFiat: String(amountFiat),
        remainingFiat: String(amountFiat),
        priceType: 'market',
        pricePremium: '0',
        fixedPrice: null,
        minTrade: String(amountFiat),
        maxTrade: String(amountFiat),
      }).returning();

      // Execute platform fill (same as manual buy)
      const tradeId = await createPlatformFill(
        order.id,
        buy.userId,
        buy.asset,
        amountFiat,
        effectivePrice,
      );

      if (!tradeId) {
        // Platform fill failed — cancel the order
        await db.update(orders).set({ status: 'cancelled', updatedAt: now }).where(eq(orders.id, order.id));
        throw new Error('Platform fill failed');
      }

      // Mark order as filled
      await db.update(orders).set({ status: 'filled', remainingFiat: '0', updatedAt: now }).where(eq(orders.id, order.id));

      // Fetch the trade to get actual amountCrypto
      const [trade] = await db.select({ amountCrypto: trades.amountCrypto })
        .from(trades).where(eq(trades.id, tradeId));
      const cryptoBought = trade?.amountCrypto ?? new Decimal(amountFiat).dividedBy(effectivePrice).toFixed(8);

      // Update stats on success
      await db.update(recurringBuys).set({
        executionCount: buy.executionCount + 1,
        consecutiveFailures: 0,
        totalSpent: new Decimal(buy.totalSpent).plus(amountFiat).toFixed(2),
        totalBought: new Decimal(buy.totalBought).plus(cryptoBought).toFixed(8),
        updatedAt: now,
      }).where(eq(recurringBuys.id, buy.id));

      // Notify user
      await db.insert(notifications).values({
        userId: buy.userId,
        type: 'system',
        title: `Recurring Buy Executed`,
        message: `Your recurring buy of $${amountFiat.toFixed(2)} CAD worth of ${buy.asset} has been executed.`,
        metadata: { asset: buy.asset, amountCad: buy.amountCad, tradeId, recurringBuyId: buy.id },
      });

      processed++;
    } catch (err) {
      logger.error({ err, recurringBuyId: buy.id }, 'Failed to process recurring buy');

      // Increment failure counter with exponential backoff retry delay
      const failures = (buy.consecutiveFailures ?? 0) + 1;
      const shouldPause = failures >= 3;
      // Backoff: 1h after 1st failure, 4h after 2nd, then pause at 3rd
      const retryDelayMs = Math.min(failures * failures * 60 * 60 * 1000, 4 * 60 * 60 * 1000);
      const retryAt = new Date(now.getTime() + retryDelayMs);
      await db.update(recurringBuys).set({
        lastRunAt: now,
        nextRunAt: shouldPause ? buy.nextRunAt : retryAt,
        consecutiveFailures: failures,
        ...(shouldPause ? { status: 'paused' as const } : {}),
        updatedAt: now,
      }).where(eq(recurringBuys.id, buy.id));

      if (shouldPause) {
        await db.insert(notifications).values({
          userId: buy.userId,
          type: 'system',
          title: 'Recurring Buy Paused',
          message: `Your recurring buy of $${Number(buy.amountCad).toFixed(2)} CAD of ${buy.asset} has been paused after 3 consecutive failures. Please check your balance and resume.`,
          metadata: { asset: buy.asset, recurringBuyId: buy.id },
        });
      }
    }
  }

  return processed;
}
