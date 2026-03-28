import { useState, useEffect } from 'react'
import { Plus, X, Trash2, Eye, EyeOff, CreditCard, Building, Landmark, Bitcoin, Car, Home, LineChart, TrendingUp, PiggyBank, Briefcase, GraduationCap, HeartPulse, Shield, Wallet } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn, formatCurrency } from '@/lib/utils'
import { useAccounts } from '@/hooks/useAccounts'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import type { Account } from '@/types'

const typeIcons: Record<string, React.ReactNode> = {
  checking: <Building className="w-5 h-5" />,
  savings: <Landmark className="w-5 h-5" />,
  credit: <CreditCard className="w-5 h-5" />,
  crypto: <Bitcoin className="w-5 h-5" />,
  loan: <Car className="w-5 h-5" />,
  mortgage: <Home className="w-5 h-5" />,
  property: <Home className="w-5 h-5" />,
  '401k': <Briefcase className="w-5 h-5" />,
  ira: <PiggyBank className="w-5 h-5" />,
  roth_ira: <PiggyBank className="w-5 h-5" />,
  brokerage: <TrendingUp className="w-5 h-5" />,
  '529': <GraduationCap className="w-5 h-5" />,
  hsa: <HeartPulse className="w-5 h-5" />,
  pension: <Shield className="w-5 h-5" />,
  other_investment: <Wallet className="w-5 h-5" />,
}

const typeLabels: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit Cards',
  crypto: 'Crypto',
  loan: 'Loans',
  mortgage: 'Mortgage',
  property: 'Property',
  '401k': '401(k)',
  ira: 'Traditional IRA',
  roth_ira: 'Roth IRA',
  brokerage: 'Brokerage',
  '529': '529 Plan',
  hsa: 'HSA',
  pension: 'Pension',
  other_investment: 'Other Investment',
}

// Group labels shown in the type dropdown
const typeGroupOptions = [
  { label: 'Bank Accounts', types: ['checking', 'savings'] },
  { label: 'Credit', types: ['credit'] },
  { label: 'Investment Accounts', types: ['401k', 'ira', 'roth_ira', 'brokerage', '529', 'hsa', 'pension', 'other_investment'] },
  { label: 'Other', types: ['crypto', 'loan', 'mortgage', 'property'] },
]

const typeGroups = [
  { types: ['checking', 'savings'], label: 'Cash' },
  { types: ['credit'], label: 'Credit Cards' },
  { types: ['401k', 'ira', 'roth_ira', 'brokerage', '529', 'hsa', 'pension', 'other_investment'], label: 'Investment Accounts' },
  { types: ['crypto'], label: 'Crypto' },
  { types: ['loan', 'mortgage'], label: 'Loans & Debts' },
  { types: ['property'], label: 'Property & Assets' },
]

function AccountCard({ account, onEdit }: { account: Account; onEdit: () => void }) {
  const isNeg = account.balance < 0
  return (
    <div
      onClick={onEdit}
      className="flex items-center gap-4 p-4 rounded-xl hover:bg-accent/30 transition-colors cursor-pointer group"
    >
      <div className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center text-lg shrink-0">
        {account.icon || typeIcons[account.type] || '🏦'}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{account.name}</p>
        <p className="text-xs text-muted-foreground">{account.institution} {account.last_four ? `•••• ${account.last_four}` : ''}</p>
      </div>
      <p className={cn('text-sm font-bold tabular-nums', isNeg ? 'text-danger' : 'text-foreground')}>
        {formatCurrency(account.balance)}
      </p>
    </div>
  )
}

