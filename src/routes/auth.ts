import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUser, verifyCredentials, getUserById, updateRefreshToken, getRefreshToken, setPin, verifyPin, hasPin, registerBiometric, verifyBiometric, revokeBiometric, createPasswordResetToken, resetPassword, changePassword, type PinVerifyResult } from '../services/auth.js';
import { authGuard } from '../middleware/auth.js';
import { getUserBalances, type SupportedAsset, SUPPORTED_ASSETS } from '../services/balance.js';
import { CHAIN_ASSETS, REQUIRED_CONFIRMATIONS, MIN_DEPOSIT } from '../services/wallet.js';
import { logAuthEvent } from '../services/auth-events.js';
import { isTotpRequired } from '../services/totp.js';
import { createSession, updateSessionActivity, revokeSession, revokeOtherUserSessions } from '../services/session.js';
import { checkLoginAnomaly, checkFailedLoginSpike } from '../services/suspicious-activity.js';
import { db } from '../db/index.js';
import { wallets } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { ErrorCode, apiError } from '../config/error-codes.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { applyReferralCode } from '../services/referral.js';
import crypto from 'node:crypto';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128).refine(
    (pw) => /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw),
    { message: 'Password must include uppercase, lowercase, and a number' }
  ),
  displayName: z.string().min(1).max(100).optional(),
  referralCode: z.string().max(20).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

const pinSchema = z.object({
  pin: z.string().length(6).regex(/^\d{6}$/, 'PIN must be 6 digits'),
});

const biometricVerifySchema = z.object({
  token: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8).max(128).refine(
    (pw) => /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw),
    { message: 'Password must include uppercase, lowercase, and a number' }
  ),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128).refine(
    (pw) => /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw),
    { message: 'Password must include uppercase, lowercase, and a number' }
  ),
});

