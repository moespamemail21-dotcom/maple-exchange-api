import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '../config/env.js';

// Extend FastifyRequest to include user
declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/**
 * Auth middleware using @fastify/jwt.
 * Extracts and verifies the JWT from the Authorization header.
 */
export async function authGuard(request: FastifyRequest, reply: FastifyReply) {
  try {
    const decoded = await request.jwtVerify<{ sub: string }>();
    request.userId = decoded.sub;
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
    const decoded = await request.jwtVerify<{ sub: string }>();
    request.userId = decoded.sub;
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
