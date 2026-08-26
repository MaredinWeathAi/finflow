import crypto from 'crypto';
import { db } from '../db/database.js';
import {
  ensureFlowClassification,
  liabilityOwed,
  SQL_SPEND_FLOWS,
  sqlExpenses,
} from './flow.js';
import { getCoverage, completeMonthsFromCoverage, monthEndIso } from './coverage.js';
import { monthlyAmount } from './frequency.js';

// All income/expense aggregates in this file use the persisted flow_type
// (see engine/flow.ts) — never the sign of the amount. Transfers, credit-card
// payments (debt_payment) and refunds are excluded from income; interest and
// fees count as expenses.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HealthFactor {
  name: string;
  score: number;
  weight: number;
}

interface HealthScore {
  score: number;
  grade: string;
  factors: HealthFactor[];
}

interface Insight {
  id: string;
  severity: 'critical' | 'warning' | 'positive' | 'info';
  title: string;
  description: string;
  metric: string;
  trend: 'up' | 'down' | 'stable';
  category: string;
  action?: string;
}

interface Recommendation {
  id: string;
  title: string;
  description: string;
  estimatedSavings?: number;
  priority: 'high' | 'medium' | 'low';
}

interface PeriodView {
  totalIncome: number;
  totalExpenses: number;
  totalRecurring: number;
  netCashFlow: number;
  savingsRate: number;
}

