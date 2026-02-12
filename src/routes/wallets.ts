import { FastifyInstance } from 'fastify';
import { db } from '../db/index.js';
import { wallets } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { authGuard } from '../middleware/auth.js';
import { CHAIN_ASSETS, REQUIRED_CONFIRMATIONS, MIN_DEPOSIT, type Chain } from '../services/wallet.js';
import { claimPoolWallets } from '../services/wallet-pool.js';

/** Network display names */
const NETWORK_NAMES: Record<string, string> = {
  bitcoin: 'Bitcoin',
  ethereum: 'Ethereum (ERC-20)',
  litecoin: 'Litecoin',
  xrp: 'XRP Ledger',
  solana: 'Solana',
};

export async function walletRoutes(app: FastifyInstance) {
  // ─── Get All Deposit Addresses ──────────────────────────────────────
  app.get('/api/wallets', { preHandler: [authGuard] }, async (request) => {
    let userWallets = await db
      .select({
        id: wallets.id,
        chain: wallets.chain,
        address: wallets.address,
        destinationTag: wallets.destinationTag,
      })
      .from(wallets)
      .where(eq(wallets.userId, request.userId));

    // Lazy wallet generation for users who registered before wallet pool existed
    if (userWallets.length === 0) {
      await db.transaction(async (tx) => {
        await claimPoolWallets(tx, request.userId);
      });
      userWallets = await db
        .select({
          id: wallets.id,
          chain: wallets.chain,
          address: wallets.address,
          destinationTag: wallets.destinationTag,
        })
        .from(wallets)
        .where(eq(wallets.userId, request.userId));
    }

    // Enrich with network metadata
    const enriched = userWallets.map((w) => {
      const chain = w.chain as Chain;
      return {
        ...w,
        networkName: NETWORK_NAMES[chain] ?? chain,
        assets: CHAIN_ASSETS[chain] ?? [],
        requiredConfirmations: REQUIRED_CONFIRMATIONS[chain] ?? 0,
        minDeposit: CHAIN_ASSETS[chain]?.reduce((acc, asset) => {
          acc[asset] = MIN_DEPOSIT[asset] ?? '0';
          return acc;
        }, {} as Record<string, string>) ?? {},
      };
    });

    return { wallets: enriched };
  });

  // ─── Get Deposit Address for Specific Chain ─────────────────────────
  app.get('/api/wallets/:chain', { preHandler: [authGuard] }, async (request, reply) => {
    const { chain } = request.params as { chain: string };

    const [wallet] = await db
      .select({
        id: wallets.id,
        chain: wallets.chain,
        address: wallets.address,
        destinationTag: wallets.destinationTag,
      })
      .from(wallets)
      .where(and(eq(wallets.userId, request.userId), eq(wallets.chain, chain)));

    if (!wallet) {
      return reply.status(404).send({ error: `No wallet found for chain: ${chain}` });
    }

    const c = wallet.chain as Chain;
    return {
      ...wallet,
      networkName: NETWORK_NAMES[c] ?? c,
      assets: CHAIN_ASSETS[c] ?? [],
      requiredConfirmations: REQUIRED_CONFIRMATIONS[c] ?? 0,
      minDeposit: CHAIN_ASSETS[c]?.reduce((acc, asset) => {
        acc[asset] = MIN_DEPOSIT[asset] ?? '0';
        return acc;
      }, {} as Record<string, string>) ?? {},
    };
  });
}
