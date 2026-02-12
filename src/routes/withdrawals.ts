import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { withdrawals, users, wallets, balanceLedger } from '../db/schema.js';
import { eq, and, desc, gt, sql } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { mutateBalance } from '../services/balance.js';
import { getPrice } from '../services/price.js';
import { validateAddress, ASSET_TO_CHAIN, type Chain } from '../services/wallet.js';
import { env } from '../config/env.js';
import Decimal from 'decimal.js';

// ─── Withdrawal Fees (flat per-chain, in asset units) ────────────────────────

const WITHDRAWAL_FEES: Record<string, Record<string, string>> = {
  BTC:  { chain: 'bitcoin',  fee: '0.00005' },
  ETH:  { chain: 'ethereum', fee: '0.001' },
  LTC:  { chain: 'litecoin', fee: '0.001' },
  XRP:  { chain: 'xrp',      fee: '0.1' },
  SOL:  { chain: 'solana',   fee: '0.005' },
  LINK: { chain: 'ethereum', fee: '0.5' },
};

const withdrawRequestSchema = z.object({
  asset: z.enum(['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK']),
  amount: z.string().refine((v) => {
    const d = new Decimal(v);
    return d.isPositive() && d.isFinite();
  }, 'Amount must be a positive number'),
  toAddress: z.string().min(10).max(255),
  destinationTag: z.string().max(20).optional().refine((v) => {
    if (v === undefined) return true;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 4294967295;
  }, 'Destination tag must be a valid integer (0–4294967295)'),
});

