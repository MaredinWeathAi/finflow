import { useState } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useThemeStore } from '@/stores/themeStore'
import { PageHeader } from '@/components/shared/PageHeader'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { Sun, Moon, Monitor, Database, Upload, Trash2, Loader2, Eraser, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'

export function SettingsPage() {
  const { user } = useAuthStore()
  const { theme, setTheme } = useThemeStore()
  const [name, setName] = useState(user?.name || '')
  const [currency, setCurrency] = useState(user?.currency || 'USD')
  const [saving, setSaving] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [wipeOpen, setWipeOpen] = useState(false)
  const [confirmWipe, setConfirmWipe] = useState('')
  const [wiping, setWiping] = useState(false)
  const [recategorizing, setRecategorizing] = useState(false)

  const handleSaveProfile = async () => {
    setSaving(true)
    try {
      await api.put('/settings', { name, currency })
      toast.success('Settings saved')
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleSeedData = async () => {
    setSeeding(true)
    try {
      await api.post('/data/seed-sample')
      toast.success('Sample data loaded! Refresh the page to see changes.')
    } catch {
      toast.error('Failed to seed data')
    } finally {
      setSeeding(false)
    }
  }

  const handleResetData = async () => {
    if (!confirm(
      'This deletes EVERYTHING: transactions, accounts and their balances, ' +
      'categories, budgets, goals and recurring items.\n\n' +
      'If you only want to clear transactions and keep your accounts, ' +
      'cancel this and use "Delete All Transactions" instead.\n\n' +
      'Continue?'
    )) return
    try {
      await api.delete('/data/reset')
      toast.success('All data has been reset')
    } catch {
      toast.error('Failed to reset')
    }
  }

  // Clearing transactions is a different, much more common job than wiping the
  // whole account: it is what you do before re-importing statements. Keeping
  // the accounts means balances, budgets, goals and recurring items survive,
  // so the balance sheet does not have to be rebuilt by hand afterwards.
  const handleDeleteTransactions = async () => {
    if (confirmWipe !== 'DELETE') return
    setWiping(true)
    try {
      const result = await api.delete<{ deleted: number; accountsAdjusted: number }>(
        '/transactions/bulk',
        { confirm: true },
      )
      toast.success(
        result.deleted === 0
          ? 'No transactions to delete'
          : `Deleted ${result.deleted.toLocaleString()} transactions across ${result.accountsAdjusted} account${result.accountsAdjusted === 1 ? '' : 's'}`,
      )
      setConfirmWipe('')
      setWipeOpen(false)
    } catch {
      toast.error('Failed to delete transactions')
    } finally {
      setWiping(false)
    }
  }

  // Improving a rule used to mean deleting everything and re-importing the
  // statements just to see the benefit. This re-decides the categories on the
  // rows that are already here, keeping ids, notes and edits.
  const handleRecategorize = async () => {
    setRecategorizing(true)
    try {
      const r = await api.post<{
        scanned: number; changed: number; bySimilarity: number; stillUncategorized: number
      }>('/transactions/recategorize-all')
      const extras: string[] = []
      if (r.bySimilarity > 0) extras.push(`${r.bySimilarity} matched by similarity`)
      if (r.stillUncategorized > 0) extras.push(`${r.stillUncategorized} still need a category`)
      toast.success(
        `Re-categorised ${r.changed.toLocaleString()} of ${r.scanned.toLocaleString()} transactions` +
        (extras.length ? ` — ${extras.join(', ')}` : ''),
      )
    } catch {
      toast.error('Failed to re-categorise')
    } finally {
      setRecategorizing(false)
    }
  }

  const themes = [
    { value: 'dark' as const, icon: Moon, label: 'Dark' },
    { value: 'light' as const, icon: Sun, label: 'Light' },
    { value: 'system' as const, icon: Monitor, label: 'System' },
  ]

  const currencies = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'BRL']

  return (
    <div>
      <PageHeader title="Settings" description="Manage your preferences" />

      <div className="max-w-2xl space-y-6">
        {/* Profile */}
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Profile</h3>
          <div className="space-y-4">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</label>
              <input
                value={user?.email || ''}
                disabled
                className="mt-1 w-full h-10 rounded-lg border border-input bg-muted px-3 text-sm text-muted-foreground"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Currency</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                className="mt-1 w-full h-10 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {currencies.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <button
              onClick={handleSaveProfile}
              disabled={saving}
              className="h-10 px-6 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>

        {/* Theme */}
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Appearance</h3>
          <div className="flex gap-3">
            {themes.map(t => (
              <button
                key={t.value}
                onClick={() => setTheme(t.value)}
                className={cn(
                  'flex-1 flex flex-col items-center gap-2 p-4 rounded-xl border transition-all',
                  theme === t.value
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border/50 hover:bg-accent/50'
                )}
              >
                <t.icon className="w-5 h-5" />
                <span className="text-xs font-medium">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Data Management */}
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Data Management</h3>
          <div className="space-y-3">
            <button
              onClick={handleSeedData}
              disabled={seeding}
              className="w-full flex items-center gap-3 p-4 rounded-xl border border-border/50 hover:bg-accent/30 transition-colors text-left"
            >
              {seeding ? (
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              ) : (
                <Database className="w-5 h-5 text-primary" />
              )}
              <div>
                <p className="text-sm font-medium">Load Sample Data</p>
                <p className="text-xs text-muted-foreground">Populate with 6 months of demo transactions</p>
              </div>
            </button>

            <button
              onClick={() => api.get('/data/export').then(data => {
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url; a.download = 'finbudget-export.json'; a.click()
                URL.revokeObjectURL(url)
                toast.success('Data exported')
              })}
              className="w-full flex items-center gap-3 p-4 rounded-xl border border-border/50 hover:bg-accent/30 transition-colors text-left"
            >
              <Upload className="w-5 h-5 text-success" />
              <div>
                <p className="text-sm font-medium">Export All Data</p>
                <p className="text-xs text-muted-foreground">Download everything as JSON</p>
              </div>
            </button>

            <button
              onClick={handleRecategorize}
              disabled={recategorizing}
              className="w-full flex items-center gap-3 p-4 rounded-xl border border-border/50 hover:bg-accent/30 transition-colors text-left disabled:opacity-60"
            >
              {recategorizing ? (
                <Loader2 className="w-5 h-5 animate-spin text-primary" />
              ) : (
                <Wand2 className="w-5 h-5 text-primary" />
              )}
              <div>
                <p className="text-sm font-medium">
                  {recategorizing ? 'Re-categorising…' : 'Re-categorise All Transactions'}
                </p>
                <p className="text-xs text-muted-foreground">
                  Re-runs the rules over the transactions you already have — no re-import needed. Your own corrections always win.
                </p>
              </div>
            </button>

            {!wipeOpen ? (
              <button
                onClick={() => setWipeOpen(true)}
                className="w-full flex items-center gap-3 p-4 rounded-xl border border-warning/40 hover:bg-warning/10 transition-colors text-left"
              >
                <Eraser className="w-5 h-5 text-warning" />
                <div>
                  <p className="text-sm font-medium">Delete All Transactions</p>
                  <p className="text-xs text-muted-foreground">
                    Clears transaction history for a fresh import. Accounts, balances, budgets, goals and recurring items are kept.
                  </p>
                </div>
              </button>
            ) : (
              <div className="w-full p-4 rounded-xl border border-warning/50 bg-warning/5 space-y-3">
                <div className="flex items-start gap-3">
                  <Eraser className="w-5 h-5 text-warning shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">Delete every transaction?</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      This cannot be undone. Your accounts and their balances, categories, budgets,
                      goals and recurring items all stay exactly as they are — only transaction
                      history is removed.
                    </p>
                  </div>
                </div>
                <input
                  autoFocus
                  value={confirmWipe}
                  onChange={(e) => setConfirmWipe(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && confirmWipe === 'DELETE') handleDeleteTransactions() }}
                  placeholder="Type DELETE to confirm"
                  aria-label="Type DELETE to confirm"
                  className="w-full px-3 py-2 rounded-lg bg-background border border-border/60 text-sm focus:outline-none focus:ring-2 focus:ring-warning/50"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleDeleteTransactions}
                    disabled={confirmWipe !== 'DELETE' || wiping}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-destructive text-destructive-foreground text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                  >
                    {wiping && <Loader2 className="w-4 h-4 animate-spin" />}
                    {wiping ? 'Deleting…' : 'Delete transactions'}
                  </button>
                  <button
                    onClick={() => { setWipeOpen(false); setConfirmWipe('') }}
                    disabled={wiping}
                    className="px-4 py-2 rounded-lg border border-border/60 text-sm hover:bg-accent/30 transition-colors disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <button
              onClick={handleResetData}
              className="w-full flex items-center gap-3 p-4 rounded-xl border border-destructive/30 hover:bg-destructive/10 transition-colors text-left"
            >
              <Trash2 className="w-5 h-5 text-destructive" />
              <div>
                <p className="text-sm font-medium text-destructive">Delete All Data</p>
                <p className="text-xs text-muted-foreground">
                  Removes accounts and balances too, along with categories, budgets, goals and recurring items. Rarely what you want.
                </p>
              </div>
            </button>
          </div>
        </div>

        {/* About */}
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">About</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Version</span>
              <span>1.0.0</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Built with</span>
              <span>React + Vite + SQLite</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
