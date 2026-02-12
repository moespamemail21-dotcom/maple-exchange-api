import { FastifyInstance } from 'fastify';
import { authGuard } from '../middleware/auth.js';
import { getUserBalances, getUserBalance, getLedgerEntries } from '../services/balance.js';
import { getPrice } from '../services/price.js';

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
  app.get('/api/balances/ledger', { preHandler: [authGuard] }, async (request) => {
    const query = request.query as { asset?: string; limit?: string; offset?: string };

    const entries = await getLedgerEntries(request.userId, {
      asset: query.asset?.toUpperCase(),
      limit: Math.min(Number(query.limit) || 50, 200),
      offset: Number(query.offset) || 0,
    });

    return { entries };
  });
}