interface InsightsResult {
  healthScore: HealthScore;
  insights: Insight[];
  recommendations: Recommendation[];
  monthlyView: PeriodView;
  annualView: PeriodView;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function getCurrentMonthStart(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function getCurrentMonthEnd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mon = now.getMonth() + 1;
  const lastDay = new Date(y, mon, 0).getDate();
  return `${y}-${String(mon).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function getPreviousMonthStart(): string {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth(); // 0-indexed, so this is already "previous month" in 1-indexed
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function getPreviousMonthEnd(): string {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth();
  if (m === 0) {
    m = 12;
    y -= 1;
  }
  const lastDay = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

function getMonthStartNBack(n: number): string {
  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth() + 1 - n;
  while (m <= 0) {
    m += 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function getMonthPrefix(dateStr: string): string {
  return dateStr.substring(0, 7);
}

function getAnnualStart(): string {
  const now = new Date();
  const y = now.getFullYear();
  return `${y}-01-01`;
}

function getAnnualEnd(): string {
  const now = new Date();
  const y = now.getFullYear();
  return `${y}-12-31`;
}

function monthsUntil(targetDate: string): number {
  const now = new Date();
  const target = new Date(targetDate);
  const diffMs = target.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24 * 30.44)));
}

// ---------------------------------------------------------------------------
// Helper: grade from score
// ---------------------------------------------------------------------------

function gradeFromScore(score: number): string {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

function fmtCurrency(amount: number): string {
  return `$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// 1. Compute Health Score
// ---------------------------------------------------------------------------

/**
 * Sum flow-classified income and expenses over an explicit list of complete
 * months ('YYYY-MM', from engine/coverage.ts). Filtering by month key — not a
 * date range — keeps a partially-covered month between complete ones out of
 * the numerator. When the user has no complete months yet (e.g. a single
 * partial month of history) this falls back to all-time totals over 1 month,
 * a labelled best-effort rather than a division by a fixed window size.
 */
async function sumFlowsOverMonths(
  userId: string,
  months: string[],
): Promise<{ income: number; expenses: number; monthCount: number }> {
  if (months.length === 0) {
    const income = (await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE user_id = ? AND flow_type = 'income'`, userId) as any).total;
    const expenses = (await db.get(`SELECT ${sqlExpenses()} as total FROM transactions
       WHERE user_id = ? AND ${SQL_SPEND_FLOWS}`, userId) as any).total;
    return { income, expenses, monthCount: 1 };
  }
  const ph = months.map(() => '?').join(', ');
  const income = (await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND flow_type = 'income' AND substr(date, 1, 7) IN (${ph})`, userId, ...months) as any).total;
  const expenses = (await db.get(`SELECT ${sqlExpenses()} as total FROM transactions
     WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND substr(date, 1, 7) IN (${ph})`, userId, ...months) as any).total;
  return { income, expenses, monthCount: months.length };
}

async function computeHealthScore(userId: string, months3: string[], months6: string[]): Promise<HealthScore> {
  const factors: HealthFactor[] = [];

  // --- Savings rate factor (25% weight) ---
  // Complete months only (engine/coverage.ts): the current partial month never
  // contaminates the window, and a stale dataset uses its own last complete
  // months instead of an empty calendar window.
  const curStart = getCurrentMonthStart();
  const flows3m = await sumFlowsOverMonths(userId, months3);
  const income3m = flows3m.income;
  const expenses3m = flows3m.expenses;

  const savingsRate3m = income3m > 0 ? (income3m - expenses3m) / income3m : 0;
  let savingsScore = 0;
  if (savingsRate3m > 0.20) savingsScore = 100;
  else if (savingsRate3m >= 0.10) savingsScore = 70;
  else if (savingsRate3m >= 0) savingsScore = 40;
  else savingsScore = 0;
  factors.push({ name: 'Savings Rate', score: savingsScore, weight: 0.25 });

  // --- Budget adherence factor (25% weight) ---
  const curMonthPrefix = getMonthPrefix(curStart);
  const budgets = await db.all(`SELECT b.amount, b.category_id, b.rollover_amount
     FROM budgets b
     WHERE b.user_id = ? AND (b.month = ? OR b.month = ?)
     ORDER BY b.amount DESC`, userId, curStart, curMonthPrefix) as any[];

  let withinBudget = 0;
  let totalBudgets = budgets.length;
  for (const b of budgets) {
    const spent = (await db.get(`SELECT ${sqlExpenses()} as spent FROM transactions
       WHERE user_id = ? AND category_id = ? AND flow_type IN ('expense', 'interest_fee', 'refund')
         AND date >= ? AND date <= ?`, userId, b.category_id, curStart, getCurrentMonthEnd()) as any).spent;
    const limit = b.amount + (b.rollover_amount || 0);
    if (spent <= limit) withinBudget++;
  }
  const adherenceScore = totalBudgets > 0 ? Math.round((withinBudget / totalBudgets) * 100) : 50;
  factors.push({ name: 'Budget Adherence', score: adherenceScore, weight: 0.25 });

  // --- Debt ratio factor (15% weight) ---
  // Type-aware, not sign-blind (audit D7): a positive-stored loan balance is
  // debt, not an asset, and an overpaid card is not counted as debt.
  const acctRows = await db.all(`SELECT type, balance FROM accounts WHERE user_id = ? AND is_hidden = 0`, userId) as any[];
  let assets = 0;
  let liabilities = 0;
  for (const a of acctRows) {
    if (['credit', 'loan', 'mortgage'].includes(a.type)) {
      liabilities += liabilityOwed(a.type, a.balance || 0);
    } else if ((a.balance || 0) > 0) {
      assets += a.balance;
    }
  }

  const debtRatio = assets > 0 ? liabilities / assets : 1;
  let debtScore = 100;
  if (debtRatio > 0.5) debtScore = 20;
  else if (debtRatio > 0.3) debtScore = 50;
  else if (debtRatio > 0.1) debtScore = 75;
  factors.push({ name: 'Debt Ratio', score: debtScore, weight: 0.15 });

  // --- Emergency fund factor (15% weight) ---
  const avgMonthlyExpenses = expenses3m / flows3m.monthCount;
  const targetEmergencyFund = avgMonthlyExpenses * 4.5; // midpoint of 3-6 months
  // Liquid cash is every non-hidden cash-like account — savings, checking,
  // money-market/cash/other (audit D10: counting only `type='savings'` told a
  // user with $30k in checking they had no emergency fund). Liability and
  // investment-linked accounts are excluded.
  const savingsBalance = (await db.get(`SELECT COALESCE(SUM(balance), 0) as total FROM accounts
     WHERE user_id = ? AND COALESCE(is_hidden, 0) = 0
       AND type NOT IN ('credit', 'loan', 'mortgage', 'investment')
       AND id NOT IN (SELECT account_id FROM investments WHERE user_id = ? AND account_id IS NOT NULL)`, userId, userId) as any).total;

  const emergencyProgress = targetEmergencyFund > 0 ? savingsBalance / targetEmergencyFund : 0;
  const emergencyScore = Math.min(100, Math.round(emergencyProgress * 100));
  factors.push({ name: 'Emergency Fund', score: emergencyScore, weight: 0.15 });

  // --- Income stability factor (10% weight) ---
  // Complete months only (audit D11): the partial current month is excluded,
  // and a complete month with zero income is a REAL zero — dropping zeros
  // censored the sample and overstated stability for irregular earners.
  const monthlyIncomes: number[] = [];
  if (months6.length > 0) {
    const ph6 = months6.map(() => '?').join(', ');
    const incomeRows = await db.all(`SELECT substr(date, 1, 7) as ym, COALESCE(SUM(amount), 0) as total
       FROM transactions
       WHERE user_id = ? AND flow_type = 'income' AND substr(date, 1, 7) IN (${ph6})
       GROUP BY substr(date, 1, 7)`, userId, ...months6) as Array<{ ym: string; total: number }>;
    const incomeByMonth = new Map(incomeRows.map((r) => [r.ym, r.total]));
    for (const ym of months6) {
      monthlyIncomes.push(incomeByMonth.get(ym) || 0);
    }
  }

  let stabilityScore = 50;
  if (monthlyIncomes.length >= 3) {
    const avg = monthlyIncomes.reduce((a, b) => a + b, 0) / monthlyIncomes.length;
    const variance = monthlyIncomes.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / monthlyIncomes.length;
    const cv = avg > 0 ? Math.sqrt(variance) / avg : 1; // coefficient of variation
    if (cv < 0.05) stabilityScore = 100;
    else if (cv < 0.15) stabilityScore = 80;
    else if (cv < 0.30) stabilityScore = 60;
    else stabilityScore = 30;
  }
  factors.push({ name: 'Income Stability', score: stabilityScore, weight: 0.10 });

  // --- Goal progress factor (10% weight) ---
  const goals = await db.all(`SELECT target_amount, current_amount, target_date, is_completed
     FROM goals WHERE user_id = ? AND is_completed = 0`, userId) as any[];

  let goalScore = 50;
  if (goals.length > 0) {
    let totalProgress = 0;
    for (const g of goals) {
      const progress = g.target_amount > 0 ? (g.current_amount / g.target_amount) : 0;
      totalProgress += Math.min(1, progress);
    }
    goalScore = Math.round((totalProgress / goals.length) * 100);
  }
  factors.push({ name: 'Goal Progress', score: goalScore, weight: 0.10 });

  // --- Weighted total ---
  const totalScore = Math.round(
    factors.reduce((sum, f) => sum + f.score * f.weight, 0)
  );

  return {
    score: totalScore,
    grade: gradeFromScore(totalScore),
    factors,
  };
}

// ---------------------------------------------------------------------------
// 2. Analyze Budget Adherence
// ---------------------------------------------------------------------------

async function analyzeBudgetAdherence(userId: string): Promise<Insight[]> {
  const insights: Insight[] = [];
  const curStart = getCurrentMonthStart();
  const curEnd = getCurrentMonthEnd();
  const curMonthPrefix = getMonthPrefix(curStart);

  const budgets = await db.all(`SELECT b.*, c.name as category_name
     FROM budgets b
     JOIN categories c ON b.category_id = c.id
     WHERE b.user_id = ? AND (b.month = ? OR b.month = ?)`, userId, curStart, curMonthPrefix) as any[];

  for (const b of budgets) {
    const spent = (await db.get(`SELECT ${sqlExpenses()} as spent FROM transactions
       WHERE user_id = ? AND category_id = ? AND flow_type IN ('expense', 'interest_fee', 'refund')
         AND date >= ? AND date <= ?`, userId, b.category_id, curStart, curEnd) as any).spent;

    const limit = b.amount + (b.rollover_amount || 0);
    const pctUsed = limit > 0 ? spent / limit : 0;

    if (pctUsed > 1.2) {
      insights.push({
        id: crypto.randomUUID(),
        severity: 'critical',
        title: `${b.category_name} budget exceeded by ${fmtPercent(pctUsed - 1)}`,
        description: `You have spent ${fmtCurrency(spent)} against a ${fmtCurrency(limit)} budget for ${b.category_name} this month. This is ${fmtPercent(pctUsed)} of your allocation. Consider reviewing recent transactions in this category to identify where spending accelerated.`,
        metric: fmtPercent(pctUsed),
        trend: 'up',
        category: 'budgets',
        action: `Review ${b.category_name} transactions and identify at least two discretionary purchases to cut next month.`,
      });
    } else if (pctUsed > 0.9) {
      insights.push({
        id: crypto.randomUUID(),
        severity: 'warning',
        title: `${b.category_name} nearing budget limit`,
        description: `You have used ${fmtPercent(pctUsed)} of your ${b.category_name} budget (${fmtCurrency(spent)} of ${fmtCurrency(limit)}). With time remaining in the month, you may want to slow down spending in this category to avoid overshoot.`,
        metric: fmtPercent(pctUsed),
        trend: 'up',
        category: 'budgets',
        action: `Limit ${b.category_name} spending to ${fmtCurrency(limit - spent)} for the rest of the month.`,
      });
    } else if (pctUsed < 0.7 && spent > 0) {
      insights.push({
        id: crypto.randomUUID(),
        severity: 'positive',
        title: `${b.category_name} well under budget`,
        description: `Excellent discipline in ${b.category_name} -- you have only used ${fmtPercent(pctUsed)} of your budget (${fmtCurrency(spent)} of ${fmtCurrency(limit)}). The remaining ${fmtCurrency(limit - spent)} could be redirected toward savings goals.`,
        metric: fmtPercent(pctUsed),
        trend: 'down',
        category: 'budgets',
      });
    }
  }

  return insights;
}

// ---------------------------------------------------------------------------
// 3. Analyze Spending Trends
// ---------------------------------------------------------------------------

async function analyzeSpendingTrends(userId: string): Promise<Insight[]> {
  const insights: Insight[] = [];
  // Compare the last two COMPLETE months. This used to compare the calendar
  // current month against the previous one, so on the 5th of a month almost
  // every category satisfied "spending dropped by half" and the page filled up
  // with false "Great improvement" insights, while genuine increases stayed
  // suppressed until month end.
  const complete = completeMonthsFromCoverage(await getCoverage(userId), 2); // newest first
  if (complete.length < 2) return insights;
  const curStart = `${complete[0]}-01`;
  const curEnd = monthEndIso(complete[0]);
  const prevStart = `${complete[1]}-01`;
  const prevEnd = monthEndIso(complete[1]);

  // Get spending by category for current and previous month
  const currentSpending = await db.all(`SELECT c.name as category_name, c.id as category_id,
            ${sqlExpenses('t')} as spent
     FROM categories c
     LEFT JOIN transactions t ON t.category_id = c.id
       AND t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund')
       AND t.date >= ? AND t.date <= ?
     WHERE c.user_id = ? AND c.is_income = 0
     GROUP BY c.id, c.name`, userId, curStart, curEnd, userId) as any[];

  const previousSpending = await db.all(`SELECT c.id as category_id,
            ${sqlExpenses('t')} as spent
     FROM categories c
     LEFT JOIN transactions t ON t.category_id = c.id
       AND t.user_id = ? AND t.flow_type IN ('expense', 'interest_fee', 'refund')
       AND t.date >= ? AND t.date <= ?
     WHERE c.user_id = ? AND c.is_income = 0
     GROUP BY c.id`, userId, prevStart, prevEnd, userId) as any[];

  const prevMap = new Map<string, number>();
  for (const p of previousSpending) {
    prevMap.set(p.category_id, p.spent);
  }

  for (const cur of currentSpending) {
    const prevSpent = prevMap.get(cur.category_id) || 0;
    if (prevSpent === 0 || cur.spent === 0) continue;

    const changeRatio = (cur.spent - prevSpent) / prevSpent;

    if (changeRatio > 0.3) {
      insights.push({
        id: crypto.randomUUID(),
        severity: 'warning',
        title: `${cur.category_name} spending up ${fmtPercent(changeRatio)} month-over-month`,
        description: `Your ${cur.category_name} spending increased from ${fmtCurrency(prevSpent)} last month to ${fmtCurrency(cur.spent)} this month. This ${fmtPercent(changeRatio)} jump may indicate lifestyle creep or a one-time spike worth investigating.`,
        metric: `+${fmtPercent(changeRatio)}`,
        trend: 'up',
        category: 'spending',
        action: `Compare your ${cur.category_name} transactions this month vs last month to identify the source of the increase.`,
      });
    } else if (changeRatio < -0.5) {
      insights.push({
        id: crypto.randomUUID(),
        severity: 'positive',
        title: `${cur.category_name} spending down ${fmtPercent(Math.abs(changeRatio))} month-over-month`,
        description: `Great improvement in ${cur.category_name} -- spending dropped from ${fmtCurrency(prevSpent)} to ${fmtCurrency(cur.spent)}, a reduction of ${fmtCurrency(prevSpent - cur.spent)}. Keep this momentum going.`,
        metric: `${fmtPercent(changeRatio)}`,
        trend: 'down',
        category: 'spending',
      });
    }
  }

  return insights;
}

// ---------------------------------------------------------------------------
// 4. Analyze Recurring Costs
// ---------------------------------------------------------------------------

async function analyzeRecurringCosts(userId: string): Promise<Insight[]> {
  const insights: Insight[] = [];

  const recurring = await db.all(`SELECT name, amount, frequency, price_history, is_active
     FROM recurring_expenses
     WHERE user_id = ? AND is_active = 1`, userId) as any[];

  let monthlyTotal = 0;
  const priceIncreases: { name: string; oldPrice: number; newPrice: number; pctChange: number }[] = [];

  for (const r of recurring) {
    // Shared frequency table (engine/frequency.ts). An unrecognised frequency
    // contributes 0 rather than its full amount every month.
    const monthly = monthlyAmount(r.amount, r.frequency) ?? 0;

    monthlyTotal += monthly;

    // Check price history for increases
    try {
      const history = JSON.parse(r.price_history || '[]');
      if (history.length >= 2) {
        const latest = history[history.length - 1];
        const previous = history[history.length - 2];
        if (latest.amount > previous.amount) {
          const pctChange = (latest.amount - previous.amount) / previous.amount;
          priceIncreases.push({
            name: r.name,
            oldPrice: previous.amount,
            newPrice: latest.amount,
            pctChange,
          });
        }
      }
    } catch {
      // Ignore malformed JSON
    }
  }

  const annualTotal = monthlyTotal * 12;

  if (recurring.length > 0) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'info',
      title: `${recurring.length} active recurring expenses totaling ${fmtCurrency(monthlyTotal)}/mo`,
      description: `Your recurring commitments add up to ${fmtCurrency(monthlyTotal)} per month (${fmtCurrency(annualTotal)} annually). This represents a fixed cost floor before any discretionary spending. Review each subscription periodically to ensure you are still getting value.`,
      metric: fmtCurrency(monthlyTotal),
      trend: 'stable',
      category: 'recurring',
      action: 'Audit your subscriptions quarterly. Cancel any you have not used in the past 30 days.',
    });
  }

  for (const increase of priceIncreases) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'warning',
      title: `${increase.name} price increased by ${fmtPercent(increase.pctChange)}`,
      description: `${increase.name} went from ${fmtCurrency(increase.oldPrice)} to ${fmtCurrency(increase.newPrice)}, a ${fmtPercent(increase.pctChange)} hike. Over a year, this costs an extra ${fmtCurrency((increase.newPrice - increase.oldPrice) * 12)}. Consider whether a cheaper alternative exists.`,
      metric: `+${fmtCurrency(increase.newPrice - increase.oldPrice)}`,
      trend: 'up',
      category: 'recurring',
      action: `Evaluate alternatives to ${increase.name} or negotiate a better rate.`,
    });
  }

  return insights;
}