export async function authRoutes(app: FastifyInstance) {
  // ─── Register ───────────────────────────────────────────────────────────
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = registerSchema.parse(request.body);

    try {
      const user = await createUser(body.email, body.password, body.displayName);

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

      // Fetch the wallets and balances just created in the registration transaction
      // so the client can show deposit addresses immediately without an extra round-trip.
      const userWallets = await db
        .select({
          chain: wallets.chain,
          address: wallets.address,
          destinationTag: wallets.destinationTag,
        })
        .from(wallets)
        .where(eq(wallets.userId, user.id));

      const balances = await getUserBalances(user.id);

      // Apply referral code if provided (silently — don't fail registration)
      if (body.referralCode) {
        try {
          await applyReferralCode(user.id, body.referralCode);
        } catch (err) {
          logger.warn({ userId: user.id, referralCode: body.referralCode, err }, 'Failed to apply referral code during registration');
        }
      }

      logAuthEvent({ userId: user.id, eventType: 'register', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: true, metadata: { email: body.email } });

      return reply.status(201).send({
        user: { id: user.id, email: user.email },
        hasPin: false,
        accessToken,
        refreshToken,
        wallets: userWallets.map((w) => ({
          chain: w.chain,
          address: w.address,
          destinationTag: w.destinationTag,
          assets: CHAIN_ASSETS[w.chain as keyof typeof CHAIN_ASSETS] ?? [],
          requiredConfirmations: REQUIRED_CONFIRMATIONS[w.chain as keyof typeof REQUIRED_CONFIRMATIONS],
        })),
        balances: balances.map((b) => ({
          asset: b.asset,
          available: b.available,
          locked: b.locked,
          pendingDeposit: b.pendingDeposit,
        })),
      });
    } catch (err: any) {
      if (err.code === '23505') {
        logAuthEvent({ eventType: 'register', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: false, metadata: { email: body.email, error: 'duplicate' } });
        return reply.status(409).send(apiError(ErrorCode.EMAIL_EXISTS, 'Email already registered'));
      }
      throw err;
    }
  });

  // ─── Login ──────────────────────────────────────────────────────────────
  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const user = await verifyCredentials(body.email, body.password);

    if (user === 'locked') {
      logAuthEvent({ eventType: 'login_failed', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: false, metadata: { email: body.email, reason: 'account_locked' } });
      return reply.status(423).send(apiError(ErrorCode.ACCOUNT_LOCKED, 'Account temporarily locked due to too many failed attempts. Try again in 15 minutes.'));
    }

    if (!user) {
      logAuthEvent({ eventType: 'login_failed', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: false, metadata: { email: body.email } });
      checkFailedLoginSpike(body.email);
      return reply.status(401).send(apiError(ErrorCode.INVALID_CREDENTIALS, 'Invalid email or password'));
    }

    // Check if 2FA is enabled — if so, return a temp token instead of real tokens
    const needs2FA = await isTotpRequired(user.id);
    if (needs2FA) {
      const tempToken = app.jwt.sign(
        { sub: user.id, type: '2fa-pending' },
        { expiresIn: '2m' },
      );

      logAuthEvent({ userId: user.id, eventType: 'login_2fa_pending', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: true });

      return { requires2FA: true, tempToken };
    }

    const refreshToken = app.jwt.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: env.JWT_REFRESH_EXPIRY },
    );

    await updateRefreshToken(user.id, refreshToken);

    // Track session + detect suspicious activity
    const sessionId = await createSession({ userId: user.id, refreshToken, ipAddress: request.ip, userAgent: request.headers['user-agent'] as string | undefined });
    checkLoginAnomaly(user.id, request.ip ?? '');

    const accessToken = app.jwt.sign(
      { sub: user.id, email: user.email, sid: sessionId },
      { expiresIn: '15m' },
    );

    // Fetch full profile, wallets, and balances for the client
    const fullUser = await getUserById(user.id);
    const pinSet = await hasPin(user.id);
    const userWallets = await db
      .select({
        chain: wallets.chain,
        address: wallets.address,
        destinationTag: wallets.destinationTag,
      })
      .from(wallets)
      .where(eq(wallets.userId, user.id));

    const balances = await getUserBalances(user.id);

    logAuthEvent({ userId: user.id, eventType: 'login', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: true });

    return {
      user: fullUser ?? user,
      hasPin: pinSet,
      accessToken,
      refreshToken,
      wallets: userWallets.map((w) => ({
        chain: w.chain,
        address: w.address,
        destinationTag: w.destinationTag,
        assets: CHAIN_ASSETS[w.chain as keyof typeof CHAIN_ASSETS] ?? [],
        requiredConfirmations: REQUIRED_CONFIRMATIONS[w.chain as keyof typeof REQUIRED_CONFIRMATIONS],
      })),
      balances: balances.map((b) => ({
        asset: b.asset,
        available: b.available,
        locked: b.locked,
        pendingDeposit: b.pendingDeposit,
      })),
    };
  });

  // ─── Refresh Token ──────────────────────────────────────────────────────
  app.post('/api/auth/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = refreshSchema.parse(request.body);

    try {
      const decoded = app.jwt.verify<{ sub: string; type: string }>(body.refreshToken);
      if (decoded.type !== 'refresh') {
        return reply.status(401).send({ error: 'Invalid token type' });
      }

      // Verify token matches stored token (rotation) — constant-time comparison
      const storedToken = await getRefreshToken(decoded.sub);
      const tokensMatch = storedToken !== null
        && storedToken.length === body.refreshToken.length
        && crypto.timingSafeEqual(Buffer.from(storedToken), Buffer.from(body.refreshToken));
      if (!tokensMatch) {
        // Token reuse detected — revoke all tokens for security
        await updateRefreshToken(decoded.sub, null);
        logAuthEvent({ userId: decoded.sub, eventType: 'token_refresh_failed', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: false, metadata: { reason: 'token_reuse' } });
        return reply.status(401).send({ error: 'Token reuse detected. All sessions revoked.' });
      }

      const user = await getUserById(decoded.sub);
      if (!user) {
        return reply.status(401).send({ error: 'User not found' });
      }

      const newRefreshToken = app.jwt.sign(
        { sub: user.id, type: 'refresh' },
        { expiresIn: env.JWT_REFRESH_EXPIRY },
      );

      await updateRefreshToken(user.id, newRefreshToken);

      // Update session tracking (swap old token for new, update activity)
      await revokeSession(body.refreshToken);
      const sessionId = await createSession({ userId: user.id, refreshToken: newRefreshToken, ipAddress: request.ip, userAgent: request.headers['user-agent'] as string | undefined });

      const accessToken = app.jwt.sign(
        { sub: user.id, email: user.email, sid: sessionId },
        { expiresIn: '15m' },
      );

      logAuthEvent({ userId: user.id, eventType: 'token_refresh', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: true });

      return { accessToken, refreshToken: newRefreshToken };
    } catch (err) {
      request.log.warn({ err }, 'Token refresh failed');
      logAuthEvent({ eventType: 'token_refresh_failed', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: false });
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }
  });

  // ─── Get Current User (enriched with wallets + balances) ───────────
  app.get('/api/auth/me', { preHandler: [authGuard] }, async (request, reply) => {
    const user = await getUserById(request.userId);
    if (!user) return reply.status(404).send({ error: 'User not found' });

    // Fetch wallets (deposit addresses)
    const userWallets = await db
      .select({
        chain: wallets.chain,
        address: wallets.address,
        destinationTag: wallets.destinationTag,
      })
      .from(wallets)
      .where(eq(wallets.userId, request.userId));

    // Fetch balances
    const balances = await getUserBalances(request.userId);

    // Check PIN/biometric status
    const pinSet = await hasPin(request.userId);

    return {
      ...user,
      hasPin: pinSet,
      wallets: userWallets,
      balances: balances.map((b) => ({
        asset: b.asset,
        available: b.available,
        locked: b.locked,
        pendingDeposit: b.pendingDeposit,
      })),
    };
  });

  // ─── PIN ────────────────────────────────────────────────────────────────
  app.post('/api/auth/pin', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = pinSchema.parse(request.body);
    await setPin(request.userId, body.pin);
    logAuthEvent({ userId: request.userId, eventType: 'pin_set', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    return { success: true };
  });

  app.post('/api/auth/pin/verify', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = pinSchema.parse(request.body);
    const result = await verifyPin(request.userId, body.pin);

    if (result.locked) {
      logAuthEvent({ userId: request.userId, eventType: 'pin_locked', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: false });
      return reply.status(423).send({
        error: 'PIN locked due to too many failed attempts. Try again later.',
        locked: true,
        lockoutSeconds: result.lockoutSeconds,
        remainingAttempts: 0,
      });
    }

    if (!result.valid) {
      logAuthEvent({ userId: request.userId, eventType: 'pin_verify_failed', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: false, metadata: { remainingAttempts: result.remainingAttempts } });
      return reply.status(401).send({
        error: 'Invalid PIN',
        remainingAttempts: result.remainingAttempts,
      });
    }

    logAuthEvent({ userId: request.userId, eventType: 'pin_verify', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    return { success: true };
  });

  app.get('/api/auth/pin/status', { preHandler: [authGuard] }, async (request) => {
    const pinSet = await hasPin(request.userId);
    return { hasPin: pinSet };
  });

  // ─── Biometric ─────────────────────────────────────────────────────────
  app.post('/api/auth/biometric/register', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    // Must have PIN set before enabling biometric
    const pinSet = await hasPin(request.userId);
    if (!pinSet) {
      return reply.status(400).send({ error: 'Set a PIN before enabling biometrics' });
    }
    const token = await registerBiometric(request.userId);
    logAuthEvent({ userId: request.userId, eventType: 'biometric_register', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    return { biometricToken: token };
  });

  app.post('/api/auth/biometric/verify', {
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = biometricVerifySchema.parse(request.body);
    const valid = await verifyBiometric(request.userId, body.token);
    if (!valid) {
      logAuthEvent({ userId: request.userId, eventType: 'biometric_verify_failed', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: false });
      return reply.status(401).send({ error: 'Biometric verification failed' });
    }
    logAuthEvent({ userId: request.userId, eventType: 'biometric_verify', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    return { success: true };
  });

  app.post('/api/auth/biometric/revoke', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } }, preHandler: [authGuard] }, async (request) => {
    await revokeBiometric(request.userId);
    logAuthEvent({ userId: request.userId, eventType: 'biometric_revoke', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    return { success: true };
  });

  // ─── Forgot Password ──────────────────────────────────────────────────
  app.post('/api/auth/forgot-password', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = forgotPasswordSchema.parse(request.body);

    const rawToken = await createPasswordResetToken(body.email);

    // In production, the reset token would be emailed to the user
    if (rawToken) {
      logger.info({ email: body.email }, 'Password reset requested');
    }

    logAuthEvent({ eventType: 'password_reset_request', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: true, metadata: { email: body.email } });

    // Always return success — don't reveal whether email exists (constant-time response)
    return {
      success: true,
      message: 'If an account exists with this email, a password reset link has been sent.',
    };
  });

  // ─── Reset Password ─────────────────────────────────────────────────────
  app.post('/api/auth/reset-password', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = resetPasswordSchema.parse(request.body);

    const result = await resetPassword(body.token, body.newPassword);

    if (!result.success) {
      logAuthEvent({ eventType: 'password_reset_complete', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: false });
      return reply.status(400).send({ error: 'Invalid or expired reset token' });
    }

    // Invalidate all sessions after password reset — force re-login everywhere
    if (result.userId) {
      await updateRefreshToken(result.userId, null);
      const { revokeAllUserSessions } = await import('../services/session.js');
      await revokeAllUserSessions(result.userId);
    }

    logAuthEvent({ userId: result.userId, eventType: 'password_reset_complete', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: true });
    return { success: true, message: 'Password has been reset. Please log in with your new password.' };
  });

  // ─── Change Password ──────────────────────────────────────────────────
  app.post('/api/auth/change-password', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = changePasswordSchema.parse(request.body);
    const result = await changePassword(request.userId, body.currentPassword, body.newPassword);
    if (!result.success) return reply.status(400).send({ error: result.error });

    // Revoke all OTHER sessions — keep current session active
    const revokedCount = request.sessionId
      ? await revokeOtherUserSessions(request.userId, request.sessionId)
      : 0;

    logAuthEvent({ userId: request.userId, eventType: 'password_change', ipAddress: request.ip, userAgent: request.headers['user-agent'], success: true, metadata: { revokedSessions: revokedCount } });
    const message = revokedCount > 0
      ? `Password changed. ${revokedCount} other session${revokedCount === 1 ? ' has' : 's have'} been signed out.`
      : 'Password changed successfully.';
    return { success: true, message };
  });

  // ─── Logout ─────────────────────────────────────────────────────────────
  app.post('/api/auth/logout', { preHandler: [authGuard] }, async (request) => {
    await updateRefreshToken(request.userId, null);
    // Revoke all sessions for this user (they only have one refresh token stored)
    const { revokeAllUserSessions } = await import('../services/session.js');
    await revokeAllUserSessions(request.userId);
    logAuthEvent({ userId: request.userId, eventType: 'logout', ipAddress: request.ip, userAgent: request.headers['user-agent'] });
    return { success: true };
  });
}
