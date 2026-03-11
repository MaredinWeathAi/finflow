import crypto from 'crypto';
import { db } from '../db/database.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AccountSummary {
  accountId: string;
  accountName: string;
  accountType: string;
  institution: string;
  balance: number;
  totalInflows: number;
  totalOutflows: number;
  netFlow: number;
  transactionCount: number;
}

interface TransferPair {
  fromAccount: string;
  toAccount: string;
  amount: number;
  date: string;
  description: string;
  status: 'matched' | 'unmatched';
}

interface MerchantSummary {
  name: string;
  totalSpent: number;
  transactionCount: number;
  avgAmount: number;
  firstSeen: string;
  lastSeen: string;
  frequency: string;
  category?: string;
}

interface IncomeSource {
  name: string;
  totalAmount: number;
  count: number;
  avgAmount: number;
  frequency: string;
  isRegular: boolean;
}

interface SpendingPattern {
  type: string;
  title: string;
  description: string;
  amount?: number;
  percentage?: number;
}

interface CashFlowMonth {
  month: string;
  income: number;
  expenses: number;
  transfers: number;
  net: number;
}

export interface FinancialAnalysis {
  // Account-level overview
  accountSummaries: AccountSummary[];
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;

  // Income analysis
  incomeSources: IncomeSource[];
  totalIncome: number;
  avgMonthlyIncome: number;

  // Expense analysis
  topMerchants: MerchantSummary[];
  totalExpenses: number;
  avgMonthlyExpenses: number;

  // Transfer analysis
  transfers: TransferPair[];
  totalInternalTransfers: number;
  transferCount: number;

  // Cash flow
  monthlyCashFlow: CashFlowMonth[];

  // Spending patterns
  patterns: SpendingPattern[];

