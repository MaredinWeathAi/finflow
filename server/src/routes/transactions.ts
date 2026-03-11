import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

// GET / - list transactions with filtering, sorting, pagination
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const {
      category,
      account,
      startDate,
      endDate,
      search,
      minAmount,
      maxAmount,
      type,
      isPending,
      sort,
    } = req.query;

    // Build WHERE clause
    const conditions: string[] = ['t.user_id = ?'];
    const params: any[] = [userId];

    if (category) {
      conditions.push('t.category_id = ?');
      params.push(category);
    }

    if (account) {
      conditions.push('t.account_id = ?');
      params.push(account);
    }

    if (startDate) {
      conditions.push('t.date >= ?');
      params.push(startDate);
    }

    if (endDate) {
      conditions.push('t.date <= ?');
      params.push(endDate);
    }

    if (search) {
      conditions.push('t.name LIKE ?');
      params.push(`%${search}%`);
    }

    if (minAmount !== undefined && minAmount !== '') {
      conditions.push('ABS(t.amount) >= ?');
      params.push(parseFloat(minAmount as string));
    }

    if (maxAmount !== undefined && maxAmount !== '') {
      conditions.push('ABS(t.amount) <= ?');
      params.push(parseFloat(maxAmount as string));
    }

    if (type === 'income') {
      conditions.push('t.amount > 0');
    } else if (type === 'expense') {
      conditions.push('t.amount < 0');
    }

    if (isPending !== undefined && isPending !== '') {
      conditions.push('t.is_pending = ?');
      params.push(isPending === 'true' ? 1 : 0);
    }

    const whereClause = conditions.join(' AND ');

    // Build ORDER BY clause
    let orderBy = 't.date DESC, t.created_at DESC';
    switch (sort) {
      case 'date_asc':
        orderBy = 't.date ASC, t.created_at ASC';
        break;
      case 'amount_desc':
        orderBy = 'ABS(t.amount) DESC';
        break;
      case 'amount_asc':
        orderBy = 'ABS(t.amount) ASC';
        break;
      case 'name_asc':
        orderBy = 't.name ASC';
        break;
      case 'date_desc':
      default:
        orderBy = 't.date DESC, t.created_at DESC';
        break;
    }

    // Get total count
    const countResult = db
      .prepare(`SELECT COUNT(*) as total FROM transactions t WHERE ${whereClause}`)
      .get(...params) as any;
    const total = countResult.total;
    const totalPages = Math.ceil(total / limit);

    // Get paginated results with joined names
    const transactions = db
      .prepare(
        `SELECT t.*,
                c.name as category_name, c.icon as category_icon, c.color as category_color,
                a.name as account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE ${whereClause}
         ORDER BY ${orderBy}
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
      .map((t: any) => ({
        ...t,
        tags: JSON.parse(t.tags || '[]'),
      }));

    res.json({ transactions, total, page, totalPages });
  } catch (error) {
    console.error('List transactions error:', error);
    res.status(500).json({ error: 'Failed to list transactions' });
  }
});

// POST / - create transaction
router.post('/', (req: Request, res: Response) => {
  try {
    const {
      account_id,
      name,
      amount,
      category_id,
      date,
      notes,
      is_pending,
      is_recurring,
      recurring_id,
      tags,
    } = req.body;

    if (!account_id || !name || amount === undefined || !date) {
      res.status(400).json({
        error: 'account_id, name, amount, and date are required',
      });
      return;
    }

    // Verify account belongs to user
    const account = db
      .prepare('SELECT id FROM accounts WHERE id = ? AND user_id = ?')
      .get(account_id, req.user!.id);

    if (!account) {
      res.status(404).json({ error: 'Account not found' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO transactions (id, user_id, account_id, name, amount, category_id, date, notes, is_pending, is_recurring, recurring_id, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.user!.id,
      account_id,
      name,
      amount,
      category_id || null,
      date,
      notes || null,
      is_pending ? 1 : 0,
      is_recurring ? 1 : 0,
      recurring_id || null,
      JSON.stringify(tags || []),
      now,
      now
    );

    // Update account balance
    db.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?').run(
      amount,
      now,
      account_id
    );

    const transaction = db
      .prepare(
        `SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE t.id = ?`
      )
      .get(id) as any;

    transaction.tags = JSON.parse(transaction.tags || '[]');

    res.status(201).json({ transaction });
  } catch (error) {
    console.error('Create transaction error:', error);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

// PUT /:id - update transaction
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id) as any;

    if (!existing) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    const {
      account_id,
      name,
      amount,
      category_id,
      date,
      notes,
      is_pending,
      is_recurring,
      recurring_id,
      tags,
    } = req.body;
    const now = new Date().toISOString();

    // If amount changed, adjust account balance
    if (amount !== undefined && amount !== existing.amount) {
      const diff = amount - existing.amount;
      const targetAccountId = account_id || existing.account_id;
      db.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?').run(
        diff,
        now,
        targetAccountId
      );

      // If account changed, also adjust old account
      if (account_id && account_id !== existing.account_id) {
        db.prepare('UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ?').run(
          amount,
          now,
          account_id
        );
        db.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?').run(
          existing.amount,
          now,
          existing.account_id
        );
      }
    } else if (account_id && account_id !== existing.account_id) {
      // Account changed but amount same - move the amount
      db.prepare('UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ?').run(
        existing.amount,
        now,
        existing.account_id
      );
      db.prepare('UPDATE accounts SET balance = balance + ?, updated_at = ? WHERE id = ?').run(
        existing.amount,
        now,
        account_id
      );
    }

    db.prepare(
      `UPDATE transactions SET
        account_id = COALESCE(?, account_id),
        name = COALESCE(?, name),
        amount = COALESCE(?, amount),
        category_id = COALESCE(?, category_id),
        date = COALESCE(?, date),
        notes = COALESCE(?, notes),
        is_pending = COALESCE(?, is_pending),
        is_recurring = COALESCE(?, is_recurring),
        recurring_id = COALESCE(?, recurring_id),
        tags = COALESCE(?, tags),
        updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      account_id ?? null,
      name ?? null,
      amount !== undefined ? amount : null,
      category_id !== undefined ? category_id : null,
      date ?? null,
      notes !== undefined ? notes : null,
      is_pending !== undefined ? (is_pending ? 1 : 0) : null,
      is_recurring !== undefined ? (is_recurring ? 1 : 0) : null,
      recurring_id !== undefined ? recurring_id : null,
      tags !== undefined ? JSON.stringify(tags) : null,
      now,
      id,
      req.user!.id
    );

    const transaction = db
      .prepare(
        `SELECT t.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         LEFT JOIN accounts a ON t.account_id = a.id
         WHERE t.id = ?`
      )
      .get(id) as any;

    transaction.tags = JSON.parse(transaction.tags || '[]');

    res.json({ transaction });
  } catch (error) {
    console.error('Update transaction error:', error);
    res.status(500).json({ error: 'Failed to update transaction' });
  }
});

