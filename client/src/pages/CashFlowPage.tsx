import { useState, useEffect } from 'react'
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { cn, formatCurrency } from '@/lib/utils'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import type { CashFlowData } from '@/types'

const periods = [
  { value: '3m', label: '3 Months' },
  { value: '6m', label: '6 Months' },
  { value: '12m', label: '12 Months' },
  { value: '24m', label: '24 Months' },
  { value: 'ytd', label: 'Year to Date' },
]

// "2026-08" -> "Aug 2026". The API keys months as YYYY-MM; showing that raw
// makes the range line and the table needlessly hard to read.
function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number)
  if (!y || !m) return key
  return `${new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' })} ${y}`
}

export function CashFlowPage() {
  const [period, setPeriod] = useState('6m')
  const [data, setData] = useState<CashFlowData[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    setIsLoading(true)
    api.get<CashFlowData[]>(`/reports/cashflow?period=${period}`)
      .then(setData)
      .catch(console.error)
      .finally(() => setIsLoading(false))
  }, [period])

  // Every card below is a total over the SELECTED period. They used to read
  // data[data.length - 1] — the most recent month only — so switching between
  // 3m / 6m / 12m / YTD changed the charts underneath but left three of the
  // four numbers identical, which is what made the header look broken.
  const months = data.length
  const totalIncome = data.reduce((s, d) => s + d.income, 0)
  const totalExpenses = data.reduce((s, d) => s + d.expenses, 0)
  const totalNet = totalIncome - totalExpenses
  const savingsRate = totalIncome > 0 ? (totalNet / totalIncome) * 100 : 0

  const avgIncome = months > 0 ? totalIncome / months : 0
  const avgExpenses = months > 0 ? totalExpenses / months : 0
  const avgNet = months > 0 ? totalNet / months : 0

  // The API only returns COMPLETE months, so the current partial month is not
  // in here. Say so, rather than letting the totals quietly undercount.
  const rangeLabel = months > 0
    ? `${monthLabel(data[0].month)} – ${monthLabel(data[months - 1].month)} · ${months} complete month${months === 1 ? '' : 's'}`
    : ''

  return (
    <div>
      <PageHeader title="Cash Flow" description="Income vs expenses analysis" />

      {/* Period Selector */}
      <div className="flex items-center gap-2 mb-6">
        {periods.map(p => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={cn(
              'h-8 px-4 rounded-lg text-sm font-medium transition-colors',
              period === p.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-card border border-border/50 hover:bg-accent'
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Exactly which months the numbers below cover. Complete months only —
          the current partial month is deliberately excluded so a half-finished
          August cannot masquerade as a bad month. */}
      {rangeLabel && (
        <p className="text-xs text-muted-foreground -mt-4 mb-5 px-1">{rangeLabel}</p>
      )}

      {/* Summary Cards — totals over the selected period, not the latest month */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net</p>
          <p className={cn('text-xl font-bold mt-1', totalNet >= 0 ? 'text-success' : 'text-danger')}>
            {formatCurrency(totalNet)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {months > 0 ? `${formatCurrency(avgNet)}/mo average` : '—'}
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Income</p>
          <p className="text-xl font-bold text-success mt-1">{formatCurrency(totalIncome)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {months > 0 ? `${formatCurrency(avgIncome)}/mo average` : '—'}
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expenses</p>
          <p className="text-xl font-bold text-danger mt-1">{formatCurrency(totalExpenses)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {months > 0 ? `${formatCurrency(avgExpenses)}/mo average` : '—'}
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Savings Rate</p>
          <p className={cn('text-xl font-bold mt-1', savingsRate >= 0 ? '' : 'text-danger')}>
            {totalIncome > 0 ? `${savingsRate.toFixed(1)}%` : '—'}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {totalIncome > 0 ? `kept from ${formatCurrency(totalIncome)} earned` : 'no income in range'}
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="bg-card rounded-2xl border border-border/50 p-8 text-center text-muted-foreground">Loading...</div>
      ) : months === 0 ? (
        <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
          <p className="font-medium">No complete months in this range</p>
          <p className="text-sm text-muted-foreground mt-1">
            Cash flow only counts months with full statement coverage, so a month still in
            progress is left out. Try a longer period, or import the missing statements.
          </p>
        </div>
      ) : (
        <>
          {/* Cash Flow Bar Chart */}
          <div className="bg-card rounded-2xl border border-border/50 p-6 mb-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Income vs Expenses</p>
            <div style={{ height: 'clamp(250px, 30vw, 350px)' }}>
              <ResponsiveContainer>
                <BarChart data={data} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                  <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(240 25% 9%)',
                      border: '1px solid hsl(240 10% 18%)',
                      borderRadius: 8,
                    }}
                    formatter={(value: number) => formatCurrency(value)}
                    labelFormatter={(label: string) => monthLabel(label)}
                  />
                  <Legend />
                  <Bar dataKey="income" fill="#34D399" radius={[4, 4, 0, 0]} name="Income" />
                  <Bar dataKey="expenses" fill="#FF6B6B" radius={[4, 4, 0, 0]} name="Expenses" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Net Income Area Chart */}
          <div className="bg-card rounded-2xl border border-border/50 p-6 mb-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Net Income Trend</p>
            <div style={{ height: 250 }}>
              <ResponsiveContainer>
                <AreaChart data={data}>
                  <defs>
                    <linearGradient id="netGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#A78BFA" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#A78BFA" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                  <XAxis dataKey="month" tickFormatter={monthLabel} tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(240 25% 9%)',
                      border: '1px solid hsl(240 10% 18%)',
                      borderRadius: 8,
                    }}
                    formatter={(value: number) => formatCurrency(value)}
                    labelFormatter={(label: string) => monthLabel(label)}
                  />
                  <Area type="monotone" dataKey="net" stroke="#A78BFA" fill="url(#netGrad)" strokeWidth={2} name="Net Income" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Monthly Comparison Table */}
          <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
            <div className="px-5 py-3 border-b border-border/30">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Monthly Comparison</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="text-left px-5 py-3 font-medium">Month</th>
                    <th className="text-right px-5 py-3 font-medium">Income</th>
                    <th className="text-right px-5 py-3 font-medium">Expenses</th>
                    <th className="text-right px-5 py-3 font-medium">Net</th>
                    <th className="text-right px-5 py-3 font-medium">Savings Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {data.map(d => {
                    const sr = d.income > 0 ? ((d.net) / d.income) * 100 : 0
                    return (
                      <tr key={d.month} className="text-sm hover:bg-accent/20">
                        <td className="px-5 py-3 font-medium">{monthLabel(d.month)}</td>
                        <td className="px-5 py-3 text-right text-success tabular-nums">{formatCurrency(d.income)}</td>
                        <td className="px-5 py-3 text-right text-danger tabular-nums">{formatCurrency(d.expenses)}</td>
                        <td className={cn('px-5 py-3 text-right font-semibold tabular-nums', d.net >= 0 ? 'text-success' : 'text-danger')}>
                          {formatCurrency(d.net)}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">{sr.toFixed(1)}%</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
