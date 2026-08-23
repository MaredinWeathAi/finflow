import { assessPassword } from '@/lib/passwordPolicy'
import { Check, X } from 'lucide-react'

const BAR_COLORS = [
  'bg-destructive',
  'bg-destructive',
  'bg-amber-500',
  'bg-emerald-500',
  'bg-emerald-500',
]

export function PasswordStrength({ password, email }: { password: string; email?: string }) {
  if (!password) return null
  const { score, label, problems, hints } = assessPassword(password, email)

  return (
    <div className="mt-2 space-y-2" aria-live="polite">
      <div className="flex items-center gap-2">
        <div className="flex-1 flex gap-1" role="presentation">
          {[0, 1, 2, 3].map(i => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i < score ? BAR_COLORS[score] : 'bg-muted'
              }`}
            />
          ))}
        </div>
        <span className="text-xs font-medium tabular-nums text-muted-foreground w-20 text-right">
          {label}
        </span>
      </div>

      {problems.length > 0 && (
        <ul className="space-y-1">
          {problems.map(p => (
            <li key={p} className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <X className="w-3.5 h-3.5 mt-px shrink-0 text-destructive" aria-hidden />
              <span>{p}</span>
            </li>
          ))}
        </ul>
      )}

      {problems.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <Check className="w-3.5 h-3.5 shrink-0" aria-hidden />
          Meets the password policy
        </p>
      )}

      {hints.map(h => (
        <p key={h} className="text-xs text-muted-foreground/80">{h}</p>
      ))}
    </div>
  )
}
