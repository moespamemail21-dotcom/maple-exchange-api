import { db } from '../db/index.js';
import { authEvents, withdrawals, notifications, users } from '../db/schema.js';
import { eq, and, gt, sql } from 'drizzle-orm';
import { logger } from '../config/logger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function maskIp(ip: string): string {
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.x.x`;
  // IPv6: show first segment
  const v6parts = ip.split(':');
  if (v6parts.length > 2) return `${v6parts[0]}:${v6parts[1]}:****`;
  return '***';
}

// ─── Login Anomaly Detection ────────────────────────────────────────────────

/**
 * Check whether the login IP has been seen before for this user.
 * If the IP is new, create a security notification.
 * Fire-and-forget — never throws, never blocks the auth flow.
 */
export async function checkLoginAnomaly(
  userId: string,
  ipAddress: string,
): Promise<void> {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const previousLogins = await db
      .select({ ipAddress: authEvents.ipAddress })
      .from(authEvents)
      .where(
        and(
          eq(authEvents.userId, userId),
          eq(authEvents.eventType, 'login'),
          eq(authEvents.success, true),
          gt(authEvents.createdAt, thirtyDaysAgo),
        ),
      );

    const knownIps = new Set(previousLogins.map((row) => row.ipAddress));

    if (knownIps.has(ipAddress)) return;

    await db.insert(notifications).values({
      userId,
      type: 'security',
      title: 'New Device Login Detected',
      message: `A login from a new IP address (${maskIp(ipAddress)}) was detected. If this wasn't you, change your password immediately.`,
      metadata: { ipAddress: maskIp(ipAddress), detectedAt: new Date().toISOString() },
    });

    logger.info({ userId, ip: maskIp(ipAddress) }, 'New IP login detected');
  } catch (err) {
    logger.error(err, 'checkLoginAnomaly failed silently');
  }
}

// ─── Withdrawal Velocity Detection ─────────────────────────────────────────

/**
 * Check whether the user has made >= 3 non-cancelled/non-failed withdrawals
 * in the last hour. If so, create a security notification.
 * Fire-and-forget — never throws, never blocks the withdrawal flow.
 */
export async function checkWithdrawalVelocity(
  userId: string,
): Promise<void> {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(withdrawals)
      .where(
        and(
          eq(withdrawals.userId, userId),
          gt(withdrawals.requestedAt, oneHourAgo),
          sql`${withdrawals.status} NOT IN ('cancelled', 'failed')`,
        ),
      );

    if (!result || result.count < 3) return;

    // Deduplicate: don't create another if one was sent in the last hour
    const [recent] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(
        eq(notifications.userId, userId),
        eq(notifications.title, 'Unusual Withdrawal Activity'),
        gt(notifications.createdAt, oneHourAgo),
      ))
      .limit(1);
    if (recent) return;

    await db.insert(notifications).values({
      userId,
      type: 'security',
      title: 'Unusual Withdrawal Activity',
      message:
        'Multiple withdrawal requests detected in a short period. If this wasn\'t you, secure your account immediately.',
    });

    logger.warn({ userId, count: result.count }, 'Withdrawal velocity threshold hit');
  } catch (err) {
    logger.error(err, 'checkWithdrawalVelocity failed silently');
  }
}

// ─── Failed Login Spike Detection ───────────────────────────────────────────

/**
 * Check whether there have been >= 3 failed login attempts for this email
 * in the last hour. If so (and the user exists), create a security notification.
 * Fire-and-forget — never throws, never blocks the auth flow.
 */
export async function checkFailedLoginSpike(
  email: string,
): Promise<void> {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    // Find the user by email so we can look up their userId and create a notification
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) return;

    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(authEvents)
      .where(
        and(
          eq(authEvents.eventType, 'login_failed'),
          eq(authEvents.success, false),
          gt(authEvents.createdAt, oneHourAgo),
          // Match on metadata email since login_failed events may not have a userId
          sql`${authEvents.metadata}->>'email' = ${email}`,
        ),
      );

    if (!result || result.count < 3) return;

    // Deduplicate: don't create another if one was sent in the last hour
    const [recentNotif] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(
        eq(notifications.userId, user.id),
        eq(notifications.title, 'Multiple Failed Login Attempts'),
        gt(notifications.createdAt, oneHourAgo),
      ))
      .limit(1);
    if (recentNotif) return;

    await db.insert(notifications).values({
      userId: user.id,
      type: 'security',
      title: 'Multiple Failed Login Attempts',
      message:
        'Someone has attempted to log into your account multiple times. Your account will be temporarily locked after 5 failed attempts.',
    });

    logger.warn({ email, count: result.count }, 'Failed login spike detected');
  } catch (err) {
    logger.error(err, 'checkFailedLoginSpike failed silently');
  }
}
