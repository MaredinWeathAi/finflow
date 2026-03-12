import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

const LIABILITY_TYPES = ['credit', 'loan', 'mortgage'];

/**
 * Round to 2 decimal places to avoid floating-point artifacts
 * like 112791.15999999999 in monetary values.
 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Calculate net worth correctly, avoiding double-counting.
 *
 * Investment-type accounts whose balance mirrors linked holdings
 * must NOT be counted separately from the investment portfolio.
 * We detect this by checking which account IDs have linked investments.
 */
function calculateNetWorth(
  accounts: any[],
  investments: any[]
): {
  netWorth: number;
  totalAssets: number;
  totalLiabilities: number;
  investmentPortfolioValue: number;
  cashAssets: number;
  assetsByType: Record<string, number>;
  liabilitiesByType: Record<string, number>;
} {
  // Build set of account IDs that have linked investment holdings
  const investmentAccountIds = new Set<string>();
  for (const inv of investments) {
    if (inv.account_id) investmentAccountIds.add(inv.account_id);
  }

  // Assets: include all non-liability, non-investment-linked accounts
  let cashAssets = 0;
  const assetsByType: Record<string, number> = {};

  for (const account of accounts) {
    if (LIABILITY_TYPES.includes(account.type)) continue;
    if (investmentAccountIds.has(account.id)) continue; // skip — value comes from holdings
    if (account.balance <= 0) continue;

    cashAssets += account.balance;
    assetsByType[account.type] = (assetsByType[account.type] || 0) + account.balance;
  }

  // Investment portfolio value from individual holdings (single source of truth)
  let investmentPortfolioValue = 0;
  for (const inv of investments) {
    investmentPortfolioValue += inv.shares * inv.current_price;
  }

  if (investmentPortfolioValue > 0) {
    assetsByType['investment_portfolio'] = round2(investmentPortfolioValue);
  }

  const totalAssets = round2(cashAssets + investmentPortfolioValue);

  // Liabilities
  let totalLiabilities = 0;
  const liabilitiesByType: Record<string, number> = {};

  for (const account of accounts) {
    if (account.type === 'credit' || (LIABILITY_TYPES.includes(account.type) && account.balance !== 0)) {
      const liabilityAmount = Math.abs(account.balance);
      totalLiabilities += liabilityAmount;
      liabilitiesByType[account.type] = (liabilitiesByType[account.type] || 0) + liabilityAmount;
    }
  }

  totalLiabilities = round2(totalLiabilities);
  const netWorth = round2(totalAssets - totalLiabilities);

  return {
    netWorth,
    totalAssets,
    totalLiabilities,
    investmentPortfolioValue: round2(investmentPortfolioValue),
    cashAssets: round2(cashAssets),
    assetsByType,
    liabilitiesByType,
  };
}

// Helper: Get current month in YYYY-MM format
function getCurrentMonth(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// Helper: Get month start and end dates
function getMonthBounds(monthStr: string): { monthStart: string; monthEnd: string } {
  const [year, month] = monthStr.split('-');
  const monthStart = `${monthStr}-01`;
  const date = new Date(parseInt(year), parseInt(month), 0);
  const monthEnd = `${monthStr}-${String(date.getDate()).padStart(2, '0')}`;
  return { monthStart, monthEnd };
}

// GET /client-profile - Returns client info (user profile, accounts summary)
router.get('/client-profile', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Get user info
    const user = db
      .prepare('SELECT id, name, email, role FROM users WHERE id = ?')
      .get(userId) as any;

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Get accounts summary
    const accounts = db
      .prepare(
        `SELECT id, name, type, institution, balance, last_four, icon, is_hidden
         FROM accounts WHERE user_id = ?
         ORDER BY created_at DESC`
      )
      .all(userId) as any[];

    // Get account count by type
    const accountsByType = accounts.reduce(
      (acc: any, account: any) => {
        if (!acc[account.type]) {
          acc[account.type] = 0;
        }
        acc[account.type]++;
        return acc;
      },
      {}
    );

    res.json({
      profile: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      accounts: {
        total: accounts.length,
        byType: accountsByType,
        list: accounts,
      },
    });
  } catch (error) {
    console.error('Get client profile error:', error);
    res.status(500).json({ error: 'Failed to get client profile' });
  }
});

