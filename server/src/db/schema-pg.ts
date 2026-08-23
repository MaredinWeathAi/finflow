/**
 * Postgres schema for the SQLite → Postgres cutover.
 *
 * This is the SQLite schema from `database.ts` (the CREATE TABLE block PLUS
 * every column added by the ALTER TABLE migrations array, appended in the same
 * order SQLite appended them, so `SELECT *` column order matches the migrated
 * production file).
 *
 * DELIBERATE COMPATIBILITY CHOICES — do not "improve" these:
 *  - Dates stay `text` (YYYY-MM-DD / ISO-8601). The app compares them as
 *    strings everywhere (`date >= ? AND date <= ?`); a real `date`/`timestamptz`
 *    column would change comparison and serialisation behaviour.
 *  - Booleans stay `integer` 0/1. The SQL says `is_active = 1` in ~20 places.
 *  - SQLite REAL → `double precision`, NOT `numeric`. `numeric` changes
 *    rounding and these figures must match the SQLite values bit-for-bit.
 *  - Every PK, FK, ON DELETE rule, UNIQUE constraint, default and index is
 *    carried over 1:1.
 *
 * The only addition: foreign keys are declared DEFERRABLE INITIALLY IMMEDIATE.
 * INITIALLY IMMEDIATE means they are checked at the end of every statement,
 * exactly like a plain FK, so runtime behaviour is unchanged — but it lets the
 * one-shot migrator run `SET CONSTRAINTS ALL DEFERRED` inside its transaction
 * so self-referencing rows (categories.parent_id, users.advisor_id) can be
 * bulk-copied in whatever order SQLite returns them.
 */
import type { Sql } from './sql.js';

export const PG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  currency text DEFAULT 'USD',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  -- columns appended by the SQLite migrations array, same order
  role text DEFAULT 'client',
  username text,
  phone text,
  advisor_id text REFERENCES users(id) DEFERRABLE INITIALLY IMMEDIATE,
  token_version integer NOT NULL DEFAULT 0,
  must_change_password integer NOT NULL DEFAULT 0,
  password_changed_at text,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until text,
  last_login_at text,
  totp_secret text,
  totp_enabled integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS accounts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  name text NOT NULL,
  type text NOT NULL,
  institution text,
  balance double precision NOT NULL DEFAULT 0,
  last_four text,
  icon text,
  is_hidden integer DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  source text DEFAULT 'seed'
);

CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  name text NOT NULL,
  icon text,
  color text,
  budget_amount double precision,
  is_income integer DEFAULT 0,
  parent_id text REFERENCES categories(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  sort_order integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  name text NOT NULL,
  amount double precision NOT NULL,
  category_id text REFERENCES categories(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  date text NOT NULL,
  notes text,
  is_pending integer DEFAULT 0,
  is_recurring integer DEFAULT 0,
  recurring_id text,
  tags text DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL,
  source text DEFAULT 'seed'
);

CREATE TABLE IF NOT EXISTS recurring_expenses (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  account_id text REFERENCES accounts(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  name text NOT NULL,
  amount double precision NOT NULL,
  category_id text REFERENCES categories(id) ON DELETE SET NULL DEFERRABLE INITIALLY IMMEDIATE,
  frequency text NOT NULL,
  next_date text NOT NULL,
  last_charged_date text,
  is_active integer DEFAULT 1,
  notes text,
  price_history text DEFAULT '[]',
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  category_id text NOT NULL REFERENCES categories(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  month text NOT NULL,
  amount double precision NOT NULL,
  rollover integer DEFAULT 0,
  rollover_amount double precision DEFAULT 0
);

CREATE TABLE IF NOT EXISTS goals (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  name text NOT NULL,
  target_amount double precision NOT NULL,
  current_amount double precision DEFAULT 0,
  target_date text,
  icon text,
  color text,
  is_completed integer DEFAULT 0,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS investments (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  symbol text NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  shares double precision NOT NULL,
  cost_basis double precision NOT NULL,
  current_price double precision NOT NULL,
  last_updated text NOT NULL
);

CREATE TABLE IF NOT EXISTS net_worth_snapshots (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  date text NOT NULL,
  total_assets double precision NOT NULL,
  total_liabilities double precision NOT NULL,
  net_worth double precision NOT NULL,
  breakdown text DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  status text NOT NULL DEFAULT 'processing',
  file_count integer DEFAULT 0,
  total_items integer DEFAULT 0,
  imported_items integer DEFAULT 0,
  duplicate_items integer DEFAULT 0,
  created_at text NOT NULL,
  completed_at text
);

CREATE TABLE IF NOT EXISTS uploaded_files (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  filename text NOT NULL,
  file_type text NOT NULL,
  file_size integer DEFAULT 0,
  row_count integer DEFAULT 0,
  status text NOT NULL DEFAULT 'parsing',
  error_message text,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_items (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  file_id text NOT NULL REFERENCES uploaded_files(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  item_type text NOT NULL DEFAULT 'transaction',
  raw_data text DEFAULT '{}',
  parsed_name text,
  parsed_amount double precision,
  parsed_date text,
  parsed_category text,
  matched_category_id text,
  matched_account_id text,
  status text NOT NULL DEFAULT 'pending',
  duplicate_of text,
  confidence double precision DEFAULT 0,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS category_rules (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  pattern text NOT NULL,
  category_id text NOT NULL REFERENCES categories(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  match_type text NOT NULL DEFAULT 'contains',
  created_at text NOT NULL,
  -- columns appended by the SQLite migrations array, same order
  name text DEFAULT '',
  account_id text,
  amount_min double precision,
  amount_max double precision,
  amount_exact double precision,
  assign_account_id text,
  assign_type text,
  is_enabled integer DEFAULT 1,
  priority integer DEFAULT 0,
  description text DEFAULT ''
);

CREATE TABLE IF NOT EXISTS clarifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  source text NOT NULL DEFAULT 'upload',
  item_type text NOT NULL,
  title text NOT NULL,
  description text,
  context text DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  resolution text,
  created_at text NOT NULL,
  resolved_at text
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  token text NOT NULL UNIQUE,
  expires_at text NOT NULL,
  used integer DEFAULT 0,
  created_at text NOT NULL,
  -- columns appended by the SQLite migrations array, same order
  token_hash text,
  requested_ip text
);

CREATE TABLE IF NOT EXISTS app_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  user_id text,
  actor_email text,
  action text NOT NULL,
  target_id text,
  outcome text NOT NULL DEFAULT 'success',
  ip text,
  user_agent text,
  detail text,
  created_at text NOT NULL
);

-- Indexes (1:1 with database.ts)
CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_id ON upload_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_uploaded_files_session_id ON uploaded_files(session_id);
CREATE INDEX IF NOT EXISTS idx_pending_items_session_id ON pending_items(session_id);
CREATE INDEX IF NOT EXISTS idx_pending_items_user_id ON pending_items(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_items_status ON pending_items(status);
CREATE INDEX IF NOT EXISTS idx_category_rules_user_id ON category_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_clarifications_user_id ON clarifications(user_id);
CREATE INDEX IF NOT EXISTS idx_clarifications_status ON clarifications(status);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_account_id ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_transactions_category_id ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_user_id ON recurring_expenses(user_id);
CREATE INDEX IF NOT EXISTS idx_budgets_user_id ON budgets(user_id);
CREATE INDEX IF NOT EXISTS idx_budgets_month ON budgets(month);
CREATE INDEX IF NOT EXISTS idx_budgets_user_month ON budgets(user_id, month);
CREATE INDEX IF NOT EXISTS idx_goals_user_id ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_investments_user_id ON investments(user_id);
CREATE INDEX IF NOT EXISTS idx_investments_account_id ON investments(account_id);
CREATE INDEX IF NOT EXISTS idx_net_worth_snapshots_user_id ON net_worth_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_net_worth_snapshots_date ON net_worth_snapshots(date);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON password_reset_tokens(token);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_advisor_id ON users(advisor_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
`;

/**
 * Apply the Postgres schema. Safe to re-run: every statement is IF NOT EXISTS.
 * Runs before the one-shot migrator so `app_config` exists for its guard check.
 */
export async function applyPgSchema(db: Sql): Promise<void> {
  await db.exec(PG_SCHEMA_SQL);
}
