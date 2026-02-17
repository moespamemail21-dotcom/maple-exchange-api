import { db } from '../db/index.js';
import { trades, users, disputes, complianceLogs, notifications, referralRewards } from '../db/schema.js';
import { eq, and, lt, or, sql } from 'drizzle-orm';
import { expireStaleRewards } from './referral.js';
import { redis, KEYS } from './redis.js';
import { env } from '../config/env.js';
import { mutateBalance } from './balance.js';
import { PLATFORM_USER_ID, isPlatformUser, completePlatformSellTrade } from './platform.js';
import { logger } from '../config/logger.js';
import Decimal from 'decimal.js';

// ─── Valid State Transitions ────────────────────────────────────────────────
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:            ['escrow_funded', 'expired', 'cancelled'],
  escrow_funded:      ['payment_sent', 'expired', 'cancelled'],
  payment_sent:       ['payment_confirmed', 'disputed', 'expired'],
  payment_confirmed:  ['crypto_released', 'disputed', 'expired'],
  crypto_released:    ['completed'],
  disputed:           ['resolved_buyer', 'resolved_seller'],
};

type TradeStatus = keyof typeof VALID_TRANSITIONS | 'completed' | 'expired' | 'cancelled' | 'resolved_buyer' | 'resolved_seller';

// ─── Trade State Machine ────────────────────────────────────────────────────

