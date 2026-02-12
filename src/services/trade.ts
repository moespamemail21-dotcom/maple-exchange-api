import { db } from '../db/index.js';
import { trades, users, disputes, complianceLogs } from '../db/schema.js';
import { eq, and, lt, sql } from 'drizzle-orm';
import { redis, KEYS } from './redis.js';
import { env } from '../config/env.js';
import { mutateBalance } from './balance.js';
import { PLATFORM_USER_ID, isPlatformUser, completePlatformSellTrade } from './platform.js';
import Decimal from 'decimal.js';

// ─── Valid State Transitions ────────────────────────────────────────────────
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending:            ['escrow_funded', 'expired', 'cancelled'],
  escrow_funded:      ['payment_sent', 'expired', 'cancelled'],
  payment_sent:       ['payment_confirmed', 'disputed', 'expired'],
  payment_confirmed:  ['crypto_released', 'expired'],
  crypto_released:    ['completed'],
  disputed:           ['resolved_buyer', 'resolved_seller'],
};

type TradeStatus = keyof typeof VALID_TRANSITIONS | 'completed' | 'expired' | 'cancelled' | 'resolved_buyer' | 'resolved_seller';

// ─── Trade State Machine ────────────────────────────────────────────────────

export async function transitionTrade(
  tradeId: string,
  newStatus: TradeStatus,
  actorId: string,
): Promise<{ success: boolean; error?: string }> {
  // Get current trade
  const [trade] = await db
    .select()
    .from(trades)
    .where(eq(trades.id, tradeId));

  if (!trade) return { success: false, error: 'Trade not found' };

  // Validate actor permission
  const actorPermission = validateActor(trade, newStatus, actorId);
  if (!actorPermission.allowed) {
    return { success: false, error: actorPermission.reason };
  }

  // Validate state transition
  const currentStatus = trade.status;
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed || !allowed.includes(newStatus)) {
    return { success: false, error: `Cannot transition from ${currentStatus} to ${newStatus}` };
  }

  // Wrap state transition + balance mutations in a single transaction
  await db.transaction(async (tx) => {
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

        // Fee: half charged to each side (stored as total in feeAmount)
        const feePerSide = new Decimal(feeAmount).dividedBy(2);
        const buyerReceives = new Decimal(amountCrypto).minus(feePerSide);

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

        // Buyer: credit available (minus buyer-side fee)
        await mutateBalance(tx, {
          userId: trade.buyerId,
          asset,
          field: 'available',
          amount: buyerReceives.toFixed(18),
          entryType: 'trade_credit',
          idempotencyKey: `trade:${tradeId}:credit:buyer`,
          tradeId,
          note: `Received ${buyerReceives.toFixed(8)} ${asset} from trade ${tradeId} (fee: ${feePerSide.toFixed(8)})`,
        });

        // Platform: credit total fee (both halves)
        const totalFee = new Decimal(feeAmount);
        await tx.execute(
          sql`UPDATE balances
              SET available = available::numeric + ${totalFee.toFixed(18)}::numeric,
                  updated_at = NOW()
              WHERE user_id = ${PLATFORM_USER_ID} AND asset = ${asset}`,
        );
        await tx.execute(
          sql`INSERT INTO balance_ledger (user_id, asset, entry_type, amount, balance_field, balance_after, trade_id, idempotency_key, note)
              VALUES (
                ${PLATFORM_USER_ID}, ${asset}, 'fee_credit',
                ${totalFee.toFixed(18)}, 'available',
                (SELECT available FROM balances WHERE user_id = ${PLATFORM_USER_ID} AND asset = ${asset}),
                ${tradeId}, ${'trade:' + tradeId + ':fee_credit'},
                ${'Trading fee from trade ' + tradeId}
              )`,
        );

        // Update user stats
        await updateUserStats(tx, trade.buyerId, true);
        await updateUserStats(tx, trade.sellerId, true);
        break;
      }

      case 'expired':
      case 'cancelled': {
        // Return escrowed crypto to seller (only if escrow was funded)
        if (currentStatus === 'escrow_funded' || currentStatus === 'payment_sent') {
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
        const rbFeePerSide = new Decimal(feeAmount).dividedBy(2);
        const rbBuyerReceives = new Decimal(amountCrypto).minus(rbFeePerSide);

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
        const rbTotalFee = new Decimal(feeAmount);
        await tx.execute(
          sql`UPDATE balances
              SET available = available::numeric + ${rbTotalFee.toFixed(18)}::numeric,
                  updated_at = NOW()
              WHERE user_id = ${PLATFORM_USER_ID} AND asset = ${asset}`,
        );
        await tx.execute(
          sql`INSERT INTO balance_ledger (user_id, asset, entry_type, amount, balance_field, balance_after, trade_id, idempotency_key, note)
              VALUES (
                ${PLATFORM_USER_ID}, ${asset}, 'fee_credit',
                ${rbTotalFee.toFixed(18)}, 'available',
                (SELECT available FROM balances WHERE user_id = ${PLATFORM_USER_ID} AND asset = ${asset}),
                ${tradeId}, ${'trade:' + tradeId + ':dispute_fee_credit'},
                ${'Fee from dispute-resolved trade ' + tradeId}
              )`,
        );
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
    if (newStatus === 'completed' && Number(trade.amountFiat) >= 10000) {
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
  });

  // Publish event (outside transaction — Redis pub/sub)
  await redis.publish(KEYS.tradeChannel, JSON.stringify({
    type: 'trade_status_changed',
    tradeId,
    oldStatus: currentStatus,
    newStatus,
    actorId,
    timestamp: new Date().toISOString(),
  }));

  return { success: true };
}

// ─── Open Dispute ───────────────────────────────────────────────────────────

export async function openDispute(
  tradeId: string,
  userId: string,
  reason: string,
  evidenceUrls: string[] = [],
): Promise<{ success: boolean; disputeId?: string; error?: string }> {
  // Transition trade to disputed state
  const result = await transitionTrade(tradeId, 'disputed', userId);
  if (!result.success) return result;

  // Create dispute record
  const [dispute] = await db
    .insert(disputes)
    .values({
      tradeId,
      openedBy: userId,
      reason,
      evidenceUrls,
    })
    .returning({ id: disputes.id });

  // File STR if suspicious
  await db.insert(complianceLogs).values({
    userId,
    tradeId,
    eventType: 'str',
    payload: {
      type: 'suspicious_transaction_report',
      reason: 'Trade disputed by participant',
      disputeReason: reason,
      tradeId,
    },
  });

  return { success: true, disputeId: dispute.id };
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
      await transitionTrade(trade.id, 'disputed', 'system');
      await db.insert(disputes).values({
        tradeId: trade.id,
        openedBy: trade.buyerId,
        reason: 'Seller did not confirm payment within the time window. Auto-dispute triggered.',
      });
      processed++;
    }
  }

  // Process trades past holding period
  const holdingComplete = await db
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.status, 'payment_confirmed'),
        lt(trades.holdingUntil, now),
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

      if (Number(user.maxTradeLimit) < newLimit) {
        await tx
          .update(users)
          .set({ maxTradeLimit: String(newLimit), updatedAt: new Date() })
          .where(eq(users.id, userId));
      }
    }
  }
}
