import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import {
  ensureFlowClassification,
  getFlowDataNotes,
  liabilityOwed,
  SQL_SPEND_FLOWS,
  sqlIncome,
  sqlExpenses,
  sqlRefunds,
} from '../engine/flow.js';
import {
  getCoverage,
  completeMonthsFromCoverage,
  monthsWithDataFromCoverage,
  monthStartIso,
  monthEndIso,
} from '../engine/coverage.js';
import { merchantStem } from '../engine/categorizer.js';

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
    // The client sends a full YYYY-MM-DD; older callers send YYYY-MM. Take the
    // first seven characters either way, so appending '-01' cannot produce
    // '2026-07-01-01' — which Postgres rejects as an invalid date, 500ing the
    // whole endpoint.
    const monthKey = String(month).slice(0, 7);
    const monthStart = monthKey + '-01';
    const [year, mon] = monthKey.split('-').map(Number);
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
      SELECT MIN(name) as name, COUNT(*) as count, ${sqlExpenses()} as total
      FROM transactions
      WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND date >= ? AND date <= ?
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
    // The client sends a full YYYY-MM-DD; older callers send YYYY-MM. Take the
    // first seven characters either way, so appending '-01' cannot produce
    // '2026-07-01-01' — which Postgres rejects as an invalid date, 500ing the
    // whole endpoint.
    const monthKey = String(month).slice(0, 7);
    const monthStart = monthKey + '-01';
    const [year, mon] = monthKey.split('-').map(Number);
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

