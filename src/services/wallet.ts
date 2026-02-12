import { sql } from 'drizzle-orm';
import { wallets } from '../db/schema.js';
import { env } from '../config/env.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { createCipheriv, createDecipheriv, randomBytes, createHmac } from 'node:crypto';
import { ethers } from 'ethers';
import { Keypair } from '@solana/web3.js';

// ─── Chain Configuration ─────────────────────────────────────────────────────

export const CHAINS = ['bitcoin', 'ethereum', 'litecoin', 'xrp', 'solana'] as const;
export type Chain = (typeof CHAINS)[number];

export const CHAIN_ASSETS: Record<Chain, string[]> = {
  bitcoin: ['BTC'],
  ethereum: ['ETH', 'LINK'], // LINK is ERC-20, shares ETH address
  litecoin: ['LTC'],
  xrp: ['XRP'],
  solana: ['SOL'],
};

export const REQUIRED_CONFIRMATIONS: Record<Chain, number> = {
  bitcoin: 2,
  ethereum: 12,
  litecoin: 6,
  xrp: 1,
  solana: 32,
};

export const MIN_DEPOSIT: Record<string, string> = {
  BTC: '0.0001',
  ETH: '0.001',
  LTC: '0.01',
  XRP: '1',
  SOL: '0.01',
  LINK: '0.1',
};

export const ASSET_TO_CHAIN: Record<string, Chain> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  LTC: 'litecoin',
  XRP: 'xrp',
  SOL: 'solana',
  LINK: 'ethereum',
};

// ─── AES-256-GCM Encryption ─────────────────────────────────────────────────

function getEncryptionKey(): Buffer {
  return Buffer.from(env.WALLET_ENCRYPTION_KEY, 'hex');
}

