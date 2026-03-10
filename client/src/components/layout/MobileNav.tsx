import { NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  ArrowLeftRight,
  Lightbulb,
  PieChart,
  Settings,
  Shield,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'

const clientMobileNavItems = [
  { to: '/', icon: LayoutDashboard, label: 'Home' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Transactions' },
  { to: '/insights', icon: Lightbulb, label: 'Insights' },
  { to: '/budgets', icon: PieChart, label: 'Budgets' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

const adminMobileNavItems = [
  { to: '/admin', icon: Shield, label: 'Admin' },
  { to: '/transactions', icon: ArrowLeftRight, label: 'Transactions' },
  { to: '/insights', icon: Lightbulb, label: 'Insights' },
  { to: '/budgets', icon: PieChart, label: 'Budgets' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export function MobileNav() {
  const location = useLocation()
  const isAdmin = useAuthStore(s => s.isAdmin)
  const mobileNavItems = isAdmin ? adminMobileNavItems : clientMobileNavItems

  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-card border-t border-border/50 px-2 pb-safe print:hidden">
      <div className="flex items-center justify-around py-2">
        {mobileNavItems.map(item => {
          const isActive = item.to === '/'
            ? location.pathname === '/'
            : item.to === '/admin'
            ? location.pathname === '/admin'
            : location.pathname.startsWith(item.to) && item.to !== '/admin'

          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={cn(
                'flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg transition-colors',
                isActive
                  ? 'text-primary'
                  : 'text-muted-foreground'
              )}
            >
              <item.icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{item.label}</span>
            </NavLink>
          )
        })}
      </div>
    </nav>
  )
}
