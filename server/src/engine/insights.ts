import crypto from 'crypto';
import { db } from '../db/database.js';

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

function computeHealthScore(userId: string): HealthScore {
  const factors: HealthFactor[] = [];

  // --- Savings rate factor (25% weight) ---
  const curStart = getCurrentMonthStart();
  const threeMonthsAgo = getMonthStartNBack(3);
  const income3m = (db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ?`
  ).get(userId, threeMonthsAgo, getCurrentMonthEnd()) as any).total;

  const expenses3m = (db.prepare(
    `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
     WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ?`
  ).get(userId, threeMonthsAgo, getCurrentMonthEnd()) as any).total;

  const savingsRate3m = income3m > 0 ? (income3m - expenses3m) / income3m : 0;
  let savingsScore = 0;
  if (savingsRate3m > 0.20) savingsScore = 100;
  else if (savingsRate3m >= 0.10) savingsScore = 70;
  else if (savingsRate3m >= 0) savingsScore = 40;
  else savingsScore = 0;
  factors.push({ name: 'Savings Rate', score: savingsScore, weight: 0.25 });

  // --- Budget adherence factor (25% weight) ---
  const curMonthPrefix = getMonthPrefix(curStart);
  const budgets = db.prepare(
    `SELECT b.amount, b.category_id, b.rollover_amount
     FROM budgets b
     WHERE b.user_id = ? AND (b.month = ? OR b.month = ?)
     ORDER BY b.amount DESC`
  ).all(userId, curStart, curMonthPrefix) as any[];

  let withinBudget = 0;
  let totalBudgets = budgets.length;
  for (const b of budgets) {
    const spent = (db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as spent FROM transactions
       WHERE user_id = ? AND category_id = ? AND amount < 0
         AND date >= ? AND date <= ?`
    ).get(userId, b.category_id, curStart, getCurrentMonthEnd()) as any).spent;
    const limit = b.amount + (b.rollover_amount || 0);
    if (spent <= limit) withinBudget++;
  }
  const adherenceScore = totalBudgets > 0 ? Math.round((withinBudget / totalBudgets) * 100) : 50;
  factors.push({ name: 'Budget Adherence', score: adherenceScore, weight: 0.25 });

  // --- Debt ratio factor (15% weight) ---
  const assets = (db.prepare(
    `SELECT COALESCE(SUM(balance), 0) as total FROM accounts
     WHERE user_id = ? AND balance > 0`
  ).get(userId) as any).total;

  const liabilities = (db.prepare(
    `SELECT COALESCE(SUM(ABS(balance)), 0) as total FROM accounts
     WHERE user_id = ? AND balance < 0`
  ).get(userId) as any).total;

  const debtRatio = assets > 0 ? liabilities / assets : 1;
  let debtScore = 100;
  if (debtRatio > 0.5) debtScore = 20;
  else if (debtRatio > 0.3) debtScore = 50;
  else if (debtRatio > 0.1) debtScore = 75;
  factors.push({ name: 'Debt Ratio', score: debtScore, weight: 0.15 });

  // --- Emergency fund factor (15% weight) ---
  const avgMonthlyExpenses = expenses3m / 3;
  const targetEmergencyFund = avgMonthlyExpenses * 4.5; // midpoint of 3-6 months
  const savingsBalance = (db.prepare(
    `SELECT COALESCE(SUM(balance), 0) as total FROM accounts
     WHERE user_id = ? AND type = 'savings'`
  ).get(userId) as any).total;

  const emergencyProgress = targetEmergencyFund > 0 ? savingsBalance / targetEmergencyFund : 0;
  const emergencyScore = Math.min(100, Math.round(emergencyProgress * 100));
  factors.push({ name: 'Emergency Fund', score: emergencyScore, weight: 0.15 });

  // --- Income stability factor (10% weight) ---
  const monthlyIncomes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const mStart = getMonthStartNBack(i);
    const mEnd = (() => {
      const parts = mStart.split('-').map(Number);
      const last = new Date(parts[0], parts[1], 0).getDate();
      return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    })();
    const mIncome = (db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
       WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ?`
    ).get(userId, mStart, mEnd) as any).total;
    if (mIncome > 0) monthlyIncomes.push(mIncome);
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
  const goals = db.prepare(
    `SELECT target_amount, current_amount, target_date, is_completed
     FROM goals WHERE user_id = ? AND is_completed = 0`
  ).all(userId) as any[];

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

function analyzeBudgetAdherence(userId: string): Insight[] {
  const insights: Insight[] = [];
  const curStart = getCurrentMonthStart();
  const curEnd = getCurrentMonthEnd();
  const curMonthPrefix = getMonthPrefix(curStart);

  const budgets = db.prepare(
    `SELECT b.*, c.name as category_name
     FROM budgets b
     JOIN categories c ON b.category_id = c.id
     WHERE b.user_id = ? AND (b.month = ? OR b.month = ?)`
  ).all(userId, curStart, curMonthPrefix) as any[];

  for (const b of budgets) {
    const spent = (db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as spent FROM transactions
       WHERE user_id = ? AND category_id = ? AND amount < 0
         AND date >= ? AND date <= ?`
    ).get(userId, b.category_id, curStart, curEnd) as any).spent;

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

