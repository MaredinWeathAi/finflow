import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatCompactCurrency(amount: number, currency = 'USD'): string {
  if (Math.abs(amount) >= 1_000_000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(amount)
  }
  return formatCurrency(amount, currency)
}

export function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num)
}

export function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}


/**
 * Occurrences per month for a recurring item's frequency.
 *
 * The browser's own table used to know 'annually' while the detector writes
 * 'annual', 'semi-annual' and 'semi-monthly' — and unrecognised values fell
 * through to a default that added the FULL amount every month, so a $1,437
 * yearly premium counted as $1,437/month. Unknown values now return null and
 * the caller skips the row rather than inventing a figure.
 *
 * Mirrors server/src/engine/frequency.ts. Keep the two in step.
 */
const FREQUENCY_PER_MONTH: Record<string, number> = {
  daily: 30.44, day: 30.44,
  weekly: 4.348, week: 4.348,
  biweekly: 2.174, 'bi-weekly': 2.174, fortnightly: 2.174,
  'semi-monthly': 2, semimonthly: 2, 'twice-monthly': 2,
  monthly: 1, month: 1,
  quarterly: 1 / 3, quarter: 1 / 3,
  'semi-annual': 1 / 6, semiannual: 1 / 6, 'semi-annually': 1 / 6, biannual: 1 / 6,
  annual: 1 / 12, annually: 1 / 12, yearly: 1 / 12, year: 1 / 12,
}

export function monthlyAmount(amount: number, frequency: string | null | undefined): number | null {
  if (!frequency) return null
  const per = FREQUENCY_PER_MONTH[String(frequency).trim().toLowerCase()]
  return per === undefined ? null : amount * per
}

const FREQUENCY_LABELS: Record<string, string> = {
  daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks',
  'semi-monthly': 'Twice a month', monthly: 'Monthly', quarterly: 'Quarterly',
  'semi-annual': 'Twice a year', semiannual: 'Twice a year',
  annual: 'Yearly', annually: 'Yearly', yearly: 'Yearly',
}

export function frequencyLabel(frequency: string | null | undefined): string {
  if (!frequency) return 'Unknown'
  return FREQUENCY_LABELS[String(frequency).trim().toLowerCase()] ?? String(frequency)
}
