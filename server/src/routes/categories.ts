import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

// GET / - list all categories for user, sorted by sort_order
router.get('/', (req: Request, res: Response) => {
  try {
    const categories = db
      .prepare(
        'SELECT * FROM categories WHERE user_id = ? ORDER BY sort_order ASC, name ASC'
      )
      .all(req.user!.id);

    res.json(categories);
  } catch (error) {
    console.error('List categories error:', error);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

// POST / - create category
router.post('/', (req: Request, res: Response) => {
  try {
    const { name, icon, color, budget_amount, is_income, parent_id, sort_order } =
      req.body;

    if (!name) {
      res.status(400).json({ error: 'Name is required' });
      return;
    }

    const id = crypto.randomUUID();

    // Get the next sort order if not provided
    let finalSortOrder = sort_order;
    if (finalSortOrder === undefined) {
      const maxOrder = db
        .prepare(
          'SELECT MAX(sort_order) as max_order FROM categories WHERE user_id = ?'
        )
        .get(req.user!.id) as any;
      finalSortOrder = (maxOrder?.max_order ?? -1) + 1;
    }

    db.prepare(
      `INSERT INTO categories (id, user_id, name, icon, color, budget_amount, is_income, parent_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.user!.id,
      name,
      icon || null,
      color || null,
      budget_amount ?? null,
      is_income ? 1 : 0,
      parent_id || null,
      finalSortOrder
    );

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    res.status(201).json({ category });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// PUT /reorder - update sort_order for all categories
// NOTE: This must be before /:id to avoid matching "reorder" as an id
router.put('/reorder', (req: Request, res: Response) => {
  try {
    const { orderedIds } = req.body;

    if (!Array.isArray(orderedIds)) {
      res.status(400).json({ error: 'orderedIds (array) is required' });
      return;
    }

    const updateStmt = db.prepare(
      'UPDATE categories SET sort_order = ? WHERE id = ? AND user_id = ?'
    );

    const reorder = db.transaction((ids: string[]) => {
      ids.forEach((id, index) => {
        updateStmt.run(index, id, req.user!.id);
      });
    });

    reorder(orderedIds);

    const categories = db
      .prepare(
        'SELECT * FROM categories WHERE user_id = ? ORDER BY sort_order ASC, name ASC'
      )
      .all(req.user!.id);

    res.json({ categories });
  } catch (error) {
    console.error('Reorder categories error:', error);
    res.status(500).json({ error: 'Failed to reorder categories' });
  }
});

// PUT /:id - update category
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    const { name, icon, color, budget_amount, is_income, parent_id, sort_order } =
      req.body;

    db.prepare(
      `UPDATE categories SET
        name = COALESCE(?, name),
        icon = COALESCE(?, icon),
        color = COALESCE(?, color),
        budget_amount = COALESCE(?, budget_amount),
        is_income = COALESCE(?, is_income),
        parent_id = COALESCE(?, parent_id),
        sort_order = COALESCE(?, sort_order)
       WHERE id = ? AND user_id = ?`
    ).run(
      name ?? null,
      icon !== undefined ? icon : null,
      color !== undefined ? color : null,
      budget_amount !== undefined ? budget_amount : null,
      is_income !== undefined ? (is_income ? 1 : 0) : null,
      parent_id !== undefined ? parent_id : null,
      sort_order !== undefined ? sort_order : null,
      id,
      req.user!.id
    );

    const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    res.json({ category });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// DELETE /:id - delete category (check for transactions first)
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM categories WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    // Check for transactions using this category
    const transactionCount = db
      .prepare(
        'SELECT COUNT(*) as count FROM transactions WHERE category_id = ? AND user_id = ?'
      )
      .get(id, req.user!.id) as any;

    if (transactionCount.count > 0) {
      res.status(409).json({
        error: `Cannot delete category: ${transactionCount.count} transactions are using it. Reassign them first.`,
        transactionCount: transactionCount.count,
      });
      return;
    }

    db.prepare('DELETE FROM categories WHERE id = ? AND user_id = ?').run(
      id,
      req.user!.id
    );

    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

export default router;
