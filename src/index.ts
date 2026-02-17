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
import { alertRoutes } from './routes/alerts.js';
import { recurringBuyRoutes } from './routes/recurring-buys.js';
import { referralRoutes } from './routes/referrals.js';
import { exportRoutes } from './routes/export.js';
import { swapRoutes } from './routes/swap.js';
import { totpRoutes } from './routes/totp.js';
import { appConfigRoutes } from './routes/app-config.js';
import { addressBookRoutes } from './routes/address-book.js';
import { sessionRoutes } from './routes/sessions.js';
import { accountRoutes } from './routes/account.js';
import { supportRoutes } from './routes/support.js';
import { setupWebSocket } from './ws/index.js';
import { startPriceFeed, fetchPrices, getPriceAge } from './services/price.js';
import { startMexcFeed } from './services/mexc-feed.js';
import { processExpiredTrades } from './services/trade.js';
import { rematchActiveOrders } from './services/matching.js';
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
import { seedDemoUser } from './services/demo-seed.js';
import { checkPriceAlerts } from './services/price-alert.js';
import { processDueRecurringBuys } from './services/recurring-buy.js';
import { cleanupExpiredResetTokens, cleanupOldNotifications, cleanupOldAuthEvents, cleanupTriggeredAlerts, cleanupClosedTickets, cleanupStaleOrders, cleanupStalePendingDeposits } from './services/cleanup.js';
import { expireStaleRewards } from './services/referral.js';
import { cleanupExpiredSessions } from './services/session.js';
import { db } from './db/index.js';
import { sql } from 'drizzle-orm';
import { redis, redisSub } from './services/redis.js';
import { ErrorCode } from './config/error-codes.js';

