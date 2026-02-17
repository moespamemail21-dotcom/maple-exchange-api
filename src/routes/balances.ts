import { FastifyInstance } from 'fastify';
import { authGuard } from '../middleware/auth.js';
import { getUserBalances, getUserBalance, getLedgerEntries } from '../services/balance.js';
import { getPrice } from '../services/price.js';
import { count, eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { balanceLedger } from '../db/schema.js';

export async function balanceRoutes(app: FastifyInstance) {
  // ─── Get All Balances + CAD Values ──────────────────────────────────
  app.get('/api/balances', { preHandler: [authGuard] }, async (request) => {
    const rows = await getUserBalances(request.userId);

    // Enrich with live CAD values
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const priceData = await getPrice(row.asset);
        const cadPrice = priceData?.cadPrice ?? 0;

        const available = Number(row.available);
        const locked = Number(row.locked);
        const pendingDeposit = Number(row.pendingDeposit);
        const total = available + locked;

        return {
          asset: row.asset,
          available: row.available,
          locked: row.locked,
          pendingDeposit: row.pendingDeposit,
          totalBalance: String(total),
          cadValue: (total * cadPrice).toFixed(2),
          cadPrice: cadPrice.toFixed(2),
        };
      })
    );

    // Portfolio total in CAD
    const totalCadValue = enriched.reduce((sum, b) => sum + Number(b.cadValue), 0);

    return {
      balances: enriched,
      totalCadValue: totalCadValue.toFixed(2),
    };
  });

  // ─── Get Single Asset Balance ───────────────────────────────────────
  app.get('/api/balances/:asset', { preHandler: [authGuard] }, async (request, reply) => {
    const { asset } = request.params as { asset: string };

    const row = await getUserBalance(request.userId, asset.toUpperCase());
    if (!row) {
      return reply.status(404).send({ error: `No balance found for asset: ${asset}` });
    }

    const priceData = await getPrice(row.asset);
    const cadPrice = priceData?.cadPrice ?? 0;
    const total = Number(row.available) + Number(row.locked);

    return {
      asset: row.asset,
      available: row.available,
      locked: row.locked,
      pendingDeposit: row.pendingDeposit,
      totalBalance: String(total),
      cadValue: (total * cadPrice).toFixed(2),
      cadPrice: cadPrice.toFixed(2),
    };
  });

  // ─── Get Ledger (Audit Trail) ───────────────────────────────────────
  app.get('/api/balances/ledger', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request) => {
    const query = request.query as { asset?: string; limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit) || 50, 200);
    const offset = Math.min(Math.max(Number(query.offset) || 0, 0), 10_000);

    const entries = await getLedgerEntries(request.userId, {
      asset: query.asset?.toUpperCase(),
      limit,
      offset,
    });

    // Count total entries with the same filters
    const conditions = [eq(balanceLedger.userId, request.userId)];
    if (query.asset) conditions.push(eq(balanceLedger.asset, query.asset.toUpperCase()));

    const [countResult] = await db
      .select({ value: count() })
      .from(balanceLedger)
      .where(and(...conditions));

    const total = countResult?.value ?? 0;

    return { entries, total, limit, offset };
  });
}
