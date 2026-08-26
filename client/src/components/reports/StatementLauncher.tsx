import { useMemo, useState } from 'react'
import {
  format, startOfMonth, endOfMonth, startOfQuarter, endOfQuarter,
  startOfYear, endOfYear, subMonths, subQuarters, subYears,
} from 'date-fns'
import { Printer } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Period picker for the printable Category Statement.
 *
 * Every preset resolves to a concrete start/end pair here, so the server never
 * has to know what "last quarter" means and the two can't disagree about it.
 */

type Preset = 'month' | 'quarter' | 'year' | 'ytd' | 'trailing12' | 'custom'

const iso = (d: Date) => format(d, 'yyyy-MM-dd')

export function StatementLauncher() {
  const now = useMemo(() => new Date(), [])
  const [preset, setPreset] = useState<Preset>('month')
  // Steppers count back from the most recent COMPLETE period: a statement of a
  // month still in progress reads as a bad month rather than a partial one.
  const [back, setBack] = useState(1)
  const [customStart, setCustomStart] = useState(iso(startOfMonth(subMonths(now, 1))))
  const [customEnd, setCustomEnd] = useState(iso(endOfMonth(subMonths(now, 1))))

  const range = useMemo((): { start: string; end: string; label: string } => {
    switch (preset) {
      case 'month': {
        const d = subMonths(now, back)
        return { start: iso(startOfMonth(d)), end: iso(endOfMonth(d)), label: format(d, 'MMMM yyyy') }
      }
      case 'quarter': {
        const d = subQuarters(now, back)
        return { start: iso(startOfQuarter(d)), end: iso(endOfQuarter(d)), label: `Q${format(d, 'Q yyyy')}` }
      }
      case 'year': {
        const d = subYears(now, back)
        return { start: iso(startOfYear(d)), end: iso(endOfYear(d)), label: format(d, 'yyyy') }
      }
      case 'ytd':
        return { start: iso(startOfYear(now)), end: iso(now), label: `Year to date ${format(now, 'yyyy')}` }
      case 'trailing12':
        return { start: iso(startOfMonth(subMonths(now, 12))), end: iso(endOfMonth(subMonths(now, 1))), label: 'Trailing 12 months' }
      case 'custom':
        return { start: customStart, end: customEnd, label: `${customStart} to ${customEnd}` }
    }
  }, [preset, back, customStart, customEnd, now])

  const stepper = preset === 'month' || preset === 'quarter' || preset === 'year'

  const open = () => {
    const qs = new URLSearchParams({ start: range.start, end: range.end, label: range.label })
    window.open(`/reports/print?${qs.toString()}`, '_blank', 'noopener')
  }

  const presets: { value: Preset; label: string }[] = [
    { value: 'month', label: 'Month' },
    { value: 'quarter', label: 'Quarter' },
    { value: 'year', label: 'Year' },
    { value: 'ytd', label: 'Year to date' },
    { value: 'trailing12', label: 'Trailing 12' },
    { value: 'custom', label: 'Custom' },
  ]

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5 mb-6 print:hidden">
      <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
        <div>
          <h2 className="text-sm font-semibold">Print a Category Statement</h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-xl">
            Totals by category for the period, then every transaction underneath the category it
            belongs to. Opens as a printable document — use your browser's print dialog to save it
            as a PDF.
          </p>
        </div>
        <button
          onClick={open}
          className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2 shrink-0"
        >
          <Printer className="w-4 h-4" />
          Open statement
        </button>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {presets.map(p => (
          <button
            key={p.value}
            onClick={() => { setPreset(p.value); setBack(1) }}
            className={cn('h-8 px-3 rounded-lg text-sm font-medium transition-colors',
              preset === p.value ? 'bg-primary text-primary-foreground' : 'bg-background border border-border/50 hover:bg-accent')}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3 mt-3 flex-wrap">
        {stepper && (
          <div className="flex items-center gap-2">
            <button onClick={() => setBack(b => b + 1)} className="h-8 px-2.5 rounded-lg border border-border/50 hover:bg-accent text-sm">&larr;</button>
            <span className="text-sm font-medium min-w-[9rem] text-center">{range.label}</span>
            <button
              onClick={() => setBack(b => Math.max(1, b - 1))}
              disabled={back <= 1}
              className="h-8 px-2.5 rounded-lg border border-border/50 hover:bg-accent text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >&rarr;</button>
          </div>
        )}
        {preset === 'custom' && (
          <div className="flex items-center gap-2 text-sm">
            <input type="date" value={customStart} onChange={e => setCustomStart(e.target.value)}
              className="h-8 px-2 rounded-lg border border-input bg-background" />
            <span className="text-muted-foreground">to</span>
            <input type="date" value={customEnd} onChange={e => setCustomEnd(e.target.value)}
              className="h-8 px-2 rounded-lg border border-input bg-background" />
          </div>
        )}
        {!stepper && preset !== 'custom' && (
          <span className="text-sm text-muted-foreground">{range.label}</span>
        )}
        <span className="text-xs text-muted-foreground">{range.start} &rarr; {range.end}</span>
      </div>
    </div>
  )
}
