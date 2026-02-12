import {
  pgTable,
  uuid,
  varchar,
  text,
  decimal,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── Users ──────────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 20 }),
  displayName: varchar('display_name', { length: 100 }),

  // KYC
  kycStatus: varchar('kyc_status', { length: 20 }).default('pending').notNull(),
  kycProviderId: varchar('kyc_provider_id', { length: 255 }),
  kycVideoStatus: varchar('kyc_video_status', { length: 20 }).default('not_submitted').notNull(),

  // Trading reputation
  tradeCount: integer('trade_count').default(0).notNull(),
  completionRate: decimal('completion_rate', { precision: 5, scale: 2 }).default('100.00').notNull(),
  avgConfirmSeconds: integer('avg_confirm_seconds'),
  maxTradeLimit: decimal('max_trade_limit', { precision: 12, scale: 2 }).default('250.00').notNull(),

  // Interac
  interacEmail: varchar('interac_email', { length: 255 }),
  autodepositVerified: boolean('autodeposit_verified').default(false).notNull(),

  // Preferences
  locale: varchar('locale', { length: 5 }).default('en').notNull(),

  // Auth
  refreshToken: varchar('refresh_token', { length: 512 }),
  twoFactorSecret: varchar('two_factor_secret', { length: 64 }),
  twoFactorEnabled: boolean('two_factor_enabled').default(false).notNull(),

  // PIN & Biometric
  pinHash: varchar('pin_hash', { length: 255 }),
  biometricTokenHash: varchar('biometric_token_hash', { length: 255 }),

  // Password Reset
  resetToken: varchar('reset_token', { length: 255 }),
  resetTokenExpiry: timestamp('reset_token_expiry', { withTimezone: true }),

  // Compliance (CARF)
  fullLegalName: varchar('full_legal_name', { length: 255 }),
  dateOfBirth: varchar('date_of_birth', { length: 10 }),
  address: text('address'),
  city: varchar('city', { length: 100 }),
  province: varchar('province', { length: 2 }),
  postalCode: varchar('postal_code', { length: 10 }),
  countryOfResidence: varchar('country_of_residence', { length: 2 }).default('CA'),
  sin: varchar('sin', { length: 11 }), // encrypted at rest
  occupation: varchar('occupation', { length: 100 }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─── Orders (Buy/Sell advertisements on the book) ───────────────────────────
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),

  type: varchar('type', { length: 4 }).notNull(), // 'buy' | 'sell'
  cryptoAsset: varchar('crypto_asset', { length: 10 }).notNull(), // 'BTC', 'ETH', 'LTC', 'XRP', 'SOL', 'LINK'

  amountCrypto: decimal('amount_crypto', { precision: 18, scale: 8 }),
  amountFiat: decimal('amount_fiat', { precision: 12, scale: 2 }).notNull(),

  // Pricing
  priceType: varchar('price_type', { length: 10 }).default('market').notNull(),
  pricePremium: decimal('price_premium', { precision: 5, scale: 2 }).default('0').notNull(),
  fixedPrice: decimal('fixed_price', { precision: 12, scale: 2 }),

  // Limits
  minTrade: decimal('min_trade', { precision: 12, scale: 2 }).default('100').notNull(),
  maxTrade: decimal('max_trade', { precision: 12, scale: 2 }).default('3000').notNull(),

  // Fill tracking
  remainingFiat: decimal('remaining_fiat', { precision: 12, scale: 2 }).notNull(),

  status: varchar('status', { length: 20 }).default('active').notNull(),
  // active, paused, filled, cancelled

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('orders_user_id_idx').on(table.userId),
  index('orders_status_type_idx').on(table.status, table.type, table.cryptoAsset),
]);

