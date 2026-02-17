import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { referralRewards } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { getOrCreateReferralCode, getReferralStats, applyReferralCode, expireStaleRewards } from '../services/referral.js';

const applyCodeSchema = z.object({
  code: z.string().min(1).max(20),
});

export async function referralRoutes(app: FastifyInstance) {
  // Get or create the user's referral code
  app.get('/api/referral/code', { preHandler: [authGuard] }, async (request) => {
    const code = await getOrCreateReferralCode(request.userId);
    return { code };
  });

  // Get referral stats (how many referred, rewards earned)
  app.get('/api/referral/stats', { preHandler: [authGuard] }, async (request) => {
    // Opportunistically expire stale rewards (non-blocking)
    expireStaleRewards().catch(() => {});
    return getReferralStats(request.userId);
  });

  // Apply a referral code (used during/after registration)
  app.post('/api/referral/apply', { preHandler: [authGuard] }, async (request, reply) => {
    const body = applyCodeSchema.parse(request.body);
    const success = await applyReferralCode(request.userId, body.code);
    if (!success) {
      return reply.status(400).send({ error: 'Invalid referral code, already used, or self-referral' });
    }
    return { success: true, message: 'Referral code applied! You\'ll both earn $10 CAD after your first trade.' };
  });

  // Get referral history (individual referrals for the referrer)
  app.get('/api/referral/history', { preHandler: [authGuard] }, async (request) => {
    const rewards = await db.select({
      id: referralRewards.id,
      refereeId: referralRewards.refereeId,
      rewardAmount: referralRewards.rewardAmount,
      status: referralRewards.status,
      creditedAt: referralRewards.creditedAt,
      createdAt: referralRewards.createdAt,
    }).from(referralRewards)
      .where(eq(referralRewards.referrerId, request.userId))
      .orderBy(desc(referralRewards.createdAt));

    return {
      referrals: rewards.map(r => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
        creditedAt: r.creditedAt?.toISOString() ?? null,
      })),
    };
  });
}
