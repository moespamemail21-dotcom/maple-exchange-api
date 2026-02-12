import { db } from '../db/index.js';
import { wallets, deposits, notifications } from '../db/schema.js';
import { eq, and, sql, isNotNull } from 'drizzle-orm';
import { mutateBalance } from './balance.js';
import { CHAINS, REQUIRED_CONFIRMATIONS, CHAIN_ASSETS, MIN_DEPOSIT, type Chain } from './wallet.js';
import { env } from '../config/env.js';
import Decimal from 'decimal.js';
import axios from 'axios';
import { ethers } from 'ethers';
import { Connection, PublicKey } from '@solana/web3.js';
import { Client as XrplClient } from 'xrpl';

// ─── Types ──────────────────────────────────────────────────────────────────

interface WalletInfo {
  id: string;
  userId: string;
  chain: string;
  address: string;
  destinationTag: string | null;
}

// ─── Module State ───────────────────────────────────────────────────────────

let scanTimer: ReturnType<typeof setInterval> | null = null;
let ethLastScannedBlock: number | null = null;

// ERC-20 Transfer(address,address,uint256) event topic
const ERC20_TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

// ─── Start / Stop ───────────────────────────────────────────────────────────

export function startDepositMonitor(): ReturnType<typeof setInterval> {
  console.log(`  Deposit Monitor: scanning every ${env.DEPOSIT_SCAN_INTERVAL_MS / 1000}s`);

  scanForDeposits().catch((err) => {
    console.error('Deposit scan error:', err);
  });

  scanTimer = setInterval(async () => {
    try {
      await scanForDeposits();
    } catch (err) {
      console.error('Deposit scan error:', err);
    }
  }, env.DEPOSIT_SCAN_INTERVAL_MS);

  return scanTimer;
}

export function stopDepositMonitor() {
  if (scanTimer) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
}

// ─── Main Scan Loop ─────────────────────────────────────────────────────────

async function scanForDeposits() {
  // 1. Load all assigned wallets, grouped by chain
  const allWallets = await db
    .select({
      id: wallets.id,
      userId: wallets.userId,
      chain: wallets.chain,
      address: wallets.address,
      destinationTag: wallets.destinationTag,
    })
    .from(wallets)
    .where(isNotNull(wallets.userId));

  const walletsByChain = new Map<Chain, WalletInfo[]>();
  for (const w of allWallets) {
    if (!w.userId) continue;
    const chain = w.chain as Chain;
    if (!walletsByChain.has(chain)) walletsByChain.set(chain, []);
    walletsByChain.get(chain)!.push(w as WalletInfo);
  }

  // 2. Update confirmations on pending deposits
  await updatePendingConfirmations();

  // 3. Scan each chain for new incoming transactions
  for (const chain of CHAINS) {
    const chainWallets = walletsByChain.get(chain) ?? [];
    if (chainWallets.length === 0) continue;

    try {
      await scanChain(chain, chainWallets);
    } catch (err) {
      console.error(`[Deposit Monitor] ${chain} scan failed:`, err instanceof Error ? err.message : err);
    }
  }
}

// ─── Chain Dispatcher ───────────────────────────────────────────────────────

