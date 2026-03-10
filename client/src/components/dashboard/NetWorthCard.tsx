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
  const change = previousNetWorth !== 0
    ? ((netWorth - previousNetWorth) / Math.abs(previousNetWorth)) * 100
    : 0
  const isPositive = change >= 0

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6 flex flex-col justify-between">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Net Worth
        </p>
        <div className="mt-2 flex items-end gap-3">
          <AnimatedNumber
            value={netWorth}
            duration={1200}
            formatter={formatCurrency}
            className="text-3xl font-bold tracking-tight"
          />
          {previousNetWorth !== 0 && (
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

      {history.length > 1 && (
        <div className="mt-4 h-20">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={history} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
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

      {history.length <= 1 && (
        <div className="mt-4 h-20 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Not enough history data</p>
        </div>
      )}
    </div>
  )
}
