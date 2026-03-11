import { useState, useEffect } from 'react'
import { format, subMonths, addMonths } from 'date-fns'
import {
  Download, FileText, Table, Printer, Share2, ChevronLeft, ChevronRight,
  TrendingUp, TrendingDown, DollarSign, Percent, Target, Wallet,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  PieChart, Pie, Cell, AreaChart, Area, LineChart, Line,
} from 'recharts'
import { cn, formatCurrency } from '@/lib/utils'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import type { CashFlowData } from '@/types'
import { toast } from 'sonner'

interface ReportSummary {
  income: number
  expenses: number
  net: number
  savings_rate: number
  expense_categories: { name: string; icon: string; color: string; amount: number; count: number }[]
  income_categories: { name: string; icon: string; color: string; amount: number; count: number }[]
  accounts: { name: string; type: string; balance: number }[]
  goals: { name: string; target: number; current: number; color: string; icon: string }[]
  budgets: { name: string; limit: number; spent: number; color: string; icon: string }[]
  daily_spending: { date: string; amount: number }[]
  monthly_trend: { month: string; income: number; expenses: number; net: number }[]
  top_merchants: { name: string; amount: number; count: number }[]
}

const CHART_COLORS = [
  '#6366F1', '#22C55E', '#F59E0B', '#3B82F6', '#8B5CF6', '#14B8A6',
  '#EF4444', '#EC4899', '#F97316', '#06B6D4', '#10B981', '#D946EF',
]

function StatCard({ icon: Icon, label, value, color, trend }: {
  icon: any; label: string; value: string; color: string; trend?: 'up' | 'down'
}) {
  return (
    <div className="bg-card rounded-xl border border-border/50 p-4 print:bg-white print:border-gray-200 print:text-black">
      <div className="flex items-center gap-2 mb-2">
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center', color)}>
          <Icon className="w-4 h-4" />
        </div>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground print:text-gray-500">{label}</span>
      </div>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
    </div>
  )
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-card border border-border/50 rounded-lg p-3 shadow-xl text-sm print:hidden">
      <p className="font-medium mb-1">{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color }} className="tabular-nums">
          {p.name}: {formatCurrency(p.value)}
        </p>
      ))}
    </div>
  )
}

