import { useState } from 'react'
import { AlertCircle, CheckCircle2, Loader2, Sparkles, X } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { api } from '@/lib/api'

interface DataQualityBannerProps {
  uncategorizedCount: number
  uncategorizedTotal: number
  onQualityImproved?: () => void
}

export function DataQualityBanner({
  uncategorizedCount,
  uncategorizedTotal,
  onQualityImproved,
}: DataQualityBannerProps) {
  const [isRunning, setIsRunning] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null
  if (uncategorizedCount === 0 && !result) return null

  const runQualityCheck = async (apply: boolean) => {
    setIsRunning(true)
    try {
      const res = await api.post<any>(`/data/quality-check?apply=${apply}`)
      setResult(res)
      if (apply && onQualityImproved) {
        onQualityImproved()
      }
    } catch (err) {
      console.error('Quality check failed:', err)
    } finally {
      setIsRunning(false)
    }
  }

  // Show success state
  if (result?.applied) {
    const { improvements } = result
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-emerald-300">Data quality improved!</p>
            <div className="text-xs text-emerald-400/80 mt-1 space-y-0.5">
              {improvements.recategorized > 0 && (
                <p>{improvements.recategorized} transactions re-categorized</p>
              )}
              {improvements.duplicatesFound?.length > 0 && (
                <p>{improvements.duplicatesFound.length} potential duplicates flagged</p>
              )}
            </div>
          </div>
          <button onClick={() => setDismissed(true)} className="text-emerald-400/60 hover:text-emerald-400">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  // Show preview results
  if (result && !result.applied) {
    const { improvements } = result
    const hasImprovements = improvements.recategorized > 0 ||
      improvements.duplicatesFound?.length > 0 ||
      improvements.missingTransferCategory?.length > 0

    if (!hasImprovements) {
      return (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-emerald-300">Your data looks great!</p>
              <p className="text-xs text-emerald-400/80 mt-0.5">No improvements needed at this time.</p>
            </div>
            <button onClick={() => setDismissed(true)} className="text-emerald-400/60 hover:text-emerald-400">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
        <div className="flex items-start gap-3">
          <Sparkles className="w-5 h-5 text-blue-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-medium text-blue-300">We found improvements</p>
            <div className="text-xs text-blue-400/80 mt-1 space-y-0.5">
              {improvements.recategorized > 0 && (
                <p>• {improvements.recategorized} transactions can be re-categorized</p>
              )}
              {improvements.duplicatesFound?.length > 0 && (
                <p>• {improvements.duplicatesFound.length} potential duplicate(s) across accounts</p>
              )}
              {improvements.missingTransferCategory?.length > 0 && (
                <p>• {improvements.missingTransferCategory.length} CC payment(s) not marked as transfers</p>
              )}
            </div>
            <div className="flex gap-2 mt-3">
              <button
                onClick={() => runQualityCheck(true)}
                disabled={isRunning}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 transition-colors"
              >
                {isRunning ? (
                  <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Applying...</span>
                ) : (
                  'Apply Improvements'
                )}
              </button>
              <button
                onClick={() => setDismissed(true)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg text-muted-foreground hover:text-foreground transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Initial state: show uncategorized warning with scan button
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-amber-400 mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="text-sm font-medium text-amber-300">
            {uncategorizedCount} uncategorized transaction{uncategorizedCount !== 1 ? 's' : ''} ({formatCurrency(uncategorizedTotal)})
          </p>
          <p className="text-xs text-amber-400/80 mt-0.5">
            Let us scan and improve your data quality automatically.
          </p>
          <button
            onClick={() => runQualityCheck(false)}
            disabled={isRunning}
            className="mt-2 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 disabled:opacity-50 transition-colors"
          >
            {isRunning ? (
              <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Scanning...</span>
            ) : (
              'Scan & Improve'
            )}
          </button>
        </div>
        <button onClick={() => setDismissed(true)} className="text-amber-400/60 hover:text-amber-400">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