// ---------------------------------------------------------------------------
// 5. Analyze Savings Rate
// ---------------------------------------------------------------------------

async function analyzeSavingsRate(userId: string, months3: string[]): Promise<Insight[]> {
  const insights: Insight[] = [];

  // Complete months only (engine/coverage.ts) — the partial current month is
  // excluded from the window and from the denominator (audit D4).
  const flows = await sumFlowsOverMonths(userId, months3);
  const income = flows.income;
  const expenses = flows.expenses;
  const windowLabel = months3.length > 0
    ? `${months3.length} complete month${months3.length === 1 ? '' : 's'}`
    : 'your available history';

  const netSavings = income - expenses;
  const savingsRate = income > 0 ? netSavings / income : 0;
  const monthlyNetSavings = netSavings / flows.monthCount;

  if (savingsRate < 0) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'critical',
      title: 'Negative savings rate over your recent complete months',
      description: `You are spending more than you earn. Over the last ${windowLabel}, expenses (${fmtCurrency(expenses)}) exceeded income (${fmtCurrency(income)}) by ${fmtCurrency(Math.abs(netSavings))}. This trajectory depletes your reserves at ${fmtCurrency(Math.abs(monthlyNetSavings))} per month.`,
      metric: fmtPercent(savingsRate),
      trend: 'down',
      category: 'savings',
      action: 'Identify your top 3 discretionary spending categories and set hard caps for next month.',
    });
  } else if (savingsRate < 0.10) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'warning',
      title: `Savings rate at ${fmtPercent(savingsRate)} -- below the recommended 10%`,
      description: `Over the last ${windowLabel}, you saved ${fmtCurrency(netSavings)} on ${fmtCurrency(income)} in income (${fmtPercent(savingsRate)} rate). Financial planners recommend saving at least 10-20% of gross income. Increasing by just ${fmtCurrency((0.10 * income - netSavings) / flows.monthCount)} per month would reach the 10% target.`,
      metric: fmtPercent(savingsRate),
      trend: 'stable',
      category: 'savings',
      action: 'Automate a transfer of at least 10% of each paycheck into your savings account.',
    });
  } else if (savingsRate >= 0.20) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'positive',
      title: `Strong savings rate of ${fmtPercent(savingsRate)}`,
      description: `Outstanding financial discipline. You saved ${fmtCurrency(netSavings)} over the last ${windowLabel}, averaging ${fmtCurrency(monthlyNetSavings)} per month. At this pace, you are building a meaningful financial cushion. Consider allocating surplus savings toward investment accounts for long-term growth.`,
      metric: fmtPercent(savingsRate),
      trend: 'up',
      category: 'savings',
    });
  } else {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'info',
      title: `Savings rate at ${fmtPercent(savingsRate)}`,
      description: `You are saving ${fmtCurrency(monthlyNetSavings)} per month on average, which puts you in a healthy range. To accelerate wealth building, aim to push above 20%.`,
      metric: fmtPercent(savingsRate),
      trend: 'stable',
      category: 'savings',
    });
  }

  return insights;
}

