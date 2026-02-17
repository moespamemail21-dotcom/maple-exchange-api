import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { withdrawals, users, wallets, savedAddresses } from '../db/schema.js';
import { eq, and, desc, gt, sql, count } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { mutateBalance } from '../services/balance.js';
import { getPrice } from '../services/price.js';
import { validateAddress, ASSET_TO_CHAIN, type Chain } from '../services/wallet.js';
import { ErrorCode, apiError } from '../config/error-codes.js';
import { isTotpRequired, verifyTotp } from '../services/totp.js';
import { checkWithdrawalVelocity } from '../services/suspicious-activity.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import Decimal from 'decimal.js';

// ─── Address Normalization (prevents cooldown bypass) ───────────────────────
function normalizeAddress(asset: string, address: string): string {
  const trimmed = address.trim();
  // ETH and LINK addresses are case-insensitive, normalize to lowercase
  if (asset === 'ETH' || asset === 'LINK') {
    return trimmed.toLowerCase();
  }
  // BTC, LTC, XRP, SOL are case-sensitive, only trim
  return trimmed;
}

// ─── Withdrawal Fees (flat per-chain, in asset units) ────────────────────────

const WITHDRAWAL_FEES: Record<string, Record<string, string>> = {
  BTC:  { chain: 'bitcoin',  fee: '0.00005' },
  ETH:  { chain: 'ethereum', fee: '0.001' },
  LTC:  { chain: 'litecoin', fee: '0.001' },
  XRP:  { chain: 'xrp',      fee: '0.1' },
  SOL:  { chain: 'solana',   fee: '0.005' },
  LINK: { chain: 'ethereum', fee: '0.5' },
};

// ─── Minimum Withdrawal Amounts (in crypto units, ~$10 CAD equivalent) ──────

const WITHDRAWAL_MINIMUMS: Record<string, string> = {
  BTC:  '0.0001',
  ETH:  '0.005',
  LTC:  '0.05',
  XRP:  '10',
  SOL:  '0.1',
  LINK: '1',
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
  totpCode: z.string().length(6).regex(/^\d{6}$/).optional(),
});

const uuidParamSchema = z.object({ id: z.string().uuid() });

