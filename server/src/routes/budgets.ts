import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db/database.js';

const router = Router();

// GET / - get budgets for month with category info and spent calculation
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const month = (req.query.month as string) || new Date().toISOString().substring(0, 10);

    // Normalize month - support both YYYY-MM and YYYY-MM-DD
    const monthPrefix = month.substring(0, 7);
    const monthStr = monthPrefix + '-01';

    // Get the end of month for transaction date range
    const [year, mon] = monthStr.split('-').map(Number);
    const endOfMonth = new Date(year, mon, 0); // Last day of the month
    const endDate = `${year}-${String(mon).padStart(2, '0')}-${String(endOfMonth.getDate()).padStart(2, '0')}`;

    // Match budgets stored as YYYY-MM or YYYY-MM-01
    const budgets = db
      .prepare(
        `SELECT b.*,
                c.name as category_name,
                c.icon as category_icon,
                c.color as category_color,
                c.is_income as category_is_income
         FROM budgets b
         JOIN categories c ON b.category_id = c.id
         WHERE b.user_id = ? AND (b.month = ? OR b.month = ?)
         ORDER BY c.sort_order ASC`
      )
      .all(userId, monthStr, monthPrefix) as any[];

    // Calculate spent for each budget category
    const budgetsWithSpent = budgets.map((budget) => {
      // Sum negative transaction amounts (expenses) for this category in the given month
      const spentResult = db
        .prepare(
          `SELECT COALESCE(SUM(ABS(amount)), 0) as spent
           FROM transactions
           WHERE user_id = ? AND category_id = ? AND amount < 0
             AND date >= ? AND date <= ?`
        )
        .get(userId, budget.category_id, monthStr, endDate) as any;

      return {
        ...budget,
        spent: spentResult.spent,
        remaining: budget.amount - spentResult.spent + (budget.rollover_amount || 0),
      };
    });

    res.json(budgetsWithSpent);
  } catch (error) {
    console.error('Get budgets error:', error);
    res.status(500).json({ error: 'Failed to get budgets' });
  }
});

// POST / - create/update budget (upsert by category_id + month)
router.post('/', (req: Request, res: Response) => {
  try {
    const { category_id, month, amount, rollover } = req.body;

    if (!category_id || !month || amount === undefined) {
      res
        .status(400)
        .json({ error: 'category_id, month, and amount are required' });
      return;
    }

    const monthStr = month.substring(0, 7) + '-01';

    // Check if budget already exists for this category and month
    const existing = db
      .prepare(
        'SELECT id FROM budgets WHERE user_id = ? AND category_id = ? AND month = ?'
      )
      .get(req.user!.id, category_id, monthStr) as any;

    if (existing) {
      // Update existing budget
      db.prepare(
        `UPDATE budgets SET amount = ?, rollover = COALESCE(?, rollover)
         WHERE id = ?`
      ).run(amount, rollover !== undefined ? (rollover ? 1 : 0) : null, existing.id);

      const budget = db.prepare('SELECT * FROM budgets WHERE id = ?').get(existing.id);
      res.json({ budget });
    } else {
      // Create new budget
      const id = crypto.randomUUID();

      db.prepare(
        `INSERT INTO budgets (id, user_id, category_id, month, amount, rollover, rollover_amount)
         VALUES (?, ?, ?, ?, ?, ?, 0)`
      ).run(id, req.user!.id, category_id, monthStr, amount, rollover ? 1 : 0);

      const budget = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id);
      res.status(201).json({ budget });
    }
  } catch (error) {
    console.error('Create/update budget error:', error);
    res.status(500).json({ error: 'Failed to create/update budget' });
  }
});

// PUT /:id - update budget
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM budgets WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Budget not found' });
      return;
    }

    const { amount, rollover, rollover_amount } = req.body;

    db.prepare(
      `UPDATE budgets SET
        amount = COALESCE(?, amount),
        rollover = COALESCE(?, rollover),
        rollover_amount = COALESCE(?, rollover_amount)
       WHERE id = ? AND user_id = ?`
    ).run(
      amount !== undefined ? amount : null,
      rollover !== undefined ? (rollover ? 1 : 0) : null,
      rollover_amount !== undefined ? rollover_amount : null,
      id,
      req.user!.id
    );

    const budget = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id);
    res.json({ budget });
  } catch (error) {
    console.error('Update budget error:', error);
    res.status(500).json({ error: 'Failed to update budget' });
  }
});

// POST /rollover/:month - calculate rollover from previous month
router.post('/rollover/:month', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const monthParam = req.params.month as string;
    const targetMonth = monthParam.substring(0, 7) + '-01';

    // Calculate the previous month
    const [year, mon] = targetMonth.split('-').map(Number);
    const prevDate = new Date(year, mon - 2, 1); // month is 0-indexed, so mon-2
    const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}-01`;
    const prevEndOfMonth = new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0);
    const prevEndDate = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}-${String(prevEndOfMonth.getDate()).padStart(2, '0')}`;

    // Get previous month's budgets that have rollover enabled
    const prevBudgets = db
      .prepare(
        'SELECT * FROM budgets WHERE user_id = ? AND month = ? AND rollover = 1'
      )
      .all(userId, prevMonth) as any[];

    const rolloverResults: any[] = [];

    const processRollover = db.transaction(() => {
      for (const prevBudget of prevBudgets) {
        // Calculate spent in previous month
        const spentResult = db
          .prepare(
            `SELECT COALESCE(SUM(ABS(amount)), 0) as spent
             FROM transactions
             WHERE user_id = ? AND category_id = ? AND amount < 0
               AND date >= ? AND date <= ?`
          )
          .get(userId, prevBudget.category_id, prevMonth, prevEndDate) as any;

        const remaining =
          prevBudget.amount + (prevBudget.rollover_amount || 0) - spentResult.spent;

        // Only roll over positive remaining amounts
        if (remaining > 0) {
          // Check if a budget exists for the target month
          const targetBudget = db
            .prepare(
              'SELECT id FROM budgets WHERE user_id = ? AND category_id = ? AND month = ?'
            )
            .get(userId, prevBudget.category_id, targetMonth) as any;

          if (targetBudget) {
            db.prepare(
              'UPDATE budgets SET rollover_amount = ? WHERE id = ?'
            ).run(remaining, targetBudget.id);
          } else {
            // Create a new budget for the target month with rollover
            const id = crypto.randomUUID();
            db.prepare(
              `INSERT INTO budgets (id, user_id, category_id, month, amount, rollover, rollover_amount)
               VALUES (?, ?, ?, ?, ?, 1, ?)`
            ).run(id, userId, prevBudget.category_id, targetMonth, prevBudget.amount, remaining);
          }

          rolloverResults.push({
            category_id: prevBudget.category_id,
            rollover_amount: remaining,
          });
        }
      }
    });

    processRollover();

    res.json({
      message: `Rollover calculated for ${targetMonth}`,
      rollovers: rolloverResults,
      previousMonth: prevMonth,
    });
  } catch (error) {
    console.error('Rollover error:', error);
    res.status(500).json({ error: 'Failed to calculate rollover' });
  }
});

// DELETE /:id - delete budget
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM budgets WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Budget not found' });
      return;
    }

    db.prepare('DELETE FROM budgets WHERE id = ? AND user_id = ?').run(id, req.user!.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete budget error:', error);
    res.status(500).json({ error: 'Failed to delete budget' });
  }
});

export default router;
