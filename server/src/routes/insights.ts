import { Router, Request, Response } from 'express';
import { generateInsights } from '../engine/insights.js';

const router = Router();

// GET / - full insights analysis
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const insights = generateInsights(userId);
    res.json(insights);
  } catch (error) {
    console.error('Insights error:', error);
    res.status(500).json({ error: 'Failed to generate insights' });
  }
});

// GET /health-score - quick health score only
router.get('/health-score', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { healthScore } = generateInsights(userId);
    res.json(healthScore);
  } catch (error) {
    console.error('Health score error:', error);
    res.status(500).json({ error: 'Failed to compute health score' });
  }
});

export default router;
