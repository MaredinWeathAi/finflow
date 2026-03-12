import { useState, useMemo } from 'react'
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
} from 'recharts'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { cn, formatCurrency, formatPercent } from '@/lib/utils'
import { AnimatedNumber } from '@/components/shared/AnimatedNumber'

interface NetWorthCardProps {
  netWorth: number
  previousNetWorth: number
  history: { date: string; value: number }[]
}

const TIME_RANGES = [
  { label: '1M', months: 1 },
  { label: '3M', months: 3 },
  { label: '6M', months: 6 },
  { label: 'YTD', months: -1 },
  { label: '1Y', months: 12 },
  { label: 'All', months: 0 },
] as const

function CustomTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-border/50 bg-popover px-3 py-2 shadow-xl">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{formatCurrency(payload[0].value as number)}</p>
    </div>
  )
}

export function NetWorthCard({ netWorth, previousNetWorth, history }: NetWorthCardProps) {
  const [selectedRange, setSelectedRange] = useState('All')

  const filteredHistory = useMemo(() => {
    if (selectedRange === 'All' || history.length <= 1) return history
    const range = TIME_RANGES.find(r => r.label === selectedRange)
    if (!range) return history

    if (range.label === 'YTD') {
      const currentMonth = new Date().getMonth() + 1
      return history.slice(Math.max(0, history.length - currentMonth))
    }
    if (range.months > 0) {
      return history.slice(Math.max(0, history.length - range.months))
    }
    return history
  }, [history, selectedRange])

  const rangeStart = filteredHistory.length >= 2 ? filteredHistory[0].value : previousNetWorth
  const change = rangeStart !== 0
    ? ((netWorth - rangeStart) / Math.abs(rangeStart)) * 100
    : 0
  const isPositive = change >= 0

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6 flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Net Worth
          </p>
          {history.length > 1 && (
            <div className="flex gap-0.5 bg-muted/50 rounded-lg p-0.5">
              {TIME_RANGES.map(r => (
                <button
                  key={r.label}
                  onClick={() => setSelectedRange(r.label)}
                  className={cn(
                    'px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors',
                    selectedRange === r.label
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-1 flex items-end gap-3">
          <AnimatedNumber
            value={netWorth}
            duration={1200}
            formatter={formatCurrency}
            className="text-3xl font-bold tracking-tight"
          />
          {rangeStart !== 0 && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
                isPositive
                  ? 'bg-success/15 text-success'
                  : 'bg-danger/15 text-danger'
              )}
            >
              {isPositive ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              {formatPercent(change)}
            </span>
          )}
        </div>
      </div>

      {filteredHistory.length > 1 && (
        <div className="mt-4 h-20">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={filteredHistory} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="netWorthGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#A78BFA" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#A78BFA" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Tooltip content={<CustomTooltip />} />
              <Area
                type="monotone"
                dataKey="value"
                stroke="#A78BFA"
                strokeWidth={2}
                fill="url(#netWorthGradient)"
                dot={false}
                activeDot={{ r: 3, fill: '#A78BFA', stroke: 'hsl(var(--card))' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {filteredHistory.length <= 1 && (
        <div className="mt-4 h-20 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Not enough history data</p>
        </div>
      )}
    </div>
  )
}