export async function transitionTrade(
  tradeId: string,
  newStatus: TradeStatus,
  actorId: string,
  options?: { disputeData?: { openedBy: string; reason: string; evidenceUrls?: string[] } },
): Promise<{ success: boolean; error?: string; disputeId?: string }> {
  // Entire read + validation + mutation in one transaction with row lock
  const txResult = await db.transaction(async (tx): Promise<
    | { success: false; error: string; currentStatus?: undefined; trade?: undefined }
    | { success: true; currentStatus: string; trade: Record<string, any>; disputeId?: string }
  > => {
    // Lock the trade row to prevent concurrent state transitions
    const result = await tx.execute(
      sql`SELECT * FROM trades WHERE id = ${tradeId} FOR UPDATE`,
    ) as any;
    const rows = Array.isArray(result) ? result : result?.rows ?? [];
    if (rows.length === 0) return { success: false, error: 'Trade not found' };

    // Map snake_case DB columns to camelCase
    const row = rows[0] as any;
    const trade = {
      id: row.id,
      orderId: row.order_id,
      buyerId: row.buyer_id,
      sellerId: row.seller_id,
      cryptoAsset: row.crypto_asset,
      amountCrypto: row.amount_crypto,
      amountFiat: row.amount_fiat,
      pricePerUnit: row.price_per_unit,
      feePercent: row.fee_percent,
      feeAmount: row.fee_amount,
      status: row.status as string,
      escrowFundedAt: row.escrow_funded_at,
      paymentSentAt: row.payment_sent_at,
      paymentConfirmedAt: row.payment_confirmed_at,
      cryptoReleasedAt: row.crypto_released_at,
      completedAt: row.completed_at,
      expiresAt: row.expires_at,
      holdingUntil: row.holding_until,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Validate actor permission
    const actorPermission = validateActor(trade as any, newStatus, actorId);
    if (!actorPermission.allowed) {
      return { success: false, error: actorPermission.reason ?? 'Permission denied' };
    }

    // Validate state transition
    const currentStatus = trade.status;
    const allowed = VALID_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(newStatus)) {
      return { success: false, error: `Cannot transition from ${currentStatus} to ${newStatus}` };
    }

    const now = new Date();
    const updatePayload: Record<string, unknown> = {
      status: newStatus,
      updatedAt: now,
    };

    const asset = trade.cryptoAsset;
    const amountCrypto = trade.amountCrypto;
    const feeAmount = trade.feeAmount;

    // ─── Balance Mutations per State Transition ───────────────────────
    switch (newStatus) {
      case 'escrow_funded': {
        updatePayload.escrowFundedAt = now;
        updatePayload.expiresAt = new Date(now.getTime() + env.PAYMENT_WINDOW_MINUTES * 60 * 1000);

        // Seller: move crypto from available → locked (escrow)
        await mutateBalance(tx, {
          userId: trade.sellerId,
          asset,
          field: 'available',
          amount: new Decimal(amountCrypto).negated().toFixed(18),
          entryType: 'trade_escrow_lock',
          idempotencyKey: `trade:${tradeId}:escrow_lock:available`,
          tradeId,
          note: `Escrow lock for trade ${tradeId}`,
        });
        await mutateBalance(tx, {
          userId: trade.sellerId,
          asset,
          field: 'locked',
          amount: amountCrypto,
          entryType: 'trade_escrow_lock',
          idempotencyKey: `trade:${tradeId}:escrow_lock:locked`,
          tradeId,
          note: `Escrow lock for trade ${tradeId}`,
        });
        break;
      }

      case 'payment_sent':
        updatePayload.paymentSentAt = now;
        updatePayload.expiresAt = new Date(now.getTime() + env.CONFIRM_WINDOW_MINUTES * 60 * 1000);
        // No balance changes — just a notification that buyer sent fiat
        break;

      case 'payment_confirmed': {
        updatePayload.paymentConfirmedAt = now;
        // Check if buyer is new — apply holding period
        const [buyer] = await tx.select().from(users).where(eq(users.id, trade.buyerId));
        if (buyer && buyer.tradeCount < 3) {
          updatePayload.holdingUntil = new Date(now.getTime() + env.NEW_USER_HOLDING_HOURS * 60 * 60 * 1000);
        } else {
          updatePayload.holdingUntil = now;
        }
        // No balance changes yet — crypto still in seller's locked
        break;
      }

      case 'crypto_released':
        updatePayload.cryptoReleasedAt = now;
        // No balance changes — this is just the trigger before completed
        break;

      case 'completed': {
        updatePayload.completedAt = now;

        // Fee: total fee split across both sides, deducted from escrowed crypto
        const totalFee = new Decimal(feeAmount);
        const buyerReceives = new Decimal(amountCrypto).minus(totalFee);

        // Seller: debit locked (escrow release)
        await mutateBalance(tx, {
          userId: trade.sellerId,
          asset,
          field: 'locked',
          amount: new Decimal(amountCrypto).negated().toFixed(18),
          entryType: 'trade_escrow_release',
          idempotencyKey: `trade:${tradeId}:release:seller_locked`,
          tradeId,
          note: `Escrow released for completed trade ${tradeId}`,
        });

        // Buyer: credit available (minus total trading fee)
        await mutateBalance(tx, {
          userId: trade.buyerId,
          asset,
          field: 'available',
          amount: buyerReceives.toFixed(18),
          entryType: 'trade_credit',
          idempotencyKey: `trade:${tradeId}:credit:buyer`,
          tradeId,
          note: `Received ${buyerReceives.toFixed(8)} ${asset} from trade ${tradeId} (fee: ${totalFee.toFixed(8)})`,
        });

        // Platform: credit total fee
        await mutateBalance(tx, {
          userId: PLATFORM_USER_ID,
          asset,
          field: 'available',
          amount: totalFee.toFixed(18),
          entryType: 'fee_credit',
          idempotencyKey: `trade:${tradeId}:fee_credit`,
          tradeId,
          note: `Trading fee from trade ${tradeId}`,
        });

        // Update user stats
        await updateUserStats(tx, trade.buyerId, true);
        await updateUserStats(tx, trade.sellerId, true);

        // Referral rewards are processed AFTER the transaction (see below)
        // to prevent CAD balance issues from blocking trade completion.
        break;
      }

      case 'expired':
      case 'cancelled': {
        // Return escrowed crypto to seller (only if escrow was funded at any prior stage)
        if (currentStatus === 'escrow_funded' || currentStatus === 'payment_sent' || currentStatus === 'payment_confirmed') {
          // Seller: move crypto from locked → available
          await mutateBalance(tx, {
            userId: trade.sellerId,
            asset,
            field: 'locked',
            amount: new Decimal(amountCrypto).negated().toFixed(18),
            entryType: 'trade_escrow_return',
            idempotencyKey: `trade:${tradeId}:return:locked`,
            tradeId,
            note: `Escrow returned — trade ${newStatus}`,
          });
          await mutateBalance(tx, {
            userId: trade.sellerId,
            asset,
            field: 'available',
            amount: amountCrypto,
            entryType: 'trade_escrow_return',
            idempotencyKey: `trade:${tradeId}:return:available`,
            tradeId,
            note: `Escrow returned — trade ${newStatus}`,
          });
        }
        break;
      }

      case 'resolved_buyer': {
        // Dispute resolved in buyer's favor: release crypto to buyer
        const rbTotalFee = new Decimal(feeAmount);
        const rbBuyerReceives = new Decimal(amountCrypto).minus(rbTotalFee);

        await mutateBalance(tx, {
          userId: trade.sellerId,
          asset,
          field: 'locked',
          amount: new Decimal(amountCrypto).negated().toFixed(18),
          entryType: 'trade_escrow_release',
          idempotencyKey: `trade:${tradeId}:dispute_release:seller_locked`,
          tradeId,
          note: `Dispute resolved — crypto released to buyer`,
        });
        await mutateBalance(tx, {
          userId: trade.buyerId,
          asset,
          field: 'available',
          amount: rbBuyerReceives.toFixed(18),
          entryType: 'trade_credit',
          idempotencyKey: `trade:${tradeId}:dispute_credit:buyer`,
          tradeId,
          note: `Dispute resolved in your favor`,
        });

        // Platform: credit total fee
        await mutateBalance(tx, {
          userId: PLATFORM_USER_ID,
          asset,
          field: 'available',
          amount: rbTotalFee.toFixed(18),
          entryType: 'fee_credit',
          idempotencyKey: `trade:${tradeId}:dispute_fee_credit`,
          tradeId,
          note: `Fee from dispute-resolved trade ${tradeId}`,
        });

        // Buyer: trade fulfilled via dispute — count as completed trade
        await updateUserStats(tx, trade.buyerId, true);
        // Seller lost the dispute — do NOT credit their trade count
        break;
      }

      case 'resolved_seller': {
        // Dispute resolved in seller's favor: return escrowed crypto
        await mutateBalance(tx, {
          userId: trade.sellerId,
          asset,
          field: 'locked',
          amount: new Decimal(amountCrypto).negated().toFixed(18),
          entryType: 'trade_escrow_return',
          idempotencyKey: `trade:${tradeId}:dispute_return:locked`,
          tradeId,
          note: `Dispute resolved in your favor — escrow returned`,
        });
        await mutateBalance(tx, {
          userId: trade.sellerId,
          asset,
          field: 'available',
          amount: amountCrypto,
          entryType: 'trade_escrow_return',
          idempotencyKey: `trade:${tradeId}:dispute_return:available`,
          tradeId,
          note: `Dispute resolved in your favor — escrow returned`,
        });
        break;
      }
    }

    // Execute the trade status update
    await tx
      .update(trades)
      .set(updatePayload)
      .where(eq(trades.id, tradeId));

    // Log for compliance (FINTRAC) — large transactions
    if (newStatus === 'completed' && new Decimal(trade.amountFiat).gte(10000)) {
      await tx.insert(complianceLogs).values({
        userId: trade.buyerId,
        tradeId,
        eventType: 'lvctr',
        payload: {
          type: 'large_virtual_currency_transaction',
          amountFiat: trade.amountFiat,
          amountCrypto: trade.amountCrypto,
          cryptoAsset: trade.cryptoAsset,
          buyerId: trade.buyerId,
          sellerId: trade.sellerId,
          completedAt: now.toISOString(),
        },
      });
    }

    // Insert dispute record atomically within the same transaction
    let disputeId: string | undefined;
    if (newStatus === 'disputed' && options?.disputeData) {
      const [dispute] = await tx
        .insert(disputes)
        .values({
          tradeId,
          openedBy: options.disputeData.openedBy,
          reason: options.disputeData.reason,
          evidenceUrls: options.disputeData.evidenceUrls ?? [],
        })
        .returning({ id: disputes.id });
      disputeId = dispute.id;

      // File STR for compliance (FINTRAC)
      await tx.insert(complianceLogs).values({
        userId: options.disputeData.openedBy,
        tradeId,
        eventType: 'str',
        payload: {
          type: 'suspicious_transaction_report',
          reason: 'Trade disputed by participant',
          disputeReason: options.disputeData.reason,
          tradeId,
        },
      });
    }

    // Return trade data for post-transaction notifications
    return { success: true as const, currentStatus, trade, disputeId };
  });

  // Transaction failed — return validation error
  if (!txResult.success) return txResult as { success: false; error: string };

  const currentStatus = txResult.currentStatus!;
  const trade = txResult.trade!;

  // Publish event (outside transaction — Redis pub/sub)
  // MUST include buyerId/sellerId for WebSocket routing to trade participants
  await redis.publish(KEYS.tradeChannel, JSON.stringify({
    type: 'trade_status_changed',
    tradeId,
    buyerId: trade.buyerId,
    sellerId: trade.sellerId,
    oldStatus: currentStatus,
    newStatus,
    timestamp: new Date().toISOString(),
  }));

  logger.info({ tradeId, fromStatus: currentStatus, toStatus: newStatus, actorId }, 'trade state transition');

  // ─── Notifications per Status Transition ──────────────────────────────────
  try {
    const tradeNotifications: Array<{
      userId: string;
      type: string;
      title: string;
      message: string;
      metadata: Record<string, unknown>;
    }> = [];

    const meta = { tradeId };

    switch (newStatus) {
      case 'payment_sent':
        tradeNotifications.push({
          userId: trade.sellerId,
          type: 'trade_update',
          title: 'Payment Sent',
          message: `Buyer has sent payment for trade #${tradeId.slice(0, 8)}`,
          metadata: meta,
        });
        break;

      case 'payment_confirmed':
        tradeNotifications.push({
          userId: trade.buyerId,
          type: 'trade_update',
          title: 'Payment Confirmed',
          message: `Payment confirmed for trade #${tradeId.slice(0, 8)}`,
          metadata: meta,
        });
        break;

      case 'completed':
        tradeNotifications.push(
          {
            userId: trade.buyerId,
            type: 'trade_update',
            title: 'Trade Completed',
            message: `Trade #${tradeId.slice(0, 8)} completed successfully`,
            metadata: meta,
          },
          {
            userId: trade.sellerId,
            type: 'trade_update',
            title: 'Trade Completed',
            message: `Trade #${tradeId.slice(0, 8)} completed successfully`,
            metadata: meta,
          },
        );
        break;

      case 'cancelled':
        tradeNotifications.push(
          {
            userId: trade.buyerId,
            type: 'trade_update',
            title: 'Trade Cancelled',
            message: `Trade #${tradeId.slice(0, 8)} has been cancelled`,
            metadata: meta,
          },
          {
            userId: trade.sellerId,
            type: 'trade_update',
            title: 'Trade Cancelled',
            message: `Trade #${tradeId.slice(0, 8)} has been cancelled`,
            metadata: meta,
          },
        );
        break;

      case 'disputed':
        tradeNotifications.push(
          {
            userId: trade.buyerId,
            type: 'trade_update',
            title: 'Dispute Opened',
            message: `A dispute has been opened for trade #${tradeId.slice(0, 8)}`,
            metadata: meta,
          },
          {
            userId: trade.sellerId,
            type: 'trade_update',
            title: 'Dispute Opened',
            message: `A dispute has been opened for trade #${tradeId.slice(0, 8)}`,
            metadata: meta,
          },
        );
        break;

      case 'resolved_buyer':
        tradeNotifications.push(
          {
            userId: trade.buyerId,
            type: 'trade_update',
            title: 'Dispute Resolved',
            message: `Dispute resolved in your favor. Crypto has been released to your wallet.`,
            metadata: meta,
          },
          {
            userId: trade.sellerId,
            type: 'trade_update',
            title: 'Dispute Resolved',
            message: `Dispute for trade #${tradeId.slice(0, 8)} has been resolved in the buyer's favor.`,
            metadata: meta,
          },
        );
        break;

      case 'resolved_seller':
        tradeNotifications.push(
          {
            userId: trade.sellerId,
            type: 'trade_update',
            title: 'Dispute Resolved',
            message: `Dispute resolved in your favor. Escrowed crypto has been returned to your wallet.`,
            metadata: meta,
          },
          {
            userId: trade.buyerId,
            type: 'trade_update',
            title: 'Dispute Resolved',
            message: `Dispute for trade #${tradeId.slice(0, 8)} has been resolved in the seller's favor.`,
            metadata: meta,
          },
        );
        break;
    }

    if (tradeNotifications.length > 0) {
      await db.insert(notifications).values(tradeNotifications);
    }
  } catch (err) {
    // Non-critical — don't fail the trade transition for a notification error
    logger.error({ tradeId, newStatus, err }, 'failed to create trade notification');
  }

  // ─── Referral Rewards (outside main transaction — non-critical) ───────────
  if (newStatus === 'completed') {
    try {
      // Opportunistically expire stale rewards (> 90 days)
      await expireStaleRewards();

      const pendingRewards = await db.select().from(referralRewards)
        .where(and(
          or(
            eq(referralRewards.refereeId, trade.buyerId),
            eq(referralRewards.refereeId, trade.sellerId),
          ),
          eq(referralRewards.status, 'pending'),
        ));
      for (const reward of pendingRewards) {
        const rewardAmountStr = new Decimal(reward.rewardAmount).toFixed(2);

        // Mark as credited
        await db.update(referralRewards)
          .set({ status: 'credited', creditedAt: new Date() })
          .where(eq(referralRewards.id, reward.id));

        // Credit fee_credit_cad to BOTH referrer and referee (atomic SQL increment)
        await db.update(users)
          .set({ feeCreditCad: sql`${users.feeCreditCad} + ${reward.rewardAmount}` })
          .where(eq(users.id, reward.referrerId));
        await db.update(users)
          .set({ feeCreditCad: sql`${users.feeCreditCad} + ${reward.rewardAmount}` })
          .where(eq(users.id, reward.refereeId));

        // Notify both parties
        await db.insert(notifications).values([
          {
            userId: reward.referrerId,
            type: 'system',
            title: 'Referral Reward Earned!',
            message: `You earned a $${rewardAmountStr} CAD fee credit from your referral! It will be applied to your next trade.`,
            metadata: { referralRewardId: reward.id },
          },
          {
            userId: reward.refereeId,
            type: 'system',
            title: 'Welcome Bonus Earned!',
            message: `You earned a $${rewardAmountStr} CAD fee credit as a welcome bonus! It will be applied to your next trade.`,
            metadata: { referralRewardId: reward.id },
          },
        ]);
      }
    } catch (err) {
      // Non-critical — trade already completed, referral credit can be retried
      logger.error({ tradeId, err }, 'failed to process referral rewards');
    }
  }

  return { success: true, disputeId: txResult.disputeId };
}

