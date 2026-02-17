import { db } from '../db/index.js';
import { notifications } from '../db/schema.js';
import { eq, count } from 'drizzle-orm';
import { PLATFORM_USER_ID } from './platform.js';
import { logger } from '../config/logger.js';

/**
 * Seed sample notifications for the platform user.
 * Idempotent — only seeds if the user has zero notifications.
 */
export async function seedNotifications(): Promise<void> {
  const [existing] = await db
    .select({ value: count() })
    .from(notifications)
    .where(eq(notifications.userId, PLATFORM_USER_ID));

  if ((existing?.value ?? 0) > 0) return;

  const now = Date.now();

  const samples = [
    {
      userId: PLATFORM_USER_ID,
      type: 'system',
      title: 'Welcome to Maple Exchange!',
      message: 'Your account has been created. Complete verification to start trading crypto with Interac e-Transfer.',
      isRead: false,
      metadata: {},
      createdAt: new Date(now - 2 * 60 * 1000), // 2 min ago
    },
    {
      userId: PLATFORM_USER_ID,
      type: 'system',
      title: 'Complete Verification',
      message: 'Verify your identity to unlock trading. It only takes 2 minutes.',
      isRead: false,
      metadata: {},
      createdAt: new Date(now - 5 * 60 * 1000), // 5 min ago
    },
    {
      userId: PLATFORM_USER_ID,
      type: 'deposit_confirmed',
      title: 'Deposit Confirmed',
      message: 'Your deposit of 0.05 BTC has been confirmed and credited to your account.',
      isRead: false,
      metadata: { asset: 'BTC', amount: '0.05' },
      createdAt: new Date(now - 30 * 60 * 1000), // 30 min ago
    },
    {
      userId: PLATFORM_USER_ID,
      type: 'trade_filled',
      title: 'Trade Completed',
      message: 'Your buy order for 0.12 ETH at $4,250.00 CAD has been filled.',
      isRead: true,
      metadata: { asset: 'ETH', amount: '0.12', fiat: '510.00' },
      createdAt: new Date(now - 2 * 60 * 60 * 1000), // 2 hours ago
    },
    {
      userId: PLATFORM_USER_ID,
      type: 'staking_reward',
      title: 'Staking Reward Earned',
      message: 'You earned 0.000023 BTC from your Bitcoin staking position.',
      isRead: true,
      metadata: { asset: 'BTC', reward: '0.000023' },
      createdAt: new Date(now - 6 * 60 * 60 * 1000), // 6 hours ago
    },
    {
      userId: PLATFORM_USER_ID,
      type: 'withdrawal_sent',
      title: 'Withdrawal Sent',
      message: 'Your withdrawal of 1.5 SOL has been broadcast to the Solana network.',
      isRead: true,
      metadata: { asset: 'SOL', amount: '1.5' },
      createdAt: new Date(now - 24 * 60 * 60 * 1000), // 1 day ago
    },
    {
      userId: PLATFORM_USER_ID,
      type: 'price_alert',
      title: 'BTC Price Alert',
      message: 'Bitcoin has risen above $90,000 CAD. Your price alert has been triggered.',
      isRead: true,
      metadata: { asset: 'BTC', threshold: '90000', direction: 'above' },
      createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    },
    {
      userId: PLATFORM_USER_ID,
      type: 'trade_filled',
      title: 'Trade Completed',
      message: 'Your sell order for 50 LINK at $18.50 CAD each has been filled.',
      isRead: true,
      metadata: { asset: 'LINK', amount: '50', fiat: '925.00' },
      createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000), // 3 days ago
    },
  ];

  await db.insert(notifications).values(samples);
  logger.info({ count: samples.length }, 'Seeded sample notifications');
}
