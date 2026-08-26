import { useEffect, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { PRINT_CSS, monthLabel } from '@/pages/StatementPrintPage'

/**
 * The chrome every printable report shares: white page, repeating running head
 * and footer, print button, coverage warning.
 *
 * The header repeats on every printed page via `display: table-header-group`
 * on a real <thead>, which is the only mechanism browsers honour for this.
 * Everything the report actually says goes in `children`.
 */
export function PrintShell({
  title, period, scopeText, coverage, notes, children,
}: {
  title: string
  period: { start: string; end: string; label: string }
  scopeText: string
  coverage: { completeMonths: string[]; partialMonths: string[] }
  notes?: string | null
  children: ReactNode
}) {
  const [params] = useSearchParams()

  // The app shell paints <body> dark; a document takes the page white while it
  // is mounted and hands it back on the way out.
  useEffect(() => {
    const prevBody = document.body.style.background
    const prevHtml = document.documentElement.style.background
    document.body.style.background = '#fff'
    document.documentElement.style.background = '#fff'
    return () => {
      document.body.style.background = prevBody
      document.documentElement.style.background = prevHtml
    }
  }, [])

  const generated = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })

  return (
    <div className="stmt">
      <style>{PRINT_CSS}</style>

      <div className="toolbar no-print">
        <button onClick={() => window.print()}>Print / Save as PDF</button>
        <span>Tip: choose “Save as PDF” in the print dialog to keep a copy.</span>
      </div>

      <table className="page-frame">
        <thead>
          <tr><td>
            <div className="run-head">
              <div>
                <div className="run-title">{title} — {period.label}</div>
                <div className="run-sub">{scopeText} · Generated {generated}</div>
              </div>
              <div className="run-range">{period.start} → {period.end}</div>
            </div>
          </td></tr>
        </thead>
        <tfoot>
          <tr><td>
            <div className="run-foot">
              {coverage.completeMonths.length > 0 && (
                <span>{coverage.completeMonths.length} complete month{coverage.completeMonths.length === 1 ? '' : 's'} in range. </span>
              )}
              {notes && <span>{notes}</span>}
            </div>
          </td></tr>
        </tfoot>
        <tbody><tr><td>
          {coverage.partialMonths.length > 0 && (
            <p className="warn">
              Includes partial data for {coverage.partialMonths.map(monthLabel).join(', ')} — totals
              for {coverage.partialMonths.length === 1 ? 'that month are' : 'those months are'} incomplete.
            </p>
          )}
          {children}
        </td></tr></tbody>
      </table>
      {params.get('autoprint') === 'never' && null}
    </div>
  )
}

/** Print once the document has really rendered, not on a timer. */
export function useAutoPrint(ready: boolean) {
  const [params] = useSearchParams()
  useEffect(() => {
    if (!ready) return
    const id = requestAnimationFrame(() => requestAnimationFrame(() => {
      if (params.get('autoprint') !== '0') window.print()
    }))
    return () => cancelAnimationFrame(id)
  }, [ready]) // eslint-disable-line react-hooks/exhaustive-deps
}