// ─── Open Dispute ───────────────────────────────────────────────────────────

export async function openDispute(
  tradeId: string,
  userId: string,
  reason: string,
  evidenceUrls: string[] = [],
): Promise<{ success: boolean; disputeId?: string; error?: string }> {
  // Dispute record + STR are created atomically inside the transitionTrade transaction
  return transitionTrade(tradeId, 'disputed', userId, {
    disputeData: { openedBy: userId, reason, evidenceUrls },
  });
}

// ─── Timeout Processing ─────────────────────────────────────────────────────

/**
 * Process expired trades. Run this periodically (every 60 seconds).
 */
export async function processExpiredTrades(): Promise<number> {
  const now = new Date();
  let processed = 0;

  // Find trades past their expiry in actionable states
  const expiredTrades = await db
    .select()
    .from(trades)
    .where(
      and(
        lt(trades.expiresAt, now),
        sql`${trades.status} IN ('escrow_funded', 'payment_sent')`,
      )
    );

  for (const trade of expiredTrades) {
    if (trade.status === 'escrow_funded') {
      // Buyer didn't send payment in time → expire (returns escrow to seller)
      await transitionTrade(trade.id, 'expired', 'system');
      processed++;
    } else if (trade.status === 'payment_sent') {
      // Seller didn't confirm payment → auto-dispute
      // Dispute record is created atomically inside transitionTrade
      await transitionTrade(trade.id, 'disputed', 'system', {
        disputeData: {
          openedBy: trade.buyerId,
          reason: 'Seller did not confirm payment within the time window. Auto-dispute triggered.',
        },
      });
      processed++;
    }
  }

  // Process trades past holding period (includes safety net for null holdingUntil:
  // if holdingUntil is NULL, treat as immediately releasable to prevent stuck funds)
  const holdingComplete = await db
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.status, 'payment_confirmed'),
        or(
          lt(trades.holdingUntil, now),
          sql`${trades.holdingUntil} IS NULL`,
        ),
      )
    );

  for (const trade of holdingComplete) {
    // Platform trades: complete directly via completePlatformSellTrade
    if (isPlatformUser(trade.sellerId)) {
      await completePlatformSellTrade(trade.id);
    } else {
      // P2P trades: advance through crypto_released → completed
      // completed is where buyer balance is credited
      await transitionTrade(trade.id, 'crypto_released', 'system');
      await transitionTrade(trade.id, 'completed', 'system');
    }
    processed++;
  }

  // Recovery: advance any trades stuck at crypto_released (e.g., if a previous
  // completed transition failed after crypto_released succeeded)
  const stuckReleased = await db
    .select()
    .from(trades)
    .where(eq(trades.status, 'crypto_released'));

  for (const trade of stuckReleased) {
    const result = await transitionTrade(trade.id, 'completed', 'system');
    if (result.success) {
      logger.info({ tradeId: trade.id }, 'Recovered stuck crypto_released trade → completed');
      processed++;
    }
  }

  return processed;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isAdmin(userId: string): boolean {
  const adminIds = env.ADMIN_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  return adminIds.includes(userId);
}

