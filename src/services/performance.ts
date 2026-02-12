import { db } from '../db/index.js';
import { portfolioSnapshots, balances } from '../db/schema.js';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import { getPrice, getPrices } from './price.js';
import { SUPPORTED_ASSETS } from './balance.js';
import Decimal from 'decimal.js';

// ─── Time Range Definitions ─────────────────────────────────────────────────

const RANGE_HOURS: Record<string, number> = {
  '24h': 24,
  '1w': 168,
  '1m': 720,
  '3m': 2160,
  '6m': 4320,
  'all': 87600, // ~10 years (effectively all)
};

// ─── Capture Portfolio Snapshot ──────────────────────────────────────────────

/**
 * Capture a snapshot of a user's portfolio. Run periodically (every hour).
 * Only captures if the user has a non-zero total.
 */
export async function captureSnapshot(userId: string): Promise<boolean> {
  const userBalances = await db
    .select()
    .from(balances)
    .where(eq(balances.userId, userId));

  const assetSnapshots: Array<{
    asset: string;
    amount: string;
    cadPrice: string;
    cadValue: string;
  }> = [];

  let totalCadValue = new Decimal(0);

  // Batch-fetch all prices at once
  const symbols = userBalances.map((b) => b.asset);
  const priceMap = await getPrices(symbols);

  for (const bal of userBalances) {
    const total = new Decimal(bal.available).plus(bal.locked);
    if (total.isZero()) continue;

    const cadPrice = priceMap.get(bal.asset)?.cadPrice ?? 0;
    const cadValue = total.times(cadPrice);

    totalCadValue = totalCadValue.plus(cadValue);

    assetSnapshots.push({
      asset: bal.asset,
      amount: total.toFixed(18),
      cadPrice: String(cadPrice),
      cadValue: cadValue.toFixed(2),
    });
  }

  // Don't snapshot empty portfolios
  if (totalCadValue.isZero()) return false;

  await db.insert(portfolioSnapshots).values({
    userId,
    totalCadValue: totalCadValue.toFixed(2),
    assets: assetSnapshots,
  });

  return true;
}

// ─── Capture Snapshots for All Active Users ─────────────────────────────────

/**
 * Run this as a background job every hour.
 * Captures snapshots for all users with non-zero balances.
 */
export async function captureAllSnapshots(): Promise<number> {
  // Find all users with non-zero balances
  const usersWithBalance = await db
    .selectDistinct({ userId: balances.userId })
    .from(balances)
    .where(
      sql`(${balances.available}::numeric + ${balances.locked}::numeric) > 0`,
    );

  let captured = 0;
  for (const { userId } of usersWithBalance) {
    // Skip platform user
    if (userId === '00000000-0000-0000-0000-000000000001') continue;

    try {
      const snapped = await captureSnapshot(userId);
      if (snapped) captured++;
    } catch (err: any) {
      console.error(`Snapshot failed for user ${userId}:`, err.message);
    }
  }
  return captured;
}

// ─── Get Performance Data ────────────────────────────────────────────────────

