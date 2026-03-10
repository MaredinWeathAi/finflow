import { useState } from 'react'
import { Plus, X, Target, PartyPopper } from 'lucide-react'
import { differenceInDays, parseISO, format } from 'date-fns'
import { cn, formatCurrency } from '@/lib/utils'
import { useGoals } from '@/hooks/useGoals'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { Goal } from '@/types'

function GoalCard({ goal, onContribute, onEdit }: {
  goal: Goal; onContribute: () => void; onEdit: () => void
}) {
  const percent = goal.target_amount > 0 ? (goal.current_amount / goal.target_amount) * 100 : 0
  const daysLeft = goal.target_date ? differenceInDays(parseISO(goal.target_date), new Date()) : null

  return (
    <div
      onClick={onEdit}
      className={cn(
        'bg-card rounded-2xl border border-border/50 p-5 hover:border-border transition-colors cursor-pointer',
        goal.is_completed && 'bg-success/5 border-success/20'
      )}
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center text-xl" style={{ backgroundColor: `${goal.color}20` }}>
            {goal.icon}
          </div>
          <div>
            <h3 className="text-sm font-semibold">{goal.name}</h3>
            {goal.target_date && (
              <p className="text-xs text-muted-foreground">
                {goal.is_completed ? 'Completed!' : daysLeft !== null && daysLeft > 0 ? `${daysLeft} days left` : 'Past due'}
              </p>
            )}
          </div>
        </div>
        {goal.is_completed && <PartyPopper className="w-5 h-5 text-success" />}
      </div>

      {/* Progress Ring - simplified as bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-muted-foreground">{percent.toFixed(0)}% complete</span>
          <span className="text-xs font-medium tabular-nums">
            {formatCurrency(goal.current_amount)} / {formatCurrency(goal.target_amount)}
          </span>
        </div>
        <div className="h-3 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{
              width: `${Math.min(percent, 100)}%`,
              backgroundColor: goal.color,
            }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {formatCurrency(goal.target_amount - goal.current_amount)} remaining
        </span>
        {!goal.is_completed && (
          <button
            onClick={e => { e.stopPropagation(); onContribute() }}
            className="text-xs font-medium px-3 py-1.5 rounded-lg hover:bg-accent transition-colors"
            style={{ color: goal.color }}
          >
            + Contribute
          </button>
        )}
      </div>
    </div>
  )
}

function ContributeModal({ open, onClose, goal, onSave }: {
  open: boolean; onClose: () => void; goal: Goal | null; onSave: () => void
}) {
  const [amount, setAmount] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!goal) return
    try {
      await api.post(`/goals/${goal.id}/contribute`, { amount: parseFloat(amount) })
      toast.success(`${formatCurrency(parseFloat(amount))} added to ${goal.name}`)
      onSave()
      onClose()
      setAmount('')
    } catch { toast.error('Failed to contribute') }
  }

  if (!open || !goal) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-sm p-6 shadow-xl">
        <h2 className="text-lg font-semibold mb-4">{goal.icon} Contribute to {goal.name}</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</label>
            <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required autoFocus />
          </div>
          <div className="flex gap-3">
            <button type="button" onClick={onClose} className="flex-1 h-10 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">Cancel</button>
            <button type="submit" className="flex-1 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">Contribute</button>
          </div>
        </form>
      </div>
    </div>
  )
}

function AddGoalModal({ open, onClose, goal, onSave }: {
  open: boolean; onClose: () => void; goal: Goal | null; onSave: () => void
}) {
  const [form, setForm] = useState({
    name: goal?.name || '',
    target_amount: goal?.target_amount?.toString() || '',
    current_amount: goal?.current_amount?.toString() || '0',
    target_date: goal?.target_date || '',
    icon: goal?.icon || '🎯',
    color: goal?.color || '#A78BFA',
  })

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const payload = {
        ...form,
        target_amount: parseFloat(form.target_amount),
        current_amount: parseFloat(form.current_amount),
        target_date: form.target_date || null,
      }
      if (goal) {
        await api.put(`/goals/${goal.id}`, payload)
        toast.success('Goal updated')
      } else {
        await api.post('/goals', payload)
        toast.success('Goal created')
      }
      onSave()
      onClose()
    } catch { toast.error('Failed to save') }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">{goal ? 'Edit' : 'New'} Goal</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-4 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Icon</label>
              <input value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-center text-lg focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div className="col-span-3">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Target Amount</label>
              <input type="number" step="0.01" value={form.target_amount} onChange={e => setForm(f => ({ ...f, target_amount: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Target Date</label>
              <input type="date" value={form.target_date} onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Color</label>
            <input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background cursor-pointer" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="flex-1 h-10 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">Cancel</button>
            <button type="submit" className="flex-1 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">{goal ? 'Update' : 'Create'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

const goalTemplates = [
  { name: 'Emergency Fund', icon: '🛟', color: '#34D399', target: 15000 },
  { name: 'Vacation', icon: '✈️', color: '#60A5FA', target: 5000 },
  { name: 'Down Payment', icon: '🏠', color: '#A78BFA', target: 50000 },
  { name: 'New Car', icon: '🚗', color: '#FB923C', target: 30000 },
]

export function GoalsPage() {
  const { goals, isLoading, refetch } = useGoals()
  const [showAdd, setShowAdd] = useState(false)
  const [editGoal, setEditGoal] = useState<Goal | null>(null)
  const [contributeGoal, setContributeGoal] = useState<Goal | null>(null)

  const active = goals.filter(g => !g.is_completed)
  const completed = goals.filter(g => g.is_completed)

  return (
    <div>
      <PageHeader
        title="Goals"
        description="Track your savings goals"
        action={
          <button onClick={() => { setEditGoal(null); setShowAdd(true) }} className="flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
            <Plus className="w-4 h-4" /> New Goal
          </button>
        }
      />

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Loading...</div>
      ) : goals.length === 0 ? (
        <div className="text-center py-16">
          <Target className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Set your first goal</h3>
          <p className="text-sm text-muted-foreground mb-6 max-w-sm mx-auto">Start tracking progress toward your financial goals</p>
          <div className="flex flex-wrap justify-center gap-2">
            {goalTemplates.map(t => (
              <button
                key={t.name}
                onClick={() => { setEditGoal(null); setShowAdd(true) }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-card border border-border/50 hover:border-border text-sm transition-colors"
              >
                {t.icon} {t.name}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Active Goals */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
            {active.map(g => (
              <GoalCard
                key={g.id}
                goal={g}
                onContribute={() => setContributeGoal(g)}
                onEdit={() => { setEditGoal(g); setShowAdd(true) }}
              />
            ))}
          </div>

          {/* Completed */}
          {completed.length > 0 && (
            <>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Completed</h3>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {completed.map(g => (
                  <GoalCard
                    key={g.id}
                    goal={g}
                    onContribute={() => {}}
                    onEdit={() => { setEditGoal(g); setShowAdd(true) }}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      <AddGoalModal open={showAdd} onClose={() => { setShowAdd(false); setEditGoal(null) }} goal={editGoal} onSave={refetch} />
      <ContributeModal open={!!contributeGoal} onClose={() => setContributeGoal(null)} goal={contributeGoal} onSave={refetch} />
    </div>
  )
}
