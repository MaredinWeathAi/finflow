import { useState, useEffect } from 'react'
import { format, subMonths } from 'date-fns'
import { Download, FileText, Table, Printer, Share2 } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { cn, formatCurrency } from '@/lib/utils'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import type { MonthlyReport, CashFlowData } from '@/types'
import { toast } from 'sonner'

export function ReportsPage() {
  const [activeTab, setActiveTab] = useState<'monthly' | 'annual'>('monthly')
  const [monthlyReport, setMonthlyReport] = useState<MonthlyReport | null>(null)
  const [annualData, setAnnualData] = useState<CashFlowData[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const currentMonth = format(new Date(), 'yyyy-MM-dd')
  const currentYear = format(new Date(), 'yyyy')

  useEffect(() => {
    setIsLoading(true)
    if (activeTab === 'monthly') {
      api.get<MonthlyReport>(`/reports/monthly?month=${currentMonth}`)
        .then(setMonthlyReport)
        .catch(console.error)
        .finally(() => setIsLoading(false))
    } else {
      api.get<CashFlowData[]>(`/reports/cashflow?period=12m`)
        .then(setAnnualData)
        .catch(console.error)
        .finally(() => setIsLoading(false))
    }
  }, [activeTab])

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

  const handlePrint = () => {
    window.print()
  }

  const handleShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'FinBudget Report',
          text: 'Check out my financial report',
          url: window.location.href,
        })
      } else {
        // Fallback: copy URL to clipboard
        await navigator.clipboard.writeText(window.location.href)
        toast.success('Report link copied to clipboard')
      }
    } catch (err) {
      if ((err as any).name !== 'AbortError') {
        toast.error('Failed to share')
      }
    }
  }

  return (
    <div>
      <PageHeader title="Reports" description="Financial reports and data export" />

      {/* Tab Selector */}
      <div className="flex items-center gap-2 mb-6 print:hidden">
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

      {isLoading ? (
        <div className="bg-card rounded-2xl border border-border/50 p-8 text-center text-muted-foreground">Loading...</div>
      ) : activeTab === 'monthly' && monthlyReport ? (
        <div className="space-y-6">
          {/* Monthly Summary */}
          <div className="grid grid-cols-3 gap-3">
            <div className="bg-card rounded-xl border print:border-gray-200 border-border/50 p-4 print:bg-white print:text-black">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Income</p>
              <p className="text-xl font-bold text-success mt-1">{formatCurrency(monthlyReport.total_income)}</p>
            </div>
            <div className="bg-card rounded-xl border print:border-gray-200 border-border/50 p-4 print:bg-white print:text-black">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expenses</p>
              <p className="text-xl font-bold text-danger mt-1">{formatCurrency(monthlyReport.total_expenses)}</p>
            </div>
            <div className="bg-card rounded-xl border print:border-gray-200 border-border/50 p-4 print:bg-white print:text-black">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Savings Rate</p>
              <p className="text-xl font-bold mt-1">{monthlyReport.savings_rate.toFixed(1)}%</p>
            </div>
          </div>

          {/* Top Categories */}
          <div className="bg-card rounded-2xl border print:border-gray-200 border-border/50 p-6 print:bg-white print:text-black">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Top Spending Categories</p>
            <div className="space-y-3">
              {monthlyReport.top_categories.map((cat, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-lg">{cat.icon}</span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium">{cat.name}</span>
                      <span className="text-sm font-semibold tabular-nums">{formatCurrency(cat.amount)}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min((cat.amount / monthlyReport.total_expenses) * 100, 100)}%`,
                          backgroundColor: cat.color,
                        }}
                      />
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground w-12 text-right">{cat.count} txns</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : activeTab === 'annual' ? (
        <div className="space-y-6">
          <div className="bg-card rounded-2xl border print:border-gray-200 border-border/50 p-6 print:bg-white print:text-black">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Annual Income vs Expenses</p>
            <div style={{ height: 'clamp(250px, 30vw, 350px)' }}>
              <ResponsiveContainer>
                <BarChart data={annualData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                  <XAxis dataKey="month" tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: 'hsl(240 25% 9%)', border: '1px solid hsl(240 10% 18%)', borderRadius: 8 }} formatter={(v: number) => formatCurrency(v)} />
                  <Legend />
                  <Bar dataKey="income" fill="#34D399" radius={[4, 4, 0, 0]} name="Income" />
                  <Bar dataKey="expenses" fill="#FF6B6B" radius={[4, 4, 0, 0]} name="Expenses" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-card rounded-2xl border print:border-gray-200 border-border/50 p-6 print:bg-white print:text-black">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Summary</p>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm text-muted-foreground">Total Income</p>
                <p className="text-lg font-bold text-success">{formatCurrency(annualData.reduce((s, d) => s + d.income, 0))}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Expenses</p>
                <p className="text-lg font-bold text-danger">{formatCurrency(annualData.reduce((s, d) => s + d.expenses, 0))}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Net Saved</p>
                <p className="text-lg font-bold">{formatCurrency(annualData.reduce((s, d) => s + d.net, 0))}</p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Export Section */}
      <div className="mt-8 print:hidden">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Export Data & Share</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <button onClick={handleExportCSV} className="flex items-center gap-3 bg-card rounded-xl border print:border-gray-200 border-border/50 p-4 hover:bg-accent/30 transition-colors text-left">
            <Table className="w-8 h-8 text-success" />
            <div>
              <p className="text-sm font-medium">Export CSV</p>
              <p className="text-xs text-muted-foreground">Transactions as CSV</p>
            </div>
          </button>
          <button onClick={handleExportJSON} className="flex items-center gap-3 bg-card rounded-xl border print:border-gray-200 border-border/50 p-4 hover:bg-accent/30 transition-colors text-left">
            <FileText className="w-8 h-8 text-primary" />
            <div>
              <p className="text-sm font-medium">Export JSON</p>
              <p className="text-xs text-muted-foreground">Full data backup</p>
            </div>
          </button>
          <button
            onClick={handlePrint}
            className="flex items-center gap-3 bg-card rounded-xl border print:border-gray-200 border-border/50 p-4 hover:bg-accent/30 transition-colors text-left"
          >
            <Printer className="w-8 h-8 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">Print Report</p>
              <p className="text-xs text-muted-foreground">Save as PDF</p>
            </div>
          </button>
          <button
            onClick={handleShare}
            className="flex items-center gap-3 bg-card rounded-xl border print:border-gray-200 border-border/50 p-4 hover:bg-accent/30 transition-colors text-left"
          >
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
