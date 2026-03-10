import { useState, useEffect, useMemo } from 'react'
import {
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Info,
  Sparkles,
  Shield,
  Target,
  Flame,
  Zap,
  ChevronRight,
  Filter,
  Lightbulb,
  HelpCircle,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn, formatCurrency } from '@/lib/utils'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/shared/PageHeader'
import type {
  InsightsData,
  Insight,
  Recommendation,
  Clarification,
  HealthFactor,
  PeriodView,
} from '@/types'

// ── Severity Config ──

const SEVERITY_CONFIG = {
  critical: {
    border: 'border-l-red-500',
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    badge: 'bg-red-500/20 text-red-400',
    icon: AlertTriangle,
    label: 'Critical',
  },
  warning: {
    border: 'border-l-amber-500',
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    badge: 'bg-amber-500/20 text-amber-400',
    icon: AlertCircle,
    label: 'Warning',
  },
  positive: {
    border: 'border-l-emerald-500',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    badge: 'bg-emerald-500/20 text-emerald-400',
    icon: CheckCircle2,
    label: 'Positive',
  },
  info: {
    border: 'border-l-blue-500',
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    badge: 'bg-blue-500/20 text-blue-400',
    icon: Info,
    label: 'Info',
  },
} as const

const PRIORITY_CONFIG = {
  high: { bg: 'bg-red-500/20 text-red-400', label: 'High Priority' },
  medium: { bg: 'bg-amber-500/20 text-amber-400', label: 'Medium' },
  low: { bg: 'bg-blue-500/20 text-blue-400', label: 'Low' },
} as const

const FILTER_TABS = ['all', 'critical', 'warning', 'positive', 'info'] as const
type FilterTab = (typeof FILTER_TABS)[number]

// ── Health Score Ring ──

function HealthScoreRing({ score, grade }: { score: number; grade: string }) {
  const radius = 90
  const stroke = 12
  const normalizedRadius = radius - stroke / 2
  const circumference = normalizedRadius * 2 * Math.PI
  const offset = circumference - (score / 100) * circumference

  const getScoreColor = (s: number) => {
    if (s >= 70) return { start: '#34D399', end: '#10B981' }
    if (s >= 40) return { start: '#FBBF24', end: '#F59E0B' }
    return { start: '#F87171', end: '#EF4444' }
  }

  const getScoreLabel = (s: number) => {
    if (s >= 90) return 'Excellent'
    if (s >= 70) return 'Good'
    if (s >= 50) return 'Fair'
    if (s >= 30) return 'Needs Work'
    return 'Critical'
  }

  const colors = getScoreColor(score)
  const gradientId = 'health-score-gradient'

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <svg
          height={radius * 2}
          width={radius * 2}
          className="transform -rotate-90"
        >
          <defs>
            <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={colors.start} />
              <stop offset="100%" stopColor={colors.end} />
            </linearGradient>
          </defs>
          {/* Background track */}
          <circle
            stroke="hsl(240 10% 15%)"
            fill="transparent"
            strokeWidth={stroke}
            r={normalizedRadius}
            cx={radius}
            cy={radius}
          />
          {/* Score arc */}
          <circle
            stroke={`url(#${gradientId})`}
            fill="transparent"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={offset}
            r={normalizedRadius}
            cx={radius}
            cy={radius}
            className="transition-all duration-1000 ease-out"
          />
        </svg>
        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-4xl font-bold tabular-nums">{score}</span>
          <span
            className={cn(
              'text-lg font-bold mt-0.5',
              score >= 70
                ? 'text-emerald-400'
                : score >= 40
                  ? 'text-amber-400'
                  : 'text-red-400'
            )}
          >
            {grade}
          </span>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mt-3">{getScoreLabel(score)}</p>
    </div>
  )
}

// ── Health Factor Row ──

