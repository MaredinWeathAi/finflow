import { useState, useCallback, useEffect } from 'react'
import { format, parseISO, isToday, isYesterday } from 'date-fns'
import { Search, Filter, Plus, ArrowUpDown, Download, Upload, X, Check, Tag, Receipt } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { useTransactions } from '@/hooks/useTransactions'
import { useCategories } from '@/hooks/useCategories'
import { useAccounts } from '@/hooks/useAccounts'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/shared/PageHeader'
import type { Transaction, Category } from '@/types'
import { toast } from 'sonner'

function formatDate(dateStr: string): string {
  const date = parseISO(dateStr)
  if (isToday(date)) return 'Today'
  if (isYesterday(date)) return 'Yesterday'
  return format(date, 'MMM d')
}

function TransactionRow({
  transaction,
  categories,
  onEdit,
  selected,
  onToggleSelect,
}: {
  transaction: Transaction
  categories: Category[]
  onEdit: (t: Transaction) => void
  selected: boolean
  onToggleSelect: () => void
}) {
  const isIncome = transaction.amount > 0

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors cursor-pointer group"
      onClick={() => onEdit(transaction)}
    >
      <button
        onClick={e => { e.stopPropagation(); onToggleSelect() }}
        className={cn(
          'w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors',
          selected ? 'bg-primary border-primary' : 'border-border group-hover:border-muted-foreground'
        )}
      >
        {selected && <Check className="w-3 h-3 text-primary-foreground" />}
      </button>

      <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center text-base shrink-0">
        {transaction.category_icon || '💰'}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{transaction.name}</span>
          {transaction.is_pending && (
            <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-warning/10 text-warning">
              Pending
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {transaction.category_name && (
            <span
              className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full"
              style={{
                backgroundColor: `${transaction.category_color}15`,
                color: transaction.category_color,
              }}
            >
              {transaction.category_name}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{transaction.account_name}</span>
        </div>
      </div>

      <div className="text-right shrink-0">
        <p className={cn('text-sm font-semibold tabular-nums', isIncome ? 'text-success' : 'text-foreground')}>
          {isIncome ? '+' : ''}{formatCurrency(transaction.amount)}
        </p>
        <p className="text-xs text-muted-foreground">{formatDate(transaction.date)}</p>
      </div>
    </div>
  )
}

function AddTransactionModal({
  open,
  onClose,
  categories,
  accounts,
  transaction,
  onSave,
  onDelete,
}: {
  open: boolean
  onClose: () => void
  categories: Category[]
  accounts: { id: string; name: string }[]
  transaction: Transaction | null
  onSave: () => void
  onDelete?: (id: string) => void
}) {
  const [form, setForm] = useState({
    name: '',
    amount: '',
    type: 'expense' as string,
    category_id: '',
    account_id: '',
    date: format(new Date(), 'yyyy-MM-dd'),
    notes: '',
    is_pending: false,
  })

  const [showPropagatePrompt, setShowPropagatePrompt] = useState(false)

  // Reset form when modal opens or transaction changes
  useEffect(() => {
    if (open) {
      setForm({
        name: transaction?.name || '',
        amount: transaction ? Math.abs(transaction.amount).toString() : '',
        type: transaction ? (transaction.amount > 0 ? 'income' : 'expense') : 'expense',
        category_id: transaction?.category_id || '',
        account_id: transaction?.account_id || '',
        date: transaction?.date || format(new Date(), 'yyyy-MM-dd'),
        notes: transaction?.notes || '',
        is_pending: transaction?.is_pending || false,
      })
      setShowPropagatePrompt(false)
    }
  }, [open, transaction])

  const categoryChanged = transaction && form.category_id && form.category_id !== transaction.category_id

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // If category changed on an existing transaction, ask about propagation
    if (categoryChanged && !showPropagatePrompt) {
      setShowPropagatePrompt(true)
      return
    }

    const amount = parseFloat(form.amount) * (form.type === 'expense' ? -1 : 1)
    const payload = {
      name: form.name,
      amount,
      category_id: form.category_id,
      account_id: form.account_id,
      date: form.date,
      notes: form.notes || null,
      is_pending: form.is_pending,
      tags: [],
    }

    try {
      if (transaction) {
        await api.put(`/transactions/${transaction.id}`, payload)
        toast.success('Transaction updated')
      } else {
        await api.post('/transactions', payload)
        toast.success('Transaction added')
      }
      onSave()
      onClose()
    } catch {
      toast.error('Failed to save transaction')
    }
  }

  const handleRecategorize = async (propagate: boolean) => {
    try {
      // First save the transaction with all field changes
      const amount = parseFloat(form.amount) * (form.type === 'expense' ? -1 : 1)
      await api.put(`/transactions/${transaction!.id}`, {
        name: form.name,
        amount,
        category_id: form.category_id,
        account_id: form.account_id,
        date: form.date,
        notes: form.notes || null,
        is_pending: form.is_pending,
        tags: [],
      })

      if (propagate) {
        const result = await api.post<{ updated: number; categoryName: string }>('/transactions/recategorize', {
          transactionId: transaction!.id,
          categoryId: form.category_id,
          propagate: true,
        })
        if (result.updated > 1) {
          toast.success(`Updated ${result.updated} similar "${transaction!.name}" transactions to ${result.categoryName}`)
        } else {
          toast.success('Transaction updated')
        }
      } else {
        toast.success('Transaction updated')
      }
      onSave()
      onClose()
    } catch {
      toast.error('Failed to update transaction')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-lg p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">{transaction ? 'Edit' : 'Add'} Transaction</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-lg"><X className="w-5 h-5" /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Merchant / Name</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                required
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Amount</label>
              <input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                required
              />
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</label>
              <select
                value={form.type}
                onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Category</label>
              <select
                value={form.category_id}
                onChange={e => setForm(f => ({ ...f, category_id: e.target.value }))}
                className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                required
              >
                <option value="">Select...</option>
                {categories.map(c => (
                  <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Account</label>
              <select
                value={form.account_id}
                onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}
                className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                required
              >
                <option value="">Select...</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Date</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                required
              />
            </div>

            <div>
              <label className="flex items-center gap-2 mt-6 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_pending}
                  onChange={e => setForm(f => ({ ...f, is_pending: e.target.checked }))}
                  className="w-4 h-4 rounded border-input"
                />
                <span className="text-sm">Pending</span>
              </label>
            </div>

            <div className="col-span-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Notes</label>
              <textarea
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="mt-1 w-full h-20 rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>

          {showPropagatePrompt ? (
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4 space-y-3">
              <p className="text-sm font-medium">Apply to similar transactions?</p>
              <p className="text-xs text-muted-foreground">
                Change all transactions named "{transaction?.name}" to the new category?
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleRecategorize(true)}
                  className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  Yes, change all
                </button>
                <button
                  type="button"
                  onClick={() => handleRecategorize(false)}
                  className="flex-1 h-9 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors"
                >
                  Just this one
                </button>
              </div>
            </div>
          ) : (
            <div className="flex gap-3 pt-2">
              {transaction && onDelete && (
                <button
                  type="button"
                  onClick={() => { if (confirm('Delete this transaction?')) { onDelete(transaction.id); onClose() } }}
                  className="h-10 px-4 rounded-lg border border-red-500/30 text-red-400 text-sm font-medium hover:bg-red-500/10 transition-colors"
                >
                  Delete
                </button>
              )}
              <button type="button" onClick={onClose} className="flex-1 h-10 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">
                Cancel
              </button>
              <button type="submit" className="flex-1 h-10 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
                {transaction ? 'Update' : 'Add'} Transaction
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  )
}

export function TransactionsPage() {
  const [search, setSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selectedAccount, setSelectedAccount] = useState('')
  const [sortBy, setSortBy] = useState('date_desc')
  const [page, setPage] = useState(1)
  const [showFilters, setShowFilters] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  const [editTransaction, setEditTransaction] = useState<Transaction | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const { categories } = useCategories()
  const { accounts } = useAccounts()
  const { transactions, total, totalPages, totalIncome, totalExpenses, isLoading, refetch } = useTransactions({
    page,
    limit: 30,
    search: search || undefined,
    category: selectedCategory || undefined,
    account: selectedAccount || undefined,
    sort: sortBy,
  })

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleBulkCategorize = async (categoryId: string) => {
    try {
      await api.post('/transactions/bulk-categorize', {
        transactionIds: Array.from(selectedIds),
        categoryId,
      })
      toast.success(`${selectedIds.size} transactions updated`)
      setSelectedIds(new Set())
      refetch()
    } catch {
      toast.error('Failed to update transactions')
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/transactions/${id}`)
      toast.success('Transaction deleted')
      refetch()
    } catch {
      toast.error('Failed to delete')
    }
  }

  return (
    <div>
      <PageHeader
        title="Transactions"
        description={`${total} transactions found`}
        action={
          <button
            onClick={() => { setEditTransaction(null); setShowAddModal(true) }}
            className="flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Transaction
          </button>
        }
      />

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Income</p>
          <p className="text-lg font-bold text-success mt-1">{formatCurrency(totalIncome)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expenses</p>
          <p className="text-lg font-bold text-danger mt-1">{formatCurrency(totalExpenses)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net</p>
          <p className={cn('text-lg font-bold mt-1', totalIncome - totalExpenses >= 0 ? 'text-success' : 'text-danger')}>
            {formatCurrency(totalIncome - totalExpenses)}
          </p>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search transactions..."
            className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={cn(
            'h-10 px-3 rounded-lg border text-sm font-medium flex items-center gap-2 transition-colors',
            showFilters ? 'border-primary text-primary bg-primary/10' : 'border-input hover:bg-accent'
          )}
        >
          <Filter className="w-4 h-4" />
          Filters
        </button>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="h-10 px-3 rounded-lg border border-input bg-background text-sm focus:outline-none"
        >
          <option value="date_desc">Newest first</option>
          <option value="date_asc">Oldest first</option>
          <option value="amount_desc">Highest amount</option>
          <option value="amount_asc">Lowest amount</option>
          <option value="name_asc">Name A-Z</option>
        </select>
      </div>

      {/* Filter Bar */}
      {showFilters && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-card rounded-xl border border-border/50">
          <select
            value={selectedCategory}
            onChange={e => { setSelectedCategory(e.target.value); setPage(1) }}
            className="h-9 px-3 rounded-lg border border-input bg-background text-sm"
          >
            <option value="">All Categories</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </select>
          <select
            value={selectedAccount}
            onChange={e => { setSelectedAccount(e.target.value); setPage(1) }}
            className="h-9 px-3 rounded-lg border border-input bg-background text-sm"
          >
            <option value="">All Accounts</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
          {(selectedCategory || selectedAccount) && (
            <button
              onClick={() => { setSelectedCategory(''); setSelectedAccount(''); setPage(1) }}
              className="h-9 px-3 rounded-lg text-sm text-muted-foreground hover:text-foreground flex items-center gap-1"
            >
              <X className="w-3 h-3" /> Clear
            </button>
          )}
        </div>
      )}

      {/* Bulk Actions */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-primary/10 rounded-xl border border-primary/20">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <select
            onChange={e => { if (e.target.value) handleBulkCategorize(e.target.value); e.target.value = '' }}
            className="h-8 px-2 rounded-lg border border-input bg-background text-sm"
          >
            <option value="">Change category...</option>
            {categories.map(c => (
              <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
            ))}
          </select>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Clear selection
          </button>
        </div>
      )}

      {/* Transaction List */}
      <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-muted-foreground">Loading...</div>
        ) : transactions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 px-4 text-center relative overflow-hidden">
            <div className="absolute inset-0 flex items-center justify-center opacity-[0.03] pointer-events-none">
              <Receipt className="w-64 h-64" />
            </div>
            <div className="relative">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4 mx-auto">
                <Receipt className="w-8 h-8 text-primary" />
              </div>
              <h3 className="text-lg font-semibold mb-1">No Transactions Yet</h3>
              <p className="text-sm text-muted-foreground max-w-sm mb-4">
                Start tracking your spending by adding your first transaction or importing from your bank.
              </p>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={() => { setEditTransaction(null); setShowAddModal(true) }}
                  className="h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors inline-flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" /> Add Transaction
                </button>
                <button
                  onClick={() => window.location.href = '/upload'}
                  className="h-9 px-4 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors inline-flex items-center gap-2"
                >
                  <Upload className="w-4 h-4" /> Import
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {transactions.map(t => (
              <TransactionRow
                key={t.id}
                transaction={t}
                categories={categories}
                onEdit={t => { setEditTransaction(t); setShowAddModal(true) }}
                selected={selectedIds.has(t.id)}
                onToggleSelect={() => toggleSelect(t.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4">
          <button
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
            className="h-9 px-4 rounded-lg border border-input text-sm font-medium disabled:opacity-50 hover:bg-accent transition-colors"
          >
            Previous
          </button>
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <button
            disabled={page === totalPages}
            onClick={() => setPage(p => p + 1)}
            className="h-9 px-4 rounded-lg border border-input text-sm font-medium disabled:opacity-50 hover:bg-accent transition-colors"
          >
            Next
          </button>
        </div>
      )}

      {/* Add/Edit Modal */}
      <AddTransactionModal
        open={showAddModal}
        onClose={() => { setShowAddModal(false); setEditTransaction(null) }}
        categories={categories}
        accounts={accounts.map(a => ({ id: a.id, name: a.name }))}
        transaction={editTransaction}
        onSave={refetch}
        onDelete={handleDelete}
      />
    </div>
  )
}
