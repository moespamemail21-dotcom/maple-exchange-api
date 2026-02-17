import { db } from '../db/index.js';
import { priceAlerts, notifications } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { getAllPricesCached } from './price.js';
import { logger } from '../config/logger.js';
import Decimal from 'decimal.js';

export async function createAlert(userId: string, asset: string, targetPrice: number, direction: 'above' | 'below') {
  // Use Decimal to avoid IEEE 754 precision loss (e.g. 50000.0000000000001)
  const [alert] = await db.insert(priceAlerts).values({
    userId, asset, targetPrice: new Decimal(targetPrice).toDecimalPlaces(2).toFixed(2), direction,
  }).returning();
  return alert;
}

export async function getUserAlerts(userId: string) {
  return db.select().from(priceAlerts)
    .where(eq(priceAlerts.userId, userId))
    .orderBy(desc(priceAlerts.createdAt));
}

export async function deleteAlert(userId: string, alertId: string): Promise<boolean> {
  const [deleted] = await db.delete(priceAlerts)
    .where(and(eq(priceAlerts.id, alertId), eq(priceAlerts.userId, userId)))
    .returning({ id: priceAlerts.id });
  return !!deleted;
}

export async function checkPriceAlerts(): Promise<number> {
  const prices = await getAllPricesCached();
  if (prices.length === 0) return 0;

  const priceMap = new Map(prices.map(p => [p.symbol, p.cadPrice]));

  // Get all untriggered alerts
  const activeAlerts = await db.select().from(priceAlerts)
    .where(eq(priceAlerts.triggered, false));

  let triggered = 0;
  for (const alert of activeAlerts) {
    const currentPrice = priceMap.get(alert.asset);
    if (currentPrice === undefined) continue;

    const target = Number(alert.targetPrice);
    const shouldTrigger =
      (alert.direction === 'above' && currentPrice >= target) ||
      (alert.direction === 'below' && currentPrice <= target);

    if (shouldTrigger) {
      // Atomic: only trigger if still untriggered (prevents duplicate notifications
      // from concurrent checkPriceAlerts() calls)
      const [updated] = await db.update(priceAlerts)
        .set({ triggered: true, triggeredAt: new Date() })
        .where(and(eq(priceAlerts.id, alert.id), eq(priceAlerts.triggered, false)))
        .returning({ id: priceAlerts.id });

      if (!updated) continue; // Another call already triggered this alert

      // Create notification
      const dirLabel = alert.direction === 'above' ? 'risen above' : 'fallen below';
      await db.insert(notifications).values({
        userId: alert.userId,
        type: 'price_alert',
        title: `${alert.asset} Price Alert`,
        message: `${alert.asset} has ${dirLabel} $${target.toLocaleString()} CAD. Current price: $${currentPrice.toLocaleString()} CAD.`,
        metadata: { asset: alert.asset, targetPrice: target, direction: alert.direction, currentPrice },
      });

      triggered++;
    }
  }

  if (triggered > 0) {
    logger.info({ triggered }, 'Price alerts triggered');
  }
  return triggered;
}
