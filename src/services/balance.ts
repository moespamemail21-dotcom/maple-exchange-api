import { eq, and, sql, desc } from 'drizzle-orm';
import { db, type DB } from '../db/index.js';
import { balances, balanceLedger } from '../db/schema.js';
import { logger } from '../config/logger.js';
import { redis, KEYS } from './redis.js';
import Decimal from 'decimal.js';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';

// Configure decimal.js for financial precision
Decimal.set({ precision: 36, rounding: Decimal.ROUND_HALF_EVEN });

// ─── Types ───────────────────────────────────────────────────────────────────

export type BalanceField = 'available' | 'locked' | 'pendingDeposit';

export interface BalanceMutation {
  userId: string;
  asset: string;
  field: BalanceField;
  /** Positive = credit, Negative = debit */
  amount: string;
  entryType: string;
  idempotencyKey: string;
  /** Exactly one of these should be set */
  depositId?: string;
  withdrawalId?: string;
  tradeId?: string;
  note?: string;
  /** Allow the resulting balance to go negative (platform market-maker only) */
  allowNegative?: boolean;
}

const FIELD_COLUMN_MAP = {
  available: balances.available,
  locked: balances.locked,
  pendingDeposit: balances.pendingDeposit,
} as const;

const FIELD_SQL_NAME = {
  available: 'available',
  locked: 'locked',
  pendingDeposit: 'pending_deposit',
} as const;

// ─── Core Balance Mutation ───────────────────────────────────────────────────
//
// EVERY balance change in the entire system MUST flow through this function.
// It provides:
//   1. Row-level locking (SELECT FOR UPDATE) to prevent race conditions
//   2. Arbitrary-precision arithmetic via decimal.js (never JS Number for money)
//   3. Negative balance rejection
//   4. Idempotency via unique key on balance_ledger
//   5. Atomic audit trail entry
//

/**
 * Mutate a user's balance within an existing database transaction.
 *
 * @param tx - A Drizzle ORM transaction (from db.transaction())
 * @param mutation - The mutation to apply
 * @returns The new balance value after mutation, or null if idempotency key was already processed
 * @throws Error if balance would go negative
 */
export async function mutateBalance(
  tx: any,
  mutation: BalanceMutation,
): Promise<string | null> {
  const { userId, asset, field, amount, entryType, idempotencyKey } = mutation;

  // 1. Lock the balance row FIRST — this serializes concurrent mutations for
  //    the same user+asset, making the idempotency check below race-free.
  const lockResult = await tx.execute(
    sql`SELECT id, ${sql.raw(FIELD_SQL_NAME[field])} as current_value
        FROM balances
        WHERE user_id = ${userId} AND asset = ${asset}
        FOR UPDATE`
  ) as any;

  const rows = Array.isArray(lockResult) ? lockResult : lockResult?.rows ?? [];
  if (rows.length === 0) {
    throw new Error(`No balance row found for user=${userId} asset=${asset}`);
  }

  // 2. Check idempotency — safe now because we hold the row lock. Any concurrent
  //    transaction with the same key blocks on step 1 until we commit.
  if (idempotencyKey) {
    const existing = await tx.execute(
      sql`SELECT id FROM balance_ledger WHERE idempotency_key = ${idempotencyKey}`
    ) as any;
    const existingRows = Array.isArray(existing) ? existing : existing?.rows ?? [];
    if (existingRows.length > 0) {
      return null; // Already processed — skip
    }
  }

  const currentValue = new Decimal(String(rows[0].current_value));
  const mutationAmount = new Decimal(amount);
  const newValue = currentValue.plus(mutationAmount);

  // 3. Reject if result would be negative (unless explicitly allowed for platform user)
  if (newValue.isNegative() && !mutation.allowNegative) {
    throw new Error(
      `Insufficient ${field} balance for ${asset}: current=${currentValue.toFixed()}, ` +
      `mutation=${mutationAmount.toFixed()}, would result in ${newValue.toFixed()}`
    );
  }

  // 4. Update the balance
  const newValueStr = newValue.toFixed(18);
  await tx
    .update(balances)
    .set({
      [field]: newValueStr,
      updatedAt: new Date(),
    })
    .where(and(eq(balances.userId, userId), eq(balances.asset, asset)));

  // 5. Insert ledger entry (idempotency already checked above, so this should succeed)
  await tx.insert(balanceLedger).values({
    userId,
    asset,
    entryType,
    amount,
    balanceField: field,
    balanceAfter: newValueStr,
    depositId: mutation.depositId ?? null,
    withdrawalId: mutation.withdrawalId ?? null,
    tradeId: mutation.tradeId ?? null,
    idempotencyKey,
    note: mutation.note ?? null,
  });

  logger.info({ userId, asset, field, amount, entryType }, 'balance mutation');

  // Queue a balance update event (fire-and-forget, outside tx commit).
  // If the transaction rolls back the user will re-fetch correct state on next poll.
  redis.publish(KEYS.balanceChannel, JSON.stringify({
    type: 'balance_updated',
    userId,
    asset,
    field,
    entryType,
  })).catch(() => { /* non-critical */ });

  return newValueStr;
}

// ─── Convenience: Run a mutation in its own transaction ──────────────────────

export async function mutateBalanceAtomic(mutation: BalanceMutation): Promise<string | null> {
  return db.transaction(async (tx) => {
    return mutateBalance(tx, mutation);
  });
}

// ─── Query Helpers ───────────────────────────────────────────────────────────

export const SUPPORTED_ASSETS = ['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK'] as const;
export type SupportedAsset = (typeof SUPPORTED_ASSETS)[number];

/**
 * Get all balances for a user. Returns one row per asset.
 */
export async function getUserBalances(userId: string) {
  return db
    .select({
      asset: balances.asset,
      available: balances.available,
      locked: balances.locked,
      pendingDeposit: balances.pendingDeposit,
    })
    .from(balances)
    .where(eq(balances.userId, userId));
}

/**
 * Get a single asset balance for a user.
 * Optionally accepts a transaction for use inside db.transaction() blocks.
 */
export async function getUserBalance(userId: string, asset: string, txn?: any) {
  const queryDb = txn ?? db;
  const [row] = await queryDb
    .select({
      asset: balances.asset,
      available: balances.available,
      locked: balances.locked,
      pendingDeposit: balances.pendingDeposit,
    })
    .from(balances)
    .where(and(eq(balances.userId, userId), eq(balances.asset, asset)));

  return row ?? null;
}

/**
 * Get paginated ledger entries for a user (optionally filtered by asset).
 */
export async function getLedgerEntries(
  userId: string,
  options: { asset?: string; limit?: number; offset?: number } = {},
) {
  const { asset, limit = 50, offset = 0 } = options;

  const conditions = [eq(balanceLedger.userId, userId)];
  if (asset) conditions.push(eq(balanceLedger.asset, asset));

  return db
    .select()
    .from(balanceLedger)
    .where(and(...conditions))
    .orderBy(desc(balanceLedger.createdAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Initialize balance rows for a new user (called within registration transaction).
 */
export async function initializeUserBalances(tx: any, userId: string) {
  const rows = SUPPORTED_ASSETS.map((asset) => ({
    userId,
    asset,
    available: '0',
    locked: '0',
    pendingDeposit: '0',
  }));

  await tx.insert(balances).values(rows);
}
