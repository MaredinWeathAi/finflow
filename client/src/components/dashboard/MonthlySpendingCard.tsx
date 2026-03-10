import { cn, formatCurrency } from '@/lib/utils'
import { AnimatedNumber } from '@/components/shared/AnimatedNumber'

interface MonthlySpendingCardProps {
  spent: number
  budget: number
}

export function MonthlySpendingCard({ spent, budget }: MonthlySpendingCardProps) {
  const percent = budget > 0 ? (spent / budget) * 100 : 0
  const remaining = budget - spent
  const isOver = remaining < 0

  const barColor =
    percent >= 100
      ? 'bg-danger'
      : percent >= 80
        ? 'bg-warning'
        : 'bg-success'

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6 flex flex-col justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Spending This Month
        </p>
        <div className="mt-2">
          <AnimatedNumber
            value={spent}
            duration={1200}
            formatter={formatCurrency}
            className="text-3xl font-bold tracking-tight"
          />
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-700 ease-out',
              barColor
            )}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-xs">
          <span
            className={cn(
              'font-medium',
              isOver ? 'text-danger' : 'text-muted-foreground'
            )}
          >
            {isOver
              ? `${formatCurrency(Math.abs(remaining))} over budget`
              : `${formatCurrency(remaining)} remaining`}
          </span>
          {budget > 0 && (
            <span className="text-muted-foreground">
              of {formatCurrency(budget)}
            </span>
          )}
        </div>

        {budget === 0 && (
          <p className="text-xs text-muted-foreground">No budget set this month</p>
        )}
      </div>
    </div>
  )
}