// ─── Trades (Matched buyer <-> seller) ──────────────────────────────────────
export const trades = pgTable('trades', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').references(() => orders.id).notNull(),

  buyerId: uuid('buyer_id').references(() => users.id).notNull(),
  sellerId: uuid('seller_id').references(() => users.id).notNull(),

  cryptoAsset: varchar('crypto_asset', { length: 10 }).notNull(),
  amountCrypto: decimal('amount_crypto', { precision: 18, scale: 8 }).notNull(),
  amountFiat: decimal('amount_fiat', { precision: 12, scale: 2 }).notNull(),
  pricePerUnit: decimal('price_per_unit', { precision: 12, scale: 2 }).notNull(),

  // Fee
  feePercent: decimal('fee_percent', { precision: 5, scale: 2 }).notNull(),
  feeAmount: decimal('fee_amount', { precision: 18, scale: 8 }).notNull(),

  // Blockchain references
  escrowAddress: varchar('escrow_address', { length: 255 }),
  escrowTxId: varchar('escrow_tx_id', { length: 255 }),
  releaseTxId: varchar('release_tx_id', { length: 255 }),

  // State machine
  status: varchar('status', { length: 25 }).default('pending').notNull(),
  // pending → escrow_funded → payment_sent → payment_confirmed → crypto_released → completed
  // Alt: → disputed → resolved_buyer / resolved_seller
  // Timeout: → expired

  // Timestamps for each state transition
  escrowFundedAt: timestamp('escrow_funded_at', { withTimezone: true }),
  paymentSentAt: timestamp('payment_sent_at', { withTimezone: true }),
  paymentConfirmedAt: timestamp('payment_confirmed_at', { withTimezone: true }),
  cryptoReleasedAt: timestamp('crypto_released_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),

  // Timers
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  holdingUntil: timestamp('holding_until', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('trades_buyer_id_idx').on(table.buyerId),
  index('trades_seller_id_idx').on(table.sellerId),
  index('trades_order_id_idx').on(table.orderId),
  index('trades_status_idx').on(table.status),
]);

// ─── Disputes ───────────────────────────────────────────────────────────────
export const disputes = pgTable('disputes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tradeId: uuid('trade_id').references(() => trades.id).notNull(),
  openedBy: uuid('opened_by').references(() => users.id).notNull(),

  reason: text('reason').notNull(),
  evidenceUrls: jsonb('evidence_urls').$type<string[]>().default([]),

  resolution: varchar('resolution', { length: 20 }),
  // buyer_wins, seller_wins, cancelled
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─── Wallets (Per-user deposit addresses, one per chain) ────────────────────
// Pool wallets have userId = NULL until claimed during user registration.
export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  // Nullable: pool wallets are unassigned (NULL) until claimed.

  chain: varchar('chain', { length: 20 }).notNull(),
  // 'bitcoin' | 'ethereum' | 'litecoin' | 'xrp' | 'solana'

  address: varchar('address', { length: 255 }).notNull(),
  derivationPath: varchar('derivation_path', { length: 50 }),
  destinationTag: varchar('destination_tag', { length: 20 }),
  // XRP only — unique integer tag per user

  encryptedPrivateKey: text('encrypted_private_key'),
  // AES-256-GCM encrypted. Key from env WALLET_ENCRYPTION_KEY.

  addressIndex: integer('address_index'),
  // Position in HD wallet sequence for this chain.

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  assignedAt: timestamp('assigned_at', { withTimezone: true }),
  // Set when a pool wallet is claimed by a user. NULL for unclaimed pool wallets.
}, (table) => [
  index('wallets_user_id_idx').on(table.userId),
  uniqueIndex('wallets_user_chain_idx').on(table.userId, table.chain),
  uniqueIndex('wallets_address_idx').on(table.address),
]);

// ─── Wallet Counters (Atomic index allocation for HD derivation) ────────────
export const walletCounters = pgTable('wallet_counters', {
  chain: varchar('chain', { length: 20 }).primaryKey(),
  nextIndex: integer('next_index').default(0).notNull(),
});