export async function getPerformance(userId: string, range: string = '24h') {
  const hours = RANGE_HOURS[range] ?? 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  // Get snapshots for the range
  const snapshots = await db
    .select({
      totalCadValue: portfolioSnapshots.totalCadValue,
      assets: portfolioSnapshots.assets,
      createdAt: portfolioSnapshots.createdAt,
    })
    .from(portfolioSnapshots)
    .where(
      and(
        eq(portfolioSnapshots.userId, userId),
        gte(portfolioSnapshots.createdAt, since),
      ),
    )
    .orderBy(portfolioSnapshots.createdAt);

  // Current portfolio value
  const userBalances = await db
    .select()
    .from(balances)
    .where(eq(balances.userId, userId));

  let currentTotal = new Decimal(0);
  const currentAssets: Record<string, { amount: string; cadValue: string; cadPrice: number }> = {};

  // Batch-fetch all prices at once
  const balanceSymbols = userBalances.map((b) => b.asset);
  const priceMap = await getPrices(balanceSymbols);

  for (const bal of userBalances) {
    const total = new Decimal(bal.available).plus(bal.locked);
    if (total.isZero()) continue;

    const cadPrice = priceMap.get(bal.asset)?.cadPrice ?? 0;
    const cadValue = total.times(cadPrice);

    currentTotal = currentTotal.plus(cadValue);
    currentAssets[bal.asset] = {
      amount: total.toFixed(18),
      cadValue: cadValue.toFixed(2),
      cadPrice,
    };
  }

  // Calculate P&L
  const startValue = snapshots.length > 0 ? Number(snapshots[0].totalCadValue) : Number(currentTotal.toFixed(2));
  const currentValue = Number(currentTotal.toFixed(2));
  const pnlAmount = currentValue - startValue;
  const pnlPercent = startValue > 0 ? (pnlAmount / startValue) * 100 : 0;

  // Build chart points
  const chartPoints = snapshots.map((s) => ({
    value: Number(s.totalCadValue),
    timestamp: s.createdAt.toISOString(),
  }));

  // Add current point
  chartPoints.push({
    value: currentValue,
    timestamp: new Date().toISOString(),
  });

  // Per-asset P&L
  const assetPerformance = [];
  for (const [asset, current] of Object.entries(currentAssets)) {
    // Find starting value for this asset
    let startAssetValue = 0;
    if (snapshots.length > 0 && snapshots[0].assets) {
      const startAsset = (snapshots[0].assets as any[]).find(
        (a: any) => a.asset === asset,
      );
      if (startAsset) startAssetValue = Number(startAsset.cadValue);
    }

    const assetPnlAmount = Number(current.cadValue) - startAssetValue;
    const assetPnlPercent = startAssetValue > 0
      ? (assetPnlAmount / startAssetValue) * 100
      : 0;

    assetPerformance.push({
      asset,
      currentCadValue: current.cadValue,
      pnlAmount: assetPnlAmount.toFixed(2),
      pnlPercent: assetPnlPercent.toFixed(2),
    });
  }

  // Sort by absolute P&L
  assetPerformance.sort((a, b) => Math.abs(Number(b.pnlAmount)) - Math.abs(Number(a.pnlAmount)));

  return {
    currentValue: currentValue.toFixed(2),
    startValue: startValue.toFixed(2),
    pnlAmount: pnlAmount.toFixed(2),
    pnlPercent: pnlPercent.toFixed(2),
    range,
    chartPoints,
    assetPerformance,
  };
}

// ─── Get Portfolio Allocations ───────────────────────────────────────────────

export async function getAllocations(userId: string) {
  const userBalances = await db
    .select()
    .from(balances)
    .where(eq(balances.userId, userId));

  let totalCadValue = new Decimal(0);
  const items: Array<{
    asset: string;
    amount: string;
    cadValue: string;
    cadPrice: string;
    percentage: string;
  }> = [];

  // Batch-fetch all prices at once
  const allocSymbols = userBalances.map((b) => b.asset);
  const allocPriceMap = await getPrices(allocSymbols);

  // First pass: compute totals
  const enriched = [];
  for (const bal of userBalances) {
    const total = new Decimal(bal.available).plus(bal.locked);
    if (total.isZero()) continue;

    const cadPrice = allocPriceMap.get(bal.asset)?.cadPrice ?? 0;
    const cadValue = total.times(cadPrice);
    totalCadValue = totalCadValue.plus(cadValue);

    enriched.push({ asset: bal.asset, amount: total, cadValue, cadPrice });
  }

  // Second pass: compute percentages
  for (const e of enriched) {
    const pct = totalCadValue.isZero()
      ? new Decimal(0)
      : e.cadValue.dividedBy(totalCadValue).times(100);

    items.push({
      asset: e.asset,
      amount: e.amount.toFixed(18),
      cadValue: e.cadValue.toFixed(2),
      cadPrice: String(e.cadPrice),
      percentage: pct.toFixed(2),
    });
  }

  // Sort by percentage descending
  items.sort((a, b) => Number(b.percentage) - Number(a.percentage));

  return {
    totalCadValue: totalCadValue.toFixed(2),
    allocations: items,
  };
}
