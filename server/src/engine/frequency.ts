/**
 * ONE frequency vocabulary.
 *
 * Audit finding: three incompatible tables existed. The UI wrote 'annually';
 * the detector wrote 'annual', 'semi-annual' and 'semi-monthly'; and each
 * normaliser silently mishandled the values it did not recognise — usually by
 * falling through to a default that counted the FULL amount every month. A
 * $1,437 yearly premium was being counted as $1,437/month, twelve times over.
 *
 * Every module that turns a recurring item into money now imports from here.
 * An unknown frequency returns null rather than guessing, so a bad value shows
 * up as a missing figure instead of a wrong one.
 */

/** Canonical frequency values. Everything else is an alias for one of these. */
export const FREQUENCIES = [
  'daily', 'weekly', 'biweekly', 'semi-monthly',
  'monthly', 'quarterly', 'semi-annual', 'annual',
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** Every spelling seen in the DB, the UI and the detector, mapped to canonical. */
const ALIASES: Record<string, Frequency> = {
  daily: 'daily', day: 'daily', everyday: 'daily',
  weekly: 'weekly', week: 'weekly',
  biweekly: 'biweekly', 'bi-weekly': 'biweekly', fortnightly: 'biweekly',
  'semi-monthly': 'semi-monthly', semimonthly: 'semi-monthly', 'twice-monthly': 'semi-monthly',
  monthly: 'monthly', month: 'monthly',
  quarterly: 'quarterly', quarter: 'quarterly',
  'semi-annual': 'semi-annual', semiannual: 'semi-annual', 'semi-annually': 'semi-annual',
  biannual: 'semi-annual', 'twice-yearly': 'semi-annual',
  annual: 'annual', annually: 'annual', yearly: 'annual', year: 'annual',
};

/** Canonicalise a stored frequency string. Returns null if unrecognised. */
export function canonicalFrequency(frequency: string | null | undefined): Frequency | null {
  if (!frequency) return null;
  return ALIASES[String(frequency).trim().toLowerCase()] ?? null;
}

/** Occurrences per month. 30.44 days/month, 365.25 days/year. */
const PER_MONTH: Record<Frequency, number> = {
  daily: 30.44,
  weekly: 4.348,
  biweekly: 2.174,
  'semi-monthly': 2,
  monthly: 1,
  quarterly: 1 / 3,
  'semi-annual': 1 / 6,
  annual: 1 / 12,
};

/**
 * What this item costs per month. Returns null for an unrecognised frequency —
 * callers decide whether to skip the row or surface it as unknown. Never
 * silently returns the raw amount, which is how annual bills got counted 12x.
 */
export function monthlyAmount(amount: number, frequency: string | null | undefined): number | null {
  const f = canonicalFrequency(frequency);
  if (!f) return null;
  return amount * PER_MONTH[f];
}

/** Occurrences per year — for annualised projections. */
export function yearlyAmount(amount: number, frequency: string | null | undefined): number | null {
  const monthly = monthlyAmount(amount, frequency);
  return monthly === null ? null : monthly * 12;
}

/** How far to step a due date forward, as {months} or {days}. Null if unknown. */
export function frequencyStep(frequency: string | null | undefined):
  { months: number; days?: undefined } | { days: number; months?: undefined } | null {
  const f = canonicalFrequency(frequency);
  if (!f) return null;
  switch (f) {
    case 'daily':         return { days: 1 };
    case 'weekly':        return { days: 7 };
    case 'biweekly':      return { days: 14 };
    case 'semi-monthly':  return { days: 15 };
    case 'monthly':       return { months: 1 };
    case 'quarterly':     return { months: 3 };
    case 'semi-annual':   return { months: 6 };
    case 'annual':        return { months: 12 };
  }
}

/** Human label for the UI. */
export function frequencyLabel(frequency: string | null | undefined): string {
  const f = canonicalFrequency(frequency);
  if (!f) return String(frequency || 'unknown');
  return {
    daily: 'Daily', weekly: 'Weekly', biweekly: 'Every 2 weeks',
    'semi-monthly': 'Twice a month', monthly: 'Monthly', quarterly: 'Quarterly',
    'semi-annual': 'Twice a year', annual: 'Yearly',
  }[f];
}
