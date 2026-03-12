import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

// ---------------------------------------------------------------------------
// Helper: extract a "core name" for grouping similar transactions
// ---------------------------------------------------------------------------
function recurringCoreName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#\-_:\/\\*]+/g, ' ')
    .replace(/\b\d+\b/g, '')           // drop standalone numbers
    .replace(/\d+\.\d+/g, '')          // drop decimal numbers
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Helper: determine which calendar month a date falls in (YYYY-MM)
// ---------------------------------------------------------------------------
function monthKey(dateStr: string): string {
  return dateStr.slice(0, 7); // "2026-03-11" → "2026-03"
}

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

// ---------------------------------------------------------------------------
// POST /detect - Auto-detect recurring transactions from history
// Scans the last 6 months of transactions, groups by core name,
// and promotes any that appear in 2+ distinct calendar months.
// Also deactivates stale recurrings not seen in 4+ months.
// ---------------------------------------------------------------------------
router.post('/detect', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const now = new Date();
    const sixMonthsAgo = new Date(now);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const cutoff = sixMonthsAgo.toISOString().slice(0, 10);

    // 1. Fetch all transactions in the last 6 months
    const transactions = db
      .prepare(
        `SELECT t.name, t.amount, t.date, t.category_id,
                c.name as category_name, c.icon as category_icon, c.color as category_color
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.date >= ?
         ORDER BY t.date DESC`
      )
      .all(userId, cutoff) as Array<{
        name: string; amount: number; date: string; category_id: string | null;
        category_name: string | null; category_icon: string | null; category_color: string | null;
      }>;

    // 2. Group transactions by core name
    const groups = new Map<string, {
      names: Map<string, number>; // original name → count
      months: Set<string>;
      amounts: number[];
      category_id: string | null;
      category_name: string | null;
      category_icon: string | null;
      category_color: string | null;
      latestDate: string;
    }>();

    for (const tx of transactions) {
      const core = recurringCoreName(tx.name);
      if (core.length < 3) continue;

      if (!groups.has(core)) {
        groups.set(core, {
          names: new Map(),
          months: new Set(),
          amounts: [],
          category_id: tx.category_id,
          category_name: tx.category_name,
          category_icon: tx.category_icon,
          category_color: tx.category_color,
          latestDate: tx.date,
        });
      }

      const g = groups.get(core)!;
      g.months.add(monthKey(tx.date));
      g.amounts.push(Math.abs(tx.amount));
      g.names.set(tx.name, (g.names.get(tx.name) || 0) + 1);
      if (tx.date > g.latestDate) g.latestDate = tx.date;
      // Use the most common category
      if (tx.category_id && !g.category_id) {
        g.category_id = tx.category_id;
        g.category_name = tx.category_name;
        g.category_icon = tx.category_icon;
        g.category_color = tx.category_color;
      }
    }

    // 3. Filter: keep only groups that appear in 2+ distinct months
    const candidates: Array<{
      name: string;
      amount: number;
      monthCount: number;
      category_id: string | null;
      category_name: string | null;
      latestDate: string;
    }> = [];

    for (const [_core, g] of groups) {
      if (g.months.size >= 2) {
        // Pick the most common original name
        let bestName = '';
        let bestCount = 0;
        for (const [n, count] of g.names) {
          if (count > bestCount) { bestName = n; bestCount = count; }
        }
        // Use median amount
        const sorted = [...g.amounts].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];

        candidates.push({
          name: bestName,
          amount: median,
          monthCount: g.months.size,
          category_id: g.category_id,
          category_name: g.category_name,
          latestDate: g.latestDate,
        });
      }
    }

    // 4. Check which candidates are already tracked as recurring
    const existing = db
      .prepare('SELECT id, name, amount, is_active FROM recurring_expenses WHERE user_id = ?')
      .all(userId) as Array<{ id: string; name: string; amount: number; is_active: number }>;

    const existingCores = new Set(existing.map(e => recurringCoreName(e.name)));

    // 5. Auto-create new recurring expenses for untracked patterns
    const created: string[] = [];
    const insertStmt = db.prepare(
      `INSERT INTO recurring_expenses (id, user_id, name, amount, category_id, frequency, next_date, is_active, notes, price_history, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'monthly', ?, 1, 'Auto-detected from transaction history', ?, ?, ?)`
    );

    const createBatch = db.transaction(() => {
      for (const c of candidates) {
        const core = recurringCoreName(c.name);
        if (existingCores.has(core)) continue;

        const id = crypto.randomUUID();
        const nowStr = new Date().toISOString();
        // Estimate next date: same day next month from latest transaction
        const latest = new Date(c.latestDate);
        latest.setMonth(latest.getMonth() + 1);
        const nextDate = latest.toISOString().slice(0, 10);
        const priceHistory = JSON.stringify([{ date: nowStr, amount: c.amount }]);

        insertStmt.run(id, userId, c.name, c.amount, c.category_id, nextDate, priceHistory, nowStr, nowStr);
        created.push(c.name);
        existingCores.add(core); // prevent duplicates within batch
      }
    });
    createBatch();

    // 6. Deactivate stale recurrings not seen in 4+ months
    const fourMonthsAgo = new Date(now);
    fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);
    const staleCutoff = fourMonthsAgo.toISOString().slice(0, 10);

    // For each active recurring, check if any matching transaction exists in last 4 months
    const activeRecurrings = db
      .prepare('SELECT id, name FROM recurring_expenses WHERE user_id = ? AND is_active = 1')
      .all(userId) as Array<{ id: string; name: string }>;

    const deactivated: string[] = [];
    const deactivateStmt = db.prepare(
      `UPDATE recurring_expenses SET is_active = 0, updated_at = ? WHERE id = ?`
    );

    for (const rec of activeRecurrings) {
      const core = recurringCoreName(rec.name);
      // Check if any transaction with this core name exists in the last 4 months
      const recentMatch = transactions.find(
        tx => recurringCoreName(tx.name) === core && tx.date >= staleCutoff
      );
      if (!recentMatch) {
        deactivateStmt.run(new Date().toISOString(), rec.id);
        deactivated.push(rec.name);
      }
    }

    res.json({
      detected: candidates.length,
      created: created.length,
      createdNames: created,
      deactivated: deactivated.length,
      deactivatedNames: deactivated,
    });
  } catch (error) {
    console.error('Detect recurring error:', error);
    res.status(500).json({ error: 'Failed to detect recurring transactions' });
  }
});

export default router;
