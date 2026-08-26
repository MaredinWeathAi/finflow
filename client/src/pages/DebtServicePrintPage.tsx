import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { formatCurrency } from '@/lib/utils'
import { PrintShell, useAutoPrint } from '@/components/reports/PrintShell'
import { monthLabel, money } from './StatementPrintPage'

/**
 * Debt Service — what the lenders take.
 *
 * Card payments, mortgages, loan payments and auto leases live in four
 * different categories and are never added together anywhere else in the app.
 * Added together they are, for this household, most of the spending.
 */

interface Payee {
  payee: string
  category: string
  total: number
  count: number
  pctOfIncome: number
  byMonth: Record<string, number>
}

interface DebtService {
  period: { start: string; end: string; label: string }
  scope: { allAccounts: boolean; accountNames: string[] }
  coverage: { completeMonths: string[]; partialMonths: string[] }
  monthKeys: string[]
  payees: Payee[]
  totals: {
    debtService: number; income: number; expenses: number
    pctOfIncome: number; pctOfExpenses: number; perMonth: number | null
  }
  completeMonthCount: number
  byMonthTotals: Record<string, number>
  note: string
  data_notes: { note?: string | null } | null
}

/** Long month grids need short labels or the table stops fitting the page. */
function shortMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m - 1]} ${String(y).slice(2)}`
}

export function DebtServicePrintPage() {
  const [params] = useSearchParams()
  const [data, setData] = useState<DebtService | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = params.toString()

  useEffect(() => {
    let off = false
    api.get<DebtService>(`/reports/debt-service?${query}`)
      .then(d => { if (!off) setData(d) })
      .catch(e => { if (!off) setError(e?.message || 'Could not load the report') })
    return () => { off = true }
  }, [query])

  useAutoPrint(!!data)

  if (error) return <div className="stmt"><p style={{ padding: 40 }}>{error}</p></div>
  if (!data) return <div className="stmt"><p style={{ padding: 40 }}>Preparing report…</p></div>

  const { totals, payees, monthKeys } = data
  // A month-by-month grid stops fitting the page somewhere past a year.
  const showGrid = monthKeys.length > 0 && monthKeys.length <= 13

  return (
    <PrintShell
      title="Debt Service"
      period={data.period}
      scopeText={data.scope.allAccounts ? 'All accounts' : data.scope.accountNames.join(', ')}
      coverage={data.coverage}
      notes={data.data_notes?.note}
    >
      <h1>What the lenders take</h1>
      <p className="note">
        Every payment servicing a mortgage, credit card, loan or lease, grouped by who was paid.
        Confirmation numbers and ACH metadata are stripped, so eleven differently-numbered payments
        to one issuer appear as one lender rather than eleven small rows.
      </p>

      <div className="kpis">
        <div className="kpi">
          <span className="k-label">Total debt service</span>
          <span className="k-value bad">{formatCurrency(totals.debtService)}</span>
          {totals.perMonth !== null && (
            <span className="k-sub">{formatCurrency(totals.perMonth)} per month</span>
          )}
        </div>
        <div className="kpi">
          <span className="k-label">Of income</span>
          <span className={'k-value ' + (totals.pctOfIncome > 45 ? 'bad' : '')}>{totals.pctOfIncome.toFixed(1)}%</span>
          <span className="k-sub">of {formatCurrency(totals.income)} earned</span>
        </div>
        <div className="kpi">
          <span className="k-label">Of all spending</span>
          <span className="k-value">{totals.pctOfExpenses.toFixed(1)}%</span>
          <span className="k-sub">of {formatCurrency(totals.expenses)} spent</span>
        </div>
        <div className="kpi">
          <span className="k-label">Lenders</span>
          <span className="k-value">{payees.length}</span>
          <span className="k-sub">{payees.reduce((s, p) => s + p.count, 0)} payments</span>
        </div>
      </div>

      <h2>By lender</h2>
      <table className="data">
        <thead>
          <tr>
            <th>Lender</th>
            <th>Type</th>
            <th className="num">Payments</th>
            <th className="num">Total</th>
            <th className="num">% of income</th>
          </tr>
        </thead>
        <tbody>
          {payees.length === 0 && (
            <tr><td colSpan={5} className="muted">No debt payments in this period.</td></tr>
          )}
          {payees.map((p, i) => (
            <tr key={i}>
              <td className="desc">{p.payee}</td>
              <td>{p.category}</td>
              <td className="num">{p.count}</td>
              <td className="num">{formatCurrency(p.total)}</td>
              <td className="num">{p.pctOfIncome.toFixed(1)}%</td>
            </tr>
          ))}
          <tr className="band-total">
            <td>Total</td>
            <td />
            <td className="num">{payees.reduce((s, p) => s + p.count, 0)}</td>
            <td className="num">{formatCurrency(totals.debtService)}</td>
            <td className="num">{totals.pctOfIncome.toFixed(1)}%</td>
          </tr>
        </tbody>
      </table>

      {showGrid && (
        <>
          <h2>By month</h2>
          <div className="scroller">
            <table className="data compact grid">
              <thead>
                <tr>
                  <th>Lender</th>
                  {monthKeys.map(m => <th key={m} className="num">{shortMonth(m)}</th>)}
                </tr>
              </thead>
              <tbody>
                {payees.map((p, i) => (
                  <tr key={i}>
                    <td className="desc">{p.payee.slice(0, 34)}</td>
                    {monthKeys.map(m => (
                      <td key={m} className="num">{p.byMonth[m] ? formatCurrency(p.byMonth[m]) : '—'}</td>
                    ))}
                  </tr>
                ))}
                <tr className="band-total">
                  <td>Total</td>
                  {monthKeys.map(m => (
                    <td key={m} className="num">{formatCurrency(data.byMonthTotals[m] ?? 0)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      <p className="memo">
        {totals.pctOfIncome > 45
          ? <>Debt service is taking <strong>{totals.pctOfIncome.toFixed(0)}% of income</strong>. Conventional
            underwriting treats anything above 43% as the point where a household has little room to
            absorb a shock.</>
          : <>Debt service is <strong>{totals.pctOfIncome.toFixed(1)}% of income</strong> over this period.</>}
      </p>

      <p className="note"><strong>What this does not show.</strong> {data.note}</p>
    </PrintShell>
  )
}
