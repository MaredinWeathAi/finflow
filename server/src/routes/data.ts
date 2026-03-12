import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import bcrypt from 'bcryptjs';
import { getMerchantDbStats } from '../engine/merchant-db.js';
import { lookupMerchant } from '../engine/merchant-db.js';

const router = Router();

// GET /merchant-lookup?name=... - test merchant recognition
router.get('/merchant-lookup', (req: Request, res: Response) => {
  try {
    const name = req.query.name as string;
    if (!name) {
      res.status(400).json({ error: 'name query parameter required' });
      return;
    }
    const result = lookupMerchant(name);
    const stats = getMerchantDbStats();
    res.json({
      query: name,
      match: result,
      merchantDbSize: stats.totalEntries,
    });
  } catch (error) {
    console.error('Merchant lookup error:', error);
    res.status(500).json({ error: 'Failed to lookup merchant' });
  }
});

// GET /merchant-stats - get merchant DB statistics
router.get('/merchant-stats', (_req: Request, res: Response) => {
  try {
    const stats = getMerchantDbStats();
    res.json(stats);
  } catch (error) {
    console.error('Merchant stats error:', error);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// POST /seed-sample - seed sample data for the authenticated user
router.post('/seed-sample', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const now = new Date().toISOString();
    const today = new Date();

    const seedData = db.transaction(() => {
      // Create sample accounts
      const checkingId = crypto.randomUUID();
      const savingsId = crypto.randomUUID();
      const creditId = crypto.randomUUID();
      const investmentId = crypto.randomUUID();

      const accounts = [
        { id: checkingId, name: 'Main Checking', type: 'checking', institution: 'Chase Bank', balance: 5420.50, last_four: '4521', icon: 'building-columns' },
        { id: savingsId, name: 'High-Yield Savings', type: 'savings', institution: 'Marcus by Goldman Sachs', balance: 15000.00, last_four: '8832', icon: 'piggy-bank' },
        { id: creditId, name: 'Credit Card', type: 'credit', institution: 'Amex', balance: -1250.75, last_four: '1004', icon: 'credit-card' },
        { id: investmentId, name: 'Brokerage Account', type: 'investment', institution: 'Fidelity', balance: 32500.00, last_four: '7745', icon: 'chart-line' },
      ];

      const insertAccount = db.prepare(
        `INSERT OR IGNORE INTO accounts (id, user_id, name, type, institution, balance, last_four, icon, is_hidden, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'seed', ?, ?)`
      );

      for (const a of accounts) {
        insertAccount.run(a.id, userId, a.name, a.type, a.institution, a.balance, a.last_four, a.icon, now, now);
      }

      // Create sample categories
      const categories = [
        { name: 'Salary', icon: 'briefcase', color: '#10B981', is_income: 1 },
        { name: 'Freelance', icon: 'laptop', color: '#06B6D4', is_income: 1 },
        { name: 'Housing', icon: 'home', color: '#6366F1', is_income: 0 },
        { name: 'Groceries', icon: 'cart-shopping', color: '#F59E0B', is_income: 0 },
        { name: 'Transportation', icon: 'car', color: '#EF4444', is_income: 0 },
        { name: 'Dining Out', icon: 'utensils', color: '#EC4899', is_income: 0 },
        { name: 'Entertainment', icon: 'film', color: '#8B5CF6', is_income: 0 },
        { name: 'Utilities', icon: 'bolt', color: '#F97316', is_income: 0 },
        { name: 'Insurance', icon: 'shield', color: '#14B8A6', is_income: 0 },
        { name: 'Subscriptions', icon: 'repeat', color: '#A855F7', is_income: 0 },
        { name: 'Healthcare', icon: 'heart-pulse', color: '#EF4444', is_income: 0 },
        { name: 'Shopping', icon: 'bag-shopping', color: '#F472B6', is_income: 0 },
      ];

      const catIds: Record<string, string> = {};
      const insertCategory = db.prepare(
        `INSERT OR IGNORE INTO categories (id, user_id, name, icon, color, is_income, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      categories.forEach((c, i) => {
        const catId = crypto.randomUUID();
        catIds[c.name] = catId;
        insertCategory.run(catId, userId, c.name, c.icon, c.color, c.is_income, i);
      });

      // Create sample transactions for last 3 months
      const insertTx = db.prepare(
        `INSERT OR IGNORE INTO transactions (id, user_id, account_id, name, amount, category_id, date, notes, is_pending, is_recurring, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const sampleTransactions = [
        // Income
        { name: 'Monthly Salary', amount: 6500, category: 'Salary', account: checkingId, recurring: true },
        { name: 'Freelance Project', amount: 1200, category: 'Freelance', account: checkingId },
        // Expenses
        { name: 'Rent', amount: -1800, category: 'Housing', account: checkingId, recurring: true },
        { name: 'Whole Foods', amount: -127.43, category: 'Groceries', account: creditId },
        { name: 'Trader Joes', amount: -89.12, category: 'Groceries', account: creditId },
        { name: 'Gas Station', amount: -52.00, category: 'Transportation', account: creditId },
        { name: 'Uber', amount: -23.50, category: 'Transportation', account: creditId },
        { name: 'Sushi Restaurant', amount: -65.00, category: 'Dining Out', account: creditId },
        { name: 'Coffee Shop', amount: -5.75, category: 'Dining Out', account: creditId },
        { name: 'Netflix', amount: -15.99, category: 'Subscriptions', account: creditId, recurring: true },
        { name: 'Spotify', amount: -10.99, category: 'Subscriptions', account: creditId, recurring: true },
        { name: 'Electric Bill', amount: -95.00, category: 'Utilities', account: checkingId, recurring: true },
        { name: 'Internet', amount: -79.99, category: 'Utilities', account: checkingId, recurring: true },
        { name: 'Car Insurance', amount: -145.00, category: 'Insurance', account: checkingId, recurring: true },
        { name: 'Movie Tickets', amount: -32.00, category: 'Entertainment', account: creditId },
        { name: 'Amazon Purchase', amount: -67.49, category: 'Shopping', account: creditId },
        { name: 'Pharmacy', amount: -24.99, category: 'Healthcare', account: creditId },
      ];

      for (let monthOffset = 0; monthOffset < 3; monthOffset++) {
        const monthDate = new Date(today.getFullYear(), today.getMonth() - monthOffset, 1);
        for (const tx of sampleTransactions) {
          const day = Math.floor(Math.random() * 27) + 1;
          const txDate = new Date(monthDate.getFullYear(), monthDate.getMonth(), day);
          const dateStr = txDate.toISOString().substring(0, 10);

          // Add some variation to amounts
          const variation = 1 + (Math.random() * 0.2 - 0.1);
          const amount = Math.round(tx.amount * variation * 100) / 100;

          insertTx.run(
            crypto.randomUUID(),
            userId,
            tx.account,
            tx.name,
            amount,
            catIds[tx.category] || null,
            dateStr,
            null,
            0,
            tx.recurring ? 1 : 0,
            '[]',
            now,
            now
          );
        }
      }

      // Create sample budgets for current month
      const currentMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      const insertBudget = db.prepare(
        `INSERT OR IGNORE INTO budgets (id, user_id, category_id, month, amount, rollover, rollover_amount)
         VALUES (?, ?, ?, ?, ?, 0, 0)`
      );

      const budgetAmounts: Record<string, number> = {
        Housing: 1900,
        Groceries: 400,
        Transportation: 200,
        'Dining Out': 150,
        Entertainment: 100,
        Utilities: 250,
        Insurance: 150,
        Subscriptions: 50,
        Healthcare: 100,
        Shopping: 200,
      };

      for (const [catName, amount] of Object.entries(budgetAmounts)) {
        if (catIds[catName]) {
          insertBudget.run(crypto.randomUUID(), userId, catIds[catName], currentMonth, amount);
        }
      }

      // Create sample goals
      const insertGoal = db.prepare(
        `INSERT OR IGNORE INTO goals (id, user_id, name, target_amount, current_amount, target_date, icon, color, is_completed, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      );

      insertGoal.run(crypto.randomUUID(), userId, 'Emergency Fund', 20000, 15000, '2025-12-31', 'shield', '#10B981', now, now);
      insertGoal.run(crypto.randomUUID(), userId, 'Vacation to Japan', 5000, 2300, '2025-08-01', 'plane', '#6366F1', now, now);
      insertGoal.run(crypto.randomUUID(), userId, 'New Laptop', 2500, 800, '2025-06-01', 'laptop', '#F59E0B', now, now);

      // Create sample recurring expenses
      const insertRecurring = db.prepare(
        `INSERT OR IGNORE INTO recurring_expenses (id, user_id, account_id, name, amount, category_id, frequency, next_date, is_active, price_history, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      );

      const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
      const nextMonthStr = nextMonth.toISOString().substring(0, 10);

      insertRecurring.run(crypto.randomUUID(), userId, checkingId, 'Rent', 1800, catIds['Housing'], 'monthly', nextMonthStr, JSON.stringify([{ date: now, amount: 1800 }]), now, now);
      insertRecurring.run(crypto.randomUUID(), userId, creditId, 'Netflix', 15.99, catIds['Subscriptions'], 'monthly', nextMonthStr, JSON.stringify([{ date: now, amount: 15.99 }]), now, now);
      insertRecurring.run(crypto.randomUUID(), userId, creditId, 'Spotify', 10.99, catIds['Subscriptions'], 'monthly', nextMonthStr, JSON.stringify([{ date: now, amount: 10.99 }]), now, now);
      insertRecurring.run(crypto.randomUUID(), userId, checkingId, 'Car Insurance', 145, catIds['Insurance'], 'monthly', nextMonthStr, JSON.stringify([{ date: now, amount: 145 }]), now, now);

      // Create sample investments
      const insertInvestment = db.prepare(
        `INSERT OR IGNORE INTO investments (id, user_id, account_id, symbol, name, type, shares, cost_basis, current_price, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      insertInvestment.run(crypto.randomUUID(), userId, investmentId, 'VTI', 'Vanguard Total Stock Market', 'ETF', 50, 220.00, 245.50, now);
      insertInvestment.run(crypto.randomUUID(), userId, investmentId, 'VXUS', 'Vanguard Total International', 'ETF', 30, 55.00, 58.75, now);
      insertInvestment.run(crypto.randomUUID(), userId, investmentId, 'BND', 'Vanguard Total Bond Market', 'ETF', 20, 72.00, 70.50, now);
      insertInvestment.run(crypto.randomUUID(), userId, investmentId, 'AAPL', 'Apple Inc.', 'Stock', 10, 150.00, 178.25, now);

      // Create sample net worth snapshots
      const insertSnapshot = db.prepare(
        `INSERT OR IGNORE INTO net_worth_snapshots (id, user_id, date, total_assets, total_liabilities, net_worth, breakdown)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      for (let i = 5; i >= 0; i--) {
        const snapDate = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const dateStr = snapDate.toISOString().substring(0, 10);
        const assets = 50000 + (5 - i) * 1500 + Math.random() * 500;
        const liabilities = 1500 + Math.random() * 300;
        const netWorth = assets - liabilities;

        insertSnapshot.run(
          crypto.randomUUID(),
          userId,
          dateStr,
          Math.round(assets * 100) / 100,
          Math.round(liabilities * 100) / 100,
          Math.round(netWorth * 100) / 100,
          JSON.stringify({
            checking: 5420.50,
            savings: 15000,
            investments: 32500,
            credit: -1250.75,
          })
        );
      }

      return {
        accounts: accounts.length,
        categories: categories.length,
        transactions: sampleTransactions.length * 3,
        budgets: Object.keys(budgetAmounts).length,
        goals: 3,
        recurring: 4,
        investments: 4,
        snapshots: 6,
      };
    });

    const counts = seedData();

    res.json({
      message: 'Sample data seeded successfully',
      counts,
    });
  } catch (error) {
    console.error('Seed data error:', error);
    res.status(500).json({ error: 'Failed to seed sample data' });
  }
});

// GET /export - return all user data as JSON
router.get('/export', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const user = db
      .prepare('SELECT id, email, name, currency, created_at, updated_at FROM users WHERE id = ?')
      .get(userId);

    const accounts = db
      .prepare('SELECT * FROM accounts WHERE user_id = ?')
      .all(userId);

    const categories = db
      .prepare('SELECT * FROM categories WHERE user_id = ?')
      .all(userId);

    const transactions = db
      .prepare('SELECT * FROM transactions WHERE user_id = ?')
      .all(userId)
      .map((t: any) => ({ ...t, tags: JSON.parse(t.tags || '[]') }));

    const budgets = db
      .prepare('SELECT * FROM budgets WHERE user_id = ?')
      .all(userId);

    const goals = db
      .prepare('SELECT * FROM goals WHERE user_id = ?')
      .all(userId);

    const recurring = db
      .prepare('SELECT * FROM recurring_expenses WHERE user_id = ?')
      .all(userId)
      .map((r: any) => ({ ...r, price_history: JSON.parse(r.price_history || '[]') }));

    const investments = db
      .prepare('SELECT * FROM investments WHERE user_id = ?')
      .all(userId);

    const netWorthSnapshots = db
      .prepare('SELECT * FROM net_worth_snapshots WHERE user_id = ?')
      .all(userId)
      .map((s: any) => ({ ...s, breakdown: JSON.parse(s.breakdown || '{}') }));

    res.json({
      exportDate: new Date().toISOString(),
      user,
      accounts,
      categories,
      transactions,
      budgets,
      goals,
      recurring,
      investments,
      netWorthSnapshots,
    });
  } catch (error) {
    console.error('Export data error:', error);
    res.status(500).json({ error: 'Failed to export data' });
  }
});

// DELETE /reset - delete all user data (except the user account itself)
router.delete('/reset', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;

    const resetData = db.transaction(() => {
      // Clear upload/processing tables first (foreign key dependencies)
      db.prepare('DELETE FROM pending_items WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM uploaded_files WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM upload_sessions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM clarifications WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM category_rules WHERE user_id = ?').run(userId);
      // Clear financial data
      db.prepare('DELETE FROM net_worth_snapshots WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM investments WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM recurring_expenses WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM goals WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM budgets WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM transactions WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM categories WHERE user_id = ?').run(userId);
      db.prepare('DELETE FROM accounts WHERE user_id = ?').run(userId);
    });

    resetData();

    res.json({ message: 'All user data has been reset successfully' });
  } catch (error) {
    console.error('Reset data error:', error);
    res.status(500).json({ error: 'Failed to reset data' });
  }
});

// POST /quality-check - analyze and suggest data improvements
router.post('/quality-check', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const apply = (req.query.apply as string) === 'true';

    // Dynamic import of categorizer
    const { categorizeItem } = require('../engine/categorizer.js');

    const improvements = db.transaction(() => {
      let recategorized = 0;
      const duplicatesFound: any[] = [];
      const missingTransferCategory: any[] = [];

      // 1. Find all uncategorized transactions
      const uncategorized = db.prepare(
        `SELECT t.id, t.name, t.amount, t.date, t.account_id, a.name as account_name
         FROM transactions t
         JOIN accounts a ON t.account_id = a.id
         WHERE t.user_id = ? AND (t.category_id IS NULL
           OR t.category_id IN (
             SELECT id FROM categories WHERE user_id = ? AND LOWER(name) LIKE '%uncategorized%'
           ))
         ORDER BY t.date DESC`
      ).all(userId, userId) as any[];

      // Try to recategorize each uncategorized transaction
      const updateTxCategory = db.prepare(
        `UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?`
      );

      for (const tx of uncategorized) {
        const result = categorizeItem(tx.name, tx.amount, userId);
        if (result.categoryId) {
          if (apply) {
            updateTxCategory.run(result.categoryId, new Date().toISOString(), tx.id);
          }
          recategorized++;
        }
      }

      // 2. Find cross-account duplicates (same name, amount, date, different accounts)
      const duplicates = db.prepare(
        `SELECT t1.id, t1.name, t1.amount, t1.date, t1.account_id, a1.name as account_name,
                t2.id as duplicate_id, a2.name as duplicate_account
         FROM transactions t1
         JOIN accounts a1 ON t1.account_id = a1.id
         JOIN transactions t2 ON t1.user_id = t2.user_id
         JOIN accounts a2 ON t2.account_id = a2.id
         WHERE t1.user_id = ?
           AND t1.id < t2.id
           AND LOWER(t1.name) = LOWER(t2.name)
           AND ABS(t1.amount) = ABS(t2.amount)
           AND t1.date = t2.date
           AND t1.account_id != t2.account_id
         ORDER BY t1.date DESC`
      ).all(userId) as any[];

      for (const dup of duplicates) {
        duplicatesFound.push({
          id: dup.id,
          name: dup.name,
          amount: dup.amount,
          date: dup.date,
          account_name: dup.account_name,
          duplicate_id: dup.duplicate_id,
          duplicate_account: dup.duplicate_account,
        });
      }

      // 3. Find CC payments not categorized as transfers
      const transferCategory = db.prepare(
        `SELECT id FROM categories WHERE user_id = ? AND LOWER(name) = 'transfer'`
      ).get(userId) as any;
      const transferCategoryId = transferCategory?.id;

      if (transferCategoryId) {
        // Look for transactions from checking/savings to credit card accounts
        const ccPayments = db.prepare(
          `SELECT t.id, t.name, t.amount, t.date, a_from.name as from_account, a_to.name as to_account
           FROM transactions t
           JOIN accounts a_from ON t.account_id = a_from.id
           JOIN accounts a_to ON LOWER(a_to.name) LIKE '%' || LOWER(t.name) || '%' OR LOWER(t.name) LIKE '%credit%'
           WHERE t.user_id = ?
             AND a_from.user_id = ?
             AND a_from.type IN ('checking', 'savings')
             AND a_to.type = 'credit'
             AND t.amount < 0
             AND (t.category_id IS NULL OR t.category_id != ?)
           ORDER BY t.date DESC`
        ).all(userId, userId, transferCategoryId) as any[];

        for (const payment of ccPayments) {
          missingTransferCategory.push({
            id: payment.id,
            name: payment.name,
            amount: payment.amount,
            date: payment.date,
          });
        }
      }

      return { recategorized, duplicatesFound, missingTransferCategory };
    })();

    res.json({
      improvements: improvements,
      applied: apply,
    });
  } catch (error) {
    console.error('Data quality check error:', error);
    res.status(500).json({ error: 'Failed to run quality check' });
  }
});

export default router;
