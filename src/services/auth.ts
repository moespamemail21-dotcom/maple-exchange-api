import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq, and, gt } from 'drizzle-orm';
import { claimPoolWallets } from './wallet-pool.js';
import { initializeUserBalances } from './balance.js';

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

export async function verifyCredentials(
  email: string,
  password: string,
): Promise<{ id: string; email: string } | null> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()));

  if (!user) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

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

export async function verifyPin(userId: string, pin: string): Promise<boolean> {
  const [user] = await db
    .select({ pinHash: users.pinHash })
    .from(users)
    .where(eq(users.id, userId));
  if (!user?.pinHash) return false;
  return bcrypt.compare(pin, user.pinHash);
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

  const resetToken = crypto.randomUUID();
  const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await db
    .update(users)
    .set({ resetToken, resetTokenExpiry, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return resetToken;
}

export async function resetPassword(token: string, newPassword: string): Promise<boolean> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.resetToken, token),
        gt(users.resetTokenExpiry, new Date()),
      ),
    );

  if (!user) return false;

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);

  await db
    .update(users)
    .set({
      passwordHash,
      resetToken: null,
      resetTokenExpiry: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  return true;
}
