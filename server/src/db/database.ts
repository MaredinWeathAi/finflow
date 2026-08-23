import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { SqliteSql, PostgresSql, translateDdl, type Sql } from './sql.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use DATABASE_PATH env var for Railway persistent volume, fallback to local
const DB_PATH = process.env.DATABASE_PATH || path.resolve(__dirname, '../../finflow.db');

// Ensure the directory exists (for volume mounts)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Auto-backup: create a backup before opening the database if it already exists
// This protects against data loss during deployments/migrations
function backupDatabase(): void {
  if (!fs.existsSync(DB_PATH)) return;

  const backupDir = path.join(dbDir, 'backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `finflow-${timestamp}.db`);

  try {
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`📦 Database backup created: ${backupPath}`);

    // Keep only the 5 most recent backups
    const backups = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('finflow-') && f.endsWith('.db'))
      .sort()
      .reverse();

    for (const old of backups.slice(5)) {
      fs.unlinkSync(path.join(backupDir, old));
    }
  } catch (err) {
    console.warn('⚠️  Database backup failed:', err);
  }
}

backupDatabase();

console.log(`Database path: ${DB_PATH}`);
const rawSqlite: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
rawSqlite.pragma('journal_mode = WAL');
rawSqlite.pragma('foreign_keys = ON');

function initDb(): void {
  rawSqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      currency TEXT DEFAULT 'USD',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      institution TEXT,
      balance REAL NOT NULL DEFAULT 0,
      last_four TEXT,
      icon TEXT,
      is_hidden INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      color TEXT,
      budget_amount REAL,
      is_income INTEGER DEFAULT 0,
      parent_id TEXT,
      sort_order INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      category_id TEXT,
      date TEXT NOT NULL,
      notes TEXT,
      is_pending INTEGER DEFAULT 0,
      is_recurring INTEGER DEFAULT 0,
      recurring_id TEXT,
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      category_id TEXT,
      frequency TEXT NOT NULL,
      next_date TEXT NOT NULL,
      last_charged_date TEXT,
      is_active INTEGER DEFAULT 1,
      notes TEXT,
      price_history TEXT DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      month TEXT NOT NULL,
      amount REAL NOT NULL,
      rollover INTEGER DEFAULT 0,
      rollover_amount REAL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      target_amount REAL NOT NULL,
      current_amount REAL DEFAULT 0,
      target_date TEXT,
      icon TEXT,
      color TEXT,
      is_completed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS investments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      shares REAL NOT NULL,
      cost_basis REAL NOT NULL,
      current_price REAL NOT NULL,
      last_updated TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS net_worth_snapshots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      date TEXT NOT NULL,
      total_assets REAL NOT NULL,
      total_liabilities REAL NOT NULL,
      net_worth REAL NOT NULL,
      breakdown TEXT DEFAULT '{}',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Upload & Insights tables
    CREATE TABLE IF NOT EXISTS upload_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      file_count INTEGER DEFAULT 0,
      total_items INTEGER DEFAULT 0,
      imported_items INTEGER DEFAULT 0,
      duplicate_items INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS uploaded_files (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      row_count INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'parsing',
      error_message TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES upload_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pending_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT 'transaction',
      raw_data TEXT DEFAULT '{}',
      parsed_name TEXT,
      parsed_amount REAL,
      parsed_date TEXT,
      parsed_category TEXT,
      matched_category_id TEXT,
      matched_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      duplicate_of TEXT,
      confidence REAL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES upload_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS category_rules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      pattern TEXT NOT NULL,
      category_id TEXT NOT NULL,
      match_type TEXT NOT NULL DEFAULT 'contains',
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clarifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'upload',
      item_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      context TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      resolution TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Indexes for new tables
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_user_id ON upload_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_uploaded_files_session_id ON uploaded_files(session_id);
    CREATE INDEX IF NOT EXISTS idx_pending_items_session_id ON pending_items(session_id);
    CREATE INDEX IF NOT EXISTS idx_pending_items_user_id ON pending_items(user_id);
    CREATE INDEX IF NOT EXISTS idx_pending_items_status ON pending_items(status);
    CREATE INDEX IF NOT EXISTS idx_category_rules_user_id ON category_rules(user_id);
    CREATE INDEX IF NOT EXISTS idx_clarifications_user_id ON clarifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_clarifications_status ON clarifications(status);

    -- Indexes for common queries
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
  `);

  // Run migrations (safe to re-run)
  const migrations = [
    "ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'client'",
    "ALTER TABLE users ADD COLUMN username TEXT",
    "ALTER TABLE users ADD COLUMN phone TEXT",
    "ALTER TABLE users ADD COLUMN advisor_id TEXT REFERENCES users(id)",
    // Track data source: 'seed' for demo data, 'upload' for user-imported, 'manual' for hand-entered
    "ALTER TABLE transactions ADD COLUMN source TEXT DEFAULT 'seed'",
    "ALTER TABLE accounts ADD COLUMN source TEXT DEFAULT 'seed'",
    // Expand category_rules into full transaction rules
    "ALTER TABLE category_rules ADD COLUMN name TEXT DEFAULT ''",
    "ALTER TABLE category_rules ADD COLUMN account_id TEXT",
    "ALTER TABLE category_rules ADD COLUMN amount_min REAL",
    "ALTER TABLE category_rules ADD COLUMN amount_max REAL",
    "ALTER TABLE category_rules ADD COLUMN amount_exact REAL",
    "ALTER TABLE category_rules ADD COLUMN assign_account_id TEXT",
    "ALTER TABLE category_rules ADD COLUMN assign_type TEXT",
    "ALTER TABLE category_rules ADD COLUMN is_enabled INTEGER DEFAULT 1",
    "ALTER TABLE category_rules ADD COLUMN priority INTEGER DEFAULT 0",
    "ALTER TABLE category_rules ADD COLUMN description TEXT DEFAULT ''",

    // --- Security hardening (2026-08) ---
    // Session generation. Bumped on password change/reset to revoke live JWTs.
    "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0",
    // Set when an account is found using a known default password, or is
    // administratively reset. Blocks every route except the change-password flow.
    "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN password_changed_at TEXT",
    "ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN locked_until TEXT",
    "ALTER TABLE users ADD COLUMN last_login_at TEXT",
    "ALTER TABLE users ADD COLUMN totp_secret TEXT",
    "ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0",
    // Reset codes are stored hashed; the plaintext column is retired.
    "ALTER TABLE password_reset_tokens ADD COLUMN token_hash TEXT",
    "ALTER TABLE password_reset_tokens ADD COLUMN requested_ip TEXT",
  ];
  for (const sql of migrations) {
    try { rawSqlite.exec(sql); } catch { /* column already exists */ }
  }

  // Backfill: mark existing NULL-source records as 'seed' (they predate the source column)
  try {
    const updated = rawSqlite.prepare("UPDATE transactions SET source = 'seed' WHERE source IS NULL").run();
    if (updated.changes > 0) console.log(`  Backfilled ${updated.changes} transactions with source='seed'`);
    const updatedAccts = rawSqlite.prepare("UPDATE accounts SET source = 'seed' WHERE source IS NULL").run();
    if (updatedAccts.changes > 0) console.log(`  Backfilled ${updatedAccts.changes} accounts with source='seed'`);
  } catch { /* safe to ignore */ }

  // Create password reset tokens table if not exists
  try {
    rawSqlite.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON password_reset_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
      CREATE INDEX IF NOT EXISTS idx_users_advisor_id ON users(advisor_id);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
    `);
  } catch { /* tables already exist */ }

  // --- Security infrastructure tables (2026-08) ---
  try {
    rawSqlite.exec(`
      /* Durable app-level secrets and settings. Lets the app self-heal a missing
         JWT_SECRET without regenerating it (and invalidating every session) on
         each restart. */
      CREATE TABLE IF NOT EXISTS app_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      /* Append-only security audit trail. */
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        actor_email TEXT,
        action TEXT NOT NULL,
        target_id TEXT,
        outcome TEXT NOT NULL DEFAULT 'success',
        ip TEXT,
        user_agent TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at);
      CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    `);
  } catch (err) {
    console.error('Security table init failed:', err);
  }

  // Backfill password_changed_at so the account-age signals are sane.
  try {
    rawSqlite.prepare('UPDATE users SET password_changed_at = created_at WHERE password_changed_at IS NULL').run();
  } catch { /* column may not exist on very old schemas */ }

  console.log('Database initialized successfully');
}