// DELETE /:id - delete transaction
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id) as any;

    if (!existing) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    // Reverse account balance
    const now = new Date().toISOString();
    db.prepare('UPDATE accounts SET balance = balance - ?, updated_at = ? WHERE id = ?').run(
      existing.amount,
      now,
      existing.account_id
    );

    db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(
      id,
      req.user!.id
    );

    res.json({ message: 'Transaction deleted successfully' });
  } catch (error) {
    console.error('Delete transaction error:', error);
    res.status(500).json({ error: 'Failed to delete transaction' });
  }
});

// POST /bulk-categorize
router.post('/bulk-categorize', (req: Request, res: Response) => {
  try {
    const { transactionIds, categoryId } = req.body;

    if (!Array.isArray(transactionIds) || !categoryId) {
      res
        .status(400)
        .json({ error: 'transactionIds (array) and categoryId are required' });
      return;
    }

    // Verify category belongs to user
    const category = db
      .prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?')
      .get(categoryId, req.user!.id);

    if (!category) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    const now = new Date().toISOString();
    const updateStmt = db.prepare(
      'UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    );

    const updateMany = db.transaction((ids: string[]) => {
      let updated = 0;
      for (const txId of ids) {
        const result = updateStmt.run(categoryId, now, txId, req.user!.id);
        updated += result.changes;
      }
      return updated;
    });

    const updated = updateMany(transactionIds);

    res.json({ message: `${updated} transactions updated`, updated });
  } catch (error) {
    console.error('Bulk categorize error:', error);
    res.status(500).json({ error: 'Failed to bulk categorize transactions' });
  }
});

// POST /recategorize - change category of a transaction and propagate to all similar ones
router.post('/recategorize', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { transactionId, categoryId, propagate } = req.body;

    if (!transactionId || !categoryId) {
      res.status(400).json({ error: 'transactionId and categoryId are required' });
      return;
    }

    // Get the transaction
    const transaction = db.prepare(
      'SELECT * FROM transactions WHERE id = ? AND user_id = ?'
    ).get(transactionId, userId) as any;

    if (!transaction) {
      res.status(404).json({ error: 'Transaction not found' });
      return;
    }

    // Verify category belongs to user
    const category = db.prepare(
      'SELECT id, name FROM categories WHERE id = ? AND user_id = ?'
    ).get(categoryId, userId) as any;

    if (!category) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }

    const now = new Date().toISOString();
    let updatedCount = 1;

    // Update the target transaction
    db.prepare('UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?')
      .run(categoryId, now, transactionId);

    // If propagate is true, update all similar transactions (same name pattern)
    if (propagate !== false) {
      // Find similar transactions by name (case-insensitive)
      const normalizedName = transaction.name.toLowerCase().trim();

      // Update all transactions with the same name (case-insensitive) that have a different category
      const result = db.prepare(
        `UPDATE transactions SET category_id = ?, updated_at = ?
         WHERE user_id = ? AND LOWER(TRIM(name)) = ? AND id != ? AND (category_id IS NULL OR category_id != ?)`
      ).run(categoryId, now, userId, normalizedName, transactionId, categoryId);

      updatedCount += result.changes;

      // Learn the rule for future categorization
      try {
        // Check if rule already exists
        const existingRule = db.prepare(
          `SELECT id FROM category_rules WHERE user_id = ? AND LOWER(pattern) = ? AND category_id = ?`
        ).get(userId, normalizedName, categoryId) as any;

        if (!existingRule) {
          db.prepare(
            `INSERT INTO category_rules (id, user_id, pattern, category_id, match_type, created_at)
             VALUES (?, ?, ?, ?, 'contains', ?)`
          ).run(crypto.randomUUID(), userId, normalizedName, categoryId, now);
        }
      } catch (e) { /* ignore */ }
    }

    res.json({
      message: `Updated ${updatedCount} transaction${updatedCount !== 1 ? 's' : ''}`,
      updated: updatedCount,
      categoryName: category.name,
    });
  } catch (error) {
    console.error('Recategorize error:', error);
    res.status(500).json({ error: 'Failed to recategorize transactions' });
  }
});

// POST /import-csv - placeholder that accepts CSV text and returns parsed preview
router.post('/import-csv', (req: Request, res: Response) => {
  try {
    const { csvText } = req.body;

    if (!csvText || typeof csvText !== 'string') {
      res.status(400).json({ error: 'csvText (string) is required' });
      return;
    }

    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      res.status(400).json({ error: 'CSV must have a header row and at least one data row' });
      return;
    }

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));

    const preview = lines.slice(1, 11).map((line) => {
      const values = line.split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      const row: Record<string, string> = {};
      headers.forEach((header, i) => {
        row[header] = values[i] || '';
      });
      return row;
    });

    res.json({
      headers,
      preview,
      totalRows: lines.length - 1,
      message: 'CSV parsed successfully. Review the preview and confirm import.',
    });
  } catch (error) {
    console.error('Import CSV error:', error);
    res.status(500).json({ error: 'Failed to parse CSV' });
  }
});

export default router;
