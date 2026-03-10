import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

// GET / - list goals
router.get('/', (req: Request, res: Response) => {
  try {
    const goals = db
      .prepare(
        'SELECT * FROM goals WHERE user_id = ? ORDER BY is_completed ASC, target_date ASC'
      )
      .all(req.user!.id);

    res.json(goals);
  } catch (error) {
    console.error('List goals error:', error);
    res.status(500).json({ error: 'Failed to list goals' });
  }
});

// POST / - create goal
router.post('/', (req: Request, res: Response) => {
  try {
    const { name, target_amount, current_amount, target_date, icon, color } =
      req.body;

    if (!name || target_amount === undefined) {
      res.status(400).json({ error: 'name and target_amount are required' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO goals (id, user_id, name, target_amount, current_amount, target_date, icon, color, is_completed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id,
      req.user!.id,
      name,
      target_amount,
      current_amount ?? 0,
      target_date || null,
      icon || null,
      color || null,
      now,
      now
    );

    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    res.status(201).json({ goal });
  } catch (error) {
    console.error('Create goal error:', error);
    res.status(500).json({ error: 'Failed to create goal' });
  }
});

// PUT /:id - update goal
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    const {
      name,
      target_amount,
      current_amount,
      target_date,
      icon,
      color,
      is_completed,
    } = req.body;
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE goals SET
        name = COALESCE(?, name),
        target_amount = COALESCE(?, target_amount),
        current_amount = COALESCE(?, current_amount),
        target_date = COALESCE(?, target_date),
        icon = COALESCE(?, icon),
        color = COALESCE(?, color),
        is_completed = COALESCE(?, is_completed),
        updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      name ?? null,
      target_amount !== undefined ? target_amount : null,
      current_amount !== undefined ? current_amount : null,
      target_date !== undefined ? target_date : null,
      icon !== undefined ? icon : null,
      color !== undefined ? color : null,
      is_completed !== undefined ? (is_completed ? 1 : 0) : null,
      now,
      id,
      req.user!.id
    );

    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    res.json({ goal });
  } catch (error) {
    console.error('Update goal error:', error);
    res.status(500).json({ error: 'Failed to update goal' });
  }
});

// DELETE /:id - delete goal
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(
      id,
      req.user!.id
    );

    res.json({ message: 'Goal deleted successfully' });
  } catch (error) {
    console.error('Delete goal error:', error);
    res.status(500).json({ error: 'Failed to delete goal' });
  }
});

// POST /:id/contribute - add to current_amount
router.post('/:id/contribute', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;

    if (amount === undefined || typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ error: 'A positive amount is required' });
      return;
    }

    const existing = db
      .prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id) as any;

    if (!existing) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    const now = new Date().toISOString();
    const newAmount = existing.current_amount + amount;
    const isCompleted = newAmount >= existing.target_amount ? 1 : 0;

    db.prepare(
      'UPDATE goals SET current_amount = ?, is_completed = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).run(newAmount, isCompleted, now, id, req.user!.id);

    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    res.json({ goal });
  } catch (error) {
    console.error('Contribute to goal error:', error);
    res.status(500).json({ error: 'Failed to contribute to goal' });
  }
});

export default router;
