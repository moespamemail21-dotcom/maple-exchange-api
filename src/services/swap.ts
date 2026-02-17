import { db } from '../db/index.js';
import { getPrice } from './price.js';
import { getUserBalance, mutateBalance } from './balance.js';
import { notifications } from '../db/schema.js';
import { env } from '../config/env.js';
import { redis } from './redis.js';
import { PLATFORM_USER_ID } from './platform.js';
import Decimal from 'decimal.js';
import { logger } from '../config/logger.js';
import crypto from 'node:crypto';

const QUOTE_TTL_SECONDS = 30;

export async function getSwapQuote(userId: string, fromAsset: string, toAsset: string, amount: string) {
  const fromPrice = await getPrice(fromAsset);
  const toPrice = await getPrice(toAsset);
  if (!fromPrice || !toPrice) throw new Error('Unable to fetch prices');

  const spread = env.PLATFORM_SPREAD_PERCENT / 100;
  const amountDec = new Decimal(amount);
  const fee = amountDec.times(env.TAKER_FEE_PERCENT / 100);
  const netAmount = amountDec.minus(fee);

  // fromAsset sold at market - spread, toAsset bought at market + spread
  const fromCadPrice = new Decimal(fromPrice.cadPrice);
  const toCadPrice = new Decimal(toPrice.cadPrice);
  const spreadDec = new Decimal(spread);
  const cadValue = netAmount.times(fromCadPrice.times(new Decimal(1).minus(spreadDec)));
  const toAmount = cadValue.dividedBy(toCadPrice.times(new Decimal(1).plus(spreadDec)));

  const rate = new Decimal(fromPrice.cadPrice).dividedBy(toPrice.cadPrice).toFixed(8);

  // Cache the quote in Redis with a 30-second TTL
  const quoteId = crypto.randomUUID();
  await redis.set(
    `swap:quote:${quoteId}`,
    JSON.stringify({
      userId,
      fromAsset,
      toAsset,
      fromAmount: amountDec.toFixed(8),
      toAmount: toAmount.toFixed(8),
      rate,
      fee: fee.toFixed(8),
      feeAsset: fromAsset,
      cadValue: cadValue.toFixed(2),
      ts: Date.now(),
    }),
    'EX',
    QUOTE_TTL_SECONDS,
  );

  return {
    quoteId,
    fromAsset,
    toAsset,
    fromAmount: amountDec.toFixed(8),
    toAmount: toAmount.toFixed(8),
    rate,
    fee: fee.toFixed(8),
    feeAsset: fromAsset,
    cadValue: cadValue.toFixed(2),
  };
}

export class SwapQuoteExpiredError extends Error {
  constructor() {
    super('Swap quote has expired. Please request a new quote.');
    this.name = 'SwapQuoteExpiredError';
  }
}

