/**
 * DDL for the aggregation subsystem. Additive-only: creates new tables and adds
 * nullable columns to `accounts`/`transactions`; it never alters or drops
 * anything that exists. Safe to run on every boot (all guarded by IF NOT
 * EXISTS / duplicate-column tolerance).
 *
 * PORTABILITY: the app runs SQLite today and is mid-migration to Postgres, so
 * everything here is written in the portable subset both accept:
 *   - TEXT primary keys generated app-side (crypto.randomUUID), matching the
 *     rest of the schema — NOT the design doc's `uuid DEFAULT gen_random_uuid()`.
 *   - TEXT ISO-8601 timestamps (matching users/accounts/transactions), NOT
 *     `timestamptz DEFAULT now()`.
 *   - REAL for money (translated to `double precision` by translateDdl() on
 *     the Postgres driver), NOT `numeric(14,2)`.
 *   - INTEGER 0/1 for booleans; TEXT for JSON payloads, NOT `jsonb`.
 *   - Token vault columns are base64 TEXT (see vault.ts), NOT `bytea`.
 * These are deliberate discrepancies from design doc §2, which assumed the
 * Postgres migration had already landed. Same tables, same columns, same
 * constraints — portable types.
 *
 * DDL goes through db.exec() so the Postgres driver's translateDdl() applies.
 */
import type { Sql } from '../db/sql.js';

const TABLES = `
  CREATE TABLE IF NOT EXISTS provider_connections (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider           TEXT NOT NULL CHECK (provider IN ('teller','plaid','simplefin','ofx','file')),
    provider_item_id   TEXT NOT NULL,        -- plaid item_id / teller enrollment_id / simplefin claim id / file:<userId>
    institution_id     TEXT,
    institution_name   TEXT NOT NULL DEFAULT 'Unknown',
    status             TEXT NOT NULL DEFAULT 'pending_link',
    status_detail      TEXT NOT NULL DEFAULT '{}',    -- JSON {error_code, reason, since}
    consent_expires_at TEXT,
    -- token vault (envelope encryption, see providers/vault.ts; base64 text)
    token_ciphertext   TEXT,
    token_iv           TEXT,
    token_tag          TEXT,
    dek_wrapped        TEXT,
    dek_iv             TEXT,
    dek_tag            TEXT,
    kek_version        INTEGER NOT NULL DEFAULT 1,
    last_synced_at     TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    deleted_at         TEXT,
    UNIQUE (user_id, provider, provider_item_id)
  );

  CREATE TABLE IF NOT EXISTS provider_accounts (
    id                  TEXT PRIMARY KEY,
    connection_id       TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_account_id TEXT NOT NULL,
    account_id          TEXT REFERENCES accounts(id) ON DELETE SET NULL,  -- link into the existing app table
    name                TEXT NOT NULL,
    official_name       TEXT,
    mask                TEXT,               -- last 4 only; full numbers are never stored
    type                TEXT NOT NULL,
    subtype             TEXT,
    currency            TEXT NOT NULL DEFAULT 'USD',
    current_balance     REAL,
    available_balance   REAL,
    credit_limit        REAL,
    balance_as_of       TEXT,
    is_selected         INTEGER NOT NULL DEFAULT 1,   -- user can exclude accounts from sync
    raw                 TEXT NOT NULL DEFAULT '{}',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE (connection_id, provider_account_id)
  );

  CREATE TABLE IF NOT EXISTS sync_cursors (
    connection_id  TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    scope          TEXT NOT NULL,   -- 'transactions' | 'transactions:<provider_account_id>' | 'investments' | 'liabilities'
    cursor         TEXT,            -- opaque: plaid next_cursor, or JSON watermark for pollers
    updated_at     TEXT NOT NULL,
    PRIMARY KEY (connection_id, scope)
  );

  CREATE TABLE IF NOT EXISTS sync_runs (
    id             TEXT PRIMARY KEY,
    connection_id  TEXT NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    scope          TEXT NOT NULL,
    trigger        TEXT NOT NULL,   -- 'webhook' | 'cron' | 'manual' | 'backfill' | 'link'
    status         TEXT NOT NULL DEFAULT 'running',  -- running|success|partial|failed
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    added_count    INTEGER NOT NULL DEFAULT 0,
    modified_count INTEGER NOT NULL DEFAULT 0,
    removed_count  INTEGER NOT NULL DEFAULT 0,
    error          TEXT,            -- JSON, sanitized; NEVER raw provider payloads or token material
    next_retry_at  TEXT,
    attempt        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS liabilities (
    id                     TEXT PRIMARY KEY,
    user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id             TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider_account_pk    TEXT REFERENCES provider_accounts(id) ON DELETE SET NULL,
    kind                   TEXT NOT NULL,  -- credit_card|heloc|auto_loan|lease|mortgage|student|other
    -- revolving
    aprs                   TEXT,           -- JSON [{type:'purchase',percentage:24.99,balance_subject:...}]
    minimum_payment        REAL,
    next_due_date          TEXT,
    last_statement_balance REAL,
    last_statement_date    TEXT,
    last_payment_amount    REAL,
    last_payment_date      TEXT,
    is_overdue             INTEGER,
    credit_limit           REAL,
    -- installment
    interest_rate_pct      REAL,
    origination_date       TEXT,
    origination_principal  REAL,
    maturity_date          TEXT,
    payoff_balance         REAL,
    escrow_balance         REAL,
    -- HELOC
    draw_period_end        TEXT,
    repayment_period_end   TEXT,
    -- lease (manual augmentation — aggregators do not model leases)
    lease_end_date         TEXT,
    lease_residual_value   REAL,
    lease_monthly_payment  REAL,
    lease_mileage_allowance INTEGER,
    lease_buyout_fee       REAL,
    lease_money_factor     REAL,
    source                 TEXT NOT NULL DEFAULT 'provider',   -- provider|manual|mixed
    manual_overrides       TEXT NOT NULL DEFAULT '{}',         -- JSON {field: {value, set_at}} — wins over provider refresh
    raw                    TEXT NOT NULL DEFAULT '{}',
    updated_at             TEXT NOT NULL,
    UNIQUE (account_id)
  );

  CREATE TABLE IF NOT EXISTS institution_status (
    provider             TEXT NOT NULL,
    institution_id       TEXT NOT NULL,
    institution_name     TEXT,
    health               TEXT NOT NULL DEFAULT 'healthy',  -- healthy|degraded|down
    detail               TEXT NOT NULL DEFAULT '{}',
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_success_at      TEXT,
    last_checked_at      TEXT NOT NULL,
    PRIMARY KEY (provider, institution_id)
  );

  -- Webhook idempotency + audit. The raw body is NOT stored; digest only.
  CREATE TABLE IF NOT EXISTS webhook_events (
    id            TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    event_id      TEXT,                    -- provider event id when present
    body_sha256   TEXT NOT NULL,
    action        TEXT NOT NULL,
    connection_id TEXT REFERENCES provider_connections(id) ON DELETE SET NULL,
    received_at   TEXT NOT NULL,
    UNIQUE (provider, body_sha256)
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_provider_connections_user ON provider_connections(user_id);
  CREATE INDEX IF NOT EXISTS idx_provider_accounts_connection ON provider_accounts(connection_id);
  CREATE INDEX IF NOT EXISTS idx_provider_accounts_user ON provider_accounts(user_id);
  CREATE INDEX IF NOT EXISTS idx_sync_runs_conn_started ON sync_runs(connection_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_sync_runs_retry ON sync_runs(next_retry_at) WHERE status = 'failed';
  CREATE INDEX IF NOT EXISTS idx_liabilities_user ON liabilities(user_id);

  -- Idempotency backbone: a provider transaction lands exactly once per account.
  -- Partial unique indexes are supported by both SQLite (3.8+) and Postgres.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_txn_provider
    ON transactions(account_id, provider, provider_txn_id)
    WHERE provider_txn_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_txn_pending_id
    ON transactions(account_id, pending_txn_id)
    WHERE pending_txn_id IS NOT NULL;
`;

