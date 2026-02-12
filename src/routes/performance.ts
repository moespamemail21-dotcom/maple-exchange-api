import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../middleware/auth.js';
import { getPerformance, getAllocations } from '../services/performance.js';
import { db } from '../db/index.js';
import { userPreferences } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const preferencesSchema = z.object({
  pushEnabled: z.boolean().optional(),
  priceAlerts: z.boolean().optional(),
  tradeNotifications: z.boolean().optional(),
  earnNotifications: z.boolean().optional(),
  defaultCurrency: z.enum(['CAD', 'USD']).optional(),
  hideSmallBalances: z.boolean().optional(),
});

export async function performanceRoutes(app: FastifyInstance) {
  // ─── Get Portfolio Performance (P&L + chart) ─────────────────────────
  app.get('/api/portfolio/performance', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { range?: string };
    return getPerformance(request.userId, query.range ?? '24h');
  });

  // ─── Get Portfolio Allocations ───────────────────────────────────────
  app.get('/api/portfolio/allocations', { preHandler: [authGuard] }, async (request) => {
    return getAllocations(request.userId);
  });

  // ─── Get User Preferences ───────────────────────────────────────────
  app.get('/api/user/preferences', { preHandler: [authGuard] }, async (request) => {
    const [prefs] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, request.userId));

    if (!prefs) {
      // Return defaults
      return {
        pushEnabled: true,
        priceAlerts: true,
        tradeNotifications: true,
        earnNotifications: true,
        defaultCurrency: 'CAD',
        hideSmallBalances: false,
      };
    }

    return {
      pushEnabled: prefs.pushEnabled,
      priceAlerts: prefs.priceAlerts,
      tradeNotifications: prefs.tradeNotifications,
      earnNotifications: prefs.earnNotifications,
      defaultCurrency: prefs.defaultCurrency,
      hideSmallBalances: prefs.hideSmallBalances,
    };
  });

  // ─── Update User Preferences ─────────────────────────────────────────
  app.put('/api/user/preferences', { preHandler: [authGuard] }, async (request) => {
    const body = preferencesSchema.parse(request.body);

    // Upsert preferences
    const [existing] = await db
      .select({ id: userPreferences.id })
      .from(userPreferences)
      .where(eq(userPreferences.userId, request.userId));

    if (existing) {
      await db
        .update(userPreferences)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(userPreferences.userId, request.userId));
    } else {
      await db.insert(userPreferences).values({
        userId: request.userId,
        ...body,
      });
    }

    return { success: true, message: 'Preferences updated.' };
  });
}
