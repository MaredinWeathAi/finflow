import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import compression from 'compression';
import { initDb } from './db/database.js';
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
