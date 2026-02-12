/**
 * Pre-generate wallet pool for Maple Exchange.
 *
 * Usage:
 *   npx tsx scripts/generate-wallets.ts [count] [chain]
 *   npx tsx scripts/generate-wallets.ts 100          # 100 per chain (500 total)
 *   npx tsx scripts/generate-wallets.ts 200 bitcoin   # 200 BTC wallets only
 */

import { db } from '../src/db/index.js';
import { wallets } from '../src/db/schema.js';
import { CHAINS, type Chain, deriveWallet, allocateIndex, seedWalletCounters } from '../src/services/wallet.js';
import { getPoolStatus } from '../src/services/wallet-pool.js';

const BATCH_SIZE = 20;

async function main() {
  const countArg = parseInt(process.argv[2] ?? '100', 10);
  const chainArg = process.argv[3] as Chain | undefined;

  if (isNaN(countArg) || countArg < 1) {
    console.error('Usage: npx tsx scripts/generate-wallets.ts [count] [chain]');
    process.exit(1);
  }

  const chains = chainArg ? [chainArg] : [...CHAINS];

  // Validate chain arg
  if (chainArg && !CHAINS.includes(chainArg)) {
    console.error(`Invalid chain "${chainArg}". Valid: ${CHAINS.join(', ')}`);
    process.exit(1);
  }

  // Ensure wallet counters exist
  await db.transaction(async (tx) => {
    await seedWalletCounters(tx);
  });

  console.log(`\nGenerating ${countArg} wallet(s) per chain for: ${chains.join(', ')}\n`);

  for (const chain of chains) {
    let generated = 0;

    while (generated < countArg) {
      const batchCount = Math.min(BATCH_SIZE, countArg - generated);

      await db.transaction(async (tx) => {
        for (let i = 0; i < batchCount; i++) {
          const index = await allocateIndex(tx, chain);
          const derived = deriveWallet(chain, index);

          await tx.insert(wallets).values({
            userId: null, // unassigned pool wallet
            chain,
            address: derived.address,
            derivationPath: derived.derivationPath,
            destinationTag: derived.destinationTag ?? null,
            encryptedPrivateKey: derived.encryptedPrivateKey,
            addressIndex: index,
          });
        }
      });

      generated += batchCount;
      process.stdout.write(`  ${chain}: ${generated}/${countArg}\r`);
    }

    console.log(`  ${chain}: ${generated}/${countArg} ✓`);
  }

  // Print pool status
  console.log('\n── Pool Status ──────────────────────────');
  const status = await getPoolStatus();
  for (const s of status) {
    console.log(`  ${s.chain.padEnd(10)} ${s.available} available`);
  }
  console.log('');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