// GET /living-expenses - Returns current month's expenses by category + recurring expenses
router.get('/living-expenses', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const currentMonth = getCurrentMonth();
    const { monthStart, monthEnd } = getMonthBounds(currentMonth);

    // Get current month transactions
    const transactions = db
      .prepare(
        `SELECT t.id, t.amount, t.category_id, t.name, t.date,
                c.name as category_name, c.icon as category_icon, c.color as category_color
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.date BETWEEN ? AND ? AND t.amount < 0
         ORDER BY t.date DESC`
      )
      .all(userId, monthStart, monthEnd) as any[];

    // Get recurring expenses
    const recurring = db
      .prepare(
        `SELECT r.id, r.name, r.amount, r.category_id, r.frequency, r.next_date, r.is_active,
                c.name as category_name, c.icon as category_icon, c.color as category_color
         FROM recurring_expenses r
         LEFT JOIN categories c ON r.category_id = c.id
         WHERE r.user_id = ? AND r.is_active = 1
         ORDER BY r.next_date ASC`
      )
      .all(userId) as any[];

    // Group transactions by category
    const expensesByCategory: any = {};
    let totalExpenses = 0;

    for (const tx of transactions) {
      const categoryName = tx.category_name || 'Uncategorized';
      const amount = Math.abs(tx.amount);

      if (!expensesByCategory[categoryName]) {
        expensesByCategory[categoryName] = {
          name: categoryName,
          icon: tx.category_icon,
          color: tx.category_color,
          total: 0,
          transactions: [],
        };
      }

      expensesByCategory[categoryName].total += amount;
      expensesByCategory[categoryName].transactions.push({
        id: tx.id,
        name: tx.name,
        amount: amount,
        date: tx.date,
      });

      totalExpenses += amount;
    }

    // Group recurring by category
    const recurringByCategory: any = {};
    let totalRecurring = 0;

    for (const rec of recurring) {
      const categoryName = rec.category_name || 'Uncategorized';
      const amount = Math.abs(rec.amount);

      if (!recurringByCategory[categoryName]) {
        recurringByCategory[categoryName] = {
          name: categoryName,
          icon: rec.category_icon,
          color: rec.category_color,
          total: 0,
          expenses: [],
        };
      }

      recurringByCategory[categoryName].total += amount;
      recurringByCategory[categoryName].expenses.push({
        id: rec.id,
        name: rec.name,
        amount: amount,
        frequency: rec.frequency,
        nextDate: rec.next_date,
      });

      totalRecurring += amount;
    }

    res.json({
      month: currentMonth,
      summary: {
        totalThisMonth: totalExpenses,
        totalRecurring: totalRecurring,
        combined: totalExpenses + totalRecurring,
      },
      byCategory: expensesByCategory,
      recurring: recurringByCategory,
    });
  } catch (error) {
    console.error('Get living expenses error:', error);
    res.status(500).json({ error: 'Failed to get living expenses' });
  }
});

// GET /goals-summary - Returns all goals with progress
router.get('/goals-summary', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const goals = db
      .prepare(
        `SELECT id, name, target_amount, current_amount, target_date, icon, color, is_completed
         FROM goals
         WHERE user_id = ?
         ORDER BY is_completed ASC, target_date ASC`
      )
      .all(userId) as any[];

    const summary = goals.map((goal: any) => ({
      ...goal,
      progress: goal.target_amount > 0 ? goal.current_amount / goal.target_amount : 0,
      progressPercent:
        goal.target_amount > 0 ? Math.round((goal.current_amount / goal.target_amount) * 100) : 0,
      remainingAmount: Math.max(0, goal.target_amount - goal.current_amount),
    }));

    const stats = {
      total: goals.length,
      completed: goals.filter((g: any) => g.is_completed).length,
      active: goals.filter((g: any) => !g.is_completed).length,
      totalTargetAmount: goals.reduce((sum: number, g: any) => sum + g.target_amount, 0),
      totalCurrentAmount: goals.reduce((sum: number, g: any) => sum + g.current_amount, 0),
    };

    res.json({
      goals: summary,
      stats,
    });
  } catch (error) {
    console.error('Get goals summary error:', error);
    res.status(500).json({ error: 'Failed to get goals summary' });
  }
});