async function main() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'debug' : 'info',
      ...(env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
    requestIdHeader: 'x-request-id',
    requestTimeout: 30_000,
    bodyLimit: 262_144, // 256 KB — prevents oversized JSON payloads
  });

  // ─── Plugins ──────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: env.NODE_ENV === 'development'
      ? true
      : (env.CORS_ORIGINS || 'https://mapleexchange.ca,https://maplecx.app').split(',').map(s => s.trim()),
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

  // ─── Security Headers ──────────────────────────────────────────────
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '0');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  // ─── Error Handler ────────────────────────────────────────────────────
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    // Zod validation errors — strip to field + message only
    if (error.name === 'ZodError') {
      const issues = JSON.parse(error.message) as Array<{ path: string[]; message: string }>;
      return reply.status(400).send({
        error: 'Validation Error',
        code: ErrorCode.VALIDATION_ERROR,
        details: issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    app.log.error(error);

    const statusCode = error.statusCode ?? 500;

    // Rate limit errors from @fastify/rate-limit
    if (statusCode === 429) {
      return reply.status(429).send({
        error: error.message || 'Rate limit exceeded',
        code: ErrorCode.RATE_LIMITED,
      });
    }

    if (statusCode >= 500) {
      return reply.status(statusCode).send({ error: 'Internal Server Error', code: ErrorCode.INTERNAL_ERROR });
    }

    reply.status(statusCode).send({
      error: error.message || 'Request Error',
    });
  });

  // ─── Request Logging ─────────────────────────────────────────────────
  app.addHook('onResponse', async (request, reply) => {
    // Skip health check and noisy endpoints from verbose logging
    if (request.url === '/api/health') return;
    request.log.info({
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: Math.round(reply.elapsedTime),
    }, 'request completed');
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
  await app.register(alertRoutes);
  await app.register(recurringBuyRoutes);
  await app.register(referralRoutes);
  await app.register(exportRoutes);
  await app.register(swapRoutes);
  await app.register(totpRoutes);
  await app.register(appConfigRoutes);
  await app.register(addressBookRoutes);
  await app.register(sessionRoutes);
  await app.register(accountRoutes);
  await app.register(supportRoutes);

  // ─── WebSocket ────────────────────────────────────────────────────────
  await setupWebSocket(app);

  // ─── Health Check ─────────────────────────────────────────────────────
  let mexcFeedHandle: { isConnected: () => boolean } | null = null;

  app.get('/api/health', async () => {
    let dbStatus = 'ok';
    try {
      await db.execute(sql`SELECT 1`);
    } catch {
      dbStatus = 'error';
    }

    let redisStatus = 'ok';
    try {
      await redis.ping();
    } catch {
      redisStatus = 'error';
    }

    const priceAgeMs = getPriceAge();
    const pricesStale = priceAgeMs > 5 * 60 * 1000;
    const mexcStatus = mexcFeedHandle?.isConnected() ? 'ok' : 'disconnected';
    const overallStatus = dbStatus !== 'ok' || redisStatus !== 'ok' || pricesStale ? 'degraded' : 'ok';

    return {
      status: overallStatus,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      env: env.NODE_ENV,
      db: dbStatus,
      redis: redisStatus,
      prices: pricesStale ? 'stale' : 'ok',
      priceAgeSeconds: Math.round(priceAgeMs / 1000),
      mexcFeed: mexcStatus,
    };
  });

  // ─── Start Server FIRST (so health check responds immediately) ───────
  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    app.log.info(`Maple Exchange server running on http://${env.HOST}:${env.PORT}`);
    app.log.info(`Environment: ${env.NODE_ENV} | WebSocket: ws://${env.HOST}:${env.PORT}/ws`);
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
    if (env.NODE_ENV === 'development') {
      await seedDemoUser();
    }
  } catch (err) {
    app.log.error({ err }, 'Error during seed operations (non-fatal)');
  }

  // ─── Background Jobs ──────────────────────────────────────────────────
  // Price feed: try first fetch, but don't crash if API is down
  try { await fetchPrices(); } catch (err) {
    app.log.error({ err }, 'Initial price fetch failed (will retry)');
  }
  const priceTimer = startPriceFeed(300_000); // 5 min — MEXC feed handles real-time

  // MEXC real-time feed: connect to MEXC WebSocket for live prices + orderbook
  const mexcFeed = startMexcFeed();
  mexcFeedHandle = mexcFeed;

  // Expired trades: check every 60 seconds (with overlap guard)
  let isProcessingExpired = false;
  const expiryTimer = setInterval(async () => {
    if (isProcessingExpired) {
      app.log.warn('Previous processExpiredTrades still running, skipping this cycle');
      return;
    }
    isProcessingExpired = true;
    try {
      const processed = await processExpiredTrades();
      if (processed > 0) {
        app.log.info(`Processed ${processed} expired/holding-complete trades`);
      }
    } catch (err: unknown) {
      app.log.error({ err }, 'Error processing expired trades');
    } finally {
      isProcessingExpired = false;
    }
  }, 60_000);

  // Re-matching: attempt to match partially-filled orders every 60 seconds
  let isRematching = false;
  const rematchTimer = setInterval(async () => {
    if (isRematching) return;
    isRematching = true;
    try {
      const matched = await rematchActiveOrders();
      if (matched > 0) {
        app.log.info(`Background re-matching: ${matched} new trades created`);
      }
    } catch (err: unknown) {
      app.log.error({ err }, 'Error in background re-matching');
    } finally {
      isRematching = false;
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
    try { await captureAllSnapshots(); } catch (err) {
      app.log.warn({ err }, 'Initial snapshot capture failed (non-fatal)');
    }
  }, 10_000);

  // Market stats: fetch on startup + every hour
  try { await fetchMarketStats(); } catch (err) {
    app.log.error({ err }, 'Initial market stats fetch failed (will retry)');
  }
  const marketStatsTimer = startMarketStatsFeed(3600_000);

  // News feed: fetch on startup + every hour (with 2s delay between coins)
  const newsTimer = startNewsFeed(3600_000);

  // Price alerts: check every 30 seconds (piggyback on price feed interval)
  const alertTimer = setInterval(async () => {
    try { await checkPriceAlerts(); } catch (err: unknown) {
      app.log.error({ err }, 'Error checking price alerts');
    }
  }, 30_000);

  // Recurring buys: check every 5 minutes
  const recurringBuyTimer = setInterval(async () => {
    try {
      const processed = await processDueRecurringBuys();
      if (processed > 0) app.log.info(`Processed ${processed} recurring buys`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error processing recurring buys');
    }
  }, 5 * 60_000);

  // ─── Stale Data Cleanup ──────────────────────────────────────────────────

  // Expired reset tokens: clear every 24 hours
  const resetTokenCleanupTimer = setInterval(async () => {
    try {
      const cleared = await cleanupExpiredResetTokens();
      if (cleared > 0) app.log.info(`Cleared ${cleared} expired password reset tokens`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error cleaning up expired reset tokens');
    }
  }, 24 * 60 * 60 * 1000);

  // Old notifications: prune every 7 days
  const notificationCleanupTimer = setInterval(async () => {
    try {
      const deleted = await cleanupOldNotifications();
      if (deleted > 0) app.log.info(`Pruned ${deleted} notifications older than 90 days`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error cleaning up old notifications');
    }
  }, 7 * 24 * 60 * 60 * 1000);

  // Old auth events: prune every 30 days
  const authEventCleanupTimer = setInterval(async () => {
    try {
      const deleted = await cleanupOldAuthEvents();
      if (deleted > 0) app.log.info(`Pruned ${deleted} auth events older than 1 year`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error cleaning up old auth events');
    }
  }, 30 * 24 * 60 * 60 * 1000);

  // Expired sessions: clear every 24 hours
  const sessionCleanupTimer = setInterval(async () => {
    try {
      const deleted = await cleanupExpiredSessions();
      if (deleted > 0) app.log.info(`Cleaned up ${deleted} expired sessions`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error cleaning up expired sessions');
    }
  }, 24 * 60 * 60 * 1000);

  // Triggered price alerts: prune every 7 days
  const alertCleanupTimer = setInterval(async () => {
    try {
      const deleted = await cleanupTriggeredAlerts();
      if (deleted > 0) app.log.info(`Pruned ${deleted} triggered alerts older than 30 days`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error cleaning up triggered alerts');
    }
  }, 7 * 24 * 60 * 60 * 1000);

  // Closed support tickets: prune every 30 days
  const ticketCleanupTimer = setInterval(async () => {
    try {
      const deleted = await cleanupClosedTickets();
      if (deleted > 0) app.log.info(`Pruned ${deleted} closed tickets older than 1 year`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error cleaning up closed tickets');
    }
  }, 30 * 24 * 60 * 60 * 1000);

  // Stale orders: cancel active orders older than 90 days, every 7 days
  const staleOrderCleanupTimer = setInterval(async () => {
    try {
      const cancelled = await cleanupStaleOrders();
      if (cancelled > 0) app.log.info(`Cancelled ${cancelled} stale orders older than 90 days`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error cleaning up stale orders');
    }
  }, 7 * 24 * 60 * 60 * 1000);

  // Stale referral rewards: expire pending rewards older than 90 days, every 24 hours
  const referralExpiryTimer = setInterval(async () => {
    try {
      const expired = await expireStaleRewards();
      if (expired > 0) app.log.info(`Expired ${expired} stale referral rewards (>90 days pending)`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error expiring stale referral rewards');
    }
  }, 24 * 60 * 60 * 1000);

  // Stale pending deposits: expire pending deposits older than 72 hours, every 24 hours
  const stalePendingDepositCleanupTimer = setInterval(async () => {
    try {
      const expired = await cleanupStalePendingDeposits();
      if (expired > 0) app.log.info(`Expired ${expired} stale pending deposits older than 72 hours`);
    } catch (err: unknown) {
      app.log.error({ err }, 'Error cleaning up stale pending deposits');
    }
  }, 24 * 60 * 60 * 1000);

  // Run reset token cleanup once on startup (clear any tokens that expired while server was down)
  try { await cleanupExpiredResetTokens(); } catch (err) {
    app.log.warn({ err }, 'Startup reset token cleanup failed (non-fatal)');
  }

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
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    app.log.info('Shutting down gracefully...');

    // Stop accepting new connections immediately
    clearInterval(priceTimer);
    clearInterval(expiryTimer);
    clearInterval(rematchTimer);
    clearInterval(depositTimer);
    clearInterval(withdrawalTimer);
    clearInterval(earningsTimer);
    clearInterval(snapshotTimer);
    clearInterval(poolTimer);
    clearInterval(marketStatsTimer);
    clearInterval(newsTimer);
    clearInterval(alertTimer);
    clearInterval(recurringBuyTimer);
    clearInterval(resetTokenCleanupTimer);
    clearInterval(notificationCleanupTimer);
    clearInterval(authEventCleanupTimer);
    clearInterval(sessionCleanupTimer);
    clearInterval(alertCleanupTimer);
    clearInterval(ticketCleanupTimer);
    clearInterval(staleOrderCleanupTimer);
    clearInterval(stalePendingDepositCleanupTimer);
    clearInterval(referralExpiryTimer);
    mexcFeed.stop();
    stopDepositMonitor();
    stopWithdrawalBroadcaster();

    // Close Redis connections
    await redis.quit();
    await redisSub.quit();

    // Allow in-flight requests to complete (up to 10s)
    await Promise.race([
      app.close(),
      new Promise(resolve => setTimeout(resolve, 10_000)),
    ]);
    app.log.info('Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // Logger may not be initialized yet, use stderr directly
  process.stderr.write(`FATAL startup error: ${err}\n`);
  process.exit(1);
});
