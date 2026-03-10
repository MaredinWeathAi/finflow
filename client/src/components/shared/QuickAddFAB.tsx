import { useState } from 'react'
import { Plus, X, Receipt, CreditCard, Target, PiggyBank } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { cn } from '@/lib/utils'

export function QuickAddFAB() {
  const [isOpen, setIsOpen] = useState(false)
  const navigate = useNavigate()

  const actions = [
    { icon: Receipt, label: 'Transaction', path: '/transactions', color: 'bg-blue-500' },
    { icon: CreditCard, label: 'Account', path: '/accounts', color: 'bg-emerald-500' },
    { icon: Target, label: 'Budget', path: '/budgets', color: 'bg-amber-500' },
    { icon: PiggyBank, label: 'Goal', path: '/goals', color: 'bg-violet-500' },
  ]

  return (
    <div className="fixed bottom-20 right-5 lg:bottom-8 lg:right-8 z-40">
      {/* Action menu */}
      {isOpen && (
        <div className="absolute bottom-16 right-0 flex flex-col gap-2 items-end mb-2">
          {actions.map((action, i) => (
            <button
              key={action.label}
              onClick={() => {
                navigate(action.path, { state: { openAdd: true } })
                setIsOpen(false)
              }}
              className={cn(
                'flex items-center gap-2 h-10 pl-4 pr-3 rounded-full bg-card border border-border/50 shadow-lg',
                'hover:bg-accent transition-all transform',
                'opacity-0 animate-fade-in',
              )}
              style={{ animationDelay: `${i * 50}ms`, animationFillMode: 'forwards' }}
            >
              <span className="text-sm font-medium whitespace-nowrap">{action.label}</span>
              <div className={cn('w-7 h-7 rounded-full flex items-center justify-center', action.color)}>
                <action.icon className="w-3.5 h-3.5 text-white" />
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Main FAB */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all duration-200',
          isOpen
            ? 'bg-muted rotate-45'
            : 'bg-primary hover:bg-primary/90 hover:scale-105'
        )}
      >
        {isOpen ? (
          <X className="w-6 h-6 text-foreground" />
        ) : (
          <Plus className="w-6 h-6 text-primary-foreground" />
        )}
      </button>
    </div>
  )
}
