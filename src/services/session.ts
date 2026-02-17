import { db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { eq, lt, desc, inArray, and, ne } from 'drizzle-orm';
import { logger } from '../config/logger.js';

const MAX_SESSIONS_PER_USER = 10;

export async function createSession(params: {
  userId: string;
  refreshToken: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<string> {
  const deviceName = parseDeviceName(params.userAgent);
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days

  const [session] = await db
    .insert(sessions)
    .values({
      userId: params.userId,
      refreshToken: params.refreshToken,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      deviceName,
      expiresAt,
    })
    .returning({ id: sessions.id });

  // Prune old sessions if the user exceeds the maximum
  try {
    const userSessions = await db
      .select({ id: sessions.id, createdAt: sessions.createdAt })
      .from(sessions)
      .where(eq(sessions.userId, params.userId))
      .orderBy(desc(sessions.createdAt));

    if (userSessions.length > MAX_SESSIONS_PER_USER) {
      const toDelete = userSessions.slice(MAX_SESSIONS_PER_USER).map(s => s.id);
      await db.delete(sessions).where(inArray(sessions.id, toDelete));
      logger.info(
        { userId: params.userId, pruned: toDelete.length },
        'pruned excess sessions',
      );
    }
  } catch (err) {
    // Non-critical — don't fail session creation for a pruning error
    logger.error({ userId: params.userId, err }, 'failed to prune sessions');
  }

  return session.id;
}

export async function updateSessionActivity(refreshToken: string): Promise<void> {
  try {
    await db
      .update(sessions)
      .set({ lastActiveAt: new Date() })
      .where(eq(sessions.refreshToken, refreshToken));
  } catch {
    // Non-critical — don't block token refresh
  }
}

export async function revokeSession(refreshToken: string): Promise<void> {
  await db
    .delete(sessions)
    .where(eq(sessions.refreshToken, refreshToken));
}

export async function revokeAllUserSessions(userId: string): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ id: sessions.id });
  return deleted.length;
}

/**
 * Revoke all sessions for a user EXCEPT the specified session.
 * Returns the count of revoked sessions.
 */
export async function revokeOtherUserSessions(userId: string, keepSessionId: string): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
    .returning({ id: sessions.id });
  return deleted.length;
}

export async function cleanupExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return deleted.length;
}

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
