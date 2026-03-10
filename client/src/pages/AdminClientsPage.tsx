import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Users, Plus, Search, ArrowRight, Trash2 } from 'lucide-react'
import { formatCurrency, cn } from '@/lib/utils'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/shared/PageHeader'
import { toast } from 'sonner'

interface ClientSummary {
  id: string
  name: string
  email: string
  username: string | null
  phone: string | null
  total_balance: number
  monthly_spending: number
  transaction_count: number
  account_count: number
  created_at: string
}

export function AdminClientsPage() {
  const [clients, setClients] = useState<ClientSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [showAddModal, setShowAddModal] = useState(false)

  const loadClients = () => {
    setIsLoading(true)
    api.get<{ clients: ClientSummary[] }>('/admin/clients')
      .then(res => setClients(res.clients))
      .catch(console.error)
      .finally(() => setIsLoading(false))
  }

  useEffect(() => { loadClients() }, [])

  const filteredClients = clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.email.toLowerCase().includes(search.toLowerCase()) ||
    (c.username && c.username.toLowerCase().includes(search.toLowerCase()))
  )

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Remove client "${name}"? This will delete all their data.`)) return
    try {
      await api.delete(`/admin/clients/${id}`)
      toast.success(`Removed ${name}`)
      loadClients()
    } catch { toast.error('Failed to remove client') }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Clients</h1>
          <p className="text-muted-foreground text-sm mt-1">{clients.length} total clients</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add Client
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search clients..."
          className="w-full h-10 pl-10 pr-4 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <div key={i} className="bg-card rounded-2xl border border-border/50 p-5 animate-pulse">
              <div className="h-5 w-40 bg-muted rounded mb-2" />
              <div className="h-4 w-60 bg-muted rounded" />
            </div>
          ))}
        </div>
      ) : filteredClients.length === 0 ? (
        <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
          <Users className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            {search ? 'No clients match your search' : 'No clients yet. Add your first client to get started.'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredClients.map(client => (
            <div
              key={client.id}
              className="bg-card rounded-2xl border border-border/50 p-5 hover:border-primary/30 transition-colors"
            >
              <div className="flex items-center justify-between">
                <Link to={`/admin/clients/${client.id}`} className="flex-1 group">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center text-sm font-semibold text-primary shrink-0">
                      {client.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold group-hover:text-primary transition-colors">{client.name}</p>
                        {client.username && (
                          <span className="text-xs text-muted-foreground">@{client.username}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{client.email}</p>
                    </div>
                    <div className="hidden sm:grid grid-cols-3 gap-6 text-right">
                      <div>
                        <p className="text-xs text-muted-foreground">Balance</p>
                        <p className={cn('text-sm font-semibold', client.total_balance >= 0 ? 'text-success' : 'text-danger')}>{formatCurrency(client.total_balance)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Monthly Spend</p>
                        <p className="text-sm font-semibold text-danger">{formatCurrency(client.monthly_spending)}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Transactions</p>
                        <p className="text-sm font-semibold">{client.transaction_count}</p>
                      </div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors ml-2" />
                  </div>
                </Link>
                <button
                  onClick={() => handleDelete(client.id, client.name)}
                  className="ml-3 p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  title="Remove client"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Client Modal */}
      {showAddModal && (
        <AddClientModal onClose={() => setShowAddModal(false)} onAdded={loadClients} />
      )}
    </div>
  )
}

function AddClientModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('password123')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await api.post('/admin/clients', { name, email, username: username || undefined, phone: phone || undefined, password })
      toast.success(`Client ${name} added`)
      onAdded()
      onClose()
    } catch (err: any) {
      toast.error(err.message || 'Failed to add client')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-card rounded-2xl border border-border/50 p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">Add New Client</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Full Name *</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required
              className="mt-1 w-full h-9 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Email *</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              className="mt-1 w-full h-9 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Username</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)}
              className="mt-1 w-full h-9 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</label>
            <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
              className="mt-1 w-full h-9 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Temporary Password *</label>
            <input type="text" value={password} onChange={e => setPassword(e.target.value)} required
              className="mt-1 w-full h-9 rounded-lg border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 h-9 rounded-lg border border-input text-sm font-medium hover:bg-accent transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={loading}
              className="flex-1 h-9 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
              {loading ? 'Adding...' : 'Add Client'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
