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
import { getGreeting } from '@/lib/utils'
import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/authStore'
import { useBudgets } from '@/hooks/useBudgets'
import { useAccounts } from '@/hooks/useAccounts'
import { useRecurring } from '@/hooks/useRecurring'
import type { Transaction, NetWorthSnapshot } from '@/types'
import { NetWorthCard } from '@/components/dashboard/NetWorthCard'
import { MonthlySpendingCard } from '@/components/dashboard/MonthlySpendingCard'
import { WeeklySpendingCard } from '@/components/dashboard/WeeklySpendingCard'
import { SafeToSpendCard } from '@/components/dashboard/SafeToSpendCard'
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

  // Upcoming recurring total for safe-to-spend
  const upcomingRecurringTotal = recurring
    .filter((r) => r.is_active)
    .reduce((sum, r) => {
      if (r.frequency === 'monthly') return sum + r.amount
      if (r.frequency === 'weekly') return sum + r.amount * 4
      if (r.frequency === 'biweekly') return sum + r.amount * 2
      if (r.frequency === 'quarterly') return sum + r.amount / 3
      if (r.frequency === 'annually') return sum + r.amount / 12
      return sum
    }, 0)

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

      {/* Top Row: Financial Health / Safe to Spend / Net Worth */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="opacity-0 animate-fade-in stagger-2">
          {summary ? (
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
          ) : (
            <SafeToSpendCard
              income={monthlyIncome}
              totalBudgeted={totalBudget}
              totalSpent={monthlyExpenses}
              upcomingRecurring={upcomingRecurringTotal}
            />
          )}
        </div>
        <div className="opacity-0 animate-fade-in stagger-3">
          <SafeToSpendCard
            income={monthlyIncome}
            totalBudgeted={totalBudget}
            totalSpent={monthlyExpenses}
            upcomingRecurring={upcomingRecurringTotal}
            isOverspending={summary?.isOverspending}
            overspendAmount={summary?.overspendAmount}
          />
        </div>
        <div className="opacity-0 animate-fade-in stagger-4">
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
          <div className="opacity-0 animate-fade-in stagger-5">
            <CreditCardDebtCard
              creditCards={summary.creditCards}
              totalCCDebt={summary.totalCCDebt}
              ccSpendingThisMonth={summary.ccSpendingThisMonth}
              ccInterestFees={summary.ccInterestFees}
              income={summary.income}
            />
          </div>
        )}
        <div className="opacity-0 animate-fade-in stagger-5">
          <SavingsSummaryCard
            income={monthlyIncome}
            expenses={monthlyExpenses}
            previousSavings={previousSavings}
          />
        </div>
        <div className="opacity-0 animate-fade-in stagger-5">
          <WeeklySpendingCard
            dailySpending={dailySpending}
            percentChange={weeklyPercentChange}
          />
        </div>
      </div>

      {/* Monthly Spending + Trend Chart */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="opacity-0 animate-fade-in stagger-6">
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
    </div>
  )
}
