import { db } from '../db/index.js';
import { users, trades, balances } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { mutateBalance } from './balance.js';
import { redis, KEYS } from './redis.js';
import Decimal from 'decimal.js';
import { SUPPORTED_ASSETS } from './balance.js';

// ─── Platform System User ──────────────────────────────────────────────────
//
// The platform acts as a market maker when no P2P sellers/buyers are available.
// This gives the app the feel of a centralized exchange — users always get
// instant fills at market price.
//
// The platform user has "infinite" virtual liquidity — its balance rows exist
// but are allowed to go negative (only this user). In production, this would
// be backed by the company's own crypto reserves.
//

// Deterministic UUID for the platform user (same across all environments)
export const PLATFORM_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Ensure the platform system user exists. Called on server startup.
 * Idempotent — safe to call multiple times.
 */
export async function ensurePlatformUser(): Promise<void> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, PLATFORM_USER_ID));

  if (existing) return;

  await db.transaction(async (tx) => {
    // Create the platform user
    await tx.insert(users).values({
      id: PLATFORM_USER_ID,
      email: 'platform@mapleexchange.ca',
      passwordHash: 'PLATFORM_SYSTEM_ACCOUNT_NO_LOGIN',
      displayName: 'Maple Exchange',
      kycStatus: 'verified',
      kycVideoStatus: 'approved',
      interacEmail: env.PLATFORM_INTERAC_EMAIL,
      autodepositVerified: true,
      tradeCount: 999,
      completionRate: '100.00',
      maxTradeLimit: '999999.00',
    });

    // Initialize balance rows (all zeros — allowed to go negative for platform)
    const rows = SUPPORTED_ASSETS.map((asset) => ({
      userId: PLATFORM_USER_ID,
      asset,
      available: '0',
      locked: '0',
      pendingDeposit: '0',
    }));
    await tx.insert(balances).values(rows);
  });

  console.log('  Platform market maker user created');
}

/**
 * Check if a user is the platform system account.
 */
export function isPlatformUser(userId: string): boolean {
  return userId === PLATFORM_USER_ID;
}

// ─── Helper: Credit fee to platform ──────────────────────────────────────────

