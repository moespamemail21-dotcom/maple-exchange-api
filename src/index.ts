import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { env } from './config/env.js';
import { authRoutes } from './routes/auth.js';
import { orderRoutes } from './routes/orders.js';
import { tradeRoutes } from './routes/trades.js';
import { priceRoutes } from './routes/prices.js';
import { userRoutes } from './routes/user.js';
import { walletRoutes } from './routes/wallets.js';
import { balanceRoutes } from './routes/balances.js';
import { depositRoutes } from './routes/deposits.js';
import { withdrawalRoutes } from './routes/withdrawals.js';
import { adminRoutes } from './routes/admin.js';
import { earnRoutes } from './routes/earn.js';
import { performanceRoutes } from './routes/performance.js';
import { notificationRoutes } from './routes/notifications.js';
import { marketRoutes } from './routes/market.js';
import { setupWebSocket } from './ws/index.js';
import { startPriceFeed, fetchPrices } from './services/price.js';
import { processExpiredTrades } from './services/trade.js';
import { startDepositMonitor, stopDepositMonitor } from './services/deposit-monitor.js';
import { startWithdrawalBroadcaster, stopWithdrawalBroadcaster } from './services/withdrawal-broadcaster.js';
import { seedWalletCounters } from './services/wallet.js';
import { getPoolStatus } from './services/wallet-pool.js';
import { ensurePlatformUser } from './services/platform.js';
import { accrueEarnings, seedStakingProducts } from './services/earn.js';
import { captureAllSnapshots } from './services/performance.js';
import { startMarketStatsFeed, fetchMarketStats } from './services/market-stats.js';
import { startNewsFeed } from './services/news.js';
import { seedNotifications } from './services/notification-seed.js';
import { db } from './db/index.js';

async function main() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'info' : 'warn',
    },
  });

  // ─── Plugins ──────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: env.NODE_ENV === 'development' ? true : ['https://mapleexchange.ca', 'https://maplecx.app', 'https://maple-exchange-api.onrender.com'],
    credentials: true,
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(jwt, {
    secret: env.JWT_SECRET,
  });

  await app.register(websocket);

  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB max (for KYC videos)
      files: 1,                     // one file per request
    },
  });

  // ─── Error Handler ────────────────────────────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    // Zod validation errors — strip to field + message only
    if (error.name === 'ZodError') {
      const issues = JSON.parse(error.message) as Array<{ path: string[]; message: string }>;
      return reply.status(400).send({
        error: 'Validation Error',
        details: issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    app.log.error(error);

    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      return reply.status(statusCode).send({ error: 'Internal Server Error' });
    }

    reply.status(statusCode).send({
      error: error.message || 'Request Error',
    });
  });

  // ─── Routes ───────────────────────────────────────────────────────────
  await app.register(authRoutes);
  await app.register(orderRoutes);
  await app.register(tradeRoutes);
  await app.register(priceRoutes);
  await app.register(userRoutes);
  await app.register(walletRoutes);
  await app.register(balanceRoutes);
  await app.register(depositRoutes);
  await app.register(withdrawalRoutes);
  await app.register(adminRoutes);
  await app.register(earnRoutes);
  await app.register(performanceRoutes);
  await app.register(notificationRoutes);
  await app.register(marketRoutes);

  // ─── WebSocket ────────────────────────────────────────────────────────
  await setupWebSocket(app);

  // ─── Health Check ─────────────────────────────────────────────────────
  app.get('/api/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    env: env.NODE_ENV,
  }));

  // ─── Start Server FIRST (so health check responds immediately) ───────
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`\n🍁 Maple Exchange server running on http://${env.HOST}:${env.PORT}`);
    console.log(`   Environment: ${env.NODE_ENV}`);
    console.log(`   WebSocket:   ws://${env.HOST}:${env.PORT}/ws`);
    console.log(`   Health:      http://${env.HOST}:${env.PORT}/api/health\n`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // ─── Seed Wallet Counters + Platform User + Staking Products ────────
  try {
    await db.transaction(async (tx) => {
      await seedWalletCounters(tx);
    });
    await ensurePlatformUser();
    await seedStakingProducts();
    await seedNotifications();
  } catch (err) {
    app.log.error({ err }, 'Error during seed operations (non-fatal)');
  }

  // ─── Background Jobs ──────────────────────────────────────────────────
  // Price feed: try first fetch, but don't crash if API is down
  try { await fetchPrices(); } catch (err) {
    app.log.error({ err }, 'Initial price fetch failed (will retry)');
  }
  const priceTimer = startPriceFeed(30_000);

  // Expired trades: check every 60 seconds
  const expiryTimer = setInterval(async () => {
    try {
      const processed = await processExpiredTrades();
      if (processed > 0) {
        app.log.info(`Processed ${processed} expired/holding-complete trades`);
      }
    } catch (err: unknown) {
      app.log.error({ err }, 'Error processing expired trades');
    }
  }, 60_000);

  // Deposit monitor: scan blockchains for incoming deposits
  const depositTimer = startDepositMonitor();

  // Withdrawal broadcaster: sign, broadcast, and confirm outgoing crypto
  const withdrawalTimer = startWithdrawalBroadcaster();

  // Earnings accrual: run every 6 hours
  const earningsTimer = setInterval(async () => {
    try {
      const accrued = await accrueEarnings();
      if (accrued > 0) {
        app.log.info(`Accrued earnings for ${accrued} staking positions`);
      }
    } catch (err: unknown) {
      app.log.error({ err }, 'Error accruing earnings');
    }
  }, 6 * 60 * 60 * 1000);

  // Portfolio snapshots: capture every hour
  const snapshotTimer = setInterval(async () => {
    try {
      const captured = await captureAllSnapshots();
      if (captured > 0) {
        app.log.info(`Captured ${captured} portfolio snapshots`);
      }
    } catch (err: unknown) {
      app.log.error({ err }, 'Error capturing portfolio snapshots');
    }
  }, 60 * 60 * 1000);

  // Capture initial snapshots on startup (after a short delay for prices to settle)
  setTimeout(async () => {
    try { await captureAllSnapshots(); } catch {}
  }, 10_000);

  // Market stats: fetch on startup + every hour
  try { await fetchMarketStats(); } catch (err) {
    app.log.error({ err }, 'Initial market stats fetch failed (will retry)');
  }
  const marketStatsTimer = startMarketStatsFeed(3600_000);

  // News feed: fetch on startup + every hour (with 2s delay between coins)
  const newsTimer = startNewsFeed(3600_000);

  // Wallet pool monitor: warn if any chain drops below 10 available wallets
  const POOL_MIN_THRESHOLD = 10;
  const poolTimer = setInterval(async () => {
    try {
      const status = await getPoolStatus();
      for (const s of status) {
        if (s.available < POOL_MIN_THRESHOLD) {
          app.log.warn(`[WALLET POOL] Low pool for ${s.chain}: ${s.available} available (threshold: ${POOL_MIN_THRESHOLD})`);
        }
      }
    } catch (err: unknown) {
      app.log.error({ err }, 'Error checking wallet pool status');
    }
  }, 10 * 60 * 1000); // every 10 minutes

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    clearInterval(priceTimer);
    clearInterval(expiryTimer);
    clearInterval(depositTimer);
    clearInterval(withdrawalTimer);
    clearInterval(earningsTimer);
    clearInterval(snapshotTimer);
    clearInterval(poolTimer);
    clearInterval(marketStatsTimer);
    clearInterval(newsTimer);
    stopDepositMonitor();
    stopWithdrawalBroadcaster();
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('FATAL startup error:', err);
  process.exit(1);
});
