import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { formatCurrency } from '@/lib/utils'
import { PrintShell, useAutoPrint } from '@/components/reports/PrintShell'
import { monthLabel, money } from './StatementPrintPage'

/**
 * Cash Flow & Deficit Funding — a sources-and-uses statement.
 *
 * The question it answers is the one a bank statement cannot: when you spent
 * more than you earned, where did the money come from? A month funded by
 * selling a car looks identical to a balanced month on any other view.
 */

interface MonthRow {
  month: string
  income: number
  expenses: number
  net: number
  cumulative: number
  funding: Record<string, number>
  fundingTotal: number
}

interface Funding {
  period: { start: string; end: string; label: string }
  scope: { allAccounts: boolean; accountNames: string[] }
  coverage: { completeMonths: string[]; partialMonths: string[] }
  sourceLabels: string[]
  months: MonthRow[]
  totals: {
    income: number; expenses: number; net: number
    fundingTotal: number; funding: Record<string, number>
  }
  deficitMonths: number
  monthCount: number
  circulation: { in: number; out: number; txnCount: number }
  avgMonthlyNet: number | null
  completeMonthCount: number
  data_notes: { note?: string | null } | null
}

export function FundingPrintPage() {
  const [params] = useSearchParams()
  const [data, setData] = useState<Funding | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = params.toString()

  useEffect(() => {
    let off = false
    api.get<Funding>(`/reports/funding?${query}`)
      .then(d => { if (!off) setData(d) })
      .catch(e => { if (!off) setError(e?.message || 'Could not load the report') })
    return () => { off = true }
  }, [query])

  useAutoPrint(!!data)

  if (error) return <div className="stmt"><p style={{ padding: 40 }}>{error}</p></div>
  if (!data) return <div className="stmt"><p style={{ padding: 40 }}>Preparing report…</p></div>

  const { totals, months, sourceLabels } = data
  const cols = 5 + sourceLabels.length
  const finalCumulative = months.length ? months[months.length - 1].cumulative : 0

  return (
    <PrintShell
      title="Cash Flow &amp; Deficit Funding"
      period={data.period}
      scopeText={data.scope.allAccounts ? 'All accounts' : data.scope.accountNames.join(', ')}
      coverage={data.coverage}
      notes={data.data_notes?.note}
    >
      <h1>What the household earned, spent, and covered the difference with</h1>
      <p className="note">
        Income and expenses are what was actually earned and spent. Everything to the right of the
        NET column is money that arrived <em>without being earned</em> — selling something you owned,
        borrowing, or drawing from savings and investments. It closes the gap in a bank balance,
        but it is finite, and it is not a raise.
      </p>

      <div className="kpis">
        <div className="kpi">
          <span className="k-label">Operating result</span>
          <span className={'k-value ' + (totals.net < 0 ? 'bad' : 'good')}>{money(totals.net)}</span>
          <span className="k-sub">{totals.income >= 0 ? `${money(totals.income)} in, ${money(totals.expenses)} out` : ''}</span>
        </div>
        {data.avgMonthlyNet !== null && (
          <div className="kpi">
            <span className="k-label">Per month</span>
            <span className={'k-value ' + (data.avgMonthlyNet < 0 ? 'bad' : 'good')}>{money(data.avgMonthlyNet)}</span>
            <span className="k-sub">over {data.completeMonthCount} complete month{data.completeMonthCount === 1 ? '' : 's'}</span>
          </div>
        )}
        <div className="kpi">
          <span className="k-label">Months in deficit</span>
          <span className="k-value">{data.deficitMonths} of {data.monthCount}</span>
          <span className="k-sub">spent more than earned</span>
        </div>
        <div className="kpi">
          <span className="k-label">Funded from</span>
          <span className="k-value">{money(totals.fundingTotal)}</span>
          <span className="k-sub">sales, borrowing, savings</span>
        </div>
      </div>

      <h2>Month by month</h2>
      <table className="data">
        <thead>
          <tr>
            <th>Month</th>
            <th className="num">Income</th>
            <th className="num">Expenses</th>
            <th className="num">Net</th>
            {sourceLabels.map(l => <th key={l} className="num">{l}</th>)}
            <th className="num">Cumulative</th>
          </tr>
        </thead>
        <tbody>
          {months.map(m => (
            <tr key={m.month}>
              <td>{monthLabel(m.month)}</td>
              <td className="num">{formatCurrency(m.income)}</td>
              <td className="num">{formatCurrency(m.expenses)}</td>
              <td className={'num ' + (m.net < 0 ? 'up' : 'down')}>{money(m.net)}</td>
              {sourceLabels.map(l => (
                <td key={l} className="num">{m.funding[l] ? formatCurrency(m.funding[l]) : '—'}</td>
              ))}
              <td className={'num ' + (m.cumulative < 0 ? 'up' : 'down')}>{money(m.cumulative)}</td>
            </tr>
          ))}
          <tr className="band-total">
            <td>Total</td>
            <td className="num">{formatCurrency(totals.income)}</td>
            <td className="num">{formatCurrency(totals.expenses)}</td>
            <td className={'num ' + (totals.net < 0 ? 'up' : 'down')}>{money(totals.net)}</td>
            {sourceLabels.map(l => <td key={l} className="num">{formatCurrency(totals.funding[l] ?? 0)}</td>)}
            <td className={'num ' + (finalCumulative < 0 ? 'up' : 'down')}>{money(finalCumulative)}</td>
          </tr>
        </tbody>
      </table>

      <h2>Where the money came from</h2>
      <p className="note">
        Money that only moved between your own accounts is excluded — its outgoing leg is already
        in the Expenses column's sibling, so counting the arrival as funding would double it.
      </p>
      <table className="data compact">
        <thead><tr><th>Source</th><th className="num">Total</th><th className="num">Share</th></tr></thead>
        <tbody>
          {sourceLabels.map(l => (
            <tr key={l}>
              <td>{l}</td>
              <td className="num">{formatCurrency(totals.funding[l] ?? 0)}</td>
              <td className="num">
                {totals.fundingTotal > 0
                  ? (((totals.funding[l] ?? 0) / totals.fundingTotal) * 100).toFixed(1) + '%'
                  : '—'}
              </td>
            </tr>
          ))}
          <tr className="band-total">
            <td>Total brought in</td>
            <td className="num">{formatCurrency(totals.fundingTotal)}</td>
            <td className="num">100.0%</td>
          </tr>
        </tbody>
      </table>

      {data.circulation.txnCount > 0 && (
        <p className="note">
          Separately, {formatCurrency(data.circulation.in)} moved in and{' '}
          {formatCurrency(data.circulation.out)} moved out across{' '}
          {data.circulation.txnCount.toLocaleString()} transfers between accounts you already own.
          That is circulation, not funding, and it is deliberately not in the table above.
        </p>
      )}

      {totals.net < 0 && (
        <p className="memo">
          Over this period the household spent <strong>{money(Math.abs(totals.net), { parens: false })}</strong>{' '}
          more than it earned{data.avgMonthlyNet !== null && <> — about {money(Math.abs(data.avgMonthlyNet), { parens: false })} a month</>}.
          {totals.fundingTotal > 0 && <> That was covered by {money(totals.fundingTotal, { parens: false })} moved
          in from asset sales, borrowing and savings.</>} A bank balance that holds steady on that basis
          is not the same as breaking even.
        </p>
      )}
      {totals.net >= 0 && (
        <p className="memo">
          The household earned <strong>{money(totals.net, { parens: false })}</strong> more than it spent
          over this period. Money moved in from other accounts is shown separately above and is not
          part of that figure.
        </p>
      )}
    </PrintShell>
  )
}
