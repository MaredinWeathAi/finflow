import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

// GET / - list investments with computed values
router.get('/', (req: Request, res: Response) => {
  try {
    const investments = db
      .prepare(
        `SELECT i.*, a.name as account_name
         FROM investments i
         LEFT JOIN accounts a ON i.account_id = a.id
         WHERE i.user_id = ?
         ORDER BY i.name ASC`
      )
      .all(req.user!.id)
      .map((inv: any) => {
        const current_value = inv.shares * inv.current_price;
        const total_cost = inv.shares * inv.cost_basis;
        const gain_loss = current_value - total_cost;
        const gain_loss_percent =
          total_cost > 0 ? ((gain_loss / total_cost) * 100) : 0;

        return {
          ...inv,
          current_value: Math.round(current_value * 100) / 100,
          total_cost: Math.round(total_cost * 100) / 100,
          gain_loss: Math.round(gain_loss * 100) / 100,
          gain_loss_percent: Math.round(gain_loss_percent * 100) / 100,
        };
      });

    // Compute portfolio totals
    const totalValue = investments.reduce(
      (sum: number, inv: any) => sum + inv.current_value,
      0
    );
    const totalCost = investments.reduce(
      (sum: number, inv: any) => sum + inv.total_cost,
      0
    );
    const totalGainLoss = totalValue - totalCost;
    const totalGainLossPercent =
      totalCost > 0 ? ((totalGainLoss / totalCost) * 100) : 0;

    res.json(investments);
  } catch (error) {
    console.error('List investments error:', error);
    res.status(500).json({ error: 'Failed to list investments' });
  }
});

// POST / - create investment
router.post('/', (req: Request, res: Response) => {
  try {
    const { account_id, symbol, name, type, shares, cost_basis, current_price } =
      req.body;

    if (
      !account_id ||
      !symbol ||
      !name ||
      !type ||
      shares === undefined ||
      cost_basis === undefined ||
      current_price === undefined
    ) {
      res.status(400).json({
        error:
          'account_id, symbol, name, type, shares, cost_basis, and current_price are required',
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
      `INSERT INTO investments (id, user_id, account_id, symbol, name, type, shares, cost_basis, current_price, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      req.user!.id,
      account_id,
      symbol.toUpperCase(),
      name,
      type,
      shares,
      cost_basis,
      current_price,
      now
    );

    const investment = db.prepare('SELECT * FROM investments WHERE id = ?').get(id);
    res.status(201).json({ investment });
  } catch (error) {
    console.error('Create investment error:', error);
    res.status(500).json({ error: 'Failed to create investment' });
  }
});

// PUT /:id - update investment
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM investments WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Investment not found' });
      return;
    }

    const { account_id, symbol, name, type, shares, cost_basis, current_price } =
      req.body;
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE investments SET
        account_id = COALESCE(?, account_id),
        symbol = COALESCE(?, symbol),
        name = COALESCE(?, name),
        type = COALESCE(?, type),
        shares = COALESCE(?, shares),
        cost_basis = COALESCE(?, cost_basis),
        current_price = COALESCE(?, current_price),
        last_updated = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      account_id ?? null,
      symbol ? symbol.toUpperCase() : null,
      name ?? null,
      type ?? null,
      shares !== undefined ? shares : null,
      cost_basis !== undefined ? cost_basis : null,
      current_price !== undefined ? current_price : null,
      now,
      id,
      req.user!.id
    );

    const investment = db.prepare('SELECT * FROM investments WHERE id = ?').get(id);
    res.json({ investment });
  } catch (error) {
    console.error('Update investment error:', error);
    res.status(500).json({ error: 'Failed to update investment' });
  }
});

// DELETE /:id - delete investment
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM investments WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Investment not found' });
      return;
    }

    db.prepare('DELETE FROM investments WHERE id = ? AND user_id = ?').run(
      id,
      req.user!.id
    );

    res.json({ message: 'Investment deleted successfully' });
  } catch (error) {
    console.error('Delete investment error:', error);
    res.status(500).json({ error: 'Failed to delete investment' });
  }
});

export default router;
