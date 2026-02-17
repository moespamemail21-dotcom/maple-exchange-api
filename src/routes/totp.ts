import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { generateTotpSecret, verifyTotp, enableTotp, disableTotp, isTotpRequired, verifyBackupCode } from '../services/totp.js';
import { getUserById, updateRefreshToken } from '../services/auth.js';
import { logAuthEvent } from '../services/auth-events.js';
import { createSession } from '../services/session.js';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { env } from '../config/env.js';
import { redis } from '../services/redis.js';
import crypto from 'node:crypto';

const MAX_2FA_ATTEMPTS = 5;
const TWO_FA_ATTEMPT_TTL = 600; // 10 min (matches temp token lifetime)

const enableSchema = z.object({
  secret: z.string().min(1),
  token: z.string().length(6).regex(/^\d{6}$/, 'Token must be 6 digits'),
});

const disableSchema = z.object({
  token: z.string().length(6).regex(/^\d{6}$/, 'Token must be 6 digits'),
});

const verifySchema = z.object({
  email: z.string().email(),
  token: z.string().min(6).max(8), // 6-digit TOTP or 8-char backup code
  tempToken: z.string().min(1),
});

export async function totpRoutes(app: FastifyInstance) {
  // ─── Setup: Generate a new TOTP secret ─────────────────────────────────
  app.post('/api/auth/2fa/setup', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const user = await getUserById(request.userId);
    if (!user) return reply.status(404).send({ error: 'User not found' });

    const { secret, uri } = generateTotpSecret(user.email);

    logAuthEvent({
      userId: request.userId,
      eventType: '2fa_setup',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return { secret, uri };
  });

  // ─── Enable: Verify code and persist TOTP ──────────────────────────────
  app.post('/api/auth/2fa/enable', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = enableSchema.parse(request.body);

    const result = await enableTotp(request.userId, body.secret, body.token);

    if (!result.success) {
      logAuthEvent({
        userId: request.userId,
        eventType: '2fa_enable_failed',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: false,
      });
      return reply.status(400).send({ error: result.error });
    }

    logAuthEvent({
      userId: request.userId,
      eventType: '2fa_enable',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return { success: true, backupCodes: result.backupCodes };
  });

  // ─── Disable: Verify code then remove TOTP ─────────────────────────────
  app.post('/api/auth/2fa/disable', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = disableSchema.parse(request.body);

    const result = await disableTotp(request.userId, body.token);

    if (!result.success) {
      logAuthEvent({
        userId: request.userId,
        eventType: '2fa_disable_failed',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: false,
      });
      return reply.status(400).send({ error: result.error });
    }

    logAuthEvent({
      userId: request.userId,
      eventType: '2fa_disable',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return { success: true };
  });

  // ─── Verify: Complete 2FA during login flow ─────────────────────────────
  app.post('/api/auth/2fa/verify', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = verifySchema.parse(request.body);

    // Verify the temp token
    let decoded: { sub: string; type: string };
    try {
      decoded = app.jwt.verify<{ sub: string; type: string }>(body.tempToken);
    } catch {
      logAuthEvent({
        eventType: '2fa_verify_failed',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: false,
        metadata: { reason: 'invalid_temp_token' },
      });
      return reply.status(401).send({ error: 'Invalid or expired temporary token' });
    }

    if (decoded.type !== '2fa-pending') {
      return reply.status(401).send({ error: 'Invalid token type' });
    }

    // Per-token attempt tracking — prevents brute-force across multiple IPs
    const tokenHash = crypto.createHash('sha256').update(body.tempToken).digest('hex').slice(0, 16);
    const attemptKey = `2fa:attempts:${tokenHash}`;
    const attempts = await redis.get(attemptKey);
    if (attempts && parseInt(attempts, 10) >= MAX_2FA_ATTEMPTS) {
      logAuthEvent({
        userId: decoded.sub,
        eventType: '2fa_verify_failed',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: false,
        metadata: { reason: 'token_attempts_exhausted' },
      });
      return reply.status(429).send({ error: 'Too many failed attempts. Please log in again.' });
    }

    // Look up user and verify TOTP
    const user = await getUserById(decoded.sub);
    if (!user) {
      return reply.status(401).send({ error: 'User not found' });
    }

    // Get the stored secret
    const [fullUser] = await db
      .select({ twoFactorSecret: users.twoFactorSecret })
      .from(users)
      .where(eq(users.id, decoded.sub));

    if (!fullUser?.twoFactorSecret) {
      return reply.status(400).send({ error: '2FA is not configured' });
    }

    // Determine if this is a backup code (8 chars) or TOTP (6 digits)
    const isBackupCode = body.token.length === 8;
    let valid: boolean;

    if (isBackupCode) {
      valid = await verifyBackupCode(decoded.sub, body.token);
    } else {
      valid = verifyTotp(fullUser.twoFactorSecret, body.token);
    }

    if (!valid) {
      // Increment per-token attempt counter
      await redis.incr(attemptKey);
      await redis.expire(attemptKey, TWO_FA_ATTEMPT_TTL);

      logAuthEvent({
        userId: decoded.sub,
        eventType: '2fa_verify_failed',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'],
        success: false,
        metadata: { reason: isBackupCode ? 'invalid_backup_code' : 'invalid_totp_code' },
      });
      return reply.status(401).send({ error: isBackupCode ? 'Invalid backup code' : 'Invalid verification code' });
    }

    // Issue real tokens
    const refreshToken = app.jwt.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: env.JWT_REFRESH_EXPIRY },
    );

    await updateRefreshToken(user.id, refreshToken);

    // Track session
    const sessionId = await createSession({ userId: user.id, refreshToken, ipAddress: request.ip, userAgent: request.headers['user-agent'] as string | undefined });

    const accessToken = app.jwt.sign(
      { sub: user.id, email: user.email, sid: sessionId },
      { expiresIn: '15m' },
    );

    logAuthEvent({
      userId: user.id,
      eventType: '2fa_verify',
      ipAddress: request.ip,
      userAgent: request.headers['user-agent'],
    });

    return { accessToken, refreshToken };
  });
}