// GET /investments-portfolio - Returns investments with current values and allocation
router.get('/investments-portfolio', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const investments = db
      .prepare(
        `SELECT i.id, i.symbol, i.name, i.type, i.shares, i.cost_basis, i.current_price, i.last_updated,
                a.name as account_name, a.id as account_id
         FROM investments i
         LEFT JOIN accounts a ON i.account_id = a.id
         WHERE i.user_id = ?
         ORDER BY i.name ASC`
      )
      .all(userId) as any[];

    // Calculate values for each investment
    const investmentDetails = investments.map((inv: any) => {
      const currentValue = inv.shares * inv.current_price;
      const totalCostBasis = inv.shares * inv.cost_basis;
      const gainLoss = currentValue - totalCostBasis;
      const gainLossPercent =
        totalCostBasis > 0 ? (gainLoss / totalCostBasis) * 100 : 0;

      return {
        ...inv,
        currentValue,
        totalCostBasis,
        gainLoss,
        gainLossPercent: Math.round(gainLossPercent * 100) / 100,
      };
    });

    // Calculate totals and allocation by type
    const totalCurrentValue = investmentDetails.reduce(
      (sum: number, inv: any) => sum + inv.currentValue,
      0
    );
    const totalCostBasis = investmentDetails.reduce(
      (sum: number, inv: any) => sum + inv.totalCostBasis,
      0
    );
    const totalGainLoss = totalCurrentValue - totalCostBasis;

    // Allocation by type
    const allocationByType: any = {};
    for (const inv of investmentDetails) {
      if (!allocationByType[inv.type]) {
        allocationByType[inv.type] = {
          type: inv.type,
          totalValue: 0,
          count: 0,
          investments: [],
        };
      }
      allocationByType[inv.type].totalValue += inv.currentValue;
      allocationByType[inv.type].count++;
      allocationByType[inv.type].investments.push(inv);
    }

    // Add allocation percentages
    for (const type in allocationByType) {
      allocationByType[type].allocationPercent =
        totalCurrentValue > 0
          ? Math.round((allocationByType[type].totalValue / totalCurrentValue) * 100)
          : 0;
    }

    res.json({
      investments: investmentDetails,
      summary: {
        totalCurrentValue,
        totalCostBasis,
        totalGainLoss,
        totalGainLossPercent:
          totalCostBasis > 0
            ? Math.round((totalGainLoss / totalCostBasis) * 10000) / 100
            : 0,
        count: investmentDetails.length,
      },
      allocationByType,
    });
  } catch (error) {
    console.error('Get investments portfolio error:', error);
    res.status(500).json({ error: 'Failed to get investments portfolio' });
  }
});

// GET /liabilities - Returns credit accounts and loans (negative balances)
router.get('/liabilities', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const liabilities = db
      .prepare(
        `SELECT id, name, type, institution, balance, last_four, icon
         FROM accounts
         WHERE user_id = ? AND (type = 'credit' OR balance < 0)
         ORDER BY type ASC, name ASC`
      )
      .all(userId) as any[];

    // Calculate summary
    const summary = {
      totalLiabilities: 0,
      byType: {} as any,
    };

    const liabilityDetails = liabilities.map((account: any) => {
      const liabilityAmount = Math.abs(account.balance);
      summary.totalLiabilities += liabilityAmount;

      if (!summary.byType[account.type]) {
        summary.byType[account.type] = {
          type: account.type,
          total: 0,
          count: 0,
        };
      }
      summary.byType[account.type].total += liabilityAmount;
      summary.byType[account.type].count++;

      return {
        ...account,
        liabilityAmount,
      };
    });

    res.json({
      liabilities: liabilityDetails,
      summary,
    });
  } catch (error) {
    console.error('Get liabilities error:', error);
    res.status(500).json({ error: 'Failed to get liabilities' });
  }
});

