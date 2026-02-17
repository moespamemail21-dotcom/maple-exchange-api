import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/index.js';
import { savedAddresses } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { validateAddress, ASSET_TO_CHAIN, type Chain } from '../services/wallet.js';

const SUPPORTED_ASSETS = ['BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK'] as const;
const MAX_SAVED_ADDRESSES = 20;

const createSchema = z.object({
  label: z.string().trim().min(1).max(50),
  asset: z.enum(SUPPORTED_ASSETS),
  address: z.string().trim().min(10).max(255),
  destinationTag: z.string().max(20).optional().refine((v) => {
    if (v === undefined || v === '') return true;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 4294967295;
  }, 'Destination tag must be a valid integer (0–4294967295)'),
});

const uuidParamSchema = z.object({ id: z.string().uuid() });

export async function addressBookRoutes(app: FastifyInstance) {
  // ─── List Saved Addresses ─────────────────────────────────────────
  app.get('/api/address-book', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { asset?: string };

    const conditions = [eq(savedAddresses.userId, request.userId)];
    if (query.asset && SUPPORTED_ASSETS.includes(query.asset as any)) {
      conditions.push(eq(savedAddresses.asset, query.asset));
    }

    const addresses = await db
      .select()
      .from(savedAddresses)
      .where(and(...conditions))
      .orderBy(desc(savedAddresses.createdAt))
      .limit(MAX_SAVED_ADDRESSES);

    return { addresses };
  });

  // ─── Save New Address ─────────────────────────────────────────────
  app.post('/api/address-book', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const body = createSchema.parse(request.body);

    // Validate address format
    const chain = ASSET_TO_CHAIN[body.asset] as Chain;
    if (!chain || !validateAddress(chain, body.address)) {
      return reply.status(400).send({ error: `Invalid ${body.asset} address format.` });
    }

    // Normalize ETH/LINK addresses to lowercase (matches withdrawal normalization)
    const normalizedAddress = (body.asset === 'ETH' || body.asset === 'LINK')
      ? body.address.toLowerCase()
      : body.address;

    // Check limit
    const existing = await db
      .select({ id: savedAddresses.id })
      .from(savedAddresses)
      .where(eq(savedAddresses.userId, request.userId));

    if (existing.length >= MAX_SAVED_ADDRESSES) {
      return reply.status(400).send({
        error: `Maximum ${MAX_SAVED_ADDRESSES} saved addresses. Delete one to add a new one.`,
      });
    }

    // Check for duplicate address (using normalized address)
    const duplicate = existing.length > 0
      ? await db
          .select({ id: savedAddresses.id })
          .from(savedAddresses)
          .where(and(
            eq(savedAddresses.userId, request.userId),
            eq(savedAddresses.address, normalizedAddress),
            eq(savedAddresses.asset, body.asset),
          ))
      : [];

    if (duplicate.length > 0) {
      return reply.status(400).send({ error: 'This address is already saved.' });
    }

    const [saved] = await db
      .insert(savedAddresses)
      .values({
        userId: request.userId,
        label: body.label,
        asset: body.asset,
        address: normalizedAddress,
        destinationTag: body.destinationTag ?? null,
      })
      .returning();

    return reply.status(201).send({ address: saved });
  });

  // ─── Delete Saved Address ─────────────────────────────────────────
  app.delete('/api/address-book/:id', { preHandler: [authGuard] }, async (request, reply) => {
    const { id } = uuidParamSchema.parse(request.params);

    const [existing] = await db
      .select()
      .from(savedAddresses)
      .where(and(eq(savedAddresses.id, id), eq(savedAddresses.userId, request.userId)));

    if (!existing) {
      return reply.status(404).send({ error: 'Address not found' });
    }

    await db
      .delete(savedAddresses)
      .where(and(eq(savedAddresses.id, id), eq(savedAddresses.userId, request.userId)));

    return { success: true };
  });
}