export async function executeSwap(
  userId: string,
  fromAsset: string,
  toAsset: string,
  amount: string,
  minReceive?: string,
  quoteId?: string,
) {
  let amountDec: Decimal;
  let fee: Decimal;
  let toAmount: Decimal;
  let netAmount: Decimal;

  if (quoteId) {
    // Use cached quote for price consistency
    const cached = await redis.get(`swap:quote:${quoteId}`);
    if (!cached) {
      throw new SwapQuoteExpiredError();
    }

    const quote = JSON.parse(cached) as {
      userId: string;
      fromAsset: string;
      toAsset: string;
      fromAmount: string;
      toAmount: string;
      fee: string;
    };

    // Validate the quote belongs to the same user and matches the requested parameters
    if (
      quote.userId !== userId ||
      quote.fromAsset !== fromAsset ||
      quote.toAsset !== toAsset ||
      quote.fromAmount !== new Decimal(amount).toFixed(8)
    ) {
      throw new Error('Quote parameters do not match the request');
    }

    amountDec = new Decimal(quote.fromAmount);
    fee = new Decimal(quote.fee);
    netAmount = amountDec.minus(fee);
    toAmount = new Decimal(quote.toAmount);

    // Delete the quote so it can't be reused
    await redis.del(`swap:quote:${quoteId}`);
  } else {
    // No quote provided — calculate fresh prices (legacy path)
    const fromPrice = await getPrice(fromAsset);
    const toPrice = await getPrice(toAsset);
    if (!fromPrice || !toPrice) throw new Error('Unable to fetch prices');

    const spread = env.PLATFORM_SPREAD_PERCENT / 100;
    amountDec = new Decimal(amount);
    fee = amountDec.times(env.TAKER_FEE_PERCENT / 100);
    netAmount = amountDec.minus(fee);

    const fromCadPrice = new Decimal(fromPrice.cadPrice);
    const toCadPrice = new Decimal(toPrice.cadPrice);
    const spreadDec = new Decimal(spread);
    const cadValue = netAmount.times(fromCadPrice.times(new Decimal(1).minus(spreadDec)));
    toAmount = cadValue.dividedBy(toCadPrice.times(new Decimal(1).plus(spreadDec)));
  }

  // Slippage protection
  if (minReceive && toAmount.lt(new Decimal(minReceive))) {
    throw new Error('Price moved beyond slippage tolerance. Please try again.');
  }

  const now = new Date();
  // Use quoteId for idempotency when available, otherwise derive a deterministic key
  // from the request parameters so retries produce the same key (preventing double-swap)
  const swapKey = quoteId ?? crypto.createHash('sha256')
    .update(`${userId}:${fromAsset}:${toAsset}:${amount}:${Math.floor(Date.now() / 60000)}`)
    .digest('hex').slice(0, 32);
  const idempotencyKey = `swap:${swapKey}`;

  // Atomic: balance check + debit/credit inside one transaction to prevent TOCTOU race
  await db.transaction(async (tx) => {
    // Check balance inside the transaction with the tx connection for snapshot consistency
    const balance = await getUserBalance(userId, fromAsset, tx);
    if (!balance || new Decimal(balance.available).lt(amountDec)) {
      throw new Error(`Insufficient ${fromAsset} balance`);
    }

    // User: debit fromAsset
    await mutateBalance(tx, {
      userId,
      asset: fromAsset,
      field: 'available',
      amount: amountDec.negated().toFixed(18),
      entryType: 'swap_out',
      idempotencyKey: `${idempotencyKey}:user:from`,
      note: `Swap ${fromAsset} to ${toAsset}`,
    });

    // User: credit toAsset
    await mutateBalance(tx, {
      userId,
      asset: toAsset,
      field: 'available',
      amount: toAmount.toFixed(18),
      entryType: 'swap_in',
      idempotencyKey: `${idempotencyKey}:user:to`,
      note: `Swap ${fromAsset} to ${toAsset}`,
    });

    // Platform: receive fromAsset (counterparty to the swap)
    await mutateBalance(tx, {
      userId: PLATFORM_USER_ID,
      asset: fromAsset,
      field: 'available',
      amount: amountDec.toFixed(18),
      entryType: 'swap_in',
      idempotencyKey: `${idempotencyKey}:platform:from`,
      note: `Platform swap counterparty: received ${fromAsset}`,
      allowNegative: true,
    });

    // Platform: provide toAsset (counterparty to the swap)
    await mutateBalance(tx, {
      userId: PLATFORM_USER_ID,
      asset: toAsset,
      field: 'available',
      amount: toAmount.negated().toFixed(18),
      entryType: 'swap_out',
      idempotencyKey: `${idempotencyKey}:platform:to`,
      note: `Platform swap counterparty: provided ${toAsset}`,
      allowNegative: true,
    });
  });

  // Notification
  await db.insert(notifications).values({
    userId,
    type: 'system',
    title: 'Swap Completed',
    message: `Swapped ${amountDec.toFixed(8)} ${fromAsset} for ${toAmount.toFixed(8)} ${toAsset} (fee: ${fee.toFixed(8)} ${fromAsset})`,
    metadata: { fromAsset, toAsset, fromAmount: amount, toAmount: toAmount.toFixed(8) },
  });

  logger.info({ userId, fromAsset, toAsset, amount, toAmount: toAmount.toFixed(8), quoteId }, 'swap executed');

  return {
    fromAsset,
    toAsset,
    fromAmount: amountDec.toFixed(8),
    toAmount: toAmount.toFixed(8),
    fee: fee.toFixed(8),
    feeAsset: fromAsset,
  };
}
