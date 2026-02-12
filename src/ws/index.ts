import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';
import { redisSub, KEYS } from '../services/redis.js';

interface WsClient {
  ws: WebSocket;
  subscriptions: Set<string>;
  userId?: string;
}

const clients = new Set<WsClient>();
const connectionsPerIp = new Map<string, number>();
const MAX_WS_PER_IP = 5;

export async function setupWebSocket(app: FastifyInstance) {
  // Subscribe to Redis channels (all tradeable assets)
  await redisSub.subscribe(
    KEYS.tradeChannel,
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
    } catch {
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
          } catch {
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
        } catch {
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
    };
    clients.add(client);

    socket.on('message', (raw: Buffer) => {
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
                const decoded = app.jwt.verify<{ sub: string }>(msg.token);
                client.userId = decoded.sub;
                client.subscriptions.add(`user:${decoded.sub}`);
                socket.send(JSON.stringify({ type: 'auth_ok', userId: decoded.sub }));
              } catch {
                socket.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
              }
            }
            break;

          case 'ping':
            socket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
            break;
        }
      } catch {
        // Ignore malformed messages
      }
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
      } catch {
        clients.delete(client);
      }
    }
  }
}

export function getConnectedCount(): number {
  return clients.size;
}
