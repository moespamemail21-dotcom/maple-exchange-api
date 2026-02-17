import { db } from '../db/index.js';
import {
  stakingProducts,
  stakingPositions,
  earnings,
  balances,
} from '../db/schema.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { mutateBalance } from './balance.js';
import { getPrice, getPrices } from './price.js';
import { logger } from '../config/logger.js';
import Decimal from 'decimal.js';

// ─── Get All Enabled Staking Products ────────────────────────────────────────

export async function getStakingProducts(term?: string) {
  const conditions = [eq(stakingProducts.enabled, true)];
  if (term) conditions.push(eq(stakingProducts.term, term));

  return db
    .select()
    .from(stakingProducts)
    .where(and(...conditions))
    .orderBy(stakingProducts.asset);
}

// ─── Get User's Active Staking Positions ─────────────────────────────────────

export async function getUserPositions(userId: string) {
  return db
    .select({
      id: stakingPositions.id,
      asset: stakingPositions.asset,
      amount: stakingPositions.amount,
      allocationPercent: stakingPositions.allocationPercent,
      status: stakingPositions.status,
      totalEarned: stakingPositions.totalEarned,
      startedAt: stakingPositions.startedAt,
      maturesAt: stakingPositions.maturesAt,
      lastAccrualAt: stakingPositions.lastAccrualAt,
      // Product details
      productId: stakingPositions.productId,
      apyPercent: stakingProducts.apyPercent,
      term: stakingProducts.term,
      lockDays: stakingProducts.lockDays,
    })
    .from(stakingPositions)
    .innerJoin(stakingProducts, eq(stakingPositions.productId, stakingProducts.id))
    .where(
      and(
        eq(stakingPositions.userId, userId),
        eq(stakingPositions.status, 'active'),
      ),
    )
    .orderBy(desc(stakingPositions.startedAt));
}

// ─── Get Earn Summary (for the Earn tab header) ────────────────────────────

export async function getEarnSummary(userId: string) {
  // Get active positions
  const positions = await getUserPositions(userId);

  // Batch-fetch all prices at once
  const symbols = [...new Set(positions.map((p) => p.asset))];
  const priceMap = await getPrices(symbols);

  // Calculate total earn balance (staked amount in CAD) using Decimal.js
  let totalEarnCadValue = new Decimal(0);
  let totalEarnedAllTime = new Decimal(0);
  let estimatedMonthlyEarning = new Decimal(0);

  for (const pos of positions) {
    const cadPrice = new Decimal(priceMap.get(pos.asset)?.cadPrice ?? 0);
    const amount = new Decimal(pos.amount);
    const cadValue = amount.times(cadPrice);

    totalEarnCadValue = totalEarnCadValue.plus(cadValue);
    totalEarnedAllTime = totalEarnedAllTime.plus(new Decimal(pos.totalEarned).times(cadPrice));

    // Monthly earning estimate: (amount * APY / 100) / 12
    const apy = new Decimal(pos.apyPercent);
    const monthlyEarningCrypto = amount.times(apy).dividedBy(100).dividedBy(12);
    estimatedMonthlyEarning = estimatedMonthlyEarning.plus(monthlyEarningCrypto.times(cadPrice));
  }

  // This month's earnings
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const monthEarnings = await db
    .select({
      total: sql<string>`COALESCE(SUM(${earnings.cadValue}::numeric), 0)`,
    })
    .from(earnings)
    .where(
      and(
        eq(earnings.userId, userId),
        sql`${earnings.createdAt} >= ${startOfMonth.toISOString()}`,
      ),
    );

  const thisMonthCad = Number(monthEarnings[0]?.total ?? 0);

  return {
    totalEarnCadValue: totalEarnCadValue.toFixed(2),
    totalEarnedAllTime: totalEarnedAllTime.toFixed(2),
    estimatedMonthlyEarning: estimatedMonthlyEarning.toFixed(2),
    thisMonthEarning: Number(thisMonthCad).toFixed(2),
    activePositions: positions.length,
    positions,
  };
}

// ─── Stake Asset ─────────────────────────────────────────────────────────────

