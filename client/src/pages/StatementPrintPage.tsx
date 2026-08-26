import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { formatCurrency } from '@/lib/utils'

/**
 * The printable Category Statement.
 *
 * Deliberately NOT rendered inside AppLayout. The app shell is dark, has a
 * sidebar, and is built for screens; trying to @media-print it into a document
 * is how you get grey-on-grey tables and a navigation column down the side of
 * page one. This is a standalone light document that happens to live at a URL.
 */

interface CategoryRow {
  categoryId: string | null
  name: string
  icon: string
  total: number
  txnCount: number
  pctOfBand: number
  monthlyAvg: number | null
  priorTotal: number | null
  change: number | null
  budget: number | null
}

interface Txn {
  id: string
  date: string
  name: string
  notes: string | null
  amount: number
  flowType: string
  isPending: boolean
  categoryId: string | null
  categoryName: string
  accountName: string
}

interface Statement {
  period: { start: string; end: string; label: string }
  scope: { allAccounts: boolean; accountNames: string[] }
  coverage: { completeMonths: string[]; partialMonths: string[]; completeMonthCount: number; showMonthlyAvg: boolean }
  prior: { start: string; end: string } | null
  showBudgets: boolean
  totals: {
    income: number; expenses: number; net: number; refunds: number
    movedIn: number; movedOut: number; debtPayments: number; rowCount: number
  }
  incomeCategories: CategoryRow[]
  expenseCategories: CategoryRow[]
  moves: { name: string; icon: string; direction: 'in' | 'out'; total: number; txnCount: number }[]
  transactions: Txn[]
  data_notes: { note?: string | null } | null
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${MONTH_NAMES[m - 1]} ${y}`
}
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number)
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${d}`
}
/** Negatives in parentheses so meaning survives a black-and-white printer. */
function money(n: number, opts: { parens?: boolean } = {}): string {
  const s = formatCurrency(Math.abs(n))
  if (n < 0 && opts.parens !== false) return `(${s})`
  return s
}