// ─── Balances (Authoritative source of truth for user holdings) ─────────────
export const balances = pgTable('balances', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),

  asset: varchar('asset', { length: 10 }).notNull(),
  // 'BTC' | 'ETH' | 'LTC' | 'XRP' | 'SOL' | 'LINK'

  available: decimal('available', { precision: 28, scale: 18 }).default('0').notNull(),
  // Funds the user can withdraw or use to create sell orders.

  locked: decimal('locked', { precision: 28, scale: 18 }).default('0').notNull(),
  // Funds locked in escrow for active trades.

  pendingDeposit: decimal('pending_deposit', { precision: 28, scale: 18 }).default('0').notNull(),
  // Deposits detected but not yet confirmed (below confirmation threshold).

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('balances_user_asset_idx').on(table.userId, table.asset),
  index('balances_user_id_idx').on(table.userId),
]);

// ─── Balance Ledger (Immutable audit trail — every balance mutation) ────────
export const balanceLedger = pgTable('balance_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),

  asset: varchar('asset', { length: 10 }).notNull(),

  entryType: varchar('entry_type', { length: 30 }).notNull(),
  // 'deposit_pending' | 'deposit_pending_cleared' | 'deposit_confirmed'
  // | 'withdrawal_requested' | 'withdrawal_confirmed' | 'withdrawal_failed'
  // | 'trade_escrow_lock' | 'trade_escrow_release' | 'trade_escrow_return'
  // | 'trade_credit' | 'fee_debit'
  // | 'admin_adjustment'

  amount: decimal('amount', { precision: 28, scale: 18 }).notNull(),
  // Positive = credit, Negative = debit.

  balanceField: varchar('balance_field', { length: 20 }).notNull(),
  // 'available' | 'locked' | 'pendingDeposit'
  // Which balance column this entry affects.

  balanceAfter: decimal('balance_after', { precision: 28, scale: 18 }).notNull(),
  // The resulting balance in that field after this entry.

  // Reference IDs (exactly one should be set per entry)
  depositId: uuid('deposit_id').references(() => deposits.id),
  withdrawalId: uuid('withdrawal_id').references(() => withdrawals.id),
  tradeId: uuid('trade_id').references(() => trades.id),

  idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),
  // Prevents duplicate entries. Format: "{type}:{referenceId}:{step}"

  note: text('note'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('ledger_user_id_idx').on(table.userId),
  index('ledger_user_asset_idx').on(table.userId, table.asset),
  index('ledger_entry_type_idx').on(table.entryType),
  index('ledger_deposit_id_idx').on(table.depositId),
  index('ledger_withdrawal_id_idx').on(table.withdrawalId),
  index('ledger_trade_id_idx').on(table.tradeId),
  index('ledger_created_at_idx').on(table.createdAt),
]);

// ─── Deposits (Incoming crypto from external wallets) ───────────────────────
export const deposits = pgTable('deposits', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  walletId: uuid('wallet_id').references(() => wallets.id).notNull(),

  asset: varchar('asset', { length: 10 }).notNull(),
  chain: varchar('chain', { length: 20 }).notNull(),

  amount: decimal('amount', { precision: 28, scale: 18 }).notNull(),

  txHash: varchar('tx_hash', { length: 255 }).notNull(),
  fromAddress: varchar('from_address', { length: 255 }),

  confirmations: integer('confirmations').default(0).notNull(),
  requiredConfirmations: integer('required_confirmations').notNull(),
  // BTC: 2, ETH/LINK: 12, LTC: 6, XRP: 1, SOL: 32

  status: varchar('status', { length: 20 }).default('pending').notNull(),
  // 'pending' | 'confirmed' | 'credited' | 'failed'

  detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  creditedAt: timestamp('credited_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('deposits_user_id_idx').on(table.userId),
  index('deposits_status_idx').on(table.status),
  index('deposits_wallet_id_idx').on(table.walletId),
  uniqueIndex('deposits_tx_hash_chain_idx').on(table.txHash, table.chain),
]);