// ---------------------------------------------------------------------------
// GET /statement - the printable Category Statement
//
// Section 1: totals by category, split into income / expenses / the internal
//            moves that belong to neither.
// Section 2: every transaction in the period, grouped under those same
//            categories, with subtotals that tie back to section 1 by
//            construction — both come from the same flow.ts helpers.
//
// Everything is period-scoped and account-scoped. Coverage is reported so the
// printed page can say when a month inside the range is only partly loaded,
// rather than presenting a half-month as a whole one.
// ---------------------------------------------------------------------------
router.get('/statement', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);

    const start = String(req.query.start || '');
    const end = String(req.query.end || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      res.status(400).json({ error: 'start and end are required as YYYY-MM-DD' });
      return;
    }
    if (start > end) {
      res.status(400).json({ error: 'start must not be after end' });
      return;
    }
    const label = String(req.query.label || '');

    // Account scope. An empty/absent list means every visible account.
    const requested = String(req.query.accounts || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const visible = await db.all(
      'SELECT id, name, type FROM accounts WHERE user_id = ? AND is_hidden = 0 ORDER BY name ASC',
      userId,
    ) as Array<{ id: string; name: string; type: string }>;
    const scopeIds = requested.length
      ? visible.filter((a) => requested.includes(a.id)).map((a) => a.id)
      : visible.map((a) => a.id);
    if (scopeIds.length === 0) {
      res.status(400).json({ error: 'No visible accounts match the requested scope' });
      return;
    }
    const acctPlaceholders = scopeIds.map(() => '?').join(', ');
    const scopeSql = `AND t.account_id IN (${acctPlaceholders})`;
    const scopeNames = visible.filter((a) => scopeIds.includes(a.id)).map((a) => a.name);
    const allAccounts = scopeIds.length === visible.length;

    // ---- coverage -------------------------------------------------------
    const coverage = await getCoverage(userId);
    const monthsInRange = monthsWithDataFromCoverage(coverage, start.slice(0, 7), end.slice(0, 7));
    const completeMonths = monthsInRange.filter((m) => m.status === 'complete').map((m) => m.month);
    const partialMonths = monthsInRange.filter((m) => m.status === 'partial').map((m) => m.month);
    // A monthly average needs at least two complete months to mean anything.
    const showMonthlyAvg = completeMonths.length >= 2;
    const cmPlaceholders = completeMonths.map(() => '?').join(', ');

    const round = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

    // ---- prior period ---------------------------------------------------
    // Same length, immediately before. Suppressed entirely when the prior
    // window is not fully covered — comparing against a hole is worse than
    // showing no comparison at all.
    const dayMs = 86400000;
    const spanDays = Math.round((Date.parse(end) - Date.parse(start)) / dayMs) + 1;
    const priorEnd = new Date(Date.parse(start) - dayMs).toISOString().slice(0, 10);
    const priorStart = new Date(Date.parse(start) - spanDays * dayMs).toISOString().slice(0, 10);
    const priorMonths = monthsWithDataFromCoverage(coverage, priorStart.slice(0, 7), priorEnd.slice(0, 7));
    const priorFullyCovered =
      priorMonths.length > 0 && priorMonths.every((m) => m.status === 'complete');

    // ---- band totals ----------------------------------------------------
    const totals = await db.get(
      `SELECT ${sqlIncome('t')} as "income",
              ${sqlExpenses('t')} as "expenses",
              ${sqlRefunds('t')} as "refunds",
              COALESCE(SUM(CASE WHEN t.flow_type = 'transfer' AND t.amount > 0 THEN t.amount ELSE 0 END), 0) as "movedIn",
              COALESCE(SUM(CASE WHEN t.flow_type = 'transfer' AND t.amount < 0 THEN -t.amount ELSE 0 END), 0) as "movedOut",
              COALESCE(SUM(CASE WHEN t.flow_type = 'debt_payment' THEN ABS(t.amount) ELSE 0 END), 0) as "debtPayments",
              COUNT(*) as "rowCount"
       FROM transactions t
       WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? ${scopeSql}`,
      userId, start, end, ...scopeIds,
    ) as any;

    const income = round(totals.income);
    const expenses = round(totals.expenses);

    // ---- category rollups ----------------------------------------------
    // LEFT JOIN + COALESCE so rows with no category are a visible line rather
    // than silently dropped: the parts must always sum to the whole.
    const UNCAT_LAST = `CASE WHEN c.id IS NULL OR LOWER(c.name) LIKE '%uncategor%' THEN 1 ELSE 0 END`;

    const expenseRows = await db.all(
      `SELECT c.id as "categoryId",
              COALESCE(c.name, 'Uncategorised') as name,
              COALESCE(c.icon, '❓') as icon,
              ${sqlExpenses('t')} as total,
              COUNT(t.id) as "txnCount"
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund')
         AND t.date >= ? AND t.date <= ? ${scopeSql}
       GROUP BY c.id, c.name, c.icon
       ORDER BY ${UNCAT_LAST} ASC, total DESC`,
      userId, start, end, ...scopeIds,
    ) as any[];

    const incomeRows = await db.all(
      `SELECT c.id as "categoryId",
              COALESCE(c.name, 'Uncategorised') as name,
              COALESCE(c.icon, '❓') as icon,
              COALESCE(SUM(t.amount), 0) as total,
              COUNT(t.id) as "txnCount"
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type = 'income'
         AND t.date >= ? AND t.date <= ? ${scopeSql}
       GROUP BY c.id, c.name, c.icon
       ORDER BY ${UNCAT_LAST} ASC, total DESC`,
      userId, start, end, ...scopeIds,
    ) as any[];

    // Internal moves, by category and direction.
    const moveRows = await db.all(
      `SELECT COALESCE(c.name, 'Unlabelled') as name,
              COALESCE(c.icon, '🔄') as icon,
              CASE WHEN t.amount > 0 THEN 'in' ELSE 'out' END as direction,
              COALESCE(SUM(ABS(t.amount)), 0) as total,
              COUNT(t.id) as "txnCount"
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type IN ('transfer', 'debt_payment')
         AND t.date >= ? AND t.date <= ? ${scopeSql}
       GROUP BY c.name, c.icon, CASE WHEN t.amount > 0 THEN 'in' ELSE 'out' END
       ORDER BY total DESC`,
      userId, start, end, ...scopeIds,
    ) as any[];

    // ---- per-category monthly averages (complete months only) -----------
    const avgByCategory = new Map<string, number>();
    if (showMonthlyAvg) {
      const avgRows = await db.all(
        `SELECT c.id as "categoryId", ${sqlExpenses('t')} as total
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund')
           AND substr(t.date, 1, 7) IN (${cmPlaceholders}) ${scopeSql}
         GROUP BY c.id`,
        userId, ...completeMonths, ...scopeIds,
      ) as any[];
      for (const r of avgRows) {
        avgByCategory.set(r.categoryId ?? '__none__', round(r.total) / completeMonths.length);
      }
      const avgIncomeRows = await db.all(
        `SELECT c.id as "categoryId", COALESCE(SUM(t.amount), 0) as total
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.flow_type = 'income'
           AND substr(t.date, 1, 7) IN (${cmPlaceholders}) ${scopeSql}
         GROUP BY c.id`,
        userId, ...completeMonths, ...scopeIds,
      ) as any[];
      for (const r of avgIncomeRows) {
        avgByCategory.set('inc:' + (r.categoryId ?? '__none__'), round(r.total) / completeMonths.length);
      }
    }

    // ---- prior-period per-category totals -------------------------------
    const priorByCategory = new Map<string, number>();
    if (priorFullyCovered) {
      const priorExpense = await db.all(
        `SELECT c.id as "categoryId", ${sqlExpenses('t')} as total
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund')
           AND t.date >= ? AND t.date <= ? ${scopeSql}
         GROUP BY c.id`,
        userId, priorStart, priorEnd, ...scopeIds,
      ) as any[];
      for (const r of priorExpense) priorByCategory.set(r.categoryId ?? '__none__', round(r.total));
      const priorIncome = await db.all(
        `SELECT c.id as "categoryId", COALESCE(SUM(t.amount), 0) as total
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.flow_type = 'income'
           AND t.date >= ? AND t.date <= ? ${scopeSql}
         GROUP BY c.id`,
        userId, priorStart, priorEnd, ...scopeIds,
      ) as any[];
      for (const r of priorIncome) priorByCategory.set('inc:' + (r.categoryId ?? '__none__'), round(r.total));
    }

    // ---- budgets (single calendar month only) ---------------------------
    // A monthly budget cannot be meaningfully multiplied across a quarter —
    // rollover makes that arithmetic wrong — so the column only appears when
    // the period IS one whole calendar month.
    const isWholeMonth =
      start.slice(0, 7) === end.slice(0, 7) &&
      start.endsWith('-01') &&
      end === monthEndIso(start.slice(0, 7));
    const budgetByCategory = new Map<string, number>();
    if (isWholeMonth) {
      const budgetRows = await db.all(
        `SELECT category_id as "categoryId", amount FROM budgets WHERE user_id = ? AND month = ?`,
        userId, start,
      ) as any[];
      for (const b of budgetRows) budgetByCategory.set(b.categoryId, round(b.amount));
    }
    // A column of em-dashes does not earn its place on paper.
    const showBudgets = isWholeMonth && budgetByCategory.size > 0;

    const decorate = (rows: any[], band: 'income' | 'expense') => {
      const bandTotal = band === 'income' ? income : expenses;
      const prefix = band === 'income' ? 'inc:' : '';
      return rows.map((r) => {
        const key = prefix + (r.categoryId ?? '__none__');
        const total = round(r.total);
        const prior = priorByCategory.has(key) ? priorByCategory.get(key)! : null;
        return {
          categoryId: r.categoryId,
          name: r.name,
          icon: r.icon,
          total,
          txnCount: Number(r.txnCount) || 0,
          pctOfBand: bandTotal !== 0 ? Math.round((total / bandTotal) * 1000) / 10 : 0,
          monthlyAvg: showMonthlyAvg ? round(avgByCategory.get(key) ?? 0) : null,
          priorTotal: prior,
          change: prior === null ? null : round(total - prior),
          budget: budgetByCategory.has(r.categoryId) ? budgetByCategory.get(r.categoryId)! : null,
        };
      });
    };

    const expenseCategories = decorate(expenseRows, 'expense');
    const incomeCategories = decorate(incomeRows, 'income');

    // Reconciliation tripwire: the rows MUST sum to the headline. If they ever
    // stop doing so the two came from different definitions, which is the exact
    // class of bug this report exists to make impossible.
    const expenseCheck = round(expenseCategories.reduce((s, r) => s + r.total, 0));
    const incomeCheck = round(incomeCategories.reduce((s, r) => s + r.total, 0));
    if (Math.abs(expenseCheck - expenses) > 0.01 || Math.abs(incomeCheck - income) > 0.01) {
      console.error(
        `Statement reconciliation failed for user ${userId}: ` +
        `expenses ${expenses} vs rows ${expenseCheck}; income ${income} vs rows ${incomeCheck}`,
      );
    }

    // ---- section 2: every transaction -----------------------------------
    const transactions = (await db.all(
      `SELECT t.id, t.date, t.name, t.notes, t.amount, t.flow_type as "flowType",
              t.is_pending as "isPending", t.category_id as "categoryId",
              COALESCE(c.name, 'Uncategorised') as "categoryName",
              a.name as "accountName"
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       JOIN accounts a ON t.account_id = a.id
       WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? ${scopeSql}
       ORDER BY t.date ASC, t.created_at ASC, t.id ASC`,
      userId, start, end, ...scopeIds,
    ) as any[]).map((t) => ({ ...t, amount: round(t.amount), isPending: !!t.isPending }));

    const dataNotes = await getFlowDataNotes(db, userId);

    res.json({
      period: { start, end, label: label || `${start} to ${end}` },
      scope: { allAccounts, accountNames: scopeNames, accountIds: scopeIds },
      coverage: {
        completeMonths,
        partialMonths,
        completeMonthCount: completeMonths.length,
        showMonthlyAvg,
      },
      prior: priorFullyCovered ? { start: priorStart, end: priorEnd } : null,
      showBudgets,
      totals: {
        income,
        expenses,
        net: round(income - expenses),
        refunds: round(totals.refunds),
        movedIn: round(totals.movedIn),
        movedOut: round(totals.movedOut),
        debtPayments: round(totals.debtPayments),
        rowCount: Number(totals.rowCount) || 0,
      },
      incomeCategories,
      expenseCategories,
      moves: moveRows.map((r) => ({
        name: r.name, icon: r.icon, direction: r.direction,
        total: round(r.total), txnCount: Number(r.txnCount) || 0,
      })),
      transactions,
      data_notes: dataNotes,
    });
  } catch (error) {
    console.error('Statement report error:', error);
    res.status(500).json({ error: 'Failed to generate statement' });
  }
});