async function creditPlatformFee(
  tx: any,
  asset: string,
  feeAmount: string,
  tradeId: string,
  idempotencySuffix: string,
) {
  const totalFee = new Decimal(feeAmount);
  if (totalFee.isZero()) return;

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
          ${tradeId}, ${'trade:' + tradeId + ':' + idempotencySuffix},
          ${'Trading fee from trade ' + tradeId}
        )`,
  );
}

// ─── Helper: Graduate user trade limit ───────────────────────────────────────

async function graduateUserLimit(tx: any, userId: string) {
  const now = new Date();
  await tx
    .update(users)
    .set({
      tradeCount: sql`${users.tradeCount} + 1`,
      updatedAt: now,
    })
    .where(eq(users.id, userId));

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
        .set({ maxTradeLimit: String(newLimit), updatedAt: now })
        .where(eq(users.id, userId));
    }
  }
}

// ─── Platform as Seller (Buy Orders) ────────────────────────────────────────

/**
 * Create a platform-filled trade when no P2P match is found for a BUY order.
 *
 * The platform acts as the seller — the buyer gets instant execution at
 * market price. Returns the trade ID, or null if unable to fill.
 */
export async function createPlatformFill(
  buyOrderId: string,
  buyerId: string,
  cryptoAsset: string,
  amountFiat: number,
  pricePerUnit: number,
): Promise<string | null> {
  const amountCrypto = new Decimal(amountFiat).dividedBy(pricePerUnit);
  const feePercent = env.TAKER_FEE_PERCENT;
  const feePerSide = amountCrypto.times(feePercent).dividedBy(100);
  const totalFee = feePerSide.times(2);

  // Add random cents for e-Transfer disambiguation
  const randomCents = Math.floor(Math.random() * 99 + 1) / 100;
  const disambiguatedFiat = Math.round((amountFiat + randomCents) * 100) / 100;

  try {
    const tradeId = await db.transaction(async (tx) => {
      const now = new Date();

      // Create trade — platform is the seller, already at escrow_funded
      const [trade] = await tx
        .insert(trades)
        .values({
          orderId: buyOrderId,
          buyerId,
          sellerId: PLATFORM_USER_ID,
          cryptoAsset,
          amountCrypto: amountCrypto.toFixed(8),
          amountFiat: String(disambiguatedFiat),
          pricePerUnit: String(pricePerUnit),
          feePercent: String(feePercent),
          feeAmount: totalFee.toFixed(8),
          status: 'escrow_funded',
          escrowFundedAt: now,
          expiresAt: new Date(now.getTime() + env.PAYMENT_WINDOW_MINUTES * 60 * 1000),
        })
        .returning({ id: trades.id });

      // Platform seller: lock balance (allowed to go negative for platform)
      await tx.execute(
        sql`UPDATE balances
            SET locked = locked::numeric + ${amountCrypto.toFixed(18)}::numeric,
                updated_at = NOW()
            WHERE user_id = ${PLATFORM_USER_ID} AND asset = ${cryptoAsset}`,
      );

      // Ledger entry for platform escrow lock
      await tx.execute(
        sql`INSERT INTO balance_ledger (user_id, asset, entry_type, amount, balance_field, balance_after, trade_id, idempotency_key, note)
            VALUES (
              ${PLATFORM_USER_ID}, ${cryptoAsset}, 'trade_escrow_lock',
              ${amountCrypto.toFixed(18)}, 'locked',
              (SELECT locked FROM balances WHERE user_id = ${PLATFORM_USER_ID} AND asset = ${cryptoAsset}),
              ${trade.id}, ${'trade:' + trade.id + ':platform_escrow_lock'},
              'Platform market maker escrow'
            )`,
      );

      return trade.id;
    });

    // Publish trade event (sanitized — no buyerId/sellerId)
    await redis.publish(KEYS.tradeChannel, JSON.stringify({
      type: 'trade_created',
      tradeId,
      status: 'escrow_funded',
    }));

    return tradeId;
  } catch (err: any) {
    console.error('Platform fill failed:', err.message ?? err);
    return null;
  }
}

// ─── Platform as Buyer (Sell Orders) ────────────────────────────────────────

/**
 * Create a platform-filled trade when no P2P match is found for a SELL order.
 *
 * The platform acts as the buyer — the seller gets instant execution.
 * Seller's crypto is moved from available → locked (escrow), then
 * autoAdvancePlatformTrade handles the rest.
 */
export async function createPlatformBuyFill(
  sellOrderId: string,
  sellerId: string,
  cryptoAsset: string,
  amountFiat: number,
  pricePerUnit: number,
): Promise<string | null> {
  const amountCrypto = new Decimal(amountFiat).dividedBy(pricePerUnit);
  const feePercent = env.TAKER_FEE_PERCENT;
  const feePerSide = amountCrypto.times(feePercent).dividedBy(100);
  const totalFee = feePerSide.times(2);

  try {
    const tradeId = await db.transaction(async (tx) => {
      const now = new Date();

      // Create trade — platform is the buyer, at escrow_funded
      const [trade] = await tx
        .insert(trades)
        .values({
          orderId: sellOrderId,
          buyerId: PLATFORM_USER_ID,
          sellerId,
          cryptoAsset,
          amountCrypto: amountCrypto.toFixed(8),
          amountFiat: String(amountFiat),
          pricePerUnit: String(pricePerUnit),
          feePercent: String(feePercent),
          feeAmount: totalFee.toFixed(8),
          status: 'escrow_funded',
          escrowFundedAt: now,
          expiresAt: new Date(now.getTime() + env.PAYMENT_WINDOW_MINUTES * 60 * 1000),
        })
        .returning({ id: trades.id });

      // Lock seller's crypto: available → locked
      await mutateBalance(tx, {
        userId: sellerId,
        asset: cryptoAsset,
        field: 'available',
        amount: amountCrypto.negated().toFixed(18),
        entryType: 'trade_escrow_lock',
        idempotencyKey: `trade:${trade.id}:escrow_lock:available`,
        tradeId: trade.id,
        note: `Escrow lock for sell to Maple Exchange`,
      });
      await mutateBalance(tx, {
        userId: sellerId,
        asset: cryptoAsset,
        field: 'locked',
        amount: amountCrypto.toFixed(18),
        entryType: 'trade_escrow_lock',
        idempotencyKey: `trade:${trade.id}:escrow_lock:locked`,
        tradeId: trade.id,
        note: `Escrow lock for sell to Maple Exchange`,
      });

      return trade.id;
    });

    // Auto-advance: platform as buyer instantly completes
    await autoAdvancePlatformTrade(tradeId);

    return tradeId;
  } catch (err: any) {
    console.error('Platform buy fill failed:', err.message ?? err);
    return null;
  }
}

// ─── Auto-Advance Platform Trades ───────────────────────────────────────────

/**
 * Auto-advance a platform trade through the state machine.
 *
 * Platform as SELLER + payment_sent:
 *   → Set status to payment_confirmed with holdingUntil (PLATFORM_VERIFY_MINUTES).
 *   → The processExpiredTrades() background job will auto-release after the hold.
 *   → Admin can verify early via POST /api/admin/trades/:id/verify-payment.
 *
 * Platform as BUYER + escrow_funded:
 *   → Instantly complete: debit seller's locked, credit platform fee, complete trade.
 *   → Platform owes seller CAD (paid offline via Interac).
 */
export async function autoAdvancePlatformTrade(tradeId: string): Promise<void> {
  const [trade] = await db
    .select()
    .from(trades)
    .where(eq(trades.id, tradeId));

  if (!trade) return;

  // Only auto-advance if the platform is the seller or buyer
  if (trade.sellerId !== PLATFORM_USER_ID && trade.buyerId !== PLATFORM_USER_ID) {
    return;
  }

  const now = new Date();
  const asset = trade.cryptoAsset;
  const amountCrypto = trade.amountCrypto;
  const feeAmount = trade.feeAmount;

  // ─── Platform is SELLER, trade at payment_sent ────────────────────────
  // Instead of instant completion, set a hold period so we can verify
  // the Interac e-Transfer actually arrived before releasing crypto.
  if (trade.sellerId === PLATFORM_USER_ID && trade.status === 'payment_sent') {
    const holdingUntil = new Date(now.getTime() + env.PLATFORM_VERIFY_MINUTES * 60 * 1000);

    await db
      .update(trades)
      .set({
        status: 'payment_confirmed',
        paymentConfirmedAt: now,
        holdingUntil,
        updatedAt: now,
      })
      .where(eq(trades.id, tradeId));

    await redis.publish(KEYS.tradeChannel, JSON.stringify({
      type: 'trade_status_changed',
      tradeId,
      newStatus: 'payment_confirmed',
      timestamp: now.toISOString(),
    }));
  }

  // ─── Platform is BUYER, trade at escrow_funded → instant complete ─────
  if (trade.buyerId === PLATFORM_USER_ID && trade.status === 'escrow_funded') {
    await db.transaction(async (tx) => {
      // Debit seller's locked
      await mutateBalance(tx, {
        userId: trade.sellerId,
        asset,
        field: 'locked',
        amount: new Decimal(amountCrypto).negated().toFixed(18),
        entryType: 'trade_escrow_release',
        idempotencyKey: `trade:${tradeId}:release:seller_locked`,
        tradeId,
        note: `Sold ${amountCrypto} ${asset} to Maple Exchange`,
      });

      // Credit platform fee
      await creditPlatformFee(tx, asset, feeAmount, tradeId, 'platform_buy_fee');

      // Update trade to completed
      await tx
        .update(trades)
        .set({
          status: 'completed',
          paymentSentAt: now,
          paymentConfirmedAt: now,
          cryptoReleasedAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(trades.id, tradeId));

      // Update seller stats
      await graduateUserLimit(tx, trade.sellerId);
    });

    await redis.publish(KEYS.tradeChannel, JSON.stringify({
      type: 'trade_status_changed',
      tradeId,
      newStatus: 'completed',
      timestamp: now.toISOString(),
    }));
  }
}

// ─── Complete Platform Sell Trade (Buy-side) ────────────────────────────────

/**
 * Complete a platform trade where platform is the seller.
 * Called by:
 *   - processExpiredTrades() when holdingUntil passes
 *   - Admin verify-payment endpoint
 *
 * Debits platform locked, credits buyer available (minus fee), credits platform fee.
 */
export async function completePlatformSellTrade(tradeId: string): Promise<void> {
  const [trade] = await db
    .select()
    .from(trades)
    .where(eq(trades.id, tradeId));

  if (!trade) return;
  if (trade.sellerId !== PLATFORM_USER_ID) return;
  if (trade.status !== 'payment_confirmed') return;

  const now = new Date();
  const asset = trade.cryptoAsset;
  const amountCrypto = trade.amountCrypto;
  const feeAmount = trade.feeAmount;

  await db.transaction(async (tx) => {
    const feePerSide = new Decimal(feeAmount).dividedBy(2);
    const buyerReceives = new Decimal(amountCrypto).minus(feePerSide);

    // Debit platform's locked balance (allowed to go negative)
    await tx.execute(
      sql`UPDATE balances
          SET locked = locked::numeric - ${new Decimal(amountCrypto).toFixed(18)}::numeric,
              updated_at = NOW()
          WHERE user_id = ${PLATFORM_USER_ID} AND asset = ${asset}`,
    );

    // Credit buyer's available balance
    await mutateBalance(tx, {
      userId: trade.buyerId,
      asset,
      field: 'available',
      amount: buyerReceives.toFixed(18),
      entryType: 'trade_credit',
      idempotencyKey: `trade:${tradeId}:credit:buyer`,
      tradeId,
      note: `Purchased ${buyerReceives.toFixed(8)} ${asset} from Maple Exchange`,
    });

    // Credit platform fee
    await creditPlatformFee(tx, asset, feeAmount, tradeId, 'platform_sell_fee');

    // Update trade to completed
    await tx
      .update(trades)
      .set({
        status: 'completed',
        cryptoReleasedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(trades.id, tradeId));

    // Update buyer stats
    await graduateUserLimit(tx, trade.buyerId);
  });

  await redis.publish(KEYS.tradeChannel, JSON.stringify({
    type: 'trade_status_changed',
    tradeId,
    newStatus: 'completed',
    timestamp: now.toISOString(),
  }));
}
