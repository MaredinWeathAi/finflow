import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Categories down, months across.
 *
 * The shape you pivot in Excel. Refunds are NOT netted into the category they
 * came from — they get their own row per tier — so one large refund no longer
 * puts a crater in the middle of a twelve-month category line. Tier subtotals
 * are gross spending minus refunds, so the totals still tie out.
 */

export interface MatrixRow {
  name: string
  icon: string
  type: 'Income' | 'Expense' | 'Refund'
  tier: string
  tierKey: string
  byMonth: Record<string, number>
  total: number
  monthlyAverage: number
}

interface Summary { name: string; byMonth: Record<string, number>; total: number; monthlyAverage: number }

export interface Matrix {
  period: { start: string; end: string; label: string }
  scope: { allAccounts: boolean; accountNames: string[] }
  coverage: { completeMonths: string[]; partialMonths: string[] }
  monthKeys: string[]
  partialIncluded: boolean
  rows: MatrixRow[]
  tierSubtotals: (Summary & { tierKey: string })[]
  summary: { income: Summary; expenses: Summary; refunds: Summary; net: Summary }
}

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function colLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTH_ABBR[m - 1]} ${String(y).slice(2)}`
}

/** Minus sign, not parentheses — the owner asked for it explicitly. */
export function cell(v: number): string {
  if (!v) return '—'
  const s = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
  return v < 0 ? `−${s}` : s
}

const TIERS = [
  { key: 'debt', label: 'Debt service' },
  { key: 'committed', label: 'Committed' },
  { key: 'discretionary', label: 'Discretionary' },
  { key: 'income', label: 'Income' },
]

/** Build the CSV exactly as the grid reads, with real minus signs. */
export function buildCsv(d: Matrix): string {
  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`
  const out: string[] = []
  out.push(['Category', 'Type', 'Tier', ...d.monthKeys, 'Total', 'MonthlyAverage'].join(','))
  for (const t of TIERS) {
    for (const r of d.rows.filter(x => x.tierKey === t.key)) {
      out.push([
        esc(r.name), r.type, esc(r.tier),
        ...d.monthKeys.map(m => String(r.byMonth[m] ?? 0)),
        String(r.total), String(r.monthlyAverage),
      ].join(','))
    }
    const sub = d.tierSubtotals.find(s => s.tierKey === t.key)
    if (sub && sub.total !== 0) {
      out.push([
        esc(sub.name), 'Subtotal', esc(t.label),
        ...d.monthKeys.map(m => String(sub.byMonth[m] ?? 0)),
        String(sub.total), String(sub.monthlyAverage),
      ].join(','))
    }
  }
  for (const s of [d.summary.income, d.summary.expenses, d.summary.refunds, d.summary.net]) {
    out.push([
      esc(s.name), 'Summary', '',
      ...d.monthKeys.map(m => String(s.byMonth[m] ?? 0)),
      String(s.total), String(s.monthlyAverage),
    ].join(','))
  }
  return out.join('\n')
}

