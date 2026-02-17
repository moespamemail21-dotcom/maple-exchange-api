import { z } from 'zod';
import { logger } from './logger.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3100),
  HOST: z.string().default('0.0.0.0'),

  // Database
  DATABASE_URL: z.string().default('postgresql://localhost:5432/maple_exchange'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // JWT
  JWT_SECRET: z.string().default('maple-dev-secret-change-in-production'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('90d'),

  // Trading
  TAKER_FEE_PERCENT: z.coerce.number().default(0.2),
  NEW_USER_TRADE_LIMIT: z.coerce.number().default(250),
  MAX_TRADE_LIMIT: z.coerce.number().default(3000),
  PAYMENT_WINDOW_MINUTES: z.coerce.number().default(30),
  CONFIRM_WINDOW_MINUTES: z.coerce.number().default(60),
  NEW_USER_HOLDING_HOURS: z.coerce.number().default(24),

  // Price feed
  COINGECKO_API_URL: z.string().default('https://api.coingecko.com/api/v3'),

  // ─── Wallet HD Seeds (BIP-39 mnemonics — MUST be set in production) ────
  WALLET_SEED_BTC: z.string().default('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  WALLET_SEED_ETH: z.string().default('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  WALLET_SEED_LTC: z.string().default('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  WALLET_SEED_XRP: z.string().default('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  WALLET_SEED_SOL: z.string().default('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),

  // ─── Wallet Encryption (AES-256-GCM key, 32-byte hex) ─────────────────
  WALLET_ENCRYPTION_KEY: z.string().default('0000000000000000000000000000000000000000000000000000000000000001'),

  // ─── KYC File Storage ─────────────────────────────────────────────────
  STORAGE_BACKEND: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./uploads'),
  AWS_S3_BUCKET: z.string().default('maple-exchange-kyc-documents'),
  AWS_REGION: z.string().default('ca-central-1'),

  // ─── Withdrawal ────────────────────────────────────────────────────────
  WITHDRAWAL_AUTO_APPROVE_CAD_LIMIT: z.coerce.number().default(500),
  WITHDRAWAL_DAILY_LIMIT_CAD: z.coerce.number().default(10_000),
  WITHDRAWAL_MONTHLY_LIMIT_CAD: z.coerce.number().default(50_000),
  WITHDRAWAL_COOLDOWN_MINUTES: z.coerce.number().default(5),
  ADDRESS_COOLDOWN_HOURS: z.coerce.number().default(24),

  // ─── Deposit Monitoring ────────────────────────────────────────────────
  DEPOSIT_SCAN_INTERVAL_MS: z.coerce.number().default(30000),

  // ─── Blockchain RPC / API Endpoints (free public defaults) ──────────
  MEMPOOL_API_URL: z.string().default('https://mempool.space/api'),
  LTC_API_URL: z.string().default('https://litecoinspace.org/api'),
  ETH_RPC_URL: z.string().default('https://eth.llamarpc.com'),
  SOL_RPC_URL: z.string().default('https://api.mainnet-beta.solana.com'),
  XRP_WSS_URL: z.string().default('wss://xrplcluster.com'),
  LINK_CONTRACT: z.string().default('0x514910771AF9Ca656af840dff83E8264EcF986CA'),

  // ─── Withdrawal Broadcasting ────────────────────────────────────────
  WITHDRAWAL_BROADCAST_INTERVAL_MS: z.coerce.number().default(15000),

  // ─── Platform Market Maker ──────────────────────────────────────────
  // The platform acts as counterparty when no P2P sellers are available.
  // This user is auto-created on startup and has infinite virtual liquidity.
  PLATFORM_INTERAC_EMAIL: z.string().default('payments@mapleexchange.ca'),
  PLATFORM_SPREAD_PERCENT: z.coerce.number().default(0.5),
  PLATFORM_VERIFY_MINUTES: z.coerce.number().default(15),

  // ─── Admin ────────────────────────────────────────────────────────────
  ADMIN_USER_IDS: z.string().default(''),

  // ─── App Config (Version Check & Maintenance) ───────────────────────
  APP_MIN_VERSION: z.string().default('1.0.0'),
  APP_LATEST_VERSION: z.string().default('1.0.0'),
  MAINTENANCE_MODE: z.coerce.boolean().default(false),
  MAINTENANCE_MESSAGE: z.string().optional(),

  // ─── CORS ────────────────────────────────────────────────────────────
  CORS_ORIGINS: z.string().default('https://mapleexchange.ca,https://maplecx.app,https://maple-exchange-api.onrender.com'),
});

export type Env = z.infer<typeof envSchema>;

export const env = envSchema.parse(process.env);

// ─── Production Safety Checks ─────────────────────────────────────────────
if (env.NODE_ENV === 'production') {
  const INSECURE_SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const INSECURE_KEY = '0000000000000000000000000000000000000000000000000000000000000001';

  const seedKeys = ['WALLET_SEED_BTC', 'WALLET_SEED_ETH', 'WALLET_SEED_LTC', 'WALLET_SEED_XRP', 'WALLET_SEED_SOL'] as const;
  for (const key of seedKeys) {
    if (env[key] === INSECURE_SEED) {
      throw new Error(`FATAL: ${key} is using the default insecure mnemonic. Set a real seed in production.`);
    }
  }

  if (env.WALLET_ENCRYPTION_KEY === INSECURE_KEY) {
    throw new Error('FATAL: WALLET_ENCRYPTION_KEY is using the default insecure key. Set a real 32-byte hex key in production.');
  }

  if (env.JWT_SECRET === 'maple-dev-secret-change-in-production') {
    throw new Error('FATAL: JWT_SECRET is using the default dev secret. Set a real secret in production.');
  }

  if (!env.ADMIN_USER_IDS || env.ADMIN_USER_IDS.trim() === '') {
    logger.warn('ADMIN_USER_IDS is empty — admin endpoints will be inaccessible');
  }
}
