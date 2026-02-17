import { db } from '../db/index.js';
import { users, trades, balances } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { mutateBalance } from './balance.js';
import { redis, KEYS } from './redis.js';
import Decimal from 'decimal.js';
import { SUPPORTED_ASSETS } from './balance.js';
import { logger } from '../config/logger.js';

// ─── Fee Credit Helper ──────────────────────────────────────────────────────
//
// Applies user's CAD fee credits to reduce trading fees.
// Must be called INSIDE a transaction to prevent TOCTOU races.
//

async function applyFeeCredit(
  tx: any,
  userId: string,
  feeAmountCrypto: Decimal,
  pricePerUnit: number,
): Promise<{ adjustedFee: Decimal; creditUsedCad: Decimal }> {
  // Look up user's fee credit balance inside the transaction
  const [user] = await tx.select({ feeCreditCad: users.feeCreditCad }).from(users)
    .where(eq(users.id, userId));

  if (!user || new Decimal(user.feeCreditCad).isZero()) {
    return { adjustedFee: feeAmountCrypto, creditUsedCad: new Decimal(0) };
  }

  const availableCredit = new Decimal(user.feeCreditCad);
  const feeAmountCad = feeAmountCrypto.times(pricePerUnit).toDecimalPlaces(2, Decimal.ROUND_UP);

  // Use up to the full fee amount in credits
  const creditToUse = Decimal.min(availableCredit, feeAmountCad);

  if (creditToUse.isZero()) {
    return { adjustedFee: feeAmountCrypto, creditUsedCad: new Decimal(0) };
  }

  // Convert credit back to crypto reduction
  const feeReduction = creditToUse.dividedBy(pricePerUnit).toDecimalPlaces(8, Decimal.ROUND_DOWN);
  const adjustedFee = Decimal.max(feeAmountCrypto.minus(feeReduction), new Decimal(0));

  // Deduct from user's fee credit (atomic SQL decrement)
  await tx.update(users)
    .set({ feeCreditCad: sql`${users.feeCreditCad} - ${creditToUse.toFixed(2)}` })
    .where(eq(users.id, userId));

  logger.info({ userId, creditUsedCad: creditToUse.toFixed(2), feeReduction: feeReduction.toFixed(8) }, 'Applied fee credit');

  return { adjustedFee, creditUsedCad: creditToUse };
}

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

  logger.info('Platform market maker user created');
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

  await mutateBalance(tx, {
    userId: PLATFORM_USER_ID,
    asset,
    field: 'available',
    amount: totalFee.toFixed(18),
    entryType: 'fee_credit',
    idempotencyKey: `trade:${tradeId}:${idempotencySuffix}`,
    tradeId,
    note: `Trading fee from trade ${tradeId}`,
    allowNegative: true,
  });
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

    if (new Decimal(user.maxTradeLimit).lessThan(newLimit)) {
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
  const feePerSide = amountCrypto.times(feePercent).dividedBy(100).toDecimalPlaces(8, Decimal.ROUND_UP);
  const baseTotalFee = feePerSide.times(2).toDecimalPlaces(8, Decimal.ROUND_UP);

  // Add random cents for e-Transfer disambiguation (capped to not exceed original order)
  const randomCents = Math.floor(Math.random() * 99 + 1) / 100;
  const rawDisambiguated = new Decimal(amountFiat).plus(randomCents).toDecimalPlaces(2);
  const disambiguatedFiat = Decimal.min(rawDisambiguated, new Decimal(amountFiat).plus(0.99)).toNumber();

  try {
    const tradeId = await db.transaction(async (tx) => {
      const now = new Date();

      // Apply fee credits (buyer pays the fee on buy orders)
      const { adjustedFee: totalFee } = await applyFeeCredit(tx, buyerId, baseTotalFee, pricePerUnit);

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

      // Platform seller: debit available, credit locked (mirror P2P escrow flow)
      await mutateBalance(tx, {
        userId: PLATFORM_USER_ID,
        asset: cryptoAsset,
        field: 'available',
        amount: amountCrypto.negated().toFixed(18),
        entryType: 'trade_escrow_lock',
        idempotencyKey: `trade:${trade.id}:platform_escrow_lock:available`,
        tradeId: trade.id,
        note: 'Platform market maker escrow — debit available',
        allowNegative: true,
      });
      await mutateBalance(tx, {
        userId: PLATFORM_USER_ID,
        asset: cryptoAsset,
        field: 'locked',
        amount: amountCrypto.toFixed(18),
        entryType: 'trade_escrow_lock',
        idempotencyKey: `trade:${trade.id}:platform_escrow_lock:locked`,
        tradeId: trade.id,
        note: 'Platform market maker escrow — credit locked',
        allowNegative: true,
      });

      return trade.id;
    });

    // Publish trade event with participant IDs for WebSocket routing
    await redis.publish(KEYS.tradeChannel, JSON.stringify({
      type: 'trade_created',
      tradeId,
      buyerId,
      sellerId: PLATFORM_USER_ID,
      status: 'escrow_funded',
    }));

    return tradeId;
  } catch (err: any) {
    logger.error({ err }, 'Platform fill failed');
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
  const feePerSide = amountCrypto.times(feePercent).dividedBy(100).toDecimalPlaces(8, Decimal.ROUND_UP);
  const baseTotalFee = feePerSide.times(2).toDecimalPlaces(8, Decimal.ROUND_UP);

  try {
    const tradeId = await db.transaction(async (tx) => {
      const now = new Date();

      // Apply fee credits (seller pays the fee on sell orders)
      const { adjustedFee: totalFee } = await applyFeeCredit(tx, sellerId, baseTotalFee, pricePerUnit);

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
    logger.error({ err }, 'Platform buy fill failed');
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
  const result = await db.transaction(async (tx) => {
    // Lock the trade row to prevent concurrent advancement (admin + background job race)
    await tx.execute(sql`SELECT id FROM trades WHERE id = ${tradeId} FOR UPDATE`);
    const [trade] = await tx.select().from(trades).where(eq(trades.id, tradeId));

    if (!trade) return null;
    if (trade.sellerId !== PLATFORM_USER_ID && trade.buyerId !== PLATFORM_USER_ID) return null;

    const now = new Date();
    const asset = trade.cryptoAsset;
    const amountCrypto = trade.amountCrypto;
    const feeAmount = trade.feeAmount;

    // ─── Platform is SELLER, trade at payment_sent ────────────────────────
    // Set a hold period so we can verify the Interac e-Transfer arrived.
    if (trade.sellerId === PLATFORM_USER_ID && trade.status === 'payment_sent') {
      const holdingUntil = new Date(now.getTime() + env.PLATFORM_VERIFY_MINUTES * 60 * 1000);

      await tx
        .update(trades)
        .set({
          status: 'payment_confirmed',
          paymentConfirmedAt: now,
          holdingUntil,
          updatedAt: now,
        })
        .where(eq(trades.id, tradeId));

      return { newStatus: 'payment_confirmed', buyerId: trade.buyerId, sellerId: trade.sellerId, timestamp: now.toISOString() };
    }

    // ─── Platform is BUYER, trade at escrow_funded → instant complete ─────
    if (trade.buyerId === PLATFORM_USER_ID && trade.status === 'escrow_funded') {
      const totalFee = new Decimal(feeAmount);
      const platformReceives = new Decimal(amountCrypto).minus(totalFee);

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

      // Credit platform buyer with net crypto (after fee)
      await mutateBalance(tx, {
        userId: PLATFORM_USER_ID,
        asset,
        field: 'available',
        amount: platformReceives.toFixed(18),
        entryType: 'trade_credit',
        idempotencyKey: `trade:${tradeId}:credit:platform_buyer`,
        tradeId,
        note: `Platform purchased ${platformReceives.toFixed(8)} ${asset}`,
        allowNegative: true,
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

      return { newStatus: 'completed', buyerId: trade.buyerId, sellerId: trade.sellerId, timestamp: now.toISOString() };
    }

    return null;
  });

  // Publish trade event outside the transaction (Redis pub/sub)
  if (result) {
    await redis.publish(KEYS.tradeChannel, JSON.stringify({
      type: 'trade_status_changed',
      tradeId,
      buyerId: result.buyerId,
      sellerId: result.sellerId,
      newStatus: result.newStatus,
      timestamp: result.timestamp,
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
  const completed = await db.transaction(async (tx) => {
    // Lock the trade row to prevent concurrent completion (admin verify + background job race)
    await tx.execute(sql`SELECT id FROM trades WHERE id = ${tradeId} FOR UPDATE`);
    const [trade] = await tx.select().from(trades).where(eq(trades.id, tradeId));

    if (!trade) return false;
    if (trade.sellerId !== PLATFORM_USER_ID) return false;
    if (trade.status !== 'payment_confirmed') return false;

    const now = new Date();
    const asset = trade.cryptoAsset;
    const amountCrypto = trade.amountCrypto;
    const feeAmount = trade.feeAmount;

    const totalFee = new Decimal(feeAmount);
    const buyerReceives = new Decimal(amountCrypto).minus(totalFee);

    // Debit platform's locked balance (allowed to go negative for market maker)
    await mutateBalance(tx, {
      userId: PLATFORM_USER_ID,
      asset,
      field: 'locked',
      amount: new Decimal(amountCrypto).negated().toFixed(18),
      entryType: 'trade_escrow_release',
      idempotencyKey: `trade:${tradeId}:release:platform_locked`,
      tradeId,
      note: `Platform market maker escrow release`,
      allowNegative: true,
    });

    // Credit buyer's available balance (amountCrypto minus total fee)
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

    return { buyerId: trade.buyerId };
  });

  if (completed) {
    await redis.publish(KEYS.tradeChannel, JSON.stringify({
      type: 'trade_status_changed',
      tradeId,
      buyerId: completed.buyerId,
      sellerId: PLATFORM_USER_ID,
      newStatus: 'completed',
      timestamp: new Date().toISOString(),
    }));
  }
}
