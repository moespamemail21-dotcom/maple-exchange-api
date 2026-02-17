import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { trades, disputes, balances, users, complianceLogs, withdrawals, wallets, orders, authEvents, kycDocuments, stakingPositions, stakingProducts, deposits, notifications } from '../db/schema.js';
import { eq, and, desc, ne, gt, sql } from 'drizzle-orm';
import { adminGuard } from '../middleware/auth.js';
import { transitionTrade } from '../services/trade.js';
import { completePlatformSellTrade, PLATFORM_USER_ID } from '../services/platform.js';
import { getPoolStatus } from '../services/wallet-pool.js';
import { decryptPrivateKey } from '../services/wallet.js';
import { mutateBalance } from '../services/balance.js';
import { executeMatches, type TradeMatch } from '../services/matching.js';
import { getPrice } from '../services/price.js';
import { env } from '../config/env.js';
import Decimal from 'decimal.js';

const resolveSchema = z.object({
  resolution: z.enum(['buyer_wins', 'seller_wins']),
  note: z.string().max(2000).optional(),
});

const uuidParamSchema = z.object({ id: z.string().uuid() });
const recoverKeySchema = z.object({ walletId: z.string().uuid() });
const rejectPaymentSchema = z.object({ reason: z.string().max(2000).optional() });
const manualMatchSchema = z.object({ buyOrderId: z.string().uuid(), sellOrderId: z.string().uuid() });
const rejectWithdrawalSchema = z.object({ reason: z.string().max(2000).optional() });
const kycStatusSchema = z.object({ status: z.enum(['verified', 'rejected']), note: z.string().max(2000).optional() });

const VALID_TRADE_STATUSES = ['pending', 'escrow_funded', 'payment_sent', 'payment_confirmed', 'crypto_released', 'completed', 'expired', 'cancelled', 'disputed', 'resolved_buyer', 'resolved_seller'] as const;
const VALID_ORDER_STATUSES = ['active', 'paused', 'filled', 'cancelled'] as const;
const VALID_ORDER_TYPES = ['buy', 'sell'] as const;
const VALID_ASSETS = ['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK'] as const;
const VALID_WITHDRAWAL_STATUSES = ['pending_review', 'approved', 'broadcasting', 'confirmed', 'failed', 'cancelled'] as const;

