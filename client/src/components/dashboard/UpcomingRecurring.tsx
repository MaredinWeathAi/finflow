import { differenceInDays, parseISO } from 'date-fns'
import { cn, formatCurrency } from '@/lib/utils'

interface UpcomingItem {
  name: string
  amount: number
  next_date: string
  category_icon: string
}

interface UpcomingRecurringProps {
  items: UpcomingItem[]
}

export function UpcomingRecurring({ items }: UpcomingRecurringProps) {
  const sorted = [...items]
    .sort((a, b) => parseISO(a.next_date).getTime() - parseISO(b.next_date).getTime())
    .slice(0, 5)

  if (sorted.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Upcoming
        </p>
        <div className="mt-8 flex items-center justify-center py-8">
          <p className="text-sm text-muted-foreground">No upcoming charges</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-5">
        Upcoming
      </p>

      <div className="space-y-3">
        {sorted.map((item, idx) => {
          const daysUntil = differenceInDays(parseISO(item.next_date), new Date())
          const daysLabel =
            daysUntil <= 0
              ? 'Due today'
              : daysUntil === 1
                ? 'Tomorrow'
                : `In ${daysUntil} days`

          const isUrgent = daysUntil <= 2

          return (
            <div
              key={`${item.name}-${idx}`}
              className="flex items-center gap-3 rounded-xl bg-muted/40 px-3.5 py-3"
            >
              <span className="text-base shrink-0" role="img" aria-label={item.name}>
                {item.category_icon || '📅'}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.name}</p>
                <p
                  className={cn(
                    'text-xs',
                    isUrgent ? 'text-warning font-medium' : 'text-muted-foreground'
                  )}
                >
                  {daysLabel}
                </p>
              </div>
              <span className="shrink-0 text-sm font-semibold tabular-nums">
                {formatCurrency(item.amount)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
