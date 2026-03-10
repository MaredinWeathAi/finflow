import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

// GET / - list recurring expenses with joined category info
router.get('/', (req: Request, res: Response) => {
  try {
    const recurring = db
      .prepare(
        `SELECT r.*,
                c.name as category_name, c.icon as category_icon, c.color as category_color,
                a.name as account_name
         FROM recurring_expenses r
         LEFT JOIN categories c ON r.category_id = c.id
         LEFT JOIN accounts a ON r.account_id = a.id
         WHERE r.user_id = ?
         ORDER BY r.next_date ASC`
      )
      .all(req.user!.id)
      .map((r: any) => ({
        ...r,
        price_history: JSON.parse(r.price_history || '[]'),
      }));

    res.json(recurring);
  } catch (error) {
    console.error('List recurring error:', error);
    res.status(500).json({ error: 'Failed to list recurring expenses' });
  }
});

// POST / - create recurring expense
router.post('/', (req: Request, res: Response) => {
  try {
    const {
      account_id,
      name,
      amount,
      category_id,
      frequency,
      next_date,
      is_active,
      notes,
    } = req.body;

    if (!name || amount === undefined || !frequency || !next_date) {
      res
        .status(400)
        .json({ error: 'name, amount, frequency, and next_date are required' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const priceHistory = JSON.stringify([{ date: now, amount }]);

    db.prepare(
      `INSERT INTO recurring_expenses (id, user_id, account_id, name, amount, category_id, frequency, next_date, is_active, notes, price_history, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.user!.id,
      account_id || null,
      name,
      amount,
      category_id || null,
      frequency,
      next_date,
      is_active !== undefined ? (is_active ? 1 : 0) : 1,
      notes || null,
      priceHistory,
      now,
      now
    );

    const recurring = db
      .prepare(
        `SELECT r.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
         FROM recurring_expenses r
         LEFT JOIN categories c ON r.category_id = c.id
         LEFT JOIN accounts a ON r.account_id = a.id
         WHERE r.id = ?`
      )
      .get(id) as any;

    recurring.price_history = JSON.parse(recurring.price_history || '[]');

    res.status(201).json({ recurring });
  } catch (error) {
    console.error('Create recurring error:', error);
    res.status(500).json({ error: 'Failed to create recurring expense' });
  }
});

// PUT /:id - update recurring expense
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM recurring_expenses WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id) as any;

    if (!existing) {
      res.status(404).json({ error: 'Recurring expense not found' });
      return;
    }

    const {
      account_id,
      name,
      amount,
      category_id,
      frequency,
      next_date,
      last_charged_date,
      is_active,
      notes,
    } = req.body;
    const now = new Date().toISOString();

    // If amount changes, update price history
    let priceHistory = existing.price_history;
    if (amount !== undefined && amount !== existing.amount) {
      const history = JSON.parse(priceHistory || '[]');
      history.push({ date: now, amount });
      priceHistory = JSON.stringify(history);
    }

    db.prepare(
      `UPDATE recurring_expenses SET
        account_id = COALESCE(?, account_id),
        name = COALESCE(?, name),
        amount = COALESCE(?, amount),
        category_id = COALESCE(?, category_id),
        frequency = COALESCE(?, frequency),
        next_date = COALESCE(?, next_date),
        last_charged_date = COALESCE(?, last_charged_date),
        is_active = COALESCE(?, is_active),
        notes = COALESCE(?, notes),
        price_history = ?,
        updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      account_id !== undefined ? account_id : null,
      name ?? null,
      amount !== undefined ? amount : null,
      category_id !== undefined ? category_id : null,
      frequency ?? null,
      next_date ?? null,
      last_charged_date !== undefined ? last_charged_date : null,
      is_active !== undefined ? (is_active ? 1 : 0) : null,
      notes !== undefined ? notes : null,
      priceHistory,
      now,
      id,
      req.user!.id
    );

    const recurring = db
      .prepare(
        `SELECT r.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
         FROM recurring_expenses r
         LEFT JOIN categories c ON r.category_id = c.id
         LEFT JOIN accounts a ON r.account_id = a.id
         WHERE r.id = ?`
      )
      .get(id) as any;

    recurring.price_history = JSON.parse(recurring.price_history || '[]');

    res.json({ recurring });
  } catch (error) {
    console.error('Update recurring error:', error);
    res.status(500).json({ error: 'Failed to update recurring expense' });
  }
});

// DELETE /:id - delete recurring expense
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM recurring_expenses WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Recurring expense not found' });
      return;
    }

    db.prepare('DELETE FROM recurring_expenses WHERE id = ? AND user_id = ?').run(
      id,
      req.user!.id
    );

    res.json({ message: 'Recurring expense deleted successfully' });
  } catch (error) {
    console.error('Delete recurring error:', error);
    res.status(500).json({ error: 'Failed to delete recurring expense' });
  }
});

export default router;
