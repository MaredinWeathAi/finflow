import { Wallet, TrendingDown, TrendingUp } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'

interface SafeToSpendCardProps {
  income: number
  totalBudgeted: number
  totalSpent: number
  upcomingRecurring: number
}

export function SafeToSpendCard({ income, totalBudgeted, totalSpent, upcomingRecurring }: SafeToSpendCardProps) {
  // Safe to spend = income - spent so far - upcoming recurring bills
  const safeToSpend = Math.max(0, income - totalSpent - upcomingRecurring)
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
  const dayOfMonth = new Date().getDate()
  const daysLeft = daysInMonth - dayOfMonth
  const dailyBudget = daysLeft > 0 ? safeToSpend / daysLeft : 0

  // How are we doing? Compare pace
  const expectedSpentByNow = totalBudgeted > 0 ? (totalBudgeted * dayOfMonth) / daysInMonth : 0
  const isAhead = totalSpent < expectedSpentByNow
  const pacePercent = expectedSpentByNow > 0
    ? Math.round(((expectedSpentByNow - totalSpent) / expectedSpentByNow) * 100)
    : 0

  return (
    <div className="bg-gradient-to-br from-emerald-500/20 via-emerald-500/10 to-card rounded-2xl border border-emerald-500/20 p-6 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full -translate-y-8 translate-x-8" />

      <div className="flex items-center gap-2 mb-3 relative">
        <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
          <Wallet className="w-4 h-4 text-emerald-400" />
        </div>
        <p className="text-xs font-semibold uppercase tracking-wider text-emerald-400">
          Safe to Spend
        </p>
      </div>

      <div className="relative">
        <p className="text-3xl font-bold tabular-nums text-emerald-50">
          {formatCurrency(safeToSpend)}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {daysLeft > 0 ? (
            <>
              <span className="text-emerald-400 font-medium">{formatCurrency(dailyBudget)}</span>
              {' '}per day for {daysLeft} days left
            </>
          ) : (
            'End of month'
          )}
        </p>
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
