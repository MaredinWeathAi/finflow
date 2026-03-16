import { useState, useEffect } from 'react'
import {
  format,
  startOfWeek,
  endOfWeek,
  isWithinInterval,
  subWeeks,
  subMonths,
  startOfMonth,
  endOfMonth,
  parseISO,
} from 'date-fns'
import { getGreeting, formatCurrency } from '@/lib/utils'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { useBudgets } from '@/hooks/useBudgets'
import { useAccounts } from '@/hooks/useAccounts'
import { useRecurring } from '@/hooks/useRecurring'
import type { Transaction, NetWorthSnapshot } from '@/types'
import { NetWorthCard } from '@/components/dashboard/NetWorthCard'
import { MonthlySpendingCard } from '@/components/dashboard/MonthlySpendingCard'
import { WeeklySpendingCard } from '@/components/dashboard/WeeklySpendingCard'
// SafeToSpendCard removed — not useful without real-time data
import { SavingsSummaryCard } from '@/components/dashboard/SavingsSummaryCard'
import { SpendingTrendChart } from '@/components/dashboard/SpendingTrendChart'
import { TrendingCategories } from '@/components/dashboard/TrendingCategories'
import { RecentTransactions } from '@/components/dashboard/RecentTransactions'
import { UpcomingRecurring } from '@/components/dashboard/UpcomingRecurring'
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
}