function AddAccountModal({ open, onClose, account, onSave }: {
  open: boolean; onClose: () => void; account: Account | null; onSave: () => void
}) {
  const [form, setForm] = useState({
    name: '',
    type: 'checking',
    institution: '',
    balance: '0',
    last_four: '',
    icon: '',
  })
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Reset form when modal opens or account changes
  useEffect(() => {
    if (open) {
      setForm({
        name: account?.name || '',
        type: account?.type || 'checking',
        institution: account?.institution || '',
        balance: account?.balance?.toString() || '0',
        last_four: account?.last_four || '',
        icon: account?.icon || '',
      })
      setConfirmDelete(false)
    }
  }, [open, account])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const payload = { ...form, balance: parseFloat(form.balance) }
      if (account) {
        await api.put(`/accounts/${account.id}`, payload)
        toast.success('Account updated')
      } else {
        await api.post('/accounts', payload)
        toast.success('Account added')
      }
      onSave()
      onClose()
    } catch {
      toast.error('Failed to save account')
    }
  }

  const handleDelete = async () => {
    if (!account) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    try {
      await api.delete(`/accounts/${account.id}`)
      toast.success(`"${account.name}" deleted`)
      onSave()
      onClose()
    } catch {
      toast.error('Failed to delete account')
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-semibold">{account ? 'Edit' : 'Add'} Account</h2>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-lg"><X className="w-5 h-5" /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Type</label>
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as any }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm">
                {typeGroupOptions.map(group => (
                  <optgroup key={group.label} label={group.label}>
                    {group.types.map(t => <option key={t} value={t}>{typeLabels[t]}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Institution</label>
              <input value={form.institution} onChange={e => setForm(f => ({ ...f, institution: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Balance</label>
              <input type="number" step="0.01" value={form.balance} onChange={e => setForm(f => ({ ...f, balance: e.target.value }))} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" required />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Last 4 Digits</label>
              <input value={form.last_four} onChange={e => setForm(f => ({ ...f, last_four: e.target.value }))} maxLength={4} className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
          </div>
          <div className="flex gap-3 pt-2">
            {account && (
              <button
                type="button"
                onClick={handleDelete}
                className={cn(
                  'h-10 px-3 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5',
                  confirmDelete
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'border border-red-300 text-red-500 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950'
                )}
              >
                <Trash2 className="w-4 h-4" />
                {confirmDelete ? 'Confirm Delete' : 'Delete'}
              </button>
            )}
            <div className="flex-1" />
            <button type="button" onClick={onClose} className="h-10 px-4 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">Cancel</button>
            <button type="submit" className="h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">{account ? 'Update' : 'Add'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function AccountsPage() {
  const { accounts, isLoading, totalAssets, totalAccountAssets, totalLiabilities, totalInvestmentAccounts, investmentPortfolioValue, netWorth, refetch } = useAccounts()
  const [showModal, setShowModal] = useState(false)
  const [editAccount, setEditAccount] = useState<Account | null>(null)
  const navigate = useNavigate()

  return (
    <div>
      <PageHeader
        title="Accounts"
        description="Manage your financial accounts"
        action={
          <button
            onClick={() => { setEditAccount(null); setShowModal(true) }}
            className="flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" /> Add Account
          </button>
        }
      />

      {/* Net Worth Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-6">
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Cash & Assets</p>
          <p className="text-xl font-bold text-success mt-1">{formatCurrency(totalAccountAssets)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Investment Accounts</p>
          <p className="text-xl font-bold text-success mt-1">{formatCurrency(totalInvestmentAccounts)}</p>
        </div>
        <div
          className="bg-card rounded-xl border border-border/50 p-4 cursor-pointer hover:bg-accent/20 transition-colors"
          onClick={() => navigate('/investments')}
        >
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Positions</p>
            <LineChart className="w-3 h-3 text-muted-foreground" />
          </div>
          <p className="text-xl font-bold text-success mt-1">{formatCurrency(investmentPortfolioValue)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">Individual holdings</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Liabilities</p>
          <p className="text-xl font-bold text-danger mt-1">{formatCurrency(totalLiabilities)}</p>
        </div>
        <div className="bg-card rounded-xl border border-border/50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Net Worth</p>
          <p className="text-xl font-bold mt-1">{formatCurrency(netWorth)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">All assets - Liabilities</p>
        </div>
      </div>

      {/* Account Groups */}
      <div className="space-y-4">
        {typeGroups.map(group => {
          const groupAccounts = accounts.filter(a => group.types.includes(a.type))
          if (groupAccounts.length === 0) return null

          const groupTotal = groupAccounts.reduce((s, a) => s + a.balance, 0)

          return (
            <div key={group.label} className="bg-card rounded-2xl border border-border/50 overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 border-b border-border/30">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</h3>
                <span className={cn('text-sm font-bold tabular-nums', groupTotal < 0 ? 'text-danger' : 'text-foreground')}>
                  {formatCurrency(groupTotal)}
                </span>
              </div>
              <div className="divide-y divide-border/30">
                {groupAccounts.map(account => (
                  <AccountCard
                    key={account.id}
                    account={account}
                    onEdit={() => { setEditAccount(account); setShowModal(true) }}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Plaid Placeholder */}
      <div className="mt-6 border-2 border-dashed border-border/50 rounded-2xl p-8 text-center">
        <Landmark className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
        <h3 className="text-base font-semibold mb-1">Connect Your Bank</h3>
        <p className="text-sm text-muted-foreground max-w-sm mx-auto">
          Automatically import transactions by connecting your bank via Plaid. Coming soon.
        </p>
      </div>

      <AddAccountModal
        open={showModal}
        onClose={() => { setShowModal(false); setEditAccount(null) }}
        account={editAccount}
        onSave={refetch}
      />
    </div>
  )
}
