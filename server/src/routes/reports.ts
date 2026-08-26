import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import {
  ensureFlowClassification,
  getFlowDataNotes,
  liabilityOwed,
  SQL_SPEND_FLOWS,
  sqlIncome,
  sqlExpenses,
} from '../engine/flow.js';
import {
  getCoverage,
  completeMonthsFromCoverage,
  monthsWithDataFromCoverage,
  monthStartIso,
  monthEndIso,
} from '../engine/coverage.js';

const router = Router();

// Aggregation contract (see engine/flow.ts): income and expenses come from the
// persisted flow_type, never from the sign of the amount. Transfers between
// owned accounts, credit-card payments (debt_payment), and refunds are excluded
// from income; interest/fees are real expenses; refunds net against their
// category in rollups.

// GET /monthly?month=YYYY-MM-DD - monthly report
router.get('/monthly', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const month = (req.query.month as string) || new Date().toISOString().substring(0, 10);
    const monthStr = month.substring(0, 7) + '-01';

    const [year, mon] = monthStr.split('-').map(Number);
    const endOfMonth = new Date(year, mon, 0);
    const endDate = `${year}-${String(mon).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

    // Total income (flow-classified; transfers/debt payments/refunds excluded)
    const incomeResult = await db.get(`SELECT COALESCE(SUM(amount), 0) as total
         FROM transactions
         WHERE user_id = ? AND flow_type = 'income' AND date >= ? AND date <= ?`, userId, monthStr, endDate) as any;

    // Total expenses (real spending + interest/fees)
    const expenseResult = await db.get(`SELECT ${sqlExpenses()} as total
         FROM transactions
         WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND date >= ? AND date <= ?`, userId, monthStr, endDate) as any;

    const income = Math.round(incomeResult.total * 100) / 100;
    const expenses = Math.round(expenseResult.total * 100) / 100;
    const net = Math.round((income - expenses) * 100) / 100;
    const savingsRate = income > 0 ? Math.round(((income - expenses) / income) * 10000) / 100 : 0;

    // Top expense categories (refunds net against their category)
    const topCategories = await db.all(`SELECT c.id, COALESCE(c.name, 'Uncategorised') as name, COALESCE(c.icon, '❓') as icon, COALESCE(c.color, '#94A3B8') as color,
                ${sqlExpenses('t')} as total,
                COUNT(t.id) as transaction_count
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund') AND t.date >= ? AND t.date <= ?
         GROUP BY c.id, c.name, c.icon, c.color
         ORDER BY total DESC
         LIMIT 10`, userId, monthStr, endDate);

    // Transaction count
    const txCount = await db.get(`SELECT COUNT(*) as count FROM transactions
         WHERE user_id = ? AND date >= ? AND date <= ?`, userId, monthStr, endDate) as any;

    const dataNotes = await getFlowDataNotes(db, userId);

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
      data_notes: dataNotes,
    });
  } catch (error) {
    console.error('Monthly report error:', error);
    res.status(500).json({ error: 'Failed to generate monthly report' });
  }
});

// GET /annual?year=YYYY - annual report with monthly breakdown
router.get('/annual', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const year = (req.query.year as string) || String(new Date().getFullYear());
    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    // Monthly breakdown
    const monthlyData = (await db.all(`SELECT
           substr(date, 1, 7) as month,
           ${sqlIncome()} as income,
           ${sqlExpenses()} as expenses
         FROM transactions
         WHERE user_id = ? AND date >= ? AND date <= ?
         GROUP BY substr(date, 1, 7)
         ORDER BY month ASC`, userId, startDate, endDate))
      .map((row: any) => ({
        month: row.month,
        income: Math.round(row.income * 100) / 100,
        expenses: Math.round(row.expenses * 100) / 100,
        net: Math.round((row.income - row.expenses) * 100) / 100,
      }));

    // Annual totals
    const totalsResult = await db.get(`SELECT
           ${sqlIncome()} as total_income,
           ${sqlExpenses()} as total_expenses,
           COUNT(*) as transaction_count
         FROM transactions
         WHERE user_id = ? AND date >= ? AND date <= ?`, userId, startDate, endDate) as any;

    const totalIncome = Math.round((totalsResult.total_income || 0) * 100) / 100;
    const totalExpenses = Math.round((totalsResult.total_expenses || 0) * 100) / 100;
    const totalNet = Math.round((totalIncome - totalExpenses) * 100) / 100;

    // Monthly averages over COMPLETE months only (engine/coverage.ts): a
    // partial month is excluded from both numerator and denominator, a
    // zero-activity month inside the covered range counts as a real zero, and
    // a month outside coverage does not count. The old code divided the
    // year-to-date total by a flat 12, understating every average mid-year.
    const coverage = await getCoverage(userId);
    const completeYearMonths = new Set(
      monthsWithDataFromCoverage(coverage, `${year}-01`, `${year}-12`)
        .filter((m) => m.status === 'complete')
        .map((m) => m.month),
    );
    let completeIncome = 0;
    let completeExpenses = 0;
    for (const row of monthlyData) {
      if (completeYearMonths.has(row.month)) {
        completeIncome += row.income;
        completeExpenses += row.expenses;
      }
    }
    const completeMonthCount = Math.max(completeYearMonths.size, 1);
    const avgMonthlyIncome = Math.round((completeIncome / completeMonthCount) * 100) / 100;
    const avgMonthlyExpenses = Math.round((completeExpenses / completeMonthCount) * 100) / 100;

    // Top categories for the year (refunds net against their category)
    const topCategories = await db.all(`SELECT c.id, COALESCE(c.name, 'Uncategorised') as name, COALESCE(c.icon, '❓') as icon, COALESCE(c.color, '#94A3B8') as color,
                ${sqlExpenses('t')} as total,
                COUNT(t.id) as transaction_count
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund') AND t.date >= ? AND t.date <= ?
         GROUP BY c.id, c.name, c.icon, c.color
         ORDER BY total DESC
         LIMIT 10`, userId, startDate, endDate);

    const dataNotes = await getFlowDataNotes(db, userId);

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
      data_notes: dataNotes,
    });
  } catch (error) {
    console.error('Annual report error:', error);
    res.status(500).json({ error: 'Failed to generate annual report' });
  }
});

// GET /cashflow?period=6m|ytd - cash flow data (income vs expenses by month)
// Returns COMPLETE calendar months only, as decided by engine/coverage.ts:
// the current partial month is excluded, a zero-activity month inside the
// covered range appears as a real $0 row, and a month outside coverage (or
// only partially covered) is omitted rather than shown as a fake $0.
// `period=ytd` returns the complete months of the current calendar year.
router.get('/cashflow', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const period = (req.query.period as string) || '6m';

    const coverage = await getCoverage(userId);

    // Which complete months does this request want? (oldest first)
    let wantedMonths: string[];
    if (period === 'ytd') {
      const year = new Date().getFullYear();
      wantedMonths = monthsWithDataFromCoverage(coverage, `${year}-01`, `${year}-12`)
        .filter((m) => m.status === 'complete')
        .map((m) => m.month);
    } else {
      let months = 6;
      const match = period.match(/^(\d+)m$/);
      if (match) {
        months = parseInt(match[1]);
      }
      wantedMonths = completeMonthsFromCoverage(coverage, months).reverse();
    }

    if (wantedMonths.length === 0) {
      res.json([]);
      return;
    }

    const startStr = monthStartIso(wantedMonths[0]);
    const endStr = monthEndIso(wantedMonths[wantedMonths.length - 1]);

    // Income and expenses come from flow_type: transfers, debt payments and
    // refunds are excluded from both sides (no more keyword/category guessing).
    const flowRows = await db.all(`SELECT substr(date, 1, 7) as month,
         ${sqlIncome()} as income,
         ${sqlExpenses()} as expenses
       FROM transactions
       WHERE user_id = ? AND date >= ? AND date <= ?
       GROUP BY substr(date, 1, 7)`, userId, startStr, endStr) as any[];

    const monthMap = new Map<string, { income: number; expenses: number }>();
    for (const row of flowRows) {
      monthMap.set(row.month, { income: row.income || 0, expenses: row.expenses || 0 });
    }

    // One row per complete month; a covered month with no activity is $0.
    const allMonths = wantedMonths.map((monthKey) => {
      const existing = monthMap.get(monthKey);
      return {
        month: monthKey,
        income: existing ? Math.round(existing.income * 100) / 100 : 0,
        expenses: existing ? Math.round(existing.expenses * 100) / 100 : 0,
        net: existing ? Math.round((existing.income - existing.expenses) * 100) / 100 : 0,
      };
    });

    res.json(allMonths);
  } catch (error) {
    console.error('Cash flow error:', error);
    res.status(500).json({ error: 'Failed to generate cash flow report' });
  }
});

// GET /networth-history - return net_worth_snapshots
router.get('/networth-history', async (req: Request, res: Response) => {
  try {
    const snapshots = (await db.all('SELECT * FROM net_worth_snapshots WHERE user_id = ? ORDER BY date ASC', req.user!.id))
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
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const month = (req.query.month as string) || new Date().toISOString().substring(0, 7);
    const monthStart = month + '-01';
    const [year, mon] = month.split('-').map(Number);
    const endOfMonth = new Date(year, mon, 0);
    const monthEnd = `${year}-${String(mon).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

    // Income and expenses (flow-classified)
    const incomeResult = await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE user_id = ? AND flow_type = 'income' AND date >= ? AND date <= ?`, userId, monthStart, monthEnd) as any;

    const expenseResult = await db.get(`SELECT ${sqlExpenses()} as total FROM transactions WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND date >= ? AND date <= ?`, userId, monthStart, monthEnd) as any;

    const income = Math.round(incomeResult.total * 100) / 100;
    const expenses = Math.round(expenseResult.total * 100) / 100;

    // Category breakdown (expenses; refunds net against their category)
    const expenseCategories = await db.all(`
      SELECT c.id, COALESCE(c.name, 'Uncategorised') as name, COALESCE(c.icon, '❓') as icon, COALESCE(c.color, '#94A3B8') as color,
        ${sqlExpenses('t')} as total,
        COUNT(t.id) as count
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund') AND t.date >= ? AND t.date <= ?
      GROUP BY c.id, c.name, c.icon, c.color ORDER BY total DESC
    `, userId, monthStart, monthEnd) as any[];

    // Category breakdown (income)
    const incomeCategories = await db.all(`
      SELECT c.id, COALESCE(c.name, 'Uncategorised') as name, COALESCE(c.icon, '❓') as icon, COALESCE(c.color, '#94A3B8') as color,
        COALESCE(SUM(t.amount), 0) as total,
        COUNT(t.id) as count
      FROM transactions t
      LEFT JOIN categories c ON t.category_id = c.id
      WHERE t.user_id = ? AND t.flow_type = 'income' AND t.date >= ? AND t.date <= ?
      GROUP BY c.id, c.name, c.icon, c.color ORDER BY total DESC
    `, userId, monthStart, monthEnd) as any[];

    // Account balances
    const accounts = await db.all('SELECT id, name, type, institution, balance, icon FROM accounts WHERE user_id = ? AND is_hidden = 0 ORDER BY type, name', userId) as any[];

    // Goals progress
    const goals = await db.all('SELECT id, name, target_amount, current_amount, target_date, icon, color FROM goals WHERE user_id = ? AND is_completed = 0', userId) as any[];

    // Budget performance (spent = real spending net of refunds)
    const budgets = await db.all(`
      SELECT b.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
        (SELECT ${sqlExpenses('t')} FROM transactions t
         WHERE t.user_id = ? AND t.category_id = b.category_id AND t.flow_type IN ('expense', 'interest_fee', 'refund')
         AND t.date >= ? AND t.date < date(?, '+1 month')) as spent
      FROM budgets b
      LEFT JOIN categories c ON b.category_id = c.id
      WHERE b.user_id = ? AND b.month = ?
    `, userId, monthStart, monthStart, userId, monthStart) as any[];

    // Daily spending trend for this month
    const dailySpending = await db.all(`
      SELECT date,
        ${sqlIncome()} as income,
        ${sqlExpenses()} as expenses
      FROM transactions
      WHERE user_id = ? AND date >= ? AND date <= ?
      GROUP BY date ORDER BY date ASC
    `, userId, monthStart, monthEnd) as any[];

    // Last 6 months trend
    const sixMonthsAgo = new Date(year, mon - 7, 1);
    const trendStart = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, '0')}-01`;
    const monthlyTrend = await db.all(`
      SELECT substr(date, 1, 7) as month,
        ${sqlIncome()} as income,
        ${sqlExpenses()} as expenses
      FROM transactions
      WHERE user_id = ? AND date >= ? AND date <= ?
      GROUP BY substr(date, 1, 7)
      ORDER BY month ASC
    `, userId, trendStart, monthEnd) as any[];

    // Top merchants (real spending only)
    const topMerchants = await db.all(`
      SELECT name, COUNT(*) as count, SUM(ABS(amount)) as total
      FROM transactions
      WHERE user_id = ? AND flow_type IN ('expense', 'interest_fee') AND date >= ? AND date <= ?
      GROUP BY LOWER(TRIM(name))
      ORDER BY total DESC LIMIT 10
    `, userId, monthStart, monthEnd) as any[];

    // Transaction count
    const txCount = (await db.get('SELECT COUNT(*) as count FROM transactions WHERE user_id = ? AND date >= ? AND date <= ?', userId, monthStart, monthEnd) as any).count;

    const dataNotes = await getFlowDataNotes(db, userId);

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
      data_notes: dataNotes,
    });
  } catch (error) {
    console.error('Summary report error:', error);
    res.status(500).json({ error: 'Failed to generate summary report' });
  }
});