// GET /assets - Returns all positive-balance accounts plus investment portfolio value (no double-counting)
router.get('/assets', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Get all non-liability accounts with positive balances
    const accounts = db
      .prepare(
        `SELECT id, name, type, institution, balance, last_four, icon
         FROM accounts
         WHERE user_id = ? AND type NOT IN ('credit', 'loan', 'mortgage') AND balance > 0
         ORDER BY type ASC, name ASC`
      )
      .all(userId) as any[];

    // Get investments with account linkage
    const investments = db
      .prepare(
        `SELECT i.id, i.symbol, i.name, i.shares, i.current_price, i.account_id
         FROM investments i
         WHERE i.user_id = ?`
      )
      .all(userId) as any[];

    // Build set of account IDs that have linked investment holdings
    const investmentAccountIds = new Set<string>();
    for (const inv of investments) {
      if (inv.account_id) investmentAccountIds.add(inv.account_id);
    }

    const investmentPortfolioValue = round2(
      investments.reduce((sum: number, inv: any) => sum + inv.shares * inv.current_price, 0)
    );

    // Separate cash accounts from investment-linked accounts
    const cashAccounts = accounts.filter(a => !investmentAccountIds.has(a.id));
    const totalCashBalance = round2(cashAccounts.reduce((sum: number, acc: any) => sum + acc.balance, 0));
    const totalAssets = round2(totalCashBalance + investmentPortfolioValue);

    // Summary by type (cash accounts only — investments shown separately)
    const byType: any = {};
    for (const account of cashAccounts) {
      if (!byType[account.type]) {
        byType[account.type] = { type: account.type, total: 0, count: 0 };
      }
      byType[account.type].total += account.balance;
      byType[account.type].count++;
    }
    if (investmentPortfolioValue > 0) {
      byType['investment_portfolio'] = {
        type: 'investment_portfolio',
        total: investmentPortfolioValue,
        count: investments.length,
      };
    }

    res.json({
      accounts: cashAccounts.map((account: any) => ({
        ...account,
        assetValue: account.balance,
        assetType: 'account',
      })),
      investments: {
        count: investments.length,
        totalValue: investmentPortfolioValue,
        investments,
      },
      summary: {
        totalAssets,
        cashBalance: totalCashBalance,
        investmentValue: investmentPortfolioValue,
        byType,
      },
    });
  } catch (error) {
    console.error('Get assets error:', error);
    res.status(500).json({ error: 'Failed to get assets' });
  }
});

// GET /net-worth - Comprehensive net worth calculation (no double-counting)
router.get('/net-worth', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const accounts = db
      .prepare('SELECT id, name, type, balance FROM accounts WHERE user_id = ?')
      .all(userId) as any[];

    const investments = db
      .prepare('SELECT account_id, shares, current_price FROM investments WHERE user_id = ?')
      .all(userId) as any[];

    const nw = calculateNetWorth(accounts, investments);

    res.json({
      netWorth: nw.netWorth,
      totalAssets: nw.totalAssets,
      totalLiabilities: nw.totalLiabilities,
      investmentPortfolioValue: nw.investmentPortfolioValue,
      cashAssets: nw.cashAssets,
      breakdown: {
        assets: {
          total: nw.totalAssets,
          byType: nw.assetsByType,
        },
        liabilities: {
          total: nw.totalLiabilities,
          byType: nw.liabilitiesByType,
        },
      },
    });
  } catch (error) {
    console.error('Get net worth error:', error);
    res.status(500).json({ error: 'Failed to get net worth' });
  }
});

