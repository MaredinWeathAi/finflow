import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Users, DollarSign, AlertTriangle, TrendingUp, ArrowRight, Printer } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/shared/PageHeader'

interface AdminDashboard {
  clientCount: number
  totalAUM: number
  totalLiabilities: number
  netWorth: number
  atRiskClients: { id: string; name: string; email: string }[]
  recentActivity: { id: string; client_name: string; name: string; amount: number; date: string; category_name: string; category_icon: string }[]
}

export function AdminDashboardPage() {
  const [data, setData] = useState<AdminDashboard | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    api.get<AdminDashboard>('/admin/dashboard')
      .then(setData)
      .catch(console.error)
      .finally(() => setIsLoading(false))
  }, [])

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Advisor Dashboard" description="Overview of all client portfolios" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          {[1,2,3,4].map(i => (
            <div key={i} className="bg-card rounded-2xl border border-border/50 p-5 animate-pulse">
              <div className="h-4 w-20 bg-muted rounded mb-3" />
              <div className="h-7 w-28 bg-muted rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!data) return null

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Advisor Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-1">Overview of all client portfolios</p>
        </div>
        <Link
          to="/admin/clients"
          className="flex items-center gap-2 h-9 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Users className="w-4 h-4" />
          View All Clients
        </Link>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-center gap-2 mb-2">
            <Users className="w-4 h-4 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total Clients</span>
          </div>
          <p className="text-2xl font-bold">{data.clientCount}</p>
        </div>
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-4 h-4 text-success" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Total AUM</span>
          </div>
          <p className="text-2xl font-bold text-success">{formatCurrency(data.totalAUM)}</p>
        </div>
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp className="w-4 h-4 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Avg Net Worth</span>
          </div>
          <p className="text-2xl font-bold">{formatCurrency(data.netWorth)}</p>
        </div>
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">At Risk</span>
          </div>
          <p className="text-2xl font-bold text-warning">{data.atRiskClients.length}</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* At Risk Clients */}
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">At-Risk Clients</h3>
          {data.atRiskClients.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No at-risk clients</p>
          ) : (
            <div className="space-y-3">
              {data.atRiskClients.map(client => (
                <Link
                  key={client.id}
                  to={`/admin/clients/${client.id}`}
                  className="flex items-center justify-between p-3 rounded-xl hover:bg-accent/30 transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-warning/20 flex items-center justify-center">
                      <AlertTriangle className="w-4 h-4 text-warning" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{client.name}</p>
                      <p className="text-xs text-muted-foreground">Budget over 90% spent</p>
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="bg-card rounded-2xl border border-border/50 p-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-4">Recent Activity</h3>
          {data.recentActivity.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No recent activity</p>
          ) : (
            <div className="space-y-3">
              {data.recentActivity.map(activity => (
                <div key={activity.id} className="flex items-start gap-3 p-2">
                  <div className="w-2 h-2 rounded-full bg-primary mt-1.5 shrink-0" />
                  <div>
                    <p className="text-sm">
                      <span className="font-medium">{activity.client_name}</span>
                      {' '}<span className="text-muted-foreground">{activity.category_icon} {activity.name} — {formatCurrency(Math.abs(activity.amount))}</span>
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">{activity.date}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
