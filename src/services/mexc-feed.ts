import WebSocket from 'ws';
import axios from 'axios';
import Decimal from 'decimal.js';
import { redis, KEYS } from './redis.js';
import { logger } from '../config/logger.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const MEXC_WS_URL = 'wss://wbs-api.mexc.com/ws';
const PAIRS = ['BTCUSDT', 'ETHUSDT', 'LTCUSDT', 'XRPUSDT', 'SOLUSDT', 'LINKUSDT'];
const PAIR_TO_SYMBOL: Record<string, string> = {
  BTCUSDT: 'BTC', ETHUSDT: 'ETH', LTCUSDT: 'LTC',
  XRPUSDT: 'XRP', SOLUSDT: 'SOL', LINKUSDT: 'LINK',
};
const SYMBOLS = Object.values(PAIR_TO_SYMBOL);

const PING_INTERVAL_MS = 20_000;
const BROADCAST_INTERVAL_MS = 1_000;
const CAD_RATE_REFRESH_MS = 5 * 60 * 1000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const REDIS_PRICE_TTL = 60; // seconds
const CANDLE_TTL = 300; // 5 minutes

// ─── Types ───────────────────────────────────────────────────────────────────

interface TickerData {
  symbol: string;
  usdPrice: number;
  cadPrice: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  lastUpdated: string;
}

// ─── State ───────────────────────────────────────────────────────────────────

let ws: WebSocket | null = null;
let connected = false;
let reconnectAttempt = 0;
let cadRate = new Decimal(1.36); // default, updated from Redis/CoinGecko

const tickerMap = new Map<string, TickerData>();

let pingTimer: ReturnType<typeof setInterval> | null = null;
let broadcastTimer: ReturnType<typeof setInterval> | null = null;
let cadRateTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

// ─── Public API ──────────────────────────────────────────────────────────────

export function startMexcFeed() {
  stopped = false;
  logger.info('Starting MEXC real-time price feed...');

  // Fetch CAD rate immediately, then every 5 minutes
  fetchCadRate();
  cadRateTimer = setInterval(fetchCadRate, CAD_RATE_REFRESH_MS);

  // Fetch initial candle history for chart seeding
  fetchInitialCandles();

  // Connect WebSocket
  connectWebSocket();

  // Broadcast prices every second
  broadcastTimer = setInterval(broadcastPrices, BROADCAST_INTERVAL_MS);

  return {
    stop: stopMexcFeed,
    isConnected: () => connected,
  };
}

function stopMexcFeed() {
  stopped = true;
  logger.info('Stopping MEXC feed...');

  if (pingTimer) clearInterval(pingTimer);
  if (broadcastTimer) clearInterval(broadcastTimer);
  if (cadRateTimer) clearInterval(cadRateTimer);
  if (reconnectTimeout) clearTimeout(reconnectTimeout);

  pingTimer = null;
  broadcastTimer = null;
  cadRateTimer = null;
  reconnectTimeout = null;

  if (ws) {
    ws.removeAllListeners();
    ws.close(1000, 'shutting down');
    ws = null;
  }
  connected = false;
}

// ─── WebSocket Connection ────────────────────────────────────────────────────

function connectWebSocket() {
  if (stopped || ws) return;

  try {
    ws = new WebSocket(MEXC_WS_URL);
  } catch (err) {
    logger.error({ err }, 'Failed to create MEXC WebSocket');
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    connected = true;
    reconnectAttempt = 0;
    logger.info('MEXC WebSocket connected');
    subscribeChannels();
    startPingTimer();
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleMessage(msg);
    } catch {
      // Ignore unparseable messages (PONG responses, etc.)
    }
  });

  ws.on('error', (err) => {
    logger.warn({ err: err.message }, 'MEXC WebSocket error');
  });

  ws.on('close', (code, reason) => {
    connected = false;
    ws = null;
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (!stopped) {
      logger.warn({ code, reason: reason?.toString() }, 'MEXC WebSocket disconnected, reconnecting...');
      scheduleReconnect();
    }
  });
}