// GET /comprehensive - Returns everything combined for financial planning software
router.get('/comprehensive', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const currentMonth = getCurrentMonth();
    const { monthStart, monthEnd } = getMonthBounds(currentMonth);

    // 1. User profile
    const user = db
      .prepare('SELECT id, name, email, role FROM users WHERE id = ?')
      .get(userId) as any;

    // 2. Accounts
    const accounts = db
      .prepare(
        `SELECT id, name, type, institution, balance, last_four, icon, is_hidden
         FROM accounts WHERE user_id = ?
         ORDER BY created_at DESC`
      )
      .all(userId) as any[];

    // 3. Current month transactions
    const transactions = db
      .prepare(
        `SELECT t.id, t.amount, t.category_id, t.name, t.date,
                c.name as category_name, c.icon as category_icon, c.color as category_color
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.date BETWEEN ? AND ?
         ORDER BY t.date DESC`
      )
      .all(userId, monthStart, monthEnd) as any[];

    // 4. Recurring expenses
    const recurring = db
      .prepare(
        `SELECT r.id, r.name, r.amount, r.category_id, r.frequency, r.next_date, r.is_active,
                c.name as category_name, c.icon as category_icon, c.color as category_color
         FROM recurring_expenses r
         LEFT JOIN categories c ON r.category_id = c.id
         WHERE r.user_id = ? AND r.is_active = 1`
      )
      .all(userId) as any[];

    // 5. Goals
    const goals = db
      .prepare(
        `SELECT id, name, target_amount, current_amount, target_date, icon, color, is_completed
         FROM goals WHERE user_id = ?
         ORDER BY is_completed ASC, target_date ASC`
      )
      .all(userId) as any[];

    // 6. Investments
    const investments = db
      .prepare(
        `SELECT i.id, i.symbol, i.name, i.type, i.shares, i.cost_basis, i.current_price, i.last_updated,
                a.name as account_name
         FROM investments i
         LEFT JOIN accounts a ON i.account_id = a.id
         WHERE i.user_id = ?
         ORDER BY i.name ASC`
      )
      .all(userId) as any[];

    // Calculate metrics for comprehensive response

    // Expenses breakdown
    const expensesByCategory: any = {};
    let totalExpenses = 0;
    for (const tx of transactions.filter((t: any) => t.amount < 0)) {
      const categoryName = tx.category_name || 'Uncategorized';
      const amount = Math.abs(tx.amount);
      if (!expensesByCategory[categoryName]) {
        expensesByCategory[categoryName] = { name: categoryName, total: 0 };
      }
      expensesByCategory[categoryName].total += amount;
      totalExpenses += amount;
    }

    // Recurring expenses
    let totalRecurring = 0;
    for (const rec of recurring) {
      totalRecurring += Math.abs(rec.amount);
    }

    // Net worth calculation using shared helper (avoids double-counting investments)
    const nw = calculateNetWorth(accounts, investments);

    // Goals progress
    const goalStats = {
      total: goals.length,
      completed: goals.filter((g: any) => g.is_completed).length,
      active: goals.filter((g: any) => !g.is_completed).length,
      totalTargetAmount: goals.reduce((sum: number, g: any) => sum + g.target_amount, 0),
      totalCurrentAmount: goals.reduce((sum: number, g: any) => sum + g.current_amount, 0),
    };

    // Investment performance
    let totalInvestmentValue = 0;
    let totalInvestmentCostBasis = 0;
    for (const inv of investments) {
      const currentValue = inv.shares * inv.current_price;
      const costBasis = inv.shares * inv.cost_basis;
      totalInvestmentValue += currentValue;
      totalInvestmentCostBasis += costBasis;
    }

    res.json({
      clientProfile: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      accounts: {
        total: accounts.length,
        list: accounts,
      },
      expenses: {
        month: currentMonth,
        thisMonth: totalExpenses,
        byCategory: expensesByCategory,
      },
      recurringExpenses: {
        total: totalRecurring,
        count: recurring.length,
        expenses: recurring,
      },
      goals: {
        total: goals.length,
        completed: goalStats.completed,
        active: goalStats.active,
        list: goals.map((g: any) => ({
          ...g,
          progress: g.target_amount > 0 ? g.current_amount / g.target_amount : 0,
          progressPercent:
            g.target_amount > 0 ? Math.round((g.current_amount / g.target_amount) * 100) : 0,
        })),
      },
      investments: {
        count: investments.length,
        totalValue: totalInvestmentValue,
        totalCostBasis: totalInvestmentCostBasis,
        gainLoss: totalInvestmentValue - totalInvestmentCostBasis,
        list: investments.map((inv: any) => {
          const currentValue = inv.shares * inv.current_price;
          const costBasis = inv.shares * inv.cost_basis;
          const gainLoss = currentValue - costBasis;
          return {
            ...inv,
            currentValue,
            costBasis,
            gainLoss,
          };
        }),
      },
      assets: {
        total: nw.totalAssets,
        byType: nw.assetsByType,
      },
      liabilities: {
        total: nw.totalLiabilities,
        byType: nw.liabilitiesByType,
      },
      netWorth: {
        total: nw.netWorth,
        assets: nw.totalAssets,
        liabilities: nw.totalLiabilities,
        investmentPortfolioValue: nw.investmentPortfolioValue,
        cashAssets: nw.cashAssets,
        breakdown: {
          assets: nw.assetsByType,
          liabilities: nw.liabilitiesByType,
        },
      },
      summary: {
        netWorth: nw.netWorth,
        totalAssets: nw.totalAssets,
        totalLiabilities: nw.totalLiabilities,
        investmentPortfolioValue: nw.investmentPortfolioValue,
        monthlyExpenses: totalExpenses,
        recurringExpenses: totalRecurring,
        activeGoals: goalStats.active,
        investmentCount: investments.length,
      },
    });
  } catch (error) {
    console.error('Get comprehensive financial data error:', error);
    res.status(500).json({ error: 'Failed to get comprehensive financial data' });
  }
});

