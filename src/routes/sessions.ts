import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { eq, and, desc, gt, ne } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';

const uuidParamSchema = z.object({ id: z.string().uuid() });

function parseDeviceName(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown Device';
  if (userAgent.includes('iPhone')) return 'iPhone';
  if (userAgent.includes('iPad')) return 'iPad';
  if (userAgent.includes('Android')) return 'Android';
  if (userAgent.includes('Mac')) return 'Mac';
  if (userAgent.includes('Windows')) return 'Windows PC';
  if (userAgent.includes('Linux')) return 'Linux';
  return 'Unknown Device';
}

export async function sessionRoutes(app: FastifyInstance) {
  // List active sessions
  app.get('/api/sessions', { preHandler: [authGuard] }, async (request) => {
    const now = new Date();
    const userSessions = await db
      .select({
        id: sessions.id,
        ipAddress: sessions.ipAddress,
        deviceName: sessions.deviceName,
        lastActiveAt: sessions.lastActiveAt,
        createdAt: sessions.createdAt,
      })
      .from(sessions)
      .where(and(
        eq(sessions.userId, request.userId),
        gt(sessions.expiresAt, now),
      ))
      .orderBy(desc(sessions.lastActiveAt));

    // Match the current session via the sessionId embedded in the JWT (sid claim)
    const currentSessionId = request.sessionId;
    return {
      sessions: userSessions.map(s => ({
        ...s,
        isCurrent: currentSessionId ? s.id === currentSessionId : false,
      })),
    };
  });

  // Revoke a specific session
  app.delete('/api/sessions/:id', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [deleted] = await db
      .delete(sessions)
      .where(and(
        eq(sessions.id, id),
        eq(sessions.userId, request.userId),
      ))
      .returning({ id: sessions.id });

    if (!deleted) {
      return reply.status(404).send({ error: 'Session not found' });
    }

    return { success: true, message: 'Session revoked' };
  });

  // Revoke all other sessions (keep current)
  app.post('/api/sessions/revoke-others', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const currentSessionId = request.sessionId;
    if (!currentSessionId) {
      return reply.status(400).send({ error: 'Cannot identify current session' });
    }

    // Delete all sessions for this user except the current one
    const deleted = await db
      .delete(sessions)
      .where(and(
        eq(sessions.userId, request.userId),
        ne(sessions.id, currentSessionId),
      ))
      .returning({ id: sessions.id });

    return { success: true, revoked: deleted.length };
  });
}
