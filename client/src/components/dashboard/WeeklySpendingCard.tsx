import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  type TooltipProps,
} from 'recharts'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { cn, formatCurrency, formatPercent } from '@/lib/utils'

interface WeeklySpendingCardProps {
  dailySpending: { day: string; amount: number }[]
  percentChange: number
}

function CustomTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-border/50 bg-popover px-3 py-2 shadow-xl">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{formatCurrency(payload[0].value as number)}</p>
    </div>
  )
}

export function WeeklySpendingCard({ dailySpending, percentChange }: WeeklySpendingCardProps) {
  const weekTotal = dailySpending.reduce((sum, d) => sum + d.amount, 0)
  const isPositive = percentChange >= 0

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6 flex flex-col justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          This Week
        </p>
        <div className="mt-2 flex items-end gap-3">
          <span className="text-3xl font-bold tracking-tight">
            {formatCurrency(weekTotal)}
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
              isPositive
                ? 'bg-danger/15 text-danger'
                : 'bg-success/15 text-success'
            )}
          >
            {isPositive ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {formatPercent(percentChange)} vs last week
          </span>
        </div>
      </div>

      {dailySpending.length > 0 ? (
        <div className="mt-4 h-28">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dailySpending} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
              <XAxis
                dataKey="day"
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: 'hsl(240 5% 55%)' }}
              />
              <YAxis hide />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: 'hsl(240 20% 14% / 0.5)' }} />
              <Bar
                dataKey="amount"
                fill="#A78BFA"
                radius={[4, 4, 0, 0]}
                maxBarSize={32}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mt-4 h-28 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">No spending data this week</p>
        </div>
      )}
    </div>
  )
}
