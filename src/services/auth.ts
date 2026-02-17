import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq, and, gt } from 'drizzle-orm';
import { claimPoolWallets } from './wallet-pool.js';
import { initializeUserBalances } from './balance.js';
import { redis } from './redis.js';

const SALT_ROUNDS = 12;
const PIN_SALT_ROUNDS = 10;

/**
 * Create a new user with wallets and balance rows — ALL in one atomic transaction.
 * If any step fails (user insert, wallet generation, balance init), everything rolls back.
 * No orphaned users without wallets. No orphaned wallets without balances.
 */
export async function createUser(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ id: string; email: string }> {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  return db.transaction(async (tx) => {
    // 1. Insert the user
    const [user] = await tx
      .insert(users)
      .values({
        email: email.toLowerCase().trim(),
        passwordHash,
        displayName: displayName ?? email.split('@')[0],
      })
      .returning({ id: users.id, email: users.email });

    // 2. Claim one wallet per chain from pre-generated pool (5 wallets: BTC, ETH, LTC, XRP, SOL)
    await claimPoolWallets(tx, user.id);

    // 3. Initialize balance rows for all 6 assets (ETH wallet also serves LINK)
    await initializeUserBalances(tx, user.id);

    return user;
  });
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<{ id: string; email: string } | null | 'locked'> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()));

  if (!user) return null;

  // Check if account is locked
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    return 'locked';
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const newCount = (user.failedLoginAttempts ?? 0) + 1;
    const updates: Record<string, unknown> = { failedLoginAttempts: newCount };
    if (newCount >= MAX_LOGIN_ATTEMPTS) {
      updates.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
    }
    await db.update(users).set(updates).where(eq(users.id, user.id));
    return null;
  }

  // Reset failed attempts on successful login
  if (user.failedLoginAttempts > 0) {
    await db.update(users).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
  }

  return { id: user.id, email: user.email };
}

export async function getUserById(userId: string) {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      phone: users.phone,
      kycStatus: users.kycStatus,
      kycVideoStatus: users.kycVideoStatus,
      tradeCount: users.tradeCount,
      completionRate: users.completionRate,
      maxTradeLimit: users.maxTradeLimit,
      interacEmail: users.interacEmail,
      autodepositVerified: users.autodepositVerified,
      locale: users.locale,
      twoFactorEnabled: users.twoFactorEnabled,
      fullLegalName: users.fullLegalName,
      dateOfBirth: users.dateOfBirth,
      city: users.city,
      province: users.province,
      postalCode: users.postalCode,
      occupation: users.occupation,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId));

  return user ?? null;
}

export async function updateRefreshToken(userId: string, token: string | null) {
  await db
    .update(users)
    .set({ refreshToken: token, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function getRefreshToken(userId: string): Promise<string | null> {
  const [user] = await db
    .select({ refreshToken: users.refreshToken })
    .from(users)
    .where(eq(users.id, userId));
  return user?.refreshToken ?? null;
}

// ─── PIN ────────────────────────────────────────────────────────────────────

export async function setPin(userId: string, pin: string): Promise<void> {
  const pinHash = await bcrypt.hash(pin, PIN_SALT_ROUNDS);
  await db
    .update(users)
    .set({ pinHash, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_SECONDS = 15 * 60; // 15 minutes

export interface PinVerifyResult {
  valid: boolean;
  locked?: boolean;
  remainingAttempts?: number;
  lockoutSeconds?: number;
}

export async function verifyPin(userId: string, pin: string): Promise<PinVerifyResult> {
  const lockKey = `pin:lockout:${userId}`;
  const attemptsKey = `pin:attempts:${userId}`;

  // Check if PIN is locked
  const lockTTL = await redis.ttl(lockKey);
  if (lockTTL > 0) {
    return { valid: false, locked: true, lockoutSeconds: lockTTL, remainingAttempts: 0 };
  }

  const [user] = await db
    .select({ pinHash: users.pinHash })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.pinHash) return { valid: false };

  const match = await bcrypt.compare(pin, user.pinHash);

  if (match) {
    // Success — clear attempt counter
    await redis.del(attemptsKey, lockKey);
    return { valid: true };
  }

  // Failure — increment attempts
  const attempts = await redis.incr(attemptsKey);
  // Set TTL on first failure so stale counters auto-expire
  if (attempts === 1) {
    await redis.expire(attemptsKey, PIN_LOCKOUT_SECONDS);
  }

  const remaining = Math.max(0, MAX_PIN_ATTEMPTS - attempts);

  if (attempts >= MAX_PIN_ATTEMPTS) {
    // Lock the PIN
    await redis.set(lockKey, '1', 'EX', PIN_LOCKOUT_SECONDS);
    await redis.del(attemptsKey);
    return { valid: false, locked: true, remainingAttempts: 0, lockoutSeconds: PIN_LOCKOUT_SECONDS };
  }

  return { valid: false, remainingAttempts: remaining };
}

export async function hasPin(userId: string): Promise<boolean> {
  const [user] = await db
    .select({ pinHash: users.pinHash })
    .from(users)
    .where(eq(users.id, userId));
  return !!user?.pinHash;
}

// ─── Biometric ──────────────────────────────────────────────────────────────

export async function registerBiometric(userId: string): Promise<string> {
  // Generate a 64-byte random token
  const token = crypto.randomBytes(64).toString('base64url');
  const tokenHash = await bcrypt.hash(token, PIN_SALT_ROUNDS);
  await db
    .update(users)
    .set({ biometricTokenHash: tokenHash, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return token; // Client stores this in Keychain protected by biometry
}

export async function verifyBiometric(userId: string, token: string): Promise<boolean> {
  const [user] = await db
    .select({ biometricTokenHash: users.biometricTokenHash })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.biometricTokenHash) return false;
  return bcrypt.compare(token, user.biometricTokenHash);
}

export async function revokeBiometric(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ biometricTokenHash: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

// ─── Password Reset ─────────────────────────────────────────────────────────

export async function createPasswordResetToken(email: string): Promise<string | null> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()));

  if (!user) return null;

  // Generate a 32-byte random hex token
  const rawToken = crypto.randomBytes(32).toString('hex');
  // Hash it with SHA-256 before storing (the raw token would go in the email)
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
  const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db
    .update(users)
    .set({ resetToken: hashedToken, resetTokenExpiry, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return rawToken;
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return { success: false, error: 'User not found' };

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) return { success: false, error: 'Current password is incorrect' };

  const now = new Date();
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await db.update(users).set({ passwordHash: hash, passwordChangedAt: now, updatedAt: now }).where(eq(users.id, userId));
  return { success: true };
}

export async function resetPassword(token: string, newPassword: string): Promise<{ success: boolean; userId?: string }> {
  // Hash the provided token with SHA-256 to match stored hash
  const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.resetToken, hashedToken),
        gt(users.resetTokenExpiry, new Date()),
      ),
    );

  if (!user) return { success: false };

  const now = new Date();
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await db
    .update(users)
    .set({
      passwordHash,
      passwordChangedAt: now,
      resetToken: null,
      resetTokenExpiry: null,
      updatedAt: now,
    })
    .where(eq(users.id, user.id));

  return { success: true, userId: user.id };
}
