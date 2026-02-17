import { FastifyInstance } from 'fastify';
import { authGuard } from '../middleware/auth.js';
import { db } from '../db/index.js';
import { trades, deposits, withdrawals } from '../db/schema.js';
import { eq, and, gte, lte, desc, or, count } from 'drizzle-orm';

const EXPORT_LIMIT = 10_000;

/** Escape a value for CSV — prevents formula injection and handles commas/quotes. */
function csvEscape(value: string | null | undefined): string {
  if (value == null) return '""';
  let s = String(value);
  // Prevent formula injection by prefixing with a single quote if the value
  // starts with a dangerous character. This preserves the original data
  // (including leading minus for negative numbers) while blocking
  // =, +, @, tab, and carriage return attacks in spreadsheet applications.
  if (/^[\t\r=+@]/.test(s) || (/^-/.test(s) && !/^-?\d/.test(s))) {
    s = "'" + s;
  }
  // Wrap in quotes and escape internal quotes
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exportRoutes(app: FastifyInstance) {
  app.get('/api/export/trades', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    preHandler: [authGuard],
  }, async (request, reply) => {
    const query = request.query as { from?: string; to?: string };
    const fromDate = query.from ? new Date(query.from) : new Date(0);
    const toDate = query.to ? new Date(query.to) : new Date();

    // Validate date params
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return reply.status(400).send({ error: 'Invalid date format. Use ISO 8601 (e.g. 2025-01-01).' });
    }
    if (fromDate > toDate) {
      return reply.status(400).send({ error: '"from" date must be before "to" date.' });
    }

    // Run data + count queries in parallel
    const tradeCondition = and(
      or(eq(trades.buyerId, request.userId), eq(trades.sellerId, request.userId)),
      gte(trades.createdAt, fromDate),
      lte(trades.createdAt, toDate),
    );
    const depositCondition = and(
      eq(deposits.userId, request.userId),
      gte(deposits.createdAt, fromDate),
      lte(deposits.createdAt, toDate),
    );
    const withdrawalCondition = and(
      eq(withdrawals.userId, request.userId),
      gte(withdrawals.createdAt, fromDate),
      lte(withdrawals.createdAt, toDate),
    );

    const [userTrades, userDeposits, userWithdrawals, tradeCount, depositCount, withdrawalCount] = await Promise.all([
      db.select().from(trades).where(tradeCondition).orderBy(desc(trades.createdAt)).limit(EXPORT_LIMIT),
      db.select().from(deposits).where(depositCondition).orderBy(desc(deposits.createdAt)).limit(EXPORT_LIMIT),
      db.select().from(withdrawals).where(withdrawalCondition).orderBy(desc(withdrawals.createdAt)).limit(EXPORT_LIMIT),
      db.select({ total: count() }).from(trades).where(tradeCondition),
      db.select({ total: count() }).from(deposits).where(depositCondition),
      db.select({ total: count() }).from(withdrawals).where(withdrawalCondition),
    ]);

    const totalTrades = tradeCount[0]?.total ?? 0;
    const totalDeposits = depositCount[0]?.total ?? 0;
    const totalWithdrawals = withdrawalCount[0]?.total ?? 0;

    const truncatedCategories: string[] = [];
    if (totalTrades > EXPORT_LIMIT) truncatedCategories.push(`trades (${totalTrades} total, ${EXPORT_LIMIT} exported)`);
    if (totalDeposits > EXPORT_LIMIT) truncatedCategories.push(`deposits (${totalDeposits} total, ${EXPORT_LIMIT} exported)`);
    if (totalWithdrawals > EXPORT_LIMIT) truncatedCategories.push(`withdrawals (${totalWithdrawals} total, ${EXPORT_LIMIT} exported)`);

    // Build CSV with proper escaping
    const rows: string[] = [];

    if (truncatedCategories.length > 0) {
      rows.push(`"WARNING: Export truncated at ${EXPORT_LIMIT} records per category. Truncated: ${truncatedCategories.join('; ')}. Narrow your date range for complete data."`);
    }

    rows.push('Date,Type,Asset,Amount,CAD Value,Fee,Status,TxHash/ID');

    for (const t of userTrades) {
      const type = t.buyerId === request.userId ? 'Buy' : 'Sell';
      rows.push([
        csvEscape(t.createdAt.toISOString()),
        csvEscape(type),
        csvEscape(t.cryptoAsset),
        csvEscape(t.amountCrypto),
        csvEscape(t.amountFiat),
        csvEscape(t.feeAmount),
        csvEscape(t.status),
        csvEscape(t.id),
      ].join(','));
    }

    for (const d of userDeposits) {
      rows.push([
        csvEscape(d.createdAt.toISOString()),
        csvEscape('Deposit'),
        csvEscape(d.asset),
        csvEscape(d.amount),
        csvEscape(''),
        csvEscape('0'),
        csvEscape(d.status),
        csvEscape(d.txHash),
      ].join(','));
    }

    for (const w of userWithdrawals) {
      rows.push([
        csvEscape(w.createdAt.toISOString()),
        csvEscape('Withdrawal'),
        csvEscape(w.asset),
        csvEscape(w.amount),
        csvEscape(''),
        csvEscape(w.fee),
        csvEscape(w.status),
        csvEscape(w.txHash ?? ''),
      ].join(','));
    }

    const csv = rows.join('\n');

    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', `attachment; filename="maple-exchange-transactions-${new Date().toISOString().split('T')[0]}.csv"`);
    if (truncatedCategories.length > 0) {
      reply.header('X-Export-Truncated', 'true');
    }
    return csv;
  });
}