export async function stakeAsset(
  userId: string,
  productId: string,
  allocationPercent: number,
): Promise<{ success: boolean; positionId?: string; error?: string }> {
  // Get the product
  const [product] = await db
    .select()
    .from(stakingProducts)
    .where(eq(stakingProducts.id, productId));

  if (!product) return { success: false, error: 'Staking product not found' };
  if (!product.enabled) return { success: false, error: 'This staking product is currently unavailable' };

  const now = new Date();

  try {
    const positionId = await db.transaction(async (tx) => {
      // Lock the balance row FIRST to serialize concurrent staking requests
      const balanceRows = await tx.execute(
        sql`SELECT id, available FROM balances
            WHERE user_id = ${userId} AND asset = ${product.asset}
            FOR UPDATE`,
      ) as unknown as Array<{ id: string; available: string }>;

      // Check existing position AFTER lock — ensures we see committed data from concurrent txs
      const [existingPos] = await tx
        .select()
        .from(stakingPositions)
        .where(
          and(
            eq(stakingPositions.userId, userId),
            eq(stakingPositions.productId, productId),
            eq(stakingPositions.status, 'active'),
          ),
        );

      if (existingPos) {
        throw new Error('DUPLICATE_POSITION');
      }

      const balance = balanceRows[0];
      if (!balance) throw new Error('NO_BALANCE');

      const availableAmount = new Decimal(balance.available);
      const stakeAmount = availableAmount.times(allocationPercent).dividedBy(100);

      if (stakeAmount.isZero() || stakeAmount.isNegative()) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      if (stakeAmount.lt(product.minAmount)) {
        throw new Error(`MIN_AMOUNT:${product.minAmount}`);
      }

      // Calculate maturity date for term products
      let maturesAt: Date | null = null;
      if (product.lockDays > 0) {
        maturesAt = new Date(now.getTime() + product.lockDays * 24 * 60 * 60 * 1000);
      }

      // Create position FIRST to get a stable ID for idempotency keys.
      // (If the transaction rolls back, both the position and mutations are undone atomically.)
      const [position] = await tx
        .insert(stakingPositions)
        .values({
          userId,
          productId,
          asset: product.asset,
          amount: stakeAmount.toFixed(18),
          allocationPercent,
          status: 'active',
          totalEarned: '0',
          lastAccrualAt: now,
          startedAt: now,
          maturesAt,
        })
        .returning({ id: stakingPositions.id });

      // Lock the staked amount: available → locked
      // Idempotency keys use position.id (UUID) — unique per request, crash-safe
      await mutateBalance(tx, {
        userId,
        asset: product.asset,
        field: 'available',
        amount: stakeAmount.negated().toFixed(18),
        entryType: 'staking_lock',
        idempotencyKey: `stake:${position.id}:available`,
        note: `Staked ${stakeAmount.toFixed(8)} ${product.asset} (${allocationPercent}% allocation)`,
      });
      await mutateBalance(tx, {
        userId,
        asset: product.asset,
        field: 'locked',
        amount: stakeAmount.toFixed(18),
        entryType: 'staking_lock',
        idempotencyKey: `stake:${position.id}:locked`,
        note: `Staked ${stakeAmount.toFixed(8)} ${product.asset} (${allocationPercent}% allocation)`,
      });

      return position.id;
    });

    logger.info({ userId, productId, asset: product.asset, amount: allocationPercent }, 'staking position created');

    return { success: true, positionId };
  } catch (err: any) {
    if (err.message === 'DUPLICATE_POSITION') {
      return { success: false, error: 'You already have an active position for this product' };
    }
    if (err.message === 'NO_BALANCE') {
      return { success: false, error: 'No balance found for this asset' };
    }
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return { success: false, error: 'Insufficient balance to stake' };
    }
    if (err.message?.startsWith('MIN_AMOUNT:')) {
      const min = err.message.split(':')[1];
      return { success: false, error: `Minimum stake amount is ${min} ${product.asset}` };
    }
    throw err;
  }
}

// ─── Unstake Asset ───────────────────────────────────────────────────────────