// ---------------------------------------------------------------------------
// Shared period/scope resolution for the printable reports.
// ---------------------------------------------------------------------------
interface ReportScope {
  start: string;
  end: string;
  label: string;
  scopeIds: string[];
  scopeSql: string;
  scopeNames: string[];
  allAccounts: boolean;
  months: string[];            // every month in range that has data, oldest first
  completeMonths: string[];
  partialMonths: string[];
}

async function resolveScope(req: Request, userId: string): Promise<ReportScope | { error: string }> {
  const start = String(req.query.start || '');
  const end = String(req.query.end || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { error: 'start and end are required as YYYY-MM-DD' };
  }
  if (start > end) return { error: 'start must not be after end' };

  const requested = String(req.query.accounts || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const visible = await db.all(
    'SELECT id, name FROM accounts WHERE user_id = ? AND is_hidden = 0 ORDER BY name ASC',
    userId,
  ) as Array<{ id: string; name: string }>;
  const scopeIds = requested.length
    ? visible.filter((a) => requested.includes(a.id)).map((a) => a.id)
    : visible.map((a) => a.id);
  if (scopeIds.length === 0) return { error: 'No visible accounts match the requested scope' };

  const coverage = await getCoverage(userId);
  const inRange = monthsWithDataFromCoverage(coverage, start.slice(0, 7), end.slice(0, 7));

  return {
    start, end,
    label: String(req.query.label || `${start} to ${end}`),
    scopeIds,
    scopeSql: `AND t.account_id IN (${scopeIds.map(() => '?').join(', ')})`,
    scopeNames: visible.filter((a) => scopeIds.includes(a.id)).map((a) => a.name),
    allAccounts: scopeIds.length === visible.length,
    months: inRange.map((m) => m.month),
    completeMonths: inRange.filter((m) => m.status === 'complete').map((m) => m.month),
    partialMonths: inRange.filter((m) => m.status === 'partial').map((m) => m.month),
  };
}

const r2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;

// ---------------------------------------------------------------------------
// GET /funding - Cash Flow & Deficit Funding
//
// A sources-and-uses statement. Month by month: what the household actually
// earned and spent, and — when that came out negative — where the money to
// cover it came from. The app's own history says the honest answer is asset
// sales, loan drawdowns and brokerage withdrawals, none of which are income,
// and all of which are finite. A deficit funded from savings looks identical
// to a balanced month on a bank statement; this report is what makes the
// difference visible.
// ---------------------------------------------------------------------------
router.get('/funding', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const scope = await resolveScope(req, userId);
    if ('error' in scope) { res.status(400).json({ error: scope.error }); return; }
    const { start, end, scopeIds, scopeSql } = scope;

    // Operating result per month.
    const opRows = await db.all(
      `SELECT substr(t.date, 1, 7) as month,
              ${sqlIncome('t')} as income,
              ${sqlExpenses('t')} as expenses
       FROM transactions t
       WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? ${scopeSql}
       GROUP BY substr(t.date, 1, 7)`,
      userId, start, end, ...scopeIds,
    ) as any[];

    // Inflows that are NOT income, by what kind of thing they are. The category
    // is the evidence: Asset Sale, Loan Proceeds and Asset Transfer are the
    // three owner-confirmed ways money arrives without being earned.
    //
    // PAIRED transfers are excluded. A transfer with a counterpart leg inside
    // the same account set is money sliding around inside the perimeter — the
    // savings sweep, moving cash from one checking account to the other — and
    // its outflow leg is already sitting in the same report. Counting the
    // inflow as "funding" made $190,096 of internal circulation look like
    // $190,096 of rescue money, which is exactly the kind of number that makes
    // a deficit look survivable when it isn't.
    const fundRows = await db.all(
      `SELECT substr(t.date, 1, 7) as month,
              LOWER(COALESCE(c.name, 'other')) as kind,
              COALESCE(SUM(t.amount), 0) as total,
              COUNT(t.id) as "txnCount"
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type = 'transfer' AND t.amount > 0
         AND t.transfer_pair_id IS NULL
         AND t.date >= ? AND t.date <= ? ${scopeSql}
       GROUP BY substr(t.date, 1, 7), LOWER(COALESCE(c.name, 'other'))`,
      userId, start, end, ...scopeIds,
    ) as any[];

    // Reported as a memo line, not as funding: how much simply circulated.
    const circulation = await db.get(
      `SELECT COALESCE(SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END), 0) as "in",
              COALESCE(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 0) as "out",
              COUNT(*) as "txnCount"
       FROM transactions t
       WHERE t.user_id = ? AND t.flow_type = 'transfer'
         AND t.transfer_pair_id IS NOT NULL
         AND t.date >= ? AND t.date <= ? ${scopeSql}`,
      userId, start, end, ...scopeIds,
    ) as any;

    const FUNDING_LABELS: Record<string, string> = {
      'asset sale': 'Asset sales',
      'loan proceeds': 'Borrowing',
      'asset transfer': 'Drawn from savings & investments',
    };
    const labelFor = (kind: string) => FUNDING_LABELS[kind] ?? 'Moved in from other accounts';

    const byMonth = new Map<string, { income: number; expenses: number; funding: Map<string, number> }>();
    const ensure = (m: string) => {
      if (!byMonth.has(m)) byMonth.set(m, { income: 0, expenses: 0, funding: new Map() });
      return byMonth.get(m)!;
    };
    for (const r of opRows) {
      const e = ensure(r.month);
      e.income = r2(r.income); e.expenses = r2(r.expenses);
    }
    for (const r of fundRows) {
      const e = ensure(r.month);
      const l = labelFor(r.kind);
      e.funding.set(l, r2((e.funding.get(l) ?? 0) + r2(r.total)));
    }

    const sourceLabels = Array.from(
      new Set(fundRows.map((r) => labelFor(r.kind))),
    ).sort();

    let cumulative = 0;
    const months = Array.from(byMonth.keys()).sort().map((m) => {
      const e = byMonth.get(m)!;
      const net = r2(e.income - e.expenses);
      cumulative = r2(cumulative + net);
      const funding: Record<string, number> = {};
      for (const l of sourceLabels) funding[l] = r2(e.funding.get(l) ?? 0);
      return {
        month: m,
        income: e.income,
        expenses: e.expenses,
        net,
        cumulative,
        funding,
        fundingTotal: r2(sourceLabels.reduce((s, l) => s + (e.funding.get(l) ?? 0), 0)),
      };
    });

    const totals = {
      income: r2(months.reduce((s, m) => s + m.income, 0)),
      expenses: r2(months.reduce((s, m) => s + m.expenses, 0)),
      net: r2(months.reduce((s, m) => s + m.net, 0)),
      fundingTotal: r2(months.reduce((s, m) => s + m.fundingTotal, 0)),
      funding: Object.fromEntries(
        sourceLabels.map((l) => [l, r2(months.reduce((s, m) => s + (m.funding[l] ?? 0), 0))]),
      ) as Record<string, number>,
    };
    const deficitMonths = months.filter((m) => m.net < 0).length;
    const completeCount = scope.completeMonths.length;

    res.json({
      report: 'funding',
      period: { start, end, label: scope.label },
      scope: { allAccounts: scope.allAccounts, accountNames: scope.scopeNames },
      coverage: { completeMonths: scope.completeMonths, partialMonths: scope.partialMonths },
      sourceLabels,
      months,
      totals,
      deficitMonths,
      monthCount: months.length,
      circulation: {
        in: r2(circulation.in),
        out: r2(circulation.out),
        txnCount: Number(circulation.txnCount) || 0,
      },
      // Burn rate over COMPLETE months only — a part-month drags the average
      // toward zero and makes a deficit look smaller than it is.
      avgMonthlyNet: completeCount > 0
        ? r2(months.filter((m) => scope.completeMonths.includes(m.month))
              .reduce((s, m) => s + m.net, 0) / completeCount)
        : null,
      completeMonthCount: completeCount,
      data_notes: await getFlowDataNotes(db, userId),
    });
  } catch (error) {
    console.error('Funding report error:', error);
    res.status(500).json({ error: 'Failed to generate funding report' });
  }
});