function HealthFactorRow({ factor }: { factor: HealthFactor }) {
  const percent = Math.min(Math.max(factor.score, 0), 100)
  const getBarColor = (s: number) => {
    if (s >= 70) return 'bg-emerald-500'
    if (s >= 40) return 'bg-amber-500'
    return 'bg-red-500'
  }

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium text-muted-foreground w-32 shrink-0 truncate">
        {factor.name}
      </span>
      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-700 ease-out',
            getBarColor(percent)
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-sm font-semibold tabular-nums w-10 text-right">
        {percent}
      </span>
    </div>
  )
}

// ── Quick Stat Card ──

function QuickStatCard({
  label,
  value,
  trend,
  trendLabel,
  icon: Icon,
  isCurrency = false,
  isPercent = false,
}: {
  label: string
  value: number
  trend?: 'up' | 'down' | 'stable'
  trendLabel?: string
  icon: React.ElementType
  isCurrency?: boolean
  isPercent?: boolean
}) {
  const formatted = isCurrency
    ? formatCurrency(value)
    : isPercent
      ? `${value.toFixed(1)}%`
      : value.toFixed(1)

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </p>
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
          <Icon className="w-4 h-4 text-primary" />
        </div>
      </div>
      <p className="text-2xl font-bold tabular-nums">{formatted}</p>
      {trend && trendLabel && (
        <div className="flex items-center gap-1">
          {trend === 'up' ? (
            <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" />
          ) : trend === 'down' ? (
            <ArrowDownRight className="w-3.5 h-3.5 text-red-400" />
          ) : (
            <Minus className="w-3.5 h-3.5 text-muted-foreground" />
          )}
          <span
            className={cn(
              'text-xs font-medium',
              trend === 'up'
                ? 'text-emerald-400'
                : trend === 'down'
                  ? 'text-red-400'
                  : 'text-muted-foreground'
            )}
          >
            {trendLabel}
          </span>
        </div>
      )}
    </div>
  )
}

// ── Insight Card ──

