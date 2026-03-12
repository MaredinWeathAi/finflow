import { useState } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts'
import { Plus, X, TrendingUp, TrendingDown } from 'lucide-react'
import { cn, formatCurrency, formatPercent } from '@/lib/utils'
import { useInvestments } from '@/hooks/useInvestments'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { Investment } from '@/types'

const typeColors: Record<string, string> = {
  stock: '#A78BFA',
  etf: '#60A5FA',
  mutual_fund: '#34D399',
  crypto: '#FB923C',
  bond: '#64748B',
  other: '#EC4899',
}

const typeLabels: Record<string, string> = {
  stock: 'Stock',
  etf: 'ETF',
  mutual_fund: 'Mutual Fund',
  crypto: 'Crypto',
  bond: 'Bond',
  other: 'Other',
}

function HoldingRow({ investment }: { investment: Investment }) {
  const value = investment.current_value || investment.shares * investment.current_price
  const gainLoss = investment.gain_loss ?? (value - investment.cost_basis)
  const gainPct = investment.gain_loss_percent ?? (investment.cost_basis > 0 ? (gainLoss / investment.cost_basis) * 100 : 0)
  const isPositive = gainLoss >= 0

  return (
    <div className="flex items-center gap-4 px-5 py-3.5 hover:bg-accent/20 transition-colors">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold shrink-0" style={{ backgroundColor: `${typeColors[investment.type]}20`, color: typeColors[investment.type] }}>
        {investment.symbol.substring(0, 3)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{investment.symbol}</span>
          <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
            {typeLabels[investment.type]}
          </span>
        </div>
        <p className="text-xs text-muted-foreground truncate">{investment.name}</p>
      </div>
      <div className="text-right shrink-0">
        <p className="text-xs text-muted-foreground">{investment.shares} shares</p>
      </div>
      <div className="text-right shrink-0 w-24">
        <p className="text-sm font-bold tabular-nums">{formatCurrency(value)}</p>
        <p className="text-xs text-muted-foreground">Cost: {formatCurrency(investment.cost_basis)}</p>
      </div>
      <div className={cn('text-right shrink-0 w-24 flex items-center gap-1 justify-end', isPositive ? 'text-success' : 'text-danger')}>
        {isPositive ? <TrendingUp className="w-3.5 h-3.5" /> : <TrendingDown className="w-3.5 h-3.5" />}
        <div>
          <p className="text-sm font-semibold tabular-nums">{isPositive ? '+' : ''}{formatCurrency(gainLoss)}</p>
          <p className="text-xs tabular-nums">{formatPercent(gainPct)}</p>
        </div>
      </div>
    </div>
  )
}

function AddInvestmentModal({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: () => void }) {
  const [form, setForm] = useState({
    symbol: '', name: '', type: 'stock', shares: '', cost_basis: '', current_price: '', account_id: '',
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await api.post('/investments', {
        ...form,
        shares: parseFloat(form.shares),
        cost_basis: parseFloat(form.cost_basis),
        current_price: parseFloat(form.current_price),
      })
      toast.success('Investment added')
      onSave()
      onClose()
    } catch { toast.error('Failed to add') }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">Add Investment</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Symbol</label>
              <input value={form.symbol} onChange={e => setForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm">
                {Object.entries(typeLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Shares</label>
              <input type="number" step="any" value={form.shares} onChange={e => setForm(f => ({ ...f, shares: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Cost Basis</label>
              <input type="number" step="0.01" value={form.cost_basis} onChange={e => setForm(f => ({ ...f, cost_basis: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Current Price</label>
              <input type="number" step="0.01" value={form.current_price} onChange={e => setForm(f => ({ ...f, current_price: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 h-10 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">Cancel</button>
            <button type="submit" className="flex-1 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">Add</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function InvestmentsPage() {
  const { investments, isLoading, totalValue, totalCostBasis, totalGainLoss, totalGainLossPercent, refetch } = useInvestments()
  const [showModal, setShowModal] = useState(false)

  const allocationByType = investments.reduce((acc, inv) => {
    const val = inv.current_value || inv.shares * inv.current_price
    if (!acc[inv.type]) acc[inv.type] = { name: typeLabels[inv.type], value: 0, color: typeColors[inv.type] }
    acc[inv.type].value += val
    return acc
  }, {} as Record<string, { name: string; value: number; color: string }>)

  const pieData = Object.values(allocationByType)

  return (
    <div>
      <PageHeader
        title="Investments"
        description="Portfolio tracking and performance"
        action={
          <button onClick={() => setShowModal(true)} className="flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
            <Plus className="w-4 h-4" /> Add Holding
          </button>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Portfolio Value</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(totalValue)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cost Basis</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(totalCostBasis)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Return</p>
          <p className={cn('text-xl font-bold mt-1', totalGainLoss >= 0 ? 'text-success' : 'text-danger')}>
            {totalGainLoss >= 0 ? '+' : ''}{formatCurrency(totalGainLoss)}
          </p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Return %</p>
          <p className={cn('text-xl font-bold mt-1', totalGainLossPercent >= 0 ? 'text-success' : 'text-danger')}>
            {formatPercent(totalGainLossPercent)}
          </p>
        </div>
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Holdings Table */}
        <div className="lg:col-span-2">
          <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
            <div className="px-5 py-3 border-b border-border/30">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Holdings</p>
            </div>
            {isLoading ? (
              <div className="p-8 text-center text-muted-foreground">Loading...</div>
            ) : investments.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">No investments yet</div>
            ) : (
              <div className="divide-y divide-border/30">
                {investments.map(inv => <HoldingRow key={inv.id} investment={inv} />)}
              </div>
            )}
          </div>
        </div>

        {/* Allocation Chart */}
        <div>
          <div className="bg-card rounded-2xl border border-border/50 p-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Asset Allocation</p>
            {pieData.length > 0 ? (
              <div style={{ height: 220 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={pieData} cx="50%" cy="50%" outerRadius={90} dataKey="value" stroke="none" paddingAngle={2}>
                      {pieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                    </Pie>
                    <Tooltip
                      content={({ payload }) => {
                        if (!payload?.[0]) return null
                        const d = payload[0].payload
                        const pct = totalValue > 0 ? (d.value / totalValue * 100).toFixed(1) : 0
                        return (
                          <div className="bg-popover border border-border rounded-lg p-2 shadow-lg text-sm">
                            <p className="font-medium">{d.name}</p>
                            <p className="text-muted-foreground">{formatCurrency(d.value)} ({pct}%)</p>
                          </div>
                        )
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : null}
            <div className="mt-4 space-y-3">
              {pieData.map(d => {
                const pct = totalValue > 0 ? (d.value / totalValue * 100) : 0
                return (
                  <div key={d.name}>
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: d.color }} />
                        <span className="text-xs font-medium">{d.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{formatCurrency(d.value)}</span>
                        <span className="text-xs font-semibold tabular-nums w-12 text-right">{pct.toFixed(1)}%</span>
                      </div>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{ width: `${pct}%`, backgroundColor: d.color }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <AddInvestmentModal open={showModal} onClose={() => setShowModal(false)} onSave={refetch} />
    </div>
  )
}
