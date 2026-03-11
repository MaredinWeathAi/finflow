import { Wallet, TrendingDown, TrendingUp, AlertTriangle } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'

interface SafeToSpendCardProps {
  income: number
  totalBudgeted: number
  totalSpent: number
  upcomingRecurring: number
  isOverspending?: boolean
  overspendAmount?: number
}

export function SafeToSpendCard({
  income,
  totalBudgeted,
  totalSpent,
  upcomingRecurring,
  isOverspending,
  overspendAmount,
}: SafeToSpendCardProps) {
  const safeToSpend = income - totalSpent - upcomingRecurring
  const isNegative = safeToSpend < 0
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
  const dayOfMonth = new Date().getDate()
  const daysLeft = daysInMonth - dayOfMonth
  const dailyBudget = daysLeft > 0 && safeToSpend > 0 ? safeToSpend / daysLeft : 0

  // How are we doing? Compare pace
  const expectedSpentByNow = totalBudgeted > 0 ? (totalBudgeted * dayOfMonth) / daysInMonth : 0
  const isAhead = totalSpent < expectedSpentByNow
  const pacePercent = expectedSpentByNow > 0
    ? Math.round(((expectedSpentByNow - totalSpent) / expectedSpentByNow) * 100)
    : 0

  // Choose color theme based on financial health
  const getTheme = () => {
    if (isOverspending || isNegative) return {
      bg: 'from-red-500/20 via-red-500/10',
      border: 'border-red-500/20',
      accent: 'text-red-400',
      iconBg: 'bg-red-500/20',
      label: 'text-red-400',
      value: 'text-red-50',
    }
    if (safeToSpend < income * 0.1) return {
      bg: 'from-amber-500/20 via-amber-500/10',
      border: 'border-amber-500/20',
      accent: 'text-amber-400',
      iconBg: 'bg-amber-500/20',
      label: 'text-amber-400',
      value: 'text-amber-50',
    }
    return {
      bg: 'from-emerald-500/20 via-emerald-500/10',
      border: 'border-emerald-500/20',
      accent: 'text-emerald-400',
      iconBg: 'bg-emerald-500/20',
      label: 'text-emerald-400',
      value: 'text-emerald-50',
    }
  }

  const theme = getTheme()

  return (
    <div className={cn('bg-gradient-to-br to-card rounded-2xl border p-6 relative overflow-hidden', theme.bg, theme.border)}>
      {/* Background decoration */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-white/[0.02] rounded-full -translate-y-8 translate-x-8" />

      <div className="flex items-center gap-2 mb-3 relative">
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', theme.iconBg)}>
          {isOverspending || isNegative ? (
            <AlertTriangle className={cn('w-4 h-4', theme.accent)} />
          ) : (
            <Wallet className={cn('w-4 h-4', theme.accent)} />
          )}
        </div>
        <p className={cn('text-xs font-semibold uppercase tracking-wider', theme.label)}>
          {isOverspending ? 'Overspending' : isNegative ? 'Over Budget' : 'Safe to Spend'}
        </p>
      </div>

      <div className="relative">
        {isOverspending || isNegative ? (
          <>
            <p className={cn('text-3xl font-bold tabular-nums', theme.value)}>
              -{formatCurrency(Math.abs(isOverspending ? (overspendAmount || 0) : safeToSpend))}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {isOverspending
                ? 'spending exceeds income this month'
                : 'more than planned this month'
              }
            </p>
          </>
        ) : (
          <>
            <p className={cn('text-3xl font-bold tabular-nums', theme.value)}>
              {formatCurrency(safeToSpend)}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {daysLeft > 0 ? (
                <>
                  <span className={cn('font-medium', theme.accent)}>{formatCurrency(dailyBudget)}</span>
                  {' '}per day for {daysLeft} days left
                </>
              ) : (
                'End of month'
              )}
            </p>
          </>
        )}
      </div>

      {totalBudgeted > 0 && (
        <div className="flex items-center gap-1.5 mt-3 relative">
          {isAhead ? (
            <TrendingDown className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <TrendingUp className="w-3.5 h-3.5 text-red-400" />
          )}
          <span
            className={cn(
              'text-xs font-medium',
              isAhead ? 'text-emerald-400' : 'text-red-400'
            )}
          >
            {isAhead
              ? `${Math.abs(pacePercent)}% under pace`
              : `${Math.abs(pacePercent)}% over pace`
            }
          </span>
        </div>
      )}
    </div>
  )
}
