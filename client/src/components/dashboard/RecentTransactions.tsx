import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import {
  isToday,
  isYesterday,
  format,
  parseISO,
} from 'date-fns'
import { cn, formatCurrency } from '@/lib/utils'
import type { Transaction } from '@/types'

interface RecentTransactionsProps {
  transactions: Transaction[]
}

function formatRelativeDate(dateStr: string): string {
  const date = parseISO(dateStr)
  if (isToday(date)) return 'Today'
  if (isYesterday(date)) return 'Yesterday'
  return format(date, 'MMM d')
}

export function RecentTransactions({ transactions }: RecentTransactionsProps) {
  if (transactions.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="flex items-center justify-between mb-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Recent Transactions
          </p>
        </div>
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-muted-foreground">No transactions yet</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center justify-between mb-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Recent Transactions
        </p>
        <Link
          to="/transactions"
          className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:text-primary/80 transition-colors"
        >
          View All
          <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="space-y-1">
        {transactions.slice(0, 8).map((tx) => {
          const isIncome = tx.amount > 0

          return (
            <div
              key={tx.id}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 -mx-3 transition-colors hover:bg-muted/50"
            >
              <span className="text-lg shrink-0" role="img" aria-label={tx.category_name || ''}>
                {tx.category_icon || '💰'}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{tx.name}</p>
                  {tx.is_pending && (
                    <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning">
                      Pending
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  {tx.category_name && (
                    <span
                      className="inline-block rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        backgroundColor: tx.category_color
                          ? `${tx.category_color}20`
                          : 'hsl(var(--muted))',
                        color: tx.category_color || 'hsl(var(--muted-foreground))',
                      }}
                    >
                      {tx.category_name}
                    </span>
                  )}
                  <span className="text-[11px] text-muted-foreground">
                    {formatRelativeDate(tx.date)}
                  </span>
                </div>
              </div>

              <span
                className={cn(
                  'shrink-0 text-sm font-semibold tabular-nums',
                  isIncome ? 'text-success' : ''
                )}
              >
                {isIncome ? '+' : ''}{formatCurrency(tx.amount)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