async function scanChain(chain: Chain, chainWallets: WalletInfo[]) {
  switch (chain) {
    case 'bitcoin':
      return scanBitcoin(chainWallets);
    case 'litecoin':
      return scanLitecoin(chainWallets);
    case 'ethereum':
      return scanEthereum(chainWallets);
    case 'xrp':
      return scanXRP(chainWallets);
    case 'solana':
      return scanSolana(chainWallets);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  BITCOIN — mempool.space REST API
// ═════════════════════════════════════════════════════════════════════════════

async function scanBitcoin(chainWallets: WalletInfo[]) {
  let newDeposits = 0;

  // Get current tip height for confirmation calculation
  let tipHeight: number;
  try {
    const { data } = await axios.get(`${env.MEMPOOL_API_URL}/blocks/tip/height`, { timeout: 10000 });
    tipHeight = Number(data);
  } catch {
    console.error('[Deposit Monitor] bitcoin: failed to get tip height');
    return;
  }

  for (const wallet of chainWallets) {
    try {
      const { data: txs } = await axios.get(
        `${env.MEMPOOL_API_URL}/address/${wallet.address}/txs`,
        { timeout: 10000 },
      );

      if (!Array.isArray(txs)) continue;

      for (const tx of txs) {
        // Sum all vouts that pay to our address (in satoshis)
        let satoshis = 0;
        for (const vout of tx.vout ?? []) {
          if (vout.scriptpubkey_address === wallet.address) {
            satoshis += vout.value ?? 0;
          }
        }
        if (satoshis === 0) continue;

        const amountBTC = new Decimal(satoshis).div(1e8).toFixed(8);
        if (new Decimal(amountBTC).lt(MIN_DEPOSIT.BTC)) continue;

        const confirmations = tx.status?.confirmed
          ? tipHeight - (tx.status.block_height as number) + 1
          : 0;

        const fromAddress = tx.vin?.[0]?.prevout?.scriptpubkey_address ?? undefined;

        await processNewDeposit({
          walletId: wallet.id,
          userId: wallet.userId,
          asset: 'BTC',
          chain: 'bitcoin',
          amount: amountBTC,
          txHash: tx.txid,
          fromAddress,
          confirmations,
        });
        newDeposits++;
      }

      // Rate limit: 1s between address queries
      await sleep(1000);
    } catch (err) {
      console.error(`[Deposit Monitor] bitcoin: error scanning ${wallet.address}:`, err instanceof Error ? err.message : err);
    }
  }

  if (newDeposits > 0) {
    console.log(`[Deposit Monitor] bitcoin: ${newDeposits} new deposit(s) detected`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  LITECOIN — litecoinspace.org REST API (mempool.space fork, identical API)
// ═════════════════════════════════════════════════════════════════════════════

async function scanLitecoin(chainWallets: WalletInfo[]) {
  let newDeposits = 0;

  let tipHeight: number;
  try {
    const { data } = await axios.get(`${env.LTC_API_URL}/blocks/tip/height`, { timeout: 10000 });
    tipHeight = Number(data);
  } catch {
    console.error('[Deposit Monitor] litecoin: failed to get tip height');
    return;
  }

  for (const wallet of chainWallets) {
    try {
      const { data: txs } = await axios.get(
        `${env.LTC_API_URL}/address/${wallet.address}/txs`,
        { timeout: 10000 },
      );

      if (!Array.isArray(txs)) continue;

      for (const tx of txs) {
        let satoshis = 0;
        for (const vout of tx.vout ?? []) {
          if (vout.scriptpubkey_address === wallet.address) {
            satoshis += vout.value ?? 0;
          }
        }
        if (satoshis === 0) continue;

        const amountLTC = new Decimal(satoshis).div(1e8).toFixed(8);
        if (new Decimal(amountLTC).lt(MIN_DEPOSIT.LTC)) continue;

        const confirmations = tx.status?.confirmed
          ? tipHeight - (tx.status.block_height as number) + 1
          : 0;

        const fromAddress = tx.vin?.[0]?.prevout?.scriptpubkey_address ?? undefined;

        await processNewDeposit({
          walletId: wallet.id,
          userId: wallet.userId,
          asset: 'LTC',
          chain: 'litecoin',
          amount: amountLTC,
          txHash: tx.txid,
          fromAddress,
          confirmations,
        });
        newDeposits++;
      }

      await sleep(1000);
    } catch (err) {
      console.error(`[Deposit Monitor] litecoin: error scanning ${wallet.address}:`, err instanceof Error ? err.message : err);
    }
  }

  if (newDeposits > 0) {
    console.log(`[Deposit Monitor] litecoin: ${newDeposits} new deposit(s) detected`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  ETHEREUM — ethers.js JsonRpcProvider (ETH native + LINK ERC-20)
// ═════════════════════════════════════════════════════════════════════════════

async function scanEthereum(chainWallets: WalletInfo[]) {
  let newDeposits = 0;

  const provider = new ethers.JsonRpcProvider(env.ETH_RPC_URL);
  const currentBlock = await provider.getBlockNumber();

  // Initialize last scanned block on first run
  if (ethLastScannedBlock === null) {
    ethLastScannedBlock = currentBlock - 50;
  }

  // Don't re-scan already scanned blocks
  if (currentBlock <= ethLastScannedBlock) return;

  // Cap at 50 blocks per cycle to avoid overloading
  const fromBlock = ethLastScannedBlock + 1;
  const toBlock = Math.min(currentBlock, fromBlock + 49);

  // Build address lookup set (lowercased for comparison)
  const addressSet = new Set<string>();
  const addressToWallet = new Map<string, WalletInfo>();
  for (const w of chainWallets) {
    const lower = w.address.toLowerCase();
    addressSet.add(lower);
    addressToWallet.set(lower, w);
  }

  // ── Scan for native ETH transfers ──
  for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
    try {
      const block = await provider.getBlock(blockNum, true);
      if (!block || !block.prefetchedTransactions) continue;

      for (const tx of block.prefetchedTransactions) {
        if (!tx.to) continue;
        const recipient = tx.to.toLowerCase();
        if (!addressSet.has(recipient)) continue;
        if (tx.value === 0n) continue;

        const wallet = addressToWallet.get(recipient)!;
        const amountETH = ethers.formatEther(tx.value);
        if (new Decimal(amountETH).lt(MIN_DEPOSIT.ETH)) continue;

        const confirmations = currentBlock - blockNum;

        await processNewDeposit({
          walletId: wallet.id,
          userId: wallet.userId,
          asset: 'ETH',
          chain: 'ethereum',
          amount: amountETH,
          txHash: tx.hash,
          fromAddress: tx.from,
          confirmations,
        });
        newDeposits++;
      }
    } catch (err) {
      console.error(`[Deposit Monitor] ethereum: error scanning block ${blockNum}:`, err instanceof Error ? err.message : err);
    }
  }

  // ── Scan for LINK (ERC-20) Transfer events ──
  try {
    // Build padded address topics for filtering
    const paddedAddresses = chainWallets.map(
      (w) => '0x' + w.address.slice(2).toLowerCase().padStart(64, '0'),
    );

    // Query Transfer logs in batches (max 10 addresses per query to avoid RPC limits)
    for (let i = 0; i < paddedAddresses.length; i += 10) {
      const batch = paddedAddresses.slice(i, i + 10);

      // When single address, filter by topic[2]; otherwise fetch all and filter manually
      const logFilter: ethers.Filter = {
        fromBlock: fromBlock,
        toBlock: toBlock,
        address: env.LINK_CONTRACT,
        topics: batch.length === 1
          ? [ERC20_TRANSFER_TOPIC, null, batch[0]]
          : [ERC20_TRANSFER_TOPIC],
      };
      const logs = await provider.getLogs(logFilter);

      const targetSet = new Set(batch);
      const filteredLogs = batch.length === 1
        ? logs
        : logs.filter((log) => log.topics[2] && targetSet.has(log.topics[2]));

      for (const log of filteredLogs) {
        const recipientTopic = log.topics[2];
        if (!recipientTopic) continue;
        const recipientAddr = '0x' + recipientTopic.slice(26).toLowerCase();
        const wallet = addressToWallet.get(recipientAddr);
        if (!wallet) continue;

        // Decode amount (uint256 in data, 18 decimals)
        const amountRaw = BigInt(log.data);
        const amountLINK = ethers.formatUnits(amountRaw, 18);
        if (new Decimal(amountLINK).lt(MIN_DEPOSIT.LINK)) continue;

        const confirmations = currentBlock - log.blockNumber;

        await processNewDeposit({
          walletId: wallet.id,
          userId: wallet.userId,
          asset: 'LINK',
          chain: 'ethereum',
          amount: amountLINK,
          txHash: log.transactionHash,
          confirmations,
        });
        newDeposits++;
      }
    }
  } catch (err) {
    console.error('[Deposit Monitor] ethereum: error scanning LINK transfers:', err instanceof Error ? err.message : err);
  }

  ethLastScannedBlock = toBlock;

  if (newDeposits > 0) {
    console.log(`[Deposit Monitor] ethereum: ${newDeposits} new deposit(s) detected (blocks ${fromBlock}-${toBlock})`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  XRP — xrpl WebSocket client
// ═════════════════════════════════════════════════════════════════════════════

async function scanXRP(chainWallets: WalletInfo[]) {
  let newDeposits = 0;

  const client = new XrplClient(env.XRP_WSS_URL);
  try {
    await client.connect();

    for (const wallet of chainWallets) {
      try {
        const response = await client.request({
          command: 'account_tx',
          account: wallet.address,
          limit: 20,
          ledger_index_min: -1,
          ledger_index_max: -1,
        });

        const txs = (response.result as any).transactions ?? [];

        for (const entry of txs) {
          const tx = entry.tx ?? entry.tx_blob;
          const meta = entry.meta;
          if (!tx || !meta) continue;

          // Only care about validated Payment transactions
          if (tx.TransactionType !== 'Payment') continue;
          if (!entry.validated) continue;

          // Must be incoming (Destination is our address)
          if (tx.Destination !== wallet.address) continue;

          // Check destination tag if wallet has one
          if (wallet.destinationTag) {
            const expectedTag = Number(wallet.destinationTag);
            if (tx.DestinationTag !== expectedTag) continue;
          }

          // Only handle native XRP (Amount is string of drops)
          if (typeof tx.Amount !== 'string') continue;

          const amountXRP = new Decimal(tx.Amount).div(1e6).toFixed(6);
          if (new Decimal(amountXRP).lt(MIN_DEPOSIT.XRP)) continue;

          // XRP validated = final (1 confirmation)
          await processNewDeposit({
            walletId: wallet.id,
            userId: wallet.userId,
            asset: 'XRP',
            chain: 'xrp',
            amount: amountXRP,
            txHash: tx.hash ?? (tx as any).Hash ?? '',
            fromAddress: tx.Account,
            confirmations: REQUIRED_CONFIRMATIONS.xrp, // Validated = confirmed
          });
          newDeposits++;
        }
      } catch (err: any) {
        // actNotFound means account has no on-ledger existence yet (no XRP received)
        if (err?.data?.error === 'actNotFound') continue;
        console.error(`[Deposit Monitor] xrp: error scanning ${wallet.address}:`, err instanceof Error ? err.message : err);
      }
    }

    if (newDeposits > 0) {
      console.log(`[Deposit Monitor] xrp: ${newDeposits} new deposit(s) detected`);
    }
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SOLANA — @solana/web3.js
// ═════════════════════════════════════════════════════════════════════════════

async function scanSolana(chainWallets: WalletInfo[]) {
  let newDeposits = 0;

  const connection = new Connection(env.SOL_RPC_URL);

  for (const wallet of chainWallets) {
    try {
      const pubkey = new PublicKey(wallet.address);
      const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 20 });

      for (const sigInfo of signatures) {
        if (sigInfo.err) continue; // Skip failed transactions

        const tx = await connection.getTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (!tx || !tx.meta) continue;

        // Find account index for our address
        const accountKeys = tx.transaction.message.getAccountKeys();
        let accountIndex = -1;
        for (let i = 0; i < accountKeys.length; i++) {
          if (accountKeys.get(i)?.toBase58() === wallet.address) {
            accountIndex = i;
            break;
          }
        }
        if (accountIndex === -1) continue;

        // Calculate received amount (post - pre, in lamports)
        const pre = tx.meta.preBalances[accountIndex] ?? 0;
        const post = tx.meta.postBalances[accountIndex] ?? 0;
        const diffLamports = post - pre;
        if (diffLamports <= 0) continue; // Not an incoming transfer

        const amountSOL = new Decimal(diffLamports).div(1e9).toFixed(9);
        if (new Decimal(amountSOL).lt(MIN_DEPOSIT.SOL)) continue;

        // Determine confirmations
        let confirmations = 0;
        if (sigInfo.confirmationStatus === 'finalized') {
          confirmations = REQUIRED_CONFIRMATIONS.solana; // 32
        } else {
          // Query for exact confirmation count
          const statuses = await connection.getSignatureStatuses([sigInfo.signature]);
          confirmations = statuses?.value?.[0]?.confirmations ?? 0;
        }

        // Try to determine sender (first signer that isn't us)
        let fromAddress: string | undefined;
        for (let i = 0; i < accountKeys.length; i++) {
          const addr = accountKeys.get(i)?.toBase58();
          if (addr && addr !== wallet.address && tx.transaction.message.isAccountSigner(i)) {
            fromAddress = addr;
            break;
          }
        }

        await processNewDeposit({
          walletId: wallet.id,
          userId: wallet.userId,
          asset: 'SOL',
          chain: 'solana',
          amount: amountSOL,
          txHash: sigInfo.signature,
          fromAddress,
          confirmations,
        });
        newDeposits++;
      }
    } catch (err) {
      console.error(`[Deposit Monitor] solana: error scanning ${wallet.address}:`, err instanceof Error ? err.message : err);
    }
  }

  if (newDeposits > 0) {
    console.log(`[Deposit Monitor] solana: ${newDeposits} new deposit(s) detected`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  UPDATE PENDING CONFIRMATIONS
// ═════════════════════════════════════════════════════════════════════════════

async function updatePendingConfirmations() {
  const pendingDeposits = await db
    .select()
    .from(deposits)
    .where(eq(deposits.status, 'pending'));

  if (pendingDeposits.length === 0) return;

  // Group by chain for efficient RPC usage
  const btcPending = pendingDeposits.filter((d) => d.chain === 'bitcoin');
  const ltcPending = pendingDeposits.filter((d) => d.chain === 'litecoin');
  const ethPending = pendingDeposits.filter((d) => d.chain === 'ethereum');
  const xrpPending = pendingDeposits.filter((d) => d.chain === 'xrp');
  const solPending = pendingDeposits.filter((d) => d.chain === 'solana');

  // ── BTC confirmations ──
  if (btcPending.length > 0) {
    try {
      const { data: tipHeight } = await axios.get(`${env.MEMPOOL_API_URL}/blocks/tip/height`, { timeout: 10000 });
      for (const deposit of btcPending) {
        try {
          const { data: txData } = await axios.get(`${env.MEMPOOL_API_URL}/tx/${deposit.txHash}`, { timeout: 10000 });
          const confs = txData.status?.confirmed
            ? Number(tipHeight) - (txData.status.block_height as number) + 1
            : 0;
          await updateDepositConfirmations(deposit, confs);
        } catch { /* skip individual tx errors */ }
      }
    } catch {
      console.error('[Deposit Monitor] bitcoin: failed to update confirmations');
    }
  }

  // ── LTC confirmations ──
  if (ltcPending.length > 0) {
    try {
      const { data: tipHeight } = await axios.get(`${env.LTC_API_URL}/blocks/tip/height`, { timeout: 10000 });
      for (const deposit of ltcPending) {
        try {
          const { data: txData } = await axios.get(`${env.LTC_API_URL}/tx/${deposit.txHash}`, { timeout: 10000 });
          const confs = txData.status?.confirmed
            ? Number(tipHeight) - (txData.status.block_height as number) + 1
            : 0;
          await updateDepositConfirmations(deposit, confs);
        } catch { /* skip individual tx errors */ }
      }
    } catch {
      console.error('[Deposit Monitor] litecoin: failed to update confirmations');
    }
  }

  // ── ETH / LINK confirmations ──
  if (ethPending.length > 0) {
    try {
      const provider = new ethers.JsonRpcProvider(env.ETH_RPC_URL);
      const currentBlock = await provider.getBlockNumber();

      for (const deposit of ethPending) {
        try {
          const receipt = await provider.getTransactionReceipt(deposit.txHash);
          if (!receipt) continue;
          const confs = currentBlock - receipt.blockNumber + 1;
          await updateDepositConfirmations(deposit, confs);
        } catch { /* skip */ }
      }
    } catch {
      console.error('[Deposit Monitor] ethereum: failed to update confirmations');
    }
  }

  // ── XRP confirmations ──
  // XRP validated = final, set to required confirmations
  for (const deposit of xrpPending) {
    await updateDepositConfirmations(deposit, REQUIRED_CONFIRMATIONS.xrp);
  }

  // ── SOL confirmations ──
  if (solPending.length > 0) {
    try {
      const connection = new Connection(env.SOL_RPC_URL);
      const sigs = solPending.map((d) => d.txHash);
      const statuses = await connection.getSignatureStatuses(sigs);

      for (let i = 0; i < solPending.length; i++) {
        const status = statuses?.value?.[i];
        if (!status) continue;
        const confs = status.confirmationStatus === 'finalized'
          ? REQUIRED_CONFIRMATIONS.solana
          : (status.confirmations ?? 0);
        await updateDepositConfirmations(solPending[i], confs);
      }
    } catch {
      console.error('[Deposit Monitor] solana: failed to update confirmations');
    }
  }
}

/**
 * Update a deposit's confirmation count and credit if threshold reached.
 */
async function updateDepositConfirmations(
  deposit: typeof deposits.$inferSelect,
  newConfirmations: number,
) {
  if (newConfirmations <= deposit.confirmations) return; // No change

  await db
    .update(deposits)
    .set({ confirmations: newConfirmations })
    .where(eq(deposits.id, deposit.id));

  if (newConfirmations >= deposit.requiredConfirmations) {
    await creditDeposit(deposit.id);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  PROCESS NEW DEPOSIT (unchanged logic — already idempotent)
// ═════════════════════════════════════════════════════════════════════════════

export async function processNewDeposit(params: {
  walletId: string;
  userId: string;
  asset: string;
  chain: string;
  amount: string;
  txHash: string;
  fromAddress?: string;
  confirmations?: number;
}) {
  const { walletId, userId, asset, chain, amount, txHash, fromAddress, confirmations = 0 } = params;

  const chainKey = chain as Chain;
  const required = REQUIRED_CONFIRMATIONS[chainKey] ?? 6;

  await db.transaction(async (tx) => {
    // Insert deposit record (idempotent via unique txHash+chain)
    try {
      await tx.insert(deposits).values({
        userId,
        walletId,
        asset,
        chain,
        amount,
        txHash,
        fromAddress: fromAddress ?? null,
        confirmations,
        requiredConfirmations: required,
        status: 'pending',
      });
    } catch (err: any) {
      // Duplicate txHash+chain — already processed
      if (err.code === '23505') return;
      throw err;
    }

    // Add to pending deposit balance
    await mutateBalance(tx, {
      userId,
      asset,
      field: 'pendingDeposit',
      amount,
      entryType: 'deposit_pending',
      idempotencyKey: `deposit:${txHash}:${chain}:pending`,
      note: `Deposit detected: ${amount} ${asset} (${confirmations}/${required} confirmations)`,
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  CREDIT DEPOSIT (moves pending → available when fully confirmed)
// ═════════════════════════════════════════════════════════════════════════════

async function creditDeposit(depositId: string) {
  await db.transaction(async (tx) => {
    // Lock and get the deposit
    const result = await tx.execute(
      sql`SELECT * FROM deposits WHERE id = ${depositId} AND status = 'pending' FOR UPDATE`,
    ) as any;

    const rows = Array.isArray(result) ? result : result?.rows ?? [];
    if (rows.length === 0) return;
    const deposit = rows[0] as any;

    // Move from pending → credited
    await tx
      .update(deposits)
      .set({
        status: 'credited',
        confirmedAt: new Date(),
        creditedAt: new Date(),
      })
      .where(eq(deposits.id, depositId));

    // Clear pending deposit balance
    await mutateBalance(tx, {
      userId: deposit.user_id,
      asset: deposit.asset,
      field: 'pendingDeposit',
      amount: new Decimal(deposit.amount).negated().toFixed(18),
      entryType: 'deposit_pending_cleared',
      idempotencyKey: `deposit:${depositId}:clear_pending`,
      depositId,
      note: `Deposit confirmed: ${deposit.amount} ${deposit.asset}`,
    });

    // Credit available balance
    await mutateBalance(tx, {
      userId: deposit.user_id,
      asset: deposit.asset,
      field: 'available',
      amount: deposit.amount,
      entryType: 'deposit_confirmed',
      idempotencyKey: `deposit:${depositId}:credit`,
      depositId,
      note: `Deposit credited: ${deposit.amount} ${deposit.asset}`,
    });

    // Create notification for user
    await tx.insert(notifications).values({
      userId: deposit.user_id,
      type: 'deposit_confirmed',
      title: 'Deposit Confirmed',
      message: `Your deposit of ${deposit.amount} ${deposit.asset} has been confirmed and credited to your account.`,
      metadata: { asset: deposit.asset, amount: deposit.amount, txHash: deposit.tx_hash },
    });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