/** [table, column, type-and-default] — additive, nullable/defaulted, zero impact on existing reads. */
const ADDITIVE_COLUMNS: Array<[string, string, string]> = [
  // accounts: which pipe feeds this account, and the provider_accounts row behind it
  ['accounts', 'provider_account_pk', 'TEXT'],
  ['accounts', 'sync_source', "TEXT DEFAULT 'manual'"],  // manual|upload|teller|plaid|simplefin|ofx|file
  // transactions: provider identity + pending->posted linkage + soft delete
  ['transactions', 'provider_txn_id', 'TEXT'],
  ['transactions', 'pending_txn_id', 'TEXT'],
  ['transactions', 'provider', 'TEXT'],
  ['transactions', 'posted_date', 'TEXT'],
  ['transactions', 'removed_at', 'TEXT'],
  // set when the user edits category/notes/tags — sync upserts must then preserve those fields
  ['transactions', 'user_edited', 'INTEGER DEFAULT 0'],
];

async function addColumnIfMissing(db: Sql, table: string, column: string, decl: string): Promise<void> {
  if (db.driver === 'postgres') {
    // Postgres supports it natively — no error-message sniffing needed.
    await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${decl}`);
    return;
  }
  // SQLite has no ADD COLUMN IF NOT EXISTS: tolerate exactly the duplicate-column
  // error and re-throw anything else (a swallowed syntax error here would
  // silently ship a half-applied schema).
  try {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (!/duplicate column|already exists/i.test(msg)) throw err;
  }
}

/**
 * Apply the aggregation schema. Idempotent; call once at boot after initDb().
 * Inert until routes/sync are wired: nothing existing reads these tables, and
 * the added columns are nullable/defaulted.
 */
export async function applyProviderSchema(db: Sql): Promise<void> {
  await db.exec(TABLES);
  for (const [table, column, decl] of ADDITIVE_COLUMNS) {
    await addColumnIfMissing(db, table, column, decl);
  }
  // Indexes last: uq_txn_provider references columns added above.
  await db.exec(INDEXES);
}