// ─── Withdrawals (Outgoing crypto to external wallets) ──────────────────────
export const withdrawals = pgTable('withdrawals', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),

  asset: varchar('asset', { length: 10 }).notNull(),
  chain: varchar('chain', { length: 20 }).notNull(),

  amount: decimal('amount', { precision: 28, scale: 18 }).notNull(),
  fee: decimal('fee', { precision: 28, scale: 18 }).notNull(),
  netAmount: decimal('net_amount', { precision: 28, scale: 18 }).notNull(),
  // amount - fee = what actually gets sent on-chain.

  toAddress: varchar('to_address', { length: 255 }).notNull(),
  destinationTag: varchar('destination_tag', { length: 20 }),
  // XRP only.

  txHash: varchar('tx_hash', { length: 255 }),
  // Set once the on-chain transaction is broadcast.

  status: varchar('status', { length: 25 }).default('pending_review').notNull(),
  // 'pending_review' | 'approved' | 'broadcasting' | 'confirmed' | 'failed' | 'cancelled'

  reviewedBy: uuid('reviewed_by').references(() => users.id),
  failureReason: text('failure_reason'),

  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  broadcastAt: timestamp('broadcast_at', { withTimezone: true }),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('withdrawals_user_id_idx').on(table.userId),
  index('withdrawals_status_idx').on(table.status),
  index('withdrawals_user_requested_at_idx').on(table.userId, table.requestedAt),
]);

// ─── KYC Documents (Photos, videos for identity verification) ───────────────
export const kycDocuments = pgTable('kyc_documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),

  documentType: varchar('document_type', { length: 30 }).notNull(),
  // 'selfie_video' | 'id_front' | 'id_back' | 'proof_of_address' | 'holding_id_video'

  mimeType: varchar('mime_type', { length: 50 }).notNull(),
  fileSize: integer('file_size').notNull(), // in bytes

  storagePath: varchar('storage_path', { length: 512 }).notNull(),
  // S3 key or local path. Format: "kyc/{userId}/{type}_{timestamp}.{ext}"

  storageBackend: varchar('storage_backend', { length: 10 }).default('local').notNull(),
  // 'local' | 's3'

  sha256Hash: varchar('sha256_hash', { length: 64 }).notNull(),
  // Integrity verification. Computed on upload.

  reviewStatus: varchar('review_status', { length: 20 }).default('pending').notNull(),
  // 'pending' | 'approved' | 'rejected'

  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewNote: text('review_note'),

  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).defaultNow().notNull(),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
}, (table) => [
  index('kyc_docs_user_id_idx').on(table.userId),
  index('kyc_docs_review_status_idx').on(table.reviewStatus),
]);

// ─── Compliance Logs (FINTRAC) ──────────────────────────────────────────────
export const complianceLogs = pgTable('compliance_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  tradeId: uuid('trade_id').references(() => trades.id),

  eventType: varchar('event_type', { length: 50 }).notNull(),
  // lvctr, str, kyc_verification, travel_rule, carf_report
  payload: jsonb('payload').notNull(),
  filedAt: timestamp('filed_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('compliance_user_idx').on(table.userId),
  index('compliance_event_type_idx').on(table.eventType),
]);

// ─── Trade Chat Messages ────────────────────────────────────────────────────
export const tradeMessages = pgTable('trade_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tradeId: uuid('trade_id').references(() => trades.id).notNull(),
  senderId: uuid('sender_id').references(() => users.id).notNull(),

  content: text('content').notNull(),
  imageUrl: varchar('image_url', { length: 512 }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('trade_messages_trade_idx').on(table.tradeId),
]);

// ─── Relations ──────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
  buyTrades: many(trades, { relationName: 'buyer' }),
  sellTrades: many(trades, { relationName: 'seller' }),
  wallets: many(wallets),
  balances: many(balances),
  deposits: many(deposits),
  withdrawals: many(withdrawals),
  kycDocuments: many(kycDocuments),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
  trades: many(trades),
}));

