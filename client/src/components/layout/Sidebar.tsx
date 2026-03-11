import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Lightbulb,
  Upload,
  ArrowLeftRight,
  PieChart,
  Wallet,
  TrendingUp,
  Target,
  FileText,
  Settings,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Users,
  Shield,
  Tag,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { useState } from 'react'

const clientNavItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/insights', icon: Lightbulb, label: 'Insights' },
  { to: '/goals', icon: Target, label: 'Goals' },
  { to: '/budgets', icon: PieChart, label: 'Budgets' },
  { to: '/cashflow', icon: TrendingUp, label: 'Cash Flow' },
  { to: '/accounts', icon: Wallet, label: 'Accounts' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Transactions' },
  { to: '/categories', icon: Tag, label: 'Categories' },
  { to: '/upload', icon: Upload, label: 'Upload' },
  { to: '/reports', icon: FileText, label: 'Reports' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

const adminNavItems = [
  { to: '/admin', icon: Shield, label: 'Advisor Home' },
  { to: '/admin/clients', icon: Users, label: 'Clients' },
]

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false)
  const logout = useAuthStore(s => s.logout)
  const user = useAuthStore(s => s.user)
  const isAdmin = useAuthStore(s => s.isAdmin)
  const location = useLocation()

  const navItems = isAdmin
    ? [...adminNavItems, { type: 'divider' as const }, ...clientNavItems]
    : clientNavItems

  return (
    <aside
      className={cn(
        'hidden lg:flex flex-col h-screen bg-card border-r border-border/50 transition-all duration-300 sticky top-0 print:hidden',
        collapsed ? 'w-[72px]' : 'w-[240px]'
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-border/50">
        <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
          <span className="text-primary-foreground font-bold text-sm">F</span>
        </div>
        {!collapsed && (
          <span className="font-bold text-lg tracking-tight">FinBudget</span>
        )}
      </div>

      {/* Admin Badge */}
      {isAdmin && !collapsed && (
        <div className="mx-3 mt-3 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/20">
          <p className="text-xs font-semibold text-primary">Wealth Advisor</p>
        </div>
      )}

      {/* Nav Items */}
      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
        {navItems.map((item, index) => {
          if ('type' in item && item.type === 'divider') {
            return <div key={`div-${index}`} className="my-2 border-t border-border/50" />
          }

          const navItem = item as { to: string; icon: any; label: string }
          const isActive = navItem.to === '/'
            ? location.pathname === '/'
            : navItem.to === '/admin'
            ? location.pathname === '/admin'
            : location.pathname.startsWith(navItem.to) && navItem.to !== '/admin'

          return (
            <NavLink
              key={navItem.to}
              to={navItem.to}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              )}
            >
              <navItem.icon className="w-5 h-5 shrink-0" />
              {!collapsed && <span>{navItem.label}</span>}
            </NavLink>
          )
        })}
      </nav>

      {/* User / Collapse */}
      <div className="border-t border-border/50 p-3 space-y-2">
        {!collapsed && user && (
          <div className="flex items-center gap-3 px-2 py-1.5">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-xs font-semibold text-primary">
              {user.name?.charAt(0).toUpperCase() || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user.name}</p>
              <p className="text-xs text-muted-foreground truncate">{user.email}</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-1">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors text-sm"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            {!collapsed && <span>Collapse</span>}
          </button>
          {!collapsed && (
            <button
              onClick={logout}
              className="flex items-center justify-center px-3 py-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}