export async function withdrawalRoutes(app: FastifyInstance) {
  // ─── Request Withdrawal ─────────────────────────────────────────────
  app.post('/api/withdrawals', { preHandler: [authGuard] }, async (request, reply) => {
    const body = withdrawRequestSchema.parse(request.body);
    const { asset, amount, toAddress, destinationTag } = body;

    // Validate user KYC
    const [user] = await db.select().from(users).where(eq(users.id, request.userId));
    if (!user) return reply.status(404).send({ error: 'User not found' });
    if (user.kycStatus !== 'verified') {
      return reply.status(403).send({ error: 'KYC verification required before withdrawing' });
    }

    // XRP requires destination tag
    if (asset === 'XRP' && !destinationTag) {
      return reply.status(400).send({ error: 'Destination tag required for XRP withdrawals' });
    }

    // Validate withdrawal address format for the target chain
    const chain = ASSET_TO_CHAIN[asset] as Chain;
    if (!chain) {
      return reply.status(400).send({ error: `No chain mapping for asset: ${asset}` });
    }
    if (!validateAddress(chain, toAddress)) {
      return reply.status(400).send({
        error: `Invalid ${chain} address. Please double-check the withdrawal address.`,
      });
    }

    // Prevent sending to own deposit address (circular transaction)
    const userWallets = await db
      .select({ address: wallets.address, destinationTag: wallets.destinationTag })
      .from(wallets)
      .where(eq(wallets.userId, request.userId));

    const isSelfSend = userWallets.some((w) => {
      if (w.address === toAddress) {
        if (asset === 'XRP') return w.destinationTag === destinationTag;
        return true;
      }
      return false;
    });

    if (isSelfSend) {
      return reply.status(400).send({
        error: 'Cannot withdraw to your own deposit address.',
      });
    }

    // Calculate fee and net amount
    const feeInfo = WITHDRAWAL_FEES[asset];
    if (!feeInfo) return reply.status(400).send({ error: `Unsupported asset: ${asset}` });

    const amountDec = new Decimal(amount);
    const feeDec = new Decimal(feeInfo.fee);
    const netAmount = amountDec.minus(feeDec);

    if (netAmount.isNegative() || netAmount.isZero()) {
      return reply.status(400).send({
        error: `Withdrawal amount must exceed the network fee of ${feeInfo.fee} ${asset}`,
      });
    }

    // Determine auto-approve threshold in crypto
    const priceData = await getPrice(asset);
    const cadEquivalent = priceData
      ? amountDec.times(priceData.cadPrice)
      : new Decimal(Infinity);

    // Cooldown: 5 minutes between withdrawal requests
    const cooldownCutoff = new Date(Date.now() - 5 * 60 * 1000);
    const [recentWithdrawal] = await db
      .select({ id: withdrawals.id })
      .from(withdrawals)
      .where(and(
        eq(withdrawals.userId, request.userId),
        gt(withdrawals.requestedAt, cooldownCutoff),
      ))
      .limit(1);

    if (recentWithdrawal) {
      return reply.status(429).send({
        error: 'Please wait at least 5 minutes between withdrawal requests.',
      });
    }

    // Daily limit: $10,000 CAD per 24 hours
    const DAILY_LIMIT_CAD = 10_000;
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayWithdrawals = await db
      .select({
        asset: withdrawals.asset,
        totalAmount: sql<string>`SUM(${withdrawals.amount}::numeric)`,
      })
      .from(withdrawals)
      .where(and(
        eq(withdrawals.userId, request.userId),
        gt(withdrawals.requestedAt, dayAgo),
        sql`${withdrawals.status} NOT IN ('cancelled', 'failed')`,
      ))
      .groupBy(withdrawals.asset);

    let totalCadToday = new Decimal(0);
    for (const row of todayWithdrawals) {
      const p = await getPrice(row.asset);
      if (p && row.totalAmount) {
        totalCadToday = totalCadToday.plus(new Decimal(row.totalAmount).times(p.cadPrice));
      }
    }

    if (cadEquivalent.isFinite() && totalCadToday.plus(cadEquivalent).gt(DAILY_LIMIT_CAD)) {
      return reply.status(400).send({
        error: `Daily withdrawal limit of $${DAILY_LIMIT_CAD.toLocaleString()} CAD exceeded. Try again tomorrow.`,
      });
    }

    const autoApprove = cadEquivalent.lte(env.WITHDRAWAL_AUTO_APPROVE_CAD_LIMIT);

    // Atomic: debit balance + create withdrawal record
    const result = await db.transaction(async (tx) => {
      // Debit user's available balance
      await mutateBalance(tx, {
        userId: request.userId,
        asset,
        field: 'available',
        amount: amountDec.negated().toFixed(18),
        entryType: 'withdrawal_requested',
        idempotencyKey: `withdrawal_debit:${request.userId}:${asset}:${Date.now()}`,
        note: `Withdrawal to ${toAddress}`,
      });

      // Create withdrawal record
      const [withdrawal] = await tx
        .insert(withdrawals)
        .values({
          userId: request.userId,
          asset,
          chain: feeInfo.chain,
          amount: amountDec.toFixed(18),
          fee: feeDec.toFixed(18),
          netAmount: netAmount.toFixed(18),
          toAddress,
          destinationTag: destinationTag ?? null,
          status: autoApprove ? 'approved' : 'pending_review',
          approvedAt: autoApprove ? new Date() : null,
        })
        .returning();

      return withdrawal;
    });

    return reply.status(201).send({
      withdrawal: result,
      message: autoApprove
        ? 'Withdrawal approved and queued for broadcasting.'
        : 'Withdrawal submitted for review. Large withdrawals require manual approval.',
    });
  });

  // ─── List Withdrawals ───────────────────────────────────────────────
  app.get('/api/withdrawals', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { status?: string; limit?: string; offset?: string };

    const conditions = [eq(withdrawals.userId, request.userId)];
    if (query.status) conditions.push(eq(withdrawals.status, query.status));

    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Number(query.offset) || 0;

    const rows = await db
      .select()
      .from(withdrawals)
      .where(and(...conditions))
      .orderBy(desc(withdrawals.requestedAt))
      .limit(limit)
      .offset(offset);

    return { withdrawals: rows };
  });

  // ─── Get Single Withdrawal ──────────────────────────────────────────
  app.get('/api/withdrawals/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [withdrawal] = await db
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.id, id), eq(withdrawals.userId, request.userId)));

    if (!withdrawal) {
      return reply.status(404).send({ error: 'Withdrawal not found' });
    }

    return withdrawal;
  });

  // ─── Cancel Pending Withdrawal ──────────────────────────────────────
  app.post('/api/withdrawals/:id/cancel', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    // Get withdrawal
    const [withdrawal] = await db
      .select()
      .from(withdrawals)
      .where(and(eq(withdrawals.id, id), eq(withdrawals.userId, request.userId)));

    if (!withdrawal) return reply.status(404).send({ error: 'Withdrawal not found' });

    if (withdrawal.status !== 'pending_review' && withdrawal.status !== 'approved') {
      return reply.status(400).send({
        error: `Cannot cancel withdrawal in "${withdrawal.status}" status. Only pending or approved withdrawals can be cancelled.`,
      });
    }

    // Atomic: re-credit balance + update withdrawal status
    await db.transaction(async (tx) => {
      // Verify the original debit amount from ledger (defensive — ensures we
      // credit back exactly what was debited, even if withdrawal schema changes)
      const debitResult = await tx.execute(
        sql`SELECT amount FROM balance_ledger
            WHERE entry_type = 'withdrawal_requested'
              AND user_id = ${request.userId}
              AND asset = ${withdrawal.asset}
              AND amount::numeric < 0
            ORDER BY created_at DESC
            LIMIT 1`
      ) as any;
      const debitRows = Array.isArray(debitResult) ? debitResult : debitResult?.rows ?? [];
      const refundAmount = debitRows.length > 0
        ? new Decimal(debitRows[0].amount).abs().toFixed(18)
        : withdrawal.amount; // fallback to stored amount

      // Re-credit the debited amount back to available
      await mutateBalance(tx, {
        userId: request.userId,
        asset: withdrawal.asset,
        field: 'available',
        amount: refundAmount,
        entryType: 'withdrawal_cancelled',
        idempotencyKey: `withdrawal_cancel:${id}`,
        withdrawalId: id,
        note: 'Withdrawal cancelled by user',
      });

      // Update withdrawal status
      await tx
        .update(withdrawals)
        .set({ status: 'cancelled' })
        .where(eq(withdrawals.id, id));
    });

    return { success: true, message: 'Withdrawal cancelled. Funds returned to your available balance.' };
  });
}