export const tradesRelations = relations(trades, ({ one, many }) => ({
  order: one(orders, { fields: [trades.orderId], references: [orders.id] }),
  buyer: one(users, { fields: [trades.buyerId], references: [users.id], relationName: 'buyer' }),
  seller: one(users, { fields: [trades.sellerId], references: [users.id], relationName: 'seller' }),
  messages: many(tradeMessages),
  disputes: many(disputes),
}));

export const disputesRelations = relations(disputes, ({ one }) => ({
  trade: one(trades, { fields: [disputes.tradeId], references: [trades.id] }),
  opener: one(users, { fields: [disputes.openedBy], references: [users.id] }),
}));

export const walletsRelations = relations(wallets, ({ one }) => ({
  user: one(users, { fields: [wallets.userId], references: [users.id] }),
}));

export const balancesRelations = relations(balances, ({ one }) => ({
  user: one(users, { fields: [balances.userId], references: [users.id] }),
}));

export const depositsRelations = relations(deposits, ({ one }) => ({
  user: one(users, { fields: [deposits.userId], references: [users.id] }),
  wallet: one(wallets, { fields: [deposits.walletId], references: [wallets.id] }),
}));

export const withdrawalsRelations = relations(withdrawals, ({ one }) => ({
  user: one(users, { fields: [withdrawals.userId], references: [users.id] }),
}));

export const kycDocumentsRelations = relations(kycDocuments, ({ one }) => ({
  user: one(users, { fields: [kycDocuments.userId], references: [users.id] }),
}));

export const balanceLedgerRelations = relations(balanceLedger, ({ one }) => ({
  user: one(users, { fields: [balanceLedger.userId], references: [users.id] }),
  deposit: one(deposits, { fields: [balanceLedger.depositId], references: [deposits.id] }),
  withdrawal: one(withdrawals, { fields: [balanceLedger.withdrawalId], references: [withdrawals.id] }),
  trade: one(trades, { fields: [balanceLedger.tradeId], references: [trades.id] }),
}));

export const tradeMessagesRelations = relations(tradeMessages, ({ one }) => ({
  trade: one(trades, { fields: [tradeMessages.tradeId], references: [trades.id] }),
  sender: one(users, { fields: [tradeMessages.senderId], references: [users.id] }),
}));

// ─── Staking Products (Available staking options with APY rates) ────────────
export const stakingProducts = pgTable('staking_products', {
  id: uuid('id').primaryKey().defaultRandom(),
  asset: varchar('asset', { length: 10 }).notNull(),
  // 'BTC' | 'ETH' | 'SOL' | 'LINK' | etc.

  term: varchar('term', { length: 20 }).notNull(),
  // 'flexible' | 'short' | 'long'

  apyPercent: decimal('apy_percent', { precision: 8, scale: 4 }).notNull(),
  // e.g. 1.50, 3.10, 5.44

  minAmount: decimal('min_amount', { precision: 28, scale: 18 }).default('0').notNull(),
  maxAmount: decimal('max_amount', { precision: 28, scale: 18 }).default('999999').notNull(),

  lockDays: integer('lock_days').default(0).notNull(),
  // 0 = flexible (withdraw any time), 30 = short term, 90/180 = long term

  enabled: boolean('enabled').default(true).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('staking_products_asset_idx').on(table.asset),
  index('staking_products_term_idx').on(table.term),
]);

// ─── Staking Positions (User's active staking) ─────────────────────────────
export const stakingPositions = pgTable('staking_positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  productId: uuid('product_id').references(() => stakingProducts.id).notNull(),

  asset: varchar('asset', { length: 10 }).notNull(),
  amount: decimal('amount', { precision: 28, scale: 18 }).notNull(),
  allocationPercent: integer('allocation_percent').default(100).notNull(),
  // What % of user's available balance for this asset is staked

  status: varchar('status', { length: 20 }).default('active').notNull(),
  // 'active' | 'unstaking' | 'completed'

  totalEarned: decimal('total_earned', { precision: 28, scale: 18 }).default('0').notNull(),
  lastAccrualAt: timestamp('last_accrual_at', { withTimezone: true }).defaultNow().notNull(),

  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  maturesAt: timestamp('matures_at', { withTimezone: true }),
  // null for flexible, set for term products

  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('staking_positions_user_idx').on(table.userId),
  index('staking_positions_status_idx').on(table.status),
  index('staking_positions_asset_idx').on(table.asset),
]);

