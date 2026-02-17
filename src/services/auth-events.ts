import { db } from '../db/index.js';
import { authEvents } from '../db/schema.js';

interface LogAuthEventParams {
  userId?: string;
  eventType: string;
  ipAddress?: string;
  userAgent?: string;
  success?: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Log an authentication event to the auth_events table.
 * Fire-and-forget — never throws, never blocks the auth flow.
 */
export async function logAuthEvent(params: LogAuthEventParams): Promise<void> {
  try {
    await db.insert(authEvents).values({
      userId: params.userId ?? null,
      eventType: params.eventType,
      ipAddress: params.ipAddress ?? null,
      userAgent: params.userAgent ?? null,
      success: params.success ?? true,
      metadata: params.metadata ?? null,
    });
  } catch {
    // Silently swallow — auth event logging must never block auth flow
  }
}
