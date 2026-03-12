import { Router, Request, Response } from 'express';
import { db } from '../db/database.js';
import { subMonths } from 'date-fns';

const router = Router();

interface GoalRecommendation {
  name: string;
  suggested_amount: number;
  icon: string;
  color: string;
  reason: string;
}

// GET / - list goals
router.get('/', (req: Request, res: Response) => {
  try {
    const goals = db
      .prepare(
        'SELECT * FROM goals WHERE user_id = ? ORDER BY is_completed ASC, target_date ASC'
      )
      .all(req.user!.id);

    res.json(goals);
  } catch (error) {
    console.error('List goals error:', error);
    res.status(500).json({ error: 'Failed to list goals' });
  }
});

// POST / - create goal
router.post('/', (req: Request, res: Response) => {
  try {
    const { name, target_amount, current_amount, target_date, icon, color } =
      req.body;

    if (!name || target_amount === undefined) {
      res.status(400).json({ error: 'name and target_amount are required' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO goals (id, user_id, name, target_amount, current_amount, target_date, icon, color, is_completed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      id,
      req.user!.id,
      name,
      target_amount,
      current_amount ?? 0,
      target_date || null,
      icon || null,
      color || null,
      now,
      now
    );

    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    res.status(201).json({ goal });
  } catch (error) {
    console.error('Create goal error:', error);
    res.status(500).json({ error: 'Failed to create goal' });
  }
});

// PUT /:id - update goal
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    const {
      name,
      target_amount,
      current_amount,
      target_date,
      icon,
      color,
      is_completed,
    } = req.body;
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE goals SET
        name = COALESCE(?, name),
        target_amount = COALESCE(?, target_amount),
        current_amount = COALESCE(?, current_amount),
        target_date = COALESCE(?, target_date),
        icon = COALESCE(?, icon),
        color = COALESCE(?, color),
        is_completed = COALESCE(?, is_completed),
        updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      name ?? null,
      target_amount !== undefined ? target_amount : null,
      current_amount !== undefined ? current_amount : null,
      target_date !== undefined ? target_date : null,
      icon !== undefined ? icon : null,
      color !== undefined ? color : null,
      is_completed !== undefined ? (is_completed ? 1 : 0) : null,
      now,
      id,
      req.user!.id
    );

    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    res.json({ goal });
  } catch (error) {
    console.error('Update goal error:', error);
    res.status(500).json({ error: 'Failed to update goal' });
  }
});

// DELETE /:id - delete goal
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const existing = db
      .prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id);

    if (!existing) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    db.prepare('DELETE FROM goals WHERE id = ? AND user_id = ?').run(
      id,
      req.user!.id
    );

    res.json({ message: 'Goal deleted successfully' });
  } catch (error) {
    console.error('Delete goal error:', error);
    res.status(500).json({ error: 'Failed to delete goal' });
  }
});

// POST /:id/contribute - add to current_amount
router.post('/:id/contribute', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { amount } = req.body;

    if (amount === undefined || typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ error: 'A positive amount is required' });
      return;
    }

    const existing = db
      .prepare('SELECT * FROM goals WHERE id = ? AND user_id = ?')
      .get(id, req.user!.id) as any;

    if (!existing) {
      res.status(404).json({ error: 'Goal not found' });
      return;
    }

    const now = new Date().toISOString();
    const newAmount = existing.current_amount + amount;
    const isCompleted = newAmount >= existing.target_amount ? 1 : 0;

    db.prepare(
      'UPDATE goals SET current_amount = ?, is_completed = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).run(newAmount, isCompleted, now, id, req.user!.id);

    const goal = db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
    res.json({ goal });
  } catch (error) {
    console.error('Contribute to goal error:', error);
    res.status(500).json({ error: 'Failed to contribute to goal' });
  }
});