// ─── Earnings (Accrued staking rewards log) ─────────────────────────────────
export const earnings = pgTable('earnings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  positionId: uuid('position_id').references(() => stakingPositions.id).notNull(),

  asset: varchar('asset', { length: 10 }).notNull(),
  amount: decimal('amount', { precision: 28, scale: 18 }).notNull(),
  cadValue: decimal('cad_value', { precision: 12, scale: 2 }),
  // CAD value at time of accrual (for display)

  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('earnings_user_idx').on(table.userId),
  index('earnings_position_idx').on(table.positionId),
  index('earnings_created_at_idx').on(table.createdAt),
]);

// ─── Portfolio Snapshots (Historical portfolio values for P&L charts) ───────
export const portfolioSnapshots = pgTable('portfolio_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),

  totalCadValue: decimal('total_cad_value', { precision: 18, scale: 2 }).notNull(),

  assets: jsonb('assets').$type<Array<{
    asset: string;
    amount: string;
    cadPrice: string;
    cadValue: string;
  }>>().notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('portfolio_snapshots_user_idx').on(table.userId),
  index('portfolio_snapshots_created_at_idx').on(table.createdAt),
  index('portfolio_snapshots_user_created_idx').on(table.userId, table.createdAt),
]);

// ─── Notifications ──────────────────────────────────────────────────────────
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),

  type: varchar('type', { length: 30 }).notNull(),
  // 'trade_filled' | 'deposit_confirmed' | 'withdrawal_sent' | 'staking_reward' | 'price_alert' | 'system'

  title: varchar('title', { length: 255 }).notNull(),
  message: text('message').notNull(),
  isRead: boolean('is_read').default(false).notNull(),

  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('notifications_user_id_idx').on(table.userId),
  index('notifications_user_read_idx').on(table.userId, table.isRead),
  index('notifications_created_at_idx').on(table.createdAt),
]);

// ─── User Preferences (Notification + app settings) ────────────────────────
export const userPreferences = pgTable('user_preferences', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull().unique(),

  // Notifications
  pushEnabled: boolean('push_enabled').default(true).notNull(),
  priceAlerts: boolean('price_alerts').default(true).notNull(),
  tradeNotifications: boolean('trade_notifications').default(true).notNull(),
  earnNotifications: boolean('earn_notifications').default(true).notNull(),

  // App customization
  defaultCurrency: varchar('default_currency', { length: 3 }).default('CAD').notNull(),
  hideSmallBalances: boolean('hide_small_balances').default(false).notNull(),

  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('user_preferences_user_idx').on(table.userId),
]);

// ─── Relations for new tables ───────────────────────────────────────────────

export const stakingProductsRelations = relations(stakingProducts, ({ many }) => ({
  positions: many(stakingPositions),
}));

export const stakingPositionsRelations = relations(stakingPositions, ({ one, many }) => ({
  user: one(users, { fields: [stakingPositions.userId], references: [users.id] }),
  product: one(stakingProducts, { fields: [stakingPositions.productId], references: [stakingProducts.id] }),
  earnings: many(earnings),
}));

export const earningsRelations = relations(earnings, ({ one }) => ({
  user: one(users, { fields: [earnings.userId], references: [users.id] }),
  position: one(stakingPositions, { fields: [earnings.positionId], references: [stakingPositions.id] }),
}));

export const portfolioSnapshotsRelations = relations(portfolioSnapshots, ({ one }) => ({
  user: one(users, { fields: [portfolioSnapshots.userId], references: [users.id] }),
}));

export const userPreferencesRelations = relations(userPreferences, ({ one }) => ({
  user: one(users, { fields: [userPreferences.userId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));
