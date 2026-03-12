import { cn, formatCurrency } from '@/lib/utils'

interface BudgetBurnRateProps {
  budgets: Array<{
    category_name: string
    category_icon: string
    category_color: string
    amount: number  // budgeted
    spent: number   // actual spent
    transaction_count: number
  }>
  dayOfMonth: number
  daysInMonth: number
}

export function BudgetBurnRate({
  budgets,
  dayOfMonth,
  daysInMonth,
}: BudgetBurnRateProps) {
  // Calculate expected pace position
  const expectedPacePercent = (dayOfMonth / daysInMonth) * 100

  // Sort by spent amount and take top 5
  const topBudgets = budgets
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 5)

  // Calculate totals
  const totalBudgeted = topBudgets.reduce((sum, b) => sum + b.amount, 0)
  const totalSpent = topBudgets.reduce((sum, b) => sum + b.spent, 0)

  const calculateBudgetStatus = (spent: number, budget: number) => {
    const percentSpent = budget > 0 ? (spent / budget) * 100 : 0
    const expectedPercent = expectedPacePercent
    const isOverPace = percentSpent > expectedPercent
    const difference = spent - budget
    return {
      percentSpent,
      isOverPace,
      difference,
    }
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-lg font-bold">Budget Burn Rate</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Day {dayOfMonth} of {daysInMonth} ({Math.round((dayOfMonth / daysInMonth) * 100)}% through month)
        </p>
      </div>

      {/* Budget Items */}
      <div className="space-y-5">
        {topBudgets.map((budget) => {
          const status = calculateBudgetStatus(budget.spent, budget.amount)
          const percentSpent = Math.min(status.percentSpent, 100)

          return (
            <div key={budget.category_name} className="flex flex-col gap-2">
              {/* Category Header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{
                      backgroundColor: `${budget.category_color}20`,
                    }}
                  >
                    <span className="text-sm">{budget.category_icon}</span>
                  </div>
                  <span className="text-sm font-medium">{budget.category_name}</span>
                </div>
                <span className="text-xs font-semibold text-muted-foreground">
                  {formatCurrency(budget.spent)} / {formatCurrency(budget.amount)}
                </span>
              </div>

              {/* Progress Bar with Expected Pace Marker */}
              <div className="relative h-6 bg-foreground/5 rounded-full overflow-hidden">
                {/* Expected pace line */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-muted-foreground/40 z-10"
                  style={{ left: `${expectedPacePercent}%` }}
                  title={`Expected pace: ${Math.round(expectedPacePercent)}%`}
                />

                {/* Filled bar */}
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-300 flex items-center justify-end pr-1',
                    status.isOverPace
                      ? 'bg-gradient-to-r from-orange-500 to-red-500'
                      : 'transition-colors'
                  )}
                  style={{
                    width: `${percentSpent}%`,
                    backgroundColor: !status.isOverPace
                      ? budget.category_color
                      : undefined,
                  }}
                />

                {/* Over budget indicator */}
                {status.percentSpent > 100 && (
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <span className="text-xs font-bold text-foreground opacity-75">
                      {Math.round(status.percentSpent)}%
                    </span>
                  </div>
                )}
              </div>

              {/* Status Text */}
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">
                  {Math.round(percentSpent)}% spent
                </div>
                <div
                  className={cn(
                    'text-xs font-semibold',
                    status.difference > 0
                      ? 'text-orange-400'
                      : 'text-emerald-400'
                  )}
                >
                  {status.difference > 0
                    ? `$${Math.abs(status.difference).toFixed(2)} over`
                    : `$${Math.abs(status.difference).toFixed(2)} under`
                  }
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Overall Total */}
      {topBudgets.length > 0 && (
        <div className="mt-6 pt-6 border-t border-border/50">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-semibold">Total (Top 5)</span>
            <span className="text-sm font-semibold">
              {formatCurrency(totalSpent)} / {formatCurrency(totalBudgeted)}
            </span>
          </div>

          {/* Overall Progress Bar */}
          <div className="relative h-6 bg-foreground/5 rounded-full overflow-hidden">
            {/* Expected pace line */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-muted-foreground/40 z-10"
              style={{ left: `${expectedPacePercent}%` }}
            />

            {/* Filled bar */}
            <div
              className={cn(
                'h-full rounded-full transition-all duration-300',
                totalBudgeted > 0
                  ? calculateBudgetStatus(totalSpent, totalBudgeted).isOverPace
                    ? 'bg-gradient-to-r from-orange-500 to-red-500'
                    : 'bg-gradient-to-r from-blue-500 to-purple-500'
                  : 'bg-muted'
              )}
              style={{
                width: `${Math.min(
                  totalBudgeted > 0 ? (totalSpent / totalBudgeted) * 100 : 0,
                  100
                )}%`,
              }}
            />
          </div>

          {/* Overall Status */}
          <div className="flex items-center justify-between mt-2">
            <div className="text-xs text-muted-foreground">
              {totalBudgeted > 0
                ? `${Math.round((totalSpent / totalBudgeted) * 100)}% of budget`
                : 'No budget data'}
            </div>
            <div
              className={cn(
                'text-xs font-semibold',
                totalSpent > totalBudgeted
                  ? 'text-orange-400'
                  : 'text-emerald-400'
              )}
            >
              {totalSpent > totalBudgeted
                ? `$${(totalSpent - totalBudgeted).toFixed(2)} over`
                : `$${(totalBudgeted - totalSpent).toFixed(2)} under`
              }
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {topBudgets.length === 0 && (
        <div className="py-8 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">No budget data available</p>
        </div>
      )}
    </div>
  )
}
