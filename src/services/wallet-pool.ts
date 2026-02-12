import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { wallets } from '../db/schema.js';
import { CHAINS, type Chain, deriveWallet, allocateIndex } from './wallet.js';

// ─── Claim wallets from pool for a new user ─────────────────────────────────
// Called during registration. For each chain, atomically claims one unclaimed
// wallet from the pool. Falls back to on-demand derivation if pool is empty.

export async function claimPoolWallets(tx: any, userId: string): Promise<void> {
  for (const chain of CHAINS) {
    const claimed = await claimOneWallet(tx, userId, chain);
    if (!claimed) {
      console.warn(`[WALLET POOL] Pool exhausted for chain=${chain} — falling back to on-demand generation`);
      await generateOnDemandWallet(tx, userId, chain);
    }
  }
}

// ─── Atomic single-wallet claim ─────────────────────────────────────────────
// Uses SELECT ... FOR UPDATE SKIP LOCKED so concurrent registrations never
// fight over the same row — each gets a different wallet instantly.

async function claimOneWallet(tx: any, userId: string, chain: Chain): Promise<boolean> {
  const result = await tx.execute(
    sql`UPDATE wallets
        SET user_id = ${userId},
            assigned_at = NOW()
        WHERE id = (
          SELECT id FROM wallets
          WHERE user_id IS NULL AND chain = ${chain}
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`
  ) as any;

  const rows = Array.isArray(result) ? result : result?.rows ?? [];
  return rows.length > 0;
}

// ─── On-demand fallback (same logic as the original generateUserWallets) ────

async function generateOnDemandWallet(tx: any, userId: string, chain: Chain): Promise<void> {
  const index = await allocateIndex(tx, chain);
  const derived = deriveWallet(chain, index);

  await tx.insert(wallets).values({
    userId,
    chain,
    address: derived.address,
    derivationPath: derived.derivationPath,
    destinationTag: derived.destinationTag ?? null,
    encryptedPrivateKey: derived.encryptedPrivateKey,
    addressIndex: index,
    assignedAt: new Date(),
  });
}

// ─── Pool Status (for admin monitoring) ─────────────────────────────────────

export async function getPoolStatus(): Promise<Array<{ chain: string; available: number }>> {
  const result = await db.execute(
    sql`SELECT chain, COUNT(*)::int AS available
        FROM wallets
        WHERE user_id IS NULL
        GROUP BY chain
        ORDER BY chain`
  ) as any;

  const rows = Array.isArray(result) ? result : result?.rows ?? [];

  // Ensure all chains are represented (even if count is 0)
  const statusMap = new Map<string, number>();
  for (const chain of CHAINS) statusMap.set(chain, 0);
  for (const r of rows) statusMap.set(r.chain, Number(r.available));

  return Array.from(statusMap.entries()).map(([chain, available]) => ({
    chain,
    available,
  }));
}