// ---------------------------------------------------------------------------
// 6. Analyze Goal Progress
// ---------------------------------------------------------------------------

async function analyzeGoalProgress(userId: string, months3: string[]): Promise<Insight[]> {
  const insights: Insight[] = [];

  const goals = await db.all(`SELECT name, target_amount, current_amount, target_date, icon
     FROM goals WHERE user_id = ? AND is_completed = 0`, userId) as any[];

  // Recent monthly surplus over complete months only (audit D4: the partial
  // current month used to contaminate this window and skew feasibility).
  const recentFlows = goals.length > 0 ? await sumFlowsOverMonths(userId, months3) : null;
  const avgMonthlySurplus = recentFlows
    ? (recentFlows.income - recentFlows.expenses) / recentFlows.monthCount
    : 0;

  for (const g of goals) {
    const remaining = g.target_amount - g.current_amount;
    const progress = g.target_amount > 0 ? g.current_amount / g.target_amount : 0;
    const months = g.target_date ? monthsUntil(g.target_date) : 0;

    if (months <= 0 && remaining > 0) {
      insights.push({
        id: crypto.randomUUID(),
        severity: 'critical',
        title: `"${g.name}" is past its target date`,
        description: `Your goal "${g.name}" target date has passed and you are still ${fmtCurrency(remaining)} short of the ${fmtCurrency(g.target_amount)} target (${fmtPercent(progress)} complete). Consider adjusting the timeline or increasing your monthly contribution.`,
        metric: fmtPercent(progress),
        trend: 'down',
        category: 'goals',
        action: `Set a new realistic target date for "${g.name}" and increase your monthly contribution by ${fmtCurrency(remaining / 6)} to close the gap in 6 months.`,
      });
    } else if (months > 0 && remaining > 0) {
      const requiredMonthly = remaining / months;

      // Check against the complete-month surplus computed above
      if (requiredMonthly > avgMonthlySurplus * 0.8) {
        insights.push({
          id: crypto.randomUUID(),
          severity: 'warning',
          title: `"${g.name}" requires ${fmtCurrency(requiredMonthly)}/mo -- may be at risk`,
          description: `To reach your ${fmtCurrency(g.target_amount)} goal for "${g.name}" in ${months} months, you need to save ${fmtCurrency(requiredMonthly)} per month. Based on your current surplus of ${fmtCurrency(avgMonthlySurplus)}/mo, this target is ambitious. You are ${fmtPercent(progress)} of the way there.`,
          metric: `${fmtCurrency(requiredMonthly)}/mo`,
          trend: 'down',
          category: 'goals',
          action: `Allocate ${fmtCurrency(requiredMonthly)} per month specifically toward "${g.name}" or consider extending the deadline.`,
        });
      } else if (progress >= 0.75) {
        insights.push({
          id: crypto.randomUUID(),
          severity: 'positive',
          title: `"${g.name}" is ${fmtPercent(progress)} complete -- on track`,
          description: `You have saved ${fmtCurrency(g.current_amount)} of your ${fmtCurrency(g.target_amount)} target for "${g.name}". With ${months} months remaining, you only need ${fmtCurrency(requiredMonthly)} per month to finish. Keep up the great work.`,
          metric: fmtPercent(progress),
          trend: 'up',
          category: 'goals',
        });
      } else {
        insights.push({
          id: crypto.randomUUID(),
          severity: 'info',
          title: `"${g.name}" is ${fmtPercent(progress)} complete`,
          description: `You have ${fmtCurrency(remaining)} left to save for "${g.name}" over the next ${months} months (${fmtCurrency(requiredMonthly)}/mo needed). Stay consistent with contributions to stay on track.`,
          metric: fmtPercent(progress),
          trend: 'stable',
          category: 'goals',
        });
      }
    }
  }

  return insights;
}

