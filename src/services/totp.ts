import * as OTPAuth from 'otpauth';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';

/**
 * Generate a new TOTP secret for a user.
 * Returns the raw secret (base32) and the otpauth:// URI for QR code generation.
 */
export function generateTotpSecret(email: string): { secret: string; uri: string } {
  const totp = new OTPAuth.TOTP({
    issuer: 'Maple Exchange',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });

  return {
    secret: totp.secret.base32,
    uri: totp.toString(),
  };
}

/**
 * Verify a 6-digit TOTP token against a base32 secret.
 * Allows a window of 1 (previous/next 30s interval).
 */
export function verifyTotp(secret: string, token: string): boolean {
  const totp = new OTPAuth.TOTP({
    issuer: 'Maple Exchange',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });

  // validate returns the time step difference (null if invalid)
  const delta = totp.validate({ token, window: 1 });
  return delta !== null;
}

const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LENGTH = 8;
const BACKUP_CODE_SALT_ROUNDS = 10;

/**
 * Generate cryptographically random alphanumeric backup codes.
 */
function generateBackupCodes(count: number, length: number): string[] {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/O/0/1 to avoid confusion
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const bytes = crypto.randomBytes(length);
    let code = '';
    for (let j = 0; j < length; j++) {
      code += chars[bytes[j] % chars.length];
    }
    codes.push(code);
  }
  return codes;
}

/**
 * Enable TOTP for a user. Verifies the provided token first,
 * then persists the secret and flips the enabled flag.
 * Also generates single-use backup codes and returns them in plaintext (one time only).
 */
export async function enableTotp(
  userId: string,
  secret: string,
  token: string,
): Promise<{ success: boolean; error?: string; backupCodes?: string[] }> {
  // Prevent silent overwrite if 2FA is already enabled
  const [currentUser] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId));
  if (currentUser?.twoFactorEnabled) {
    return { success: false, error: '2FA is already enabled. Disable it first before re-enabling.' };
  }

  const valid = verifyTotp(secret, token);
  if (!valid) {
    return { success: false, error: 'Invalid verification code' };
  }

  // Generate 8 random backup codes and hash each with bcrypt
  const plaintextCodes = generateBackupCodes(BACKUP_CODE_COUNT, BACKUP_CODE_LENGTH);
  const hashedCodes = await Promise.all(
    plaintextCodes.map((code) => bcrypt.hash(code, BACKUP_CODE_SALT_ROUNDS)),
  );

  await db
    .update(users)
    .set({
      twoFactorSecret: secret,
      twoFactorEnabled: true,
      twoFactorBackupCodes: JSON.stringify(hashedCodes),
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  return { success: true, backupCodes: plaintextCodes };
}

/**
 * Verify a backup code against stored hashed codes.
 * If valid, removes the used code from the array (single-use).
 * Returns true if the code matched.
 */
export async function verifyBackupCode(userId: string, code: string): Promise<boolean> {
  // Use a transaction with FOR UPDATE to prevent concurrent backup code usage
  return db.transaction(async (tx) => {
    const result = await tx.execute(
      sql`SELECT two_factor_backup_codes FROM users WHERE id = ${userId} FOR UPDATE`,
    ) as any;
    const rows = Array.isArray(result) ? result : result?.rows ?? [];
    const backupCodesRaw = rows[0]?.two_factor_backup_codes;

    if (!backupCodesRaw) return false;

    let hashedCodes: string[];
    try {
      hashedCodes = typeof backupCodesRaw === 'string' ? JSON.parse(backupCodesRaw) : backupCodesRaw;
    } catch {
      return false;
    }

    if (!Array.isArray(hashedCodes) || hashedCodes.length === 0) return false;

    // Compare against each hashed code
    const upperCode = code.toUpperCase();
    for (let i = 0; i < hashedCodes.length; i++) {
      const match = await bcrypt.compare(upperCode, hashedCodes[i]);
      if (match) {
        // Remove the used code and update DB (inside the same transaction)
        hashedCodes.splice(i, 1);
        await tx
          .update(users)
          .set({
            twoFactorBackupCodes: JSON.stringify(hashedCodes),
            updatedAt: new Date(),
          })
          .where(eq(users.id, userId));
        return true;
      }
    }

    return false;
  });
}

/**
 * Disable TOTP for a user. Verifies the provided token against
 * the stored secret first, then clears the secret and flag.
 */
export async function disableTotp(
  userId: string,
  token: string,
): Promise<{ success: boolean; error?: string }> {
  const [user] = await db
    .select({ twoFactorSecret: users.twoFactorSecret })
    .from(users)
    .where(eq(users.id, userId));

  if (!user?.twoFactorSecret) {
    return { success: false, error: '2FA is not enabled' };
  }

  const valid = verifyTotp(user.twoFactorSecret, token);
  if (!valid) {
    return { success: false, error: 'Invalid verification code' };
  }

  await db
    .update(users)
    .set({
      twoFactorSecret: null,
      twoFactorEnabled: false,
      twoFactorBackupCodes: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  return { success: true };
}

/**
 * Check whether a user has TOTP enabled.
 */
export async function isTotpRequired(userId: string): Promise<boolean> {
  const [user] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, userId));

  return user?.twoFactorEnabled ?? false;
}