export async function unstakeAsset(
  userId: string,
  positionId: string,
): Promise<{ success: boolean; error?: string }> {
  const now = new Date();

  try {
  const position = await db.transaction(async (tx) => {
    // Lock the position row to prevent concurrent unstakes
    const lockResult = await tx.execute(
      sql`SELECT * FROM staking_positions WHERE id = ${positionId} AND user_id = ${userId} FOR UPDATE`,
    ) as any;
    const rows = Array.isArray(lockResult) ? lockResult : lockResult?.rows ?? [];
    if (rows.length === 0) {
      throw new Error('POSITION_NOT_FOUND');
    }

    const pos = rows[0] as typeof stakingPositions.$inferSelect;

    if (pos.status !== 'active') {
      throw new Error('POSITION_NOT_ACTIVE');
    }

    // Check lock period for term products
    if (pos.maturesAt && now < new Date(pos.maturesAt)) {
      throw new Error('POSITION_LOCKED');
    }

    // Fetch product APY INSIDE the transaction to ensure it's consistent
    const [product] = await tx
      .select({ apyPercent: stakingProducts.apyPercent })
      .from(stakingProducts)
      .where(eq(stakingProducts.id, pos.productId));

    if (!product) {
      throw new Error('PRODUCT_NOT_FOUND');
    }

    // Calculate final earnings since last accrual
    const lastAccrualAt = new Date(pos.lastAccrualAt);
    const hoursSinceLastAccrual =
      (now.getTime() - lastAccrualAt.getTime()) / (1000 * 60 * 60);
    const dailyRate = new Decimal(product.apyPercent).dividedBy(365).dividedBy(100);
    const daysElapsed = new Decimal(hoursSinceLastAccrual).dividedBy(24);
    const finalReward = new Decimal(pos.amount).times(dailyRate).times(daysElapsed);
    // Credit final earnings if any
    if (finalReward.gt(0)) {
      await mutateBalance(tx, {
        userId,
        asset: pos.asset,
        field: 'available',
        amount: finalReward.toFixed(18),
        entryType: 'staking_reward',
        idempotencyKey: `earn:final:${positionId}`,
        note: `Final staking reward: ${finalReward.toFixed(8)} ${pos.asset}`,
      });

      const priceData = await getPrice(pos.asset);
      const cadValue = finalReward.times(priceData?.cadPrice ?? 0);

      await tx.insert(earnings).values({
        userId,
        positionId,
        asset: pos.asset,
        amount: finalReward.toFixed(18),
        cadValue: cadValue.toFixed(2),
        periodStart: lastAccrualAt,
        periodEnd: now,
      });
    }

    // Return staked amount: locked → available
    await mutateBalance(tx, {
      userId,
      asset: pos.asset,
      field: 'locked',
      amount: new Decimal(pos.amount).negated().toFixed(18),
      entryType: 'staking_unlock',
      idempotencyKey: `unstake:${positionId}:locked`,
      note: `Unstaked ${new Decimal(pos.amount).toFixed(8)} ${pos.asset}`,
    });
    await mutateBalance(tx, {
      userId,
      asset: pos.asset,
      field: 'available',
      amount: pos.amount,
      entryType: 'staking_unlock',
      idempotencyKey: `unstake:${positionId}:available`,
      note: `Unstaked ${new Decimal(pos.amount).toFixed(8)} ${pos.asset}`,
    });

    // Mark position as completed with final earned total
    const newTotalEarned = new Decimal(pos.totalEarned).plus(finalReward);
    await tx
      .update(stakingPositions)
      .set({ status: 'completed', completedAt: now, totalEarned: newTotalEarned.toFixed(18) })
      .where(eq(stakingPositions.id, positionId));

    return pos;
  });

  logger.info({ userId, positionId, asset: position.asset, amount: position.amount }, 'staking position unstaked');
  return { success: true };
  } catch (err: any) {
    if (err.message === 'PRODUCT_NOT_FOUND') {
      return { success: false, error: 'Staking product no longer exists. Contact support.' };
    }
    if (err.message === 'POSITION_NOT_FOUND') {
      return { success: false, error: 'Position not found' };
    }
    if (err.message === 'POSITION_NOT_ACTIVE') {
      return { success: false, error: 'Position is not active' };
    }
    if (err.message === 'POSITION_LOCKED') {
      return { success: false, error: 'This position is locked until maturity' };
    }
    throw err;
  }
}