// ---------------------------------------------------------------------------
// 7. Analyze Investments
// ---------------------------------------------------------------------------

async function analyzeInvestments(userId: string): Promise<Insight[]> {
  const insights: Insight[] = [];

  const investments = await db.all(`SELECT symbol, name, type, shares, cost_basis, current_price
     FROM investments WHERE user_id = ?`, userId) as any[];

  if (investments.length === 0) return insights;

  let totalValue = 0;
  let totalCost = 0;
  const typeAllocation: Record<string, number> = {};

  for (const inv of investments) {
    const currentValue = inv.shares * inv.current_price;
    const costValue = inv.shares * inv.cost_basis;
    totalValue += currentValue;
    totalCost += costValue;
    typeAllocation[inv.type] = (typeAllocation[inv.type] || 0) + currentValue;
  }

  const totalGainLoss = totalValue - totalCost;
  const totalGainLossPct = totalCost > 0 ? totalGainLoss / totalCost : 0;

  if (totalGainLoss > 0) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'positive',
      title: `Investment portfolio up ${fmtPercent(totalGainLossPct)} (${fmtCurrency(totalGainLoss)})`,
      description: `Your investment portfolio is valued at ${fmtCurrency(totalValue)} with a total gain of ${fmtCurrency(totalGainLoss)} (${fmtPercent(totalGainLossPct)} return on ${fmtCurrency(totalCost)} invested). Consider rebalancing if any single position exceeds 25% of your portfolio.`,
      metric: `+${fmtPercent(totalGainLossPct)}`,
      trend: 'up',
      category: 'investments',
    });
  } else if (totalGainLossPct < -0.10) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'warning',
      title: `Investment portfolio down ${fmtPercent(Math.abs(totalGainLossPct))} (${fmtCurrency(Math.abs(totalGainLoss))})`,
      description: `Your portfolio has declined to ${fmtCurrency(totalValue)}, reflecting a ${fmtCurrency(Math.abs(totalGainLoss))} unrealized loss. Avoid panic selling -- review your asset allocation and ensure it aligns with your risk tolerance and time horizon.`,
      metric: `${fmtPercent(totalGainLossPct)}`,
      trend: 'down',
      category: 'investments',
      action: 'Review your portfolio allocation and consider tax-loss harvesting opportunities.',
    });
  } else {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'info',
      title: `Investment portfolio at ${fmtCurrency(totalValue)}`,
      description: `Your portfolio is near breakeven with a ${fmtPercent(totalGainLossPct)} return. Total invested: ${fmtCurrency(totalCost)}. Continue dollar-cost averaging into diversified positions for long-term growth.`,
      metric: fmtCurrency(totalValue),
      trend: 'stable',
      category: 'investments',
    });
  }

  // Allocation insight
  const allocationEntries = Object.entries(typeAllocation).map(([type, value]) => ({
    type,
    value,
    pct: totalValue > 0 ? value / totalValue : 0,
  }));

  const heavyPositions = allocationEntries.filter((a) => a.pct > 0.5);
  if (heavyPositions.length > 0) {
    const top = heavyPositions[0];
    insights.push({
      id: crypto.randomUUID(),
      severity: 'warning',
      title: `Portfolio concentration: ${fmtPercent(top.pct)} in ${top.type}`,
      description: `More than half of your portfolio (${fmtCurrency(top.value)}) is concentrated in ${top.type} assets. Diversification across asset classes can reduce risk and smooth returns over time.`,
      metric: fmtPercent(top.pct),
      trend: 'stable',
      category: 'investments',
      action: `Consider rebalancing by shifting ${fmtPercent(top.pct - 0.4)} of your ${top.type} allocation into other asset classes.`,
    });
  }

  return insights;
}

