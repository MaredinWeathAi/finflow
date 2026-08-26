import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { DEFAULT_CATEGORIES } from '../engine/default-categories.js';

const router = Router();

// GET / - list all categories for user, sorted by sort_order
router.get('/', async (req: Request, res: Response) => {
  try {
    const categories = await db.all(`SELECT * FROM categories WHERE user_id = ?
         ORDER BY CASE WHEN LOWER(name) = 'uncategorized' THEN 1 ELSE 0 END ASC,
                  sort_order ASC, name ASC`, req.user!.id);

    res.json(categories);
  } catch (error) {
    console.error('List categories error:', error);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

// POST /ensure-defaults - create default categories if user has none
router.post('/ensure-defaults', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const existingCount = (await db.get('SELECT COUNT(*) as count FROM categories WHERE user_id = ?', userId) as any).count;

    if (existingCount > 0) {
      // Backfill EVERY missing default, not a hand-picked pair.
      //
      // This used to top up only CC PMT and Home Improvements, so a category
      // the flow classifier depends on could be permanently absent for an
      // existing user. Interactive Brokers withdrawals resolved to "Asset
      // Transfer", the category did not exist, the lookup returned null, and
      // the rows fell through to Other Income — booking $39,200 of moving your
      // own money between your own accounts as earnings.
      const systemCategories = DEFAULT_CATEGORIES;
      let added = 0;
      for (const cat of systemCategories) {
        const exists = await db.get('SELECT id FROM categories WHERE user_id = ? AND LOWER(name) = ?', userId, cat.name.toLowerCase()) as any;
        if (!exists) {
          const maxOrder = await db.get('SELECT MAX(sort_order) as max_order FROM categories WHERE user_id = ?', userId) as any;
          const nextOrder = (maxOrder?.max_order ?? -1) + 1;
          await db.run(`INSERT INTO categories (id, user_id, name, icon, color, is_income, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`, crypto.randomUUID(), userId, cat.name, cat.icon, cat.color, cat.isIncome ? 1 : 0, nextOrder);
          added++;
        }
      }

      const categories = await db.all('SELECT * FROM categories WHERE user_id = ? ORDER BY sort_order ASC, name ASC', userId);
      res.json({ message: added > 0 ? `Added ${added} missing system categories` : 'Categories already exist', created: added, categories });
      return;
    }

    const defaults = DEFAULT_CATEGORIES;

    const insertSql =
      `INSERT INTO categories (id, user_id, name, icon, color, is_income, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`;

    for (const [idx, cat] of defaults.entries()) {
      await db.run(insertSql, crypto.randomUUID(), userId, cat.name, cat.icon, cat.color, cat.isIncome ? 1 : 0, idx);
    }

    const categories = await db.all('SELECT * FROM categories WHERE user_id = ? ORDER BY sort_order ASC, name ASC', userId);
    res.json({ message: 'Default categories created', created: defaults.length, categories });
  } catch (error) {
    console.error('Ensure defaults error:', error);
    res.status(500).json({ error: 'Failed to create default categories' });
  }
});

// POST / - create category
router.post('/', async (req: Request, res: Response) => {
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
      const maxOrder = await db.get('SELECT MAX(sort_order) as max_order FROM categories WHERE user_id = ?', req.user!.id) as any;
      finalSortOrder = (maxOrder?.max_order ?? -1) + 1;
    }

    await db.run(`INSERT INTO categories (id, user_id, name, icon, color, budget_amount, is_income, parent_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, req.user!.id, name, icon || null, color || null, budget_amount ?? null, is_income ? 1 : 0, parent_id || null, finalSortOrder);

    const category = await db.get('SELECT * FROM categories WHERE id = ?', id);
    res.status(201).json({ category });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ error: 'Failed to create category' });
  }
});

// PUT /reorder - update sort_order for all categories
// NOTE: This must be before /:id to avoid matching "reorder" as an id
router.put('/reorder', async (req: Request, res: Response) => {
  try {
    const { orderedIds } = req.body;

    if (!Array.isArray(orderedIds)) {
      res.status(400).json({ error: 'orderedIds (array) is required' });
      return;
    }

    const updateSql = 'UPDATE categories SET sort_order = ? WHERE id = ? AND user_id = ?';

    await db.tx(async (t) => {
      for (const [index, id] of (orderedIds as string[]).entries()) {
        await t.run(updateSql, index, id, req.user!.id);
      }
    });

    const categories = await db.all('SELECT * FROM categories WHERE user_id = ? ORDER BY sort_order ASC, name ASC', req.user!.id);

    res.json({ categories });
  } catch (error) {
    console.error('Reorder categories error:', error);
    res.status(500).json({ error: 'Failed to reorder categories' });
  }
});

// PUT /:id - update category
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await db.get('SELECT * FROM categories WHERE id = ? AND user_id = ?', id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    const { name, icon, color, budget_amount, is_income, parent_id, sort_order } =
      req.body;

    await db.run(`UPDATE categories SET
        name = COALESCE(?, name),
        icon = COALESCE(?, icon),
        color = COALESCE(?, color),
        budget_amount = COALESCE(?, budget_amount),
        is_income = COALESCE(?, is_income),
        parent_id = COALESCE(?, parent_id),
        sort_order = COALESCE(?, sort_order)
       WHERE id = ? AND user_id = ?`, name ?? null, icon !== undefined ? icon : null, color !== undefined ? color : null, budget_amount !== undefined ? budget_amount : null, is_income !== undefined ? (is_income ? 1 : 0) : null, parent_id !== undefined ? parent_id : null, sort_order !== undefined ? sort_order : null, id, req.user!.id);

    const category = await db.get('SELECT * FROM categories WHERE id = ?', id);
    res.json({ category });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// DELETE /:id - delete category (check for transactions first)
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await db.get('SELECT * FROM categories WHERE id = ? AND user_id = ?', id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    // Check for transactions using this category
    const transactionCount = await db.get('SELECT COUNT(*) as count FROM transactions WHERE category_id = ? AND user_id = ?', id, req.user!.id) as any;

    if (transactionCount.count > 0) {
      res.status(409).json({
        error: `Cannot delete category: ${transactionCount.count} transactions are using it. Reassign them first.`,
        transactionCount: transactionCount.count,
      });
      return;
    }

    await db.run('DELETE FROM categories WHERE id = ? AND user_id = ?', id, req.user!.id);

    res.json({ message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

export default router;
