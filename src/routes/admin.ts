import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { trades, disputes, balances, users, complianceLogs, withdrawals, wallets, orders } from '../db/schema.js';
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
    const { id } = request.params as { id: string };

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
  app.post('/api/admin/disputes/:id/resolve', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
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
  app.post('/api/admin/trades/:id/verify-payment', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [trade] = await db.select().from(trades).where(eq(trades.id, id));
    if (!trade) return reply.status(404).send({ error: 'Trade not found' });

    if (!['payment_sent', 'payment_confirmed'].includes(trade.status)) {
      return reply.status(400).send({ error: `Trade is at "${trade.status}", expected payment_sent or payment_confirmed` });
    }

    if (trade.sellerId === PLATFORM_USER_ID) {
      // Platform trade: advance to payment_confirmed first if needed, then complete
      if (trade.status === 'payment_sent') {
        await db.update(trades).set({
          status: 'payment_confirmed',
          paymentConfirmedAt: new Date(),
          holdingUntil: new Date(),
          updatedAt: new Date(),
        }).where(eq(trades.id, id));
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
    const query = request.query as { status?: string; limit?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);

    const statusFilter = query.status ? sql`AND t.status = ${query.status}` : sql``;
    const rows = await db.execute(
      sql`SELECT t.*,
                 b.email AS buyer_email, b.display_name AS buyer_display_name,
                 s.email AS seller_email, s.display_name AS seller_display_name
          FROM trades t
          LEFT JOIN users b ON b.id = t.buyer_id
          LEFT JOIN users s ON s.id = t.seller_id
          WHERE 1=1 ${statusFilter}
          ORDER BY t.created_at DESC
          LIMIT ${limit}`,
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
  app.post('/api/admin/wallets/recover-key', { preHandler: [adminGuard] }, async (request, reply) => {
    const { walletId } = request.body as { walletId: string };
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
    const [feeTotal] = await db.execute(
      sql`SELECT asset, SUM(amount::numeric) as total_fees
          FROM balance_ledger
          WHERE user_id = ${PLATFORM_USER_ID} AND entry_type = 'fee_credit'
          GROUP BY asset`,
    ) as any[] ?? [];

    return {
      balances: platformBalances,
      feeTotals: feeTotal ?? [],
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
      const pattern = `%${query.search}%`;
      conditions.push(sql`(${users.email} ILIKE ${pattern} OR ${users.displayName} ILIKE ${pattern})`);
    }
    if (query.kycStatus) {
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
    const { id } = request.params as { id: string };

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

    return { user, balances: userBalances, wallets: userWallets, recentTrades, orders: userOrders };
  });

  // ─── Single Trade Detail ──────────────────────────────────────────
  app.get('/api/admin/trades/:id', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };

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
    const offset = Number(query.offset) || 0;

    const conditions = [];
    if (query.status) conditions.push(eq(withdrawals.status, query.status));

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
  app.post('/api/admin/withdrawals/:id/approve', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const [withdrawal] = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
    if (!withdrawal) return reply.status(404).send({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending_review') {
      return reply.status(400).send({ error: `Cannot approve: status is "${withdrawal.status}", expected "pending_review"` });
    }

    await db
      .update(withdrawals)
      .set({ status: 'approved', approvedAt: new Date() })
      .where(eq(withdrawals.id, id));

    await db.insert(complianceLogs).values({
      userId: request.userId,
      eventType: 'admin_withdrawal_approved',
      payload: {
        withdrawalId: id,
        withdrawalUserId: withdrawal.userId,
        asset: withdrawal.asset,
        amount: withdrawal.amount,
        toAddress: withdrawal.toAddress,
      },
    });

    return { success: true, message: 'Withdrawal approved and queued for broadcasting.' };
  });

  // ─── Reject Withdrawal ────────────────────────────────────────────
  app.post('/api/admin/withdrawals/:id/reject', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body as { reason?: string }) ?? {};

    const [withdrawal] = await db.select().from(withdrawals).where(eq(withdrawals.id, id));
    if (!withdrawal) return reply.status(404).send({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending_review') {
      return reply.status(400).send({ error: `Cannot reject: status is "${withdrawal.status}", expected "pending_review"` });
    }

    await db.transaction(async (tx) => {
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
    });

    await db.insert(complianceLogs).values({
      userId: request.userId,
      eventType: 'admin_withdrawal_rejected',
      payload: {
        withdrawalId: id,
        withdrawalUserId: withdrawal.userId,
        asset: withdrawal.asset,
        amount: withdrawal.amount,
        reason: reason ?? null,
      },
    });

    return { success: true, message: 'Withdrawal rejected. Funds returned to user.' };
  });

  // ─── Order Book (Admin) ──────────────────────────────────────────
  app.get('/api/admin/orders', { preHandler: [adminGuard] }, async (request) => {
    const query = request.query as { status?: string; type?: string; asset?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Number(query.offset) || 0;

    const filters: string[] = [];
    const statusFilter = query.status ? sql`AND o.status = ${query.status}` : sql``;
    const typeFilter = query.type ? sql`AND o.type = ${query.type}` : sql``;
    const assetFilter = query.asset ? sql`AND o.crypto_asset = ${query.asset}` : sql``;

    const rows = await db.execute(
      sql`SELECT o.*,
                 u.email AS user_email, u.display_name AS user_display_name
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
  app.post('/api/admin/trades/:id/reject-payment', { preHandler: [adminGuard] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body as { reason?: string }) ?? {};

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
  app.post('/api/admin/orders/manual-match', { preHandler: [adminGuard] }, async (request, reply) => {
    const { buyOrderId, sellOrderId } = request.body as { buyOrderId: string; sellOrderId: string };
    if (!buyOrderId || !sellOrderId) {
      return reply.status(400).send({ error: 'buyOrderId and sellOrderId are required' });
    }

    const [buyOrder] = await db.select().from(orders).where(eq(orders.id, buyOrderId));
    const [sellOrder] = await db.select().from(orders).where(eq(orders.id, sellOrderId));

    if (!buyOrder) return reply.status(404).send({ error: 'Buy order not found' });
    if (!sellOrder) return reply.status(404).send({ error: 'Sell order not found' });
    if (buyOrder.status !== 'active') return reply.status(400).send({ error: `Buy order is "${buyOrder.status}", must be active` });
    if (sellOrder.status !== 'active') return reply.status(400).send({ error: `Sell order is "${sellOrder.status}", must be active` });
    if (buyOrder.type !== 'buy') return reply.status(400).send({ error: 'First order must be a buy order' });
    if (sellOrder.type !== 'sell') return reply.status(400).send({ error: 'Second order must be a sell order' });
    if (buyOrder.cryptoAsset !== sellOrder.cryptoAsset) {
      return reply.status(400).send({ error: `Asset mismatch: buy=${buyOrder.cryptoAsset}, sell=${sellOrder.cryptoAsset}` });
    }
    if (buyOrder.userId === sellOrder.userId) {
      return reply.status(400).send({ error: 'Cannot match orders from the same user' });
    }

    const asset = sellOrder.cryptoAsset;

    // Resolve price from seller's terms
    const priceData = await getPrice(asset);
    if (!priceData) return reply.status(400).send({ error: `No price data for ${asset}` });

    let pricePerUnit: number;
    if (sellOrder.priceType === 'fixed' && sellOrder.fixedPrice) {
      pricePerUnit = Number(sellOrder.fixedPrice);
    } else {
      const premium = new Decimal(sellOrder.pricePremium ?? 0);
      pricePerUnit = new Decimal(priceData.cadPrice).times(premium.dividedBy(100).plus(1)).toNumber();
    }

    // Fill amount = min of both remaining + random cents for e-transfer disambiguation
    const fillFiat = Math.min(Number(buyOrder.remainingFiat), Number(sellOrder.remainingFiat));
    const randomCents = Math.floor(Math.random() * 99) / 100;
    const finalFiat = new Decimal(fillFiat).plus(randomCents).toNumber();
    const amountCrypto = new Decimal(finalFiat).dividedBy(pricePerUnit).toDecimalPlaces(8).toNumber();

    const feePercent = env.TAKER_FEE_PERCENT;
    const feeAmount = new Decimal(amountCrypto).times(feePercent).dividedBy(100).toDecimalPlaces(8).toNumber();

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
    const offset = Number(query.offset) || 0;

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
}
