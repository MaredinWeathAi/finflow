import { useState, useEffect } from 'react'
import {
  Brain,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  Wallet,
  CreditCard,
  DollarSign,
  ArrowLeftRight,
  BarChart3,
  Loader2,
  Building2,
  Repeat,
  PieChart,
  Activity,
  Sparkles,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/shared/PageHeader'

interface AccountSummary {
  accountId: string
  accountName: string
  accountType: string
  institution: string
  balance: number
  totalInflows: number
  totalOutflows: number
  netFlow: number
  transactionCount: number
}

interface TransferPair {
  fromAccount: string
  toAccount: string
  amount: number
  date: string
  description: string
  status: 'matched' | 'unmatched'
}

interface MerchantSummary {
  name: string
  totalSpent: number
  transactionCount: number
  avgAmount: number
  firstSeen: string
  lastSeen: string
  frequency: string
  category?: string
}

interface IncomeSource {
  name: string
  totalAmount: number
  count: number
  avgAmount: number
  frequency: string
  isRegular: boolean
}

interface SpendingPattern {
  type: string
  title: string
  description: string
  amount?: number
  percentage?: number
}

interface CashFlowMonth {
  month: string
  income: number
  expenses: number
  transfers: number
  net: number
}

interface FinancialAnalysis {
  accountSummaries: AccountSummary[]
  totalAssets: number
  totalLiabilities: number
  netWorth: number
  incomeSources: IncomeSource[]
  totalIncome: number
  avgMonthlyIncome: number
  topMerchants: MerchantSummary[]
  totalExpenses: number
  avgMonthlyExpenses: number
  transfers: TransferPair[]
  totalInternalTransfers: number
  transferCount: number
  monthlyCashFlow: CashFlowMonth[]
  patterns: SpendingPattern[]
  narrative: string[]
}

function getAccountIcon(type: string) {
  switch (type) {
    case 'checking': return <Wallet className="w-4 h-4 text-blue-400" />
    case 'savings': return <DollarSign className="w-4 h-4 text-emerald-400" />
    case 'credit': return <CreditCard className="w-4 h-4 text-purple-400" />
    case 'investment': return <TrendingUp className="w-4 h-4 text-amber-400" />
    default: return <Wallet className="w-4 h-4 text-muted-foreground" />
  }
}

function formatMonth(monthStr: string): string {
  const [year, month] = monthStr.split('-')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[parseInt(month) - 1]} ${year}`
}

function NarrativeSection({ narrative }: { narrative: string[] }) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Brain className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">AI Financial Summary</h2>
          <p className="text-xs text-muted-foreground">Intelligent analysis of your financial data</p>
        </div>
      </div>
      <div className="space-y-3">
        {narrative.map((text, i) => (
          <p key={i} className="text-sm text-muted-foreground leading-relaxed">{text}</p>
        ))}
      </div>
    </div>
  )
}

function NetWorthCard({ totalAssets, totalLiabilities, netWorth }: { totalAssets: number; totalLiabilities: number; netWorth: number }) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Net Worth</h3>
      <p className={cn('text-3xl font-bold', netWorth >= 0 ? 'text-emerald-400' : 'text-red-400')}>
        {formatCurrency(netWorth)}
      </p>
      <div className="flex items-center gap-4 mt-4">
        <div>
          <p className="text-xs text-muted-foreground">Assets</p>
          <p className="text-sm font-semibold text-emerald-400">{formatCurrency(totalAssets)}</p>
        </div>
        <ArrowRight className="w-4 h-4 text-muted-foreground" />
        <div>
          <p className="text-xs text-muted-foreground">Liabilities</p>
          <p className="text-sm font-semibold text-red-400">{formatCurrency(totalLiabilities)}</p>
        </div>
      </div>
    </div>
  )
}

function AccountsOverview({ accounts }: { accounts: AccountSummary[] }) {
  if (accounts.length === 0) return null
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Building2 className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Accounts Overview</h3>
      </div>
      <div className="space-y-3">
        {accounts.map((acct) => (
          <div key={acct.accountId} className="flex items-center gap-3 p-3 rounded-xl bg-muted/30 border border-border/20">
            {getAccountIcon(acct.accountType)}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{acct.accountName}</p>
              <p className="text-xs text-muted-foreground">{acct.transactionCount} transactions</p>
            </div>
            <div className="text-right">
              <p className={cn('text-sm font-bold tabular-nums', acct.balance >= 0 ? 'text-foreground' : 'text-red-400')}>
                {formatCurrency(acct.balance)}
              </p>
              <p className="text-xs text-muted-foreground">
                <span className="text-emerald-400">+{formatCurrency(acct.totalInflows)}</span>
                {' / '}
                <span className="text-red-400">-{formatCurrency(acct.totalOutflows)}</span>
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function IncomeAnalysis({ sources, totalIncome, avgMonthly }: { sources: IncomeSource[]; totalIncome: number; avgMonthly: number }) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Income Sources</h3>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-emerald-400">{formatCurrency(totalIncome)}</p>
          <p className="text-xs text-muted-foreground">{formatCurrency(avgMonthly)}/mo avg</p>
        </div>
      </div>
      <div className="space-y-2.5">
        {sources.slice(0, 10).map((src, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className={cn('w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0',
              src.isRegular ? 'bg-emerald-500/10 text-emerald-400' : 'bg-muted text-muted-foreground'
            )}>
              {src.isRegular ? <Repeat className="w-3.5 h-3.5" /> : <DollarSign className="w-3.5 h-3.5" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{src.name}</p>
              <p className="text-xs text-muted-foreground">{src.frequency} &middot; {src.count} time{src.count !== 1 ? 's' : ''}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-semibold tabular-nums text-emerald-400">{formatCurrency(src.totalAmount)}</p>
              <p className="text-xs text-muted-foreground tabular-nums">avg {formatCurrency(src.avgAmount)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ExpenseAnalysis({ merchants, totalExpenses, avgMonthly }: { merchants: MerchantSummary[]; totalExpenses: number; avgMonthly: number }) {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <TrendingDown className="w-4 h-4 text-red-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Top Merchants</h3>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold text-red-400">{formatCurrency(totalExpenses)}</p>
          <p className="text-xs text-muted-foreground">{formatCurrency(avgMonthly)}/mo avg</p>
        </div>
      </div>
      <div className="space-y-2.5">
        {merchants.slice(0, 10).map((m, i) => {
          const barWidth = merchants[0] ? (m.totalSpent / merchants[0].totalSpent) * 100 : 0
          return (
            <div key={i} className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-medium truncate">{m.name}</p>
                  {m.category && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                      {m.category}
                    </span>
                  )}
                </div>
                <div className="text-right shrink-0 ml-3">
                  <p className="text-sm font-semibold tabular-nums">{formatCurrency(m.totalSpent)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-red-500/40" style={{ width: `${barWidth}%` }} />
                </div>
                <p className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                  {m.transactionCount} txn{m.transactionCount !== 1 ? 's' : ''} &middot; {m.frequency}
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TransferAnalysis({ transfers, total, count }: { transfers: TransferPair[]; total: number; count: number }) {
  if (transfers.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-6">
        <div className="flex items-center gap-2 mb-4">
          <ArrowLeftRight className="w-4 h-4 text-blue-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transfer Analysis</h3>
        </div>
        <p className="text-sm text-muted-foreground">No inter-account transfers detected yet. Import statements from multiple accounts to see transfer reconciliation.</p>
      </div>
    )
  }

  const matched = transfers.filter(t => t.status === 'matched')
  const unmatched = transfers.filter(t => t.status === 'unmatched')

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="w-4 h-4 text-blue-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Transfer Analysis</h3>
        </div>
        <div className="text-right">
          <p className="text-sm font-bold text-blue-400">{formatCurrency(total)}</p>
          <p className="text-xs text-muted-foreground">{count} transfer{count !== 1 ? 's' : ''}</p>
        </div>
      </div>

      <div className="flex gap-3 mb-4">
        <div className="flex-1 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20">
          <div className="flex items-center gap-1.5 mb-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <p className="text-[10px] font-semibold text-emerald-400 uppercase">Matched</p>
          </div>
          <p className="text-lg font-bold">{matched.length}</p>
        </div>
        <div className="flex-1 p-3 rounded-lg bg-amber-500/5 border border-amber-500/20">
          <div className="flex items-center gap-1.5 mb-1">
            <AlertCircle className="w-3.5 h-3.5 text-amber-400" />
            <p className="text-[10px] font-semibold text-amber-400 uppercase">Unmatched</p>
          </div>
          <p className="text-lg font-bold">{unmatched.length}</p>
        </div>
      </div>

      <div className="space-y-2 max-h-[300px] overflow-y-auto">
        {transfers.slice(0, 15).map((t, i) => (
          <div key={i} className={cn(
            'flex items-center gap-3 p-2.5 rounded-lg border',
            t.status === 'matched' ? 'border-border/20 bg-muted/20' : 'border-amber-500/20 bg-amber-500/5'
          )}>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 text-xs">
                <span className="font-medium text-foreground">{t.fromAccount}</span>
                <ArrowRight className="w-3 h-3 text-muted-foreground" />
                <span className="font-medium text-foreground">{t.toAccount}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{t.description}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-sm font-semibold tabular-nums">{formatCurrency(t.amount)}</p>
              <p className="text-[10px] text-muted-foreground">{t.date}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CashFlowChart({ months }: { months: CashFlowMonth[] }) {
  if (months.length === 0) return null

  const maxVal = Math.max(...months.map(m => Math.max(m.income, m.expenses)))

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Monthly Cash Flow</h3>
      </div>

      <div className="flex items-center gap-4 mb-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-emerald-500/40" />
          Income
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-red-500/40" />
          Expenses
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-sm bg-blue-500/40" />
          Net
        </div>
      </div>

      <div className="space-y-3">
        {months.map((m, i) => {
          const incomeWidth = maxVal > 0 ? (m.income / maxVal) * 100 : 0
          const expenseWidth = maxVal > 0 ? (m.expenses / maxVal) * 100 : 0

          return (
            <div key={i} className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium w-16 shrink-0">{formatMonth(m.month)}</span>
                <span className={cn(
                  'text-xs font-bold tabular-nums',
                  m.net >= 0 ? 'text-emerald-400' : 'text-red-400'
                )}>
                  {m.net >= 0 ? '+' : ''}{formatCurrency(m.net)}
                </span>
              </div>
              <div className="space-y-0.5">
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-emerald-500/50" style={{ width: `${incomeWidth}%` }} />
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div className="h-full rounded-full bg-red-500/50" style={{ width: `${expenseWidth}%` }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PatternsSection({ patterns }: { patterns: SpendingPattern[] }) {
  if (patterns.length === 0) return null

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="w-4 h-4 text-purple-400" />
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Spending Patterns</h3>
      </div>
      <div className="space-y-4">
        {patterns.map((p, i) => (
          <div key={i} className="p-4 rounded-xl bg-muted/30 border border-border/20">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <p className="text-sm font-semibold">{p.title}</p>
              {p.percentage !== undefined && (
                <span className="text-[10px] font-bold bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">
                  {(p.percentage * 100).toFixed(0)}%
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">{p.description}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

export function AnalysisPage() {
  const [analysis, setAnalysis] = useState<FinancialAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchAnalysis() {
      try {
        const data = await api.get<FinancialAnalysis>('/insights/analysis')
        setAnalysis(data)
      } catch (err: any) {
        setError(err.message || 'Failed to load analysis')
      } finally {
        setLoading(false)
      }
    }
    fetchAnalysis()
  }, [])

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Financial Analysis"
          description="AI-powered deep analysis of your finances"
        />
        <div className="flex items-center justify-center py-20">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
            <p className="text-sm">Analyzing your financial data...</p>
          </div>
        </div>
      </div>
    )
  }

  if (error || !analysis) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Financial Analysis"
          description="AI-powered deep analysis of your finances"
        />
        <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
          <AlertCircle className="w-10 h-10 text-red-400 mx-auto mb-3" />
          <p className="text-sm font-medium">Failed to generate analysis</p>
          <p className="text-xs text-muted-foreground mt-1">{error || 'Import some transactions first to see your analysis.'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Financial Analysis"
        description="AI-powered deep analysis of your income, expenses, transfers, and spending patterns"
      />

      {/* AI Narrative Summary */}
      <div className="opacity-0 animate-fade-in stagger-1">
        <NarrativeSection narrative={analysis.narrative} />
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 opacity-0 animate-fade-in stagger-2">
        <NetWorthCard
          totalAssets={analysis.totalAssets}
          totalLiabilities={analysis.totalLiabilities}
          netWorth={analysis.netWorth}
        />
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Total Income</h3>
          <p className="text-2xl font-bold text-emerald-400">{formatCurrency(analysis.totalIncome)}</p>
          <p className="text-xs text-muted-foreground mt-1">{formatCurrency(analysis.avgMonthlyIncome)}/mo avg</p>
        </div>
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Total Expenses</h3>
          <p className="text-2xl font-bold text-red-400">{formatCurrency(analysis.totalExpenses)}</p>
          <p className="text-xs text-muted-foreground mt-1">{formatCurrency(analysis.avgMonthlyExpenses)}/mo avg</p>
        </div>
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Transfers</h3>
          <p className="text-2xl font-bold text-blue-400">{analysis.transferCount}</p>
          <p className="text-xs text-muted-foreground mt-1">{formatCurrency(analysis.totalInternalTransfers)} total</p>
        </div>
      </div>

      {/* Two column layout */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Left column */}
        <div className="space-y-6 opacity-0 animate-fade-in stagger-3">
          <IncomeAnalysis
            sources={analysis.incomeSources}
            totalIncome={analysis.totalIncome}
            avgMonthly={analysis.avgMonthlyIncome}
          />
          <TransferAnalysis
            transfers={analysis.transfers}
            total={analysis.totalInternalTransfers}
            count={analysis.transferCount}
          />
        </div>

        {/* Right column */}
        <div className="space-y-6 opacity-0 animate-fade-in stagger-4">
          <ExpenseAnalysis
            merchants={analysis.topMerchants}
            totalExpenses={analysis.totalExpenses}
            avgMonthly={analysis.avgMonthlyExpenses}
          />
          <AccountsOverview accounts={analysis.accountSummaries} />
        </div>
      </div>

      {/* Full width sections */}
      <div className="opacity-0 animate-fade-in stagger-5">
        <CashFlowChart months={analysis.monthlyCashFlow} />
      </div>

      <div className="opacity-0 animate-fade-in stagger-5">
        <PatternsSection patterns={analysis.patterns} />
      </div>
    </div>
  )
}