// ============================================================
// API SYNC ENDPOINTS — For connecting with external Financial Planning portal
// These allow bidirectional sync of investment data when a client
// has accounts set up in both the Budget app and the Planning portal.
// ============================================================

// POST /sync/investments — Receive investment data from the Financial Planning portal
router.post('/sync/investments', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { investments: incomingInvestments, source } = req.body;

    if (!incomingInvestments || !Array.isArray(incomingInvestments)) {
      res.status(400).json({ error: 'investments array is required' });
      return;
    }

    const results = {
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [] as string[],
    };

    // Get existing investments for this user
    const existingInvestments = db
      .prepare('SELECT id, symbol, account_id FROM investments WHERE user_id = ?')
      .all(userId) as any[];

    const existingBySymbol = new Map(
      existingInvestments.map((inv: any) => [inv.symbol, inv])
    );

    // Get user's first investment-type account, or create one
    let investmentAccount = db
      .prepare(
        `SELECT id FROM accounts WHERE user_id = ? AND type = 'investment' LIMIT 1`
      )
      .get(userId) as any;

    if (!investmentAccount) {
      const accountId = crypto.randomUUID();
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO accounts (id, user_id, name, type, institution, balance, last_four, icon, is_hidden, created_at, updated_at)
         VALUES (?, ?, ?, 'investment', ?, 0, '', '', 0, ?, ?)`
      ).run(accountId, userId, 'Synced Investments', source || 'Financial Planning Portal', now, now);
      investmentAccount = { id: accountId };
    }

    const now = new Date().toISOString();

    for (const inv of incomingInvestments) {
      try {
        if (!inv.symbol || !inv.name) {
          results.errors.push(`Missing symbol or name for investment`);
          results.skipped++;
          continue;
        }

        const existing = existingBySymbol.get(inv.symbol.toUpperCase());

        if (existing) {
          db.prepare(
            `UPDATE investments SET
              shares = COALESCE(?, shares),
              cost_basis = COALESCE(?, cost_basis),
              current_price = COALESCE(?, current_price),
              name = COALESCE(?, name),
              type = COALESCE(?, type),
              last_updated = ?
             WHERE id = ? AND user_id = ?`
          ).run(
            inv.shares ?? null,
            inv.cost_basis ?? null,
            inv.current_price ?? null,
            inv.name ?? null,
            inv.type ?? null,
            now,
            existing.id,
            userId
          );
          results.updated++;
        } else {
          const id = crypto.randomUUID();
          db.prepare(
            `INSERT INTO investments (id, user_id, account_id, symbol, name, type, shares, cost_basis, current_price, last_updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            id,
            userId,
            inv.account_id || investmentAccount.id,
            inv.symbol.toUpperCase(),
            inv.name,
            inv.type || 'stock',
            inv.shares || 0,
            inv.cost_basis || 0,
            inv.current_price || 0,
            now
          );
          results.created++;
        }
      } catch (err: any) {
        results.errors.push(`Error processing ${inv.symbol}: ${err.message}`);
        results.skipped++;
      }
    }

    // Recalculate investment account balance
    const portfolioValue = db
      .prepare(
        `SELECT COALESCE(SUM(shares * current_price), 0) as total
         FROM investments WHERE user_id = ? AND account_id = ?`
      )
      .get(userId, investmentAccount.id) as any;

    db.prepare('UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?').run(
      portfolioValue.total, now, investmentAccount.id
    );

    res.json({
      message: 'Investment sync completed',
      results,
      portfolioValue: portfolioValue.total,
    });
  } catch (error) {
    console.error('Sync investments error:', error);
    res.status(500).json({ error: 'Failed to sync investments' });
  }
});

