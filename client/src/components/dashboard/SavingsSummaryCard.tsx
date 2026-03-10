import { PiggyBank, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'

interface SavingsSummaryCardProps {
  income: number
  expenses: number
  previousSavings?: number
}

export function SavingsSummaryCard({ income, expenses, previousSavings }: SavingsSummaryCardProps) {
  const saved = income - expenses
  const savingsRate = income > 0 ? (saved / income) * 100 : 0
  const isPositive = saved >= 0

  // Compare to previous month if available
  const hasPrevious = previousSavings !== undefined && previousSavings !== null
  const changePercent = hasPrevious && previousSavings !== 0
    ? ((saved - previousSavings) / Math.abs(previousSavings)) * 100
    : 0
  const isImproving = changePercent > 0

  // Health indicator
  const getHealthLabel = () => {
    if (savingsRate >= 20) return { label: 'Excellent', color: 'text-emerald-400' }
    if (savingsRate >= 10) return { label: 'Good', color: 'text-emerald-400' }
    if (savingsRate >= 0) return { label: 'Low', color: 'text-amber-400' }
    return { label: 'Overspending', color: 'text-red-400' }
  }

  const health = getHealthLabel()

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6 h-full">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-violet-500/20 flex items-center justify-center">
            <PiggyBank className="w-4 h-4 text-violet-400" />
          </div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Monthly Savings
          </p>
        </div>
        <span className={cn('text-xs font-semibold px-2 py-0.5 rounded-full',
          isPositive ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
        )}>
          {savingsRate.toFixed(1)}% rate
        </span>
      </div>

      <p className={cn('text-2xl font-bold tabular-nums', isPositive ? 'text-emerald-400' : 'text-red-400')}>
        {isPositive ? '+' : ''}{formatCurrency(saved)}
      </p>
      <p className="text-sm text-muted-foreground mt-1">
        of {formatCurrency(income)} earned
      </p>

      <div className="flex items-center gap-3 mt-3">
        <span className={cn('text-xs font-semibold', health.color)}>
          {health.label}
        </span>
        {hasPrevious && (
          <div className="flex items-center gap-1">
            {isImproving ? (
              <TrendingUp className="w-3 h-3 text-emerald-400" />
            ) : changePercent < 0 ? (
              <TrendingDown className="w-3 h-3 text-red-400" />
            ) : (
              <Minus className="w-3 h-3 text-muted-foreground" />
            )}
            <span className={cn('text-xs', isImproving ? 'text-emerald-400' : changePercent < 0 ? 'text-red-400' : 'text-muted-foreground')}>
              {changePercent !== 0 ? `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(0)}% vs last month` : 'Same as last month'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
