export interface User {
  id: string
  email: string
  name: string
  currency: string
  role: 'admin' | 'client'
  username?: string
  phone?: string
  created_at: string
}

export interface Account {
  id: string
  user_id: string
  name: string
  type: 'checking' | 'savings' | 'credit' | 'investment' | 'crypto' | 'loan' | 'mortgage' | 'property' | '401k' | 'ira' | 'roth_ira' | 'brokerage' | '529' | 'hsa' | 'pension' | 'other_investment'
  institution: string
  balance: number
  last_four: string
  icon: string
  is_hidden: boolean
  created_at: string
  updated_at: string
}

export interface Transaction {
  id: string
  user_id: string
  account_id: string
  name: string
  amount: number
  category_id: string
  date: string
  notes: string | null
  is_pending: boolean
  is_recurring: boolean
  recurring_id: string | null
  tags: string[]
  created_at: string
  updated_at: string
  // joined fields
  category_name?: string
  category_icon?: string
  category_color?: string
  account_name?: string
}

export interface Category {
  id: string
  user_id: string
  name: string
  icon: string
  color: string
  budget_amount: number | null
  is_income: boolean
  parent_id: string | null
  sort_order: number
}

export interface RecurringExpense {
  id: string
  user_id: string
  account_id: string | null
  name: string
  amount: number
  category_id: string
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annually'
  next_date: string
  last_charged_date: string | null
  is_active: boolean
  notes: string | null
  price_history: { date: string; amount: number }[]
  created_at: string
  updated_at: string
  // joined
  category_name?: string
  category_icon?: string
  category_color?: string
}

export interface Budget {
  id: string
  user_id: string
  category_id: string
  month: string
  amount: number
  rollover: boolean
  rollover_amount: number
  // joined
  category_name?: string
  category_icon?: string
  category_color?: string
  spent?: number
  transaction_count?: number
}

export interface Goal {
  id: string
  user_id: string
  name: string
  target_amount: number
  current_amount: number
  target_date: string | null
  icon: string
  color: string
  is_completed: boolean
  created_at: string
  updated_at: string
}

export interface Investment {
  id: string
  user_id: string
  account_id: string
  symbol: string
  name: string
  type: 'stock' | 'etf' | 'mutual_fund' | 'crypto' | 'bond' | 'other'
  shares: number
  cost_basis: number
  current_price: number
  last_updated: string
  // computed
  current_value?: number
  gain_loss?: number
  gain_loss_percent?: number
}

export interface NetWorthSnapshot {
  id: string
  user_id: string
  date: string
  total_assets: number
  total_liabilities: number
  net_worth: number
  breakdown: {
    cash: number
    investments: number
    property: number
    crypto: number
    debts: number
  }
}

export interface CashFlowData {
  month: string
  income: number
  expenses: number
  net: number
}

export interface MonthlyReport {
  month: string
  total_income: number
  total_expenses: number
  net: number
  top_categories: { name: string; icon: string; color: string; amount: number; count: number }[]
  budget_adherence: number
  savings_rate: number
}

// ── Insights ──

export interface HealthFactor {
  name: string
  score: number
  weight: number
}

export interface HealthScore {
  score: number
  grade: string
  factors: HealthFactor[]
}

export interface Insight {
  id: string
  severity: 'critical' | 'warning' | 'positive' | 'info'
  title: string
  description: string
  metric: string
  trend: 'up' | 'down' | 'stable'
  category: string
  action?: string
}

export interface Recommendation {
  id: string
  title: string
  description: string
  estimatedSavings?: number
  priority: 'high' | 'medium' | 'low'
}

export interface PeriodView {
  totalIncome: number
  totalExpenses: number
  totalRecurring: number
  netCashFlow: number
  savingsRate: number
}

export interface InsightsData {
  healthScore: HealthScore
  insights: Insight[]
  recommendations: Recommendation[]
  monthlyView: PeriodView
  annualView: PeriodView
}

// ── Upload ──

export interface UploadSession {
  id: string
  user_id: string
  status: 'processing' | 'review' | 'completed' | 'failed'
  file_count: number
  total_items: number
  imported_items: number
  duplicate_items: number
  created_at: string
  completed_at: string | null
  files?: UploadedFile[]
  items?: PendingItem[]
}

export interface UploadedFile {
  id: string
  session_id: string
  filename: string
  file_type: string
  file_size: number
  row_count: number
  status: 'parsing' | 'parsed' | 'importing' | 'done' | 'error'
  error_message?: string
}

export interface PendingItem {
  id: string
  session_id: string
  file_id: string
  parsed_name: string
  parsed_amount: number
  parsed_date: string
  parsed_category: string | null
  matched_category_id: string | null
  matched_account_id: string | null
  status: 'pending' | 'approved' | 'skipped' | 'imported' | 'duplicate'
  duplicate_of: string | null
  confidence: number
  raw_data: Record<string, string>
  // joined
  category_name?: string
  category_icon?: string
  category_color?: string
}

export interface DuplicateMatch {
  itemId: string
  matchedTransactionId: string
  score: number
  reasons: string[]
  matchType: 'existing' | 'cross_file'
}

// ── Clarifications ──

export interface Clarification {
  id: string
  user_id: string
  source: 'upload' | 'insight'
  item_type: string
  title: string
  description: string
  context: Record<string, any>
  status: 'pending' | 'resolved' | 'dismissed'
  resolution: Record<string, any> | null
  created_at: string
  resolved_at: string | null
}