export function ReportsPage() {
  const [activeTab, setActiveTab] = useState<'monthly' | 'annual'>('monthly')
  const [summary, setSummary] = useState<ReportSummary | null>(null)
  const [annualData, setAnnualData] = useState<CashFlowData[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedMonth, setSelectedMonth] = useState(new Date())

  const monthStr = format(selectedMonth, 'yyyy-MM')
  const monthLabel = format(selectedMonth, 'MMMM yyyy')

  useEffect(() => {
    setIsLoading(true)
    if (activeTab === 'monthly') {
      api.get<ReportSummary>(`/reports/summary?month=${monthStr}`)
        .then(setSummary)
        .catch(() => setSummary(null))
        .finally(() => setIsLoading(false))
    } else {
      api.get<CashFlowData[]>(`/reports/cashflow?period=12m`)
        .then(setAnnualData)
        .catch(() => setAnnualData([]))
        .finally(() => setIsLoading(false))
    }
  }, [activeTab, monthStr])

  const handleExportCSV = async () => {
    try {
      const data = await api.get<any>('/data/export')
      const csv = convertToCSV(data.transactions || [])
      downloadFile(csv, 'transactions.csv', 'text/csv')
      toast.success('CSV exported')
    } catch { toast.error('Export failed') }
  }

  const handleExportJSON = async () => {
    try {
      const data = await api.get<any>('/data/export')
      downloadFile(JSON.stringify(data, null, 2), 'finbudget-data.json', 'application/json')
      toast.success('Data exported')
    } catch { toast.error('Export failed') }
  }

  const handlePrint = () => window.print()

  const handleShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'FinBudget Report', text: 'Check out my financial report', url: window.location.href })
      } else {
        await navigator.clipboard.writeText(window.location.href)
        toast.success('Report link copied to clipboard')
      }
    } catch (err) {
      if ((err as any).name !== 'AbortError') toast.error('Failed to share')
    }
  }

  const netWorth = summary?.accounts?.reduce((s, a) => s + a.balance, 0) ?? 0

  return (
    <div>
      {/* Print-only header */}
      <div className="hidden print:block mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center">
            <span className="text-white font-bold text-lg">F</span>
          </div>
          <div>
            <h1 className="text-2xl font-bold">FinBudget Report</h1>
            <p className="text-gray-500 text-sm">{monthLabel}</p>
          </div>
        </div>
        <hr className="border-gray-300" />
      </div>

      <div className="print:hidden">
        <PageHeader title="Reports" description="Financial reports and analytics" />
      </div>

      {/* Tab + Month Nav */}
      <div className="flex items-center justify-between mb-6 print:hidden">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('monthly')}
            className={cn('h-9 px-4 rounded-lg text-sm font-medium transition-colors',
              activeTab === 'monthly' ? 'bg-primary text-primary-foreground' : 'bg-card border border-border/50 hover:bg-accent'
            )}
          >
            Monthly Report
          </button>
          <button
            onClick={() => setActiveTab('annual')}
            className={cn('h-9 px-4 rounded-lg text-sm font-medium transition-colors',
              activeTab === 'annual' ? 'bg-primary text-primary-foreground' : 'bg-card border border-border/50 hover:bg-accent'
            )}
          >
            Annual Overview
          </button>
        </div>
        {activeTab === 'monthly' && (
          <div className="flex items-center gap-2">
            <button onClick={() => setSelectedMonth(subMonths(selectedMonth, 1))} className="p-2 rounded-lg hover:bg-accent transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-sm font-medium w-36 text-center">{monthLabel}</span>
            <button onClick={() => setSelectedMonth(addMonths(selectedMonth, 1))} className="p-2 rounded-lg hover:bg-accent transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : activeTab === 'monthly' && summary ? (
        <div className="space-y-6">
          {/* Stat Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard icon={TrendingUp} label="Income" value={formatCurrency(summary.income)} color="bg-emerald-500/10 text-emerald-500" />
            <StatCard icon={TrendingDown} label="Expenses" value={formatCurrency(summary.expenses)} color="bg-red-500/10 text-red-500" />
            <StatCard icon={DollarSign} label="Net Savings" value={formatCurrency(summary.net)} color="bg-blue-500/10 text-blue-500" />
            <StatCard icon={Percent} label="Savings Rate" value={`${summary.savings_rate.toFixed(1)}%`} color="bg-purple-500/10 text-purple-500" />
          </div>

          {/* Charts Row: Expense Pie + Daily Spending */}
          <div className="grid lg:grid-cols-2 gap-4">
            {/* Expense Breakdown Pie */}
            {summary.expense_categories.length > 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-5 print:bg-white print:border-gray-200">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 print:text-gray-500">Expense Breakdown</p>
                <div style={{ height: 260 }}>
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie
                        data={summary.expense_categories.slice(0, 10)}
                        cx="50%" cy="50%"
                        innerRadius={55} outerRadius={100}
                        paddingAngle={2}
                        dataKey="amount"
                        nameKey="name"
                      >
                        {summary.expense_categories.slice(0, 10).map((cat, i) => (
                          <Cell key={i} fill={cat.color || CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => formatCurrency(v)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-3">
                  {summary.expense_categories.slice(0, 8).map((cat, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: cat.color || CHART_COLORS[i % CHART_COLORS.length] }} />
                      <span className="truncate">{cat.icon} {cat.name}</span>
                      <span className="ml-auto tabular-nums font-medium">{formatCurrency(cat.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Daily Spending */}
            {summary.daily_spending.length > 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-5 print:bg-white print:border-gray-200">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 print:text-gray-500">Daily Spending</p>
                <div style={{ height: 260 }}>
                  <ResponsiveContainer>
                    <AreaChart data={summary.daily_spending}>
                      <defs>
                        <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#EF4444" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="#EF4444" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                      <XAxis dataKey="date" tick={{ fill: 'hsl(240 5% 55%)', fontSize: 10 }} tickFormatter={(d) => d.split('-')[2]} />
                      <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 10 }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Area type="monotone" dataKey="amount" stroke="#EF4444" fill="url(#spendGrad)" name="Spending" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
                  <span>Daily avg: {formatCurrency(summary.daily_spending.reduce((s, d) => s + d.amount, 0) / Math.max(summary.daily_spending.length, 1))}</span>
                  <span>Peak: {formatCurrency(Math.max(...summary.daily_spending.map(d => d.amount)))}</span>
                </div>
              </div>
            )}
          </div>

          {/* 6-Month Trend */}
          {summary.monthly_trend.length > 0 && (
            <div className="bg-card rounded-2xl border border-border/50 p-5 print:bg-white print:border-gray-200">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 print:text-gray-500">6-Month Trend</p>
              <div style={{ height: 280 }}>
                <ResponsiveContainer>
                  <BarChart data={summary.monthly_trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                    <XAxis dataKey="month" tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                    <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Bar dataKey="income" fill="#22C55E" radius={[4, 4, 0, 0]} name="Income" />
                    <Bar dataKey="expenses" fill="#EF4444" radius={[4, 4, 0, 0]} name="Expenses" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Net Savings Trend Line */}
          {summary.monthly_trend.length > 1 && (
            <div className="bg-card rounded-2xl border border-border/50 p-5 print:bg-white print:border-gray-200">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 print:text-gray-500">Net Savings Trend</p>
              <div style={{ height: 200 }}>
                <ResponsiveContainer>
                  <LineChart data={summary.monthly_trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                    <XAxis dataKey="month" tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                    <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                    <Tooltip content={<CustomTooltip />} />
                    <Line type="monotone" dataKey="net" stroke="#6366F1" strokeWidth={2.5} dot={{ r: 4, fill: '#6366F1' }} name="Net Savings" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Top Merchants + Budget Performance */}
          <div className="grid lg:grid-cols-2 gap-4">
            {/* Top Merchants */}
            {summary.top_merchants.length > 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-5 print:bg-white print:border-gray-200">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 print:text-gray-500">Top Merchants</p>
                <div className="space-y-2.5">
                  {summary.top_merchants.slice(0, 8).map((m, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <span className="text-xs font-medium text-muted-foreground w-5">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium truncate">{m.name}</span>
                          <span className="text-sm font-semibold tabular-nums">{formatCurrency(m.amount)}</span>
                        </div>
                        <div className="h-1 rounded-full bg-muted mt-1 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${(m.amount / (summary.top_merchants[0]?.amount || 1)) * 100}%` }}
                          />
                        </div>
                      </div>
                      <span className="text-[10px] text-muted-foreground">{m.count}x</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Budget Performance */}
            {summary.budgets.length > 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-5 print:bg-white print:border-gray-200">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 print:text-gray-500">Budget Performance</p>
                <div className="space-y-3">
                  {summary.budgets.map((b, i) => {
                    const pct = b.limit > 0 ? (b.spent / b.limit) * 100 : 0
                    const isOver = pct > 100
                    return (
                      <div key={i}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium">{b.icon} {b.name}</span>
                          <span className={cn('text-xs font-semibold tabular-nums', isOver ? 'text-red-500' : 'text-muted-foreground')}>
                            {formatCurrency(b.spent)} / {formatCurrency(b.limit)}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn('h-full rounded-full transition-all', isOver ? 'bg-red-500' : 'bg-emerald-500')}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Account Balances + Goals */}
          <div className="grid lg:grid-cols-2 gap-4">
            {/* Account Balances */}
            {summary.accounts.length > 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-5 print:bg-white print:border-gray-200">
                <div className="flex items-center justify-between mb-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground print:text-gray-500">Account Balances</p>
                  <div className="text-right">
                    <p className="text-[10px] uppercase text-muted-foreground">Net Worth</p>
                    <p className="text-lg font-bold tabular-nums">{formatCurrency(netWorth)}</p>
                  </div>
                </div>
                <div className="space-y-2">
                  {summary.accounts.map((a, i) => (
                    <div key={i} className="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
                      <div className="flex items-center gap-2">
                        <Wallet className="w-4 h-4 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium">{a.name}</p>
                          <p className="text-[10px] uppercase text-muted-foreground">{a.type}</p>
                        </div>
                      </div>
                      <span className={cn('text-sm font-semibold tabular-nums', a.balance >= 0 ? 'text-emerald-500' : 'text-red-500')}>
                        {formatCurrency(a.balance)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Goals Progress */}
            {summary.goals.length > 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-5 print:bg-white print:border-gray-200">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 print:text-gray-500">Goals Progress</p>
                <div className="space-y-3">
                  {summary.goals.map((g, i) => {
                    const pct = g.target > 0 ? (g.current / g.target) * 100 : 0
                    return (
                      <div key={i}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium">{g.icon} {g.name}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{pct.toFixed(0)}%</span>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full" style={{ backgroundColor: g.color || '#6366F1', width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <div className="flex justify-between mt-0.5">
                          <span className="text-[10px] text-muted-foreground tabular-nums">{formatCurrency(g.current)}</span>
                          <span className="text-[10px] text-muted-foreground tabular-nums">{formatCurrency(g.target)}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      ) : activeTab === 'annual' ? (
        <div className="space-y-6">
          {/* Annual Bar Chart */}
          <div className="bg-card rounded-2xl border border-border/50 p-6 print:bg-white print:border-gray-200">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 print:text-gray-500">12-Month Income vs Expenses</p>
            <div style={{ height: 'clamp(250px, 30vw, 350px)' }}>
              <ResponsiveContainer>
                <BarChart data={annualData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                  <XAxis dataKey="month" tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Legend />
                  <Bar dataKey="income" fill="#22C55E" radius={[4, 4, 0, 0]} name="Income" />
                  <Bar dataKey="expenses" fill="#EF4444" radius={[4, 4, 0, 0]} name="Expenses" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Annual Net Line */}
          <div className="bg-card rounded-2xl border border-border/50 p-6 print:bg-white print:border-gray-200">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4 print:text-gray-500">Net Savings Over Time</p>
            <div style={{ height: 220 }}>
              <ResponsiveContainer>
                <LineChart data={annualData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                  <XAxis dataKey="month" tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Line type="monotone" dataKey="net" stroke="#6366F1" strokeWidth={2.5} dot={{ r: 4, fill: '#6366F1' }} name="Net" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Annual Summary Cards */}
          <div className="grid grid-cols-3 gap-3">
            <StatCard icon={TrendingUp} label="Total Income" value={formatCurrency(annualData.reduce((s, d) => s + d.income, 0))} color="bg-emerald-500/10 text-emerald-500" />
            <StatCard icon={TrendingDown} label="Total Expenses" value={formatCurrency(annualData.reduce((s, d) => s + d.expenses, 0))} color="bg-red-500/10 text-red-500" />
            <StatCard icon={DollarSign} label="Net Saved" value={formatCurrency(annualData.reduce((s, d) => s + d.net, 0))} color="bg-blue-500/10 text-blue-500" />
          </div>
        </div>
      ) : null}

      {/* Export Section */}
      <div className="mt-8 print:hidden">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Export Data & Share</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <button onClick={handleExportCSV} className="flex items-center gap-3 bg-card rounded-xl border border-border/50 p-4 hover:bg-accent/30 transition-colors text-left">
            <Table className="w-8 h-8 text-emerald-500" />
            <div>
              <p className="text-sm font-medium">Export CSV</p>
              <p className="text-xs text-muted-foreground">Transactions spreadsheet</p>
            </div>
          </button>
          <button onClick={handleExportJSON} className="flex items-center gap-3 bg-card rounded-xl border border-border/50 p-4 hover:bg-accent/30 transition-colors text-left">
            <FileText className="w-8 h-8 text-primary" />
            <div>
              <p className="text-sm font-medium">Export JSON</p>
              <p className="text-xs text-muted-foreground">Full data backup</p>
            </div>
          </button>
          <button onClick={handlePrint} className="flex items-center gap-3 bg-card rounded-xl border border-border/50 p-4 hover:bg-accent/30 transition-colors text-left">
            <Printer className="w-8 h-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Print Report</p>
              <p className="text-xs text-muted-foreground">Save as PDF</p>
            </div>
          </button>
          <button onClick={handleShare} className="flex items-center gap-3 bg-card rounded-xl border border-border/50 p-4 hover:bg-accent/30 transition-colors text-left">
            <Share2 className="w-8 h-8 text-primary" />
            <div>
              <p className="text-sm font-medium">Share</p>
              <p className="text-xs text-muted-foreground">Share report link</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}

function convertToCSV(transactions: any[]): string {
  if (!transactions.length) return ''
  const headers = ['Date', 'Name', 'Amount', 'Category', 'Account', 'Notes']
  const rows = transactions.map(t =>
    [t.date, t.name, t.amount, t.category_name || '', t.account_name || '', t.notes || '']
      .map(v => `"${String(v).replace(/"/g, '""')}"`)
      .join(',')
  )
  return [headers.join(','), ...rows].join('\n')
}

function downloadFile(content: string, filename: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