export function downloadCsv(d: Matrix) {
  const blob = new Blob([buildCsv(d)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  // The period travels in the filename, not in a title row that would stop
  // Excel treating row 1 as headers.
  a.download = `finbudget-monthly-matrix-${d.period.start.slice(0, 7)}_${d.period.end.slice(0, 7)}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function CategoryMatrix({ start, end, label }: { start: string; end: string; label?: string }) {
  const [data, setData] = useState<Matrix | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [includePartial, setIncludePartial] = useState(false)

  const query = useMemo(() => {
    const p = new URLSearchParams({ start, end })
    if (label) p.set('label', label)
    if (includePartial) p.set('includePartial', '1')
    return p.toString()
  }, [start, end, label, includePartial])

  useEffect(() => {
    let off = false
    setError(null)
    api.get<Matrix>(`/reports/matrix?${query}`)
      .then(d => { if (!off) setData(d) })
      .catch(e => { if (!off) setError(e?.message || 'Could not load the matrix') })
    return () => { off = true }
  }, [query])

  if (error) {
    return <div className="bg-card rounded-2xl border border-border/50 p-8 text-center text-muted-foreground">{error}</div>
  }
  if (!data) {
    return <div className="bg-card rounded-2xl border border-border/50 p-8 text-center text-muted-foreground">Loading…</div>
  }
  if (data.monthKeys.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
        <p className="font-medium">No complete months in this range</p>
        <p className="text-sm text-muted-foreground mt-1">
          The matrix uses months with full statement coverage. Try a longer period, or tick
          “Include the current partial month”.
        </p>
      </div>
    )
  }

  const { monthKeys, summary } = data
  const num = (v: number) => (
    <span className={cn('tabular-nums', v < 0 && 'text-danger')}>{cell(v)}</span>
  )

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4 flex-wrap">
          <p className="text-sm text-muted-foreground">
            {monthKeys.length} month{monthKeys.length === 1 ? '' : 's'} ·{' '}
            {data.rows.length} categories
            {data.coverage.partialMonths.length > 0 && !includePartial && (
              <> · {data.coverage.partialMonths.length} partial month
                {data.coverage.partialMonths.length === 1 ? '' : 's'} left out</>
            )}
          </p>
          {data.coverage.partialMonths.length > 0 && (
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={includePartial}
                onChange={e => setIncludePartial(e.target.checked)}
                className="accent-primary"
              />
              Include partial months
            </label>
          )}
        </div>
        <button
          onClick={() => downloadCsv(data)}
          className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2"
        >
          <Download className="w-4 h-4" />
          Download CSV
        </button>
      </div>

      <div className="bg-card rounded-2xl border border-border/50 overflow-x-auto">
        <table className="w-full text-sm border-separate border-spacing-0 tabular-nums">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 bg-card text-left px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border min-w-[190px]">
                Category
              </th>
              {monthKeys.map(m => (
                <th key={m} className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border whitespace-nowrap">
                  {colLabel(m)}
                  {data.coverage.partialMonths.includes(m) && <span title="partial month"> *</span>}
                </th>
              ))}
              <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border bg-primary/5">Total</th>
              <th className="px-3 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border-b border-border">Avg</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map(t => {
              const rows = data.rows.filter(r => r.tierKey === t.key)
              if (rows.length === 0) return null
              const sub = data.tierSubtotals.find(s => s.tierKey === t.key)
              return (
                <>
                  <tr key={t.key + '-band'} className="bg-muted/60">
                    <td className="sticky left-0 z-10 bg-muted/60 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                      {t.label}
                    </td>
                    <td colSpan={monthKeys.length + 2} />
                  </tr>
                  {rows.map(r => (
                    <tr key={t.key + r.name} className="hover:bg-accent/20">
                      <td className="sticky left-0 z-10 bg-card px-4 py-1.5 whitespace-nowrap">
                        {r.icon} {r.name}
                      </td>
                      {monthKeys.map(m => (
                        <td key={m} className="px-3 py-1.5 text-right">{num(r.byMonth[m] ?? 0)}</td>
                      ))}
                      <td className="px-3 py-1.5 text-right font-semibold bg-primary/5">{num(r.total)}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{num(r.monthlyAverage)}</td>
                    </tr>
                  ))}
                  {sub && sub.total !== 0 && (
                    <tr key={t.key + '-sub'} className="font-semibold border-t border-border">
                      <td className="sticky left-0 z-10 bg-card px-4 py-1.5 whitespace-nowrap">{sub.name}</td>
                      {monthKeys.map(m => (
                        <td key={m} className="px-3 py-1.5 text-right border-t border-border">{num(sub.byMonth[m] ?? 0)}</td>
                      ))}
                      <td className="px-3 py-1.5 text-right border-t border-border bg-primary/5">{num(sub.total)}</td>
                      <td className="px-3 py-1.5 text-right border-t border-border">{num(sub.monthlyAverage)}</td>
                    </tr>
                  )}
                </>
              )
            })}

            <tr className="bg-muted/60">
              <td className="sticky left-0 z-10 bg-muted/60 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">
                Summary
              </td>
              <td colSpan={monthKeys.length + 2} />
            </tr>
            {[summary.income, summary.expenses, summary.refunds].map(s => (
              <tr key={s.name} className={cn(s.name.startsWith('of which') ? 'text-muted-foreground' : 'font-semibold')}>
                <td className="sticky left-0 z-10 bg-card px-4 py-1.5 whitespace-nowrap">{s.name}</td>
                {monthKeys.map(m => <td key={m} className="px-3 py-1.5 text-right">{num(s.byMonth[m] ?? 0)}</td>)}
                <td className="px-3 py-1.5 text-right bg-primary/5">{num(s.total)}</td>
                <td className="px-3 py-1.5 text-right">{num(s.monthlyAverage)}</td>
              </tr>
            ))}
            <tr className="font-bold border-t-2 border-b-2 border-foreground/60">
              <td className="sticky left-0 z-10 bg-card px-4 py-2 whitespace-nowrap">NET</td>
              {monthKeys.map(m => (
                <td key={m} className="px-3 py-2 text-right">{num(summary.net.byMonth[m] ?? 0)}</td>
              ))}
              <td className="px-3 py-2 text-right bg-primary/5">{num(summary.net.total)}</td>
              <td className="px-3 py-2 text-right">{num(summary.net.monthlyAverage)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground px-1">
        Spending is shown as a positive amount; refunds are their own row per tier and carry a
        minus sign, so one large refund no longer dents a category&rsquo;s trend line. Tier
        subtotals are spending less refunds.
      </p>
    </div>
  )
}
