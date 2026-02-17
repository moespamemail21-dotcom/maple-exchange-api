import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { authGuard } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { deviceTokens } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const registerDeviceSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(['ios', 'android']),
});

export async function appConfigRoutes(app: FastifyInstance) {
  // ─── GET /api/app/config — Public (no auth required) ────────────────
  app.get('/api/app/config', async (_request, _reply) => {
    return {
      minVersion: env.APP_MIN_VERSION,
      latestVersion: env.APP_LATEST_VERSION,
      forceUpdate: false,
      maintenanceMode: env.MAINTENANCE_MODE,
      maintenanceMessage: env.MAINTENANCE_MESSAGE ?? null,
      announcements: [],
    };
  });

  // ─── POST /api/devices/register — Authenticated ─────────────────────
  app.post('/api/devices/register', { preHandler: [authGuard] }, async (request, reply) => {
    const body = registerDeviceSchema.parse(request.body);

    // Upsert: if token already exists, update userId and platform
    await db
      .insert(deviceTokens)
      .values({
        userId: request.userId,
        token: body.token,
        platform: body.platform,
      })
      .onConflictDoUpdate({
        target: deviceTokens.token,
        set: {
          userId: request.userId,
          platform: body.platform,
          updatedAt: new Date(),
        },
      });

    return { success: true, message: 'Device registered' };
  });
}
