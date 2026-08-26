import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/database.js';
import {
  ensureFlowClassification,
  SQL_SPEND_FLOWS,
  sqlIncome,
  sqlExpenses,
} from '../engine/flow.js';
import crypto from 'crypto';

const router = Router();

// GET /clients - list all clients for this advisor
router.get('/clients', async (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    await ensureFlowClassification();
    const clients = await db.all(`
      SELECT u.id, u.email, u.username, u.name, u.phone, u.created_at,
        (SELECT COUNT(*) FROM transactions WHERE user_id = u.id) as transaction_count,
        (SELECT COUNT(*) FROM accounts WHERE user_id = u.id) as account_count,
        (SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE user_id = u.id AND type IN ('checking','savings')) as total_balance,
        (SELECT ${sqlExpenses()} FROM transactions WHERE user_id = u.id AND ${SQL_SPEND_FLOWS} AND date >= date('now', 'start of month')) as monthly_spending
      FROM users u
      WHERE u.advisor_id = ? AND u.role = 'client'
      ORDER BY u.name ASC
    `, advisorId) as any[];

    res.json({ clients });
  } catch (error) {
    console.error('Get clients error:', error);
    res.status(500).json({ error: 'Failed to get clients' });
  }
});

// POST /clients - create a new client
router.post('/clients', async (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    const { email, username, name, password, phone } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: 'Email, password, and name are required' });
      return;
    }

    const existing = await db.get('SELECT id FROM users WHERE email = ?', email) as any;
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    if (username) {
      const existingUsername = await db.get('SELECT id FROM users WHERE username = ?', username) as any;
      if (existingUsername) {
        res.status(409).json({ error: 'Username already taken' });
        return;
      }
    }

    const id = crypto.randomUUID();
    const passwordHash = bcrypt.hashSync(password, 10);
    const now = new Date().toISOString();

    await db.run(`
      INSERT INTO users (id, email, username, password_hash, name, phone, role, advisor_id, currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'client', ?, 'USD', ?, ?)
    `, id, email, username || null, passwordHash, name, phone || null, advisorId, now, now);

    res.status(201).json({ id, email, username, name, phone, role: 'client', created_at: now });
  } catch (error) {
    console.error('Create client error:', error);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// GET /clients/:clientId - get full client details
router.get('/clients/:clientId', async (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    const { clientId } = req.params;

    const client = await db.get('SELECT id, email, username, name, phone, currency, created_at FROM users WHERE id = ? AND advisor_id = ? AND role = ?', clientId, advisorId, 'client') as any;

    if (!client) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    await ensureFlowClassification(String(clientId));

    // Get accounts
    const accounts = await db.all('SELECT * FROM accounts WHERE user_id = ?', clientId) as any[];

    // Get recent transactions
    const transactions = await db.all(`
      SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.user_id = ?
      ORDER BY t.date DESC
      LIMIT 50
    `, clientId) as any[];

    // Get budgets for current month
    const currentMonth = new Date().toISOString().substring(0, 7) + '-01';
    const budgets = await db.all(`
      SELECT b.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
        (SELECT ${sqlExpenses('t')} FROM transactions t
         WHERE t.user_id = ? AND t.category_id = b.category_id AND t.flow_type IN ('expense', 'interest_fee', 'refund')
         AND t.date >= ? AND t.date < date(?, '+1 month')) as spent
      FROM budgets b
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE b.user_id = ? AND b.month = ?
    `, clientId, currentMonth, currentMonth, clientId, currentMonth) as any[];

    // Get goals
    const goals = await db.all('SELECT * FROM goals WHERE user_id = ?', clientId) as any[];

    // Monthly summary (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const monthlySummary = await db.all(`
      SELECT
        substr(date, 1, 7) as month,
        ${sqlIncome()} as income,
        ${sqlExpenses()} as expenses
      FROM transactions
      WHERE user_id = ? AND date >= ?
      GROUP BY substr(date, 1, 7)
      ORDER BY month ASC
    `, clientId, sixMonthsAgo.toISOString().substring(0, 10)) as any[];

    res.json({
      client,
      accounts,
      transactions,
      budgets,
      goals,
      monthlySummary,
    });
  } catch (error) {
    console.error('Get client details error:', error);
    res.status(500).json({ error: 'Failed to get client details' });
  }
});

// DELETE /clients/:clientId
router.delete('/clients/:clientId', async (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    const { clientId } = req.params;

    const result = await db.run('DELETE FROM users WHERE id = ? AND advisor_id = ? AND role = ?', clientId, advisorId, 'client');

    if (result.changes === 0) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Delete client error:', error);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

// GET /dashboard - advisor overview dashboard data
router.get('/dashboard', async (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    await ensureFlowClassification();

    // Client count
    const clientCount = (await db.get('SELECT COUNT(*) as count FROM users WHERE advisor_id = ? AND role = ?', advisorId, 'client') as any).count;

    // Total AUM (assets under management) — asset-typed accounts only; a
    // positive-stored loan balance is debt, not AUM (audit D7)
    const aumResult = await db.get(`
      SELECT COALESCE(SUM(a.balance), 0) as total
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      WHERE u.advisor_id = ? AND u.role = 'client' AND a.balance > 0
        AND a.type NOT IN ('credit', 'loan', 'mortgage')
    `, advisorId) as any;

    // Total liabilities — type-aware; an overpaid card (positive balance on a
    // credit account) owes nothing, never abs()
    const liabResult = await db.get(`
      SELECT COALESCE(SUM(CASE WHEN a.balance < 0 THEN -a.balance WHEN a.type != 'credit' THEN a.balance ELSE 0 END), 0) as total
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      WHERE u.advisor_id = ? AND u.role = 'client' AND a.type IN ('credit', 'loan', 'mortgage')
    `, advisorId) as any;

    // Clients with budgets at risk (spending > 90% of budget this month)
    const currentMonth = new Date().toISOString().substring(0, 7) + '-01';
    const atRiskClients = await db.all(`
      SELECT DISTINCT u.id, u.name, u.email
      FROM users u
      JOIN budgets b ON b.user_id = u.id AND b.month = ?
      WHERE u.advisor_id = ? AND u.role = 'client'
      AND (
        SELECT COALESCE(SUM(ABS(t.amount)), 0)
        FROM transactions t
        WHERE t.user_id = u.id AND t.category_id = b.category_id AND t.flow_type IN ('expense', 'interest_fee')
        AND t.date >= ? AND t.date < date(?, '+1 month')
      ) > b.amount * 0.9
    `, currentMonth, advisorId, currentMonth, currentMonth) as any[];

    // Recent activity across all clients
    const recentActivity = await db.all(`
      SELECT t.*, u.name as client_name, c.name as category_name, c.icon as category_icon
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE u.advisor_id = ? AND u.role = 'client'
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT 20
    `, advisorId) as any[];

    res.json({
      clientCount,
      totalAUM: aumResult.total,
      totalLiabilities: liabResult.total,
      netWorth: aumResult.total - liabResult.total,
      atRiskClients,
      recentActivity,
    });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ error: 'Failed to get dashboard data' });
  }
});

// GET /clients/:clientId/report?type=monthly&month=2026-03
router.get('/clients/:clientId/report', async (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    const { clientId } = req.params;
    const reportType = (req.query.type as string) || 'monthly';

    // Verify client belongs to advisor
    const client = await db.get('SELECT id, name, email FROM users WHERE id = ? AND advisor_id = ? AND role = ?', clientId, advisorId, 'client') as any;

    if (!client) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    await ensureFlowClassification(String(clientId));

    if (reportType === 'monthly') {
      const month = (req.query.month as string) || new Date().toISOString().substring(0, 7);
      const monthStart = month + '-01';
      const [y, m] = month.split('-').map(Number);
      const endOfMonth = new Date(y, m, 0);
      const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

      const income = (await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND flow_type = 'income' AND date >= ? AND date <= ?`, clientId, monthStart, monthEnd) as any).total;

      const expenses = (await db.get(`SELECT ${sqlExpenses()} as total FROM transactions WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND date >= ? AND date <= ?`, clientId, monthStart, monthEnd) as any).total;

      const categoryBreakdown = await db.all(`
        SELECT c.name, c.icon, c.color, ${sqlExpenses('t')} as total, COUNT(t.id) as count
        FROM transactions t JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund') AND t.date >= ? AND t.date <= ?
        GROUP BY c.id ORDER BY total DESC
      `, clientId, monthStart, monthEnd) as any[];

      const accounts = await db.all('SELECT name, type, balance FROM accounts WHERE user_id = ?', clientId) as any[];

      const goals = await db.all('SELECT name, target_amount, current_amount, target_date FROM goals WHERE user_id = ?', clientId) as any[];

      res.json({
        client,
        reportType: 'monthly',
        month,
        income: Math.round(income * 100) / 100,
        expenses: Math.round(expenses * 100) / 100,
        net: Math.round((income - expenses) * 100) / 100,
        savingsRate: income > 0 ? Math.round(((income - expenses) / income) * 10000) / 100 : 0,
        categoryBreakdown,
        accounts,
        goals,
        generatedAt: new Date().toISOString(),
      });
    } else {
      // Annual report
      const year = (req.query.year as string) || String(new Date().getFullYear());
      const startDate = `${year}-01-01`;
      const endDate = `${year}-12-31`;

      const monthlyData = await db.all(`
        SELECT substr(date, 1, 7) as month,
          ${sqlIncome()} as income,
          ${sqlExpenses()} as expenses
        FROM transactions WHERE user_id = ? AND date >= ? AND date <= ?
        GROUP BY substr(date, 1, 7) ORDER BY month ASC
      `, clientId, startDate, endDate) as any[];

      const totals = await db.get(`
        SELECT
          ${sqlIncome()} as total_income,
          ${sqlExpenses()} as total_expenses,
          COUNT(*) as transaction_count
        FROM transactions WHERE user_id = ? AND date >= ? AND date <= ?
      `, clientId, startDate, endDate) as any;

      const accounts = await db.all('SELECT name, type, balance FROM accounts WHERE user_id = ?', clientId) as any[];
      const goals = await db.all('SELECT name, target_amount, current_amount, target_date FROM goals WHERE user_id = ?', clientId) as any[];

      res.json({
        client,
        reportType: 'annual',
        year,
        totalIncome: Math.round((totals.total_income || 0) * 100) / 100,
        totalExpenses: Math.round((totals.total_expenses || 0) * 100) / 100,
        totalNet: Math.round(((totals.total_income || 0) - (totals.total_expenses || 0)) * 100) / 100,
        transactionCount: totals.transaction_count,
        monthlyBreakdown: monthlyData,
        accounts,
        goals,
        generatedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error('Client report error:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});

export default router;