// ─── Get Optimize Suggestions ────────────────────────────────────────────────

export async function getOptimizeSuggestions(userId: string) {
  // Get user's balances
  const userBalances = await db
    .select()
    .from(balances)
    .where(eq(balances.userId, userId));

  // Get active positions
  const activePositions = await getUserPositions(userId);
  const stakedAssets = new Set(activePositions.map((p) => p.asset));

  // Get all flexible products
  const products = await getStakingProducts('flexible');

  // Batch-fetch prices for all product assets
  const productSymbols = [...new Set(products.map((p) => p.asset))];
  const priceMap = await getPrices(productSymbols);

  // Suggest staking for assets with balance but no active position
  const suggestions = [];
  for (const product of products) {
    const balance = userBalances.find((b) => b.asset === product.asset);
    if (!balance) continue;

    const available = new Decimal(balance.available);
    if (available.lte(0)) continue;

    const cadPrice = new Decimal(priceMap.get(product.asset)?.cadPrice ?? 0);

    // Monthly earning estimate
    const monthlyEarning = available.times(product.apyPercent).dividedBy(100).dividedBy(12);

    suggestions.push({
      productId: product.id,
      asset: product.asset,
      type: 'Staking',
      term: product.term,
      apyPercent: product.apyPercent,
      availableBalance: balance.available,
      estimatedMonthlyEarning: monthlyEarning.toFixed(8),
      estimatedMonthlyEarningCad: monthlyEarning.times(cadPrice).toFixed(2),
      isAlreadyStaked: stakedAssets.has(product.asset),
      suggestedAllocation: stakedAssets.has(product.asset) ? 0 : 100,
    });
  }

  // Calculate total estimated monthly earning
  const totalMonthly = suggestions.reduce(
    (sum, s) => sum + Number(s.estimatedMonthlyEarningCad),
    0,
  );

  return {
    suggestions,
    totalEstimatedMonthlyEarning: totalMonthly.toFixed(2),
  };
}

// ─── Background Job: Accrue Earnings ─────────────────────────────────────────

let isAccruing = false;

