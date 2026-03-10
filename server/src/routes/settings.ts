import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';

const router = Router();

// GET / - get user settings
router.get('/', (req: Request, res: Response) => {
  try {
    const user = db
      .prepare(
        'SELECT id, email, name, currency, created_at, updated_at FROM users WHERE id = ?'
      )
      .get(req.user!.id) as any;

    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json({
      settings: {
        id: user.id,
        email: user.email,
        name: user.name,
        currency: user.currency,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// PUT / - update user settings
router.put('/', (req: Request, res: Response) => {
  try {
    const { name, currency } = req.body;
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE users SET
        name = COALESCE(?, name),
        currency = COALESCE(?, currency),
        updated_at = ?
       WHERE id = ?`
    ).run(name ?? null, currency ?? null, now, req.user!.id);

    const user = db
      .prepare(
        'SELECT id, email, name, currency, created_at, updated_at FROM users WHERE id = ?'
      )
      .get(req.user!.id) as any;

    res.json({
      settings: {
        id: user.id,
        email: user.email,
        name: user.name,
        currency: user.currency,
        created_at: user.created_at,
        updated_at: user.updated_at,
      },
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;
