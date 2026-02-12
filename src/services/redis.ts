import Redis from 'ioredis';
import { env } from '../config/env.js';

const redisOpts: any = {
  maxRetriesPerRequest: null, // required for BullMQ
  enableReadyCheck: false,
};

// Render external Redis uses rediss:// (TLS)
if (env.REDIS_URL.startsWith('rediss://')) {
  redisOpts.tls = {};
}

export const redis = new Redis(env.REDIS_URL, redisOpts);

// Separate connection for subscriptions
export const redisSub = new Redis(env.REDIS_URL, redisOpts);

// Order book keys
export const KEYS = {
  buyBook: (asset: string) => `orderbook:${asset}:buy`,   // sorted set: score = price (descending for buys)
  sellBook: (asset: string) => `orderbook:${asset}:sell`,  // sorted set: score = price (ascending for sells)
  orderData: (orderId: string) => `order:${orderId}`,      // hash: full order data
  price: (asset: string) => `price:${asset}:cad`,          // string: latest price
  tradeChannel: 'channel:trades',                           // pub/sub for new trades
  orderBookChannel: (asset: string) => `channel:orderbook:${asset}`,
} as const;