// ---------------------------------------------------------------------------
// 8. Detect Uncategorized Transactions
// ---------------------------------------------------------------------------

async function detectUncategorized(userId: string): Promise<Insight[]> {
  const insights: Insight[] = [];

  const result = (await db.get(`SELECT COUNT(*) as count FROM transactions
     WHERE user_id = ? AND category_id IS NULL`, userId) as any);

  const uncategorizedCount = result.count;

  if (uncategorizedCount > 5) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'warning',
      title: `${uncategorizedCount} uncategorized transactions found`,
      description: `You have ${uncategorizedCount} transactions without a category. Uncategorized transactions reduce the accuracy of your budget tracking, spending trends, and financial health score. Categorizing them takes just a few minutes and significantly improves your insights.`,
      metric: `${uncategorizedCount}`,
      trend: 'stable',
      category: 'data-quality',
      action: 'Go to your transactions list, filter by "Uncategorized", and assign categories to improve your reports.',
    });
  } else if (uncategorizedCount > 0) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'info',
      title: `${uncategorizedCount} uncategorized transaction${uncategorizedCount === 1 ? '' : 's'}`,
      description: `Nearly all your transactions are categorized. Just ${uncategorizedCount} remaining -- categorizing them will give you a complete picture of your finances.`,
      metric: `${uncategorizedCount}`,
      trend: 'stable',
      category: 'data-quality',
    });
  }

  return insights;
}

// ---------------------------------------------------------------------------
// 9. Generate Recommendations
// ---------------------------------------------------------------------------

/**
 * Normalize a recurring amount to a monthly figure.
 *
 * Delegates to engine/frequency.ts. This used to have its own table that knew
 * 'yearly' and 'annual' but not 'annually', 'semi-monthly' or 'semi-annual' —
 * and returned the raw amount for anything it didn't recognise, so an annual
 * bill counted twelve times. Unknown frequencies now contribute 0 rather than
 * a wrong number.
 */
function toMonthlyAmount(amount: number, frequency: string): number {
  return monthlyAmount(amount, frequency) ?? 0;
}

/**
 * Recommendations. Every `estimatedSavings` figure is computed from the user's
 * own data (actual budget overages, the user's real gap to a 10% savings rate,
 * the actual price increases on their recurring services). When no real figure
 * can be computed the field is omitted — an invented number is never presented
 * as an estimate (audit: the old code shipped hardcoded count × $75/$120/$150).
 */