function InsightCard({ insight }: { insight: Insight }) {
  const config = SEVERITY_CONFIG[insight.severity]
  const SeverityIcon = config.icon

  const getTrendIcon = () => {
    if (insight.trend === 'up') {
      return insight.severity === 'positive' ? (
        <TrendingUp className="w-4 h-4 text-emerald-400" />
      ) : (
        <TrendingUp className="w-4 h-4 text-red-400" />
      )
    }
    if (insight.trend === 'down') {
      return insight.severity === 'positive' ? (
        <TrendingDown className="w-4 h-4 text-red-400" />
      ) : (
        <TrendingDown className="w-4 h-4 text-emerald-400" />
      )
    }
    return <Minus className="w-4 h-4 text-muted-foreground" />
  }

  return (
    <div
      className={cn(
        'bg-card rounded-xl border border-border/50 border-l-4 p-5 transition-all hover:border-border',
        config.border
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5',
            config.bg
          )}
        >
          <SeverityIcon className={cn('w-4.5 h-4.5', config.text)} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold leading-tight">
                {insight.title}
              </h3>
              <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                {insight.description}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-3 flex-wrap">
            <div className="flex items-center gap-1.5 bg-muted/50 rounded-lg px-2.5 py-1">
              {getTrendIcon()}
              <span className="text-xs font-medium">{insight.metric}</span>
            </div>
            <span
              className={cn(
                'text-[11px] font-medium px-2 py-0.5 rounded-full',
                config.badge
              )}
            >
              {config.label}
            </span>
            {insight.category && (
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                {insight.category}
              </span>
            )}
          </div>
          {insight.action && (
            <button
              onClick={() => {
                const cat = insight.category?.toLowerCase() || ''
                if (cat.includes('budget') || cat.includes('spending')) window.location.href = '/budgets'
                else if (cat.includes('recurring')) window.location.href = '/recurring'
                else if (cat.includes('saving') || cat.includes('goal')) window.location.href = '/goals'
                else if (cat.includes('invest')) window.location.href = '/investments'
                else window.location.href = '/transactions'
              }}
              className="mt-3 text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1 transition-colors"
            >
              {insight.action}
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Recommendation Card ──

function getActionRoute(rec: Recommendation): string {
  const title = rec.title.toLowerCase()
  const desc = rec.description.toLowerCase()
  if (title.includes('budget') || desc.includes('budget')) return '/budgets'
  if (title.includes('saving') || desc.includes('saving')) return '/goals'
  if (title.includes('recurring') || title.includes('subscription') || desc.includes('subscription')) return '/recurring'
  if (title.includes('invest') || desc.includes('invest')) return '/investments'
  if (title.includes('transaction') || desc.includes('categoriz')) return '/transactions'
  if (title.includes('goal') || desc.includes('goal')) return '/goals'
  if (title.includes('account') || desc.includes('account')) return '/accounts'
  return '/budgets'
}

function RecommendationCard({ rec, onNavigate }: { rec: Recommendation; onNavigate: (path: string) => void }) {
  const priorityConf = PRIORITY_CONFIG[rec.priority]
  const route = getActionRoute(rec)

  return (
    <div className="bg-card rounded-xl border border-border/50 p-5 transition-all hover:border-border">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-amber-400 shrink-0" />
          <h3 className="text-sm font-semibold leading-tight">{rec.title}</h3>
        </div>
        <span
          className={cn(
            'text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0',
            priorityConf.bg
          )}
        >
          {priorityConf.label}
        </span>
      </div>
      <p className="text-sm text-muted-foreground leading-relaxed">
        {rec.description}
      </p>
      {rec.estimatedSavings != null && rec.estimatedSavings > 0 && (
        <div className="mt-3 flex items-center gap-2 bg-emerald-500/10 rounded-lg px-3 py-2">
          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-xs font-medium text-emerald-400">
            Estimated savings: {formatCurrency(rec.estimatedSavings)}/mo
          </span>
        </div>
      )}
      <button
        onClick={() => onNavigate(route)}
        className="mt-3 w-full h-9 rounded-lg bg-primary/10 text-primary text-sm font-medium hover:bg-primary/20 transition-colors flex items-center justify-center gap-1.5"
      >
        <Zap className="w-3.5 h-3.5" />
        Take Action
      </button>
    </div>
  )
}

// ── Clarification Card ──

function ClarificationCard({
  clarification,
  onResolve,
  onDismiss,
}: {
  clarification: Clarification
  onResolve: (id: string) => void
  onDismiss: (id: string) => void
}) {
  return (
    <div className="bg-card rounded-xl border border-border/50 border-l-4 border-l-purple-500 p-5">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-purple-500/10 flex items-center justify-center shrink-0 mt-0.5">
          <HelpCircle className="w-4.5 h-4.5 text-purple-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold">{clarification.title}</h3>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
            {clarification.description}
          </p>
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-400">
              {clarification.item_type}
            </span>
            <span className="text-[11px] text-muted-foreground">
              via {clarification.source}
            </span>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => onResolve(clarification.id)}
              className="h-8 px-4 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
            >
              Resolve
            </button>
            <button
              onClick={() => onDismiss(clarification.id)}
              className="h-8 px-4 rounded-lg border border-border/50 text-xs font-medium hover:bg-accent transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Loading Skeleton ──

function InsightsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="opacity-0 animate-fade-in stagger-1">
        <div className="h-8 w-48 rounded-lg bg-muted animate-pulse" />
        <div className="h-4 w-64 rounded-lg bg-muted animate-pulse mt-2" />
      </div>

      {/* Health Score skeleton */}
      <div className="bg-card rounded-2xl border border-border/50 p-8 opacity-0 animate-fade-in stagger-2">
        <div className="flex flex-col lg:flex-row items-center gap-8">
          <div className="w-[180px] h-[180px] rounded-full bg-muted animate-pulse" />
          <div className="flex-1 space-y-4 w-full">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-6 rounded-lg bg-muted animate-pulse" />
            ))}
          </div>
        </div>
      </div>

      {/* Quick stats skeleton */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 opacity-0 animate-fade-in stagger-3">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="bg-card rounded-2xl border border-border/50 p-5 h-32 animate-pulse"
          />
        ))}
      </div>

      {/* Insights skeleton */}
      <div className="space-y-4 opacity-0 animate-fade-in stagger-4">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="bg-card rounded-xl border border-border/50 p-5 h-28 animate-pulse"
          />
        ))}
      </div>
    </div>
  )
}