export function encryptPrivateKey(privateKeyHex: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(privateKeyHex, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Wire format: base64(iv || authTag || ciphertext)
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

export function decryptPrivateKey(encrypted: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(encrypted, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

// ─── Seed Management ─────────────────────────────────────────────────────────

function getMnemonic(chain: Chain): string {
  const map: Record<Chain, string> = {
    bitcoin: env.WALLET_SEED_BTC,
    ethereum: env.WALLET_SEED_ETH,
    litecoin: env.WALLET_SEED_LTC,
    xrp: env.WALLET_SEED_XRP,
    solana: env.WALLET_SEED_SOL,
  };
  return map[chain];
}

function getSeed(chain: Chain): Uint8Array {
  return mnemonicToSeedSync(getMnemonic(chain));
}

// ─── Derived Wallet Result ───────────────────────────────────────────────────

export interface DerivedWallet {
  address: string;
  encryptedPrivateKey: string;
  derivationPath: string;
  destinationTag?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BITCOIN — BIP-84 native SegWit (bc1q...)
//  Derivation: @scure/bip32 secp256k1 → RIPEMD160(SHA256(pubkey)) → bech32
// ═══════════════════════════════════════════════════════════════════════════════

function deriveBitcoinWallet(index: number): DerivedWallet {
  const path = `m/84'/0'/0'/0/${index}`;
  const seed = getSeed('bitcoin');
  const child = HDKey.fromMasterSeed(seed).derive(path);
  if (!child.publicKey || !child.privateKey) throw new Error('BTC derivation failed');

  const pubkeyHash = ripemd160(sha256(child.publicKey));
  return {
    address: encodeBech32('bc', 0, pubkeyHash),
    encryptedPrivateKey: encryptPrivateKey(Buffer.from(child.privateKey).toString('hex')),
    derivationPath: path,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ETHEREUM — BIP-44, keccak256 address via ethers.js
//  ethers handles: secp256k1 → uncompress pubkey → keccak256 → last 20 bytes
//  → EIP-55 checksum address. This is the ONLY correct way.
// ═══════════════════════════════════════════════════════════════════════════════

function deriveEthereumWallet(index: number): DerivedWallet {
  const path = `m/44'/60'/0'/0/${index}`;
  const mnemonic = getMnemonic('ethereum');
  const hdNode = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path);

  return {
    address: hdNode.address, // proper keccak256-derived checksum address
    encryptedPrivateKey: encryptPrivateKey(hdNode.privateKey.slice(2)),
    derivationPath: path,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LITECOIN — BIP-84 native SegWit (ltc1q...)
//  Same math as BTC but HRP='ltc', coin type=2
// ═══════════════════════════════════════════════════════════════════════════════

function deriveLitecoinWallet(index: number): DerivedWallet {
  const path = `m/84'/2'/0'/0/${index}`;
  const seed = getSeed('litecoin');
  const child = HDKey.fromMasterSeed(seed).derive(path);
  if (!child.publicKey || !child.privateKey) throw new Error('LTC derivation failed');

  const pubkeyHash = ripemd160(sha256(child.publicKey));
  return {
    address: encodeBech32('ltc', 0, pubkeyHash),
    encryptedPrivateKey: encryptPrivateKey(Buffer.from(child.privateKey).toString('hex')),
    derivationPath: path,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  XRP — BIP-44 secp256k1, XRP classic address (r...)
//  RIPEMD160(SHA256(pubkey)) → Base58Check with version 0x00
//  Destination tag = unique integer per user for shared-address identification
// ═══════════════════════════════════════════════════════════════════════════════

function deriveXRPWallet(index: number): DerivedWallet {
  const path = `m/44'/144'/0'/0/${index}`;
  const seed = getSeed('xrp');
  const child = HDKey.fromMasterSeed(seed).derive(path);
  if (!child.publicKey || !child.privateKey) throw new Error('XRP derivation failed');

  const pubkeyHash = ripemd160(sha256(child.publicKey));
  return {
    address: encodeBase58Check(0x00, pubkeyHash),
    encryptedPrivateKey: encryptPrivateKey(Buffer.from(child.privateKey).toString('hex')),
    derivationPath: path,
    destinationTag: String(index + 100000),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SOLANA — SLIP-0010 ed25519 derivation (NOT BIP-32 secp256k1)
//  Solana uses ed25519, which requires a completely different HD derivation
//  algorithm. All path segments must be hardened.
// ═══════════════════════════════════════════════════════════════════════════════

function deriveSolanaWallet(index: number): DerivedWallet {
  const path = `m/44'/501'/${index}'/0'`;
  const seed = getSeed('solana');

  // SLIP-0010 master key from seed
  let I = createHmac('sha512', 'ed25519 seed').update(seed).digest();
  let key = I.subarray(0, 32);
  let chainCode = I.subarray(32, 64);

  // Derive each hardened path segment
  const segments = path.replace('m/', '').split('/').map((s) => {
    const idx = parseInt(s.replace("'", ''), 10);
    return s.endsWith("'") ? idx + 0x80000000 : idx;
  });

  for (const segment of segments) {
    const data = Buffer.alloc(37);
    data[0] = 0x00; // private key marker for hardened child
    Buffer.from(key).copy(data, 1);
    data.writeUInt32BE(segment >>> 0, 33);

    I = createHmac('sha512', chainCode).update(data).digest();
    key = I.subarray(0, 32);
    chainCode = I.subarray(32, 64);
  }

  // key is now a 32-byte ed25519 seed
  const keypair = Keypair.fromSeed(new Uint8Array(key));

  return {
    address: keypair.publicKey.toBase58(),
    encryptedPrivateKey: encryptPrivateKey(Buffer.from(keypair.secretKey).toString('hex')),
    derivationPath: path,
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

export function deriveWallet(chain: Chain, index: number): DerivedWallet {
  switch (chain) {
    case 'bitcoin':   return deriveBitcoinWallet(index);
    case 'ethereum':  return deriveEthereumWallet(index);
    case 'litecoin':  return deriveLitecoinWallet(index);
    case 'xrp':       return deriveXRPWallet(index);
    case 'solana':    return deriveSolanaWallet(index);
  }
}

// ─── Atomic Index Allocation ─────────────────────────────────────────────────

export async function allocateIndex(tx: any, chain: Chain): Promise<number> {
  const result = await tx.execute(
    sql`UPDATE wallet_counters
        SET next_index = next_index + 1
        WHERE chain = ${chain}
        RETURNING next_index`
  ) as any;

  const rows = Array.isArray(result) ? result : result?.rows ?? [];
  if (rows.length === 0) {
    await tx.execute(
      sql`INSERT INTO wallet_counters (chain, next_index)
          VALUES (${chain}, 1)
          ON CONFLICT (chain) DO UPDATE SET next_index = wallet_counters.next_index + 1
          RETURNING next_index`
    );
    const retry = await tx.execute(
      sql`SELECT next_index FROM wallet_counters WHERE chain = ${chain}`
    ) as any;
    const retryRows = Array.isArray(retry) ? retry : retry?.rows ?? [];
    return Number(retryRows[0].next_index) - 1;
  }

  return Number(rows[0].next_index) - 1;
}

// ─── Generate All Wallets for a New User ────────────────────────────────────

export async function generateUserWallets(tx: any, userId: string) {
  for (const chain of CHAINS) {
    const index = await allocateIndex(tx, chain);
    const derived = deriveWallet(chain, index);

    await tx.insert(wallets).values({
      userId,
      chain,
      address: derived.address,
      derivationPath: derived.derivationPath,
      destinationTag: derived.destinationTag ?? null,
      encryptedPrivateKey: derived.encryptedPrivateKey,
      addressIndex: index,
    });
  }
}

// ─── Seed Wallet Counters ────────────────────────────────────────────────────

export async function seedWalletCounters(tx: any) {
  for (const chain of CHAINS) {
    await tx.execute(
      sql`INSERT INTO wallet_counters (chain, next_index)
          VALUES (${chain}, 0)
          ON CONFLICT (chain) DO NOTHING`
    );
  }
}

// ─── Address Validation (for withdrawals) ────────────────────────────────────

export function validateAddress(chain: Chain, address: string): boolean {
  switch (chain) {
    case 'bitcoin':
      return /^(bc1q[a-z0-9]{38,62}|bc1p[a-z0-9]{58}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(address);
    case 'ethereum':
      return /^0x[0-9a-fA-F]{40}$/.test(address);
    case 'litecoin':
      return /^(ltc1q[a-z0-9]{38,62}|[LM3][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(address);
    case 'xrp':
      return /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(address);
    case 'solana':
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    default:
      return false;
  }
}

// ─── Bech32 Encoding (BTC/LTC native SegWit) ────────────────────────────────

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      chk ^= (b >> i) & 1 ? GEN[i] : 0;
    }
  }
  return chk;
}

function bech32HrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (const c of hrp) ret.push(c.charCodeAt(0) >> 5);
  ret.push(0);
  for (const c of hrp) ret.push(c.charCodeAt(0) & 31);
  return ret;
}

function encodeBech32(hrp: string, witnessVersion: number, data: Uint8Array): string {
  const converted = convertBits(data, 8, 5, true);
  const values = [witnessVersion, ...converted];
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum: number[] = [];
  for (let i = 0; i < 6; i++) checksum.push((polymod >> (5 * (5 - i))) & 31);

  let result = hrp + '1';
  for (const v of [...values, ...checksum]) result += BECH32_CHARSET[v];
  return result;
}

function convertBits(data: Uint8Array, fromBits: number, toBits: number, pad: boolean): number[] {
  let acc = 0, bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) { bits -= toBits; ret.push((acc >> bits) & maxv); }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

// ─── Base58 / Base58Check (XRP) ──────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(data: Uint8Array): string {
  let num = BigInt(0);
  for (const byte of data) num = num * 256n + BigInt(byte);
  let result = '';
  while (num > 0n) { result = BASE58_ALPHABET[Number(num % 58n)] + result; num = num / 58n; }
  for (const byte of data) { if (byte === 0) result = '1' + result; else break; }
  return result || '1';
}

function encodeBase58Check(version: number, payload: Uint8Array): string {
  const versioned = new Uint8Array(1 + payload.length);
  versioned[0] = version;
  versioned.set(payload, 1);
  const checksum = sha256(sha256(versioned)).slice(0, 4);
  const full = new Uint8Array(versioned.length + 4);
  full.set(versioned);
  full.set(checksum, versioned.length);
  return encodeBase58(full);
}
