/**
 * GET /api/safe-to-spend
 *
 * Server-side safe-to-spend (audit item 9). Replaces the client-side
 * `income − spent − upcomingRecurring` math in SafeToSpendCard.tsx with the
 * balance-anchored model in engine/safeToSpend.ts and returns every component
 * so the card can explain the number.
 *
 * Wiring (owner of index.ts):
 *   import safeToSpendRoutes from './routes/safe-to-spend.js';
 *   app.use('/api/safe-to-spend', authMiddleware, safeToSpendRoutes);
 */
import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { ensureFlowClassification } from '../engine/flow.js';
import { computeSafeToSpend } from '../engine/safeToSpend.js';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    // flow_type is the authority on income vs expense — make sure any newly
    // imported rows are classified before we aggregate.
    await ensureFlowClassification(userId);
    const result = await computeSafeToSpend(db, userId);
    res.json(result);
  } catch (error: any) {
    console.error('Safe-to-spend error:', error);
    res.status(500).json({ error: 'Failed to compute safe to spend' });
  }
});

export default router;