// GET /sync/investments — Export investment data for the Financial Planning portal to pull
router.get('/sync/investments', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const investments = db
      .prepare(
        `SELECT i.id, i.symbol, i.name, i.type, i.shares, i.cost_basis, i.current_price, i.last_updated,
                a.name as account_name, a.institution as account_institution
         FROM investments i
         LEFT JOIN accounts a ON i.account_id = a.id
         WHERE i.user_id = ?
         ORDER BY i.name ASC`
      )
      .all(userId) as any[];

    const holdings = investments.map((inv: any) => {
      const currentValue = inv.shares * inv.current_price;
      const totalCost = inv.shares * inv.cost_basis;
      const gainLoss = currentValue - totalCost;

      return {
        id: inv.id,
        symbol: inv.symbol,
        name: inv.name,
        type: inv.type,
        shares: inv.shares,
        costBasis: inv.cost_basis,
        currentPrice: inv.current_price,
        currentValue,
        totalCost,
        gainLoss,
        gainLossPercent: totalCost > 0 ? (gainLoss / totalCost) * 100 : 0,
        lastUpdated: inv.last_updated,
        account: inv.account_name,
        institution: inv.account_institution,
      };
    });

    const totalValue = holdings.reduce((sum: number, h: any) => sum + h.currentValue, 0);
    const totalCost = holdings.reduce((sum: number, h: any) => sum + h.totalCost, 0);

    res.json({
      clientId: userId,
      lastSyncedAt: new Date().toISOString(),
      portfolio: {
        totalValue,
        totalCost,
        totalGainLoss: totalValue - totalCost,
        totalGainLossPercent: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
        holdingCount: holdings.length,
      },
      holdings,
    });
  } catch (error) {
    console.error('Export investments error:', error);
    res.status(500).json({ error: 'Failed to export investments' });
  }
});