// ---------------------------------------------------------------------------
// GET /debt-service - what the lenders take
//
// Every payment that services debt, by payee, by month, and as a share of
// income. Marcelo's Q2 2026 was 72% — a number that exists nowhere else in the
// app because card payments, the mortgage and the auto leases live in four
// different categories and are never added together.
//
// Principal and interest cannot be separated: no APR is stored anywhere, and
// the bank descriptor does not carry the split. The report says so rather than
// implying the whole payment is a cost.
// ---------------------------------------------------------------------------
const DEBT_SERVICE_CATEGORIES = ['mortgage', 'cc pmt', 'loan payment', 'auto lease'];

router.get('/debt-service', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const scope = await resolveScope(req, userId);
    if ('error' in scope) { res.status(400).json({ error: scope.error }); return; }
    const { start, end, scopeIds, scopeSql } = scope;

    const catPlaceholders = DEBT_SERVICE_CATEGORIES.map(() => '?').join(', ');
    const debtFilter = `LOWER(COALESCE(c.name, '')) IN (${catPlaceholders})`;

    const rows = await db.all(
      `SELECT t.name, t.amount, t.date, COALESCE(c.name, 'Uncategorised') as "categoryName"
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'debt_payment')
         AND ${debtFilter}
         AND t.date >= ? AND t.date <= ? ${scopeSql}
       ORDER BY t.date ASC`,
      userId, ...DEBT_SERVICE_CATEGORIES, start, end, ...scopeIds,
    ) as any[];

    // Group by payee. merchantStem() strips confirmation numbers, ACH metadata
    // and dates, so eleven differently-numbered Amex payments collapse to one
    // lender line instead of eleven rows that each look small.
    const byPayee = new Map<string, {
      payee: string; category: string; total: number; count: number;
      months: Map<string, number>;
    }>();
    for (const r of rows) {
      const key = merchantStem(String(r.name || '')) || String(r.name || '').toLowerCase();
      if (!byPayee.has(key)) {
        byPayee.set(key, {
          payee: String(r.name || ''), category: r.categoryName,
          total: 0, count: 0, months: new Map(),
        });
      }
      const e = byPayee.get(key)!;
      const amt = Math.abs(Number(r.amount) || 0);
      e.total = r2(e.total + amt);
      e.count += 1;
      const m = String(r.date).slice(0, 7);
      e.months.set(m, r2((e.months.get(m) ?? 0) + amt));
    }

    const monthKeys = Array.from(new Set(rows.map((r) => String(r.date).slice(0, 7)))).sort();

    const incomeRow = await db.get(
      `SELECT ${sqlIncome('t')} as income FROM transactions t
       WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? ${scopeSql}`,
      userId, start, end, ...scopeIds,
    ) as any;
    const income = r2(incomeRow.income);

    const expenseRow = await db.get(
      `SELECT ${sqlExpenses('t')} as expenses FROM transactions t
       WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? ${scopeSql}`,
      userId, start, end, ...scopeIds,
    ) as any;
    const expenses = r2(expenseRow.expenses);

    const payees = Array.from(byPayee.values())
      .map((p) => ({
        payee: p.payee,
        category: p.category,
        total: p.total,
        count: p.count,
        pctOfIncome: income > 0 ? Math.round((p.total / income) * 1000) / 10 : 0,
        byMonth: Object.fromEntries(monthKeys.map((m) => [m, r2(p.months.get(m) ?? 0)])),
      }))
      .sort((a, b) => b.total - a.total);

    const totalDebt = r2(payees.reduce((s, p) => s + p.total, 0));
    const completeCount = scope.completeMonths.length;

    res.json({
      report: 'debt-service',
      period: { start, end, label: scope.label },
      scope: { allAccounts: scope.allAccounts, accountNames: scope.scopeNames },
      coverage: { completeMonths: scope.completeMonths, partialMonths: scope.partialMonths },
      monthKeys,
      payees,
      totals: {
        debtService: totalDebt,
        income,
        expenses,
        pctOfIncome: income > 0 ? Math.round((totalDebt / income) * 1000) / 10 : 0,
        pctOfExpenses: expenses > 0 ? Math.round((totalDebt / expenses) * 1000) / 10 : 0,
        perMonth: completeCount > 0 ? r2(totalDebt / completeCount) : null,
      },
      completeMonthCount: completeCount,
      byMonthTotals: Object.fromEntries(
        monthKeys.map((m) => [m, r2(payees.reduce((s, p) => s + (p.byMonth[m] ?? 0), 0))]),
      ),
      note: 'Principal and interest cannot be separated: no interest rate is stored for these accounts and the bank descriptor does not carry the split. These are total payments, not total cost.',
      data_notes: await getFlowDataNotes(db, userId),
    });
  } catch (error) {
    console.error('Debt service report error:', error);
    res.status(500).json({ error: 'Failed to generate debt service report' });
  }
});

