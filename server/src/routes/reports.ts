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

    // Hard monthly cut-offs: drop incomplete first/last periods for accurate analysis.
    // Current month is always incomplete (we're mid-month) — drop it.
    // First month may be incomplete if uploads don't start on day 1 — check min date.
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let filtered = allMonths.filter(m => m.month !== currentMonthKey);

    // Check if the first month with data has transactions from early in the month (day <= 5)
    if (filtered.length > 0) {
      const firstMonth = filtered[0].month;
      const minDateResult = db.prepare(
        `SELECT MIN(date) as minDate FROM transactions WHERE user_id = ? AND substr(date, 1, 7) = ?`
      ).get(userId, firstMonth) as any;
      if (minDateResult?.minDate) {
        const day = parseInt(minDateResult.minDate.substring(8, 10));
        // If first transaction is after day 10, the month is likely incomplete — drop it
        if (day > 10) {
          filtered = filtered.slice(1);
        }
      }
    }

    res.json(filtered);
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

    // Get Transfer and CC PMT categories (both excluded from income/expense totals)
    const transferCategory = db.prepare(
      `SELECT id FROM categories WHERE user_id = ? AND LOWER(name) = 'transfer'`
    ).get(userId) as any;
    const transferCategoryId = transferCategory?.id;

    const ccPmtCategory = db.prepare(
      `SELECT id FROM categories WHERE user_id = ? AND LOWER(name) = 'cc pmt'`
    ).get(userId) as any;
    const ccPmtCategoryId = ccPmtCategory?.id;

    // Core monthly numbers (excluding transfers and CC payments — CC PMT is a balance
    // transfer, not a new expense; the expense was already counted when the charge hit)
    const excludeIds = [transferCategoryId, ccPmtCategoryId].filter(Boolean);
    const buildExcludeClause = () => {
      if (excludeIds.length === 0) return 'AND 1=1';
      const placeholders = excludeIds.map(() => '?').join(', ');
      return `AND (category_id IS NULL OR category_id NOT IN (${placeholders}))`;
    };
    const excludeParams = [userId, monthStart, monthEnd, ...excludeIds];

    const incomeResult = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ? ${buildExcludeClause()}`
    ).get(...excludeParams) as any;

    const expenseResult = db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
       WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ? ${buildExcludeClause()}`
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

    // CC debt should be a positive number representing how much is owed.
    // Credit card balances are stored as negative values in the DB.
    const totalCCDebt = creditCards.reduce((sum, cc) => sum + Math.abs(cc.balance || 0), 0);

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

    // Top expense categories (excluding transfers and CC PMT)
    const topExpenseExcludeIds = [transferCategoryId, ccPmtCategoryId].filter(Boolean);
    const topExpenseExcludeClause = topExpenseExcludeIds.length > 0
      ? `AND c.id NOT IN (${topExpenseExcludeIds.map(() => '?').join(', ')})`
      : 'AND 1=1';
    const topExpenses = db.prepare(
      `SELECT c.id, c.name, c.icon, c.color,
              COALESCE(SUM(ABS(t.amount)), 0) as total,
              COUNT(t.id) as transaction_count
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date <= ?
             ${topExpenseExcludeClause}
       GROUP BY c.id
       ORDER BY total DESC
       LIMIT 10`
    ).all(userId, monthStart, monthEnd, ...topExpenseExcludeIds) as any[];

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

    // -----------------------------------------------------------------------
    // 6-Month Averages — find the 6 most recent COMPLETE months with data
    // (ignores the current partial month; if fewer than 6 months have data,
    //  use however many exist)
    // -----------------------------------------------------------------------
    // Step 1: Find distinct complete months with data (exclude current month)
    const currentYM = `${year}-${String(mon).padStart(2, '0')}`;
    const recentMonths = db.prepare(
      `SELECT DISTINCT substr(date, 1, 7) as ym FROM transactions
       WHERE user_id = ? AND substr(date, 1, 7) < ?
       ORDER BY ym DESC
       LIMIT 6`
    ).all(userId, currentYM) as { ym: string }[];

    const monthCount = Math.max(recentMonths.length, 1);

    // Step 2: Build date range from oldest to newest of those months
    let sixMonthStart = monthStart; // fallback
    let sixMonthEnd = monthEnd;     // fallback
    if (recentMonths.length > 0) {
      const oldestYM = recentMonths[recentMonths.length - 1].ym;
      sixMonthStart = oldestYM + '-01';
      const newestYM = recentMonths[0].ym;
      const [ny, nm] = newestYM.split('-').map(Number);
      const lastDay = new Date(ny, nm, 0).getDate();
      sixMonthEnd = `${newestYM}-${String(lastDay).padStart(2, '0')}`;
    }

    const sixMoExcludeParams = [userId, sixMonthStart, sixMonthEnd, ...excludeIds];

    const avgIncomeResult = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ? ${buildExcludeClause()}`
    ).get(...sixMoExcludeParams) as any;

    const avgExpenseResult = db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
       WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ? ${buildExcludeClause()}`
    ).get(...sixMoExcludeParams) as any;

    const avgMonthlyIncome = Math.round((avgIncomeResult.total / monthCount) * 100) / 100;
    const avgMonthlyExpenses = Math.round((avgExpenseResult.total / monthCount) * 100) / 100;
    const avgMonthlySavings = Math.round((avgMonthlyIncome - avgMonthlyExpenses) * 100) / 100;

    // -----------------------------------------------------------------------
    // Last completed month figures (for dashboard row income/expenses/savings)
    // -----------------------------------------------------------------------
    let lastMonthIncome = 0;
    let lastMonthExpenses = 0;
    let lastMonthLabel = '';
    if (recentMonths.length > 0) {
      const lastYM = recentMonths[0].ym;
      lastMonthLabel = lastYM;
      const [ly, lm] = lastYM.split('-').map(Number);
      const lmStart = lastYM + '-01';
      const lmLastDay = new Date(ly, lm, 0).getDate();
      const lmEnd = `${lastYM}-${String(lmLastDay).padStart(2, '0')}`;
      const lmExcludeParams = [userId, lmStart, lmEnd, ...excludeIds];

      const lmIncomeResult = db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
         WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ? ${buildExcludeClause()}`
      ).get(...lmExcludeParams) as any;
      const lmExpenseResult = db.prepare(
        `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
         WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ? ${buildExcludeClause()}`
      ).get(...lmExcludeParams) as any;

      lastMonthIncome = Math.round(lmIncomeResult.total * 100) / 100;
      lastMonthExpenses = Math.round(lmExpenseResult.total * 100) / 100;
    }
    const lastMonthSavings = Math.round((lastMonthIncome - lastMonthExpenses) * 100) / 100;

    // Top 10 expense categories (6-month average) excluding transfers/CC PMT
    const topExpense6MoExcludeIds = [transferCategoryId, ccPmtCategoryId].filter(Boolean);
    const topExpense6MoExcludeClause = topExpense6MoExcludeIds.length > 0
      ? `AND c.id NOT IN (${topExpense6MoExcludeIds.map(() => '?').join(', ')})`
      : 'AND 1=1';
    const topExpenses6Mo = db.prepare(
      `SELECT c.id, c.name, c.icon, c.color,
              COALESCE(SUM(ABS(t.amount)), 0) as total,
              COUNT(t.id) as transaction_count
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.amount < 0 AND t.date >= ? AND t.date <= ?
             ${topExpense6MoExcludeClause}
       GROUP BY c.id
       ORDER BY total DESC
       LIMIT 10`
    ).all(userId, sixMonthStart, sixMonthEnd, ...topExpense6MoExcludeIds) as any[];

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
      // 6-month averages
      avgMonthlyIncome,
      avgMonthlyExpenses,
      avgMonthlySavings,
      avgMonthCount: monthCount,
      // Last completed month
      lastMonthIncome,
      lastMonthExpenses,
      lastMonthSavings,
      lastMonthLabel,
      topExpenses6Mo: topExpenses6Mo.map((c: any) => ({
        name: c.name,
        icon: c.icon,
        color: c.color,
        totalAmount: Math.round(c.total * 100) / 100,
        avgAmount: Math.round((c.total / monthCount) * 100) / 100,
        count: c.transaction_count,
      })),
    });
  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ error: 'Failed to generate dashboard summary' });
  }
});

export default router;
