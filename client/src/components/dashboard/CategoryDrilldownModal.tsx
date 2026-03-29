import { useState, useEffect } from 'react'
import { X, ExternalLink, ArrowUpDown } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn, formatCurrency } from '@/lib/utils'
import { api } from '@/lib/api'
import { format, parseISO } from 'date-fns'

interface DrilldownTransaction {
  id: string
  name: string
  amount: number
  date: string
  account_name: string
  category_name: string
  category_icon: string
  category_color: string
}

interface CategoryDrilldownModalProps {
  open: boolean
  onClose: () => void
  categoryId: string
  categoryName: string
  categoryIcon: string
  categoryColor: string
  avgAmount: number
  totalAmount: number
  count: number
  dateStart: string
  dateEnd: string
  type: 'expense' | 'income'
}

export function CategoryDrilldownModal({
  open,
  onClose,
  categoryId,
  categoryName,
  categoryIcon,
  categoryColor,
  avgAmount,
  totalAmount,
  count,
  dateStart,
  dateEnd,
  type,
}: CategoryDrilldownModalProps) {
  const navigate = useNavigate()
  const [transactions, setTransactions] = useState<DrilldownTransaction[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [sortByDate, setSortByDate] = useState(true) // true = date desc, false = amount desc

  useEffect(() => {
    if (!open || !categoryId) return
    setIsLoading(true)
    api
      .get<{ transactions: DrilldownTransaction[] }>(
        `/transactions?category=${categoryId}&startDate=${dateStart}&endDate=${dateEnd}&limit=500&sort=date_desc`
      )
      .then((res) => {
        const txs = res.transactions || []
        setTransactions(txs)
      })
      .catch(() => setTransactions([]))
      .finally(() => setIsLoading(false))
  }, [open, categoryId, dateStart, dateEnd])

  if (!open) return null

  const sorted = [...transactions].sort((a, b) => {
    if (sortByDate) return b.date.localeCompare(a.date)
    return Math.abs(b.amount) - Math.abs(a.amount)
  })

  const handleViewInTransactions = () => {
    onClose()
    navigate(`/transactions?category=${categoryId}`)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-2xl shadow-xl flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border/30 shrink-0">
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-lg"
              style={{ backgroundColor: `${categoryColor}20` }}
            >
              {categoryIcon || '📁'}
            </div>
            <div>
              <h2 className="text-lg font-semibold">{categoryName}</h2>
              <p className="text-xs text-muted-foreground">
                {count} transactions &middot; {formatDateRange(dateStart, dateEnd)}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-accent rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Summary bar */}
        <div className="grid grid-cols-2 gap-4 px-6 py-3 border-b border-border/30 bg-muted/30 shrink-0">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Total</p>
            <p className={cn('text-lg font-bold tabular-nums', type === 'income' ? 'text-emerald-400' : 'text-foreground')}>
              {formatCurrency(totalAmount)}
            </p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Monthly Avg</p>
            <p className={cn('text-lg font-bold tabular-nums', type === 'income' ? 'text-emerald-400' : 'text-foreground')}>
              {formatCurrency(avgAmount)}
              <span className="text-xs font-normal text-muted-foreground">/mo</span>
            </p>
          </div>
        </div>

        {/* Sort toggle */}
        <div className="flex items-center justify-between px-6 py-2 border-b border-border/20 shrink-0">
          <p className="text-xs text-muted-foreground">{sorted.length} transactions</p>
          <button
            onClick={() => setSortByDate(!sortByDate)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowUpDown className="w-3 h-3" />
            {sortByDate ? 'By date' : 'By amount'}
          </button>
        </div>

        {/* Transaction list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {isLoading ? (
            <div className="p-8 text-center">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
              <p className="text-sm text-muted-foreground mt-2">Loading transactions...</p>
            </div>
          ) : sorted.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">No transactions found</div>
          ) : (
            <div className="divide-y divide-border/20">
              {sorted.map((tx) => (
                <div key={tx.id} className="flex items-center gap-3 px-6 py-3 hover:bg-accent/20 transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{tx.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">
                        {format(parseISO(tx.date), 'MMM d, yyyy')}
                      </span>
                      {tx.account_name && (
                        <span className="text-xs text-muted-foreground">&middot; {tx.account_name}</span>
                      )}
                    </div>
                  </div>
                  <p className={cn('text-sm font-semibold tabular-nums shrink-0', tx.amount > 0 ? 'text-emerald-400' : 'text-foreground')}>
                    {formatCurrency(Math.abs(tx.amount))}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer — View in Transactions */}
        <div className="px-6 py-3 border-t border-border/30 shrink-0">
          <button
            onClick={handleViewInTransactions}
            className="w-full flex items-center justify-center gap-2 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            View All in Transactions
          </button>
        </div>
      </div>
    </div>
  )
}

function formatDateRange(start: string, end: string): string {
  try {
    const s = parseISO(start)
    const e = parseISO(end)
    return `${format(s, 'MMM yyyy')} - ${format(e, 'MMM yyyy')}`
  } catch {
    return ''
  }
}