// ---------------------------------------------------------------------------
// GET /committed - what is actually cuttable
//
// Splits spending three ways: debt service (contractual), committed (you can
// change it, but not this month — utilities, insurance, tuition), and
// discretionary (this month's decisions). The useful number is the last one:
// "spend less" is only actionable against the part you actually control.
//
// The mapping is stated in the response so it can be argued with. Groceries
// sits in committed and restaurants in discretionary, which is the split most
// people mean even though both are food.
// ---------------------------------------------------------------------------
const COMMITMENT_TIERS: Record<string, 'debt' | 'committed' | 'discretionary'> = {
  'mortgage': 'debt', 'cc pmt': 'debt', 'loan payment': 'debt', 'auto lease': 'debt',
  'housing': 'committed', 'utilities': 'committed', 'insurance': 'committed',
  'healthcare': 'committed', 'education': 'committed', 'taxes': 'committed',
  'college savings': 'committed', 'kids': 'committed', 'groceries': 'committed',
  'bank fees': 'committed', 'subscriptions': 'committed', 'home services': 'committed',
  'transportation': 'committed', 'pets': 'committed',
};
const tierOf = (cat: string): 'debt' | 'committed' | 'discretionary' =>
  COMMITMENT_TIERS[cat.toLowerCase()] ?? 'discretionary';

