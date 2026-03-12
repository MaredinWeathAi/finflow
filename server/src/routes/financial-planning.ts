import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

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

// GET /assets - Returns all positive-balance accounts plus investment portfolio value
router.get('/assets', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Get bank accounts with positive balances
    const accounts = db
      .prepare(
        `SELECT id, name, type, institution, balance, last_four, icon
         FROM accounts
         WHERE user_id = ? AND type IN ('checking', 'savings', 'investment') AND balance > 0
         ORDER BY type ASC, name ASC`
      )
      .all(userId) as any[];

    // Get investments
    const investments = db
      .prepare(
        `SELECT i.id, i.symbol, i.name, i.shares, i.current_price
         FROM investments i
         WHERE i.user_id = ?`
      )
      .all(userId) as any[];

    // Calculate investment portfolio value
    const investmentPortfolioValue = investments.reduce((sum: number, inv: any) => {
      return sum + inv.shares * inv.current_price;
    }, 0);

    // Prepare account assets
    const accountAssets = accounts.map((account: any) => ({
      ...account,
      assetValue: account.balance,
      assetType: 'account',
    }));

    // Total assets
    const totalAccountBalance = accounts.reduce((sum: number, acc: any) => sum + acc.balance, 0);
    const totalAssets = totalAccountBalance + investmentPortfolioValue;

    // Summary by type
    const summary = {
      totalAssets,
      accountBalance: totalAccountBalance,
      investmentValue: investmentPortfolioValue,
      byType: {} as any,
    };

    for (const account of accounts) {
      if (!summary.byType[account.type]) {
        summary.byType[account.type] = {
          type: account.type,
          total: 0,
          count: 0,
        };
      }
      summary.byType[account.type].total += account.balance;
      summary.byType[account.type].count++;
    }

    if (investmentPortfolioValue > 0) {
      summary.byType['investment_portfolio'] = {
        type: 'investment_portfolio',
        total: investmentPortfolioValue,
        count: investments.length,
      };
    }

    res.json({
      accounts: accountAssets,
      investments: {
        count: investments.length,
        totalValue: investmentPortfolioValue,
        investments,
      },
      summary,
    });
  } catch (error) {
    console.error('Get assets error:', error);
    res.status(500).json({ error: 'Failed to get assets' });
  }
});

// GET /net-worth - Comprehensive net worth calculation
router.get('/net-worth', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    // Get all accounts
    const accounts = db
      .prepare(
        `SELECT id, name, type, balance
         FROM accounts
         WHERE user_id = ?`
      )
      .all(userId) as any[];

    // Get all investments
    const investments = db
      .prepare(
        `SELECT shares, current_price
         FROM investments
         WHERE user_id = ?`
      )
      .all(userId) as any[];

    // Calculate assets
    let totalAssets = 0;
    const assetsByType: any = {};

    for (const account of accounts) {
      if (account.type === 'checking' || account.type === 'savings') {
        if (account.balance > 0) {
          totalAssets += account.balance;
          if (!assetsByType[account.type]) {
            assetsByType[account.type] = 0;
          }
          assetsByType[account.type] += account.balance;
        }
      } else if (account.type === 'investment' && account.balance > 0) {
        totalAssets += account.balance;
        if (!assetsByType['investment_accounts']) {
          assetsByType['investment_accounts'] = 0;
        }
        assetsByType['investment_accounts'] += account.balance;
      }
    }

    // Add investment portfolio value
    let investmentPortfolioValue = 0;
    for (const inv of investments) {
      investmentPortfolioValue += inv.shares * inv.current_price;
    }
    totalAssets += investmentPortfolioValue;
    if (investmentPortfolioValue > 0) {
      assetsByType['investment_portfolio'] = investmentPortfolioValue;
    }

    // Calculate liabilities
    let totalLiabilities = 0;
    const liabilitiesByType: any = {};

    for (const account of accounts) {
      if (account.type === 'credit' || account.balance < 0) {
        const liabilityAmount = Math.abs(account.balance);
        totalLiabilities += liabilityAmount;
        if (!liabilitiesByType[account.type]) {
          liabilitiesByType[account.type] = 0;
        }
        liabilitiesByType[account.type] += liabilityAmount;
      }
    }

    // Calculate net worth
    const netWorth = totalAssets - totalLiabilities;

    res.json({
      netWorth,
      totalAssets,
      totalLiabilities,
      breakdown: {
        assets: {
          total: totalAssets,
          byType: assetsByType,
        },
        liabilities: {
          total: totalLiabilities,
          byType: liabilitiesByType,
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

    // Assets calculation
    let totalAssets = 0;
    const assetsByType: any = {};
    for (const account of accounts) {
      if (
        (account.type === 'checking' || account.type === 'savings' || account.type === 'investment') &&
        account.balance > 0
      ) {
        totalAssets += account.balance;
        assetsByType[account.type] = (assetsByType[account.type] || 0) + account.balance;
      }
    }

    // Investment portfolio value
    let investmentPortfolioValue = 0;
    for (const inv of investments) {
      investmentPortfolioValue += inv.shares * inv.current_price;
    }
    totalAssets += investmentPortfolioValue;
    assetsByType['investment_portfolio'] = investmentPortfolioValue;

    // Liabilities calculation
    let totalLiabilities = 0;
    const liabilitiesByType: any = {};
    for (const account of accounts) {
      if (account.type === 'credit' || account.balance < 0) {
        const liabilityAmount = Math.abs(account.balance);
        totalLiabilities += liabilityAmount;
        liabilitiesByType[account.type] = (liabilitiesByType[account.type] || 0) + liabilityAmount;
      }
    }

    // Net worth
    const netWorth = totalAssets - totalLiabilities;

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
        total: totalAssets,
        byType: assetsByType,
      },
      liabilities: {
        total: totalLiabilities,
        byType: liabilitiesByType,
      },
      netWorth: {
        total: netWorth,
        assets: totalAssets,
        liabilities: totalLiabilities,
        breakdown: {
          assets: assetsByType,
          liabilities: liabilitiesByType,
        },
      },
      summary: {
        netWorth,
        totalAssets,
        totalLiabilities,
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

export default router;
