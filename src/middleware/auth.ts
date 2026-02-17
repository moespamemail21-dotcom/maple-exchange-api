import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';

// Extend FastifyRequest to include user and session context
declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
    sessionId?: string;
  }
}

/**
 * Auth middleware using @fastify/jwt.
 * Extracts and verifies the JWT from the Authorization header,
 * then validates that the session hasn't been revoked.
 */
export async function authGuard(request: FastifyRequest, reply: FastifyReply) {
  try {
    const decoded = await request.jwtVerify<{ sub: string; sid?: string }>();
    request.userId = decoded.sub;
    request.sessionId = decoded.sid;

    // Validate session still exists (prevents use of revoked sessions)
    if (decoded.sid) {
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, decoded.sid));
      if (!session) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Session revoked' });
      }
    }
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }
}

/**
 * Optional auth — sets userId if token present, but doesn't block.
 */
/**
 * Admin guard — verifies JWT and checks userId against ADMIN_USER_IDS.
 */
export async function adminGuard(request: FastifyRequest, reply: FastifyReply) {
  try {
    const decoded = await request.jwtVerify<{ sub: string; sid?: string }>();
    request.userId = decoded.sub;
    request.sessionId = decoded.sid;

    // Validate session still exists (prevents use of revoked sessions)
    if (decoded.sid) {
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, decoded.sid));
      if (!session) {
        return reply.status(401).send({ error: 'Unauthorized', message: 'Session revoked' });
      }
    }
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
  }

  const adminIds = env.ADMIN_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean);
  if (!adminIds.includes(request.userId)) {
    return reply.status(403).send({ error: 'Forbidden', message: 'Admin access required' });
  }
}

/**
 * Optional auth — sets userId if token present, but doesn't block.
 */
export async function optionalAuth(request: FastifyRequest, _reply: FastifyReply) {
  try {
    const decoded = await request.jwtVerify<{ sub: string }>();
    request.userId = decoded.sub;
  } catch {
    // No-op: unauthenticated access allowed
  }
}
