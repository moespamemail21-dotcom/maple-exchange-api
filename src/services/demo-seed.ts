import bcrypt from 'bcryptjs';
import { db } from '../db/index.js';
import {
  users,
  balances,
  orders,
  trades,
  stakingProducts,
  stakingPositions,
  notifications,
  portfolioSnapshots,
} from '../db/schema.js';
import { eq, and, count } from 'drizzle-orm';
import { claimPoolWallets } from './wallet-pool.js';
import { initializeUserBalances, SUPPORTED_ASSETS } from './balance.js';
import { PLATFORM_USER_ID } from './platform.js';
import { logger } from '../config/logger.js';

const DEMO_EMAIL = 'demo@maple.exchange';
const DEMO_PASSWORD = 'Maple123!';
const SALT_ROUNDS = 12;

/**
 * Seed a demo user with rich test data (balances, trades, staking, notifications, snapshots).
 * Idempotent — skips if demo@maple.exchange already exists.
 * Only call in development.
 */
export async function seedDemoUser(): Promise<void> {
  // Check if already exists
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEMO_EMAIL));

  if (existing) {
    logger.debug('Demo user already exists, enriching data');
    await enrichDemoUser(existing.id);
    return;
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, SALT_ROUNDS);

  const userId = await db.transaction(async (tx) => {
    // 1. Create user
    const [user] = await tx
      .insert(users)
      .values({
        email: DEMO_EMAIL,
        passwordHash,
        displayName: 'Demo User',
        kycStatus: 'verified',
        kycVideoStatus: 'approved',
        autodepositVerified: true,
        tradeCount: 5,
        completionRate: '100.00',
        maxTradeLimit: '5000.00',
        interacEmail: 'demo@maple.exchange',
        fullLegalName: 'Demo User',
        city: 'Toronto',
        province: 'ON',
        postalCode: 'M5V 2T6',
        occupation: 'Software Developer',
      })
      .returning({ id: users.id });

    // 2. Claim pool wallets (one per chain)
    await claimPoolWallets(tx, user.id);

    // 3. Initialize balance rows (all zeros)
    await initializeUserBalances(tx, user.id);

    return user.id;
  });

  // 4. Update balances to sample amounts (outside tx to avoid nested tx issues)
  const sampleBalances: Record<string, string> = {
    BTC: '0.05',
    ETH: '1.2',
    SOL: '25.0',
    LINK: '100.0',
    LTC: '5.0',
    XRP: '500.0',
  };

  for (const [asset, amount] of Object.entries(sampleBalances)) {
    await db
      .update(balances)
      .set({ available: amount, updatedAt: new Date() })
      .where(and(eq(balances.userId, userId), eq(balances.asset, asset)));
  }

  // 5. Create sample completed trades (platform as counterparty)
  const now = Date.now();
  const tradeData = [
    {
      asset: 'BTC',
      amountCrypto: '0.02',
      amountFiat: '2450.00',
      pricePerUnit: '122500.00',
      type: 'buy' as const,
      daysAgo: 7,
    },
    {
      asset: 'ETH',
      amountCrypto: '0.5',
      amountFiat: '2125.00',
      pricePerUnit: '4250.00',
      type: 'buy' as const,
      daysAgo: 5,
    },
    {
      asset: 'SOL',
      amountCrypto: '10.0',
      amountFiat: '2800.00',
      pricePerUnit: '280.00',
      type: 'buy' as const,
      daysAgo: 3,
    },
    {
      asset: 'LINK',
      amountCrypto: '50.0',
      amountFiat: '925.00',
      pricePerUnit: '18.50',
      type: 'sell' as const,
      daysAgo: 2,
    },
    {
      asset: 'LTC',
      amountCrypto: '2.0',
      amountFiat: '340.00',
      pricePerUnit: '170.00',
      type: 'buy' as const,
      daysAgo: 1,
    },
  ];

  for (const t of tradeData) {
    const createdAt = new Date(now - t.daysAgo * 24 * 60 * 60 * 1000);
    const completedAt = new Date(createdAt.getTime() + 15 * 60 * 1000); // 15 min after creation

    const buyerId = t.type === 'buy' ? userId : PLATFORM_USER_ID;
    const sellerId = t.type === 'sell' ? userId : PLATFORM_USER_ID;

    // Create an order for the trade
    const [order] = await db
      .insert(orders)
      .values({
        userId: sellerId,
        type: 'sell',
        cryptoAsset: t.asset,
        amountCrypto: t.amountCrypto,
        amountFiat: t.amountFiat,
        remainingFiat: '0',
        status: 'filled',
        createdAt,
        updatedAt: completedAt,
      })
      .returning({ id: orders.id });

    await db.insert(trades).values({
      orderId: order.id,
      buyerId,
      sellerId,
      cryptoAsset: t.asset,
      amountCrypto: t.amountCrypto,
      amountFiat: t.amountFiat,
      pricePerUnit: t.pricePerUnit,
      feePercent: '1.50',
      feeAmount: (parseFloat(t.amountCrypto) * 0.015).toFixed(8),
      status: 'completed',
      escrowFundedAt: createdAt,
      paymentSentAt: new Date(createdAt.getTime() + 5 * 60 * 1000),
      paymentConfirmedAt: new Date(createdAt.getTime() + 10 * 60 * 1000),
      cryptoReleasedAt: new Date(createdAt.getTime() + 12 * 60 * 1000),
      completedAt,
      createdAt,
      updatedAt: completedAt,
    });
  }

  // 6. Create staking positions (flexible BTC + short-term ETH)
  const [btcProduct] = await db
    .select()
    .from(stakingProducts)
    .where(and(eq(stakingProducts.asset, 'BTC'), eq(stakingProducts.term, 'flexible')));

  const [ethProduct] = await db
    .select()
    .from(stakingProducts)
    .where(and(eq(stakingProducts.asset, 'ETH'), eq(stakingProducts.term, 'short')));

  if (btcProduct) {
    await db.insert(stakingPositions).values({
      userId,
      productId: btcProduct.id,
      asset: 'BTC',
      amount: '0.01',
      allocationPercent: 20,
      status: 'active',
      totalEarned: '0.00002100',
      lastAccrualAt: new Date(now - 6 * 60 * 60 * 1000),
      startedAt: new Date(now - 14 * 24 * 60 * 60 * 1000), // 14 days ago
    });
  }

  if (ethProduct) {
    await db.insert(stakingPositions).values({
      userId,
      productId: ethProduct.id,
      asset: 'ETH',
      amount: '0.3',
      allocationPercent: 25,
      status: 'active',
      totalEarned: '0.00045000',
      lastAccrualAt: new Date(now - 6 * 60 * 60 * 1000),
      startedAt: new Date(now - 10 * 24 * 60 * 60 * 1000), // 10 days ago
      maturesAt: new Date(now + 20 * 24 * 60 * 60 * 1000), // matures in 20 days
    });
  }

  // 7. Notifications for the demo user
  const demoNotifications = [
    {
      userId,
      type: 'system',
      title: 'Welcome to Maple Exchange!',
      message: 'Your account is verified and ready to trade. Buy, sell, and earn crypto with Interac e-Transfer.',
      isRead: false,
      metadata: {},
      createdAt: new Date(now - 2 * 60 * 1000),
    },
    {
      userId,
      type: 'deposit_confirmed',
      title: 'Deposit Confirmed',
      message: 'Your deposit of 0.05 BTC has been confirmed and credited to your account.',
      isRead: false,
      metadata: { asset: 'BTC', amount: '0.05' },
      createdAt: new Date(now - 30 * 60 * 1000),
    },
    {
      userId,
      type: 'trade_filled',
      title: 'Trade Completed',
      message: 'Your buy order for 0.5 ETH at $4,250.00 CAD has been filled.',
      isRead: true,
      metadata: { asset: 'ETH', amount: '0.5', fiat: '2125.00' },
      createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
    },
    {
      userId,
      type: 'staking_reward',
      title: 'Staking Reward Earned',
      message: 'You earned 0.000021 BTC from your Bitcoin staking position.',
      isRead: true,
      metadata: { asset: 'BTC', reward: '0.000021' },
      createdAt: new Date(now - 6 * 60 * 60 * 1000),
    },
    {
      userId,
      type: 'price_alert',
      title: 'BTC Price Alert',
      message: 'Bitcoin has risen above $125,000 CAD. Your price alert has been triggered.',
      isRead: true,
      metadata: { asset: 'BTC', threshold: '125000', direction: 'above' },
      createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
    },
  ];

  await db.insert(notifications).values(demoNotifications);

  // 8. Portfolio snapshots for the performance chart (7 days of data)
  const snapshotValues = [
    { daysAgo: 7, total: '8500.00' },
    { daysAgo: 6, total: '8750.00' },
    { daysAgo: 5, total: '9100.00' },
    { daysAgo: 4, total: '8900.00' },
    { daysAgo: 3, total: '9400.00' },
    { daysAgo: 2, total: '9250.00' },
    { daysAgo: 1, total: '9600.00' },
    { daysAgo: 0, total: '9800.00' },
  ];

  for (const snap of snapshotValues) {
    await db.insert(portfolioSnapshots).values({
      userId,
      totalCadValue: snap.total,
      assets: [
        { asset: 'BTC', amount: '0.05', cadPrice: '122500.00', cadValue: '6125.00' },
        { asset: 'ETH', amount: '1.2', cadPrice: '4250.00', cadValue: '5100.00' },
        { asset: 'SOL', amount: '25.0', cadPrice: '280.00', cadValue: '7000.00' },
      ],
      createdAt: new Date(now - snap.daysAgo * 24 * 60 * 60 * 1000),
    });
  }

  logger.info('Demo user seeded: demo@maple.exchange / Maple123!');
}

