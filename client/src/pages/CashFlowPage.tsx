import { useState, useEffect } from 'react'
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { cn, formatCurrency, formatPercent } from '@/lib/utils'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import type { CashFlowData } from '@/types'

const periods = [
  { value: '3m', label: '3 Months' },
  { value: '6m', label: '6 Months' },
  { value: '12m', label: '12 Months' },
  { value: 'ytd', label: 'Year to Date' },
]

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

  const currentMonth = data[data.length - 1]
  const prevMonth = data[data.length - 2]

  const totalIncome = data.reduce((s, d) => s + d.income, 0)
  const totalExpenses = data.reduce((s, d) => s + d.expenses, 0)
  const avgSavingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0

  const incomeChange = currentMonth && prevMonth && prevMonth.income > 0
    ? ((currentMonth.income - prevMonth.income) / prevMonth.income) * 100
    : 0

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

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Income</p>
          <p className={cn('text-xl font-bold mt-1', (currentMonth?.net || 0) >= 0 ? 'text-success' : 'text-danger')}>
            {formatCurrency(currentMonth?.net || 0)}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">This month</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Income</p>
          <p className="text-xl font-bold text-success mt-1">{formatCurrency(currentMonth?.income || 0)}</p>
          {incomeChange !== 0 && (
            <p className={cn('text-xs mt-0.5', incomeChange > 0 ? 'text-success' : 'text-danger')}>
              {formatPercent(incomeChange)} vs last month
            </p>
          )}
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expenses</p>
          <p className="text-xl font-bold text-danger mt-1">{formatCurrency(currentMonth?.expenses || 0)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Savings Rate</p>
          <p className="text-xl font-bold mt-1">{avgSavingsRate.toFixed(1)}%</p>
          <p className="text-xs text-muted-foreground mt-0.5">Average</p>
        </div>
      </div>

      {isLoading ? (
        <div className="bg-card rounded-2xl border border-border/50 p-8 text-center text-muted-foreground">Loading...</div>
      ) : (
        <>
          {/* Cash Flow Bar Chart */}
          <div className="bg-card rounded-2xl border border-border/50 p-6 mb-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Income vs Expenses</p>
            <div style={{ height: 'clamp(250px, 30vw, 350px)' }}>
              <ResponsiveContainer>
                <BarChart data={data} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                  <XAxis dataKey="month" tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(240 25% 9%)',
                      border: '1px solid hsl(240 10% 18%)',
                      borderRadius: 8,
                    }}
                    formatter={(value: number) => formatCurrency(value)}
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
                  <XAxis dataKey="month" tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(240 25% 9%)',
                      border: '1px solid hsl(240 10% 18%)',
                      borderRadius: 8,
                    }}
                    formatter={(value: number) => formatCurrency(value)}
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
                        <td className="px-5 py-3 font-medium">{d.month}</td>
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
