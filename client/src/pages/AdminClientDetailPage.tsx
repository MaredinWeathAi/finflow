import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ArrowLeft, Printer, Share2, Download, Wallet, PieChart, TrendingUp, Target } from 'lucide-react'
import { formatCurrency, cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { format } from 'date-fns'
import { toast } from 'sonner'

interface ClientDetail {
  client: {
    id: string; name: string; email: string; username: string | null; phone: string | null; created_at: string
  }
  accounts: { id: string; name: string; type: string; institution: string; balance: number }[]
  transactions: { id: string; name: string; amount: number; date: string; category_name: string; category_icon: string }[]
  budgets: { category_name: string; category_icon: string; amount: number; spent: number }[]
  goals: { id: string; name: string; target_amount: number; current_amount: number; icon: string }[]
  monthlySummary: { month: string; income: number; expenses: number }[]
}

interface ClientReport {
  client: { name: string; email: string }
  reportType: string
  month?: string
  year?: string
  income?: number
  expenses?: number
  net?: number
  savingsRate?: number
  totalIncome?: number
  totalExpenses?: number
  totalNet?: number
  categoryBreakdown?: { name: string; icon: string; color: string; total: number; count: number }[]
  accounts: { name: string; type: string; balance: number }[]
  goals: { name: string; target_amount: number; current_amount: number; target_date: string | null }[]
}

export function AdminClientDetailPage() {
  const { clientId } = useParams<{ clientId: string }>()
  const [detail, setDetail] = useState<ClientDetail | null>(null)
  const [report, setReport] = useState<ClientReport | null>(null)
  const [activeTab, setActiveTab] = useState<'overview' | 'report'>('overview')
  const [reportType, setReportType] = useState<'monthly' | 'annual'>('monthly')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!clientId) return
    setIsLoading(true)
    api.get<ClientDetail>(`/admin/clients/${clientId}`)
      .then(setDetail)
      .catch(console.error)
      .finally(() => setIsLoading(false))
  }, [clientId])

  const loadReport = async () => {
    if (!clientId) return
    try {
      const r = await api.get<ClientReport>(`/admin/clients/${clientId}/report?type=${reportType}`)
      setReport(r)
    } catch { toast.error('Failed to load report') }
  }

  useEffect(() => {
    if (activeTab === 'report') loadReport()
  }, [activeTab, reportType])

  const handlePrint = () => window.print()

  const handleShare = async () => {
    const url = window.location.href
    if (navigator.share) {
      try {
        await navigator.share({ title: `${detail?.client.name} - FinBudget Report`, url })
      } catch {}
    } else {
      await navigator.clipboard.writeText(url)
      toast.success('Link copied to clipboard')
    }
  }

  if (isLoading) {
    return (
      <div>
        <div className="h-8 w-48 bg-muted rounded animate-pulse mb-6" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {[1,2,3,4].map(i => (
            <div key={i} className="bg-card rounded-2xl border border-border/50 p-5 animate-pulse">
              <div className="h-4 w-20 bg-muted rounded mb-3" />
              <div className="h-7 w-28 bg-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!detail) return <div className="text-center py-12 text-muted-foreground">Client not found</div>

  const { client, accounts, transactions, budgets, goals, monthlySummary } = detail

  // Compute current month summary from monthlySummary array
  const currentMonthData = monthlySummary.length > 0 ? monthlySummary[monthlySummary.length - 1] : { income: 0, expenses: 0 }
  const summaryIncome = currentMonthData.income || 0
  const summaryExpenses = currentMonthData.expenses || 0
  const summaryNet = summaryIncome - summaryExpenses
  const summarySavingsRate = summaryIncome > 0 ? ((summaryIncome - summaryExpenses) / summaryIncome) * 100 : 0

  return (
    <div className="print:bg-white print:text-black">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 print:hidden">
        <div className="flex items-center gap-3">
          <Link to="/admin/clients" className="p-2 rounded-lg hover:bg-accent transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{client.name}</h1>
            <p className="text-sm text-muted-foreground">{client.email}{client.phone ? ` • ${client.phone}` : ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handlePrint} className="flex items-center gap-2 h-9 px-3 rounded-lg border border-input text-sm hover:bg-accent transition-colors">
            <Printer className="w-4 h-4" /> Print
          </button>
          <button onClick={handleShare} className="flex items-center gap-2 h-9 px-3 rounded-lg border border-input text-sm hover:bg-accent transition-colors">
            <Share2 className="w-4 h-4" /> Share
          </button>
        </div>
      </div>

      {/* Print Header */}
      <div className="hidden print:block mb-6">
        <h1 className="text-2xl font-bold">{client.name} — FinBudget Report</h1>
        <p className="text-sm text-gray-500">{client.email} • Generated {format(new Date(), 'MMMM d, yyyy')}</p>
      </div>

      {/* Tab Selector */}
      <div className="flex items-center gap-2 mb-6 print:hidden">
        <button onClick={() => setActiveTab('overview')}
          className={cn('h-9 px-4 rounded-lg text-sm font-medium transition-colors',
            activeTab === 'overview' ? 'bg-primary text-primary-foreground' : 'bg-card border border-border/50 hover:bg-accent')}>
          Overview
        </button>
        <button onClick={() => setActiveTab('report')}
          className={cn('h-9 px-4 rounded-lg text-sm font-medium transition-colors',
            activeTab === 'report' ? 'bg-primary text-primary-foreground' : 'bg-card border border-border/50 hover:bg-accent')}>
          Reports
        </button>
      </div>

      {activeTab === 'overview' ? (
        <div className="space-y-6">
          {/* Monthly Summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-card rounded-2xl border border-border/50 p-5 print:border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp className="w-4 h-4 text-success" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Income</span>
              </div>
              <p className="text-xl font-bold text-success">{formatCurrency(summaryIncome)}</p>
            </div>
            <div className="bg-card rounded-2xl border border-border/50 p-5 print:border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <PieChart className="w-4 h-4 text-danger" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expenses</span>
              </div>
              <p className="text-xl font-bold text-danger">{formatCurrency(summaryExpenses)}</p>
            </div>
            <div className="bg-card rounded-2xl border border-border/50 p-5 print:border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <Wallet className="w-4 h-4 text-primary" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net</span>
              </div>
              <p className={cn('text-xl font-bold', summaryNet >= 0 ? 'text-success' : 'text-danger')}>
                {formatCurrency(summaryNet)}
              </p>
            </div>
            <div className="bg-card rounded-2xl border border-border/50 p-5 print:border-gray-200">
              <div className="flex items-center gap-2 mb-2">
                <Target className="w-4 h-4 text-primary" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Savings Rate</span>
              </div>
              <p className="text-xl font-bold">{summarySavingsRate.toFixed(1)}%</p>
            </div>
          </div>

          {/* Accounts */}
          <div className="bg-card rounded-2xl border border-border/50 p-6 print:border-gray-200">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Accounts</h3>
            {accounts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No accounts</p>
            ) : (
              <div className="space-y-2">
                {accounts.map(acc => (
                  <div key={acc.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/30">
                    <div>
                      <p className="text-sm font-medium">{acc.name}</p>
                      <p className="text-xs text-muted-foreground">{acc.institution} • {acc.type}</p>
                    </div>
                    <p className={cn('text-sm font-semibold tabular-nums', acc.balance >= 0 ? 'text-success' : 'text-danger')}>
                      {formatCurrency(acc.balance)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* Budget Performance */}
            <div className="bg-card rounded-2xl border border-border/50 p-6 print:border-gray-200">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Budget Performance</h3>
              {budgets.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No budgets set</p>
              ) : (
                <div className="space-y-3">
                  {budgets.map((b, i) => {
                    const pct = b.amount > 0 ? Math.min((b.spent / b.amount) * 100, 100) : 0
                    return (
                      <div key={i}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm">{b.category_icon} {b.category_name}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {formatCurrency(b.spent)} / {formatCurrency(b.amount)}
                          </span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className={cn('h-full rounded-full transition-all', pct > 90 ? 'bg-danger' : pct > 70 ? 'bg-warning' : 'bg-success')}
                            style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Goals */}
            <div className="bg-card rounded-2xl border border-border/50 p-6 print:border-gray-200">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Goals</h3>
              {goals.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No goals set</p>
              ) : (
                <div className="space-y-3">
                  {goals.map(g => {
                    const pct = g.target_amount > 0 ? Math.min((g.current_amount / g.target_amount) * 100, 100) : 0
                    return (
                      <div key={g.id}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm">{g.icon} {g.name}</span>
                          <span className="text-xs text-muted-foreground tabular-nums">{pct.toFixed(0)}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                          {formatCurrency(g.current_amount)} of {formatCurrency(g.target_amount)}
                        </p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Recent Transactions */}
          <div className="bg-card rounded-2xl border border-border/50 p-6 print:border-gray-200">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Recent Transactions</h3>
            {transactions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No transactions</p>
            ) : (
              <div className="space-y-2">
                {transactions.map(t => (
                  <div key={t.id} className="flex items-center justify-between p-3 rounded-xl bg-muted/30">
                    <div className="flex items-center gap-3">
                      <span className="text-lg">{t.category_icon || '💳'}</span>
                      <div>
                        <p className="text-sm font-medium">{t.name}</p>
                        <p className="text-xs text-muted-foreground">{t.category_name} • {t.date}</p>
                      </div>
                    </div>
                    <p className={cn('text-sm font-semibold tabular-nums', t.amount > 0 ? 'text-success' : 'text-danger')}>
                      {t.amount > 0 ? '+' : ''}{formatCurrency(t.amount)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Report Tab */
        <div className="space-y-6">
          <div className="flex items-center gap-2 print:hidden">
            <button onClick={() => setReportType('monthly')}
              className={cn('h-8 px-3 rounded-lg text-xs font-medium transition-colors',
                reportType === 'monthly' ? 'bg-primary/20 text-primary' : 'bg-muted hover:bg-accent')}>
              Monthly
            </button>
            <button onClick={() => setReportType('annual')}
              className={cn('h-8 px-3 rounded-lg text-xs font-medium transition-colors',
                reportType === 'annual' ? 'bg-primary/20 text-primary' : 'bg-muted hover:bg-accent')}>
              Annual
            </button>
          </div>

          {report ? (
            <div className="space-y-6" id="printable-report">
              <div className="bg-card rounded-2xl border border-border/50 p-6 print:border-gray-200">
                <h3 className="text-lg font-semibold mb-1">{report.client.name} — {reportType === 'monthly' ? 'Monthly' : 'Annual'} Report</h3>
                <p className="text-sm text-muted-foreground mb-4">Period: {report.month || report.year}</p>

                {(() => {
                  const rIncome = report.income ?? report.totalIncome ?? 0
                  const rExpenses = report.expenses ?? report.totalExpenses ?? 0
                  const rNet = report.net ?? report.totalNet ?? 0
                  const rSavings = report.savingsRate ?? (rIncome > 0 ? ((rIncome - rExpenses) / rIncome) * 100 : 0)
                  return (
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                      <div className="p-3 rounded-xl bg-muted/30">
                        <p className="text-xs text-muted-foreground">Income</p>
                        <p className="text-lg font-bold text-success">{formatCurrency(rIncome)}</p>
                      </div>
                      <div className="p-3 rounded-xl bg-muted/30">
                        <p className="text-xs text-muted-foreground">Expenses</p>
                        <p className="text-lg font-bold text-danger">{formatCurrency(rExpenses)}</p>
                      </div>
                      <div className="p-3 rounded-xl bg-muted/30">
                        <p className="text-xs text-muted-foreground">Net</p>
                        <p className={cn('text-lg font-bold', rNet >= 0 ? 'text-success' : 'text-danger')}>
                          {formatCurrency(rNet)}
                        </p>
                      </div>
                      <div className="p-3 rounded-xl bg-muted/30">
                        <p className="text-xs text-muted-foreground">Savings Rate</p>
                        <p className="text-lg font-bold">{rSavings.toFixed(1)}%</p>
                      </div>
                    </div>
                  )
                })()}

                {(report.categoryBreakdown && report.categoryBreakdown.length > 0) && (
                  <>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Top Spending Categories</h4>
                    <div className="space-y-2 mb-6">
                      {report.categoryBreakdown.map((cat, i) => {
                        const totalExp = report.expenses ?? report.totalExpenses ?? 1
                        const pct = totalExp > 0 ? (cat.total / totalExp) * 100 : 0
                        return (
                          <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-muted/20">
                            <span className="text-sm">{cat.icon} {cat.name}</span>
                            <div className="text-right">
                              <span className="text-sm font-semibold tabular-nums">{formatCurrency(cat.total)}</span>
                              <span className="text-xs text-muted-foreground ml-2">({pct.toFixed(1)}%)</span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}

                {report.accounts.length > 0 && (
                  <>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Account Balances</h4>
                    <div className="space-y-2 mb-6">
                      {report.accounts.map((acc, i) => (
                        <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-muted/20">
                          <span className="text-sm">{acc.name} <span className="text-xs text-muted-foreground">({acc.type})</span></span>
                          <span className={cn('text-sm font-semibold tabular-nums', acc.balance >= 0 ? 'text-success' : 'text-danger')}>
                            {formatCurrency(acc.balance)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {report.goals.length > 0 && (
                  <>
                    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Goal Progress</h4>
                    <div className="space-y-2">
                      {report.goals.map((g, i) => {
                        const progress = g.target_amount > 0 ? Math.min((g.current_amount / g.target_amount) * 100, 100) : 0
                        return (
                          <div key={i} className="p-2 rounded-lg bg-muted/20">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm">{g.name}</span>
                              <span className="text-xs font-semibold text-primary">{progress.toFixed(0)}%</span>
                            </div>
                            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                              <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-card rounded-2xl border border-border/50 p-8 text-center animate-pulse">
              <div className="h-6 w-40 bg-muted rounded mx-auto mb-3" />
              <div className="h-4 w-60 bg-muted rounded mx-auto" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