/**
 * Enrich an existing demo user — update KYC status, add notifications,
 * staking positions, and portfolio snapshots if missing.
 */
async function enrichDemoUser(userId: string): Promise<void> {
  // Update KYC to verified so the banner goes away
  await db
    .update(users)
    .set({
      kycStatus: 'verified',
      kycVideoStatus: 'approved',
      autodepositVerified: true,
      maxTradeLimit: '5000.00',
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  const now = Date.now();

  // Add notifications if none exist
  const [notifCount] = await db
    .select({ value: count() })
    .from(notifications)
    .where(eq(notifications.userId, userId));

  if ((notifCount?.value ?? 0) === 0) {
    await db.insert(notifications).values([
      {
        userId,
        type: 'system',
        title: 'Welcome to Maple Exchange!',
        message: 'Your account is verified and ready to trade. Buy, sell, and earn crypto with Interac e-Transfer.',
        isRead: false,
        metadata: {},
        createdAt: new Date(now - 2 * 60 * 1000),
      },
      {
        userId,
        type: 'deposit_confirmed',
        title: 'Deposit Confirmed',
        message: 'Your deposit of 0.05 BTC has been confirmed and credited to your account.',
        isRead: false,
        metadata: { asset: 'BTC', amount: '0.05' },
        createdAt: new Date(now - 30 * 60 * 1000),
      },
      {
        userId,
        type: 'trade_filled',
        title: 'Trade Completed',
        message: 'Your buy order for 0.5 ETH at $4,250.00 CAD has been filled.',
        isRead: true,
        metadata: { asset: 'ETH', amount: '0.5', fiat: '2125.00' },
        createdAt: new Date(now - 5 * 24 * 60 * 60 * 1000),
      },
      {
        userId,
        type: 'staking_reward',
        title: 'Staking Reward Earned',
        message: 'You earned 0.000021 BTC from your Bitcoin staking position.',
        isRead: true,
        metadata: { asset: 'BTC', reward: '0.000021' },
        createdAt: new Date(now - 6 * 60 * 60 * 1000),
      },
      {
        userId,
        type: 'price_alert',
        title: 'BTC Price Alert',
        message: 'Bitcoin has risen above $125,000 CAD. Your price alert has been triggered.',
        isRead: true,
        metadata: { asset: 'BTC', threshold: '125000', direction: 'above' },
        createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      },
    ]);
    logger.info('Seeded demo user notifications');
  }

  // Add staking positions if none exist
  const [posCount] = await db
    .select({ value: count() })
    .from(stakingPositions)
    .where(and(eq(stakingPositions.userId, userId), eq(stakingPositions.status, 'active')));

  if ((posCount?.value ?? 0) === 0) {
    const [btcProduct] = await db
      .select()
      .from(stakingProducts)
      .where(and(eq(stakingProducts.asset, 'BTC'), eq(stakingProducts.term, 'flexible')));

    const [ethProduct] = await db
      .select()
      .from(stakingProducts)
      .where(and(eq(stakingProducts.asset, 'ETH'), eq(stakingProducts.term, 'short')));

    if (btcProduct) {
      await db.insert(stakingPositions).values({
        userId,
        productId: btcProduct.id,
        asset: 'BTC',
        amount: '0.01',
        allocationPercent: 20,
        status: 'active',
        totalEarned: '0.00002100',
        lastAccrualAt: new Date(now - 6 * 60 * 60 * 1000),
        startedAt: new Date(now - 14 * 24 * 60 * 60 * 1000),
      });
    }

    if (ethProduct) {
      await db.insert(stakingPositions).values({
        userId,
        productId: ethProduct.id,
        asset: 'ETH',
        amount: '0.3',
        allocationPercent: 25,
        status: 'active',
        totalEarned: '0.00045000',
        lastAccrualAt: new Date(now - 6 * 60 * 60 * 1000),
        startedAt: new Date(now - 10 * 24 * 60 * 60 * 1000),
        maturesAt: new Date(now + 20 * 24 * 60 * 60 * 1000),
      });
    }
    logger.info('Seeded demo user staking positions');
  }

  // Add portfolio snapshots if none exist
  const [snapCount] = await db
    .select({ value: count() })
    .from(portfolioSnapshots)
    .where(eq(portfolioSnapshots.userId, userId));

  if ((snapCount?.value ?? 0) === 0) {
    const snapshotValues = [
      { daysAgo: 7, total: '8500.00' },
      { daysAgo: 6, total: '8750.00' },
      { daysAgo: 5, total: '9100.00' },
      { daysAgo: 4, total: '8900.00' },
      { daysAgo: 3, total: '9400.00' },
      { daysAgo: 2, total: '9250.00' },
      { daysAgo: 1, total: '9600.00' },
      { daysAgo: 0, total: '9800.00' },
    ];

    for (const snap of snapshotValues) {
      await db.insert(portfolioSnapshots).values({
        userId,
        totalCadValue: snap.total,
        assets: [
          { asset: 'BTC', amount: '0.05', cadPrice: '122500.00', cadValue: '6125.00' },
          { asset: 'ETH', amount: '1.2', cadPrice: '4250.00', cadValue: '5100.00' },
          { asset: 'SOL', amount: '25.0', cadPrice: '280.00', cadValue: '7000.00' },
        ],
        createdAt: new Date(now - snap.daysAgo * 24 * 60 * 60 * 1000),
      });
    }
    logger.info('Seeded demo user portfolio snapshots');
  }
}
