import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { initDb, db, hasRealUserData, getDriver, usePostgres, revertToSqlite } from './db/database.js';
import { applyPgSchema } from './db/schema-pg.js';
import { migrateSqliteToPostgres } from './db/migrate-sqlite-to-postgres.js';
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

import {
  ALLOWED_ORIGINS,
  IS_PROD,
  enforceNoDefaultCredentials,
  initSecurity,
  logSecurityPosture,
} from './config/security.js';
import { trimAuditLog } from './security/audit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Trust exactly one proxy hop (Railway's edge). Required for correct client IPs
// in rate limiting and the audit log; more hops would let clients spoof X-Forwarded-For.
app.set('trust proxy', 1);

// Don't advertise the framework.
app.disable('x-powered-by');

// ============================================================
// HEALTH CHECK — MUST be before any middleware that touches DB
// Railway hits this to verify the app is alive.
// ============================================================

app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// NOTE: The unauthenticated `POST /api/seed` endpoint was removed (finding H3).
// It allowed an anonymous caller to trigger creation of default-credential
// accounts on a fresh volume, and leaked the deployment's user count.
// Seeding is now a deliberate operation: `npm run seed` with ADMIN_EMAIL and
// ADMIN_PASSWORD set, and it refuses to create demo accounts in production.

// ============================================================
// MIDDLEWARE
// ============================================================

// Gzip compression
app.use(compression());

// --- Security headers (finding H4) -----------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        // Vite emits a small inline bootstrap; styles are injected at runtime.
        scriptSrc: ["'self'"],
        // index.html links a Google Fonts stylesheet; Tailwind/Radix inject
        // inline styles at runtime. TODO(design wave): self-host the webfont and
        // drop both external hosts from this policy.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        connectSrc: ["'self'", ...ALLOWED_ORIGINS],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: IS_PROD ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: IS_PROD ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
  })
);

// --- CORS: same-origin by default, explicit allowlist otherwise (finding M3) --
app.use(
  cors({
    origin(origin, callback) {
      // Same-origin / server-to-server requests send no Origin header.
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    maxAge: 600,
  })
);

// --- Rate limiting (finding H2) --------------------------------------------
const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts from this address. Try again in a few minutes.' },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Upload limit reached for this hour.' },
});

app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/upload', uploadLimiter);

// Default JSON body cap is deliberately small; the upload route uses multer with
// its own limits and does not go through express.json.
app.use(express.json({ limit: '256kb' }));

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

// Schema + migrations run against the raw synchronous SQLite handle. This is
// boot-time only, before any request is served.
initDb();

// Switch the async data layer over to Postgres when configured. Everything above
// this point still runs on SQLite, which is what the one-shot migrator reads.
//
// Cutover order: connect → apply schema (idempotent) → one-shot data migration
// (idempotent, single transaction, verified). If ANY step throws, we fall back
// to the SQLite driver — the file still holds all production data, and a
// wrong-but-empty app is far worse than a delayed migration.
if (getDriver() === 'postgres') {
  if (!process.env.DATABASE_URL) {
    console.error('[db] DB_DRIVER=postgres but DATABASE_URL is not set — staying on SQLite.');
  } else {
    try {
      await usePostgres();
      await applyPgSchema(db);
      const migration = await migrateSqliteToPostgres();
      if (migration.migrated) {
        console.log('[db] SQLite → Postgres migration completed and verified.');
      } else {
        console.log(`[db] SQLite → Postgres migration skipped: ${migration.reason}`);
      }
    } catch (err) {
      console.error('='.repeat(72));
      console.error('[db] ❌ POSTGRES CUTOVER FAILED — FALLING BACK TO SQLITE.');
      console.error('[db] The migration transaction rolled back; Postgres was left untouched.');
      console.error('[db] The app is serving from the SQLite file. Fix the error and redeploy.');
      console.error(err);
      console.error('='.repeat(72));
      await revertToSqlite();
    }
  }
} else {
  console.log('[db] driver: sqlite');
}

// Resolve and cache signing secrets. Must run after initDb() (it reads
// app_config) and before any token is issued or verified.
await initSecurity();

// Database persistence verification
console.log(`Database path: ${process.env.DATABASE_PATH || '(default - NOT persistent on Railway)'}`);
if (!process.env.DATABASE_PATH && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  WARNING: DATABASE_PATH not set in production! Data will NOT persist across deploys.');
  console.warn('⚠️  Set DATABASE_PATH=/data/finflow.db and attach a persistent volume at /data');
}

// Auto-seed if database is truly empty (fresh volume or first deploy)
// SAFETY: Never seed over real user data (uploaded transactions, etc.)
try {
  const userCount = (await db.get('SELECT COUNT(*) as count FROM users') as any).count;
  if (userCount === 0) {
    if (hasRealUserData()) {
      console.warn('⚠️  WARNING: Database has 0 users but contains real upload data!');
      console.warn('⚠️  Skipping auto-seed to protect existing data. Check backups/ folder.');
    } else if (IS_PROD) {
      // SECURITY (finding C1): never auto-seed in production. The old behaviour
      // created `demo@finflow.com / demo123` with role=admin on any fresh volume.
      console.warn('Empty database in production — auto-seed is disabled.');
      console.warn('Run `npm run seed` with ADMIN_EMAIL and ADMIN_PASSWORD set to bootstrap an account.');
    } else {
      console.log('Empty database detected, auto-seeding (development only)...');
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
// BOOT-TIME SECURITY GUARDS
// ============================================================

// Flags any account still using a known default password (e.g. the historical
// `demo123` / `password123` seeds) as password-change-only and kills its sessions.
await enforceNoDefaultCredentials();
await trimAuditLog();
logSecurityPosture();

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
