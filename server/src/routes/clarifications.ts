import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { learnRule } from '../engine/categorizer.js';

const router = Router();

// GET / - list pending clarifications
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const status = (req.query.status as string) || 'pending';

    const clarifications = (await db.all(`SELECT * FROM clarifications
         WHERE user_id = ? AND status = ?
         ORDER BY created_at DESC`, userId, status))
      .map((c: any) => ({
        ...c,
        context: JSON.parse(c.context || '{}'),
        resolution: c.resolution ? JSON.parse(c.resolution) : null,
      }));

    res.json(clarifications);
  } catch (error) {
    console.error('Clarifications error:', error);
    res.status(500).json({ error: 'Failed to fetch clarifications' });
  }
});

// GET /count - quick count of pending clarifications
router.get('/count', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const result = await db.get('SELECT COUNT(*) as count FROM clarifications WHERE user_id = ? AND status = ?', userId, 'pending') as any;

    res.json({ count: result.count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get count' });
  }
});

// PUT /:id - resolve a clarification
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { status, resolution } = req.body;

    // Verify ownership
    const existing = await db.get('SELECT * FROM clarifications WHERE id = ? AND user_id = ?', id, userId) as any;

    if (!existing) {
      return res.status(404).json({ error: 'Clarification not found' });
    }

    await db.run(`UPDATE clarifications
       SET status = ?, resolution = ?, resolved_at = ?
       WHERE id = ? AND user_id = ?`, status || 'resolved', resolution ? JSON.stringify(resolution) : null, new Date().toISOString(), id, userId);

    // If the resolution includes a category rule, learn it
    if (resolution?.learnRule && resolution.pattern && resolution.categoryId) {
      await learnRule(userId, resolution.pattern, resolution.categoryId, resolution.matchType || 'contains');
    }

    res.json({ message: 'Clarification resolved' });
  } catch (error) {
    console.error('Resolve clarification error:', error);
    res.status(500).json({ error: 'Failed to resolve clarification' });
  }
});

// DELETE /:id - dismiss a clarification
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    await db.run(`UPDATE clarifications SET status = 'dismissed', resolved_at = ? WHERE id = ? AND user_id = ?`, new Date().toISOString(), id, userId);

    res.json({ message: 'Clarification dismissed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to dismiss clarification' });
  }
});

export default router;
