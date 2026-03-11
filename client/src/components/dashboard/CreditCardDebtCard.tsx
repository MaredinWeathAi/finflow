import { CreditCard, TrendingUp, AlertTriangle, DollarSign } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'

interface CreditCardInfo {
  name: string
  balance: number
  institution: string
  icon: string
}

interface CreditCardDebtCardProps {
  creditCards: CreditCardInfo[]
  totalCCDebt: number
  ccSpendingThisMonth: number
  ccInterestFees: number
  income: number
}

export function CreditCardDebtCard({
  creditCards,
  totalCCDebt,
  ccSpendingThisMonth,
  ccInterestFees,
  income,
}: CreditCardDebtCardProps) {
  if (creditCards.length === 0 && totalCCDebt === 0) return null

  const debtToIncomeRatio = income > 0 ? (totalCCDebt / income) * 100 : 0
  const isHighDebt = debtToIncomeRatio > 50
  const isCriticalDebt = debtToIncomeRatio > 100

  return (
    <div className={cn(
      'rounded-2xl border p-5',
      isCriticalDebt
        ? 'bg-gradient-to-br from-red-500/15 via-red-500/5 to-card border-red-500/20'
        : isHighDebt
        ? 'bg-gradient-to-br from-amber-500/15 via-amber-500/5 to-card border-amber-500/20'
        : 'bg-card border-border/50'
    )}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center',
            isCriticalDebt ? 'bg-red-500/20' : isHighDebt ? 'bg-amber-500/20' : 'bg-blue-500/20'
          )}>
            <CreditCard className={cn(
              'w-4 h-4',
              isCriticalDebt ? 'text-red-400' : isHighDebt ? 'text-amber-400' : 'text-blue-400'
            )} />
          </div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Credit Card Debt
          </p>
        </div>
        {isCriticalDebt && (
          <AlertTriangle className="w-4 h-4 text-red-400 animate-pulse" />
        )}
      </div>

      {/* Total Debt */}
      <p className={cn(
        'text-2xl font-bold tabular-nums',
        isCriticalDebt ? 'text-red-400' : isHighDebt ? 'text-amber-400' : 'text-foreground'
      )}>
        {formatCurrency(Math.abs(totalCCDebt))}
      </p>
      {income > 0 && (
        <p className="text-xs text-muted-foreground mt-0.5">
          {debtToIncomeRatio.toFixed(0)}% of monthly income
        </p>
      )}

      {/* Card Breakdown */}
      {creditCards.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {creditCards.map((cc, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground truncate max-w-[60%]">
                {cc.name} ({cc.institution})
              </span>
              <span className="font-medium tabular-nums">
                {formatCurrency(Math.abs(cc.balance))}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Cost Indicators */}
      <div className="mt-3 pt-3 border-t border-border/30 space-y-1.5">
        {ccSpendingThisMonth > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <TrendingUp className="w-3 h-3 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground">Charged this month:</span>
            <span className="font-medium ml-auto tabular-nums">{formatCurrency(ccSpendingThisMonth)}</span>
          </div>
        )}
        {ccInterestFees > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <DollarSign className="w-3 h-3 text-red-400 shrink-0" />
            <span className="text-red-400 font-medium">Interest & Fees:</span>
            <span className="text-red-400 font-bold ml-auto tabular-nums">{formatCurrency(ccInterestFees)}</span>
          </div>
        )}
        {ccInterestFees > 0 && (
          <p className="text-[10px] text-red-400/80 italic mt-1">
            That's {formatCurrency(ccInterestFees * 12)}/year going to the credit card company
          </p>
        )}
      </div>
    </div>
  )
}
