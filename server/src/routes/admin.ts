import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../db/database.js';
import crypto from 'crypto';

const router = Router();

// GET /clients - list all clients for this advisor
router.get('/clients', (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    const clients = db.prepare(`
      SELECT u.id, u.email, u.username, u.name, u.phone, u.created_at,
        (SELECT COUNT(*) FROM transactions WHERE user_id = u.id) as transaction_count,
        (SELECT COUNT(*) FROM accounts WHERE user_id = u.id) as account_count,
        (SELECT COALESCE(SUM(balance), 0) FROM accounts WHERE user_id = u.id AND type IN ('checking','savings')) as total_balance,
        (SELECT COALESCE(SUM(ABS(amount)), 0) FROM transactions WHERE user_id = u.id AND amount < 0 AND date >= date('now', 'start of month')) as monthly_spending
      FROM users u
      WHERE u.advisor_id = ? AND u.role = 'client'
      ORDER BY u.name ASC
    `).all(advisorId) as any[];

    res.json({ clients });
  } catch (error) {
    console.error('Get clients error:', error);
    res.status(500).json({ error: 'Failed to get clients' });
  }
});

// POST /clients - create a new client
router.post('/clients', (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    const { email, username, name, password, phone } = req.body;

    if (!email || !password || !name) {
      res.status(400).json({ error: 'Email, password, and name are required' });
      return;
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any;
    if (existing) {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }

    if (username) {
      const existingUsername = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as any;
      if (existingUsername) {
        res.status(409).json({ error: 'Username already taken' });
        return;
      }
    }

    const id = crypto.randomUUID();
    const passwordHash = bcrypt.hashSync(password, 10);
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO users (id, email, username, password_hash, name, phone, role, advisor_id, currency, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'client', ?, 'USD', ?, ?)
    `).run(id, email, username || null, passwordHash, name, phone || null, advisorId, now, now);

    res.status(201).json({ id, email, username, name, phone, role: 'client', created_at: now });
  } catch (error) {
    console.error('Create client error:', error);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// GET /clients/:clientId - get full client details
router.get('/clients/:clientId', (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    const { clientId } = req.params;

    const client = db.prepare(
      'SELECT id, email, username, name, phone, currency, created_at FROM users WHERE id = ? AND advisor_id = ? AND role = ?'
    ).get(clientId, advisorId, 'client') as any;

    if (!client) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    // Get accounts
    const accounts = db.prepare('SELECT * FROM accounts WHERE user_id = ?').all(clientId) as any[];

    // Get recent transactions
    const transactions = db.prepare(`
      SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      LEFT JOIN accounts a ON t.account_id = a.id
      WHERE t.user_id = ?
      ORDER BY t.date DESC
      LIMIT 50
    `).all(clientId) as any[];

    // Get budgets for current month
    const currentMonth = new Date().toISOString().substring(0, 7) + '-01';
    const budgets = db.prepare(`
      SELECT b.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
        (SELECT COALESCE(SUM(ABS(t.amount)), 0) FROM transactions t
         WHERE t.user_id = ? AND t.category_id = b.category_id AND t.amount < 0
         AND t.date >= ? AND t.date < date(?, '+1 month')) as spent
      FROM budgets b
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE b.user_id = ? AND b.month = ?
    `).all(clientId, currentMonth, currentMonth, clientId, currentMonth) as any[];

    // Get goals
    const goals = db.prepare('SELECT * FROM goals WHERE user_id = ?').all(clientId) as any[];

    // Monthly summary (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const monthlySummary = db.prepare(`
      SELECT
        substr(date, 1, 7) as month,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
      FROM transactions
      WHERE user_id = ? AND date >= ?
      GROUP BY substr(date, 1, 7)
      ORDER BY month ASC
    `).all(clientId, sixMonthsAgo.toISOString().substring(0, 10)) as any[];

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
router.delete('/clients/:clientId', (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    const { clientId } = req.params;

    const result = db.prepare('DELETE FROM users WHERE id = ? AND advisor_id = ? AND role = ?')
      .run(clientId, advisorId, 'client');

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
router.get('/dashboard', (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;

    // Client count
    const clientCount = (db.prepare(
      'SELECT COUNT(*) as count FROM users WHERE advisor_id = ? AND role = ?'
    ).get(advisorId, 'client') as any).count;

    // Total AUM (assets under management)
    const aumResult = db.prepare(`
      SELECT COALESCE(SUM(a.balance), 0) as total
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      WHERE u.advisor_id = ? AND u.role = 'client' AND a.balance > 0
    `).get(advisorId) as any;

    // Total liabilities
    const liabResult = db.prepare(`
      SELECT COALESCE(SUM(ABS(a.balance)), 0) as total
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      WHERE u.advisor_id = ? AND u.role = 'client' AND a.balance < 0
    `).get(advisorId) as any;

    // Clients with budgets at risk (spending > 90% of budget this month)
    const currentMonth = new Date().toISOString().substring(0, 7) + '-01';
    const atRiskClients = db.prepare(`
      SELECT DISTINCT u.id, u.name, u.email
      FROM users u
      JOIN budgets b ON b.user_id = u.id AND b.month = ?
      WHERE u.advisor_id = ? AND u.role = 'client'
      AND (
        SELECT COALESCE(SUM(ABS(t.amount)), 0)
        FROM transactions t
        WHERE t.user_id = u.id AND t.category_id = b.category_id AND t.amount < 0
        AND t.date >= ? AND t.date < date(?, '+1 month')
      ) > b.amount * 0.9
    `).all(currentMonth, advisorId, currentMonth, currentMonth) as any[];

    // Recent activity across all clients
    const recentActivity = db.prepare(`
      SELECT t.*, u.name as client_name, c.name as category_name, c.icon as category_icon
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE u.advisor_id = ? AND u.role = 'client'
      ORDER BY t.date DESC, t.created_at DESC
      LIMIT 20
    `).all(advisorId) as any[];

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
router.get('/clients/:clientId/report', (req: Request, res: Response) => {
  try {
    const advisorId = req.user!.id;
    const { clientId } = req.params;
    const reportType = (req.query.type as string) || 'monthly';

    // Verify client belongs to advisor
    const client = db.prepare(
      'SELECT id, name, email FROM users WHERE id = ? AND advisor_id = ? AND role = ?'
    ).get(clientId, advisorId, 'client') as any;

    if (!client) {
      res.status(404).json({ error: 'Client not found' });
      return;
    }

    if (reportType === 'monthly') {
      const month = (req.query.month as string) || new Date().toISOString().substring(0, 7);
      const monthStart = month + '-01';
      const [y, m] = month.split('-').map(Number);
      const endOfMonth = new Date(y, m, 0);
      const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

      const income = (db.prepare(
        'SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ?'
      ).get(clientId, monthStart, monthEnd) as any).total;

      const expenses = (db.prepare(
        'SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ?'
      ).get(clientId, monthStart, monthEnd) as any).total;

      const categoryBreakdown = db.prepare(`
        SELECT c.name, c.icon, c.color, COALESCE(SUM(ABS(t.amount)), 0) as total, COUNT(t.id) as count
        FROM transactions t JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date <= ?
        GROUP BY c.id ORDER BY total DESC
      `).all(clientId, monthStart, monthEnd) as any[];

      const accounts = db.prepare('SELECT name, type, balance FROM accounts WHERE user_id = ?').all(clientId) as any[];

      const goals = db.prepare('SELECT name, target_amount, current_amount, target_date FROM goals WHERE user_id = ?').all(clientId) as any[];

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

      const monthlyData = db.prepare(`
        SELECT substr(date, 1, 7) as month,
          SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
          SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
        FROM transactions WHERE user_id = ? AND date >= ? AND date <= ?
        GROUP BY substr(date, 1, 7) ORDER BY month ASC
      `).all(clientId, startDate, endDate) as any[];

      const totals = db.prepare(`
        SELECT
          SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_income,
          SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as total_expenses,
          COUNT(*) as transaction_count
        FROM transactions WHERE user_id = ? AND date >= ? AND date <= ?
      `).get(clientId, startDate, endDate) as any;

      const accounts = db.prepare('SELECT name, type, balance FROM accounts WHERE user_id = ?').all(clientId) as any[];
      const goals = db.prepare('SELECT name, target_amount, current_amount, target_date FROM goals WHERE user_id = ?').all(clientId) as any[];

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