interface DashboardState {
  transactions: Transaction[]
  netWorthHistory: NetWorthSnapshot[]
  summary: DashboardSummary | null
  isLoading: boolean
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function computeWeeklySpending(
  transactions: Transaction[],
  weekStart: Date,
  weekEnd: Date
): { day: string; amount: number }[] {
  const dailyMap: Record<number, number> = {}
  for (let i = 0; i < 7; i++) {
    dailyMap[i] = 0
  }

  transactions
    .filter((tx) => {
      const txDate = parseISO(tx.date)
      return (
        tx.amount < 0 &&
        isWithinInterval(txDate, { start: weekStart, end: weekEnd })
      )
    })
    .forEach((tx) => {
      const txDate = parseISO(tx.date)
      const dayIndex = (txDate.getDay() + 6) % 7
      dailyMap[dayIndex] += Math.abs(tx.amount)
    })

  return DAY_LABELS.map((day, i) => ({
    day,
    amount: dailyMap[i],
  }))
}

function computeWeeklyPercentChange(
  transactions: Transaction[],
  currentWeekStart: Date,
  currentWeekEnd: Date
): number {
  const prevWeekStart = subWeeks(currentWeekStart, 1)
  const prevWeekEnd = subWeeks(currentWeekEnd, 1)

  const currentTotal = transactions
    .filter((tx) => {
      const txDate = parseISO(tx.date)
      return (
        tx.amount < 0 &&
        isWithinInterval(txDate, { start: currentWeekStart, end: currentWeekEnd })
      )
    })
    .reduce((sum, tx) => sum + Math.abs(tx.amount), 0)

  const prevTotal = transactions
    .filter((tx) => {
      const txDate = parseISO(tx.date)
      return (
        tx.amount < 0 &&
        isWithinInterval(txDate, { start: prevWeekStart, end: prevWeekEnd })
      )
    })
    .reduce((sum, tx) => sum + Math.abs(tx.amount), 0)

  if (prevTotal === 0) return 0
  return ((currentTotal - prevTotal) / prevTotal) * 100
}

export function DashboardPage() {
  const user = useAuthStore((s) => s.user)
  const { netWorth, totalAssets, totalLiabilities } = useAccounts()
  const { budgets, totalBudget, totalSpent } = useBudgets()
  const { recurring } = useRecurring()

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
  const currentWeekStart = startOfWeek(now, { weekStartsOn: 1 })
  const currentWeekEnd = endOfWeek(now, { weekStartsOn: 1 })

  // Weekly spending data
  const dailySpending = computeWeeklySpending(
    state.transactions,
    currentWeekStart,
    currentWeekEnd
  )
  const weeklyPercentChange = computeWeeklyPercentChange(
    state.transactions,
    currentWeekStart,
    currentWeekEnd
  )

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

  // Trending categories from budget data
  const trendingCategories = budgets
    .filter((b) => b.category_name && b.amount > 0)
    .map((b) => ({
      name: b.category_name!,
      icon: b.category_icon || '📁',
      color: b.category_color || '#A78BFA',
      spent: b.spent || 0,
      budget: b.amount,
      count: b.transaction_count || 0,
    }))

  // Upcoming recurring
  const upcomingItems = recurring
    .filter((r) => r.is_active)
    .map((r) => ({
      name: r.name,
      amount: r.amount,
      next_date: r.next_date,
      category_icon: r.category_icon || '📅',
    }))

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

      {/* Top Row: Financial Health + Net Worth */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="opacity-0 animate-fade-in stagger-2 cursor-pointer" onClick={() => setDetailModal('health')}>
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
        <div className="opacity-0 animate-fade-in stagger-3 cursor-pointer" onClick={() => setDetailModal('networth')}>
          <NetWorthCard
            netWorth={netWorth}
            previousNetWorth={previousNetWorth}
            history={netWorthHistoryData}
          />
        </div>
      </div>

      {/* Second Row: CC Debt (if any) + Savings + Weekly Spending */}
      <div className={`grid grid-cols-1 ${summary && summary.totalCCDebt !== 0 ? 'md:grid-cols-3' : 'md:grid-cols-2'} gap-5`}>
        {summary && summary.totalCCDebt !== 0 && (
          <div className="opacity-0 animate-fade-in stagger-5 cursor-pointer" onClick={() => setDetailModal('ccdebt')}>
            <CreditCardDebtCard
              creditCards={summary.creditCards}
              totalCCDebt={summary.totalCCDebt}
              ccSpendingThisMonth={summary.ccSpendingThisMonth}
              ccInterestFees={summary.ccInterestFees}
              income={summary.income}
            />
          </div>
        )}
        <div className="opacity-0 animate-fade-in stagger-5 cursor-pointer" onClick={() => setDetailModal('savings')}>
          <SavingsSummaryCard
            income={monthlyIncome}
            expenses={monthlyExpenses}
            previousSavings={previousSavings}
          />
        </div>
        <div className="opacity-0 animate-fade-in stagger-5 cursor-pointer" onClick={() => setDetailModal('weekly')}>
          <WeeklySpendingCard
            dailySpending={dailySpending}
            percentChange={weeklyPercentChange}
          />
        </div>
      </div>

      {/* Monthly Spending + Trend Chart */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="opacity-0 animate-fade-in stagger-6 cursor-pointer" onClick={() => setDetailModal('monthly')}>
          <MonthlySpendingCard
            spent={totalSpent}
            budget={totalBudget}
          />
        </div>
        <div className="md:col-span-2 opacity-0 animate-fade-in stagger-6">
          <SpendingTrendChart />
        </div>
      </div>

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

      {/* Trending Categories */}
      <div className="opacity-0 animate-fade-in stagger-7">
        <TrendingCategories categories={trendingCategories} />
      </div>

      {/* Bottom Row: Recent Transactions (2/3) + Upcoming Recurring (1/3) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 opacity-0 animate-fade-in stagger-7">
          <RecentTransactions transactions={recentTransactions} />
        </div>
        <div className="opacity-0 animate-fade-in stagger-7">
          <UpcomingRecurring items={upcomingItems} />
        </div>
      </div>

      {/* ================================================================== */}
      {/* Detail Modals — show how each card is calculated                   */}
      {/* ================================================================== */}

      {/* Financial Health Detail */}
      <CardDetailModal
        open={detailModal === 'health'}
        onClose={() => setDetailModal(null)}
        title="How Financial Health Score Works"
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

      {/* Weekly Spending Detail */}
      <CardDetailModal
        open={detailModal === 'weekly'}
        onClose={() => setDetailModal(null)}
        title="Weekly Spending Breakdown"
      >
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground mb-4">
            Your daily spending for the current week (Mon–Sun), compared to last week.
          </p>

          <SectionHeader>Daily Totals</SectionHeader>
          {dailySpending.map((d, i) => (
            <FormulaRow
              key={i}
              label={d.day}
              value={formatCurrency(d.amount)}
              color={d.amount > 0 ? 'default' : 'default'}
            />
          ))}
          <FormulaRow
            label="Week Total"
            value={formatCurrency(dailySpending.reduce((s, d) => s + d.amount, 0))}
            bold
            operator="="
          />

          <SectionHeader>Week-over-Week Change</SectionHeader>
          <FormulaRow
            label="vs. Last Week"
            value={`${weeklyPercentChange >= 0 ? '+' : ''}${weeklyPercentChange.toFixed(1)}%`}
            color={weeklyPercentChange <= 0 ? 'green' : 'red'}
            detail={weeklyPercentChange <= 0 ? 'Spending decreased (good)' : 'Spending increased from last week'}
          />
        </div>
      </CardDetailModal>

      {/* Monthly Spending Detail */}
      <CardDetailModal
        open={detailModal === 'monthly'}
        onClose={() => setDetailModal(null)}
        title="Monthly Budget Breakdown"
      >
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground mb-4">
            Your total spending vs. total budget across all categories this month.
          </p>

          <SectionHeader>Overview</SectionHeader>
          <FormulaRow label="Total Budget" value={formatCurrency(totalBudget)} color="green" />
          <FormulaRow label="Total Spent" value={formatCurrency(totalSpent)} operator="-" color="red" />
          <FormulaRow label="Remaining" value={formatCurrency(totalBudget - totalSpent)} bold operator="=" color={totalBudget - totalSpent >= 0 ? 'green' : 'red'} />
          <FormulaRow
            label="Budget Used"
            value={totalBudget > 0 ? `${((totalSpent / totalBudget) * 100).toFixed(0)}%` : 'N/A'}
            detail={summary ? `Day ${summary.dayOfMonth} of ${summary.daysInMonth} (${((summary.dayOfMonth / summary.daysInMonth) * 100).toFixed(0)}% through month)` : ''}
          />

          {budgets.filter(b => b.category_name && b.amount > 0).length > 0 && (
            <>
              <SectionHeader>By Category</SectionHeader>
              {budgets
                .filter(b => b.category_name && b.amount > 0)
                .sort((a, b) => (b.spent || 0) - (a.spent || 0))
                .map((b, i) => {
                  const pct = b.amount > 0 ? ((b.spent || 0) / b.amount) * 100 : 0
                  return (
                    <FormulaRow
                      key={i}
                      label={`${b.category_icon || '📁'} ${b.category_name}`}
                      value={`${formatCurrency(b.spent || 0)} / ${formatCurrency(b.amount)}`}
                      detail={`${pct.toFixed(0)}% used${pct > 100 ? ' — over budget!' : ''}`}
                      color={pct > 100 ? 'red' : pct > 80 ? 'amber' : 'green'}
                    />
                  )
                })}
            </>
          )}
        </div>
      </CardDetailModal>
    </div>
  )
}