export async function withdrawalRoutes(app: FastifyInstance) {
  // ─── Request Withdrawal ─────────────────────────────────────────────
  app.post('/api/withdrawals', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = withdrawRequestSchema.parse(request.body);
    const { asset, amount, toAddress, destinationTag } = body;

    // Validate user KYC
    const [user] = await db.select().from(users).where(eq(users.id, request.userId));
    if (!user) return reply.status(404).send({ error: 'User not found' });
    if (user.kycStatus !== 'verified') {
      return reply.status(403).send(apiError(ErrorCode.KYC_REQUIRED, 'KYC verification required before withdrawing'));
    }

    // Withdrawal cooldown: block withdrawals for 24 hours after password change/reset
    if (user.passwordChangedAt) {
      const cooldownMs = 24 * 60 * 60 * 1000;
      const elapsed = Date.now() - new Date(user.passwordChangedAt).getTime();
      if (elapsed < cooldownMs) {
        const hoursLeft = Math.ceil((cooldownMs - elapsed) / (60 * 60 * 1000));
        return reply.status(403).send({
          error: `Withdrawals are temporarily disabled for security after a password change. Please wait approximately ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}.`,
        });
      }
    }

    // Require 2FA verification for withdrawals if user has 2FA enabled
    if (user.twoFactorEnabled) {
      if (!body.totpCode) {
        return reply.status(400).send({ ...apiError(ErrorCode.REQUIRES_2FA, '2FA verification code required for withdrawals'), requires2FA: true });
      }
      if (!user.twoFactorSecret || !verifyTotp(user.twoFactorSecret, body.totpCode)) {
        return reply.status(403).send(apiError(ErrorCode.INVALID_2FA, 'Invalid 2FA code. Please try again.'));
      }
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

    // Minimum withdrawal amount (prevents dust withdrawals)
    const minAmount = WITHDRAWAL_MINIMUMS[asset];
    if (minAmount && amountDec.lt(new Decimal(minAmount))) {
      return reply.status(400).send({
        error: `Minimum withdrawal amount is ${minAmount} ${asset}. Please increase your withdrawal amount.`,
      });
    }

    // Determine auto-approve threshold in crypto
    const priceData = await getPrice(asset);
    const cadEquivalent = priceData
      ? amountDec.times(priceData.cadPrice)
      : new Decimal(Infinity);

    // Cooldown between withdrawal requests
    const cooldownCutoff = new Date(Date.now() - env.WITHDRAWAL_COOLDOWN_MINUTES * 60 * 1000);
    const [recentWithdrawal] = await db
      .select({ id: withdrawals.id })
      .from(withdrawals)
      .where(and(
        eq(withdrawals.userId, request.userId),
        gt(withdrawals.requestedAt, cooldownCutoff),
      ))
      .limit(1);

    if (recentWithdrawal) {
      return reply.status(429).send(apiError(ErrorCode.WITHDRAWAL_COOLDOWN, `Please wait at least ${env.WITHDRAWAL_COOLDOWN_MINUTES} minutes between withdrawal requests.`));
    }

    // Daily limit (configurable via env)
    const DAILY_LIMIT_CAD = env.WITHDRAWAL_DAILY_LIMIT_CAD;
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
      return reply.status(400).send(apiError(ErrorCode.DAILY_LIMIT_EXCEEDED, `Daily withdrawal limit of $${DAILY_LIMIT_CAD.toLocaleString()} CAD exceeded. Try again tomorrow.`));
    }

    // Monthly limit (configurable via env)
    const MONTHLY_LIMIT_CAD = env.WITHDRAWAL_MONTHLY_LIMIT_CAD;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const monthWithdrawals = await db
      .select({
        asset: withdrawals.asset,
        totalAmount: sql<string>`SUM(${withdrawals.amount}::numeric)`,
      })
      .from(withdrawals)
      .where(and(
        eq(withdrawals.userId, request.userId),
        gt(withdrawals.requestedAt, thirtyDaysAgo),
        sql`${withdrawals.status} NOT IN ('cancelled', 'failed')`,
      ))
      .groupBy(withdrawals.asset);

    let totalCadMonth = new Decimal(0);
    for (const row of monthWithdrawals) {
      const p = await getPrice(row.asset);
      if (p && row.totalAmount) {
        totalCadMonth = totalCadMonth.plus(new Decimal(row.totalAmount).times(p.cadPrice));
      }
    }

    if (cadEquivalent.isFinite() && totalCadMonth.plus(cadEquivalent).gt(MONTHLY_LIMIT_CAD)) {
      return reply.status(400).send(apiError(ErrorCode.MONTHLY_LIMIT_EXCEEDED, `Monthly withdrawal limit of $${MONTHLY_LIMIT_CAD.toLocaleString()} CAD exceeded. Contact support for higher limits.`));
    }


    // ─── Address Whitelist Check (24h cooldown for new addresses) ────────
    const normalizedAddress = normalizeAddress(body.asset, body.toAddress);
    const [savedAddr] = await db
      .select()
      .from(savedAddresses)
      .where(
        and(
          eq(savedAddresses.userId, request.userId),
          eq(savedAddresses.asset, body.asset),
          eq(savedAddresses.address, normalizedAddress),
        ),
      )
      .limit(1);

    const addressCooldownMs = env.ADDRESS_COOLDOWN_HOURS * 60 * 60 * 1000;
    if (savedAddr) {
      // Check if address was added recently (within cooldown period)
      const cooldownCutoff = new Date(Date.now() - addressCooldownMs);
      if (savedAddr.createdAt > cooldownCutoff) {
        const readyAt = new Date(savedAddr.createdAt.getTime() + addressCooldownMs);
        return reply.status(403).send({ ...apiError(ErrorCode.ADDRESS_COOLDOWN, `This address was recently added to your address book. For security, new addresses require a ${env.ADDRESS_COOLDOWN_HOURS}-hour cooldown period.`), readyAt: readyAt.toISOString() });
      }
      // Address is in book and old enough — whitelisted, proceed
    } else {
      // Address not in address book at all — auto-add it with cooldown
      // Enforce MAX_SAVED_ADDRESSES limit (same as address-book route)
      const [addrCount] = await db
        .select({ count: count() })
        .from(savedAddresses)
        .where(eq(savedAddresses.userId, request.userId));
      if (addrCount && addrCount.count >= 20) {
        return reply.status(400).send(apiError(ErrorCode.ADDRESS_LIMIT, 'Maximum 20 saved addresses. Delete one from your address book to add a new withdrawal address.'));
      }
      await db.insert(savedAddresses).values({
        userId: request.userId,
        label: `${body.asset} Withdrawal`,
        asset: body.asset,
        address: normalizedAddress,
        destinationTag: body.destinationTag ?? null,
      });
      return reply.status(403).send({ ...apiError(ErrorCode.ADDRESS_NEW, `This is a new withdrawal address. For your security, it has been added to your address book with a ${env.ADDRESS_COOLDOWN_HOURS}-hour cooldown period. You can withdraw to this address after the cooldown.`), readyAt: new Date(Date.now() + addressCooldownMs).toISOString() });
    }

    const autoApprove = cadEquivalent.lte(env.WITHDRAWAL_AUTO_APPROVE_CAD_LIMIT);

    // Atomic: debit balance + create withdrawal record.
    // We create the withdrawal record first to get a unique ID for the
    // idempotency key, ensuring cancelled withdrawals can't be replayed.
    const result = await db.transaction(async (tx) => {
      // Create withdrawal record first (for the unique ID)
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

      // Debit user's available balance using the withdrawal ID as idempotency key
      // — prevents replay after cancellation since each withdrawal gets a unique ID.
      await mutateBalance(tx, {
        userId: request.userId,
        asset,
        field: 'available',
        amount: amountDec.negated().toFixed(18),
        entryType: 'withdrawal_requested',
        idempotencyKey: `withdrawal_debit:${withdrawal.id}`,
        withdrawalId: withdrawal.id,
        note: `Withdrawal to ${toAddress}`,
      });

      return withdrawal;
    });

    // Check for suspicious withdrawal velocity
    try {
      await checkWithdrawalVelocity(request.userId);
    } catch (err) {
      logger.error({ err }, 'Withdrawal velocity check failed');
    }

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
    const offset = Math.min(Math.max(Number(query.offset) || 0, 0), 10_000);

    const rows = await db
      .select()
      .from(withdrawals)
      .where(and(...conditions))
      .orderBy(desc(withdrawals.requestedAt))
      .limit(limit)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: count() })
      .from(withdrawals)
      .where(and(...conditions));

    return { withdrawals: rows, total, limit, offset };
  });

  // ─── Get Single Withdrawal ──────────────────────────────────────────
  app.get('/api/withdrawals/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

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
    const { id } = uuidParamSchema.parse(request.params);

    // Atomic: verify status + re-credit balance + update withdrawal status
    // All inside a transaction with FOR UPDATE to prevent TOCTOU race with admin approve/reject.
    const result = await db.transaction(async (tx) => {
      // Lock the withdrawal row to prevent concurrent admin approve/reject
      await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${id} FOR UPDATE`);
      const [withdrawal] = await tx
        .select()
        .from(withdrawals)
        .where(and(eq(withdrawals.id, id), eq(withdrawals.userId, request.userId)));

      if (!withdrawal) return { error: 'Withdrawal not found', code: 404 } as const;

      if (withdrawal.status !== 'pending_review') {
        return {
          error: `Cannot cancel withdrawal in "${withdrawal.status}" status. Only withdrawals pending review can be cancelled.`,
          code: 400,
        } as const;
      }

      // Refund the full debited amount (withdrawal.amount includes fee).
      // withdrawal.amount is the authoritative record of what was debited.
      const refundAmount = withdrawal.amount;

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

      return { success: true } as const;
    });

    if ('error' in result && 'code' in result) {
      return reply.status(result.code as number).send({ error: result.error });
    }

    return { success: true, message: 'Withdrawal cancelled. Funds returned to your available balance.' };
  });
}
