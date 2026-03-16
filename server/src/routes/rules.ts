import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db/database.js';

const router = Router();

// ---------------------------------------------------------------------------
// GET / — list all rules for the user
// ---------------------------------------------------------------------------
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const rules = db.prepare(
      `SELECT r.*, c.name as category_name, c.icon as category_icon, c.color as category_color,
              a.name as account_name, aa.name as assign_account_name
       FROM category_rules r
       LEFT JOIN categories c ON r.category_id = c.id
       LEFT JOIN accounts a ON r.account_id = a.id
       LEFT JOIN accounts aa ON r.assign_account_id = aa.id
       WHERE r.user_id = ?
       ORDER BY r.priority DESC, r.created_at DESC`
    ).all(userId);
    res.json(rules);
  } catch (error) {
    console.error('List rules error:', error);
    res.status(500).json({ error: 'Failed to list rules' });
  }
});

// ---------------------------------------------------------------------------
// POST / — create a new rule
// ---------------------------------------------------------------------------
router.post('/', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const {
      name, pattern, match_type, category_id, account_id,
      amount_min, amount_max, amount_exact,
      assign_account_id, assign_type,
      is_enabled, priority, description,
    } = req.body;

    if (!pattern && !amount_exact && amount_min == null && amount_max == null) {
      res.status(400).json({ error: 'At least a name pattern or amount condition is required' });
      return;
    }
    if (!category_id) {
      res.status(400).json({ error: 'A category assignment is required' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO category_rules
        (id, user_id, name, pattern, match_type, category_id, account_id,
         amount_min, amount_max, amount_exact,
         assign_account_id, assign_type,
         is_enabled, priority, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, userId,
      name || '',
      pattern || '',
      match_type || 'contains',
      category_id,
      account_id || null,
      amount_min ?? null,
      amount_max ?? null,
      amount_exact ?? null,
      assign_account_id || null,
      assign_type || null,
      is_enabled !== false ? 1 : 0,
      priority || 0,
      description || '',
      now,
    );

    const rule = db.prepare(
      `SELECT r.*, c.name as category_name, c.icon as category_icon, c.color as category_color
       FROM category_rules r
       LEFT JOIN categories c ON r.category_id = c.id
       WHERE r.id = ?`
    ).get(id);

    res.status(201).json(rule);
  } catch (error) {
    console.error('Create rule error:', error);
    res.status(500).json({ error: 'Failed to create rule' });
  }
});

// ---------------------------------------------------------------------------
// PUT /:id — update a rule
// ---------------------------------------------------------------------------
router.put('/:id', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const existing = db.prepare(
      'SELECT * FROM category_rules WHERE id = ? AND user_id = ?'
    ).get(id, userId);
    if (!existing) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }

    const fields: string[] = [];
    const vals: any[] = [];
    const allowed = [
      'name', 'pattern', 'match_type', 'category_id', 'account_id',
      'amount_min', 'amount_max', 'amount_exact',
      'assign_account_id', 'assign_type',
      'is_enabled', 'priority', 'description',
    ];

    for (const field of allowed) {
      if (field in req.body) {
        fields.push(`${field} = ?`);
        vals.push(req.body[field]);
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    db.prepare(
      `UPDATE category_rules SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`
    ).run(...vals, id, userId);

    const rule = db.prepare(
      `SELECT r.*, c.name as category_name, c.icon as category_icon, c.color as category_color
       FROM category_rules r
       LEFT JOIN categories c ON r.category_id = c.id
       WHERE r.id = ?`
    ).get(id);

    res.json(rule);
  } catch (error) {
    console.error('Update rule error:', error);
    res.status(500).json({ error: 'Failed to update rule' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — delete a rule
// ---------------------------------------------------------------------------
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const result = db.prepare(
      'DELETE FROM category_rules WHERE id = ? AND user_id = ?'
    ).run(id, userId);

    if (result.changes === 0) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }

    res.json({ message: 'Rule deleted' });
  } catch (error) {
    console.error('Delete rule error:', error);
    res.status(500).json({ error: 'Failed to delete rule' });
  }
});

// ---------------------------------------------------------------------------
// POST /apply — run all enabled rules against existing transactions
// ---------------------------------------------------------------------------
router.post('/apply', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const rules = db.prepare(
      `SELECT * FROM category_rules WHERE user_id = ? AND is_enabled = 1
       ORDER BY priority DESC, created_at ASC`
    ).all(userId) as any[];

    let totalUpdated = 0;

    const updateCategoryOnly = db.prepare(
      `UPDATE transactions SET category_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    );

    const updateCategoryAndAmount = db.prepare(
      `UPDATE transactions SET category_id = ?, amount = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`
    );

    const now = new Date().toISOString();

    // Get all user transactions
    const transactions = db.prepare(
      `SELECT id, name, amount, date, account_id, category_id FROM transactions WHERE user_id = ?`
    ).all(userId) as any[];

    const applied = db.transaction(() => {
      for (const txn of transactions) {
        for (const rule of rules) {
          if (matchesRule(txn, rule)) {
            const categoryChanged = txn.category_id !== rule.category_id;

            // Determine if amount sign needs to flip based on assign_type
            let newAmount = txn.amount;
            let amountChanged = false;
            if (rule.assign_type) {
              const absAmt = Math.abs(txn.amount);
              if (rule.assign_type === 'income' && txn.amount < 0) {
                newAmount = absAmt;
                amountChanged = true;
              } else if (rule.assign_type === 'expense' && txn.amount > 0) {
                newAmount = -absAmt;
                amountChanged = true;
              }
              // 'transfer' keeps original sign — user just wants category override
            }

            if (categoryChanged && amountChanged) {
              updateCategoryAndAmount.run(rule.category_id, newAmount, now, txn.id, userId);
              totalUpdated++;
            } else if (categoryChanged) {
              updateCategoryOnly.run(rule.category_id, now, txn.id, userId);
              totalUpdated++;
            } else if (amountChanged) {
              updateCategoryAndAmount.run(txn.category_id, newAmount, now, txn.id, userId);
              totalUpdated++;
            }
            break; // first matching rule wins (highest priority)
          }
        }
      }
      return totalUpdated;
    });

    const count = applied();
    res.json({ updated: count, message: `Applied rules to ${count} transactions` });
  } catch (error) {
    console.error('Apply rules error:', error);
    res.status(500).json({ error: 'Failed to apply rules' });
  }
});

// ---------------------------------------------------------------------------
// POST /test — preview which transactions a rule would match (without applying)
// ---------------------------------------------------------------------------
router.post('/test', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const rule = req.body;

    const transactions = db.prepare(
      `SELECT t.id, t.name, t.amount, t.date, t.account_id, t.category_id,
              c.name as category_name, a.name as account_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN accounts a ON t.account_id = a.id
       WHERE t.user_id = ?
       ORDER BY t.date DESC`
    ).all(userId) as any[];

    const matches = transactions.filter(txn => matchesRule(txn, rule));
    res.json({ matches: matches.slice(0, 50), totalMatches: matches.length });
  } catch (error) {
    console.error('Test rule error:', error);
    res.status(500).json({ error: 'Failed to test rule' });
  }
});

// ---------------------------------------------------------------------------
// Rule matching logic — shared between apply and test
// ---------------------------------------------------------------------------
function matchesRule(txn: any, rule: any): boolean {
  const txnName = (txn.name || '').toLowerCase().trim();
  const pattern = (rule.pattern || '').toLowerCase().trim();

  // Name/pattern matching
  if (pattern) {
    const matchType = rule.match_type || 'contains';
    let nameMatch = false;

    switch (matchType) {
      case 'exact':
        nameMatch = txnName === pattern;
        break;
      case 'starts_with':
        nameMatch = txnName.startsWith(pattern);
        break;
      case 'ends_with':
        nameMatch = txnName.endsWith(pattern);
        break;
      case 'contains':
      default:
        nameMatch = txnName.includes(pattern);
        break;
    }

    if (!nameMatch) return false;
  }

  // Amount conditions
  const absAmount = Math.abs(txn.amount);

  if (rule.amount_exact != null) {
    if (Math.abs(absAmount - Math.abs(rule.amount_exact)) > 0.01) return false;
  }
  if (rule.amount_min != null) {
    if (absAmount < rule.amount_min) return false;
  }
  if (rule.amount_max != null) {
    if (absAmount > rule.amount_max) return false;
  }

  // Account filter
  if (rule.account_id && txn.account_id !== rule.account_id) {
    return false;
  }

  return true;
}

export default router;
