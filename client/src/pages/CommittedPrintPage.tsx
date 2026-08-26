import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '@/lib/api'
import { formatCurrency } from '@/lib/utils'
import { PrintShell, useAutoPrint } from '@/components/reports/PrintShell'
import { money } from './StatementPrintPage'

/**
 * Committed vs Discretionary — what is actually cuttable.
 *
 * "Spend less" is only actionable against the part you control. This splits
 * spending three ways and shows the waterfall down from income, so the last
 * number on the page is the one worth arguing about.
 */

type Tier = 'debt' | 'committed' | 'discretionary'

interface Cat {
  name: string; icon: string; tier: Tier
  total: number; txnCount: number
  byMonth: Record<string, number>
}

interface Committed {
  period: { start: string; end: string; label: string }
  scope: { allAccounts: boolean; accountNames: string[] }
  coverage: { completeMonths: string[]; partialMonths: string[] }
  monthKeys: string[]
  categories: Cat[]
  totals: {
    income: number; debt: number; committed: number; discretionary: number
    spending: number; afterDebt: number; afterCommitted: number; net: number
    pctDebt: number; pctCommitted: number; pctDiscretionary: number
  }
  perMonth: { income: number; debt: number; committed: number; discretionary: number } | null
  completeMonthCount: number
  tiers: Record<Tier, string>
  data_notes: { note?: string | null } | null
}

const TIER_TITLES: Record<Tier, string> = {
  debt: 'DEBT SERVICE',
  committed: 'COMMITTED',
  discretionary: 'DISCRETIONARY',
}

