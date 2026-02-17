import { db } from '../db/index.js';
import { withdrawals, wallets, notifications } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { mutateBalance } from './balance.js';
import { decryptPrivateKey, ASSET_TO_CHAIN, type Chain } from './wallet.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import Decimal from 'decimal.js';
import axios from 'axios';
import { ethers } from 'ethers';
import { Transaction as BtcTransaction, p2wpkh, NETWORK } from '@scure/btc-signer';
import { Connection, PublicKey, Keypair, SystemProgram, Transaction as SolTransaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { Client as XrplClient, Wallet as XrplWallet, xrpToDrops } from 'xrpl';

// ─── Module State ───────────────────────────────────────────────────────────

let broadcastTimer: ReturnType<typeof setInterval> | null = null;

// Litecoin network params for @scure/btc-signer
const LTC_NETWORK = {
  bech32: 'ltc',
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
} as typeof NETWORK;

// ─── Start / Stop ───────────────────────────────────────────────────────────

export function startWithdrawalBroadcaster(): ReturnType<typeof setInterval> {
  logger.info(`  Withdrawal Broadcaster: processing every ${env.WITHDRAWAL_BROADCAST_INTERVAL_MS / 1000}s`);

  processWithdrawals().catch((err) => {
    logger.error({ err }, 'Withdrawal broadcast error');
  });

  broadcastTimer = setInterval(async () => {
    try {
      await processWithdrawals();
    } catch (err) {
      logger.error({ err }, 'Withdrawal broadcast error');
    }
  }, env.WITHDRAWAL_BROADCAST_INTERVAL_MS);

  return broadcastTimer;
}

export function stopWithdrawalBroadcaster() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
}

// ─── Main Processing Loop ───────────────────────────────────────────────────

async function processWithdrawals() {
  // 1. Pick up approved withdrawals (with row-level locking to prevent double-broadcast)
  await broadcastApproved();

  // 2. Check broadcasting withdrawals for confirmations
  await checkBroadcasting();
}

// ─── Broadcast Approved Withdrawals ─────────────────────────────────────────