router.get('/committed', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const scope = await resolveScope(req, userId);
    if ('error' in scope) { res.status(400).json({ error: scope.error }); return; }
    const { start, end, scopeIds, scopeSql } = scope;

    const catRows = await db.all(
      `SELECT COALESCE(c.name, 'Uncategorised') as name,
              COALESCE(c.icon, '❓') as icon,
              substr(t.date, 1, 7) as month,
              ${sqlExpenses('t')} as total,
              COUNT(t.id) as "txnCount"
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund')
         AND t.date >= ? AND t.date <= ? ${scopeSql}
       GROUP BY c.name, c.icon, substr(t.date, 1, 7)`,
      userId, start, end, ...scopeIds,
    ) as any[];

    const incomeByMonth = await db.all(
      `SELECT substr(t.date, 1, 7) as month, ${sqlIncome('t')} as income
       FROM transactions t
       WHERE t.user_id = ? AND t.date >= ? AND t.date <= ? ${scopeSql}
       GROUP BY substr(t.date, 1, 7)`,
      userId, start, end, ...scopeIds,
    ) as any[];

    const monthKeys = Array.from(new Set([
      ...catRows.map((r) => r.month), ...incomeByMonth.map((r) => r.month),
    ])).sort();

    const cats = new Map<string, { name: string; icon: string; tier: string; total: number; txnCount: number; byMonth: Map<string, number> }>();
    for (const r of catRows) {
      if (!cats.has(r.name)) {
        cats.set(r.name, { name: r.name, icon: r.icon, tier: tierOf(r.name), total: 0, txnCount: 0, byMonth: new Map() });
      }
      const e = cats.get(r.name)!;
      e.total = r2(e.total + r2(r.total));
      e.txnCount += Number(r.txnCount) || 0;
      e.byMonth.set(r.month, r2(r.total));
    }

    const categories = Array.from(cats.values())
      .map((c) => ({
        name: c.name, icon: c.icon, tier: c.tier, total: c.total, txnCount: c.txnCount,
        byMonth: Object.fromEntries(monthKeys.map((m) => [m, r2(c.byMonth.get(m) ?? 0)])),
      }))
      .sort((a, b) => b.total - a.total);

    const tierTotal = (tier: string) => r2(categories.filter((c) => c.tier === tier).reduce((s, c) => s + c.total, 0));
    const income = r2(incomeByMonth.reduce((s, r) => s + r2(r.income), 0));
    const debt = tierTotal('debt');
    const committed = tierTotal('committed');
    const discretionary = tierTotal('discretionary');
    const completeCount = scope.completeMonths.length;

    res.json({
      report: 'committed',
      period: { start, end, label: scope.label },
      scope: { allAccounts: scope.allAccounts, accountNames: scope.scopeNames },
      coverage: { completeMonths: scope.completeMonths, partialMonths: scope.partialMonths },
      monthKeys,
      categories,
      incomeByMonth: Object.fromEntries(incomeByMonth.map((r) => [r.month, r2(r.income)])),
      totals: {
        income, debt, committed, discretionary,
        spending: r2(debt + committed + discretionary),
        afterDebt: r2(income - debt),
        afterCommitted: r2(income - debt - committed),
        net: r2(income - debt - committed - discretionary),
        pctDebt: income > 0 ? Math.round((debt / income) * 1000) / 10 : 0,
        pctCommitted: income > 0 ? Math.round((committed / income) * 1000) / 10 : 0,
        pctDiscretionary: income > 0 ? Math.round((discretionary / income) * 1000) / 10 : 0,
      },
      perMonth: completeCount > 0 ? {
        income: r2(income / completeCount), debt: r2(debt / completeCount),
        committed: r2(committed / completeCount), discretionary: r2(discretionary / completeCount),
      } : null,
      completeMonthCount: completeCount,
      tiers: {
        debt: 'Contractual. Missing one has consequences beyond the money.',
        committed: 'Real commitments you could change, but not this month.',
        discretionary: 'This month\'s decisions — the part actually under your control.',
      },
      data_notes: await getFlowDataNotes(db, userId),
    });
  } catch (error) {
    console.error('Committed report error:', error);
    res.status(500).json({ error: 'Failed to generate committed spending report' });
  }
});

export default router;
