import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authGuard } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { notifications } from '../db/schema.js';
import { eq, and, desc, sql, count } from 'drizzle-orm';

export async function notificationRoutes(app: FastifyInstance) {
  // ─── List Notifications (paginated, newest first) ──────────────────
  app.get('/api/notifications', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 30, 100);
    const offset = Number(query.offset) || 0;

    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, request.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        isRead: n.isRead,
        metadata: n.metadata,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  });

  // ─── Unread Count ──────────────────────────────────────────────────
  app.get('/api/notifications/unread-count', { preHandler: [authGuard] }, async (request) => {
    const [result] = await db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, request.userId),
          eq(notifications.isRead, false),
        ),
      );

    return { unreadCount: result?.value ?? 0 };
  });

  // ─── Mark Single as Read ──────────────────────────────────────────
  app.patch('/api/notifications/:id/read', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [updated] = await db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, request.userId),
        ),
      )
      .returning({ id: notifications.id });

    if (!updated) {
      return reply.status(404).send({ error: 'Notification not found' });
    }

    return { success: true };
  });

  // ─── Mark All as Read ─────────────────────────────────────────────
  app.post('/api/notifications/read-all', { preHandler: [authGuard] }, async (request) => {
    const result = await db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.userId, request.userId),
          eq(notifications.isRead, false),
        ),
      )
      .returning({ id: notifications.id });

    return { success: true, markedCount: result.length };
  });
}