function subscribeChannels() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Subscribe to miniTicker for real-time prices
  const tickerChannels = PAIRS.map(p => `spot@public.miniTicker.v3.api@${p}@UTC+0`);
  ws.send(JSON.stringify({ method: 'SUBSCRIPTION', params: tickerChannels }));

  // Subscribe to partial depth (orderbook) — 20 levels
  const depthChannels = PAIRS.map(p => `spot@public.limit.v3.api@${p}@20`);
  ws.send(JSON.stringify({ method: 'SUBSCRIPTION', params: depthChannels }));

  logger.info({ pairs: PAIRS.length }, 'Subscribed to MEXC ticker + depth channels');
}

function startPingTimer() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send('{"method":"PING"}');
    }
  }, PING_INTERVAL_MS);
}

function scheduleReconnect() {
  if (stopped || reconnectTimeout) return;
  reconnectAttempt++;
  const jitter = Math.random() * 1000;
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt - 1) + jitter, RECONNECT_MAX_MS);
  logger.info({ delay: Math.round(delay), attempt: reconnectAttempt }, 'MEXC reconnecting...');
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    connectWebSocket();
  }, delay);
}

// ─── Message Handlers ────────────────────────────────────────────────────────

function handleMessage(msg: any) {
  // MEXC miniTicker: { c: "channel", d: { s: "BTCUSDT", p: "97000", r: "0.025", h: "98000", l: "96000", v: "1000", q: "97000000" }, t: timestamp }
  if (msg.c && msg.d && typeof msg.d === 'object') {
    const channel = msg.c as string;

    if (channel.includes('miniTicker')) {
      handleTickerMessage(msg.d);
    } else if (channel.includes('limit.v3.api')) {
      handleDepthMessage(msg.d, channel);
    }
  }
}

function handleTickerMessage(d: any) {
  const pairSymbol = d.s as string | undefined;
  if (!pairSymbol) return;

  const symbol = PAIR_TO_SYMBOL[pairSymbol];
  if (!symbol) return;

  const usdPrice = new Decimal(d.p || '0');
  const changeRate = new Decimal(d.r || '0');
  const high = new Decimal(d.h || '0');
  const low = new Decimal(d.l || '0');
  const volume = new Decimal(d.q || '0'); // quote volume in USDT

  if (usdPrice.isNaN() || usdPrice.lte(0)) return;

  const cadPrice = usdPrice.mul(cadRate).toDecimalPlaces(8).toNumber();
  const ticker: TickerData = {
    symbol,
    usdPrice: usdPrice.toNumber(),
    cadPrice,
    change24h: changeRate.mul(100).toDecimalPlaces(4).toNumber(),
    high24h: high.toNumber(),
    low24h: low.toNumber(),
    volume24h: volume.toNumber(),
    lastUpdated: new Date().toISOString(),
  };

  tickerMap.set(symbol, ticker);

  // Write to Redis (same key pattern as CoinGecko, so existing code reads it)
  const priceData = {
    asset: coingeckoId(symbol),
    symbol,
    cadPrice,
    usdPrice: usdPrice.toNumber(),
    change24h: ticker.change24h,
    high24h: high.mul(cadRate).toDecimalPlaces(8).toNumber(),
    low24h: low.mul(cadRate).toDecimalPlaces(8).toNumber(),
    volume24h: ticker.volume24h,
    lastUpdated: ticker.lastUpdated,
  };

  redis.set(KEYS.price(symbol), JSON.stringify(priceData), 'EX', REDIS_PRICE_TTL).catch(() => {});
}