// POST /sync/accounts — Receive account data from the Financial Planning portal
router.post('/sync/accounts', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { accounts: incomingAccounts } = req.body;

    if (!incomingAccounts || !Array.isArray(incomingAccounts)) {
      res.status(400).json({ error: 'accounts array is required' });
      return;
    }

    const results = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
    const now = new Date().toISOString();

    for (const acc of incomingAccounts) {
      try {
        if (!acc.name || !acc.type) {
          results.errors.push(`Missing name or type for account`);
          results.skipped++;
          continue;
        }

        const existing = db
          .prepare(
            `SELECT id FROM accounts WHERE user_id = ? AND LOWER(name) = LOWER(?) AND LOWER(COALESCE(institution, '')) = LOWER(?)`
          )
          .get(userId, acc.name, acc.institution || '') as any;

        if (existing) {
          db.prepare(
            `UPDATE accounts SET balance = COALESCE(?, balance), updated_at = ? WHERE id = ?`
          ).run(acc.balance ?? null, now, existing.id);
          results.updated++;
        } else {
          const id = crypto.randomUUID();
          db.prepare(
            `INSERT INTO accounts (id, user_id, name, type, institution, balance, last_four, icon, is_hidden, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
          ).run(id, userId, acc.name, acc.type, acc.institution || '', acc.balance || 0, acc.last_four || '', acc.icon || '', now, now);
          results.created++;
        }
      } catch (err: any) {
        results.errors.push(`Error processing ${acc.name}: ${err.message}`);
        results.skipped++;
      }
    }

    res.json({ message: 'Account sync completed', results });
  } catch (error) {
    console.error('Sync accounts error:', error);
    res.status(500).json({ error: 'Failed to sync accounts' });
  }
});

// GET /sync/status — Check if client has data in both systems
router.get('/sync/status', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const accountCount = (db.prepare('SELECT COUNT(*) as count FROM accounts WHERE user_id = ?').get(userId) as any).count;
    const investmentCount = (db.prepare('SELECT COUNT(*) as count FROM investments WHERE user_id = ?').get(userId) as any).count;
    const transactionCount = (db.prepare('SELECT COUNT(*) as count FROM transactions WHERE user_id = ?').get(userId) as any).count;
    const budgetCount = (db.prepare('SELECT COUNT(*) as count FROM budgets WHERE user_id = ?').get(userId) as any).count;
    const goalCount = (db.prepare('SELECT COUNT(*) as count FROM goals WHERE user_id = ?').get(userId) as any).count;

    const accounts = db.prepare('SELECT id, type, balance FROM accounts WHERE user_id = ?').all(userId) as any[];
    const investments = db.prepare('SELECT account_id, shares, current_price FROM investments WHERE user_id = ?').all(userId) as any[];
    const nw = calculateNetWorth(accounts, investments);

    res.json({
      clientId: userId,
      hasBudgetData: transactionCount > 0 || budgetCount > 0,
      hasInvestmentData: investmentCount > 0,
      hasAccountData: accountCount > 0,
      hasGoalData: goalCount > 0,
      syncReady: accountCount > 0 && investmentCount > 0,
      counts: { accounts: accountCount, investments: investmentCount, transactions: transactionCount, budgets: budgetCount, goals: goalCount },
      netWorth: {
        total: nw.netWorth,
        totalAssets: nw.totalAssets,
        totalLiabilities: nw.totalLiabilities,
        investmentPortfolioValue: nw.investmentPortfolioValue,
        cashAssets: nw.cashAssets,
      },
    });
  } catch (error) {
    console.error('Sync status error:', error);
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

// POST /sync/price-update — Bulk update current prices for investments
router.post('/sync/price-update', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { prices } = req.body;

    if (!prices || !Array.isArray(prices)) {
      res.status(400).json({ error: 'prices array is required (each with symbol and current_price)' });
      return;
    }

    const now = new Date().toISOString();
    let updated = 0;
    let notFound = 0;

    for (const { symbol, current_price } of prices) {
      if (!symbol || current_price === undefined) continue;
      const result = db
        .prepare(`UPDATE investments SET current_price = ?, last_updated = ? WHERE user_id = ? AND symbol = ?`)
        .run(current_price, now, userId, symbol.toUpperCase());
      if (result.changes > 0) updated++;
      else notFound++;
    }

    // Update investment account balances
    const investmentAccounts = db
      .prepare(`SELECT DISTINCT account_id FROM investments WHERE user_id = ?`)
      .all(userId) as any[];

    for (const { account_id } of investmentAccounts) {
      const total = db
        .prepare(`SELECT COALESCE(SUM(shares * current_price), 0) as total FROM investments WHERE user_id = ? AND account_id = ?`)
        .get(userId, account_id) as any;
      db.prepare('UPDATE accounts SET balance = ?, updated_at = ? WHERE id = ?').run(total.total, now, account_id);
    }

    res.json({ message: 'Price update completed', updated, notFound, timestamp: now });
  } catch (error) {
    console.error('Price update error:', error);
    res.status(500).json({ error: 'Failed to update prices' });
  }
});

export default router;
