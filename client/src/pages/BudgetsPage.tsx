import { useState, useMemo, useEffect } from 'react'
import { format, addMonths, subMonths, startOfMonth } from 'date-fns'
import { ChevronLeft, ChevronRight, Plus, Edit2, Trash2, X, Search } from 'lucide-react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import { cn, formatCurrency } from '@/lib/utils'
import { useBudgets } from '@/hooks/useBudgets'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/shared/PageHeader'
import { toast } from 'sonner'
import type { Budget, Category } from '@/types'

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
            <Pie data={data} cx="50%" cy="50%" innerRadius={80} outerRadius={120} dataKey="value" stroke="none" paddingAngle={2}>
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

function CategoryBudgetRow({ budget, onEdit, onDelete }: { budget: Budget; onEdit: () => void; onDelete: () => void }) {
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
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
        <button onClick={onEdit} className="p-1.5 rounded-lg hover:bg-accent transition-colors">
          <Edit2 className="w-3.5 h-3.5 text-muted-foreground" />
        </button>
        <button onClick={onDelete} className="p-1.5 rounded-lg hover:bg-red-500/10 transition-colors">
          <Trash2 className="w-3.5 h-3.5 text-red-400" />
        </button>
      </div>
    </div>
  )
}

function BudgetModal({
  open,
  onClose,
  budget,
  month,
  existingCategoryIds,
  onSave,
}: {
  open: boolean
  onClose: () => void
  budget: Budget | null
  month: Date
  existingCategoryIds: string[]
  onSave: () => void
}) {
  const [amount, setAmount] = useState('')
  const [rollover, setRollover] = useState(false)
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [categories, setCategories] = useState<Category[]>([])
  const [search, setSearch] = useState('')
  const isEditing = !!budget?.id

  useEffect(() => {
    if (open) {
      if (budget) {
        setAmount(budget.amount?.toString() || '')
        setRollover(!!budget.rollover)
        setSelectedCategory(budget.category_id || '')
      } else {
        setAmount('')
        setRollover(false)
        setSelectedCategory('')
      }
      setSearch('')
      // Fetch categories for the picker
      api.get<Category[]>('/categories').then(setCategories).catch(() => {})
    }
  }, [open, budget])

  // Filter to expense categories not already budgeted (for new budgets)
  const availableCategories = useMemo(() => {
    let cats = categories.filter(c => !c.is_income)
    if (!isEditing) {
      cats = cats.filter(c => !existingCategoryIds.includes(c.id))
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      cats = cats.filter(c => c.name.toLowerCase().includes(q))
    }
    return cats
  }, [categories, existingCategoryIds, isEditing, search])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const parsedAmount = parseFloat(amount)
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error('Enter a valid budget amount')
      return
    }
    if (!isEditing && !selectedCategory) {
      toast.error('Select a category')
      return
    }

    try {
      if (isEditing) {
        await api.put(`/budgets/${budget!.id}`, { amount: parsedAmount, rollover })
        toast.success('Budget updated')
      } else {
        await api.post('/budgets', {
          category_id: selectedCategory,
          month: format(month, 'yyyy-MM-dd'),
          amount: parsedAmount,
          rollover,
        })
        toast.success('Budget created')
      }
      onSave()
      onClose()
    } catch {
      toast.error(isEditing ? 'Failed to update budget' : 'Failed to create budget')
    }
  }

  if (!open) return null

  const selectedCat = categories.find(c => c.id === selectedCategory)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-md p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">
            {isEditing ? `${budget?.category_icon} Edit ${budget?.category_name} Budget` : 'Create New Budget'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Category Picker (only for new budgets) */}
          {!isEditing && (
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Category</label>
              {selectedCat ? (
                <div className="mt-1 flex items-center gap-2 p-2.5 rounded-lg border border-primary/50 bg-primary/5">
                  <span className="text-lg">{selectedCat.icon}</span>
                  <span className="text-sm font-medium flex-1">{selectedCat.name}</span>
                  <button type="button" onClick={() => setSelectedCategory('')} className="p-1 hover:bg-accent rounded">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="relative mt-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="text"
                      value={search}
                      onChange={e => setSearch(e.target.value)}
                      placeholder="Search categories..."
                      className="w-full h-10 rounded-lg border border-input bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-border/50 divide-y divide-border/30">
                    {availableCategories.length === 0 ? (
                      <div className="p-3 text-center text-xs text-muted-foreground">
                        {categories.length === 0 ? 'Loading categories...' : 'All categories already have budgets'}
                      </div>
                    ) : (
                      availableCategories.map(cat => (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => setSelectedCategory(cat.id)}
                          className="w-full flex items-center gap-2.5 p-2.5 text-left hover:bg-accent/50 transition-colors"
                        >
                          <span className="text-lg">{cat.icon}</span>
                          <span className="text-sm">{cat.name}</span>
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Amount */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Monthly Budget Amount</label>
            <div className="relative mt-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full h-10 rounded-lg border border-input bg-background pl-7 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                required
                autoFocus={isEditing}
              />
            </div>
          </div>

          {/* Rollover Toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={rollover}
              onChange={e => setRollover(e.target.checked)}
              className="w-4 h-4 rounded border-input"
            />
            <span className="text-sm">Roll over unused budget to next month</span>
          </label>

          {/* Buttons */}
          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose} className="flex-1 h-10 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!isEditing && !selectedCategory}
              className={cn(
                'flex-1 h-10 rounded-lg text-sm font-medium transition-colors',
                (!isEditing && !selectedCategory)
                  ? 'bg-primary/50 text-primary-foreground/50 cursor-not-allowed'
                  : 'bg-primary text-primary-foreground hover:bg-primary/90'
              )}
            >
              {isEditing ? 'Save Changes' : 'Create Budget'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function DeleteConfirmModal({ open, onClose, budget, onConfirm }: {
  open: boolean; onClose: () => void; budget: Budget | null; onConfirm: () => void
}) {
  if (!open || !budget) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-sm p-6 shadow-xl">
        <h2 className="text-lg font-semibold mb-2">Delete Budget</h2>
        <p className="text-sm text-muted-foreground mb-5">
          Remove the <strong>{budget.category_icon} {budget.category_name}</strong> budget of {formatCurrency(budget.amount)}? This won't delete any transactions.
        </p>
        <div className="flex gap-3">
          <button onClick={onClose} className="flex-1 h-10 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">Cancel</button>
          <button onClick={onConfirm} className="flex-1 h-10 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 transition-colors">Delete</button>
        </div>
      </div>
    </div>
  )
}

export function BudgetsPage() {
  const [month, setMonth] = useState(startOfMonth(new Date()))
  const { budgets, isLoading, totalBudget, totalSpent, remaining, refetch } = useBudgets(month)
  const [modalBudget, setModalBudget] = useState<Budget | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [deleteBudget, setDeleteBudget] = useState<Budget | null>(null)

  const sortedBudgets = useMemo(() =>
    [...budgets].sort((a, b) => {
      const pA = a.amount > 0 ? ((a.spent || 0) / a.amount) : 0
      const pB = b.amount > 0 ? ((b.spent || 0) / b.amount) : 0
      return pB - pA
    }),
    [budgets]
  )

  const existingCategoryIds = useMemo(() => budgets.map(b => b.category_id), [budgets])

  const barData = sortedBudgets.slice(0, 8).map(b => ({
    name: b.category_name?.substring(0, 12) || '',
    spent: b.spent || 0,
    budget: b.amount,
  }))

  const handleCreate = () => {
    setModalBudget(null)
    setShowModal(true)
  }

  const handleEdit = (b: Budget) => {
    setModalBudget(b)
    setShowModal(true)
  }

  const handleDeleteConfirm = async () => {
    if (!deleteBudget) return
    try {
      await api.delete(`/budgets/${deleteBudget.id}`)
      toast.success('Budget deleted')
      refetch()
    } catch {
      toast.error('Failed to delete budget')
    }
    setDeleteBudget(null)
  }

  return (
    <div>
      <PageHeader
        title="Budgets"
        description={`${format(month, 'MMMM yyyy')} budget overview`}
      />

      {/* Month Navigator + Add Button */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-1">
          <button onClick={() => setMonth(m => subMonths(m, 1))} className="p-2 rounded-lg hover:bg-accent transition-colors">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h2 className="text-lg font-semibold w-44 text-center">{format(month, 'MMMM yyyy')}</h2>
          <button onClick={() => setMonth(m => addMonths(m, 1))} className="p-2 rounded-lg hover:bg-accent transition-colors">
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
        <button
          onClick={handleCreate}
          className="flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Budget
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
            <div className="flex items-center justify-between mb-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Category Breakdown</p>
              <span className="text-xs text-muted-foreground">{budgets.length} budgets</span>
            </div>
            {isLoading ? (
              <div className="py-8 text-center text-muted-foreground">Loading...</div>
            ) : sortedBudgets.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-muted-foreground mb-3">No budgets set for this month</p>
                <button
                  onClick={handleCreate}
                  className="inline-flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Create Your First Budget
                </button>
              </div>
            ) : (
              <div className="divide-y divide-border/30">
                {sortedBudgets.map(b => (
                  <CategoryBudgetRow
                    key={b.id}
                    budget={b}
                    onEdit={() => handleEdit(b)}
                    onDelete={() => setDeleteBudget(b)}
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

      {/* Modals */}
      <BudgetModal
        open={showModal}
        onClose={() => { setShowModal(false); setModalBudget(null) }}
        budget={modalBudget}
        month={month}
        existingCategoryIds={existingCategoryIds}
        onSave={refetch}
      />
      <DeleteConfirmModal
        open={!!deleteBudget}
        onClose={() => setDeleteBudget(null)}
        budget={deleteBudget}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  )
}
