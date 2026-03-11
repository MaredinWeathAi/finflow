import Database, { type Database as DatabaseType } from 'better-sqlite3';
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
const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb(): void {
  db.exec(`
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
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // Create password reset tokens table if not exists
  try {
    db.exec(`
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

  console.log('Database initialized successfully');
}

/**
 * Check if the database has real (non-seed) user data.
 * This is used to prevent the auto-seed from wiping uploaded transactions.
 */
function hasRealUserData(): boolean {
  try {
    // Check for upload sessions (only created by real file uploads)
    const uploadCount = (db.prepare('SELECT COUNT(*) as count FROM upload_sessions').get() as any).count;
    if (uploadCount > 0) return true;

    // Check for transactions marked as 'upload' or 'manual' source
    const realTxCount = (db.prepare("SELECT COUNT(*) as count FROM transactions WHERE source IN ('upload', 'manual')").get() as any).count;
    if (realTxCount > 0) return true;

    // Check for accounts created from uploads
    const realAcctCount = (db.prepare("SELECT COUNT(*) as count FROM accounts WHERE source = 'upload'").get() as any).count;
    if (realAcctCount > 0) return true;

    return false;
  } catch {
    return false;
  }
}

export { db, initDb, hasRealUserData };