export function StatementPrintPage() {
  const [params] = useSearchParams()
  const [data, setData] = useState<Statement | null>(null)
  const [error, setError] = useState<string | null>(null)

  const query = params.toString()

  useEffect(() => {
    let cancelled = false
    api.get<Statement>(`/reports/statement?${query}`)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e?.message || 'Could not load the statement') })
    return () => { cancelled = true }
  }, [query])

  // The app shell paints a dark background on <body>. This route is a document,
  // so it takes the page white for as long as it is mounted and hands it back
  // on the way out.
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

  // Print once the document has actually rendered, not on a timer.
  useEffect(() => {
    if (!data) return
    const id = requestAnimationFrame(() => requestAnimationFrame(() => {
      if (params.get('autoprint') !== '0') window.print()
    }))
    return () => cancelAnimationFrame(id)
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const byCategory = useMemo(() => {
    if (!data) return new Map<string, Txn[]>()
    const m = new Map<string, Txn[]>()
    for (const t of data.transactions) {
      const key = (t.flowType === 'transfer' || t.flowType === 'debt_payment')
        ? '__moves__'
        : (t.categoryId ?? '__none__')
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(t)
    }
    return m
  }, [data])

  if (error) {
    return <div className="stmt"><p style={{ padding: 40 }}>{error}</p></div>
  }
  if (!data) {
    return <div className="stmt"><p style={{ padding: 40 }}>Preparing statement…</p></div>
  }

  const { totals, coverage } = data
  const generated = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
  const scopeText = data.scope.allAccounts ? 'All accounts' : data.scope.accountNames.join(', ')

  const catCols = 4 + (coverage.showMonthlyAvg ? 1 : 0) + (data.prior ? 1 : 0) + (data.showBudgets ? 1 : 0)

  const renderBand = (rows: CategoryRow[], bandTotal: number, title: string, band: 'income' | 'expense') => (
    <>
      <tr className="band-head"><td colSpan={catCols}>{title}</td></tr>
      {rows.length === 0 && (
        <tr><td colSpan={catCols} className="muted">No {band === 'income' ? 'income' : 'spending'} in this period.</td></tr>
      )}
      {rows.map(r => (
        <tr key={band + (r.categoryId ?? 'none')}>
          <td>{r.icon} {r.name}</td>
          <td className="num">{r.txnCount.toLocaleString()}</td>
          <td className="num">{money(r.total)}</td>
          <td className="num">{r.pctOfBand.toFixed(1)}%</td>
          {coverage.showMonthlyAvg && <td className="num">{money(r.monthlyAvg ?? 0)}</td>}
          {data.prior && (
            <td className={'num ' + ((r.change ?? 0) > 0 ? 'up' : (r.change ?? 0) < 0 ? 'down' : '')}>
              {r.change === null ? '—' : (r.change > 0 ? '+' : '') + money(r.change, { parens: false })}
            </td>
          )}
          {data.showBudgets && (
            <td className="num">
              {r.budget === null ? '—' : `${money(r.budget)} / ${r.total > r.budget ? '+' : ''}${money(r.total - r.budget, { parens: false })}`}
            </td>
          )}
        </tr>
      ))}
      <tr className="band-total">
        <td>Total {band === 'income' ? 'income' : 'expenses'}</td>
        <td className="num">{rows.reduce((s, r) => s + r.txnCount, 0).toLocaleString()}</td>
        <td className="num">{money(bandTotal)}</td>
        <td className="num">100.0%</td>
        {coverage.showMonthlyAvg && <td className="num">{money(bandTotal / Math.max(coverage.completeMonthCount, 1))}</td>}
        {data.prior && <td />}
        {data.showBudgets && <td />}
      </tr>
    </>
  )

  const detailBlocks = [
    ...data.incomeCategories.map(c => ({ cat: c, band: 'Income' as const })),
    ...data.expenseCategories.map(c => ({ cat: c, band: 'Expenses' as const })),
  ]

  return (
    <div className="stmt">
      <style>{PRINT_CSS}</style>

      <div className="toolbar no-print">
        <button onClick={() => window.print()}>Print / Save as PDF</button>
        <span>Tip: choose “Save as PDF” in the print dialog to keep a copy.</span>
      </div>

      {/* One outer table so the identity header repeats on every printed page —
          table-header-group is the only mechanism browsers honour for this. */}
      <table className="page-frame">
        <thead>
          <tr><td>
            <div className="run-head">
              <div>
                <div className="run-title">Category Statement — {data.period.label}</div>
                <div className="run-sub">{scopeText} · Generated {generated}</div>
              </div>
              <div className="run-range">{data.period.start} → {data.period.end}</div>
            </div>
          </td></tr>
        </thead>
        <tfoot>
          <tr><td>
            <div className="run-foot">
              {coverage.completeMonthCount > 0 && <span>{coverage.completeMonthCount} complete month{coverage.completeMonthCount === 1 ? '' : 's'} in range. </span>}
              {data.data_notes?.note && <span>{data.data_notes.note}</span>}
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

          {/* ---------- Section 1 ---------- */}
          <h1>Summary by category</h1>
          <table className="data">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Txns</th>
                <th className="num">Total</th>
                <th className="num">% of band</th>
                {coverage.showMonthlyAvg && <th className="num">Monthly avg</th>}
                {data.prior && <th className="num">vs prior</th>}
                {data.showBudgets && <th className="num">Budget / Δ</th>}
              </tr>
            </thead>
            <tbody>
              {renderBand(data.incomeCategories, totals.income, 'INCOME', 'income')}
              {renderBand(data.expenseCategories, totals.expenses, 'EXPENSES', 'expense')}
              <tr className="net-row">
                <td>NET {totals.net >= 0 ? 'SURPLUS' : 'DEFICIT'}</td>
                <td />
                <td className="num">{money(totals.net)}</td>
                <td colSpan={catCols - 3} />
              </tr>
            </tbody>
          </table>

          {totals.net < 0 && totals.movedIn > 0 && (
            <p className="memo">
              The {money(Math.abs(totals.net), { parens: false })} shortfall was covered by{' '}
              {money(totals.movedIn, { parens: false })} moved in from asset sales, loan proceeds and
              your own other accounts — money that is not earnings.
            </p>
          )}

          {data.moves.length > 0 && (
            <>
              <h2>Excluded from the totals above — internal moves &amp; funding</h2>
              <p className="note">
                Money crossing between accounts you own, and payments onto debt. Counting these would
                double-count both the earning and the spending, so they sit in neither column.
              </p>
              <table className="data compact">
                <thead>
                  <tr><th>Movement</th><th className="num">Txns</th><th className="num">In</th><th className="num">Out</th></tr>
                </thead>
                <tbody>
                  {data.moves.map((m, i) => (
                    <tr key={i}>
                      <td>{m.icon} {m.name}</td>
                      <td className="num">{m.txnCount}</td>
                      <td className="num">{m.direction === 'in' ? money(m.total) : '—'}</td>
                      <td className="num">{m.direction === 'out' ? money(m.total) : '—'}</td>
                    </tr>
                  ))}
                  <tr className="band-total">
                    <td>Total</td>
                    <td className="num">{data.moves.reduce((s, m) => s + m.txnCount, 0)}</td>
                    <td className="num">{money(totals.movedIn)}</td>
                    <td className="num">{money(totals.movedOut + totals.debtPayments)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}

          {/* ---------- Section 2 ---------- */}
          <div className="section">
            <h1>Transaction detail</h1>
            <p className="note">
              Every transaction in the period, grouped under the category it belongs to and ordered
              oldest first. Each subtotal is the same figure shown in the summary above.
              <span className="legend"> R = refund (reduces the category total) · F = interest or fee · † = pending</span>
            </p>

            {detailBlocks.map(({ cat, band }) => {
              const rows = byCategory.get(cat.categoryId ?? '__none__') ?? []
              if (rows.length === 0) return null
              return (
                <div key={band + (cat.categoryId ?? 'none')} className={'cat-block' + (rows.length <= 12 ? ' short' : '')}>
                  <div className="cat-head">
                    <span>{cat.icon} {cat.name} <em>· {band}</em></span>
                    <span>{rows.length.toLocaleString()} transaction{rows.length === 1 ? '' : 's'} · {money(cat.total)}</span>
                  </div>
                  <table className="data detail">
                    <thead>
                      <tr><th>Date</th><th>Description</th><th>Account</th><th className="num">Amount</th></tr>
                    </thead>
                    <tbody>
                      {rows.map(t => (
                        <tr key={t.id}>
                          <td className="date">{shortDate(t.date)}{t.isPending ? ' †' : ''}</td>
                          <td className="desc">
                            {t.name}
                            {t.notes ? <em> — {t.notes}</em> : null}
                          </td>
                          <td className="acct">{t.accountName}</td>
                          <td className="num">
                            {t.flowType === 'refund'
                              ? `(${formatCurrency(Math.abs(t.amount))}) R`
                              : formatCurrency(Math.abs(t.amount)) + (t.flowType === 'interest_fee' ? ' F' : '')}
                          </td>
                        </tr>
                      ))}
                      <tr className="cat-total">
                        <td colSpan={3}>Subtotal — {cat.name}</td>
                        <td className="num">{money(cat.total)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )
            })}

            {(byCategory.get('__moves__')?.length ?? 0) > 0 && (
              <div className="cat-block">
                <div className="cat-head">
                  <span>🔄 Internal moves &amp; funding</span>
                  <span>{byCategory.get('__moves__')!.length} transaction{byCategory.get('__moves__')!.length === 1 ? '' : 's'}</span>
                </div>
                <table className="data detail">
                  <thead>
                    <tr><th>Date</th><th>Description</th><th>Account</th><th className="num">Amount</th></tr>
                  </thead>
                  <tbody>
                    {byCategory.get('__moves__')!.map(t => (
                      <tr key={t.id}>
                        <td className="date">{shortDate(t.date)}</td>
                        <td className="desc">{t.name}</td>
                        <td className="acct">{t.accountName}</td>
                        <td className="num">{t.amount >= 0 ? '+' : '−'}{formatCurrency(Math.abs(t.amount))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

        </td></tr></tbody>
      </table>
    </div>
  )
}

const PRINT_CSS = `
.stmt {
  background: #fff; color: #000; min-height: 100vh;
  font: 10.5pt/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-variant-numeric: tabular-nums;
  max-width: 8.5in; margin: 0 auto; padding: 0.5in 0.55in 1in;
}
.stmt table { border-collapse: collapse; width: 100%; }
.stmt .page-frame > thead > tr > td,
.stmt .page-frame > tfoot > tr > td,
.stmt .page-frame > tbody > tr > td { padding: 0; }

.run-head { display: flex; justify-content: space-between; align-items: flex-end;
  border-bottom: 1.5px solid #000; padding-bottom: 6px; margin-bottom: 16px; }
.run-title { font-size: 13pt; font-weight: 700; }
.run-sub { font-size: 8.5pt; color: #555; margin-top: 2px; }
.run-range { font-size: 8.5pt; color: #555; }
.run-foot { border-top: 1px solid #ccc; margin-top: 14px; padding-top: 5px;
  font-size: 8pt; color: #666; }

.stmt h1 { font-size: 12pt; font-weight: 700; margin: 20px 0 8px; }
.stmt h2 { font-size: 10.5pt; font-weight: 700; margin: 20px 0 4px; }
.stmt p { margin: 0 0 10px; }
.stmt .note { font-size: 8.5pt; color: #555; }
.stmt .legend { display: block; margin-top: 2px; color: #777; }
.stmt .muted { color: #777; font-style: italic; }
.stmt .warn { background: #FFF6E0; border: 1px solid #E8C77A; padding: 7px 10px;
  font-size: 9pt; border-radius: 2px; }
.stmt .memo { background: #F4F4F4; border-left: 3px solid #000; padding: 8px 10px;
  font-size: 9.5pt; }

table.data { margin-bottom: 6px; }
table.data th { text-align: left; font-size: 8pt; text-transform: uppercase;
  letter-spacing: .06em; color: #444; border-bottom: 1px solid #000;
  padding: 5px 6px; font-weight: 600; }
table.data td { padding: 3.5px 6px; border-bottom: 1px solid #EAEAEA; vertical-align: top; }
table.data .num { text-align: right; white-space: nowrap; }
table.data tbody tr:nth-child(even) td { background: #FAFAFA; }

tr.band-head td { background: #ECECEC !important; font-weight: 700; font-size: 8.5pt;
  letter-spacing: .08em; padding-top: 7px; padding-bottom: 5px; }
tr.band-total td { font-weight: 700; border-top: 1px solid #000;
  border-bottom: 1px solid #000; background: #fff !important; }
tr.net-row td { font-weight: 700; font-size: 11pt; border-top: 2px solid #000;
  border-bottom: 2px solid #000; background: #fff !important; padding: 7px 6px; }
.up { color: #A81E14; } .down { color: #0D6344; }

.cat-block { margin-bottom: 18px; }
.cat-head { display: flex; justify-content: space-between; font-weight: 700;
  font-size: 10pt; border-bottom: 1.5px solid #000; padding-bottom: 3px; margin-bottom: 2px; }
.cat-head em { font-weight: 400; font-style: normal; color: #777; font-size: 8.5pt; }
table.detail td { font-size: 9pt; }
table.detail .date { width: 0.62in; color: #444; white-space: nowrap; }
table.detail .acct { width: 1.15in; color: #555; font-size: 8.5pt; }
table.detail .num { width: 0.95in; }
table.detail .desc em { color: #666; font-size: 8.5pt; }
tr.cat-total td { font-weight: 700; border-top: 1px solid #000; background: #fff !important; }

.toolbar { display: flex; align-items: center; gap: 14px; margin-bottom: 18px;
  font-size: 9.5pt; color: #555; }
.toolbar button { font: inherit; font-weight: 600; color: #fff; background: #111;
  border: 0; border-radius: 4px; padding: 8px 16px; cursor: pointer; }

@media print {
  @page { size: letter portrait; margin: 0.5in 0.55in; }
  .stmt { max-width: none; margin: 0; padding: 0; }
  .no-print { display: none !important; }
  .page-frame > thead { display: table-header-group; }
  .page-frame > tfoot { display: table-footer-group; }
  table.data thead { display: table-header-group; }
  tr { break-inside: avoid; }
  .cat-block.short { break-inside: avoid; }
  .cat-head { break-after: avoid; }
  .section { break-before: page; }
  h1, h2 { break-after: avoid; }
  table.data tbody tr:nth-child(even) td,
  tr.band-head td { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`
