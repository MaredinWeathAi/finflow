import { X } from 'lucide-react'

interface CardDetailModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
}

export function CardDetailModal({ open, onClose, title, children }: CardDetailModalProps) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-card rounded-2xl border border-border/50 w-full max-w-2xl shadow-xl max-h-[85vh] overflow-y-auto">
        <div className="sticky top-0 bg-card/95 backdrop-blur-sm border-b border-border/30 px-6 py-4 flex items-center justify-between z-10 rounded-t-2xl">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-accent rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-6 py-5">
          {children}
        </div>
      </div>
    </div>
  )
}

/* Reusable row for showing formula breakdowns */
export function FormulaRow({
  label,
  value,
  detail,
  indent,
  bold,
  color,
  operator,
}: {
  label: string
  value: string
  detail?: string
  indent?: boolean
  bold?: boolean
  color?: 'green' | 'red' | 'amber' | 'default'
  operator?: '+' | '-' | '=' | '×'
}) {
  const colorClass =
    color === 'green' ? 'text-emerald-400' :
    color === 'red' ? 'text-red-400' :
    color === 'amber' ? 'text-amber-400' :
    'text-foreground'

  return (
    <div className={`flex items-start justify-between py-1.5 ${indent ? 'pl-6' : ''} ${bold ? 'border-t border-border/50 pt-3 mt-1' : ''}`}>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {operator && (
          <span className="text-xs font-mono text-muted-foreground w-4 text-center shrink-0">{operator}</span>
        )}
        <div>
          <span className={`text-sm ${bold ? 'font-semibold' : 'text-muted-foreground'}`}>{label}</span>
          {detail && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{detail}</p>}
        </div>
      </div>
      <span className={`text-sm font-mono tabular-nums ${bold ? 'font-bold' : 'font-medium'} ${colorClass} shrink-0`}>
        {value}
      </span>
    </div>
  )
}

export function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-5 mb-2 first:mt-0">
      {children}
    </h3>
  )
}