  // Summary narrative
  narrative: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtCurrency(amount: number): string {
  return `$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function detectFrequency(dates: string[]): string {
  if (dates.length < 2) return 'one-time';

  const sorted = dates.sort();
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d1 = new Date(sorted[i - 1]);
    const d2 = new Date(sorted[i]);
    gaps.push((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
  }

  const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

  if (avgGap < 10) return 'weekly';
  if (avgGap < 18) return 'bi-weekly';
  if (avgGap < 40) return 'monthly';
  if (avgGap < 100) return 'quarterly';
  return 'irregular';
}

// ---------------------------------------------------------------------------
// Account Analysis
// ---------------------------------------------------------------------------

function analyzeAccounts(userId: string): { summaries: AccountSummary[]; totalAssets: number; totalLiabilities: number } {
  const accounts = db.prepare(
    `SELECT id, name, type, institution, balance FROM accounts WHERE user_id = ?`
  ).all(userId) as any[];

  const summaries: AccountSummary[] = [];
  let totalAssets = 0;
  let totalLiabilities = 0;

  for (const acct of accounts) {
    const inflows = (db.prepare(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as cnt FROM transactions
       WHERE user_id = ? AND account_id = ? AND amount > 0`
    ).get(userId, acct.id) as any);

    const outflows = (db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total, COUNT(*) as cnt FROM transactions
       WHERE user_id = ? AND account_id = ? AND amount < 0`
    ).get(userId, acct.id) as any);

    summaries.push({
      accountId: acct.id,
      accountName: acct.name,
      accountType: acct.type,
      institution: acct.institution || '',
      balance: acct.balance,
      totalInflows: inflows.total,
      totalOutflows: outflows.total,
      netFlow: inflows.total - outflows.total,
      transactionCount: inflows.cnt + outflows.cnt,
    });

    if (acct.balance >= 0) {
      totalAssets += acct.balance;
    } else {
      totalLiabilities += Math.abs(acct.balance);
    }
  }

  return { summaries, totalAssets, totalLiabilities };
}

// ---------------------------------------------------------------------------
// Income Analysis
// ---------------------------------------------------------------------------

function analyzeIncome(userId: string): { sources: IncomeSource[]; total: number; avgMonthly: number } {
  // Get all income transactions (positive amounts)
  const incomeTransactions = db.prepare(
    `SELECT name, amount, date FROM transactions
     WHERE user_id = ? AND amount > 0
     ORDER BY date DESC`
  ).all(userId) as any[];

  // Group by normalized merchant name
  const grouped = new Map<string, { amounts: number[]; dates: string[] }>();

  for (const txn of incomeTransactions) {
    const key = txn.name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!grouped.has(key)) {
      grouped.set(key, { amounts: [], dates: [] });
    }
    grouped.get(key)!.amounts.push(txn.amount);
    grouped.get(key)!.dates.push(txn.date);
  }

  const sources: IncomeSource[] = [];
  let total = 0;

  for (const [name, data] of grouped) {
    const totalAmount = data.amounts.reduce((a, b) => a + b, 0);
    const avgAmount = totalAmount / data.amounts.length;
    const frequency = detectFrequency(data.dates);
    const isRegular = ['weekly', 'bi-weekly', 'monthly'].includes(frequency) && data.amounts.length >= 2;

    total += totalAmount;
    sources.push({
      name: incomeTransactions.find(t => t.name.toLowerCase().replace(/\s+/g, ' ').trim() === name)?.name || name,
      totalAmount,
      count: data.amounts.length,
      avgAmount: Math.round(avgAmount * 100) / 100,
      frequency,
      isRegular,
    });
  }

  sources.sort((a, b) => b.totalAmount - a.totalAmount);

  // Calculate avg monthly based on date range
  const dateRange = db.prepare(
    `SELECT MIN(date) as minDate, MAX(date) as maxDate FROM transactions WHERE user_id = ? AND amount > 0`
  ).get(userId) as any;

  let months = 1;
  if (dateRange.minDate && dateRange.maxDate) {
    const d1 = new Date(dateRange.minDate);
    const d2 = new Date(dateRange.maxDate);
    months = Math.max(1, Math.ceil((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
  }

  return { sources: sources.slice(0, 20), total, avgMonthly: total / months };
}

// ---------------------------------------------------------------------------
// Merchant / Expense Analysis
// ---------------------------------------------------------------------------

function analyzeExpenses(userId: string): { merchants: MerchantSummary[]; total: number; avgMonthly: number } {
  const expenses = db.prepare(
    `SELECT t.name, t.amount, t.date, c.name as category_name
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? AND t.amount < 0
     ORDER BY t.date DESC`
  ).all(userId) as any[];

  const grouped = new Map<string, { amounts: number[]; dates: string[]; category?: string }>();

  for (const txn of expenses) {
    const key = txn.name.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!grouped.has(key)) {
      grouped.set(key, { amounts: [], dates: [], category: txn.category_name });
    }
    grouped.get(key)!.amounts.push(Math.abs(txn.amount));
    grouped.get(key)!.dates.push(txn.date);
  }

  const merchants: MerchantSummary[] = [];
  let total = 0;

  for (const [name, data] of grouped) {
    const totalSpent = data.amounts.reduce((a, b) => a + b, 0);
    const avgAmount = totalSpent / data.amounts.length;
    const dates = data.dates.sort();

    total += totalSpent;
    merchants.push({
      name: expenses.find(t => t.name.toLowerCase().replace(/\s+/g, ' ').trim() === name)?.name || name,
      totalSpent: Math.round(totalSpent * 100) / 100,
      transactionCount: data.amounts.length,
      avgAmount: Math.round(avgAmount * 100) / 100,
      firstSeen: dates[0],
      lastSeen: dates[dates.length - 1],
      frequency: detectFrequency(data.dates),
      category: data.category,
    });
  }

  merchants.sort((a, b) => b.totalSpent - a.totalSpent);

  const dateRange = db.prepare(
    `SELECT MIN(date) as minDate, MAX(date) as maxDate FROM transactions WHERE user_id = ? AND amount < 0`
  ).get(userId) as any;

  let months = 1;
  if (dateRange.minDate && dateRange.maxDate) {
    const d1 = new Date(dateRange.minDate);
    const d2 = new Date(dateRange.maxDate);
    months = Math.max(1, Math.ceil((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24 * 30.44)));
  }

  return { merchants: merchants.slice(0, 30), total, avgMonthly: total / months };
}

// ---------------------------------------------------------------------------
// Transfer Analysis
// ---------------------------------------------------------------------------

function analyzeTransfers(userId: string): { transfers: TransferPair[]; total: number; count: number } {
  // Find transactions with transfer-like names
  const transferKeywords = [
    'transfer', 'xfer', 'online banking transfer', 'ach transfer',
    'wire', 'zelle', 'venmo', 'paypal transfer', 'internal transfer',
    'from savings', 'to savings', 'from checking', 'to checking',
    'mobile transfer', 'funds transfer',
  ];

  const allTransactions = db.prepare(
    `SELECT t.id, t.name, t.amount, t.date, t.account_id, t.notes,
            a.name as account_name, a.type as account_type
     FROM transactions t
     JOIN accounts a ON t.account_id = a.id
     WHERE t.user_id = ?
     ORDER BY t.date DESC, ABS(t.amount) DESC`
  ).all(userId) as any[];

  const transfers: TransferPair[] = [];
  const matched = new Set<string>();
  let total = 0;

  // Find matching pairs (same absolute amount, opposite signs, within 3 days)
  for (let i = 0; i < allTransactions.length; i++) {
    const txn = allTransactions[i];
    if (matched.has(txn.id)) continue;

    const isTransferLike = transferKeywords.some(kw => txn.name.toLowerCase().includes(kw));
    if (!isTransferLike) continue;

    // Look for matching opposite transaction
    for (let j = i + 1; j < allTransactions.length; j++) {
      const other = allTransactions[j];
      if (matched.has(other.id)) continue;
      if (other.account_id === txn.account_id) continue;

      const amtMatch = Math.abs(Math.abs(txn.amount) - Math.abs(other.amount)) < 0.01;
      const oppositeSign = (txn.amount > 0 && other.amount < 0) || (txn.amount < 0 && other.amount > 0);

      if (amtMatch && oppositeSign) {
        const d1 = new Date(txn.date);
        const d2 = new Date(other.date);
        const daysDiff = Math.abs(d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24);

        if (daysDiff <= 3) {
          matched.add(txn.id);
          matched.add(other.id);

          const from = txn.amount < 0 ? txn : other;
          const to = txn.amount > 0 ? txn : other;

          transfers.push({
            fromAccount: from.account_name,
            toAccount: to.account_name,
            amount: Math.abs(from.amount),
            date: from.date,
            description: from.name,
            status: 'matched',
          });

          total += Math.abs(from.amount);
          break;
        }
      }
    }

    // If no match found, it's an unmatched transfer
    if (!matched.has(txn.id)) {
      matched.add(txn.id);
      transfers.push({
        fromAccount: txn.amount < 0 ? txn.account_name : 'External',
        toAccount: txn.amount > 0 ? txn.account_name : 'External',
        amount: Math.abs(txn.amount),
        date: txn.date,
        description: txn.name,
        status: 'unmatched',
      });
      total += Math.abs(txn.amount);
    }
  }

  return { transfers: transfers.slice(0, 50), total, count: transfers.length };
}

// ---------------------------------------------------------------------------
// Monthly Cash Flow
// ---------------------------------------------------------------------------

function computeMonthlyCashFlow(userId: string): CashFlowMonth[] {
  const rows = db.prepare(
    `SELECT
       substr(date, 1, 7) as month,
       SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
       SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
     FROM transactions
     WHERE user_id = ?
     GROUP BY substr(date, 1, 7)
     ORDER BY month DESC
     LIMIT 12`
  ).all(userId) as any[];

  // Get transfer amounts per month
  const transferKeywords = ['transfer', 'xfer', 'internal', 'from savings', 'to savings', 'from checking', 'to checking'];

  return rows.map(r => {
    const transferAmount = (db.prepare(
      `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions
       WHERE user_id = ? AND substr(date, 1, 7) = ? AND (
         ${transferKeywords.map(() => 'LOWER(name) LIKE ?').join(' OR ')}
       )`
    ).get(userId, r.month, ...transferKeywords.map(k => `%${k}%`)) as any).total;

    return {
      month: r.month,
      income: Math.round(r.income * 100) / 100,
      expenses: Math.round(r.expenses * 100) / 100,
      transfers: Math.round(transferAmount * 100) / 100,
      net: Math.round((r.income - r.expenses) * 100) / 100,
    };
  }).reverse();
}

// ---------------------------------------------------------------------------
// Spending Patterns
// ---------------------------------------------------------------------------

function detectPatterns(
  userId: string,
  merchants: MerchantSummary[],
  incomeSources: IncomeSource[],
  monthlyCashFlow: CashFlowMonth[],
): SpendingPattern[] {
  const patterns: SpendingPattern[] = [];

  // 1. Fixed vs variable spending ratio
  const fixedMerchants = merchants.filter(m => ['weekly', 'bi-weekly', 'monthly'].includes(m.frequency));
  const fixedTotal = fixedMerchants.reduce((s, m) => s + m.totalSpent, 0);
  const variableTotal = merchants.reduce((s, m) => s + m.totalSpent, 0) - fixedTotal;
  const totalSpending = fixedTotal + variableTotal;

  if (totalSpending > 0) {
    const fixedPct = fixedTotal / totalSpending;
    patterns.push({
      type: 'fixed-vs-variable',
      title: 'Fixed vs Variable Spending',
      description: `${(fixedPct * 100).toFixed(0)}% of your spending (${fmtCurrency(fixedTotal)}) is recurring/fixed costs, while ${((1 - fixedPct) * 100).toFixed(0)}% (${fmtCurrency(variableTotal)}) is variable. ${fixedPct > 0.7 ? 'Your high fixed costs leave less room for discretionary cuts. Focus on renegotiating or eliminating recurring services.' : 'You have flexibility in your variable spending to optimize savings.'}`,
      amount: fixedTotal,
      percentage: fixedPct,
    });
  }

  // 2. Top category concentration
  const categorySpending = db.prepare(
    `SELECT c.name, SUM(ABS(t.amount)) as total
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? AND t.amount < 0
     GROUP BY c.id
     ORDER BY total DESC
     LIMIT 5`
  ).all(userId) as any[];

  if (categorySpending.length >= 3 && totalSpending > 0) {
    const top3Total = categorySpending.slice(0, 3).reduce((s: number, c: any) => s + c.total, 0);
    const top3Pct = top3Total / totalSpending;
    const top3Names = categorySpending.slice(0, 3).map((c: any) => c.name).join(', ');
    patterns.push({
      type: 'category-concentration',
      title: 'Spending Concentration',
      description: `Your top 3 categories (${top3Names}) account for ${(top3Pct * 100).toFixed(0)}% of all spending. ${top3Pct > 0.7 ? 'High concentration means small changes in these categories have outsized impact on your budget.' : 'Your spending is relatively diversified across categories.'}`,
      percentage: top3Pct,
    });
  }

  // 3. Income regularity
  const regularIncome = incomeSources.filter(s => s.isRegular);
  const totalRegularIncome = regularIncome.reduce((s, i) => s + i.totalAmount, 0);
  const totalAllIncome = incomeSources.reduce((s, i) => s + i.totalAmount, 0);

  if (totalAllIncome > 0) {
    const regularPct = totalRegularIncome / totalAllIncome;
    patterns.push({
      type: 'income-regularity',
      title: 'Income Regularity',
      description: `${(regularPct * 100).toFixed(0)}% of your income (${fmtCurrency(totalRegularIncome)}) comes from regular, predictable sources. ${regularPct > 0.8 ? 'Your stable income base supports confident budgeting and planning.' : 'With significant irregular income, consider budgeting conservatively based on your regular income only.'}`,
      percentage: regularPct,
    });
  }

  // 4. Month-over-month trend
  if (monthlyCashFlow.length >= 3) {
    const recent = monthlyCashFlow.slice(-3);
    const nets = recent.map(m => m.net);
    const isImproving = nets[2] > nets[1] && nets[1] > nets[0];
    const isDeclining = nets[2] < nets[1] && nets[1] < nets[0];

    if (isImproving) {
      patterns.push({
        type: 'trend-improving',
        title: 'Cash Flow Improving',
        description: `Your net cash flow has improved for 3 consecutive months: ${recent.map(m => `${m.month}: ${fmtCurrency(m.net)}`).join(' → ')}. This positive trajectory suggests your financial habits are strengthening.`,
        amount: nets[2],
      });
    } else if (isDeclining) {
      patterns.push({
        type: 'trend-declining',
        title: 'Cash Flow Declining',
        description: `Your net cash flow has declined for 3 consecutive months: ${recent.map(m => `${m.month}: ${m.net >= 0 ? '+' : '-'}${fmtCurrency(m.net)}`).join(' → ')}. Review recent spending increases and income changes to reverse this trend.`,
        amount: nets[2],
      });
    }
  }

  // 5. Large transaction detection
  const largeTxns = (db.prepare(
    `SELECT COUNT(*) as cnt, SUM(ABS(amount)) as total FROM transactions
     WHERE user_id = ? AND ABS(amount) > 500`
  ).get(userId) as any);

  if (largeTxns.cnt > 0) {
    patterns.push({
      type: 'large-transactions',
      title: 'Large Transactions',
      description: `You have ${largeTxns.cnt} transactions over $500 totaling ${fmtCurrency(largeTxns.total)}. Large infrequent expenses can skew monthly budgets. Consider setting aside a monthly buffer for irregular large expenses.`,
      amount: largeTxns.total,
    });
  }

  return patterns;
}

// ---------------------------------------------------------------------------
// Generate Narrative Summary
// ---------------------------------------------------------------------------

function generateNarrative(
  accountSummaries: AccountSummary[],
  incomeSources: IncomeSource[],
  merchants: MerchantSummary[],
  transfers: TransferPair[],
  monthlyCashFlow: CashFlowMonth[],
  totalAssets: number,
  totalLiabilities: number,
): string[] {
  const narrative: string[] = [];

  // Net worth
  const netWorth = totalAssets - totalLiabilities;
  narrative.push(
    `Your current net worth across ${accountSummaries.length} account${accountSummaries.length !== 1 ? 's' : ''} is ${fmtCurrency(netWorth)} (${fmtCurrency(totalAssets)} in assets, ${fmtCurrency(totalLiabilities)} in liabilities).`
  );

  // Income summary
  const regularSources = incomeSources.filter(s => s.isRegular);
  if (regularSources.length > 0) {
    const primaryIncome = regularSources[0];
    narrative.push(
      `Your primary income source is "${primaryIncome.name}" contributing ${fmtCurrency(primaryIncome.avgAmount)} on a ${primaryIncome.frequency} basis. You have ${regularSources.length} regular income source${regularSources.length !== 1 ? 's' : ''}.`
    );
  }

  // Top spending
  if (merchants.length > 0) {
    const top3 = merchants.slice(0, 3);
    narrative.push(
      `Your top spending merchants are: ${top3.map(m => `${m.name} (${fmtCurrency(m.totalSpent)}, ${m.transactionCount} txns)`).join('; ')}.`
    );
  }

  // Transfers
  const matchedTransfers = transfers.filter(t => t.status === 'matched');
  const unmatchedTransfers = transfers.filter(t => t.status === 'unmatched');
  if (transfers.length > 0) {
    narrative.push(
      `The system detected ${transfers.length} transfer${transfers.length !== 1 ? 's' : ''} between accounts: ${matchedTransfers.length} matched pairs and ${unmatchedTransfers.length} unmatched. Transfers are excluded from income/expense calculations to avoid double-counting.`
    );
  }

  // Cash flow trend
  if (monthlyCashFlow.length >= 2) {
    const latest = monthlyCashFlow[monthlyCashFlow.length - 1];
    const previous = monthlyCashFlow[monthlyCashFlow.length - 2];
    const trend = latest.net > previous.net ? 'improved' : latest.net < previous.net ? 'declined' : 'held steady';
    narrative.push(
      `Your most recent month (${latest.month}) shows ${fmtCurrency(latest.income)} income, ${fmtCurrency(latest.expenses)} expenses, resulting in ${latest.net >= 0 ? 'a surplus' : 'a deficit'} of ${fmtCurrency(latest.net)}. This ${trend} from the prior month.`
    );
  }

  return narrative;
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

export function generateFinancialAnalysis(userId: string): FinancialAnalysis {
  // Account analysis
  const { summaries: accountSummaries, totalAssets, totalLiabilities } = analyzeAccounts(userId);

  // Income analysis
  const { sources: incomeSources, total: totalIncome, avgMonthly: avgMonthlyIncome } = analyzeIncome(userId);

  // Expense analysis
  const { merchants: topMerchants, total: totalExpenses, avgMonthly: avgMonthlyExpenses } = analyzeExpenses(userId);

  // Transfer analysis
  const { transfers, total: totalInternalTransfers, count: transferCount } = analyzeTransfers(userId);

  // Monthly cash flow
  const monthlyCashFlow = computeMonthlyCashFlow(userId);

  // Patterns
  const patterns = detectPatterns(userId, topMerchants, incomeSources, monthlyCashFlow);

  // Narrative
  const narrative = generateNarrative(
    accountSummaries,
    incomeSources,
    topMerchants,
    transfers,
    monthlyCashFlow,
    totalAssets,
    totalLiabilities,
  );

  return {
    accountSummaries,
    totalAssets: Math.round(totalAssets * 100) / 100,
    totalLiabilities: Math.round(totalLiabilities * 100) / 100,
    netWorth: Math.round((totalAssets - totalLiabilities) * 100) / 100,
    incomeSources,
    totalIncome: Math.round(totalIncome * 100) / 100,
    avgMonthlyIncome: Math.round(avgMonthlyIncome * 100) / 100,
    topMerchants,
    totalExpenses: Math.round(totalExpenses * 100) / 100,
    avgMonthlyExpenses: Math.round(avgMonthlyExpenses * 100) / 100,
    transfers,
    totalInternalTransfers: Math.round(totalInternalTransfers * 100) / 100,
    transferCount,
    monthlyCashFlow,
    patterns,
    narrative,
  };
}