/**
 * Check if the database has real (non-seed) user data.
 * This is used to prevent the auto-seed from wiping uploaded transactions.
 */
function hasRealUserData(): boolean {
  try {
    // Check for upload sessions (only created by real file uploads)
    const uploadCount = (rawSqlite.prepare('SELECT COUNT(*) as count FROM upload_sessions').get() as any).count;
    if (uploadCount > 0) return true;

    // Check for transactions marked as 'upload' or 'manual' source
    const realTxCount = (rawSqlite.prepare("SELECT COUNT(*) as count FROM transactions WHERE source IN ('upload', 'manual')").get() as any).count;
    if (realTxCount > 0) return true;

    // Check for accounts created from uploads
    const realAcctCount = (rawSqlite.prepare("SELECT COUNT(*) as count FROM accounts WHERE source = 'upload'").get() as any).count;
    if (realAcctCount > 0) return true;

    return false;
  } catch {
    return false;
  }
}

/**
 * The application data handle.
 *
 * This is the async adapter, not the raw better-sqlite3 object. Every call site
 * awaits. Under DB_DRIVER=sqlite it resolves immediately (identical behaviour to
 * the old synchronous code); under DB_DRIVER=postgres it talks to Railway Postgres.
 */
let db: Sql = new SqliteSql(rawSqlite);

export function getDriver(): 'sqlite' | 'postgres' {
  return process.env.DB_DRIVER === 'postgres' ? 'postgres' : 'sqlite';
}

/**
 * Swap in the Postgres driver. Called once at boot, after initDb(), and only
 * when DB_DRIVER=postgres and DATABASE_URL is present.
 */
export async function usePostgres(): Promise<void> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.DATABASE_URL?.includes('railway.internal') ? undefined : { rejectUnauthorized: false },
  });
  await pool.query('SELECT 1');
  db = new PostgresSql(pool as any);
  console.log('[db] driver: postgres');
}

/** Raw synchronous SQLite handle — boot-time schema work and the migrator only. */
export { rawSqlite, translateDdl };
export { db, initDb, hasRealUserData };