export async function adminRoutes(app: FastifyInstance) {
  // ─── List Open Disputes ─────────────────────────────────────────────
  app.get('/api/admin/disputes', { preHandler: [adminGuard] }, async () => {
    const openDisputes = await db
      .select({
        id: disputes.id,
        tradeId: disputes.tradeId,
        openedBy: disputes.openedBy,
        reason: disputes.reason,
        evidenceUrls: disputes.evidenceUrls,
        resolution: disputes.resolution,
        createdAt: disputes.createdAt,
        // Trade details
        cryptoAsset: trades.cryptoAsset,
        amountCrypto: trades.amountCrypto,
        amountFiat: trades.amountFiat,
        tradeStatus: trades.status,
        buyerId: trades.buyerId,
        sellerId: trades.sellerId,
      })
      .from(disputes)
      .innerJoin(trades, eq(disputes.tradeId, trades.id))
      .where(sql`${disputes.resolution} IS NULL`)
      .orderBy(desc(disputes.createdAt));

    return { disputes: openDisputes };
  });

  // ─── Get Single Dispute ─────────────────────────────────────────────
  app.get('/api/admin/disputes/:id', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [dispute] = await db
      .select()
      .from(disputes)
      .where(eq(disputes.id, id));

    if (!dispute) return reply.status(404).send({ error: 'Dispute not found' });

    const [trade] = await db.select().from(trades).where(eq(trades.id, dispute.tradeId));
    const [buyer] = trade ? await db.select().from(users).where(eq(users.id, trade.buyerId)) : [];
    const [seller] = trade ? await db.select().from(users).where(eq(users.id, trade.sellerId)) : [];

    return {
      dispute,
      trade,
      buyer: buyer ? { id: buyer.id, email: buyer.email, displayName: buyer.displayName, tradeCount: buyer.tradeCount } : null,
      seller: seller ? { id: seller.id, email: seller.email, displayName: seller.displayName, tradeCount: seller.tradeCount } : null,
    };
  });

  // ─── Resolve Dispute ────────────────────────────────────────────────
  app.post('/api/admin/disputes/:id/resolve', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: [adminGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const body = resolveSchema.parse(request.body);

    const [dispute] = await db.select().from(disputes).where(eq(disputes.id, id));
    if (!dispute) return reply.status(404).send({ error: 'Dispute not found' });
    if (dispute.resolution) return reply.status(400).send({ error: 'Dispute already resolved' });

    const newStatus = body.resolution === 'buyer_wins' ? 'resolved_buyer' : 'resolved_seller';
    const result = await transitionTrade(dispute.tradeId, newStatus as any, request.userId);

    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    // Update dispute record
    await db
      .update(disputes)
      .set({
        resolution: body.resolution,
        resolvedBy: request.userId,
        resolvedAt: new Date(),
      })
      .where(eq(disputes.id, id));

    // Audit log
    await db.insert(complianceLogs).values({
      userId: request.userId,
      tradeId: dispute.tradeId,
      eventType: 'admin_dispute_resolved',
      payload: {
        disputeId: id,
        resolution: body.resolution,
        note: body.note ?? null,
      },
    });

    return { success: true, message: `Dispute resolved: ${body.resolution}` };
  });

  // ─── Verify Payment (Admin confirms Interac received → instant complete) ──
  app.post('/api/admin/trades/:id/verify-payment', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: [adminGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [trade] = await db.select().from(trades).where(eq(trades.id, id));
    if (!trade) return reply.status(404).send({ error: 'Trade not found' });

    if (!['payment_sent', 'payment_confirmed'].includes(trade.status)) {
      return reply.status(400).send({ error: `Trade is at "${trade.status}", expected payment_sent or payment_confirmed` });
    }

    if (trade.sellerId === PLATFORM_USER_ID) {
      // Platform trade: advance through state machine, then complete
      if (trade.status === 'payment_sent') {
        const r1 = await transitionTrade(id, 'payment_confirmed', request.userId);
        if (!r1.success) return reply.status(400).send({ error: r1.error });
      }
      await completePlatformSellTrade(id);
    } else {
      // P2P trade: skip crypto_released, go straight to completed
      // transitionTrade('completed') handles all balance mutations:
      //   - debits seller locked, credits buyer available, credits platform fee, updates stats
      if (trade.status === 'payment_sent') {
        // First advance to payment_confirmed
        const r1 = await transitionTrade(id, 'payment_confirmed', request.userId);
        if (!r1.success) return reply.status(400).send({ error: r1.error });
      }
      // Then to crypto_released
      const r2 = await transitionTrade(id, 'crypto_released', request.userId);
      if (!r2.success) return reply.status(400).send({ error: r2.error });
      // Then to completed (this is where buyer balance is credited)
      const r3 = await transitionTrade(id, 'completed', request.userId);
      if (!r3.success) return reply.status(400).send({ error: r3.error });
    }

    // Audit log
    await db.insert(complianceLogs).values({
      userId: request.userId,
      tradeId: id,
      eventType: 'admin_payment_verified',
      payload: { tradeId: id, previousStatus: trade.status },
    });

    return { success: true, message: 'Trade completed. Crypto credited to buyer.' };
  });

  // ─── Full Trade List (Admin view, with buyer/seller names) ─────────
  app.get('/api/admin/trades', { preHandler: [adminGuard] }, async (request) => {
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const validatedStatus = query.status && VALID_TRADE_STATUSES.includes(query.status as any) ? query.status : undefined;
    const statusFilter = validatedStatus ? sql`AND t.status = ${validatedStatus}` : sql``;
    const rows = await db.execute(
      sql`SELECT t.id, t.status,
                 t.order_id        AS "orderId",
                 t.buyer_id        AS "buyerId",
                 t.seller_id       AS "sellerId",
                 t.crypto_asset    AS "cryptoAsset",
                 t.amount_crypto   AS "amountCrypto",
                 t.amount_fiat     AS "amountFiat",
                 t.price_per_unit  AS "pricePerUnit",
                 t.fee_percent     AS "feePercent",
                 t.fee_amount      AS "feeAmount",
                 t.escrow_address  AS "escrowAddress",
                 t.escrow_tx_id    AS "escrowTxId",
                 t.release_tx_id   AS "releaseTxId",
                 t.escrow_funded_at    AS "escrowFundedAt",
                 t.payment_sent_at     AS "paymentSentAt",
                 t.payment_confirmed_at AS "paymentConfirmedAt",
                 t.crypto_released_at  AS "cryptoReleasedAt",
                 t.completed_at   AS "completedAt",
                 t.expires_at     AS "expiresAt",
                 t.holding_until  AS "holdingUntil",
                 t.created_at     AS "createdAt",
                 t.updated_at     AS "updatedAt",
                 b.email           AS "buyerEmail",
                 b.display_name    AS "buyerDisplayName",
                 s.email           AS "sellerEmail",
                 s.display_name    AS "sellerDisplayName"
          FROM trades t
          LEFT JOIN users b ON b.id = t.buyer_id
          LEFT JOIN users s ON s.id = t.seller_id
          WHERE 1=1 ${statusFilter}
          ORDER BY t.created_at DESC
          LIMIT ${limit} OFFSET ${offset}`,
    ) as any;
    const tradeList = Array.isArray(rows) ? rows : rows?.rows ?? [];

    return { trades: tradeList };
  });

  // ─── Wallet Pool Status ──────────────────────────────────────────────
  app.get('/api/admin/wallets/pool', { preHandler: [adminGuard] }, async () => {
    const pool = await getPoolStatus();

    // Also count assigned wallets per chain
    const assignedResult = await db.execute(
      sql`SELECT chain, COUNT(*)::int AS assigned
          FROM wallets
          WHERE user_id IS NOT NULL
          GROUP BY chain
          ORDER BY chain`,
    ) as any;
    const assignedRows = Array.isArray(assignedResult) ? assignedResult : assignedResult?.rows ?? [];
    const assignedMap = new Map<string, number>();
    for (const r of assignedRows) assignedMap.set(r.chain, Number(r.assigned));

    return {
      pool: pool.map((p) => ({
        ...p,
        assigned: assignedMap.get(p.chain) ?? 0,
      })),
    };
  });

  // ─── Wallet Key Recovery (Admin) ────────────────────────────────────
  app.post('/api/admin/wallets/recover-key', {
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
    preHandler: [adminGuard],
  }, async (request, reply) => {
    const { walletId } = recoverKeySchema.parse(request.body);
    if (!walletId) return reply.status(400).send({ error: 'walletId is required' });

    const [wallet] = await db
      .select({
        id: wallets.id,
        chain: wallets.chain,
        address: wallets.address,
        userId: wallets.userId,
        encryptedPrivateKey: wallets.encryptedPrivateKey,
      })
      .from(wallets)
      .where(eq(wallets.id, walletId));

    if (!wallet) return reply.status(404).send({ error: 'Wallet not found' });
    if (!wallet.encryptedPrivateKey) return reply.status(400).send({ error: 'No encrypted key stored' });

    // Audit log to compliance_logs (replaces console.log)
    await db.insert(complianceLogs).values({
      userId: request.userId,
      eventType: 'admin_key_recovery',
      payload: {
        walletId,
        chain: wallet.chain,
        address: wallet.address,
        walletUserId: wallet.userId,
      },
    });

    const privateKeyHex = decryptPrivateKey(wallet.encryptedPrivateKey);

    return {
      walletId: wallet.id,
      chain: wallet.chain,
      address: wallet.address,
      userId: wallet.userId,
      privateKeyHex,
    };
  });

  // ─── Platform Balances + Fee Totals ────────────────────────────────
  app.get('/api/admin/platform/balances', { preHandler: [adminGuard] }, async () => {
    const platformBalances = await db
      .select()
      .from(balances)
      .where(eq(balances.userId, PLATFORM_USER_ID));

    // Sum all fee credits from ledger
    const feeTotalResult = await db.execute(
      sql`SELECT asset, SUM(amount::numeric) AS "totalFees"
          FROM balance_ledger
          WHERE user_id = ${PLATFORM_USER_ID} AND entry_type = 'fee_credit'
          GROUP BY asset`,
    );
    const feeTotals = (feeTotalResult as any).rows ?? feeTotalResult;

    return {
      balances: platformBalances,
      feeTotals,
    };
  });

  // ─── Dashboard Stats ──────────────────────────────────────────────
  app.get('/api/admin/stats', { preHandler: [adminGuard] }, async () => {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [userCount] = await db.execute(
      sql`SELECT COUNT(*)::int AS total FROM users WHERE id != ${PLATFORM_USER_ID}`,
    ) as any[];

    const [volume24h] = await db.execute(
      sql`SELECT COALESCE(SUM(amount_fiat::numeric), 0) AS volume
          FROM trades
          WHERE created_at > ${dayAgo}
            AND status IN ('completed', 'crypto_released', 'payment_confirmed')`,
    ) as any[];

    const [activeDisputes] = await db.execute(
      sql`SELECT COUNT(*)::int AS total FROM disputes WHERE resolution IS NULL`,
    ) as any[];

    const [pendingWithdrawals] = await db.execute(
      sql`SELECT COUNT(*)::int AS total FROM withdrawals WHERE status = 'pending_review'`,
    ) as any[];

    const [trades24h] = await db.execute(
      sql`SELECT COUNT(*)::int AS total FROM trades WHERE created_at > ${dayAgo}`,
    ) as any[];

    return {
      totalUsers: userCount?.total ?? 0,
      volume24h: volume24h?.volume ?? '0',
      activeDisputes: activeDisputes?.total ?? 0,
      pendingWithdrawals: pendingWithdrawals?.total ?? 0,
      trades24h: trades24h?.total ?? 0,
    };
  });

  // ─── User List (Paginated + Search + Filter) ─────────────────────
  app.get('/api/admin/users', { preHandler: [adminGuard] }, async (request) => {
    const query = request.query as { page?: string; limit?: string; search?: string; kycStatus?: string };
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = (page - 1) * limit;

    const conditions = [sql`${users.id} != ${PLATFORM_USER_ID}`];
    if (query.search) {
      const search = query.search.slice(0, 100); // Cap search length
      const pattern = `%${search}%`;
      conditions.push(sql`(${users.email} ILIKE ${pattern} OR ${users.displayName} ILIKE ${pattern})`);
    }
    const VALID_KYC_STATUSES = ['pending', 'verified', 'rejected'];
    if (query.kycStatus && VALID_KYC_STATUSES.includes(query.kycStatus)) {
      conditions.push(eq(users.kycStatus, query.kycStatus));
    }

    const whereClause = and(...conditions);

    const userList = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        kycStatus: users.kycStatus,
        tradeCount: users.tradeCount,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(whereClause)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db.execute(
      sql`SELECT COUNT(*)::int AS total FROM users WHERE ${whereClause}`,
    ) as any[];

    return {
      users: userList,
      total: countResult?.total ?? 0,
      page,
      limit,
    };
  });

  // ─── Single User Detail ───────────────────────────────────────────
  app.get('/api/admin/users/:id', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        kycStatus: users.kycStatus,
        tradeCount: users.tradeCount,
        completionRate: users.completionRate,
        maxTradeLimit: users.maxTradeLimit,
        createdAt: users.createdAt,
        // Payment
        interacEmail: users.interacEmail,
        autodepositVerified: users.autodepositVerified,
        phone: users.phone,
        // KYC / Compliance
        fullLegalName: users.fullLegalName,
        dateOfBirth: users.dateOfBirth,
        address: users.address,
        city: users.city,
        province: users.province,
        postalCode: users.postalCode,
        countryOfResidence: users.countryOfResidence,
        occupation: users.occupation,
        kycVideoStatus: users.kycVideoStatus,
      })
      .from(users)
      .where(eq(users.id, id));

    if (!user) return reply.status(404).send({ error: 'User not found' });

    const userBalances = await db.select().from(balances).where(eq(balances.userId, id));
    const userWallets = await db
      .select({
        id: wallets.id,
        chain: wallets.chain,
        address: wallets.address,
        assignedAt: wallets.assignedAt,
        hasEncryptedKey: sql<boolean>`${wallets.encryptedPrivateKey} IS NOT NULL`.as('has_encrypted_key'),
      })
      .from(wallets)
      .where(eq(wallets.userId, id));

    const recentTrades = await db
      .select()
      .from(trades)
      .where(sql`${trades.buyerId} = ${id} OR ${trades.sellerId} = ${id}`)
      .orderBy(desc(trades.createdAt))
      .limit(20);

    const userOrders = await db
      .select()
      .from(orders)
      .where(and(eq(orders.userId, id), sql`${orders.status} IN ('active', 'paused')`))
      .orderBy(desc(orders.createdAt))
      .limit(20);

    // Audit log for PII access
    await db.insert(complianceLogs).values({
      userId: request.userId,
      eventType: 'admin_viewed_user_pii',
      payload: { targetUserId: id },
    });

    return { user, balances: userBalances, wallets: userWallets, recentTrades, orders: userOrders };
  });

  // ─── Single Trade Detail ──────────────────────────────────────────
  app.get('/api/admin/trades/:id', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [trade] = await db.select().from(trades).where(eq(trades.id, id));
    if (!trade) return reply.status(404).send({ error: 'Trade not found' });

    const [buyer] = await db
      .select({
        id: users.id, email: users.email, displayName: users.displayName,
        tradeCount: users.tradeCount, interacEmail: users.interacEmail,
        autodepositVerified: users.autodepositVerified,
      })
      .from(users)
      .where(eq(users.id, trade.buyerId));

    const [seller] = await db
      .select({
        id: users.id, email: users.email, displayName: users.displayName,
        tradeCount: users.tradeCount, interacEmail: users.interacEmail,
        autodepositVerified: users.autodepositVerified,
      })
      .from(users)
      .where(eq(users.id, trade.sellerId));

    // Source order info
    const [order] = trade.orderId
      ? await db.select().from(orders).where(eq(orders.id, trade.orderId))
      : [];

    return { trade, buyer: buyer ?? null, seller: seller ?? null, order: order ?? null };
  });

  // ─── All Withdrawals (Admin) ──────────────────────────────────────
  app.get('/api/admin/withdrawals', { preHandler: [adminGuard] }, async (request) => {
    const query = request.query as { status?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const conditions = [];
    if (query.status && VALID_WITHDRAWAL_STATUSES.includes(query.status as any)) {
      conditions.push(eq(withdrawals.status, query.status));
    }

    const rows = await db
      .select({
        id: withdrawals.id,
        userId: withdrawals.userId,
        asset: withdrawals.asset,
        chain: withdrawals.chain,
        amount: withdrawals.amount,
        fee: withdrawals.fee,
        netAmount: withdrawals.netAmount,
        toAddress: withdrawals.toAddress,
        destinationTag: withdrawals.destinationTag,
        status: withdrawals.status,
        requestedAt: withdrawals.requestedAt,
        approvedAt: withdrawals.approvedAt,
        userEmail: users.email,
        userDisplayName: users.displayName,
      })
      .from(withdrawals)
      .innerJoin(users, eq(withdrawals.userId, users.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(withdrawals.requestedAt))
      .limit(limit)
      .offset(offset);

    return { withdrawals: rows };
  });

  // ─── Approve Withdrawal ───────────────────────────────────────────
  app.post('/api/admin/withdrawals/:id/approve', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: [adminGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${id} FOR UPDATE`);
      const [withdrawal] = await tx.select().from(withdrawals).where(eq(withdrawals.id, id));
      if (!withdrawal) return { error: 'Withdrawal not found', code: 404 } as const;
      if (withdrawal.status !== 'pending_review') {
        return { error: `Cannot approve: status is "${withdrawal.status}", expected "pending_review"`, code: 400 } as const;
      }

      await tx
        .update(withdrawals)
        .set({ status: 'approved', approvedAt: new Date() })
        .where(eq(withdrawals.id, id));

      return { success: true, withdrawal } as const;
    });

    if ('error' in result && 'code' in result) {
      return reply.status(result.code as number).send({ error: result.error });
    }

    await db.insert(complianceLogs).values({
      userId: request.userId,
      eventType: 'admin_withdrawal_approved',
      payload: {
        withdrawalId: id,
        withdrawalUserId: result.withdrawal.userId,
        asset: result.withdrawal.asset,
        amount: result.withdrawal.amount,
        toAddress: result.withdrawal.toAddress,
      },
    });

    return { success: true, message: 'Withdrawal approved and queued for broadcasting.' };
  });

  // ─── Reject Withdrawal ────────────────────────────────────────────
  app.post('/api/admin/withdrawals/:id/reject', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: [adminGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const { reason } = rejectWithdrawalSchema.parse(request.body);

    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM withdrawals WHERE id = ${id} FOR UPDATE`);
      const [withdrawal] = await tx.select().from(withdrawals).where(eq(withdrawals.id, id));
      if (!withdrawal) return { error: 'Withdrawal not found', code: 404 } as const;
      if (withdrawal.status !== 'pending_review') {
        return { error: `Cannot reject: status is "${withdrawal.status}", expected "pending_review"`, code: 400 } as const;
      }

      // Refund the debited amount back to user's available balance
      await mutateBalance(tx, {
        userId: withdrawal.userId,
        asset: withdrawal.asset,
        field: 'available',
        amount: new Decimal(withdrawal.amount).toFixed(18),
        entryType: 'withdrawal_rejected',
        idempotencyKey: `withdrawal_reject:${id}`,
        withdrawalId: id,
        note: reason ? `Rejected by admin: ${reason}` : 'Rejected by admin',
      });

      await tx
        .update(withdrawals)
        .set({ status: 'failed' })
        .where(eq(withdrawals.id, id));

      return { success: true, withdrawal } as const;
    });

    if ('error' in result && 'code' in result) {
      return reply.status(result.code as number).send({ error: result.error });
    }

    await db.insert(complianceLogs).values({
      userId: request.userId,
      eventType: 'admin_withdrawal_rejected',
      payload: {
        withdrawalId: id,
        withdrawalUserId: result.withdrawal.userId,
        asset: result.withdrawal.asset,
        amount: result.withdrawal.amount,
        reason: reason ?? null,
      },
    });

    return { success: true, message: 'Withdrawal rejected. Funds returned to user.' };
  });

  // ─── Order Book (Admin) ──────────────────────────────────────────
  app.get('/api/admin/orders', { preHandler: [adminGuard] }, async (request) => {
    const query = request.query as { status?: string; type?: string; asset?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const validatedStatus = query.status && VALID_ORDER_STATUSES.includes(query.status as any) ? query.status : undefined;
    const validatedType = query.type && VALID_ORDER_TYPES.includes(query.type as any) ? query.type : undefined;
    const validatedAsset = query.asset && VALID_ASSETS.includes(query.asset as any) ? query.asset : undefined;
    const statusFilter = validatedStatus ? sql`AND o.status = ${validatedStatus}` : sql``;
    const typeFilter = validatedType ? sql`AND o.type = ${validatedType}` : sql``;
    const assetFilter = validatedAsset ? sql`AND o.crypto_asset = ${validatedAsset}` : sql``;

    const rows = await db.execute(
      sql`SELECT o.id, o.type, o.status,
                 o.user_id         AS "userId",
                 o.crypto_asset    AS "cryptoAsset",
                 o.amount_crypto   AS "amountCrypto",
                 o.amount_fiat     AS "amountFiat",
                 o.price_type      AS "priceType",
                 o.price_premium   AS "pricePremium",
                 o.fixed_price     AS "fixedPrice",
                 o.min_trade       AS "minTrade",
                 o.max_trade       AS "maxTrade",
                 o.remaining_fiat  AS "remainingFiat",
                 o.created_at      AS "createdAt",
                 o.updated_at      AS "updatedAt",
                 u.email           AS "userEmail",
                 u.display_name    AS "userDisplayName"
          FROM orders o
          INNER JOIN users u ON u.id = o.user_id
          WHERE 1=1 ${statusFilter} ${typeFilter} ${assetFilter}
          ORDER BY o.created_at DESC
          LIMIT ${limit} OFFSET ${offset}`,
    ) as any;
    const orderList = Array.isArray(rows) ? rows : rows?.rows ?? [];

    return { orders: orderList };
  });

  // ─── Reject Payment (Admin reverts bad e-transfer) ────────────────
  app.post('/api/admin/trades/:id/reject-payment', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: [adminGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const { reason } = rejectPaymentSchema.parse(request.body);

    const [trade] = await db.select().from(trades).where(eq(trades.id, id));
    if (!trade) return reply.status(404).send({ error: 'Trade not found' });

    if (!['payment_sent', 'payment_confirmed'].includes(trade.status)) {
      return reply.status(400).send({ error: `Cannot reject: trade is at "${trade.status}", expected payment_sent or payment_confirmed` });
    }

    // Transition to expired — returns escrowed crypto to seller
    const result = await transitionTrade(id, 'expired', request.userId);
    if (!result.success) {
      return reply.status(400).send({ error: result.error });
    }

    await db.insert(complianceLogs).values({
      userId: request.userId,
      tradeId: id,
      eventType: 'admin_payment_rejected',
      payload: {
        tradeId: id,
        previousStatus: trade.status,
        reason: reason ?? null,
        buyerId: trade.buyerId,
        sellerId: trade.sellerId,
      },
    });

    return { success: true, message: 'Payment rejected. Escrowed crypto returned to seller.' };
  });

  // ─── Manual Match (Admin pairs buyer + seller) ────────────────────
  app.post('/api/admin/orders/manual-match', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [adminGuard],
  }, async (request, reply) => {
    const { buyOrderId, sellOrderId } = manualMatchSchema.parse(request.body);
    if (!buyOrderId || !sellOrderId) {
      return reply.status(400).send({ error: 'buyOrderId and sellOrderId are required' });
    }

    // Read orders with FOR UPDATE inside transaction to prevent concurrent modification
    const matchResult = await db.transaction(async (tx) => {
      const buyRows = await tx.execute(
        sql`SELECT * FROM orders WHERE id = ${buyOrderId} FOR UPDATE`,
      ) as any;
      const sellRows = await tx.execute(
        sql`SELECT * FROM orders WHERE id = ${sellOrderId} FOR UPDATE`,
      ) as any;

      const buyOrder = (Array.isArray(buyRows) ? buyRows : buyRows?.rows ?? [])[0] as typeof orders.$inferSelect | undefined;
      const sellOrder = (Array.isArray(sellRows) ? sellRows : sellRows?.rows ?? [])[0] as typeof orders.$inferSelect | undefined;

      if (!buyOrder) return { error: 'Buy order not found', status: 404 } as const;
      if (!sellOrder) return { error: 'Sell order not found', status: 404 } as const;
      if (buyOrder.status !== 'active') return { error: `Buy order is "${buyOrder.status}", must be active`, status: 400 } as const;
      if (sellOrder.status !== 'active') return { error: `Sell order is "${sellOrder.status}", must be active`, status: 400 } as const;
      if (buyOrder.type !== 'buy') return { error: 'First order must be a buy order', status: 400 } as const;
      if (sellOrder.type !== 'sell') return { error: 'Second order must be a sell order', status: 400 } as const;
      if (buyOrder.cryptoAsset !== sellOrder.cryptoAsset) return { error: `Asset mismatch: buy=${buyOrder.cryptoAsset}, sell=${sellOrder.cryptoAsset}`, status: 400 } as const;
      if (buyOrder.userId === sellOrder.userId) return { error: 'Cannot match orders from the same user', status: 400 } as const;

      return { buyOrder, sellOrder } as const;
    });

    if ('error' in matchResult) {
      return reply.status(matchResult.status as number).send({ error: matchResult.error });
    }

    const { buyOrder, sellOrder } = matchResult;
    const asset = sellOrder.cryptoAsset;

    // Resolve price from seller's terms using Decimal for precision
    const priceData = await getPrice(asset);
    if (!priceData) return reply.status(400).send({ error: `No price data for ${asset}` });

    let pricePerUnit: number;
    if (sellOrder.priceType === 'fixed' && sellOrder.fixedPrice) {
      pricePerUnit = new Decimal(sellOrder.fixedPrice).toNumber();
    } else {
      const premium = new Decimal(sellOrder.pricePremium ?? 0);
      pricePerUnit = new Decimal(priceData.cadPrice).times(premium.dividedBy(100).plus(1)).toNumber();
    }

    // Fill amount = min of both remaining (using Decimal) + random cents for e-transfer disambiguation
    const fillFiat = Decimal.min(
      new Decimal(buyOrder.remainingFiat),
      new Decimal(sellOrder.remainingFiat),
    );
    const randomCents = new Decimal(Math.floor(Math.random() * 99) + 1).dividedBy(100);
    const maxAllowed = Decimal.min(
      new Decimal(buyOrder.remainingFiat),
      new Decimal(sellOrder.remainingFiat),
    );
    const finalFiat = Decimal.min(fillFiat.plus(randomCents), maxAllowed).toDecimalPlaces(2).toNumber();
    const amountCrypto = new Decimal(finalFiat).dividedBy(pricePerUnit).toDecimalPlaces(8).toNumber();

    const feePercent = env.TAKER_FEE_PERCENT;
    // Total fee = feePerSide * 2 (buyer side + seller side), consistent with matching engine
    const feeAmount = new Decimal(amountCrypto).times(feePercent).dividedBy(100).times(2).toDecimalPlaces(8, Decimal.ROUND_UP).toNumber();

    const match: TradeMatch = {
      orderId: sellOrder.id,
      buyerId: buyOrder.userId,
      sellerId: sellOrder.userId,
      amountFiat: finalFiat,
      amountCrypto,
      pricePerUnit,
      feePercent,
      feeAmount,
    };

    const tradeIds = await executeMatches(buyOrder.id, [match], asset);

    if (tradeIds.length === 0) {
      return reply.status(400).send({ error: 'Match failed — seller may have insufficient balance' });
    }

    // Audit log
    await db.insert(complianceLogs).values({
      userId: request.userId,
      eventType: 'admin_manual_match',
      payload: {
        buyOrderId,
        sellOrderId,
        tradeIds,
        asset,
        amountFiat: finalFiat,
        amountCrypto,
        pricePerUnit,
      },
    });

    return { success: true, message: `Trade created successfully`, tradeIds };
  });

  // ─── Compliance Logs ──────────────────────────────────────────────
  app.get('/api/admin/compliance-logs', { preHandler: [adminGuard] }, async (request) => {
    const query = request.query as { eventType?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const conditions = [];
    if (query.eventType) conditions.push(eq(complianceLogs.eventType, query.eventType));

    const logs = await db
      .select()
      .from(complianceLogs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(complianceLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return { logs };
  });

  // ─── Auth Events ────────────────────────────────────────────────────
  app.get('/api/admin/auth-events', { preHandler: [adminGuard] }, async (request) => {
    const query = request.query as { userId?: string; eventType?: string; success?: string; limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit || '50'), 100);
    const offset = Math.max(parseInt(query.offset || '0'), 0);

    const conditions: any[] = [];
    if (query.userId) conditions.push(eq(authEvents.userId, query.userId));
    if (query.eventType) conditions.push(eq(authEvents.eventType, query.eventType));
    if (query.success === 'true') conditions.push(eq(authEvents.success, true));
    if (query.success === 'false') conditions.push(eq(authEvents.success, false));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [events, countResult] = await Promise.all([
      db.select({
        id: authEvents.id,
        userId: authEvents.userId,
        eventType: authEvents.eventType,
        ipAddress: authEvents.ipAddress,
        userAgent: authEvents.userAgent,
        success: authEvents.success,
        metadata: authEvents.metadata,
        createdAt: authEvents.createdAt,
      })
        .from(authEvents)
        .where(whereClause)
        .orderBy(desc(authEvents.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: sql<number>`count(*)::int` })
        .from(authEvents)
        .where(whereClause),
    ]);

    return { events, total: countResult[0]?.count ?? 0 };
  });

  // ─── KYC Status Management ──────────────────────────────────────────
  app.post('/api/admin/users/:id/kyc-status', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const body = kycStatusSchema.parse(request.body);

    // Atomic: row lock + state validation + update inside transaction
    const result = await db.transaction(async (tx) => {
      const lockResult = await tx.execute(
        sql`SELECT kyc_status FROM users WHERE id = ${id} FOR UPDATE`,
      ) as any;
      const rows = Array.isArray(lockResult) ? lockResult : lockResult?.rows ?? [];
      if (rows.length === 0) return { error: 'User not found', code: 404 } as const;

      const currentStatus = rows[0].kyc_status as string;

      // Validate state transition
      if (body.status === 'verified' && currentStatus === 'verified') {
        return { error: 'User is already verified', code: 409 } as const;
      }

      await tx.update(users).set({ kycStatus: body.status, updatedAt: new Date() }).where(eq(users.id, id));

      return { success: true, previousStatus: currentStatus } as const;
    });

    if ('error' in result && 'code' in result) {
      return reply.status(result.code as number).send({ error: result.error });
    }

    // Log to compliance (userId = admin who performed the action)
    await db.insert(complianceLogs).values({
      userId: request.userId,
      eventType: body.status === 'verified' ? 'kyc_approved' : 'kyc_rejected',
      payload: { targetUserId: id, note: body.note || null, previousStatus: result.previousStatus },
    });

    return { success: true, kycStatus: body.status };
  });

  // ─── KYC Documents ──────────────────────────────────────────────────
  app.get('/api/admin/users/:id/kyc-documents', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);
    const docs = await db.select().from(kycDocuments).where(eq(kycDocuments.userId, id)).orderBy(desc(kycDocuments.uploadedAt));
    return { documents: docs };
  });

  // ─── Staking Admin ──────────────────────────────────────────────────
  app.get('/api/admin/staking/positions', { preHandler: [adminGuard] }, async (request) => {
    const query = request.query as { userId?: string; asset?: string; status?: string; limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit || '50'), 100);
    const offset = Math.max(parseInt(query.offset || '0'), 0);

    const conditions: any[] = [];
    if (query.userId) conditions.push(eq(stakingPositions.userId, query.userId));
    if (query.asset) conditions.push(eq(stakingPositions.asset, query.asset));
    if (query.status) conditions.push(eq(stakingPositions.status, query.status));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const positions = await db.select({
      id: stakingPositions.id,
      userId: stakingPositions.userId,
      asset: stakingPositions.asset,
      amount: stakingPositions.amount,
      allocationPercent: stakingPositions.allocationPercent,
      status: stakingPositions.status,
      totalEarned: stakingPositions.totalEarned,
      startedAt: stakingPositions.startedAt,
      maturesAt: stakingPositions.maturesAt,
      lastAccrualAt: stakingPositions.lastAccrualAt,
      productId: stakingPositions.productId,
      apyPercent: stakingProducts.apyPercent,
      term: stakingProducts.term,
      lockDays: stakingProducts.lockDays,
      userEmail: users.email,
    })
      .from(stakingPositions)
      .leftJoin(stakingProducts, eq(stakingPositions.productId, stakingProducts.id))
      .leftJoin(users, eq(stakingPositions.userId, users.id))
      .where(whereClause)
      .orderBy(desc(stakingPositions.startedAt))
      .limit(limit)
      .offset(offset);

    return { positions };
  });

  app.get('/api/admin/staking/summary', { preHandler: [adminGuard] }, async () => {
    const result = await db.execute(sql`
      SELECT
        COUNT(*)::int AS "totalPositions",
        COUNT(*) FILTER (WHERE status = 'active')::int AS "activePositions",
        COALESCE(SUM(CASE WHEN status = 'active' THEN total_earned::numeric ELSE 0 END), 0)::text AS "totalEarningsPaid"
      FROM staking_positions
    `);
    const row = (result as any).rows?.[0] ?? result[0] ?? {};

    const byAsset = await db.execute(sql`
      SELECT asset, SUM(amount::numeric)::text AS "totalStaked", COUNT(*)::int AS positions
      FROM staking_positions WHERE status = 'active'
      GROUP BY asset ORDER BY asset
    `);

    return {
      totalPositions: row.totalPositions ?? 0,
      activePositions: row.activePositions ?? 0,
      totalEarningsPaid: row.totalEarningsPaid ?? '0',
      byAsset: (byAsset as any).rows ?? byAsset,
    };
  });

  // ─── Manual Deposit Credit (Admin) ─────────────────────────────────
  app.post('/api/admin/deposits/:id/manual-credit', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [adminGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const result = await db.transaction(async (tx) => {
      // Lock the deposit row
      const lockResult = await tx.execute(
        sql`SELECT * FROM deposits WHERE id = ${id} FOR UPDATE`,
      ) as any;
      const rows = Array.isArray(lockResult) ? lockResult : lockResult?.rows ?? [];
      if (rows.length === 0) return { error: 'Deposit not found', code: 404 } as const;

      const deposit = rows[0] as any;

      // Only allow manual credit for confirmed deposits that haven't been credited yet
      if (deposit.status === 'credited') {
        return { error: 'Deposit already credited', code: 400 } as const;
      }
      if (!['pending', 'confirming', 'confirmed'].includes(deposit.status)) {
        return { error: `Cannot credit deposit with status "${deposit.status}"`, code: 400 } as const;
      }

      // Mark as confirmed + credited
      await tx.execute(
        sql`UPDATE deposits SET status = 'credited', confirmed_at = NOW(), credited_at = NOW() WHERE id = ${id}`,
      );

      // Clear any pending deposit balance (idempotent)
      await mutateBalance(tx, {
        userId: deposit.user_id,
        asset: deposit.asset,
        field: 'pendingDeposit',
        amount: new Decimal(deposit.amount).negated().toFixed(18),
        entryType: 'deposit_pending_cleared',
        idempotencyKey: `deposit:${id}:clear_pending`,
        depositId: id,
        note: `Admin manual credit: cleared pending`,
      });

      // Credit available balance
      await mutateBalance(tx, {
        userId: deposit.user_id,
        asset: deposit.asset,
        field: 'available',
        amount: deposit.amount,
        entryType: 'deposit_confirmed',
        idempotencyKey: `deposit:${id}:credit`,
        depositId: id,
        note: `Admin manual credit: ${deposit.amount} ${deposit.asset}`,
      });

      // Notify user
      await tx.insert(notifications).values({
        userId: deposit.user_id,
        type: 'deposit_confirmed',
        title: 'Deposit Confirmed',
        message: `Your deposit of ${deposit.amount} ${deposit.asset} has been confirmed and credited to your account.`,
        metadata: { asset: deposit.asset, amount: deposit.amount, txHash: deposit.tx_hash },
      });

      return { success: true, userId: deposit.user_id, asset: deposit.asset, amount: deposit.amount } as const;
    });

    if ('error' in result && 'code' in result) {
      return reply.status(result.code as number).send({ error: result.error });
    }

    // Audit log
    await db.insert(complianceLogs).values({
      userId: request.userId,
      eventType: 'admin_manual_deposit_credit',
      payload: { depositId: id, creditedUserId: result.userId, asset: result.asset, amount: result.amount },
    });

    return { success: true, message: `Deposit of ${result.amount} ${result.asset} credited to user.` };
  });

  // ─── Skip Holding Period (Admin fast-tracks trade completion) ──────
  app.post('/api/admin/trades/:id/skip-holding', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    preHandler: [adminGuard],
  }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [trade] = await db.select().from(trades).where(eq(trades.id, id));
    if (!trade) return reply.status(404).send({ error: 'Trade not found' });

    if (trade.status !== 'payment_confirmed') {
      return reply.status(400).send({ error: `Trade is at "${trade.status}", expected payment_confirmed` });
    }

    // Set holdingUntil to now so the next processExpiredTrades cycle completes it
    await db
      .update(trades)
      .set({ holdingUntil: new Date(), updatedAt: new Date() })
      .where(eq(trades.id, id));

    // Audit log
    await db.insert(complianceLogs).values({
      userId: request.userId,
      tradeId: id,
      eventType: 'admin_skip_holding_period',
      payload: { tradeId: id, buyerId: trade.buyerId, sellerId: trade.sellerId },
    });

    return { success: true, message: 'Holding period skipped. Trade will complete on next processing cycle.' };
  });
}
