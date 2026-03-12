import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

// GET /monthly?month=YYYY-MM-DD - monthly report
router.get('/monthly', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const month = (req.query.month as string) || new Date().toISOString().substring(0, 10);
    const monthStr = month.substring(0, 7) + '-01';

    const [year, mon] = monthStr.split('-').map(Number);
    const endOfMonth = new Date(year, mon, 0);
    const endDate = `${year}-${String(mon).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

    // Total income (positive amounts)
    const incomeResult = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as total
         FROM transactions
         WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ?`
      )
      .get(userId, monthStr, endDate) as any;

    // Total expenses (negative amounts)
    const expenseResult = db
      .prepare(
        `SELECT COALESCE(SUM(ABS(amount)), 0) as total
         FROM transactions
         WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ?`
      )
      .get(userId, monthStr, endDate) as any;

    const income = Math.round(incomeResult.total * 100) / 100;
    const expenses = Math.round(expenseResult.total * 100) / 100;
    const net = Math.round((income - expenses) * 100) / 100;
    const savingsRate = income > 0 ? Math.round(((income - expenses) / income) * 10000) / 100 : 0;

    // Top expense categories
    const topCategories = db
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color,
                COALESCE(SUM(ABS(t.amount)), 0) as total,
                COUNT(t.id) as transaction_count
         FROM transactions t
         JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date <= ?
         GROUP BY c.id
         ORDER BY total DESC
         LIMIT 10`
      )
      .all(userId, monthStr, endDate);

    // Transaction count
    const txCount = db
      .prepare(
        `SELECT COUNT(*) as count FROM transactions
         WHERE user_id = ? AND date >= ? AND date <= ?`
      )
      .get(userId, monthStr, endDate) as any;

    res.json({
      month: monthStr,
      total_income: income,
      total_expenses: expenses,
      net,
      savings_rate: savingsRate,
      top_categories: (topCategories as any[]).map((c: any) => ({
        name: c.name,
        icon: c.icon,
        color: c.color,
        amount: c.total,
        count: c.transaction_count,
      })),
      budget_adherence: 0,
      transaction_count: txCount.count,
    });
  } catch (error) {
    console.error('Monthly report error:', error);
    res.status(500).json({ error: 'Failed to generate monthly report' });
  }
});

// GET /annual?year=YYYY - annual report with monthly breakdown
router.get('/annual', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const year = (req.query.year as string) || String(new Date().getFullYear());
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    // Monthly breakdown
    const monthlyData = db
      .prepare(
        `SELECT
           substr(date, 1, 7) as month,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
           SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
         FROM transactions
         WHERE user_id = ? AND date >= ? AND date <= ?
         GROUP BY substr(date, 1, 7)
         ORDER BY month ASC`
      )
      .all(userId, startDate, endDate)
      .map((row: any) => ({
        month: row.month,
        income: Math.round(row.income * 100) / 100,
        expenses: Math.round(row.expenses * 100) / 100,
        net: Math.round((row.income - row.expenses) * 100) / 100,
      }));

    // Annual totals
    const totalsResult = db
      .prepare(
        `SELECT
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as total_income,
           SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as total_expenses,
           COUNT(*) as transaction_count
         FROM transactions
         WHERE user_id = ? AND date >= ? AND date <= ?`
      )
      .get(userId, startDate, endDate) as any;

    const totalIncome = Math.round((totalsResult.total_income || 0) * 100) / 100;
    const totalExpenses = Math.round((totalsResult.total_expenses || 0) * 100) / 100;
    const totalNet = Math.round((totalIncome - totalExpenses) * 100) / 100;
    const avgMonthlyIncome = Math.round((totalIncome / 12) * 100) / 100;
    const avgMonthlyExpenses = Math.round((totalExpenses / 12) * 100) / 100;

    // Top categories for the year
    const topCategories = db
      .prepare(
        `SELECT c.id, c.name, c.icon, c.color,
                COALESCE(SUM(ABS(t.amount)), 0) as total,
                COUNT(t.id) as transaction_count
         FROM transactions t
         JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date <= ?
         GROUP BY c.id
         ORDER BY total DESC
         LIMIT 10`
      )
      .all(userId, startDate, endDate);

    res.json({
      year,
      totalIncome,
      totalExpenses,
      totalNet,
      avgMonthlyIncome,
      avgMonthlyExpenses,
      savingsRate: totalIncome > 0 ? Math.round(((totalIncome - totalExpenses) / totalIncome) * 10000) / 100 : 0,
      transactionCount: totalsResult.transaction_count,
      monthlyBreakdown: monthlyData,
      topCategories,
    });
  } catch (error) {
    console.error('Annual report error:', error);
    res.status(500).json({ error: 'Failed to generate annual report' });
  }
});

// GET /cashflow?period=6m - cash flow data (income vs expenses by month)
router.get('/cashflow', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const period = (req.query.period as string) || '6m';

    // Parse period
    let months = 6;
    const match = period.match(/^(\d+)m$/);
    if (match) {
      months = parseInt(match[1]);
    }

    // Calculate start date
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
    const startStr = startDate.toISOString().substring(0, 10);
    const endStr = now.toISOString().substring(0, 10);

    const cashflow = db
      .prepare(
        `SELECT
           substr(date, 1, 7) as month,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
           SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
         FROM transactions
         WHERE user_id = ? AND date >= ? AND date <= ?
         GROUP BY substr(date, 1, 7)
         ORDER BY month ASC`
      )
      .all(userId, startStr, endStr)
      .map((row: any) => ({
        month: row.month,
        income: Math.round(row.income * 100) / 100,
        expenses: Math.round(row.expenses * 100) / 100,
        net: Math.round((row.income - row.expenses) * 100) / 100,
      }));

    // Fill in missing months with zero values
    const allMonths: any[] = [];
    const current = new Date(startDate);
    while (current <= now) {
      const monthKey = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
      const existing = cashflow.find((c: any) => c.month === monthKey);
      allMonths.push(
        existing || { month: monthKey, income: 0, expenses: 0, net: 0 }
      );
      current.setMonth(current.getMonth() + 1);
    }

    res.json(allMonths);
  } catch (error) {
    console.error('Cash flow error:', error);
    res.status(500).json({ error: 'Failed to generate cash flow report' });
  }
});

// GET /networth-history - return net_worth_snapshots
router.get('/networth-history', (req: Request, res: Response) => {
  try {
    const snapshots = db
      .prepare(
        'SELECT * FROM net_worth_snapshots WHERE user_id = ? ORDER BY date ASC'
      )
      .all(req.user!.id)
      .map((s: any) => ({
        ...s,
        breakdown: JSON.parse(s.breakdown || '{}'),
      }));

    res.json(snapshots);
  } catch (error) {
    console.error('Net worth history error:', error);
    res.status(500).json({ error: 'Failed to get net worth history' });
  }
});

// GET /summary - comprehensive financial summary for reports page
router.get('/summary', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const month = (req.query.month as string) || new Date().toISOString().substring(0, 7);
    const monthStart = month + '-01';
    const [year, mon] = month.split('-').map(Number);
    const endOfMonth = new Date(year, mon, 0);
    const monthEnd = `${year}-${String(mon).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

    // Income and expenses
    const incomeResult = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ?`
    ).get(userId, monthStart, monthEnd) as any;

    const expenseResult = db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ?`
    ).get(userId, monthStart, monthEnd) as any;

    const income = Math.round(incomeResult.total * 100) / 100;
    const expenses = Math.round(expenseResult.total * 100) / 100;

    // Category breakdown (expenses)
    const expenseCategories = db.prepare(`
      SELECT c.id, c.name, c.icon, c.color,
        COALESCE(SUM(ABS(t.amount)), 0) as total,
        COUNT(t.id) as count
      FROM transactions t
      JOIN categories c ON t.category_id = c.id
      WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date <= ?
      GROUP BY c.id ORDER BY total DESC
    `).all(userId, monthStart, monthEnd) as any[];

    // Category breakdown (income)
    const incomeCategories = db.prepare(`
      SELECT c.id, c.name, c.icon, c.color,
        COALESCE(SUM(t.amount), 0) as total,
        COUNT(t.id) as count
      FROM transactions t
      JOIN categories c ON t.category_id = c.id
      WHERE t.user_id = ? AND t.amount > 0 AND t.date >= ? AND t.date <= ?
      GROUP BY c.id ORDER BY total DESC
    `).all(userId, monthStart, monthEnd) as any[];

    // Account balances
    const accounts = db.prepare(
      'SELECT id, name, type, institution, balance, icon FROM accounts WHERE user_id = ? AND is_hidden = 0 ORDER BY type, name'
    ).all(userId) as any[];

    // Goals progress
    const goals = db.prepare(
      'SELECT id, name, target_amount, current_amount, target_date, icon, color FROM goals WHERE user_id = ? AND is_completed = 0'
    ).all(userId) as any[];

    // Budget performance
    const budgets = db.prepare(`
      SELECT b.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
        (SELECT COALESCE(SUM(ABS(t.amount)), 0) FROM transactions t
         WHERE t.user_id = ? AND t.category_id = b.category_id AND t.amount < 0
         AND t.date >= ? AND t.date < date(?, '+1 month')) as spent
      FROM budgets b
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE b.user_id = ? AND b.month = ?
    `).all(userId, monthStart, monthStart, userId, monthStart) as any[];

    // Daily spending trend for this month
    const dailySpending = db.prepare(`
      SELECT date,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
      FROM transactions
      WHERE user_id = ? AND date >= ? AND date <= ?
      GROUP BY date ORDER BY date ASC
    `).all(userId, monthStart, monthEnd) as any[];

    // Last 6 months trend
    const sixMonthsAgo = new Date(year, mon - 7, 1);
    const trendStart = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, '0')}-01`;
    const monthlyTrend = db.prepare(`
      SELECT substr(date, 1, 7) as month,
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
      FROM transactions
      WHERE user_id = ? AND date >= ? AND date <= ?
      GROUP BY substr(date, 1, 7)
      ORDER BY month ASC
    `).all(userId, trendStart, monthEnd) as any[];

    // Top merchants
    const topMerchants = db.prepare(`
      SELECT name, COUNT(*) as count, SUM(ABS(amount)) as total
      FROM transactions
      WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ?
      GROUP BY LOWER(TRIM(name))
      ORDER BY total DESC LIMIT 10
    `).all(userId, monthStart, monthEnd) as any[];

    // Transaction count
    const txCount = (db.prepare(
      'SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND date >= ? AND date <= ?'
    ).get(userId, monthStart, monthEnd) as any).count;

    res.json({
      month,
      income,
      expenses,
      net: Math.round((income - expenses) * 100) / 100,
      savingsRate: income > 0 ? Math.round(((income - expenses) / income) * 10000) / 100 : 0,
      transactionCount: txCount,
      expenseCategories,
      incomeCategories,
      accounts,
      goals,
      budgets,
      dailySpending,
      monthlyTrend: monthlyTrend.map((m: any) => ({
        ...m,
        income: Math.round(m.income * 100) / 100,
        expenses: Math.round(m.expenses * 100) / 100,
        net: Math.round((m.income - m.expenses) * 100) / 100,
      })),
      topMerchants,
    });
  } catch (error) {
    console.error('Summary report error:', error);
    res.status(500).json({ error: 'Failed to generate summary report' });
  }
});

// GET /dashboard-summary - comprehensive data for improved dashboard
router.get('/dashboard-summary', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const month = (req.query.month as string) || new Date().toISOString().substring(0, 7);
    const monthStart = month + '-01';
    const [year, mon] = month.split('-').map(Number);
    const endOfMonth = new Date(year, mon, 0);
    const monthEnd = `${year}-${String(mon).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

    // Get Transfer category
    const transferCategory = db.prepare(
      `SELECT id FROM categories WHERE user_id = ? AND LOWER(name) = 'transfer'`
    ).get(userId) as any;
    const transferCategoryId = transferCategory?.id;

    // Core monthly numbers (excluding transfers)
    const buildExcludeTransferClause = () => {
      return transferCategoryId ? `AND (category_id IS NULL OR category_id != ?)` : 'AND 1=1';
    };
    const excludeParams = transferCategoryId ? [userId, monthStart, monthEnd, transferCategoryId] : [userId, monthStart, monthEnd];

    const incomeResult = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ? ${buildExcludeTransferClause()}`
    ).get(...excludeParams) as any;

    const expenseResult = db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
       WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ? ${buildExcludeTransferClause()}`
    ).get(...excludeParams) as any;

    const income = Math.round(incomeResult.total * 100) / 100;
    const expenses = Math.round(expenseResult.total * 100) / 100;
    const net = Math.round((income - expenses) * 100) / 100;
    const savingsRate = income > 0 ? Math.round(((income - expenses) / income) * 10000) / 100 : 0;

    // Overspending alert
    const isOverspending = expenses > income;
    const overspendAmount = isOverspending ? Math.round((expenses - income) * 100) / 100 : 0;

    // Credit cards (accounts where type = 'credit')
    const creditCards = db.prepare(
      `SELECT id, name, balance, institution, icon FROM accounts
       WHERE user_id = ? AND type = 'credit' AND is_hidden = 0
       ORDER BY name`
    ).all(userId) as any[];

    const totalCCDebt = creditCards.reduce((sum, cc) => sum + (cc.balance || 0), 0);

    // CC spending this month (charges on CC accounts)
    const ccSpendingResult = db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
       WHERE user_id = ? AND account_id IN (
         SELECT id FROM accounts WHERE user_id = ? AND type = 'credit'
       ) AND amount < 0 AND date >= ? AND date <= ?`
    ).get(userId, userId, monthStart, monthEnd) as any;
    const ccSpendingThisMonth = Math.round(ccSpendingResult.total * 100) / 100;

    // CC interest/fees (transactions on CC accounts with names matching patterns)
    const ccInterestFeesResult = db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
       WHERE user_id = ? AND account_id IN (
         SELECT id FROM accounts WHERE user_id = ? AND type = 'credit'
       ) AND amount < 0 AND date >= ? AND date <= ?
       AND (LOWER(name) LIKE '%interest%' OR LOWER(name) LIKE '%finance charge%'
            OR LOWER(name) LIKE '%late fee%' OR LOWER(name) LIKE '%annual fee%'
            OR LOWER(name) LIKE '%penalty%')`
    ).get(userId, userId, monthStart, monthEnd) as any;
    const ccInterestFees = Math.round(ccInterestFeesResult.total * 100) / 100;

    // Transfers in/out
    let transfersInResult = { total: 0 };
    let transfersOutResult = { total: 0 };
    if (transferCategoryId) {
      transfersInResult = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
         WHERE user_id = ? AND category_id = ? AND amount > 0 AND date >= ? AND date <= ?`
      ).get(userId, transferCategoryId, monthStart, monthEnd) as any;

      transfersOutResult = db.prepare(
        `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
         WHERE user_id = ? AND category_id = ? AND amount < 0 AND date >= ? AND date <= ?`
      ).get(userId, transferCategoryId, monthStart, monthEnd) as any;
    }
    const transfersIn = Math.round(transfersInResult.total * 100) / 100;
    const transfersOut = Math.round(transfersOutResult.total * 100) / 100;

    // Cash accounts (checking, savings, etc.)
    const cashAccounts = db.prepare(
      `SELECT id, name, balance, type FROM accounts
       WHERE user_id = ? AND type IN ('checking', 'savings') AND is_hidden = 0
       ORDER BY name`
    ).all(userId) as any[];

    const totalCash = cashAccounts.reduce((sum, acc) => sum + (acc.balance || 0), 0);

    // Top expense categories (excluding transfers)
    const topExpenses = db.prepare(
      `SELECT c.id, c.name, c.icon, c.color,
              COALESCE(SUM(ABS(t.amount)), 0) as total,
              COUNT(t.id) as transaction_count
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date <= ?
             ${transferCategoryId ? 'AND c.id != ?' : 'AND 1=1'}
       GROUP BY c.id
       ORDER BY total DESC
       LIMIT 10`
    ).all(transferCategoryId
      ? [userId, monthStart, monthEnd, transferCategoryId]
      : [userId, monthStart, monthEnd]) as any[];

    // Uncategorized transactions
    const uncategorizedResult = db.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(ABS(amount)), 0) as total
       FROM transactions
       WHERE user_id = ? AND date >= ? AND date <= ?
             AND (category_id IS NULL OR category_id IN (
               SELECT id FROM categories WHERE user_id = ? AND LOWER(name) LIKE '%uncategorized%'
             ))`
    ).get(userId, monthStart, monthEnd, userId) as any;

    const uncategorizedCount = uncategorizedResult.count || 0;
    const uncategorizedTotal = Math.round(uncategorizedResult.total * 100) / 100;

    // Investment portfolio value
    const investments = db.prepare(
      `SELECT shares, current_price FROM investments WHERE user_id = ?`
    ).all(userId) as any[];

    const investmentPortfolioValue = investments.reduce(
      (sum: number, inv: any) => sum + (inv.shares * inv.current_price), 0
    );

    // Day of month info
    const today = new Date();
    const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const daysInMonth = endOfMonth.getDate();
    const dayOfMonth = month === currentMonth ? today.getDate() : daysInMonth;

    res.json({
      income,
      expenses,
      net,
      savingsRate,
      isOverspending,
      overspendAmount,
      creditCards: creditCards.map(cc => ({
        name: cc.name,
        balance: cc.balance,
        institution: cc.institution || 'Unknown',
        icon: cc.icon || 'credit-card',
      })),
      totalCCDebt: Math.round(totalCCDebt * 100) / 100,
      ccSpendingThisMonth,
      ccInterestFees,
      transfersIn,
      transfersOut,
      cashAccounts: cashAccounts.map(acc => ({
        name: acc.name,
        balance: acc.balance,
        type: acc.type,
      })),
      totalCash: Math.round(totalCash * 100) / 100,
      investmentPortfolioValue: Math.round(investmentPortfolioValue * 100) / 100,
      investmentCount: investments.length,
      topExpenses: topExpenses.map((c: any) => ({
        name: c.name,
        icon: c.icon,
        color: c.color,
        amount: Math.round(c.total * 100) / 100,
        count: c.transaction_count,
      })),
      uncategorizedCount,
      uncategorizedTotal,
      month,
      daysInMonth,
      dayOfMonth,
    });
  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ error: 'Failed to generate dashboard summary' });
  }
});

export default router;
