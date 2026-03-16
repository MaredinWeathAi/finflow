import { useState, useEffect } from 'react'
import {
  format,
  isWithinInterval,
  subMonths,
  startOfMonth,
  endOfMonth,
  parseISO,
} from 'date-fns'
import { getGreeting, formatCurrency, cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { useBudgets } from '@/hooks/useBudgets'
import { useAccounts } from '@/hooks/useAccounts'
// useRecurring removed — Upcoming Recurring section removed from dashboard
import type { Transaction, NetWorthSnapshot } from '@/types'
import { NetWorthCard } from '@/components/dashboard/NetWorthCard'
import { SpendingTrendChart } from '@/components/dashboard/SpendingTrendChart'
import { RecentTransactions } from '@/components/dashboard/RecentTransactions'
import { FinancialHealthCard } from '@/components/dashboard/FinancialHealthCard'
import { CreditCardDebtCard } from '@/components/dashboard/CreditCardDebtCard'
import { DataQualityBanner } from '@/components/dashboard/DataQualityBanner'
import { BudgetBurnRate } from '@/components/dashboard/BudgetBurnRate'
import { OnboardingWizard } from '@/components/shared/OnboardingWizard'
import { CardDetailModal, FormulaRow, SectionHeader } from '@/components/dashboard/CardDetailModal'

interface DashboardSummary {
  income: number
  expenses: number
  net: number
  savingsRate: number
  isOverspending: boolean
  overspendAmount: number
  creditCards: { name: string; balance: number; institution: string; icon: string }[]
  totalCCDebt: number
  ccSpendingThisMonth: number
  ccInterestFees: number
  transfersIn: number
  transfersOut: number
  cashAccounts: { name: string; balance: number; type: string }[]
  totalCash: number
  topExpenses: { name: string; icon: string; color: string; amount: number; count: number }[]
  uncategorizedCount: number
  uncategorizedTotal: number
  month: string
  daysInMonth: number
  dayOfMonth: number
  // 6-month averages
  avgMonthlyIncome: number
  avgMonthlyExpenses: number
  avgMonthlySavings: number
  avgMonthCount: number
  // Last completed month
  lastMonthIncome: number
  lastMonthExpenses: number
  lastMonthSavings: number
  lastMonthLabel: string
  topExpenses6Mo: { name: string; icon: string; color: string; totalAmount: number; avgAmount: number; count: number }[]
  topIncome: { name: string; icon: string; color: string; amount: number; count: number }[]
  topIncome6Mo: { name: string; icon: string; color: string; totalAmount: number; avgAmount: number; count: number }[]
}

interface DashboardState {
  transactions: Transaction[]
  netWorthHistory: NetWorthSnapshot[]
  summary: DashboardSummary | null
  isLoading: boolean
}

export function DashboardPage() {
  const user = useAuthStore((s) => s.user)
  const { netWorth, totalAssets, totalLiabilities } = useAccounts()
  const { budgets, totalBudget, totalSpent } = useBudgets()
  // useRecurring removed

  const [showOnboarding, setShowOnboarding] = useState(false)
  const [detailModal, setDetailModal] = useState<string | null>(null)

  const [state, setState] = useState<DashboardState>({
    transactions: [],
    netWorthHistory: [],
    summary: null,
    isLoading: true,
  })

  useEffect(() => {
    // Check if onboarding needed
    const onboarded = localStorage.getItem('finflow_onboarded')
    if (!onboarded) {
      const timer = setTimeout(() => {
        if (state.transactions.length === 0 && !state.isLoading) {
          setShowOnboarding(true)
        }
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [state.transactions.length, state.isLoading])

  const fetchData = async () => {
    try {
      const [txRes, nwRes, summaryRes] = await Promise.all([
        api.get<{ transactions: Transaction[] }>('/transactions?limit=200&sort=date_desc'),
        api.get<NetWorthSnapshot[]>('/reports/networth-history').catch(() => [] as NetWorthSnapshot[]),
        api.get<DashboardSummary>('/reports/dashboard-summary').catch(() => null),
      ])

      setState({
        transactions: txRes.transactions || [],
        netWorthHistory: Array.isArray(nwRes) ? nwRes : [],
        summary: summaryRes,
        isLoading: false,
      })
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err)
      setState((prev) => ({ ...prev, isLoading: false }))
    }
  }

  useEffect(() => {
    let cancelled = false
    fetchData().then(() => { if (cancelled) return })
    return () => { cancelled = true }
  }, [])

  const now = new Date()

  // Monthly income/expenses - prefer dashboard-summary (transfer-aware) over raw tx math
  const summary = state.summary
  const monthStart = startOfMonth(now)
  const monthEnd = endOfMonth(now)
  const thisMonthTx = state.transactions.filter((tx) => {
    const d = parseISO(tx.date)
    return isWithinInterval(d, { start: monthStart, end: monthEnd })
  })

  // Use summary data (which excludes transfers) if available, else fallback
  const monthlyIncome = summary?.income ?? thisMonthTx.filter((tx) => tx.amount > 0).reduce((sum, tx) => sum + tx.amount, 0)
  const monthlyExpenses = summary?.expenses ?? thisMonthTx.filter((tx) => tx.amount < 0).reduce((sum, tx) => sum + Math.abs(tx.amount), 0)

  // Previous month savings for comparison
  const prevMonthStart = startOfMonth(subMonths(now, 1))
  const prevMonthEnd = endOfMonth(subMonths(now, 1))
  const prevMonthTx = state.transactions.filter((tx) => {
    const d = parseISO(tx.date)
    return isWithinInterval(d, { start: prevMonthStart, end: prevMonthEnd })
  })
  const prevIncome = prevMonthTx.filter((tx) => tx.amount > 0).reduce((sum, tx) => sum + tx.amount, 0)
  const prevExpenses = prevMonthTx.filter((tx) => tx.amount < 0).reduce((sum, tx) => sum + Math.abs(tx.amount), 0)
  const previousSavings = prevIncome - prevExpenses

  // Net worth history for sparkline
  const netWorthHistoryData = state.netWorthHistory.map((snap) => ({
    date: format(parseISO(snap.date), 'MMM yyyy'),
    value: snap.net_worth,
  }))

  const previousNetWorth =
    state.netWorthHistory.length >= 2
      ? state.netWorthHistory[state.netWorthHistory.length - 2].net_worth
      : 0

  // Recent transactions (top 8)
  const recentTransactions = state.transactions.slice(0, 8)

  const firstName = user?.name?.split(' ')[0] || 'there'

  if (state.isLoading) {
    return (
      <div className="space-y-6">
        <div className="opacity-0 animate-fade-in stagger-1">
          <div className="h-8 w-64 rounded-lg bg-muted animate-pulse" />
          <div className="h-4 w-40 rounded-lg bg-muted animate-pulse mt-2" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className={`bg-card rounded-2xl border border-border/50 p-6 h-48 animate-pulse opacity-0 animate-fade-in stagger-${i + 1}`}
            />
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {[4, 5].map((i) => (
            <div
              key={i}
              className={`bg-card rounded-2xl border border-border/50 p-6 h-48 animate-pulse opacity-0 animate-fade-in stagger-${i + 1}`}
            />
          ))}
        </div>
        <div className="bg-card rounded-2xl border border-border/50 p-6 h-40 animate-pulse opacity-0 animate-fade-in stagger-7" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Onboarding Wizard */}
      {showOnboarding && (
        <OnboardingWizard
          userName={user?.name || 'Friend'}
          onComplete={() => setShowOnboarding(false)}
        />
      )}

      {/* Greeting Header */}
      <div className="opacity-0 animate-fade-in stagger-1">
        <h1 className="text-2xl font-bold tracking-tight">
          {getGreeting()}, {firstName}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {format(now, 'EEEE, MMMM d, yyyy')}
        </p>
      </div>

      {/* Data Quality Banner */}
      {summary && summary.uncategorizedCount > 0 && (
        <div className="opacity-0 animate-fade-in stagger-2">
          <DataQualityBanner
            uncategorizedCount={summary.uncategorizedCount}
            uncategorizedTotal={summary.uncategorizedTotal}
            onQualityImproved={fetchData}
          />
        </div>
      )}

      {/* Row 1: Monthly Financial Health + Net Worth (equal size) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="opacity-0 animate-fade-in stagger-2 cursor-pointer min-h-[200px]" onClick={() => setDetailModal('health')}>
          {summary && (
            <FinancialHealthCard
              income={summary.income}
              expenses={summary.expenses}
              isOverspending={summary.isOverspending}
              overspendAmount={summary.overspendAmount}
              totalCCDebt={summary.totalCCDebt}
              ccSpendingThisMonth={summary.ccSpendingThisMonth}
              ccInterestFees={summary.ccInterestFees}
              transfersIn={summary.transfersIn}
              transfersOut={summary.transfersOut}
              savingsRate={summary.savingsRate}
              dayOfMonth={summary.dayOfMonth}
              daysInMonth={summary.daysInMonth}
            />
          )}
        </div>
        <div className="opacity-0 animate-fade-in stagger-3 cursor-pointer min-h-[200px]" onClick={() => setDetailModal('networth')}>
          <NetWorthCard
            netWorth={netWorth}
            previousNetWorth={previousNetWorth}
            history={netWorthHistoryData}
          />
        </div>
      </div>

      {/* Row 2: 6-Month Spending Trend Chart */}
      <div className="opacity-0 animate-fade-in stagger-4">
        <SpendingTrendChart />
      </div>

      {/* Row 3: Last Month Income / Expenses / Savings + CC Debt */}
      {(() => {
        const lmIncome = summary?.lastMonthIncome || 0;
        const lmExpenses = summary?.lastMonthExpenses || 0;
        const lmSavings = summary?.lastMonthSavings || 0;
        const lmLabel = summary?.lastMonthLabel
          ? new Date(summary.lastMonthLabel + '-15').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
          : 'Last month';
        const lmSavingsRate = lmIncome > 0 ? ((lmSavings / lmIncome) * 100) : 0;
        const hasCCDebt = summary && summary.totalCCDebt !== 0;
        return (
          <div className={`grid grid-cols-1 ${hasCCDebt ? 'md:grid-cols-4' : 'md:grid-cols-3'} gap-5`}>
            <div className="opacity-0 animate-fade-in stagger-5">
              <div className="bg-card rounded-2xl border border-border/50 p-6 h-full flex flex-col justify-between cursor-pointer" onClick={() => setDetailModal('savings')}>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Income</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{lmLabel}</p>
                  <p className="text-2xl font-bold tabular-nums text-emerald-400 mt-2">
                    {formatCurrency(lmIncome)}
                  </p>
                </div>
                <div className="mt-3 pt-3 border-t border-border/30">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">6-mo avg</span>
                    <span className="font-medium">{formatCurrency(summary?.avgMonthlyIncome || 0)}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="opacity-0 animate-fade-in stagger-5">
              <div className="bg-card rounded-2xl border border-border/50 p-6 h-full flex flex-col justify-between cursor-pointer" onClick={() => setDetailModal('savings')}>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expenses</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{lmLabel}</p>
                  <p className="text-2xl font-bold tabular-nums text-red-400 mt-2">
                    {formatCurrency(lmExpenses)}
                  </p>
                </div>
                <div className="mt-3 pt-3 border-t border-border/30">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">6-mo avg</span>
                    <span className="font-medium">{formatCurrency(summary?.avgMonthlyExpenses || 0)}</span>
                  </div>
                </div>
              </div>
            </div>
            <div className="opacity-0 animate-fade-in stagger-5">
              <div className={cn(
                'rounded-2xl border p-6 h-full flex flex-col justify-between cursor-pointer',
                lmSavings >= 0
                  ? 'bg-card border-border/50'
                  : 'bg-gradient-to-br from-red-500/10 to-card border-red-500/20'
              )} onClick={() => setDetailModal('savings')}>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Savings</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{lmLabel}</p>
                  <p className={cn(
                    'text-2xl font-bold tabular-nums mt-2',
                    lmSavings >= 0 ? 'text-emerald-400' : 'text-red-400'
                  )}>
                    {lmSavings >= 0 ? '+' : ''}{formatCurrency(lmSavings)}
                  </p>
                </div>
                <div className="mt-3 pt-3 border-t border-border/30">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">Savings rate</span>
                    <span className={cn('font-medium', lmSavingsRate >= 10 ? 'text-emerald-400' : 'text-amber-400')}>
                      {lmIncome > 0 ? `${lmSavingsRate.toFixed(1)}%` : 'N/A'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            {hasCCDebt && (
              <div className="opacity-0 animate-fade-in stagger-5 cursor-pointer" onClick={() => setDetailModal('ccdebt')}>
                <CreditCardDebtCard
                  creditCards={summary!.creditCards}
                  totalCCDebt={summary!.totalCCDebt}
                  ccSpendingThisMonth={summary!.ccSpendingThisMonth}
                  ccInterestFees={summary!.ccInterestFees}
                  income={summary!.income}
                />
              </div>
            )}
          </div>
        );
      })()}

      {/* Top Categories — Expenses & Income side by side (6-Month Averages) */}
      {summary && ((summary.topExpenses6Mo && summary.topExpenses6Mo.length > 0) || (summary.topIncome6Mo && summary.topIncome6Mo.length > 0)) && (
        <div className="opacity-0 animate-fade-in stagger-7">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Top Expense Categories */}
            {summary.topExpenses6Mo && summary.topExpenses6Mo.length > 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-6">
                <div className="flex items-center justify-between mb-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Top Expense Categories
                  </p>
                  <span className="text-[10px] text-muted-foreground">
                    {summary.avgMonthCount}-month avg
                  </span>
                </div>
                <div className="space-y-3">
                  {summary.topExpenses6Mo.map((cat) => {
                    const maxAvg = summary.topExpenses6Mo[0]?.avgAmount || 1
                    const barPct = Math.min((cat.avgAmount / maxAvg) * 100, 100)
                    return (
                      <div key={cat.name} className="flex items-center gap-3">
                        <div className="flex w-36 shrink-0 items-center gap-2 min-w-0">
                          <span className="text-base">{cat.icon || '📁'}</span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{cat.name}</p>
                            <p className="text-[10px] text-muted-foreground">{cat.count} txns</p>
                          </div>
                        </div>
                        <div className="flex-1">
                          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full transition-all duration-700 ease-out"
                              style={{ width: `${barPct}%`, backgroundColor: cat.color || '#A78BFA' }}
                            />
                          </div>
                        </div>
                        <div className="w-24 shrink-0 text-right">
                          <span className="text-sm font-semibold tabular-nums">{formatCurrency(cat.avgAmount)}</span>
                          <span className="text-[10px] text-muted-foreground">/mo</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Top Income Categories */}
            {summary.topIncome6Mo && summary.topIncome6Mo.length > 0 && (
              <div className="bg-card rounded-2xl border border-border/50 p-6">
                <div className="flex items-center justify-between mb-5">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Top Income Categories
                  </p>
                  <span className="text-[10px] text-muted-foreground">
                    {summary.avgMonthCount}-month avg
                  </span>
                </div>
                <div className="space-y-3">
                  {summary.topIncome6Mo.map((cat) => {
                    const maxAvg = summary.topIncome6Mo[0]?.avgAmount || 1
                    const barPct = Math.min((cat.avgAmount / maxAvg) * 100, 100)
                    return (
                      <div key={cat.name} className="flex items-center gap-3">
                        <div className="flex w-36 shrink-0 items-center gap-2 min-w-0">
                          <span className="text-base">{cat.icon || '📁'}</span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{cat.name}</p>
                            <p className="text-[10px] text-muted-foreground">{cat.count} txns</p>
                          </div>
                        </div>
                        <div className="flex-1">
                          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full transition-all duration-700 ease-out"
                              style={{ width: `${barPct}%`, backgroundColor: cat.color || '#10B981' }}
                            />
                          </div>
                        </div>
                        <div className="w-24 shrink-0 text-right">
                          <span className="text-sm font-semibold tabular-nums">{formatCurrency(cat.avgAmount)}</span>
                          <span className="text-[10px] text-muted-foreground">/mo</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Budget Burn Rate */}
      {budgets.length > 0 && (
        <div className="opacity-0 animate-fade-in stagger-7">
          <BudgetBurnRate
            budgets={budgets
              .filter(b => b.category_name && b.amount > 0)
              .map(b => ({
                category_name: b.category_name!,
                category_icon: b.category_icon || '📁',
                category_color: b.category_color || '#A78BFA',
                amount: b.amount,
                spent: b.spent || 0,
                transaction_count: b.transaction_count || 0,
              }))}
            dayOfMonth={summary?.dayOfMonth || new Date().getDate()}
            daysInMonth={summary?.daysInMonth || new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()}
          />
        </div>
      )}

      {/* Recent Transactions — full width */}
      <div className="opacity-0 animate-fade-in stagger-7">
        <RecentTransactions transactions={recentTransactions} />
      </div>

      {/* ================================================================== */}
      {/* Detail Modals — show how each card is calculated                   */}
      {/* ================================================================== */}

      {/* Financial Health Detail */}
      <CardDetailModal
        open={detailModal === 'health'}
        onClose={() => setDetailModal(null)}
        title="How Monthly Financial Health Score Works"
      >
        {summary && (() => {
          const savingsRate = summary.savingsRate
          const debtToIncome = summary.income > 0 ? summary.totalCCDebt / summary.income : 0
          const expectedSpentPct = summary.dayOfMonth / summary.daysInMonth
          const actualSpentPct = summary.income > 0 ? summary.expenses / summary.income : 1

          // Recalculate score components for display
          let savingsPoints = 5
          if (savingsRate >= 20) savingsPoints = 30
          else if (savingsRate >= 10) savingsPoints = 20
          else if (savingsRate >= 0) savingsPoints = 5
          else if (savingsRate >= -10) savingsPoints = -10
          else savingsPoints = -30

          let debtPoints = 0
          if (summary.totalCCDebt > 0) {
            if (debtToIncome > 2) debtPoints = -20
            else if (debtToIncome > 1) debtPoints = -15
            else if (debtToIncome > 0.5) debtPoints = -10
            else debtPoints = -5
          }

          const interestPoints = summary.ccInterestFees > 0 ? -10 : 0
          const pacePoints = actualSpentPct < expectedSpentPct ? 10 : 0

          const rawScore = 50 + savingsPoints + debtPoints + interestPoints + pacePoints
          const finalScore = Math.max(0, Math.min(100, rawScore))

          return (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground mb-4">
                Your health score is calculated from four factors. Each starts from a base of 50 and adds or subtracts points.
              </p>

              <SectionHeader>Score Breakdown</SectionHeader>
              <FormulaRow label="Base Score" value="50" detail="Everyone starts here" />
              <FormulaRow
                label={`Savings Rate (${savingsRate.toFixed(1)}%)`}
                value={`${savingsPoints >= 0 ? '+' : ''}${savingsPoints}`}
                detail={savingsRate >= 20 ? '20%+ = +30 pts (excellent)' : savingsRate >= 10 ? '10-20% = +20 pts (good)' : savingsRate >= 0 ? '0-10% = +5 pts (low)' : savingsRate >= -10 ? '-10 to 0% = -10 pts' : 'Below -10% = -30 pts (critical)'}
                operator="+"
                color={savingsPoints >= 20 ? 'green' : savingsPoints >= 0 ? 'amber' : 'red'}
              />
              <FormulaRow
                label={`CC Debt Impact${summary.totalCCDebt > 0 ? ` (${(debtToIncome * 100).toFixed(0)}% of income)` : ''}`}
                value={`${debtPoints}`}
                detail={summary.totalCCDebt === 0 ? 'No CC debt = no penalty' : `Debt-to-income ratio determines penalty (${formatCurrency(summary.totalCCDebt)} / ${formatCurrency(summary.income)})`}
                operator="+"
                color={debtPoints === 0 ? 'green' : debtPoints >= -10 ? 'amber' : 'red'}
              />
              <FormulaRow
                label="CC Interest/Fees"
                value={`${interestPoints}`}
                detail={summary.ccInterestFees > 0 ? `Paying ${formatCurrency(summary.ccInterestFees)} in interest = -10 pts` : 'No interest charges = no penalty'}
                operator="+"
                color={interestPoints === 0 ? 'green' : 'red'}
              />
              <FormulaRow
                label="Spending Pace"
                value={`+${pacePoints}`}
                detail={`Day ${summary.dayOfMonth}/${summary.daysInMonth} of month. ${actualSpentPct < expectedSpentPct ? 'Spending is on track or under pace' : 'Spending ahead of pace for the month'}`}
                operator="+"
                color={pacePoints > 0 ? 'green' : 'default'}
              />
              <FormulaRow
                label="Final Score"
                value={`${finalScore}/100`}
                bold
                color={finalScore >= 70 ? 'green' : finalScore >= 40 ? 'amber' : 'red'}
                operator="="
              />

              <SectionHeader>Score Ranges</SectionHeader>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-emerald-500" /> 80-100: Excellent</div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-emerald-400" /> 70-79: Good</div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-amber-400" /> 50-69: Fair</div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-amber-500" /> 30-49: Needs Attention</div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded-full bg-red-500" /> 0-29: Critical</div>
              </div>

              <SectionHeader>How to Improve</SectionHeader>
              <p className="text-xs text-muted-foreground">
                {savingsPoints < 20 && 'Increase your savings rate by cutting discretionary spending. '}
                {debtPoints < 0 && 'Pay down credit card debt to reduce the debt-to-income penalty. '}
                {interestPoints < 0 && 'Paying off CC balances in full each month eliminates interest fees. '}
                {pacePoints === 0 && 'Try to keep spending pace below your expected monthly rate. '}
                {finalScore >= 70 && 'Your finances are in great shape. Keep maintaining these habits.'}
              </p>
            </div>
          )
        })()}
      </CardDetailModal>

      {/* Net Worth Detail */}
      <CardDetailModal
        open={detailModal === 'networth'}
        onClose={() => setDetailModal(null)}
        title="How Net Worth is Calculated"
      >
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground mb-4">
            Net worth is the total value of everything you own minus everything you owe. Here's the breakdown.
          </p>

          <SectionHeader>Formula</SectionHeader>
          <FormulaRow label="Cash Accounts (checking, savings, crypto)" value={formatCurrency(totalAssets - (netWorth + totalLiabilities - totalAssets >= 0 ? 0 : 0))} detail="Non-hidden, non-investment-linked accounts" color="green" />
          <FormulaRow label="Investment Portfolio" value="included" detail="Sum of (shares x current price) for all holdings. If an account is linked to investments, its balance is excluded to avoid double-counting." operator="+" color="green" />
          <FormulaRow label="Total Assets" value={formatCurrency(totalAssets)} bold operator="=" color="green" />
          <FormulaRow label="Liabilities (credit cards, loans, mortgage)" value={formatCurrency(totalLiabilities)} detail="Absolute balance of all credit, loan, and mortgage type accounts" operator="-" color="red" />
          <FormulaRow label="Net Worth" value={formatCurrency(netWorth)} bold operator="=" />

          <SectionHeader>What's Included</SectionHeader>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p><strong className="text-foreground">Assets:</strong> All non-hidden account balances (checking, savings, crypto, property) plus the total value of investment holdings.</p>
            <p><strong className="text-foreground">Liabilities:</strong> Absolute balance of accounts typed as credit, loan, or mortgage.</p>
            <p><strong className="text-foreground">Double-counting prevention:</strong> If an account is linked to investment holdings, its balance is excluded from cash assets since the investment value already represents it.</p>
            <p><strong className="text-foreground">Hidden accounts:</strong> Accounts marked as hidden are excluded entirely from net worth.</p>
          </div>
        </div>
      </CardDetailModal>

      {/* CC Debt Detail */}
      <CardDetailModal
        open={detailModal === 'ccdebt'}
        onClose={() => setDetailModal(null)}
        title="Credit Card Debt Breakdown"
      >
        {summary && (
          <div className="space-y-1">
            <SectionHeader>Card Balances</SectionHeader>
            {summary.creditCards.map((cc, i) => (
              <FormulaRow
                key={i}
                label={`${cc.icon || '💳'} ${cc.name}`}
                value={formatCurrency(Math.abs(cc.balance))}
                detail={cc.institution}
                color="red"
              />
            ))}
            <FormulaRow label="Total CC Debt" value={formatCurrency(summary.totalCCDebt)} bold operator="=" color="red" />

            <SectionHeader>This Month's Activity</SectionHeader>
            <FormulaRow label="CC Spending This Month" value={formatCurrency(summary.ccSpendingThisMonth)} detail="New charges added to credit cards" />
            <FormulaRow label="Interest & Fees" value={formatCurrency(summary.ccInterestFees)} detail="Charges from carrying a balance" color={summary.ccInterestFees > 0 ? 'red' : 'green'} />

            <SectionHeader>Impact on Health Score</SectionHeader>
            <p className="text-xs text-muted-foreground">
              {summary.income > 0 ? (
                <>Your debt-to-income ratio is {((summary.totalCCDebt / summary.income) * 100).toFixed(0)}%. {summary.totalCCDebt > summary.income ? 'This exceeds your monthly income, which heavily impacts your health score (-20 pts).' : summary.totalCCDebt > summary.income * 0.5 ? 'This is over 50% of income, costing you -10 pts on health score.' : 'This is manageable at under 50% of income (-5 pts).'}</>
              ) : 'Unable to calculate debt-to-income without income data.'}
              {summary.ccInterestFees > 0 && ' Paying interest costs an additional -10 pts. Paying balances in full each month eliminates this penalty.'}
            </p>
          </div>
        )}
      </CardDetailModal>

      {/* Savings Detail */}
      <CardDetailModal
        open={detailModal === 'savings'}
        onClose={() => setDetailModal(null)}
        title="How Savings is Calculated"
      >
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground mb-4">
            Monthly savings is simply income minus expenses. Transfers between your own accounts are excluded.
          </p>

          <SectionHeader>This Month</SectionHeader>
          <FormulaRow label="Total Income" value={formatCurrency(monthlyIncome)} detail="All deposits, paychecks, and income" color="green" />
          <FormulaRow label="Total Expenses" value={formatCurrency(monthlyExpenses)} detail="All spending (CC charges count as expenses)" operator="-" color="red" />
          <FormulaRow label="Net Savings" value={formatCurrency(monthlyIncome - monthlyExpenses)} bold operator="=" color={monthlyIncome - monthlyExpenses >= 0 ? 'green' : 'red'} />
          <FormulaRow
            label="Savings Rate"
            value={monthlyIncome > 0 ? `${((monthlyIncome - monthlyExpenses) / monthlyIncome * 100).toFixed(1)}%` : 'N/A'}
            detail="(Income - Expenses) / Income x 100"
            color={monthlyIncome > 0 && (monthlyIncome - monthlyExpenses) / monthlyIncome >= 0.1 ? 'green' : 'amber'}
          />

          {previousSavings !== undefined && (
            <>
              <SectionHeader>Compared to Last Month</SectionHeader>
              <FormulaRow label="Previous Month Savings" value={formatCurrency(previousSavings)} />
              <FormulaRow
                label="Change"
                value={formatCurrency((monthlyIncome - monthlyExpenses) - previousSavings)}
                color={(monthlyIncome - monthlyExpenses) > previousSavings ? 'green' : 'red'}
              />
            </>
          )}

          <SectionHeader>What's Excluded</SectionHeader>
          <p className="text-xs text-muted-foreground">
            Transfers between your own accounts and CC payment transactions are not counted as income or expenses.
            They're just money moving between accounts, not actual earning or spending.
          </p>

          <SectionHeader>Savings Rate Benchmarks</SectionHeader>
          <div className="space-y-1 text-xs">
            <div className="flex justify-between"><span className="text-emerald-400">20%+ Excellent</span><span className="text-muted-foreground">Strong wealth building</span></div>
            <div className="flex justify-between"><span className="text-emerald-300">10-20% Good</span><span className="text-muted-foreground">Solid financial health</span></div>
            <div className="flex justify-between"><span className="text-amber-400">0-10% Low</span><span className="text-muted-foreground">Room for improvement</span></div>
            <div className="flex justify-between"><span className="text-red-400">Negative</span><span className="text-muted-foreground">Spending more than earning</span></div>
          </div>
        </div>
      </CardDetailModal>

      {/* Weekly and Monthly detail modals removed — cards no longer on dashboard */}
    </div>
  )
}