export function CommittedPrintPage() {
  const [params] = useSearchParams()
  const [data, setData] = useState<Committed | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = params.toString()

  useEffect(() => {
    let off = false
    api.get<Committed>(`/reports/committed?${query}`)
      .then(d => { if (!off) setData(d) })
      .catch(e => { if (!off) setError(e?.message || 'Could not load the report') })
    return () => { off = true }
  }, [query])

  useAutoPrint(!!data)

  if (error) return <div className="stmt"><p style={{ padding: 40 }}>{error}</p></div>
  if (!data) return <div className="stmt"><p style={{ padding: 40 }}>Preparing report…</p></div>

  const { totals, perMonth } = data
  const tierTotal = (t: Tier) => t === 'debt' ? totals.debt : t === 'committed' ? totals.committed : totals.discretionary

  const bar = (v: number) => Math.max(0, Math.min(100, totals.income > 0 ? (v / totals.income) * 100 : 0))

  return (
    <PrintShell
      title="Committed vs Discretionary"
      period={data.period}
      scopeText={data.scope.allAccounts ? 'All accounts' : data.scope.accountNames.join(', ')}
      coverage={data.coverage}
      notes={data.data_notes?.note}
    >
      <h1>What is actually cuttable</h1>
      <p className="note">
        Advice to "spend less" is only actionable against the part you control. Debt service is
        contractual. Committed spending is real but slow to change. Discretionary is this month's
        decisions — the only tier where a decision today changes next month's number.
      </p>

      <h2>From income down</h2>
      <table className="data waterfall">
        <tbody>
          <tr className="wf-start">
            <td>Income</td>
            <td className="num">{formatCurrency(totals.income)}</td>
            <td className="bar"><span style={{ width: '100%' }} /></td>
            <td className="num">100%</td>
          </tr>
          <tr>
            <td>&minus; Debt service</td>
            <td className="num">{formatCurrency(totals.debt)}</td>
            <td className="bar"><span className="b-debt" style={{ width: bar(totals.debt) + '%' }} /></td>
            <td className="num">{totals.pctDebt.toFixed(1)}%</td>
          </tr>
          <tr className="wf-mid">
            <td>Left after debt</td>
            <td className="num">{money(totals.afterDebt)}</td>
            <td className="bar" /><td />
          </tr>
          <tr>
            <td>&minus; Committed</td>
            <td className="num">{formatCurrency(totals.committed)}</td>
            <td className="bar"><span className="b-comm" style={{ width: bar(totals.committed) + '%' }} /></td>
            <td className="num">{totals.pctCommitted.toFixed(1)}%</td>
          </tr>
          <tr className="wf-mid">
            <td>Left after commitments</td>
            <td className="num">{money(totals.afterCommitted)}</td>
            <td className="bar" /><td />
          </tr>
          <tr>
            <td>&minus; Discretionary</td>
            <td className="num">{formatCurrency(totals.discretionary)}</td>
            <td className="bar"><span className="b-disc" style={{ width: bar(totals.discretionary) + '%' }} /></td>
            <td className="num">{totals.pctDiscretionary.toFixed(1)}%</td>
          </tr>
          <tr className="net-row">
            <td>{totals.net >= 0 ? 'SURPLUS' : 'SHORTFALL'}</td>
            <td className="num">{money(totals.net)}</td>
            <td className="bar" /><td />
          </tr>
        </tbody>
      </table>

      {perMonth && (
        <p className="note">
          Per complete month ({data.completeMonthCount}): income {formatCurrency(perMonth.income)},
          debt {formatCurrency(perMonth.debt)}, committed {formatCurrency(perMonth.committed)},
          discretionary {formatCurrency(perMonth.discretionary)}.
        </p>
      )}

      <p className="memo">
        {totals.discretionary > 0 && totals.net < 0 ? (
          <>Closing a {money(Math.abs(totals.net), { parens: false })} shortfall out of discretionary
          spending alone would mean cutting it by{' '}
          <strong>{Math.min(100, (Math.abs(totals.net) / totals.discretionary) * 100).toFixed(0)}%</strong>
          {Math.abs(totals.net) > totals.discretionary && <> — and even eliminating it entirely would
          not be enough, which puts the answer in the debt and committed tiers</>}.</>
        ) : (
          <>Discretionary spending is {formatCurrency(totals.discretionary)},{' '}
          {totals.pctDiscretionary.toFixed(1)}% of income — the part a decision this month can change.</>
        )}
      </p>

      <div className="section">
        <h1>Every category, by tier</h1>
        {(['debt', 'committed', 'discretionary'] as Tier[]).map(tier => {
          const rows = data.categories.filter(c => c.tier === tier)
          if (rows.length === 0) return null
          const t = tierTotal(tier)
          return (
            <div key={tier} className="cat-block">
              <div className="cat-head">
                <span>{TIER_TITLES[tier]}</span>
                <span>{formatCurrency(t)}</span>
              </div>
              <p className="note tier-note">{data.tiers[tier]}</p>
              <table className="data detail">
                <thead>
                  <tr><th>Category</th><th className="num">Txns</th><th className="num">Total</th><th className="num">% of tier</th><th className="num">% of income</th></tr>
                </thead>
                <tbody>
                  {rows.map(c => (
                    <tr key={c.name}>
                      <td>{c.icon} {c.name}</td>
                      <td className="num">{c.txnCount}</td>
                      <td className="num">{money(c.total)}</td>
                      <td className="num">{t !== 0 ? ((c.total / t) * 100).toFixed(1) + '%' : '—'}</td>
                      <td className="num">{totals.income > 0 ? ((c.total / totals.income) * 100).toFixed(1) + '%' : '—'}</td>
                    </tr>
                  ))}
                  <tr className="cat-total">
                    <td>Subtotal</td>
                    <td className="num">{rows.reduce((s, c) => s + c.txnCount, 0)}</td>
                    <td className="num">{money(t)}</td>
                    <td className="num">100.0%</td>
                    <td className="num">{totals.income > 0 ? ((t / totals.income) * 100).toFixed(1) + '%' : '—'}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )
        })}
        <p className="note">
          <strong>How categories were assigned.</strong> Debt service is mortgages, card payments,
          loan payments and auto leases. Committed covers utilities, insurance, healthcare,
          education, taxes, groceries, transport, kids and subscriptions. Everything else is
          discretionary. Groceries sits in committed and restaurants in discretionary, which is the
          split most people mean even though both are food. Disagree with any of it and the
          category is what to change.
        </p>
      </div>
    </PrintShell>
  )
}