async function broadcastApproved() {
  // Atomically claim up to 5 approved withdrawals by setting status='broadcasting'.
  // This prevents double-broadcast: two concurrent instances can't both claim the same row.
  const result = await db.execute(
    sql`UPDATE withdrawals
        SET status = 'broadcasting', broadcast_at = NOW()
        WHERE id IN (
          SELECT id FROM withdrawals
          WHERE status = 'approved'
          ORDER BY approved_at ASC
          LIMIT 5
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
  ) as any;

  const rows = Array.isArray(result) ? result : result?.rows ?? [];
  if (rows.length === 0) return;

  for (const withdrawal of rows) {
    try {
      // Get user's wallet for this chain
      const chain = withdrawal.chain as Chain;
      const [wallet] = await db
        .select()
        .from(wallets)
        .where(and(eq(wallets.userId, withdrawal.user_id), eq(wallets.chain, chain)));

      if (!wallet || !wallet.encryptedPrivateKey) {
        throw new Error(`No wallet found for user ${withdrawal.user_id} on chain ${chain}`);
      }

      // Decrypt private key
      const privateKey = decryptPrivateKey(wallet.encryptedPrivateKey);

      // Sign and broadcast
      const txHash = await broadcastTransaction({
        chain,
        asset: withdrawal.asset,
        privateKey,
        fromAddress: wallet.address,
        toAddress: withdrawal.to_address,
        netAmount: withdrawal.net_amount,
        destinationTag: withdrawal.destination_tag,
      });

      // Update with txHash
      await db
        .update(withdrawals)
        .set({ txHash })
        .where(eq(withdrawals.id, withdrawal.id));

      logger.info({ withdrawalId: withdrawal.id, asset: withdrawal.asset, txHash, netAmount: withdrawal.net_amount }, 'withdrawal broadcast');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ withdrawalId: withdrawal.id, err: message }, 'withdrawal broadcast failed');

      // Refund balance and mark as failed
      try {
        await refundFailedWithdrawal(withdrawal, message);
      } catch (refundErr) {
        logger.fatal({
          withdrawalId: withdrawal.id,
          broadcastError: message,
          refundError: refundErr instanceof Error ? refundErr.message : String(refundErr),
        }, 'CRITICAL: Failed to refund failed withdrawal — manual intervention required');
      }
    }
  }
}

// ─── Per-Chain Transaction Broadcasting ─────────────────────────────────────

interface BroadcastParams {
  chain: Chain;
  asset: string;
  privateKey: string;
  fromAddress: string;
  toAddress: string;
  netAmount: string;
  destinationTag: string | null;
}

async function broadcastTransaction(params: BroadcastParams): Promise<string> {
  switch (params.chain) {
    case 'bitcoin':
      return broadcastBitcoin(params);
    case 'litecoin':
      return broadcastLitecoin(params);
    case 'ethereum':
      return params.asset === 'LINK'
        ? broadcastERC20(params)
        : broadcastEthereum(params);
    case 'xrp':
      return broadcastXRP(params);
    case 'solana':
      return broadcastSolana(params);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  BITCOIN — @scure/btc-signer + mempool.space
// ═════════════════════════════════════════════════════════════════════════════

async function broadcastBitcoin(params: BroadcastParams): Promise<string> {
  return broadcastUTXO(params, env.MEMPOOL_API_URL, NETWORK);
}

// ═════════════════════════════════════════════════════════════════════════════
//  LITECOIN — Same as BTC with LTC network params
// ═════════════════════════════════════════════════════════════════════════════

async function broadcastLitecoin(params: BroadcastParams): Promise<string> {
  return broadcastUTXO(params, env.LTC_API_URL, LTC_NETWORK);
}

/**
 * Shared UTXO-based broadcast for BTC and LTC (both use SegWit p2wpkh).
 */
async function broadcastUTXO(
  params: BroadcastParams,
  apiUrl: string,
  network: typeof NETWORK,
): Promise<string> {
  const privKeyBytes = Buffer.from(params.privateKey, 'hex');
  const pubKey = getPubKeyFromPriv(privKeyBytes);
  const payment = p2wpkh(pubKey, network);

  // 1. Fetch UTXOs
  const { data: utxos } = await axios.get(
    `${apiUrl}/address/${params.fromAddress}/utxo`,
    { timeout: 15000 },
  );
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new Error('No UTXOs available for sending');
  }

  // 2. Get recommended fee rate
  let feeRate = 10; // Default sat/vB
  try {
    const { data: fees } = await axios.get(`${apiUrl}/v1/fees/recommended`, { timeout: 10000 });
    feeRate = fees.halfHourFee ?? fees.fastestFee ?? 10;
  } catch { /* use default */ }

  // 3. Calculate output amount in satoshis
  const outputSats = BigInt(new Decimal(params.netAmount).times(1e8).round().toFixed(0));

  // 4. Select UTXOs — use actual vsize estimate from the start to avoid underflow
  const sortedUtxos = utxos.sort((a: any, b: any) => b.value - a.value);
  let totalInput = 0n;
  const selectedUtxos: any[] = [];

  // Pre-calculate: estimate fee based on inputs selected so far
  // SegWit p2wpkh: ~68 vB/input, ~31 vB/output, ~10 vB overhead
  function estimateFee(numInputs: number): bigint {
    const vsize = 10 + numInputs * 68 + 2 * 31; // 2 outputs (recipient + change)
    return BigInt(feeRate * vsize);
  }

  for (const utxo of sortedUtxos) {
    selectedUtxos.push(utxo);
    totalInput += BigInt(utxo.value);
    const fee = estimateFee(selectedUtxos.length);
    if (totalInput >= outputSats + fee) break;
  }

  const actualFee = estimateFee(selectedUtxos.length);
  if (totalInput < outputSats + actualFee) {
    throw new Error(`Insufficient UTXOs: have ${totalInput}, need ${outputSats + actualFee}`);
  }

  // 5. Build transaction
  const tx = new BtcTransaction();

  for (const utxo of selectedUtxos) {
    tx.addInput({
      txid: utxo.txid,
      index: utxo.vout,
      witnessUtxo: {
        script: payment.script,
        amount: BigInt(utxo.value),
      },
    });
  }

  // Output to recipient
  tx.addOutputAddress(params.toAddress, outputSats, network);

  // Change output (back to our address)
  const change = totalInput - outputSats - actualFee;

  if (change > 546n) { // dust threshold
    tx.addOutputAddress(params.fromAddress, change, network);
  }

  // 6. Sign all inputs
  tx.sign(privKeyBytes);
  tx.finalize();

  // 7. Broadcast
  const rawHex = Buffer.from(tx.extract()).toString('hex');
  const { data: txid } = await axios.post(`${apiUrl}/tx`, rawHex, {
    headers: { 'Content-Type': 'text/plain' },
    timeout: 15000,
  });

  return String(txid);
}

// ═════════════════════════════════════════════════════════════════════════════
//  ETHEREUM (native ETH) — ethers.js
// ═════════════════════════════════════════════════════════════════════════════

async function broadcastEthereum(params: BroadcastParams): Promise<string> {
  const provider = new ethers.JsonRpcProvider(env.ETH_RPC_URL);
  const wallet = new ethers.Wallet('0x' + params.privateKey, provider);

  const tx = await wallet.sendTransaction({
    to: params.toAddress,
    value: ethers.parseEther(params.netAmount),
  });

  return tx.hash;
}

// ═════════════════════════════════════════════════════════════════════════════
//  LINK (ERC-20) — ethers.js Contract
// ═════════════════════════════════════════════════════════════════════════════

async function broadcastERC20(params: BroadcastParams): Promise<string> {
  const provider = new ethers.JsonRpcProvider(env.ETH_RPC_URL);
  const wallet = new ethers.Wallet('0x' + params.privateKey, provider);

  const contract = new ethers.Contract(
    env.LINK_CONTRACT,
    ['function transfer(address to, uint256 amount) returns (bool)'],
    wallet,
  );

  const tx = await contract.transfer(
    params.toAddress,
    ethers.parseUnits(params.netAmount, 18),
  );

  return tx.hash;
}

// ═════════════════════════════════════════════════════════════════════════════
//  XRP — xrpl package
// ═════════════════════════════════════════════════════════════════════════════

async function broadcastXRP(params: BroadcastParams): Promise<string> {
  const client = new XrplClient(env.XRP_WSS_URL);
  try {
    await client.connect();

    // Derive compressed secp256k1 public key from private key
    const privKeyBytes = Buffer.from(params.privateKey, 'hex');
    const pubKeyHex = Buffer.from(getPubKeyFromPriv(privKeyBytes)).toString('hex').toUpperCase();
    const xrpWallet = new XrplWallet(pubKeyHex, '00' + params.privateKey.toUpperCase());

    // Build payment transaction
    const payment: any = {
      TransactionType: 'Payment' as const,
      Account: params.fromAddress,
      Destination: params.toAddress,
      Amount: xrpToDrops(params.netAmount),
    };

    if (params.destinationTag) {
      payment.DestinationTag = Number(params.destinationTag);
    }

    // Autofill sequence, fee, lastLedgerSequence
    const prepared = await client.autofill(payment);

    // Sign
    const signed = xrpWallet.sign(prepared);

    // Submit and wait for validation
    const result = await client.submitAndWait(signed.tx_blob);

    const txHash = (result.result as any).hash ?? signed.hash;
    return txHash;
  } finally {
    try { await client.disconnect(); } catch { /* ignore */ }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SOLANA — @solana/web3.js
// ═════════════════════════════════════════════════════════════════════════════

async function broadcastSolana(params: BroadcastParams): Promise<string> {
  const connection = new Connection(env.SOL_RPC_URL);

  // Reconstruct keypair from 64-byte secret key
  const secretKey = Buffer.from(params.privateKey, 'hex');
  const keypair = Keypair.fromSecretKey(new Uint8Array(secretKey));

  const toPubkey = new PublicKey(params.toAddress);
  const lamports = BigInt(new Decimal(params.netAmount).times(1e9).round().toFixed(0));

  const transaction = new SolTransaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey,
      lamports,
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [keypair]);
  return signature;
}

// ═════════════════════════════════════════════════════════════════════════════
//  CHECK BROADCASTING WITHDRAWALS FOR CONFIRMATION
// ═════════════════════════════════════════════════════════════════════════════

async function checkBroadcasting() {
  const broadcasting = await db
    .select()
    .from(withdrawals)
    .where(eq(withdrawals.status, 'broadcasting'));

  if (broadcasting.length === 0) return;

  for (const withdrawal of broadcasting) {
    if (!withdrawal.txHash) continue;

    try {
      const confirmed = await checkConfirmation(withdrawal.chain as Chain, withdrawal.txHash);
      if (!confirmed) continue;

      // Mark as confirmed (only if still broadcasting — prevents overwriting admin-cancelled)
      const [updated] = await db
        .update(withdrawals)
        .set({ status: 'confirmed', confirmedAt: new Date() })
        .where(and(eq(withdrawals.id, withdrawal.id), eq(withdrawals.status, 'broadcasting')))
        .returning({ id: withdrawals.id });

      if (!updated) continue; // Status changed by admin or concurrent process

      // Create notification
      await db.insert(notifications).values({
        userId: withdrawal.userId,
        type: 'withdrawal_sent',
        title: 'Withdrawal Confirmed',
        message: `Your withdrawal of ${withdrawal.netAmount} ${withdrawal.asset} has been confirmed on the network.`,
        metadata: {
          asset: withdrawal.asset,
          amount: withdrawal.netAmount,
          txHash: withdrawal.txHash,
          chain: withdrawal.chain,
        },
      });

      logger.info({ withdrawalId: withdrawal.id, asset: withdrawal.asset, txHash: withdrawal.txHash }, 'withdrawal confirmed');
    } catch (err) {
      // Don't fail — just retry next cycle
      logger.error({ withdrawalId: withdrawal.id, err: err instanceof Error ? err.message : err }, 'error checking withdrawal confirmation');
    }
  }
}

async function checkConfirmation(chain: Chain, txHash: string): Promise<boolean> {
  switch (chain) {
    case 'bitcoin':
      return checkUTXOConfirmation(env.MEMPOOL_API_URL, txHash);
    case 'litecoin':
      return checkUTXOConfirmation(env.LTC_API_URL, txHash);
    case 'ethereum':
      return checkETHConfirmation(txHash);
    case 'xrp':
      // XRP submitAndWait already ensures validation
      return true;
    case 'solana':
      return checkSOLConfirmation(txHash);
  }
}

async function checkUTXOConfirmation(apiUrl: string, txHash: string): Promise<boolean> {
  const { data } = await axios.get(`${apiUrl}/tx/${txHash}`, { timeout: 10000 });
  return !!data.status?.confirmed;
}

async function checkETHConfirmation(txHash: string): Promise<boolean> {
  const provider = new ethers.JsonRpcProvider(env.ETH_RPC_URL);
  const receipt = await provider.getTransactionReceipt(txHash);
  return receipt !== null && receipt.status === 1;
}

async function checkSOLConfirmation(signature: string): Promise<boolean> {
  const connection = new Connection(env.SOL_RPC_URL);
  const statuses = await connection.getSignatureStatuses([signature]);
  const status = statuses?.value?.[0];
  return status?.confirmationStatus === 'finalized';
}

// ─── Failed Withdrawal Refund ───────────────────────────────────────────────

async function refundFailedWithdrawal(withdrawal: any, failureReason: string) {
  await db.transaction(async (tx) => {
    // Only transition to 'failed' if still in a pre-terminal state
    const [updated] = await tx
      .update(withdrawals)
      .set({ status: 'failed', failureReason })
      .where(and(
        eq(withdrawals.id, withdrawal.id),
        sql`${withdrawals.status} IN ('approved', 'broadcasting')`,
      ))
      .returning({ id: withdrawals.id });

    if (!updated) {
      // Withdrawal was already confirmed, cancelled, or failed — skip refund
      return;
    }

    // Refund the full debited amount (including fee) back to available
    await mutateBalance(tx, {
      userId: withdrawal.user_id,
      asset: withdrawal.asset,
      field: 'available',
      amount: withdrawal.amount, // Full amount including fee
      entryType: 'withdrawal_failed',
      idempotencyKey: `withdrawal_refund:${withdrawal.id}`,
      withdrawalId: withdrawal.id,
      note: `Withdrawal broadcast failed: ${failureReason}`,
    });

    // Notify user about the failed withdrawal
    await tx.insert(notifications).values({
      userId: withdrawal.user_id,
      type: 'withdrawal_update',
      title: 'Withdrawal Failed',
      message: `Your withdrawal of ${withdrawal.amount} ${withdrawal.asset} has failed. Funds have been refunded.`,
      metadata: {
        withdrawalId: withdrawal.id,
        asset: withdrawal.asset,
        amount: withdrawal.amount,
        chain: withdrawal.chain,
      },
    });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Derive compressed public key from raw secp256k1 private key bytes.
 * Uses ethers.js SigningKey which wraps noble/curves internally.
 */
function getPubKeyFromPriv(privKey: Uint8Array): Uint8Array {
  const signingKey = new ethers.SigningKey('0x' + Buffer.from(privKey).toString('hex'));
  // ethers compressedPublicKey is "0x02..." or "0x03..." (33 bytes hex)
  return Buffer.from(signingKey.compressedPublicKey.slice(2), 'hex');
}
