import { useState } from 'react'
import { format, parseISO, differenceInDays } from 'date-fns'
import { Plus, X, TrendingUp, TrendingDown, Minus, AlertTriangle, Zap, Loader2, Check, Clock } from 'lucide-react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { cn, formatCurrency } from '@/lib/utils'
import { useRecurring } from '@/hooks/useRecurring'
import { useCategories } from '@/hooks/useCategories'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { RecurringExpense } from '@/types'

const freqLabels: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
}

function PriceChangeBadge({ expense }: { expense: RecurringExpense }) {
  const history = expense.price_history || []
  if (history.length < 2) return <Minus className="w-3.5 h-3.5 text-muted-foreground" />

  const prev = history[history.length - 2].amount
  const curr = history[history.length - 1].amount
  if (curr > prev) return <TrendingUp className="w-3.5 h-3.5 text-danger" />
  if (curr < prev) return <TrendingDown className="w-3.5 h-3.5 text-success" />
  return <Minus className="w-3.5 h-3.5 text-muted-foreground" />
}

function RecurringRow({ expense, onEdit }: { expense: RecurringExpense; onEdit: () => void }) {
  const daysUntil = differenceInDays(parseISO(expense.next_date), new Date())
  const isOverdue = daysUntil < 0
  const isDueToday = daysUntil === 0
  const isDueSoon = daysUntil > 0 && daysUntil <= 3
  const hasPriceIncrease = (() => {
    const h = expense.price_history || []
    return h.length >= 2 && h[h.length - 1].amount > h[h.length - 2].amount
  })()

  // Determine the due day of month for display (like Copilot's "1st", "5th", etc.)
  const dueDay = (() => {
    try {
      const d = parseISO(expense.next_date).getDate()
      if (d === 1 || d === 21 || d === 31) return `${d}st`
      if (d === 2 || d === 22) return `${d}nd`
      if (d === 3 || d === 23) return `${d}rd`
      return `${d}th`
    } catch { return '' }
  })()

  return (
    <div
      onClick={onEdit}
      className={cn(
        'flex items-center gap-4 px-5 py-4 hover:bg-accent/30 transition-colors cursor-pointer',
        hasPriceIncrease && 'bg-danger/5',
        isOverdue && 'bg-amber-500/5'
      )}
    >
      {/* Icon with status overlay */}
      <div className="relative w-9 h-9 shrink-0">
        <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-base">
          {expense.category_icon || '🔄'}
        </div>
        {/* Status indicator - top-right corner */}
        {expense.is_active && !isOverdue && daysUntil > 3 && (
          <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center">
            <Check className="w-2.5 h-2.5 text-white" />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{expense.name}</span>
          {hasPriceIncrease && (
            <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-danger/10 text-danger flex items-center gap-0.5">
              <AlertTriangle className="w-3 h-3" /> Price up
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          {freqLabels[expense.frequency]} &middot; {expense.category_name || 'Uncategorized'}
        </p>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <PriceChangeBadge expense={expense} />
        <div className="text-right">
          <p className="text-sm font-bold tabular-nums">{formatCurrency(expense.amount)}</p>
          {isOverdue ? (
            <p className="text-[11px] text-red-400 font-semibold">Overdue</p>
          ) : isDueToday ? (
            <p className="text-[11px] text-amber-400 font-semibold">Due today</p>
          ) : isDueSoon ? (
            <p className="text-[11px] text-amber-400 font-medium">In {daysUntil} day{daysUntil > 1 ? 's' : ''}</p>
          ) : (
            <p className="text-[11px] text-muted-foreground">{dueDay}</p>
          )}
        </div>
        <div
          className={cn(
            'w-2 h-2 rounded-full shrink-0',
            !expense.is_active ? 'bg-muted-foreground' :
            isOverdue ? 'bg-red-400' :
            isDueSoon || isDueToday ? 'bg-amber-400' :
            'bg-success'
          )}
        />
      </div>
    </div>
  )
}

function AddRecurringModal({ open, onClose, expense, categories, onSave }: {
  open: boolean; onClose: () => void; expense: RecurringExpense | null; categories: { id: string; name: string; icon: string }[]; onSave: () => void
}) {
  const [form, setForm] = useState({
    name: expense?.name || '',
    amount: expense?.amount?.toString() || '',
    category_id: expense?.category_id || '',
    frequency: expense?.frequency || 'monthly',
    next_date: expense?.next_date || format(new Date(), 'yyyy-MM-dd'),
    is_active: expense?.is_active ?? true,
    notes: expense?.notes || '',
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const payload = { ...form, amount: parseFloat(form.amount) }
      if (expense) {
        await api.put(`/recurring/${expense.id}`, payload)
        toast.success('Recurring expense updated')
      } else {
        await api.post('/recurring', payload)
        toast.success('Recurring expense added')
      }
      onSave()
      onClose()
    } catch {
      toast.error('Failed to save')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">{expense ? 'Edit' : 'Add'} Recurring Expense</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</label>
              <input type="number" step="0.01" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Frequency</label>
              <select value={form.frequency} onChange={e => setForm(f => ({ ...f, frequency: e.target.value as any }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm">
                {Object.entries(freqLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Category</label>
              <select value={form.category_id} onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm" required>
                <option value="">Select...</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Next Date</label>
              <input type="date" value={form.next_date} onChange={e => setForm(f => ({ ...f, next_date: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} className="w-4 h-4 rounded border-input" />
            <span className="text-sm">Active</span>
          </label>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 h-10 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">Cancel</button>
            <button type="submit" className="flex-1 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">{expense ? 'Update' : 'Add'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function RecurringPage() {
  const { recurring, isLoading, totalMonthly, totalAnnual, refetch } = useRecurring()
  const { categories } = useCategories()
  const [showModal, setShowModal] = useState(false)
  const [editExpense, setEditExpense] = useState<RecurringExpense | null>(null)
  const [isDetecting, setIsDetecting] = useState(false)

  const activeCount = recurring.filter(r => r.is_active).length
  const priceIncreases = recurring.filter(r => {
    const h = r.price_history || []
    return h.length >= 2 && h[h.length - 1].amount > h[h.length - 2].amount
  }).length

  const handleAutoDetect = async () => {
    setIsDetecting(true)
    try {
      const result = await api.post<{
        detected: number; created: number; createdNames: string[];
        deactivated: number; deactivatedNames: string[]
      }>('/recurring/detect')
      if (result.created > 0) {
        toast.success(`Found ${result.created} new recurring expense${result.created > 1 ? 's' : ''}: ${result.createdNames.join(', ')}`)
      } else {
        toast.info('No new recurring patterns detected')
      }
      if (result.deactivated > 0) {
        toast(`${result.deactivated} stale recurring${result.deactivated > 1 ? 's' : ''} deactivated`)
      }
      refetch()
    } catch {
      toast.error('Failed to auto-detect recurring expenses')
    } finally {
      setIsDetecting(false)
    }
  }

  const categoryBreakdown = recurring.reduce((acc, r) => {
    if (!r.is_active) return acc
    const key = r.category_name || 'Other'
    if (!acc[key]) acc[key] = { name: key, value: 0, color: r.category_color || '#A78BFA' }
    acc[key].value += r.amount
    return acc
  }, {} as Record<string, { name: string; value: number; color: string }>)

  const pieData = Object.values(categoryBreakdown)

  const sorted = [...recurring].sort((a, b) => {
    const dA = new Date(a.next_date).getTime()
    const dB = new Date(b.next_date).getTime()
    return dA - dB
  })

  // Split into this month (overdue + due this month) and future
  const now = new Date()
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  const thisMonth = sorted.filter(r => r.is_active && new Date(r.next_date) <= endOfMonth)
  const upcoming = sorted.filter(r => r.is_active && new Date(r.next_date) > endOfMonth)
  const inactive = sorted.filter(r => !r.is_active)

  // Summary: left to pay vs paid so far this month
  const leftToPay = thisMonth
    .filter(r => differenceInDays(parseISO(r.next_date), now) >= 0)
    .reduce((s, r) => s + r.amount, 0)
  const paidSoFar = thisMonth
    .filter(r => differenceInDays(parseISO(r.next_date), now) < 0)
    .reduce((s, r) => s + r.amount, 0)

  return (
    <div>
      <PageHeader
        title="Recurring Expenses"
        description="Track subscriptions, bills, and fixed costs"
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={handleAutoDetect}
              disabled={isDetecting}
              className="flex items-center gap-2 h-9 px-4 rounded-lg bg-amber-500/10 text-amber-400 text-sm font-medium hover:bg-amber-500/20 transition-colors disabled:opacity-50"
            >
              {isDetecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              Auto-Detect
            </button>
            <button
              onClick={() => { setEditExpense(null); setShowModal(true) }}
              className="flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="w-4 h-4" /> Add
            </button>
          </div>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Monthly Total</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(totalMonthly)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Annual Estimate</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(totalAnnual)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Active</p>
          <p className="text-xl font-bold mt-1">{activeCount}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Price Increases</p>
          <p className={cn('text-xl font-bold mt-1', priceIncreases > 0 ? 'text-danger' : 'text-foreground')}>{priceIncreases}</p>
        </div>
      </div>

      {/* Monthly Progress Bar (like Copilot) */}
      {thisMonth.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-2xl font-bold">{formatCurrency(leftToPay)}</p>
              <p className="text-xs text-muted-foreground">left to pay</p>
            </div>
            <div className="w-24 h-24 relative">
              <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" className="text-muted/30" strokeWidth="8" />
                <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" className="text-primary"
                  strokeWidth="8" strokeDasharray={`${(paidSoFar / (paidSoFar + leftToPay || 1)) * 251.2} 251.2`}
                  strokeLinecap="round" />
              </svg>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold">{formatCurrency(paidSoFar)}</p>
              <p className="text-xs text-muted-foreground">paid so far</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* This Month */}
          {isLoading ? (
            <div className="bg-card rounded-2xl border border-border/50 p-8 text-center text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin mx-auto mb-2" /> Loading...
            </div>
          ) : sorted.length === 0 ? (
            <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
              <Clock className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-sm font-medium">No recurring expenses yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Click "Auto-Detect" to scan your transactions, or add one manually.
              </p>
            </div>
          ) : (
            <>
              {thisMonth.length > 0 && (
                <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
                  <div className="px-5 py-3 border-b border-border/30">
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary">This Month</p>
                  </div>
                  <div className="divide-y divide-border/30">
                    {thisMonth.map(r => (
                      <RecurringRow key={r.id} expense={r} onEdit={() => { setEditExpense(r); setShowModal(true) }} />
                    ))}
                  </div>
                </div>
              )}

              {upcoming.length > 0 && (
                <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
                  <div className="px-5 py-3 border-b border-border/30">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Upcoming</p>
                  </div>
                  <div className="divide-y divide-border/30">
                    {upcoming.map(r => (
                      <RecurringRow key={r.id} expense={r} onEdit={() => { setEditExpense(r); setShowModal(true) }} />
                    ))}
                  </div>
                </div>
              )}

              {inactive.length > 0 && (
                <div className="bg-card rounded-2xl border border-border/50 overflow-hidden opacity-60">
                  <div className="px-5 py-3 border-b border-border/30">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Inactive</p>
                  </div>
                  <div className="divide-y divide-border/30">
                    {inactive.map(r => (
                      <RecurringRow key={r.id} expense={r} onEdit={() => { setEditExpense(r); setShowModal(true) }} />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Pie Chart Sidebar */}
        <div>
          <div className="bg-card rounded-2xl border border-border/50 p-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">By Category</p>
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
                        return (
                          <div className="bg-popover border border-border rounded-lg p-2 shadow-lg text-sm">
                            <p className="font-medium">{d.name}</p>
                            <p className="text-muted-foreground">{formatCurrency(d.value)}/mo</p>
                          </div>
                        )
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-8">No data</p>
            )}
            <div className="mt-4 space-y-2">
              {pieData.map(d => (
                <div key={d.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: d.color }} />
                    <span className="text-xs">{d.name}</span>
                  </div>
                  <span className="text-xs font-medium tabular-nums">{formatCurrency(d.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <AddRecurringModal
        open={showModal}
        onClose={() => { setShowModal(false); setEditExpense(null) }}
        expense={editExpense}
        categories={categories.map(c => ({ id: c.id, name: c.name, icon: c.icon }))}
        onSave={refetch}
      />
    </div>
  )
}
