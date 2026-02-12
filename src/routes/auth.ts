import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUser, verifyCredentials, getUserById, updateRefreshToken, getRefreshToken, setPin, verifyPin, hasPin, registerBiometric, verifyBiometric, revokeBiometric, createPasswordResetToken, resetPassword } from '../services/auth.js';
import { authGuard } from '../middleware/auth.js';
import { getUserBalances, type SupportedAsset, SUPPORTED_ASSETS } from '../services/balance.js';
import { CHAIN_ASSETS, REQUIRED_CONFIRMATIONS, MIN_DEPOSIT } from '../services/wallet.js';
import { db } from '../db/index.js';
import { wallets } from '../db/schema.js';
import { eq } from 'drizzle-orm';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(100).optional(),
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
  newPassword: z.string().min(8).max(128),
});

export async function authRoutes(app: FastifyInstance) {
  // ─── Register ───────────────────────────────────────────────────────────
  app.post('/api/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = registerSchema.parse(request.body);

    try {
      const user = await createUser(body.email, body.password, body.displayName);

      const accessToken = app.jwt.sign(
        { sub: user.id, email: user.email },
        { expiresIn: '15m' },
      );
      const refreshToken = app.jwt.sign(
        { sub: user.id, type: 'refresh' },
        { expiresIn: '90d' },
      );

      await updateRefreshToken(user.id, refreshToken);

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
        return reply.status(409).send({ error: 'Email already registered' });
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

    if (!user) {
      return reply.status(401).send({ error: 'Invalid email or password' });
    }

    const accessToken = app.jwt.sign(
      { sub: user.id, email: user.email },
      { expiresIn: '15m' },
    );
    const refreshToken = app.jwt.sign(
      { sub: user.id, type: 'refresh' },
      { expiresIn: '90d' },
    );

    await updateRefreshToken(user.id, refreshToken);

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
  app.post('/api/auth/refresh', async (request, reply) => {
    const body = refreshSchema.parse(request.body);

    try {
      const decoded = app.jwt.verify<{ sub: string; type: string }>(body.refreshToken);
      if (decoded.type !== 'refresh') {
        return reply.status(401).send({ error: 'Invalid token type' });
      }

      // Verify token matches stored token (rotation)
      const storedToken = await getRefreshToken(decoded.sub);
      if (storedToken !== body.refreshToken) {
        // Token reuse detected — revoke all tokens for security
        await updateRefreshToken(decoded.sub, null);
        return reply.status(401).send({ error: 'Token reuse detected. All sessions revoked.' });
      }

      const user = await getUserById(decoded.sub);
      if (!user) {
        return reply.status(401).send({ error: 'User not found' });
      }

      const accessToken = app.jwt.sign(
        { sub: user.id, email: user.email },
        { expiresIn: '15m' },
      );
      const newRefreshToken = app.jwt.sign(
        { sub: user.id, type: 'refresh' },
        { expiresIn: '90d' },
      );

      await updateRefreshToken(user.id, newRefreshToken);

      return { accessToken, refreshToken: newRefreshToken };
    } catch {
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
  app.post('/api/auth/pin', { preHandler: [authGuard] }, async (request, reply) => {
    const body = pinSchema.parse(request.body);
    await setPin(request.userId, body.pin);
    return { success: true };
  });

  app.post('/api/auth/pin/verify', { preHandler: [authGuard] }, async (request, reply) => {
    const body = pinSchema.parse(request.body);
    const valid = await verifyPin(request.userId, body.pin);
    if (!valid) {
      return reply.status(401).send({ error: 'Invalid PIN' });
    }
    return { success: true };
  });

  app.get('/api/auth/pin/status', { preHandler: [authGuard] }, async (request) => {
    const pinSet = await hasPin(request.userId);
    return { hasPin: pinSet };
  });

  // ─── Biometric ─────────────────────────────────────────────────────────
  app.post('/api/auth/biometric/register', { preHandler: [authGuard] }, async (request, reply) => {
    // Must have PIN set before enabling biometric
    const pinSet = await hasPin(request.userId);
    if (!pinSet) {
      return reply.status(400).send({ error: 'Set a PIN before enabling biometrics' });
    }
    const token = await registerBiometric(request.userId);
    return { biometricToken: token };
  });

  app.post('/api/auth/biometric/verify', { preHandler: [authGuard] }, async (request, reply) => {
    const body = biometricVerifySchema.parse(request.body);
    const valid = await verifyBiometric(request.userId, body.token);
    if (!valid) {
      return reply.status(401).send({ error: 'Biometric verification failed' });
    }
    return { success: true };
  });

  app.post('/api/auth/biometric/revoke', { preHandler: [authGuard] }, async (request) => {
    await revokeBiometric(request.userId);
    return { success: true };
  });

  // ─── Forgot Password ──────────────────────────────────────────────────
  app.post('/api/auth/forgot-password', {
    config: { rateLimit: { max: 3, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = forgotPasswordSchema.parse(request.body);

    const resetToken = await createPasswordResetToken(body.email);

    if (resetToken) {
      app.log.info('Password reset token generated');
    }

    // Always return success — don't reveal whether email exists
    return {
      success: true,
      message: 'If an account with that email exists, a reset link has been sent.',
    };
  });

  // ─── Reset Password ─────────────────────────────────────────────────────
  app.post('/api/auth/reset-password', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const body = resetPasswordSchema.parse(request.body);

    const success = await resetPassword(body.token, body.newPassword);

    if (!success) {
      return reply.status(400).send({ error: 'Invalid or expired reset token' });
    }

    return { success: true };
  });

  // ─── Logout ─────────────────────────────────────────────────────────────
  app.post('/api/auth/logout', { preHandler: [authGuard] }, async (request) => {
    await updateRefreshToken(request.userId, null);
    return { success: true };
  });
}
