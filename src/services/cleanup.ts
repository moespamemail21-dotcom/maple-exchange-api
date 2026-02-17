import { db } from '../db/index.js';
import { users, notifications, authEvents, priceAlerts, supportTickets, ticketMessages, orders, deposits } from '../db/schema.js';
import { lt, and, eq, isNotNull, inArray, sql } from 'drizzle-orm';
import { mutateBalance } from './balance.js';
import { logger } from '../config/logger.js';
import Decimal from 'decimal.js';

// ── Overlap guards ──────────────────────────────────────────────────────────
let isCleaningResetTokens = false;
let isCleaningNotifications = false;
let isCleaningAuthEvents = false;
let isCleaningAlerts = false;
let isCleaningTickets = false;
let isCleaningOrders = false;
let isCleaningDeposits = false;

/**
 * Clear expired password reset tokens.
 * Runs daily. Nulls out resetToken/resetTokenExpiry for any user
 * whose token has passed its expiry time.
 */
export async function cleanupExpiredResetTokens(): Promise<number> {
  if (isCleaningResetTokens) {
    logger.debug('Reset token cleanup already running, skipping');
    return 0;
  }
  isCleaningResetTokens = true;
  try {
    const cleared = await db
      .update(users)
      .set({ resetToken: null, resetTokenExpiry: null })
      .where(
        and(
          isNotNull(users.resetToken),
          lt(users.resetTokenExpiry, new Date()),
        ),
      )
      .returning({ id: users.id });
    return cleared.length;
  } finally {
    isCleaningResetTokens = false;
  }
}

/**
 * Delete notifications older than 90 days.
 * Runs weekly. Keeps the notifications table from growing unbounded.
 */
export async function cleanupOldNotifications(): Promise<number> {
  if (isCleaningNotifications) {
    logger.debug('Notification cleanup already running, skipping');
    return 0;
  }
  isCleaningNotifications = true;
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(notifications)
      .where(lt(notifications.createdAt, cutoff))
      .returning({ id: notifications.id });
    return deleted.length;
  } finally {
    isCleaningNotifications = false;
  }
}

/**
 * Delete auth events older than 1 year.
 * Runs monthly. Retains recent audit trail while pruning stale records.
 */
export async function cleanupOldAuthEvents(): Promise<number> {
  if (isCleaningAuthEvents) {
    logger.debug('Auth event cleanup already running, skipping');
    return 0;
  }
  isCleaningAuthEvents = true;
  try {
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(authEvents)
      .where(lt(authEvents.createdAt, cutoff))
      .returning({ id: authEvents.id });
    return deleted.length;
  } finally {
    isCleaningAuthEvents = false;
  }
}

/**
 * Delete triggered price alerts older than 30 days.
 * Runs weekly. Once triggered, alerts are informational only.
 */
export async function cleanupTriggeredAlerts(): Promise<number> {
  if (isCleaningAlerts) {
    logger.debug('Triggered alert cleanup already running, skipping');
    return 0;
  }
  isCleaningAlerts = true;
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const deleted = await db
      .delete(priceAlerts)
      .where(
        and(
          eq(priceAlerts.triggered, true),
          lt(priceAlerts.triggeredAt, cutoff),
        ),
      )
      .returning({ id: priceAlerts.id });
    return deleted.length;
  } finally {
    isCleaningAlerts = false;
  }
}

/**
 * Delete closed support tickets and their messages older than 1 year.
 * Runs monthly. Keeps the support tables from growing unbounded.
 */
export async function cleanupClosedTickets(): Promise<number> {
  if (isCleaningTickets) {
    logger.debug('Closed ticket cleanup already running, skipping');
    return 0;
  }
  isCleaningTickets = true;
  try {
    const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const oldTickets = await db
      .select({ id: supportTickets.id })
      .from(supportTickets)
      .where(
        and(
          eq(supportTickets.status, 'closed'),
          lt(supportTickets.updatedAt, cutoff),
        ),
      );

    if (oldTickets.length === 0) return 0;

    const ticketIds = oldTickets.map(t => t.id);

    // Delete messages first (FK constraint)
    await db
      .delete(ticketMessages)
      .where(inArray(ticketMessages.ticketId, ticketIds));

    const deleted = await db
      .delete(supportTickets)
      .where(inArray(supportTickets.id, ticketIds))
      .returning({ id: supportTickets.id });

    return deleted.length;
  } finally {
    isCleaningTickets = false;
  }
}

/**
 * Cancel active orders older than 90 days.
 * Runs weekly. Prevents stale orders from lingering on the book indefinitely.
 */
export async function cleanupStaleOrders(): Promise<number> {
  if (isCleaningOrders) {
    logger.debug('Stale order cleanup already running, skipping');
    return 0;
  }
  isCleaningOrders = true;
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const cancelled = await db
      .update(orders)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(orders.status, 'active'),
          lt(orders.createdAt, cutoff),
        ),
      )
      .returning({ id: orders.id });
    return cancelled.length;
  } finally {
    isCleaningOrders = false;
  }
}

/**
 * Expire stale pending deposits older than 72 hours.
 * Runs every 24 hours. Marks deposits as 'expired' and reverses
 * any pendingDeposit balance that was credited when the deposit was detected.
 */
export async function cleanupStalePendingDeposits(): Promise<number> {
  if (isCleaningDeposits) {
    logger.debug('Stale deposit cleanup already running, skipping');
    return 0;
  }
  isCleaningDeposits = true;
  try {
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000); // 72 hours

    const staleDeposits = await db
      .select({
        id: deposits.id,
        userId: deposits.userId,
        asset: deposits.asset,
        amount: deposits.amount,
        txHash: deposits.txHash,
        chain: deposits.chain,
      })
      .from(deposits)
      .where(
        and(
          eq(deposits.status, 'pending'),
          lt(deposits.createdAt, cutoff),
        ),
      );

    if (staleDeposits.length === 0) return 0;

    let expired = 0;
    for (const deposit of staleDeposits) {
      try {
        await db.transaction(async (tx) => {
          // Lock the deposit row to prevent races with the deposit monitor
          const lockResult = await tx.execute(
            sql`SELECT id, status FROM deposits WHERE id = ${deposit.id} AND status = 'pending' FOR UPDATE`,
          ) as any;
          const rows = Array.isArray(lockResult) ? lockResult : lockResult?.rows ?? [];
          if (rows.length === 0) return; // Already processed

          // Mark deposit as expired
          await tx
            .update(deposits)
            .set({ status: 'expired' })
            .where(eq(deposits.id, deposit.id));

          // Reverse the pendingDeposit balance entry
          await mutateBalance(tx, {
            userId: deposit.userId,
            asset: deposit.asset,
            field: 'pendingDeposit',
            amount: new Decimal(deposit.amount).negated().toFixed(18),
            entryType: 'deposit_pending_cleared',
            idempotencyKey: `deposit:${deposit.id}:expired`,
            depositId: deposit.id,
            note: `Stale pending deposit expired after 72h: ${deposit.amount} ${deposit.asset} (tx: ${deposit.txHash})`,
          });

          expired++;
          logger.info(
            { depositId: deposit.id, userId: deposit.userId, asset: deposit.asset, amount: deposit.amount },
            'Expired stale pending deposit',
          );
        });
      } catch (err) {
        logger.error(
          { err, depositId: deposit.id },
          'Failed to expire stale pending deposit',
        );
      }
    }

    return expired;
  } finally {
    isCleaningDeposits = false;
  }
}
