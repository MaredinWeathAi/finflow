/**
 * THE default category list.
 *
 * There were two, and they had drifted: upload.ts backfilled 36 categories
 * including Asset Sale, Loan Proceeds and Asset Transfer, while
 * POST /categories/ensure-defaults created a different 24 and its "system
 * categories" backfill topped up exactly two of them by hand. The result was
 * that a category the flow classifier depends on could be permanently absent
 * for an existing user: Interactive Brokers withdrawals resolved to
 * "Asset Transfer", the category did not exist, the lookup returned null, and
 * the rows fell through to Other Income — booking $39,200 of moving your own
 * money as earnings, in direct contradiction of the merchant entry that had
 * just been corrected to prevent exactly that.
 *
 * Both callers now backfill from this list, and they backfill ALL of it rather
 * than a hand-picked subset.
 */

export interface DefaultCategory {
  name: string;
  icon: string;
  color: string;
  isIncome: boolean;
}

// NOTE: there is deliberately no 'Uncategorized' category. A row with no
// category IS uncategorised; having a category that means "no category" gave
// every report two adjacent rows for the same idea — one for the real category
// and one for the NULL bucket — which is exactly what the monthly matrix made
// obvious. Reports label the NULL bucket 'Uncategorized' for display.
export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: 'Housing', icon: '🏠', color: '#6366F1', isIncome: false },
  { name: 'Groceries', icon: '🛒', color: '#22C55E', isIncome: false },
  { name: 'Food & Dining', icon: '🍔', color: '#F59E0B', isIncome: false },
  { name: 'Transportation', icon: '🚗', color: '#3B82F6', isIncome: false },
  { name: 'Shopping', icon: '🛍️', color: '#8B5CF6', isIncome: false },
  { name: 'Utilities', icon: '💡', color: '#14B8A6', isIncome: false },
  { name: 'Healthcare', icon: '🏥', color: '#EF4444', isIncome: false },
  { name: 'Entertainment', icon: '🎬', color: '#EC4899', isIncome: false },
  { name: 'Subscriptions', icon: '📱', color: '#F97316', isIncome: false },
  { name: 'Insurance', icon: '🛡️', color: '#06B6D4', isIncome: false },
  { name: 'Health & Fitness', icon: '💪', color: '#10B981', isIncome: false },
  { name: 'Personal Care', icon: '💇', color: '#D946EF', isIncome: false },
  { name: 'Education', icon: '📚', color: '#0EA5E9', isIncome: false },
  { name: 'Travel', icon: '✈️', color: '#F472B6', isIncome: false },
  { name: 'Pets', icon: '🐾', color: '#A78BFA', isIncome: false },
  { name: 'Gifts & Donations', icon: '🎁', color: '#FB923C', isIncome: false },
  { name: 'Investments', icon: '📊', color: '#818CF8', isIncome: false },
  { name: 'Salary', icon: '💵', color: '#10B981', isIncome: true },
  { name: 'Freelance', icon: '💼', color: '#22D3EE', isIncome: true },
  { name: 'Other Income', icon: '💰', color: '#34D399', isIncome: true },
  { name: 'Transfer', icon: '🔄', color: '#94A3B8', isIncome: false },
  // Debt and housing kept apart. "Housing" holding a mortgage, two vehicle
  // leases and a child's college rent in one number answers no question
  // anyone actually asks.
  { name: 'Mortgage', icon: '🏦', color: '#4F46E5', isIncome: false },
  { name: 'Auto Lease', icon: '🚙', color: '#2563EB', isIncome: false },
  { name: 'CC PMT', icon: '💳', color: '#94A3B8', isIncome: false },
  { name: 'Loan Payment', icon: '📉', color: '#78716C', isIncome: false },
  { name: 'Loan Proceeds', icon: '📈', color: '#A8A29E', isIncome: false },
  { name: 'Asset Sale', icon: '🔁', color: '#0D9488', isIncome: false },
  // Money moved out of an account the household already owns (brokerage
  // withdrawal, IRA distribution to checking). Not earnings — it converts
  // one asset into another, so it belongs in neither income nor expenses.
  { name: 'Asset Transfer', icon: '🏦', color: '#64748B', isIncome: false },
  // Money set aside is not money consumed; it needs its own line so the
  // savings rate is not read as spending.
  { name: 'College Savings', icon: '🎓', color: '#0891B2', isIncome: false },
  { name: 'Kids', icon: '🧒', color: '#F59E0B', isIncome: false },
  { name: 'Home Services', icon: '🔧', color: '#65A30D', isIncome: false },
  { name: 'Home Improvements', icon: '🛠️', color: '#CA8A04', isIncome: false },
  // One-off capital work on the house — a roof, a re-pipe, an addition. Kept
  // apart from Home Improvements because a $37,494 roof is not a monthly
  // decision, and lumping it in put it in the 'cuttable' column of the
  // committed-vs-discretionary report.
  { name: 'Capital Improvements', icon: '🏗️', color: '#B45309', isIncome: false },
  { name: 'Taxes', icon: '🧾', color: '#DC2626', isIncome: false },
  { name: 'Bank Fees', icon: '🏧', color: '#9F1239', isIncome: false },
  { name: 'Cash', icon: '💵', color: '#57534E', isIncome: false },
];
