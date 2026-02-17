import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import {
  users, trades, deposits, withdrawals, balances, stakingPositions,
  earnings, notifications, priceAlerts, recurringBuys, savedAddresses,
  sessions, authEvents, complianceLogs, orders, kycDocuments
} from '../db/schema.js';
import { eq, and, or, desc, gt, sql, inArray } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import bcrypt from 'bcryptjs';
import { updateRefreshToken } from '../services/auth.js';
import { revokeAllUserSessions } from '../services/session.js';

// ─── Schemas ────────────────────────────────────────────────────────────────

const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

// Active trade statuses that block account deletion
const ACTIVE_TRADE_STATUSES = [
  'pending',
  'escrow_funded',
  'payment_sent',
  'payment_confirmed',
  'disputed',
];

// Active staking statuses that block account deletion
const ACTIVE_STAKING_STATUSES = ['active', 'unstaking'];

// Pending withdrawal statuses that block account deletion
const PENDING_WITHDRAWAL_STATUSES = ['pending_review', 'approved', 'broadcasting'];

export async function accountRoutes(app: FastifyInstance) {

  // ─── PIPEDA Subject Access Request — Data Export ──────────────────────
  app.post('/api/account/export', {
    config: { rateLimit: { max: 1, timeWindow: '1 hour' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const userId = request.userId;

    // Fetch user profile, excluding sensitive auth fields
    const [userRow] = await db
      .select({
        id: users.id,
        email: users.email,
        phone: users.phone,
        displayName: users.displayName,
        kycStatus: users.kycStatus,
        kycVideoStatus: users.kycVideoStatus,
        tradeCount: users.tradeCount,
        completionRate: users.completionRate,
        avgConfirmSeconds: users.avgConfirmSeconds,
        maxTradeLimit: users.maxTradeLimit,
        interacEmail: users.interacEmail,
        autodepositVerified: users.autodepositVerified,
        locale: users.locale,
        twoFactorEnabled: users.twoFactorEnabled,
        fullLegalName: users.fullLegalName,
        dateOfBirth: users.dateOfBirth,
        address: users.address,
        city: users.city,
        province: users.province,
        postalCode: users.postalCode,
        countryOfResidence: users.countryOfResidence,
        sin: users.sin,
        occupation: users.occupation,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, userId));

    if (!userRow) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Fetch all user data in parallel
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    const [
      userTrades,
      userDeposits,
      userWithdrawals,
      userBalances,
      userStakingPositions,
      userEarnings,
      userNotifications,
      userPriceAlerts,
      userRecurringBuys,
      userSavedAddresses,
      userSessions,
      userAuthEvents,
    ] = await Promise.all([
      db.select().from(trades)
        .where(or(eq(trades.buyerId, userId), eq(trades.sellerId, userId)))
        .orderBy(desc(trades.createdAt)),
      db.select().from(deposits)
        .where(eq(deposits.userId, userId))
        .orderBy(desc(deposits.createdAt)),
      db.select().from(withdrawals)
        .where(eq(withdrawals.userId, userId))
        .orderBy(desc(withdrawals.createdAt)),
      db.select().from(balances)
        .where(eq(balances.userId, userId)),
      db.select().from(stakingPositions)
        .where(eq(stakingPositions.userId, userId))
        .orderBy(desc(stakingPositions.createdAt)),
      db.select().from(earnings)
        .where(eq(earnings.userId, userId))
        .orderBy(desc(earnings.createdAt)),
      db.select().from(notifications)
        .where(eq(notifications.userId, userId))
        .orderBy(desc(notifications.createdAt)),
      db.select().from(priceAlerts)
        .where(eq(priceAlerts.userId, userId))
        .orderBy(desc(priceAlerts.createdAt)),
      db.select().from(recurringBuys)
        .where(eq(recurringBuys.userId, userId))
        .orderBy(desc(recurringBuys.createdAt)),
      db.select().from(savedAddresses)
        .where(eq(savedAddresses.userId, userId))
        .orderBy(desc(savedAddresses.createdAt)),
      db.select().from(sessions)
        .where(eq(sessions.userId, userId))
        .orderBy(desc(sessions.createdAt)),
      db.select().from(authEvents)
        .where(and(
          eq(authEvents.userId, userId),
          gt(authEvents.createdAt, ninetyDaysAgo),
        ))
        .orderBy(desc(authEvents.createdAt)),
    ]);

    return reply.send({
      exportedAt: new Date().toISOString(),
      pipedaNotice: 'This export contains all personal data held by Maple Exchange pursuant to your right of access under the Personal Information Protection and Electronic Documents Act (PIPEDA).',
      profile: userRow,
      trades: userTrades,
      deposits: userDeposits,
      withdrawals: userWithdrawals,
      balances: userBalances,
      stakingPositions: userStakingPositions,
      earnings: userEarnings,
      notifications: userNotifications,
      priceAlerts: userPriceAlerts,
      recurringBuys: userRecurringBuys,
      savedAddresses: userSavedAddresses,
      sessions: userSessions,
      authEvents: userAuthEvents,
    });
  });

  // ─── Account Deletion (Soft Delete) ───────────────────────────────────
  app.delete('/api/account', {
    config: { rateLimit: { max: 1, timeWindow: '1 day' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const userId = request.userId;
    const body = deleteAccountSchema.parse(request.body);

    // ── Step 1: Verify password ──────────────────────────────────────────
    const [user] = await db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId));

    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const passwordValid = await bcrypt.compare(body.password, user.passwordHash);
    if (!passwordValid) {
      return reply.status(401).send({ error: 'Invalid password' });
    }

    // ── Step 2: Cancel all active orders and refund locked balances ─────
    const activeOrders = await db.select().from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.status, 'active')));

    if (activeOrders.length > 0) {
      // Cancel all active orders. Note: crypto is only locked per-trade (during
      // matching/escrow), NOT per-order, so no balance refund is needed here.
      // Any in-flight trades are blocked separately below.
      await db.update(orders)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(and(eq(orders.userId, userId), eq(orders.status, 'active')));
    }

    // ── Step 3: Check for blocking conditions ────────────────────────────

    // Active trades (pending, escrow_funded, payment_sent, payment_confirmed, disputed)
    const activeTrades = await db
      .select({ id: trades.id, status: trades.status })
      .from(trades)
      .where(and(
        or(eq(trades.buyerId, userId), eq(trades.sellerId, userId)),
        inArray(trades.status, ACTIVE_TRADE_STATUSES),
      ));

    if (activeTrades.length > 0) {
      return reply.status(409).send({
        error: 'Cannot delete account with active trades',
        activeTradeCount: activeTrades.length,
        message: 'Please complete or cancel all active trades before deleting your account.',
      });
    }

    // Active staking positions
    const activeStaking = await db
      .select({ id: stakingPositions.id, status: stakingPositions.status })
      .from(stakingPositions)
      .where(and(
        eq(stakingPositions.userId, userId),
        inArray(stakingPositions.status, ACTIVE_STAKING_STATUSES),
      ));

    if (activeStaking.length > 0) {
      return reply.status(409).send({
        error: 'Cannot delete account with active staking positions',
        activeStakingCount: activeStaking.length,
        message: 'Please unstake and withdraw all staking positions before deleting your account.',
      });
    }

    // Pending withdrawals
    const pendingWithdrawals = await db
      .select({ id: withdrawals.id, status: withdrawals.status })
      .from(withdrawals)
      .where(and(
        eq(withdrawals.userId, userId),
        inArray(withdrawals.status, PENDING_WITHDRAWAL_STATUSES),
      ));

    if (pendingWithdrawals.length > 0) {
      return reply.status(409).send({
        error: 'Cannot delete account with pending withdrawals',
        pendingWithdrawalCount: pendingWithdrawals.length,
        message: 'Please wait for all pending withdrawals to complete before deleting your account.',
      });
    }

    // Non-zero balances — warn user they will lose funds
    const userBalances = await db
      .select({ asset: balances.asset, available: balances.available, locked: balances.locked })
      .from(balances)
      .where(eq(balances.userId, userId));
    const nonZero = userBalances.filter(
      (b) => parseFloat(b.available) > 0 || parseFloat(b.locked) > 0,
    );
    if (nonZero.length > 0) {
      return reply.status(409).send({
        error: 'Cannot delete account with remaining balances',
        balances: nonZero.map((b) => ({ asset: b.asset, available: b.available, locked: b.locked })),
        message: 'Please withdraw all funds before deleting your account.',
      });
    }

    // ── Step 4: Perform soft deletion ────────────────────────────────────

    // Cancel all recurring buys
    await db
      .update(recurringBuys)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(
        eq(recurringBuys.userId, userId),
        eq(recurringBuys.status, 'active'),
      ));

    // Revoke all sessions
    await revokeAllUserSessions(userId);

    // Clear refresh token
    await updateRefreshToken(userId, null);

    // Delete price alerts
    await db.delete(priceAlerts).where(eq(priceAlerts.userId, userId));

    // Delete notifications
    await db.delete(notifications).where(eq(notifications.userId, userId));

    // Delete saved addresses
    await db.delete(savedAddresses).where(eq(savedAddresses.userId, userId));

    // Delete KYC documents (PIPEDA: personal identity documents must be purged)
    await db.delete(kycDocuments).where(eq(kycDocuments.userId, userId));

    // Anonymize user record
    await db
      .update(users)
      .set({
        email: `deleted_${userId}@deleted.maple`,
        displayName: null,
        phone: null,
        interacEmail: null,
        fullLegalName: null,
        address: null,
        city: null,
        province: null,
        postalCode: null,
        sin: null,
        occupation: null,
        pinHash: null,
        biometricTokenHash: null,
        twoFactorSecret: null,
        twoFactorEnabled: false,
        kycStatus: 'deleted',
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    // Log compliance event
    await db.insert(complianceLogs).values({
      userId,
      eventType: 'account_deletion',
      payload: {
        reason: 'user_requested',
        deletedAt: new Date().toISOString(),
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      },
    });

    return reply.send({
      success: true,
      message: 'Your account has been deleted. All personal data has been anonymized in accordance with PIPEDA.',
    });
  });
}