export async function accrueEarnings(): Promise<number> {
  if (isAccruing) {
    logger.debug('Accrual already in progress, skipping');
    return 0;
  }

  try {
  isAccruing = true;
  const now = new Date();
  let accrued = 0;

  // Get all active positions that haven't been accrued in the last 23 hours
  const cutoff = new Date(now.getTime() - 23 * 60 * 60 * 1000);

  const activePositions = await db
    .select({
      id: stakingPositions.id,
      userId: stakingPositions.userId,
      asset: stakingPositions.asset,
      amount: stakingPositions.amount,
      lastAccrualAt: stakingPositions.lastAccrualAt,
      totalEarned: stakingPositions.totalEarned,
      apyPercent: stakingProducts.apyPercent,
    })
    .from(stakingPositions)
    .innerJoin(stakingProducts, eq(stakingPositions.productId, stakingProducts.id))
    .where(
      and(
        eq(stakingPositions.status, 'active'),
        sql`${stakingPositions.lastAccrualAt} < ${cutoff.toISOString()}`,
      ),
    );

  for (const pos of activePositions) {
    try {
      const hoursSinceLastAccrual =
        (now.getTime() - pos.lastAccrualAt.getTime()) / (1000 * 60 * 60);
      const dailyRate = new Decimal(pos.apyPercent).dividedBy(365).dividedBy(100);
      const daysElapsed = new Decimal(hoursSinceLastAccrual).dividedBy(24);
      const reward = new Decimal(pos.amount).times(dailyRate).times(daysElapsed);

      if (reward.isZero()) {
        // Still advance lastAccrualAt to prevent stale accrual windows
        await db
          .update(stakingPositions)
          .set({ lastAccrualAt: now })
          .where(eq(stakingPositions.id, pos.id));
        continue;
      }

      const priceData = await getPrice(pos.asset);
      const cadValue = reward.times(priceData?.cadPrice ?? 0);

      await db.transaction(async (tx) => {
        // Re-check position is still active inside transaction (prevents race with unstake)
        await tx.execute(sql`SELECT id FROM staking_positions WHERE id = ${pos.id} FOR UPDATE`);
        const [current] = await tx
          .select({ status: stakingPositions.status, lastAccrualAt: stakingPositions.lastAccrualAt })
          .from(stakingPositions)
          .where(eq(stakingPositions.id, pos.id));

        if (!current || current.status !== 'active') {
          return; // Position was unstaked between read and accrual — skip
        }

        // Credit reward to user's available balance
        await mutateBalance(tx, {
          userId: pos.userId,
          asset: pos.asset,
          field: 'available',
          amount: reward.toFixed(18),
          entryType: 'staking_reward',
          idempotencyKey: `earn:${pos.id}:${now.toISOString().slice(0, 10)}`,
          note: `Staking reward: ${reward.toFixed(8)} ${pos.asset}`,
        });

        // Record earning
        await tx.insert(earnings).values({
          userId: pos.userId,
          positionId: pos.id,
          asset: pos.asset,
          amount: reward.toFixed(18),
          cadValue: cadValue.toFixed(2),
          periodStart: pos.lastAccrualAt,
          periodEnd: now,
        });

        // Update position
        const newTotalEarned = new Decimal(pos.totalEarned).plus(reward);
        await tx
          .update(stakingPositions)
          .set({
            totalEarned: newTotalEarned.toFixed(18),
            lastAccrualAt: now,
          })
          .where(eq(stakingPositions.id, pos.id));
      });

      accrued++;
    } catch (err: any) {
      logger.error({ positionId: pos.id, err: err.message }, 'earnings accrual failed for position');
    }
  }

  logger.info({ positionsAccrued: accrued }, 'earnings accrual completed');

  return accrued;
  } finally {
    isAccruing = false;
  }
}

// ─── Seed Staking Products ──────────────────────────────────────────────────

export async function seedStakingProducts(): Promise<void> {
  const existing = await db.select({ id: stakingProducts.id }).from(stakingProducts).limit(1);
  if (existing.length > 0) return;

  const products = [
    // Flexible (withdraw any time)
    { asset: 'BTC', term: 'flexible', apyPercent: '1.50', lockDays: 0, minAmount: '0.00001' },
    { asset: 'ETH', term: 'flexible', apyPercent: '3.10', lockDays: 0, minAmount: '0.001' },
    { asset: 'SOL', term: 'flexible', apyPercent: '5.44', lockDays: 0, minAmount: '0.01' },
    { asset: 'LINK', term: 'flexible', apyPercent: '4.20', lockDays: 0, minAmount: '0.1' },
    { asset: 'LTC', term: 'flexible', apyPercent: '2.00', lockDays: 0, minAmount: '0.01' },
    { asset: 'XRP', term: 'flexible', apyPercent: '3.50', lockDays: 0, minAmount: '1' },

    // Short term (30 days)
    { asset: 'BTC', term: 'short', apyPercent: '2.50', lockDays: 30, minAmount: '0.00001' },
    { asset: 'ETH', term: 'short', apyPercent: '4.50', lockDays: 30, minAmount: '0.001' },
    { asset: 'SOL', term: 'short', apyPercent: '7.00', lockDays: 30, minAmount: '0.01' },

    // Long term (90 days)
    { asset: 'BTC', term: 'long', apyPercent: '3.50', lockDays: 90, minAmount: '0.00001' },
    { asset: 'ETH', term: 'long', apyPercent: '6.00', lockDays: 90, minAmount: '0.001' },
    { asset: 'SOL', term: 'long', apyPercent: '9.00', lockDays: 90, minAmount: '0.01' },
  ];

  await db.insert(stakingProducts).values(
    products.map((p) => ({
      asset: p.asset,
      term: p.term,
      apyPercent: p.apyPercent,
      lockDays: p.lockDays,
      minAmount: p.minAmount,
      maxAmount: '999999',
      enabled: true,
    })),
  );

  logger.info({ count: products.length }, 'seeded staking products');
}