// ── Empty State ──

function EmptyInsights() {
  return (
    <div className="bg-card rounded-2xl border border-border/50 p-12 text-center">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
        <Sparkles className="w-8 h-8 text-primary" />
      </div>
      <h3 className="text-lg font-semibold">No Insights Yet</h3>
      <p className="text-sm text-muted-foreground mt-2 max-w-sm mx-auto">
        Start tracking your transactions and budgets to unlock personalized financial
        insights and recommendations.
      </p>
    </div>
  )
}

// ── Main Page ──

export function InsightsPage() {
  const navigate = useNavigate()
  const [data, setData] = useState<InsightsData | null>(null)
  const [clarifications, setClarifications] = useState<Clarification[]>([])
  const [loading, setLoading] = useState(true)
  const [periodView, setPeriodView] = useState<'monthly' | 'annual'>('monthly')
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all')

  useEffect(() => {
    let cancelled = false

    async function loadData() {
      try {
        const [insightsRes, clarRes] = await Promise.all([
          api.get<InsightsData>('/insights').catch(() => null),
          api.get<Clarification[]>('/clarifications').catch(() => []),
        ])

        if (!cancelled) {
          setData(insightsRes)
          setClarifications(Array.isArray(clarRes) ? clarRes : [])
          setLoading(false)
        }
      } catch (err) {
        console.error('Failed to load insights:', err)
        if (!cancelled) setLoading(false)
      }
    }

    loadData()
    return () => {
      cancelled = true
    }
  }, [])

  // Derive the active period view
  const activePeriod: PeriodView | null = useMemo(() => {
    if (!data) return null
    return periodView === 'monthly' ? data.monthlyView : data.annualView
  }, [data, periodView])

  // Filter insights
  const filteredInsights = useMemo(() => {
    if (!data) return []
    const sorted = [...data.insights].sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2, positive: 3 }
      return order[a.severity] - order[b.severity]
    })
    if (activeFilter === 'all') return sorted
    return sorted.filter((i) => i.severity === activeFilter)
  }, [data, activeFilter])

  // Pending clarifications only
  const pendingClarifications = useMemo(() => {
    return clarifications.filter((c) => c.status === 'pending')
  }, [clarifications])

  // Insight filter counts
  const filterCounts = useMemo(() => {
    if (!data) return {} as Record<FilterTab, number>
    const counts: Record<FilterTab, number> = {
      all: data.insights.length,
      critical: 0,
      warning: 0,
      positive: 0,
      info: 0,
    }
    data.insights.forEach((i) => {
      counts[i.severity]++
    })
    return counts
  }, [data])

  // Compute trend for savings rate
  const savingsRateTrend = useMemo((): {
    trend: 'up' | 'down' | 'stable'
    label: string
  } => {
    if (!data) return { trend: 'stable', label: '' }
    const monthly = data.monthlyView.savingsRate
    if (monthly >= 20) return { trend: 'up', label: 'Healthy' }
    if (monthly >= 10) return { trend: 'stable', label: 'Average' }
    return { trend: 'down', label: 'Below target' }
  }, [data])

  // Budget adherence trend
  const budgetTrend = useMemo((): {
    trend: 'up' | 'down' | 'stable'
    label: string
  } => {
    if (!activePeriod) return { trend: 'stable', label: '' }
    const adherence =
      activePeriod.totalExpenses > 0 && activePeriod.totalIncome > 0
        ? Math.max(
            0,
            100 -
              ((activePeriod.totalExpenses - activePeriod.totalRecurring) /
                activePeriod.totalIncome) *
                100
          )
        : 100
    if (adherence >= 90) return { trend: 'up', label: 'On track' }
    if (adherence >= 70) return { trend: 'stable', label: 'Moderate' }
    return { trend: 'down', label: 'Over budget' }
  }, [activePeriod])

  const handleResolveClarification = async (id: string) => {
    try {
      await api.put(`/clarifications/${id}`, {
        status: 'resolved',
        resolution: {},
      })
      setClarifications((prev) =>
        prev.map((c) => (c.id === id ? { ...c, status: 'resolved' as const } : c))
      )
    } catch (err) {
      console.error('Failed to resolve clarification:', err)
    }
  }

  const handleDismissClarification = async (id: string) => {
    try {
      await api.put(`/clarifications/${id}`, {
        status: 'dismissed',
        resolution: {},
      })
      setClarifications((prev) =>
        prev.map((c) =>
          c.id === id ? { ...c, status: 'dismissed' as const } : c
        )
      )
    } catch (err) {
      console.error('Failed to dismiss clarification:', err)
    }
  }

  // ── Render ──

  if (loading) return <InsightsSkeleton />

  if (!data) return (
    <div>
      <PageHeader
        title="Financial Insights"
        description="AI-powered analysis of your financial health"
      />
      <EmptyInsights />
    </div>
  )

  const budgetAdherence =
    activePeriod && activePeriod.totalExpenses > 0 && activePeriod.totalIncome > 0
      ? Math.min(
          100,
          Math.max(
            0,
            100 -
              ((activePeriod.totalExpenses - activePeriod.totalRecurring) /
                activePeriod.totalIncome) *
                100
          )
        )
      : 100

  return (
    <div className="space-y-6">
      {/* ── Page Header ── */}
      <PageHeader
        title="Financial Insights"
        description="AI-powered analysis of your financial health"
        action={
          <div className="flex items-center gap-1.5 bg-gradient-to-r from-primary/20 to-purple-500/20 rounded-full px-3 py-1.5">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-medium text-primary">
              AI Advisor
            </span>
          </div>
        }
      />

      {/* ── 1. Health Score Hero ── */}
      <div className="bg-card rounded-2xl border border-border/50 p-6 lg:p-8 opacity-0 animate-fade-in stagger-1">
        <div className="flex items-center gap-2 mb-6">
          <Shield className="w-5 h-5 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Financial Health Score
          </h2>
        </div>
        <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-12">
          <HealthScoreRing
            score={data.healthScore.score}
            grade={data.healthScore.grade}
          />
          <div className="flex-1 w-full space-y-3">
            {data.healthScore.factors.map((factor, i) => (
              <HealthFactorRow key={i} factor={factor} />
            ))}
          </div>
        </div>
      </div>

      {/* ── 2 & 3. Period Toggle + Quick Stats ── */}
      <div className="space-y-4 opacity-0 animate-fade-in stagger-2">
        {/* Toggle */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Financial Overview
          </h2>
          <div className="flex items-center bg-muted rounded-lg p-0.5">
            <button
              onClick={() => setPeriodView('monthly')}
              className={cn(
                'h-8 px-4 rounded-md text-xs font-medium transition-all',
                periodView === 'monthly'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Monthly
            </button>
            <button
              onClick={() => setPeriodView('annual')}
              className={cn(
                'h-8 px-4 rounded-md text-xs font-medium transition-all',
                periodView === 'annual'
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              Annual
            </button>
          </div>
        </div>

        {/* Quick Stats Grid */}
        {activePeriod && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <QuickStatCard
              label="Savings Rate"
              value={activePeriod.savingsRate}
              trend={savingsRateTrend.trend}
              trendLabel={savingsRateTrend.label}
              icon={Target}
              isPercent
            />
            <QuickStatCard
              label="Budget Adherence"
              value={budgetAdherence}
              trend={budgetTrend.trend}
              trendLabel={budgetTrend.label}
              icon={Shield}
              isPercent
            />
            <QuickStatCard
              label={
                periodView === 'monthly' ? 'Monthly Burn' : 'Annual Burn'
              }
              value={activePeriod.totalExpenses}
              trend={
                activePeriod.totalExpenses > activePeriod.totalIncome * 0.8
                  ? 'down'
                  : 'up'
              }
              trendLabel={
                activePeriod.totalExpenses > activePeriod.totalIncome * 0.8
                  ? 'High spend'
                  : 'Controlled'
              }
              icon={Flame}
              isCurrency
            />
            <QuickStatCard
              label="Net Cash Flow"
              value={activePeriod.netCashFlow}
              trend={activePeriod.netCashFlow >= 0 ? 'up' : 'down'}
              trendLabel={
                activePeriod.netCashFlow >= 0 ? 'Positive' : 'Negative'
              }
              icon={TrendingUp}
              isCurrency
            />
          </div>
        )}
      </div>

      {/* ── 4. Insights Feed ── */}
      <div className="space-y-4 opacity-0 animate-fade-in stagger-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-primary" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Insights
            </h2>
            <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5">
              {data.insights.length}
            </span>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveFilter(tab)}
              className={cn(
                'h-8 px-3 rounded-lg text-xs font-medium transition-colors capitalize whitespace-nowrap flex items-center gap-1.5',
                activeFilter === tab
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border border-border/50 hover:bg-accent text-muted-foreground'
              )}
            >
              {tab === 'all' ? (
                <Filter className="w-3 h-3" />
              ) : (
                <span
                  className={cn(
                    'w-2 h-2 rounded-full',
                    tab === 'critical' && 'bg-red-500',
                    tab === 'warning' && 'bg-amber-500',
                    tab === 'positive' && 'bg-emerald-500',
                    tab === 'info' && 'bg-blue-500'
                  )}
                />
              )}
              {tab === 'all' ? 'All' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              {filterCounts[tab] > 0 && (
                <span className="text-[10px] opacity-75">
                  ({filterCounts[tab]})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Insight Cards */}
        {filteredInsights.length === 0 ? (
          <div className="bg-card rounded-xl border border-border/50 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No {activeFilter === 'all' ? '' : activeFilter + ' '}insights to
              show.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredInsights.map((insight) => (
              <InsightCard key={insight.id} insight={insight} />
            ))}
          </div>
        )}
      </div>

      {/* ── 5. Recommendations ── */}
      {data.recommendations.length > 0 && (
        <div className="space-y-4 opacity-0 animate-fade-in stagger-4">
          <div className="flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-amber-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Recommendations
            </h2>
            <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5">
              {data.recommendations.length}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.recommendations
              .sort((a, b) => {
                const order = { high: 0, medium: 1, low: 2 }
                return order[a.priority] - order[b.priority]
              })
              .map((rec) => (
                <RecommendationCard key={rec.id} rec={rec} onNavigate={navigate} />
              ))}
          </div>
        </div>
      )}

      {/* ── 6. Needs Clarification ── */}
      {pendingClarifications.length > 0 && (
        <div className="space-y-4 opacity-0 animate-fade-in stagger-5">
          <div className="flex items-center gap-2">
            <HelpCircle className="w-5 h-5 text-purple-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Needs Your Input
            </h2>
            <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5">
              {pendingClarifications.length}
            </span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {pendingClarifications.map((c) => (
              <ClarificationCard
                key={c.id}
                clarification={c}
                onResolve={handleResolveClarification}
                onDismiss={handleDismissClarification}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
