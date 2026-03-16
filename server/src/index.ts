import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import { initDb, db, hasRealUserData } from './db/database.js';
import { authMiddleware, adminMiddleware } from './middleware/auth.js';

// Route imports
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import transactionRoutes from './routes/transactions.js';
import categoryRoutes from './routes/categories.js';
import budgetRoutes from './routes/budgets.js';
import recurringRoutes from './routes/recurring.js';
import goalRoutes from './routes/goals.js';
import investmentRoutes from './routes/investments.js';
import reportRoutes from './routes/reports.js';
import settingsRoutes from './routes/settings.js';
import dataRoutes from './routes/data.js';
import insightsRoutes from './routes/insights.js';
import uploadRoutes from './routes/upload.js';
import clarificationsRoutes from './routes/clarifications.js';
import adminRoutes from './routes/admin.js';
import financialPlanningRoutes from './routes/financial-planning.js';
import rulesRoutes from './routes/rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's reverse proxy (needed for secure cookies behind HTTPS proxy)
app.set('trust proxy', 1);

// ============================================================
// HEALTH CHECK — MUST be before any middleware that touches DB
// Railway hits this to verify the app is alive.
// ============================================================

app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// TEMPORARY debug endpoint — remove after investigation
app.get('/api/debug-txns', (_req, res) => {
  try {
    const month = (_req.query.month as string) || '2026-02';
    const monthStart = `${month}-01`;
    const monthEnd = `${month}-31`;
    const userParam = _req.query.user as string;

    // Show all users
    const allUsers = db.prepare('SELECT id, username, email FROM users').all();

    // Get user - either specified or first
    let user: any;
    if (userParam) {
      user = db.prepare('SELECT id, username FROM users WHERE username = ? OR id = ?').get(userParam, userParam) as any;
    }
    if (!user) {
      user = db.prepare('SELECT id, username FROM users LIMIT 1').get() as any;
    }
    if (!user) return res.json({ error: 'No users', allUsers });

    // Get all months with data for this user
    const months = db.prepare(
      `SELECT substr(date, 1, 7) as month, COUNT(*) as count,
              SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
              SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
       FROM transactions WHERE user_id = ?
       GROUP BY substr(date, 1, 7)
       ORDER BY month DESC`
    ).all(user.id);

    // All income (positive) for the month
    const income = db.prepare(
      `SELECT t.id, t.name, t.amount, t.date, c.name as category_name, a.name as account_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.user_id = ? AND t.amount > 0 AND t.date >= ? AND t.date <= ?
       ORDER BY t.amount DESC`
    ).all(user.id, monthStart, monthEnd);

    // All Zelle transactions (any amount)
    const zelle = db.prepare(
      `SELECT t.id, t.name, t.amount, t.date, c.name as category_name, a.name as account_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? AND LOWER(t.name) LIKE '%zelle%'
       ORDER BY t.date DESC`
    ).all(user.id, monthStart, monthEnd);

    // All Fifth Generation transactions
    const fifthGen = db.prepare(
      `SELECT t.id, t.name, t.amount, t.date, c.name as category_name, a.name as account_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.user_id = ? AND LOWER(t.name) LIKE '%fifth%generation%'
       ORDER BY t.date DESC`
    ).all(user.id);

    // Curran transactions
    const curran = db.prepare(
      `SELECT t.id, t.name, t.amount, t.date, c.name as category_name, a.name as account_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.user_id = ? AND LOWER(t.name) LIKE '%curran%'
       ORDER BY t.date DESC`
    ).all(user.id);

    // Total income/expense for the month
    const totals = db.prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) as totalIncome,
        COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as totalExpenses
       FROM transactions WHERE user_id = ? AND date >= ? AND date <= ?`
    ).get(user.id, monthStart, monthEnd);

    // Rules
    const rules = db.prepare(
      `SELECT r.*, c.name as category_name FROM category_rules r
       LEFT JOIN categories c ON r.category_id = c.id
       WHERE r.user_id = ?`
    ).all(user.id);

    res.json({
      allUsers,
      user: user.username,
      userId: user.id,
      monthsWithData: months,
      month,
      totals,
      incomeCount: (income as any[]).length,
      income,
      zelleCount: (zelle as any[]).length,
      zelle,
      fifthGenCount: (fifthGen as any[]).length,
      fifthGen,
      curranCount: (curran as any[]).length,
      curran,
      rulesCount: (rules as any[]).length,
      rules,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// One-time seed endpoint — only seeds if no users exist
app.post('/api/seed', async (_req, res) => {
  try {
    const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
    if (userCount > 0) {
      res.json({ message: 'Database already seeded', userCount });
      return;
    }
    // Dynamic import of seed script
    await import('./db/seed.js');
    res.json({ message: 'Database seeded successfully' });
  } catch (error: any) {
    console.error('Seed error:', error);
    res.status(500).json({ error: 'Seed failed', details: error.message });
  }
});

// ============================================================
// MIDDLEWARE
// ============================================================

// Gzip compression
app.use(compression());

app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Serve static frontend files (built Vite output)
const publicDir = path.resolve(__dirname, '../../public');
app.use(express.static(publicDir, {
  maxAge: '1h',
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ============================================================
// DATABASE INIT
// ============================================================

initDb();

// Database persistence verification
console.log(`Database path: ${process.env.DATABASE_PATH || '(default - NOT persistent on Railway)'}`);
if (!process.env.DATABASE_PATH && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  WARNING: DATABASE_PATH not set in production! Data will NOT persist across deploys.');
  console.warn('⚠️  Set DATABASE_PATH=/data/finflow.db and attach a persistent volume at /data');
}

// Auto-seed if database is truly empty (fresh volume or first deploy)
// SAFETY: Never seed over real user data (uploaded transactions, etc.)
try {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as any).count;
  if (userCount === 0) {
    if (hasRealUserData()) {
      console.warn('⚠️  WARNING: Database has 0 users but contains real upload data!');
      console.warn('⚠️  Skipping auto-seed to protect existing data. Check backups/ folder.');
    } else {
      console.log('Empty database detected, auto-seeding...');
      import('./db/seed.js').then(() => {
        console.log('Auto-seed complete');
      }).catch(err => {
        console.error('Auto-seed failed:', err);
      });
    }
  } else {
    const realData = hasRealUserData();
    console.log(`✅ Database persistent: ${userCount} users found${realData ? ' (contains real user data)' : ' (seed data only)'}`);
  }
} catch (e) {
  console.error('Seed check failed:', e);
}

// ============================================================
// PUBLIC ROUTES (no auth required)
// ============================================================

app.use('/api/auth', authRoutes);

// ============================================================
// PROTECTED ROUTES (auth required)
// ============================================================

app.use('/api/accounts', authMiddleware, accountRoutes);
app.use('/api/transactions', authMiddleware, transactionRoutes);
app.use('/api/categories', authMiddleware, categoryRoutes);
app.use('/api/budgets', authMiddleware, budgetRoutes);
app.use('/api/recurring', authMiddleware, recurringRoutes);
app.use('/api/goals', authMiddleware, goalRoutes);
app.use('/api/investments', authMiddleware, investmentRoutes);
app.use('/api/reports', authMiddleware, reportRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);
app.use('/api/data', authMiddleware, dataRoutes);
app.use('/api/insights', authMiddleware, insightsRoutes);
app.use('/api/upload', authMiddleware, uploadRoutes);
app.use('/api/clarifications', authMiddleware, clarificationsRoutes);
app.use('/api/admin', authMiddleware, adminMiddleware, adminRoutes);
app.use('/api/financial-planning', authMiddleware, financialPlanningRoutes);
app.use('/api/rules', authMiddleware, rulesRoutes);

// ============================================================
// ERROR HANDLING
// ============================================================

app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      error: 'Internal server error',
      message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
);

// ============================================================
// SPA CATCH-ALL: serve index.html for any non-API route
// ============================================================

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ============================================================
// UNCAUGHT ERROR HANDLERS
// ============================================================

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`FinFlow server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
