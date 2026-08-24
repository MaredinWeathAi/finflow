import { useState } from 'react'
import { Wallet, AlertTriangle, CalendarClock, ChevronDown, ChevronUp, Landmark, ShieldCheck, Receipt } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { useSafeToSpend } from '@/hooks/useSafeToSpend'

/**
 * Safe to Spend — server-computed (GET /api/safe-to-spend).
 *
 * The old version computed `income − spent − upcomingRecurring` in the browser
 * with no idea what the account balance was, so it went deeply negative before
 * payday. The server now computes:
 *
 *   liquid cash balance − committed bills before the next paycheck − buffer
 *
 * and returns every component, which this card surfaces so the number can
 * explain itself. Low-confidence results (sparse/stale/new-user data) are
 * labelled instead of shown as confident truth.
 */
export function SafeToSpendCard() {
  const { data, isLoading, error } = useSafeToSpend()
  const [showDetails, setShowDetails] = useState(false)

  if (isLoading) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="h-4 w-32 rounded bg-muted animate-pulse" />
        <div className="h-9 w-44 rounded bg-muted animate-pulse mt-3" />
        <div className="h-4 w-56 rounded bg-muted animate-pulse mt-2" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Safe to Spend</p>
        <p className="text-sm text-muted-foreground mt-2">Couldn't load safe-to-spend right now.</p>
      </div>
    )
  }

  const isNegative = data.safeToSpend < 0
  const isTight = !isNegative && data.balance.total > 0 && data.safeToSpend < data.balance.total * 0.05
  const isLowConfidence = data.confidence === 'low'

  // Theme: emerald = healthy, amber = tight, red = committed outflows exceed
  // cash. Every colour pairs a light-mode shade with a dark: variant — the old
  // card hardcoded dark-mode-only colours (text-emerald-50 on a light page).
  const theme = isNegative
    ? {
        bg: 'from-red-500/15 via-red-500/5',
        border: 'border-red-500/20',
        accent: 'text-red-600 dark:text-red-400',
        iconBg: 'bg-red-500/15 dark:bg-red-500/20',
      }
    : isTight
    ? {
        bg: 'from-amber-500/15 via-amber-500/5',
        border: 'border-amber-500/20',
        accent: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-500/15 dark:bg-amber-500/20',
      }
    : {
        bg: 'from-emerald-500/15 via-emerald-500/5',
        border: 'border-emerald-500/20',
        accent: 'text-emerald-600 dark:text-emerald-400',
        iconBg: 'bg-emerald-500/15 dark:bg-emerald-500/20',
      }

  const payDateLabel = data.nextIncome
    ? new Date(data.nextIncome.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null

  const visibleCommitted = data.committed.items.slice(0, 5)
  const hiddenCommittedCount = data.committed.items.length - visibleCommitted.length

  return (
    <div className={cn('bg-gradient-to-br to-card rounded-2xl border p-6 relative overflow-hidden', theme.bg, theme.border)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 relative">
        <div className="flex items-center gap-2">
          <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', theme.iconBg)}>
            {isNegative ? (
              <AlertTriangle className={cn('w-4 h-4', theme.accent)} />
            ) : (
              <Wallet className={cn('w-4 h-4', theme.accent)} />
            )}
          </div>
          <p className={cn('text-xs font-semibold uppercase tracking-wider', theme.accent)}>
            Safe to Spend
          </p>
        </div>
        {isLowConfidence && (
          <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
            Low confidence
          </span>
        )}
      </div>

      {/* Headline number */}
      <div className="relative">
        <p className={cn('text-3xl font-bold tabular-nums', isNegative ? theme.accent : 'text-foreground')}>
          {isNegative ? '-' : ''}{formatCurrency(Math.abs(data.safeToSpend))}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {isNegative ? (
            <>bills due before {payDateLabel ? `payday (${payDateLabel})` : 'the next 30 days end'} exceed your cash</>
          ) : (
            <>
              <span className={cn('font-medium', theme.accent)}>{formatCurrency(data.perDay)}</span>
              {' '}per day for {data.daysUntilNextIncome} day{data.daysUntilNextIncome === 1 ? '' : 's'}
              {payDateLabel ? ` until payday (${payDateLabel})` : ''}
            </>
          )}
        </p>
      </div>

      {/* How the number is built */}
      <div className="mt-4 pt-3 border-t border-border/30 space-y-1.5 relative">
        <div className="flex items-center gap-2 text-xs">
          <Landmark className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">
            Cash ({data.balance.accounts.length} account{data.balance.accounts.length === 1 ? '' : 's'})
          </span>
          <span className="font-medium ml-auto tabular-nums">{formatCurrency(data.balance.total)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Receipt className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">
            Bills before {payDateLabel ?? 'window end'} ({data.committed.items.length})
          </span>
          <span className="font-medium ml-auto tabular-nums">−{formatCurrency(data.committed.total)}</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <ShieldCheck className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">Buffer (floor + spending volatility)</span>
          <span className="font-medium ml-auto tabular-nums">−{formatCurrency(data.buffer.total)}</span>
        </div>
        {data.nextIncome && (
          <div className="flex items-center gap-2 text-xs">
            <CalendarClock className="w-3 h-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground truncate">
              Next income: {data.nextIncome.name}
            </span>
            <span className={cn('font-medium ml-auto tabular-nums whitespace-nowrap', theme.accent)}>
              +{formatCurrency(data.nextIncome.amount)} · {payDateLabel}
            </span>
          </div>
        )}
      </div>

      {/* Expandable committed-bills detail */}
      {data.committed.items.length > 0 && (
        <div className="mt-2 relative">
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            {showDetails ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showDetails ? 'Hide upcoming bills' : 'Show upcoming bills'}
          </button>
          {showDetails && (
            <div className="mt-2 space-y-1">
              {visibleCommitted.map((item, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground truncate max-w-[55%]">
                    {item.name}
                    {item.source === 'detected' && (
                      <span className="text-[10px] text-muted-foreground/70"> · detected</span>
                    )}
                  </span>
                  <span className="text-[10px] text-muted-foreground mr-2">
                    {new Date(item.dueDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                  <span className="font-medium tabular-nums">{formatCurrency(item.amount)}</span>
                </div>
              ))}
              {hiddenCommittedCount > 0 && (
                <p className="text-[10px] text-muted-foreground">+ {hiddenCommittedCount} more</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Data-quality notes */}
      {data.notes.length > 0 && (
        <p className="text-[10px] text-muted-foreground italic mt-3 relative">
          {data.notes[0]}
        </p>
      )}
    </div>
  )
}
