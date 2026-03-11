import { AlertTriangle, TrendingDown, CreditCard, ArrowRightLeft, ShieldAlert, CheckCircle2 } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'

interface FinancialHealthCardProps {
  income: number
  expenses: number
  isOverspending: boolean
  overspendAmount: number
  totalCCDebt: number
  ccSpendingThisMonth: number
  ccInterestFees: number
  transfersIn: number
  transfersOut: number
  savingsRate: number
  dayOfMonth: number
  daysInMonth: number
}

export function FinancialHealthCard({
  income,
  expenses,
  isOverspending,
  overspendAmount,
  totalCCDebt,
  ccSpendingThisMonth,
  ccInterestFees,
  transfersIn,
  transfersOut,
  savingsRate,
  dayOfMonth,
  daysInMonth,
}: FinancialHealthCardProps) {
  // Calculate health score (0-100)
  const getHealthScore = () => {
    let score = 50 // start neutral

    // Savings rate impact (-30 to +30)
    if (savingsRate >= 20) score += 30
    else if (savingsRate >= 10) score += 20
    else if (savingsRate >= 0) score += 5
    else if (savingsRate >= -10) score -= 10
    else score -= 30

    // CC debt impact (0 to -20)
    if (totalCCDebt > 0) {
      const debtToIncome = income > 0 ? totalCCDebt / income : 10
      if (debtToIncome > 2) score -= 20
      else if (debtToIncome > 1) score -= 15
      else if (debtToIncome > 0.5) score -= 10
      else score -= 5
    }

    // CC interest penalty (0 to -10)
    if (ccInterestFees > 0) score -= 10

    // Spending pace (0 to +10)
    const expectedSpentPct = dayOfMonth / daysInMonth
    const actualSpentPct = income > 0 ? expenses / income : 1
    if (actualSpentPct < expectedSpentPct) score += 10

    return Math.max(0, Math.min(100, score))
  }

  const healthScore = getHealthScore()

  const getScoreColor = () => {
    if (healthScore >= 70) return 'text-emerald-400'
    if (healthScore >= 40) return 'text-amber-400'
    return 'text-red-400'
  }

  const getScoreLabel = () => {
    if (healthScore >= 80) return 'Excellent'
    if (healthScore >= 70) return 'Good'
    if (healthScore >= 50) return 'Fair'
    if (healthScore >= 30) return 'Needs Attention'
    return 'Critical'
  }

  const getScoreBg = () => {
    if (healthScore >= 70) return 'from-emerald-500/20 via-emerald-500/10'
    if (healthScore >= 40) return 'from-amber-500/20 via-amber-500/10'
    return 'from-red-500/20 via-red-500/10'
  }

  const getScoreBorder = () => {
    if (healthScore >= 70) return 'border-emerald-500/20'
    if (healthScore >= 40) return 'border-amber-500/20'
    return 'border-red-500/20'
  }

  // Build alerts
  const alerts: { icon: any; message: string; severity: 'critical' | 'warning' | 'info' }[] = []

  if (isOverspending) {
    alerts.push({
      icon: AlertTriangle,
      message: `Spending exceeds income by ${formatCurrency(overspendAmount)} this month`,
      severity: 'critical',
    })
  }

  if (ccInterestFees > 0) {
    alerts.push({
      icon: ShieldAlert,
      message: `${formatCurrency(ccInterestFees)} in CC interest/fees — this is money lost`,
      severity: 'critical',
    })
  }

  if (totalCCDebt > 0 && income > 0 && totalCCDebt > income * 0.5) {
    alerts.push({
      icon: CreditCard,
      message: `CC debt (${formatCurrency(totalCCDebt)}) is ${Math.round((totalCCDebt / income) * 100)}% of monthly income`,
      severity: totalCCDebt > income ? 'critical' : 'warning',
    })
  }

  if (savingsRate < 0) {
    alerts.push({
      icon: TrendingDown,
      message: `Negative savings rate (${savingsRate.toFixed(1)}%) — spending more than earning`,
      severity: 'critical',
    })
  } else if (savingsRate < 10 && savingsRate >= 0) {
    alerts.push({
      icon: TrendingDown,
      message: `Savings rate is only ${savingsRate.toFixed(1)}% — aim for at least 10-20%`,
      severity: 'warning',
    })
  }

  if (transfersIn > 0 || transfersOut > 0) {
    alerts.push({
      icon: ArrowRightLeft,
      message: `${formatCurrency(transfersOut)} transferred between accounts (not counted as spending)`,
      severity: 'info',
    })
  }

  return (
    <div className={cn('rounded-2xl border p-5 bg-gradient-to-br to-card', getScoreBg(), getScoreBorder())}>
      {/* Score Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {healthScore >= 70 ? (
            <CheckCircle2 className="w-5 h-5 text-emerald-400" />
          ) : healthScore >= 40 ? (
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          ) : (
            <ShieldAlert className="w-5 h-5 text-red-400" />
          )}
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Financial Health</p>
        </div>
        <div className="flex items-baseline gap-1">
          <span className={cn('text-2xl font-bold tabular-nums', getScoreColor())}>{healthScore}</span>
          <span className="text-xs text-muted-foreground">/100</span>
        </div>
      </div>

      <p className={cn('text-sm font-semibold', getScoreColor())}>{getScoreLabel()}</p>

      {/* Health Bar */}
      <div className="mt-2 h-2 rounded-full bg-muted/50 overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all duration-1000',
            healthScore >= 70 ? 'bg-emerald-500' : healthScore >= 40 ? 'bg-amber-500' : 'bg-red-500'
          )}
          style={{ width: `${healthScore}%` }}
        />
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {alerts.slice(0, 4).map((alert, i) => {
            const Icon = alert.icon
            return (
              <div key={i} className="flex items-start gap-2">
                <Icon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0',
                  alert.severity === 'critical' ? 'text-red-400' :
                  alert.severity === 'warning' ? 'text-amber-400' : 'text-blue-400'
                )} />
                <span className="text-xs text-muted-foreground leading-tight">{alert.message}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
