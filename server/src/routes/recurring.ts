import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { detectRecurring, recurringCoreName } from '../engine/recurring-detector.js';
import { frequencyStep } from '../engine/frequency.js';
import { ensureFlowClassification } from '../engine/flow.js';

const router = Router();

// GET / - list recurring expenses with joined category info
router.get('/', async (req: Request, res: Response) => {
  try {
    const recurring = (await db.all(`SELECT r.*,
                c.name as category_name, c.icon as category_icon, c.color as category_color,
                a.name as account_name
         FROM recurring_expenses r
         LEFT JOIN categories c ON r.category_id = c.id
         LEFT JOIN accounts a ON r.account_id = a.id
         WHERE r.user_id = ?
         ORDER BY r.next_date ASC`, req.user!.id))
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
router.post('/', async (req: Request, res: Response) => {
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

    await db.run(`INSERT INTO recurring_expenses (id, user_id, account_id, name, amount, category_id, frequency, next_date, is_active, notes, price_history, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, req.user!.id, account_id || null, name, amount, category_id || null, frequency, next_date, is_active !== undefined ? (is_active ? 1 : 0) : 1, notes || null, priceHistory, now, now);

    const recurring = await db.get(`SELECT r.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
         FROM recurring_expenses r
         LEFT JOIN categories c ON r.category_id = c.id
         LEFT JOIN accounts a ON r.account_id = a.id
         WHERE r.id = ?`, id) as any;

    recurring.price_history = JSON.parse(recurring.price_history || '[]');

    res.status(201).json({ recurring });
  } catch (error) {
    console.error('Create recurring error:', error);
    res.status(500).json({ error: 'Failed to create recurring expense' });
  }
});

// PUT /:id - update recurring expense
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await db.get('SELECT * FROM recurring_expenses WHERE id = ? AND user_id = ?', id, req.user!.id) as any;

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

    await db.run(`UPDATE recurring_expenses SET
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
       WHERE id = ? AND user_id = ?`, account_id !== undefined ? account_id : null, name ?? null, amount !== undefined ? amount : null, category_id !== undefined ? category_id : null, frequency ?? null, next_date ?? null, last_charged_date !== undefined ? last_charged_date : null, is_active !== undefined ? (is_active ? 1 : 0) : null, notes !== undefined ? notes : null, priceHistory, now, id, req.user!.id);

    const recurring = await db.get(`SELECT r.*, c.name as category_name, c.icon as category_icon, c.color as category_color, a.name as account_name
         FROM recurring_expenses r
         LEFT JOIN categories c ON r.category_id = c.id
         LEFT JOIN accounts a ON r.account_id = a.id
         WHERE r.id = ?`, id) as any;

    recurring.price_history = JSON.parse(recurring.price_history || '[]');

    res.json({ recurring });
  } catch (error) {
    console.error('Update recurring error:', error);
    res.status(500).json({ error: 'Failed to update recurring expense' });
  }
});

// DELETE /:id - delete recurring expense
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = await db.get('SELECT * FROM recurring_expenses WHERE id = ? AND user_id = ?', id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Recurring expense not found' });
      return;
    }

    await db.run('DELETE FROM recurring_expenses WHERE id = ? AND user_id = ?', id, req.user!.id);

    res.json({ message: 'Recurring expense deleted successfully' });
  } catch (error) {
    console.error('Delete recurring error:', error);
    res.status(500).json({ error: 'Failed to delete recurring expense' });
  }
});

// ---------------------------------------------------------------------------
// POST /detect - Auto-detect recurring transactions from history
// Scans the last 12 months of transactions and uses the recurring-detector
// engine which requires: consistent amount + consistent interval + same merchant.
// Also deactivates stale recurrings not seen in 4+ months.
// ---------------------------------------------------------------------------
router.post('/detect', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    await ensureFlowClassification(userId);
    const now = new Date();
    const twelveMonthsAgo = new Date(now);
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const cutoff = twelveMonthsAgo.toISOString().slice(0, 10);

    // 1. Fetch the last 12 months of REAL SPENDING.
    //
    // This query used to have no flow filter and no sign filter, and the
    // detector takes ABS() of the amount — so a recurring deposit was
    // indistinguishable from a recurring bill. Against Marcelo's real data it
    // produced 20 "recurring expenses" totalling ~$55,525/month, including
    // BOTH legs of his own savings sweep and $6,100 of inbound Interactive
    // Brokers transfers fitted as a weekly expense worth $26,413/month.
    //
    // Only outflows the app already classified as spending can be a bill.
    const transactions = await db.all(`SELECT t.name, t.amount, t.date, t.category_id,
                c.name as category_name, c.icon as category_icon, c.color as category_color
         FROM transactions t
         LEFT JOIN categories c ON t.category_id = c.id
         WHERE t.user_id = ? AND t.date >= ?
           AND t.flow_type IN ('expense', 'interest_fee')
           AND t.amount < 0
         ORDER BY t.date ASC`, userId, cutoff) as Array<{
        name: string; amount: number; date: string; category_id: string | null;
        category_name: string | null; category_icon: string | null; category_color: string | null;
      }>;

    // 2. Run the recurring detector engine
    const candidates = detectRecurring(transactions);

    // 3. Check which candidates are already tracked
    const existing = await db.all('SELECT id, name, amount, frequency, is_active FROM recurring_expenses WHERE user_id = ?', userId) as Array<{ id: string; name: string; amount: number; frequency: string; is_active: number }>;

    const existingCores = new Set(existing.map(e => recurringCoreName(e.name)));

    // 4. Auto-create new recurring expenses for untracked patterns
    const created: Array<{ name: string; amount: number; frequency: string; confidence: number }> = [];
    const insertSql =
      `INSERT INTO recurring_expenses (id, user_id, name, amount, category_id, frequency, next_date, is_active, notes, price_history, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`;

    await db.tx(async (t) => {
      for (const c of candidates) {
        if (existingCores.has(c.coreName)) continue;

        const id = crypto.randomUUID();
        const nowStr = new Date().toISOString();

        // Estimate next date based on frequency
        const nextDate = estimateNextDate(c.latestDate, c.frequency);
        const priceHistory = JSON.stringify([{ date: nowStr, amount: c.amount }]);
        const notes = `Auto-detected (${c.frequency}, ${c.occurrences} occurrences, ${Math.round(c.confidence * 100)}% confidence)`;

        await t.run(insertSql, id, userId, c.name, c.amount, c.category_id, c.frequency, nextDate, notes, priceHistory, nowStr, nowStr);
        created.push({ name: c.name, amount: c.amount, frequency: c.frequency, confidence: c.confidence });
        existingCores.add(c.coreName);
      }
    });

    // 5. Deactivate stale recurrings not seen in 4+ months
    const fourMonthsAgo = new Date(now);
    fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);
    const staleCutoff = fourMonthsAgo.toISOString().slice(0, 10);

    const activeRecurrings = await db.all('SELECT id, name FROM recurring_expenses WHERE user_id = ? AND is_active = 1', userId) as Array<{ id: string; name: string }>;

    const deactivated: string[] = [];
    const deactivateSql =
      `UPDATE recurring_expenses SET is_active = 0, updated_at = ? WHERE id = ?`;

    for (const rec of activeRecurrings) {
      const core = recurringCoreName(rec.name);
      const recentMatch = transactions.find(
        tx => recurringCoreName(tx.name) === core && tx.date >= staleCutoff
      );
      if (!recentMatch) {
        await db.run(deactivateSql, new Date().toISOString(), rec.id);
        deactivated.push(rec.name);
      }
    }

    res.json({
      detected: candidates.length,
      created: created.length,
      createdItems: created,
      deactivated: deactivated.length,
      deactivatedNames: deactivated,
      // Include all candidates for transparency (even already-tracked ones)
      allCandidates: candidates.map(c => ({
        name: c.name,
        amount: c.amount,
        frequency: c.frequency,
        confidence: c.confidence,
        occurrences: c.occurrences,
        monthCount: c.monthCount,
        avgIntervalDays: c.avgIntervalDays,
        alreadyTracked: existingCores.has(c.coreName),
      })),
    });
  } catch (error) {
    console.error('Detect recurring error:', error);
    res.status(500).json({ error: 'Failed to detect recurring transactions' });
  }
});

// ---------------------------------------------------------------------------
// Helper: estimate next charge date based on frequency
// ---------------------------------------------------------------------------
function estimateNextDate(lastDate: string, frequency: string): string {
  const d = new Date(lastDate);
  // Shared frequency table — this switch had no 'semi-monthly' case, so a bill
  // paid twice a month was given a next date a full month out.
  const step = frequencyStep(frequency) ?? { months: 1 };
  if (step.days) d.setDate(d.getDate() + step.days);
  else d.setMonth(d.getMonth() + step.months!);
  return d.toISOString().slice(0, 10);
}

export default router;