async function generateRecommendations(
  userId: string,
  allInsights: Insight[],
  months3: string[]
): Promise<Recommendation[]> {
  const recommendations: Recommendation[] = [];

  // Analyze critical and warning insights to derive recommendations
  const criticals = allInsights.filter((i) => i.severity === 'critical');
  const warnings = allInsights.filter((i) => i.severity === 'warning');

  // Recommendation: If budget overruns exist
  const budgetOverruns = criticals.filter((i) => i.category === 'budgets');
  if (budgetOverruns.length > 0) {
    // Real figure: the user's actual overage this month across categories that
    // are significantly (>20%) over budget — the same set that produced the
    // critical insights above.
    const curStart = getCurrentMonthStart();
    const curEnd = getCurrentMonthEnd();
    const budgets = await db.all(`SELECT b.amount, b.category_id, b.rollover_amount
       FROM budgets b
       WHERE b.user_id = ? AND (b.month = ? OR b.month = ?)`, userId, curStart, getMonthPrefix(curStart)) as any[];
    let totalOverage = 0;
    for (const b of budgets) {
      const spent = (await db.get(`SELECT ${sqlExpenses()} as spent FROM transactions
         WHERE user_id = ? AND category_id = ? AND flow_type IN ('expense', 'interest_fee', 'refund')
           AND date >= ? AND date <= ?`, userId, b.category_id, curStart, curEnd) as any).spent;
      const limit = b.amount + (b.rollover_amount || 0);
      if (limit > 0 && spent > limit * 1.2) totalOverage += spent - limit;
    }
    const estimatedSavings = Math.round(totalOverage);
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Tighten overspent budget categories',
      description: `You have ${budgetOverruns.length} budget categor${budgetOverruns.length === 1 ? 'y' : 'ies'} significantly over limit${estimatedSavings > 0 ? `, a combined ${fmtCurrency(estimatedSavings)} over budget this month` : ''}. Review the largest transactions in each overspent category and identify recurring discretionary purchases that can be reduced or eliminated. Start with the category showing the highest overage.`,
      ...(estimatedSavings > 0 ? { estimatedSavings } : {}),
      priority: 'high',
    });
  }

  // Recommendation: If savings rate is low
  const savingsIssues = allInsights.filter(
    (i) => i.category === 'savings' && (i.severity === 'critical' || i.severity === 'warning')
  );
  if (savingsIssues.length > 0) {
    // Real figure: the user's own monthly gap to a 10% savings rate, measured
    // over their recent complete months.
    const flows = await sumFlowsOverMonths(userId, months3);
    const monthlyGap = (0.10 * flows.income - (flows.income - flows.expenses)) / flows.monthCount;
    const estimatedSavings = monthlyGap > 0 && flows.income > 0 ? Math.round(monthlyGap) : 0;
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Boost your savings rate with automated transfers',
      description: `Set up an automatic transfer of at least 10% of each paycheck directly into a high-yield savings account.${estimatedSavings > 0 ? ` Based on your recent complete months, redirecting about ${fmtCurrency(estimatedSavings)} per month would bring you to a 10% savings rate.` : ''} By paying yourself first, you remove the temptation to spend before saving.`,
      ...(estimatedSavings > 0 ? { estimatedSavings } : {}),
      priority: 'high',
    });
  }

  // Recommendation: Recurring cost optimization
  const recurringWarnings = warnings.filter((i) => i.category === 'recurring');
  if (recurringWarnings.length > 0) {
    // Real figure: the annualized cost of the actual price increases detected
    // on the user's recurring services (the same price_history comparison that
    // produced the warnings above).
    const recurring = await db.all(`SELECT amount, frequency, price_history FROM recurring_expenses
       WHERE user_id = ? AND is_active = 1`, userId) as any[];
    let annualDelta = 0;
    for (const r of recurring) {
      try {
        const history = JSON.parse(r.price_history || '[]');
        if (history.length >= 2) {
          const latest = history[history.length - 1];
          const previous = history[history.length - 2];
          if (latest.amount > previous.amount) {
            annualDelta += toMonthlyAmount(latest.amount - previous.amount, r.frequency) * 12;
          }
        }
      } catch {
        // Ignore malformed JSON
      }
    }
    const estimatedSavings = Math.round(annualDelta);
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Negotiate or replace services with price increases',
      description: `${recurringWarnings.length} of your recurring services have recently increased in price${estimatedSavings > 0 ? `, adding about ${fmtCurrency(estimatedSavings)} per year` : ''}. Contact each provider to negotiate a retention discount, or research competitive alternatives. Many providers offer loyalty discounts when you call to cancel. Bundle services where possible for additional savings.`,
      ...(estimatedSavings > 0 ? { estimatedSavings } : {}),
      priority: 'medium',
    });
  }

  // Recommendation: Spending trends. No dollar estimate is attached: the
  // month-over-month movement of a category is not a measure of what a
  // cooling-off rule would save, and a fabricated figure is worse than none.
  const spendingUp = warnings.filter((i) => i.category === 'spending');
  if (spendingUp.length > 0) {
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Address rising spending categories',
      description: `${spendingUp.length} spending categor${spendingUp.length === 1 ? 'y has' : 'ies have'} increased significantly month-over-month. Implement a 24-hour cooling-off rule for purchases over $50 in these categories. Track each purchase in the moment to build awareness around impulse spending.`,
      priority: 'medium',
    });
  }

  // Recommendation: Uncategorized transactions
  const uncategorized = allInsights.filter(
    (i) => i.category === 'data-quality' && i.severity === 'warning'
  );
  if (uncategorized.length > 0) {
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Categorize transactions for better insights',
      description: 'Uncategorized transactions create blind spots in your financial analysis. Set aside 5 minutes each week to categorize new transactions. Consider setting up auto-categorization rules for merchants you visit regularly to save time going forward.',
      priority: 'low',
    });
  }

  // Recommendation: Goal acceleration (if behind on goals)
  const goalIssues = allInsights.filter(
    (i) => i.category === 'goals' && (i.severity === 'critical' || i.severity === 'warning')
  );
  if (goalIssues.length > 0) {
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Realign savings goals with realistic timelines',
      description: `${goalIssues.length} of your savings goals are at risk of falling short. Prioritize the most time-sensitive goal and allocate any monthly surplus toward it. If multiple goals compete for limited funds, extend the deadline on lower-priority goals to reduce monthly pressure.`,
      priority: 'medium',
    });
  }

  // Always provide a positive recommendation if portfolio is doing well
  const investmentPositive = allInsights.filter(
    (i) => i.category === 'investments' && i.severity === 'positive'
  );
  if (investmentPositive.length > 0 && recommendations.length < 5) {
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Consider increasing investment contributions',
      description: 'Your portfolio is generating positive returns. If your emergency fund covers 3-6 months of expenses, consider increasing your monthly investment contributions. Dollar-cost averaging into diversified index funds remains one of the most reliable long-term wealth-building strategies.',
      priority: 'low',
    });
  }

  // Cap at 5 recommendations, sorted by priority
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
  return recommendations.slice(0, 5);
}