function handleDepthMessage(d: any, channel: string) {
  // Extract pair from channel: "spot@public.limit.v3.api@BTCUSDT@20"
  const parts = channel.split('@');
  const pairSymbol = parts[2];
  if (!pairSymbol) return;

  const symbol = PAIR_TO_SYMBOL[pairSymbol];
  if (!symbol) return;

  const bidsRaw = d.bids as Array<{ p: string; v: string }> | undefined;
  const asksRaw = d.asks as Array<{ p: string; v: string }> | undefined;

  if (!bidsRaw || !asksRaw) return;

  const bids = bidsRaw.slice(0, 20).map(b => ({
    price: new Decimal(b.p || '0').mul(cadRate).toDecimalPlaces(8).toNumber(),
    amount: new Decimal(b.v || '0').toNumber(),
  }));

  const asks = asksRaw.slice(0, 20).map(a => ({
    price: new Decimal(a.p || '0').mul(cadRate).toDecimalPlaces(8).toNumber(),
    amount: new Decimal(a.v || '0').toNumber(),
  }));

  const message = JSON.stringify({
    type: 'orderbook_update',
    asset: symbol,
    bids,
    asks,
    ts: Date.now(),
  });

  // Publish to orderbook channel (ws/index.ts already handles this)
  redis.publish(KEYS.orderBookChannel(symbol), message).catch(() => {});

  // Also cache as snapshot for REST fallback
  redis.set(KEYS.orderbookSnapshot(symbol), message, 'EX', 10).catch(() => {});
}

// ─── Price Broadcasting ──────────────────────────────────────────────────────

function broadcastPrices() {
  if (tickerMap.size === 0) return;

  const data: Record<string, object> = {};
  for (const [symbol, ticker] of tickerMap) {
    data[symbol] = {
      cadPrice: ticker.cadPrice,
      usdPrice: ticker.usdPrice,
      change24h: ticker.change24h,
      high24h: cadRate.mul(ticker.high24h).toDecimalPlaces(8).toNumber(),
      low24h: cadRate.mul(ticker.low24h).toDecimalPlaces(8).toNumber(),
      volume24h: ticker.volume24h,
    };
  }

  const payload = JSON.stringify({
    type: 'price_update',
    data,
    ts: Date.now(),
  });

  redis.publish(KEYS.priceChannel, payload).catch(() => {});
}

// ─── CAD Rate ────────────────────────────────────────────────────────────────

async function fetchCadRate() {
  try {
    // Try reading USDT price from Redis (written by CoinGecko fetch)
    const cached = await redis.get(KEYS.price('USDT'));
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.cadPrice && parsed.cadPrice > 0) {
        cadRate = new Decimal(parsed.cadPrice);
        return;
      }
    }

    // Fallback: fetch directly from CoinGecko
    const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: 'tether', vs_currencies: 'cad' },
      timeout: 5000,
    });
    if (data?.tether?.cad) {
      cadRate = new Decimal(data.tether.cad);
      logger.debug({ cadRate: cadRate.toNumber() }, 'Updated CAD rate from CoinGecko');
    }
  } catch (err) {
    logger.warn({ err, cadRate }, 'Failed to update CAD rate, using last known');
  }
}

// ─── Initial Candle History ──────────────────────────────────────────────────

async function fetchInitialCandles() {
  for (const pair of PAIRS) {
    const symbol = PAIR_TO_SYMBOL[pair];
    try {
      const { data } = await axios.get('https://api.mexc.com/api/v3/klines', {
        params: { symbol: pair, interval: '1m', limit: 60 },
        timeout: 8000,
      });

      if (!Array.isArray(data)) continue;

      // Each candle: [openTime, open, high, low, close, volume, closeTime, quoteVolume]
      const candles = data.map((c: any[]) => {
        const closePrice = new Decimal(c[4] || '0');
        return {
          timestamp: new Date(c[0]).toISOString(),
          usdPrice: closePrice.toNumber(),
          cadPrice: closePrice.mul(cadRate).toDecimalPlaces(8).toNumber(),
        };
      });

      await redis.set(
        KEYS.candles(symbol, '1m'),
        JSON.stringify(candles),
        'EX',
        CANDLE_TTL,
      );
    } catch (err) {
      logger.debug({ err, pair }, 'Failed to fetch initial candles for pair');
    }

    // Small delay between pairs to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  logger.info('Initial candle history fetched for all pairs');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function coingeckoId(symbol: string): string {
  const map: Record<string, string> = {
    BTC: 'bitcoin', ETH: 'ethereum', LTC: 'litecoin',
    XRP: 'ripple', SOL: 'solana', LINK: 'chainlink',
  };
  return map[symbol] ?? symbol.toLowerCase();
}
