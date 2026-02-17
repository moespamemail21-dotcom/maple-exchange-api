import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { redisSub, KEYS } from '../services/redis.js';
import { logger } from '../config/logger.js';

interface WsClient {
  ws: WebSocket;
  subscriptions: Set<string>;
  userId?: string;
  tokenExpiresAt?: number;
  msgCount: number;
  msgWindowStart: number;
}

const clients = new Set<WsClient>();
const connectionsPerIp = new Map<string, number>();
const MAX_WS_PER_IP = 5;
const MAX_MESSAGES_PER_WINDOW = 30; // max messages per 10-second window
const MSG_WINDOW_MS = 10_000;

export async function setupWebSocket(app: FastifyInstance) {
  // Subscribe to Redis channels (all tradeable assets + balances)
  await redisSub.subscribe(
    KEYS.tradeChannel,
    KEYS.priceChannel,
    KEYS.balanceChannel,
    KEYS.orderBookChannel('BTC'),
    KEYS.orderBookChannel('ETH'),
    KEYS.orderBookChannel('LTC'),
    KEYS.orderBookChannel('XRP'),
    KEYS.orderBookChannel('SOL'),
    KEYS.orderBookChannel('LINK'),
  );

  redisSub.on('message', (channel, message) => {
    // Parse message to check if it's a trade event that needs filtering
    let parsed: any;
    try {
      parsed = JSON.parse(message);
    } catch (err) {
      logger.warn({ err }, 'Failed to parse Redis message');
      return;
    }

    // Price updates: broadcast to all clients subscribed to channel:prices
    if (channel === KEYS.priceChannel) {
      for (const client of clients) {
        if (client.subscriptions.has('channel:prices') || client.subscriptions.has('*')) {
          try {
            client.ws.send(message);
          } catch {
            clients.delete(client);
          }
        }
      }
      return;
    }

    // Balance updates: send only to the affected user (strip amount details)
    if (channel === KEYS.balanceChannel) {
      const userId = parsed.userId;
      if (!userId) return;

      const sanitized = JSON.stringify({
        type: 'balance_updated',
        asset: parsed.asset,
        timestamp: Date.now(),
      });

      for (const client of clients) {
        if (client.userId === userId) {
          try {
            client.ws.send(sanitized);
          } catch {
            clients.delete(client);
          }
        }
      }
      return;
    }

    // Trade events: only send to participants, and strip P2P data
    if (channel === KEYS.tradeChannel) {
      const sanitized = JSON.stringify({
        type: parsed.type,
        tradeId: parsed.tradeId,
        status: parsed.newStatus ?? parsed.status,
        timestamp: parsed.timestamp ?? Date.now(),
      });

      // Send only to the relevant user(s)
      const recipientIds = new Set<string>();
      if (parsed.buyerId) recipientIds.add(parsed.buyerId);
      if (parsed.sellerId) recipientIds.add(parsed.sellerId);

      // If no specific recipients (e.g. orderbook updates), don't broadcast trade events
      if (recipientIds.size === 0) return;

      for (const client of clients) {
        if (client.userId && recipientIds.has(client.userId)) {
          try {
            client.ws.send(sanitized);
          } catch (err) {
            logger.debug({ err, userId: client.userId }, 'Removing disconnected trade client');
            clients.delete(client);
          }
        }
      }
      return;
    }

    // Order book updates: broadcast to all subscribed (no P2P data in these)
    for (const client of clients) {
      if (client.subscriptions.has(channel) || client.subscriptions.has('*')) {
        try {
          client.ws.send(message);
        } catch (err) {
          logger.debug({ err, userId: client.userId }, 'Removing disconnected orderbook client');
          clients.delete(client);
        }
      }
    }
  });

  app.get('/ws', { websocket: true }, (socket: WebSocket, request) => {
    // Per-IP connection limit
    const ip = request.ip;
    const currentCount = connectionsPerIp.get(ip) ?? 0;
    if (currentCount >= MAX_WS_PER_IP) {
      socket.close(4029, 'Too many connections from this IP');
      return;
    }
    connectionsPerIp.set(ip, currentCount + 1);

    const client: WsClient = {
      ws: socket,
      subscriptions: new Set(), // no auto-subscribe — clients must explicitly subscribe
      msgCount: 0,
      msgWindowStart: Date.now(),
    };
    clients.add(client);

    socket.on('message', (raw: Buffer) => {
      // Per-message rate limiting: max 30 messages per 10-second window
      const now = Date.now();
      if (now - client.msgWindowStart > MSG_WINDOW_MS) {
        client.msgCount = 0;
        client.msgWindowStart = now;
      }
      client.msgCount++;
      if (client.msgCount > MAX_MESSAGES_PER_WINDOW) {
        logger.debug({ ip, userId: client.userId }, 'WebSocket message rate limit exceeded');
        socket.send(JSON.stringify({ type: 'error', error: 'Rate limit exceeded' }));
        if (client.msgCount > MAX_MESSAGES_PER_WINDOW * 3) {
          socket.close(4029, 'Message rate limit exceeded');
        }
        return;
      }

      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'subscribe':
            if (Array.isArray(msg.channels)) {
              for (const ch of msg.channels) {
                client.subscriptions.add(ch);
              }
            }
            break;

          case 'unsubscribe':
            if (Array.isArray(msg.channels)) {
              for (const ch of msg.channels) {
                client.subscriptions.delete(ch);
              }
            }
            break;

          case 'auth':
            if (msg.token) {
              try {
                const decoded = app.jwt.verify<{ sub: string; exp?: number }>(msg.token);
                client.userId = decoded.sub;
                client.tokenExpiresAt = decoded.exp ? decoded.exp * 1000 : Date.now() + 15 * 60 * 1000;
                client.subscriptions.add(`user:${decoded.sub}`);
                socket.send(JSON.stringify({ type: 'auth_ok', userId: decoded.sub }));
              } catch (err) {
                logger.debug({ err }, 'WebSocket auth failed — invalid token');
                socket.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
              }
            }
            break;

          case 'ping':
            socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            break;
        }
      } catch (err) {
        logger.debug({ err }, 'Malformed WebSocket message received');
      }
    });

    socket.on('error', (err) => {
      logger.debug({ err, userId: client.userId }, 'WebSocket error');
      clients.delete(client);
      const remaining = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, remaining);
    });

    socket.on('close', () => {
      clients.delete(client);
      const remaining = (connectionsPerIp.get(ip) ?? 1) - 1;
      if (remaining <= 0) connectionsPerIp.delete(ip);
      else connectionsPerIp.set(ip, remaining);
    });

    // Send welcome message
    socket.send(JSON.stringify({
      type: 'connected',
      message: 'Connected to Maple Exchange',
      ts: Date.now(),
    }));
  });

  // Server-side keepalive: ping all clients every 30s to detect stale connections
  setInterval(() => {
    for (const client of clients) {
      try {
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.ping();
        } else {
          clients.delete(client);
        }
      } catch {
        clients.delete(client);
      }
    }
  }, 30_000);

  // Expire stale auth tokens every 60s
  setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      if (client.tokenExpiresAt && now > client.tokenExpiresAt) {
        client.userId = undefined;
        client.tokenExpiresAt = undefined;
        client.subscriptions.forEach((ch) => {
          if (ch.startsWith('user:')) client.subscriptions.delete(ch);
        });
        try {
          client.ws.send(JSON.stringify({ type: 'auth_expired', message: 'Token expired, please re-authenticate' }));
        } catch { /* client disconnected */ }
      }
    }
  }, 60_000);
}

/**
 * Send a message directly to a specific user's WebSocket connections.
 */
export function sendToUser(userId: string, message: object) {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.userId === userId) {
      try {
        client.ws.send(payload);
      } catch (err) {
        logger.debug({ err, userId }, 'Removing disconnected client during sendToUser');
        clients.delete(client);
      }
    }
  }
}

export function getConnectedCount(): number {
  return clients.size;
}