function analyzeSpendingTrends(userId: string): Insight[] {
  const insights: Insight[] = [];
  const curStart = getCurrentMonthStart();
  const curEnd = getCurrentMonthEnd();
  const prevStart = getPreviousMonthStart();
  const prevEnd = getPreviousMonthEnd();

  // Get spending by category for current and previous month
  const currentSpending = db.prepare(
    `SELECT c.name as category_name, c.id as category_id,
            COALESCE(SUM(ABS(t.amount)), 0) as spent
     FROM categories c
     LEFT JOIN transactions t ON t.category_id = c.id
       AND t.user_id = ? AND t.amount < 0
       AND t.date >= ? AND t.date <= ?
     WHERE c.user_id = ? AND c.is_income = 0
     GROUP BY c.id, c.name`
  ).all(userId, curStart, curEnd, userId) as any[];

  const previousSpending = db.prepare(
    `SELECT c.id as category_id,
            COALESCE(SUM(ABS(t.amount)), 0) as spent
     FROM categories c
     LEFT JOIN transactions t ON t.category_id = c.id
       AND t.user_id = ? AND t.amount < 0
       AND t.date >= ? AND t.date <= ?
     WHERE c.user_id = ? AND c.is_income = 0
     GROUP BY c.id`
  ).all(userId, prevStart, prevEnd, userId) as any[];

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

function analyzeRecurringCosts(userId: string): Insight[] {
  const insights: Insight[] = [];

  const recurring = db.prepare(
    `SELECT name, amount, frequency, price_history, is_active
     FROM recurring_expenses
     WHERE user_id = ? AND is_active = 1`
  ).all(userId) as any[];

  let monthlyTotal = 0;
  const priceIncreases: { name: string; oldPrice: number; newPrice: number; pctChange: number }[] = [];

  for (const r of recurring) {
    // Normalize to monthly
    let monthly = r.amount;
    if (r.frequency === 'weekly') monthly = r.amount * 4.33;
    else if (r.frequency === 'biweekly') monthly = r.amount * 2.17;
    else if (r.frequency === 'quarterly') monthly = r.amount / 3;
    else if (r.frequency === 'yearly' || r.frequency === 'annual') monthly = r.amount / 12;

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

function analyzeSavingsRate(userId: string): Insight[] {
  const insights: Insight[] = [];
  const threeMonthsAgo = getMonthStartNBack(3);
  const curEnd = getCurrentMonthEnd();

  const income = (db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ?`
  ).get(userId, threeMonthsAgo, curEnd) as any).total;

  const expenses = (db.prepare(
    `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
     WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ?`
  ).get(userId, threeMonthsAgo, curEnd) as any).total;

  const netSavings = income - expenses;
  const savingsRate = income > 0 ? netSavings / income : 0;
  const monthlyNetSavings = netSavings / 3;

  if (savingsRate < 0) {
    insights.push({
      id: crypto.randomUUID(),
      severity: 'critical',
      title: 'Negative savings rate over the last 3 months',
      description: `You are spending more than you earn. Over the past 3 months, expenses (${fmtCurrency(expenses)}) exceeded income (${fmtCurrency(income)}) by ${fmtCurrency(Math.abs(netSavings))}. This trajectory depletes your reserves at ${fmtCurrency(Math.abs(monthlyNetSavings))} per month.`,
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
      description: `Over the last 3 months, you saved ${fmtCurrency(netSavings)} on ${fmtCurrency(income)} in income (${fmtPercent(savingsRate)} rate). Financial planners recommend saving at least 10-20% of gross income. Increasing by just ${fmtCurrency((0.10 * income - netSavings) / 3)} per month would reach the 10% target.`,
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
      description: `Outstanding financial discipline. You saved ${fmtCurrency(netSavings)} over the past 3 months, averaging ${fmtCurrency(monthlyNetSavings)} per month. At this pace, you are building a meaningful financial cushion. Consider allocating surplus savings toward investment accounts for long-term growth.`,
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

function analyzeGoalProgress(userId: string): Insight[] {
  const insights: Insight[] = [];

  const goals = db.prepare(
    `SELECT name, target_amount, current_amount, target_date, icon
     FROM goals WHERE user_id = ? AND is_completed = 0`
  ).all(userId) as any[];

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

      // Check if the user's recent monthly savings can support this
      const threeMonthsAgo = getMonthStartNBack(3);
      const curEnd = getCurrentMonthEnd();
      const recentIncome = (db.prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
         WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ?`
      ).get(userId, threeMonthsAgo, curEnd) as any).total;
      const recentExpenses = (db.prepare(
        `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
         WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ?`
      ).get(userId, threeMonthsAgo, curEnd) as any).total;
      const avgMonthlySurplus = (recentIncome - recentExpenses) / 3;

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

function analyzeInvestments(userId: string): Insight[] {
  const insights: Insight[] = [];

  const investments = db.prepare(
    `SELECT symbol, name, type, shares, cost_basis, current_price
     FROM investments WHERE user_id = ?`
  ).all(userId) as any[];

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

function detectUncategorized(userId: string): Insight[] {
  const insights: Insight[] = [];

  const result = (db.prepare(
    `SELECT COUNT(*) as count FROM transactions
     WHERE user_id = ? AND category_id IS NULL`
  ).get(userId) as any);

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

function generateRecommendations(
  userId: string,
  allInsights: Insight[]
): Recommendation[] {
  const recommendations: Recommendation[] = [];

  // Analyze critical and warning insights to derive recommendations
  const criticals = allInsights.filter((i) => i.severity === 'critical');
  const warnings = allInsights.filter((i) => i.severity === 'warning');

  // Recommendation: If budget overruns exist
  const budgetOverruns = criticals.filter((i) => i.category === 'budgets');
  if (budgetOverruns.length > 0) {
    const estimatedSavings = budgetOverruns.length * 75; // conservative estimate
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Tighten overspent budget categories',
      description: `You have ${budgetOverruns.length} budget categor${budgetOverruns.length === 1 ? 'y' : 'ies'} significantly over limit. Review the largest transactions in each overspent category and identify recurring discretionary purchases that can be reduced or eliminated. Start with the category showing the highest overage.`,
      estimatedSavings,
      priority: 'high',
    });
  }

  // Recommendation: If savings rate is low
  const savingsIssues = allInsights.filter(
    (i) => i.category === 'savings' && (i.severity === 'critical' || i.severity === 'warning')
  );
  if (savingsIssues.length > 0) {
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Boost your savings rate with automated transfers',
      description: 'Set up an automatic transfer of at least 10% of each paycheck directly into a high-yield savings account. By paying yourself first, you remove the temptation to spend before saving. Even a 5% increase in your savings rate compounds dramatically over a decade.',
      estimatedSavings: 200,
      priority: 'high',
    });
  }

  // Recommendation: Recurring cost optimization
  const recurringWarnings = warnings.filter((i) => i.category === 'recurring');
  if (recurringWarnings.length > 0) {
    const annualSavings = recurringWarnings.length * 120;
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Negotiate or replace services with price increases',
      description: `${recurringWarnings.length} of your recurring services have recently increased in price. Contact each provider to negotiate a retention discount, or research competitive alternatives. Many providers offer loyalty discounts when you call to cancel. Bundle services where possible for additional savings.`,
      estimatedSavings: annualSavings,
      priority: 'medium',
    });
  }

  // Recommendation: Spending trends
  const spendingUp = warnings.filter((i) => i.category === 'spending');
  if (spendingUp.length > 0) {
    recommendations.push({
      id: crypto.randomUUID(),
      title: 'Address rising spending categories',
      description: `${spendingUp.length} spending categor${spendingUp.length === 1 ? 'y has' : 'ies have'} increased significantly month-over-month. Implement a 24-hour cooling-off rule for purchases over $50 in these categories. Track each purchase in the moment to build awareness around impulse spending.`,
      estimatedSavings: 150,
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

function computeMonthlyVsAnnualView(userId: string): { monthlyView: PeriodView; annualView: PeriodView } {
  // --- Monthly view (current month) ---
  const curStart = getCurrentMonthStart();
  const curEnd = getCurrentMonthEnd();

  const monthIncome = (db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ?`
  ).get(userId, curStart, curEnd) as any).total;

  const monthExpenses = (db.prepare(
    `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
     WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ?`
  ).get(userId, curStart, curEnd) as any).total;

  // Monthly recurring total (active recurring expenses normalized to monthly)
  const recurringItems = db.prepare(
    `SELECT amount, frequency FROM recurring_expenses
     WHERE user_id = ? AND is_active = 1`
  ).all(userId) as any[];

  let monthRecurring = 0;
  for (const r of recurringItems) {
    let monthly = r.amount;
    if (r.frequency === 'weekly') monthly = r.amount * 4.33;
    else if (r.frequency === 'biweekly') monthly = r.amount * 2.17;
    else if (r.frequency === 'quarterly') monthly = r.amount / 3;
    else if (r.frequency === 'yearly' || r.frequency === 'annual') monthly = r.amount / 12;
    monthRecurring += monthly;
  }

  const monthNet = monthIncome - monthExpenses;
  const monthSavingsRate = monthIncome > 0 ? monthNet / monthIncome : 0;

  const monthlyView: PeriodView = {
    totalIncome: Math.round(monthIncome * 100) / 100,
    totalExpenses: Math.round(monthExpenses * 100) / 100,
    totalRecurring: Math.round(monthRecurring * 100) / 100,
    netCashFlow: Math.round(monthNet * 100) / 100,
    savingsRate: Math.round(monthSavingsRate * 10000) / 10000,
  };

  // --- Annual view (current calendar year) ---
  const yearStart = getAnnualStart();
  const yearEnd = getAnnualEnd();

  const yearIncome = (db.prepare(
    `SELECT COALESCE(SUM(amount), 0) as total FROM transactions
     WHERE user_id = ? AND amount > 0 AND date >= ? AND date <= ?`
  ).get(userId, yearStart, yearEnd) as any).total;

  const yearExpenses = (db.prepare(
    `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
     WHERE user_id = ? AND amount < 0 AND date >= ? AND date <= ?`
  ).get(userId, yearStart, yearEnd) as any).total;

  const annualRecurring = monthRecurring * 12;
  const yearNet = yearIncome - yearExpenses;
  const yearSavingsRate = yearIncome > 0 ? yearNet / yearIncome : 0;

  const annualView: PeriodView = {
    totalIncome: Math.round(yearIncome * 100) / 100,
    totalExpenses: Math.round(yearExpenses * 100) / 100,
    totalRecurring: Math.round(annualRecurring * 100) / 100,
    netCashFlow: Math.round(yearNet * 100) / 100,
    savingsRate: Math.round(yearSavingsRate * 10000) / 10000,
  };

  return { monthlyView, annualView };
}

// ---------------------------------------------------------------------------
// Main: generateInsights
// ---------------------------------------------------------------------------

export function generateInsights(userId: string): InsightsResult {
  // Compute health score
  const healthScore = computeHealthScore(userId);

  // Gather all insights from analysis functions
  const budgetInsights = analyzeBudgetAdherence(userId);
  const spendingInsights = analyzeSpendingTrends(userId);
  const recurringInsights = analyzeRecurringCosts(userId);
  const savingsInsights = analyzeSavingsRate(userId);
  const goalInsights = analyzeGoalProgress(userId);
  const investmentInsights = analyzeInvestments(userId);
  const uncategorizedInsights = detectUncategorized(userId);

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
  const recommendations = generateRecommendations(userId, allInsights);

  // Compute views
  const { monthlyView, annualView } = computeMonthlyVsAnnualView(userId);

  return {
    healthScore,
    insights: allInsights,
    recommendations,
    monthlyView,
    annualView,
  };
}
