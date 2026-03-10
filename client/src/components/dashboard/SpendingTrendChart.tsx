import { useState, useEffect } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { TrendingUp } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { api } from '@/lib/api'

interface MonthlyData {
  month: string
  income: number
  expenses: number
  net: number
}

export function SpendingTrendChart() {
  const [data, setData] = useState<MonthlyData[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await api.get<MonthlyData[]>('/reports/cashflow?period=6m')
        setData(Array.isArray(res) ? res : [])
      } catch (err) {
        console.error('Failed to fetch spending trend:', err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchData()
  }, [])

  const formatMonth = (month: string) => {
    const [y, m] = month.split('-')
    const date = new Date(parseInt(y), parseInt(m) - 1)
    return date.toLocaleString('default', { month: 'short' })
  }

  // Calculate average
  const avgExpenses = data.length > 0
    ? data.reduce((sum, d) => sum + d.expenses, 0) / data.length
    : 0

  if (isLoading) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6 h-full">
        <div className="h-4 w-32 rounded bg-muted animate-pulse mb-4" />
        <div className="h-[200px] rounded bg-muted/50 animate-pulse" />
      </div>
    )
  }

  if (data.length < 2) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6 h-full flex flex-col items-center justify-center text-center">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-3">
          <TrendingUp className="w-6 h-6 text-primary" />
        </div>
        <p className="text-sm font-medium">Spending Trend</p>
        <p className="text-xs text-muted-foreground mt-1">
          Add more transactions to see your 6-month spending trend
        </p>
      </div>
    )
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6 h-full">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            6-Month Spending Trend
          </h3>
        </div>
        <span className="text-xs text-muted-foreground">
          Avg: {formatCurrency(avgExpenses)}/mo
        </span>
      </div>

      <div className="w-full" style={{ height: 'clamp(160px, 20vw, 220px)' }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="expenseGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#F87171" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#F87171" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="incomeGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34D399" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#34D399" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 15%)" />
            <XAxis
              dataKey="month"
              tickFormatter={formatMonth}
              stroke="hsl(240 5% 40%)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              stroke="hsl(240 5% 40%)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
              width={45}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(240 25% 9%)',
                border: '1px solid hsl(240 10% 18%)',
                borderRadius: '12px',
                fontSize: '12px',
              }}
              formatter={(value: number, name: string) => [
                formatCurrency(value),
                name === 'expenses' ? 'Expenses' : 'Income'
              ]}
              labelFormatter={formatMonth}
            />
            <Area
              type="monotone"
              dataKey="income"
              stroke="#34D399"
              strokeWidth={2}
              fill="url(#incomeGradient)"
            />
            <Area
              type="monotone"
              dataKey="expenses"
              stroke="#F87171"
              strokeWidth={2}
              fill="url(#expenseGradient)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 mt-3 justify-center">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
          <span className="text-xs text-muted-foreground">Income</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
          <span className="text-xs text-muted-foreground">Expenses</span>
        </div>
      </div>
    </div>
  )
}
