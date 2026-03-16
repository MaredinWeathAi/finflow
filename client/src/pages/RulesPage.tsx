import { useState, useEffect } from 'react'
import { Plus, X, Trash2, Play, TestTube2, Zap, GripVertical, ToggleLeft, ToggleRight, ChevronDown, ChevronUp } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { useCategories } from '@/hooks/useCategories'
import { useAccounts } from '@/hooks/useAccounts'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { Category } from '@/types'

interface Rule {
  id: string
  name: string
  pattern: string
  match_type: string
  category_id: string
  category_name?: string
  category_icon?: string
  category_color?: string
  account_id?: string
  account_name?: string
  amount_min?: number
  amount_max?: number
  amount_exact?: number
  assign_account_id?: string
  assign_account_name?: string
  assign_type?: string
  is_enabled: number
  priority: number
  description: string
  created_at: string
}

interface TestMatch {
  id: string
  name: string
  amount: number
  date: string
  category_name?: string
  account_name?: string
}

const matchTypeLabels: Record<string, string> = {
  contains: 'Contains',
  exact: 'Exact match',
  starts_with: 'Starts with',
  ends_with: 'Ends with',
}

function RuleCard({
  rule,
  onEdit,
  onToggle,
  onDelete,
}: {
  rule: Rule
  onEdit: () => void
  onToggle: () => void
  onDelete: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)

  const conditions: string[] = []
  if (rule.pattern) {
    conditions.push(`Name ${matchTypeLabels[rule.match_type]?.toLowerCase() || 'contains'} "${rule.pattern}"`)
  }
  if (rule.amount_exact != null) {
    conditions.push(`Amount = ${formatCurrency(rule.amount_exact)}`)
  }
  if (rule.amount_min != null && rule.amount_max != null) {
    conditions.push(`Amount ${formatCurrency(rule.amount_min)} – ${formatCurrency(rule.amount_max)}`)
  } else if (rule.amount_min != null) {
    conditions.push(`Amount >= ${formatCurrency(rule.amount_min)}`)
  } else if (rule.amount_max != null) {
    conditions.push(`Amount <= ${formatCurrency(rule.amount_max)}`)
  }
  if (rule.account_name) {
    conditions.push(`From: ${rule.account_name}`)
  }

  return (
    <div
      className={cn(
        'flex items-start gap-3 p-4 rounded-xl transition-colors border border-transparent',
        rule.is_enabled ? 'hover:bg-accent/30 cursor-pointer' : 'opacity-50 hover:opacity-70 cursor-pointer'
      )}
      onClick={onEdit}
    >
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <button
          onClick={e => { e.stopPropagation(); onToggle() }}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title={rule.is_enabled ? 'Disable rule' : 'Enable rule'}
        >
          {rule.is_enabled ? (
            <ToggleRight className="w-5 h-5 text-success" />
          ) : (
            <ToggleLeft className="w-5 h-5" />
          )}
        </button>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-medium">{rule.name || rule.pattern || 'Unnamed rule'}</span>
          {rule.priority > 0 && (
            <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-warning/10 text-warning">
              Priority {rule.priority}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
          {conditions.map((c, i) => (
            <span
              key={i}
              className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground"
            >
              {c}
            </span>
          ))}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Assign to:</span>
          {rule.category_name && (
            <span
              className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full"
              style={{
                backgroundColor: `${rule.category_color}15`,
                color: rule.category_color,
              }}
            >
              {rule.category_icon} {rule.category_name}
            </span>
          )}
          {rule.assign_type && (
            <span className={cn(
              'text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full',
              rule.assign_type === 'income' ? 'bg-emerald-500/15 text-emerald-400' :
              rule.assign_type === 'expense' ? 'bg-red-500/15 text-red-400' :
              'bg-blue-500/15 text-blue-400'
            )}>
              Treat as {rule.assign_type}
            </span>
          )}
        </div>

        {rule.description && (
          <p className="text-xs text-muted-foreground mt-1">{rule.description}</p>
        )}
      </div>

      <button
        onClick={e => {
          e.stopPropagation()
          if (!confirmDelete) {
            setConfirmDelete(true)
            setTimeout(() => setConfirmDelete(false), 3000)
          } else {
            onDelete()
          }
        }}
        className={cn(
          'p-1.5 rounded-lg transition-colors shrink-0',
          confirmDelete ? 'bg-red-600 text-white' : 'text-muted-foreground hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950'
        )}
      >
        <Trash2 className="w-4 h-4" />
      </button>
    </div>
  )
}

function RuleModal({
  open,
  onClose,
  rule,
  categories,
  accounts,
  onSave,
}: {
  open: boolean
  onClose: () => void
  rule: Rule | null
  categories: Category[]
  accounts: { id: string; name: string }[]
  onSave: () => void
}) {
  const [form, setForm] = useState({
    name: '',
    pattern: '',
    match_type: 'contains',
    category_id: '',
    account_id: '',
    amount_min: '',
    amount_max: '',
    amount_exact: '',
    assign_type: '',
    priority: '0',
    description: '',
    is_enabled: true,
  })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [testResults, setTestResults] = useState<{ matches: TestMatch[]; totalMatches: number } | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (open) {
      setForm({
        name: rule?.name || '',
        pattern: rule?.pattern || '',
        match_type: rule?.match_type || 'contains',
        category_id: rule?.category_id || '',
        account_id: rule?.account_id || '',
        amount_min: rule?.amount_min?.toString() || '',
        amount_max: rule?.amount_max?.toString() || '',
        amount_exact: rule?.amount_exact?.toString() || '',
        assign_type: rule?.assign_type || '',
        priority: rule?.priority?.toString() || '0',
        description: rule?.description || '',
        is_enabled: rule ? !!rule.is_enabled : true,
      })
      setTestResults(null)
      setShowAdvanced(!!(rule?.amount_min || rule?.amount_max || rule?.amount_exact || rule?.account_id || rule?.priority || rule?.assign_type))
    }
  }, [open, rule])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const payload = {
        name: form.name,
        pattern: form.pattern,
        match_type: form.match_type,
        category_id: form.category_id,
        account_id: form.account_id || null,
        amount_min: form.amount_min ? parseFloat(form.amount_min) : null,
        amount_max: form.amount_max ? parseFloat(form.amount_max) : null,
        amount_exact: form.amount_exact ? parseFloat(form.amount_exact) : null,
        assign_type: form.assign_type || null,
        priority: parseInt(form.priority) || 0,
        description: form.description,
        is_enabled: form.is_enabled ? 1 : 0,
      }

      if (rule) {
        const result = await api.put<any>(`/rules/${rule.id}`, payload)
        const applied = result?.applied || 0
        toast.success(applied > 0 ? `Rule updated — applied to ${applied} transactions` : 'Rule updated')
      } else {
        const result = await api.post<any>('/rules', payload)
        const applied = result?.applied || 0
        toast.success(applied > 0 ? `Rule created — applied to ${applied} transactions` : 'Rule created')
      }
      onSave()
      onClose()
    } catch {
      toast.error('Failed to save rule')
    }
  }

  const handleTest = async () => {
    setTesting(true)
    try {
      const payload = {
        pattern: form.pattern,
        match_type: form.match_type,
        account_id: form.account_id || null,
        amount_min: form.amount_min ? parseFloat(form.amount_min) : null,
        amount_max: form.amount_max ? parseFloat(form.amount_max) : null,
        amount_exact: form.amount_exact ? parseFloat(form.amount_exact) : null,
      }
      const result = await api.post<{ matches: TestMatch[]; totalMatches: number }>('/rules/test', payload)
      setTestResults(result)
    } catch {
      toast.error('Failed to test rule')
    } finally {
      setTesting(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-lg p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">{rule ? 'Edit' : 'Create'} Rule</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-lg"><X className="w-5 h-5" /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Rule name / label */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rule Name</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. 'Zelle transfers from Mom'"
              className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Match conditions */}
          <div className="bg-muted/30 rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">When a transaction...</p>

            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-1">
                <select
                  value={form.match_type}
                  onChange={e => setForm(f => ({ ...f, match_type: e.target.value }))}
                  className="w-full h-9 rounded-lg border border-input bg-background px-2 text-xs"
                >
                  <option value="contains">Contains</option>
                  <option value="exact">Exactly matches</option>
                  <option value="starts_with">Starts with</option>
                  <option value="ends_with">Ends with</option>
                </select>
              </div>
              <div className="col-span-2">
                <input
                  value={form.pattern}
                  onChange={e => setForm(f => ({ ...f, pattern: e.target.value }))}
                  placeholder="Transaction name pattern..."
                  className="w-full h-9 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
            </div>

            {/* Advanced toggle */}
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {showAdvanced ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {showAdvanced ? 'Less conditions' : 'More conditions (amount, account)'}
            </button>

            {showAdvanced && (
              <div className="space-y-3 pt-1">
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Exact Amount</label>
                  <input
                    type="number"
                    step="0.01"
                    value={form.amount_exact}
                    onChange={e => setForm(f => ({ ...f, amount_exact: e.target.value, amount_min: '', amount_max: '' }))}
                    placeholder="Match specific amount..."
                    className="mt-0.5 w-full h-8 rounded-lg border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Amount Min</label>
                    <input
                      type="number"
                      step="0.01"
                      value={form.amount_min}
                      onChange={e => setForm(f => ({ ...f, amount_min: e.target.value, amount_exact: '' }))}
                      placeholder="Min..."
                      className="mt-0.5 w-full h-8 rounded-lg border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Amount Max</label>
                    <input
                      type="number"
                      step="0.01"
                      value={form.amount_max}
                      onChange={e => setForm(f => ({ ...f, amount_max: e.target.value, amount_exact: '' }))}
                      placeholder="Max..."
                      className="mt-0.5 w-full h-8 rounded-lg border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Only from Account</label>
                  <select
                    value={form.account_id}
                    onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}
                    className="mt-0.5 w-full h-8 rounded-lg border border-input bg-background px-2 text-xs"
                  >
                    <option value="">Any account</option>
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Priority (higher = checked first)</label>
                  <input
                    type="number"
                    value={form.priority}
                    onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                    className="mt-0.5 w-full h-8 rounded-lg border border-input bg-background px-3 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Assignment */}
          <div className="bg-primary/5 rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Then assign to...</p>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Category</label>
              <select
                value={form.category_id}
                onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}
                className="mt-0.5 w-full h-9 rounded-lg border border-input bg-background px-3 text-sm"
                required
              >
                <option value="">Select category...</option>
                {categories.map(c => (
                  <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Treat as (transaction type)</label>
              <select
                value={form.assign_type}
                onChange={e => setForm(f => ({ ...f, assign_type: e.target.value }))}
                className="mt-0.5 w-full h-9 rounded-lg border border-input bg-background px-3 text-sm"
              >
                <option value="">Don't change type</option>
                <option value="income">Income (money in)</option>
                <option value="expense">Expense (money out)</option>
                <option value="transfer">Transfer (between accounts)</option>
              </select>
              <p className="text-[10px] text-muted-foreground mt-1">
                Override how the system treats matching transactions. E.g., mark Zelle deposits as "Income" instead of "Transfer."
              </p>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notes (optional)</label>
            <input
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Why does this rule exist?"
              className="mt-1 w-full h-9 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Test results */}
          {testResults && (
            <div className="bg-muted/30 rounded-xl p-3">
              <p className="text-xs font-semibold mb-2">
                {testResults.totalMatches} transaction{testResults.totalMatches !== 1 ? 's' : ''} would match
              </p>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {testResults.matches.slice(0, 10).map(m => (
                  <div key={m.id} className="flex items-center justify-between text-xs">
                    <span className="truncate flex-1">{m.name}</span>
                    <span className="text-muted-foreground ml-2">{m.date}</span>
                    <span className={cn('ml-2 font-medium tabular-nums', m.amount > 0 ? 'text-success' : '')}>
                      {formatCurrency(m.amount)}
                    </span>
                  </div>
                ))}
                {testResults.totalMatches > 10 && (
                  <p className="text-[10px] text-muted-foreground">...and {testResults.totalMatches - 10} more</p>
                )}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || (!form.pattern && !form.amount_exact && !form.amount_min)}
              className="h-10 px-3 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors flex items-center gap-1.5 disabled:opacity-40"
            >
              <TestTube2 className="w-4 h-4" />
              {testing ? 'Testing...' : 'Test'}
            </button>
            <div className="flex-1" />
            <button type="button" onClick={onClose} className="h-10 px-4 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!form.category_id || (!form.pattern && !form.amount_exact && !form.amount_min && !form.amount_max)}
              className="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-40"
            >
              {rule ? 'Update' : 'Create'} Rule
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function RulesPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editRule, setEditRule] = useState<Rule | null>(null)
  const [applying, setApplying] = useState(false)
  const { categories } = useCategories()
  const { accounts } = useAccounts()

  const fetchRules = async () => {
    try {
      const data = await api.get<Rule[]>('/rules')
      setRules(data)
    } catch {
      toast.error('Failed to load rules')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => { fetchRules() }, [])

  const handleToggle = async (rule: Rule) => {
    try {
      await api.put(`/rules/${rule.id}`, { is_enabled: rule.is_enabled ? 0 : 1 })
      fetchRules()
    } catch {
      toast.error('Failed to toggle rule')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/rules/${id}`)
      toast.success('Rule deleted')
      fetchRules()
    } catch {
      toast.error('Failed to delete rule')
    }
  }

  const handleApplyAll = async () => {
    setApplying(true)
    try {
      const result = await api.post<{ updated: number; message: string }>('/rules/apply')
      if (result.updated > 0) {
        toast.success(`Applied rules to ${result.updated} transactions`)
      } else {
        toast.info('All transactions already match their rules')
      }
    } catch {
      toast.error('Failed to apply rules')
    } finally {
      setApplying(false)
    }
  }

  const autoRules = rules.filter(r => r.description !== '__auto_learned__' || r.name)
  const learnedRules = rules.filter(r => !r.name && r.description === '' && !r.amount_min && !r.amount_max && !r.amount_exact)
  const manualRules = rules.filter(r => !learnedRules.includes(r))

  return (
    <div>
      <PageHeader
        title="Rules"
        description={`${rules.length} rule${rules.length !== 1 ? 's' : ''} — auto-categorize transactions`}
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={handleApplyAll}
              disabled={applying || rules.length === 0}
              className="flex items-center gap-2 h-9 px-4 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors disabled:opacity-40"
            >
              <Play className="w-4 h-4" />
              {applying ? 'Applying...' : 'Apply All Rules'}
            </button>
            <button
              onClick={() => { setEditRule(null); setShowModal(true) }}
              className="flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Plus className="w-4 h-4" /> New Rule
            </button>
          </div>
        }
      />

      {/* Explainer */}
      <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 mb-5">
        <div className="flex items-start gap-3">
          <Zap className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium mb-1">How Rules Work</p>
            <p className="text-xs text-muted-foreground">
              Rules tell the system how to automatically categorize and classify transactions. When a transaction's name, amount,
              or account matches your conditions, it gets assigned to the category you choose — and you can also override whether
              the system treats it as income, expense, or transfer. For example, "Zelle from Maredin" can be marked as Salary
              and treated as income. Rules apply to new uploads and can be run against existing transactions with "Apply All Rules."
            </p>
          </div>
        </div>
      </div>

      {/* Manual / user-created rules */}
      {manualRules.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden mb-4">
          <div className="px-5 py-3 border-b border-border/30">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Your Rules ({manualRules.length})
            </h3>
          </div>
          <div className="divide-y divide-border/30">
            {manualRules.map(rule => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onEdit={() => { setEditRule(rule); setShowModal(true) }}
                onToggle={() => handleToggle(rule)}
                onDelete={() => handleDelete(rule.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Auto-learned rules */}
      {learnedRules.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
          <div className="px-5 py-3 border-b border-border/30">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Auto-Learned ({learnedRules.length})
            </h3>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Created automatically when you recategorize transactions
            </p>
          </div>
          <div className="divide-y divide-border/30">
            {learnedRules.map(rule => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onEdit={() => { setEditRule(rule); setShowModal(true) }}
                onToggle={() => handleToggle(rule)}
                onDelete={() => handleDelete(rule.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {rules.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <Zap className="w-8 h-8 text-primary" />
          </div>
          <h3 className="text-lg font-semibold mb-1">No Rules Yet</h3>
          <p className="text-sm text-muted-foreground max-w-sm mb-4">
            Create rules to automatically categorize transactions. Rules are also learned when you recategorize transactions and choose "change all."
          </p>
          <button
            onClick={() => { setEditRule(null); setShowModal(true) }}
            className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors inline-flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Create Your First Rule
          </button>
        </div>
      )}

      {isLoading && (
        <div className="p-8 text-center text-muted-foreground">Loading rules...</div>
      )}

      <RuleModal
        open={showModal}
        onClose={() => { setShowModal(false); setEditRule(null) }}
        rule={editRule}
        categories={categories}
        accounts={accounts.map(a => ({ id: a.id, name: a.name }))}
        onSave={fetchRules}
      />
    </div>
  )
}