// GET /recommendations - Get smart goal recommendations based on spending patterns
router.get('/recommendations', (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const recommendations: GoalRecommendation[] = [];

    // Get last 3 months of transactions to analyze spending patterns
    const threeMonthsAgo = subMonths(new Date(), 3).toISOString();

    // 1. Get top 5 expense categories over last 3 months
    const topCategories = db
      .prepare(`
        SELECT
          c.id, c.name, c.icon, c.color,
          SUM(ABS(t.amount)) as total,
          COUNT(*) as count
        FROM transactions t
        JOIN categories c ON t.category_id = c.id
        WHERE t.user_id = ? AND t.date >= ? AND t.amount < 0 AND NOT c.is_income
        GROUP BY c.id
        ORDER BY total DESC
        LIMIT 5
      `)
      .all(userId, threeMonthsAgo) as any[];

    // 2. Get recurring expenses
    const recurringExpenses = db
      .prepare(`
        SELECT SUM(amount) as total_recurring, COUNT(*) as count
        FROM recurring_expenses
        WHERE user_id = ? AND is_active = 1
      `)
      .get(userId) as any;

    // 3. Get accounts for debt and investment detection
    const accounts = db
      .prepare('SELECT * FROM accounts WHERE user_id = ?')
      .all(userId) as any[];

    // 4. Calculate monthly income and expenses
    const now = new Date();
    const currentMonth = now.toISOString().substring(0, 7);

    const monthlyStats = db
      .prepare(`
        SELECT
          SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
          SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) as expenses
        FROM transactions
        WHERE user_id = ? AND date LIKE ?
      `)
      .get(userId, currentMonth + '%') as any;

    const monthlyIncome = monthlyStats?.income || 0;
    const monthlyExpenses = monthlyStats?.expenses || 0;

    // Add recommendation: High expense category reduction
    if (topCategories.length > 0) {
      const topCategory = topCategories[0];
      const reductionTarget = topCategory.total * 0.2; // 20% reduction
      recommendations.push({
        name: `${topCategory.name} Budget Goal`,
        suggested_amount: reductionTarget,
        icon: topCategory.icon || '💰',
        color: topCategory.color || '#A78BFA',
        reason: `You spent ${Math.round(topCategory.total)} on ${topCategory.name} in the last 3 months. Reduce by 20% to reach this goal.`,
      });
    }

    // Add recommendation: Debt payoff (if credit card debt exists)
    const creditCardDebt = accounts
      .filter(a => a.type === 'credit' && a.balance < 0)
      .reduce((sum: number, a: any) => sum + Math.abs(a.balance), 0);

    if (creditCardDebt > 0) {
      recommendations.push({
        name: 'Credit Card Debt Payoff',
        suggested_amount: creditCardDebt,
        icon: '💳',
        color: '#EF4444',
        reason: `You have ${creditCardDebt.toFixed(2)} in credit card debt. Pay it off to improve your financial health.`,
      });
    }

    // Add recommendation: Emergency fund (6 months of expenses)
    if (monthlyExpenses > 0) {
      const emergencyFundTarget = monthlyExpenses * 6;
      recommendations.push({
        name: 'Emergency Fund',
        suggested_amount: emergencyFundTarget,
        icon: '🛟',
        color: '#10B981',
        reason: `Build an emergency fund covering 6 months of expenses (${Math.round(monthlyExpenses)}/month).`,
      });
    }

    // Add recommendation: Investment growth (if investment accounts exist)
    const hasInvestmentAccounts = accounts.some(a => a.type === 'investment' || a.type === 'crypto');
    if (hasInvestmentAccounts && monthlyIncome > monthlyExpenses) {
      const monthlySavings = monthlyIncome - monthlyExpenses;
      const yearlyInvestmentTarget = monthlySavings * 12;
      recommendations.push({
        name: 'Investment Growth',
        suggested_amount: yearlyInvestmentTarget,
        icon: '📈',
        color: '#3B82F6',
        reason: `You have ${Math.round(monthlySavings)}/month in savings. Grow your investments toward ${yearlyInvestmentTarget.toFixed(0)}/year.`,
      });
    }

    // Add generic recommendations based on income level
    if (monthlyIncome > 0 && recommendations.length < 4) {
      // Vacation fund (10% of monthly income)
      if (recommendations.length < 4) {
        const vacationTarget = monthlyIncome * 1.5;
        recommendations.push({
          name: 'Vacation Fund',
          suggested_amount: vacationTarget,
          icon: '✈️',
          color: '#06B6D4',
          reason: `Save for a vacation with 1.5 months of your income (${Math.round(monthlyIncome)}/month).`,
        });
      }

      // Down payment goal (for higher income)
      if (monthlyIncome > 3000 && recommendations.length < 4) {
        const downPaymentTarget = monthlyIncome * 12; // 1 year of income
        recommendations.push({
          name: 'Home Down Payment',
          suggested_amount: downPaymentTarget,
          icon: '🏠',
          color: '#A78BFA',
          reason: `Work toward a home down payment of ${Math.round(downPaymentTarget)}.`,
        });
      }
    }

    // Return max 4 recommendations
    res.json(recommendations.slice(0, 4));
  } catch (error) {
    console.error('Get recommendations error:', error);
    res.status(500).json({ error: 'Failed to get recommendations' });
  }
});

export default router;