// GET /dashboard-summary - comprehensive data for improved dashboard
router.get('/dashboard-summary', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const month = (req.query.month as string) || new Date().toISOString().substring(0, 7);
    const monthStart = month + '-01';
    const [year, mon] = month.split('-').map(Number);
    const endOfMonth = new Date(year, mon, 0);
    const monthEnd = `${year}-${String(mon).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

    // Income: flow-classified. Card payments arriving on a card (debt_payment),
    // internal transfers, and refunds are never income.
    const incomeResult = await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE user_id = ? AND flow_type = 'income' AND date >= ? AND date <= ?`, userId, monthStart, monthEnd) as any;

    // Expenses: real spending + interest/fees. The funding leg of a card
    // payment is a transfer (its purchases are already counted on the card).
    const expenseResult = await db.get(`SELECT ${sqlExpenses()} as total FROM transactions
       WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND date >= ? AND date <= ?`, userId, monthStart, monthEnd) as any;

    const income = Math.round(incomeResult.total * 100) / 100;
    const expenses = Math.round(expenseResult.total * 100) / 100;
    const net = Math.round((income - expenses) * 100) / 100;
    const savingsRate = income > 0 ? Math.round(((income - expenses) / income) * 10000) / 100 : 0;

    // Overspending alert
    const isOverspending = expenses > income;
    const overspendAmount = isOverspending ? Math.round((expenses - income) * 100) / 100 : 0;

    // Credit cards (accounts where type = 'credit')
    const creditCards = await db.all(`SELECT id, name, balance, institution, icon FROM accounts
       WHERE user_id = ? AND type = 'credit' AND is_hidden = 0
       ORDER BY name`, userId) as any[];

    // CC debt should be a positive number representing how much is owed.
    // Credit card balances are stored as negative values in the DB; an
    // overpaid card (credit balance) owes 0 — never abs() (audit D7).
    const totalCCDebt = creditCards.reduce((sum, cc) => sum + liabilityOwed('credit', cc.balance || 0), 0);

    // CC spending this month (real purchases charged to CC accounts)
    const ccSpendingResult = await db.get(`SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
       WHERE user_id = ? AND account_id IN (
         SELECT id FROM accounts WHERE user_id = ? AND type = 'credit'
       ) AND flow_type IN ('expense', 'interest_fee') AND date >= ? AND date <= ?`, userId, userId, monthStart, monthEnd) as any;
    const ccSpendingThisMonth = Math.round(ccSpendingResult.total * 100) / 100;

    // CC interest/fees (flow-classified, no name guessing)
    const ccInterestFeesResult = await db.get(`SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
       WHERE user_id = ? AND account_id IN (
         SELECT id FROM accounts WHERE user_id = ? AND type = 'credit'
       ) AND flow_type = 'interest_fee' AND date >= ? AND date <= ?`, userId, userId, monthStart, monthEnd) as any;
    const ccInterestFees = Math.round(ccInterestFeesResult.total * 100) / 100;

    // Transfers in/out (flow-classified internal moves)
    const transfersInResult = await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE user_id = ? AND flow_type = 'transfer' AND amount > 0 AND date >= ? AND date <= ?`, userId, monthStart, monthEnd) as any;

    const transfersOutResult = await db.get(`SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
       WHERE user_id = ? AND flow_type = 'transfer' AND amount < 0 AND date >= ? AND date <= ?`, userId, monthStart, monthEnd) as any;
    const transfersIn = Math.round(transfersInResult.total * 100) / 100;
    const transfersOut = Math.round(transfersOutResult.total * 100) / 100;

    // Cash accounts (checking, savings, etc.)
    const cashAccounts = await db.all(`SELECT id, name, balance, type FROM accounts
       WHERE user_id = ? AND type IN ('checking', 'savings') AND is_hidden = 0
       ORDER BY name`, userId) as any[];

    const totalCash = cashAccounts.reduce((sum, acc) => sum + (acc.balance || 0), 0);

    // Top expense categories (refunds net against their category)
    const topExpenses = await db.all(`SELECT c.id, COALESCE(c.name, 'Uncategorised') as name, COALESCE(c.icon, '❓') as icon, COALESCE(c.color, '#94A3B8') as color,
              ${sqlExpenses('t')} as total,
              COUNT(t.id) as transaction_count
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund') AND t.date >= ? AND t.date <= ?
             AND COALESCE(c.is_income, 0) = 0
       GROUP BY c.id, c.name, c.icon, c.color
       ORDER BY CASE WHEN LOWER(c.name) = 'uncategorized' THEN 1 ELSE 0 END ASC, total DESC
       LIMIT 10`, userId, monthStart, monthEnd) as any[];

    // Top income categories (this month)
    const topIncome = await db.all(`SELECT c.id, COALESCE(c.name, 'Uncategorised') as name, COALESCE(c.icon, '❓') as icon, COALESCE(c.color, '#94A3B8') as color,
              COALESCE(SUM(t.amount), 0) as total,
              COUNT(t.id) as transaction_count
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type = 'income' AND t.date >= ? AND t.date <= ?
       GROUP BY c.id, c.name, c.icon, c.color
       ORDER BY total DESC
       LIMIT 10`, userId, monthStart, monthEnd) as any[];

    // Uncategorized transactions
    const uncategorizedResult = await db.get(`SELECT COUNT(*) as count, COALESCE(SUM(ABS(amount)), 0) as total
       FROM transactions
       WHERE user_id = ? AND date >= ? AND date <= ?
             AND (category_id IS NULL OR category_id IN (
               SELECT id FROM categories WHERE user_id = ? AND LOWER(name) LIKE '%uncategorized%'
             ))`, userId, monthStart, monthEnd, userId) as any;

    const uncategorizedCount = uncategorizedResult.count || 0;
    const uncategorizedTotal = Math.round(uncategorizedResult.total * 100) / 100;

    // Investment portfolio value
    const investments = await db.all(`SELECT shares, current_price FROM investments WHERE user_id = ?`, userId) as any[];

    const investmentPortfolioValue = investments.reduce(
      (sum: number, inv: any) => sum + (inv.shares * inv.current_price), 0
    );

    // Day of month info
    const today = new Date();
    const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const daysInMonth = endOfMonth.getDate();
    const dayOfMonth = month === currentMonth ? today.getDate() : daysInMonth;

    // -----------------------------------------------------------------------
    // 6-Month Averages — the 6 most recent COMPLETE months, decided solely by
    // engine/coverage.ts. The current partial month is excluded, a zero-
    // activity month inside the covered range counts as a real $0, a month
    // outside (or only partially inside) coverage is excluded from both the
    // numerator and the denominator. If fewer than 6 complete months exist,
    // divide by however many do.
    // -----------------------------------------------------------------------
    const coverage = await getCoverage(userId);
    const recentMonths = completeMonthsFromCoverage(coverage, 6); // newest first
    const monthCount = Math.max(recentMonths.length, 1);
    const monthPlaceholders = recentMonths.map(() => '?').join(', ');

    // Displayed window bounds (oldest complete month .. newest complete month)
    let sixMonthStart = monthStart; // fallback
    let sixMonthEnd = monthEnd;     // fallback
    if (recentMonths.length > 0) {
      sixMonthStart = monthStartIso(recentMonths[recentMonths.length - 1]);
      sixMonthEnd = monthEndIso(recentMonths[0]);
    }

    // 6-month income and expenses (flow-classified, complete months only —
    // a partially covered month between complete ones must not leak in, so
    // filter by month key rather than a plain date range)
    let avgIncomeTotal = 0;
    let avgExpenseTotal = 0;
    if (recentMonths.length > 0) {
      const avgIncomeResult = await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions
         WHERE user_id = ? AND flow_type = 'income' AND substr(date, 1, 7) IN (${monthPlaceholders})`, userId, ...recentMonths) as any;

      const avgExpenseResult = await db.get(`SELECT ${sqlExpenses()} as total FROM transactions
         WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND substr(date, 1, 7) IN (${monthPlaceholders})`, userId, ...recentMonths) as any;
      avgIncomeTotal = avgIncomeResult.total;
      avgExpenseTotal = avgExpenseResult.total;
    }

    const avgMonthlyIncome = Math.round((avgIncomeTotal / monthCount) * 100) / 100;
    const avgMonthlyExpenses = Math.round((avgExpenseTotal / monthCount) * 100) / 100;
    const avgMonthlySavings = Math.round((avgMonthlyIncome - avgMonthlyExpenses) * 100) / 100;

    // -----------------------------------------------------------------------
    // Last completed month figures (for dashboard row income/expenses/savings)
    // -----------------------------------------------------------------------
    let lastMonthIncome = 0;
    let lastMonthExpenses = 0;
    let lastMonthLabel = '';
    if (recentMonths.length > 0) {
      const lastYM = recentMonths[0];
      lastMonthLabel = lastYM;
      const lmStart = monthStartIso(lastYM);
      const lmEnd = monthEndIso(lastYM);
      const lmIncomeResult = await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions
         WHERE user_id = ? AND flow_type = 'income' AND date >= ? AND date <= ?`, userId, lmStart, lmEnd) as any;

      const lmExpenseResult = await db.get(`SELECT ${sqlExpenses()} as total FROM transactions
         WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND date >= ? AND date <= ?`, userId, lmStart, lmEnd) as any;

      lastMonthIncome = Math.round(lmIncomeResult.total * 100) / 100;
      lastMonthExpenses = Math.round(lmExpenseResult.total * 100) / 100;
    }
    const lastMonthSavings = Math.round((lastMonthIncome - lastMonthExpenses) * 100) / 100;

    // Top 10 expense categories (complete months only; refunds net against their category)
    const topExpenses6Mo = recentMonths.length === 0 ? [] : await db.all(`SELECT c.id, COALESCE(c.name, 'Uncategorised') as name, COALESCE(c.icon, '❓') as icon, COALESCE(c.color, '#94A3B8') as color,
              ${sqlExpenses('t')} as total,
              COUNT(t.id) as transaction_count
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund') AND substr(t.date, 1, 7) IN (${monthPlaceholders})
             AND COALESCE(c.is_income, 0) = 0
       GROUP BY c.id, c.name, c.icon, c.color
       ORDER BY CASE WHEN LOWER(c.name) = 'uncategorized' THEN 1 ELSE 0 END ASC, total DESC
       LIMIT 10`, userId, ...recentMonths) as any[];

    // Top income categories (complete months only)
    const topIncome6Mo = recentMonths.length === 0 ? [] : await db.all(`SELECT c.id, COALESCE(c.name, 'Uncategorised') as name, COALESCE(c.icon, '❓') as icon, COALESCE(c.color, '#94A3B8') as color,
              COALESCE(SUM(t.amount), 0) as total,
              COUNT(t.id) as transaction_count
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type = 'income' AND substr(t.date, 1, 7) IN (${monthPlaceholders})
       GROUP BY c.id, c.name, c.icon, c.color
       ORDER BY total DESC
       LIMIT 10`, userId, ...recentMonths) as any[];

    // Per-category denominators: a category's average divides by the number of
    // complete window months in which that category has coverage — i.e. the
    // complete months on/after the category's first-ever transaction — not by
    // "months in which it happened to have a transaction" (which turned an
    // annual bill into a fake monthly cost) and not by the global month count
    // (which diluted categories that only came into existence mid-window).
    const categoryFirstMonths = await db.all(`SELECT category_id, MIN(substr(date, 1, 7)) as first_ym
       FROM transactions
       WHERE user_id = ? AND category_id IS NOT NULL
       GROUP BY category_id`, userId) as Array<{ category_id: string; first_ym: string }>;
    const firstYmByCategory = new Map(categoryFirstMonths.map((r) => [r.category_id, r.first_ym]));
    const categoryMonthCount = (categoryId: string): number => {
      const firstYm = firstYmByCategory.get(categoryId);
      if (!firstYm) return monthCount;
      const covered = recentMonths.filter((ym) => ym >= firstYm).length;
      return Math.max(covered, 1);
    };

    // Reclassification transparency for the UI ("reclassified N rows")
    const dataNotes = await getFlowDataNotes(db, userId);

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
      topIncome: topIncome.map((c: any) => ({
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
      sixMonthStart,
      sixMonthEnd,
      topExpenses6Mo: topExpenses6Mo.map((c: any) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        color: c.color,
        totalAmount: Math.round(c.total * 100) / 100,
        avgAmount: Math.round((c.total / categoryMonthCount(c.id)) * 100) / 100,
        count: c.transaction_count,
      })),
      topIncome6Mo: topIncome6Mo.map((c: any) => ({
        id: c.id,
        name: c.name,
        icon: c.icon,
        color: c.color,
        totalAmount: Math.round(c.total * 100) / 100,
        avgAmount: Math.round((c.total / categoryMonthCount(c.id)) * 100) / 100,
        count: c.transaction_count,
      })),
      data_notes: dataNotes,
    });
  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({ error: 'Failed to generate dashboard summary' });
  }
});

// NOTE: `/debug-income` was removed (audit finding L6) — a debug endpoint
// dumping raw transaction rows should not exist in a production build.

export default router;