function validateActor(
  trade: typeof trades.$inferSelect,
  newStatus: string,
  actorId: string,
): { allowed: boolean; reason?: string } {
  // System can do anything
  if (actorId === 'system') return { allowed: true };

  // Admin can do anything
  if (isAdmin(actorId)) return { allowed: true };

  switch (newStatus) {
    case 'escrow_funded':
      // Only seller can fund escrow
      if (actorId !== trade.sellerId) return { allowed: false, reason: 'Only the seller can fund escrow' };
      break;
    case 'payment_sent':
      // Only buyer can mark payment as sent
      if (actorId !== trade.buyerId) return { allowed: false, reason: 'Only the buyer can mark payment as sent' };
      break;
    case 'payment_confirmed':
      // Seller or platform can confirm payment
      if (actorId !== trade.sellerId && !isPlatformUser(actorId)) {
        return { allowed: false, reason: 'Only the seller can confirm payment' };
      }
      break;
    case 'crypto_released':
    case 'completed':
      // System/admin only (handled above)
      return { allowed: false, reason: 'Only the system can advance to this state' };
    case 'disputed':
      // Either party can dispute
      if (actorId !== trade.buyerId && actorId !== trade.sellerId) {
        return { allowed: false, reason: 'Only trade participants can open a dispute' };
      }
      break;
    case 'resolved_buyer':
    case 'resolved_seller':
      // Admin only (handled above)
      return { allowed: false, reason: 'Only an admin can resolve disputes' };
    case 'cancelled':
      // Buyer can cancel before payment (in centralized UX, buyer is the one cancelling their order)
      if (actorId !== trade.buyerId && actorId !== trade.sellerId) {
        return { allowed: false, reason: 'Only trade participants can cancel' };
      }
      break;
  }

  return { allowed: true };
}

async function updateUserStats(tx: any, userId: string, completedSuccessfully: boolean) {
  if (completedSuccessfully) {
    await tx
      .update(users)
      .set({
        tradeCount: sql`${users.tradeCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    // Graduate trade limit based on completed trades
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (user) {
      let newLimit = 250;
      if (user.tradeCount >= 20) newLimit = 3000;
      else if (user.tradeCount >= 10) newLimit = 2000;
      else if (user.tradeCount >= 5) newLimit = 1000;
      else if (user.tradeCount >= 3) newLimit = 500;

      if (new Decimal(user.maxTradeLimit).lt(newLimit)) {
        await tx
          .update(users)
          .set({ maxTradeLimit: String(newLimit), updatedAt: new Date() })
          .where(eq(users.id, userId));
      }
    }
  }
}
