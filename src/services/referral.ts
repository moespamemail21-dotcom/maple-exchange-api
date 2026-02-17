import { db } from '../db/index.js';
import { referralCodes, referralRewards, notifications, users } from '../db/schema.js';
import { eq, and, lt, count, sum, sql } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import crypto from 'crypto';

function generateCode(): string {
  return 'MAPLE' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const [existing] = await db.select().from(referralCodes)
    .where(eq(referralCodes.userId, userId));
  if (existing) return existing.code;

  const code = generateCode();
  try {
    await db.insert(referralCodes).values({ userId, code });
  } catch (err: any) {
    // Unique constraint violation — concurrent request created the code first
    if (err.code === '23505') {
      const [created] = await db.select().from(referralCodes)
        .where(eq(referralCodes.userId, userId));
      if (created) return created.code;
    }
    throw err;
  }
  return code;
}

export async function getReferralStats(userId: string) {
  const [codeRow] = await db.select().from(referralCodes)
    .where(eq(referralCodes.userId, userId));

  const rewards = await db.select({
    totalRewards: sum(referralRewards.rewardAmount),
    totalReferrals: count(),
    pendingCount: sql<number>`count(*) filter (where ${referralRewards.status} = 'pending')`,
    creditedCount: sql<number>`count(*) filter (where ${referralRewards.status} = 'credited')`,
  }).from(referralRewards)
    .where(eq(referralRewards.referrerId, userId));

  // Get user's current fee credit balance
  const [user] = await db.select({ feeCreditCad: users.feeCreditCad }).from(users)
    .where(eq(users.id, userId));

  // Check if this user was referred by someone (referee perspective)
  const [refereeReward] = await db.select({
    status: referralRewards.status,
  }).from(referralRewards)
    .where(eq(referralRewards.refereeId, userId));

  let welcomeBonusStatus: 'none' | 'pending' | 'credited' = 'none';
  if (refereeReward) {
    welcomeBonusStatus = refereeReward.status === 'credited' ? 'credited' : 'pending';
  }

  return {
    code: codeRow?.code ?? null,
    totalReferrals: rewards[0]?.totalReferrals ?? 0,
    pendingRewards: rewards[0]?.pendingCount ?? 0,
    creditedRewards: rewards[0]?.creditedCount ?? 0,
    totalEarned: rewards[0]?.totalRewards ?? '0.00',
    feeCreditCad: user?.feeCreditCad ?? '0.00',
    referredBy: !!refereeReward,
    welcomeBonusStatus,
  };
}

/**
 * Expire referral rewards that have been pending for more than 90 days.
 * Called opportunistically when stats are fetched or trades complete.
 */
export async function expireStaleRewards(): Promise<number> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const result = await db.update(referralRewards)
    .set({ status: 'expired' })
    .where(and(
      eq(referralRewards.status, 'pending'),
      lt(referralRewards.createdAt, ninetyDaysAgo),
    ))
    .returning({ id: referralRewards.id });

  if (result.length > 0) {
    logger.info({ count: result.length }, 'Expired stale referral rewards (>90 days pending)');
  }

  return result.length;
}

export async function applyReferralCode(refereeId: string, code: string): Promise<boolean> {
  const [referralCode] = await db.select().from(referralCodes)
    .where(eq(referralCodes.code, code.toUpperCase()));

  if (!referralCode) return false;
  if (referralCode.userId === refereeId) return false; // Can't refer yourself

  try {
    await db.transaction(async (tx) => {
      // Check if referee already has a referral reward (prevent double-apply)
      const [existing] = await tx.select().from(referralRewards)
        .where(eq(referralRewards.refereeId, refereeId));
      if (existing) throw new Error('ALREADY_APPLIED');

      // Create pending reward — $10 CAD credited when referee completes first trade
      await tx.insert(referralRewards).values({
        referrerId: referralCode.userId,
        refereeId,
        rewardAsset: 'CAD',
        rewardAmount: '10.00',
        status: 'pending',
      });

      // Atomic SQL increment (prevents TOCTOU on concurrent requests)
      await tx.update(referralCodes)
        .set({ usedCount: sql`${referralCodes.usedCount} + 1` })
        .where(eq(referralCodes.id, referralCode.id));

      // Notify referrer
      await tx.insert(notifications).values({
        userId: referralCode.userId,
        type: 'system',
        title: 'New Referral!',
        message: 'Someone used your referral code! You\'ll earn $10 CAD when they complete their first trade.',
        metadata: { refereeId },
      });
    });
  } catch (err: any) {
    // ALREADY_APPLIED or unique constraint violation — both mean duplicate
    if (err.message === 'ALREADY_APPLIED' || err.code === '23505') {
      return false;
    }
    throw err;
  }

  logger.info({ referrerId: referralCode.userId, refereeId, code }, 'Referral code applied');
  return true;
}
