/**
 * Client-side mirror of the server password policy (server/src/config/security.ts).
 * The server is authoritative — this exists to give immediate feedback, never to
 * decide anything.
 */
const KNOWN_WEAK = [
  'demo123', 'password123', 'password', 'admin', 'admin123', 'letmein',
  'changeme', 'welcome1', 'qwerty123', 'finflow', 'finflow123', 'test1234',
]

export interface PasswordAssessment {
  ok: boolean
  score: 0 | 1 | 2 | 3 | 4
  label: string
  problems: string[]
  hints: string[]
}

export function assessPassword(password: string, email?: string): PasswordAssessment {
  const problems: string[] = []
  const hints: string[] = []
  const lower = password.toLowerCase()

  if (password.length < 12) problems.push('At least 12 characters')
  if (password.length > 200) problems.push('Under 200 characters')

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(password)).length
  if (classes < 3) problems.push('Mix at least three of: lowercase, uppercase, numbers, symbols')

  if (password && KNOWN_WEAK.some(w => lower === w || lower.includes(w))) {
    problems.push('Contains a known default or very common password')
  }

  if (email) {
    const local = email.split('@')[0]?.toLowerCase()
    if (local && local.length >= 4 && lower.includes(local)) {
      problems.push('Must not contain your email address')
    }
  }

  // Rough strength signal for the meter — length dominates, variety helps.
  let score = 0
  if (password.length >= 12) score += 1
  if (password.length >= 16) score += 1
  if (classes >= 3) score += 1
  if (password.length >= 20 || (classes === 4 && password.length >= 16)) score += 1
  if (problems.length > 0) score = Math.min(score, 1)

  if (password.length > 0 && password.length < 16) hints.push('Longer beats more complicated — a passphrase of 4+ words is ideal.')

  const labels = ['Too weak', 'Weak', 'Fair', 'Strong', 'Excellent'] as const

  return {
    ok: problems.length === 0 && password.length >= 12,
    score: Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4,
    label: labels[Math.max(0, Math.min(4, score))],
    problems,
    hints,
  }
}