// ---------------------------------------------------------------------------
// 10. Compute Monthly vs Annual View
// ---------------------------------------------------------------------------

async function computeMonthlyVsAnnualView(userId: string): Promise<{ monthlyView: PeriodView; annualView: PeriodView }> {
  // --- Monthly view (current month) ---
  const curStart = getCurrentMonthStart();
  const curEnd = getCurrentMonthEnd();

  const monthIncome = (await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND flow_type = 'income' AND date >= ? AND date <= ?`, userId, curStart, curEnd) as any).total;

  const monthExpenses = (await db.get(`SELECT ${sqlExpenses()} as total FROM transactions
     WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND date >= ? AND date <= ?`, userId, curStart, curEnd) as any).total;

  // Monthly recurring total (active recurring expenses normalized to monthly)
  const recurringItems = await db.all(`SELECT amount, frequency FROM recurring_expenses
     WHERE user_id = ? AND is_active = 1`, userId) as any[];

  let monthRecurring = 0;
  for (const r of recurringItems) {
    monthRecurring += monthlyAmount(r.amount, r.frequency) ?? 0;
  }

  const monthNet = monthIncome - monthExpenses;
  const monthSavingsRate = monthIncome > 0 ? monthNet / monthIncome : 0;

  const monthlyView: PeriodView = {
    totalIncome: Math.round(monthIncome * 100) / 100,
    totalExpenses: Math.round(monthExpenses * 100) / 100,
    totalRecurring: Math.round(monthRecurring * 100) / 100,
    netCashFlow: Math.round(monthNet * 100) / 100,
    // A PERCENTAGE, matching /reports/summary and what the Insights card
    // renders. This used to ship the raw fraction (-0.1983) into a card that
    // formats it as `${value.toFixed(1)}%`, so a household overspending by 20%
    // of its income read "-0.2%" — off by a factor of 100.
    savingsRate: Math.round(monthSavingsRate * 100 * 100) / 100,
  };

  // --- Annual view (current calendar year) ---
  const yearStart = getAnnualStart();
  const yearEnd = getAnnualEnd();

  const yearIncome = (await db.get(`SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND flow_type = 'income' AND date >= ? AND date <= ?`, userId, yearStart, yearEnd) as any).total;

  const yearExpenses = (await db.get(`SELECT ${sqlExpenses()} as total FROM transactions
     WHERE user_id = ? AND ${SQL_SPEND_FLOWS} AND date >= ? AND date <= ?`, userId, yearStart, yearEnd) as any).total;

  const annualRecurring = monthRecurring * 12;
  const yearNet = yearIncome - yearExpenses;
  const yearSavingsRate = yearIncome > 0 ? yearNet / yearIncome : 0;

  const annualView: PeriodView = {
    totalIncome: Math.round(yearIncome * 100) / 100,
    totalExpenses: Math.round(yearExpenses * 100) / 100,
    totalRecurring: Math.round(annualRecurring * 100) / 100,
    netCashFlow: Math.round(yearNet * 100) / 100,
    savingsRate: Math.round(yearSavingsRate * 100 * 100) / 100,   // percentage, see above
  };

  return { monthlyView, annualView };
}

// ---------------------------------------------------------------------------
// Main: generateInsights
// ---------------------------------------------------------------------------

export async function generateInsights(userId: string): Promise<InsightsResult> {
  // Every aggregate below reads flow_type; make sure all rows are classified.
  await ensureFlowClassification(userId);

  // Load coverage once: engine/coverage.ts is the only authority on which
  // months are complete. Incomplete months never enter a mean or denominator.
  const coverage = await getCoverage(userId);
  const months3 = completeMonthsFromCoverage(coverage, 3);
  const months6 = completeMonthsFromCoverage(coverage, 6);

  // Compute health score
  const healthScore = await computeHealthScore(userId, months3, months6);

  // Gather all insights from analysis functions
  const budgetInsights = await analyzeBudgetAdherence(userId);
  const spendingInsights = await analyzeSpendingTrends(userId);
  const recurringInsights = await analyzeRecurringCosts(userId);
  const savingsInsights = await analyzeSavingsRate(userId, months3);
  const goalInsights = await analyzeGoalProgress(userId, months3);
  const investmentInsights = await analyzeInvestments(userId);
  const uncategorizedInsights = await detectUncategorized(userId);

  const allInsights = [
    ...budgetInsights,
    ...spendingInsights,
    ...recurringInsights,
    ...savingsInsights,
    ...goalInsights,
    ...investmentInsights,
    ...uncategorizedInsights,
  ];

  // Sort insights: critical first, then warning, info, positive
  const severityOrder: Record<string, number> = {
    critical: 0,
    warning: 1,
    info: 2,
    positive: 3,
  };
  allInsights.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  // Generate recommendations based on all insights
  const recommendations = await generateRecommendations(userId, allInsights, months3);

  // Compute views
  const { monthlyView, annualView } = await computeMonthlyVsAnnualView(userId);

  return {
    healthScore,
    insights: allInsights,
    recommendations,
    monthlyView,
    annualView,
  };
}
