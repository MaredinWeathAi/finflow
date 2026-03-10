import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

// GET / - list all accounts for user
router.get('/', (req: Request, res: Response) => {
  try {
    const accounts = db
      .prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at DESC')
      .all(req.user!.id);

    res.json(accounts);
  } catch (error) {
    console.error('List accounts error:', error);
    res.status(500).json({ error: 'Failed to list accounts' });
  }
});

// POST / - create account
router.post('/', (req: Request, res: Response) => {
  try {
    const { name, type, institution, balance, last_four, icon, is_hidden } = req.body;

    if (!name || !type) {
      res.status(400).json({ error: 'Name and type are required' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO accounts (id, user_id, name, type, institution, balance, last_four, icon, is_hidden, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.user!.id,
      name,
      type,
      institution || null,
      balance ?? 0,
      last_four || null,
      icon || null,
      is_hidden ? 1 : 0,
      now,
      now
    );

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    res.status(201).json({ account });
  } catch (error) {
    console.error('Create account error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// PUT /:id - update account
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const existing = db
      .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id) as any;

    if (!existing) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const { name, type, institution, balance, last_four, icon, is_hidden } = req.body;
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE accounts SET
        name = COALESCE(?, name),
        type = COALESCE(?, type),
        institution = COALESCE(?, institution),
        balance = COALESCE(?, balance),
        last_four = COALESCE(?, last_four),
        icon = COALESCE(?, icon),
        is_hidden = COALESCE(?, is_hidden),
        updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      name ?? null,
      type ?? null,
      institution !== undefined ? institution : null,
      balance !== undefined ? balance : null,
      last_four !== undefined ? last_four : null,
      icon !== undefined ? icon : null,
      is_hidden !== undefined ? (is_hidden ? 1 : 0) : null,
      now,
      id,
      req.user!.id
    );

    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    res.json({ account });
  } catch (error) {
    console.error('Update account error:', error);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

// DELETE /:id - delete account
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?').run(
      id,
      req.user!.id
    );

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// GET /:id/transactions - get transactions for account
router.get('/:id/transactions', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const account = db
      .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const transactions = db
      .prepare(
        `SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.account_id = ? AND t.user_id = ?
         ORDER BY t.date DESC`
      )
      .all(id, req.user!.id)
      .map((t: any) => ({
        ...t,
        tags: JSON.parse(t.tags || '[]'),
      }));

    res.json({ transactions });
  } catch (error) {
    console.error('Get account transactions error:', error);
    res.status(500).json({ error: 'Failed to get account transactions' });
  }
});

// GET /:id/balance-history - return balance history generated from transactions
router.get('/:id/balance-history', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const account = db
      .prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id) as any;

    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    // Get all transactions for this account ordered by date ascending
    const transactions = db
      .prepare(
        `SELECT date, amount FROM transactions
         WHERE account_id = ? AND user_id = ?
         ORDER BY date ASC`
      )
      .all(id, req.user!.id) as any[];

    // Build balance history by working backwards from current balance
    // First, calculate total transaction sum
    const totalSum = transactions.reduce(
      (sum: number, t: any) => sum + t.amount,
      0
    );
    const startingBalance = account.balance - totalSum;

    // Build daily balance snapshots
    const balanceMap = new Map<string, number>();
    let runningBalance = startingBalance;

    for (const t of transactions) {
      runningBalance += t.amount;
      balanceMap.set(t.date.substring(0, 10), runningBalance);
    }

    // Convert to array sorted by date
    const history = Array.from(balanceMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, balance]) => ({ date, balance }));

    // If no transactions, return current balance for today
    if (history.length === 0) {
      history.push({
        date: new Date().toISOString().substring(0, 10),
        balance: account.balance,
      });
    }

    res.json({ history });
  } catch (error) {
    console.error('Get balance history error:', error);
    res.status(500).json({ error: 'Failed to get balance history' });
  }
});

export default router;
