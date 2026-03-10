import { useState, useMemo } from 'react'
import { format, addMonths, subMonths, startOfMonth } from 'date-fns'
import { ChevronLeft, ChevronRight, Plus, Edit2, X } from 'lucide-react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import { cn, formatCurrency } from '@/lib/utils'
import { useBudgets } from '@/hooks/useBudgets'
import { useCategories } from '@/hooks/useCategories'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/shared/PageHeader'
import { toast } from 'sonner'
import type { Budget } from '@/types'

function BudgetDonut({ budgets }: { budgets: Budget[] }) {
  const data = budgets
    .filter(b => b.amount > 0)
    .map(b => ({
      name: b.category_name || 'Unknown',
      value: b.spent || 0,
      budget: b.amount,
      color: b.category_color || '#A78BFA',
      icon: b.category_icon || '📊',
    }))

  const totalSpent = data.reduce((s, d) => s + d.value, 0)
  const totalBudget = data.reduce((s, d) => s + d.budget, 0)

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Budget Overview</p>
      <div className="relative" style={{ height: 'clamp(220px, 25vw, 280px)' }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={80}
              outerRadius={120}
              dataKey="value"
              stroke="none"
              paddingAngle={2}
            >
              {data.map((entry, i) => (
                <Cell key={i} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              content={({ payload }) => {
                if (!payload?.[0]) return null
                const d = payload[0].payload
                return (
                  <div className="bg-popover border border-border rounded-lg p-3 shadow-lg text-sm">
                    <p className="font-medium">{d.icon} {d.name}</p>
                    <p className="text-muted-foreground">{formatCurrency(d.value)} / {formatCurrency(d.budget)}</p>
                  </div>
                )
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <p className="text-2xl font-bold">{formatCurrency(totalSpent)}</p>
          <p className="text-xs text-muted-foreground">of {formatCurrency(totalBudget)}</p>
        </div>
      </div>
    </div>
  )
}

function CategoryBudgetRow({ budget, onEdit }: { budget: Budget; onEdit: () => void }) {
  const spent = budget.spent || 0
  const percent = budget.amount > 0 ? (spent / budget.amount) * 100 : 0
  const remaining = budget.amount - spent
  const isOver = remaining < 0

  return (
    <div className="flex items-center gap-4 py-3 px-1 group">
      <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-base shrink-0">
        {budget.category_icon || '📊'}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-sm font-medium">{budget.category_name}</span>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">{budget.transaction_count || 0} txns</span>
            <span className="text-sm font-semibold tabular-nums">
              {formatCurrency(spent)} <span className="text-muted-foreground font-normal">/ {formatCurrency(budget.amount)}</span>
            </span>
          </div>
        </div>
        <div className="relative h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              'absolute inset-y-0 left-0 rounded-full transition-all duration-700',
              percent > 100 ? 'bg-danger' : percent > 80 ? 'bg-warning' : 'bg-success'
            )}
            style={{ width: `${Math.min(percent, 100)}%` }}
          />
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-[11px] text-muted-foreground">{percent.toFixed(0)}% used</span>
          <span className={cn('text-[11px] font-medium', isOver ? 'text-danger' : 'text-success')}>
            {isOver ? `${formatCurrency(Math.abs(remaining))} over` : `${formatCurrency(remaining)} left`}
          </span>
        </div>
      </div>
      <button
        onClick={onEdit}
        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-accent transition-all"
      >
        <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
      </button>
    </div>
  )
}

function EditBudgetModal({
  open,
  onClose,
  budget,
  onSave,
}: {
  open: boolean
  onClose: () => void
  budget: Budget | null
  onSave: () => void
}) {
  const [amount, setAmount] = useState(budget?.amount?.toString() || '')
  const [rollover, setRollover] = useState(budget?.rollover || false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      if (budget?.id) {
        await api.put(`/budgets/${budget.id}`, { amount: parseFloat(amount), rollover })
      }
      toast.success('Budget updated')
      onSave()
      onClose()
    } catch {
      toast.error('Failed to update budget')
    }
  }

  if (!open || !budget) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-sm p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">{budget.category_icon} {budget.category_name}</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Monthly Budget</label>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              required
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={rollover}
              onChange={e => setRollover(e.target.checked)}
              className="w-4 h-4 rounded border-input"
            />
            <span className="text-sm">Roll over unused budget</span>
          </label>
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="flex-1 h-10 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">Cancel</button>
            <button type="submit" className="flex-1 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">Save</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function BudgetsPage() {
  const [month, setMonth] = useState(startOfMonth(new Date()))
  const { budgets, isLoading, totalBudget, totalSpent, remaining, refetch } = useBudgets(month)
  const [editBudget, setEditBudget] = useState<Budget | null>(null)

  const sortedBudgets = useMemo(() =>
    [...budgets].sort((a, b) => {
      const pA = a.amount > 0 ? ((a.spent || 0) / a.amount) : 0
      const pB = b.amount > 0 ? ((b.spent || 0) / b.amount) : 0
      return pB - pA
    }),
    [budgets]
  )

  const barData = sortedBudgets.slice(0, 8).map(b => ({
    name: b.category_name?.substring(0, 12) || '',
    spent: b.spent || 0,
    budget: b.amount,
  }))

  return (
    <div>
      <PageHeader
        title="Budgets"
        description={`${format(month, 'MMMM yyyy')} budget overview`}
      />

      {/* Month Navigator */}
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => setMonth(m => subMonths(m, 1))}
          className="p-2 rounded-lg hover:bg-accent transition-colors"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold">{format(month, 'MMMM yyyy')}</h2>
        <button
          onClick={() => setMonth(m => addMonths(m, 1))}
          className="p-2 rounded-lg hover:bg-accent transition-colors"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Budget</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(totalBudget)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Spent</p>
          <p className="text-xl font-bold mt-1 text-danger">{formatCurrency(totalSpent)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Remaining</p>
          <p className={cn('text-xl font-bold mt-1', remaining >= 0 ? 'text-success' : 'text-danger')}>
            {formatCurrency(remaining)}
          </p>
        </div>
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* Donut Chart */}
        <div className="lg:col-span-2">
          <BudgetDonut budgets={budgets} />
        </div>

        {/* Category Breakdown */}
        <div className="lg:col-span-3">
          <div className="bg-card rounded-2xl border border-border/50 p-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Category Breakdown</p>
            {isLoading ? (
              <div className="py-8 text-center text-muted-foreground">Loading...</div>
            ) : sortedBudgets.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">No budgets set for this month</div>
            ) : (
              <div className="divide-y divide-border/30">
                {sortedBudgets.map(b => (
                  <CategoryBudgetRow
                    key={b.id}
                    budget={b}
                    onEdit={() => setEditBudget(b)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Budget vs Actual Bar Chart */}
      {barData.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 p-6 mt-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Budget vs Actual</p>
          <div style={{ height: 'clamp(220px, 25vw, 300px)' }}>
            <ResponsiveContainer>
              <BarChart data={barData} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(240 10% 18%)" />
                <XAxis dataKey="name" tick={{ fill: 'hsl(240 5% 55%)', fontSize: 11 }} />
                <YAxis tick={{ fill: 'hsl(240 5% 55%)', fontSize: 11 }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: 'hsl(240 25% 9%)',
                    border: '1px solid hsl(240 10% 18%)',
                    borderRadius: 8,
                  }}
                  formatter={(value: number) => formatCurrency(value)}
                />
                <Bar dataKey="budget" fill="#60A5FA" radius={[4, 4, 0, 0]} name="Budget" />
                <Bar dataKey="spent" fill="#A78BFA" radius={[4, 4, 0, 0]} name="Spent" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <EditBudgetModal
        open={!!editBudget}
        onClose={() => setEditBudget(null)}
        budget={editBudget}
        onSave={refetch}
      />
    </div>
  )
}
