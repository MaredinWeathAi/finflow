import { cn, formatCurrency } from '@/lib/utils'

interface TrendingCategory {
  name: string
  icon: string
  color: string
  spent: number
  budget: number
  count: number
}

interface TrendingCategoriesProps {
  categories: TrendingCategory[]
}

export function TrendingCategories({ categories }: TrendingCategoriesProps) {
  const sorted = [...categories]
    .map((c) => ({
      ...c,
      percent: c.budget > 0 ? (c.spent / c.budget) * 100 : 0,
    }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 5)

  if (sorted.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Trending Categories
        </p>
        <div className="mt-8 flex items-center justify-center py-8">
          <p className="text-sm text-muted-foreground">No budget data for this month</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-5">
        Trending Categories
      </p>

      <div className="space-y-4">
        {sorted.map((cat) => {
          const barPercent = Math.min(cat.percent, 100)
          const isOver = cat.percent > 100

          return (
            <div key={cat.name} className="flex items-center gap-4">
              <div className="flex w-40 shrink-0 items-center gap-2.5 min-w-0">
                <span className="text-lg" role="img" aria-label={cat.name}>
                  {cat.icon}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{cat.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {cat.count} transaction{cat.count !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              <div className="flex-1">
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-700 ease-out',
                      isOver ? 'opacity-90' : ''
                    )}
                    style={{
                      width: `${barPercent}%`,
                      backgroundColor: isOver ? '#FF6B6B' : cat.color,
                    }}
                  />
                </div>
              </div>

              <div className="w-36 shrink-0 text-right">
                <span
                  className={cn(
                    'text-sm font-semibold',
                    isOver ? 'text-danger' : ''
                  )}
                >
                  {formatCurrency(cat.spent)}
                </span>
                {cat.budget > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {' '}/ {formatCurrency(cat.budget)}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
